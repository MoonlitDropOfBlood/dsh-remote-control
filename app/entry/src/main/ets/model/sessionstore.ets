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
import { DshrcLink, LinkPeers, LinkState, dshrcLink } from './link';
import {
  DshrcMsg,
  DshrcQuestion,
  DshrcSessionSummary,
  DshrcSubagentInfo,
  DshrcChatMessage,
  DshrcHistoryPage,
  DshrcValue,
  MSG_EVENT,
  TOPIC_APPROVAL_REQUEST,
  TOPIC_APPROVAL_RESOLVED,
  TOPIC_ASSISTANT_DELTA,
  TOPIC_ERROR,
  TOPIC_PUSH_STATE,
  TOPIC_QUESTION_REQUEST,
  TOPIC_QUESTION_RESOLVED,
  TOPIC_SESSION_ACTIVITY,
  TOPIC_SESSION_ADDED,
  TOPIC_SESSION_REMOVED,
  TOPIC_SESSION_STATUS,
  TOPIC_TURN_END
} from './protocol';

const TAG: string = 'dshrc-sessionstore';
const PREF_NAME: string = 'dshrc_prefs';
const KEY_PUSH_ENABLED: string = 'pushEnabled';
const LOG_KEEP: number = 80;

/** 会话列表一行（契约 §5.3 SessionSummary 的可观察形态；v1.0.4 补 subagent/blank，
 *  v1.0.5 删 archived——列表不再有归档筛选，subagent 不进列表）。 */
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
  }

  /** subagent 会话（origin 标记或有父会话血缘）→ 不进列表，入口在父会话详情页。 */
  isSubagent(): boolean {
    return this.origin === 'subagent' || this.parentSessionId.length > 0;
  }
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

/** 一条聊天消息（user / assistant；assistant 可处于流式追加中）。
 *  seq：host 日志持久序号（session.history 历史消息）；-1=本地/直播气泡（无持久序号）。 */
@ObservedV2
export class ChatItem {
  @Trace id: string = '';
  @Trace role: string = '';
  @Trace text: string = '';
  @Trace streaming: boolean = false;
  @Trace ts: number = 0;
  @Trace errorText: string = '';
  @Trace seq: number = -1;

  constructor(id: string, role: string, text: string, ts: number, streaming: boolean) {
    this.id = id;
    this.role = role;
    this.text = text;
    this.ts = ts;
    this.streaming = streaming;
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
  @Trace activeId: string = '';
  @Trace messages: ChatItem[] = [];
  // ---- 历史消息（契约 §5.1 session.history，v1.0.4；活动会话投影）----
  @Trace historyLoading: boolean = false;
  @Trace historyHasMore: boolean = false;
  @Trace historyLoaded: boolean = false;
  // ---- 子代理目录（契约 §5.6 v1.0.5；活动会话投影 + 每父会话缓存）----
  @Trace activeSubagents: SubagentRow[] = [];
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

  /** Index 挂载后设置：有待导航目标时立即回调（EntryAbility onNewWant 触发链）。 */
  onPendingNav: (() => void) | null = null;

  private link: DshrcLink = dshrcLink;
  private cache: Map<string, ChatItem[]> = new Map<string, ChatItem[]>();
  private histMeta: Map<string, HistMeta> = new Map<string, HistMeta>();
  private chatSeq: number = 0;

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

  /** session.list 拉取（连接成功 / 下拉刷新调用）；返回 Promise 供刷新动画收尾，永不 reject。 */
  refreshSessions(): Promise<void> {
    if (this.link.getState() !== 'online' || this.refreshing) {
      return Promise.resolve();
    }
    this.refreshing = true;
    return this.link.sessionList().then((list: DshrcSessionSummary[]): void => {
      this.applySessionList(list);
      this.refreshing = false;
    }).catch((e: Error): void => {
      this.refreshing = false;
      this.lastError = e.message;
      logDshrc(TAG, 'warn', 'session.list failed: ' + e.message);
    });
  }

  /** session.list 结果整体替换（保留既有行实例，避免页面状态被重建）。 */
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
    if (sid.length === 0) {
      this.messages = [];
      this.historyHasMore = false;
      this.historyLoaded = false;
      return;
    }
    if (!this.cache.has(sid)) {
      this.cache.set(sid, []);
    }
    const items: ChatItem[] | undefined = this.cache.get(sid);
    this.messages = items !== undefined ? items.slice() : [];
    // 投影本会话的历史翻页状态（详情页据此渲染「加载更早消息」）
    const meta: HistMeta | undefined = this.histMeta.get(sid);
    this.historyLoaded = meta !== undefined && meta.loaded;
    this.historyHasMore = meta !== undefined && meta.hasMore;
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
      this.mergeHistory(sid, page.messages, prepend);
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
   * 历史页并入缓存（历史与直播气泡合并去重，用 seq 对齐）：
   *  1) durable 消息按页覆盖区间判重——与本页 [pageMin,pageMax] 重叠的旧副本摘除，
   *     统一按 seq 升序重排（页内可能含被过滤的非聊天事件，不能只按单点 seq 比对）；
   *  2) 直播气泡（seq<0）：非 prepend 时若与本页某条历史同 role+text，视为同一句话，丢弃直播副本；
   *  3) 组装：prepend=旧页在最前；否则历史接在旧 durable 之后；直播气泡永远在最后（时间上最新）。
   */
  private mergeHistory(sid: string, messages: DshrcChatMessage[], prepend: boolean): void {
    const items: ChatItem[] = this.cacheOf(sid);
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
    const durable: ChatItem[] = [];
    const live: ChatItem[] = [];
    for (let j: number = 0; j < items.length; j++) {
      const it: ChatItem = items[j];
      if (it.seq >= 0) {
        if (messages.length > 0 && it.seq >= pageMin && it.seq <= pageMax) {
          continue; // 与本页覆盖区间重叠：旧副本摘除，统一用本页副本
        }
        durable.push(it);
        continue;
      }
      if (!prepend && it.text.length > 0 && this.textCoveredByPage(messages, it)) {
        continue; // 直播副本已被 durable 历史覆盖，同一句话不显示两遍
      }
      live.push(it);
    }
    durable.sort((a: ChatItem, b: ChatItem): number => a.seq - b.seq);
    const pageItems: ChatItem[] = [];
    for (let k: number = 0; k < messages.length; k++) {
      const msg: DshrcChatMessage = messages[k];
      const ci: ChatItem = new ChatItem(msg.id, msg.role, msg.text, msg.ts, false);
      ci.seq = msg.seq;
      pageItems.push(ci);
    }
    const body: ChatItem[] = prepend ? pageItems.concat(durable) : durable.concat(pageItems);
    this.cache.set(sid, body.concat(live));
    this.notifyActive(sid);
  }

  /** 直播气泡是否已被本页历史覆盖（存在同 role+text 的 durable 消息）。 */
  private textCoveredByPage(messages: DshrcChatMessage[], it: ChatItem): boolean {
    for (let i: number = 0; i < messages.length; i++) {
      if (messages[i].role === it.role && messages[i].text === it.text) {
        return true;
      }
    }
    return false;
  }

  /** 本地乐观追加一条用户消息（发送即上屏）。 */
  pushLocalUser(sid: string, text: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: ChatItem[] = this.cacheOf(sid);
    this.chatSeq = this.chatSeq + 1;
    items.push(new ChatItem('u' + this.chatSeq.toString(), 'user', text, Date.now(), false));
    this.notifyActive(sid);
  }

  /** assistant.delta：首段开新气泡，后续并入当前流式气泡（契约 §5.2）。 */
  private appendDelta(sid: string, text: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: ChatItem[] = this.cacheOf(sid);
    const last: ChatItem | undefined = items.length > 0 ? items[items.length - 1] : undefined;
    if (last !== undefined && last.role === 'assistant' && last.streaming) {
      last.text = last.text + text;
      last.ts = Date.now();
    } else {
      this.chatSeq = this.chatSeq + 1;
      items.push(new ChatItem('a' + this.chatSeq.toString(), 'assistant', text, Date.now(), true));
    }
    this.notifyActive(sid);
  }

  /** turn.end：定稿当前流式气泡；status=error 时标注错误（契约 §5.2）。 */
  private finalizeTurn(sid: string, errText: string): void {
    if (sid.length === 0) {
      return;
    }
    const items: ChatItem[] = this.cacheOf(sid);
    const last: ChatItem | undefined = items.length > 0 ? items[items.length - 1] : undefined;
    if (last !== undefined && last.streaming) {
      last.streaming = false;
      last.ts = Date.now();
      if (errText.length > 0) {
        last.errorText = errText;
      }
    } else if (errText.length > 0) {
      this.chatSeq = this.chatSeq + 1;
      const it: ChatItem = new ChatItem('e' + this.chatSeq.toString(), 'assistant', '',
        Date.now(), false);
      it.errorText = errText;
      items.push(it);
    }
    this.notifyActive(sid);
  }

  private cacheOf(sid: string): ChatItem[] {
    let items: ChatItem[] | undefined = this.cache.get(sid);
    if (items === undefined) {
      items = [];
      this.cache.set(sid, items);
    }
    return items;
  }

  /** 结构性变化后整数组替换（数组快照与 cache 共享 ChatItem 实例）。 */
  private notifyActive(sid: string): void {
    if (sid !== this.activeId) {
      return;
    }
    const items: ChatItem[] | undefined = this.cache.get(sid);
    this.messages = items !== undefined ? items.slice() : [];
  }

  /** 会话被移除后清缓存；活动会话被删则退回空。 */
  private pruneCache(): void {
    // 保留仍在列表里的会话缓存，删除的顺带清掉，防止内存无限涨。
    const alive: Map<string, boolean> = new Map<string, boolean>();
    for (let i: number = 0; i < this.sessions.length; i++) {
      alive.set(this.sessions[i].sessionId, true);
    }
    const keys: string[] = [];
    this.cache.forEach((v: ChatItem[], k: string): void => {
      keys.push(k);
    });
    for (let j: number = 0; j < keys.length; j++) {
      if (!alive.has(keys[j])) {
        this.cache.delete(keys[j]);
        this.histMeta.delete(keys[j]);
      }
    }
    if (this.activeId.length > 0 && !alive.has(this.activeId)) {
      this.activeId = '';
      this.messages = [];
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
          this.pruneCache();
        }
        break;
      }
      case TOPIC_SESSION_STATUS: {
        const sid2: string = data.sessionId !== undefined ? data.sessionId : '';
        const row2: SessionRow | undefined = this.findRow(sid2);
        if (row2 !== undefined) {
          row2.running = data.running === true;
        }
        break;
      }
      case TOPIC_SESSION_ACTIVITY: {
        const sid3: string = data.sessionId !== undefined ? data.sessionId : '';
        const row3: SessionRow | undefined = this.findRow(sid3);
        if (row3 !== undefined && data.updatedAt !== undefined) {
          row3.updatedAt = data.updatedAt;
        }
        break;
      }
      case TOPIC_ASSISTANT_DELTA: {
        const sid4: string = data.sessionId !== undefined ? data.sessionId : '';
        if (data.text !== undefined) {
          this.appendDelta(sid4, data.text);
        }
        break;
      }
      case TOPIC_TURN_END: {
        const sid5: string = data.sessionId !== undefined ? data.sessionId : '';
        const row5: SessionRow | undefined = this.findRow(sid5);
        if (row5 !== undefined) {
          row5.running = false;
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
