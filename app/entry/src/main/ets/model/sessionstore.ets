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
import { hilog } from '@kit.PerformanceAnalysisKit';
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { Context } from '@kit.AbilityKit';
import { DshrcLink, LinkPeers, LinkState, dshrcLink } from './link';
import {
  DshrcMsg,
  DshrcQuestion,
  DshrcSessionSummary,
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
const LOG_DOMAIN: number = 0x0000;
const PREF_NAME: string = 'dshrc_prefs';
const KEY_PUSH_ENABLED: string = 'pushEnabled';
const LOG_KEEP: number = 80;

/** 会话列表一行（契约 §5.3 SessionSummary 的可观察形态）。 */
@ObservedV2
export class SessionRow {
  @Trace sessionId: string = '';
  @Trace title: string = '';
  @Trace cwd: string = '';
  @Trace running: boolean = false;
  @Trace updatedAt: number = 0;
  @Trace archived: boolean = false;

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
    this.archived = s.archived;
  }
}

/** 一条聊天消息（user / assistant；assistant 可处于流式追加中）。 */
@ObservedV2
export class ChatItem {
  @Trace id: string = '';
  @Trace role: string = '';
  @Trace text: string = '';
  @Trace streaming: boolean = false;
  @Trace ts: number = 0;
  @Trace errorText: string = '';

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
    hilog.warn(LOG_DOMAIN, TAG, 'loadPushEnabled failed: %{public}s', err.message);
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
    hilog.error(LOG_DOMAIN, TAG, 'savePushEnabled failed: %{public}s', err.message);
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
    return this.link.sessionList(false).then((list: DshrcSessionSummary[]): void => {
      this.applySessionList(list);
      this.refreshing = false;
    }).catch((e: Error): void => {
      this.refreshing = false;
      this.lastError = e.message;
      hilog.warn(LOG_DOMAIN, TAG, 'session.list failed: %{public}s', e.message);
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
    if (sid.length === 0) {
      this.messages = [];
      return;
    }
    if (!this.cache.has(sid)) {
      this.cache.set(sid, []);
    }
    const items: ChatItem[] | undefined = this.cache.get(sid);
    this.messages = items !== undefined ? items.slice() : [];
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
      hilog.info(LOG_DOMAIN, TAG, 'push.register ok=%{public}s', ok.toString());
    }).catch((e: Error): void => {
      this.pushRegistered = false;
      hilog.warn(LOG_DOMAIN, TAG, 'push.register failed: %{public}s', e.message);
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
        }
        break;
      }
      case TOPIC_APPROVAL_RESOLVED: {
        const askId2: string = data.askId !== undefined ? data.askId : '';
        if (askId2.length > 0) {
          this.dropApproval(askId2);
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
        }
        break;
      }
      case TOPIC_QUESTION_RESOLVED: {
        const askId4: string = data.askId !== undefined ? data.askId : '';
        if (askId4.length > 0) {
          this.dropQuestion(askId4);
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
        hilog.warn(LOG_DOMAIN, TAG, 'host error event: %{public}s', this.lastError);
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
