/**
 * dsh-remote-control — Host half（契约 §8.1；v1.1.x 配对入口搬进设置面板）。
 *
 * Cordis **类插件**（`export default class RemoteControlService extends TypertRemoteService`）：
 * DSH 装载器把本包作为类插件挂载，服务名 `remoteControl`；Typert 网关把它
 * 标记为 Remote 的方法暴露给浏览器端（`ctx.remote.remoteControl.*`）——
 * 桌面端「设置 → DSH Pocket」分区即通过这三个 Remote 方法驱动：
 *
 *   - getPairing()  → {relayUrl, channel, hidden, qrSvg}（二维码内联进设置页）
 *   - rotateSecret()→ 轮换 channel/secret（旧二维码立即失效）
 *   - setHidden(b)  → 隐藏/恢复配对展示
 *
 * 插件同时保留函数式入口 `apply(ctx, config)`（等价于类插件的初始化路径），
 * 供按函数插件方式挂载的宿主使用；两条路径共用 `startRemoteHost()`。
 *
 * 宿主侧能力（原有，全部保留）：
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
 * secret（base64url 24 字节）；**二维码在设置面板展示**（v1.1.x 起不再有
 * /remote-pairing 命令）。手机扫码后凭 URI 里的 relayUrl/channel/secret 配对。
 *
 * 写入范围：仅本包目录。运行时数据（config.json）在 DSH_HOME/remote-control/。
 */

import { Service } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { assertKat } from "./lib/protocol.mjs";
import { loadConfig, dataDir } from "./lib/config.mjs";
import { RelayClient } from "./lib/relay-client.mjs";
import { PushSender, pushConfigured, pushUnavailableReason } from "./lib/push.mjs";
import { HostBridge } from "./lib/host-bridge.mjs";
import {
  buildPairingUri,
  renderPairing,
  writePairingSvg,
  rotatePairingIdentity,
  setPairingHidden,
} from "./lib/pairing.mjs";

/**
 * 标记一个实例方法为 Remote 导出——不依赖装饰器语法（Node ESM 在此不支持
 * 提案装饰器），而是手动驱动同一个 `Remote(name)` 装饰器：构造一个合成装饰器
 * 上下文，把注册进来的 initializer 对实例执行一遍（标记落在原型上）。
 *
 * @param {object} instance - 活的 Service 实例。
 * @param {string} method - 公开实例方法名。
 * @param {string} [exportName] - wire 导出名；默认与方法名相同。
 */
function markRemoteMethod(instance, method, exportName = method) {
  const decorator = Remote(exportName, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/**
 * 已启动的宿主链路状态（按 ctx 记账）——保证同一条链路只启动一次。
 * @type {WeakMap<object, {cfg:any, configPath:string, log:Function, relay:any, katOk:boolean, running:boolean}>}
 */
const HOST_STATES = new WeakMap();

/**
 * 启动宿主侧链路（KAT → 配置 → Push → 中继客户端 + Host 桥接）。
 *
 * 任何一步的早退都**不抛**：配置缺失/被禁用/KAT 失败时插件空转，但状态句柄
 * 仍然返回——设置面板据此回答「未配置 relayUrl」等可操作提示。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rowConfig Cordis 行 config（紧急覆盖开关）。
 * @returns {{cfg:any, configPath:string, log:Function, relay:any, katOk:boolean, running:boolean}}
 */
export function startRemoteHost(ctx, rowConfig) {
  // 幂等：同一个 ctx 只启动一次（类插件的 [Service.init] 与函数式 apply 共存时
  // 不会起两条中继链路、不会重复注册监听）。
  const existing = HOST_STATES.get(ctx);
  if (existing) return existing;

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
    const failed = { cfg: null, configPath: "", log, relay: null, katOk: false, running: false };
    HOST_STATES.set(ctx, failed);
    return failed;
  }
  const { config: cfg, generated, repaired, path: configPath } = loaded;
  if (repaired) log("warn", "config was corrupt; regenerated pairing identity", { path: configPath });
  if (generated) log("info", "generated new pairing identity (channel/secret)", { channel: cfg.channel });

  // 行 config 紧急覆盖：enabled / relayUrl / intercept* / approvalTimeoutMs
  const rowCfg = rowConfig && typeof rowConfig === "object" ? rowConfig : {};
  if (typeof rowCfg.enabled === "boolean") cfg.enabled = rowCfg.enabled;
  if (typeof rowCfg.relayUrl === "string" && rowCfg.relayUrl !== "") cfg.relayUrl = rowCfg.relayUrl;
  if (typeof rowCfg.interceptApprovals === "boolean") cfg.interceptApprovals = rowCfg.interceptApprovals;
  if (typeof rowCfg.interceptQuestions === "boolean") cfg.interceptQuestions = rowCfg.interceptQuestions;
  if (typeof rowCfg.approvalTimeoutMs === "number") cfg.approvalTimeoutMs = rowCfg.approvalTimeoutMs;

  /** @type {any} 中继客户端（空转时为 null）。 */
  let relay = null;
  const state = { cfg, configPath, log, relay: null, katOk, running: false };
  HOST_STATES.set(ctx, state);

  if (!katOk) {
    log("error", "KAT failure takes precedence: not connecting", { channel: cfg.channel });
    return state;
  }
  if (cfg.enabled !== true) {
    log("info", "plugin disabled by config; not connecting", { path: configPath });
    return state;
  }
  if (typeof cfg.relayUrl !== "string" || cfg.relayUrl === "") {
    // 未配置 relayUrl：优雅空转——不连接、不拦截（瀑布照常 next()），等用户配对。
    log(
      "info",
      "relayUrl not configured — idling (no connection, no interception). " +
        "Set relayUrl/channel/secret in " + configPath + ", then pair the phone app. channel=" + cfg.channel,
    );
    return state;
  }

  // ---- 3. Push Kit（§6；未配置时优雅禁用，不影响主链路）--------------------
  const push = new PushSender(cfg.push, log);
  if (!pushConfigured(cfg.push)) {
    log("info", "push.state disabled: " + pushUnavailableReason(cfg.push), { hint: "configure push.* in " + configPath });
  }

  // ---- 4. 中继链路 + Host 桥接 ---------------------------------------------
  /** @type {HostBridge|null} */
  let bridge = null;
  relay = new RelayClient({
    relayUrl: cfg.relayUrl,
    channel: cfg.channel,
    secret: cfg.secret,
    relayToken: cfg.relayToken,
    role: "host",
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
  state.relay = relay;
  state.running = true;

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

  return state;
}

/**
 * 函数式插件入口（与类插件共用 startRemoteHost）。
 *
 * 注意：DSH 装载器对模块做 `unwrapExports`——**default 导出优先**，
 * 因此在 DSH 里生效的是下面的 `RemoteControlService` 类插件；本函数供
 * 以函数插件方式挂载本包的宿主使用（两条路径不会同时生效）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config Cordis 行 config。
 */
export function apply(ctx, config) {
  startRemoteHost(ctx, config);
  // 配置热保存钩子占位：配对信息的写回由 lib/pairing.mjs 负责（rotate/hide）。
  void saveConfig;
}

/**
 * Host 侧 Remote 服务：桌面端「设置 → DSH Pocket」分区的唯一入口。
 *
 * 服务名 `remoteControl`（= Typert wire namespace）。
 */
export class RemoteControlService extends TypertRemoteService {
  /** 无硬服务依赖：sessionController 等由 HostBridge 自己按需 ctx.get。 */
  static inject = [];

  /**
   * Cordis 类插件用 `new Callback(ctx, config)` 构造——第二个参数是**插件配置**，
   * 不是服务名；服务名必须传给 super()。
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {Record<string, unknown>} config
   */
  constructor(ctx, config) {
    super(ctx, "remoteControl");
    this._rowConfig = config && typeof config === "object" ? config : {};
    /** @type {any} 宿主链路状态（startRemoteHost 的返回值）。 */
    this._host = null;
  }

  /**
   * Cordis 类插件初始化器：构造之后、服务发布之前运行。
   * 启动宿主链路并标记 Remote 方法；每一步独立兜底——失败只降级，不让插件激活失败。
   */
  [Service.init]() {
    try {
      this._host = startRemoteHost(this.ctx, this._rowConfig);
    } catch (e) {
      this._host = null;
      // eslint-disable-next-line no-console
      (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
        "[dsh-remote-control] host startup failed:",
        e,
      );
    }
    for (const method of ["getPairing", "rotateSecret", "setHidden"]) {
      try {
        markRemoteMethod(this, method, method);
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
          "[dsh-remote-control] Remote method not published: " + method,
          e,
        );
      }
    }
  }

  /**
   * 当前配对信息（设置面板渲染用）。
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:{code:string,message:string}}>}
   */
  async getPairing() {
    const host = this._host;
    if (!host || !host.cfg) {
      return { ok: false, error: { code: "not-ready", message: "插件尚未初始化。" } };
    }
    const cfg = host.cfg;
    const value = {
      relayUrl: typeof cfg.relayUrl === "string" ? cfg.relayUrl : "",
      channel: typeof cfg.channel === "string" ? cfg.channel : "",
      hidden: cfg.hidden === true,
      qrSvg: "",
      note: "",
    };
    if (value.hidden) {
      value.note = "配对已隐藏：手机端请使用此前扫码保存的配对信息。";
      return { ok: true, value };
    }
    try {
      const uri = buildPairingUri(cfg);
      const rendered = renderPairing(uri);
      value.qrSvg = rendered.svg;
      // 落盘一份（供外部工具/备份使用）；失败不致命——设置页直接用内联 SVG。
      try {
        writePairingSvg(rendered.svg);
      } catch (e) {
        host.log("warn", "pairing.svg write failed", { error: String(e && e.message) });
      }
      return { ok: true, value };
    } catch (e) {
      // relayUrl 未配置等预期错误：给出明确指引（**不返回 URI/secret**）
      return {
        ok: false,
        error: { code: "pairing-unavailable", message: String(e && e.message) },
      };
    }
  }

  /**
   * 轮换配对信息：换 channel+secret 并落盘，旧二维码立即失效。
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:{code:string,message:string}}>}
   */
  async rotateSecret() {
    const host = this._host;
    if (!host || !host.cfg) {
      return { ok: false, error: { code: "not-ready", message: "插件尚未初始化。" } };
    }
    const res = rotatePairingIdentity({
      config: host.cfg,
      configPath: host.configPath,
      log: host.log,
      getRelay: () => host.relay,
    });
    if (!res.ok) {
      return { ok: false, error: { code: "pairing-rotate-failed", message: String(res.error) } };
    }
    const pairing = await this.getPairing();
    if (!pairing.ok) return pairing;
    pairing.value.note = res.note ?? "";
    return pairing;
  }

  /**
   * 隐藏 / 恢复配对展示。
   * @param {boolean} hidden
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:{code:string,message:string}}>}
   */
  async setHidden(hidden) {
    const host = this._host;
    if (!host || !host.cfg) {
      return { ok: false, error: { code: "not-ready", message: "插件尚未初始化。" } };
    }
    const res = setPairingHidden(hidden === true, { config: host.cfg, log: host.log });
    if (!res.ok) {
      return { ok: false, error: { code: "pairing-hide-failed", message: String(res.error) } };
    }
    const pairing = await this.getPairing();
    if (!pairing.ok) return pairing;
    pairing.value.note = res.hidden === true ? "配对二维码已隐藏。" : "配对二维码已恢复显示。";
    return pairing;
  }
}

export default RemoteControlService;
