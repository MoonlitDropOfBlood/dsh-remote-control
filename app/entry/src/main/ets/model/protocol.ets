/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 协议层：常量 / 消息类型 / KAT 向量（契约 v1.1.1）。
 * 契约来源（只读）：仓库根 docs/PROTOCOL.md（dsh-remote-control，v1.1.1）
 * 本文件只描述“协议长什么样”，不做任何 IO 与加密运算。
 */

/** 协议版本（契约 §5.1 hello.proto）。 */
export const PROTO_VERSION: number = 1;

/** 协议契约文档版本（v1.1.1：§5.10.1/§5.10.2 交付物图片 + §5.2 session.queue 队列 + session.prompt 的 mode；关于页展示用）。 */
export const CONTRACT_VERSION: string = 'v1.1.1';

/** 角色：host = PC 端 DSH 插件；client = 本 App。 */
export const ROLE_HOST: string = 'host';
export const ROLE_CLIENT: string = 'client';

/**
 * session.prompt 的发送模式（契约 §5.1 v1.1.1）：
 *  - 'queue'：缺省语义——追加到当前 turn 之后执行（agent 空闲时即刻执行）；
 *  - 'steer'：插入正在运行的 turn（宿主拒绝 steer 时回 error，客户端可退回 queue）。
 */
export type DshrcPromptMode = 'queue' | 'steer';

/** HKDF 参数（契约 §3.3）。 */
export const HKDF_SALT: string = 'dsh-remote-control/v1';
export const HKDF_INFO_PREFIX: string = 'e2e|'; // info = UTF8("e2e|" + channel)
export const HKDF_KEY_LEN: number = 32;

/** hello 签名原文（契约 §3.4）：UTF8("hello|" + role + "|" + channel)。 */
export const HELLO_SIG_PREFIX: string = 'hello|';

/**
 * v2 握手证明原文前缀（契约 §3.4.1，v1.1.3）：
 * UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)。
 */
export const HELLO_SIG2_PREFIX: string = 'hello2|';

/**
 * 传输层握手证明版本 pv（契约 §3.4.1）：v1.1.3 = 2；v1.1.2 及以前不带该字段（视为 1）。
 * 本端恒为 2（v1.1.3）；对端 pv 由中继透传的证明给出。
 */
export const PROTO_HELLO_V2: number = 2;

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
/** 连接实例 id 的格式（8 位十六进制，契约 §4 v1.0.2；v1.1.3 证明里的 sid 也用同一格式）。 */
export const SID_PATTERN: RegExp = /^[0-9a-f]{8}$/i;
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
export const MSG_SESSION_SUBAGENTS: string = 'session.subagents'; // v1.0.5：父会话子代理目录
export const MSG_SESSION_SUBAGENT_PROMPT: string = 'session.subagentPrompt'; // v1.0.5：向 continuable 子代理发消息
export const MSG_SESSION_SUBAGENT_CANCEL: string = 'session.subagentCancel'; // v1.0.5：取消子代理当前 turn
export const MSG_SESSION_CREATE: string = 'session.create';
export const MSG_SESSION_CAPABILITIES: string = 'session.capabilities'; // v1.0.6：模式/权限目录
export const MSG_SESSION_ARCHIVE: string = 'session.archive'; // v1.0.7：Workspace 真实归档
export const MSG_SESSION_UNARCHIVE: string = 'session.unarchive'; // v1.0.7：从 Workspace 归档恢复
export const MSG_SESSION_SELECT_MODEL: string = 'session.selectModel'; // v1.0.8：会话中切换模型/思考强度
export const MSG_SESSION_MODEL: string = 'session.model'; // v1.0.8：查询会话当前模型
export const MSG_IMAGE_FETCH: string = 'image.fetch'; // v1.0.9：拉取图片大图（§5.10）
export const MSG_SESSION_QUEUE: string = 'session.queue'; // v1.1.1：拉取待执行消息快照（§5.2）
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
export const TOPIC_SESSION_ARCHIVES: string = 'session.archives'; // v1.0.7：Workspace 归档全集快照
export const TOPIC_SESSION_QUEUE: string = 'session.queue'; // v1.1.1：待执行消息（排队中 / 已插入当前 turn）
export const TOPIC_SESSION_MODEL_CHANGED: string = 'session.modelChanged'; // v1.0.8：会话模型/强度变化
export const TOPIC_ASSISTANT_DELTA: string = 'assistant.delta';
export const TOPIC_ASSISTANT_REASONING_DELTA: string = 'assistant.reasoningDelta'; // v1.0.7：思考增量
export const TOPIC_ASSISTANT_IMAGE: string = 'assistant.image'; // v1.0.9：会话消息里的图片（§5.10）
export const TOPIC_TOOL_CALL: string = 'tool.call'; // v1.0.6：工具调用开始
export const TOPIC_TOOL_RESULT: string = 'tool.result'; // v1.0.6：工具调用结束
// system.message（v1.0.6 引入）已于 v1.1.4 移除：宿主的 system/developer 消息是
// 系统提示词组装 / 工具注册表记录，不是对话内容，DSH 桌面端聊天视图从不展示。
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
  // session.create / session.capabilities（§5.1 v1.0.6）
  agentPreset?: string;
  permission?: string;
  presets?: DshrcModeOption[];
  permissions?: DshrcPermissionOption[];
  defaultPreset?: string;
  defaultPermission?: string;
  // session.create 模型选择 / session.capabilities 模型目录（§5.8 v1.0.7）
  model?: DshrcModelSelection;
  modelError?: string;
  models?: DshrcModelOption[];
  defaultModelId?: string;
  archiveSupported?: boolean;
  // session.archive / session.unarchive（§5.1 v1.0.7）
  archived?: boolean;
  archivedSessionIds?: string[];
  stopActivity?: boolean;
  // session.subagents / subagentPrompt / subagentCancel（§5.1 v1.0.5）
  subagents?: DshrcSubagentInfo[];
  parentSessionId?: string;
  childSessionId?: string;
  // session.prompt（§5.1 v1.1.1）：发送模式（'queue' | 'steer'）——请求体必须**显式**带上
  mode?: DshrcPromptMode;
  // image.fetch（§5.1 v1.0.9：拉图片大图）
  imageId?: string;
  maxEdge?: number;
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
  /**
   * session.prompt 回包的**实际**投递行为（契约 §5.1 v1.1.2）：'queue' | 'steer'。
   * 主机拒绝插话时插件自动退回 queue（消息不丢），此时回包标 queue。
   * 旧插件不回该字段 → undefined（调用方按 'queue' 保守兜底）。
   */
  mode?: DshrcPromptMode;
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
  // session.history（§5.1 v1.0.6）：工作步骤（工具调用）列表
  steps?: DshrcStepRecord[];
  // tool.call / tool.result 事件载荷（§5.2 v1.0.6）
  callId?: string;
  name?: string;
  arguments?: string;
  resultText?: string;
  errorText?: string;
  ts?: number;
  // session.capabilities（§5.1 v1.0.6）：模式与权限目录
  presets?: DshrcModeOption[];
  permissions?: DshrcPermissionOption[];
  defaultPreset?: string;
  defaultPermission?: string;
  // session.capabilities（§5.1 v1.0.7）：模型目录 + 真实归档能力标记
  models?: DshrcModelOption[];
  defaultModelId?: string;
  archiveSupported?: boolean;
  // session.capabilities（§5.1 v1.1.2）：宿主「繁忙时的发送行为」（只读）
  busyEnter?: string;
  // session.create（§5.1 v1.0.7）：模型选择与设置结果
  model?: DshrcModelSelection;
  modelError?: string;
  agentPreset?: string;
  // session.archive / session.unarchive（§5.1 v1.0.7）
  archived?: boolean;
  archivedSessionIds?: string[];
  // session.subagents（§5.1 v1.0.5）：子代理目录
  subagents?: DshrcSubagentInfo[];
  // image.fetch 响应（§5.10 v1.0.9）：大图 data URI + 尺寸
  data?: string;
  mediaType?: string;
  width?: number;
  height?: number;
  imageId?: string;
  // assistant.image 事件（§5.10 v1.0.9）：单张图片引用
  image?: DshrcImageRef;
  // session.queue 事件（§5.2 v1.1.1）：该会话待执行的用户消息列表（空数组 = 没有待执行消息）
  items?: DshrcQueueItem[];
}

/**
 * 待执行消息条目（契约 §5.2 v1.1.1 session.queue）。
 *  源为 Host 会话事件 agent/inbox/spliced（入队）与 user/message（被消费时出队）。
 *  target：'next-turn' = 当前 turn 结束后执行（排队中）；'next-step' = 已插入当前 turn（尚未消费）。
 *  客户端**只做展示，不做猜测**（不推断文本、不推断状态）。
 */
export interface DshrcQueueItem {
  itemId: string;
  text: string;
  target: string; // 'next-turn' | 'next-step'
}

/** session.history 的单条历史消息（契约 §5.1 v1.0.4 ChatMessage）。 */
export interface DshrcChatMessage {
  id: string;
  role: string; // "user" | "assistant" | "reasoning"（v1.0.7 思考过程，独立于 assistant 正文）
  text: string;
  ts: number;
  seq: number; // host 日志持久序号（去重键）
  /** v1.0.9：消息内图片（§5.10）——旧插件不返该字段时按空数组处理。 */
  images?: DshrcImageRef[];
}

/**
 * 会话消息里的图片引用（契约 §5.10 v1.0.9）。
 *  出现在 ChatMessage.images[] 与 assistant.image 事件 data 里。
 *  thumb 是**内联缩略图** data URI（长边 ≤ 480、JPEG q75，≤ 96KB base64）；
 *  插件降质后仍超限时只发元数据、thumb 留空（客户端显示占位框）。
 */
export interface DshrcImageRef {
  imageId: string; // 宿主 attachmentId（同会话内稳定）；交付物图片为 "d"+hash
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  width: number; // 原图宽（px）
  height: number; // 原图高（px）
  bytes: number; // 原始字节数（宿主侧）
  /**
   * 图片来源（契约 §5.10.1 / §5.10.2 v1.1.1，**可选**）：
   *  - 缺省 = 'attachment'：宿主会话消息的附件引用；
   *  - 'deliverable' = present 投递的交付物文件。
   *  交付物图片**必须**渲染成独立的一条图片消息（不挂到 assistant 气泡上）——
   *  挂上去会在 turn 结束的历史刷新里被宿主持久副本替换（副本里没有该图）→ 图片消失。
   */
  source?: string;
  thumb: string; // 缩略图 data URI（可能为空串）
}

/** session.history 响应 value（契约 §5.1 v1.0.4）。 */
export interface DshrcHistoryPage {
  messages: DshrcChatMessage[];
  /** v1.0.6：工作步骤（工具调用）列表——旧插件不返时为空数组。 */
  steps: DshrcStepRecord[];
  hasMore: boolean;
  oldestSeq: number;
}

/**
 * 工作步骤（契约 §5.7 v1.0.6）：会话时间线里的工具调用。
 * 直播期由 tool.call / tool.result 事件补齐（seq = -1 表示无持久序号）。
 */
export interface DshrcStepRecord {
  seq: number;
  callId: string;
  name: string;
  arguments: string;
  status: string; // "ok" | "error" | "running"
  resultText: string;
  errorText: string;
  ts: number;
  turn: number;
  step: number;
}

/** 模式选项（契约 §5.8 v1.0.6）：Host 的 Agent preset。 */
export interface DshrcModeOption {
  id: string;
  name: string;
  description: string;
}

/** 权限选项（契约 §5.8 v1.0.6）：Host 的 permission preset。 */
export interface DshrcPermissionOption {
  id: string;
  name: string;
  description: string;
}

/**
 * 思考强度选项（契约 §5.8 v1.0.8）：宿主 reasoning.efforts 的单项。
 */
export interface DshrcEffortOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * 模型选项（契约 §5.8 v1.0.7 + v1.0.8）：Host `sessionController.modelCatalog()` 的可路由模型。
 *  id 仅供客户端选择/默认项匹配（建议 `provider + "/" + model`）；
 *  提交时必须用 DshrcModelSelection，**不要从 id 反拆**。
 */
export interface DshrcModelOption {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoningEffort?: string; // 该模型的 reasoning.defaultEffort（若有）
  /** v1.0.8：该模型合法的思考强度集合（无该字段 = 模型不支持思考强度）。 */
  efforts?: DshrcEffortOption[];
}

/** 模型选择（契约 §5.8 v1.0.7）：session.create 的 model 载荷。 */
export interface DshrcModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** session.capabilities 响应 value（契约 §5.8 v1.0.6 + v1.0.7）。 */
export interface DshrcCapabilities {
  presets: DshrcModeOption[];
  permissions: DshrcPermissionOption[];
  defaultPreset: string;
  defaultPermission: string;
  /** v1.0.7：模型目录（宿主不支持时为空数组）。 */
  models: DshrcModelOption[];
  /** v1.0.7：默认模型 id（宿主不支持时为空串）。 */
  defaultModelId: string;
  /** v1.0.7：宿主是否支持 Workspace 真实归档（false 时客户端禁用归档动作）。 */
  archiveSupported: boolean;
  /**
   * v1.1.2：宿主「繁忙时的发送行为」（'queue' | 'steer'）——**只读**。
   * 手机端不提供切换；发消息走哪种行为由 DSH 设置决定（用户明确要求）。
   */
  busyEnter: string;
}

/**
 * session.create 响应 value（契约 §5.1 v1.0.7）。
 *  会话已创建但模型设置失败时仍回成功并带 modelError——客户端**不得重复创建**。
 */
export interface DshrcCreateResult {
  sessionId: string;
  agentPreset: string;
  model?: DshrcModelSelection;
  modelError?: string;
}

/**
 * session.prompt 响应 value（契约 §5.1 v1.1.2）：{accepted: bool, mode:'queue'|'steer'}。
 *  - accepted：主机是否接受这条提示词；
 *  - mode：**实际**使用的投递行为（'queue' = 排到当前 turn 之后；'steer' = 插话进当前 turn）。
 *    主机拒绝插话时插件自动退回 queue（消息不丢），回包标 queue。
 *    旧插件不回 mode → 按 'queue' 保守兜底（繁忙时不把消息乐观插进主时间线）。
 */
export interface DshrcPromptResult {
  accepted: boolean;
  mode: DshrcPromptMode;
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

/** SessionSummary（契约 §5.3；v1.0.4 补 origin/parentSessionId/blank；
 *  v1.0.7 重新加入 archived——由插件按 workspaceRegistry.archivedSessionIds 拼装，
 *  旧插件缺省时按 false 处理）。 */
export interface DshrcSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  running: boolean;
  updatedAt: number;
  // v1.0.4：subagent 标记 / fork-spawn 血缘 / 空会话（旧插件缺省时按空处理）
  origin?: string; // "subagent" | ""
  parentSessionId?: string;
  blank?: boolean;
  // v1.0.7：Workspace 真实归档标记（插件按归档集合拼装）
  archived?: boolean;
}

/** SubagentInfo（契约 §5.6 v1.0.5）：session.subagents 的目录行。 */
export interface DshrcSubagentInfo {
  sessionId: string;
  label: string; // 创建名（可空串 → UI 用 sessionId 前 8 位兜底）
  mode: string; // "one-shot" | "continuable"
  running: boolean;
  hasChildren: boolean;
  createdAt: number;
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
  // v1.1.3（契约 §3.4.1）：hello 帧携带的会话纪元证明
  e?: number; // hello：会话纪元（跨进程重启单调递增，每条新连接 +1）
  ts?: number; // hello：发送时刻 Unix 毫秒（仅诊断用，不参与安全判定）
  pv?: number; // hello：握手证明版本（v1.1.3 = 2；旧端不带 → 视为 1）
  peer?: DshrcPeerProof; // welcome / peer-joined：对端 hello 证明（中继原样透传）
}

/**
 * 对端 hello 证明（契约 §3.4.1 / §4）：
 * 中继没有密钥，只能**原样复制**对端 hello 里的证明字段（不重排、不补默认值、不校验）。
 * 接收方用本端 key 验签：sig = base64url(HMAC-SHA256(key,
 *   UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)))。
 */
export interface DshrcPeerProof {
  role?: string; // 对端角色（host / client）
  e?: number; // 会话纪元
  ts?: number; // 发送时刻 Unix 毫秒（仅诊断用）
  pv?: number; // 握手证明版本（>=2 才有 v2 证明）
  sid?: string; // 对端连接实例 id（8 位十六进制）
  sig?: string; // v2 证明串（base64url）
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
