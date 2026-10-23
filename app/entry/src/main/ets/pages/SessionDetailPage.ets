/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之③：会话详情页（NavDestination，param = SessionDetailParam）。
 *  - 消息气泡流：用户右对齐品牌蓝 / assistant 左对齐浅面卡片；代码片段等宽字体
 *  - assistant.delta 流式追加到当前气泡（带光标），turn.end 定稿
 *  - 底部输入条 + 发送；running 时显示「取消」；顶部标题栏 + 运行状态徽标
 *  - 本会话的审批 / 提问卡片内嵌在输入条上方（AskCards），resolved 后自动消失
 */
import { Markdown, MarkdownController } from '@luvi/lv-markdown-in';
import { promptAction } from '@kit.ArkUI';
import { HRouter } from 'hrouter';
import { dshrcLink } from '../model/link';
import { SessionDetailParam, goBack } from '../model/routes';
import {
  ApprovalCard,
  ChatItem,
  QuestionCard,
  SessionStore,
  sessionStore
} from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  FS_SUBTITLE,
  HAIRLINE,
  RADIUS_BUBBLE,
  RADIUS_CARD,
  RADIUS_CTRL,
  RADIUS_PILL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  clockTime
} from '../model/theme';
import { ApprovalCardView, QuestionCardView } from './AskCards';


/** 单条消息气泡（agent 消息用 lv-markdown-in 渲染 markdown）。 */
@ComponentV2
struct MessageBubble {
  @Require @Param item: ChatItem;
  /** 共享的 markdown 渲染控制器（DSH 风格配色，页面级创建后下传）。 */
  @Require @Param mdController: MarkdownController;

  build() {
    Column() {
      if (this.item.role === 'user') {
        // 用户：右对齐品牌蓝气泡。Text 自身即气泡（padding/bg 挂 Text），
        // constraintSize 的百分比解析自外层 Row（定宽）——绝不把 width('100%')
        // 塞进自适应 Column（循环百分比 → 不换行 → 文字甩出气泡，真机实测 bug）。
        Row() {
          Text(this.item.text)
            .fontSize(FS_BODY)
            .fontColor($r('app.color.label_on_brand'))
            .padding({ left: 12, right: 12, top: 10, bottom: 10 })
            .backgroundColor($r('app.color.brand_fill'))
            .borderRadius(RADIUS_BUBBLE)
            .constraintSize({ maxWidth: '82%' })
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
        .margin({ top: SP_1, bottom: SP_1 })
      } else {
        // 助手：左对齐浅面卡片 + lv-markdown-in 渲染（标题/列表/表格/代码块/行内代码/
        // 引用/分割线全支持；text 随流式增量更新，库侧 @Prop 响应）。
        Row() {
          Column() {
            Markdown({
              text: this.item.text,
              controller: this.mdController
            })
              .width('100%')
            if (this.item.streaming) {
              Text('▍')
                .fontSize(FS_BODY)
                .fontColor($r('app.color.brand_fill'))
                .margin({ top: 2 })
            }
            if (this.item.errorText.length > 0) {
              Text(this.item.errorText)
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.state_error'))
                .margin({ top: SP_1 })
            }
          }
          .width('82%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .backgroundColor($r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          .borderRadius(RADIUS_BUBBLE)
        }
        .width('100%')
        .justifyContent(FlexAlign.Start)
        .margin({ top: SP_1, bottom: SP_1 })
      }

      Row() {
        if (this.item.role === 'user') {
          Blank()
          Text(clockTime(this.item.ts))
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
        } else {
          Text(clockTime(this.item.ts))
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
          Blank()
        }
      }
      .width('100%')
      .padding({ left: 2, right: 2 })
      .margin({ top: 2 })
    }
    .width('100%')
    .margin({ bottom: SP_1 })
  }
}

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// @Route({ name: 'session_detail' })
@ComponentV2
export struct SessionDetailPage {
  @Local store: SessionStore = sessionStore;
  @Local sessionId: string = '';
  @Local draft: string = '';
  private scroller: Scroller = new Scroller();
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
        }
      }
    });
  }

  /** 从 hrouter 路由上下文读取 sessionId（幂等）。 */
  private readRouteParams(): void {
    const params: SessionDetailParam | undefined = HRouter.getParams<SessionDetailParam>(this);
    if (params !== undefined && params.sessionId.length > 0) {
      this.sessionId = params.sessionId;
    }
  }

  /** 新气泡或流式增长时贴底滚动；顶部加载更早消息（prepend）不打断阅读位置。 */
  @Monitor('store.messages')
  onMessagesChanged(mon: IMonitor): void {
    const now: ChatItem[] | undefined = mon.value<ChatItem[]>()?.now;
    const before: ChatItem[] | undefined = mon.value<ChatItem[]>()?.before;
    if (now === undefined) {
      return;
    }
    const lastNow: ChatItem | undefined = now.length > 0 ? now[now.length - 1] : undefined;
    const lastBefore: ChatItem | undefined =
      before !== undefined && before.length > 0 ? before[before.length - 1] : undefined;
    const tailChanged: boolean = lastNow !== undefined &&
      (lastBefore === undefined || lastBefore.id !== lastNow.id);
    const streaming: boolean = lastNow !== undefined && lastNow.streaming;
    if ((tailChanged && (before === undefined || now.length > before.length)) || streaming) {
      this.scroller.scrollEdge(Edge.Bottom);
    }
  }

  /** 发送提示词（乐观上屏 + session.prompt）。 */
  private send(): void {
    const text: string = this.draft.trim();
    if (text.length === 0 || this.sessionId.length === 0) {
      return;
    }
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在配对页连接中继', duration: 2500 });
      return;
    }
    this.store.pushLocalUser(this.sessionId, text);
    this.draft = '';
    dshrcLink.sessionPrompt(this.sessionId, text).then((accepted: boolean): void => {
      if (!accepted) {
        promptAction.showToast({ message: '主机未接受该提示词', duration: 2500 });
      }
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '发送失败：' + e.message, duration: 3000 });
    });
    this.scroller.scrollEdge(Edge.Bottom);
  }

  /** 取消当前 turn。 */
  private cancelTurn(): void {
    dshrcLink.sessionCancel(this.sessionId).then((cancelled: boolean): void => {
      promptAction.showToast({
        message: cancelled ? '已请求取消' : '主机未接受取消请求',
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

      Scroll(this.scroller) {
        Column() {
          this.historyBar()
          if (this.store.messages.length === 0) {
            if (!this.store.historyLoading) {
              this.emptyState()
            }
          } else {
            Repeat(this.store.messages)
              .each((cell: RepeatItem<ChatItem>): void => {
                MessageBubble({ item: cell.item, mdController: this.mdCtrl })
              })
              .key((m: ChatItem): string => m.id)
          }
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)

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

      // 输入条
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
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
  }
}
