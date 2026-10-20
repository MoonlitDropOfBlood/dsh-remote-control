/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之①：配对/设置页（Navigation 根页）。
 *  - relayUrl / channel / secret / relayToken 输入 → Preferences 持久化 → 链路启动
 *  - 连接状态灯（连接中/已连接/重连中/错误）+ 主机在线徽标 + KAT 自检指示 + 链路日志
 *  - 推送开关（本机 Preferences + push.register 上报状态，契约 §6）
 *  - 「进入会话列表」「待审批」「关于」入口；消费推送点击直达目标（契约 §6 intent）
 * 设计：亮/暗 token 全走 $r('app.color.*')；卡片 bg_layer_1 + 1px border_l1 + 12vp 圆角；
 *      主按钮 brand_fill（DeepSeek 蓝）配 label_on_brand 白字。
 */
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { dshrcLink } from '../model/link';
import { CONTRACT_VERSION, isValidChannel } from '../model/protocol';
import {
  APP_NAME,
  APP_VERSION,
  PairingConfig,
  loadPairing,
  savePairing,
  toLinkConfig,
  validatePairing
} from '../model/store';
import {
  PendingNav,
  SessionStore,
  loadPushEnabled,
  savePushEnabled,
  sessionStore
} from '../model/sessionstore';
import { runKatCheck } from '../model/crypto';
import {
  FS_BODY,
  FS_CAPTION,
  FS_HERO,
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
  SP_6,
  linkBusy,
  linkStateColor,
  linkStateText
} from '../model/theme';
import { FieldInput } from './FieldInput';
import { SessionListPage } from './SessionListPage';
import { SessionDetailParam, SessionDetailPage } from './SessionDetailPage';
import { ApprovalQueuePage } from './ApprovalQueuePage';
import { AboutPage } from './AboutPage';

@Entry
@ComponentV2
struct Index {
  @Local navPathStack: NavPathStack = new NavPathStack();
  @Local store: SessionStore = sessionStore;
  @Local relayUrl: string = '';
  @Local channel: string = '';
  @Local secret: string = '';
  @Local relayToken: string = '';
  @Local katText: string = 'KAT 自检中…';
  @Local katOk: boolean = false;
  @Local pushEnabled: boolean = true;
  @Local showLog: boolean = false;

  aboutToAppear(): void {
    const ctx: common.Context = getContext(this) as common.Context;
    const cfg: PairingConfig = loadPairing(ctx);
    this.relayUrl = cfg.relayUrl;
    this.channel = cfg.channel;
    this.secret = cfg.secret;
    this.relayToken = cfg.relayToken;
    this.pushEnabled = loadPushEnabled(ctx);
    this.store.pushLocalEnabled = this.pushEnabled;
    // KAT 自检（契约 §7）：连接前跑一遍，逐字节核对 key/ct/tag/aad。
    runKatCheck().then((text: string): void => {
      this.katText = text;
      this.katOk = text.startsWith('KAT 通过');
    });
    // 推送点击直达（EntryAbility onNewWant / onCreate 写入后回调这里）
    this.store.onPendingNav = (): void => {
      this.consumePending();
    };
  }

  aboutToDisappear(): void {
    this.store.onPendingNav = null;
  }

  /** 四个 NavDestination 的路由映射（单一 builder，链式 navDestination 会互相覆盖）。 */
  @Builder
  pageMap(name: string) {
    if (name === 'SessionListPage') {
      SessionListPage();
    }
    if (name === 'SessionDetailPage') {
      SessionDetailPage();
    }
    if (name === 'ApprovalQueuePage') {
      ApprovalQueuePage();
    }
    if (name === 'AboutPage') {
      AboutPage();
    }
  }

  /** 消费推送点击目标：有 askId 直达审批队列，否则直达会话详情（契约 §6）。 */
  private consumePending(): void {
    const p: PendingNav = this.store.takePendingNav();
    if (p.askId.length > 0) {
      this.navPathStack.pushPathByName('ApprovalQueuePage', null);
      return;
    }
    if (p.sessionId.length > 0) {
      const param: SessionDetailParam = { sessionId: p.sessionId };
      this.navPathStack.pushPath({ name: 'SessionDetailPage', param: param });
    }
  }

  /** 连接：校验 → Preferences 保存 → 启动链路（内部先跑 KAT 再建链）。 */
  private onConnectClick(): void {
    const cfg: PairingConfig = {
      relayUrl: this.relayUrl.trim(),
      channel: this.channel.trim(),
      secret: this.secret.trim(),
      relayToken: this.relayToken.trim()
    };
    const invalid: string = validatePairing(cfg);
    if (invalid.length > 0) {
      promptAction.showToast({ message: invalid, duration: 3000 });
      return;
    }
    if (!isValidChannel(cfg.channel)) {
      promptAction.showToast({ message: 'channel 格式不合法（契约 §4：A-Z2-7，16~64 位）', duration: 3000 });
      return;
    }
    const ctx: common.Context = getContext(this) as common.Context;
    savePairing(ctx, cfg);
    this.store.lastError = '';
    dshrcLink.start(toLinkConfig(cfg, APP_NAME, APP_VERSION));
  }

  /** 断开链路。 */
  private onStopClick(): void {
    dshrcLink.stop();
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

  /** 卡片容器公共样式（Builder 内联书写，避免样式链过长难读）。 */

  @Builder
  brandMark() {
    Stack() {
      Text('DSH')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_on_brand'))
    }
    .width(46)
    .height(46)
    .borderRadius(RADIUS_CARD)
    .backgroundColor($r('app.color.brand_fill'))
  }

  @Builder
  headerBlock() {
    Row() {
      this.brandMark()
      Column() {
        Text('DSH Remote Control')
          .fontSize(FS_HERO)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.label_primary'))
        Text('会话遥控 · 审批应答 · 端到端加密')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .margin({ top: SP_1 })
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: SP_3 })
      .layoutWeight(1)
      Button('关于')
        .type(ButtonType.Normal)
        .height(32)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_primary'))
        .backgroundColor($r('app.color.bg_layer_2'))
        .onClick((): void => {
          this.navPathStack.pushPathByName('AboutPage', null);
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: SP_5 })
  }

  @Builder
  statusCard() {
    Column() {
      Row() {
        Circle({ width: 10, height: 10 })
          .fill(linkStateColor(this.store.linkState))
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

      Text(this.katText)
        .fontSize(FS_SMALL)
        .fontColor(this.katOk ? $r('app.color.state_success') : $r('app.color.state_warn'))
        .margin({ top: SP_3 })

      if (this.store.lastError.length > 0) {
        Text(this.store.lastError)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.state_error'))
          .margin({ top: SP_1 })
      }

      Row() {
        Text('链路日志')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_tertiary'))
          .layoutWeight(1)
        Text(this.showLog ? '收起' : '展开')
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.brand_label'))
          .onClick((): void => {
            this.showLog = !this.showLog;
          })
      }
      .width('100%')
      .margin({ top: SP_3 })

      if (this.showLog) {
        Text(this.store.logLines.slice(0, 5).join('\n'))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .width('100%')
          .margin({ top: SP_2 })
          .padding({ left: SP_2, right: SP_2, top: SP_2, bottom: SP_2 })
          .backgroundColor($r('app.color.bg_layer_2'))
          .borderRadius(RADIUS_CTRL)
      }
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_3 })
  }

  @Builder
  fieldsCard() {
    Column() {
      Text('配对信息')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_primary'))
        .margin({ bottom: SP_3 })
      FieldInput({
        label: '中继地址',
        hint: 'wss://relay.example.com/ws',
        text: this.relayUrl,
        onInput: (v: string): void => {
          this.relayUrl = v;
        }
      })
      FieldInput({
        label: '配对频道 channel',
        hint: 'A-Z2-7，16~64 位（插件配置页可见）',
        text: this.channel,
        onInput: (v: string): void => {
          this.channel = v;
        }
      })
      FieldInput({
        label: '配对密钥 secret',
        hint: '≥32 字符，仅存本地，绝不发给中继',
        text: this.secret,
        secret: true,
        onInput: (v: string): void => {
          this.secret = v;
        }
      })
      FieldInput({
        label: '中继令牌（可选）',
        hint: '中继配置了 RELAY_TOKEN 时填写',
        text: this.relayToken,
        secret: true,
        onInput: (v: string): void => {
          this.relayToken = v;
        }
      })
    }
    .width('100%')
    .padding(SP_4)
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .margin({ bottom: SP_3 })
  }

  @Builder
  actionRow() {
    Row() {
      Button(linkBusy(this.store.linkState) ? '连接中…' :
        (this.store.linkState === 'online' ? '重新连接' : '连接'))
        .layoutWeight(1)
        .height(46)
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_on_brand'))
        .backgroundColor($r('app.color.brand_fill'))
        .borderRadius(RADIUS_CTRL)
        .enabled(!linkBusy(this.store.linkState))
        .onClick((): void => {
          this.onConnectClick();
        })
      Button('断开')
        .width(92)
        .height(46)
        .margin({ left: SP_2 })
        .fontSize(FS_BODY)
        .fontColor($r('app.color.state_error'))
        .backgroundColor($r('app.color.bg_layer_1'))
        .border({ width: HAIRLINE, color: $r('app.color.border_l2') })
        .borderRadius(RADIUS_CTRL)
        .enabled(this.store.linkState !== 'idle' && this.store.linkState !== 'stopped')
        .onClick((): void => {
          this.onStopClick();
        })
    }
    .width('100%')
    .margin({ bottom: SP_3 })
  }

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

  @Builder
  entryRows() {
    Row() {
      Button('进入会话列表')
        .layoutWeight(1)
        .height(46)
        .fontSize(FS_BODY)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.label_on_brand'))
        .backgroundColor($r('app.color.brand_fill'))
        .borderRadius(RADIUS_CTRL)
        .onClick((): void => {
          this.navPathStack.pushPathByName('SessionListPage', null);
        })
      if (this.store.pendingCount() > 0) {
        Button('待处理 ' + this.store.pendingCount().toString())
          .height(46)
          .margin({ left: SP_2 })
          .padding({ left: SP_3, right: SP_3 })
          .fontSize(FS_BODY)
          .fontColor($r('app.color.state_warn'))
          .backgroundColor($r('app.color.state_warn_tint'))
          .borderRadius(RADIUS_CTRL)
          .onClick((): void => {
            this.navPathStack.pushPathByName('ApprovalQueuePage', null);
          })
      }
    }
    .width('100%')
    .margin({ bottom: SP_4 })

    Text(APP_NAME + ' v' + APP_VERSION + ' · 协议契约 ' + CONTRACT_VERSION +
      ' · MIT License')
      .fontSize(FS_CAPTION)
      .fontColor($r('app.color.label_tertiary'))
      .width('100%')
      .textAlign(TextAlign.Center)
  }

  build() {
    Navigation(this.navPathStack) {
      Scroll() {
        Column() {
          this.headerBlock()
          this.statusCard()
          this.fieldsCard()
          this.actionRow()
          this.pushCard()
          this.entryRows()
          Text('提示：PC 端需先启用 dsh-remote-control 插件（host 角色）并填入同一 channel / secret，' +
            '连接成功后即可遥控会话、查看流式回复并处理审批与提问。')
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_tertiary'))
            .width('100%')
            .margin({ top: SP_4, bottom: SP_6 })
        }
        .width('100%')
        .padding({ left: SP_4, right: SP_4, top: SP_5, bottom: SP_6 })
      }
      .width('100%')
      .height('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
      .onVisibleAreaChange([0.0, 1.0], (isExpanding: boolean, currentRatio: number): void => {
        if (isExpanding && currentRatio > 0.9) {
          this.consumePending();
        }
      })
    }
    .width('100%')
    .height('100%')
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
    .hideToolBar(true)
    .backgroundColor($r('app.color.bg_base'))
    .navDestination(this.pageMap)
  }
}
