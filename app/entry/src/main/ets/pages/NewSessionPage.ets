/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页（选模式 + 权限，契约 §5.8 v1.0.6）。
 *  - 标题（可选）/ 工作目录（可选）：留空由主机取默认值
 *  - 模式（Host Agent preset）与权限（permission preset）单选组：候选项来自
 *    sessionStore.presets / permissions（宿主不支持或旧插件 → 目录为空 → 整块隐藏）
 *  - 创建：session.create(title, agentPreset, permission, cwd)；
 *    宿主拒绝所选模式/权限（错误含 unsupported）→ 回退为「不带模式/权限」再创建一次
 *  - 页面本体保持普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
 */
import { promptAction } from '@kit.ArkUI';
import { dshrcLink } from '../model/link';
import { DshrcModeOption, DshrcPermissionOption } from '../model/protocol';
import {
  DshrcChoiceItem,
  isUnsupportedError,
  permissionItems,
  presetItems,
  resolvePermissionId,
  resolvePresetId
} from '../model/newsession';
import { goBack, openSessionDetail } from '../model/routes';
import { SessionStore, sessionStore } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  FS_SUBTITLE,
  HAIRLINE,
  RADIUS_CARD,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  SP_5
} from '../model/theme';

/** 文本输入卡片（标题 / 工作目录）。 */
@ComponentV2
struct TextFieldCard {
  @Param label: string = '';
  @Param hint: string = '';
  @Param value: string = '';
  @Event onInput: (value: string) => void;

  build() {
    Column() {
      Text(this.label)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_secondary'))
        .width('100%')
      TextInput({ text: this.value, placeholder: this.hint })
        .type(InputType.Normal)
        .onChange((v: string): void => {
          this.onInput(v);
        })
        .width('100%')
        .height(44)
        .margin({ top: SP_1 })
        .padding({ left: SP_3, right: SP_3 })
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
        .placeholderColor($r('app.color.label_tertiary'))
        .caretColor($r('app.color.brand_fill'))
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
  }
}

/** 单选组的一行：Radio + 名称（FS_BODY / label_primary）+ 描述（FS_CAPTION / label_secondary）。 */
@ComponentV2
struct ChoiceRow {
  @Require @Param item: DshrcChoiceItem;
  /** 单选组名（'mode' / 'permission'）——同组互斥由 Radio 的 group 机制保证。 */
  @Param group: string = '';
  @Param selected: boolean = false;
  @Event onSelect: (id: string) => void;

  build() {
    Row() {
      // Radio 无 selectedColor 属性：选中态配色走 radioStyle（环=brand_fill，勾=label_on_brand）。
      Radio({ value: this.item.id, group: this.group })
        .checked(this.selected)
        .radioStyle({
          checkedBackgroundColor: $r('app.color.brand_fill'),
          indicatorColor: $r('app.color.label_on_brand')
        })
        .onChange((isChecked: boolean): void => {
          if (isChecked) {
            this.onSelect(this.item.id);
          }
        })
      Column() {
        Text(this.item.name)
          .fontSize(FS_BODY)
          .fontColor($r('app.color.label_primary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.item.description.length > 0) {
          Text(this.item.description)
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .width('100%')
            .margin({ top: SP_1 })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: SP_2 })
    }
    .width('100%')
    .padding({ top: SP_2, bottom: SP_2 })
    .alignItems(VerticalAlign.Center)
  }
}

/** 单选组卡片（模式 / 权限共用外观）。 */
@ComponentV2
struct ChoiceGroupCard {
  @Param title: string = '';
  @Param hint: string = '';
  @Require @Param items: DshrcChoiceItem[];
  @Param group: string = '';
  @Param selectedId: string = '';
  @Event onSelect: (id: string) => void;

  build() {
    Column() {
      Text(this.title)
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_primary'))
        .width('100%')
      Text(this.hint)
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_secondary'))
        .width('100%')
        .margin({ top: SP_1 })
      Repeat(this.items)
        .each((cell: RepeatItem<DshrcChoiceItem>): void => {
          ChoiceRow({
            item: cell.item,
            group: this.group,
            selected: cell.item.id === this.selectedId,
            onSelect: (id: string): void => {
              this.onSelect(id);
            }
          })
        })
        .key((c: DshrcChoiceItem): string => c.id)
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
  }
}

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// @Route({ name: 'new_session' })
@ComponentV2
export struct NewSessionPage {
  @Local store: SessionStore = sessionStore;
  /** 会话标题（可留空 → 主机取默认）。 */
  @Local title: string = '';
  /** 工作目录（可留空 → 主机默认目录）。 */
  @Local cwd: string = '';
  /** 选中的模式 id（宿主 Agent preset id；空串 = 不传）。 */
  @Local selectedPresetId: string = '';
  /** 选中的权限 id（宿主 permission preset id；空串 = 不传）。 */
  @Local selectedPermissionId: string = '';
  /** 创建中（防重复提交）。 */
  @Local creating: boolean = false;

  aboutToAppear(): void {
    this.syncDefaults();
    // 目录未拉取过（首次进入 / 旧插件）→ 拉一次；离线时 loadCapabilities 直接空转，
    // 选择区保持隐藏（宿主不支持能力目录时数组为空）。
    if (!this.store.capabilitiesLoaded) {
      this.store.loadCapabilities().then((): void => {
        this.syncDefaults();
      });
    }
  }

  /** 目录到位后写入默认选中项（宿主给的 default 优先，否则第一项；用户已选过则不覆盖）。 */
  private syncDefaults(): void {
    const presets: DshrcModeOption[] = this.store.presets;
    if (presets.length > 0 && this.selectedPresetId.length === 0) {
      this.selectedPresetId = resolvePresetId(presets, this.store.defaultPresetId);
    }
    const permissions: DshrcPermissionOption[] = this.store.permissions;
    if (permissions.length > 0 && this.selectedPermissionId.length === 0) {
      this.selectedPermissionId = resolvePermissionId(permissions, this.store.defaultPermissionId);
    }
  }

  /** 选中模式（单选）。 */
  private selectPreset(id: string): void {
    this.selectedPresetId = id;
  }

  /** 选中权限（单选）。 */
  private selectPermission(id: string): void {
    this.selectedPermissionId = id;
  }

  /** 创建会话：带所选模式/权限；宿主不支持时回退为「不带选项」重试一次。 */
  private createSession(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在连接管理页连接主机', duration: 2500 });
      return;
    }
    if (this.creating) {
      return;
    }
    this.creating = true;
    const title: string = this.title.trim();
    const cwd: string = this.cwd.trim();
    const presetId: string = this.selectedPresetId;
    const permissionId: string = this.selectedPermissionId;
    dshrcLink.sessionCreate(title, presetId, permissionId, cwd).then((sid: string): void => {
      this.creating = false;
      if (sid.length > 0) {
        this.gotoCreated(sid);
      } else {
        promptAction.showToast({ message: '主机未返回会话 id', duration: 2500 });
      }
    }).catch((e: Error): void => {
      this.creating = false;
      const msg: string = e !== undefined && e.message !== undefined ? e.message : '未知错误';
      if (isUnsupportedError(msg)) {
        // 回退：宿主不认识所选模式/权限 → 不带选项再创建一次
        dshrcLink.sessionCreate(title, '', '', cwd).then((sid2: string): void => {
          if (sid2.length > 0) {
            promptAction.showToast({ message: '主机不支持所选模式/权限，已用默认创建', duration: 2500 });
            this.gotoCreated(sid2);
          } else {
            promptAction.showToast({ message: '主机未返回会话 id', duration: 2500 });
          }
        }).catch((e2: Error): void => {
          const msg2: string = e2 !== undefined && e2.message !== undefined ? e2.message : '未知错误';
          promptAction.showToast({ message: '创建失败：' + msg2, duration: 3000 });
        });
      } else {
        promptAction.showToast({ message: '创建失败：' + msg, duration: 3000 });
      }
    });
  }

  /** 创建成功 → 跳会话详情，并把本页（表单）弹掉：返回键不会回到表单。
   *  注意顺序：先弹本页再 push 详情——hrouter 的 push 是同步入栈，
   *  若先 push 再 pop，被弹掉的是刚 push 的详情页（表单会留在栈顶）。 */
  private gotoCreated(sid: string): void {
    goBack();
    openSessionDetail(sid);
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
      Text('新建会话')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .margin({ left: SP_3 })
        .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      Scroll() {
        Column() {
          TextFieldCard({
            label: '标题',
            hint: '给会话起个名字（可留空）',
            value: this.title,
            onInput: (v: string): void => {
              this.title = v;
            }
          })
          TextFieldCard({
            label: '工作目录',
            hint: '留空则用主机默认目录',
            value: this.cwd,
            onInput: (v: string): void => {
              this.cwd = v;
            }
          })
          // 模式：目录为空（宿主不支持 / 旧插件）→ 整块隐藏
          if (this.store.presets.length > 0) {
            ChoiceGroupCard({
              title: '模式',
              hint: '决定这个会话运行哪套工具组合',
              items: presetItems(this.store.presets),
              group: 'mode',
              selectedId: this.selectedPresetId,
              onSelect: (id: string): void => {
                this.selectPreset(id);
              }
            })
          }
          // 权限：目录为空 → 整块隐藏
          if (this.store.permissions.length > 0) {
            ChoiceGroupCard({
              title: '权限',
              hint: '权限决定主机上可执行的操作范围',
              items: permissionItems(this.store.permissions),
              group: 'permission',
              selectedId: this.selectedPermissionId,
              onSelect: (id: string): void => {
                this.selectPermission(id);
              }
            })
          }

          Button('创建会话')
            .width('100%')
            .height(46)
            .margin({ top: SP_5 })
            .fontSize(FS_BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.label_on_brand'))
            .backgroundColor($r('app.color.brand_fill'))
            .borderRadius(RADIUS_CTRL)
            .enabled(!this.creating)
            .onClick((): void => {
              this.createSession();
            })
          if (this.creating) {
            Text('正在创建…')
              .fontSize(FS_CAPTION)
              .fontColor($r('app.color.label_secondary'))
              .width('100%')
              .margin({ top: SP_2 })
              .textAlign(TextAlign.Center)
          }
          Blank().height(SP_4)
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2 })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
  }
}
