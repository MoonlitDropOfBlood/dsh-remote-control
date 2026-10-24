/*
 * Copyright (c) 2026 dukedsh.
 * 统一时间线渲染（契约 §5.7 v1.0.6）：详情页消息流按 kind 分派，全部来自 store.timeline。
 *  - message：用户右对齐品牌蓝气泡；助手左对齐浅面卡片 + @luvi/lv-markdown-in（流式光标 / 错误提示）
 *  - step：连续的工作步骤归为一个「工作步骤 · N」分组，组头可整体折叠/展开
 *  - system：系统 / 开发者说明行（细分隔 + 说明文字；超过 2 行折叠，可点击展开全文）
 */
import { Markdown, MarkdownController } from '@luvi/lv-markdown-in';
import { TimelineItem } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  HAIRLINE,
  RADIUS_BUBBLE,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  clockTime
} from '../model/theme';
import { StepCard } from './StepCard';

/** 系统说明行：字符数超过该阈值视为可能超过 2 行（折叠 + 可展开）。 */
const SYSTEM_FOLD_CHARS: number = 80;

/** 时间线条目：单条消息 / 系统行，或一组连续的工作步骤。 */
interface TimelineEntry {
  /** Repeat 的稳定 key（分组用首步 id 前缀）。 */
  key: string;
  /** 是否工作步骤分组。 */
  isGroup: boolean;
  /** 单项渲染时=该条目；分组渲染时=组内首个步骤。 */
  head: TimelineItem;
  /** 分组内的工作步骤（非分组为空数组）。 */
  steps: TimelineItem[];
}

/** 连续的工作步骤归为一个分组；其余条目按单项渲染。 */
function groupTimeline(items: TimelineItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let i: number = 0;
  while (i < items.length) {
    const it: TimelineItem = items[i];
    if (it.isStep()) {
      const steps: TimelineItem[] = [];
      while (i < items.length && items[i].isStep()) {
        steps.push(items[i]);
        i = i + 1;
      }
      const head: TimelineItem = steps[0];
      out.push({ key: 'g:' + head.id, isGroup: true, head: head, steps: steps });
    } else {
      out.push({ key: it.id, isGroup: false, head: it, steps: [] });
      i = i + 1;
    }
  }
  return out;
}

/** 对话气泡：用户右对齐品牌蓝 / 助手左对齐浅面卡片（markdown 渲染）。 */
@ComponentV2
struct MessageBubble {
  @Require @Param item: TimelineItem;
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
        // 引用/分割线全支持；text 随流式增量更新，库侧自带响应）。
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

/** 系统 / 开发者说明行：细分隔 + 说明文字；超 2 行折叠，点击展开全文。 */
@ComponentV2
struct SystemNote {
  @Require @Param item: TimelineItem;
  @Local expanded: boolean = false;

  /** 文本是否可能超过 2 行（超出则折叠 + 提供展开）。 */
  private longText(): boolean {
    return this.item.text.length > SYSTEM_FOLD_CHARS;
  }

  /** 来源标签（system / developer）。 */
  private roleLabel(): string {
    return this.item.role === 'developer' ? '开发者' : '系统';
  }

  build() {
    Column() {
      Divider()
        .color($r('app.color.border_l1'))
        .margin({ bottom: SP_1 })
      Row() {
        Text(this.roleLabel())
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .margin({ right: SP_2 })
        Text(this.item.text)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .layoutWeight(1)
          .maxLines(this.expanded ? 500 : 2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .onClick((): void => {
            if (this.longText()) {
              this.expanded = !this.expanded;
            }
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    }
    .width('100%')
    .margin({ top: SP_1, bottom: SP_1 })
  }
}

/**
 * 「工作步骤 · N」分组：组头点击整体折叠/展开。
 * 折叠时组内步骤卡保持挂载（仅不可见），子项各自的展开状态不会丢失。
 */
@ComponentV2
struct StepGroup {
  @Require @Param steps: TimelineItem[];
  /** 整组默认收起（用户点组头才展开组内步骤）；折叠时子卡保持挂载，展开状态不丢。 */
  @Local open: boolean = false;

  build() {
    Column() {
      Row() {
        Text('工作步骤 · ' + this.steps.length.toString())
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
        Blank()
        // 固定尺寸符号（不依赖字体行高，收起/展开两态盒子完全一致）
        SymbolGlyph(this.open ? $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([$r('app.color.label_tertiary')])
          .width(18)
          .height(16)
      }
      .width('100%')
      .padding({ left: SP_1, right: SP_1, top: SP_1, bottom: SP_1 })
      .margin({ bottom: SP_1 })
      .onClick((): void => {
        this.open = !this.open;
      })

      Column() {
        Repeat(this.steps)
          .each((cell: RepeatItem<TimelineItem>): void => {
            StepCard({ item: cell.item })
          })
          .key((s: TimelineItem): string => s.id)
      }
      .width('100%')
      .visibility(this.open ? Visibility.Visible : Visibility.None)
    }
    .width('100%')
  }
}

/**
 * 「思考过程」折叠块（kind="reasoning"）：lightbulb 图标 + 标题 + 固定尺寸 chevron。
 * 默认收起，点标题行展开/收起；正文用 item.text（FS_SMALL + label_secondary），
 * 左缩进 + padding，刻意弱化——既不是等宽代码块，也不是助手气泡。
 * 流式刷新：item 为 @Param，item.text 是 model 侧 @Trace 字段，原地增量更新即可自然刷新。
 */
@ComponentV2
struct ReasoningCard {
  @Require @Param item: TimelineItem;
  /** 默认收起。 */
  @Local expanded: boolean = false;

  build() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.lightbulb'))
          .fontSize(16)
          .fontColor([$r('app.color.label_tertiary')])
          .width(18)
          .height(16)
        Text('思考过程')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .margin({ left: SP_2 })
        Blank()
        SymbolGlyph(this.expanded ? $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([$r('app.color.label_tertiary')])
          .width(18)
          .height(16)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .padding({ left: SP_1, right: SP_1, top: SP_1, bottom: SP_1 })
      .onClick((): void => {
        this.expanded = !this.expanded;
      })

      if (this.expanded) {
        Text(this.item.text)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .padding({ left: SP_4, right: SP_2, top: SP_2, bottom: SP_2 })
      }
    }
    .width('100%')
    .margin({ bottom: SP_1 })
  }
}

/** 统一时间线：按 kind 分派渲染（消息 / 工作步骤分组 / 思考过程 / 系统说明行）。 */
@ComponentV2
export struct TimelineView {
  @Require @Param items: TimelineItem[];
  @Require @Param mdController: MarkdownController;

  /** 分组视图（连续的工作步骤 → 一组）。 */
  private timelineEntries(): TimelineEntry[] {
    return groupTimeline(this.items);
  }

  build() {
    Column() {
      Repeat(this.timelineEntries())
        .each((cell: RepeatItem<TimelineEntry>): void => {
          if (cell.item.isGroup) {
            StepGroup({ steps: cell.item.steps })
          } else if (cell.item.head.kind === 'system') {
            SystemNote({ item: cell.item.head })
          } else if (cell.item.head.kind === 'reasoning') {
            // 思考过程：独立折叠块，不进消息气泡、也不并入工作步骤分组
            ReasoningCard({ item: cell.item.head })
          } else {
            MessageBubble({ item: cell.item.head, mdController: this.mdController })
          }
        })
        .key((e: TimelineEntry): string => e.key)
    }
    .width('100%')
  }
}
