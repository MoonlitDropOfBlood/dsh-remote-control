/*
 * Copyright (c) 2026 dukedsh.
 * 统一时间线渲染（契约 §5.7 v1.0.6）：详情页消息流按 kind 分派，全部来自 store.timeline。
 *  - message：用户右对齐品牌蓝气泡；助手左对齐浅面卡片 + @luvi/lv-markdown-in（流式光标 / 错误提示）
 *  - step：连续的工作步骤归为一个「工作步骤 · N」分组，组头可整体折叠/展开
 *  - system：系统 / 开发者说明行（细分隔 + 说明文字；超过 2 行折叠，可点击展开全文）
 */
import { Markdown, MarkdownController } from '@luvi/lv-markdown-in';
import { DshrcImageRef } from '../model/protocol';
import { openImageViewer } from '../model/routes';
import { TimelineItem } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  HAIRLINE,
  RADIUS_BUBBLE,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  clockTime
} from '../model/theme';
import { StepCard } from './StepCard';

/** 系统说明行：字符数超过该阈值视为可能超过 2 行（折叠 + 可展开）。 */
const SYSTEM_FOLD_CHARS: number = 80;

/** 缩略图最大高度（vp）——契约 §5.10：等比、最大宽度撑满气泡、最大高度 ≤ 320vp。 */
const THUMB_MAX_HEIGHT: number = 320;
/** 缩略图可用宽度的缺省值（vp）：气泡宽度测量完成前的兜底。 */
const THUMB_FALLBACK_WIDTH: number = 240;
/** 占位框上限尺寸（vp）：thumb 为空时（插件降质后仍超限）显示的灰框。 */
const PLACEHOLDER_MAX_WIDTH: number = 160;
const PLACEHOLDER_MAX_HEIGHT: number = 120;

/** 图片渲染项（Repeat 的稳定 key：imageId 可能重复 → 拼下标保证唯一）。 */
interface ImageEntry {
  key: string;
  image: DshrcImageRef;
}

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

/**
 * 单张图片缩略图（契约 §5.10 v1.0.9）：
 *  - thumb 内联 data URI → 直接当 Image 的 src；
 *  - thumb 为空（插件降质后仍超限）→ 灰色占位框（图片图标 + 「图片」字样）；
 *  - 点击 → 进大图浏览页（openImageViewer）。
 */
@ComponentV2
struct MessageImage {
  @Require @Param image: DshrcImageRef;
  /** 气泡内容可用宽度（vp）：由 MessageBubble 测量后传入。 */
  @Param availWidth: number = 0;

  /** 宽高比（宽/高）；尺寸非法时按 1 处理。 */
  private ratio(): number {
    const w: number = this.image.width;
    const h: number = this.image.height;
    if (w <= 0 || h <= 0) {
      return 1;
    }
    return w / h;
  }

  /** 展示宽度（vp）：撑满可用宽度；超过最大高度时按比例收窄。 */
  private displayWidth(): number {
    const avail: number = this.availWidth > 0 ? this.availWidth : THUMB_FALLBACK_WIDTH;
    const r: number = this.ratio();
    if (avail / r > THUMB_MAX_HEIGHT) {
      return THUMB_MAX_HEIGHT * r;
    }
    return avail;
  }

  /** 展示高度（vp）：与展示宽度严格等比。 */
  private displayHeight(): number {
    return this.displayWidth() / this.ratio();
  }

  /** 占位框尺寸（vp）：不超过缩略图应有的显示尺寸。 */
  private placeholderWidth(): number {
    return Math.min(this.displayWidth(), PLACEHOLDER_MAX_WIDTH);
  }

  private placeholderHeight(): number {
    return Math.min(this.displayHeight(), PLACEHOLDER_MAX_HEIGHT);
  }

  build() {
    if (this.image.thumb.length === 0) {
      Column() {
        SymbolGlyph($r('sys.symbol.picture'))
          .fontSize(22)
          .fontColor([$r('app.color.label_tertiary')])
          .width(24)
          .height(24)
        Text('图片')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .margin({ top: SP_1 })
      }
      .width(this.placeholderWidth())
      .height(this.placeholderHeight())
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
      .backgroundColor($r('app.color.bg_layer_2'))
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      .borderRadius(RADIUS_CTRL)
      .onClick((): void => {
        openImageViewer(this.image);
      })
    } else {
      Image(this.image.thumb)
        .width(this.displayWidth())
        .height(this.displayHeight())
        .objectFit(ImageFit.Contain)
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .onClick((): void => {
          openImageViewer(this.image);
        })
    }
  }
}

/** 消息内的图片列表（文本下方，逐张缩略图）。 */
@ComponentV2
struct MessageImages {
  @Require @Param images: DshrcImageRef[];
  /** 气泡内容可用宽度（vp）。 */
  @Param availWidth: number = 0;
  /** 是否右对齐（用户消息的图片跟在右对齐气泡下方）。 */
  @Param alignEnd: boolean = false;

  /** 渲染项（key 稳定唯一）。 */
  private entries(): ImageEntry[] {
    const out: ImageEntry[] = [];
    for (let i: number = 0; i < this.images.length; i++) {
      const e: ImageEntry = { key: this.images[i].imageId + '#' + i.toString(), image: this.images[i] };
      out.push(e);
    }
    return out;
  }

  build() {
    Column({ space: SP_2 }) {
      Repeat(this.entries())
        .each((cell: RepeatItem<ImageEntry>): void => {
          MessageImage({ image: cell.item.image, availWidth: this.availWidth })
        })
        .key((e: ImageEntry): string => e.key)
    }
    .width('100%')
    .alignItems(this.alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
  }
}

/** 对话气泡：用户右对齐品牌蓝 / 助手左对齐浅面卡片（markdown 渲染）。 */
@ComponentV2
struct MessageBubble {
  @Require @Param item: TimelineItem;
  /** 共享的 markdown 渲染控制器（DSH 风格配色，页面级创建后下传）。 */
  @Require @Param mdController: MarkdownController;
  /** 气泡所在列的宽度（vp，测量得到）：缩略图按它等比缩放（测量前用缺省值）。 */
  @Local availWidth: number = 0;

  /** 助手气泡内的图片可用宽度（vp）：扣掉气泡自身内边距与描边。 */
  private assistantAvail(): number {
    const w: number = this.availWidth > 0 ? this.availWidth : THUMB_FALLBACK_WIDTH;
    return w - SP_4 - SP_2 - 2 * HAIRLINE;
  }

  /** 用户气泡下的图片可用宽度（vp）：与文字气泡同宽上限（82%）。 */
  private userAvail(): number {
    const w: number = this.availWidth > 0 ? this.availWidth : THUMB_FALLBACK_WIDTH;
    return w * 0.82;
  }

  /** 气泡列宽变化 → 更新缩略图可用宽度（onAreaChange 的尺寸单位是 vp）。 */
  private handleAreaChange(oldArea: Area, newArea: Area): void {
    const w: Length = newArea.width;
    if (typeof w === 'number') {
      this.availWidth = w;
    }
  }

  build() {
    Column() {
      if (this.item.role === 'user') {
        // 用户：右对齐品牌蓝气泡。Text 自身即气泡（padding/bg 挂 Text），
        // constraintSize 的百分比解析自外层 Row（定宽）——绝不把 width('100%')
        // 塞进自适应 Column（循环百分比 → 不换行 → 文字甩出气泡，真机实测 bug）。
        Column() {
          Row() {
            // v1.0.9：纯图片消息（无正文）不画空气泡——否则会留一个空的蓝色药丸
            if (this.item.text.length > 0) {
              Text(this.item.text)
                .fontSize(FS_BODY)
                .fontColor($r('app.color.label_on_brand'))
                .padding({ left: 12, right: 12, top: 10, bottom: 10 })
                .backgroundColor($r('app.color.brand_fill'))
                .borderRadius(RADIUS_BUBBLE)
                .constraintSize({ maxWidth: '82%' })
            }
          }
          .width('100%')
          .justifyContent(FlexAlign.End)
          // v1.0.9：图片在消息文本下方（用户气泡是纯文本气泡，图片另起一块右对齐）
          if (this.item.images.length > 0) {
            MessageImages({
              images: this.item.images,
              availWidth: this.userAvail(),
              alignEnd: true
            })
          }
        }
        .width('100%')
        .margin({ top: SP_1, bottom: SP_1 })
      } else {
        // 助手：左对齐浅面卡片 + lv-markdown-in 渲染（标题/列表/表格/代码块/行内代码/
        // 引用/分割线全支持；text 随流式增量更新，库侧自带响应）。
        // 宽度与「工作步骤」卡一致（铺满整行），不再压到 82%。
        Row() {
          Column() {
            if (this.item.text.length > 0) {
              Markdown({
                text: this.item.text,
                controller: this.mdController
              })
                .width('100%')
            }
            // v1.0.9：图片在消息文本下方（同属这张浅面卡片内）
            if (this.item.images.length > 0) {
              MessageImages({ images: this.item.images, availWidth: this.assistantAvail() })
            }
            if (this.item.errorText.length > 0) {
              Text(this.item.errorText)
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.state_error'))
                .margin({ top: SP_1 })
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: SP_4, right: SP_2, top: SP_2, bottom: SP_2 })
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
    // 测量气泡列宽（vp）——缩略图按此等比缩放
    .onAreaChange((oldArea: Area, newArea: Area): void => {
      this.handleAreaChange(oldArea, newArea);
    })
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
