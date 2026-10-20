/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 配置持久化（Preferences，契约 §8.3）。
 * 保存 relayUrl / channel / secret / relayToken；secret 仅存本地，绝不发给中继。
 * 状态与 UI 层见 sessionstore.ets / push.ets 与 pages/（阶段 R2 已交付）。
 */
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Context } from '@kit.AbilityKit';
import { LinkConfig } from './link';

const TAG: string = 'dshrc-store';
const LOG_DOMAIN: number = 0x0000;
const PREF_NAME: string = 'dshrc_prefs';

const KEY_RELAY_URL: string = 'relayUrl';
const KEY_CHANNEL: string = 'channel';
const KEY_SECRET: string = 'secret';
const KEY_RELAY_TOKEN: string = 'relayToken';

/** 应用名与版本（与 AppScope/app.json5 versionName 保持一致；hello.appVersion 与关于页展示用）。 */
export const APP_NAME: string = 'dsh-remote-control';
export const APP_VERSION: string = '1.0.0';

/** 配对配置（UI 与链路层共用的形状）。 */
export interface PairingConfig {
  relayUrl: string;
  channel: string;
  secret: string;
  relayToken: string;
}

/** 读取已保存的配对配置；无保存时返回空串字段。 */
export function loadPairing(context: Context): PairingConfig {
  const cfg: PairingConfig = { relayUrl: '', channel: '', secret: '', relayToken: '' };
  try {
    const pref: preferences.Preferences = preferences.getPreferencesSync(context, { name: PREF_NAME });
    cfg.relayUrl = pref.getSync(KEY_RELAY_URL, '') as string;
    cfg.channel = pref.getSync(KEY_CHANNEL, '') as string;
    cfg.secret = pref.getSync(KEY_SECRET, '') as string;
    cfg.relayToken = pref.getSync(KEY_RELAY_TOKEN, '') as string;
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    hilog.error(LOG_DOMAIN, TAG, 'loadPairing failed: %{public}s', err.message);
  }
  return cfg;
}

/** 保存配对配置（连接前调用，保证重装/重启后可恢复）。 */
export function savePairing(context: Context, cfg: PairingConfig): boolean {
  try {
    const pref: preferences.Preferences = preferences.getPreferencesSync(context, { name: PREF_NAME });
    pref.putSync(KEY_RELAY_URL, cfg.relayUrl);
    pref.putSync(KEY_CHANNEL, cfg.channel);
    pref.putSync(KEY_SECRET, cfg.secret);
    pref.putSync(KEY_RELAY_TOKEN, cfg.relayToken);
    pref.flushSync();
    return true;
  } catch (e) {
    const err: BusinessError = e as BusinessError;
    hilog.error(LOG_DOMAIN, TAG, 'savePairing failed: %{public}s', err.message);
    return false;
  }
}

/** PairingConfig → 链路层 LinkConfig。 */
export function toLinkConfig(cfg: PairingConfig, clientName: string, appVersion: string): LinkConfig {
  const lc: LinkConfig = {
    relayUrl: cfg.relayUrl,
    channel: cfg.channel,
    secret: cfg.secret,
    relayToken: cfg.relayToken,
    clientName: clientName,
    appVersion: appVersion
  };
  return lc;
}

/** 校验配对输入，返回可展示的错误文本；通过则返回空串。 */
export function validatePairing(cfg: PairingConfig): string {
  if (cfg.relayUrl.length === 0) {
    return '请填写中继地址（wss://…）';
  }
  if (!cfg.relayUrl.startsWith('ws://') && !cfg.relayUrl.startsWith('wss://')) {
    return '中继地址必须以 ws:// 或 wss:// 开头';
  }
  if (cfg.channel.length === 0) {
    return '请填写配对频道（channel）';
  }
  if (!/^[A-Z2-7]{16,64}$/.test(cfg.channel)) {
    return 'channel 须为 16~64 位大写字母 A-Z / 数字 2-7';
  }
  if (cfg.secret.length < 32) {
    return 'secret 至少 32 个字符';
  }
  return '';
}
