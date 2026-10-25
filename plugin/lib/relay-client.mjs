// lib/relay-client.mjs — 中继 WebSocket 客户端（契约 §4 / §3.4.1）。
//
// DSH 插件以 host 角色**出站连接**中继（无需端口映射）；中继只转发
// AES-256-GCM 密文帧（frame.data）。本模块职责：
//   - 连接 / hello（10s 内发出，带 §3.4.1 v2 握手证明与可选 RELAY_TOKEN）
//   - 指数退避重连：1s → 60s 封顶，带 ±50% 抖动
//   - 应用层心跳：30s 无帧即发 ping；90s 无任何消息判死重连
//   - 发送 seq 单调递增（从 1 开始）；接收按对端 seq 去重（同一 seq 只处理一次）
//   - 解密后把明文业务消息交给 onMessage
//
// **v1.1.3 会话纪元（契约 §3.4.1 / §7）**：
//   - hello 带 e/ts/pv/sid，sig 用 v2 证明串（"hello2|role|channel|e|ts|pv|sid"）。
//   - 对端证明由中继在 welcome.peer / peer-joined.peer 里**原样透传**（中继无密钥）。
//   - 模式判定：双方 pv≥2 → 加固模式（AAD 绑定发送方 sid + 钉扎对端 sid）；
//     任一方 pv<2（或对端没带证明）→ 兼容模式（旧 AAD）。
//   - 纪元单调性：对端 e ≤ 已接受值 → 拒绝连接（疑似重放）；同一证明重复 → 幂等接受。
//   - **收到 welcome 之前不发业务帧**（否则不知道对端 pv → AAD 会选错）。
//
// 传输层帧语义见契约 §4；加解密复用 lib/protocol.mjs。
import { randomBytes } from "node:crypto";
import {
  acceptPeerEpoch,
  deriveKey,
  helloSig2,
  HELLO_PROTO_VERSION,
  MODE_COMPAT,
  MODE_HARDENED,
  negotiateMode,
  open,
  seal,
  verifyHelloSig2,
} from "./protocol.mjs";

const HELLO_TIMEOUT_MS = 10_000; // 契约 §4：连接后 10s 内必须 hello
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s 无帧即发 ping
const DEAD_TIMEOUT_MS = 90_000; // 90s 无任何消息判死
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const SEEN_SET_TRIM = 2_048; // 去重集合超量时裁剪窗口
const PENDING_STASH_MAX = 16; // 模式切换竞态下暂存的帧数上限
const PENDING_STASH_TTL_MS = 15_000; // 暂存帧的最长存活时间

/**
 * @typedef {"connecting"|"handshaking"|"ready"|"disconnected"|"error"} RelayStatus
 * @typedef {{
 *   relayUrl: string, channel: string, secret: string,
 *   relayToken?: string,
 *   role?: "host"|"client",
 *   // v1.1.3 会话纪元的持久化钩子（契约 §3.4.1）。
 *   // 不传时退化为纯内存（进程内单调，跨重启不保留——只用于测试）。
 *   epoch?: {
 *     // 取下一个自纪元（实现方必须先落盘再返回；失败应抛错）。
 *     nextSelfEpoch?: () => number,
 *     // 读已接受的对端纪元锚点 {peer, peerSid}。
 *     peerState?: () => {peer?: number, peerSid?: string},
 *     // 持久化已接受的对端纪元锚点。
 *     savePeerEpoch?: (peer: number, peerSid: string) => void,
 *   },
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

  // ---- v1.1.3 会话纪元（契约 §3.4.1）--------------------------------------
  #selfEpoch = 0; // 本连接的自纪元（每条新连接 +1，先落盘再使用）
  #lastPeerEpoch = 0; // 已接受的对端纪元（回退检测的锚点，跨重启保留）
  #lastPeerSid = ""; // 已接受的对端纪元对应的 sid（锚点的一部分）
  #pinnedPeerSid = ""; // **本连接**钉扎的对端 sid（加固模式用于校验 frame.sid）
  #peerPv = 1; // 对端协议版本（1 = 旧端 / 未知）
  #peerProof = null; // 对端证明原文（welcome.peer / peer-joined.peer）
  #mode = MODE_COMPAT; // 当前握手模式（compat | hardened）
  #peerRejected = false; // 对端证明非法 → 拒绝连接（不发业务帧）
  #pendingFrames = []; // 兼容模式下解不开的帧（模式切换后按加固 AAD 重试）

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

  /** 当前握手模式："compat"（旧 AAD）或 "hardened"（AAD 绑定 sid）。 */
  get mode() {
    return this.#mode;
  }

  /** 本连接的自纪元号（契约 §3.4.1）。 */
  get selfEpoch() {
    return this.#selfEpoch;
  }

  /** 已钉扎的对端 sid（加固模式才有值；空串 = 还没接受对端证明）。 */
  get pinnedPeerSid() {
    return this.#pinnedPeerSid;
  }

  /** 对端协议版本（1 = 旧端/未知，2 = v1.1.3）。 */
  get peerProtocolVersion() {
    return this.#peerPv;
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
    this.#resetPeerState();
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
    // 换了对端身份 → 之前的对端证明/钉扎一律作废（新连接重新握手）。
    this.#resetPeerState();
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
   *
   * **AAD 两模式（契约 §7）**：兼容模式 "dshrc|role|seq"；加固模式再绑定**发送方**的
   * 连接实例 id（"dshrc|role|seq|sid"）。因此**必须等到 welcome 之后**才发
   * （welcome 才知道对端 pv → 才知道该用哪种 AAD）。
   * @param {object} message 明文业务消息
   * @param {boolean} [urgent] 审批/提问帧标记优先补发（契约 §4）
   * @returns {boolean}
   */
  send(message, urgent = false) {
    const ws = this.#ws;
    if (this.#closed || ws === null || ws.readyState !== 1 /* OPEN */) return false;
    if (!this.#handshaken) return false; // hello 握手完成前不发业务帧
    if (this.#peerRejected) return false; // 对端证明非法 → 拒绝连接，不发业务帧
    this.#seq += 1;
    const aadSid = this.#mode === MODE_HARDENED ? this.#sid : undefined;
    const frame = {
      t: "frame",
      sid: this.#sid,
      seq: this.#seq,
      data: seal(this.#key, "host", this.#seq, message, undefined, aadSid),
    };
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
      // v1.1.3：每条新连接自纪元 +1，**先落盘再使用**（崩溃也不能复用纪元）。
      // 落盘失败 → 拒绝开链路（纪元不可持久化 = 重放窗口，宁可不连）。
      const epoch = this.#nextSelfEpoch();
      if (epoch === null) {
        this.#opts.log?.("error", "session epoch persistence failed — refusing to open an unauthenticated link");
        this.#setStatus("error", "epoch-persist-failed");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.#selfEpoch = epoch;
      // 新连接 → 对端状态重新协商（钉扎/证明作废；纪元锚点从持久化里读）。
      this.#resetPeerState();
      this.#loadPeerState();
      this.#setStatus("handshaking");
      // 契约 §4：hello 必须是连接后第一条消息，10s 内未发出即断开重试。
      // v1.1.3：带 e/ts/pv/sid，sig 用 v2 证明串（§3.4.1）。
      const ts = Date.now();
      const pv = HELLO_PROTO_VERSION;
      const hello = {
        t: "hello",
        role: "host",
        ch: this.#opts.channel,
        e: this.#selfEpoch,
        ts,
        pv,
        sid: this.#sid,
        sig: helloSig2(this.#key, "host", this.#opts.channel, this.#selfEpoch, ts, pv, this.#sid),
      };
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
      this.#resetPeerState();
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
        // v1.1.3：对端证明（中继原样透传 welcome.peer）；没有 → 兼容模式。
        if (f.peer) this.#applyPeerProof(f.peer, "welcome");
        else this.#setCompatMode("peer proof absent");
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
        if (joined) {
          // v1.1.3：peer-joined 带**新上线方**的证明（§4：中继逐字复制）。
          if (f.peer) this.#applyPeerProof(f.peer, "peer-joined");
        } else {
          // 对端下线 → 钉扎作废（重新上线时会有新的证明与新的 sid）。
          this.#resetPeerState();
        }
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

  // ---- v1.1.3 会话纪元（契约 §3.4.1）--------------------------------------

  /**
   * 复位**本连接**的对端协商状态（证明/钉扎/模式）。
   * 注意：**不动** #lastPeerEpoch/#lastPeerSid —— 那是跨重启的抗重放锚点。
   */
  #resetPeerState() {
    this.#pinnedPeerSid = "";
    this.#peerPv = 1;
    this.#peerProof = null;
    this.#mode = MODE_COMPAT;
    this.#peerRejected = false;
    this.#pendingFrames = [];
  }

  /** 从持久化里读「已接受的对端纪元」锚点（回退检测用）。 */
  #loadPeerState() {
    const state = this.#readPeerState();
    this.#lastPeerEpoch = state.peer;
    this.#lastPeerSid = state.peerSid;
  }

  /** 读持久化的对端纪元锚点（无钩子时用内存态）。 */
  #readPeerState() {
    const fn = this.#opts.epoch?.peerState;
    if (typeof fn === "function") {
      try {
        const raw = fn() ?? {};
        const peer = Number.isInteger(raw.peer) ? raw.peer : 0;
        const peerSid = typeof raw.peerSid === "string" ? raw.peerSid : "";
        return { peer, peerSid };
      } catch (e) {
        this.#opts.log?.("error", "peer epoch state read failed", { error: String(e && e.message) });
      }
    }
    return { peer: this.#lastPeerEpoch, peerSid: this.#lastPeerSid };
  }

  /** 持久化「已接受的对端纪元 + 钉扎 sid」（跨重启有效）。 */
  #savePeerState(peer, peerSid) {
    const fn = this.#opts.epoch?.savePeerEpoch;
    if (typeof fn !== "function") return;
    try {
      fn(peer, peerSid);
    } catch (e) {
      this.#opts.log?.("error", "peer epoch persistence failed", { error: String(e && e.message) });
    }
  }

  /**
   * 取下一个自纪元（**先落盘再使用**；契约 §3.4.1）。
   * 落盘失败 → 返回 null（调用方拒绝开链路：纪元不可持久化 = 重放窗口）。
   * @returns {number|null}
   */
  #nextSelfEpoch() {
    const fn = this.#opts.epoch?.nextSelfEpoch;
    if (typeof fn === "function") {
      try {
        const n = fn();
        if (Number.isInteger(n) && n >= 0) return n;
        this.#opts.log?.("error", "session epoch provider returned an invalid value");
        return null;
      } catch (e) {
        this.#opts.log?.("error", "session epoch persistence failed", { error: String(e && e.message) });
        return null;
      }
    }
    // 无持久化钩子（仅测试用）：内存里单调递增。
    this.#selfEpoch += 1;
    return this.#selfEpoch;
  }

  /** 退到兼容模式（对端是旧端 / 没有证明）。 */
  #setCompatMode(reason) {
    this.#mode = MODE_COMPAT;
    this.#peerPv = 1;
    this.#pinnedPeerSid = "";
    this.#opts.log?.("info", "handshake in compatibility mode", { reason });
  }

  /**
   * 处理中继透传的对端证明（welcome.peer / peer-joined.peer，契约 §3.4.1）：
   *   ① pv≥2 → 先验签（不过 → 拒绝连接）；再查纪元单调性（回退 → 拒绝连接）；
   *      通过 → 钉扎 (e, sid) 并持久化 → 切加固模式。
   *   ② pv<2（旧端）→ 兼容模式（不钉扎、不记纪元）。
   * @param {unknown} proof 中继原样复制过来的对端 hello 证明
   * @param {string} source 来源（诊断用）
   */
  #applyPeerProof(proof, source) {
    if (proof === null || typeof proof !== "object") {
      this.#setCompatMode("peer proof malformed");
      return;
    }
    const p = /** @type {Record<string, unknown>} */ (proof);
    const role = p.role === "client" ? "client" : "host";
    if (role === this.#opts.role) {
      // 不是对端的证明（对端 role 与自己相同 = 中继串台）→ 忽略。
      this.#opts.log?.("warn", "ignoring peer proof with our own role", { role, source });
      return;
    }
    const pv = Number.isInteger(p.pv) ? /** @type {number} */ (p.pv) : 1;
    if (pv < 2) {
      // 旧端：没有纪元也没有证明 → 兼容模式。
      this.#peerProof = p;
      this.#setCompatMode("peer protocol version < 2");
      return;
    }
    const e = /** @type {number} */ (p.e);
    const ts = /** @type {number} */ (p.ts);
    const sid = /** @type {string} */ (p.sid);
    // ① 验签（恒定时间比较；中继无密钥、只能复制 → 验签通过即可信任）。
    if (!verifyHelloSig2(this.#key, role, this.#opts.channel, e, ts, pv, sid, /** @type {string} */ (p.sig))) {
      this.#opts.log?.("error", "peer handshake proof v2 verification failed — connection rejected", { role, source });
      this.#rejectPeer("peer-proof-invalid");
      return;
    }
    // ② 纪元单调性（回退 = 疑似重放 → 拒绝连接）。
    const verdict = acceptPeerEpoch({ peerEpoch: this.#lastPeerEpoch, peerSid: this.#lastPeerSid }, { e, sid });
    if (!verdict.ok) {
      this.#opts.log?.("error", "peer session epoch rejected — connection rejected", {
        role,
        source,
        reason: verdict.reason,
      });
      this.#rejectPeer(verdict.reason ?? "epoch-rejected");
      return;
    }
    if (!verdict.duplicate) {
      this.#lastPeerEpoch = verdict.peerEpoch;
      this.#lastPeerSid = verdict.peerSid;
      this.#savePeerState(verdict.peerEpoch, verdict.peerSid);
    }
    this.#peerProof = p;
    this.#peerPv = pv;
    this.#pinnedPeerSid = sid;
    this.#mode = negotiateMode(HELLO_PROTO_VERSION, pv);
    this.#opts.log?.("info", "handshake in hardened mode", { role, source, duplicate: verdict.duplicate === true });
    // 模式切换竞态：之前用兼容 AAD 解不开的帧，按加固 AAD 重试一次。
    this.#retryPendingFrames();
  }

  /** 拒绝连接：断开 socket、不发业务帧（对端证明非法 / 纪元回退）。 */
  #rejectPeer(reason) {
    this.#peerRejected = true;
    this.#handshaken = false;
    this.#pendingFrames = [];
    this.#setStatus("error", reason);
    this.#opts.log?.("error", "rejecting relay connection", { reason });
    const ws = this.#ws;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 处理转发帧：去重（sid:seq）→ sid 钉扎校验 → 解密（role 用发送方的 role）→ 上交。 */
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
    // v1.1.3 加固模式：**钉扎**对端 sid——收到的帧 sid 不符 → 丢弃（跨会话重放）。
    let aadSid;
    if (this.#mode === MODE_HARDENED) {
      if (this.#pinnedPeerSid === "") {
        this.#opts.log?.("warn", "hardened mode without pinned peer sid; frame dropped", { seq });
        return;
      }
      if (sid !== this.#pinnedPeerSid) {
        this.#opts.log?.("warn", "frame sid mismatch; frame dropped", { seq });
        return;
      }
      aadSid = sid;
    }
    let m;
    try {
      m = open(this.#key, from, seq, f.data, aadSid);
    } catch (e) {
      // 兼容模式下、**还不知道对端 pv** 时解不开 → 可能是对端已经切到加固模式
      // （模式切换竞态：welcome 与 peer-joined 落在不同 socket 上）→ 暂存，
      // 等对端证明到达、模式切到加固后按加固 AAD 重试一次。
      if (this.#mode === MODE_COMPAT && this.#peerProof === null && this.#pendingFrames.length < PENDING_STASH_MAX) {
        this.#pendingFrames.push({ seq, sid, from, data: f.data, at: Date.now() });
        return;
      }
      // 密钥不匹配或帧损坏：丢帧并节流告警（避免刷屏）。
      this.#opts.log?.("warn", "decrypt failed; frame dropped", { seq, error: String(e && e.message) });
      return;
    }
    this.#deliver(m);
  }

  /**
   * 模式切到加固模式后，把暂存的帧按加固 AAD 重试一次。
   * 只接受**能按加固 AAD 解开且 sid 与钉扎值一致**的帧（安全性等价于加固模式）。
   */
  #retryPendingFrames() {
    if (this.#pendingFrames.length === 0) return;
    const list = this.#pendingFrames;
    this.#pendingFrames = [];
    const now = Date.now();
    for (const item of list) {
      if (now - item.at > PENDING_STASH_TTL_MS) continue; // 过期丢弃
      if (this.#mode !== MODE_HARDENED) continue;
      if (item.sid !== this.#pinnedPeerSid) continue;
      let m;
      try {
        m = open(this.#key, item.from, item.seq, item.data, item.sid);
      } catch {
        continue;
      }
      this.#deliver(m);
    }
  }

  /** 把解密后的业务消息交给上层（异常不许打断链路）。 */
  #deliver(m) {
    try {
      this.#opts.onMessage(m);
    } catch (e) {
      this.#opts.log?.("error", "message handler threw", { type: m && m.type, error: String(e && e.message) });
    }
  }
}
