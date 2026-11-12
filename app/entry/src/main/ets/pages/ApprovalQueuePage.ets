/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之④：审批 / 提问队列页（NavDestination）。
 *  - 列出全部会话的待答审批与提问（卡片本体复用 AskCards），带倒计时
 *  - 入口：列表页顶部横幅、「待处理 n」按钮、推送点击直达（askId，契约 §6）
 *  - approval.resolved / question.resolved 到达即从队列消失
 */
import {
  FS_CAPTION,
  FS_SMALL,
  FS_SUBTITLE,
  RADIUS_CARD,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4
} from '../model/theme';
import { ApprovalCard, QuestionCard, SessionStore, sessionStore } from '../model/sessionstore';
import { EVT_SESSION_STATE_CHANGED } from '../model/events';
import { EventPost } from 'eventpost';
import { goBack } from '../model/routes';
import { ApprovalRepeatCard, QuestionRepeatCard } from './AskCards';

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// @Route({ name: 'approval_queue' })
@ComponentV2
export struct ApprovalQueuePage {
  @Local store: SessionStore = sessionStore;
  /**
   * v1.3.1：待答卡片列表快照。
   * store 里的卡片数组存在 Map/@Trace 数组里，页面**经 helper 方法读不会建立渲染依赖**
   * （真机症状：新提问卡不出现、答完的卡不消失）→ 改由 store 广播
   * EVT_SESSION_STATE_CHANGED，页面把列表搬进自己的 @Local。
   */
  @Local approvalsSnap: ApprovalCard[] = [];
  @Local questionsSnap: QuestionCard[] = [];

  aboutToAppear(): void {
    EventPost.getDefault().onFromComponent(EVT_SESSION_STATE_CHANGED, this, (): void => {
      this.syncQueue();
    });
    this.syncQueue();
  }

  /** 把 store 的待答列表搬进本页 @Local。 */
  private syncQueue(): void {
    this.approvalsSnap = this.store.pendingApprovals();
    this.questionsSnap = this.store.pendingQuestions();
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
      Text('审批 / 提问')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .margin({ left: SP_3 })
        .layoutWeight(1)
      Text('待处理 ' + (this.approvalsSnap.length + this.questionsSnap.length).toString())
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.state_warn'))
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .borderRadius(RADIUS_CARD)
        .backgroundColor($r('app.color.state_warn_tint'))
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  @Builder
  emptyState() {
    Column() {
      Text('✓')
        .fontSize(40)
        .fontColor($r('app.color.state_success'))
      Text('没有待处理的审批 / 提问')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_secondary'))
        .margin({ top: SP_2 })
      Text('agent 请求审批或向你提问时，卡片会自动出现在这里')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 60, bottom: 60 })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      Scroll() {
        Column() {
          if (this.approvalsSnap.length === 0 && this.questionsSnap.length === 0) {
            this.emptyState()
          }
          Repeat(this.approvalsSnap)
            .each((cell: RepeatItem<ApprovalCard>): void => {
              ApprovalRepeatCard({
                cell: cell,
                sessionTitle: this.store.titleOf(cell.item.sessionId)
              })
            })
            .key((c: ApprovalCard): string => c.askId)
          Repeat(this.questionsSnap)
            .each((cell: RepeatItem<QuestionCard>): void => {
              QuestionRepeatCard({
                cell: cell,
                sessionTitle: this.store.titleOf(cell.item.sessionId)
              })
            })
            .key((c: QuestionCard): string => c.askId)
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_4 })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
