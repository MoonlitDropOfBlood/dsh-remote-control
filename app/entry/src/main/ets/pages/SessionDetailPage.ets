/*
 * Copyright (c) 2026 dukedsh.
 * 会话详情页（NavDestination，param = SessionDetailParam）。
 *  - 统一时间线：store.timeline 按 kind 分派（消息气泡 / 工作步骤卡 / 系统说明行）→ TimelineView
 *  - assistant.delta 流式追加到当前气泡（带光标），turn.end 定稿
 *  - 底部输入条 + 发送；running 时显示「取消」；顶部标题栏 + 运行状态徽标
 *  - 本会话的审批 / 提问卡片内嵌在输入条上方（AskCards），resolved 后自动消失
 *  - v1.0.8：输入条上方「模型 / 思考强度」胶囊 → bindSheet 选模型与强度（session.selectModel）
 *  - v1.1.1：agent 运行时输入条上方出现「排队 / 插入当前任务」模式胶囊（session.prompt 的 mode）；
 *    待执行消息列表（宿主 session.queue 事件）在输入区上方展示，只展示不猜测
 */
import { MarkdownController } from '@luvi/lv-markdown-in';
import { promptAction } from '@kit.ArkUI';
import { HRouter } from 'hrouter';
import { dshrcLink } from '../model/link';
import { DshrcEffortOption, DshrcModelOption, DshrcModelSelection, DshrcQueueItem } from '../model/protocol';
import { SessionDetailParam, goBack, openSessionDetail } from '../model/routes';
import {
  ApprovalCard,
  QuestionCard,
  SessionRow,
  SessionStore,
  SubagentRow,
  TimelineItem,
  sessionStore
} from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  FS_SUBTITLE,
  HAIRLINE,
  RADIUS_CARD,
  RADIUS_CTRL,
  RADIUS_PILL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  SP_6
} from '../model/theme';
import { ApprovalCardView, QuestionCardView } from './AskCards';
import { TimelineView } from './TimelineView';


/** 子代理目录 chip（契约 §5.6 v1.0.5；点击进入子代理详情）。 */
@ComponentV2
struct SubagentChip {
  @Require @Param row: SubagentRow;
  @Event onOpen: (sessionId: string) => void;

  build() {
    Row() {
      if (this.row.running) {
        Circle({ width: 6, height: 6 }).fill($r('app.color.brand_fill'))
      } else {
        Circle({ width: 6, height: 6 }).fill($r('app.color.label_tertiary'))
      }
      Text(this.row.displayName())
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 140 })
        .margin({ left: 5 })
      if (this.row.isOneShot()) {
        Text('一次性')
          .fontSize(10)
          .fontColor($r('app.color.label_secondary'))
          .padding({ left: 6, right: 6, top: 1, bottom: 1 })
          .margin({ left: SP_1 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor($r('app.color.bg_layer_2'))
      }
    }
    .padding({ left: SP_3, right: SP_3, top: SP_1 + 2, bottom: SP_1 + 2 })
    .borderRadius(RADIUS_PILL)
    .backgroundColor($r('app.color.bg_layer_2'))
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onOpen(this.row.sessionId);
    })
  }
}

/** 「接近底部」判定阈值（vp）：距底部不超过该值即视为用户仍在底部（可继续跟随）。 */
const NEAR_BOTTOM_VP: number = 32;

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// @Route({ name: 'session_detail' })
@ComponentV2
export struct SessionDetailPage {
  @Local store: SessionStore = sessionStore;
  @Local sessionId: string = '';
  @Local draft: string = '';
  /** 用户是否仍在底部（自动贴底开关）：上翻历史即暂停，滑回底部即恢复跟随。 */
  @Local followBottom: boolean = true;
  /** 模型选择面板是否展开（V2 bindSheet 用 $$ 双向绑定）。 */
  @Local modelSheetOpen: boolean = false;
  /** 下拉刷新进行中（Refresh !! 双向绑定）。 */
  @Local refreshing: boolean = false;
  /** 面板内选中的模型目录 id。 */
  @Local sheetModelId: string = '';
  /** 面板内选中的思考强度 id（'' = 默认）。 */
  @Local sheetEffortId: string = '';
  /**
   * 发送模式（契约 §5.1 v1.1.1 session.prompt 的 mode）：
   *  - 'queue'（默认）：当前任务结束后执行（agent 空闲时即刻执行）；
   *  - 'steer'：插入正在运行的任务。
   *  仅在 agent 运行时可切换（见 modeChip）。
   */
  @Local sendMode: string = 'queue';
  private scroller: Scroller = new Scroller();
  /** 首次进入是否已完成贴底（timeline 有缓存 / 历史异步到达两种都要滚到底）。 */
  private pendingInitialScroll: boolean = true;
  /** Scroll 视口高度（vp）：onAreaChange 维护，用于判断「接近底部」。 */
  private viewportVp: number = 0;
  /** 是否有一次自动贴底待执行（内容变化后布局未完成时补一次；用户滚动即取消）。 */
  private autoScrollPending: boolean = false;
  /** markdown 渲染控制器（DSH 风格配色，深浅色随系统资源自动适配）。 */
  private mdCtrl: MarkdownController = new MarkdownController();
  /**
   * 思考过程的 markdown 控制器：**独立**于助手气泡。
   * 思考块刻意弱化（FS_SMALL + label_secondary），不能跟正文同色同号——
   * 否则「思考」和「回答」视觉上分不开（用户反馈：颜色和之前版本不一致）。
   */
  private mdCtrlReasoning: MarkdownController = new MarkdownController();

  /**
   * markdown 渲染样式：全部走 app.color 资源（深浅色自动适配），
   * 视觉口径对齐 DSH 自身主题（背景层/描边/标签层级）。
   */
  private setupMarkdownTheme(): void {
    this.applyMarkdownTheme(this.mdCtrl, false);
    this.applyMarkdownTheme(this.mdCtrlReasoning, true);
  }

  /**
   * 把一套 markdown 主题刷到控制器上。
   * @param ctrl 目标控制器
   * @param dim true = 思考块专用（弱化：小号 + secondary 文字色）
   */
  private applyMarkdownTheme(ctrl: MarkdownController, dim: boolean): void {
    try {
      const textColor: Resource = dim ? $r('app.color.label_secondary') : $r('app.color.label_primary');
      const titleColor: Resource = dim ? $r('app.color.label_secondary') : $r('app.color.label_primary');
      const bodySize: number = dim ? FS_SMALL : FS_BODY;
      ctrl
        .setTextColor(textColor)
        .setTitleColor(titleColor)
        .setTextSize(bodySize)
        // setTitleSize 收 6 元组（h1..h6），单值不合法
        .setTitleSize(dim
          ? [FS_SMALL, FS_SMALL, FS_SMALL, FS_SMALL, FS_SMALL, FS_SMALL]
          : [FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE])
        .setTextLineHeight(dim ? 20 : 22)
        .setInlineCodeColor(textColor)
        .setInlineCodeBackgroundColor($r('app.color.bg_layer_2'))
        .setInlineCodeBackgroundRadius(4)
        .setQuoteBackgroundColor($r('app.color.bg_layer_2'))
        .setQuoteTextColor(dim ? $r('app.color.label_tertiary') : $r('app.color.label_secondary'))
        .setQuoteBorderColor($r('app.color.border_l1'))
        .setQuoteBorderRadius(RADIUS_CTRL)
        .setHyperlinkTextColor($r('app.color.brand_label'))
        .setTableBackgroundColor($r('app.color.bg_layer_2'))
        .setTableTitleBackgroundColor($r('app.color.bg_layer_1'))
        .setTableTitleTextColor(titleColor)
        .setTableOuterBorderColor($r('app.color.border_l1'))
        .setTableInnerBorderColor($r('app.color.border_l1'))
        .setTableBorderRadius(RADIUS_CTRL)
        .setLineColor($r('app.color.border_l1'))
        .setFootnoteTextColor(dim ? $r('app.color.label_tertiary') : $r('app.color.label_secondary'))
        .setCodeBlockBorderRadius(RADIUS_CTRL)
        .setTextSelectionEnable(true);
      // 以下两个返回 void（不能链式），单独调用
      ctrl.setTableNormalTextColor(textColor);
      ctrl.setTableInterleaveTextColor(dim ? $r('app.color.label_tertiary') : $r('app.color.label_secondary'));
    } catch (err) {
      // 样式设置失败不影响渲染（库会走默认主题）
    }
  }

  aboutToAppear(): void {
    this.setupMarkdownTheme();
    // 路由参数由 hrouter 传递（routes.openSessionDetail 的 param → 本页 getParams）。
    this.readRouteParams();
    if (this.sessionId.length > 0) {
      this.store.openSession(this.sessionId);
      // 契约 §5.1 v1.0.4：先拉最新一页历史消息（修复打开历史会话空白）
      this.store.loadHistory(this.sessionId, false);
      // 契约 §5.1 v1.0.8：拉会话当前模型 / 思考强度（静默，失败不打扰时间线）
      this.store.loadSessionModel(this.sessionId);
      // 契约 §5.6 v1.0.5：根会话拉子代理目录（详情页子代理入口区数据）
      this.maybeLoadSubagents();
    }
    // onAppear 兜底：万一 aboutToAppear 时 wrapper onReady 尚未回填 contextMap（真机时序差异），
    // 组件上树后再补读一次参数。
    // 返回本页时重开会话（替代原 NavDestination.onShown；页面卸载时自动清理）。
    HRouter.registerLifecycle(this, {
      onAppear: (): void => {
        if (this.sessionId.length === 0) {
          this.readRouteParams();
          if (this.sessionId.length > 0) {
            this.store.openSession(this.sessionId);
            this.store.loadHistory(this.sessionId, false);
            this.store.loadSessionModel(this.sessionId);
          }
        }
      },
      onShown: (): void => {
        if (this.sessionId.length > 0) {
          this.store.openSession(this.sessionId);
          // 重进页面补拉最新一页（store 内按 seq 去重，不会重复显示）
          this.store.loadHistory(this.sessionId, false);
          // 重进页面刷新会话当前模型（桌面端切换后回来即最新）
          this.store.loadSessionModel(this.sessionId);
          this.maybeLoadSubagents();
        }
      }
    });
    // 首次进入贴底：等首屏内容布局完成后再滚到底（timeline 有缓存 / 历史异步到达都走这里兜底）。
    // 用户已主动上翻历史（followBottom=false）时不强制贴底。
    setTimeout((): void => {
      if (!this.followBottom) {
        return;
      }
      this.scrollToBottom();
      if (this.store.timeline.length > 0) {
        this.pendingInitialScroll = false;
      }
    }, 120);
  }

  /** 当前会话是否 subagent（父目录 mode 判断用）。 */
  private isSubagentView(): boolean {
    const row: SessionRow | undefined = this.store.rowOf(this.sessionId);
    return row !== undefined && row.isSubagent();
  }

  /** 根会话时拉子代理目录（subagent 详情页不拉——孙代入口在子代理详情里同样适用，
   *  但当前会话行若也是根…… 简化：只要不是 blank 都拉，目录空则入口区隐藏）。 */
  private maybeLoadSubagents(): void {
    this.store.loadSubagents(this.sessionId);
  }

  /** 当前 subagent 会话的 mode（父目录缓存里查；查不到按 continuable 处理，发送失败有 toast）。 */
  private subagentMode(): string {
    const cached: string = this.store.subagentModeOf(this.sessionId);
    return cached.length > 0 ? cached : 'continuable';
  }

  /** 从 hrouter 路由上下文读取 sessionId（幂等）。 */
  private readRouteParams(): void {
    const params: SessionDetailParam | undefined = HRouter.getParams<SessionDetailParam>(this);
    if (params !== undefined && params.sessionId.length > 0) {
      this.sessionId = params.sessionId;
    }
  }

  /**
   * 用户是否「接近底部」（距底部 ≤ NEAR_BOTTOM_VP 即算仍在底部，可继续跟随）。
   * contentSize / currentOffset 单位都是 vp，可直接相减。
   */
  private nearBottom(): boolean {
    try {
      if (this.scroller.isAtEnd()) {
        return true;
      }
      if (this.viewportVp <= 0) {
        return this.followBottom;
      }
      const size: SizeResult = this.scroller.contentSize();
      const offset: OffsetResult = this.scroller.currentOffset();
      const maxOffset: number = size.height - this.viewportVp;
      return (maxOffset - offset.yOffset) <= NEAR_BOTTOM_VP;
    } catch (e) {
      return this.followBottom;
    }
  }

  /**
   * 用户滚动时更新跟随状态：只有手指拖动 / 滚轮（ScrollState.Scroll）才代表「用户主动离开底部」；
   * 程序化动画滚动（Fling）不动跟随状态，避免自动贴底把自己判成「离开底部」。
   */
  private handleUserScroll(state: ScrollState): void {
    if (state === ScrollState.Scroll) {
      // 用户接管：放弃尚未执行的补贴底，并按当前位置决定是否继续跟随
      this.autoScrollPending = false;
      this.followBottom = this.nearBottom();
    }
  }

  /**
   * 下拉刷新：重拉最新一页历史（wire 幂等，按 sid:seq 去重），完成后收起刷新态。
   * 离线 / 空会话直接收起（Refresh 的转圈不能卡住）。
   */
  private doPullRefresh(): void {
    if (this.sessionId.length === 0 || this.store.linkState !== 'online') {
      this.refreshing = false;
      return;
    }
    this.store.loadHistory(this.sessionId, false).then((): void => {
      this.refreshing = false;
    }).catch((): void => {
      this.refreshing = false;
    });
  }

  /**
   * 贴底：内容变化后布局可能尚未完成，先同步贴一次、再异步补一次（落到真正的新底部）。
   * 用户主动滚动会取消待执行的补贴底（autoScrollPending）。
   */
  private scrollToBottom(): void {
    this.autoScrollPending = true;
    try {
      this.scroller.scrollEdge(Edge.Bottom);
    } catch (e) {
      // scroller 尚未绑定组件（首次 build 前）时忽略
    }
    setTimeout((): void => {
      if (!this.autoScrollPending) {
        return;
      }
      this.autoScrollPending = false;
      this.followBottom = true;
      try {
        this.scroller.scrollEdge(Edge.Bottom);
      } catch (e) {
        // 同上
      }
    }, 100);
  }

  /**
   * 时间线变化 → 贴底策略：
   *  - 加载更早消息（前插）不动用户位置；
   *  - 首次进入（缓存已有内容 / 历史异步到达）强制贴底；
   *  - 其余（新 delta / 新步骤）仅在用户仍在底部时跟随。
   */
  @Monitor('store.timeline')
  onMessagesChanged(mon: IMonitor): void {
    const now: TimelineItem[] | undefined = mon.value<TimelineItem[]>()?.now;
    const before: TimelineItem[] | undefined = mon.value<TimelineItem[]>()?.before;
    if (now === undefined) {
      return;
    }
    // 前插判定：更早的消息插到最前（首条 id 变化）→ 加载更早消息不把用户拽到底
    if (before !== undefined && before.length > 0 && now.length > 0 && now[0].id !== before[0].id) {
      return;
    }
    if (this.pendingInitialScroll) {
      if (now.length > 0) {
        this.pendingInitialScroll = false;
        // 首屏到达 → 强制贴底（用户已主动上翻历史则尊重用户位置）
        if (this.followBottom) {
          this.scrollToBottom();
        }
      }
      return;
    }
    if (this.followBottom) {
      this.scrollToBottom();
    }
  }

  // ---- v1.0.8：模型 / 思考强度（session.model + session.selectModel，契约 §5.1/§5.8）----

  /** 目录中匹配 provider + model 的模型项（不按 id 反拆）。 */
  private findModelOption(provider: string, model: string): DshrcModelOption | undefined {
    const models: DshrcModelOption[] = this.store.models;
    for (let i: number = 0; i < models.length; i++) {
      if (models[i].provider === provider && models[i].model === model) {
        return models[i];
      }
    }
    return undefined;
  }

  /** 目录中按 id 取模型项。 */
  private modelOptionById(id: string): DshrcModelOption | undefined {
    const models: DshrcModelOption[] = this.store.models;
    for (let i: number = 0; i < models.length; i++) {
      if (models[i].id === id) {
        return models[i];
      }
    }
    return undefined;
  }

  /** 目录默认模型项（defaultModelId 命中；未命中 → 第一项；空目录 → undefined）。 */
  private defaultModelOption(): DshrcModelOption | undefined {
    const models: DshrcModelOption[] = this.store.models;
    if (models.length === 0) {
      return undefined;
    }
    for (let i: number = 0; i < models.length; i++) {
      if (models[i].id === this.store.defaultModelId) {
        return models[i];
      }
    }
    return models[0];
  }

  /** 当前会话模型在目录中的对应项（无 → undefined：目录为空或模型不在目录里）。 */
  private currentModelOption(): DshrcModelOption | undefined {
    const sel: DshrcModelSelection | null = this.store.sessionModel;
    if (sel === null) {
      return undefined;
    }
    return this.findModelOption(sel.provider, sel.model);
  }

  /** 胶囊主文案：当前模型短名（未知 → 目录默认名；都没有 → 「模型」）。 */
  private modelCapsuleText(): string {
    const cur: DshrcModelOption | undefined = this.currentModelOption();
    if (cur !== undefined) {
      return cur.name.length > 0 ? cur.name : cur.model;
    }
    const sel: DshrcModelSelection | null = this.store.sessionModel;
    if (sel !== null) {
      // 目录里没有该模型（Host 目录变了）→ provider/model 截断显示
      const ref: string = sel.provider + '/' + sel.model;
      return ref.length > 24 ? ref.substring(0, 24) + '…' : ref;
    }
    const def: DshrcModelOption | undefined = this.defaultModelOption();
    if (def !== undefined) {
      return def.name.length > 0 ? def.name : def.model;
    }
    return '模型';
  }

  /** 胶囊上的思考强度（id）；无 → 空串。 */
  private modelEffortText(): string {
    const sel: DshrcModelSelection | null = this.store.sessionModel;
    if (sel === null || sel.reasoningEffort === undefined) {
      return '';
    }
    return sel.reasoningEffort;
  }

  /** 面板中所选模型的合法思考强度集合（无 → 空数组 = 该模型不支持强度）。 */
  private sheetModelEfforts(): DshrcEffortOption[] {
    const option: DshrcModelOption | undefined = this.modelOptionById(this.sheetModelId);
    if (option === undefined || option.efforts === undefined) {
      return [];
    }
    return option.efforts;
  }

  /** 面板：模型下拉选项（name · provider，区分不同来源的同名模型）。 */
  private sheetModelOptions(): SelectOption[] {
    const out: SelectOption[] = [];
    const models: DshrcModelOption[] = this.store.models;
    for (let i: number = 0; i < models.length; i++) {
      const m: DshrcModelOption = models[i];
      const base: string = m.name.length > 0 ? m.name : m.model;
      out.push({ value: m.provider.length > 0 ? base + ' · ' + m.provider : base });
    }
    return out;
  }

  /** 面板：强度下拉选项（首项「默认」= id 空串）。 */
  private sheetEffortOptions(): SelectOption[] {
    const out: SelectOption[] = [];
    out.push({ value: '默认' });
    const efforts: DshrcEffortOption[] = this.sheetModelEfforts();
    for (let i: number = 0; i < efforts.length; i++) {
      out.push({ value: efforts[i].name });
    }
    return out;
  }

  /** 面板：模型选中下标（未命中 → 第一项；空目录 → -1）。 */
  private sheetModelIndex(): number {
    const models: DshrcModelOption[] = this.store.models;
    for (let i: number = 0; i < models.length; i++) {
      if (models[i].id === this.sheetModelId) {
        return i;
      }
    }
    return models.length > 0 ? 0 : -1;
  }

  /** 面板：强度选中下标（0 = 默认；其余是 efforts 下标 + 1）。 */
  private sheetEffortIndex(): number {
    const efforts: DshrcEffortOption[] = this.sheetModelEfforts();
    if (this.sheetEffortId.length === 0) {
      return 0;
    }
    for (let i: number = 0; i < efforts.length; i++) {
      if (efforts[i].id === this.sheetEffortId) {
        return i + 1;
      }
    }
    return 0;
  }

  /** 面板：模型当前显示文案。 */
  private sheetModelValue(): string {
    const idx: number = this.sheetModelIndex();
    const models: DshrcModelOption[] = this.store.models;
    if (idx < 0 || idx >= models.length) {
      return '模型';
    }
    const m: DshrcModelOption = models[idx];
    const base: string = m.name.length > 0 ? m.name : m.model;
    return m.provider.length > 0 ? base + ' · ' + m.provider : base;
  }

  /** 面板：强度当前显示文案。 */
  private sheetEffortValue(): string {
    const idx: number = this.sheetEffortIndex();
    const efforts: DshrcEffortOption[] = this.sheetModelEfforts();
    if (idx <= 0 || idx - 1 >= efforts.length) {
      return '默认';
    }
    return efforts[idx - 1].name;
  }

  /** 打开面板：初值 = 当前会话模型（未知 → 目录默认）；强度取当前值（不属于所选模型则「默认」）。 */
  private openModelSheet(): void {
    const cur: DshrcModelOption | undefined = this.currentModelOption();
    if (cur !== undefined) {
      this.sheetModelId = cur.id;
    } else {
      const def: DshrcModelOption | undefined = this.defaultModelOption();
      this.sheetModelId = def !== undefined ? def.id : '';
    }
    let effortId: string = '';
    const sel: DshrcModelSelection | null = this.store.sessionModel;
    const efforts: DshrcEffortOption[] = this.sheetModelEfforts();
    if (sel !== null && sel.reasoningEffort !== undefined) {
      for (let i: number = 0; i < efforts.length; i++) {
        if (efforts[i].id === sel.reasoningEffort) {
          effortId = sel.reasoningEffort;
          break;
        }
      }
    }
    this.sheetEffortId = effortId;
    this.modelSheetOpen = true;
  }

  /** 面板：切换模型（换模型后强度重置为「默认」，契约 §5.8 v1.0.8）。 */
  private onSheetModelSelect(index: number): void {
    const models: DshrcModelOption[] = this.store.models;
    if (index < 0 || index >= models.length) {
      return;
    }
    this.sheetModelId = models[index].id;
    this.sheetEffortId = '';
  }

  /** 面板：切换思考强度（index 0 = 默认）。 */
  private onSheetEffortSelect(index: number): void {
    const efforts: DshrcEffortOption[] = this.sheetModelEfforts();
    if (index <= 0) {
      this.sheetEffortId = '';
      return;
    }
    const i: number = index - 1;
    if (i < efforts.length) {
      this.sheetEffortId = efforts[i].id;
    }
  }

  /** 应用：按目录项构造 ModelSelection 调 session.selectModel（成功收面板，失败回主机原文）。 */
  private applySheetModel(): void {
    const option: DshrcModelOption | undefined = this.modelOptionById(this.sheetModelId);
    if (option === undefined) {
      promptAction.showToast({ message: '模型目录不可用', duration: 2000 });
      return;
    }
    const sel: DshrcModelSelection = { provider: option.provider, model: option.model };
    if (this.sheetEffortId.length > 0) {
      sel.reasoningEffort = this.sheetEffortId;
    }
    this.store.applyModelSelection(this.sessionId, sel).then((): void => {
      promptAction.showToast({ message: '已切换模型', duration: 1500 });
      this.modelSheetOpen = false;
    }).catch((e: Error): void => {
      promptAction.showToast({ message: e.message, duration: 2500 });
    });
  }

  /** 输入条上方的「模型 / 思考强度」胶囊（one-shot 只读会话随输入条一起隐藏）。 */
  @Builder
  modelCapsule() {
    Row() {
      Text(this.modelCapsuleText())
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.modelEffortText().length > 0) {
        Text(this.modelEffortText())
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .margin({ left: SP_1 })
      }
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(14)
        .fontColor([$r('app.color.label_tertiary')])
        .width(16)
        .height(14)
        .margin({ left: SP_1 })
    }
    .padding({ left: SP_2, right: SP_2, top: SP_1, bottom: SP_1 })
    .backgroundColor($r('app.color.bg_layer_2'))
    .borderRadius(RADIUS_PILL)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .constraintSize({ maxWidth: '76%' })
    .onClick((): void => {
      this.openModelSheet();
    })
  }

  /** 模型 / 思考强度选择面板（bindSheet 内容）。 */
  @Builder
  modelSheet() {
    Column() {
      Text('模型与思考强度')
        .fontSize(FS_SUBTITLE)
        .fontColor($r('app.color.label_primary'))
        .width('100%')
        .margin({ bottom: SP_3 })

      Text('模型')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
        .width('100%')
        .margin({ bottom: SP_1 })
      Select(this.sheetModelOptions())
        .selected(this.sheetModelIndex())
        .value(this.sheetModelValue())
        .fontColor($r('app.color.label_primary'))
        .selectedOptionFontColor($r('app.color.brand_label'))
        .optionFontColor($r('app.color.label_primary'))
        .menuBackgroundColor($r('app.color.bg_layer_1'))
        .width('100%')
        .onSelect((index: number): void => {
          this.onSheetModelSelect(index);
        })

      // 思考强度：所选模型不支持（无 efforts）→ 整块隐藏
      if (this.sheetModelEfforts().length > 0) {
        Text('思考强度')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .margin({ top: SP_3, bottom: SP_1 })
        Select(this.sheetEffortOptions())
          .selected(this.sheetEffortIndex())
          .value(this.sheetEffortValue())
          .fontColor($r('app.color.label_primary'))
          .selectedOptionFontColor($r('app.color.brand_label'))
          .optionFontColor($r('app.color.label_primary'))
          .menuBackgroundColor($r('app.color.bg_layer_1'))
          .width('100%')
          .onSelect((index: number): void => {
            this.onSheetEffortSelect(index);
          })
      }

      Button('应用')
        .width('100%')
        .height(44)
        .margin({ top: SP_4 })
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_on_brand'))
        .backgroundColor($r('app.color.brand_fill'))
        .borderRadius(RADIUS_CTRL)
        .enabled(this.store.models.length > 0)
        .onClick((): void => {
          this.applySheetModel();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: SP_4, right: SP_4, top: SP_4, bottom: SP_6 })
  }

  // ---- v1.1.1：发送模式（session.prompt 的 mode）+ 待执行消息列表（session.queue）----

  /** agent 是否正在运行（决定是否显示发送模式胶囊）。 */
  private agentRunning(): boolean {
    return this.store.runningOf(this.sessionId);
  }

  /**
   * 待执行消息（宿主 session.queue 事件，契约 §5.2 v1.1.1）。
   * 读 store.queueVersion（@Trace）建立响应式依赖——队列内容存在 store 内部 Map 里，
   * 版本号一变即触发本页重渲染；宿主说「没有待执行消息」→ 空数组（不显示该区）。
   */
  private pendingQueue(): DshrcQueueItem[] {
    const version: number = this.store.queueVersion;
    if (version < 0) {
      return [];
    }
    return this.store.queueItems(this.sessionId);
  }

  /** 模式胶囊旁的一句说明（跟着当前模式走）。 */
  private modeHint(mode: string): string {
    return mode === 'steer' ? '插入正在运行的任务' : '当前任务结束后执行';
  }

  /**
   * 发送模式胶囊（仅 agent 运行时显示）：两段式，点一下即切换。
   * 当前模式 = 品牌填充 + 反白字；未选中 = 中性底 + 次级字（全部走 app.color 资源）。
   */
  @Builder
  modeChip() {
    Row({ space: SP_1 }) {
      Text('排队发送')
        .fontSize(FS_CAPTION)
        .fontColor(this.sendMode === 'queue' ? $r('app.color.label_on_brand') : $r('app.color.label_secondary'))
        .padding({ left: SP_2, right: SP_2, top: SP_1, bottom: SP_1 })
        .borderRadius(RADIUS_PILL)
        .backgroundColor(this.sendMode === 'queue' ? $r('app.color.brand_fill') : $r('app.color.bg_layer_1'))
        .onClick((): void => {
          this.sendMode = 'queue';
        })
      Text('插入当前任务')
        .fontSize(FS_CAPTION)
        .fontColor(this.sendMode === 'steer' ? $r('app.color.label_on_brand') : $r('app.color.label_secondary'))
        .padding({ left: SP_2, right: SP_2, top: SP_1, bottom: SP_1 })
        .borderRadius(RADIUS_PILL)
        .backgroundColor(this.sendMode === 'steer' ? $r('app.color.brand_fill') : $r('app.color.bg_layer_1'))
        .onClick((): void => {
          this.sendMode = 'steer';
        })
    }
    .padding({ left: SP_1, right: SP_1, top: SP_1, bottom: SP_1 })
    .borderRadius(RADIUS_PILL)
    .backgroundColor($r('app.color.bg_layer_2'))
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
  }

  /**
   * 待执行消息列表（宿主 session.queue 事件，契约 §5.2 v1.1.1）：
   * 文本与状态**直接来自宿主**（只做展示，不做猜测）；target='next-step' → 「已插入」，
   * 其余（'next-turn'）→ 「排队中」。空列表时整块不渲染（不留空白占位）。
   */
  @Builder
  pendingQueueBar() {
    Column({ space: SP_1 }) {
      // 标题沿用桌面端文案（dsh-client-ui-conversation：「排队消息」）
      Text('排队消息')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
        .width('100%')
      Repeat(this.pendingQueue())
        .each((cell: RepeatItem<DshrcQueueItem>): void => {
          Row() {
            Text(cell.item.text.length > 0 ? cell.item.text : '（空消息）')
              .fontSize(FS_SMALL)
              .fontColor($r('app.color.label_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
            Text(cell.item.target === 'next-step' ? '已插入' : '排队中')
              .fontSize(FS_CAPTION)
              .fontColor(cell.item.target === 'next-step' ? $r('app.color.brand_label') : $r('app.color.state_warn'))
              .padding({ left: SP_2, right: SP_2, top: 1, bottom: 1 })
              .borderRadius(RADIUS_PILL)
              .backgroundColor(cell.item.target === 'next-step' ? $r('app.color.brand_tint') : $r('app.color.state_warn_tint'))
              .margin({ left: SP_2 })
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
          .padding({ left: SP_3, right: SP_3, top: SP_1 + 2, bottom: SP_1 + 2 })
          .borderRadius(RADIUS_CTRL)
          .backgroundColor($r('app.color.bg_layer_2'))
        })
        .key((it: DshrcQueueItem, index: number): string => {
          return it.itemId.length > 0 ? it.itemId : ('q' + index.toString());
        })
    }
    .width('100%')
    .padding({ left: SP_3, right: SP_3, top: SP_2 })
  }

  /** 发送提示词（乐观上屏；根会话走 session.prompt，subagent 走 session.subagentPrompt §5.1 v1.0.5）。 */
  private send(): void {
    const text: string = this.draft.trim();
    if (text.length === 0 || this.sessionId.length === 0) {
      return;
    }
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在配对页连接中继', duration: 2500 });
      return;
    }
    const row: SessionRow | undefined = this.store.rowOf(this.sessionId);
    const parent: string = row !== undefined ? row.parentSessionId : '';
    // v1.1.1：steer 只在 agent 运行时才有意义（空闲时按 queue 发）。
    const running: boolean = this.agentRunning();
    const steer: boolean = this.sendMode === 'steer' && running;
    this.store.pushLocalUser(this.sessionId, text);
    this.draft = '';
    const sent: Promise<boolean> = parent.length > 0 ?
      dshrcLink.subagentPrompt(parent, this.sessionId, text) :
      dshrcLink.sessionPrompt(this.sessionId, text, steer ? 'steer' : 'queue');
    sent.then((accepted: boolean): void => {
      if (!accepted) {
        promptAction.showToast({ message: '主机未接受该提示词', duration: 2500 });
        return;
      }
      if (parent.length > 0) {
        return; // subagent 没有 queue/steer 之分（契约 §5.1 v1.0.5）
      }
      if (steer) {
        promptAction.showToast({ message: '已插入当前任务', duration: 2000 });
      } else if (running) {
        // 排队模式：明确告诉用户「发出去了，但排在当前任务之后」，别让人以为没发出去
        promptAction.showToast({ message: '已排队，当前任务结束后执行', duration: 2500 });
      } else {
        // 空闲时的 queue 语义 = 立即执行（没有当前任务可排）
        promptAction.showToast({ message: '已发送', duration: 1500 });
      }
    }).catch((e: Error): void => {
      // v1.1.1：宿主拒绝 steer（当前 turn 不再接受插入）时**自动退回 queue**——
      // 桌面端此时是把 steer 动作置灰，手机端不能把用户的消息直接弄丢。
      if (steer && parent.length === 0) {
        promptAction.showToast({ message: '当前任务无法插入，已改为排队发送', duration: 2500 });
        dshrcLink.sessionPrompt(this.sessionId, text, 'queue').then((ok2: boolean): void => {
          if (!ok2) {
            promptAction.showToast({ message: '主机未接受该提示词', duration: 2500 });
          }
        }).catch((e2: Error): void => {
          promptAction.showToast({ message: '发送失败：' + e2.message, duration: 3000 });
        });
        return;
      }
      promptAction.showToast({ message: '发送失败：' + e.message, duration: 3000 });
    });
    // 自己发的消息一定看得到：贴底并恢复跟随（不再受「用户已上翻历史」影响）
    this.followBottom = true;
    this.scrollToBottom();
  }

  /** 取消当前 turn（subagent 走 session.subagentCancel §5.1 v1.0.5）。 */
  private cancelTurn(): void {
    const row: SessionRow | undefined = this.store.rowOf(this.sessionId);
    const parent: string = row !== undefined ? row.parentSessionId : '';
    const cancelled: Promise<boolean> = parent.length > 0 ?
      dshrcLink.subagentCancel(parent, this.sessionId) :
      dshrcLink.sessionCancel(this.sessionId);
    cancelled.then((ok: boolean): void => {
      promptAction.showToast({
        message: ok ? '已请求取消' : '主机未接受取消请求',
        duration: 2000
      });
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '取消失败：' + e.message, duration: 2500 });
    });
  }

  @Builder
  topBar() {
    Row() {
      Button() {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.label_primary'))
      }
      .type(ButtonType.Normal)
      .width(36)
      .height(36)
      .backgroundColor($r('app.color.bg_layer_2'))
      .borderRadius(RADIUS_CTRL)
      .onClick((): void => {
        goBack();
      })
      Column() {
        Text(this.store.titleOf(this.sessionId))
          .fontSize(FS_SUBTITLE)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.label_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text(this.store.hostOnline ? '主机在线 · 会话已就绪' : '主机离线 · 事件将在重连后补发')
          .fontSize(FS_CAPTION)
          .fontColor(this.store.hostOnline ? $r('app.color.state_success') :
            $r('app.color.label_tertiary'))
          .maxLines(1)
          .width('100%')
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: SP_3 })
      .layoutWeight(1)
      if (this.store.runningOf(this.sessionId)) {
        Row() {
          Circle({ width: 6, height: 6 }).fill($r('app.color.brand_fill'))
          Text('运行中')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.brand_label'))
            .margin({ left: 4 })
        }
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .borderRadius(RADIUS_PILL)
        .backgroundColor($r('app.color.brand_tint'))
        .alignItems(VerticalAlign.Center)
      } else {
        Text('空闲')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor($r('app.color.bg_layer_2'))
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  @Builder
  historyBar() {
    // 历史翻页条：加载中 / 「加载更早消息」（hasMore 时显示，向前翻页）
    Column() {
      if (this.store.historyLoading) {
        Row({ space: SP_2 }) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color($r('app.color.label_tertiary'))
          Text(this.store.historyHasMore ? '加载更早消息…' : '正在加载历史消息…')
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_tertiary'))
        }
        .justifyContent(FlexAlign.Center)
        .width('100%')
        .padding({ top: SP_2, bottom: SP_2 })
      } else if (this.store.historyHasMore) {
        Text('加载更早消息')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.brand_label'))
          .padding({ left: SP_4, right: SP_4, top: SP_1 + 2, bottom: SP_1 + 2 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor($r('app.color.bg_layer_2'))
          .onClick((): void => {
            this.store.loadHistory(this.sessionId, true);
          })
      }
    }
    .width('100%')
    .margin({ bottom: SP_1 })
  }

  /** 子代理目录入口区（契约 §5.6 v1.0.5；根会话详情顶部，有子代理才显示）。 */
  @Builder
  subagentBar() {
    Scroll() {
      Row({ space: SP_2 }) {
        Text('子代理')
          .fontSize(FS_SMALL)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_secondary'))
          .alignSelf(ItemAlign.Center)
        Repeat(this.store.activeSubagents)
          .each((cell: RepeatItem<SubagentRow>): void => {
            SubagentChip({
              row: cell.item,
              onOpen: (sid: string): void => {
                openSessionDetail(sid);
              }
            })
          })
          .key((r: SubagentRow): string => r.sessionId)
      }
      .alignItems(VerticalAlign.Center)
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .padding({ left: SP_4, right: SP_4, top: SP_1, bottom: SP_1 })
  }

  @Builder
  emptyState() {
    Column() {
      Text('还没有消息')
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_secondary'))
      Text('在下方输入提示词，回复会以流式气泡呈现')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 48, bottom: 48 })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      if (this.store.activeSubagents.length > 0) {
        this.subagentBar()
      }

      // 下拉刷新（V2 !! 双向绑定）：重拉最新一页历史；Scroll 的贴底/跟随逻辑不受影响
      //（Refresh 只在内容顶到顶时接管下拉手势，向上滚动照常）。
      Refresh({ refreshing: this.refreshing!! }) {
        Scroll(this.scroller) {
          Column() {
            this.historyBar()
            if (this.store.timeline.length === 0) {
              if (!this.store.historyLoading) {
                this.emptyState()
              }
            } else {
              TimelineView({
                items: this.store.timeline,
                mdController: this.mdCtrl,
                mdReasoningController: this.mdCtrlReasoning
              })
            }
          }
          .width('100%')
          .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
        }
        .width('100%')
        .height('100%')
        .scrollBar(BarState.Off)
        .align(Alignment.Top)
        // 滚动位置跟踪：用户手指滚动（Scroll 状态）时更新「是否仍在底部」；
        // 触底（onScrollEdge）与停止滚动（onScrollStop）恢复跟随。
        .onDidScroll((xOffset: number, yOffset: number, state: ScrollState): void => {
          this.handleUserScroll(state);
        })
        .onScrollEdge((side: Edge): void => {
          if (side === Edge.Bottom) {
            this.followBottom = true;
          }
        })
        .onScrollStop((): void => {
          this.followBottom = this.nearBottom();
        })
        // 视口高度（vp）：用于「接近底部」的距离判定
        .onAreaChange((oldArea: Area, newArea: Area): void => {
          const h: Length = newArea.height;
          this.viewportVp = typeof h === 'number' ? h : 0;
        })
      }
      .width('100%')
      .layoutWeight(1)
      .onRefreshing((): void => {
        this.doPullRefresh();
      })

      // 本会话的审批 / 提问卡片（输入条上方；resolved / answered 后消失）
      if (this.store.approvalsFor(this.sessionId).length > 0 ||
        this.store.questionsFor(this.sessionId).length > 0) {
        Scroll() {
          Column() {
            Repeat(this.store.approvalsFor(this.sessionId))
              .each((cell: RepeatItem<ApprovalCard>): void => {
                ApprovalCardView({ card: cell.item, sessionTitle: '' })
              })
              .key((c: ApprovalCard): string => c.askId)
            Repeat(this.store.questionsFor(this.sessionId))
              .each((cell: RepeatItem<QuestionCard>): void => {
                QuestionCardView({ card: cell.item, sessionTitle: '' })
              })
              .key((c: QuestionCard): string => c.askId)
          }
          .width('100%')
          .padding({ left: SP_3, right: SP_3, top: SP_2 })
        }
        .width('100%')
        .constraintSize({ maxHeight: '46%' })
        .scrollBar(BarState.Off)
      }

      // 输入条：one-shot 子代理只读（契约 §5.6：一次性子代理不能发消息），其余正常
      if (this.isSubagentView() && this.subagentMode() === 'one-shot') {
        Row() {
          Text(' ⓘ 一次性子代理 · 仅查看')
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_secondary'))
            .width('100%')
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ left: SP_3, right: SP_3, top: SP_3, bottom: SP_4 })
        .backgroundColor($r('app.color.bg_layer_1'))
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      } else {
        Column() {
          // 待执行消息列表（宿主 session.queue；空 → 整块不渲染，不留空白占位）
          if (this.pendingQueue().length > 0) {
            this.pendingQueueBar()
          }
          // 模型 / 思考强度胶囊（v1.0.8）：在输入框上方一行，点击弹选择面板
          Row() {
            this.modelCapsule()
            Blank()
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
          .padding({ left: SP_3, right: SP_3, top: SP_2, bottom: SP_1 })

          // 发送模式胶囊（v1.1.1）：仅 agent 正在运行时显示（点一下切 queue / steer）
          if (this.agentRunning()) {
            Row() {
              this.modeChip()
              Text(this.modeHint(this.sendMode))
                .fontSize(FS_CAPTION)
                .fontColor($r('app.color.label_tertiary'))
                .margin({ left: SP_2 })
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Blank()
            }
            .width('100%')
            .alignItems(VerticalAlign.Center)
            .padding({ left: SP_3, right: SP_3, bottom: SP_1 })
          }

          Row() {
            TextArea({ text: this.draft, placeholder: '输入提示词，Enter 发送…' })
              .onChange((v: string): void => {
                this.draft = v;
              })
              .layoutWeight(1)
              .height(44)
              .padding({ left: SP_3, right: SP_3, top: 8, bottom: 8 })
              .backgroundColor($r('app.color.bg_layer_2'))
              .borderRadius(RADIUS_CARD)
              .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
              .fontSize(FS_BODY)
              .fontColor($r('app.color.label_primary'))
              .placeholderColor($r('app.color.label_tertiary'))
              .caretColor($r('app.color.brand_fill'))
            if (this.store.runningOf(this.sessionId)) {
              Button('取消')
                .height(44)
                .margin({ left: SP_2 })
                .padding({ left: SP_3, right: SP_3 })
                .fontSize(FS_BODY)
                .fontColor($r('app.color.state_error'))
                .backgroundColor($r('app.color.bg_layer_1'))
                .border({ width: HAIRLINE, color: $r('app.color.state_error') })
                .borderRadius(RADIUS_CTRL)
                .onClick((): void => {
                  this.cancelTurn();
                })
            }
            Button('发送')
              .height(44)
              .margin({ left: SP_2 })
              .padding({ left: SP_4, right: SP_4 })
              .fontSize(FS_BODY)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.label_on_brand'))
              .backgroundColor($r('app.color.brand_fill'))
              .borderRadius(RADIUS_CTRL)
              .enabled(this.draft.trim().length > 0 && this.store.linkState === 'online')
              .onClick((): void => {
                this.send();
              })
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)
          .padding({ left: SP_3, right: SP_3, top: SP_1, bottom: SP_4 })
        }
        .width('100%')
        .backgroundColor($r('app.color.bg_layer_1'))
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
    // v1.0.8：模型 / 思考强度选择面板（bindSheet；用户关闭时 onDisappear 回写开关）
    .bindSheet(this.modelSheetOpen, this.modelSheet(), {
      height: 300,
      showClose: true,
      dragBar: true,
      backgroundColor: $r('app.color.bg_layer_1'),
      onDisappear: (): void => {
        this.modelSheetOpen = false;
      }
    })
  }
}
