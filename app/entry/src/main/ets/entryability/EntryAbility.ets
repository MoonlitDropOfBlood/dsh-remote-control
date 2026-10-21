/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 入口 Ability：
 *  - Push Kit：启动取 token（onCreate）、token 变化监听（onWindowStageCreate 绑定）、
 *    通知授权请求（loadContent 回调内，hmos-push-kit skill 要求）
 *  - 通知点击 intent（契约 §6：sessionId / askId / kind）→ sessionStore 待导航目标
 *  - onCreate / onNewWant 双入口解析（冷启动 / 应用存活两种拉起路径）
 */
import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';
import { HRouter } from 'hrouter';
import { flushLogs, initLogger, logDshrc } from '../model/logger';
import { parsePushIntent, PushIntentTarget, pushKit } from '../model/push';
import { sessionStore } from '../model/sessionstore';

const TAG = 'dshrc-ability';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 文件日志（@duke/logan-ext）必须在任何 logDshrc 之前初始化；失败自动降级为纯 hilog。
    initLogger(this.context);
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      logDshrc(TAG, 'error', 'Failed to set colorMode. Cause: ' + JSON.stringify(err));
    }
    logDshrc(TAG, 'info', 'Ability onCreate');
    // 推送 token（契约 §6：取到后由 sessionStore 在链路在线时 push.register 上报）
    pushKit.fetchToken();
    // 冷启动点击通知：先记下直达目标，Index 挂载后消费
    this.handleWant(want);
  }

  /** 应用存活时点击通知（单例应用再次拉起）。 */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    logDshrc(TAG, 'info', 'Ability onNewWant');
    this.handleWant(want);
  }

  /** 解析 intent extra（契约 §6），命中则写入待导航目标。 */
  private handleWant(want: Want): void {
    try {
      const target: PushIntentTarget = parsePushIntent(want.parameters);
      if (target.sessionId.length > 0 || target.askId.length > 0) {
        logDshrc(TAG, 'info', 'push intent: session=' + target.sessionId +
          ' ask=' + target.askId + ' kind=' + target.kind);
        sessionStore.setPendingNav(target.sessionId, target.askId);
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'warn', 'parse intent failed: ' + err.message);
    }
  }

  onDestroy(): void {
    logDshrc(TAG, 'info', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    logDshrc(TAG, 'info', 'Ability onWindowStageCreate');
    // hrouter 运行时初始化（读取 service_map、注册 NavDestination observer）。
    // 失败只降级为「无路由表增强」，不阻断 loadContent（契约 §10 优雅降级）。
    HRouter.init(this.context, { enableLog: true }).catch((e: Error): void => {
      logDshrc(TAG, 'error', 'HRouter.init failed: ' + e.message);
    });

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        logDshrc(TAG, 'error', 'Failed to load the content. Cause: ' + JSON.stringify(err));
        return;
      }
      logDshrc(TAG, 'info', 'Succeeded in loading the content.');
      // 通知授权（必须在页面加载完成后请求，否则弹窗体验/时序不合规）
      notificationManager.requestEnableNotification(this.context).then((): void => {
        logDshrc(TAG, 'info', '[ANS] requestEnableNotification success');
      }).catch((e: BusinessError): void => {
        // 未开通推送服务/用户拒绝时优雅降级（契约 §10），不影响主链路
        logDshrc(TAG, 'error', '[ANS] requestEnableNotification failed: ' +
          e.code.toString() + ' ' + e.message);
      });
      // token 变化监听（卸载重装/签名变化后 token 会变，需重新上报）
      pushKit.bindTokenUpdate(this);
    });
  }

  onWindowStageDestroy(): void {
    logDshrc(TAG, 'info', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    logDshrc(TAG, 'info', 'Ability onForeground');
  }

  onBackground(): void {
    logDshrc(TAG, 'info', 'Ability onBackground');
    // 进后台强制落盘：真机崩溃/被杀时缓冲日志不丢。
    flushLogs();
  }
}
