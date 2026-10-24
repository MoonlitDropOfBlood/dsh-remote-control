// lib/relay-supervisor.mjs — 中继进程托管（v1.1.1，2026-10-25）
//
// 目的：中继是这套方案的「服务端」，不该靠人手 `node server.js` 起。
// 插件启动时把本机中继拉起来，插件卸载/DSH 退出时收掉。
//
// 进程安全铁律（曾因误杀 DSH 后端被固化为全局规则）：
//   - **只操作自己 spawn 出来的子进程**（按 child handle 停），绝不按进程名/端口批量杀；
//   - 端口探测只做 TCP connect（不发送数据），探测到占用就**不抢**（外部中继优先）；
//   - 远端中继（relayUrl 指向别的机器）**不托管**——那是别人机器上的服务。
//
// 父子绑定：中继子进程以 DSHRC_RELAY_PARENT_WATCHDOG=1 启动，
// 它监听 stdin ——收到 "shutdown" 命令则优雅停止；stdin EOF（父进程死了）也优雅退出。
// 不留孤儿进程。
//
// 审计修复要点（2026-10-25，独立审计发现）：
//   S1 改端口 → 必须先停旧进程再起新的（原来只判「子进程活着」就 return，端口换了不换进程）；
//   S2 状态必须由 supervisor 实时持有并回调（原来只在 ensure() 时拍快照，看门狗读到旧值永不重拉）；
//   S3 ensure 加 in-flight 锁 + exit 回调按归属判断（原来并发会双 spawn，且败者的 exit 回调
//      把胜者的句柄一起清掉 → 孤儿）；
//   S4 dispose 标志：卸载后不再启动（原来在途 ensure 会在卸载后把中继拉起来）；
//   S5 spawn 后 unref child 与三条 stdio（原来 pipe 句柄吊住 DSH 事件循环，导致优雅退出挂住）；
//   S6 Windows 上 child.kill('SIGTERM') 是硬杀（不走 signal handler）→ 改用 stdin 管道下命令，
//      让中继自己走 relay.stop() 优雅关闭。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本模块所在目录（plugin/lib）→ 插件根目录（plugin/）。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（plugin/）。 */
export const PLUGIN_DIR = resolve(LIB_DIR, "..");

/** 优雅停止命令（父进程 → 子进程，经 stdin 管道）。 */
const SHUTDOWN_COMMAND = "shutdown";
/** 优雅停止的宽限期（毫秒）；超时才硬杀。 */
const STOP_GRACE_MS = 3000;

/**
 * 中继入口的候选位置（按优先级）：
 *  1. 环境变量 DSHRC_RELAY_ENTRY 显式指定
 *  2. <plugin>/../relay/server.js —— 仓库布局（link 安装/开发时是活源码，优先）
 *  3. <plugin>/vendor/relay/server.js —— **打包进插件的中继副本**（bundle 安装时唯一可用的）
 *     （由 scripts/vendor-relay.mjs 从 relay/server.js 生成，门禁校验同步）
 *  4. <plugin>/node_modules/dsh-remote-control-relay/server.js —— 将来若发布成 npm 包
 */
export function resolveRelayEntry(pluginDir = PLUGIN_DIR, env = process.env) {
  const candidates = [];
  if (typeof env.DSHRC_RELAY_ENTRY === "string" && env.DSHRC_RELAY_ENTRY !== "") {
    candidates.push(resolve(env.DSHRC_RELAY_ENTRY));
  }
  candidates.push(resolve(pluginDir, "..", "relay", "server.js"));
  candidates.push(resolve(pluginDir, "vendor", "relay", "server.js"));
  candidates.push(resolve(pluginDir, "node_modules", "dsh-remote-control-relay", "server.js"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "";
}

/**
 * 解析 relayUrl → { host, port }；不是 ws/wss 或 URL 非法时返回 null。
 * @param {string} url
 * @returns {{host:string, port:number}|null}
 */
export function parseRelayTarget(url) {
  if (typeof url !== "string" || url.trim() === "") return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
  const port = u.port !== "" ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  // URL.hostname 对 IPv6 带方括号（[::1]）——去掉，判定与比较都用裸地址
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return { host, port };
}

/**
 * host 是否指向**本机**（含本机所有网卡地址）。
 * 只有本机中继才该由插件托管；远端（VPS / 另一台机器）不碰。
 * @param {string} host
 * @param {Record<string, Array<{address:string, family:string, internal:boolean}>>} [ifaces]
 */
export function isLocalHost(host, ifaces = networkInterfaces()) {
  if (typeof host !== "string" || host === "") return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  for (const list of Object.values(ifaces || {})) {
    for (const ni of list || []) {
      if (ni && typeof ni.address === "string" && ni.address.toLowerCase() === h) return true;
    }
  }
  return false;
}

/**
 * host 是否指向本机（**含 DNS 解析**：本机名/本机别名也认）。
 * 解析失败一律按「非本机」处理（保守：宁可不管，也不误托管别人的服务）。
 * @param {string} host
 * @returns {Promise<boolean>}
 */
export async function isLocalHostResolved(host) {
  if (typeof host !== "string" || host === "") return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLocalHost(h)) return true;
  try {
    const res = await lookup(h);
    const addrs = Array.isArray(res) ? res : [res];
    return addrs.some((a) => isLocalHost(a.address));
  } catch {
    return false;
  }
}

/**
 * 端口上是否已有服务在监听（纯 TCP connect 探测，不发数据）。
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortListening(port, host = "127.0.0.1", timeoutMs = 400) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const sock = connect({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * 目标端口是否已被占用——**同时探 127.0.0.1 与目标 host**。
 * 只探 127.0.0.1 会漏判「只绑了 LAN IP 的外部服务」→ 起一个影子中继（审计 M1）。
 * @param {number} port
 * @param {string} host 目标 host
 * @returns {Promise<boolean>}
 */
export async function isRelayPortBusy(port, host) {
  if (await isPortListening(port, "127.0.0.1")) return true;
  const h = (host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h !== "" && h !== "127.0.0.1" && h !== "localhost" && h !== "::1" && h !== "0.0.0.0" && h !== "::") {
    if (await isPortListening(port, h)) return true;
  }
  return false;
}

/** 托管状态快照。 */
export function emptyStatus() {
  return {
    /** 是否由插件托管（配置允许且 relayUrl 指向本机）。 */
    managed: false,
    /** 中继是否在跑（托管的子进程活着，或端口上已有服务）。 */
    running: false,
    /** 子进程 pid（未运行时为 0）。 */
    pid: 0,
    /** 监听端口（未托管时为 0）。 */
    port: 0,
    /** 最近一次状态说明（中文，直接可展示）。 */
    detail: "",
    /** 端口上是不是**别人**的服务（外部中继）。 */
    external: false,
    /**
     * 状态原因（看门狗据此决定要不要再探一次端口）：
     *   'not-configured' 未配置地址 / 'disabled' 关掉了自动启动 / 'remote' 远端中继 /
     *   'no-entry' 找不到中继程序 / 'external' 端口上是别人的服务 / 'managed' 我们托管的
     */
    reason: "not-configured",
  };
}

/**
 * 中继进程托管器。
 *
 * 生命周期：ensure()（幂等，按需拉起）→ stop()（只停自己起的进程）/ dispose()（永久）。
 * 所有 spawn/kill 都针对本对象持有的 child handle——**不按名字或端口杀任何进程**。
 */
export class RelaySupervisor {
  /**
   * @param {object} opts
   * @param {string} [opts.entry]        中继入口（server.js）；缺省自动解析，空串 = 显式没有
   * @param {string} [opts.nodePath]     用来起子进程的 node 可执行文件（默认 process.execPath）
   * @param {(level:string, msg:string, extra?:object)=>void} [opts.log]
   * @param {(state:object)=>void} [opts.onStatus]  状态变化回调（宿主用它刷新设置页快照）
   * @param {(file:string, args:string[], env:object, opts:object)=>object} [opts.spawnFn]  单测注入点
   */
  constructor(opts = {}) {
    // 注意：**空串是显式的「没有入口」**（测试与「禁用托管」场景用），
    // 不能用 || ——否则 "" 会被当成「没传」而自动解析出真入口。
    this.entry = opts.entry === undefined ? resolveRelayEntry() : opts.entry;
    this.nodePath = opts.nodePath || process.execPath;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.onStatus = typeof opts.onStatus === "function" ? opts.onStatus : null;
    this.spawnFn = typeof opts.spawnFn === "function" ? opts.spawnFn : spawn;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    /** 子进程**实际**监听的端口（改端口时用它判断是否要换进程）。 */
    this.childPort = 0;
    /** @type {object} */
    this.status = emptyStatus();
    /** 在途 ensure 的 promise（并发去重锁）。 */
    this.pending = null;
    /** 永久停用标志（dispose 后不再启动任何进程）。 */
    this.disposed = false;
    /** 子进程输出缓冲（启动失败时把原因带给宿主日志）。 */
    this.output = "";
  }

  /** 更新状态并通知宿主（宿主据此刷新设置页快照——S2：不能只在 ensure 时拍快照）。 */
  #publish(patch) {
    this.status = { ...this.status, ...patch };
    try {
      this.onStatus?.(this.status);
    } catch {
      /* 回调失败不影响托管 */
    }
  }

  /** 子进程是否还活着（真的活着，不是「调过 kill」）。 */
  isChildAlive() {
    const c = this.child;
    if (!c) return false;
    return c.exitCode === null && c.signalCode === null;
  }

  /**
   * 确保本机中继在跑（幂等，并发安全）。
   *
   * 判定顺序：
   *   1. 没配 relayUrl / autoStartRelay=false → 不托管
   *   2. relayUrl 指向远端 → 不托管（别人的服务）
   *   3. 找不到中继入口 → 不托管（给出提示）
   *   4. 端口已被占用 → 不托管（外部中继在跑），但标记 running
   *   5. 已在托管且**端口一致** → 直接返回
   *   6. 已在托管但**端口变了** → 先停旧进程，再起新的（S1）
   *   7. 否则 spawn 一个（并等它打印「relay listening」）
   *
   * @param {string} relayUrl
   * @param {object} [opts]
   * @param {boolean} [opts.autoStart]  默认 true
   * @param {string} [opts.relayToken]  中继自身 token（配置了才带）
   * @returns {Promise<object>} 状态快照
   */
  async ensure(relayUrl, opts = {}) {
    // 并发去重：看门狗 tick 与 setRelayUrl 可能同时打进来（S3）
    if (this.pending) return await this.pending;
    this.pending = this.#ensureInner(relayUrl, opts).finally(() => {
      this.pending = null;
    });
    return await this.pending;
  }

  async #ensureInner(relayUrl, opts) {
    const autoStart = opts.autoStart !== false;
    const target = parseRelayTarget(relayUrl);
    if (!target) {
      this.#publish({
        ...emptyStatus(),
        reason: "not-configured",
        detail: "未配置中继地址，暂不托管中继进程。",
      });
      return this.status;
    }
    if (!autoStart) {
      this.#publish({
        ...emptyStatus(),
        port: target.port,
        reason: "disabled",
        detail: "已关闭「随插件启动中继」。",
      });
      return this.status;
    }
    if (!(await isLocalHostResolved(target.host))) {
      this.#publish({
        ...emptyStatus(),
        port: target.port,
        reason: "remote",
        detail: "中继地址不在本机（远程中继），插件不托管进程。",
      });
      return this.status;
    }
    if (this.entry === "" || !existsSync(this.entry)) {
      this.#publish({
        ...emptyStatus(),
        port: target.port,
        reason: "no-entry",
        detail:
          "未找到中继程序（relay/server.js）；非仓库布局的安装请设置 DSHRC_RELAY_ENTRY，" +
          "或把 autoStartRelay 设为 false 自行启动中继。",
      });
      return this.status;
    }
    // 已在托管：端口一致才复用；端口变了必须换进程（S1：原来只判「活着」就 return）
    if (this.isChildAlive()) {
      if (this.childPort === target.port) {
        this.#publish({
          managed: true,
          running: true,
          pid: this.child?.pid || 0,
          port: this.childPort,
          reason: "managed",
          detail: `中继进程由插件托管（pid ${this.child?.pid || 0}，端口 ${this.childPort}）。`,
        });
        return this.status;
      }
      this.log("info", "relay port changed; restarting managed relay", {
        from: this.childPort,
        to: target.port,
      });
      await this.stop();
    }
    if (await isRelayPortBusy(target.port, target.host)) {
      // 外部已有中继在监听：不抢、不杀，只如实报告（external → 看门狗**仍会再探一次端口**，
      // 因为占用者随时可能消失——插件热重载时旧实例的中继就是这种情况）
      this.#publish({
        ...emptyStatus(),
        running: true,
        port: target.port,
        external: true,
        reason: "external",
        detail: `端口 ${target.port} 已有服务监听（中继可能已由外部启动），插件不重复启动。`,
      });
      return this.status;
    }
    if (this.disposed) {
      this.#publish({
        ...emptyStatus(),
        port: target.port,
        reason: "not-configured",
        detail: "插件已卸载，不再启动中继进程。",
      });
      return this.status;
    }
    return await this.start(target.port, opts.relayToken);
  }

  /**
   * 真正 spawn 中继子进程。
   * @param {number} port
   * @param {string} [relayToken]
   * @returns {Promise<object>} 状态快照
   */
  async start(port, relayToken = "") {
    const env = {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: process.env.DSHRC_RELAY_LOG_LEVEL || "info",
      // 父子绑定：父进程（DSH）一死，stdin 管道 EOF，中继自己优雅退出
      DSHRC_RELAY_PARENT_WATCHDOG: "1",
    };
    // **跨平台**：宿主若是 Electron（macOS 的 DSH 常见是 .app 打包），process.execPath
    // 是 Electron 可执行文件，直接跑脚本会再开一个应用实例 → 必须让它以 Node 模式运行。
    // Windows 版 DSH 的后端是独立 node.exe（process.versions.electron 为空），不受影响。
    if (process.versions && process.versions.electron) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    if (typeof relayToken === "string" && relayToken !== "") {
      env.RELAY_TOKEN = relayToken;
    }
    let child;
    try {
      child = this.spawnFn(this.nodePath, [this.entry], {
        cwd: dirname(this.entry),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      this.#publish({ ...emptyStatus(), port, detail: "启动中继进程失败：" + String(e && e.message) });
      this.log("error", "relay spawn failed", { error: String(e && e.message) });
      return this.status;
    }
    this.child = child;
    this.childPort = port;
    this.output = "";
    this.#publish({
      managed: true,
      running: true,
      pid: child.pid || 0,
      port,
      reason: "managed",
      detail: `中继进程由插件托管（pid ${child.pid || 0}，端口 ${port}）。`,
    });

    // 收集子进程输出：启动失败时把原因带给宿主日志（M2：原来全被吞掉）
    const onData = (buf) => {
      this.output += String(buf);
      if (this.output.length > 4096) this.output = this.output.slice(-4096);
    };
    if (child.stdout) child.stdout.on("data", onData);
    if (child.stderr) child.stderr.on("data", onData);

    child.on("exit", (code, signal) => {
      // 归属判断：只有「当前持有的那个」退出才清句柄（S3：败者的 exit 回调
      // 曾把胜者的句柄一起清掉 → 变成孤儿，再也管不到）
      if (this.child === child) {
        this.child = null;
        this.childPort = 0;
        // **managed 保持 true**（审计 S2）：子进程崩了不代表「不归我管」——
        // 仍是我们负责的那个中继，只是没在跑 → 看门狗据此重拉。
        this.#publish({
          managed: true,
          running: false,
          pid: 0,
          port,
          external: false,
          reason: "managed",
          detail: `托管的中继进程已退出（code=${String(code)} signal=${String(signal)}），将自动重拉。`,
        });
      }
      this.log("warn", "managed relay exited", { code, signal, port });
    });
    child.on("error", (e) => {
      if (this.child !== child) return;
      this.#publish({ ...emptyStatus(), port, detail: "中继进程出错：" + String(e && e.message) });
      this.log("error", "managed relay error", { error: String(e && e.message) });
    });

    // S5：子进程的三条 stdio 管道 + child 本身都是 ref 句柄，会吊住 DSH 事件循环
    // （DSH 走「排空事件循环」式退出时会一直挂住）。unref 只解除「保持事件循环存活」，
    // 不影响管道本身——stdin EOF 看门狗照常工作。
    // **必须在启动确认之后才 unref**：unref 后若父进程没有别的 ref 句柄，事件循环会空，
    // 正在 await 的 promise 永远不落定（门禁实测踩到：unsettled top-level await）。
    const unrefAll = () => {
      try {
        child.unref?.();
        child.stdin?.unref?.();
        child.stdout?.unref?.();
        child.stderr?.unref?.();
      } catch {
        /* 某些平台不支持 unref，忽略 */
      }
    };

    // 等「listening」确认真的起来了（最多 8s）
    const ready = await this.waitForListening(child, 8000);
    // 等待期间可能已被 stop()/dispose() 收掉 → 句柄不再属于我们，别再发布「运行中」
    if (this.child !== child) {
      this.log("info", "managed relay was stopped while starting", { pid: child.pid || 0, port });
      unrefAll();
      return this.status;
    }
    if (!ready) {
      // 启动失败：把子进程输出带给宿主日志（M2）
      const tail = this.output.trim().split("\n").slice(-6).join(" | ").slice(0, 600);
      this.log("error", "managed relay did not confirm listening", {
        pid: child.pid || 0,
        port,
        output: tail,
      });
    }
    this.#publish({
      managed: true,
      running: ready,
      pid: child.pid || 0,
      port,
      reason: "managed",
      detail: ready
        ? `中继进程由插件托管（pid ${child.pid || 0}，端口 ${port}）。`
        : `中继进程已启动（pid ${child.pid || 0}），但暂未确认监听成功，稍后自动重试。`,
    });
    this.log(ready ? "info" : "warn", ready ? "managed relay ready" : "managed relay starting", {
      pid: child.pid || 0,
      port,
    });
    // 启动确认后再解除 ref（见上面的 S5 说明）
    unrefAll();
    return this.status;
  }

  /**
   * 等子进程打印出「relay listening」/「listening on」——中继启动成功的唯一可靠信号。
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  waitForListening(child, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = [];
      const finish = (v) => {
        if (done) return;
        done = true;
        for (const fn of cleanup) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const check = (buf) => {
        const s = String(buf);
        if (s.includes("relay listening") || s.includes("listening on ws://")) {
          finish(true);
        }
      };
      if (child.stdout) {
        child.stdout.on("data", check);
        cleanup.push(() => child.stdout.removeListener("data", check));
      }
      if (child.stderr) {
        child.stderr.on("data", check);
        cleanup.push(() => child.stderr.removeListener("data", check));
      }
      cleanup.push(() => clearTimeout(timer));
      child.once("exit", () => finish(false));
    });
  }

  /**
   * 停止自己托管的中继（**只停这个 child handle**）。
   *
   * 跨平台差异（实测）：
   *   - **POSIX（Linux/macOS）**：`child.kill('SIGTERM')` 会触发子进程的 signal handler
   *     → 中继走 relay.stop() 优雅关闭（手机端看到正常 close）。
   *   - **Windows**：`child.kill('SIGTERM')` 直接 TerminateProcess（**硬杀，不走 handler**），
   *     所以只发 stdin 的 `shutdown` 命令让中继自己优雅关停；宽限期内没退出才硬杀。
   * 两条路径都等真实退出；「调过 kill」不等于「已退出」（M5：原来据此提前丢句柄）。
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this.child;
    this.child = null;
    this.childPort = 0;
    if (!child) return;
    // 只有「进程真的结束了」才算停完；killed 只说明调过 kill
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#publish({ ...emptyStatus(), detail: "已停止托管的中继进程。" });
      return;
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        clearTimeout(waitTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        // 硬杀后**等进程真的退出**再返回：否则调用方紧接着探测端口仍会看到占用
        waitTimer = setTimeout(finish, 2000);
        if (typeof waitTimer.unref === "function") waitTimer.unref();
      }, STOP_GRACE_MS);
      if (typeof killTimer.unref === "function") killTimer.unref();
      let waitTimer = null;
      child.once("exit", finish);
      // 等待退出期间临时 ref 住子进程：unref 后父进程可能没有别的 ref 句柄，
      // 事件循环一空，这个 await 永远不落定（stop() 会挂住）。
      try {
        child.ref?.();
      } catch {
        /* ignore */
      }
      // 优雅停止（所有平台都走这条）：写 shutdown 命令，子进程读到就自己 relay.stop()
      try {
        if (child.stdin && !child.stdin.destroyed) {
          child.stdin.write(SHUTDOWN_COMMAND + "\n");
        }
      } catch {
        /* 管道已断 → 走下面的硬杀分支 */
      }
      // POSIX 额外补一发 SIGTERM（真优雅信号）；Windows 上跳过——那里 SIGTERM 是硬杀，
      // 会抢在上面的 shutdown 命令之前把进程打死。
      if (process.platform !== "win32") {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    });
    this.#publish({ ...emptyStatus(), detail: "已停止托管的中继进程。" });
  }

  /**
   * 永久停用（插件卸载时调用）：置位 disposed，之后的 ensure 不会再启动任何进程，
   * 并收掉当前托管的进程（S4：原来在途 ensure 会在卸载后把中继拉起来 → 孤儿）。
   * @returns {Promise<void>}
   */
  async dispose() {
    this.disposed = true;
    await this.stop();
  }
}

/**
 * 看门狗判定：现在**要不要**再跑一次 ensure()？（纯函数，便于单测——审计指出接线逻辑零覆盖）
 *
 * 规则：
 *   - 我们托管的进程在跑 → 不用管；
 *   - 未配置 / 关了自动启动 / 远端中继 / 找不到中继程序 → 不用管（再探也没意义）；
 *   - 我们托管的进程崩了 → 要重拉；
 *   - 端口上是**别人**的服务 → **要再探一次端口**！
 *     占用者随时可能消失：插件热重载时旧实例的中继就是这样——
 *     新实例启动时看到端口被占（判 external），随后旧实例被卸载把中继杀了，
 *     若看门狗被 external 挡住，中继就永远起不来（实测过的设计漏洞）。
 *
 * @param {object} status supervisor 的**实时**状态
 * @returns {boolean}
 */
export function shouldRestartRelay(status) {
  if (!status || typeof status !== "object") return false;
  const reason = typeof status.reason === "string" ? status.reason : "";
  if (reason === "managed") return status.running !== true;
  if (reason === "external") return true;
  // 旧版本没有 reason 字段时的兼容判断
  if (status.running === true) return false;
  if (status.external === true) return true;
  return false;
}

/** 插件根目录（导出以便测试与其它模块引用）。 */
export function pluginDir() {
  return PLUGIN_DIR;
}
