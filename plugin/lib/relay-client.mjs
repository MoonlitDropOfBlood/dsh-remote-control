// lib/relay-client.mjs — 中继 WebSocket 客户端（契约 §4）。
//
// DSH 插件以 host 角色**出站连接**中继（无需端口映射）；中继只转发
// AES-256-GCM 密文帧（frame.data）。本模块职责：
//   - 连接 / hello（10s 内发出，带 §3.4 HMAC sig 与可选 RELAY_TOKEN）
//   - 指数退避重连：1s → 60s 封顶，带 ±50% 抖动
//   - 应用层心跳：30s 无帧即发 ping；90s 无任何消息判死重连
//   - 发送 seq 单调递增（从 1 开始）；接收按对端 seq 去重（同一 seq 只处理一次）
//   - 解密后把明文业务消息交给 onMessage
//
// 传输层帧语义见契约 §4；加解密复用 lib/protocol.mjs。
import { randomBytes } from "node:crypto";
import { deriveKey, helloSig, open, seal } from "./protocol.mjs";

const HELLO_TIMEOUT_MS = 10_000; // 契约 §4：连接后 10s 内必须 hello
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s 无帧即发 ping
const DEAD_TIMEOUT_MS = 90_000; // 90s 无任何消息判死
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SEEN_SET_TRIM = 2_048; // 去重集合超量时裁剪窗口

/**
 * @typedef {"connecting"|"handshaking"|"ready"|"disconnected"|"error"} RelayStatus
 * @typedef {{
 *   relayUrl: string, channel: string, secret: string,
 *   relayToken?: string,
 *   onStatus?: (s: RelayStatus, detail?: string) => void,
 *   onPeer?: (joined: boolean, role: "host"|"client") => void,
 *   onMessage: (m: object) => void,
 *   onFatal?: (code: string, message: string) => void,
 *   log?: (level: "info"|"warn"|"error", message: string, extra?: object) => void,
 * }} RelayClientOptions
 */

export class RelayClient {
  #opts;
  #key;
  #ws = null;
  #closed = false;
  #seq = 0; // 本端发送序号（每条连接从 1 开始，契约 §4）
  #sid = ""; // 发送端实例 id（每条连接生成一次；去重键 = sid:seq，契约 §4 v1.0.2）
  #seen = new Map(); // 对端去重：sid -> Set<seq>
  #tries = 0; // 连续失败次数（退避指数）
  #reconnectTimer = null;
  #heartbeatTimer = null;
  #helloTimer = null;
  #lastTrafficAt = 0;
  #handshaken = false; // 本端 hello 已被中继接受（收到 welcome）

  /**
   * 对端在线状态。只跟踪**对端**：host 角色实例只读写 peers.client，
   * client 角色实例只读写 peers.host。本端的可发送性由 #handshaken 决定
   * （welcome.peers 自己那一项是中继快照，时序上可能落后，不可当作凭据）。
   */
  peers = { host: false, client: false };

  /**
   * @param {RelayClientOptions} opts
   */
  constructor(opts) {
    this.#opts = opts;
    this.#key = deriveKey(opts.secret, opts.channel);
  }

  get key() {
    return this.#key;
  }

  /** 手机端（client 角色）是否在线——审批拦截的前置条件之一（契约 §5.5）。 */
  get clientOnline() {
    return this.#handshaken && this.peers.client === true;
  }

  /** welcome 已收到（hello 被接受）且 socket 仍开着。 */
  get ready() {
    return this.#ws !== null && this.#ws.readyState === 1 /* OPEN */ && this.#handshaken;
  }

  /** 启动连接（幂等）。 */
  start() {
    if (this.#closed) return;
    if (this.#ws !== null) return;
    this.#connect();
    this.#heartbeatTimer = setInterval(() => this.#tick(), HEARTBEAT_INTERVAL_MS);
  }

  /** 停止并释放全部资源（插件卸载 / 配置变更时调用）。 */
  close() {
    this.#closed = true;
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#clearHelloTimer();
    const ws = this.#ws;
    this.#ws = null;
    this.#handshaken = false;
    this.peers = { host: false, client: false };
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.#setStatus("disconnected", "closed");
  }

  /**
   * 强制断开当前连接以触发自动重连（网络切换、手动重连、测试断线场景）。
   * 与 close() 的区别：不置 #closed，因此 ws 的 close 事件会照常走指数退避重连。
   * 空闲时（无连接）是 no-op。
   */
  dropConnection() {
    if (this.#closed) return;
    const ws = this.#ws;
    if (ws === null) return;
    try {
      ws.close();
    } catch {
      /* 已关闭；close 事件仍会触发 */
    }
  }

  /**
   * 以新的配对信息热更换（/remote-pairing rotate，契约 §3.5）：换 channel/secret
   * 后立即用新密钥重连；旧密钥、旧连接、去重表即刻作废（旧二维码/旧口述失效）。
   * 未传的字段保持原值；close() 之后调用是 no-op。
   * @param {{channel?:string, secret?:string, relayToken?:string, relayUrl?:string}} next
   */
  reload(next) {
    if (this.#closed) return;
    const n = next ?? {};
    if (typeof n.channel === "string" && n.channel !== "") this.#opts.channel = n.channel;
    if (typeof n.secret === "string" && n.secret !== "") this.#opts.secret = n.secret;
    if (n.relayToken !== undefined) this.#opts.relayToken = n.relayToken;
    if (typeof n.relayUrl === "string" && n.relayUrl !== "") this.#opts.relayUrl = n.relayUrl;
    this.#key = deriveKey(this.#opts.secret, this.#opts.channel);
    this.#tries = 0;
    this.#seen.clear();
    this.#seq = 0;
    this.#sid = "";
    this.#handshaken = false;
    this.peers = { host: false, client: false };
    // 摘除旧 socket：先置空，close 事件里的 #ws !== ws 守卫会忽略它（不触发退避重连）
    const ws = this.#ws;
    this.#ws = null;
    this.#clearHelloTimer();
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.#opts.log?.("info", "pairing identity reloaded; reconnecting", { channel: this.#opts.channel });
    this.#connect();
  }

  /**
   * 发送一条明文业务消息：加密 → {t:"frame", seq, data, urgent?}。
   * 未就绪时返回 false（调用方决定是否缓存或丢弃；中继另有离线缓存）。
   * @param {object} message 明文业务消息
   * @param {boolean} [urgent] 审批/提问帧标记优先补发（契约 §4）
   * @returns {boolean}
   */
  send(message, urgent = false) {
    const ws = this.#ws;
    if (this.#closed || ws === null || ws.readyState !== 1 /* OPEN */) return false;
    if (!this.#handshaken) return false; // hello 握手完成前不发业务帧
    this.#seq += 1;
    const frame = { t: "frame", sid: this.#sid, seq: this.#seq, data: seal(this.#key, "host", this.#seq, message) };
    if (urgent) frame.urgent = true;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      this.#opts.log?.("warn", "frame send failed", { error: String(e && e.message) });
      return false;
    }
  }

  // ---- 内部 ----------------------------------------------------------------

  #setStatus(s, detail) {
    try {
      this.#opts.onStatus?.(s, detail);
    } catch {
      /* 回调异常不影响链路 */
    }
  }

  #clearHelloTimer() {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
  }

  #connect() {
    if (this.#closed) return;
    const { relayUrl } = this.#opts;
    this.#setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(relayUrl);
    } catch (e) {
      this.#opts.log?.("error", "WebSocket construct failed", { relayUrl, error: String(e && e.message) });
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.#lastTrafficAt = Date.now();

    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      // v1.0.2：每条连接生成新 sid 并重置 seq——旧连接的去重状态不得误伤新连接的 seq。
      this.#sid = randomBytes(4).toString("hex");
      this.#seq = 0;
      this.#setStatus("handshaking");
      // 契约 §4：hello 必须是连接后第一条消息，10s 内未发出即断开重试。
      const hello = { t: "hello", role: "host", ch: this.#opts.channel, sig: helloSig(this.#key, "host", this.#opts.channel) };
      if (this.#opts.relayToken) hello.token = this.#opts.relayToken;
      try {
        ws.send(JSON.stringify(hello));
      } catch (e) {
        this.#opts.log?.("warn", "hello send failed", { error: String(e && e.message) });
      }
      this.#clearHelloTimer();
      this.#helloTimer = setTimeout(() => {
        // hello 未被接受（无 welcome）→ 判死重连
        if (this.#ws === ws) {
          this.#opts.log?.("warn", "hello timed out (no welcome)");
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }, HELLO_TIMEOUT_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (this.#ws !== ws) return;
      this.#lastTrafficAt = Date.now();
      this.#onRaw(String(ev.data));
    });

    ws.addEventListener("close", () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#clearHelloTimer();
      this.#handshaken = false;
      this.peers = { host: false, client: false };
      if (this.#closed) return;
      this.#setStatus("disconnected");
      this.#scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // error 后必然跟随 close；这里只记日志，重连由 close 驱动。
      this.#opts.log?.("warn", "websocket error event");
      try {
        ws.close();
      } catch {
        /* 已经在关闭 */
      }
    });
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer !== null) return;
    this.#tries += 1;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.#tries - 1, 6));
    const delay = Math.round(base * (0.5 + Math.random() * 0.5)); // ±50% 抖动
    this.#opts.log?.("info", "reconnect scheduled", { attempt: this.#tries, delayMs: delay });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #tick() {
    if (this.#ws === null) return;
    const idle = Date.now() - this.#lastTrafficAt;
    if (idle > DEAD_TIMEOUT_MS) {
      this.#opts.log?.("warn", "no traffic for 90s; reconnecting");
      try {
        this.#ws.close();
      } catch {
        /* close 事件驱动重连 */
      }
      return;
    }
    this.#sendRelay({ t: "ping" });
  }

  #sendRelay(obj) {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* close 事件驱动重连 */
    }
  }

  /** 解析并分发一条中继明文帧。任何解析/解密失败只丢帧，不打断链路。 */
  #onRaw(raw) {
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (f === null || typeof f !== "object") return;
    switch (f.t) {
      case "welcome": {
        this.#clearHelloTimer();
        this.#tries = 0; // 握手成功，退避归零
        this.#handshaken = true;
        // welcome.peers 是中继的当前快照，只取**对端**那一项；本端项不可靠
        // （中继登记本端连接与计算快照之间存在竞态，可能短暂回报 false）。
        this.peers = this.#opts.role === "host"
          ? { host: false, client: !!(f.peers && f.peers.client) }
          : { host: !!(f.peers && f.peers.host), client: false };
        this.#setStatus("ready");
        if (this.peers.client) this.#notifyPeer(true, "client");
        else if (this.peers.host) this.#notifyPeer(true, "host");
        break;
      }
      case "peer-joined":
      case "peer-left": {
        const role = f.role === "client" ? "client" : "host";
        const joined = f.t === "peer-joined";
        const was = this.peers[role];
        this.peers[role] = joined;
        if (was !== joined) this.#notifyPeer(joined, role);
        break;
      }
      case "ping":
        this.#sendRelay({ t: "pong" });
        break;
      case "pong":
        break;
      case "error": {
        const code = typeof f.code === "string" ? f.code : "unknown";
        const message = typeof f.message === "string" ? f.message : "";
        this.#opts.log?.("error", "relay error", { code, message });
        if (code === "bad-hello" || code === "channel-full") {
          // 协议级拒绝：重连无意义，交给上层决定（fatal：禁用并提示配置问题）。
          try {
            this.#opts.onFatal?.(code, message);
          } catch {
            /* ignore */
          }
        }
        this.#setStatus("error", code + " " + message);
        break;
      }
      case "frame":
        this.#onFrame(f);
        break;
      default:
        break; // 未知帧类型：前向兼容，忽略
    }
  }

  #notifyPeer(joined, role) {
    try {
      this.#opts.onPeer?.(joined, role);
    } catch {
      /* 回调异常不影响链路 */
    }
  }

  /** 处理转发帧：去重（sid:seq）→ 解密（role 用发送方的 role）→ 信封消毒 → 上交。 */
  #onFrame(f) {
    const seq = f.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return;
    // 契约 §4 v1.0.2：去重键 = sid:seq（缺 sid 按 legacy），按 sid 分桶淘汰。
    const sid = typeof f.sid === "string" && f.sid !== "" ? f.sid : "legacy";
    let bucket = this.#seen.get(sid);
    if (bucket === undefined) {
      bucket = new Set();
      this.#seen.set(sid, bucket);
      if (this.#seen.size > 64) {
        const oldest = this.#seen.keys().next().value;
        if (oldest !== undefined) this.#seen.delete(oldest);
      }
    }
    if (bucket.has(seq)) return; // 同一 sid 的同一 seq 只处理一次
    bucket.add(seq);
    if (bucket.size > SEEN_SET_TRIM * 2) {
      const arr = [...bucket].sort((a, b) => a - b);
      this.#seen.set(sid, new Set(arr.slice(-SEEN_SET_TRIM)));
    }
    if (typeof f.data !== "string") return;
    const from = f.from === "host" ? "host" : "client";
    let m;
    try {
      m = open(this.#key, from, seq, f.data);
    } catch (e) {
      // 密钥不匹配或帧损坏：丢帧并节流告警（避免刷屏）。
      this.#opts.log?.("warn", "decrypt failed; frame dropped", { seq, error: String(e && e.message) });
      return;
    }
    try {
      this.#opts.onMessage(m);
    } catch (e) {
      this.#opts.log?.("error", "message handler threw", { type: m && m.type, error: String(e && e.message) });
    }
  }
}
