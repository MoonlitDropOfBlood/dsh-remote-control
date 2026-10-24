/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页（任务内容 + 工作目录 / 模型+思考强度 / 模式 / 权限，契约 §5.8 v1.0.8）。
 *  - 首条任务：多行输入（标题由 DSH 自动生成，客户端不填标题）
 *  - 工作目录：下拉选择（主机默认目录 + 已有会话用过的 cwd，去重 + 最近使用在前）
 *  - 模型 + 思考强度：同一张卡里的两个下拉（模型无 efforts → 强度整行不渲染）
 *  - 模式（Host Agent preset）/ 权限（permission preset）：下拉选择；宿主不支持 → 整块隐藏
 *  - 创建：session.create('', preset, permission, cwd, model) → session.prompt(sid, 首条消息)
 *    宿主拒绝模式/权限（错误含 unsupported）→ 回退「只去掉 preset/permission，保留 cwd 与模型」再创建一次
 *    create 成功但模型设置失败（result.modelError）→ toast 提示后继续 prompt，**不得重复创建**
 *    create 成功但 prompt 失败 → 照样进详情页 + toast，不留在表单诱导重复创建
 *  - 页面本体保持普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
 */
import { promptAction } from '@kit.ArkUI';
import { dshrcLink } from '../model/link';
import {
  DshrcCreateResult,
  DshrcModeOption,
  DshrcModelOption,
  DshrcModelSelection,
  DshrcPermissionOption
} from '../model/protocol';
import {
  DshrcChoiceItem,
  directoryItems,
  effortItems,
  isUnsupportedError,
  modelItems,
  modelSelectionOf,
  permissionItems,
  presetItems,
  resolveEffortId,
  resolveModelId,
  resolvePermissionId,
  resolvePresetId,
  validModelId,
  validPermissionId,
  validPresetId
} from '../model/newsession';
import { goBack, openSessionDetail } from '../model/routes';
import { SessionStore, sessionStore } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SUBTITLE,
  HAIRLINE,
  RADIUS_CARD,
  RADIUS_CTRL,
  SP_1,
  SP_2,
  SP_3,
  SP_4
} from '../model/theme';

/** 下拉行（标题 + 说明 + Select）。
 *  选项文案 = item.name；回传按 index 反查 item.id（避免同名歧义）。
 *  可单独成卡（SelectFieldCard），也可内嵌在同一张卡里（模型 + 思考强度）。 */
@ComponentV2
struct SelectRow {
  @Param label: string = '';
  @Param hint: string = '';
  @Require @Param items: DshrcChoiceItem[];
  @Param selectedId: string = '';
  @Event onSelect: (id: string) => void;

  /** 下拉选项（显示文案）。 */
  private options(): SelectOption[] {
    const out: SelectOption[] = [];
    for (let i: number = 0; i < this.items.length; i++) {
      out.push({ value: this.items[i].name });
    }
    return out;
  }

  /** 当前选中下标（找不到 → 第一项；空列表 → -1）。 */
  private selectedIndex(): number {
    for (let i: number = 0; i < this.items.length; i++) {
      if (this.items[i].id === this.selectedId) {
        return i;
      }
    }
    return this.items.length > 0 ? 0 : -1;
  }

  /** 当前选中项文案。 */
  private selectedLabel(): string {
    const idx: number = this.selectedIndex();
    return idx >= 0 ? this.items[idx].name : '';
  }

  /** 按下标取候选项（越界 → undefined）。 */
  private itemAt(index: number): DshrcChoiceItem | undefined {
    if (index < 0 || index >= this.items.length) {
      return undefined;
    }
    return this.items[index];
  }

  build() {
    Column() {
      Text(this.label)
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_primary'))
        .width('100%')
      Text(this.hint)
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_secondary'))
        .width('100%')
        .margin({ top: SP_1 })
      if (this.items.length > 0) {
        Select(this.options())
          .selected(this.selectedIndex())
          .value(this.selectedLabel())
          .fontColor($r('app.color.label_primary'))
          .selectedOptionFontColor($r('app.color.brand_label'))
          .optionFontColor($r('app.color.label_primary'))
          .menuBackgroundColor($r('app.color.bg_layer_1'))
          .onSelect((index: number): void => {
            const item: DshrcChoiceItem | undefined = this.itemAt(index);
            if (item !== undefined) {
              this.onSelect(item.id);
            }
          })
          .width('100%')
          .margin({ top: SP_2 })
      }
    }
    .width('100%')
  }
}

/** 单个下拉配置的卡片（工作目录 / 模式 / 权限）。 */
@ComponentV2
struct SelectFieldCard {
  @Param label: string = '';
  @Param hint: string = '';
  @Require @Param items: DshrcChoiceItem[];
  @Param selectedId: string = '';
  @Event onSelect: (id: string) => void;

  build() {
    Column() {
      SelectRow({
        label: this.label,
        hint: this.hint,
        items: this.items,
        selectedId: this.selectedId,
        onSelect: (id: string): void => {
          this.onSelect(id);
        }
      })
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
  }
}

/** 模型卡片：模型下拉 + 思考强度下拉。
 *  契约 §5.8 v1.0.8：所选模型没有 efforts（不支持思考强度）→ 强度整行不渲染。 */
@ComponentV2
struct ModelFieldCard {
  @Require @Param models: DshrcChoiceItem[];
  @Param modelId: string = '';
  @Require @Param efforts: DshrcChoiceItem[];
  @Param effortId: string = '';
  @Event onModel: (id: string) => void;
  @Event onEffort: (id: string) => void;

  build() {
    Column() {
      SelectRow({
        label: '模型',
        hint: '决定这个会话使用的模型与思考强度',
        items: this.models,
        selectedId: this.modelId,
        onSelect: (id: string): void => {
          this.onModel(id);
        }
      })
      if (this.efforts.length > 0) {
        Divider()
          .color($r('app.color.border_l1'))
          .width('100%')
          .margin({ top: SP_3, bottom: SP_3 })
        SelectRow({
          label: '思考强度',
          hint: '决定模型的思考强度，默认档交给宿主',
          items: this.efforts,
          selectedId: this.effortId,
          onSelect: (id: string): void => {
            this.onEffort(id);
          }
        })
      }
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
  /** 首条任务内容（创建成功后自动发给新会话）。 */
  @Local initialPrompt: string = '';
  /** 选中的工作目录（'' = 主机默认目录）。 */
  @Local selectedCwd: string = '';
  /** 选中的模型 id（宿主 model catalog id；空串 = 不传，宿主用默认模型）。 */
  @Local selectedModelId: string = '';
  /** 选中的思考强度 id（'' = 默认档 → 提交不带 reasoningEffort，交给宿主）。 */
  @Local selectedEffortId: string = '';
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

  /** 目录到位后写入默认选中项（宿主给的 default 优先，否则第一项）。
   *  仅在“当前选中项不在目录里”时改写——用户手动选过且仍有效则保留。 */
  private syncDefaults(): void {
    const models: DshrcModelOption[] = this.store.models;
    if (models.length > 0 && validModelId(models, this.selectedModelId).length === 0) {
      this.selectedModelId = resolveModelId(models, this.store.defaultModelId);
    }
    // 思考强度：换了模型 / 当前档不在新模型的合法集合（含「默认」档）→ 重置为该模型默认
    if (!this.effortValid()) {
      this.selectedEffortId = resolveEffortId(models, this.selectedModelId);
    }
    const presets: DshrcModeOption[] = this.store.presets;
    if (presets.length > 0 && validPresetId(presets, this.selectedPresetId).length === 0) {
      this.selectedPresetId = resolvePresetId(presets, this.store.defaultPresetId);
    }
    const permissions: DshrcPermissionOption[] = this.store.permissions;
    if (permissions.length > 0 && validPermissionId(permissions, this.selectedPermissionId).length === 0) {
      this.selectedPermissionId = resolvePermissionId(permissions, this.store.defaultPermissionId);
    }
  }

  /** 工作目录候选（主机默认目录 + 已有会话 cwd；当前已选值始终保留）。 */
  private dirItems(): DshrcChoiceItem[] {
    return directoryItems(this.store.listItems(), this.selectedCwd);
  }

  /** 思考强度候选（所选模型的 efforts；无 efforts → 空数组 → 该行不渲染）。 */
  private effortItemList(): DshrcChoiceItem[] {
    return effortItems(this.store.models, this.selectedModelId);
  }

  /** 当前思考强度是否仍属于所选模型的合法集合（含「默认」档 id=''）。 */
  private effortValid(): boolean {
    const items: DshrcChoiceItem[] = this.effortItemList();
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].id === this.selectedEffortId) {
        return true;
      }
    }
    return false;
  }

  /** 切换模型 → 思考强度重置为新模型的默认档（契约 §5.8 v1.0.8）。 */
  private selectModel(id: string): void {
    if (id === this.selectedModelId) {
      return;
    }
    this.selectedModelId = id;
    this.selectedEffortId = resolveEffortId(this.store.models, id);
  }

  /** 选中思考强度（'' = 默认档 → 提交不带 reasoningEffort）。 */
  private selectEffort(id: string): void {
    this.selectedEffortId = id;
  }

  /** 创建会话并发送首条消息。 */
  private createAndSend(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在连接管理页连接主机', duration: 2500 });
      return;
    }
    const prompt: string = this.initialPrompt.trim();
    if (prompt.length === 0) {
      promptAction.showToast({ message: '请先填写任务内容', duration: 2000 });
      return;
    }
    if (this.creating) {
      return;
    }
    this.creating = true;
    const cwd: string = this.selectedCwd;
    const presetId: string = validPresetId(this.store.presets, this.selectedPresetId);
    const permissionId: string = validPermissionId(this.store.permissions, this.selectedPermissionId);
    // 模型提交值按目录项本身构造（不从 id 反拆）；思考强度命中 efforts 才带；
    // 没选中模型 → undefined（不提交 model，宿主用默认模型）
    const model: DshrcModelSelection | undefined =
      modelSelectionOf(this.store.models, this.selectedModelId, this.selectedEffortId);
    // 标题由 DSH 自动生成 → 一律传空串
    dshrcLink.sessionCreate('', presetId, permissionId, cwd, model).then((res: DshrcCreateResult): void => {
      if (res.sessionId.length === 0) {
        this.creating = false;
        promptAction.showToast({ message: '主机未返回会话 id', duration: 2500 });
        return;
      }
      if (res.modelError) {
        // 会话已建成、但模型设置失败：提示后继续发首条消息（**不得重复创建**）
        promptAction.showToast({ message: '会话已创建，模型设置失败，将使用默认模型', duration: 3000 });
      }
      this.sendFirstPrompt(res.sessionId, prompt);
    }).catch((e: Error): void => {
      const msg: string = e !== undefined && e.message !== undefined ? e.message : '未知错误';
      if (isUnsupportedError(msg)) {
        // 回退：宿主不认识所选模式/权限 → 只去掉 preset/permission，保留 cwd 与模型
        dshrcLink.sessionCreate('', '', '', cwd, model).then((res2: DshrcCreateResult): void => {
          if (res2.sessionId.length === 0) {
            this.creating = false;
            promptAction.showToast({ message: '主机未返回会话 id', duration: 2500 });
            return;
          }
          promptAction.showToast({ message: '主机不支持所选模式/权限，已用默认创建', duration: 2500 });
          if (res2.modelError) {
            promptAction.showToast({ message: '会话已创建，模型设置失败，将使用默认模型', duration: 3000 });
          }
          this.sendFirstPrompt(res2.sessionId, prompt);
        }).catch((e2: Error): void => {
          this.creating = false;
          const msg2: string = e2 !== undefined && e2.message !== undefined ? e2.message : '未知错误';
          promptAction.showToast({ message: '创建失败：' + msg2, duration: 3000 });
        });
      } else {
        this.creating = false;
        promptAction.showToast({ message: '创建失败：' + msg, duration: 3000 });
      }
    });
  }

  /** 发送首条消息：无论成功与否都进详情页（失败只 toast，不留在表单重复创建）。 */
  private sendFirstPrompt(sid: string, text: string): void {
    dshrcLink.sessionPrompt(sid, text).then((accepted: boolean): void => {
      this.creating = false;
      if (!accepted) {
        promptAction.showToast({ message: '会话已创建，首条消息发送失败，请重试', duration: 3000 });
      }
      this.gotoCreated(sid);
    }).catch((e: Error): void => {
      this.creating = false;
      promptAction.showToast({ message: '会话已创建，首条消息发送失败，请重试', duration: 3000 });
      this.gotoCreated(sid);
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

  /** 首条任务输入卡片。 */
  @Builder
  taskCard() {
    Column() {
      Text('任务内容')
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_primary'))
        .width('100%')
      Text('会话标题由 DSH 自动生成，这里写下这次要完成的事')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_secondary'))
        .width('100%')
        .margin({ top: SP_1 })
      TextArea({ text: this.initialPrompt, placeholder: '描述这次要完成的任务，创建后立即发送…' })
        .onChange((v: string): void => {
          this.initialPrompt = v;
        })
        .width('100%')
        .height(150)
        .margin({ top: SP_2 })
        .padding({ left: SP_3, right: SP_3, top: SP_2, bottom: SP_2 })
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
        .placeholderColor($r('app.color.label_tertiary'))
        .caretColor($r('app.color.brand_fill'))
      if (this.initialPrompt.trim().length === 0) {
        Text('任务内容不能为空')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .margin({ top: SP_2 })
      }
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      Scroll() {
        Column({ space: SP_3 }) {
          this.taskCard()
          SelectFieldCard({
            label: '工作目录',
            hint: '会话在主机上的工作位置，留空用主机默认目录',
            items: this.dirItems(),
            selectedId: this.selectedCwd,
            onSelect: (id: string): void => {
              this.selectedCwd = id;
            }
          })
          // 模型 + 思考强度：目录为空（宿主未提供 model catalog）→ 整块隐藏
          if (this.store.models.length > 0) {
            ModelFieldCard({
              models: modelItems(this.store.models),
              modelId: this.selectedModelId,
              efforts: this.effortItemList(),
              effortId: this.selectedEffortId,
              onModel: (id: string): void => {
                this.selectModel(id);
              },
              onEffort: (id: string): void => {
                this.selectEffort(id);
              }
            })
          }
          // 模式：目录为空（宿主不支持 / 旧插件）→ 整块隐藏
          if (this.store.presets.length > 0) {
            SelectFieldCard({
              label: '模式',
              hint: '决定这个会话运行哪套工具组合',
              items: presetItems(this.store.presets),
              selectedId: this.selectedPresetId,
              onSelect: (id: string): void => {
                this.selectedPresetId = id;
              }
            })
          }
          // 权限：目录为空 → 整块隐藏
          if (this.store.permissions.length > 0) {
            SelectFieldCard({
              label: '权限',
              hint: '权限决定主机上可执行的操作范围',
              items: permissionItems(this.store.permissions),
              selectedId: this.selectedPermissionId,
              onSelect: (id: string): void => {
                this.selectedPermissionId = id;
              }
            })
          }
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_4 })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .align(Alignment.Top)

      // 固定底栏：创建并发送
      Column() {
        Divider()
          .color($r('app.color.border_l1'))
          .width('100%')
        Button('创建并发送')
          .width('100%')
          .height(46)
          .margin({ top: SP_3 })
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_on_brand'))
          .backgroundColor($r('app.color.brand_fill'))
          .borderRadius(RADIUS_CTRL)
          .enabled(!this.creating && this.initialPrompt.trim().length > 0)
          .onClick((): void => {
            this.createAndSend();
          })
        if (this.creating) {
          Text('正在创建…')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .width('100%')
            .margin({ top: SP_2 })
            .textAlign(TextAlign.Center)
        }
      }
      .width('100%')
      .padding({ left: SP_4, right: SP_4, top: SP_3, bottom: SP_4 })
      .backgroundColor($r('app.color.bg_layer_1'))
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.bg_base'))
  }
}
