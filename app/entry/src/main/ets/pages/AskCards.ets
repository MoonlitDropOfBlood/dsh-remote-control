/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之④的卡片本体：审批卡 + 提问卡（详情页内嵌与审批队列页共用）。
 *  - 审批：工具名 / reason / argsPreview（等宽字体）/ 倒计时进度；允许=品牌蓝，拒绝=描边红
 *  - 提问：单选 Radio、多选 Checkbox、自由文本；answers 按契约 §5.4 组装
 *  - *.resolved 到达后由 store 移除；本地提交成功即先隐藏（fail-open：超时由桌面端兜底）
 */
import { promptAction } from '@kit.ArkUI';
import { DshrcQuestion, DshrcQuestionOption } from '../model/protocol';
import { ApprovalCard, QuestionCard, SessionStore, sessionStore } from '../model/sessionstore';
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
  countdownText
} from '../model/theme';

/** 一个选项的选中态（@ObservedV2，勾选即时刷新）。 */
@ObservedV2
class AskPickItem {
  @Trace label: string = '';
  @Trace on: boolean = false;

  constructor(label: string, on: boolean) {
    this.label = label;
    this.on = on;
  }
}

/** JSON 字符串字面量转义（answers 组装用）。 */
function jsonStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 单个问题的选项块（单选 Radio / 多选 Checkbox）。 */
@ComponentV2
struct AskQuestionBlock {
  @Require @Param q: DshrcQuestion;
  @Require @Param picks: AskPickItem[];
  @Param multi: boolean = false;
  @Param group: string = '';

  build() {
    Column() {
      Row() {
        Text(this.q.question)
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .layoutWeight(1)
        Text(this.multi ? '多选' : '单选')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor($r('app.color.bg_layer_2'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Repeat(this.picks)
        .each((cell: RepeatItem<AskPickItem>): void => {
          Row() {
            if (this.multi) {
              Checkbox({ name: cell.item.label })
                .select(cell.item.on)
                .selectedColor($r('app.color.brand_fill'))
                .onChange((v: boolean): void => {
                  cell.item.on = v;
                })
            } else {
              Radio({ value: cell.item.label, group: this.group })
                .checked(cell.item.on)
                .onChange((isChecked: boolean): void => {
                  if (isChecked) {
                    for (let i: number = 0; i < this.picks.length; i++) {
                      this.picks[i].on = false;
                    }
                    cell.item.on = true;
                  }
                })
            }
            Column() {
              Text(cell.item.label)
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_primary'))
              if (this.optionDesc(cell.item.label).length > 0) {
                Text(this.optionDesc(cell.item.label))
                  .fontSize(FS_CAPTION)
                  .fontColor($r('app.color.label_secondary'))
                  .margin({ top: 2 })
              }
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .margin({ left: SP_2 })
          }
          .width('100%')
          .padding({ top: SP_1, bottom: SP_1 })
          .alignItems(VerticalAlign.Center)
        })
        .key((p: AskPickItem): string => p.label)
    }
    .width('100%')
    .padding({ top: SP_2 })
  }

  /** 由选项 label 反查描述（选项来自契约 §5.4 options；无则空串）。 */
  private optionDesc(label: string): string {
    const opts: DshrcQuestionOption[] = this.q.options !== undefined ? this.q.options : [];
    for (let i: number = 0; i < opts.length; i++) {
      if (opts[i].label === label) {
        const d: string | undefined = opts[i].description;
        return d !== undefined ? d : '';
      }
    }
    return '';
  }
}

/** 共享的倒计时头部（工具名/提问 + 剩余时间 + 细进度条）。 */
@ComponentV2
export struct AskCountdownBar {
  @Param title: string = '';
  @Param remaining: number = 0;
  @Param totalMs: number = 1;

  build() {
    Column() {
      Row() {
        Text(this.title)
          .fontSize(FS_CAPTION)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.remaining > 20000 ? $r('app.color.brand_label') :
            $r('app.color.state_error'))
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor(this.remaining > 20000 ? $r('app.color.brand_tint') :
            $r('app.color.state_error_tint'))
        Blank()
        Text(this.remaining > 0 ? countdownText(this.remaining) : '已超时')
          .fontSize(FS_CAPTION)
          .fontColor(this.remaining > 0 ? $r('app.color.label_secondary') :
            $r('app.color.state_error'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      Progress({
        value: this.remaining > 0 ? this.remaining : 0,
        total: this.totalMs > 0 ? this.totalMs : 1,
        type: ProgressType.Linear
      })
        .width('100%')
        .height(4)
        .margin({ top: SP_2 })
        .borderRadius(2)
        .backgroundColor($r('app.color.bg_layer_2'))
        .color(this.remaining > 20000 ? $r('app.color.brand_fill') : $r('app.color.state_error'))
    }
    .width('100%')
  }
}

/** 审批卡：允许（品牌蓝）/ 拒绝（描边红）。 */
@ComponentV2
export struct ApprovalCardView {
  @Require @Param card: ApprovalCard;
  /** 详情页传空；审批队列页传会话标题（显示会话胶囊）。 */
  @Param sessionTitle: string = '';
  @Local store: SessionStore = sessionStore;
  @Local remaining: number = 0;
  private timerId: number = -1;

  aboutToAppear(): void {
    this.remaining = this.card.deadline - Date.now();
    this.tick();
    this.timerId = setInterval((): void => {
      this.tick();
    }, 1000);
  }

  aboutToDisappear(): void {
    this.clearTimer();
  }

  private tick(): void {
    this.remaining = this.card.deadline - Date.now();
    if (this.remaining <= 0) {
      this.clearTimer();
    }
  }

  private clearTimer(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
  }

  /** 允许 / 拒绝（契约 §5.1 approval.answer）。 */
  private answer(decision: string): void {
    this.store.submitApproval(this.card.askId, decision, '').then((applied: boolean): void => {
      promptAction.showToast({
        message: applied ? (decision === 'approved' ? '已允许' : '已拒绝') : '已超时，桌面端已处理',
        duration: 2000
      });
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '提交失败：' + e.message, duration: 2500 });
    });
  }

  build() {
    Column() {
      AskCountdownBar({
        title: '工具审批',
        remaining: this.remaining,
        totalMs: this.card.timeoutMs > 0 ? this.card.timeoutMs : 1
      })

      if (this.sessionTitle.length > 0) {
        Text(this.sessionTitle)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .margin({ top: SP_2 })
      }

      Text(this.card.toolName.length > 0 ? this.card.toolName : '（未命名工具）')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontFamily('monospace')
        .fontColor($r('app.color.label_primary'))
        .width('100%')
        .margin({ top: SP_3 })

      if (this.card.reason.length > 0) {
        Text(this.card.reason)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .margin({ top: SP_1 })
      }

      if (this.card.argsPreview.length > 0) {
        Text(this.card.argsPreview)
          .fontSize(FS_CAPTION)
          .fontFamily('monospace')
          .fontColor($r('app.color.label_primary'))
          .width('100%')
          .maxLines(6)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .padding({ left: SP_2, right: SP_2, top: SP_2, bottom: SP_2 })
          .margin({ top: SP_2 })
          .backgroundColor($r('app.color.bg_layer_2'))
          .borderRadius(RADIUS_CTRL)
      }

      Row() {
        Button('允许')
          .layoutWeight(1)
          .height(42)
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_on_brand'))
          .backgroundColor($r('app.color.brand_fill'))
          .borderRadius(RADIUS_CTRL)
          .enabled(this.remaining > 0 && !this.card.answered)
          .onClick((): void => {
            this.answer('approved');
          })
        Button('拒绝')
          .layoutWeight(1)
          .height(42)
          .margin({ left: SP_3 })
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.state_error'))
          .backgroundColor($r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.state_error') })
          .borderRadius(RADIUS_CTRL)
          .enabled(this.remaining > 0 && !this.card.answered)
          .onClick((): void => {
            this.answer('rejected');
          })
      }
      .width('100%')
      .margin({ top: SP_4 })
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
    .margin({ bottom: SP_3 })
  }
}

/** 提问卡：单选 / 多选 / 自由文本，按契约 §5.4 组装 answers。 */
@ComponentV2
export struct QuestionCardView {
  @Require @Param card: QuestionCard;
  @Param sessionTitle: string = '';
  @Local store: SessionStore = sessionStore;
  @Local picksByQ: AskPickItem[][] = [];
  @Local freeText: string = '';
  @Local remaining: number = 0;
  private timerId: number = -1;

  aboutToAppear(): void {
    this.initPicks();
    this.remaining = this.card.deadline - Date.now();
    this.tick();
    this.timerId = setInterval((): void => {
      this.tick();
    }, 1000);
  }

  aboutToDisappear(): void {
    this.clearTimer();
  }

  private tick(): void {
    this.remaining = this.card.deadline - Date.now();
    if (this.remaining <= 0) {
      this.clearTimer();
    }
  }

  private clearTimer(): void {
    if (this.timerId >= 0) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
  }

  /** 按 questions 初始化每个问题的选项选中态。 */
  private initPicks(): void {
    const byQ: AskPickItem[][] = [];
    for (let i: number = 0; i < this.card.questions.length; i++) {
      const q: DshrcQuestion = this.card.questions[i];
      const opts: DshrcQuestionOption[] = q.options !== undefined ? q.options : [];
      const items: AskPickItem[] = [];
      for (let j: number = 0; j < opts.length; j++) {
        items.push(new AskPickItem(opts[j].label, false));
      }
      byQ.push(items);
    }
    this.picksByQ = byQ;
  }

  /** 单选/多选：问题自身 multiSelect 优先，否则用卡片级默认（契约 §5.4）。 */
  private isMulti(q: DshrcQuestion): boolean {
    return q.multiSelect !== undefined ? q.multiSelect : this.card.multiSelect;
  }

  /** 组装 answers JSON（单选 → 标签串；多选 → 标签数组），契约 §5.4。 */
  private buildAnswers(): Object {
    const parts: string[] = [];
    for (let i: number = 0; i < this.card.questions.length; i++) {
      const q: DshrcQuestion = this.card.questions[i];
      const picks: AskPickItem[] = i < this.picksByQ.length ? this.picksByQ[i] : [];
      const chosen: string[] = [];
      for (let j: number = 0; j < picks.length; j++) {
        if (picks[j].on) {
          chosen.push(picks[j].label);
        }
      }
      if (chosen.length === 0) {
        continue;
      }
      if (chosen.length === 1 && !this.isMulti(q)) {
        parts.push(jsonStr(q.id) + ':' + jsonStr(chosen[0]));
      } else {
        const arr: string[] = [];
        for (let k: number = 0; k < chosen.length; k++) {
          arr.push(jsonStr(chosen[k]));
        }
        parts.push(jsonStr(q.id) + ':[' + arr.join(',') + ']');
      }
    }
    const json: string = '{' + parts.join(',') + '}';
    return JSON.parse(json) as Object;
  }

  private hasSelection(): boolean {
    for (let i: number = 0; i < this.picksByQ.length; i++) {
      const picks: AskPickItem[] = this.picksByQ[i];
      for (let j: number = 0; j < picks.length; j++) {
        if (picks[j].on) {
          return true;
        }
      }
    }
    return false;
  }

  /** 提交回答（契约 §5.1 question.answer）。 */
  private submit(): void {
    const text: string = this.freeText.trim();
    if (!this.hasSelection() && text.length === 0) {
      promptAction.showToast({ message: '请先选择选项或填写回答', duration: 2000 });
      return;
    }
    const answers: Object = this.buildAnswers();
    this.store.submitQuestion(this.card.askId, answers, text).then((applied: boolean): void => {
      promptAction.showToast({
        message: applied ? '已提交回答' : '已超时，桌面端已处理',
        duration: 2000
      });
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '提交失败：' + e.message, duration: 2500 });
    });
  }

  build() {
    Column() {
      AskCountdownBar({
        title: '向你提问',
        remaining: this.remaining,
        totalMs: this.card.timeoutMs > 0 ? this.card.timeoutMs : 1
      })

      if (this.sessionTitle.length > 0) {
        Text(this.sessionTitle)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .margin({ top: SP_2 })
      }

      Repeat(this.card.questions)
        .each((cell: RepeatItem<DshrcQuestion>): void => {
          Column() {
            AskQuestionBlock({
              q: cell.item,
              picks: cell.index < this.picksByQ.length ? this.picksByQ[cell.index] : [],
              multi: this.isMulti(cell.item),
              group: this.card.askId + '#' + cell.item.id
            })
            Divider().color($r('app.color.border_l1'))
          }
          .width('100%')
          .margin({ top: SP_3 })
        })
        .key((q: DshrcQuestion): string => q.id)

      Text('自由文本回答（可选）')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_secondary'))
        .width('100%')
        .margin({ top: SP_3 })
      TextArea({ text: this.freeText, placeholder: '补充说明、澄清或直接作答…' })
        .onChange((v: string): void => {
          this.freeText = v;
        })
        .width('100%')
        .height(64)
        .margin({ top: SP_1 })
        .padding({ left: SP_2, right: SP_2, top: SP_2, bottom: SP_2 })
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_primary'))
        .placeholderColor($r('app.color.label_tertiary'))
        .caretColor($r('app.color.brand_fill'))

      Button('提交回答')
        .width('100%')
        .height(42)
        .margin({ top: SP_3 })
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_on_brand'))
        .backgroundColor($r('app.color.brand_fill'))
        .borderRadius(RADIUS_CTRL)
        .enabled(this.remaining > 0 && !this.card.answered)
        .onClick((): void => {
          this.submit();
        })
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
    .margin({ bottom: SP_3 })
  }
}
