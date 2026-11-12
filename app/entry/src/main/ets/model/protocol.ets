/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 协议层：常量 / 消息类型 / KAT 向量（契约 v1.3.0）。
 * 契约来源（只读）：仓库根 docs/PROTOCOL.md（dsh-remote-control，v1.3.0）
 * 本文件只描述“协议长什么样”，不做任何 IO 与加密运算。
 *
 * v1.3.0 增补（§5.12 / §5.13 / §5.14）：
 *  - §5.12 待答交互：pending.interactions 快照 + PendingQuestion/PendingApproval；
 *    question.request 增 state(open/continued)/callId/expiresAt/answerable。
 *  - §5.13 Todo：session.todos 请求 + session.todosChanged 事件 + TodoItem。
 *  - §5.14 Goal：session.goal / session.goalAction 请求 + session.goalChanged /
 *    session.goalActivationChanged 事件 + GoalWire / GoalAction。
 *  - session.capabilities 增 todos / goal / pendingInteractions 三个能力目录。
 */

/** 协议版本（契约 §5.1 hello.proto）。 */
export const PROTO_VERSION: number = 1;

/** 协议契约文档版本（v1.3.0：§5.12 待答交互与双端提问同步 + §5.13 Todo + §5.14 Goal；关于页展示用）。 */
export const CONTRACT_VERSION: string = 'v1.3.1';

/** 角色：host = PC 端 DSH 插件；client = 本 App。 */
export const ROLE_HOST: string = 'host';
export const ROLE_CLIENT: string = 'client';

/**
 * v1.3.0（契约 §5.1 hello.features）：客户端能力特性声明。
 *
 * `session-state-v1` = 本客户端支持：
 *  - `pending.interactions` 待答快照恢复通道（§5.12）；
 *  - `session.todos` 只读清单展示（§5.13）；
 *  - `session.goal` / `session.goalAction` 人类面 CAS 操作（§5.14）；
 *  - timed 超时后 `question.request{state:"continued"}` 的**补答**语义（§5.12.6）。
 *
 * 旧插件忽略该字段；未声明该特性的客户端，插件仍按旧事件语义处理
 * （timed 超时时直接发 question.resolved，不会重发 continued）。
 */
export const FEATURE_SESSION_STATE_V1: string = 'session-state-v1';

/** 本客户端在业务 hello 里声明的特性列表（契约 §5.1）。 */
export const CLIENT_FEATURES: string[] = [FEATURE_SESSION_STATE_V1];

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
export const MSG_SESSION_SELECT_PERMISSION: string = 'session.selectPermission'; // 会话中切换权限
export const MSG_SESSION_PERMISSION: string = 'session.permission'; // 查询会话当前权限
export const MSG_IMAGE_FETCH: string = 'image.fetch'; // v1.0.9：拉取图片大图（§5.10）
export const MSG_SESSION_QUEUE: string = 'session.queue'; // v1.1.1：拉取待执行消息快照（§5.2）
export const MSG_UPLOAD_BEGIN: string = 'attachment.upload.begin'; // v1.2.0：开启附件分块上传（§5.11）
export const MSG_UPLOAD_CHUNK: string = 'attachment.upload.chunk'; // v1.2.0：上传一个明文块
export const MSG_UPLOAD_COMMIT: string = 'attachment.upload.commit'; // v1.2.0：提交附件（落宿主附件存储）
export const MSG_UPLOAD_ABORT: string = 'attachment.upload.abort'; // v1.2.0：放弃上传（幂等，已提交不可撤回）
export const MSG_SESSION_PROMPT: string = 'session.prompt';
export const MSG_SESSION_CANCEL: string = 'session.cancel';
export const MSG_SESSION_RENAME: string = 'session.rename';
export const MSG_APPROVAL_ANSWER: string = 'approval.answer';
export const MSG_QUESTION_ANSWER: string = 'question.answer';
export const MSG_PENDING_INTERACTIONS: string = 'pending.interactions'; // v1.3.0：待答交互快照（§5.12）
export const MSG_SESSION_TODOS: string = 'session.todos'; // v1.3.0：读 Host todos 持久投影（§5.13）
export const MSG_SESSION_GOAL: string = 'session.goal'; // v1.3.0：读 Host goal 持久投影（§5.14）
export const MSG_SESSION_GOAL_ACTION: string = 'session.goalAction'; // v1.3.0：执行目标人类操作（§5.14）
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
export const TOPIC_SESSION_PERMISSION_CHANGED: string = 'session.permissionChanged'; // 会话权限变化
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
export const TOPIC_SESSION_TODOS_CHANGED: string = 'session.todosChanged'; // v1.3.0：整表覆盖 / 清空（§5.13）
export const TOPIC_SESSION_GOAL_CHANGED: string = 'session.goalChanged'; // v1.3.0：目标变更（§5.14）
export const TOPIC_SESSION_GOAL_ACTIVATION_CHANGED: string = 'session.goalActivationChanged'; // v1.3.0：目标 armed/disarmed（§5.14）
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
  /**
   * v1.3.0（契约 §5.1 hello.features）：客户端能力特性声明。
   * 旧插件忽略该字段；未声明该特性的客户端插件按旧事件语义处理。
   */
  features?: string[];
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
  /**
   * session.prompt（§5.1 v1.2.0）：已 `attachment.upload.commit` 的 uploadId 列表。
   * 与 text 至少一项非空（附件可单独发送）；附件顺序与列表一致（§5.11.3）。
   */
  uploads?: string[];
  // attachment.upload.*（§5.1 v1.2.0）
  kind?: string; // begin：'image' | 'file'
  name?: string; // begin：文件名（kind='file' 必填）
  mediaType?: string; // begin：图片媒体类型（kind='image' 必填，§5.11.1 目录内）
  bytes?: number; // begin：附件原始字节数
  uploadId?: string; // begin/chunk/commit/abort
  chunkBytes?: number; // begin 响应：单块明文上限
  index?: number; // chunk：从 0 连续递增
  received?: number; // chunk 响应：累计解码字节数
  attachment?: DshrcUploadedAttachment; // commit 响应：宿主归一化后的附件元数据
  aborted?: boolean; // abort 响应：是否真的丢弃了未提交缓冲
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
  // v1.3.0：question.request 增字段（§5.2）：状态机 + Host callId + 绝对过期时间 + 可答标记
  state?: string; // 'open' | 'continued'
  callId?: string; // Host 侧 callId（与桌面端同一个）
  expiresAt?: number; // 绝对 Unix 毫秒
  answerable?: boolean;
  // v1.3.0：session.goalAction 请求（§5.14）
  action?: DshrcGoalAction;
  /** CAS 引用：除 create 外每个变更都必须带手机当前看到的 {id,revision}。 */
  expected?: DshrcGoalRef;
  objective?: string;
  maxGoalRounds?: number;
  /** v1.3.0：session.goalChanged 事件的 operation（create/edit/pause/resume/complete/block/clear）。 */
  operation?: string;
  // event（§5.2）
  topic?: string;
  /**
   * 事件载荷（§5.2）或 attachment.upload.chunk 的请求字段（§5.1 v1.2.0）——
   * 两者共用 `data` 键：事件里是对象，分块请求里是**标准 base64 字符串**。
   * 接收方读事件时必须先判类型（sessionstore.handleEvent 已按对象收窄）。
   */
  data?: DshrcValue | string;
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
  // v1.3.0（§5.2/§5.12）：question.request 增字段——状态机 + 绝对过期时间 + 可答标记。
  // state = 'open'（手机独占窗口内）| 'continued'（窗口结束但宿主仍可补答）。
  state?: string;
  expiresAt?: number;
  answerable?: boolean;
  // v1.3.0（§5.14）：session.goalChanged 事件的 operation
  // （create/edit/pause/resume/complete/block/clear；block 由模型/策略产生，手机不提供）。
  operation?: string;
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
  // session.permission / session.selectPermission / session.permissionChanged
  permission?: string;
  // session.capabilities（§5.1 v1.0.7）：模型目录 + 真实归档能力标记
  models?: DshrcModelOption[];
  defaultModelId?: string;
  archiveSupported?: boolean;
  // session.capabilities（§5.1 v1.1.2）：宿主「繁忙时的发送行为」（只读）
  busyEnter?: string;
  // session.capabilities（§5.1 v1.2.0）：附件能力目录（缺省 = 宿主不支持）
  attachments?: DshrcAttachmentCaps;
  // v1.3.0（§5.13）：Todo 整表快照。null = 本回合尚无清单/已清空；[] = 明确空清单。
  todos?: DshrcTodoItem[] | null;
  // v1.3.0（§5.13/§5.14）：宿主是否提供该能力（supported=false = 客户端隐藏对应 UI）。
  supported?: boolean;
  // v1.3.0（§5.14）：目标投影与激活态
  goal?: DshrcGoalWire | null;
  activation?: string | null;
  actions?: DshrcGoalAction[];
  // v1.3.0（§5.12）：pending.interactions 响应的审批待答项（提问项走独立响应接口）。
  approvals?: DshrcPendingApproval[];
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
  // attachment.upload.begin / chunk / commit / abort 响应（§5.1 v1.2.0）
  uploadId?: string;
  chunkBytes?: number;
  received?: number;
  attachment?: DshrcUploadedAttachment;
  aborted?: boolean;
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
  /** v1.2.0：用户消息里的文件（§5.11.4）——旧插件不返该字段时按空数组处理。 */
  files?: DshrcFileRef[];
  /**
   * v1.3.1（§5.3）：**唤醒消息**的触发来源（宿主自动唤醒一回合，不是用户手打）。
   * goal / agent / team / subagent / webhook / schedule / job / plugin。
   * 带该字段时 text 为空串（注入的原始正文由客户端隐藏），渲染成触发卡
   * （与桌面端一致，例如「继续执行目标」）。旧插件不返该字段 → 保持旧行为。
   */
  trigger?: string;
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

/**
 * 用户消息里的文件引用（契约 §5.11.4 v1.2.0 `ChatMessage.files[]`）。
 * 手机端 v1.2.0 **不提供下载**：只渲染成文件卡片（图标 + 文件名 + 大小）。
 * 乐观上屏时 fileId 用 `local:<localId>`（宿主持久副本会给出真实 id 并替换）。
 */
export interface DshrcFileRef {
  fileId: string;
  name: string;
  bytes: number;
}

/**
 * 附件能力目录（契约 §5.11.1 v1.2.0 `session.capabilities.attachments`）。
 * 旧插件**缺省该字段** → 客户端隐藏附件入口（不得报错）。
 */
export interface DshrcAttachmentCaps {
  supported: boolean;
  maxCount: number; // 单条 prompt 的 uploads 数量上限（当前 9）
  maxItemBytes: number; // 单个附件原始字节上限（当前 20MiB）
  maxMessageBytes: number; // 单条消息附件总字节上限（当前 40MiB）
  chunkBytes: number; // 单块明文上限（当前 256KiB；客户端可更小）
  imageMediaTypes: string[]; // 宿主接受的图片媒体类型
}

/** `attachment.upload.begin` 响应（契约 §5.1 v1.2.0）。 */
export interface DshrcUploadBegin {
  uploadId: string;
  chunkBytes: number;
}

/**
 * `attachment.upload.commit` 回包里的附件元数据（契约 §5.11.2 v1.2.0）。
 * 图片字段是**宿主归一化存储后**的值；文件 bytes 为原始长度。
 */
export interface DshrcUploadedAttachment {
  kind: string; // 'image' | 'file'
  name?: string;
  mediaType?: string;
  bytes: number;
  width?: number;
  height?: number;
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
  /**
   * v1.2.0（§5.11.1）：用户提示词附件能力目录——**缺省 = 宿主不支持**，
   * 客户端据此隐藏附件入口（旧插件没有该字段，不得报错）。
   */
  attachments?: DshrcAttachmentCaps;
  /**
   * v1.3.0（§5.13）：Todo 能力目录——**缺省 = 宿主不支持**（客户端隐藏清单卡）。
   */
  todos?: DshrcTodosCaps;
  /**
   * v1.3.0（§5.14）：Goal 能力目录——**缺省 = 宿主不支持**（客户端隐藏目标条）。
   * `actions` 是宿主可执行的人类操作子集（手机不得触发 block）。
   */
  goal?: DshrcGoalCaps;
  /**
   * v1.3.0（§5.12）：待答交互能力目录——**缺省 = 宿主不支持**（客户端不做快照对账）。
   */
  pendingInteractions?: DshrcPendingInteractionsCaps;
}

/** v1.3.0（§5.13）：Todo 能力目录。 */
export interface DshrcTodosCaps {
  supported: boolean;
}

/** v1.3.0（§5.14）：Goal 能力目录。 */
export interface DshrcGoalCaps {
  /** 宿主是否可读目标投影（false → 客户端隐藏目标条）。 */
  read: boolean;
  /** 宿主允许的人类操作子集（create/edit/pause/resume/complete/clear；**不含 block**）。 */
  actions: DshrcGoalAction[];
}

/** v1.3.0（§5.12）：待答交互能力目录。 */
export interface DshrcPendingInteractionsCaps {
  /** 宿主是否有提问投影（true 时 open 超时会推进到 continued，仍可补答）。 */
  questions: boolean;
  /** 宿主是否有审批投影（通常没有；审批只恢复插件仍持有的未决项）。 */
  approvals: boolean;
  /** 宿主启用 timed 模式（手机独占窗口结束后问题仍可补答）。 */
  hostContinued: boolean;
}

/** v1.3.0（§5.13）：Todo 条目三态。 */
export type DshrcTodoStatus = 'pending' | 'in_progress' | 'completed';

/** v1.3.0（§5.14）：目标阶段。 */
export type DshrcGoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** v1.3.0（§5.14）：目标激活态（进程内状态，不持久；读不到就是未知）。 */
export type DshrcGoalActivation = 'armed' | 'disarmed';

/**
 * v1.3.0（§5.14）：手机可执行的人类操作。
 * **不含 block**——blocked 由模型/策略负责，契约明令禁止手机触发。
 */
export type DshrcGoalAction = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear';

/** v1.3.0（§5.13）：Todo 条目（契约 §5.13 TodoItem）。 */
export interface DshrcTodoItem {
  content: string;
  status: string; // 'pending' | 'in_progress' | 'completed'
}

/** v1.3.0（§5.14）：目标被阻塞的原因（仅 phase='blocked' 时有值）。 */
export interface DshrcGoalBlockedReason {
  code: string;
  message: string;
}

/** v1.3.0（§5.14）：目标投影（契约 §5.14 GoalWire）。 */
export interface DshrcGoalWire {
  id: string;
  /** CAS 版本号：每次变更 +1；手机变更必须带当前 {id,revision}。 */
  revision: number;
  objective: string;
  phase: string; // 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: DshrcGoalBlockedReason;
  maxGoalRounds: number;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  /** 已知时的激活态（未知就省略，客户端不得显示「自动续跑中」）。 */
  activation?: string;
}

/** v1.3.0（§5.14）：CAS 引用——手机看到的 {id,revision}。 */
export interface DshrcGoalRef {
  id: string;
  revision: number;
}

/**
 * v1.3.0（§5.12）：待答快照里的单个提问（契约 §5.12 PendingQuestion）。
 * `state:'continued'` = 手机独占等待窗口已结束，但 Host 仍可回答（可补答）。
 */
export interface DshrcPendingQuestion {
  askId: string;
  sessionId: string;
  /** Host 侧 callId（与桌面端同一个；没有时为空串）。 */
  callId: string;
  questions: DshrcQuestion[];
  state: string; // 'open' | 'continued'
  answerable: boolean;
  source: string; // 'plugin' | 'host'
  /** 绝对 Unix 毫秒；缺省 = 无限期/continued（0 = 未知）。 */
  expiresAt: number;
  /** 兼容旧客户端的等待窗口长度（可省略）。 */
  timeoutMs: number;
  multiSelect: boolean;
}

/** v1.3.0（§5.12）：待答快照里的单个审批（契约 §5.12 PendingApproval）。 */
export interface DshrcPendingApproval {
  askId: string;
  sessionId: string;
  toolName: string;
  reason: string;
  argsPreview: string;
  answerable: boolean;
  source: string;
  /** 绝对 Unix 毫秒；缺省 = 未知（0）。 */
  expiresAt: number;
}

/**
 * v1.3.0（§5.12）：pending.interactions 响应值。
 * 字段可选：旧插件 / 读取失败一律按空数组处理（**绝不阻塞瀑布**）。
 */
export interface DshrcPendingInteractions {
  questions?: DshrcPendingQuestion[];
  approvals?: DshrcPendingApproval[];
}

/** v1.3.0（§5.13）：session.todos 响应值。 */
export interface DshrcTodosSnapshot {
  sessionId: string;
  /** null = 本回合尚无清单/已清空（与 supported=false 严格区分）。 */
  todos: DshrcTodoItem[] | null;
  supported: boolean;
}

/** v1.3.0（§5.14）：session.goal 响应值。 */
export interface DshrcGoalSnapshot {
  sessionId: string;
  goal: DshrcGoalWire | null;
  /** 'armed' | 'disarmed' | null（未知为 null，不得显示「自动续跑中」）。 */
  activation: string | null;
  supported: boolean;
  /** 宿主允许的人类操作子集。 */
  actions: DshrcGoalAction[];
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

/**
 * v1.3.0（§5.12）：解析 pending.interactions 的响应值。
 *
 * wire 上 `questions` 这个键在两处出现，元素形状不同：
 *  - §5.2 question.request **事件** → Question[]（id / question / options）
 *  - §5.12 pending.interactions **响应** → PendingQuestion[]（askId / state / answerable）
 * `DshrcValue` 是宽松袋子（一个字段无法同时表达两种形状），故对响应值做一次
 * JSON 往返后按 PendingInteractions 解析——载荷很小，成本可忽略，
 * 且 **wire 文本一个字都不改**。
 */
export function parsePendingInteractions(value: DshrcValue): DshrcPendingInteractions {
  const raw: string = JSON.stringify(value);
  const parsed: DshrcPendingInteractions = JSON.parse(raw) as DshrcPendingInteractions;
  return parsed;
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
