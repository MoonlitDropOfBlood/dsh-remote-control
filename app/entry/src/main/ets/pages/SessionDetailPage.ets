/*
 * Copyright (c) 2026 dukedsh.
 * 会话详情页（NavDestination，param = SessionDetailParam）。
 *  - 统一时间线：store.timeline 按 kind 分派（消息气泡 / 工作步骤卡 / 系统说明行）→ TimelineView
 *  - assistant.delta 流式追加到当前气泡（带光标），turn.end 定稿
 *  - 底部输入条 + 发送；running 时显示「取消」；顶部标题栏 + 运行状态徽标
 *  - 本会话的审批 / 提问卡片内嵌在输入条上方（AskCards），resolved 后自动消失
 */
import { MarkdownController } from '@luvi/lv-markdown-in';
import { promptAction } from '@kit.ArkUI';
import { HRouter } from 'hrouter';
import { dshrcLink } from '../model/link';
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
  SP_4
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
   * markdown 渲染样式：全部走 app.color 资源（深浅色自动适配），
   * 视觉口径对齐 DSH 自身主题（背景层/描边/标签层级）。
   */
  private setupMarkdownTheme(): void {
    try {
      this.mdCtrl
        .setTextColor($r('app.color.label_primary'))
        .setTitleColor($r('app.color.label_primary'))
        .setTextSize(FS_BODY)
        // setTitleSize 收 6 元组（h1..h6），单值不合法
        .setTitleSize([FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE, FS_SUBTITLE])
        .setTextLineHeight(22)
        .setInlineCodeColor($r('app.color.label_primary'))
        .setInlineCodeBackgroundColor($r('app.color.bg_layer_2'))
        .setInlineCodeBackgroundRadius(4)
        .setQuoteBackgroundColor($r('app.color.bg_layer_2'))
        .setQuoteTextColor($r('app.color.label_secondary'))
        .setQuoteBorderColor($r('app.color.border_l1'))
        .setQuoteBorderRadius(RADIUS_CTRL)
        .setHyperlinkTextColor($r('app.color.brand_label'))
        .setTableBackgroundColor($r('app.color.bg_layer_2'))
        .setTableTitleBackgroundColor($r('app.color.bg_layer_1'))
        .setTableTitleTextColor($r('app.color.label_primary'))
        .setTableOuterBorderColor($r('app.color.border_l1'))
        .setTableInnerBorderColor($r('app.color.border_l1'))
        .setTableBorderRadius(RADIUS_CTRL)
        .setLineColor($r('app.color.border_l1'))
        .setFootnoteTextColor($r('app.color.label_secondary'))
        .setCodeBlockBorderRadius(RADIUS_CTRL)
        .setTextSelectionEnable(true);
      // 以下两个返回 void（不能链式），单独调用
      this.mdCtrl.setTableNormalTextColor($r('app.color.label_primary'));
      this.mdCtrl.setTableInterleaveTextColor($r('app.color.label_secondary'));
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
          }
        }
      },
      onShown: (): void => {
        if (this.sessionId.length > 0) {
          this.store.openSession(this.sessionId);
          // 重进页面补拉最新一页（store 内按 seq 去重，不会重复显示）
          this.store.loadHistory(this.sessionId, false);
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
    this.store.pushLocalUser(this.sessionId, text);
    this.draft = '';
    const sent: Promise<boolean> = parent.length > 0 ?
      dshrcLink.subagentPrompt(parent, this.sessionId, text) :
      dshrcLink.sessionPrompt(this.sessionId, text);
    sent.then((accepted: boolean): void => {
      if (!accepted) {
        promptAction.showToast({ message: '主机未接受该提示词', duration: 2500 });
      }
    }).catch((e: Error): void => {
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
              mdController: this.mdCtrl
            })
          }
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
      }
      .width('100%')
      .layoutWeight(1)
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
      .padding({ left: SP_3, right: SP_3, top: SP_3, bottom: SP_4 })
      .backgroundColor($r('app.color.bg_layer_1'))
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
  }
}
