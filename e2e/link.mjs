// e2e/link.mjs — 中继链路层（契约 §4）：hello/welcome/frame/心跳/seq/去重。
// mock-phone 与 mock-host 共用。依赖 Node ≥22 全局 WebSocket。
import { deriveKey, helloSig, seal, open, msg, Correlator } from "./protocol.mjs";

export class RelayLink {
  #heartbeat;
  #outbox;
  /**
   * @param {{relayUrl:string, channel:string, secret:string, role:"host"|"client",
   *          onMessage:(m:any)=>void, onStatus?:(s:string)=>void, onPeer?:(joined:boolean, role:string)=>void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.key = deriveKey(opts.secret, opts.channel);
    this.seq = 0; // 本端发送序号（每条连接从 1 开始）
    this.sid = ""; // 发送端实例 id（每条连接生成一次，契约 §4 v1.0.2）
    this.seen = new Map(); // 对端去重：sid -> Set<seq>
    this.corr = new Correlator();
    this.closed = false;
    this.lastTraffic = Date.now();
    this.peers = { host: false, client: false };
    this.#connect();
    this.#heartbeat = setInterval(() => this.#tick(), 30000);
  }

  #connect() {
    const { relayUrl } = this.opts;
    this.sid = Math.random().toString(16).slice(2, 10); // 每条连接新 sid
    this.seq = 0;
    this.opts.onStatus?.("connecting");
    this.ws = new WebSocket(relayUrl);
    this.ws.addEventListener("open", () => {
      this.lastTraffic = Date.now();
      this.ws.send(
        JSON.stringify({
          t: "hello",
          role: this.opts.role,
          ch: this.opts.channel,
          sig: helloSig(this.key, this.opts.role, this.opts.channel),
        }),
      );
    });
    this.ws.addEventListener("message", (ev) => this.#onRaw(String(ev.data)));
    this.ws.addEventListener("close", () => {
      if (this.closed) return;
      this.opts.onStatus?.("disconnected");
      const delay = this.#nextBackoff();
      setTimeout(() => this.#connect(), delay);
    });
    this.ws.addEventListener("error", () => {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    });
  }

  #nextBackoff() {
    this._tries = (this._tries ?? 0) + 1;
    const base = Math.min(60000, 1000 * 2 ** Math.min(this._tries - 1, 6));
    return base * (0.5 + Math.random() * 0.5);
  }

  #onRaw(raw) {
    this.lastTraffic = Date.now();
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    switch (f.t) {
      case "welcome":
        this._tries = 0;
        this.peers = f.peers ?? this.peers;
        this.opts.onStatus?.("ready");
        // 补发 open 之前缓冲的帧
        if (this.#outbox?.length) {
          const pending = this.#outbox;
          this.#outbox = [];
          for (const obj of pending) this.ws.send(JSON.stringify(obj));
        }
        break;
      case "peer-joined":
      case "peer-left":
        this.peers[f.role] = f.t === "peer-joined";
        this.opts.onPeer?.(f.t === "peer-joined", f.role);
        break;
      case "ping":
        this.#sendRelay({ t: "pong" });
        break;
      case "pong":
        break;
      case "error":
        this.opts.onStatus?.("error: " + f.code + " " + f.message);
        break;
      case "frame": {
        // 契约 §4 v1.0.2：去重键 = sid:seq（缺 sid 按 legacy）
        const sid = typeof f.sid === "string" && f.sid !== "" ? f.sid : "legacy";
        let bucket = this.seen.get(sid);
        if (bucket === undefined) {
          bucket = new Set();
          this.seen.set(sid, bucket);
          if (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value);
        }
        if (bucket.has(f.seq)) return; // 去重
        bucket.add(f.seq);
        if (bucket.size > 4096) this.seen.set(sid, new Set([...bucket].slice(-2048)));
        let m;
        try {
          // 接收方解密时 role 用「发送方」的 role
          m = open(this.key, f.from, f.seq, f.data);
        } catch (e) {
          this.opts.onStatus?.("decrypt failed: " + e.message);
          return;
        }
        this.corr.deliver(m, (x) => this.opts.onMessage(x));
        break;
      }
      default:
        break;
    }
  }

  #sendRelay(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return;
    }
    // 未 open 时缓冲，open 后按序补发（防止早期请求被静默丢弃）
    this.#outbox ??= [];
    this.#outbox.push(obj);
    if (this.#outbox.length > 256) this.#outbox.shift();
  }

  #tick() {
    if (Date.now() - this.lastTraffic > 90000) {
      try {
        this.ws?.close();
      } catch {
        /* reconnect handles it */
      }
      return;
    }
    this.#sendRelay({ t: "ping" });
  }

  /** 发送一条业务消息（自动加密 + sid/seq） */
  send(message, urgent = false) {
    this.seq += 1;
    const data = seal(this.key, this.opts.role, this.seq, message);
    this.#sendRelay({ t: "frame", sid: this.sid, seq: this.seq, data, urgent });
  }

  /** 请求-响应 */
  request(type, payload, timeoutMs = 15000) {
    return this.corr.request((m) => this.send(m), type, payload, timeoutMs);
  }

  close() {
    this.closed = true;
    clearInterval(this.#heartbeat);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export { msg };

/**
 * LoopbackLink —— 一对「进程内直连」端点（**不经过中继**）：自测用。
 *
 * 与 RelayLink 的差别只有一处：中继转发 → 进程内直投。其余完全一致：
 * 同样的 §3 密钥派生、同样的 §7 封装（iv||ct||tag）与 AAD（role+seq）绑定、
 * 同样的信封（{id,type,ts,payload}）与请求-响应关联。
 *
 * 用途：auto-test 的 v1.0.6 新链路用例不依赖中继进程、不占用真实 channel，
 * 也不受「一个 channel 只允许一个 host」的限制（契约 §4）。
 */
export class LoopbackLink {
  #peer = null;
  #seq = 0;
  /**
   * @param {{role:"host"|"client", channel:string, secret:string,
   *          onMessage:(m:any)=>void, onStatus?:(s:string)=>void}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.key = deriveKey(opts.secret, opts.channel);
    this.corr = new Correlator();
    this.closed = false;
    this.opts.onStatus?.("ready");
  }

  /** 由 createLoopbackPair 内部调用：绑定对端。 */
  _attach(peer) {
    this.#peer = peer;
  }

  /** 发送一条业务消息（自动加密 + seq 计数）。 */
  send(message, urgent = false) {
    if (this.closed) return false;
    this.#seq += 1;
    // seq 必须在此刻定格：连续多次 send 会把多帧排进微任务队列，
    // 投递时再读 this.#seq 会拿到更大的值 → AAD 不匹配 → 解密失败。
    const seq = this.#seq;
    const data = seal(this.key, this.opts.role, seq, message);
    const peer = this.#peer;
    if (peer === null) return false;
    void urgent;
    // 异步投递：模拟网络时序（不重入 send 调用栈）
    queueMicrotask(() => peer._deliver(data, seq, this.opts.role));
    return true;
  }

  /** 收到对端的一帧密文：按「发送方 role」解密后交给 correlator。 */
  _deliver(data, seq, fromRole) {
    if (this.closed) return;
    let m;
    try {
      m = open(this.key, fromRole, seq, data);
    } catch (e) {
      this.opts.onStatus?.("decrypt failed: " + (e?.message ?? String(e)));
      return;
    }
    this.corr.deliver(m, (x) => this.opts.onMessage(x));
  }

  /** 请求-响应（与 RelayLink 同签名）。 */
  request(type, payload, timeoutMs = 15000) {
    return this.corr.request((m) => this.send(m), type, payload, timeoutMs);
  }

  close() {
    this.closed = true;
    this.#peer = null;
  }
}

/**
 * 建一对直连端点（host ↔ client）。
 * @param {{channel:string, secret:string, onHostMessage?:(m:any)=>void, onClientMessage?:(m:any)=>void}} opts
 */
export function createLoopbackPair(opts) {
  const host = new LoopbackLink({
    role: "host",
    channel: opts.channel,
    secret: opts.secret,
    onMessage: opts.onHostMessage ?? (() => {}),
    onStatus: opts.onStatus,
  });
  const client = new LoopbackLink({
    role: "client",
    channel: opts.channel,
    secret: opts.secret,
    onMessage: opts.onClientMessage ?? (() => {}),
    onStatus: opts.onStatus,
  });
  host._attach(client);
  client._attach(host);
  return { host, client };
}
