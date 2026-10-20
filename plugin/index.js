/**
 * dsh-remote-control — Host half（契约 §8.1）。
 *
 * Cordis 功能插件（`export function apply(ctx, config)`）：以 host 角色出站
 * 连接公网中继（WebSocket，无需端口映射），桥接 DSH Host 服务，让 HarmonyOS
 * 手机 App 远程控制本机的 DeepSeek Harness：
 *
 *   - 会话遥控：list / create / prompt / cancel / rename（§5.1，经 sessionController）
 *   - 事件桥接：session.added/removed/status/activity、assistant.delta
 *     （按会话节流 ≤8 条/秒）、turn.end（§5.2）
 *   - 审批/提问拦截：`approval/request` 与 `user-questions/request` 瀑布以
 *     {prepend:true} 抢占在桌面答案器之前；**仅当手机在线且开关打开**才拦截，
 *     超时（默认 120s）/出错/取消一律 next() 放行——绝不 fail-closed（§5.5）
 *   - Push Kit 旁路：审批/提问/任务完成推送通知（§6；未配置 AGC 时优雅禁用）
 *
 * E2E 加密（§3/§7）：HKDF-SHA256 派生 + AES-256-GCM，AAD 绑定发送方 role 与
 * seq；启动时跑契约 KAT 自测，**失败即禁用连接**（打日志，绝不带病连中继）。
 *
 * 配对（§3）：首次启用在插件自有 config.json 生成 channel（16 位 base32）与
 * secret（base64url 24 字节）；用户在手机配对页输入 relayUrl + channel + secret。
 *
 * 写入范围：仅本包目录。运行时数据（config.json）在 DSH_HOME/remote-control/。
 */

import { assertKat } from "./lib/protocol.mjs";
import { loadConfig, saveConfig, dataDir } from "./lib/config.mjs";
import { RelayClient } from "./lib/relay-client.mjs";
import { PushSender, pushConfigured, pushUnavailableReason } from "./lib/push.mjs";
import { HostBridge } from "./lib/host-bridge.mjs";

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config Cordis 行 config（cordis.patch.yml 的 config 字段；
 *   本插件的持久配置在自己的 config.json，行 config 仅作紧急覆盖开关）。
 */
export function apply(ctx, config) {
  const log = (level, message, extra) => {
    const line = "[dsh-remote-control] " + message + (extra ? " " + JSON.stringify(extra) : "");
    try {
      if (level === "error") ctx.logger?.error?.(line);
      else if (level === "warn") ctx.logger?.warn?.(line);
      else ctx.logger?.info?.(line);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  // ---- 1. 协议 KAT 自测（契约 §7；失败禁用连接）---------------------------
  let katOk = true;
  try {
    assertKat();
    log("info", "protocol KAT self-test passed (HKDF/AES-256-GCM/AAD binding)");
  } catch (e) {
    katOk = false;
    log("error", "protocol KAT self-test FAILED — relay connection DISABLED", { error: String(e && e.message) });
  }

  // ---- 2. 配置（§3.1：首次启动生成 channel/secret）------------------------
  let loaded;
  try {
    loaded = loadConfig();
  } catch (e) {
    log("error", "config load failed — remote control disabled", { error: String(e && e.message) });
    return;
  }
  const { config: cfg, generated, repaired, path: configPath } = loaded;
  if (repaired) log("warn", "config was corrupt; regenerated pairing identity", { path: configPath });
  if (generated) log("info", "generated new pairing identity (channel/secret)", { channel: cfg.channel });

  // 行 config 紧急覆盖：enabled / relayUrl / intercept* / approvalTimeoutMs
  const rowCfg = config && typeof config === "object" ? config : {};
  if (typeof rowCfg.enabled === "boolean") cfg.enabled = rowCfg.enabled;
  if (typeof rowCfg.relayUrl === "string" && rowCfg.relayUrl !== "") cfg.relayUrl = rowCfg.relayUrl;
  if (typeof rowCfg.interceptApprovals === "boolean") cfg.interceptApprovals = rowCfg.interceptApprovals;
  if (typeof rowCfg.interceptQuestions === "boolean") cfg.interceptQuestions = rowCfg.interceptQuestions;
  if (typeof rowCfg.approvalTimeoutMs === "number") cfg.approvalTimeoutMs = rowCfg.approvalTimeoutMs;

  if (!katOk) {
    log("error", "KAT failure takes precedence: not connecting", { channel: cfg.channel });
    return;
  }
  if (cfg.enabled !== true) {
    log("info", "plugin disabled by config; not connecting", { path: configPath });
    return;
  }
  if (typeof cfg.relayUrl !== "string" || cfg.relayUrl === "") {
    // 未配置 relayUrl：优雅空转——不连接、不拦截（瀑布照常 next()），等用户配对。
    log(
      "info",
      "relayUrl not configured — idling (no connection, no interception). " +
        "Set relayUrl/channel/secret in " + configPath + ", then pair the phone app. channel=" + cfg.channel,
    );
    return;
  }

  // ---- 3. Push Kit（§6；未配置时优雅禁用，不影响主链路）--------------------
  const push = new PushSender(cfg.push, log);
  if (!pushConfigured(cfg.push)) {
    log("info", "push.state disabled: " + pushUnavailableReason(cfg.push), { hint: "configure push.* in " + configPath });
  }

  // ---- 4. 中继链路 + Host 桥接 ---------------------------------------------
  /** @type {HostBridge|null} */
  let bridge = null;
  const relay = new RelayClient({
    relayUrl: cfg.relayUrl,
    channel: cfg.channel,
    secret: cfg.secret,
    relayToken: cfg.relayToken,
    log,
    onStatus: (s, detail) => {
      log(s === "ready" ? "info" : "info", "relay " + s + (detail ? ": " + detail : ""), {
        relayUrl: cfg.relayUrl,
        channel: cfg.channel,
      });
      if (s === "ready") bridge?.sendPushState();
    },
    onPeer: (joined, role) => {
      log("info", "peer " + (joined ? "joined" : "left"), { role });
    },
    onFatal: (code, message) => {
      // bad-hello / channel-full：协议级拒绝，重连无意义——停掉链路并大声说明
      log("error", "relay rejected connection (fatal); disconnecting", { code, message, channel: cfg.channel });
      relay.close();
    },
    onMessage: (plain) => {
      bridge?.onPlainMessage(plain);
    },
  });

  bridge = new HostBridge({ ctx, relay, push, config: cfg, log });
  const detachBridge = bridge.attach();
  relay.start();

  log("info", "remote control active", {
    channel: cfg.channel,
    relayUrl: cfg.relayUrl,
    interceptApprovals: cfg.interceptApprovals,
    interceptQuestions: cfg.interceptQuestions,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    dataDir: dataDir(),
  });

  // ---- 5. 卸载清理（插件热卸载时释放 socket/定时器/监听）-------------------
  ctx.effect(() => () => {
    try {
      relay.close();
    } catch {
      /* ignore */
    }
    try {
      detachBridge();
    } catch {
      /* ignore */
    }
    log("info", "unloaded");
  });

  // 配置热保存钩子：本插件无设置页（v1 手改 config.json），此函数留给
  // 未来 settings.section 扩展；当前仅在生成身份时已落盘。
  void saveConfig;
}
