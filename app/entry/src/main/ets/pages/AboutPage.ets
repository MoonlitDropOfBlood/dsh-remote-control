/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之⑤：关于页（NavDestination）。
 *  - App 版本 / 协议契约版本 / 端到端加密说明 / KAT 自检结果 / MIT License 与仓库链接
 */
import { APP_NAME, APP_VERSION } from '../model/store';
import { CONTRACT_VERSION, HKDF_SALT, PROTO_VERSION } from '../model/protocol';
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
  SP_5,
  SP_6
} from '../model/theme';
import { runKatCheck } from '../model/crypto';
import { DshrcLogFile, exportLogs, logDirPath } from '../model/logger';
import { goBack } from '../model/routes';

/** 信息行（左标题右值）。 */
@ComponentV2
struct AboutRow {
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
// @Route({ name: 'about' })
@ComponentV2
export struct AboutPage {
  @Local katText: string = 'KAT 自检中…';
  @Local katOk: boolean = false;
  /** 文件日志摘要（exportLogs() 拉取；空串 = 未取到）。 */
  @Local logSummary: string = '文件日志：读取中…';

  aboutToAppear(): void {
    runKatCheck().then((text: string): void => {
      this.katText = text;
      this.katOk = text.startsWith('KAT 通过');
    });
    this.refreshLogInfo();
  }

  /** 拉取 Logan 文件列表（@duke/logan-ext exportLogs），展示个数与总大小。 */
  private refreshLogInfo(): void {
    exportLogs().then((files: DshrcLogFile[]): void => {
      if (files.length === 0) {
        this.logSummary = '文件日志：暂无（目录 ' + logDirPath() + '）';
        return;
      }
      let total: number = 0;
      for (let i: number = 0; i < files.length; i++) {
        total += files[i].size;
      }
      this.logSummary = '文件日志：' + files.length.toString() + ' 个 · 共 ' +
        (total / 1024).toFixed(1) + ' KB';
    }).catch((): void => {
      this.logSummary = '文件日志：读取失败';
    });
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
      Text('关于')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .margin({ left: SP_3 })
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
            // 品牌头
            Column() {
              Stack() {
                Text('DSH')
                  .fontSize(15)
                  .fontWeight(FontWeight.Bold)
                  .fontColor($r('app.color.label_on_brand'))
              }
              .width(56)
              .height(56)
              .borderRadius(RADIUS_CARD)
              .backgroundColor($r('app.color.brand_fill'))
              Text(APP_NAME)
                .fontSize(FS_SUBTITLE)
                .fontWeight(FontWeight.Bold)
                .fontColor($r('app.color.label_primary'))
                .margin({ top: SP_3 })
              Text('HarmonyOS 手机远程控制 DeepSeek Harness')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_secondary'))
                .margin({ top: SP_1 })
            }
            .width('100%')
            .padding({ top: SP_4, bottom: SP_5 })
            .alignItems(HorizontalAlign.Center)

            // 版本信息
            Column() {
              Text('版本与协议')
                .fontSize(FS_BODY)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.label_primary'))
                .width('100%')
                .margin({ bottom: SP_1 })
              AboutRow({ label: 'App 版本', value: 'v' + APP_VERSION })
              Divider().color($r('app.color.border_l1'))
              AboutRow({ label: '协议契约', value: CONTRACT_VERSION + '（proto ' +
                PROTO_VERSION.toString() + '）' })
              Divider().color($r('app.color.border_l1'))
              AboutRow({ label: 'HKDF salt', value: HKDF_SALT })
              Divider().color($r('app.color.border_l1'))
              AboutRow({
                label: 'KAT 自检',
                value: this.katOk ? '通过 ✓' : (this.katText.startsWith('KAT 通过') ? '通过 ✓' : '运行中…')
              })
              Divider().color($r('app.color.border_l1'))
              AboutRow({ label: '本地日志', value: this.logSummary })
            }
            .width('100%')
            .padding(SP_4)
            .backgroundColor($r('app.color.bg_layer_1'))
            .borderRadius(RADIUS_CARD)
            .border({ width: HAIRLINE, color: $r('app.color.border_l1') })

            Text(this.katText)
              .fontSize(FS_CAPTION)
              .fontColor(this.katOk ? $r('app.color.state_success') : $r('app.color.state_warn'))
              .width('100%')
              .margin({ top: SP_2 })

            // 端到端加密说明
            Column() {
              Text('端到端加密')
                .fontSize(FS_BODY)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.label_primary'))
                .width('100%')
                .margin({ bottom: SP_2 })
              Text('· 密钥由配对 secret 经 HKDF-SHA256 派生（salt=' + HKDF_SALT +
                '，info=e2e|channel），仅手机与 PC 插件两端持有。')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_secondary'))
                .width('100%')
              Text('· 消息体为 AES-256-GCM 密文（base64url(iv||ciphertext||tag)），AAD 绑定 ' +
                '"dshrc|role|seq" 防重放与串帧。')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_secondary'))
                .width('100%')
                .margin({ top: SP_1 })
              Text('· 中继服务器只转发密文，不持有 secret，被攻破也读不到会话内容；secret 不出本地。')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_secondary'))
                .width('100%')
                .margin({ top: SP_1 })
            }
            .width('100%')
            .padding(SP_4)
            .margin({ top: SP_3 })
            .backgroundColor($r('app.color.bg_layer_1'))
            .borderRadius(RADIUS_CARD)
            .border({ width: HAIRLINE, color: $r('app.color.border_l1') })

            // License
            Column() {
              Text('开源许可')
                .fontSize(FS_BODY)
                .fontWeight(FontWeight.Medium)
                .fontColor($r('app.color.label_primary'))
                .width('100%')
                .margin({ bottom: SP_2 })
              Text('MIT License · © 2026 Duke / dsh-remote-control contributors')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.label_secondary'))
                .width('100%')
              Text('github.com/MoonlitDropOfBlood/dsh-remote-control')
                .fontSize(FS_SMALL)
                .fontColor($r('app.color.brand_label'))
                .width('100%')
                .margin({ top: SP_1 })
            }
            .width('100%')
            .padding(SP_4)
            .margin({ top: SP_3, bottom: SP_6 })
            .backgroundColor($r('app.color.bg_layer_1'))
            .borderRadius(RADIUS_CARD)
            .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
          }
          .width('100%')
          .padding({ left: SP_4, right: SP_4 })
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
