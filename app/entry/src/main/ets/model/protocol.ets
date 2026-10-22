/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 协议层：常量 / 消息类型 / KAT 向量（契约 v1.0.2）。
 * 契约来源（只读）：仓库根 docs/PROTOCOL.md（dsh-remote-control，v1.0.2）
 * 本文件只描述“协议长什么样”，不做任何 IO 与加密运算。
 */

/** 协议版本（契约 §5.1 hello.proto）。 */
export const PROTO_VERSION: number = 1;

/** 协议契约文档版本（v1.0.4：§5.1 session.history、§5.3 SessionSummary 补 origin/parentSessionId/blank；关于页展示用）。 */
export const CONTRACT_VERSION: string = 'v1.0.4';

/** 角色：host = PC 端 DSH 插件；client = 本 App。 */
export const ROLE_HOST: string = 'host';
export const ROLE_CLIENT: string = 'client';

/** HKDF 参数（契约 §3.3）。 */
export const HKDF_SALT: string = 'dsh-remote-control/v1';
export const HKDF_INFO_PREFIX: string = 'e2e|'; // info = UTF8("e2e|" + channel)
export const HKDF_KEY_LEN: number = 32;

/** hello 签名原文（契约 §3.4）：UTF8("hello|" + role + "|" + channel)。 */
export const HELLO_SIG_PREFIX: string = 'hello|';

/** AAD 原文（契约 §7）：UTF8("dshrc|" + 发送方 role + "|" + seq)。 */
export const AAD_PREFIX: string = 'dshrc|';

/** channel 格式（契约 §4）。运行时必须校验；KAT 字面量除外。 */
export const CHANNEL_PATTERN: RegExp = /^[A-Z2-7]{16,64}$/;

/** 中继帧类型（契约 §4）。 */
export const FRAME_HELLO: string = 'hello';
export const FRAME_WELCOME: string = 'welcome';
export const FRAME_PEER_JOINED: string = 'peer-joined';
export const FRAME_PEER_LEFT: string = 'peer-left';
export const FRAME_FRAME: string = 'frame';
export const FRAME_PING: string = 'ping';
export const FRAME_PONG: string = 'pong';
export const FRAME_ERROR: string = 'error';

/** 链路参数（契约 §4）。 */
export const HELLO_TIMEOUT_MS: number = 10000; // 连接后 10s 内必须发 hello
export const HEARTBEAT_INTERVAL_MS: number = 30000; // 30s 无帧即发 ping
export const DEAD_TIMEOUT_MS: number = 90000; // 90s 无任何消息判死
export const BACKOFF_BASE_MS: number = 1000; // 重连退避 1s 起
export const BACKOFF_MAX_MS: number = 60000; // 上限 60s，带抖动

/** 发送端实例 id（契约 §4 v1.0.2）：每条 WS 连接生成一次，8 位十六进制随机。 */
export const SID_LEN: number = 8;
/** 去重键兜底桶：缺 sid 的帧按 "legacy":seq 处理（契约 §4 v1.0.2）。 */
export const SID_LEGACY: string = 'legacy';
/** seen 分桶裁剪（契约 §4 v1.0.2）：单 sid 桶上限、总 sid 桶上限。 */
export const SEEN_BUCKET_MAX: number = 4096;
export const SEEN_MAX_SIDS: number = 64;

/** 加密布局（契约 §7 v1.0.1）：base64url( iv(12) || ciphertext || tag(16) )。 */
export const IV_LEN: number = 12;
export const TAG_LEN: number = 16;

/** 业务消息 type（契约 §5.1，client → host 请求）。 */
export const MSG_HELLO: string = 'hello';
export const MSG_SESSION_LIST: string = 'session.list';
export const MSG_SESSION_HISTORY: string = 'session.history'; // v1.0.4：历史消息翻页
export const MSG_SESSION_CREATE: string = 'session.create';
export const MSG_SESSION_PROMPT: string = 'session.prompt';
export const MSG_SESSION_CANCEL: string = 'session.cancel';
export const MSG_SESSION_RENAME: string = 'session.rename';
export const MSG_APPROVAL_ANSWER: string = 'approval.answer';
export const MSG_QUESTION_ANSWER: string = 'question.answer';
export const MSG_PUSH_REGISTER: string = 'push.register';
export const MSG_PING: string = 'ping';

/** 业务消息 type（契约 §5，host → client）。 */
export const MSG_RESULT: string = 'result';
export const MSG_EVENT: string = 'event';

/** 事件 topic（契约 §5.2）。 */
export const TOPIC_SESSION_ADDED: string = 'session.added';
export const TOPIC_SESSION_REMOVED: string = 'session.removed';
export const TOPIC_SESSION_STATUS: string = 'session.status';
export const TOPIC_SESSION_ACTIVITY: string = 'session.activity';
export const TOPIC_ASSISTANT_DELTA: string = 'assistant.delta';
export const TOPIC_TURN_END: string = 'turn.end';
export const TOPIC_APPROVAL_REQUEST: string = 'approval.request';
export const TOPIC_APPROVAL_RESOLVED: string = 'approval.resolved';
export const TOPIC_QUESTION_REQUEST: string = 'question.request';
export const TOPIC_QUESTION_RESOLVED: string = 'question.resolved';
export const TOPIC_PUSH_STATE: string = 'push.state';
export const TOPIC_ERROR: string = 'error';

/** 业务消息信封（契约 §5）：{ id, type, ts, payload }。 */
export interface DshrcMsg {
  id: string;
  type: string;
  ts: number;
  payload: DshrcPayload;
}

/**
 * payload 是任意 JSON 对象。ArkTS 禁用 any/unknown，
 * 这里用“可选字段全集”的具体接口表达，读取方按需取用。
 */
export interface DshrcPayload {
  // 通用 result / error（契约 §5）
  ok?: boolean;
  value?: DshrcValue;
  error?: DshrcErrorBody;
  // result 关联的请求 id（payload.id）
  id?: string;
  // hello（§5.1）
  proto?: number;
  clientName?: string;
  appVersion?: string;
  sig?: string;
  pushToken?: string;
  platform?: string;
  hostName?: string;
  dshVersion?: string;
  pluginVersion?: string;
  // session.*（§5.1）
  includeArchived?: boolean;
  sessions?: DshrcSessionSummary[];
  sessionId?: string;
  title?: string;
  cwd?: string;
  text?: string;
  accepted?: boolean;
  cancelled?: boolean;
  // session.history（§5.1 v1.0.4）
  beforeSeq?: number;
  maxMessages?: number;
  // approval / question（§5.1）
  askId?: string;
  decision?: string;
  note?: string;
  applied?: boolean;
  answers?: DshrcAnswers;
  freeText?: string;
  // event（§5.2）
  topic?: string;
  data?: DshrcValue;
  // ping
  pong?: number;
}

/** result.value 的可读子集（阶段一先放会话摘要，阶段二按需扩展）。 */
export interface DshrcValue {
  sessions?: DshrcSessionSummary[];
  sessionId?: string;
  title?: string;
  cwd?: string;
  accepted?: boolean;
  cancelled?: boolean;
  applied?: boolean;
  registered?: boolean;
  pong?: number;
  hostName?: string;
  dshVersion?: string;
  pluginVersion?: string;
  // session.added（§5.2）：data.session 承载完整摘要
  session?: DshrcSessionSummary;
  // session.status / session.activity（§5.2）
  running?: boolean;
  updatedAt?: number;
  // assistant.delta / turn.end（§5.2）
  text?: string;
  status?: string; // turn.end: "idle" | "error"
  error?: string;
  // error 事件（§5.2）：data = {message}
  message?: string;
  // approval.request（§5.2）；reason 亦复用于 push.state 的不可用原因
  askId?: string;
  toolName?: string;
  reason?: string;
  argsPreview?: string;
  timeoutMs?: number;
  decision?: string; // approval.resolved / approval.answer: "approved" | "rejected"
  source?: string; // *.resolved: "phone" | "timeout" | "desktop"
  // question.request（§5.2）
  questions?: DshrcQuestion[];
  multiSelect?: boolean;
  // push.state（§5.2）：推送通道是否可用；未开通推送服务时为 false 并附 reason
  enabled?: boolean;
  // session.history（§5.1 v1.0.4）：历史消息页
  messages?: DshrcChatMessage[];
  hasMore?: boolean;
  oldestSeq?: number;
}

/** session.history 的单条历史消息（契约 §5.1 v1.0.4 ChatMessage）。 */
export interface DshrcChatMessage {
  id: string;
  role: string; // "user" | "assistant"
  text: string;
  ts: number;
  seq: number; // host 日志持久序号（去重键）
}

/** session.history 响应 value（契约 §5.1 v1.0.4）。 */
export interface DshrcHistoryPage {
  messages: DshrcChatMessage[];
  hasMore: boolean;
  oldestSeq: number;
}

/** result.error（契约 §5）。 */
export interface DshrcErrorBody {
  code: string;
  message: string;
}

/** question.request 的单个选项（契约 §5.4）。 */
export interface DshrcQuestionOption {
  label: string;
  description?: string;
}

/** question.request 的单个问题（契约 §5.4）。 */
export interface DshrcQuestion {
  id: string;
  question: string;
  multiSelect?: boolean;
  options?: DshrcQuestionOption[];
}

/** SessionSummary（契约 §5.3；v1.0.4 补充 origin/parentSessionId/blank，Host 原生字段透传）。 */
export interface DshrcSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  running: boolean;
  updatedAt: number;
  archived: boolean;
  // v1.0.4：subagent 标记 / fork-spawn 血缘 / 空会话（旧插件缺省时按空处理）
  origin?: string; // "subagent" | ""
  parentSessionId?: string;
  blank?: boolean;
}

/**
 * question.answer.answers：{ [questionId]: label | [label...] }（契约 §5.4）。
 * ArkTS 禁用索引签名，这里用 Object 承载 JSON 对象；阶段二在问答页做具体读写。
 */
export type DshrcAnswers = Object;

/** 中继帧（契约 §4）：明文 JSON，WebSocket text 帧。 */
export interface DshrcRelayFrame {
  t: string; // hello/welcome/peer-joined/peer-left/frame/ping/pong/error
  role?: string; // hello(role) / peer-joined / peer-left
  ch?: string; // hello
  sig?: string; // hello
  token?: string; // hello（中继鉴权，可选）
  peers?: DshrcRelayPeers; // welcome
  from?: string; // relay→peer frame
  sid?: string; // frame：发送端实例 id（8 位十六进制，每条 WS 连接生成一次；契约 §4 v1.0.2）
  seq?: number; // frame
  data?: string; // frame（base64url 密文）
  urgent?: boolean; // frame（可选）
  code?: string; // error
  message?: string; // error
}

/** welcome.peers（契约 §4）。 */
export interface DshrcRelayPeers {
  host: boolean;
  client: boolean;
}

/** 构造一条业务消息信封（id 用 uuid v4，ts 为毫秒时间戳）。 */
export function makeMsg(type: string, payload: DshrcPayload, id: string): DshrcMsg {
  const m: DshrcMsg = {
    id: id,
    type: type,
    ts: Date.now(),
    payload: payload
  };
  return m;
}

/** 校验 channel 格式（契约 §4）。 */
export function isValidChannel(ch: string): boolean {
  return CHANNEL_PATTERN.test(ch);
}

/**
 * 契约 §7 KAT（已知答案测试）字面量，逐字节照抄契约，勿改动。
 * 注意：KAT 的 channel 仅为测试输入，不参与格式校验。
 */
export const KAT_SECRET: string = 'dsh-remote-demo-secret-0123456789';
export const KAT_CHANNEL: string = 'ABCDEFGH23456789';
export const KAT_KEY_HEX: string =
  '6a76161fb789e8a48e1004cdcba483c2908bf4123180dae162dfb7e61e342a1d';
export const KAT_IV_HEX: string = '000102030405060708090a0b';
export const KAT_PT: string = '{"id":"r1","type":"ping","ts":1700000000000,"payload":{}}';
export const KAT_CT_HEX: string =
  '72b6fd46c5981533620ae9edc88cf0d607c89b5ad3da2d5ddd0548d6aef0c53e' +
  '4b242be9c97ead9930a1374918a2f46dc861811055c1cbe1a3';
export const KAT_TAG_HEX: string = '292260ad46868699ac0bda00a1336cb4';
