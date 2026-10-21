/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之③：会话详情页（NavDestination，param = SessionDetailParam）。
 *  - 消息气泡流：用户右对齐品牌蓝 / assistant 左对齐浅面卡片；代码片段等宽字体
 *  - assistant.delta 流式追加到当前气泡（带光标），turn.end 定稿
 *  - 底部输入条 + 发送；running 时显示「取消」；顶部标题栏 + 运行状态徽标
 *  - 本会话的审批 / 提问卡片内嵌在输入条上方（AskCards），resolved 后自动消失
 */
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

/** 单条消息气泡（含代码分段渲染）。 */
@ComponentV2
struct MessageBubble {
  @Require @Param item: ChatItem;

  /**
   * 按 ``` 围栏切段：偶数段=正文，奇数段=代码（等宽字体 + bg_layer_2 底）。
   * build 中经方法读取 item.text（@Trace），增量到达自动重建分段。
   */
  private segsOf(): string[] {
    const t: string = this.item.text;
    if (t.indexOf('```') < 0) {
      return [t];
    }
    return t.split('```');
  }

  @Builder
  segView(seg: string, idx: number) {
    if (idx % 2 === 1) {
      Text(seg)
        .fontFamily('monospace')
        .fontSize(13)
        .fontColor($r('app.color.label_primary'))
                .width('100%')
        .padding({ left: SP_2, right: SP_2, top: SP_2, bottom: SP_2 })
        .margin({ top: SP_1, bottom: SP_1 })
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
    } else {
      Text(seg)
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
                .width('100%')
    }
  }

  build() {
    Column() {
      if (this.item.role === 'user') {
        // 用户：右对齐品牌蓝气泡 + 白字
        Row() {
          Column() {
            Text(this.item.text)
              .fontSize(FS_BODY)
              .fontColor($r('app.color.label_on_brand'))
                            .width('100%')
          }
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .backgroundColor($r('app.color.brand_fill'))
          .borderRadius(RADIUS_BUBBLE)
          .constraintSize({ maxWidth: '82%' })
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
        .margin({ top: SP_1, bottom: SP_1 })
      } else {
        // 助手：左对齐浅面卡片，代码片段等宽
        Row() {
          Column() {
            Repeat(this.segsOf())
              .each((cell: RepeatItem<string>): void => {
                this.segView(cell.item, cell.index)
              })
              .key((s: string, i: number): string => i.toString() + '-' + s.length.toString())
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
          .padding({ left: 12, right: 12, top: 10, bottom: 10 })
          .backgroundColor($r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          .borderRadius(RADIUS_BUBBLE)
          .constraintSize({ maxWidth: '86%' })
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

  aboutToAppear(): void {
    // 路由参数由 hrouter 传递（routes.openSessionDetail 的 param → 本页 getParams）。
    this.readRouteParams();
    if (this.sessionId.length > 0) {
      this.store.openSession(this.sessionId);
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
          }
        }
      },
      onShown: (): void => {
        if (this.sessionId.length > 0) {
          this.store.openSession(this.sessionId);
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

  /** 新气泡或流式增长时贴底滚动。 */
  @Monitor('store.messages')
  onMessagesChanged(mon: IMonitor): void {
    const now: ChatItem[] | undefined = mon.value<ChatItem[]>()?.now;
    const before: ChatItem[] | undefined = mon.value<ChatItem[]>()?.before;
    if (now === undefined) {
      return;
    }
    const grown: boolean = before === undefined || now.length > before.length;
    const streaming: boolean = now.length > 0 && now[now.length - 1].streaming;
    if (grown || streaming) {
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
          if (this.store.messages.length === 0) {
            this.emptyState()
          } else {
            Repeat(this.store.messages)
              .each((cell: RepeatItem<ChatItem>): void => {
                MessageBubble({ item: cell.item })
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
