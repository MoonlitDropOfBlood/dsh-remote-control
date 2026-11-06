/*
 * Copyright (c) 2026 dukedsh.
 * 统一时间线渲染（契约 §5.7 v1.0.6；v1.1.4 改造）：详情页消息流按 kind 分派，
 * 全部来自 store.timeline。本文件只提供**条目组件**与分组函数——列表容器
 * （List + Repeat 懒加载 + 模板复用）在 SessionDetailPage 里（v1.1.4 从
 * Scroll+Column 全量加载迁移到 List 懒加载：长会话只布局可视区、支持 initialIndex
 * 首帧贴底与 scrollToIndex 定位）。
 *  - message：用户右对齐品牌蓝气泡；助手左对齐浅面卡片 + @luvi/lv-markdown-in（流式光标 / 错误提示）
 *    v1.2.0（§5.11.4）：消息里的附件——图片缩略图在前、文件卡片（图标+名称+大小）在后；
 *    纯附件消息（正文为空）不画空气泡；本地乐观图片（source='local'）不响应点开大图。
 *  - step：连续的工作步骤归为一个「工作步骤 · N」分组，组头可整体折叠/展开
 *  - reasoning：思考过程独立折叠块（弱化配色，独立 markdown 控制器）
 *  （v1.0.6 的 system 说明行已随 v1.1.4 移除——宿主 system/developer 消息是
 *   提示词组装/工具注册表记录，不是对话内容，PC 聊天视图从不展示。）
 *
 * 复用安全（v1.1.4）：折叠/展开状态一律存在
 * TimelineItem.expanded（数据侧 @Trace），不放在组件 @Local——List 懒加载会
 * 回收/复用节点，组件内状态在复用时会被重置或串台，挂数据上则随 @Param 绑定恢复。
 * 注意：这些条目组件**不能**挂 @ReusableV2——Repeat 的 `.template()` 里不允许
 * 出现 @ReusableV2 组件（模板自带复用池，两者冲突）。复用由 Repeat 的
 * virtualScroll + template 分类池负责（相同 template type 的节点互相复用）。
 */
import { Markdown, MarkdownController } from '@luvi/lv-markdown-in';
import { DshrcFileRef, DshrcImageRef } from '../model/protocol';
import { formatAttachmentSize } from '../model/attachment-plan';
import { openImageViewer } from '../model/routes';
import {
  ProcessActivityCount,
  ProcessActivityKind,
  activityOfTool,
  composeProcessTitle,
  processActivityLabel,
  processLiveDetail,
  reasoningPreview,
  rankProcessActivities
} from '../model/process-activity';
import { TimelineEntry, TimelineItem, sessionStore } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  HAIRLINE,
  RADIUS_BUBBLE,
  RADIUS_CARD,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  clockTime
} from '../model/theme';
import { StepCard } from './StepCard';

/** 缩略图最大高度（vp）——契约 §5.10：等比、最大宽度撑满气泡、最大高度 ≤ 320vp。 */
const THUMB_MAX_HEIGHT: number = 320;
/** 用户消息里的图片上限高度（vp）：比助手图片更收一点，聊天气泡观感更轻。 */
const THUMB_MAX_HEIGHT_USER: number = 240;
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

/**
 * 过程分组里某个条目对应的活动种类（桌面端 activity() 的等价分类）：
 * 思考块 = thinking，工具调用按工具名分类。
 */
export function memberActivity(it: TimelineItem): ProcessActivityKind {
  if (it.isReasoning()) {
    return 'thinking';
  }
  return activityOfTool(it.toolName);
}

/** 过程分组是否还在进行中（最后一条还在跑 / 思考还在流式输出）。 */
export function processGroupLive(members: TimelineItem[]): boolean {
  if (members.length === 0) {
    return false;
  }
  const last: TimelineItem = members[members.length - 1];
  if (last.isReasoning()) {
    return last.streaming;
  }
  return last.status === 'running';
}

/**
 * 这个分组是不是**当前正在跑**的那一组（响应式：读 entry.members / store 状态）。
 * 桌面端按 turn 的 closed 判定，不看最后一条的状态 —— 工具间隙里思考已结束、
 * 下一个调用还没到，仍然算「运行中」。
 */
export function isLiveProcessGroup(entry: TimelineEntry, sessionId: string): boolean {
  // message 边界由 groupTimeline() 立即关闭旧组；即使旧组末项仍是 running，
  // 也不能再让它以“当前正在执行”的身份占用组头（与 DSH ProcessGroup.closed 一致）。
  if (entry.closed) {
    return false;
  }
  const members: TimelineItem[] = entry.members;
  if (members.length === 0) {
    return false;
  }
  const last: TimelineItem = members[members.length - 1];
  if (last.isReasoning() && last.streaming) {
    return true;
  }
  if (last.isStep() && last.status === 'running') {
    return true;
  }
  // 工具间隙：会话在跑，且本组就是最后一个过程分组。
  if (!sessionStore.runningOf(sessionId)) {
    return false;
  }
  const groups: TimelineEntry[] = sessionStore.processGroups;
  if (groups.length === 0) {
    return false;
  }
  return groups[groups.length - 1].key === entry.key;
}

/**
 * 过程分组**组头文案**（v1.2.1）：
 *  - 运行中：实时活动标题（「正在运行命令」）+ 「 · 细节」（命令/文件路径…），
 *    与桌面端 liveProcessDetail 的表现一致；
 *  - 已结束：按活动类型合成的完成态标题（「已读取文件并搜索代码」）。
 */
export function processGroupHeaderText(members: TimelineItem[], live: boolean): string {
  if (members.length === 0) {
    return processActivityLabel('thinking', false);
  }
  if (!live) {
    return processGroupTitle(members);
  }
  const last: TimelineItem = members[members.length - 1];
  const label: string = processActivityLabel(memberActivity(last), true);
  if (last.isReasoning()) {
    // 分组折叠时（默认）也能看到「正在想什么」：思考块头部同样有一份动态摘要
    const preview: string = reasoningPreview(last.text, true);
    return preview.length === 0 ? label : label + ' · ' + preview;
  }
  const detail: string = processLiveDetail(last.argsText);
  return detail.length === 0 ? label : label + ' · ' + detail;
}

/**
 * 过程分组当前的**代表活动**：运行中看最后一条（正在做什么），已结束看排名第一类
 * （决定了组头左侧图标，桌面端 PROCESS_ICONS[activity] 的等价物）。
 */
export function processGroupActivity(members: TimelineItem[], live: boolean): ProcessActivityKind {
  if (members.length === 0) {
    return 'thinking';
  }
  if (live) {
    return memberActivity(members[members.length - 1]);
  }
  const kinds: ProcessActivityKind[] = [];
  for (let i: number = 0; i < members.length; i++) {
    kinds.push(memberActivity(members[i]));
  }
  const ranked: ProcessActivityCount[] = rankProcessActivities(kinds);
  return ranked.length > 0 ? ranked[0].kind : 'thinking';
}

/** 活动 → 系统符号图标（桌面端 PROCESS_ICONS 的等价映射；只在 .ets 里做资源解析）。 */
function activitySymbol(kind: ProcessActivityKind): Resource {
  if (kind === 'read') {
    return $r('sys.symbol.doc_plaintext');
  }
  if (kind === 'readImage') {
    return $r('sys.symbol.picture');
  }
  if (kind === 'search' || kind === 'webSearch') {
    return $r('sys.symbol.magnifyingglass');
  }
  if (kind === 'write' || kind === 'edit') {
    return $r('sys.symbol.square_and_pencil');
  }
  if (kind === 'commands') {
    return $r('sys.symbol.code_square');
  }
  if (kind === 'code') {
    return $r('sys.symbol.code_1');
  }
  if (kind === 'webFetch') {
    return $r('sys.symbol.link');
  }
  if (kind === 'subagents') {
    return $r('sys.symbol.person_2');
  }
  if (kind === 'plan') {
    return $r('sys.symbol.list_bullet');
  }
  if (kind === 'questions') {
    return $r('sys.symbol.questionmark_circle');
  }
  if (kind === 'tools') {
    return $r('sys.symbol.wrench_and_screwdriver');
  }
  return $r('sys.symbol.lightbulb');
}

/** 已关闭过程分组的合成标题；closed 后必须忽略成员遗留的 running 状态。 */
export function processGroupTitle(members: TimelineItem[]): string {
  if (members.length === 0) {
    return processActivityLabel('thinking', false);
  }
  const kinds: ProcessActivityKind[] = [];
  for (let i = 0; i < members.length; i++) {
    kinds.push(memberActivity(members[i]));
  }
  return composeProcessTitle(rankProcessActivities(kinds));
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
  /** 展示高度上限（vp）：用户图片更收一点（240），助手图片按契约 320。 */
  @Param maxHeight: number = THUMB_MAX_HEIGHT;

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
    const maxH: number = this.maxHeight > 0 ? this.maxHeight : THUMB_MAX_HEIGHT;
    if (avail / r > maxH) {
      return maxH * r;
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

  /**
   * 是否本地乐观图片（v1.2.0 §5.11.4：乐观上屏用 `imageId='local:<id>'`、
   * `source='local'`，宿主 attachmentId 还不存在）→ 点开大图必然 `image.fetch`
   * 失败，所以本地图片**不响应点击**（缩略图本身已足够看）。
   */
  private isLocal(): boolean {
    return this.image.source === 'local' || this.image.imageId.indexOf('local:') === 0;
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
        if (!this.isLocal()) {
          openImageViewer(this.image);
        }
      })
    } else {
      Image(this.image.thumb)
        .width(this.displayWidth())
        .height(this.displayHeight())
        .objectFit(ImageFit.Contain)
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .onClick((): void => {
          if (!this.isLocal()) {
            openImageViewer(this.image);
          }
        })
    }
  }
}

/** Repeat 边界包装：图片组件随 RepeatItem 更新，而不是固定绑定创建时的 image。 */
@ComponentV2
struct MessageImageItem {
  @Require @Param cell: RepeatItem<ImageEntry>;
  @Param availWidth: number = 0;
  @Param maxHeight: number = THUMB_MAX_HEIGHT;

  build() {
    MessageImage({
      image: this.cell.item.image,
      availWidth: this.availWidth,
      maxHeight: this.maxHeight
    })
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
  /** 展示高度上限（vp）：用户消息 240、助手消息 320（契约 §5.10 上限）。 */
  @Param maxHeight: number = THUMB_MAX_HEIGHT;

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
          MessageImageItem({ cell: cell, availWidth: this.availWidth, maxHeight: this.maxHeight })
        })
        .key((e: ImageEntry): string => e.key)
    }
    .width('100%')
    .alignItems(this.alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
  }
}

/** 文件渲染项（Repeat 的稳定 key：fileId 可能重复 → 拼下标保证唯一）。 */
interface FileEntry {
  key: string;
  file: DshrcFileRef;
}

/**
 * 消息内的文件卡片（契约 §5.11.4 v1.2.0）：图标 + 文件名 + 大小。
 * 手机端 v1.2.0 **不提供下载**（契约明确），只做展示；用户消息右对齐、助手消息左对齐。
 * 文件在图片之后渲染（契约：images 在前、files 在后）。
 *
 * 视觉：左侧品牌色图标托（brand_tint 底 + brand_label 字形），右侧两行文本；
 * 卡片底色按所在表面切换（用户消息浮在页面底上 → 白卡；助手消息在白色气泡里 → 灰卡），
 * 避免「白底白卡」看不见层次（DSH 语义坑）。
 */
@ComponentV2
struct MessageFiles {
  @Require @Param files: DshrcFileRef[];
  /** 是否右对齐（用户消息）。 */
  @Param alignEnd: boolean = false;
  /** 是否渲染在助手白色气泡内（true → 卡片用 bg_layer_2，否则用 bg_layer_1）。 */
  @Param onCard: boolean = false;

  private entries(): FileEntry[] {
    const out: FileEntry[] = [];
    for (let i: number = 0; i < this.files.length; i++) {
      const e: FileEntry = { key: this.files[i].fileId + '#' + i.toString(), file: this.files[i] };
      out.push(e);
    }
    return out;
  }

  build() {
    Column({ space: SP_2 }) {
      Repeat(this.entries())
        .each((cell: RepeatItem<FileEntry>): void => {
          Row({ space: SP_2 }) {
            Stack({ alignContent: Alignment.Center }) {
              SymbolGlyph($r('sys.symbol.doc_plaintext_fill_1'))
                .fontSize(18)
                .fontColor([$r('app.color.brand_label')])
                .width(18)
                .height(18)
            }
            .width(34)
            .height(34)
            .backgroundColor($r('app.color.brand_tint'))
            .borderRadius(RADIUS_CTRL)

            Column({ space: 2 }) {
              Text(cell.item.file.name.length > 0 ? cell.item.file.name : '附件')
                .fontSize(FS_SMALL)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.label_primary'))
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(formatAttachmentSize(cell.item.file.bytes))
                .fontSize(FS_CAPTION)
                .fontColor($r('app.color.label_tertiary'))
                .maxLines(1)
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .padding({ left: SP_2, right: SP_3, top: SP_2, bottom: SP_2 })
          .alignItems(VerticalAlign.Center)
          .constraintSize({ minWidth: 168, maxWidth: 260 })
          .backgroundColor(this.onCard ? $r('app.color.bg_layer_2') : $r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          .borderRadius(RADIUS_CARD)
        })
        .key((e: FileEntry): string => e.key)
    }
    .width('100%')
    .alignItems(this.alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
  }
}

/** 对话气泡：用户右对齐品牌蓝 / 助手左对齐浅面卡片（markdown 渲染）。 */
@ComponentV2
export struct MessageBubble {
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
            // v1.0.9：纯图片/纯附件消息（无正文）不画空气泡——否则会留一个空的蓝色药丸
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
          // v1.2.0：图片与文件作为一个右对齐附件组，统一间距；图片上限 240vp 更轻。
          if (this.item.images.length > 0 || this.item.files.length > 0) {
            Column({ space: SP_2 }) {
              if (this.item.images.length > 0) {
                MessageImages({
                  images: this.item.images,
                  availWidth: this.userAvail(),
                  alignEnd: true,
                  maxHeight: THUMB_MAX_HEIGHT_USER
                })
              }
              if (this.item.files.length > 0) {
                MessageFiles({ files: this.item.files, alignEnd: true, onCard: false })
              }
            }
            .width('100%')
            .alignItems(HorizontalAlign.End)
            .margin({ top: SP_2 })
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
            // v1.2.0（契约 §5.11.4）：文件卡片（图片在前、文件在后）
            if (this.item.files.length > 0) {
              MessageFiles({ files: this.item.files, alignEnd: false, onCard: true })
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

/** 消息模板的 RepeatItem 包装：复用后始终从当前 cell.item.head 取消息。 */
@ComponentV2
export struct TimelineMessage {
  @Require @Param cell: RepeatItem<TimelineEntry>;
  @Require @Param mdController: MarkdownController;

  build() {
    MessageBubble({ item: this.cell.item.head, mdController: this.mdController })
  }
}

/**
 * 「工作步骤」过程分组的**组头**（v1.2.1，桌面端 DSH 对齐）：
 *  - 标题是**动态**的：按本组实际发生的活动类型合成（桌面端 processTitle）
 *    ——「已读取文件并搜索代码」「正在运行命令」……不再是固定的「工作步骤 · N」。
 *  - 组头作为 ListItemGroup 的 header 传入（分组聚合用 ListItemGroup + ListItem）。
 *  - 折叠态存 head.groupExpanded（数据侧 @Trace）：List 懒加载复用节点时组件
 *    @Local 会丢/串台，挂数据上随 @Param 恢复；与条目自身的 expanded 分开。
 */
@ComponentV2
export struct ProcessGroupHeader {
  /**
   * 必须传完整的 RepeatItem：Repeat 复用节点时会更新这个包装对象；
   * 只传 cell.item 会让组头继续绑定旧分组（官方 Repeat/@Builder 混用规则）。
   */
  @Require @Param cell: RepeatItem<TimelineEntry>;
  /** 会话 id（判「是否还在跑」要读 store.running）。 */
  @Param sessionId: string = '';

  /** 组内成员（从当前 RepeatItem 取 entry 的 @Trace 字段）。 */
  private members(): TimelineItem[] {
    return this.cell.item.members;
  }

  /** 是否正在进行中：最后一条还在跑 / 思考还在流式；或本组是最后一个分组且会话在跑。 */
  private live(): boolean {
    return isLiveProcessGroup(this.cell.item, this.sessionId);
  }

  build() {
    Row() {
      // 左侧图标 = 当前活动类型（读文件 / 搜索 / 运行命令 …，桌面端 PROCESS_ICONS 的等价物）；
      // 运行中换成转圈 + 品牌色，一眼看出「正在跑」。
      if (this.live()) {
        LoadingProgress()
          .width(14)
          .height(14)
          .color($r('app.color.brand_fill'))
          .margin({ right: SP_2 })
      } else {
        SymbolGlyph(activitySymbol(processGroupActivity(this.members(), this.live())))
          .fontSize(14)
          .fontColor([$r('app.color.label_secondary')])
          .width(16)
          .height(14)
          .margin({ right: SP_2 })
      }
      Text(processGroupHeaderText(this.members(), this.live()))
        .fontSize(FS_SMALL)
        .fontColor(this.live() ? $r('app.color.label_primary') :
          $r('app.color.label_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      // 固定尺寸符号（不依赖字体行高，收起/展开两态盒子完全一致）
      SymbolGlyph(this.cell.item.groupExpanded ? $r('sys.symbol.chevron_down') :
        $r('sys.symbol.chevron_right'))
        .fontSize(16)
        .fontColor([$r('app.color.label_tertiary')])
        .width(18)
        .height(16)
        .margin({ left: SP_1 })
    }
    .width('100%')
    .height(32)
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_1, right: SP_2 })
    .onClick((): void => {
      this.cell.item.groupExpanded = !this.cell.item.groupExpanded;
    })
  }

}

/**
 * 「思考过程」折叠块（kind="reasoning"）：lightbulb 图标 + 标题 + 固定尺寸 chevron。
 * 默认收起，点标题行展开/收起；展开正文走 markdown 渲染
 * （思考内容常含代码块/列表，纯 Text 展示会甩出一堆裸标记——用户反馈）。
 * mdController 传的是**思考专用**控制器（小号 + label_secondary 弱化配色），
 * 与助手气泡的正文主题分开——同色会分不清「思考」和「回答」。
 * 流式刷新：item 为 @Param，item.text 是 model 侧 @Trace 字段，原地增量更新即可自然刷新。
 * 折叠态存 item.expanded（数据侧 @Trace，v1.1.4 复用安全，见 StepGroup 注释）。
 */
@ComponentV2
export struct ReasoningCard {
  @Require @Param item: TimelineItem;
  /** 共享的 markdown 渲染控制器（思考专用弱化主题，页面级创建后下传）。 */
  @Require @Param mdController: MarkdownController;

  /** 折叠行的一句话摘要（流式时跟着最近写完的段落首行走）。 */
  private summaryText(): string {
    return reasoningPreview(this.item.text, this.item.streaming);
  }

  build() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.lightbulb'))
          .fontSize(12)
          .fontColor([$r('app.color.label_tertiary')])
          .width(14)
          .height(12)
        Text('思考过程')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .margin({ left: SP_2 })
        // 折叠时的**动态摘要**（桌面端 ReasoningRow 的 collapsed summary）：
        // 流式思考时跟着「最近一个写完的段落首行」前进，运行中一行就能看到在想什么。
        if (!this.item.expanded && this.summaryText().length > 0) {
          Text(' · ' + this.summaryText())
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_tertiary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: SP_1 })
        } else {
          Blank()
        }
        SymbolGlyph(this.item.expanded ? $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([$r('app.color.label_tertiary')])
          .width(18)
          .height(16)
          .margin({ left: SP_1 })
      }
      .width('100%')
      .height(32)
      .alignItems(VerticalAlign.Center)
      .padding({ left: SP_1, right: SP_2 })
      .onClick((): void => {
        this.item.expanded = !this.item.expanded;
      })

      if (this.item.expanded) {
        Column() {
          Markdown({ text: this.item.text, controller: this.mdController })
            .width('100%')
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_2, top: SP_2, bottom: SP_2 })
      }
    }
    .width('100%')
    .margin({ bottom: SP_1 })
  }
}

/**
 * Repeat 成员包装：把完整的 RepeatItem 接进自定义组件，再取其 item 给卡片。
 * 直接写 StepCard({ item: cell.item }) 会在节点复用时保留旧 item 绑定。
 */
@ComponentV2
struct ProcessStepCard {
  @Require @Param cell: RepeatItem<TimelineItem>;

  build() {
    StepCard({ item: this.cell.item })
  }
}

/** 思考成员的 RepeatItem 包装（与 ProcessStepCard 同理）。 */
@ComponentV2
struct ProcessReasoningCard {
  @Require @Param cell: RepeatItem<TimelineItem>;
  @Require @Param mdController: MarkdownController;

  build() {
    ReasoningCard({ item: this.cell.item, mdController: this.mdController })
  }
}

/**
 * 一个完整的过程分组：ListItemGroup 组头 + 每个成员独立的 ListItem。
 * 外层 Repeat 必须把 cell 整体传进来；entry 只从 this.cell.item 读取，
 * 保证插话新增分组、滚动回收和模板复用后不会继续展示前一组的数据。
 */
@ComponentV2
export struct ProcessGroup {
  @Require @Param cell: RepeatItem<TimelineEntry>;
  @Param sessionId: string = '';
  @Require @Param mdController: MarkdownController;

  @Builder
  groupHeader(cell: RepeatItem<TimelineEntry>) {
    ProcessGroupHeader({ cell: cell, sessionId: this.sessionId })
  }

  build() {
    ListItemGroup({ header: this.groupHeader(this.cell) }) {
      Repeat(this.cell.item.members)
        // 兜底 builder 不写 if；类型分派只走 templateId/template。
        .each((memberCell: RepeatItem<TimelineItem>): void => {
          ListItem() {
            ProcessStepCard({ cell: memberCell })
          }
          .visibility(this.cell.item.groupExpanded ? Visibility.Visible : Visibility.None)
        })
        .key((it: TimelineItem): string => it.id)
        .templateId((it: TimelineItem): string => {
          return it.isReasoning() ? 'reasoning' : 'step';
        })
        .template('reasoning', (memberCell: RepeatItem<TimelineItem>): void => {
          ListItem() {
            ProcessReasoningCard({ cell: memberCell, mdController: this.mdController })
          }
          .visibility(this.cell.item.groupExpanded ? Visibility.Visible : Visibility.None)
        })
        .template('step', (memberCell: RepeatItem<TimelineItem>): void => {
          ListItem() {
            ProcessStepCard({ cell: memberCell })
          }
          .visibility(this.cell.item.groupExpanded ? Visibility.Visible : Visibility.None)
        })
    }
  }
}
