/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 链路层：WebSocket 客户端 → 中继（契约 §4；仓库根 docs/PROTOCOL.md v1.1.3）。
 * 职责：
 *  - 连接前先跑 assertKat()（契约 §7 KAT 逐字节自检），失败则不建链
 *  - 连接 / 断线重连（指数退避 1s→60s + 抖动）
 *  - 收到 welcome 前发 hello（v1.1.3：sig = base64url(HMAC-SHA256(key,
 *    "hello2|client|"+channel+"|"+e+"|"+ts+"|"+pv+"|"+sid))，并带 e/ts/pv/sid）
 *  - 30s 无帧发 ping；90s 无任何消息判死并重连
 *  - sid/seq（契约 §4 v1.0.2）：每条 WS 连接（含重连）生成一次 8 位十六进制 sid，
 *    seq 每条连接从 1 开始；接收去重键为 sid+":"+seq（缺 sid 按 "legacy"），
 *    seen 按 sid 分桶（单桶 >4096 裁剪最旧，总桶 >64 淘汰最旧）
 *  - 业务消息收发加解密（AES-256-GCM，iv||ct||tag）
 *  - Correlator 请求-响应关联（result{id,ok,value|error}）
 *
 * v1.1.3 会话纪元（契约 §3.4.1，抗重放）：
 *  - 传输层 hello 带 e(纪元)/ts/pv(=2)/sid，证明串覆盖它们（hello2|…）
 *  - 对端证明来自 welcome.peer / peer-joined.peer（中继原样透传）→ 验签 → 判模式 →
 *    钉扎对端 sid → 纪元回退即拒绝连接
 *  - 模式：双方 pv>=2 = 加固（AAD = "dshrc|role|seq|sid"，sid = 发送方自己）；
 *    任一方 pv<2 = 兼容（AAD = "dshrc|role|seq"）
 *  - 业务帧必须在**知道对端 pv 之后**才发（否则双方 AAD 选得不一样）
 */
import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { logDshrc } from './logger';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEAD_TIMEOUT_MS,
  DshrcMsg,
  DshrcPayload,
  DshrcValue,
  DshrcAnswers,
  DshrcSessionSummary,
  DshrcHistoryPage,
  DshrcCapabilities,
  DshrcCreateResult,
  DshrcModelSelection,
  DshrcPromptMode,
  DshrcPromptResult,
  DshrcQueueItem,
  DshrcSubagentInfo,
  DshrcRelayFrame,
  DshrcRelayPeers,
  DshrcPeerProof,
  FRAME_ERROR,
  FRAME_FRAME,
  FRAME_HELLO,
  FRAME_PING,
  FRAME_PONG,
  FRAME_PEER_JOINED,
  FRAME_PEER_LEFT,
  FRAME_WELCOME,
  HEARTBEAT_INTERVAL_MS,
  HELLO_TIMEOUT_MS,
  MSG_HELLO,
  MSG_RESULT,
  MSG_SESSION_LIST,
  MSG_SESSION_HISTORY,
  MSG_SESSION_CAPABILITIES,
  MSG_SESSION_SUBAGENTS,
  MSG_SESSION_SUBAGENT_PROMPT,
  MSG_SESSION_SUBAGENT_CANCEL,
  MSG_SESSION_CREATE,
  MSG_SESSION_ARCHIVE,
  MSG_SESSION_UNARCHIVE,
  MSG_SESSION_SELECT_MODEL,
  MSG_SESSION_MODEL,
  MSG_SESSION_SELECT_PERMISSION,
  MSG_SESSION_PERMISSION,
  MSG_SESSION_QUEUE,
  MSG_SESSION_PROMPT,
  MSG_SESSION_CANCEL,
  MSG_SESSION_RENAME,
  MSG_APPROVAL_ANSWER,
  MSG_QUESTION_ANSWER,
  MSG_PUSH_REGISTER,
  MSG_PING,
  PROTO_HELLO_V2,
  PROTO_VERSION,
  ROLE_CLIENT,
  ROLE_HOST,
  SEEN_BUCKET_MAX,
  SEEN_MAX_SIDS,
  SID_LEGACY,
  SID_LEN,
  SID_PATTERN,
  makeMsg
} from './protocol';
import { assertKat, deriveKey, helloSig, helloSig2, open, seal } from './crypto';
import { DshrcOrderedQueue } from './ordered-queue';
import { postBusMsg, postLinkPeers, postLinkState } from './events';

const TAG: string = 'dshrc-link';
const DEFAULT_REQ_TIMEOUT_MS: number = 15000;
const HOST_HELLO_TIMEOUT_MS: number = 15000;
/** 加固模式下连续 sid 不匹配（对端换了连接实例）达到该次数 → 重连自愈（契约 §3.4.1 钉扎语义）。 */
const SID_MISMATCH_RECONNECT_THRESHOLD: number = 3;

/** 链路状态（字符串字面量，UI 直接展示）。 */
export type LinkState = 'idle' | 'deriving' | 'connecting' | 'handshaking' | 'online' | 'reconnecting' | 'stopped' | 'error';

/**
 * 会话纪元状态（契约 §3.4.1，v1.1.3）：
 *  - self   : 本端自己的纪元（每条新连接 +1，**先持久化再使用**）
 *  - peer   : 已接受的对端最高纪元（-1 = 尚未接受过任何对端证明）
 *  - peerSid: 已钉扎的对端 sid（加固模式下必须与收到的 frame.sid 一致）
 */
export interface LinkEpochState {
  self: number;
  peer: number;
  peerSid: string;
}

/** 配置（由配对页写入）。 */
export interface LinkConfig {
  relayUrl: string;
  channel: string;
  secret: string;
  relayToken: string;
  clientName: string;
  appVersion: string;
  /** v1.1.3：纪元状态（缺省 = 不持久化，仅进程内自增；生产路径由 connections.ets 注入）。 */
  epoch?: LinkEpochState;
  /** v1.1.3：纪元状态变更回调（**先持久化再使用**的要求由调用方兑现）。 */
  onEpoch?: (s: LinkEpochState) => void;
}

/** 对端在线状态（welcome.peers / peer-joined / peer-left 维护）。 */
export interface LinkPeers {
  host: boolean;
  client: boolean;
}

/** 主机信息（业务 hello 响应，§5.1）：连接信息页展示。 */
export interface DshrcHostInfo {
  hostName: string;
  dshVersion: string;
  pluginVersion: string;
}

/** seen 去重桶（契约 §4 v1.0.2）：按发送端 sid 分桶。 */
interface SeenBucket {
  seqs: Set<number>; // 本 sid 见过的 seq
  order: number[]; // seq 插入顺序（单桶裁剪最旧用）
  last: number; // 最近活动时间戳（总桶淘汰最旧用）
}

/** 生成 8 位十六进制发送端实例 id（契约 §4 v1.0.2；仅用于去重，不作安全用途）。 */
function newSid(): string {
  let s: string = '';
  for (let i: number = 0; i < SID_LEN; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}

/** 待处理请求。 */
interface PendingRequest {
  resolve: (v: DshrcValue) => void;
  reject: (e: Error) => void;
  timerId: number;
}

/**
 * 请求-响应关联表（契约 §5）：result{id} 命中 pending 则回填，否则交给事件回调。
 * resolve 的值类型是 result.value（DshrcValue）。
 */
export class Correlator {
  private pending: Map<string, PendingRequest> = new Map<string, PendingRequest>();

  /** 发起一条请求：send 返回后等待 result；超时 reject。 */
  request(send: (m: DshrcMsg) => void, type: string, payload: DshrcPayload,
    timeoutMs: number): Promise<DshrcValue> {
    const m: DshrcMsg = makeMsg(type, payload, util.generateRandomUUID());
    return new Promise<DshrcValue>((resolve: (v: DshrcValue) => void,
      reject: (e: Error) => void) => {
      const timerId: number = setTimeout(() => {
        this.pending.delete(m.id);
        reject(new Error('request timeout: ' + type));
      }, timeoutMs);
      this.pending.set(m.id, { resolve: resolve, reject: reject, timerId: timerId });
      try {
        send(m);
      } catch (e) {
        this.pending.delete(m.id);
        clearTimeout(timerId);
        const err: Error = e instanceof Error ? e : new Error('send failed');
        reject(err);
      }
    });
  }

  /**
   * 投递一条解密后的业务消息。
   * result{id} 且命中 pending → 回填并返回 true；其他（event / 未命中 result）返回 false。
   */
  deliver(m: DshrcMsg): boolean {
    if (m.type === MSG_RESULT) {
      const reqId: string = m.payload.id !== undefined ? m.payload.id : '';
      const p: PendingRequest | undefined = this.pending.get(reqId);
      if (p !== undefined) {
        this.pending.delete(reqId);
        clearTimeout(p.timerId);
        if (m.payload.ok === true) {
          // value 缺省时兜底为空 DshrcValue（JSON 断言避开弱类型空字面量检查）。
          const emptyVal: DshrcValue = JSON.parse('{}') as DshrcValue;
          const val: DshrcValue = m.payload.value !== undefined ? m.payload.value : emptyVal;
          p.resolve(val);
        } else {
          const body = m.payload.error;
          const msg: string = body !== undefined ? (body.code + ': ' + body.message) : 'remote error';
          p.reject(new Error(msg));
        }
        return true;
      }
    }
    return false;
  }

  /** 断线时清空所有 pending（全部 reject）。 */
  rejectAll(reason: string): void {
    this.pending.forEach((p: PendingRequest, id: string) => {
      clearTimeout(p.timerId);
      p.reject(new Error(reason));
    });
    this.pending.clear();
  }
}

/**
 * DSH 中继链路（单例使用）。状态迁移：
 * idle/deriving → connecting(ws connect) → handshaking(hello/welcome) → online
 * 任意在线态断开 → reconnecting（指数退避）→ connecting …
 * stop() → stopped；配置非法或 hello 被拒 → error。
 * 终局错误（relay: bad-hello / channel-full / replaced）→ error 并**停止自动重连**
 *   （不置 reconnecting，否则「重连 → 再次被顶替」死循环，UI 永远停在「重连中」）。
 */
export class DshrcLink {
  private ws: webSocket.WebSocket | null = null;
  private key: Uint8Array | null = null;
  private cfg: LinkConfig | null = null;
  private shouldRun: boolean = false;
  private state: LinkState = 'idle';
  private sendSeq: number = 0; // 本条连接的发送序号（v1.0.2：每条连接从 1 开始）
  private sid: string = ''; // 本条连接的发送端实例 id（v1.0.2）
  private seen: Map<string, SeenBucket> = new Map<string, SeenBucket>(); // 接收去重（按 sid 分桶）
  private reconnectAttempts: number = 0;
  private peers: LinkPeers = { host: false, client: false };
  private correlator: Correlator = new Correlator();
  private lastRecvTs: number = 0;
  private lastSendTs: number = 0;
  private heartbeatTimerId: number = -1;
  private helloTimerId: number = -1;
  private reconnectTimerId: number = -1;
  private katChecked: boolean = false; // 契约 §7 KAT 已通过（连接前执行一次）
  // ---- v1.1.3 会话纪元（契约 §3.4.1）----
  /** 纪元状态（self=自己的纪元 / peer=已接受的对端纪元 / peerSid=已钉扎的对端 sid）。 */
  private epoch: LinkEpochState = { self: 0, peer: -1, peerSid: '' };
  /** 对端握手证明版本 pv（0 = 未知；>=2 = 支持 v2 证明）。 */
  private peerPv: number = 0;
  /** 是否已知对端 pv（未知时**不能**发业务帧：否则 AAD 模式会选错）。 */
  private peerPvKnown: boolean = false;
  /** 当前模式：true = 加固（AAD 绑定 sid），false = 兼容（旧 AAD）。 */
  private hardened: boolean = false;
  /** 本连接是否已发过业务 hello（契约：收到 welcome 之后才发）。 */
  private businessHelloSent: boolean = false;
  /** 加固模式下连续 sid 不匹配的帧数（达到阈值 → 重连自愈）。 */
  private sidMismatchCount: number = 0;
  /** 异步帧世代：停止/断线/新连接后，旧连接的解密与加密回调一律失效。 */
  private connectionGeneration: number = 0;
  /** host→client：按 WS 到达顺序串行解密并分发，杜绝 turn.end 越过先前事件。 */
  private inboundQueue: DshrcOrderedQueue = new DshrcOrderedQueue();
  /** client→host：按 seq 分配顺序串行加密并发送。 */
  private outboundQueue: DshrcOrderedQueue = new DshrcOrderedQueue();

  /** UI 回调（在 UIAbility 主线程设置；WS 回调也在主线程分发）。 */
  onState: ((s: LinkState) => void) | null = null;
  onEvent: ((m: DshrcMsg) => void) | null = null;
  onPeers: ((p: LinkPeers) => void) | null = null;
  onLog: ((line: string) => void) | null = null;
  /** 业务 hello 成功回调（连接信息页展示主机名/版本）。 */
  onHello: ((info: DshrcHostInfo) => void) | null = null;

  getState(): LinkState {
    return this.state;
  }

  getPeers(): LinkPeers {
    return this.peers;
  }

  private log(line: string): void {
    // 双写：hilog（实时）+ Logan 文件（崩溃后排障）——logger.ets 统一入口。
    logDshrc(TAG, 'info', line);
    if (this.onLog !== null) {
      this.onLog(line);
    }
  }

  private setState(s: LinkState): void {
    this.state = s;
    // 兼容保留直接回调；同时走事件总线广播（页面用 onFromComponent 订阅，自动反注册）。
    if (this.onState !== null) {
      this.onState(s);
    }
    postLinkState(s);
  }

  /** peers 变化统一出口：直接回调（兼容）+ 事件总线广播。 */
  private emitPeers(): void {
    if (this.onPeers !== null) {
      this.onPeers(this.peers);
    }
    postLinkPeers(this.peers.host);
  }

  /** 启动链路：先做 KAT 级密钥派生，再连接。重复调用以最新配置重启。 */
  async start(cfg: LinkConfig): Promise<void> {
    this.stopInternal('restart');
    this.cfg = cfg;
    this.shouldRun = true;
    this.sendSeq = 0;
    this.sid = '';
    this.reconnectAttempts = 0;
    this.peers = { host: false, client: false };
    // v1.1.3：纪元状态从配置注入（持久化在远程档案里 → 跨进程重启单调）。
    const ep: LinkEpochState | undefined = cfg.epoch;
    if (ep !== undefined) {
      this.epoch = { self: ep.self, peer: ep.peer, peerSid: ep.peerSid };
    }
    this.peerPv = 0;
    this.peerPvKnown = false;
    this.hardened = false;
    this.businessHelloSent = false;
    this.sidMismatchCount = 0;
    this.setState('deriving');
    try {
      // 契约 §7：KAT 必须在连接建立前执行；成功后缓存，进程内只跑一次。
      if (!this.katChecked) {
        await assertKat();
        this.katChecked = true;
        this.log('KAT passed (HKDF / AES-256-GCM 与契约 §7 逐字节一致)');
      }
      this.key = await deriveKey(cfg.secret, cfg.channel);
    } catch (e) {
      this.setState('error');
      this.log('derive key failed: ' + (e instanceof Error ? e.message : 'unknown'));
      return;
    }
    this.connectOnce();
  }

  /** 停止链路（用户主动断开）。 */
  stop(): void {
    this.shouldRun = false;
    this.stopInternal('stopped');
    this.setState('stopped');
  }

  /**
   * 回前台立即重连（v1.0.9）：App 在后台时系统可能冻结定时器/挂起套接字，
   * 退避重连最长要等 60s；回前台时若正处于重连等待，跳过剩余退避立即试一次，
   * 并重置退避档位（真机场景：扫码后一直「重连中」，切几次前后台才连上）。
   * 仅在「应该运行且正在重连等待」时生效，不打扰正常在线/终局状态。
   */
  kickReconnect(): void {
    if (!this.shouldRun || this.state !== 'reconnecting') {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.log('foreground kick: reconnect now');
    this.connectOnce();
  }

  /** 作废旧连接的异步工作，并给新世代独立队列，避免旧积压阻塞新连接。 */
  private invalidateAsyncFrames(): void {
    this.connectionGeneration = this.connectionGeneration + 1;
    this.inboundQueue = new DshrcOrderedQueue();
    this.outboundQueue = new DshrcOrderedQueue();
  }

  private stopInternal(reason: string): void {
    this.invalidateAsyncFrames();
    this.clearHeartbeatTimer();
    this.clearHelloTimer();
    this.clearReconnectTimer();
    this.correlator.rejectAll('link closed: ' + reason);
    const wsRef: webSocket.WebSocket | null = this.ws;
    this.ws = null;
    if (wsRef !== null) {
      try {
        wsRef.off('open');
        wsRef.off('message');
        wsRef.off('close');
        wsRef.off('error');
        wsRef.close().catch((e: BusinessError) => {
          this.log('close failed: ' + e.code);
        });
      } catch (e) {
        this.log('close exception');
      }
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimerId >= 0) {
      clearInterval(this.heartbeatTimerId);
      this.heartbeatTimerId = -1;
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimerId >= 0) {
      clearTimeout(this.helloTimerId);
      this.helloTimerId = -1;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId >= 0) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = -1;
    }
  }

  /** 一次连接尝试（每次都新建 WebSocket 实例）。 */
  private connectOnce(): void {
    if (!this.shouldRun || this.cfg === null) {
      return;
    }
    this.invalidateAsyncFrames();
    // 契约 §4 v1.0.2：每条 WS 连接（含重连）生成新 sid，seq 从 1 重新开始
    this.sid = newSid();
    this.sendSeq = 0;
    // 每条新连接重新判定模式（对端 pv 只能从本连接 welcome/peer-joined 的证明得知）
    this.peerPv = 0;
    this.peerPvKnown = false;
    this.hardened = false;
    this.businessHelloSent = false;
    this.sidMismatchCount = 0;
    // 契约 §3.4.1：每条新连接纪元 +1，**先持久化再使用**（跨进程重启必须单调）。
    this.epoch.self = this.epoch.self + 1;
    this.persistEpoch();
    const cfg: LinkConfig = this.cfg;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const ws: webSocket.WebSocket = webSocket.createWebSocket();
    this.ws = ws;

    ws.on('open', (err: BusinessError, value: Object) => {
      // 官方语义：成功时 err 为 undefined —— 必须判空再读 code（真机崩溃点）
      if (err !== undefined && err !== null) {
        this.log('open error: ' + err.code + ' ' + err.message);
        return;
      }
      if (this.ws !== ws) {
        return; // 已被新连接替换
      }
      this.onWsOpen(cfg);
    });
    ws.on('message', (err: BusinessError<void>, value: string | ArrayBuffer) => {
      if (this.ws !== ws) {
        return;
      }
      if (typeof value === 'string') {
        this.onWsMessage(value);
      }
    });
    ws.on('close', (err: BusinessError, value: webSocket.CloseResult) => {
      if (this.ws !== ws) {
        return;
      }
      const closeCode: number = err !== undefined && err !== null ? err.code : -1;
      this.log('closed: code=' + closeCode + ' reason=' + value.reason);
      this.onWsDown('closed');
    });
    ws.on('error', (err: BusinessError) => {
      if (this.ws !== ws) {
        return;
      }
      this.log('error: ' + err.code + ' ' + err.message);
      this.onWsDown('error');
    });

    ws.connect(cfg.relayUrl).then((ok: boolean) => {
      this.log('connect() resolved: ' + ok.toString());
    }).catch((e: BusinessError) => {
      this.log('connect failed: ' + e.code + ' ' + e.message);
      if (this.ws === ws) {
        this.onWsDown('connect-failed');
      }
    });
  }

  /** WS 已建立：发送中继 hello（契约 §4 + v1.1.3 §3.4.1 纪元证明 v2）。 */
  private onWsOpen(cfg: LinkConfig): void {
    this.setState('handshaking');
    this.lastRecvTs = Date.now();
    this.lastSendTs = Date.now();
    const key: Uint8Array | null = this.key;
    if (key === null) {
      return;
    }
    // v1.1.3：证明串覆盖 role/channel/纪元/时刻/版本/连接实例 id。
    const epoch: number = this.epoch.self;
    const ts: number = Date.now();
    const pv: number = PROTO_HELLO_V2;
    const sid: string = this.sid;
    const generation: number = this.connectionGeneration;
    helloSig2(key, ROLE_CLIENT, cfg.channel, epoch, ts, pv, sid).then((sig: string) => {
      if (generation !== this.connectionGeneration || this.sid !== sid) {
        return;
      }
      const hello: DshrcRelayFrame = {
        t: FRAME_HELLO,
        role: ROLE_CLIENT,
        ch: cfg.channel,
        sig: sig,
        e: epoch,
        ts: ts,
        pv: pv,
        sid: sid
      };
      if (cfg.relayToken.length > 0) {
        hello.token = cfg.relayToken;
      }
      this.sendRelayJson(JSON.stringify(hello));
      // 10s 内必须收到 welcome，否则判死重连
      this.clearHelloTimer();
      this.helloTimerId = setTimeout(() => {
        this.helloTimerId = -1;
        if (this.state === 'handshaking') {
          this.log('welcome timeout, dropping connection');
          this.forceReconnect('welcome-timeout');
        }
      }, HELLO_TIMEOUT_MS);
    }).catch((e: BusinessError) => {
      this.log('helloSig2 failed: ' + e.code);
    });
  }

  /** 连接下行消息（明文 JSON 中继帧）。 */
  private onWsMessage(text: string): void {
    this.lastRecvTs = Date.now();
    let frame: DshrcRelayFrame | null = null;
    try {
      frame = JSON.parse(text) as DshrcRelayFrame;
    } catch (e) {
      this.log('bad relay json, dropped');
      return;
    }
    if (frame === null) {
      return;
    }
    switch (frame.t) {
      case FRAME_WELCOME: {
        this.clearHelloTimer();
        this.reconnectAttempts = 0;
        this.handleWelcome(frame).catch((e: Error) => {
          this.log('welcome handling failed: ' + e.message);
        });
        break;
      }
      case FRAME_PEER_JOINED: {
        if (frame.role === ROLE_HOST) {
          // host（重）上线：v1.0.2 起 host 每条连接生成新 sid 并重置 seq，
          // 去重按 sid 分桶，无需清空游标（契约 §4 v1.0.2）。
          this.peers.host = true;
          this.emitPeers();
          this.handlePeerJoined(frame).catch((e: Error) => {
            this.log('peer-joined handling failed: ' + e.message);
          });
        }
        break;
      }
      case FRAME_PEER_LEFT: {
        if (frame.role === ROLE_HOST) {
          this.peers.host = false;
          this.emitPeers();
          this.log('host left');
        }
        break;
      }
      case FRAME_FRAME: {
        this.onRelayFrame(frame);
        break;
      }
      case FRAME_PING: {
        const pongFrame: DshrcRelayFrame = { t: FRAME_PONG };
        this.sendRelayJson(JSON.stringify(pongFrame));
        break;
      }
      case FRAME_PONG: {
        break; // lastRecvTs 已更新
      }
      case FRAME_ERROR: {
        const code: string = frame.code !== undefined ? frame.code : '?';
        this.log('relay error: ' + code + ' ' + (frame.message !== undefined ? frame.message : ''));
        // 终局错误（契约 §4）：鉴权失败 bad-hello / 频道被占 channel-full /
        // 被同 role 的新连接顶替 replaced —— 重连没有意义（replaced 会「重连→再被顶替」
        // 死循环，UI 永远停在「重连中」），必须停掉自动重连并落到 error。
        if (code === 'bad-hello' || code === 'channel-full' || code === 'replaced') {
          this.shouldRun = false;
          this.clearHeartbeatTimer();
          this.clearHelloTimer();
          this.clearReconnectTimer();
          this.setState('error');
          this.peers = { host: false, client: false };
          this.emitPeers();
          // 关掉当前 ws（内部同样清 timer + reject pending 请求）；
          // 随后的 close 事件由 onWsDown 兜底：state 已是 error → 保持 error，不再重连。
          this.stopInternal('relay-' + code);
          this.log('relay terminal error: ' + code + ', auto reconnect stopped');
        }
        // rate-limited 等非终局错误：交给退避重连（onWsDown 统一处理）
        break;
      }
      default: {
        this.log('unknown relay frame: ' + frame.t);
        break;
      }
    }
  }

  // ---- v1.1.3 会话纪元（契约 §3.4.1）------------------------------------

  /**
   * welcome 处理（契约 §4 + §3.4.1）：
   *  - 取对端 hello 证明（`welcome.peer`，中继原样透传）→ 验签 → 纪元单调性 → 钉扎 sid；
   *  - 判定模式（双方 pv>=2 = 加固）；**知道对端 pv 之前不发业务帧**（否则 AAD 会选错）；
   *  - 对端在线但没带证明 → 旧端（pv 视为 1）→ 兼容模式。
   */
  private async handleWelcome(frame: DshrcRelayFrame): Promise<void> {
    const generation: number = this.connectionGeneration;
    const peers: DshrcRelayPeers | undefined = frame.peers;
    if (peers !== undefined) {
      this.peers = { host: peers.host, client: peers.client };
    } else {
      // 极老中继不带 peers：无从判断对端是否在线 → 退回兼容模式（v1.1.2 行为）。
      this.log('welcome without peers field (legacy relay), compat mode');
    }
    const proof: DshrcPeerProof | undefined = frame.peer;
    if (proof !== undefined) {
      const accepted: boolean = await this.acceptPeerProof(proof);
      if (!accepted || generation !== this.connectionGeneration) {
        return; // 已拒绝连接，或证明验签期间连接世代已变化
      }
    } else if (peers === undefined || peers.host) {
      // 对端在线却没带证明 → 旧端（pv 缺省视为 1）→ 兼容模式。
      this.peerPv = 1;
      this.peerPvKnown = true;
      this.applyMode();
    }
    // 对端离线（peers.host=false）且没有证明 → 对端 pv 未知：
    // **不发业务帧**（否则 AAD 模式可能与对端选得不一样）→ 等 peer-joined 拿到证明。
    this.setState('online');
    this.startHeartbeat();
    this.log('online, peers=' + JSON.stringify(this.peers));
    this.emitPeers();
    this.maybeSendBusinessHello();
  }

  /**
   * peer-joined 处理（契约 §4 + §3.4.1）：host 上线时中继带上它的 hello 证明。
   * 证明里带新的 sid（host 每条连接一个新 sid）→ 重新钉扎；纪元必须比已接受值大。
   */
  private async handlePeerJoined(frame: DshrcRelayFrame): Promise<void> {
    const generation: number = this.connectionGeneration;
    const proof: DshrcPeerProof | undefined = frame.peer;
    if (proof !== undefined) {
      const accepted: boolean = await this.acceptPeerProof(proof);
      if (!accepted || generation !== this.connectionGeneration) {
        return; // 已拒绝连接，或证明验签期间连接世代已变化
      }
      this.log('host joined (proof accepted, epoch=' + this.epoch.peer.toString() + ')');
    } else {
      // 旧端上线（无证明）→ 兼容模式
      this.peerPv = 1;
      this.peerPvKnown = true;
      this.applyMode();
      this.log('host joined (legacy peer, no proof)');
    }
    this.maybeSendBusinessHello();
  }

  /**
   * 接受对端 hello 证明（契约 §3.4.1）：
   *  1. pv>=2 → 用本端 key 验 v2 证明串；验不过 → **拒绝连接**（疑似伪造/重放）。
   *  2. 纪元单调性：同一 (e,sid) 重复出现 → 幂等接受（welcome 与 peer-joined 都带）；
   *     e <= 已接受纪元 → **拒绝连接**（纪元回退 = 疑似重放）。
   *  3. 通过 → 钉扎对端 sid + 持久化「已接受的对端纪元」。
   */
  private async acceptPeerProof(proof: DshrcPeerProof): Promise<boolean> {
    const generation: number = this.connectionGeneration;
    const key: Uint8Array | null = this.key;
    const cfg: LinkConfig | null = this.cfg;
    if (key === null || cfg === null) {
      return false;
    }
    const role: string = proof.role !== undefined && proof.role.length > 0 ? proof.role : ROLE_HOST;
    const pv: number = proof.pv !== undefined ? proof.pv : 1;
    const epoch: number = proof.e !== undefined ? proof.e : 0;
    const ts: number = proof.ts !== undefined ? proof.ts : 0;
    const sid: string = proof.sid !== undefined ? proof.sid : '';
    const sig: string = proof.sig !== undefined ? proof.sig : '';
    // 1) 验签（只有 pv>=2 才有 v2 证明）
    if (pv >= PROTO_HELLO_V2) {
      if (!Number.isInteger(epoch) || epoch < 0) {
        this.rejectPeerProof('proof has bad epoch');
        return false;
      }
      if (!SID_PATTERN.test(sid)) {
        this.rejectPeerProof('proof has bad sid');
        return false;
      }
      if (sig.length === 0) {
        this.rejectPeerProof('proof incomplete (pv>=2 but no sig)');
        return false;
      }
      let expect: string = '';
      try {
        expect = await helloSig2(key, role, cfg.channel, epoch, ts, pv, sid);
      } catch (e) {
        if (generation !== this.connectionGeneration) {
          return false;
        }
        this.rejectPeerProof('proof verify error');
        return false;
      }
      if (generation !== this.connectionGeneration) {
        return false; // 旧连接的验签结果不得改变新连接的纪元、模式或状态。
      }
      if (expect !== sig) {
        this.rejectPeerProof('proof signature mismatch (pv=' + pv.toString() + ')');
        return false;
      }
    }
    // 2) 纪元单调性（抗回滚）
    const lastEpoch: number = this.epoch.peer;
    const lastSid: string = this.epoch.peerSid;
    if (lastEpoch >= 0) {
      if (epoch === lastEpoch && sid === lastSid) {
        // 同一份证明重复出现（welcome + peer-joined）→ 幂等接受，不更新持久化值。
        this.peerPv = pv;
        this.peerPvKnown = true;
        this.applyMode();
        return true;
      }
      if (epoch <= lastEpoch) {
        this.rejectPeerProof('peer epoch rollback (e=' + epoch.toString() +
          ' <= accepted ' + lastEpoch.toString() + ')');
        return false;
      }
    }
    // 3) 接受：钉扎 sid + 持久化已接受纪元
    this.epoch.peer = epoch;
    this.epoch.peerSid = sid;
    this.persistEpoch();
    this.peerPv = pv;
    this.peerPvKnown = true;
    this.applyMode();
    return true;
  }

  /** 拒绝连接（验签失败 / 纪元回退）：终局错误，停止自动重连。 */
  private rejectPeerProof(reason: string): void {
    this.log('peer proof rejected: ' + reason);
    this.shouldRun = false;
    this.clearHeartbeatTimer();
    this.clearHelloTimer();
    this.clearReconnectTimer();
    this.setState('error');
    this.peers = { host: false, client: false };
    this.emitPeers();
    this.stopInternal('peer-proof-rejected');
  }

  /** 模式判定（契约 §3.4.1）：本端 pv>=2 且对端 pv>=2 = 加固，否则兼容。 */
  private applyMode(): void {
    const before: boolean = this.hardened;
    this.hardened = this.peerPvKnown && this.peerPv >= PROTO_HELLO_V2;
    if (this.hardened !== before) {
      this.log('mode: ' + (this.hardened ? 'hardened (aad bound to sid)' : 'compat (legacy aad)'));
    }
  }

  /** 持久化纪元状态（先持久化再使用——契约 §3.4.1）。 */
  private persistEpoch(): void {
    const cfg: LinkConfig | null = this.cfg;
    if (cfg === null) {
      return;
    }
    const cb: ((s: LinkEpochState) => void) | undefined = cfg.onEpoch;
    if (cb === undefined) {
      return;
    }
    const st: LinkEpochState = {
      self: this.epoch.self,
      peer: this.epoch.peer,
      peerSid: this.epoch.peerSid
    };
    cb(st);
  }

  /**
   * 业务 hello（契约 §5.1）只在**知道对端 pv 之后**发——
   * 否则 AAD 模式会与对端选得不一样（加固 AAD 多一段 sid），双方都解不开。
   */
  private maybeSendBusinessHello(): void {
    if (!this.peerPvKnown || this.businessHelloSent) {
      return;
    }
    this.businessHelloSent = true;
    this.sendBusinessHello();
  }

  /** 密文帧：按 sid+":"+seq 去重 → 串行解密 → 有序业务分发；旧世代回调失效。 */
  private onRelayFrame(frame: DshrcRelayFrame): void {
    const key: Uint8Array | null = this.key;
    const sid: string = frame.sid !== undefined ? frame.sid : SID_LEGACY;
    const seq: number = frame.seq !== undefined ? frame.seq : 0;
    const data: string = frame.data !== undefined && frame.data !== null ? frame.data : '';
    if (key === null || seq <= 0 || data.length === 0) {
      return;
    }
    // 加固模式：帧的 sid 必须等于**已钉扎的对端 sid**，否则丢弃（契约 §3.4.1）。
    if (this.hardened) {
      const pinned: string = this.epoch.peerSid;
      if (pinned.length === 0 || sid !== pinned) {
        this.sidMismatchCount = this.sidMismatchCount + 1;
        this.log('frame sid not pinned, dropped (mismatch=' + this.sidMismatchCount.toString() + ')');
        if (this.sidMismatchCount >= SID_MISMATCH_RECONNECT_THRESHOLD) {
          // 对端换了连接实例（host 重启）而中继没发 peer-joined → 重连取新 welcome 证明自愈。
          this.sidMismatchCount = 0;
          this.log('too many sid mismatches, reconnecting to re-pin peer');
          this.forceReconnect('sid-mismatch');
        }
        return;
      }
      this.sidMismatchCount = 0;
    }
    if (this.isDuplicate(sid, seq)) {
      this.log('dup frame ' + sid + ':' + seq.toString() + ' dropped');
      return;
    }
    const generation: number = this.connectionGeneration;
    const hardened: boolean = this.hardened;
    // native convertKey 异步完成顺序不受控；解密与 correlator/store 分发必须同队保序。
    this.inboundQueue.enqueue(async (): Promise<void> => {
      if (generation !== this.connectionGeneration) {
        return;
      }
      try {
        const pt: string = hardened ? await open(key, ROLE_HOST, seq, data, sid) :
          await open(key, ROLE_HOST, seq, data);
        if (generation !== this.connectionGeneration) {
          return;
        }
        this.dispatchPlain(pt);
      } catch (e) {
        const err: BusinessError = e as BusinessError;
        // 认证失败（AAD/密钥不匹配）：丢弃该帧，但不阻塞后续帧。
        this.log('decrypt failed seq=' + seq + ' err=' + err.code);
      }
    });
  }

  /** 解密后的业务消息：JSON 解析 → 请求-响应关联 / 事件分发。 */
  private dispatchPlain(pt: string): void {
    let m: DshrcMsg;
    try {
      m = JSON.parse(pt) as DshrcMsg;
    } catch (e) {
      this.log('bad business json, dropped');
      return;
    }
    if (this.correlator.deliver(m)) {
      return;
    }
    // 直接回调（兼容，sessionstore 实时更新走这条）+ 事件总线并行广播。
    if (this.onEvent !== null) {
      this.onEvent(m);
    }
    postBusMsg(m);
  }

  /**
   * 接收去重（契约 §4 v1.0.2）：去重键为 sid + ":" + seq（缺 sid 走 "legacy" 桶）。
   * seen 按 sid 分桶：单桶超过 SEEN_BUCKET_MAX 项裁剪最旧；
   * 总桶数超过 SEEN_MAX_SIDS 个淘汰最久未活动的桶。首次见到返回 false。
   */
  private isDuplicate(sid: string, seq: number): boolean {
    let bucket: SeenBucket | undefined = this.seen.get(sid);
    if (bucket === undefined) {
      bucket = { seqs: new Set<number>(), order: new Array<number>(), last: Date.now() };
      this.seen.set(sid, bucket);
    }
    if (bucket.seqs.has(seq)) {
      return true;
    }
    bucket.seqs.add(seq);
    bucket.order.push(seq);
    bucket.last = Date.now();
    // 单桶裁剪最旧（Map/Set 插入序即 seq 到达序）
    while (bucket.order.length > SEEN_BUCKET_MAX) {
      const oldSeq: number | undefined = bucket.order.shift();
      if (oldSeq === undefined) {
        break;
      }
      bucket.seqs.delete(oldSeq);
    }
    // 总桶数超限时淘汰最旧的 sid 桶
    while (this.seen.size > SEEN_MAX_SIDS) {
      let oldestSid: string = '';
      let oldestTs: number = Number.MAX_SAFE_INTEGER;
      this.seen.forEach((b: SeenBucket, s: string): void => {
        if (b.last < oldestTs) {
          oldestTs = b.last;
          oldestSid = s;
        }
      });
      if (oldestSid.length === 0) {
        break;
      }
      this.seen.delete(oldestSid);
    }
    return false;
  }

  /**
   * 连接下行（断开/出错）：退避重连。
   *
   * 状态机约束（v1.0.6 修复）：
   *  - 终局态（stopped / error / shouldRun=false / 无配置）**一律不置 reconnecting**——
   *    否则 UI 会停在「重连中」而实际上没有任何重连定时器（看着像在重连，其实已经死了）。
   *  - 只有确实要 schedule 重连时，才置 reconnecting。
   *  - 终局错误路径（relay bad-hello / channel-full / replaced）先置 error，
   *    随后的 close 事件进来时保持 error，不再退避重连。
   */
  private onWsDown(reason: string): void {
    this.invalidateAsyncFrames();
    this.clearHeartbeatTimer();
    this.clearHelloTimer();
    this.clearReconnectTimer();
    this.ws = null;
    this.correlator.rejectAll('connection lost: ' + reason);
    this.peers = { host: false, client: false };
    this.emitPeers();
    // 用户主动停止 → 保持 stopped，不再重连
    if (this.state === 'stopped') {
      return;
    }
    // 不该再跑（shouldRun=false：终局错误或用户停止）或没有配置：
    // 已是 error 就保持 error，否则落 stopped；**不得**置 reconnecting。
    if (!this.shouldRun || this.cfg === null) {
      if (this.state !== 'error') {
        this.setState('stopped');
      }
      return;
    }
    this.reconnectAttempts = this.reconnectAttempts + 1;
    const cap: number = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1));
    const jitter: number = 0.8 + Math.random() * 0.4;
    const delay: number = Math.round(cap * jitter);
    this.setState('reconnecting');
    this.log('reconnect in ' + delay.toString() + 'ms (attempt ' + this.reconnectAttempts.toString() + ')');
    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = -1;
      this.connectOnce();
    }, delay);
  }

  /** 主动掐断当前连接并进入重连流程（hello 超时等内部判死用）。 */
  private forceReconnect(reason: string): void {
    const wsRef: webSocket.WebSocket | null = this.ws;
    this.ws = null;
    if (wsRef !== null) {
      try {
        wsRef.off('open');
        wsRef.off('message');
        wsRef.off('close');
        wsRef.off('error');
        wsRef.close().catch((e: BusinessError) => {
          this.log('force close failed: ' + e.code);
        });
      } catch (e) {
        this.log('force close exception');
      }
    }
    this.onWsDown(reason);
  }

  /** 心跳：30s 无帧发 ping；90s 无任何消息判死。 */
  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimerId = setInterval(() => {
      if (this.state !== 'online') {
        return;
      }
      const now: number = Date.now();
      if (now - this.lastRecvTs > DEAD_TIMEOUT_MS) {
        this.log('dead: no message for ' + (now - this.lastRecvTs).toString() + 'ms');
        this.forceReconnect('dead');
        return;
      }
      if (now - this.lastSendTs > HEARTBEAT_INTERVAL_MS) {
        const pingFrame: DshrcRelayFrame = { t: FRAME_PING };
        this.sendRelayJson(JSON.stringify(pingFrame));
      }
    }, 5000);
  }

  /**
   * 业务层 hello（契约 §5.1，连接后首条；host 离线时中继缓存补发）。
   * payload.sig 仍用 v1 证明串（`hello|role|channel`）——旧插件互操作；
   * v2 证明（契约 §3.4.1）只用于**传输层** hello 帧。
   */
  private sendBusinessHello(): void {
    const key: Uint8Array | null = this.key;
    const cfg: LinkConfig | null = this.cfg;
    if (key === null || cfg === null) {
      return;
    }
    const generation: number = this.connectionGeneration;
    const sid: string = this.sid;
    helloSig(key, ROLE_CLIENT, cfg.channel).then((sig: string) => {
      if (generation !== this.connectionGeneration || this.sid !== sid) {
        return;
      }
      const payload: DshrcPayload = {
        proto: PROTO_VERSION,
        clientName: cfg.clientName,
        appVersion: cfg.appVersion,
        sig: sig
      };
      this.correlator.request((m: DshrcMsg) => {
        this.sealAndSend(m);
      }, MSG_HELLO, payload, HOST_HELLO_TIMEOUT_MS).then((v: DshrcValue) => {
        const info: DshrcHostInfo = {
          hostName: v.hostName !== undefined ? v.hostName : '',
          dshVersion: v.dshVersion !== undefined ? v.dshVersion : '',
          pluginVersion: v.pluginVersion !== undefined ? v.pluginVersion : ''
        };
        this.log('host hello: ' + info.hostName + ' ' + info.dshVersion);
        if (this.onHello !== null) {
          this.onHello(info);
        }
      }).catch((e: Error) => {
        // host 离线属正常（中继已缓存该帧），只记录
        this.log('business hello pending/failed: ' + e.message);
      });
    }).catch((e: BusinessError) => {
      this.log('business hello sig failed: ' + e.code);
    });
  }

  /** 发送一条业务请求并等待 result（resolve 的是 result.value）。 */
  request(type: string, payload: DshrcPayload, timeoutMs?: number): Promise<DshrcValue> {
    const to: number = timeoutMs !== undefined ? timeoutMs : DEFAULT_REQ_TIMEOUT_MS;
    if (this.state !== 'online') {
      return Promise.reject(new Error('link not online'));
    }
    // 契约 §3.4.1：还不知道对端 pv → 不知道该用哪种 AAD → 不能发业务帧。
    if (!this.peerPvKnown) {
      return Promise.reject(new Error('peer mode unknown (host proof not received)'));
    }
    return this.correlator.request((m: DshrcMsg) => {
      this.sealAndSend(m);
    }, type, payload, to);
  }

  // ---- 契约 §5.1 client → host 业务请求封装 ----

  /** session.list（§5.1 v1.0.5）：value.sessions → SessionSummary[]（归档参数已删）。 */
  sessionList(): Promise<DshrcSessionSummary[]> {
    const p: DshrcPayload = {};
    return this.request(MSG_SESSION_LIST, p).then((v: DshrcValue): DshrcSessionSummary[] => {
      return v.sessions !== undefined ? v.sessions : [];
    });
  }

  /** session.history（§5.1 v1.0.4）：向后翻页的历史消息页。
   *  beforeSeq 缺省取最新一页；向前翻页回传上一页的 oldestSeq。
   *  v1.0.6：响应额外带 steps（工作步骤，§5.7）。 */
  sessionHistory(sessionId: string, beforeSeq?: number, maxMessages?: number): Promise<DshrcHistoryPage> {
    const p: DshrcPayload = { sessionId: sessionId };
    if (beforeSeq !== undefined && beforeSeq >= 0) {
      p.beforeSeq = beforeSeq;
    }
    if (maxMessages !== undefined && maxMessages > 0) {
      p.maxMessages = maxMessages;
    }
    return this.request(MSG_SESSION_HISTORY, p, 20000).then((v: DshrcValue): DshrcHistoryPage => {
      const page: DshrcHistoryPage = {
        messages: v.messages !== undefined ? v.messages : [],
        steps: v.steps !== undefined ? v.steps : [],
        hasMore: v.hasMore === true,
        oldestSeq: v.oldestSeq !== undefined ? v.oldestSeq : 0
      };
      return page;
    });
  }

  /**
   * session.queue（§5.2 v1.1.1）：拉取该会话**当前**的待执行消息快照。
   * 事件只在变化时推 → 断线重连后光靠事件补不上，打开会话时拉一次。
   */
  sessionQueue(sessionId: string): Promise<DshrcQueueItem[]> {
    const p: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_QUEUE, p, 15000).then((v: DshrcValue): DshrcQueueItem[] => {
      const out: DshrcQueueItem[] = [];
      if (v.items !== undefined) {
        for (let i = 0; i < v.items.length; i++) {
          const src: DshrcQueueItem = v.items[i];
          out.push({
            itemId: src.itemId !== undefined ? src.itemId : '',
            text: src.text !== undefined ? src.text : '',
            target: src.target !== undefined ? src.target : 'next-turn'
          });
        }
      }
      return out;
    });
  }

  /** session.capabilities（§5.1 v1.0.6 + v1.0.7）：新建会话可选的「模式 / 权限 / 模型」目录
   *  与真实归档能力标记。宿主不支持时返回空目录（客户端隐藏选择区，不报错）。 */
  sessionCapabilities(): Promise<DshrcCapabilities> {
    const p: DshrcPayload = {};
    return this.request(MSG_SESSION_CAPABILITIES, p, 15000).then((v: DshrcValue): DshrcCapabilities => {
      const caps: DshrcCapabilities = {
        presets: v.presets !== undefined ? v.presets : [],
        permissions: v.permissions !== undefined ? v.permissions : [],
        defaultPreset: v.defaultPreset !== undefined ? v.defaultPreset : '',
        defaultPermission: v.defaultPermission !== undefined ? v.defaultPermission : '',
        models: v.models !== undefined ? v.models : [],
        defaultModelId: v.defaultModelId !== undefined ? v.defaultModelId : '',
        archiveSupported: v.archiveSupported === true,
        // v1.1.2：宿主「繁忙时的发送行为」（只读；旧插件无此字段 → queue）
        busyEnter: v.busyEnter === 'steer' ? 'steer' : 'queue'
      };
      return caps;
    });
  }

  /**
   * session.archive / session.unarchive（§5.1 v1.0.7）：Workspace **真实归档**。
   *  - archive：payload 带 stopActivity=false（默认不打断运行中的活动）；
   *  - unarchive：幂等恢复。
   *  返回 true = 主机已确认；false / reject = 主机拒绝（客户端不得本机假成功）。
   */
  sessionSetArchived(sessionId: string, archived: boolean): Promise<boolean> {
    if (sessionId.length === 0) {
      return Promise.reject(new Error('sessionId empty'));
    }
    if (archived) {
      const p: DshrcPayload = { sessionId: sessionId, stopActivity: false };
      return this.request(MSG_SESSION_ARCHIVE, p).then((v: DshrcValue): boolean => {
        return v.archived === true;
      });
    }
    const p2: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_UNARCHIVE, p2).then((v: DshrcValue): boolean => {
      return v.archived === false;
    });
  }

  /**
   * session.selectModel（§5.1 v1.0.8）：对**已存在会话**切换模型/思考强度。
   * 成功 resolve 归一化后的 selection（下一次 prompt 组装即生效）；
   * Host 拒绝时 reject（错误原文带出）——调用方提示，不回退假成功。
   */
  sessionSelectModel(sessionId: string, model: DshrcModelSelection): Promise<DshrcModelSelection> {
    if (sessionId.length === 0) {
      return Promise.reject(new Error('sessionId empty'));
    }
    const p: DshrcPayload = { sessionId: sessionId, model: model };
    return this.request(MSG_SESSION_SELECT_MODEL, p).then((v: DshrcValue): DshrcModelSelection => {
      const sel: DshrcModelSelection | undefined = v.model;
      if (sel === undefined) {
        throw new Error('主机未返回模型结果');
      }
      return sel;
    });
  }

  /**
   * session.model（§5.1 v1.0.8）：查询会话当前模型/思考强度。
   * 插件无记录（如刚重启）时 resolve null——调用方回退展示目录默认，不臆造。
   */
  sessionModel(sessionId: string): Promise<DshrcModelSelection | null> {
    if (sessionId.length === 0) {
      return Promise.reject(new Error('sessionId empty'));
    }
    const p: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_MODEL, p).then((v: DshrcValue): DshrcModelSelection | null => {
      const sel: DshrcModelSelection | undefined = v.model;
      return sel !== undefined ? sel : null;
    });
  }

  /** session.permission：查询会话当前权限；custom 为派生状态，原样返回供只读展示。 */
  sessionPermission(sessionId: string): Promise<string | null> {
    if (sessionId.length === 0) {
      return Promise.reject(new Error('sessionId empty'));
    }
    const p: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_PERMISSION, p).then((v: DshrcValue): string | null => {
      return typeof v.permission === 'string' ? v.permission : null;
    });
  }

  /** session.selectPermission：根会话切换权限；Host 拒绝时 reject 原文，不做本机假成功。 */
  sessionSelectPermission(sessionId: string, permission: string): Promise<string> {
    if (sessionId.length === 0 || permission.length === 0) {
      return Promise.reject(new Error('sessionId/permission empty'));
    }
    const p: DshrcPayload = { sessionId: sessionId, permission: permission };
    return this.request(MSG_SESSION_SELECT_PERMISSION, p).then((v: DshrcValue): string => {
      if (typeof v.permission !== 'string' || v.permission.length === 0) {
        throw new Error('主机未返回权限结果');
      }
      return v.permission;
    });
  }

  /** session.subagents（§5.1 v1.0.5）：父会话的直接子代理目录。 */
  sessionSubagents(sessionId: string): Promise<DshrcSubagentInfo[]> {
    const p: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_SUBAGENTS, p, 20000).then((v: DshrcValue): DshrcSubagentInfo[] => {
      return v.subagents !== undefined ? v.subagents : [];
    });
  }

  /** session.subagentPrompt（§5.1 v1.0.5）：向 continuable 子代理发消息（delivery:queue）。 */
  subagentPrompt(parentSessionId: string, childSessionId: string, text: string): Promise<boolean> {
    const p: DshrcPayload = {
      parentSessionId: parentSessionId,
      childSessionId: childSessionId,
      text: text
    };
    return this.request(MSG_SESSION_SUBAGENT_PROMPT, p).then((v: DshrcValue): boolean => {
      return v.accepted === true;
    });
  }

  /** session.subagentCancel（§5.1 v1.0.5）：取消 continuable 子代理当前 turn。 */
  subagentCancel(parentSessionId: string, childSessionId: string): Promise<boolean> {
    const p: DshrcPayload = { parentSessionId: parentSessionId, childSessionId: childSessionId };
    return this.request(MSG_SESSION_SUBAGENT_CANCEL, p).then((v: DshrcValue): boolean => {
      return v.accepted === true;
    });
  }

  /**
   * session.create（§5.1 v1.0.6 + v1.0.7）：返回创建结果。
   *  - agentPreset（模式）/ permission（权限档位）/ model（模型选择，§5.8）；
   *  - v1.0.7：会话已创建但模型设置失败时仍回成功并带 modelError——
   *    调用方**不得重复创建**（sessionId 照常使用，提示「已用默认模型」）。
   */
  sessionCreate(title: string, agentPreset?: string, permission?: string, cwd?: string,
    model?: DshrcModelSelection): Promise<DshrcCreateResult> {
    const p: DshrcPayload = {};
    if (title.length > 0) {
      p.title = title;
    }
    if (agentPreset !== undefined && agentPreset.length > 0) {
      p.agentPreset = agentPreset;
    }
    if (permission !== undefined && permission.length > 0) {
      p.permission = permission;
    }
    if (cwd !== undefined && cwd.length > 0) {
      p.cwd = cwd;
    }
    if (model !== undefined) {
      p.model = model;
    }
    return this.request(MSG_SESSION_CREATE, p).then((v: DshrcValue): DshrcCreateResult => {
      const res: DshrcCreateResult = {
        sessionId: v.sessionId !== undefined ? v.sessionId : '',
        agentPreset: v.agentPreset !== undefined ? v.agentPreset : ''
      };
      if (v.model !== undefined) {
        res.model = v.model;
      }
      if (v.modelError !== undefined && v.modelError.length > 0) {
        res.modelError = v.modelError;
      }
      return res;
    });
  }

  /**
   * session.prompt（§5.1 v1.1.2）：发送提示词，返回**结构化**回包。
   *  value = {accepted: bool, mode:'queue'|'steer'}——mode 是**实际**使用的投递行为
   *  （主机拒绝插话时插件自动退回 queue，消息不丢）。
   *  请求**不带 mode**：投递行为由宿主设置决定，手机端只跟随
   *  （用户在 DSH 设置里改「繁忙时的发送行为」，手机端随之变化）。
   *  旧插件不回 mode → 按 'queue' 保守兜底（繁忙时不把消息乐观插进主时间线）。
   */
  sessionPromptResult(sessionId: string, text: string): Promise<DshrcPromptResult> {
    const p: DshrcPayload = { sessionId: sessionId, text: text };
    return this.request(MSG_SESSION_PROMPT, p).then((v: DshrcValue): DshrcPromptResult => {
      const raw: DshrcPromptMode | undefined = v.mode;
      const mode: DshrcPromptMode = raw === 'steer' ? 'steer' : 'queue';
      const res: DshrcPromptResult = { accepted: v.accepted === true, mode: mode };
      return res;
    });
  }

  /**
   * session.prompt 的兼容入口：只要 accepted（新建会话页用）。
   * 需要知道**实际**投递行为（queue/steer）请用 sessionPromptResult。
   */
  sessionPrompt(sessionId: string, text: string): Promise<boolean> {
    return this.sessionPromptResult(sessionId, text).then((r: DshrcPromptResult): boolean => {
      return r.accepted;
    });
  }

  /** session.cancel（§5.1）：取消当前 turn；value.cancelled。 */
  sessionCancel(sessionId: string): Promise<boolean> {
    const p: DshrcPayload = { sessionId: sessionId };
    return this.request(MSG_SESSION_CANCEL, p).then((v: DshrcValue): boolean => {
      return v.cancelled === true;
    });
  }

  /** session.rename（§5.1）：改标题。 */
  sessionRename(sessionId: string, title: string): Promise<string> {
    const p: DshrcPayload = { sessionId: sessionId, title: title };
    return this.request(MSG_SESSION_RENAME, p).then((v: DshrcValue): string => {
      return v.title !== undefined ? v.title : title;
    });
  }

  /** approval.answer（§5.1）：允许/拒绝；value.applied=false 表示已超时被桌面端处理。 */
  approvalAnswer(askId: string, decision: string, note: string): Promise<boolean> {
    const p: DshrcPayload = { askId: askId, decision: decision };
    if (note.length > 0) {
      p.note = note;
    }
    return this.request(MSG_APPROVAL_ANSWER, p).then((v: DshrcValue): boolean => {
      return v.applied === true;
    });
  }

  /** question.answer（§5.1）：提交问答；answers 见 §5.4。 */
  questionAnswer(askId: string, answers: DshrcAnswers, freeText: string): Promise<boolean> {
    const p: DshrcPayload = { askId: askId, answers: answers };
    if (freeText.length > 0) {
      p.freeText = freeText;
    }
    return this.request(MSG_QUESTION_ANSWER, p).then((v: DshrcValue): boolean => {
      return v.applied === true;
    });
  }

  /** push.register（§5.1）：上报 Push Token；value.registered。 */
  pushRegister(pushToken: string): Promise<boolean> {
    const p: DshrcPayload = { pushToken: pushToken, platform: 'harmonyos' };
    return this.request(MSG_PUSH_REGISTER, p).then((v: DshrcValue): boolean => {
      return v.registered === true;
    });
  }

  /** ping（§5.1）：应用层探活（与传输层心跳独立）。 */
  ping(): Promise<number> {
    const p: DshrcPayload = {};
    return this.request(MSG_PING, p).then((v: DshrcValue): number => {
      return v.pong !== undefined ? v.pong : 0;
    });
  }

  /**
   * 加密并发送一条业务消息（v1.0.2：sid 随帧携带，seq 每条连接从 1 递增）。
   * AAD（契约 §7）：兼容模式 = "dshrc|client|seq"；加固模式 = "dshrc|client|seq|" + 本端 sid。
   */
  private sealAndSend(m: DshrcMsg): void {
    const key: Uint8Array | null = this.key;
    const ws: webSocket.WebSocket | null = this.ws;
    if (key === null || ws === null || this.sid.length === 0) {
      throw new Error('link not ready');
    }
    if (!this.peerPvKnown) {
      throw new Error('peer mode unknown');
    }
    this.sendSeq = this.sendSeq + 1;
    const seq: number = this.sendSeq;
    const sid: string = this.sid;
    const hardened: boolean = this.hardened;
    const generation: number = this.connectionGeneration;
    const pt: string = JSON.stringify(m);
    // seq 在调用序分配，加密与 ws.send 也必须按同一顺序完成，不能并发 seal 后直接发送。
    this.outboundQueue.enqueue(async (): Promise<void> => {
      if (generation !== this.connectionGeneration) {
        return;
      }
      try {
        const data: string = hardened ? await seal(key, ROLE_CLIENT, seq, pt, undefined, sid) :
          await seal(key, ROLE_CLIENT, seq, pt);
        if (generation !== this.connectionGeneration || this.ws !== ws) {
          return;
        }
        const frame: DshrcRelayFrame = { t: FRAME_FRAME, sid: sid, seq: seq, data: data };
        await this.sendRelayJson(JSON.stringify(frame));
      } catch (e) {
        const err: BusinessError = e as BusinessError;
        this.log('seal failed: ' + err.code);
      }
    });
  }

  /** 发送明文中继帧（hello/ping/pong/frame）。 */
  private sendRelayJson(text: string): Promise<void> {
    const ws: webSocket.WebSocket | null = this.ws;
    if (ws === null) {
      return Promise.resolve();
    }
    this.lastSendTs = Date.now();
    return ws.send(text).then((ok: boolean): void => {
      if (!ok) {
        this.log('send returned false');
      }
    }).catch((e: BusinessError): void => {
      this.log('send failed: ' + e.code);
      this.onWsDown('send-failed');
    });
  }
}

/** 全局单例（配对页与状态页共享同一条链路）。 */
export const dshrcLink: DshrcLink = new DshrcLink();
