// e2e/link.mjs — 中继链路层（契约 §4）：hello/welcome/frame/心跳/seq/去重。
// mock-phone 与 mock-host 共用。依赖 Node ≥22 全局 WebSocket。
//
// v1.1.3（契约 §3.4.1 会话纪元 / §7 AAD 绑定 sid）：
//   - 本端 hello 带 e/ts/pv/sid + v2 sig（"hello2|role|channel|e|ts|pv|sid"）
//   - 对端证明由中继**原样透传**（welcome.peer / peer-joined.peer）→ 本端验签
//   - 双方 pv>=2 → **加固模式**：AAD = "dshrc|role|seq|sid"；收到的 frame.sid
//     与钉扎值不符 → **丢弃**
//   - 对端纪元 e <= 已接受值（且不是同一证明）→ **拒绝连接**
//   - 纪元必须**持久化**：每条新连接 +1，跨进程重启继续递增（EpochStore）
//
// 与 plugin/lib/relay-client.mjs **同口径**（模式判定 / 纪元锚点 / 暂存重试），
// 两份实现互通的前提是逐字节一致，不是代码一致。
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveKey,
  makeProof,
  verifyProof,
  seal,
  open,
  msg,
  Correlator,
  EpochStore,
  PROOF_VERSION,
} from "./protocol.mjs";

/** 握手模式：兼容模式（任一方 pv<2）与加固模式（双方 pv>=2）。 */
export const MODE_COMPAT = "compat";
export const MODE_HARDENED = "hardened";

/** 8 位十六进制连接实例 id（契约 §4 v1.0.2 / §3.4.1 的 sid） */
export function newSid() {
  return randomBytes(4).toString("hex");
}

/**
 * 默认纪元文件（mock 两端各自维护；跨进程重启继续递增——契约 §3.4.1「必须持久化」）。
 * 文件名含 role + channel → host / client 两端各一份，互不干扰。
 */
export function defaultEpochFile(role, channel) {
  return join(tmpdir(), `dshrc-e2e-epoch-${role}-${channel}.json`);
}

/**
 * 中继级**致命**错误：重连无意义，收到后必须停心跳、停止自动重连。
 *   - `replaced`：同 channel 同 role 有新连接顶替了我们（中继 §4「同 channel 同 role
 *     单活跃连接：新顶旧」）。真实手机在线时再跑 auto-test 的真实宿主链路就会踩到：
 *     两边每秒互抢（手机被顶 → 手机重连 → 顶掉我们 → 我们重连 …）。
 *   - `bad-hello`：握手被拒（channel/role/token 不合法），再连也是被拒。
 * 其它错误（rate-limited / transient）保持原有退避重连逻辑。
 */
export const FATAL_ERROR_CODES = new Set(["replaced", "bad-hello"]);

/** 中继顶替旧连接时的 WS close code（relay/server.js：old.ws.close(4001, …)）。 */
const REPLACED_CLOSE_CODE = 4001;

/** 模式竞态暂存的帧上限 / 存活期（与 plugin 一致） */
const PENDING_STASH_MAX = 64;
const PENDING_STASH_TTL_MS = 30_000;

export class RelayLink {
  #heartbeat;
  #outbox;
  #reconnectTimer = null;
  #fatalCode = "";
  /** 模式竞态暂存的帧（兼容模式解不开、且还没拿到对端证明） */
  #stashed = [];
  /** welcome 之前发送的业务消息（**只在真正发出时才 seal**——AAD 依赖当时的模式） */
  #pending = [];
  /** 是否已收到 welcome（契约 §3.4.1：welcome 之后才发业务帧） */
  #readyToSend = false;

  /**
   * @param {{relayUrl:string, channel:string, secret:string, role:"host"|"client",
   *          onMessage:(m:any)=>void, onStatus?:(s:string)=>void, onPeer?:(joined:boolean, role:string)=>void,
   *          token?:string, epochFile?:string, epochStore?:EpochStore, pv?:number}} opts
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
    // ---- v1.1.3：证明 / 纪元 / 模式 ----
    this.pv = opts.pv ?? PROOF_VERSION; // 本端证明版本（pv）
    this.epochStore =
      opts.epochStore ?? new EpochStore(opts.epochFile ?? defaultEpochFile(opts.role, opts.channel));
    this.proof = null; // 本端 hello 的证明
    this.peerProof = null; // 对端证明（中继原样透传）
    this.peerPv = 1; // 对端 pv（未知/旧端 = 1）
    this.peerSid = ""; // 钉扎的对端 sid（加固模式）
    this.mode = MODE_COMPAT; // compat | hardened
    this.peerRejected = false;
    this.#connect();
    this.#heartbeat = setInterval(() => this.#tick(), 30000);
  }

  /** 致命错误后的错误码（空串 = 没发生过致命错误）。 */
  get fatalCode() {
    return this.#fatalCode;
  }

  #connect() {
    const { relayUrl } = this.opts;
    this.sid = newSid(); // 每条连接新 sid
    this.seq = 0;
    this.peerProof = null;
    this.peerPv = 1;
    this.peerSid = "";
    this.mode = MODE_COMPAT;
    this.#stashed = [];
    this.#pending = [];
    this.#readyToSend = false;
    this.opts.onStatus?.("connecting");
    this.ws = new WebSocket(relayUrl);
    this.ws.addEventListener("open", () => {
      this.lastTraffic = Date.now();
      // v1.1.3：hello 带会话纪元证明（e/ts/pv/sid + v2 证明串）
      this.proof = makeProof(this.key, this.opts.role, this.opts.channel, {
        e: this.epochStore.next(), // 每条新连接 +1（持久化）
        ts: Date.now(),
        pv: this.pv,
        sid: this.sid,
      });
      const hello = {
        t: "hello",
        role: this.opts.role,
        ch: this.opts.channel,
        sig: this.proof.sig,
        e: this.proof.e,
        ts: this.proof.ts,
        pv: this.proof.pv,
        sid: this.proof.sid,
      };
      // 中继自身鉴权（契约 §4 RELAY_TOKEN）：配置后 hello 必须带 token
      if (this.opts.token) hello.token = this.opts.token;
      this.ws.send(JSON.stringify(hello));
    });
    this.ws.addEventListener("message", (ev) => this.#onRaw(String(ev.data)));
    this.ws.addEventListener("close", (ev) => {
      if (this.closed) return;
      // 中继以 4001 关闭 = 被同 role 的新连接顶替（即使没收到 error 帧也不能再连，
      // 否则会和新连接互抢到天荒地老）。
      if (ev?.code === REPLACED_CLOSE_CODE) {
        this.#fatal("replaced", typeof ev.reason === "string" ? ev.reason : "replaced by a newer connection");
        return;
      }
      this.opts.onStatus?.("disconnected");
      const delay = this.#nextBackoff();
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null;
        if (this.closed) return; // close() / 致命错误之后不复活
        this.#connect();
      }, delay);
    });
    this.ws.addEventListener("error", () => {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    });
  }

  /**
   * 致命错误：停心跳 + 停自动重连（close 回调不得复活本连接）。
   * 幂等：重复调用无副作用。
   */
  #fatal(code, message) {
    if (this.closed) return;
    this.closed = true; // 必须先置位：随后的 close 回调才不会重连
    this.#fatalCode = typeof code === "string" ? code : "";
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#heartbeat !== null && this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.opts.onStatus?.("fatal: " + this.#fatalCode + " " + (message ?? ""));
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }

  #nextBackoff() {
    this._tries = (this._tries ?? 0) + 1;
    const base = Math.min(60000, 1000 * 2 ** Math.min(this._tries - 1, 6));
    return base * (0.5 + Math.random() * 0.5);
  }

  // ---- v1.1.3：握手证明 / 模式 / 纪元 ---------------------------------------

  /** 退到兼容模式（对端是旧端 / 没有证明）。 */
  #setCompatMode(reason) {
    this.mode = MODE_COMPAT;
    this.peerPv = 1;
    this.peerSid = "";
    this.opts.onStatus?.("mode: compat (" + reason + ")");
  }

  /**
   * 处理中继透传的对端证明（welcome.peer / peer-joined.peer，契约 §3.4.1）：
   *   ① pv>=2 → 先验签（不过 → 拒绝连接）；再查纪元单调性（回退 → 拒绝连接）；
   *      通过 → 钉扎 (e, sid) → 切加固模式。
   *   ② pv<2（旧端）→ 兼容模式（不钉扎、不记纪元）。
   */
  #applyPeerProof(proof, source) {
    if (proof === null || typeof proof !== "object") {
      this.#setCompatMode("peer proof malformed");
      return;
    }
    const role =
      proof.role === "client" || proof.role === "host"
        ? proof.role
        : this.opts.role === "host"
          ? "client"
          : "host";
    if (role === this.opts.role) {
      this.opts.onStatus?.("ignore peer proof with our own role");
      return;
    }
    const pv = Number.isInteger(proof.pv) ? proof.pv : 1;
    if (pv < 2) {
      // 旧端：没有纪元也没有 v2 证明 → 兼容模式
      this.peerProof = proof;
      this.#setCompatMode("peer protocol version < 2");
      return;
    }
    // ① 验签（恒定时间比较；中继无密钥、只能复制 → 验签通过即可信任）
    if (!verifyProof(this.key, role, this.opts.channel, proof)) {
      this.opts.onStatus?.("peer proof invalid (" + source + ")");
      this.#rejectPeer("peer-proof-invalid");
      return;
    }
    // ② 纪元单调性（回退 = 疑似重放 → 拒绝连接；同一证明重复 → 幂等接受）
    const verdict = this.epochStore.acceptPeer(role, { e: proof.e, sid: proof.sid });
    if (!verdict.ok) {
      this.opts.onStatus?.("peer epoch rejected: " + verdict.reason);
      this.#rejectPeer(verdict.reason ?? "epoch-rejected");
      return;
    }
    this.peerProof = proof;
    this.peerPv = pv;
    this.peerSid = proof.sid;
    this.mode = this.pv >= 2 && pv >= 2 ? MODE_HARDENED : MODE_COMPAT;
    this.opts.onStatus?.(
      "mode: " + this.mode + " (peer pv=" + pv + ", e=" + proof.e + ", duplicate=" + (verdict.duplicate === true) + ")",
    );
    // 模式切换竞态：之前用兼容 AAD 解不开的帧，按加固 AAD 重试一次
    this.#retryStashed();
  }

  /** 拒绝连接：对端证明非法 / 纪元回退 → 断开且不再重连。 */
  #rejectPeer(reason) {
    this.peerRejected = true;
    this.#stashed = [];
    this.#fatal(reason, "peer handshake rejected: " + reason);
  }

  /** 模式切到加固后，把暂存的帧按加固 AAD 重试一次（sid 必须与钉扎值一致）。 */
  #retryStashed() {
    if (this.#stashed.length === 0) return;
    const list = this.#stashed;
    this.#stashed = [];
    const now = Date.now();
    for (const item of list) {
      if (now - item.at > PENDING_STASH_TTL_MS) continue;
      if (this.mode !== MODE_HARDENED) continue;
      if (item.sid !== this.peerSid) continue;
      let m;
      try {
        m = open(this.key, item.from, item.seq, item.data, item.sid);
      } catch {
        continue;
      }
      this.corr.deliver(m, (x) => this.opts.onMessage(x));
    }
  }

  /** 处理转发帧：去重（sid:seq）→ sid 钉扎校验 → 解密（role 用发送方的 role）→ 上交。 */
  #onFrame(f) {
    const seq = f.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return;
    // 契约 §4 v1.0.2：去重键 = sid:seq（缺 sid 按 legacy），按 sid 分桶淘汰
    const sid = typeof f.sid === "string" && f.sid !== "" ? f.sid : "legacy";
    let bucket = this.seen.get(sid);
    if (bucket === undefined) {
      bucket = new Set();
      this.seen.set(sid, bucket);
      if (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value);
    }
    if (bucket.has(seq)) return; // 去重
    bucket.add(seq);
    if (bucket.size > 4096) this.seen.set(sid, new Set([...bucket].slice(-2048)));
    if (typeof f.data !== "string") return;
    const from = f.from === "host" ? "host" : "client";
    // v1.1.3 加固模式：**钉扎**对端 sid —— 收到的帧 sid 不符 → 丢弃（跨会话重放）
    let aadSid;
    if (this.mode === MODE_HARDENED) {
      if (this.peerSid === "") {
        this.opts.onStatus?.("drop frame: hardened mode without pinned peer sid");
        return;
      }
      if (sid !== this.peerSid) {
        this.opts.onStatus?.("drop frame: sid mismatch (" + sid + " != " + this.peerSid + ")");
        return;
      }
      aadSid = sid;
    }
    let m;
    try {
      // 接收方解密时 role 用「发送方」的 role
      m = open(this.key, from, seq, f.data, aadSid);
    } catch (e) {
      // 兼容模式下、还不知道对端 pv 时解不开 → 可能是对端已切加固模式（模式竞态）→ 暂存
      if (this.mode === MODE_COMPAT && this.peerProof === null && this.#stashed.length < PENDING_STASH_MAX) {
        this.#stashed.push({ seq, sid, from, data: f.data, at: Date.now() });
        return;
      }
      this.opts.onStatus?.("decrypt failed: " + (e?.message ?? e));
      return;
    }
    this.corr.deliver(m, (x) => this.opts.onMessage(x));
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
        // v1.1.3：对端证明（中继原样透传）——**先**处理证明（决定首帧的 AAD 模式），
        // 再冲刷 outbox 与业务帧队列
        if (f.peer) this.#applyPeerProof(f.peer, "welcome");
        else this.#setCompatMode("peer proof absent");
        this.opts.onStatus?.("ready");
        // 补发 open 之前缓冲的帧
        if (this.#outbox?.length) {
          const pending = this.#outbox;
          this.#outbox = [];
          for (const obj of pending) this.ws.send(JSON.stringify(obj));
        }
        // welcome 之后才发业务帧（此时模式已定 → AAD 正确）
        this.#readyToSend = true;
        const queued = this.#pending;
        this.#pending = [];
        for (const item of queued) this.#sendFrame(item.message, item.urgent);
        break;
      case "peer-joined":
      case "peer-left": {
        const joined = f.t === "peer-joined";
        this.peers[f.role] = joined;
        this.opts.onPeer?.(joined, f.role);
        if (joined) {
          // v1.1.3：peer-joined 带**新上线方**的证明（§4：中继逐字复制）
          if (f.peer) this.#applyPeerProof(f.peer, "peer-joined");
        } else {
          // 对端下线 → 钉扎作废（重新上线时会有新的证明与新的 sid）。
          // 注意：**不动**纪元锚点（那是跨重启的抗重放锚点，必须保留）。
          this.peerProof = null;
          this.peerPv = 1;
          this.peerSid = "";
          this.mode = MODE_COMPAT;
        }
        break;
      }
      case "ping":
        this.#sendRelay({ t: "pong" });
        break;
      case "pong":
        break;
      case "error": {
        const code = typeof f.code === "string" ? f.code : "";
        const message = typeof f.message === "string" ? f.message : "";
        if (FATAL_ERROR_CODES.has(code)) {
          // 致命：不再自动重连（否则同 channel 同 role 会互抢到天荒地老）
          this.#fatal(code, message);
          return;
        }
        this.opts.onStatus?.("error: " + code + " " + message);
        break;
      }
      case "frame":
        this.#onFrame(f);
        break;
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
    if (this.closed) return; // 致命错误 / close() 之后不再心跳
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
    if (this.closed) return false; // 致命错误 / close() 之后不再发（也不进 outbox 缓冲）
    // 契约 §3.4.1：**welcome 之后**才发业务帧（此时才知道对端 pv → AAD 格式）。
    // 注意：不能在 send() 里就 seal —— 从 send 到真正发出之间模式可能变化
    // （welcome.peer 到达即切加固模式）→ 那样会发出用错 AAD 的帧。
    if (!this.#readyToSend) {
      this.#pending.push({ message, urgent });
      return true;
    }
    this.#sendFrame(message, urgent);
    return true;
  }

  /** 真正发一帧：分配 seq + 按**当前模式** seal（加固模式 AAD 绑定 sid） */
  #sendFrame(message, urgent) {
    this.seq += 1;
    const seq = this.seq;
    const aadSid = this.mode === MODE_HARDENED ? this.sid : undefined;
    const data = seal(this.key, this.opts.role, seq, message, undefined, aadSid);
    this.#sendRelay({ t: "frame", sid: this.sid, seq, data, urgent });
  }

  /** 请求-响应 */
  request(type, payload, timeoutMs = 15000) {
    return this.corr.request((m) => this.send(m), type, payload, timeoutMs);
  }

  /** 关闭连接：幂等（可重复调用；致命错误后调用同样安全，不会复活连接）。 */
  close() {
    this.closed = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#heartbeat !== null && this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
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
 * 同样的 §3 密钥派生、同样的 §7 封装（iv||ct||tag）与 AAD（role+seq[+sid]）绑定、
 * 同样的信封（{id,type,ts,payload}）与请求-响应关联。
 *
 * v1.1.3：直连两端同样**交换握手证明**（模拟中继的 welcome.peer / peer-joined.peer
 * 透传）→ 双方 pv>=2 → 自动进入加固模式，AAD 绑定 sid。
 *
 * 用途：auto-test 的新链路用例不依赖中继进程、不占用真实 channel，
 * 也不受「一个 channel 只允许一个 host」的限制（契约 §4）。
 */
export class LoopbackLink {
  #peer = null;
  #seq = 0;
  /**
   * @param {{role:"host"|"client", channel:string, secret:string,
   *          onMessage:(m:any)=>void, onStatus?:(s:string)=>void,
   *          epochStore?:EpochStore, epochFile?:string, pv?:number}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.key = deriveKey(opts.secret, opts.channel);
    this.corr = new Correlator();
    this.closed = false;
    // ---- v1.1.3 ----
    this.pv = opts.pv ?? PROOF_VERSION;
    this.epochStore = opts.epochStore ?? new EpochStore(opts.epochFile ?? null);
    this.sid = newSid();
    this.proof = makeProof(this.key, opts.role, opts.channel, {
      e: this.epochStore.next(),
      ts: Date.now(),
      pv: this.pv,
      sid: this.sid,
    });
    this.peerProof = null;
    this.peerSid = "";
    this.mode = MODE_COMPAT;
    this.opts.onStatus?.("ready");
  }

  /** 由 createLoopbackPair 内部调用：绑定对端。 */
  _attach(peer) {
    this.#peer = peer;
    // 模拟中继的证明透传：双方交换 hello 证明（幂等：同一证明重复出现 → 幂等接受）
    // 注意：中继透传时会在证明对象里补 role 字段；直连时由对端的 role 直接给出。
    peer._receivePeerProof(this.proof, this.opts.role);
    this._receivePeerProof(peer.proof, peer.opts.role);
  }

  /** 收到对端的握手证明：验签 → 纪元单调性 → 钉扎 → 模式判定。 */
  _receivePeerProof(proof, peerRole) {
    if (!proof || typeof proof !== "object") return;
    const role = peerRole === "client" ? "client" : "host";
    if (role === this.opts.role) return;
    const pv = Number.isInteger(proof.pv) ? proof.pv : 1;
    if (pv < 2) {
      this.peerProof = proof;
      this.mode = MODE_COMPAT;
      return;
    }
    if (!verifyProof(this.key, role, this.opts.channel, proof)) {
      this.opts.onStatus?.("peer proof invalid");
      this.closed = true;
      return;
    }
    const verdict = this.epochStore.acceptPeer(role, { e: proof.e, sid: proof.sid });
    if (!verdict.ok) {
      this.opts.onStatus?.("peer epoch rejected: " + verdict.reason);
      this.closed = true;
      return;
    }
    this.peerProof = proof;
    this.peerSid = proof.sid;
    this.mode = this.pv >= 2 && pv >= 2 ? MODE_HARDENED : MODE_COMPAT;
  }

  /** 发送一条业务消息（自动加密 + seq 计数）。 */
  send(message, urgent = false) {
    if (this.closed) return false;
    this.#seq += 1;
    // seq 必须在此刻定格：连续多次 send 会把多帧排进微任务队列，
    // 投递时再读 this.#seq 会拿到更大的值 → AAD 不匹配 → 解密失败。
    const seq = this.#seq;
    const aadSid = this.mode === MODE_HARDENED ? this.sid : undefined;
    const data = seal(this.key, this.opts.role, seq, message, undefined, aadSid);
    const peer = this.#peer;
    if (peer === null) return false;
    void urgent;
    // 异步投递：模拟网络时序（不重入 send 调用栈）
    queueMicrotask(() => peer._deliver(data, seq, this.opts.role, this.sid));
    return true;
  }

  /** 收到对端的一帧密文：按「发送方 role」解密后交给 correlator。 */
  _deliver(data, seq, fromRole, sid) {
    if (this.closed) return;
    // 加固模式：收到的帧 sid 必须与钉扎值一致，否则丢弃
    if (this.mode === MODE_HARDENED && this.peerSid !== "" && sid !== this.peerSid) {
      this.opts.onStatus?.("drop frame: sid mismatch");
      return;
    }
    let m;
    try {
      const aadSid = this.mode === MODE_HARDENED ? this.peerSid : undefined;
      m = open(this.key, fromRole, seq, data, aadSid);
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
 * @param {{channel:string, secret:string, onHostMessage?:(m:any)=>void, onClientMessage?:(m:any)=>void,
 *          hostEpochStore?:EpochStore, clientEpochStore?:EpochStore}} opts
 */
export function createLoopbackPair(opts) {
  const host = new LoopbackLink({
    role: "host",
    channel: opts.channel,
    secret: opts.secret,
    epochStore: opts.hostEpochStore,
    epochFile: opts.hostEpochFile,
    onMessage: opts.onHostMessage ?? (() => {}),
    onStatus: opts.onStatus,
  });
  const client = new LoopbackLink({
    role: "client",
    channel: opts.channel,
    secret: opts.secret,
    epochStore: opts.clientEpochStore,
    epochFile: opts.clientEpochFile,
    onMessage: opts.onClientMessage ?? (() => {}),
    onStatus: opts.onStatus,
  });
  host._attach(client);
  client._attach(host);
  return { host, client };
}
