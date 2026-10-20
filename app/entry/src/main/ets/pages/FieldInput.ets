/*
 * Copyright (c) 2026 dukedsh.
 * 通用“标签 + 输入框”字段（配对页各输入项复用）。
 * 卡片式外观：bg_layer_2 嵌套面 + 1px border_l1 描边 + 8vp 圆角。
 */
import { FS_BODY, FS_SMALL, HAIRLINE, RADIUS_CTRL, SP_1 } from '../model/theme';

@ComponentV2
export struct FieldInput {
  @Param label: string = '';
  @Param hint: string = '';
  @Param text: string = '';
  /** true = 密码态（secret / relayToken）。 */
  @Param secret: boolean = false;
  @Event onInput: (value: string) => void;

  build() {
    Column() {
      Text(this.label)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_secondary'))
      TextInput({ text: this.text, placeholder: this.hint })
        .type(this.secret ? InputType.Password : InputType.Normal)
        .onChange((value: string): void => {
          this.onInput(value);
        })
        .width('100%')
        .height(44)
        .margin({ top: SP_1 })
        .padding({ left: 12, right: 12 })
        .backgroundColor($r('app.color.bg_layer_2'))
        .borderRadius(RADIUS_CTRL)
        .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_primary'))
        .placeholderColor($r('app.color.label_tertiary'))
        .caretColor($r('app.color.brand_fill'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
