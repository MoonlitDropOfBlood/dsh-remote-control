/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页（任务内容 + 工作目录 / 模型+思考强度 / 模式 / 权限，契约 §5.8 v1.0.8）。
 *  - 首条任务：多行输入（标题由 DSH 自动生成，客户端不填标题）
 *  - 工作目录：下拉选择（主机默认目录 + 已有会话用过的 cwd，去重 + 最近使用在前）
 *  - 模型 + 思考强度：同一张卡里的两个下拉（模型无 efforts → 强度整行不渲染）
 *  - 模式（Host Agent preset）/ 权限（permission preset）：下拉选择；宿主不支持 → 整块隐藏
 *  - 创建：session.create('', preset, permission, cwd, model) → （有附件先分块上传）→ session.prompt(sid, 首条消息)
 *    附件-only 合法；附件 wire 仍走契约 §5.11，session.create 本身不扩展字段
 *    宿主拒绝模式/权限（错误含 unsupported）→ 回退「只去掉 preset/permission，保留 cwd 与模型」再创建一次
 *    create 成功但模型设置失败（result.modelError）→ toast 提示后继续 prompt，**不得重复创建**
 *    create 成功但上传/prompt 失败 → 草稿移交详情页 + toast，不留在表单诱导重复创建
 *  - 页面本体保持普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
 */
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { dshrcLink } from '../model/link';
import {
  DshrcCreateResult,
  DshrcModeOption,
  DshrcModelOption,
  DshrcModelSelection,
  DshrcPermissionOption,
  DshrcPromptResult
} from '../model/protocol';
import {
  AttachmentPickResult,
  DraftAttachment,
  checkNewAttachment,
  pickFiles,
  pickImages,
  releaseAttachmentPayload,
  uploadDraftAttachment
} from '../model/attachments';
import { AttachmentCaps, AttachmentCheck, formatAttachmentSize } from '../model/attachment-plan';
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
  /** 首条消息的附件草稿（契约 §5.11：create 后用新 sessionId 上传）。 */
  @Local attachments: DraftAttachment[] = [];
  /** 上传阶段标记与进度文案；创建/上传/首发期间禁止重复提交。 */
  @Local uploading: boolean = false;
  @Local uploadLabel: string = '';

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

  /** 离开未提交的新建页时释放本地字节；失败移交前已清空本页数组，不会误释放详情页草稿。 */
  aboutToDisappear(): void {
    for (let i: number = 0; i < this.attachments.length; i++) {
      releaseAttachmentPayload(this.attachments[i].localId);
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

  /** 统一 toast（附件与创建流程共用）。 */
  private toast(message: string): void {
    promptAction.showToast({ message: message, duration: 3000 });
  }

  /** 宿主附件能力（旧宿主没有 capabilities.attachments 时隐藏入口）。 */
  private attachmentEntryVisible(): boolean {
    return this.store.attachmentsSupported();
  }

  private attachmentLimits(): AttachmentCaps {
    return this.store.attachmentLimits();
  }

  private remainingSlots(): number {
    const left: number = this.attachmentLimits().maxCount - this.attachments.length;
    return left > 0 ? left : 0;
  }

  /** 「+」菜单：与详情页一样选图片或文件，不把 base64 塞进 prompt。 */
  private plusMenuItems(): MenuElement[] {
    const items: MenuElement[] = [
      {
        value: '图片',
        action: (): void => {
          this.chooseAttachments('image');
        }
      },
      {
        value: '文件',
        action: (): void => {
          this.chooseAttachments('file');
        }
      }
    ];
    return items;
  }

  private chooseAttachments(kind: string): void {
    if (this.creating) {
      return;
    }
    if (!this.attachmentEntryVisible()) {
      this.toast('当前主机不支持附件');
      return;
    }
    const remaining: number = this.remainingSlots();
    if (remaining <= 0) {
      this.toast('附件数量已达上限');
      return;
    }
    const ctx: common.Context = getContext(this) as common.Context;
    const caps: AttachmentCaps = this.attachmentLimits();
    const task: Promise<AttachmentPickResult> = kind === 'image' ?
      pickImages(ctx, remaining, caps) : pickFiles(ctx, remaining, caps);
    task.then((result: AttachmentPickResult): void => {
      this.applyPicked(result);
    }).catch((e: Error): void => {
      this.toast('选择附件失败：' + e.message);
    });
  }

  /** 逐项校验数量/单项/合计上限；被拒项立即释放字节。 */
  private applyPicked(result: AttachmentPickResult): void {
    const caps: AttachmentCaps = this.attachmentLimits();
    let rejected: string = '';
    for (let i: number = 0; i < result.items.length; i++) {
      const item: DraftAttachment = result.items[i];
      const check: AttachmentCheck = checkNewAttachment(this.attachments, item, caps);
      if (!check.ok) {
        rejected = check.message;
        releaseAttachmentPayload(item.localId);
        continue;
      }
      this.attachments = this.attachments.concat([item]);
    }
    if (rejected.length > 0) {
      this.toast(rejected);
    } else if (result.error.length > 0) {
      this.toast(result.error);
    }
  }

  private removeAttachment(item: DraftAttachment): void {
    if (this.creating) {
      return;
    }
    const next: DraftAttachment[] = [];
    for (let i: number = 0; i < this.attachments.length; i++) {
      if (this.attachments[i].localId !== item.localId) {
        next.push(this.attachments[i]);
      }
    }
    this.attachments = next;
    releaseAttachmentPayload(item.localId);
  }

  /** 同一 uploadId 只允许一条 chunk 流，必须串行上传（契约 §5.11.2）。 */
  private async uploadAllAttachments(sid: string, items: DraftAttachment[],
    caps: AttachmentCaps): Promise<string[]> {
    const uploadIds: string[] = [];
    for (let i: number = 0; i < items.length; i++) {
      const item: DraftAttachment = items[i];
      this.uploadLabel = '正在上传附件 ' + (i + 1).toString() + '/' + items.length.toString() + '…';
      item.uploading = true;
      item.progress = 0;
      try {
        const uploadId: string = await uploadDraftAttachment(sid, item, caps, (p: number): void => {
          item.progress = p;
        });
        uploadIds.push(uploadId);
      } finally {
        item.uploading = false;
      }
    }
    return uploadIds;
  }

  private canCreate(): boolean {
    if (this.creating || this.uploading) {
      return false;
    }
    return this.initialPrompt.trim().length > 0 || this.attachments.length > 0;
  }

  private creatingLabel(): string {
    return this.uploadLabel.length > 0 ? this.uploadLabel : '正在创建并发送…';
  }

  /** 模式/权限不支持时只去掉这两项，cwd 与模型必须保留。 */
  private async createSession(cwd: string, presetId: string, permissionId: string,
    model: DshrcModelSelection | undefined): Promise<DshrcCreateResult> {
    try {
      return await dshrcLink.sessionCreate('', presetId, permissionId, cwd, model);
    } catch (e) {
      const err: Error = e as Error;
      if (!isUnsupportedError(err.message)) {
        throw err;
      }
      const fallback: DshrcCreateResult = await dshrcLink.sessionCreate('', '', '', cwd, model);
      this.toast('主机不支持所选模式/权限，已用默认创建');
      return fallback;
    }
  }

  /** 创建会话并发送首条消息；附件-only 与「文字 + 附件」都合法。 */
  private async createAndSend(): Promise<void> {
    if (this.creating || this.uploading) {
      return;
    }
    if (this.store.linkState !== 'online') {
      this.toast('未连接，请先在连接管理页连接主机');
      return;
    }
    const prompt: string = this.initialPrompt.trim();
    const items: DraftAttachment[] = this.attachments.slice();
    if (prompt.length === 0 && items.length === 0) {
      this.toast('请填写任务内容或选择附件');
      return;
    }
    if (items.length > 0 && !this.attachmentEntryVisible()) {
      this.toast('当前主机不支持附件，请移除附件后再创建');
      return;
    }
    this.creating = true;
    this.uploadLabel = '';
    const cwd: string = this.selectedCwd;
    const presetId: string = validPresetId(this.store.presets, this.selectedPresetId);
    const permissionId: string = validPermissionId(this.store.permissions, this.selectedPermissionId);
    const model: DshrcModelSelection | undefined =
      modelSelectionOf(this.store.models, this.selectedModelId, this.selectedEffortId);
    try {
      const res: DshrcCreateResult = await this.createSession(cwd, presetId, permissionId, model);
      if (res.sessionId.length === 0) {
        throw new Error('主机未返回会话 id');
      }
      if (res.modelError) {
        // 会话已建成，不能因模型设置失败而重复 create。
        this.toast('会话已创建，模型设置失败，将使用默认模型');
      }
      await this.sendFirstPrompt(res.sessionId, prompt, items);
    } catch (e) {
      this.creating = false;
      this.uploading = false;
      this.uploadLabel = '';
      const err: Error = e as Error;
      this.toast('创建失败：' + err.message);
    }
  }

  /**
   * 首发严格按契约 §5.11：先有 sessionId，再串行上传，最后带 uploads 发 prompt。
   * 失败草稿会移交给详情页；本函数不重复 create。
   */
  private async sendFirstPrompt(sid: string, text: string, items: DraftAttachment[]): Promise<void> {
    try {
      let res: DshrcPromptResult;
      if (items.length > 0) {
        this.uploading = true;
        this.uploadLabel = '正在准备附件…';
        const caps: AttachmentCaps = this.attachmentLimits();
        const uploadIds: string[] = await this.uploadAllAttachments(sid, items, caps);
        this.uploadLabel = '正在发送首条消息…';
        res = await dshrcLink.sessionPromptResult(sid, text, uploadIds);
      } else {
        this.uploadLabel = '正在发送首条消息…';
        res = await dshrcLink.sessionPromptResult(sid, text);
      }
      if (!res.accepted) {
        this.failFirstPrompt(sid, text, items, '宿主未接受首条消息');
        return;
      }
      this.creating = false;
      this.uploading = false;
      this.uploadLabel = '';
      this.initialPrompt = '';
      this.attachments = [];
      for (let i: number = 0; i < items.length; i++) {
        releaseAttachmentPayload(items[i].localId);
      }
      this.gotoCreated(sid);
    } catch (e) {
      const err: Error = e as Error;
      const message: string = err.message.length > 0 ? err.message : '未知错误';
      if (message.indexOf('attachment-upload-expired') >= 0 || message.indexOf('attachment-upload-not-found') >= 0) {
        for (let i: number = 0; i < items.length; i++) {
          items[i].uploadId = '';
        }
      }
      this.failFirstPrompt(sid, text, items, message);
    }
  }

  /** 会话已创建：草稿一次性移交详情页，本页清空但**不释放**移交出去的附件字节。 */
  private failFirstPrompt(sid: string, text: string, items: DraftAttachment[], message: string): void {
    this.store.stashFirstPromptDraft(sid, text, items);
    this.initialPrompt = '';
    this.attachments = [];
    this.creating = false;
    this.uploading = false;
    this.uploadLabel = '';
    this.toast('会话已创建，首条消息发送失败：' + message + '。请在详情页重试');
    this.gotoCreated(sid);
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
      .enabled(!this.creating)
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

  /** 已选附件 chips（Repeat + 业务 localId；图片缩略图 / 文件卡）。 */
  @Builder
  attachmentChips() {
    Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start, alignItems: ItemAlign.Start }) {
      Repeat(this.attachments)
        .each((cell: RepeatItem<DraftAttachment>): void => {
          this.attachmentChip(cell)
        })
        .key((item: DraftAttachment): string => item.localId)
    }
    .width('100%')
    .padding({ top: SP_2 })
  }

  @Builder
  attachmentChip(cell: RepeatItem<DraftAttachment>) {
    Stack({ alignContent: Alignment.TopEnd }) {
      if (cell.item.isImage()) {
        Stack({ alignContent: Alignment.Center }) {
          Image(cell.item.thumb)
            .width(60)
            .height(60)
            .objectFit(ImageFit.Cover)
            .borderRadius(RADIUS_CARD)
            .backgroundColor($r('app.color.bg_layer_2'))
            .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          if (cell.item.uploading) {
            Column() {
              Text(this.progressText(cell.item))
                .fontSize(FS_CAPTION)
                .fontColor($r('app.color.label_on_brand'))
            }
            .width(60)
            .height(60)
            .justifyContent(FlexAlign.Center)
            .alignItems(HorizontalAlign.Center)
            .borderRadius(RADIUS_CARD)
            .backgroundColor($r('app.color.scrim'))
          }
        }
        .width(60)
        .height(60)
      } else {
        Row({ space: SP_2 }) {
          Stack({ alignContent: Alignment.Center }) {
            SymbolGlyph($r('sys.symbol.doc_plaintext_fill_1'))
              .fontSize(18)
              .fontColor([$r('app.color.label_secondary')])
              .width(18)
              .height(18)
          }
          .width(32)
          .height(32)
          .backgroundColor($r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          .borderRadius(RADIUS_CTRL)

          Column({ space: 2 }) {
            Text(cell.item.name.length > 0 ? cell.item.name : '附件')
              .fontSize(FS_SMALL)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.label_primary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(cell.item.uploading ? this.progressText(cell.item) : formatAttachmentSize(cell.item.bytes))
              .fontSize(FS_CAPTION)
              .fontColor($r('app.color.label_tertiary'))
              .maxLines(1)
          }
          .alignItems(HorizontalAlign.Start)
          .constraintSize({ maxWidth: 150 })
        }
        .padding({ left: SP_2, right: SP_5, top: SP_2, bottom: SP_2 })
        .height(60)
        .alignItems(VerticalAlign.Center)
        .backgroundColor($r('app.color.bg_layer_2'))
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .borderRadius(RADIUS_CARD)
      }
      Button() {
        SymbolGlyph($r('sys.symbol.xmark'))
          .fontSize(11)
          .fontColor([$r('app.color.label_on_brand')])
          .width(11)
          .height(11)
      }
      .type(ButtonType.Circle)
      .width(20)
      .height(20)
      .backgroundColor($r('app.color.scrim'))
      .border({ width: 1, color: $r('app.color.bg_layer_1') })
      .margin({ top: 2, right: 2 })
      .enabled(!this.creating)
      .onClick((): void => {
        this.removeAttachment(cell.item);
      })
    }
    .margin({ right: SP_2, bottom: SP_2 })
  }

  private progressText(item: DraftAttachment): string {
    const pct: number = Math.round(item.progress * 100);
    const clamped: number = pct < 0 ? 0 : (pct > 100 ? 100 : pct);
    return clamped.toString() + '%';
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
        .enabled(!this.creating)
      if (this.attachmentEntryVisible()) {
        Row({ space: SP_2 }) {
          Button() {
            SymbolGlyph($r('sys.symbol.plus'))
              .fontSize(18)
              .fontColor([$r('app.color.label_secondary')])
              .width(20)
              .height(20)
          }
          .type(ButtonType.Circle)
          .width(34)
          .height(34)
          .backgroundColor($r('app.color.bg_layer_2'))
          .enabled(!this.creating)
          .bindMenu(this.plusMenuItems())
          Text('添加图片或文件（可只发附件）')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .margin({ top: SP_2 })
        if (this.attachments.length > 0) {
          this.attachmentChips()
        }
      }
      if (this.initialPrompt.trim().length === 0 && this.attachments.length === 0) {
        Text('请填写任务内容或选择附件')
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
            hint: '会话在主机上的工作位置，默认使用 ~/.dsh/remote',
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
          .enabled(this.canCreate())
          .onClick((): void => {
            this.createAndSend();
          })
        if (this.creating) {
          Text(this.creatingLabel())
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
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
