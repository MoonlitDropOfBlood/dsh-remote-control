/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 推送接入（契约 §6 旁路，hmos-push-kit skill）。
 *  - pushService.getToken() 取 token；on('tokenUpdate', ability, …) 变化重取
 *  - token 交给 sessionStore，链路在线时由 sessionStore 走 push.register 上报（契约 §5.1）
 *  - 未开通 AGC 推送服务时优雅降级：只记日志，绝不抛出打断主链路（契约 §10）
 *  - 点击通知 intent（extra：sessionId / askId / kind）由 EntryAbility 解析 → sessionStore
 */
import { pushService } from '@kit.PushKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Ability } from '@kit.AbilityKit';
import { logDshrc } from './logger';
import { sessionStore } from './sessionstore';

const TAG: string = 'dshrc-push';

/** 通知点击直达目标（契约 §6 intent extra）。 */
export interface PushIntentTarget {
  sessionId: string;
  askId: string;
  kind: string;
}

/** 推送 token 取用封装（单例）。所有失败都只记日志，按契约 §10 优雅降级。 */
export class PushKit {
  private static instance: PushKit | null = null;
  private token: string = '';
  private wired: boolean = false;

  private constructor() {
  }

  static get(): PushKit {
    if (PushKit.instance === null) {
      PushKit.instance = new PushKit();
    }
    const inst: PushKit | null = PushKit.instance;
    return inst as PushKit;
  }

  /** 当前 token（诊断展示用；空串=未取到）。 */
  currentToken(): string {
    return this.token;
  }

  /**
   * 取一次 token 并写入 sessionStore（EntryAbility.onCreate 调用）。
   * 常见失败：1000900010 推送服务未开通 / 1000900011 签名不匹配 → 仅日志降级。
   */
  fetchToken(): void {
    pushService.getToken().then((t: string): void => {
      this.token = t;
      sessionStore.setPushToken(t);
      logDshrc(TAG, 'info', 'push token acquired, len=' + t.length.toString());
    }).catch((e: BusinessError): void => {
      logDshrc(TAG, 'error',
        'getToken failed: ' + e.code.toString() + ' ' + e.message + '（推送降级，主链路不受影响）');
    });
  }

  /** 监听 token 变化（需 Ability 实例）；变化时重新写入 store 触发补报。 */
  bindTokenUpdate(ability: Ability): void {
    if (this.wired) {
      return;
    }
    this.wired = true;
    try {
      pushService.on('tokenUpdate', ability, (t: string): void => {
        this.token = t;
        sessionStore.setPushToken(t);
        logDshrc(TAG, 'info', 'push token updated, len=' + t.length.toString());
      });
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'error', 'bind tokenUpdate failed: ' + err.code.toString());
    }
  }
}

/** 从 want.parameters 取字符串参数（缺省空串）。 */
function paramStr(parameters: Record<string, Object>, key: string): string {
  const v: Object | undefined = parameters[key];
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return v.toString();
  }
  return '';
}

/** 从一个嵌套对象里取字符串参数（插件可能把 extra 包一层）。 */
function nestedStr(parameters: Record<string, Object>, holder: string, key: string): string {
  const v: Object | undefined = parameters[holder];
  if (v === undefined || v === null) {
    return '';
  }
  // 非对象载体按属性取值会得到 undefined，paramStr 返回空串兜底，不会抛出。
  const rec: Record<string, Object> = v as Record<string, Object>;
  return paramStr(rec, key);
}

/**
 * 解析通知点击 intent → 直达目标（契约 §6：extra 字段 sessionId / askId / kind）。
 * 兼容两种载荷形状：顶层字段，或包在 parameters / extra / dshrc 之一里。
 */
export function parsePushIntent(parameters: Record<string, Object> | undefined): PushIntentTarget {
  const t: PushIntentTarget = { sessionId: '', askId: '', kind: '' };
  if (parameters === undefined) {
    return t;
  }
  t.sessionId = paramStr(parameters, 'sessionId');
  t.askId = paramStr(parameters, 'askId');
  t.kind = paramStr(parameters, 'kind');
  if (t.sessionId.length === 0 && t.askId.length === 0) {
    const holders: string[] = ['parameters', 'extra', 'dshrc'];
    for (let i: number = 0; i < holders.length; i++) {
      const h: string = holders[i];
      const sid: string = nestedStr(parameters, h, 'sessionId');
      const aid: string = nestedStr(parameters, h, 'askId');
      const kind: string = nestedStr(parameters, h, 'kind');
      if (sid.length > 0 || aid.length > 0) {
        t.sessionId = sid;
        t.askId = aid;
        t.kind = kind;
        break;
      }
    }
  }
  return t;
}

/** 全局单例（EntryAbility 使用）。 */
export const pushKit: PushKit = PushKit.get();
