/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 会话/审批/提问状态仓（契约 §5.2 全部事件，V2 装饰器）。
 * 职责：
 *  - 订阅 dshrcLink 的 onEvent/onState/onPeers/onLog，合并成页面可直接渲染的快照
 *  - session.added 的 data.session 嵌套、error 的 data.message（契约 §5.2 字段形状）
 *  - assistant.delta 流式合并进当前气泡，turn.end 定稿；本地乐观追加用户消息
 *  - approval.* / question.* 生成待答卡片，resolved 消除；push.state 记录远端推送状态
 *  - Push Token 记录 + 链路在线时 push.register 上报（契约 §5.1/§6）
 *  - 推送点击待导航目标（EntryAbility 解析 intent 后写入，Index 消费）
 *  - v1.1.1：交付物图片（source='deliverable'）独立成条（§5.10.2）；
 *    session.queue 事件落地为每会话待执行消息快照（§5.2，只展示不猜测）
 * 本层不做加解密（链路层负责），状态一律 @ObservedV2 + @Trace，页面直接读即自动刷新。
 */
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { Context } from '@kit.AbilityKit';
import { logDshrc } from './logger';
import {
  postApprovalArrived,
  postApprovalResolved,
  postPendingNav,
  postQuestionArrived,
  postQuestionResolved
} from './events';
import { DshrcLink, DshrcHostInfo, LinkPeers, LinkState, dshrcLink } from './link';
import {
  DshrcMsg,
  DshrcPayload,
  DshrcQuestion,
  DshrcQueueItem,
  DshrcSessionSummary,
  DshrcSubagentInfo,
  DshrcChatMessage,
  DshrcHistoryPage,
  DshrcCapabilities,
  DshrcImageRef,
  DshrcModeOption,
  DshrcModelOption,
  DshrcModelSelection,
  DshrcPermissionOption,
  DshrcStepRecord,
  DshrcValue,
  MSG_EVENT,
  MSG_IMAGE_FETCH,
  TOPIC_APPROVAL_REQUEST,
  TOPIC_APPROVAL_RESOLVED,
  TOPIC_ASSISTANT_DELTA,
  TOPIC_ASSISTANT_IMAGE,
  TOPIC_ASSISTANT_REASONING_DELTA,
  TOPIC_ERROR,
  TOPIC_PUSH_STATE,
  TOPIC_QUESTION_REQUEST,
  TOPIC_QUESTION_RESOLVED,
  TOPIC_SESSION_ACTIVITY,
  TOPIC_SESSION_ADDED,
  TOPIC_SESSION_ARCHIVES,
  TOPIC_SESSION_MODEL_CHANGED,
  TOPIC_SESSION_QUEUE,
  TOPIC_SESSION_REMOVED,
  TOPIC_SESSION_STATUS,
  TOPIC_SYSTEM_MESSAGE,
  TOPIC_TOOL_CALL,
  TOPIC_TOOL_RESULT,
  TOPIC_TURN_END
} from './protocol';

const TAG: string = 'dshrc-sessionstore';
const PREF_NAME: string = 'dshrc_prefs';
const KEY_PUSH_ENABLED: string = 'pushEnabled';
const LOG_KEEP: number = 80;
/** image.fetch 默认长边（契约 §5.10：maxEdge 缺省 1600、上限 4096）。 */
const IMAGE_FETCH_DEFAULT_MAX_EDGE: number = 1600;
/** image.fetch 长边上限（契约 §5.10）。 */
const IMAGE_FETCH_MAX_EDGE: number = 4096;
/** image.fetch 请求超时（ms）：大图压缩在宿主侧完成，可能略慢。 */
const IMAGE_FETCH_TIMEOUT_MS: number = 20000;
/** 大图内存缓存条目上限（超出按插入序淘汰最旧）。 */
const IMAGE_CACHE_MAX: number = 24;

/** 会话列表一行（契约 §5.3 SessionSummary 的可观察形态；v1.0.4 补 subagent/blank，
 *  v1.0.7 补 archived——Host 权威的 Workspace 归档标记）。 */
@ObservedV2
export class SessionRow {
  @Trace sessionId: string = '';
  @Trace title: string = '';
  @Trace cwd: string = '';
  @Trace running: boolean = false;
  @Trace updatedAt: number = 0;
  @Trace origin: string = ''; // "subagent" | ""（Host 原生字段透传）
  @Trace parentSessionId: string = ''; // fork/spawn 血缘（subagent 会话=父会话 id）
  @Trace blank: boolean = false; // 尚无对话的空会话（列表一律隐藏，DSH 官方语义）
  @Trace archived: boolean = false; // v1.0.7：Workspace 真实归档标记（Host 权威）

  constructor(s: DshrcSessionSummary) {
    this.apply(s);
  }

  /** 用 wire 层摘要刷新本行（session.added / session.list / status / activity 都走这里）。 */
  apply(s: DshrcSessionSummary): void {
    this.sessionId = s.sessionId;
    this.title = s.title;
    this.cwd = s.cwd;
    this.running = s.running;
    this.updatedAt = s.updatedAt;
    // v1.0.4 三字段（旧插件不发时按空/false 处理，向后兼容）
    this.origin = s.origin !== undefined ? s.origin : '';
    this.parentSessionId = s.parentSessionId !== undefined ? s.parentSessionId : '';
    this.blank = s.blank === true;
    // v1.0.7：插件按 workspaceRegistry.archivedSessionIds 拼装；旧插件缺省按 false
    this.archived = s.archived === true;
  }

  /** subagent 会话（origin 标记或有父会话血缘）→ 不进列表，入口在父会话详情页。 */
  isSubagent(): boolean {
    return this.origin === 'subagent' || this.parentSessionId.length > 0;
  }
}

/**
 * 会话列表的**不可变投影**（列表 UI 的数据源，v1.0.6 修复）。
 *
 * 为什么不用可变的 SessionRow 实例直接喂给 Repeat：
 *  - Repeat 按「当前索引处的 item 是否变化」判断要不要刷新页面（懒加载模式），
 *    全量加载模式更是**只看 key**——key 相同就不刷新。
 *  - session.list 刷新时若复用同一批 SessionRow 实例（原地 apply），item 引用不变，
 *    框架判定「数据没变」→ **列表不刷新**（用户看到的「刷新后数据没有变化」）。
 *  - 因此这里每次都产出**新实例 + 纯原始字段**，让变化可被稳定观测。
 */
export interface SessionListItem {
  sessionId: string;
  title: string;
  cwd: string;
  running: boolean;
  updatedAt: number;
  /** v1.0.7：Host 权威的归档标记（普通列表与「已归档」视图据此分流）。 */
  archived: boolean;
}

/** 刷新结果（诚实反馈：真正应用了 / 失败 / 被跳过——失败不假装已刷新）。 */
export interface SessionRefreshResult {
  /** true = 已拉到并应用了新的会话列表。 */
  ok: boolean;
  /** 应用后的会话行数（失败时为当前行数）。 */
  count: number;
  /** 失败原因（ok=false 且 skipped=false 时有值）。 */
  error: string;
  /** true = 未连接主机，本次没有发请求（不算刷新成功）。 */
  skipped: boolean;
}

/** 构造刷新结果（显式类型，避免对象字面量推断问题）。 */
function makeRefreshResult(ok: boolean, count: number, error: string, skipped: boolean): SessionRefreshResult {
  const r: SessionRefreshResult = { ok: ok, count: count, error: error, skipped: skipped };
  return r;
}

/** 父会话详情页的子代理目录一行（契约 §5.6 SubagentInfo，v1.0.5）。 */
@ObservedV2
export class SubagentRow {
  @Trace sessionId: string = '';
  @Trace label: string = '';
  @Trace mode: string = ''; // "one-shot" | "continuable"
  @Trace running: boolean = false;
  @Trace hasChildren: boolean = false;
  @Trace createdAt: number = 0;

  constructor(info: DshrcSubagentInfo) {
    this.sessionId = info.sessionId;
    this.label = info.label;
    this.mode = info.mode;
    this.running = info.running;
    this.hasChildren = info.hasChildren;
    this.createdAt = info.createdAt;
  }

  /** 显示名：label 空时用 sessionId 前 8 位兜底（契约 §5.6）。 */
  displayName(): string {
    return this.label.length > 0 ? this.label : this.sessionId.substring(0, 8);
  }

  isOneShot(): boolean {
    return this.mode === 'one-shot';
  }
}

/** 时间线项（契约 §5.7 v1.0.6）：一条消息、一个工作步骤或一条系统消息。
 *  kind: "message"（对话气泡，role=user/assistant） | "step"（工具调用） | "system"（系统/开发者消息）。
 *  seq：host 日志持久序号（session.history 的合并排序键）；-1=本地/直播项（永远排在最后）。 */
@ObservedV2
export class TimelineItem {
  @Trace id: string = '';
  @Trace kind: string = '';
  @Trace role: string = '';
  @Trace text: string = '';
  @Trace streaming: boolean = false;
  @Trace ts: number = 0;
  @Trace errorText: string = '';
  @Trace seq: number = -1;
  /** 步骤字段（kind="step"）：工具调用。 */
  @Trace callId: string = '';
  @Trace toolName: string = '';
  @Trace argsText: string = '';
  @Trace status: string = ''; // "running" | "ok" | "error"
  @Trace resultText: string = '';
  @Trace turn: number = 0;
  @Trace step: number = 0;
  /** v1.0.9：消息内图片（契约 §5.10）——空数组 = 该消息没有图片。 */
  @Trace images: DshrcImageRef[] = [];

  constructor(id: string, kind: string, ts: number) {
    this.id = id;
    this.kind = kind;
    this.ts = ts;
  }

  /** 是否工作步骤（工具调用）。 */
  isStep(): boolean {
    return this.kind === 'step';
  }

  /** 是否对话消息。 */
  isMessage(): boolean {
    return this.kind === 'message';
  }

  /** 是否思考过程块（契约 §5.3 v1.0.7：role='reasoning' 的独立块）。 */
  isReasoning(): boolean {
    return this.kind === 'reasoning';
  }
}

/** 一张待审批卡片（契约 §5.2 approval.request）。 */
@ObservedV2
export class ApprovalCard {
  @Trace askId: string = '';
  @Trace sessionId: string = '';
  @Trace toolName: string = '';
  @Trace reason: string = '';
  @Trace argsPreview: string = '';
  @Trace deadline: number = 0; // Date.now() + timeoutMs，倒计时用
  @Trace timeoutMs: number = 0;
  @Trace answered: boolean = false;

  constructor(askId: string, sessionId: string, toolName: string, reason: string,
    argsPreview: string, deadline: number, timeoutMs: number) {
    this.askId = askId;
    this.sessionId = sessionId;
    this.toolName = toolName;
    this.reason = reason;
    this.argsPreview = argsPreview;
    this.deadline = deadline;
    this.timeoutMs = timeoutMs;
  }
}

/** 一张待回答卡片（契约 §5.2 question.request / §5.4 Question）。 */
@ObservedV2
export class QuestionCard {
  @Trace askId: string = '';
  @Trace sessionId: string = '';
  @Trace questions: DshrcQuestion[] = [];
  @Trace multiSelect: boolean = false;
  @Trace deadline: number = 0;
  @Trace timeoutMs: number = 0;
  @Trace answered: boolean = false;

  constructor(askId: string, sessionId: string, questions: DshrcQuestion[],
    multiSelect: boolean, deadline: number, timeoutMs: number) {
    this.askId = askId;
    this.sessionId = sessionId;
    this.questions = questions;
    this.multiSelect = multiSelect;
    this.deadline = deadline;
    this.timeoutMs = timeoutMs;
  }
}

/** 每会话历史翻页元数据（非 @Trace：详情页读 store 的活动会话投影字段）。 */
class HistMeta {
  loaded: boolean = false; // 首页（最新一页）是否已拉取
  hasMore: boolean = false; // 是否还有更早的消息页
  oldestSeq: number = 0; // 已加载的最老 durable seq（向前翻页的 beforeSeq）
}

/** 推送点击待导航目标（契约 §6：intent 携带 sessionId / askId）。 */
export interface PendingNav {
  sessionId: string;
  askId: string;
}

/** 读取推送开关（Preferences，缺省开）。 */
export function loadPushEnabled(context: Context): boolean {
  try {
    const pref: preferences.Preferences =
      preferences.getPreferencesSync(context, { name: PREF_NAME });
    return pref.getSync(KEY_PUSH_ENABLED, true) as boolean;
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    logDshrc(TAG, 'warn', 'loadPushEnabled failed: ' + err.message);
    return true;
  }
}

/** 保存推送开关。 */
export function savePushEnabled(context: Context, on: boolean): boolean {
  try {
    const pref: preferences.Preferences =
      preferences.getPreferencesSync(context, { name: PREF_NAME });
    pref.putSync(KEY_PUSH_ENABLED, on);
    pref.flushSync();
    return true;
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    logDshrc(TAG, 'error', 'savePushEnabled failed: ' + err.message);
    return false;
  }
}

/**
 * 全局状态仓（单例）。@Trace 字段被页面读取即自动刷新，无需订阅/取消订阅。
 * 结构性变化（增删会话/卡片/消息）一律整数组替换；字段级变化改 @ObservedV2 实例属性。
 */
@ObservedV2
export class SessionStore {
  private static instance: SessionStore | null = null;

  // ---- 链路 ----
  @Trace linkState: LinkState = 'idle';
  @Trace hostOnline: boolean = false;
  @Trace lastError: string = '';
  @Trace logLines: string[] = [];
  // ---- 会话 ----
  @Trace sessions: SessionRow[] = [];
  @Trace refreshing: boolean = false;
  /** 会话列表数据版本号：任何影响列表展示的变化都自增（页面据此重建不可变投影）。
   *  v1.0.6：Repeat 靠 item 引用判断「数据是否变化」，行实例原地复用会被判定为
   *  「没变」→ 列表不刷新；版本号 + 不可变投影（listItems）一起解决。 */
  @Trace listVersion: number = 0;
  @Trace activeId: string = '';
  /** 会话时间线（契约 §5.7 v1.0.6）：消息 + 工作步骤 + 系统消息，按 seq 升序、直播项在末尾。 */
  @Trace timeline: TimelineItem[] = [];
  // ---- 历史消息（契约 §5.1 session.history，v1.0.4；活动会话投影）----
  @Trace historyLoading: boolean = false;
  @Trace historyHasMore: boolean = false;
  @Trace historyLoaded: boolean = false;
  // ---- 子代理目录（契约 §5.6 v1.0.5；活动会话投影 + 每父会话缓存）----
  @Trace activeSubagents: SubagentRow[] = [];
  // ---- 待执行消息（契约 §5.2 v1.1.1 session.queue）----
  /**
   * 队列数据版本号：任何会话的待执行消息变化都自增（页面据此重建队列列表）。
   * 队列**内容**存在内部 Map（queueCache）里——Map 不是可观察对象，
   * 故用版本号把「内容变了」这件事暴露成 @Trace 变化，驱动 UI 刷新。
   */
  @Trace queueVersion: number = 0;
  // ---- 审批 / 提问（契约 §5.5）----
  @Trace approvals: ApprovalCard[] = [];
  @Trace questions: QuestionCard[] = [];
  // ---- 推送（契约 §6）----
  @Trace pushToken: string = '';
  @Trace pushRegistered: boolean = false;
  @Trace pushLocalEnabled: boolean = true; // 本机开关（Preferences 持久化）
  @Trace pushRemoteEnabled: boolean = false; // host 侧 push.state
  @Trace pushRemoteReason: string = '';
  // ---- 推送点击导航 ----
  @Trace pendingNavSessionId: string = '';
  @Trace pendingNavAskId: string = '';
  @Trace pendingNavSeq: number = 0;
  // ---- 主机信息（hello 响应；连接信息页展示）----
  @Trace hostName: string = '';
  @Trace hostVersion: string = '';
  @Trace pluginVersion: string = '';
  // ---- 新建会话能力目录（契约 §5.8 v1.0.6：模式 / 权限；v1.0.7 加模型目录）----
  @Trace presets: DshrcModeOption[] = [];
  @Trace permissions: DshrcPermissionOption[] = [];
  @Trace defaultPresetId: string = '';
  @Trace defaultPermissionId: string = '';
  /** v1.0.7：模型目录（宿主不支持时为空数组 → 客户端隐藏模型选择区）。 */
  @Trace models: DshrcModelOption[] = [];
  /** v1.0.7：默认模型 id（宿主不支持时为空串）。 */
  @Trace defaultModelId: string = '';
  /** v1.0.7：宿主是否支持 Workspace 真实归档（false → 禁用归档动作，不做本机假归档）。 */
  @Trace archiveSupported: boolean = false;
  @Trace capabilitiesLoaded: boolean = false;
  /**
   * v1.1.2：宿主「繁忙时的发送行为」（'queue' | 'steer'）——**只读**。
   * 手机端不提供切换：发消息走哪种行为由 DSH 设置决定（用户明确要求）。
   */
  @Trace busyEnter: string = 'queue';
  /** v1.0.8：当前活动会话的模型/思考强度（null = 未知，UI 回退目录默认）。 */
  @Trace sessionModel: DshrcModelSelection | null = null;

  /** Index 挂载后设置：有待导航目标时立即回调（EntryAbility onNewWant 触发链）。 */
  onPendingNav: (() => void) | null = null;

  private link: DshrcLink = dshrcLink;
  private cache: Map<string, TimelineItem[]> = new Map<string, TimelineItem[]>();
  private histMeta: Map<string, HistMeta> = new Map<string, HistMeta>();
  /** v1.0.8：各会话当前模型（源=session.model 请求 / session.modelChanged 事件）。 */
  private modelCache: Map<string, DshrcModelSelection> = new Map<string, DshrcModelSelection>();
  /** v1.0.9：大图内存缓存（key = imageId + '@' + maxEdge），避免重复拉取。 */
  private imageCache: Map<string, string> = new Map<string, string>();
  /** v1.1.1：每会话待执行消息（宿主 session.queue 事件，契约 §5.2）。 */
  private queueCache: Map<string, DshrcQueueItem[]> = new Map<string, DshrcQueueItem[]>();
  private chatSeq: number = 0;
  /** 在途刷新（并发刷新合并到同一个 Promise，v1.0.6：不再直接 resolve 假装已刷新）。 */
  private pendingRefresh: Promise<SessionRefreshResult> | null = null;

  private constructor() {
    this.link.onState = (s: LinkState): void => {
      this.onLinkState(s);
    };
    this.link.onEvent = (m: DshrcMsg): void => {
      this.handleEvent(m);
    };
    this.link.onPeers = (p: LinkPeers): void => {
      this.hostOnline = p.host;
    };
    this.link.onLog = (line: string): void => {
      this.appendLog(line);
    };
    this.link.onHello = (info: DshrcHostInfo): void => {
      this.hostName = info.hostName;
      this.hostVersion = info.dshVersion;
      this.pluginVersion = info.pluginVersion;
    };
  }

  /** 单例入口。 */
  static get(): SessionStore {
    if (SessionStore.instance === null) {
      SessionStore.instance = new SessionStore();
    }
    const inst: SessionStore | null = SessionStore.instance;
    return inst as SessionStore;
  }

  // ---- 链路状态 ----

  private onLinkState(s: LinkState): void {
    this.linkState = s;
    if (s === 'online') {
      this.refreshSessions();
      this.reportPush();
      this.loadCapabilities();
    }
    if (s === 'stopped' || s === 'idle') {
      // 断开/切换远程：清掉当前会话的投影，避免展示上一台主机的时间线
      this.activeId = '';
      this.timeline = [];
      this.hostName = '';
      this.hostVersion = '';
      this.pluginVersion = '';
      this.presets = [];
      this.permissions = [];
      this.models = [];
      this.defaultModelId = '';
      this.archiveSupported = false;
      this.capabilitiesLoaded = false;
      this.sessionModel = null;
      this.modelCache.clear();
      this.queueCache.clear(); // v1.1.1：断开后不留上一台主机的待执行消息
    }
    if (s === 'error') {
      this.lastError = '连接错误（详见链路日志）';
    }
  }

  private appendLog(line: string): void {
    const head: string[] = ['[' + new Date().toLocaleTimeString() + '] ' + line];
    this.logLines = head.concat(this.logLines.slice(0, LOG_KEEP - 1));
  }

  // ---- 会话列表 ----

  /**
   * session.list 拉取（连接成功 / 下拉刷新调用）。
   *
   * v1.0.6 修复（用户反馈「刷新后数据没有变化」）：
   *  - 未连接 → 返回 skipped（**不假装已刷新**）；
   *  - 已有刷新在途 → **合并**到同一个在途 Promise（不再直接 resolve：
   *    否则下拉动画提前结束、后续刷新被吞，调用方无法区分「刷过」与「被跳过」）；
   *  - 失败 → 返回 ok=false + 错误原因（UI 显式提示，不静默）。
   */
  refreshSessions(): Promise<SessionRefreshResult> {
    if (this.link.getState() !== 'online') {
      return Promise.resolve(makeRefreshResult(false, this.sessions.length, '未连接主机', true));
    }
    const pending: Promise<SessionRefreshResult> | null = this.pendingRefresh;
    if (pending !== null) {
      return pending;
    }
    this.refreshing = true;
    const p: Promise<SessionRefreshResult> = this.link.sessionList().then(
      (list: DshrcSessionSummary[]): SessionRefreshResult => {
        this.applySessionList(list);
        this.lastError = '';
        this.refreshing = false;
        this.pendingRefresh = null;
        return makeRefreshResult(true, this.sessions.length, '', false);
      },
      (e: Error): SessionRefreshResult => {
        const msg: string = e.message;
        this.lastError = '刷新会话列表失败：' + msg;
        logDshrc(TAG, 'warn', 'session.list failed: ' + msg);
        this.refreshing = false;
        this.pendingRefresh = null;
        return makeRefreshResult(false, this.sessions.length, msg, false);
      }
    );
    this.pendingRefresh = p;
    return p;
  }

  /**
   * 会话列表的**不可变投影**（列表 UI 的数据源）：
   *  - 只显示根会话（非 blank、非 subagent——契约 §5.3 v1.0.5）；
   *  - updatedAt 降序；
   *  - 每项都是**新实例**（纯原始字段）：Repeat 以 item 引用判断「数据是否变化」，
   *    复用同一批可变实例会被判定为「没变」→ 列表不刷新。
   */
  listItems(): SessionListItem[] {
    const out: SessionListItem[] = [];
    for (const row of this.sessions) {
      if (row.blank || row.isSubagent()) {
        continue;
      }
      const item: SessionListItem = {
        sessionId: row.sessionId,
        title: row.title,
        cwd: row.cwd,
        running: row.running,
        updatedAt: row.updatedAt,
        archived: row.archived
      };
      out.push(item);
    }
    out.sort((a: SessionListItem, b: SessionListItem): number => b.updatedAt - a.updatedAt);
    return out;
  }

  // ---- Workspace 真实归档（契约 §5.9 v1.0.7：权威数据在 Host 侧）----

  /**
   * 归档 / 恢复一个会话（**Host 权威**：workspaceRegistry 归档集合）。
   *  - 宿主不支持归档（archiveSupported=false）→ 直接 reject（**不得本机假成功**）；
   *  - 主机拒绝（运行中归档失败等）→ reject，错误原文带出；
   *  - 主机确认后才更新本地行并自增 listVersion。
   */
  setSessionArchived(sid: string, archived: boolean): Promise<void> {
    if (sid.length === 0) {
      return Promise.reject(new Error('会话 id 为空'));
    }
    if (!this.archiveSupported) {
      return Promise.reject(new Error('主机不支持归档'));
    }
    return this.link.sessionSetArchived(sid, archived).then((ok: boolean): void => {
      if (!ok) {
        throw new Error('主机未确认归档结果');
      }
      const row: SessionRow | undefined = this.findRow(sid);
      if (row !== undefined) {
        row.archived = archived;
      }
      this.listVersion = this.listVersion + 1;
    });
  }

  /**
   * session.archives 事件（契约 §5.2 v1.0.7）：Workspace 归档集合**全集**快照。
   * 据此覆盖所有行的 archived（不做增量猜测），并自增 listVersion。
   */
  applyArchivedSet(ids: string[]): void {
    for (const row of this.sessions) {
      row.archived = ids.indexOf(row.sessionId) >= 0;
    }
    this.listVersion = this.listVersion + 1;
  }

  /** session.list 结果整体替换（复用既有行实例，详情页持有的引用继续实时更新）。 */
  private applySessionList(list: DshrcSessionSummary[]): void {
    const next: SessionRow[] = [];
    for (let i: number = 0; i < list.length; i++) {
      const s: DshrcSessionSummary = list[i];
      const row: SessionRow | undefined = this.findRow(s.sessionId);
      if (row !== undefined) {
        row.apply(s);
        next.push(row);
      } else {
        next.push(new SessionRow(s));
      }
    }
    this.sessions = next;
    this.listVersion = this.listVersion + 1;
    this.pruneCache();
  }

  private findRow(sid: string): SessionRow | undefined {
    for (let i: number = 0; i < this.sessions.length; i++) {
      if (this.sessions[i].sessionId === sid) {
        return this.sessions[i];
      }
    }
    return undefined;
  }

  /** 会话标题（详情页标题栏 / 通知直达兜底）。 */
  titleOf(sid: string): string {
    const row: SessionRow | undefined = this.findRow(sid);
    if (row !== undefined && row.title.length > 0) {
      return row.title;
    }
    return sid.length > 8 ? sid.substring(0, 8) + '…' : sid;
  }

  /** 会话是否运行中（详情页取消按钮 / 列表徽标）。 */
  runningOf(sid: string): boolean {
    const row: SessionRow | undefined = this.findRow(sid);
    return row !== undefined && row.running;
  }

  // ---- 待执行消息（契约 §5.2 v1.1.1 session.queue）----

  /**
   * 某会话的待执行消息（宿主 session.queue 事件；**只做展示，不做猜测**）。
   * 没有事件过 / 宿主说 items 为空 → 返回空数组（页面据此隐藏该区，不留空白占位）。
   */
  queueItems(sid: string): DshrcQueueItem[] {
    const items: DshrcQueueItem[] | undefined = this.queueCache.get(sid);
    if (items === undefined) {
      return [];
    }
    return items.slice();
  }

  /**
   * session.queue 事件落地：整体覆盖该会话的待执行消息（宿主给的是**全量快照**，
   * 不做增量猜测），并自增 queueVersion 驱动页面刷新。
   */
  private applyQueueSnapshot(sid: string, raw: DshrcQueueItem[] | undefined): void {
    if (sid.length === 0) {
      return;
    }
    const items: DshrcQueueItem[] = [];
    if (raw !== undefined) {
      for (let i: number = 0; i < raw.length; i++) {
        const src: DshrcQueueItem = raw[i];
        const item: DshrcQueueItem = {
          itemId: src.itemId !== undefined ? src.itemId : '',
          text: src.text !== undefined ? src.text : '',
          target: src.target !== undefined ? src.target : 'next-turn'
        };
        items.push(item);
      }
    }
    this.queueCache.set(sid, items);
    this.queueVersion = this.queueVersion + 1;
  }

  /** 待处理的审批 + 提问总数（列表页角标）。 */
  pendingCount(): number {
    let n: number = 0;
    for (let i: number = 0; i < this.approvals.length; i++) {
      if (!this.approvals[i].answered) {
        n = n + 1;
      }
    }
    for (let j: number = 0; j < this.questions.length; j++) {
      if (!this.questions[j].answered) {
        n = n + 1;
      }
    }
    return n;
  }

  // ---- 消息流 ----

  /** 打开会话：切换活动消息数组（详情页 aboutToAppear 调用）。 */
  openSession(sid: string): void {
    if (this.activeId === sid) {
      return;
    }
    this.activeId = sid;
    this.projectSubagents(sid);
    // v1.0.8：投影该会话当前模型（缓存里没有 → null，UI 回退目录默认）
    const known: DshrcModelSelection | undefined = this.modelCache.get(sid);
    this.sessionModel = known !== undefined ? known : null;
    if (sid.length === 0) {
      this.timeline = [];
      this.historyHasMore = false;
      this.historyLoaded = false;
      return;
    }
    if (!this.cache.has(sid)) {
      this.cache.set(sid, []);
    }
    const items: TimelineItem[] | undefined = this.cache.get(sid);
    this.timeline = items !== undefined ? items.slice() : [];
    // 投影本会话的历史翻页状态（详情页据此渲染「加载更早消息」）
    const meta: HistMeta | undefined = this.histMeta.get(sid);
    this.historyLoaded = meta !== undefined && meta.loaded;
    this.historyHasMore = meta !== undefined && meta.hasMore;
  }

  // ---- 新建会话能力目录（契约 §5.8 v1.0.6 + v1.0.7）----

  /**
   * 拉取主机支持的「模式 / 权限 / 模型」目录与真实归档能力标记。
   * 失败静默（目录保持空 → 客户端隐藏选择区；archiveSupported=false → 禁用归档动作）。
   */
  loadCapabilities(): Promise<void> {
    if (this.link.getState() !== 'online') {
      return Promise.resolve();
    }
    return this.link.sessionCapabilities().then((caps: DshrcCapabilities): void => {
      this.presets = caps.presets;
      this.permissions = caps.permissions;
      this.defaultPresetId = caps.defaultPreset;
      this.defaultPermissionId = caps.defaultPermission;
      this.models = caps.models;
      this.defaultModelId = caps.defaultModelId;
      this.archiveSupported = caps.archiveSupported;
      // v1.1.2：宿主「繁忙时的发送行为」（只读跟随，手机端不提供切换）
      this.busyEnter = caps.busyEnter === 'steer' ? 'steer' : 'queue';
      this.capabilitiesLoaded = true;
    }).catch((e: Error): void => {
      // 旧插件无此请求 → 能力目录为空（客户端隐藏选择区，不报错）
      this.presets = [];
      this.permissions = [];
      this.models = [];
      this.defaultModelId = '';
      this.archiveSupported = false;
      this.busyEnter = 'queue';
      this.capabilitiesLoaded = true;
      logDshrc(TAG, 'info', 'session.capabilities unavailable: ' + e.message);
    });
  }

  /**
   * 拉该会话的待执行消息快照（契约 §5.2 v1.1.2）。
   *
   * 为什么必须「拉」：`session.queue` 事件只在**队列变化时**推。手机端断线重连后
   * 若队列在断线期间变过，光靠事件永远补不上 → 用户看到「排队列表空的，
   * 桌面端明明排着一条」。故打开会话时拉一次全量快照（与事件同形状）。
   */
  loadQueue(sid: string): Promise<void> {
    if (sid.length === 0 || this.link.getState() !== 'online') {
      return Promise.resolve();
    }
    return this.link.sessionQueue(sid).then((items: DshrcQueueItem[]): void => {
      this.applyQueueSnapshot(sid, items);
    }).catch((e: Error): void => {
      // 旧插件无此请求 → 队列显示为空（不报错，不阻塞会话）
      logDshrc(TAG, 'info', 'session.queue unavailable: ' + e.message);
    });
  }

  /** 模式 id（新建会话用；无目录时返回空串）。 */
  presetNameOf(id: string): string {
    for (let i: number = 0; i < this.presets.length; i++) {
      if (this.presets[i].id === id) {
        return this.presets[i].name;
      }
    }
    return id;
  }

  /** 权限 id（新建会话用；无目录时返回空串）。 */
  permissionNameOf(id: string): string {
    for (let i: number = 0; i < this.permissions.length; i++) {
      if (this.permissions[i].id === id) {
        return this.permissions[i].name;
      }
    }
    return id;
  }

  // ---- 会话模型 / 思考强度（契约 §5.8 v1.0.8）----

  /**
   * 查询会话当前模型（session.model）。插件无记录 → null（UI 回退目录默认）。
   * 成功后写入缓存并投影到活动会话；失败静默（保持 null，不打扰时间线）。
   */
  loadSessionModel(sid: string): void {
    if (sid.length === 0 || this.link.getState() !== 'online') {
      return;
    }
    this.link.sessionModel(sid).then((sel: DshrcModelSelection | null): void => {
      if (sid !== this.activeId) {
        return; // 已切走：只进缓存，不动投影
      }
      if (sel === null) {
        this.sessionModel = null;
        return;
      }
      this.modelCache.set(sid, sel);
      this.sessionModel = sel;
    }).catch((e: Error): void => {
      logDshrc(TAG, 'info', 'session.model unavailable: ' + e.message);
    });
  }

  /**
   * 会话中切换模型/思考强度（session.selectModel，契约 §5.1 v1.0.8）。
   * Host 确认后更新缓存与投影（modelChanged 事件到达时幂等覆盖）；拒绝时 reject 原文。
   */
  applyModelSelection(sid: string, sel: DshrcModelSelection): Promise<void> {
    return this.link.sessionSelectModel(sid, sel).then((applied: DshrcModelSelection): void => {
      this.modelCache.set(sid, applied);
      if (sid === this.activeId) {
        this.sessionModel = applied;
      }
    });
  }

  // ---- 历史消息（契约 §5.1 session.history，v1.0.4）----

  private metaOf(sid: string): HistMeta {
    let meta: HistMeta | undefined = this.histMeta.get(sid);
    if (meta === undefined) {
      meta = new HistMeta();
      this.histMeta.set(sid, meta);
    }
    const got: HistMeta = meta;
    return got;
  }

  /**
   * 拉一页历史消息并并入会话缓存；永不 reject。
   * prepend=false：详情页打开时拉最新一页；prepend=true：列表顶部「加载更早消息」向前翻页
   * （beforeSeq 回传上一页的 oldestSeq，开区间）。
   */
  /** session.subagents 结果缓存（key=父会话 id；Map 内部变化不触发 UI，投影走 activeSubagents）。 */
  private subagentCache: Map<string, SubagentRow[]> = new Map<string, SubagentRow[]>();
  private subagentLoading: boolean = false;

  /**
   * session.subagents（§5.1 v1.0.5）：父会话直接子代理目录。
   * 永不 reject：失败静默（目录区隐藏即可，不打扰聊天）；结果写缓存并在
   * 目标为当前活动会话时投影到 activeSubagents（详情页子代理入口区直接读）。
   */
  loadSubagents(parentSid: string): Promise<void> {
    if (parentSid.length === 0 || this.link.getState() !== 'online' || this.subagentLoading) {
      return Promise.resolve();
    }
    this.subagentLoading = true;
    return this.link.sessionSubagents(parentSid).then((list: DshrcSubagentInfo[]): void => {
      const rows: SubagentRow[] = [];
      for (let i: number = 0; i < list.length; i++) {
        rows.push(new SubagentRow(list[i]));
      }
      this.subagentCache.set(parentSid, rows);
      if (parentSid === this.activeId) {
        this.activeSubagents = rows.slice();
      }
      this.subagentLoading = false;
    }).catch((e: Error): void => {
      this.subagentLoading = false;
      logDshrc(TAG, 'warn', 'session.subagents failed: ' + e.message);
    });
  }

  /** 打开会话时同步子代理目录投影（openSession 调用；缓存缺失时由页面触发 loadSubagents）。 */
  private projectSubagents(sid: string): void {
    const cached: SubagentRow[] | undefined = this.subagentCache.get(sid);
    this.activeSubagents = cached !== undefined ? cached.slice() : [];
  }

  /** 查某子代理会话在其父目录里的 mode（详情页判断 one-shot 用；查不到回空串）。 */
  subagentModeOf(childSid: string): string {
    for (const rows of this.subagentCache.values()) {
      for (let i: number = 0; i < rows.length; i++) {
        if (rows[i].sessionId === childSid) {
          return rows[i].mode;
        }
      }
    }
    return '';
  }

  /** 当前会话行（summaries 里查；subagent 详情页用它拿 parentSessionId）。 */
  rowOf(sid: string): SessionRow | undefined {
    return this.findRow(sid);
  }

  loadHistory(sid: string, prepend: boolean): Promise<void> {
    if (sid.length === 0 || this.link.getState() !== 'online' || this.historyLoading) {
      return Promise.resolve();
    }
    const meta: HistMeta = this.metaOf(sid);
    if (prepend && !meta.hasMore) {
      return Promise.resolve();
    }
    this.historyLoading = true;
    const before: number | undefined = prepend ? meta.oldestSeq : undefined;
    return this.link.sessionHistory(sid, before).then((page: DshrcHistoryPage): void => {
      meta.hasMore = page.hasMore;
      if (page.oldestSeq > 0) {
        meta.oldestSeq = page.oldestSeq;
      }
      meta.loaded = true;
      this.mergeHistory(sid, page.messages, page.steps, prepend);
      if (sid === this.activeId) {
        this.historyHasMore = meta.hasMore;
        this.historyLoaded = true;
      }
      this.historyLoading = false;
    }).catch((e: Error): void => {
      this.historyLoading = false;
      this.lastError = '加载历史失败：' + e.message;
      logDshrc(TAG, 'warn', 'session.history failed: ' + e.message);
    });
  }

  /**
   * 历史页并入缓存（契约 §5.7 v1.0.6：消息 + 工作步骤同轴合并，用 seq 对齐）：
   *  1) durable 项（消息/步骤）按页覆盖区间判重——与本页 [pageMin,pageMax] 重叠的旧副本摘除，
   *     统一按 seq 升序重排（页内可能含被过滤的非聊天事件，不能只按单点 seq 比对）；
   *  2) 直播项（seq<0）：非 prepend 时若与本页某条历史同 role+text 的消息，视为同一句话，丢弃直播副本；
   *     直播步骤若本页已含同 callId 的持久步骤，同样丢弃（同一调用不显示两遍）；
   *  3) 组装：prepend=旧页在最前；否则历史接在旧 durable 之后；直播项永远在最后（到达顺序）。
   */
  private mergeHistory(sid: string, messages: DshrcChatMessage[], steps: DshrcStepRecord[],
    prepend: boolean): void {
    const items: TimelineItem[] = this.cacheOf(sid);
    let pageMin: number = Number.MAX_SAFE_INTEGER;
    let pageMax: number = -1;
    for (let i: number = 0; i < messages.length; i++) {
      const sq: number = messages[i].seq;
      if (sq < pageMin) {
        pageMin = sq;
      }
      if (sq > pageMax) {
        pageMax = sq;
      }
    }
    for (let j: number = 0; j < steps.length; j++) {
      const sq2: number = steps[j].seq;
      if (sq2 >= 0 && sq2 < pageMin) {
        pageMin = sq2;
      }
      if (sq2 >= 0 && sq2 > pageMax) {
        pageMax = sq2;
      }
    }
    const durable: TimelineItem[] = [];
    const live: TimelineItem[] = [];
    for (let k: number = 0; k < items.length; k++) {
      const it: TimelineItem = items[k];
      if (it.seq >= 0) {
        if (it.seq >= pageMin && it.seq <= pageMax) {
          continue; // 与本页覆盖区间重叠：旧副本摘除，统一用本页副本
        }
        durable.push(it);
        continue;
      }
      if (!prepend && (it.isMessage() || it.isReasoning()) && it.text.length > 0 &&
        this.textCoveredByPage(messages, it)) {
        continue; // 直播副本已被 durable 历史覆盖，同一句话不显示两遍
      }
      if (!prepend && it.isMessage() && it.text.length === 0 && it.images.length > 0 &&
        this.imagesCoveredByPage(messages, it)) {
        continue; // v1.1.1：直播的独立图片消息（交付物，正文为空）已被本页 durable 副本覆盖 → 不重复显示
      }
      if (!prepend && it.isStep() && this.stepCoveredByPage(steps, it)) {
        continue; // 直播步骤已被本页持久步骤覆盖
      }
      live.push(it);
    }
    durable.sort((a: TimelineItem, b: TimelineItem): number => a.seq - b.seq);
    // v1.1.2 修复「下拉刷新后列表不再更新」：全量加载模式的 Repeat 按 key 复用节点、
    // **不会重新执行 each**——如果这里给同 key 换新实例（直播步骤 's'+callId 与历史步骤
    // 同 key；重复拉同一页时消息同 id），屏幕上的卡片仍绑着旧实例，后续 @Trace 更新
    // 打在旧实例上永远到不了 UI（步骤永远停在 running）。官方口径：身份稳定 + @Trace
    // 原地更新。故页项先查旧实例：同 id 就把字段搬运过去、**复用旧实例**。
    const oldById: Map<string, TimelineItem> = new Map<string, TimelineItem>();
    for (let k2: number = 0; k2 < items.length; k2++) {
      if (!oldById.has(items[k2].id)) {
        oldById.set(items[k2].id, items[k2]);
      }
    }
    const pageItems: TimelineItem[] = [];
    for (let m: number = 0; m < messages.length; m++) {
      const msg: DshrcChatMessage = messages[m];
      // v1.0.7：role==='reasoning' 映射为独立「思考过程」块（kind='reasoning'），
      // 不混进普通 assistant 正文（契约 §5.3）。
      const isReasoning: boolean = msg.role === 'reasoning';
      const kind: string = isReasoning ? 'reasoning' : 'message';
      const mi: TimelineItem = new TimelineItem(msg.id, kind, msg.ts);
      mi.role = msg.role;
      mi.text = msg.text;
      mi.seq = msg.seq;
      // v1.0.9：历史消息里的图片（旧插件不返该字段 → 空数组）
      mi.images = msg.images !== undefined ? msg.images : [];
      const priorM: TimelineItem | undefined = oldById.get(mi.id);
      if (priorM !== undefined) {
        this.transferTimelineFields(priorM, mi);
        pageItems.push(priorM);
      } else {
        pageItems.push(mi);
      }
    }
    for (let n: number = 0; n < steps.length; n++) {
      const st: DshrcStepRecord = steps[n];
      const si: TimelineItem = new TimelineItem('s' + st.callId, 'step', st.ts);
      si.callId = st.callId;
      si.toolName = st.name;
      si.argsText = st.arguments;
      si.status = st.status;
      si.resultText = st.resultText;
      si.errorText = st.errorText;
      si.turn = st.turn;
      si.step = st.step;
      si.seq = st.seq;
      // 同 key（'s'+callId）复用旧实例：直播步骤 → 持久步骤的字段搬运（status 定稿）
      const priorS: TimelineItem | undefined = oldById.get(si.id);
      if (priorS !== undefined) {
        this.transferTimelineFields(priorS, si);
        pageItems.push(priorS);
      } else {
        pageItems.push(si);
      }
    }
    pageItems.sort((a: TimelineItem, b: TimelineItem): number => a.seq - b.seq);
    // 防重保险：被页项复用的旧实例不得同时留在 durable/live（同对象进两个数组会双渲染；
    // 正常路径到不了这里，防御未来改动引入的回归）
    const reusedIds: Set<string> = new Set<string>();
    for (let p: number = 0; p < pageItems.length; p++) {
      reusedIds.add(pageItems[p].id);
    }
    const durableKept: TimelineItem[] = [];
    for (let q: number = 0; q < durable.length; q++) {
      if (!reusedIds.has(durable[q].id)) {
        durableKept.push(durable[q]);
      }
    }
    const liveKept: TimelineItem[] = [];
    for (let r: number = 0; r < live.length; r++) {
      if (!reusedIds.has(live[r].id)) {
        liveKept.push(live[r]);
      }
    }
    const body: TimelineItem[] = prepend ? pageItems.concat(durableKept) : durableKept.concat(pageItems);
    const merged: TimelineItem[] = body.concat(liveKept);
    this.cache.set(sid, merged);
    // v1.0.9 自愈：turn.end 事件若在断线窗口丢失，流式光标（▍）会残留在已结束的
    // 消息上。宿主侧该会话已不在运行（running=false）时不可能存在进行中的流——
    // 拉到历史后一律定稿所有 streaming 块，下次打开/刷新即自愈。
    if (!this.runningOf(sid)) {
      this.finalizeStaleStreaming(sid, merged);
    }
    this.notifyActive(sid);
  }

  /**
   * 把「新构造的页项」字段搬运到「同 id 的旧实例」上（v1.1.2）。
   *
   * 全量加载模式的 Repeat 按 key 复用节点且不重跑 each——屏幕上的组件绑的是旧实例，
   * 换实例等于把 UI 与数据切断。故历史合并时**身份不变、内容原地更新**：
   * 全部 @Trace 字段照搬（id 不动），组件靠 @Trace 感知内容变化。
   */
  private transferTimelineFields(dst: TimelineItem, src: TimelineItem): void {
    dst.kind = src.kind;
    dst.role = src.role;
    dst.text = src.text;
    dst.streaming = src.streaming;
    dst.ts = src.ts;
    dst.errorText = src.errorText;
    dst.seq = src.seq;
    dst.callId = src.callId;
    dst.toolName = src.toolName;
    dst.argsText = src.argsText;
    dst.status = src.status;
    dst.resultText = src.resultText;
    dst.turn = src.turn;
    dst.step = src.step;
    dst.images = src.images;
  }

  /** 静默清掉残留的流式标志（不自增 ts / 不加错误文案——只是光标回收）。 */
  private finalizeStaleStreaming(sid: string, items: TimelineItem[]): void {
    let touched: boolean = false;
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].streaming) {
        items[i].streaming = false;
        touched = true;
      }
    }
    if (touched) {
      logDshrc(TAG, 'info', 'finalized stale streaming blocks after history load (turn.end likely lost)');
    }
  }

  /** 直播气泡是否已被本页历史覆盖（存在同 role+text 的 durable 消息）。 */
  private textCoveredByPage(messages: DshrcChatMessage[], it: TimelineItem): boolean {
    for (let i: number = 0; i < messages.length; i++) {
      if (messages[i].role === it.role && messages[i].text === it.text) {
        return true;
      }
    }
    return false;
  }

  /** 直播步骤是否已被本页持久步骤覆盖（同 callId）。 */
  private stepCoveredByPage(steps: DshrcStepRecord[], it: TimelineItem): boolean {
    for (let i: number = 0; i < steps.length; i++) {
      if (steps[i].callId === it.callId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 直播图片消息是否已被本页 durable 历史覆盖（**所有**图片都能在历史里找到才算覆盖）。
   * 场景（契约 §5.10.2 v1.1.1）：交付物图片直播时是一条独立图片消息，
   * 插件在 session.history 里也会把它作为独立历史消息返回 →
   * 历史刷新后直播副本与 durable 副本重复，这里摘掉直播副本，只留一条。
   */
  private imagesCoveredByPage(messages: DshrcChatMessage[], it: TimelineItem): boolean {
    for (let i: number = 0; i < it.images.length; i++) {
      const imgId: string = it.images[i].imageId;
      let found: boolean = false;
      for (let j: number = 0; j < messages.length && !found; j++) {
        const imgs: DshrcImageRef[] | undefined = messages[j].images;
        if (imgs === undefined) {
          continue;
        }
        for (let k: number = 0; k < imgs.length; k++) {
          if (imgs[k].imageId === imgId) {
            found = true;
            break;
          }
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }

  /** 本地乐观追加一条用户消息（发送即上屏）。 */
  pushLocalUser(sid: string, text: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    this.chatSeq = this.chatSeq + 1;
    const mi: TimelineItem = new TimelineItem('u' + this.chatSeq.toString(), 'message', Date.now());
    mi.role = 'user';
    mi.text = text;
    items.push(mi);
    this.notifyActive(sid);
  }

  /** assistant.delta：首段开新气泡，后续并入当前流式气泡（契约 §5.2）。 */
  private appendDelta(sid: string, text: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    const last: TimelineItem | undefined = items.length > 0 ? items[items.length - 1] : undefined;
    if (last !== undefined && last.isMessage() && last.role === 'assistant' && last.streaming) {
      last.text = last.text + text;
      last.ts = Date.now();
    } else {
      this.chatSeq = this.chatSeq + 1;
      const mi: TimelineItem = new TimelineItem('a' + this.chatSeq.toString(), 'message', Date.now());
      mi.role = 'assistant';
      mi.text = text;
      mi.streaming = true;
      items.push(mi);
    }
    this.notifyActive(sid);
  }

  /**
   * assistant.reasoningDelta（契约 §5.2 v1.0.7）：思考增量。
   * 与文本分流——独立的「思考过程」块（kind='reasoning'），不并入 assistant 正文气泡。
   */
  private appendReasoningDelta(sid: string, text: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    const last: TimelineItem | undefined = items.length > 0 ? items[items.length - 1] : undefined;
    if (last !== undefined && last.kind === 'reasoning' && last.streaming) {
      last.text = last.text + text;
      last.ts = Date.now();
    } else {
      this.chatSeq = this.chatSeq + 1;
      const mi: TimelineItem = new TimelineItem('r' + this.chatSeq.toString(), 'reasoning', Date.now());
      mi.role = 'reasoning';
      mi.text = text;
      mi.streaming = true;
      items.push(mi);
    }
    this.notifyActive(sid);
  }

  /**
   * turn.end（契约 §5.2）：**定稿本轮所有流式块**（assistant 文本块与 reasoning 思考块），
   * 不能只处理最后一个——本轮可能先思考、后正文，两块都在流式。
   */
  private finalizeTurn(sid: string, errText: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    let finalized: boolean = false;
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].streaming) {
        items[i].streaming = false;
        items[i].ts = Date.now();
        if (errText.length > 0 && items[i].kind === 'message' && items[i].role === 'assistant') {
          items[i].errorText = errText;
        }
        finalized = true;
      }
    }
    if (!finalized && errText.length > 0) {
      this.chatSeq = this.chatSeq + 1;
      const it: TimelineItem = new TimelineItem('e' + this.chatSeq.toString(), 'message', Date.now());
      it.role = 'assistant';
      it.errorText = errText;
      items.push(it);
    }
    this.notifyActive(sid);
  }

  // ---- 工作步骤（契约 §5.7 v1.0.6）----

  /**
   * tool.call / tool.result 事件：登记或更新一条工作步骤。
   * 同 callId 已存在则原地更新（running → ok/error），不新增行。
   */
  private upsertStep(sid: string, callId: string, name: string, argsText: string,
    status: string, resultText: string, errorText: string, ts: number): void {
    if (sid.length === 0 || callId.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].isStep() && items[i].callId === callId) {
        if (name.length > 0) {
          items[i].toolName = name;
        }
        if (argsText.length > 0) {
          items[i].argsText = argsText;
        }
        items[i].status = status;
        if (resultText.length > 0) {
          items[i].resultText = resultText;
        }
        if (errorText.length > 0) {
          items[i].errorText = errorText;
        }
        items[i].ts = ts;
        this.notifyActive(sid);
        return;
      }
    }
    const si: TimelineItem = new TimelineItem('s' + callId, 'step', ts);
    si.callId = callId;
    si.toolName = name;
    si.argsText = argsText;
    si.status = status;
    si.resultText = resultText;
    si.errorText = errorText;
    items.push(si);
    this.notifyActive(sid);
  }

  /**
   * system.message 事件：追加一条系统/开发者消息（说明行，不占气泡）。 */
  private appendSystem(sid: string, kind: string, text: string, ts: number): void {
    if (sid.length === 0 || text.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    this.chatSeq = this.chatSeq + 1;
    const si: TimelineItem = new TimelineItem('y' + this.chatSeq.toString(), 'system', ts);
    si.role = kind;
    si.text = text;
    items.push(si);
    this.notifyActive(sid);
  }

  // ---- 图片（契约 §5.10 v1.0.9）----

  /**
   * assistant.image 事件（契约 §5.10 v1.0.9 + §5.10.2 v1.1.1）：
   *  - **附件图片**（无 source / source='attachment'）：挂到该会话当前正在流式的
   *    assistant 消息上；没有正在流式的 assistant 消息时，按到达顺序**单独成一条
   *    图片消息**（kind='message'、role='assistant'、text 为空串、images 带这一张）。
   *  - **交付物图片**（source='deliverable'，present 投递的文件）：**必须单独成一条**
   *    图片消息，**不挂**到流式 assistant 消息上——挂上去会在 turn 结束的历史刷新里
   *    被宿主的持久副本替换（副本里没有交付物图）→ 图片「一闪而过然后消失」。
   * 同一 imageId 重复到达时幂等（不重复挂、不重复成条）。
   */
  private appendImage(sid: string, image: DshrcImageRef): void {
    if (sid.length === 0 || image.imageId.length === 0) {
      return;
    }
    const items: TimelineItem[] = this.cacheOf(sid);
    const isDeliverable: boolean = image.source !== undefined && image.source === 'deliverable';
    if (!isDeliverable) {
      for (let i: number = items.length - 1; i >= 0; i--) {
        const it: TimelineItem = items[i];
        if (it.isMessage() && it.role === 'assistant' && it.streaming) {
          if (!this.hasImage(it, image.imageId)) {
            it.images = it.images.concat([image]);
          }
          this.notifyActive(sid);
          return;
        }
      }
    } else if (this.hasImageInItems(items, image.imageId)) {
      // 幂等：同一交付物图片重复到达 → 不再单独成一条
      return;
    }
    this.chatSeq = this.chatSeq + 1;
    const mi: TimelineItem = new TimelineItem('p' + this.chatSeq.toString(), 'message', Date.now());
    mi.role = 'assistant';
    mi.text = '';
    mi.images = [image];
    items.push(mi);
    this.notifyActive(sid);
  }

  /** 该消息上是否已挂了同 id 的图片（幂等判定）。 */
  private hasImage(it: TimelineItem, imageId: string): boolean {
    for (let i: number = 0; i < it.images.length; i++) {
      if (it.images[i].imageId === imageId) {
        return true;
      }
    }
    return false;
  }

  /** 会话里是否已经出现过这张图（交付物图片幂等判定；跨消息查）。 */
  private hasImageInItems(items: TimelineItem[], imageId: string): boolean {
    for (let i: number = 0; i < items.length; i++) {
      if (this.hasImage(items[i], imageId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 拉取图片大图（契约 §5.1 image.fetch / §5.10 v1.0.9）。
   *  - maxEdge 缺省 1600、上限 4096（超出按上限截断）；
   *  - 命中内存缓存直接返回（避免重复压缩 / 重复传输）；
   *  - **失败吞掉并回 null**（图片可选，绝不抛崩 UI）。
   */
  fetchImage(imageId: string, maxEdge?: number): Promise<string | null> {
    if (imageId.length === 0) {
      return Promise.resolve(null);
    }
    let edge: number = maxEdge !== undefined ? maxEdge : IMAGE_FETCH_DEFAULT_MAX_EDGE;
    if (edge <= 0) {
      edge = IMAGE_FETCH_DEFAULT_MAX_EDGE;
    }
    if (edge > IMAGE_FETCH_MAX_EDGE) {
      edge = IMAGE_FETCH_MAX_EDGE;
    }
    const key: string = imageId + '@' + edge.toString();
    const cached: string | undefined = this.imageCache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const p: DshrcPayload = { imageId: imageId, maxEdge: edge };
    return this.link.request(MSG_IMAGE_FETCH, p, IMAGE_FETCH_TIMEOUT_MS).then((v: DshrcValue): string | null => {
      const data: string = v.data !== undefined ? v.data : '';
      if (data.length === 0) {
        logDshrc(TAG, 'warn', 'image.fetch empty payload: ' + imageId);
        return null;
      }
      this.putImageCache(key, data);
      return data;
    }).catch((e: Error): string | null => {
      // 契约 §5.10：image.fetch 失败不得影响会话其余功能
      logDshrc(TAG, 'warn', 'image.fetch failed: ' + e.message);
      return null;
    });
  }

  /** 大图内存缓存写入（超出上限按插入序淘汰最旧）。 */
  private putImageCache(key: string, data: string): void {
    this.imageCache.set(key, data);
    while (this.imageCache.size > IMAGE_CACHE_MAX) {
      const oldest: string[] = [];
      this.imageCache.forEach((v: string, k: string): void => {
        oldest.push(k);
      });
      if (oldest.length === 0) {
        break;
      }
      this.imageCache.delete(oldest[0]);
    }
  }

  private cacheOf(sid: string): TimelineItem[] {
    let items: TimelineItem[] | undefined = this.cache.get(sid);
    if (items === undefined) {
      items = [];
      this.cache.set(sid, items);
    }
    return items;
  }

  /** 结构性变化后整数组替换（数组快照与 cache 共享 TimelineItem 实例）。 */
  private notifyActive(sid: string): void {
    if (sid !== this.activeId) {
      return;
    }
    const items: TimelineItem[] | undefined = this.cache.get(sid);
    this.timeline = items !== undefined ? items.slice() : [];
  }

  /** 会话被移除后清缓存；活动会话被删则退回空。 */
  private pruneCache(): void {
    // 保留仍在列表里的会话缓存，删除的顺带清掉，防止内存无限涨。
    const alive: Map<string, boolean> = new Map<string, boolean>();
    for (let i: number = 0; i < this.sessions.length; i++) {
      alive.set(this.sessions[i].sessionId, true);
    }
    const keys: string[] = [];
    this.cache.forEach((v: TimelineItem[], k: string): void => {
      keys.push(k);
    });
    for (let j: number = 0; j < keys.length; j++) {
      if (!alive.has(keys[j])) {
        this.cache.delete(keys[j]);
        this.histMeta.delete(keys[j]);
        this.queueCache.delete(keys[j]); // v1.1.1：会话没了，它的待执行消息也没了
      }
    }
    if (this.activeId.length > 0 && !alive.has(this.activeId)) {
      this.activeId = '';
      this.timeline = [];
    }
  }

  // ---- 审批 / 提问 ----

  /** 本会话待审批卡片（详情页内嵌）。 */
  approvalsFor(sid: string): ApprovalCard[] {
    const out: ApprovalCard[] = [];
    for (let i: number = 0; i < this.approvals.length; i++) {
      const c: ApprovalCard = this.approvals[i];
      if (!c.answered && c.sessionId === sid) {
        out.push(c);
      }
    }
    return out;
  }

  /** 本会话待回答卡片。 */
  questionsFor(sid: string): QuestionCard[] {
    const out: QuestionCard[] = [];
    for (let i: number = 0; i < this.questions.length; i++) {
      const c: QuestionCard = this.questions[i];
      if (!c.answered && c.sessionId === sid) {
        out.push(c);
      }
    }
    return out;
  }

  /** 全部待审批卡片（审批队列页）。 */
  pendingApprovals(): ApprovalCard[] {
    const out: ApprovalCard[] = [];
    for (let i: number = 0; i < this.approvals.length; i++) {
      if (!this.approvals[i].answered) {
        out.push(this.approvals[i]);
      }
    }
    return out;
  }

  /** 全部待回答卡片。 */
  pendingQuestions(): QuestionCard[] {
    const out: QuestionCard[] = [];
    for (let i: number = 0; i < this.questions.length; i++) {
      if (!this.questions[i].answered) {
        out.push(this.questions[i]);
      }
    }
    return out;
  }

  /** 提交审批决定（契约 §5.1 approval.answer；applied=false 表示已超时由桌面端处理）。 */
  submitApproval(askId: string, decision: string, note: string): Promise<boolean> {
    return this.link.approvalAnswer(askId, decision, note).then((applied: boolean): boolean => {
      if (applied) {
        this.markApprovalAnswered(askId);
      } else {
        this.lastError = '审批已超时，桌面端已处理';
      }
      return applied;
    });
  }

  /** 提交提问回答（契约 §5.1 question.answer）。 */
  submitQuestion(askId: string, answers: Object, freeText: string): Promise<boolean> {
    return this.link.questionAnswer(askId, answers, freeText).then((applied: boolean): boolean => {
      if (applied) {
        this.markQuestionAnswered(askId);
      } else {
        this.lastError = '提问已超时，桌面端已处理';
      }
      return applied;
    });
  }

  /** 本地先隐藏卡片（等 host 回推 *.resolved 彻底移除）。 */
  markApprovalAnswered(askId: string): void {
    for (let i: number = 0; i < this.approvals.length; i++) {
      if (this.approvals[i].askId === askId) {
        this.approvals[i].answered = true;
      }
    }
  }

  /** 本地先隐藏问答卡片。 */
  markQuestionAnswered(askId: string): void {
    for (let i: number = 0; i < this.questions.length; i++) {
      if (this.questions[i].askId === askId) {
        this.questions[i].answered = true;
      }
    }
  }

  // ---- 推送（契约 §6）----

  /** EntryAbility / PushKit 取到 token 后写入；在线则立即补报。 */
  setPushToken(token: string): void {
    this.pushToken = token;
    if (this.link.getState() === 'online') {
      this.reportPush();
    }
  }

  /** push.register 上报（链路在线 + 有 token + 本机开关开）。 */
  reportPush(): void {
    if (this.link.getState() !== 'online' || this.pushToken.length === 0 || !this.pushLocalEnabled) {
      return;
    }
    this.link.pushRegister(this.pushToken).then((ok: boolean): void => {
      this.pushRegistered = ok;
      logDshrc(TAG, 'info', 'push.register ok=' + ok.toString());
    }).catch((e: Error): void => {
      this.pushRegistered = false;
      logDshrc(TAG, 'warn', 'push.register failed: ' + e.message);
    });
  }

  /** 本机推送开关（配对页 Toggle；同时持久化）。 */
  setPushLocalEnabled(on: boolean): void {
    this.pushLocalEnabled = on;
    if (on) {
      this.reportPush();
    } else {
      this.pushRegistered = false;
    }
  }

  // ---- 推送点击导航 ----

  /** EntryAbility 解析 intent 后写入；Index 已挂载则立即回调。 */
  setPendingNav(sessionId: string, askId: string): void {
    this.pendingNavSessionId = sessionId;
    this.pendingNavAskId = askId;
    this.pendingNavSeq = this.pendingNavSeq + 1;
    if (this.onPendingNav !== null) {
      this.onPendingNav();
    }
    // 粘性广播：EntryAbility.onCreate 写入早于 Index 挂载，Index sticky 订阅补收。
    postPendingNav(sessionId, askId);
  }

  /** Index 读取并清空待导航目标（消费一次即清）。 */
  takePendingNav(): PendingNav {
    const p: PendingNav = { sessionId: this.pendingNavSessionId, askId: this.pendingNavAskId };
    this.pendingNavSessionId = '';
    this.pendingNavAskId = '';
    return p;
  }

  // ---- 事件合并（契约 §5.2）----

  /** 处理一条解密后的业务消息（result 已被 Correlator 吃掉，这里只处理 event）。 */
  private handleEvent(m: DshrcMsg): void {
    if (m.type !== MSG_EVENT) {
      return;
    }
    if (m.payload === null || m.payload === undefined) {
      return;
    }
    const topic: string = m.payload.topic !== undefined ? m.payload.topic : '';
    const empty: DshrcValue = JSON.parse('{}') as DshrcValue;
    const data: DshrcValue = m.payload.data !== undefined && m.payload.data !== null ? m.payload.data : empty;
    switch (topic) {
      case TOPIC_SESSION_ADDED: {
        // 契约 §5.2：session.added 的 data = {session: SessionSummary}（嵌套一层）
        const added: DshrcSessionSummary | undefined = data.session;
        if (added !== undefined && added.sessionId.length > 0) {
          const row: SessionRow | undefined = this.findRow(added.sessionId);
          if (row !== undefined) {
            row.apply(added);
          } else {
            this.sessions = this.sessions.concat([new SessionRow(added)]);
          }
          this.listVersion = this.listVersion + 1;
        }
        break;
      }
      case TOPIC_SESSION_REMOVED: {
        const sid: string = data.sessionId !== undefined ? data.sessionId : '';
        if (sid.length > 0) {
          const next: SessionRow[] = [];
          for (let i: number = 0; i < this.sessions.length; i++) {
            if (this.sessions[i].sessionId !== sid) {
              next.push(this.sessions[i]);
            }
          }
          this.sessions = next;
          this.listVersion = this.listVersion + 1;
          this.pruneCache();
        }
        break;
      }
      case TOPIC_SESSION_STATUS: {
        const sid2: string = data.sessionId !== undefined ? data.sessionId : '';
        const row2: SessionRow | undefined = this.findRow(sid2);
        if (row2 !== undefined) {
          row2.running = data.running === true;
          this.listVersion = this.listVersion + 1;
        }
        break;
      }
      case TOPIC_SESSION_ACTIVITY: {
        const sid3: string = data.sessionId !== undefined ? data.sessionId : '';
        const row3: SessionRow | undefined = this.findRow(sid3);
        if (row3 !== undefined && data.updatedAt !== undefined) {
          row3.updatedAt = data.updatedAt;
          this.listVersion = this.listVersion + 1;
        }
        break;
      }
      case TOPIC_SESSION_ARCHIVES: {
        // 契约 §5.2 v1.0.7：Workspace 归档集合**全集**快照 → 覆盖所有行的 archived
        const ids: string[] = data.archivedSessionIds !== undefined ? data.archivedSessionIds : [];
        this.applyArchivedSet(ids);
        break;
      }
      case TOPIC_SESSION_MODEL_CHANGED: {
        // 契约 §5.2 v1.0.8：任一端切换模型 → 更新该会话缓存并投影到活动会话
        const sidM: string = data.sessionId !== undefined ? data.sessionId : '';
        const sel: DshrcModelSelection | undefined = data.model;
        if (sidM.length > 0 && sel !== undefined) {
          this.modelCache.set(sidM, sel);
          if (sidM === this.activeId) {
            this.sessionModel = sel;
          }
        }
        break;
      }
      case TOPIC_SESSION_QUEUE: {
        // 契约 §5.2 v1.1.1：待执行消息全量快照（排队中 / 已插入当前 turn）——只展示，不猜测
        const sidQ: string = data.sessionId !== undefined ? data.sessionId : '';
        this.applyQueueSnapshot(sidQ, data.items);
        break;
      }
      case TOPIC_ASSISTANT_DELTA: {
        const sid4: string = data.sessionId !== undefined ? data.sessionId : '';
        if (data.text !== undefined) {
          this.appendDelta(sid4, data.text);
        }
        break;
      }
      case TOPIC_ASSISTANT_REASONING_DELTA: {
        // 契约 §5.2 v1.0.7：思考增量（与文本分流，独立「思考过程」块）
        const sidR2: string = data.sessionId !== undefined ? data.sessionId : '';
        if (data.text !== undefined) {
          this.appendReasoningDelta(sidR2, data.text);
        }
        break;
      }
      case TOPIC_ASSISTANT_IMAGE: {
        // 契约 §5.10 v1.0.9：会话消息里的图片（挂当前流式 assistant 消息 / 单独成一条）
        const sidImg: string = data.sessionId !== undefined ? data.sessionId : '';
        const img: DshrcImageRef | undefined = data.image;
        if (img !== undefined) {
          this.appendImage(sidImg, img);
        }
        break;
      }
      case TOPIC_TOOL_CALL: {
        // 契约 §5.7 v1.0.6：工具调用开始 → 工作步骤（running）
        const sidT: string = data.sessionId !== undefined ? data.sessionId : '';
        this.upsertStep(sidT,
          data.callId !== undefined ? data.callId : '',
          data.name !== undefined ? data.name : '',
          data.arguments !== undefined ? data.arguments : '',
          'running', '', '',
          data.ts !== undefined ? data.ts : Date.now());
        break;
      }
      case TOPIC_TOOL_RESULT: {
        // 契约 §5.7 v1.0.6：工具调用结束 → 工作步骤定稿
        const sidR: string = data.sessionId !== undefined ? data.sessionId : '';
        const st: string = data.status !== undefined ? data.status : 'ok';
        this.upsertStep(sidR,
          data.callId !== undefined ? data.callId : '',
          '',
          '',
          st === 'error' ? 'error' : 'ok',
          data.resultText !== undefined ? data.resultText : '',
          data.errorText !== undefined ? data.errorText : '',
          data.ts !== undefined ? data.ts : Date.now());
        break;
      }
      case TOPIC_SYSTEM_MESSAGE: {
        // 契约 §5.7 v1.0.6：系统/开发者消息
        const sidS: string = data.sessionId !== undefined ? data.sessionId : '';
        const kind: string = data.kind !== undefined ? data.kind : 'system';
        this.appendSystem(sidS, kind, data.text !== undefined ? data.text : '',
          data.ts !== undefined ? data.ts : Date.now());
        break;
      }
      case TOPIC_TURN_END: {
        const sid5: string = data.sessionId !== undefined ? data.sessionId : '';
        const row5: SessionRow | undefined = this.findRow(sid5);
        if (row5 !== undefined) {
          row5.running = false;
          this.listVersion = this.listVersion + 1;
        }
        const errText: string = data.status === 'error'
          ? (data.error !== undefined ? data.error : '回复出错') : '';
        this.finalizeTurn(sid5, errText);
        break;
      }
      case TOPIC_APPROVAL_REQUEST: {
        const askId: string = data.askId !== undefined ? data.askId : '';
        if (askId.length > 0) {
          const timeoutMs: number = data.timeoutMs !== undefined ? data.timeoutMs : 0;
          const card: ApprovalCard = new ApprovalCard(askId,
            data.sessionId !== undefined ? data.sessionId : '',
            data.toolName !== undefined ? data.toolName : '',
            data.reason !== undefined ? data.reason : '',
            data.argsPreview !== undefined ? data.argsPreview : '',
            Date.now() + timeoutMs, timeoutMs);
          this.approvals = this.approvals.concat([card]);
          postApprovalArrived(card.sessionId, askId, card.toolName);
        }
        break;
      }
      case TOPIC_APPROVAL_RESOLVED: {
        const askId2: string = data.askId !== undefined ? data.askId : '';
        if (askId2.length > 0) {
          this.dropApproval(askId2);
          postApprovalResolved(askId2);
        }
        break;
      }
      case TOPIC_QUESTION_REQUEST: {
        const askId3: string = data.askId !== undefined ? data.askId : '';
        if (askId3.length > 0) {
          const timeoutMs3: number = data.timeoutMs !== undefined ? data.timeoutMs : 0;
          const qcard: QuestionCard = new QuestionCard(askId3,
            data.sessionId !== undefined ? data.sessionId : '',
            data.questions !== undefined ? data.questions : [],
            data.multiSelect === true, Date.now() + timeoutMs3, timeoutMs3);
          this.questions = this.questions.concat([qcard]);
          postQuestionArrived(qcard.sessionId, askId3);
        }
        break;
      }
      case TOPIC_QUESTION_RESOLVED: {
        const askId4: string = data.askId !== undefined ? data.askId : '';
        if (askId4.length > 0) {
          this.dropQuestion(askId4);
          postQuestionResolved(askId4);
        }
        break;
      }
      case TOPIC_PUSH_STATE: {
        this.pushRemoteEnabled = data.enabled === true;
        this.pushRemoteReason = data.reason !== undefined ? data.reason : '';
        break;
      }
      case TOPIC_ERROR: {
        // 契约 §5.2：error 事件的 data = {message}
        this.lastError = data.message !== undefined ? data.message : 'host 报错';
        logDshrc(TAG, 'warn', 'host error event: ' + this.lastError);
        break;
      }
      default: {
        break;
      }
    }
  }

  private dropApproval(askId: string): void {
    const next: ApprovalCard[] = [];
    for (let i: number = 0; i < this.approvals.length; i++) {
      if (this.approvals[i].askId !== askId) {
        next.push(this.approvals[i]);
      }
    }
    this.approvals = next;
  }

  private dropQuestion(askId: string): void {
    const next: QuestionCard[] = [];
    for (let i: number = 0; i < this.questions.length; i++) {
      if (this.questions[i].askId !== askId) {
        next.push(this.questions[i]);
      }
    }
    this.questions = next;
  }
}

/** 全局单例（配对页 / 列表页 / 详情页 / 审批页共享同一份状态）。 */
export const sessionStore: SessionStore = SessionStore.get();
