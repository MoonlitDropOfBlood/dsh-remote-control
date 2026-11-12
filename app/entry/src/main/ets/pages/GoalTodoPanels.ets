/*
 * Copyright (c) 2026 dukedsh.
 * v1.3.0 只读面板：Goal 单行条 + Todo 折叠卡（契约 §5.13 / §5.14）。
 *
 * 位置：会话详情页输入区**上方**，渲染顺序为
 *   Goal 单行条 → Todo 折叠卡 → 排队消息 → 附件 → 输入框。
 * 无数据时各自隐藏（宿主不支持 = 整块不渲染；本回合无数据 = 显示占位文案）。
 *
 * 组件边界说明：
 *  - 参数**只用基本类型**（字符串 / 布尔 / 数字）——V2 的 @Param 对对象/数组是深拷贝，
 *    传可变对象会出现「引用没变 → 子组件不刷新」的坑；页面每次渲染重建这些值即可。
 *  - 折叠/展开状态放**页面**（@Local），不放子组件：节点被回收复用后 @Local 会丢。
 */
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

/** Todo 展示行（唯一 key + 文案 + 三态标签）。 */
export interface TodoRowView {
  key: string;
  content: string;
  statusLabel: string;
  done: boolean;
}

/**
 * Goal 单行条（契约 §5.14）。
 *
 * 显示：objective / phase / activation / rounds / blockedReason。
 * 操作：新建（无目标时）/ 编辑 / 暂停 / 恢复 / 完成 / 清除。
 * **手机不提供 block**（契约：blocked 由模型/策略负责）。
 * 子代理只读：`canOperate=false` 时**不渲染任何操作按钮**。
 */
@ComponentV2
export struct GoalBar {
  /** 宿主是否支持目标（false → 整块不渲染）。 */
  @Param visible: boolean = false;
  /** 当前是否有目标（false → 显示「新建目标」入口）。 */
  @Param hasGoal: boolean = false;
  @Param objective: string = '';
  @Param phaseLabel: string = '';
  /** 轮次文案（"6/12"；空串 = 不显示）。轮次由 Agent 驱动，手机只读。 */
  @Param roundsText: string = '';
  @Param blockedText: string = '';
  /** 是否是根会话（子代理只读，不给操作）。 */
  @Param canOperate: boolean = false;
  @Param canCreate: boolean = false;
  @Param canEdit: boolean = false;
  @Param canPause: boolean = false;
  @Param canResume: boolean = false;
  @Param canClear: boolean = false;
  /** 新建目标（objective 必填；轮次由 Agent 控制，回调里恒传 0 = 不提交该字段）。 */
  @Event onCreate: (objective: string, maxGoalRounds: number) => void;
  /** 编辑目标（只改 objective；轮次不提交）。 */
  @Event onEdit: (objective: string, maxGoalRounds: number) => void;
  @Event onPause: () => void;
  @Event onResume: () => void;
  @Event onClear: () => void;

  @Local sheetOpen: boolean = false;
  @Local sheetMode: string = 'create';
  @Local draftObjective: string = '';

  /** 打开目标编辑器（新建 / 编辑共用一张面板）。 */
  private openEditor(mode: string): void {
    this.sheetMode = mode;
    this.draftObjective = this.objective;
    this.sheetOpen = true;
  }

  /** 提交面板：objective 非空才提交（轮次不提交，恒传 0）。 */
  private submitEditor(): void {
    const objective: string = this.draftObjective.trim();
    if (objective.length === 0) {
      return;
    }
    // 轮次（maxGoalRounds）由 Agent 自己控制，手机端不编辑 → 恒传 0（不提交该字段）。
    this.sheetOpen = false;
    if (this.sheetMode === 'create') {
      this.onCreate(objective, 0);
    } else {
      this.onEdit(objective, 0);
    }
  }

  /** 目标编辑器面板内容（新建 / 编辑共用）。 */
  @Builder
  editorSheet() {
    Column() {
      Text(this.sheetMode === 'create' ? '新建目标' : '编辑目标')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_primary'))
        .width('100%')
      Text('目标描述（必填）')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
        .width('100%')
        .margin({ top: SP_3, bottom: SP_1 })
      TextArea({ text: this.draftObjective, placeholder: '例如：把登录重试的边界情况补齐并跑通回归' })
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
        .placeholderColor($r('app.color.label_tertiary'))
        .caretColor($r('app.color.brand_fill'))
        .width('100%')
        .height(96)
        .padding(SP_2)
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .onChange((value: string): void => {
          this.draftObjective = value;
        })
      Button('保存')
        .width('100%')
        .height(44)
        .margin({ top: SP_4 })
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_on_brand'))
        .backgroundColor($r('app.color.brand_fill'))
        .borderRadius(RADIUS_CTRL)
        .enabled(this.draftObjective.trim().length > 0)
        .onClick((): void => {
          this.submitEditor();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: SP_4, right: SP_4, top: SP_4, bottom: SP_4 })
  }

  build() {
    if (!this.visible) {
      Column() {
      }
      .width('100%')
      .height(0)
    } else {
      Column() {
        Row() {
          // 桌面 GoalBar 同款顺序：目标图标 → 状态 → 文案（目标内容）→ 三个小图标按钮
          // （恢复/暂停、编辑、删除）。手机窄，状态文案用短词（不带「的目标」）。
          Text('目标')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
          if (this.hasGoal) {
            Text(this.phaseLabel)
              .fontSize(FS_SMALL)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.label_primary'))
              .margin({ left: SP_2 })
            if (this.roundsText.length > 0) {
              Text(this.roundsText)
                .fontSize(FS_CAPTION)
                .fontColor($r('app.color.label_tertiary'))
                .margin({ left: SP_1 })
            }
            Text(this.objective)
              .fontSize(FS_SMALL)
              .fontColor($r('app.color.label_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
              .margin({ left: SP_2 })
              .margin({ right: SP_1 })
          } else {
            Text('未设置')
              .fontSize(FS_SMALL)
              .fontColor($r('app.color.label_tertiary'))
              .layoutWeight(1)
              .margin({ left: SP_2 })
          }
          if (this.canOperate) {
            if (!this.hasGoal && this.canCreate) {
              Button('新建目标')
                .fontSize(FS_CAPTION)
                .fontColor($r('app.color.label_on_brand'))
                .backgroundColor($r('app.color.brand_fill'))
                .borderRadius(RADIUS_PILL)
                .height(26)
                .padding({ left: SP_3, right: SP_3 })
                .onClick((): void => {
                  this.openEditor('create');
                })
            } else {
              if (this.canPause) {
                Button() {
                  SymbolGlyph($r('sys.symbol.pause'))
                    .fontSize(16)
                    .fontColor([$r('app.color.label_tertiary')])
                }
                .width(28)
                .height(28)
                .borderRadius(14)
                .padding(0)
                .backgroundColor(Color.Transparent)
                .margin({ left: SP_1 })
                .onClick((): void => {
                  this.onPause();
                })
              } else if (this.canResume) {
                Button() {
                  SymbolGlyph($r('sys.symbol.play'))
                    .fontSize(16)
                    .fontColor([$r('app.color.label_tertiary')])
                }
                .width(28)
                .height(28)
                .borderRadius(14)
                .padding(0)
                .backgroundColor(Color.Transparent)
                .margin({ left: SP_1 })
                .onClick((): void => {
                  this.onResume();
                })
              }
              if (this.canEdit) {
                Button() {
                  SymbolGlyph($r('sys.symbol.square_and_pencil'))
                    .fontSize(16)
                    .fontColor([$r('app.color.label_tertiary')])
                }
                .width(28)
                .height(28)
                .borderRadius(14)
                .padding(0)
                .backgroundColor(Color.Transparent)
                .margin({ left: SP_1 })
                .onClick((): void => {
                  this.openEditor('edit');
                })
              }
              if (this.canClear) {
                Button() {
                  SymbolGlyph($r('sys.symbol.trash'))
                    .fontSize(16)
                    .fontColor([$r('app.color.label_tertiary')])
                }
                .width(28)
                .height(28)
                .borderRadius(14)
                .padding(0)
                .backgroundColor(Color.Transparent)
                .margin({ left: SP_1 })
                .onClick((): void => {
                  this.onClear();
                })
              }
            }
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        if (this.hasGoal && this.blockedText.length > 0) {
          Text(this.blockedText)
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.state_warn'))
            .width('100%')
            .margin({ top: SP_1 })
        }
      }
      .width('100%')
      .padding({ left: SP_3, right: SP_3, top: SP_2, bottom: SP_2 })
      .backgroundColor($r('app.color.bg_layer_1'))
      .borderRadius(RADIUS_CARD)
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      .bindSheet(this.sheetOpen, this.editorSheet(), {
        height: SheetSize.FIT_CONTENT,
        showClose: false,
        dragBar: true,
        backgroundColor: $r('app.color.bg_layer_1'),
        onDisappear: (): void => {
          this.sheetOpen = false;
        }
      })
    }
  }
}

/**
 * Todo 折叠卡（契约 §5.13，手机**只读**）。
 *
 * - 宿主不支持（supported=false）→ 整块不渲染；
 * - 宿主支持但本回合无清单（todos=null / 空表）→ 显示「暂无任务」；
 * - 展开后按三态（待办 / 进行中 / 已完成）列出条目与计数。
 */
@ComponentV2
export struct TodoCard {
  @Param visible: boolean = false;
  @Param expanded: boolean = false;
  /** true = 本回合没有清单（显示「暂无任务」）。 */
  @Param empty: boolean = true;
  /** 计数摘要，例如「2/5 已完成」。 */
  @Param countsText: string = '';
  @Param rows: TodoRowView[] = [];
  @Event onToggle: () => void;

  build() {
    if (!this.visible) {
      Column() {
      }
      .width('100%')
      .height(0)
    } else {
      Column() {
        Row() {
          Text('任务清单')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
          Text(this.empty ? '暂无任务' : this.countsText)
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .margin({ left: SP_2 })
          Blank()
          if (!this.empty) {
            Text(this.expanded ? '收起' : '展开')
              .fontSize(FS_CAPTION)
              .fontColor($r('app.color.brand_label'))
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .onClick((): void => {
          this.onToggle();
        })

        if (this.expanded && !this.empty) {
          Repeat(this.rows)
            .each((cell: RepeatItem<TodoRowView>): void => {
              Row() {
                Text(this.statusDot(cell.item))
                  .fontSize(FS_SMALL)
                  .fontColor(this.statusColor(cell.item))
                Text(cell.item.content)
                  .fontSize(FS_SMALL)
                  .fontColor(cell.item.done ? $r('app.color.label_tertiary') : $r('app.color.label_primary'))
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                  .margin({ left: SP_2 })
                Text(cell.item.statusLabel)
                  .fontSize(FS_CAPTION)
                  .fontColor($r('app.color.label_tertiary'))
              }
              .width('100%')
              .alignItems(VerticalAlign.Center)
              .padding({ top: SP_1, bottom: SP_1 })
            })
            .key((row: TodoRowView): string => row.key)
          Text(this.countsText)
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
            .width('100%')
            .margin({ top: SP_1 })
        }
      }
      .width('100%')
      .padding({ left: SP_3, right: SP_3, top: SP_2, bottom: SP_2 })
      .backgroundColor($r('app.color.bg_layer_1'))
      .borderRadius(RADIUS_CARD)
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    }
  }

  /** 三态圆点（用字符，避免额外图形资源）。 */
  private statusDot(row: TodoRowView): string {
    if (row.done) {
      return '✓';
    }
    if (row.statusLabel === '进行中') {
      return '◐';
    }
    return '○';
  }

  /** 三态颜色。 */
  private statusColor(row: TodoRowView): ResourceColor {
    if (row.done) {
      return $r('app.color.state_success');
    }
    if (row.statusLabel === '进行中') {
      return $r('app.color.brand_label');
    }
    return $r('app.color.label_tertiary');
  }
}
