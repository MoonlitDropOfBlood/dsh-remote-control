/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 入口 Ability：
 *  - Push Kit：启动取 token（onCreate）、token 变化监听（onWindowStageCreate 绑定）、
 *    通知授权请求（loadContent 回调内，hmos-push-kit skill 要求）
 *  - 通知点击 intent（契约 §6：sessionId / askId / kind）→ sessionStore 待导航目标
 *  - onCreate / onNewWant 双入口解析（冷启动 / 应用存活两种拉起路径）
 */
import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';
import { parsePushIntent, PushIntentTarget, pushKit } from '../model/push';
import { sessionStore } from '../model/sessionstore';

const DOMAIN = 0x0000;
const TAG = 'dshrc-ability';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
    // 推送 token（契约 §6：取到后由 sessionStore 在链路在线时 push.register 上报）
    pushKit.fetchToken();
    // 冷启动点击通知：先记下直达目标，Index 挂载后消费
    this.handleWant(want);
  }

  /** 应用存活时点击通知（单例应用再次拉起）。 */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onNewWant');
    this.handleWant(want);
  }

  /** 解析 intent extra（契约 §6），命中则写入待导航目标。 */
  private handleWant(want: Want): void {
    try {
      const target: PushIntentTarget = parsePushIntent(want.parameters);
      if (target.sessionId.length > 0 || target.askId.length > 0) {
        hilog.info(DOMAIN, TAG, 'push intent: session=%{public}s ask=%{public}s kind=%{public}s',
          target.sessionId, target.askId, target.kind);
        sessionStore.setPendingNav(target.sessionId, target.askId);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'parse intent failed: %{public}s', err.message);
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, '%{public}s', 'Succeeded in loading the content.');
      // 通知授权（必须在页面加载完成后请求，否则弹窗体验/时序不合规）
      notificationManager.requestEnableNotification(this.context).then((): void => {
        hilog.info(DOMAIN, TAG, '%{public}s', '[ANS] requestEnableNotification success');
      }).catch((e: BusinessError): void => {
        // 未开通推送服务/用户拒绝时优雅降级（契约 §10），不影响主链路
        hilog.error(DOMAIN, TAG, '[ANS] requestEnableNotification failed: %{public}d %{public}s',
          e.code, e.message);
      });
      // token 变化监听（卸载重装/签名变化后 token 会变，需重新上报）
      pushKit.bindTokenUpdate(this);
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onBackground');
  }
}
