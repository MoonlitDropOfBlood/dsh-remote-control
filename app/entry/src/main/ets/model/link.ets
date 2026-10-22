/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 链路层：WebSocket 客户端 → 中继（契约 §4；仓库根 docs/PROTOCOL.md v1.0.2）。
 * 职责：
 *  - 连接前先跑 assertKat()（契约 §7 KAT 逐字节自检），失败则不建链
 *  - 连接 / 断线重连（指数退避 1s→60s + 抖动）
 *  - 收到 welcome 前发 hello（sig = base64url(HMAC-SHA256(key,"hello|client|"+channel))）
 *  - 30s 无帧发 ping；90s 无任何消息判死并重连
 *  - sid/seq（契约 §4 v1.0.2）：每条 WS 连接（含重连）生成一次 8 位十六进制 sid，
 *    seq 每条连接从 1 开始；接收去重键为 sid+":"+seq（缺 sid 按 "legacy"），
 *    seen 按 sid 分桶（单桶 >4096 裁剪最旧，总桶 >64 淘汰最旧）
 *  - 业务消息收发加解密（AES-256-GCM，iv||ct||tag；AAD 仍为 "dshrc|"+发送方role+"|"+seq）
 *  - Correlator 请求-响应关联（result{id,ok,value|error}）
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
  DshrcRelayFrame,
  DshrcRelayPeers,
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
  MSG_SESSION_CREATE,
  MSG_SESSION_PROMPT,
  MSG_SESSION_CANCEL,
  MSG_SESSION_RENAME,
  MSG_APPROVAL_ANSWER,
  MSG_QUESTION_ANSWER,
  MSG_PUSH_REGISTER,
  MSG_PING,
  PROTO_VERSION,
  ROLE_CLIENT,
  SEEN_BUCKET_MAX,
  SEEN_MAX_SIDS,
  SID_LEGACY,
  SID_LEN,
  makeMsg
} from './protocol';
import { assertKat, deriveKey, helloSig, open, seal } from './crypto';
import { postBusMsg, postLinkPeers, postLinkState } from './events';

const TAG: string = 'dshrc-link';
const DEFAULT_REQ_TIMEOUT_MS: number = 15000;
const HOST_HELLO_TIMEOUT_MS: number = 15000;

/** 链路状态（字符串字面量，UI 直接展示）。 */
export type LinkState = 'idle' | 'deriving' | 'connecting' | 'handshaking' | 'online' | 'reconnecting' | 'stopped' | 'error';

/** 配置（由配对页写入）。 */
export interface LinkConfig {
  relayUrl: string;
  channel: string;
  secret: string;
  relayToken: string;
  clientName: string;
  appVersion: string;
}

/** 对端在线状态（welcome.peers / peer-joined / peer-left 维护）。 */
export interface LinkPeers {
  host: boolean;
  client: boolean;
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

  /** UI 回调（在 UIAbility 主线程设置；WS 回调也在主线程分发）。 */
  onState: ((s: LinkState) => void) | null = null;
  onEvent: ((m: DshrcMsg) => void) | null = null;
  onPeers: ((p: LinkPeers) => void) | null = null;
  onLog: ((line: string) => void) | null = null;

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

  private stopInternal(reason: string): void {
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
    // 契约 §4 v1.0.2：每条 WS 连接（含重连）生成新 sid，seq 从 1 重新开始
    this.sid = newSid();
    this.sendSeq = 0;
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

  /** WS 已建立：发送中继 hello（契约 §4）。 */
  private onWsOpen(cfg: LinkConfig): void {
    this.setState('handshaking');
    this.lastRecvTs = Date.now();
    this.lastSendTs = Date.now();
    const key: Uint8Array | null = this.key;
    if (key === null) {
      return;
    }
    helloSig(key, ROLE_CLIENT, cfg.channel).then((sig: string) => {
      const hello: DshrcRelayFrame = { t: FRAME_HELLO, role: ROLE_CLIENT, ch: cfg.channel, sig: sig };
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
      this.log('helloSig failed: ' + e.code);
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
        const peers: DshrcRelayPeers | undefined = frame.peers;
        if (peers !== undefined) {
          this.peers = { host: peers.host, client: peers.client };
        }
        this.setState('online');
        this.startHeartbeat();
        this.log('online, peers=' + JSON.stringify(this.peers));
        this.emitPeers();
        this.sendBusinessHello();
        break;
      }
      case FRAME_PEER_JOINED: {
        if (frame.role === 'host') {
          // host（重）上线：v1.0.2 起 host 每条连接生成新 sid 并重置 seq，
          // 去重按 sid 分桶，无需清空游标（契约 §4 v1.0.2）。
          this.peers.host = true;
          this.emitPeers();
          this.log('host joined');
        }
        break;
      }
      case FRAME_PEER_LEFT: {
        if (frame.role === 'host') {
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
        if (code === 'bad-hello') {
          // 鉴权失败，重连无意义
          this.shouldRun = false;
          this.setState('error');
          this.stopInternal('bad-hello');
        } else if (code === 'channel-full') {
          this.shouldRun = false;
          this.setState('error');
          this.stopInternal('channel-full');
        }
        // rate-limited / replaced：交给重连退避
        break;
      }
      default: {
        this.log('unknown relay frame: ' + frame.t);
        break;
      }
    }
  }

  /** 密文帧：按 sid+":"+seq 去重 → 解密 → 业务分发（契约 §4 v1.0.2）。 */
  private onRelayFrame(frame: DshrcRelayFrame): void {
    const key: Uint8Array | null = this.key;
    const sid: string = frame.sid !== undefined ? frame.sid : SID_LEGACY;
    const seq: number = frame.seq !== undefined ? frame.seq : 0;
    const data: string = frame.data !== undefined && frame.data !== null ? frame.data : '';
    if (key === null || seq <= 0 || data.length === 0) {
      return;
    }
    if (this.isDuplicate(sid, seq)) {
      this.log('dup frame ' + sid + ':' + seq.toString() + ' dropped');
      return;
    }
    open(key, 'host', seq, data).then((pt: string) => {
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
    }).catch((e: BusinessError) => {
      // 认证失败（AAD/密钥不匹配）：丢弃该帧
      this.log('decrypt failed seq=' + seq + ' err=' + e.code);
    });
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

  /** 连接下行（断开/出错）：退避重连。 */
  private onWsDown(reason: string): void {
    this.clearHeartbeatTimer();
    this.clearHelloTimer();
    this.ws = null;
    this.correlator.rejectAll('connection lost: ' + reason);
    this.peers = { host: false, client: false };
    this.emitPeers();
    if (!this.shouldRun) {
      return;
    }
    this.reconnectAttempts = this.reconnectAttempts + 1;
    const cap: number = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1));
    const jitter: number = 0.8 + Math.random() * 0.4;
    const delay: number = Math.round(cap * jitter);
    this.setState('reconnecting');
    this.log('reconnect in ' + delay.toString() + 'ms (attempt ' + this.reconnectAttempts.toString() + ')');
    this.clearReconnectTimer();
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

  /** 业务层 hello（契约 §5.1，连接后首条；host 离线时中继缓存补发）。 */
  private sendBusinessHello(): void {
    const key: Uint8Array | null = this.key;
    const cfg: LinkConfig | null = this.cfg;
    if (key === null || cfg === null) {
      return;
    }
    helloSig(key, ROLE_CLIENT, cfg.channel).then((sig: string) => {
      const payload: DshrcPayload = {
        proto: PROTO_VERSION,
        clientName: cfg.clientName,
        appVersion: cfg.appVersion,
        sig: sig
      };
      this.correlator.request((m: DshrcMsg) => {
        this.sealAndSend(m);
      }, MSG_HELLO, payload, HOST_HELLO_TIMEOUT_MS).then((v: DshrcValue) => {
        this.log('host hello: ' + (v.hostName !== undefined ? v.hostName : '?') + ' ' +
          (v.dshVersion !== undefined ? v.dshVersion : ''));
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
    return this.correlator.request((m: DshrcMsg) => {
      this.sealAndSend(m);
    }, type, payload, to);
  }

  // ---- 契约 §5.1 client → host 业务请求封装 ----

  /** session.list（§5.1）：value.sessions → SessionSummary[]。 */
  sessionList(includeArchived: boolean): Promise<DshrcSessionSummary[]> {
    const p: DshrcPayload = { includeArchived: includeArchived };
    return this.request(MSG_SESSION_LIST, p).then((v: DshrcValue): DshrcSessionSummary[] => {
      return v.sessions !== undefined ? v.sessions : [];
    });
  }

  /** session.history（§5.1 v1.0.4）：向后翻页的历史消息页。
   *  beforeSeq 缺省取最新一页；向前翻页回传上一页的 oldestSeq。 */
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
        hasMore: v.hasMore === true,
        oldestSeq: v.oldestSeq !== undefined ? v.oldestSeq : 0
      };
      return page;
    });
  }

  /** session.create（§5.1）：返回新建会话的 sessionId。 */
  sessionCreate(title: string): Promise<string> {
    const p: DshrcPayload = {};
    if (title.length > 0) {
      p.title = title;
    }
    return this.request(MSG_SESSION_CREATE, p).then((v: DshrcValue): string => {
      return v.sessionId !== undefined ? v.sessionId : '';
    });
  }

  /** session.prompt（§5.1）：发送提示词；value.accepted。 */
  sessionPrompt(sessionId: string, text: string): Promise<boolean> {
    const p: DshrcPayload = { sessionId: sessionId, text: text };
    return this.request(MSG_SESSION_PROMPT, p).then((v: DshrcValue): boolean => {
      return v.accepted === true;
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

  /** 加密并发送一条业务消息（v1.0.2：sid 随帧携带，seq 每条连接从 1 递增；AAD 仍为 client|seq）。 */
  private sealAndSend(m: DshrcMsg): void {
    const key: Uint8Array | null = this.key;
    if (key === null || this.ws === null || this.sid.length === 0) {
      throw new Error('link not ready');
    }
    this.sendSeq = this.sendSeq + 1;
    const seq: number = this.sendSeq;
    const sid: string = this.sid; // 捕获本条连接的 sid（重连后旧帧不会串桶）
    const pt: string = JSON.stringify(m);
    seal(key, ROLE_CLIENT, seq, pt).then((data: string) => {
      const frame: DshrcRelayFrame = { t: FRAME_FRAME, sid: sid, seq: seq, data: data };
      this.sendRelayJson(JSON.stringify(frame));
    }).catch((e: BusinessError) => {
      this.log('seal failed: ' + e.code);
    });
  }

  /** 发送明文中继帧（hello/ping/pong/frame）。 */
  private sendRelayJson(text: string): void {
    const ws: webSocket.WebSocket | null = this.ws;
    if (ws === null) {
      return;
    }
    this.lastSendTs = Date.now();
    ws.send(text).then((ok: boolean) => {
      if (!ok) {
        this.log('send returned false');
      }
    }).catch((e: BusinessError) => {
      this.log('send failed: ' + e.code);
      this.onWsDown('send-failed');
    });
  }
}

/** 全局单例（配对页与状态页共享同一条链路）。 */
export const dshrcLink: DshrcLink = new DshrcLink();
