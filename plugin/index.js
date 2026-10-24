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
import { loadConfig, saveConfig, dataDir } from "./lib/config.mjs";
import { RelayClient } from "./lib/relay-client.mjs";
import { RelaySupervisor, shouldTickWatchdog } from "./lib/relay-supervisor.mjs";
import { PushSender, pushConfigured, pushUnavailableReason } from "./lib/push.mjs";
import { HostBridge } from "./lib/host-bridge.mjs";
import {
  buildPairingUri,
  renderPairing,
  writePairingSvg,
  rotatePairingIdentity,
  setPairingHidden,
  loopbackWarning,
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
  // **N2**：已 dispose 的旧 state 不能复用——插件二次加载时若拿到它，
  // 托管会永久失效（supervisor 的 disposed 是单向闩锁）。丢掉重建。
  if (existing && existing.supervisor && existing.supervisor.disposed === true) {
    HOST_STATES.delete(ctx);
  } else if (existing) {
    return existing;
  }

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

  const state = {
    cfg,
    configPath,
    log,
    relay: null,
    katOk,
    running: false,
    /** 启动/热更换中继链路（设置页改中继地址时复用）。 */
    startLink: null,
    /** 停止并释放当前链路（清空中继地址时用）。 */
    stopLink: null,
    /** 中继进程托管器（v1.1.1：本机中继随插件启动/停止）。 */
    supervisor: null,
    /** 托管状态快照（设置页展示）。 */
    relayProcess: null,
    /** 看门狗定时器（托管进程意外退出后自动重拉）。 */
    relayWatchdog: null,
  };
  HOST_STATES.set(ctx, state);

  // ---- 3. Push Kit（§6；未配置时优雅禁用，不影响主链路）--------------------
  // 提前创建：设置页改中继地址后要能立刻起链路，push 发送器得先备好。
  const push = new PushSender(cfg.push, log);
  if (!pushConfigured(cfg.push)) {
    log("info", "push.state disabled: " + pushUnavailableReason(cfg.push), { hint: "configure push.* in " + configPath });
  }

  // ---- 4. 链路控制（启动 / 热更换 / 停止）------------------------------------
  /** 停止并释放当前链路（幂等；未在跑时是 no-op）。 */
  function stopLink() {
    const currentRelay = state.relay;
    const detach = state.detachBridge;
    state.relay = null;
    state.bridge = null;
    state.detachBridge = null;
    state.running = false;
    try {
      currentRelay?.close();
    } catch {
      /* ignore */
    }
    try {
      detach?.();
    } catch {
      /* ignore */
    }
  }

  // ---- 4b. 中继进程托管（v1.1.1）--------------------------------------------
  // 中继是本方案的服务端，不该靠人手起：插件启动时把**本机**中继拉起来，
  // 插件卸载/DSH 退出时收掉（只按 child handle 停自己起的那个进程）。
  const supervisor = new RelaySupervisor({
    log: (level, msg, extra) => log(level, "relay supervisor: " + msg, extra),
    // 状态一变就刷新宿主快照（审计 S2）：子进程崩溃时由 supervisor 主动通知，
    // 否则设置页会一直显示「运行中（已死的 pid）」。
    onStatus: (snapshot) => {
      state.relayProcess = snapshot;
    },
  });
  state.supervisor = supervisor;

  /**
   * 确保本机中继在跑（幂等）。中继没起来时链路客户端会自己退避重连，
   * 所以这里不阻塞插件启动。
   */
  async function ensureRelayProcess() {
    try {
      const snapshot = await supervisor.ensure(state.cfg.relayUrl, {
        // **N1：`cfg.enabled` 必须折进 autoStart**——插件被禁用时绝不能拉起中继
        // （审计实测：enabled=false 时看门狗仍把 0.0.0.0 的中继拉了起来）。
        autoStart: state.cfg.enabled === true && state.cfg.autoStartRelay !== false,
        relayToken: state.cfg.relayToken,
      });
      state.relayProcess = snapshot;
      if (snapshot.managed) {
        log("info", snapshot.detail, { pid: snapshot.pid, port: snapshot.port });
      } else if (snapshot.detail) {
        log("info", snapshot.detail, { port: snapshot.port });
      }
    } catch (e) {
      log("error", "relay supervisor failed", { error: String(e && e.message) });
    }
  }

  // 看门狗：托管的中继意外退出（例如被外部杀掉）后自动重拉。
  // 15s 一次；**判定走 shouldRestartRelay()**（纯函数，有单测覆盖）——
  // 审计指出：原来读 ensure() 时刻的静态快照 → 子进程退出后快照仍是 running=true
  // → 永不重拉，设置页还显示「运行中（已死的 pid）」。
  state.relayWatchdog = setInterval(() => {
    // 判定走纯函数 shouldTickWatchdog()（有单测覆盖）：
    // ① 插件被禁用 → 一律不碰中继（N1：否则「用户关了插件」反而把中继拉起来）；
    // ② 其余按 supervisor 的实时状态决定（含 external 重探、崩溃重拉）。
    if (!shouldTickWatchdog(supervisor.status, state.cfg)) return;
    void ensureRelayProcess();
  }, 15_000);
  if (typeof state.relayWatchdog.unref === "function") state.relayWatchdog.unref();

  /**
   * 建立中继链路：已有客户端 → 热更换（换地址立即重连）；没有 → 新建客户端 + 桥接。
   * @returns {{ok:boolean, mode?:string, message?:string}}
   */
  function startLink() {
    if (!state.katOk) {
      return { ok: false, message: "协议 KAT 自测未通过，已禁用连接。" };
    }
    if (state.cfg.enabled !== true) {
      return { ok: false, message: "插件已被配置禁用（config.json 的 enabled=false）。" };
    }
    const url = typeof state.cfg.relayUrl === "string" ? state.cfg.relayUrl.trim() : "";
    if (url === "") {
      return { ok: false, message: "未配置中继地址。" };
    }
    if (state.relay) {
      // 已有客户端：热更换（地址/凭据立即生效，旧连接作废）
      state.relay.reload({
        relayUrl: url,
        channel: state.cfg.channel,
        secret: state.cfg.secret,
        relayToken: state.cfg.relayToken,
      });
      return { ok: true, mode: "reload" };
    }
    // 新建客户端 + Host 桥接
    const client = new RelayClient({
      relayUrl: url,
      channel: state.cfg.channel,
      secret: state.cfg.secret,
      relayToken: state.cfg.relayToken,
      role: "host",
      log,
      onStatus: (s, detail) => {
        log("info", "relay " + s + (detail ? ": " + detail : ""), {
          relayUrl: state.cfg.relayUrl,
          channel: state.cfg.channel,
        });
        if (s === "ready") state.bridge?.sendPushState();
      },
      onPeer: (joined, role) => {
        log("info", "peer " + (joined ? "joined" : "left"), { role });
      },
      onFatal: (code, message) => {
        // bad-hello / channel-full：协议级拒绝，重连无意义——停掉链路并大声说明
        log("error", "relay rejected connection (fatal); disconnecting", { code, message, channel: state.cfg.channel });
        stopLink();
      },
      onMessage: (plain) => {
        state.bridge?.onPlainMessage(plain);
      },
    });
    const hostBridge = new HostBridge({ ctx, relay: client, push, config: state.cfg, log });
    const detachHostBridge = hostBridge.attach();
    client.start();
    state.relay = client;
    state.bridge = hostBridge;
    state.detachBridge = detachHostBridge;
    state.running = true;
    return { ok: true, mode: "start" };
  }

  state.startLink = startLink;
  state.stopLink = stopLink;
  state.ensureRelayProcess = ensureRelayProcess;

  // ---- 5. 卸载清理（插件热卸载时释放 socket/定时器/监听）-------------------
  // 无论当前是否在跑链路都要注册：设置页稍后起链路时同样要能收回资源。
  ctx.effect(() => () => {
    stopLink();
    // v1.1.1：收掉**自己起的**中继子进程（只按 child handle 停，不按名字/端口杀）
    if (state.relayWatchdog) {
      clearInterval(state.relayWatchdog);
      state.relayWatchdog = null;
    }
    // **dispose 而非 stop**（审计 S4）：dispose 置位「永久停用」，
    // 在途的 ensure 完成后不会再把中继拉起来（原来 stop 后在途 ensure 仍会 spawn → 孤儿）。
    void supervisor.dispose();
    // **N2：必须把 ctx 的状态从 HOST_STATES 里摘掉**——
    // 否则插件二次加载（DSH `set_plugin` 关→开走 cordis `Fiber.restart()`，**复用同一个 ctx**）
    // 会拿到这份「已 dispose 的旧 state」→ 托管永久失效（实测：端口再也不监听、看门狗也没了）。
    HOST_STATES.delete(ctx);
    log("info", "unloaded");
  });

  if (!katOk) {
    log("error", "KAT failure takes precedence: not connecting", { channel: cfg.channel });
    return state;
  }
  if (cfg.enabled !== true) {
    log("info", "plugin disabled by config; not connecting", { path: configPath });
    return state;
  }
  if (typeof cfg.relayUrl !== "string" || cfg.relayUrl === "") {
    // 未配置 relayUrl：优雅空转——不连接、不拦截（瀑布照常 next()），
    // 等用户在设置页填写中继地址（v1.1.x：setRelayUrl 会现场把链路拉起来）。
    log(
      "info",
      "relayUrl not configured — idling (no connection, no interception). " +
        "Set the relay address in the DSH settings panel (\"DSH Pocket\"), then pair the phone app. channel=" +
        cfg.channel,
    );
    return state;
  }

  const started = startLink();
  if (started.ok) {
    log("info", "remote control active", {
      channel: cfg.channel,
      relayUrl: cfg.relayUrl,
      interceptApprovals: cfg.interceptApprovals,
      interceptQuestions: cfg.interceptQuestions,
      approvalTimeoutMs: cfg.approvalTimeoutMs,
      dataDir: dataDir(),
    });
  }

  // v1.1.1：中继进程随插件启动（不阻塞上面的链路建立——中继没起来时
  // 链路客户端会自己退避重连，中继一上线就能连上）。
  void ensureRelayProcess();

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
    for (const method of ["getPairing", "rotateSecret", "setHidden", "setRelayUrl"]) {
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
    if (cfg.hidden === true) {
      return {
        ok: true,
        value: withRelayProcess(pairingValue(cfg, "配对已隐藏：手机端请使用此前扫码保存的配对信息。", false), host),
      };
    }
    // 未配置 relayUrl：给出明确指引（**不返回 URI/secret**）
    try {
      buildPairingUri(cfg);
    } catch (e) {
      return {
        ok: false,
        error: { code: "pairing-unavailable", message: String(e && e.message) },
      };
    }
    return { ok: true, value: withRelayProcess(pairingValue(cfg, "", true), host) };
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

  /**
   * 设置中继地址（设置页输入框直改，v1.1.x）。
   *
   * 校验 → 落盘 → 热切换链路 → 回新的配对信息。
   * 空串 = 清除中继地址（插件回到空转状态，不再连接中继）。
   *
   * @param {string} url 中继地址，如 ws://192.168.1.10:8788；空串 = 清除
   * @returns {Promise<{ok:true,value:object}|{ok:false,error:{code:string,message:string}}>}
   */
  async setRelayUrl(url) {
    const host = this._host;
    if (!host || !host.cfg) {
      return { ok: false, error: { code: "not-ready", message: "插件尚未初始化。" } };
    }
    if (typeof url !== "string") {
      return { ok: false, error: { code: "bad-params", message: "中继地址必须是字符串。" } };
    }
    const raw = url.trim();
    if (raw.length > 512) {
      return { ok: false, error: { code: "bad-params", message: "中继地址过长（上限 512 字符）。" } };
    }
    if (raw !== "") {
      if (!/^wss?:\/\//i.test(raw)) {
        return {
          ok: false,
          error: { code: "bad-params", message: "中继地址必须以 ws:// 或 wss:// 开头（例如 ws://192.168.1.10:8788）。" },
        };
      }
      let parsed = null;
      try {
        parsed = new URL(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || !parsed.host) {
        return {
          ok: false,
          error: { code: "bad-params", message: "中继地址不是合法的 URL（缺少主机名，例如 ws://192.168.1.10:8788）。" },
        };
      }
    }

    // 落盘（只把 relayUrl 写回磁盘配置；行内紧急覆盖不动）
    try {
      const fresh = loadConfig().config;
      fresh.relayUrl = raw;
      saveConfig(fresh);
    } catch (e) {
      return {
        ok: false,
        error: { code: "config-save-failed", message: "保存中继地址失败：" + String(e && e.message) },
      };
    }
    // 内存同步 + 链路热切换
    host.cfg.relayUrl = raw;
    host.log("info", "relay address updated", { relayUrl: raw, cleared: raw === "" });

    let note = "";
    if (raw === "") {
      // 清除：停掉链路，插件回到空转（不连接、不拦截）
      host.stopLink?.();
      // v1.1.1：地址清空 → 收掉托管的中继进程（否则会留一个没人用的中继）
      void host.supervisor?.stop();
      host.relayProcess = null;
      note = "中继地址已清除，插件已停止连接中继（空转）。填写地址后可立即重新连接。";
    } else {
      const link = host.startLink ? host.startLink() : { ok: false, message: "链路控制不可用。" };
      note = link.ok
        ? link.mode === "reload"
          ? "中继地址已更新，链路已用新地址重连。"
          : "中继地址已更新，链路已启动。"
        : "中继地址已保存，但链路未启动：" + (link.message || "未知原因");
      // v1.1.1：地址变了 → 托管进程要跟着换（端口可能也变了）
      void host.ensureRelayProcess?.();
    }
    const warn = loopbackWarning(raw);
    if (warn) note = (note ? note + " " : "") + warn;

    const value = pairingValue(host.cfg, note, raw !== "");
    return { ok: true, value: withRelayProcess(value, host) };
  }
}

/**
 * 组装配对信息（**不含 secret 明文**——secret 只存在于二维码图像里）。
 *
 * @param {any} cfg 插件配置
 * @param {string} note 提示文案
 * @param {boolean} withQr 是否产出二维码（无中继地址或已隐藏时不产出）
 * @returns {{relayUrl:string, channel:string, hidden:boolean, qrSvg:string, note:string}}
 */
function pairingValue(cfg, note, withQr) {
  const value = {
    relayUrl: typeof cfg?.relayUrl === "string" ? cfg.relayUrl : "",
    channel: typeof cfg?.channel === "string" ? cfg.channel : "",
    hidden: cfg?.hidden === true,
    qrSvg: "",
    note: typeof note === "string" ? note : "",
    /** v1.1.1：中继进程托管状态（设置页展示；老客户端忽略即可）。 */
    relayProcess: null,
  };
  if (!withQr || value.hidden) return value;
  try {
    const rendered = renderPairing(buildPairingUri(cfg));
    value.qrSvg = rendered.svg;
    // 落盘一份（供外部工具/备份使用）；失败不致命——设置页直接用内联 SVG。
    try {
      writePairingSvg(rendered.svg);
    } catch {
      /* ignore */
    }
  } catch (e) {
    value.note = (value.note ? value.note + " " : "") + String(e && e.message);
  }
  return value;
}

/**
 * 给配对信息挂上**中继进程托管状态**（v1.1.1）。
 *
 * 设置页据此显示「中继进程：由插件托管 · 运行中（pid 1234）」之类的一行，
 * 让用户知道中继是谁在管。快照取自 supervisor 的内存状态——不含任何敏感信息。
 *
 * @param {any} value pairingValue() 的结果
 * @param {any} host  插件宿主状态
 * @returns {any} 同一个 value（就地补字段）
 */
function withRelayProcess(value, host) {
  const snap = host?.relayProcess;
  value.relayProcess = {
    /** 是否由插件托管（配置允许 + relayUrl 指向本机 + 找到中继程序）。 */
    managed: snap?.managed === true,
    /** 中继是否在跑（托管的子进程活着，或端口上已有服务）。 */
    running: snap?.running === true,
    /** 托管子进程 pid（未运行时 0）。 */
    pid: typeof snap?.pid === "number" ? snap.pid : 0,
    /** 监听端口（未托管时 0）。 */
    port: typeof snap?.port === "number" ? snap.port : 0,
    /** 人类可读的一句话状态。 */
    detail: typeof snap?.detail === "string" ? snap.detail : "",
    /** 端口上是不是**别人**的服务（N11：不透传的话设置页无法区分「外部中继」）。 */
    external: snap?.external === true,
    /** 状态原因（not-configured/disabled/remote/no-entry/external/managed）。 */
    reason: typeof snap?.reason === "string" ? snap.reason : "",
  };
  return value;
}

export default RemoteControlService;
