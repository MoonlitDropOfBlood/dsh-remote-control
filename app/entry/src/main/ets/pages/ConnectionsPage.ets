/*
 * Copyright (c) 2026 dukedsh.
 * 连接管理页（v1.0.6）：管理**多个**远程主机 + 当前连接状态。
 *  - 当前连接卡：链路状态灯 + 主机名 / DSH 版本 / 插件版本 + 「断开 / 连接」按钮 + KAT 自检指示
 *  - 远程列表：名称 / relay 地址 / channel + 「使用中」徽标 + 「编辑」「删除」；
 *    点行 = 切到该远程并连接（stop → start）
 *  - 新增远程：表单（名称 / 中继地址 / channel / secret / relayToken）+ 扫码配对
 *    （Scan Kit 默认界面 → parsePairQr，自动回填并保存连接，契约 §3.5）
 *  - 推送开关（本机 Preferences + push.register 上报状态，契约 §6）+ 关于入口
 *  - secret / relayToken 只进密码框，**绝不写日志**
 * 说明：页面本体是普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
 */
import { promptAction, ShowDialogSuccessResponse } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { scanBarcode } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { goBack, openAbout } from '../model/routes';
import { logDshrc } from '../model/logger';
import { runKatCheck } from '../model/crypto';
import { dshrcLink, LinkState } from '../model/link';
import { PairQrResult, parsePairQr } from '../model/pairqr';
import { PairingConfig, validatePairing } from '../model/store';
import {
  ConnectionStore,
  RemoteProfile,
  RemoteProfilePatch,
  connectionStore
} from '../model/connections';
import {
  SessionStore,
  loadPushEnabled,
  savePushEnabled,
  sessionStore
} from '../model/sessionstore';
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
  SP_5,
  linkBusy,
  linkStateColor,
  linkStateText
} from '../model/theme';
import { FieldInput } from './FieldInput';

/** 信息行（左标题右值）。 */
@ComponentV2
struct ConnInfoRow {
  @Param label: string = '';
  @Param value: string = '';

  build() {
    Row() {
      Text(this.label)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_secondary'))
      Blank()
      Text(this.value)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_primary'))
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: '62%' })
        .textAlign(TextAlign.End)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ top: SP_2, bottom: SP_2 })
  }
}

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// 页面本体保持普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
// @Route({ name: 'connections' })
@ComponentV2
export struct ConnectionsPage {
  @Local store: SessionStore = sessionStore;
  @Local conn: ConnectionStore = connectionStore;
  @Local katText: string = 'KAT 自检中…';
  @Local katOk: boolean = false;
  @Local pushEnabled: boolean = true;
  /** 远程表单是否展开。 */
  @Local showForm: boolean = false;
  /** 编辑中的远程 id（空串 = 新增）。 */
  @Local editingId: string = '';
  @Local formName: string = '';
  @Local formRelayUrl: string = '';
  @Local formChannel: string = '';
  @Local formSecret: string = '';
  @Local formRelayToken: string = '';
  /** 扫码提示行（空 = 不显示）；scanHintOk 决定用 state_success / state_error。 */
  @Local scanHint: string = '';
  @Local scanHintOk: boolean = false;

  aboutToAppear(): void {
    const ctx: common.Context = getContext(this) as common.Context;
    this.conn.load(ctx);
    this.pushEnabled = loadPushEnabled(ctx);
    this.store.pushLocalEnabled = this.pushEnabled;
    runKatCheck().then((text: string): void => {
      this.katText = text;
      this.katOk = text.startsWith('KAT 通过');
    });
  }

  /** 当前使用的远程名（未配置时兜底）。 */
  private remoteName(): string {
    const p: RemoteProfile | undefined = this.conn.activeProfile();
    if (p === undefined) {
      return '未配置';
    }
    const n: string = p.name.trim();
    return n.length > 0 ? n : '未配置';
  }

  /** 链路是否处于「已连上或正在连」。 */
  private linkActive(): boolean {
    const st: LinkState = this.store.linkState;
    return st === 'online' || st === 'connecting' || st === 'handshaking' ||
      st === 'deriving' || st === 'reconnecting';
  }

  /** 「断开 / 连接」切换：已连上则断开，否则连接当前远程。 */
  private onToggleLink(): void {
    if (this.linkActive()) {
      dshrcLink.stop();
      return;
    }
    const ctx: common.Context = getContext(this) as common.Context;
    const active: RemoteProfile | undefined = this.conn.activeProfile();
    if (active === undefined) {
      promptAction.showToast({ message: '还没有远程配置，点「新增远程」或扫码配对', duration: 2500 });
      return;
    }
    this.conn.activate(ctx, active.id);
  }

  /** 切换到某个远程并连接（点列表行）。 */
  private switchTo(id: string): void {
    const ctx: common.Context = getContext(this) as common.Context;
    this.conn.activate(ctx, id);
  }

  /** 展开「新增远程」表单。 */
  private onAddClick(): void {
    this.editingId = '';
    this.formName = '';
    this.formRelayUrl = '';
    this.formChannel = '';
    this.formSecret = '';
    this.formRelayToken = '';
    this.scanHint = '';
    this.showForm = true;
  }

  /** 展开「编辑远程」表单（回填当前值）。 */
  private onEditClick(p: RemoteProfile): void {
    this.editingId = p.id;
    this.formName = p.name;
    this.formRelayUrl = p.relayUrl;
    this.formChannel = p.channel;
    this.formSecret = p.secret;
    this.formRelayToken = p.relayToken;
    this.scanHint = '';
    this.showForm = true;
  }

  /** 收起表单。 */
  private closeForm(): void {
    this.showForm = false;
    this.editingId = '';
    this.scanHint = '';
  }

  /** 删除远程（二次确认）。 */
  private onDeleteClick(p: RemoteProfile): void {
    const buttons: promptAction.Button[] = [
      { text: '取消', color: $r('app.color.label_secondary') },
      { text: '删除', color: $r('app.color.state_error') }
    ];
    promptAction.showDialog({
      title: '删除远程',
      message: '确定删除「' + p.displayName() + '」？该远程的配对信息会从本机移除。',
      buttons: buttons
    }).then((res: ShowDialogSuccessResponse): void => {
      if (res.index === 1) {
        this.removeProfile(p);
      }
    }).catch((e: Error): void => {
      logDshrc('dshrc-connections', 'warn', 'delete dialog failed: ' + e.message);
    });
  }

  /** 真正删除（被删的是当前项时先断链，避免连着已删除的远程）。 */
  private removeProfile(p: RemoteProfile): void {
    if (p.id === this.conn.activeId) {
      dshrcLink.stop();
    }
    this.conn.remove(p.id);
    promptAction.showToast({ message: '已删除「' + p.displayName() + '」', duration: 2000 });
  }

  /**
   * 扫码配对（契约 §3.5）：Scan Kit 默认界面扫码。
   * 默认界面自带相机预授权（系统级 UI），无需 CAMERA 权限；
   * 调用包 try/catch 兜底设备兼容性（PC / 无后置相机设备上调用会同步/异步报错，
   * 等价于 canIUse 守卫——linter-cli 按 compatible SDK 10 解析不到 @since 11 的全局 canIUse）。
   */
  private onScanClick(): void {
    const ctx: common.Context = getContext(this) as common.Context;
    try {
      scanBarcode.startScanForResult(ctx).then((res: scanBarcode.ScanResult): void => {
        this.applyScanText(res.originalValue);
      }).catch((err: BusinessError): void => {
        // 取消（1000500002）/ 失败均静默回到本页（不打断输入），只记日志便于排障。
        logDshrc('dshrc-scan', 'warn',
          'startScanForResult failed: ' + err.code.toString() + ' ' + err.message);
      });
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc('dshrc-scan', 'warn',
        'startScanForResult threw: ' + err.code.toString() + ' ' + err.message);
      promptAction.showToast({ message: '当前设备不支持扫码功能', duration: 3000 });
    }
  }

  /**
   * 处理扫码文本：解析（§3.5 完整 URI / 裸 query 两种形态）→ 回填表单 → 成功即保存并连接；
   * 失败 Toast 明确原因并停留手动输入（已解析出的字段照常回填，不静默丢弃）。
   */
  private applyScanText(raw: string): void {
    const parsed: PairQrResult = parsePairQr(raw);
    if (parsed.cfg.relayUrl.length > 0) {
      this.formRelayUrl = parsed.cfg.relayUrl;
    }
    if (parsed.cfg.channel.length > 0) {
      this.formChannel = parsed.cfg.channel;
    }
    if (parsed.cfg.secret.length > 0) {
      this.formSecret = parsed.cfg.secret;
    }
    if (parsed.cfg.relayToken.length > 0) {
      this.formRelayToken = parsed.cfg.relayToken;
    }
    if (!parsed.ok) {
      this.scanHintOk = false;
      this.scanHint = '扫码未采用：' + parsed.reason + '（请核对后手动输入）';
      promptAction.showToast({ message: parsed.reason, duration: 3000 });
      this.showForm = true;
      return;
    }
    this.showForm = true;
    if (this.formName.trim().length === 0) {
      this.formName = '扫码远程';
    }
    this.scanHintOk = true;
    this.scanHint = '已扫码，正在保存并连接…';
    this.saveProfile();
  }

  /** 保存（新增或更新）当前远程：校验 → 落盘 → 连接。 */
  private saveProfile(): void {
    const cfg: PairingConfig = {
      relayUrl: this.formRelayUrl.trim(),
      channel: this.formChannel.trim(),
      secret: this.formSecret.trim(),
      relayToken: this.formRelayToken.trim()
    };
    const invalid: string = validatePairing(cfg);
    if (invalid.length > 0) {
      promptAction.showToast({ message: invalid, duration: 3000 });
      return;
    }
    const ctx: common.Context = getContext(this) as common.Context;
    let targetId: string = this.editingId;
    if (targetId.length > 0) {
      const patch: RemoteProfilePatch = {
        name: this.formName.trim().length > 0 ? this.formName.trim() : '未命名远程',
        relayUrl: cfg.relayUrl,
        channel: cfg.channel,
        secret: cfg.secret,
        relayToken: cfg.relayToken
      };
      this.conn.update(targetId, patch);
    } else {
      const p: RemoteProfile = new RemoteProfile();
      p.name = this.formName.trim().length > 0 ? this.formName.trim() : '未命名远程';
      p.relayUrl = cfg.relayUrl;
      p.channel = cfg.channel;
      p.secret = cfg.secret;
      p.relayToken = cfg.relayToken;
      this.conn.add(p);
      targetId = p.id;
    }
    this.closeForm();
    this.conn.activate(ctx, targetId);
    promptAction.showToast({ message: '已保存，正在连接…', duration: 2000 });
  }

  /** 推送开关：写本地状态 + 持久化 + 联动 token 上报。 */
  private onPushToggle(on: boolean): void {
    this.pushEnabled = on;
    this.store.setPushLocalEnabled(on);
    savePushEnabled(getContext(this) as common.Context, on);
  }

  /** 推送状态一行说明。 */
  private pushStatusText(): string {
    if (!this.pushEnabled) {
      return '已关闭 · 不再获取 / 上报推送 token';
    }
    const tk: string = this.store.pushToken;
    const brief: string = tk.length > 0 ? 'token ' + tk.substring(0, 8) + '…' : '未取到 token';
    let s: string = brief + (this.store.pushRegistered ? ' · 已上报主机' : ' · 未上报');
    if (this.store.linkState === 'online' && !this.store.pushRemoteEnabled) {
      s += ' · 主机侧未开通推送';
    }
    return s;
  }

  /** 顶栏：返回 + 标题。 */
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
      Text('连接')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .margin({ left: SP_3 })
        .layoutWeight(1)
      Text(this.remoteName())
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 140 })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  /** 当前连接卡：链路状态 + 主机信息 + 断开/连接按钮。 */
  @Builder
  currentCard() {
    Column() {
      Row() {
        Circle({ width: 10, height: 10 }).fill(linkStateColor(this.store.linkState))
        Text(linkStateText(this.store.linkState))
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .margin({ left: SP_2 })
        if (linkBusy(this.store.linkState)) {
          LoadingProgress()
            .width(16)
            .height(16)
            .color($r('app.color.brand_fill'))
            .margin({ left: SP_2 })
        }
        Blank()
        Row() {
          Circle({ width: 6, height: 6 })
            .fill(this.store.hostOnline ? $r('app.color.state_success') : $r('app.color.state_idle'))
          Text(this.store.hostOnline ? '主机在线' : '主机离线')
            .fontSize(FS_CAPTION)
            .fontColor(this.store.hostOnline ? $r('app.color.state_success') :
              $r('app.color.label_secondary'))
            .margin({ left: 5 })
        }
        .padding({ left: 8, right: 8, top: 4, bottom: 4 })
        .borderRadius(RADIUS_PILL)
        .backgroundColor(this.store.hostOnline ? $r('app.color.state_success_tint') :
          $r('app.color.state_idle_tint'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Divider().color($r('app.color.border_l1')).margin({ top: SP_3, bottom: SP_1 })
      ConnInfoRow({ label: '主机名', value: this.store.hostName.length > 0 ? this.store.hostName : '—' })
      ConnInfoRow({ label: 'DSH 版本', value: this.store.hostVersion.length > 0 ? this.store.hostVersion : '—' })
      ConnInfoRow({ label: '插件版本', value: this.store.pluginVersion.length > 0 ? this.store.pluginVersion : '—' })
      ConnInfoRow({ label: '当前远程', value: this.remoteName() })

      Button(this.linkActive() ? '断开' : '连接')
        .width('100%')
        .height(40)
        .margin({ top: SP_3 })
        .fontSize(FS_BODY)
        .fontColor(this.linkActive() ? $r('app.color.state_error') : $r('app.color.label_on_brand'))
        .backgroundColor(this.linkActive() ? $r('app.color.bg_layer_2') : $r('app.color.brand_fill'))
        .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
        .borderRadius(RADIUS_CTRL)
        .onClick((): void => {
          this.onToggleLink();
        })

      Text(this.katText)
        .fontSize(FS_CAPTION)
        .fontColor(this.katOk ? $r('app.color.state_success') : $r('app.color.state_warn'))
        .width('100%')
        .margin({ top: SP_2 })
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_3 })
  }

  /** 单个远程行：名称 / relay / channel + 使用中徽标 + 编辑 / 删除。 */
  @Builder
  remoteRow(p: RemoteProfile) {
    Row() {
      Column() {
        Row() {
          Text(p.displayName())
            .fontSize(FS_BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.label_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (p.id === this.conn.activeId) {
            Text('使用中')
              .fontSize(FS_CAPTION)
              .fontColor($r('app.color.brand_label'))
              .padding({ left: 8, right: 8, top: 3, bottom: 3 })
              .margin({ left: SP_2 })
              .borderRadius(RADIUS_PILL)
              .backgroundColor($r('app.color.brand_tint'))
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text(p.relayUrl)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: SP_1 })

        Text('channel ' + p.channel)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .onClick((): void => {
        this.switchTo(p.id);
      })

      Button('编辑')
        .type(ButtonType.Normal)
        .height(30)
        .padding({ left: 10, right: 10 })
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_primary'))
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .margin({ left: SP_2 })
        .onClick((): void => {
          this.onEditClick(p);
        })

      Button('删除')
        .type(ButtonType.Normal)
        .height(30)
        .padding({ left: 10, right: 10 })
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.state_error'))
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .margin({ left: SP_1 })
        .onClick((): void => {
          this.onDeleteClick(p);
        })
    }
    .width('100%')
    .padding({ left: SP_3, right: SP_3, top: SP_3, bottom: SP_3 })
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_2 })
  }

  /** 远程列表（空态提示）。 */
  @Builder
  remoteList() {
    Text('远程主机（' + this.conn.profiles.length.toString() + '）')
      .fontSize(FS_SUBTITLE)
      .fontWeight(FontWeight.Bold)
      .fontColor($r('app.color.label_primary'))
      .width('100%')
      .margin({ bottom: SP_3 })

    if (this.conn.profiles.length === 0) {
      Column() {
        Text('还没有远程主机')
          .fontSize(FS_BODY)
          .fontColor($r('app.color.label_secondary'))
        Text('点下方「新增远程」手动填写，或用「扫码配对」扫 PC 端 /remote-pairing 的二维码')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .textAlign(TextAlign.Center)
          .margin({ top: SP_1 })
      }
      .width('100%')
      .padding({ top: SP_4, bottom: SP_4 })
      .backgroundColor($r('app.color.bg_layer_1'))
      .borderRadius(RADIUS_CARD)
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      .margin({ bottom: SP_2 })
    } else {
      Repeat(this.conn.profiles)
        .each((cell: RepeatItem<RemoteProfile>): void => {
          this.remoteRow(cell.item)
        })
        .key((p: RemoteProfile): string => p.id)
    }

    Button(this.showForm ? '收起表单' : '＋ 新增远程')
      .width('100%')
      .height(44)
      .fontSize(FS_BODY)
      .fontWeight(FontWeight.Medium)
      .fontColor($r('app.color.label_on_brand'))
      .backgroundColor($r('app.color.brand_fill'))
      .borderRadius(RADIUS_CTRL)
      .margin({ top: SP_2, bottom: SP_3 })
      .onClick((): void => {
        if (this.showForm) {
          this.closeForm();
        } else {
          this.onAddClick();
        }
      })
  }

  /** 新增 / 编辑远程的表单。 */
  @Builder
  formCard() {
    if (this.showForm) {
      Column() {
        Text(this.editingId.length > 0 ? '编辑远程' : '新增远程')
          .fontSize(FS_SUBTITLE)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .width('100%')
          .margin({ bottom: SP_3 })

        FieldInput({
          label: '名称',
          hint: '例如：家里台式机',
          text: this.formName,
          onInput: (v: string): void => {
            this.formName = v;
          }
        })
        FieldInput({
          label: '中继地址',
          hint: 'wss://relay.example.com/ws',
          text: this.formRelayUrl,
          onInput: (v: string): void => {
            this.formRelayUrl = v;
          }
        })
        FieldInput({
          label: '配对频道 channel',
          hint: 'A-Z2-7，16~64 位（插件配置页可见）',
          text: this.formChannel,
          onInput: (v: string): void => {
            this.formChannel = v;
          }
        })
        FieldInput({
          label: '配对密钥 secret',
          hint: '≥32 字符，仅存本地，绝不发给中继',
          text: this.formSecret,
          secret: true,
          onInput: (v: string): void => {
            this.formSecret = v;
          }
        })
        FieldInput({
          label: '中继令牌（可选）',
          hint: '中继配置了 RELAY_TOKEN 时填写',
          text: this.formRelayToken,
          secret: true,
          onInput: (v: string): void => {
            this.formRelayToken = v;
          }
        })

        if (this.scanHint.length > 0) {
          Text(this.scanHint)
            .fontSize(FS_SMALL)
            .fontColor(this.scanHintOk ? $r('app.color.state_success') : $r('app.color.state_error'))
            .width('100%')
            .margin({ top: SP_2 })
        }

        Button('扫码配对')
          .width('100%')
          .height(44)
          .margin({ top: SP_3 })
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .backgroundColor($r('app.color.bg_layer_2'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
          .borderRadius(RADIUS_CTRL)
          .onClick((): void => {
            this.onScanClick();
          })
        Text('扫描 PC 端「/remote-pairing」页面出示的配对二维码，自动填入并保存连接（契约 §3.5）')
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .margin({ top: SP_2 })

        Row() {
          Button('取消')
            .layoutWeight(1)
            .height(44)
            .fontSize(FS_BODY)
            .fontColor($r('app.color.label_primary'))
            .backgroundColor($r('app.color.bg_layer_2'))
            .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
            .borderRadius(RADIUS_CTRL)
            .onClick((): void => {
              this.closeForm();
            })
          Button(this.editingId.length > 0 ? '保存并连接' : '添加并连接')
            .layoutWeight(1)
            .height(44)
            .margin({ left: SP_2 })
            .fontSize(FS_BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.label_on_brand'))
            .backgroundColor($r('app.color.brand_fill'))
            .borderRadius(RADIUS_CTRL)
            .onClick((): void => {
              this.saveProfile();
            })
        }
        .width('100%')
        .margin({ top: SP_3 })
      }
      .width('100%')
      .padding(SP_4)
      .backgroundColor($r('app.color.bg_layer_1'))
      .borderRadius(RADIUS_CARD)
      .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
      .margin({ bottom: SP_3 })
    }
  }

  /** 推送开关卡。 */
  @Builder
  pushCard() {
    Column() {
      Row() {
        Column() {
          Text('推送通知')
            .fontSize(FS_BODY)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.label_primary'))
          Text(this.pushStatusText())
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_secondary'))
            .margin({ top: SP_1 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.pushEnabled })
          .selectedColor($r('app.color.brand_fill'))
          .switchPointColor($r('app.color.label_on_brand'))
          .onChange((on: boolean): void => {
            this.onPushToggle(on);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_3 })
  }

  /** 关于入口。 */
  @Builder
  aboutRow() {
    Row() {
      Text('关于本应用')
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
        .layoutWeight(1)
      Text('›')
        .fontSize(FS_SUBTITLE)
        .fontColor($r('app.color.label_tertiary'))
    }
    .width('100%')
    .padding({ left: SP_4, right: SP_4, top: SP_3, bottom: SP_3 })
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_5 })
    .onClick((): void => {
      openAbout();
    })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      Scroll() {
        Column() {
          this.currentCard()
          this.remoteList()
          this.formCard()
          this.pushCard()
          this.aboutRow()
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_5 })
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
