/*
 * Copyright (c) 2026 dukedsh.
 * 工作步骤卡（契约 §5.7 v1.0.6）：复刻 DSH 桌面端 / 网页端「工作步骤（Tool 调用）」标准样式。
 *  - 折叠态（默认，一行约 32vp）：扁平的辅助信息行——状态点 + 工具名（FS_SMALL/label_secondary）
 *    + 摘要（FS_CAPTION/label_tertiary）+ 时间 + chevron；无卡片底色 / 描边，与对话气泡层级分明；
 *    整行点击展开/收起
 *  - 展开态：折叠行下方追加「参数」「输出 / 错误」两块（bg_layer_2 底 + RADIUS_CTRL + SP_3 内边距，
 *    等宽字体、FS_SMALL/label_secondary，错误用 state_error），相对折叠行左缩进 SP_4、右留 SP_2
 *  - 超长参数 / 输出用内层 Scroll 限制高度并内部滚动（外层列表不抢滚动手势）
 *  - 展开状态存在本组件 @Local（V2）里，不写进 store
 */
import { display } from '@kit.ArkUI';
import { TimelineItem } from '../model/sessionstore';
import {
  FS_CAPTION,
  FS_SMALL,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  clockTime
} from '../model/theme';

/** 工具参数 JSON 里我们关心的字段（JSON 解析的显式断言目标；禁 any/unknown）。 */
interface StepArgs {
  description?: string;
  file_path?: string;
  command?: string;
  cmd?: string;
  script?: string;
  code?: string;
}

/** 折叠行「兜底摘要」的最大字符数。 */
const STEP_SUMMARY_MAX: number = 60;

/** 命令类工具名关键字（含其一即按命令首行展示）。 */
const STEP_SHELL_KEYS: string[] = ['bash', 'shell', 'pwsh', 'terminal'];

/** 内层 Scroll 的最大高度缓存（vp）。 */
let STEP_OUTPUT_MAX_VP: number = 0;

/**
 * 内层 Scroll 的最大高度 = 屏高 40%（下限 160vp）。
 * 说明：ArkUI 的 Scroll 子组件在主轴方向不设限，'40%' 这类百分比高度没有确定的
 * 基准（会退化成 0 或不设限），故按屏高换算成 vp——语义等价于「40% 屏高」，
 * 且保证长参数 / 长输出可视 + 内部滚动。
 */
function stepOutputMaxVp(): number {
  if (STEP_OUTPUT_MAX_VP > 0) {
    return STEP_OUTPUT_MAX_VP;
  }
  try {
    const screenH: number = display.getDefaultDisplaySync().height; // vp
    STEP_OUTPUT_MAX_VP = Math.max(160, Math.floor(screenH * 0.4));
  } catch (e) {
    STEP_OUTPUT_MAX_VP = 240;
  }
  return STEP_OUTPUT_MAX_VP;
}

/** 单个工作步骤卡（一次工具调用）。 */
@ComponentV2
export struct StepCard {
  @Require @Param item: TimelineItem;
  /** 展开状态（组件内 V2 状态，不入 store）。 */
  @Local expanded: boolean = false;

  /** 状态色：running→品牌蓝 / ok→成功绿 / error→错误红。 */
  private statusColor(): ResourceColor {
    if (this.item.status === 'error') {
      return $r('app.color.state_error');
    }
    if (this.item.status === 'ok') {
      return $r('app.color.state_success');
    }
    return $r('app.color.brand_fill');
  }

  /** 本次调用是否失败（决定「输出 / 错误」块与配色）。 */
  private isError(): boolean {
    return this.item.status === 'error';
  }

  /** 是否命令类工具（bash/shell/pwsh/terminal）。 */
  private isShellTool(): boolean {
    const name: string = this.item.toolName.toLowerCase();
    for (let i: number = 0; i < STEP_SHELL_KEYS.length; i++) {
      if (name.indexOf(STEP_SHELL_KEYS[i]) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** 参数 JSON → 关注字段（非对象 / 非法 JSON → undefined）。 */
  private parsedArgs(): StepArgs | undefined {
    const raw: string = this.item.argsText.trim();
    if (raw.length === 0 || raw.charAt(0) !== '{') {
      return undefined;
    }
    try {
      const parsed: StepArgs = JSON.parse(raw) as StepArgs;
      return parsed;
    } catch (e) {
      return undefined;
    }
  }

  /** 命令首行（命令类工具专用）。 */
  private commandText(args: StepArgs): string {
    const candidates: string[] = [];
    if (args.command !== undefined) {
      candidates.push(args.command);
    }
    if (args.cmd !== undefined) {
      candidates.push(args.cmd);
    }
    if (args.script !== undefined) {
      candidates.push(args.script);
    }
    if (args.code !== undefined) {
      candidates.push(args.code);
    }
    for (let i: number = 0; i < candidates.length; i++) {
      const first: string = candidates[i].split('\n')[0].trim();
      if (first.length > 0) {
        return first;
      }
    }
    return '';
  }

  /** 兜底摘要：参数压成一行并截断。 */
  private rawSummary(): string {
    const one: string = this.item.argsText.replace(/\s+/g, ' ').trim();
    if (one.length === 0) {
      return '';
    }
    return one.length > STEP_SUMMARY_MAX ? one.substring(0, STEP_SUMMARY_MAX) + '…' : one;
  }

  /** 折叠行主标题：工具名（弱化样式，FS_SMALL + label_secondary）。 */
  private toolLabel(): string {
    return this.item.toolName.length > 0 ? this.item.toolName : '工具';
  }

  /**
   * 折叠行副标题：摘要（弱化样式，FS_CAPTION + label_tertiary）。
   * 优先级：description → file_path → 命令首行 → 参数一行摘要。
   */
  private summaryText(): string {
    let summary: string = '';
    const args: StepArgs | undefined = this.parsedArgs();
    if (args !== undefined) {
      const desc: string | undefined = args.description;
      if (desc !== undefined && desc.trim().length > 0) {
        summary = desc.trim();
      } else {
        const filePath: string | undefined = args.file_path;
        if (filePath !== undefined && filePath.trim().length > 0) {
          summary = filePath.trim();
        } else if (this.isShellTool()) {
          summary = this.commandText(args);
        }
      }
    }
    if (summary.length === 0) {
      summary = this.rawSummary();
    }
    return summary;
  }

  /** 输出块内容：失败优先 errorText；空则「（无输出）」。 */
  private outputText(): string {
    if (this.isError()) {
      if (this.item.errorText.length > 0) {
        return this.item.errorText;
      }
      if (this.item.resultText.length > 0) {
        return this.item.resultText;
      }
      return '（无输出）';
    }
    return this.item.resultText.length > 0 ? this.item.resultText : '（无输出）';
  }

  /** 「参数」块：原始参数 JSON（等宽字体，弱化的 label_secondary）。 */
  @Builder
  argsBlock() {
    Column() {
      Text('参数')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
        .width('100%')
        .margin({ bottom: SP_1 })
      Scroll() {
        Text(this.item.argsText)
          .fontSize(FS_SMALL)
          .fontFamily('monospace')
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
      }
      .width('100%')
      .constraintSize({ maxHeight: stepOutputMaxVp() })
      .nestedScroll({
        scrollForward: NestedScrollMode.SELF_ONLY,
        scrollBackward: NestedScrollMode.SELF_ONLY
      })
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .padding(SP_3)
    .margin({ bottom: SP_2 })
    .backgroundColor($r('app.color.bg_layer_2'))
    .borderRadius(RADIUS_CTRL)
  }

  /** 「输出 / 错误」块：正文弱化（label_secondary），失败用 state_error 明示。 */
  @Builder
  outputBlock() {
    Column() {
      Text(this.isError() ? '错误' : '输出')
        .fontSize(FS_CAPTION)
        .fontColor(this.isError() ? $r('app.color.state_error') : $r('app.color.label_tertiary'))
        .width('100%')
        .margin({ bottom: SP_1 })
      Scroll() {
        Text(this.outputText())
          .fontSize(FS_SMALL)
          .fontFamily('monospace')
          .fontColor(this.isError() ? $r('app.color.state_error') : $r('app.color.label_secondary'))
          .width('100%')
      }
      .width('100%')
      .constraintSize({ maxHeight: stepOutputMaxVp() })
      .nestedScroll({
        scrollForward: NestedScrollMode.SELF_ONLY,
        scrollBackward: NestedScrollMode.SELF_ONLY
      })
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .padding(SP_3)
    .margin({ bottom: SP_2 })
    .backgroundColor($r('app.color.bg_layer_2'))
    .borderRadius(RADIUS_CTRL)
  }

  build() {
    Column() {
      // 扁平行（辅助信息，不做卡片观感）：状态点 + 工具名 + 摘要 + 时间 + chevron
      Row() {
        Circle({ width: 5, height: 5 })
          .fill(this.statusColor())
        Text(this.toolLabel())
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
          .margin({ left: SP_2 })
        if (this.summaryText().length > 0) {
          Text(this.summaryText())
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(2)
            .margin({ left: SP_2 })
        }
        Text(clockTime(this.item.ts))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .margin({ left: SP_2 })
        Text(this.expanded ? '⌄' : '›')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_tertiary'))
          .margin({ left: SP_1 })
      }
      .width('100%')
      .height(32)
      .alignItems(VerticalAlign.Center)
      .padding({ left: SP_2, right: SP_2 })
      .onClick((): void => {
        this.expanded = !this.expanded;
      })

      if (this.expanded) {
        // 展开区：相对折叠行左缩进 SP_4、右留 SP_2，块间 SP_2 间距（不贴边）
        Column() {
          if (this.item.argsText.length > 0) {
            this.argsBlock()
          }
          this.outputBlock()
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_2 })
        .margin({ top: SP_2 })
      }
    }
    .width('100%')
    .margin({ bottom: SP_1 })
  }
}
