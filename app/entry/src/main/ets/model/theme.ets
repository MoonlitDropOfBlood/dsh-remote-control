/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 设计 token（数值层）与语义映射。
 *
 * 颜色 token 集中定义在 resources/base/element/color.json + resources/dark/element/color.json
 * （亮/暗自动跟随系统），代码中一律以 $r('app.color.*') 引用，不散落硬编码色值：
 *  - 背景层：bg_base / bg_layer_1 / bg_layer_2 / bg_overlay / bg_sidebar
 *  - 描边：  border_l1（浅）/ border_l2（强）/ border_contrast（对比色，仅描边·文字·焦点环）
 *  - 文字：  label_primary / label_secondary / label_tertiary / label_on_brand
 *  - 品牌填充：brand_fill（DeepSeek 蓝 #4D6BFE 系，配 label_on_brand 白字）/ brand_tint
 *  - 状态：  state_error / state_warn / state_success / state_idle（+ *_tint 阶梯）
 *  - 叠加：  fill_hover / fill_pressed / scrim（透明度阶梯，禁止再手写 rgba）
 * 重要语义：border_contrast 是对比色（≈亮黑/暗白），只能做描边/文字/焦点环，
 *           不能做填充底配白字；填充底请用 brand_fill。
 */
import { LinkState } from './link';

/** 间距阶梯（vp）。 */
export const SP_1: number = 4;
export const SP_2: number = 8;
export const SP_3: number = 12;
export const SP_4: number = 16;
export const SP_5: number = 20;
export const SP_6: number = 24;

/** 圆角阶梯（vp）：卡片 8–12、气泡稍大、胶囊全圆。 */
export const RADIUS_CTRL: number = 8;
export const RADIUS_CARD: number = 12;
export const RADIUS_BUBBLE: number = 14;
export const RADIUS_PILL: number = 100;

/** 字号阶梯（fp）。 */
export const FS_CAPTION: number = 11;
export const FS_SMALL: number = 12;
export const FS_BODY: number = 15;
export const FS_SUBTITLE: number = 17;
export const FS_TITLE: number = 20;
export const FS_HERO: number = 26;

/** 1px 细描边。 */
export const HAIRLINE: number = 1;

/** 链路状态 → 状态色 token（状态灯 / 徽标描边）。 */
export function linkStateColor(s: LinkState): ResourceColor {
  if (s === 'online') {
    return $r('app.color.state_success');
  }
  if (s === 'error') {
    return $r('app.color.state_error');
  }
  if (s === 'reconnecting') {
    return $r('app.color.state_warn');
  }
  if (s === 'connecting' || s === 'deriving' || s === 'handshaking') {
    return $r('app.color.brand_label');
  }
  return $r('app.color.state_idle');
}

/** 链路状态 → 中文文案（配对页状态灯 / 各页顶栏徽标）。 */
export function linkStateText(s: LinkState): string {
  if (s === 'idle') {
    return '未连接';
  }
  if (s === 'deriving') {
    return '派生密钥中';
  }
  if (s === 'connecting') {
    return '连接中继中';
  }
  if (s === 'handshaking') {
    return '握手中';
  }
  if (s === 'online') {
    return '已连接';
  }
  if (s === 'reconnecting') {
    return '重连中';
  }
  if (s === 'stopped') {
    return '已停止';
  }
  return '连接错误';
}

/** 链路是否处于“进行中”（连接按钮禁用 / 状态灯呼吸用）。 */
export function linkBusy(s: LinkState): boolean {
  return s === 'deriving' || s === 'connecting' || s === 'handshaking' || s === 'reconnecting';
}

/** 毫秒时间戳 → 相对时间（会话列表“最近活动”）。 */
export function relTime(ts: number): string {
  if (ts <= 0) {
    return '';
  }
  const diff: number = Date.now() - ts;
  if (diff < 60000) {
    return '刚刚';
  }
  if (diff < 3600000) {
    return Math.floor(diff / 60000).toString() + ' 分钟前';
  }
  if (diff < 86400000) {
    return Math.floor(diff / 3600000).toString() + ' 小时前';
  }
  if (diff < 7 * 86400000) {
    return Math.floor(diff / 86400000).toString() + ' 天前';
  }
  return clockDate(ts);
}

/** 两位补零。 */
function pad2(n: number): string {
  return n < 10 ? '0' + n.toString() : n.toString();
}

/** 毫秒时间戳 → HH:mm（气泡时间戳）。 */
export function clockTime(ts: number): string {
  const d: Date = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 毫秒时间戳 → YYYY-MM-DD（远期相对时间兜底）。 */
export function clockDate(ts: number): string {
  const d: Date = new Date(ts);
  const y: string = d.getFullYear().toString();
  return y + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 会话 id 截断显示（详情页兜底标题）。 */
export function shortId(id: string): string {
  if (id.length <= 8) {
    return id;
  }
  return id.substring(0, 8) + '…';
}

/** 秒数 → 倒计时文案 mm:ss。 */
export function countdownText(msLeft: number): string {
  const total: number = msLeft > 0 ? Math.floor(msLeft / 1000) : 0;
  const m: number = Math.floor(total / 60);
  const s: number = total % 60;
  return pad2(m) + ':' + pad2(s);
}
