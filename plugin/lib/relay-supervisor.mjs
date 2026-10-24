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
// 它监听 stdin 的 EOF——DSH 进程一死管道关闭，中继自己优雅退出，不留孤儿。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本模块所在目录（plugin/lib）→ 插件根目录（plugin/）。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（plugin/）。 */
export const PLUGIN_DIR = resolve(LIB_DIR, "..");

/** 中继入口的候选位置（按优先级）：
 *  1. <plugin>/../relay/server.js —— 仓库布局（link 安装时是软链，指向真实仓库）
 *  2. <plugin>/node_modules/dsh-remote-control-relay/server.js —— 作为 npm 依赖安装
 *  3. 环境变量 DSHRC_RELAY_ENTRY 显式指定
 */
export function resolveRelayEntry(pluginDir = PLUGIN_DIR, env = process.env) {
  const candidates = [];
  if (typeof env.DSHRC_RELAY_ENTRY === "string" && env.DSHRC_RELAY_ENTRY !== "") {
    candidates.push(resolve(env.DSHRC_RELAY_ENTRY));
  }
  candidates.push(resolve(pluginDir, "..", "relay", "server.js"));
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
  return { host: u.hostname, port };
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
 * 端口上是否已有服务在监听（纯 TCP connect 探测，不发数据）。
 * 探测到占用 → 说明外部中继（或上一个残留）已在跑，**不要重复起**。
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

/** 托管状态快照。 */
export function emptyStatus() {
  return {
    /** 是否由插件托管（配置允许且 relayUrl 指向本机）。 */
    managed: false,
    /** 托管的中继子进程是否活着。 */
    running: false,
    /** 子进程 pid（未运行时为 0）。 */
    pid: 0,
    /** 监听端口（未托管时为 0）。 */
    port: 0,
    /** 最近一次状态说明（中文，直接可展示）。 */
    detail: "",
  };
}

/**
 * 中继进程托管器。
 *
 * 生命周期：ensure()（幂等，按需拉起）→ stop()（只停自己起的进程）。
 * 所有 spawn/kill 都针对本对象持有的 child handle——**不按名字或端口杀任何进程**。
 */
export class RelaySupervisor {
  /**
   * @param {object} opts
   * @param {string} [opts.entry]        中继入口（server.js）；缺省自动解析
   * @param {string} [opts.nodePath]     用来起子进程的 node 可执行文件（默认 process.execPath）
   * @param {(level:string, msg:string, extra?:object)=>void} [opts.log]
   * @param {(file:string, args:string[], env:object, opts:object)=>object} [opts.spawnFn]  单测注入点
   */
  constructor(opts = {}) {
    // 注意：**空串是显式的「没有入口」**（测试与「禁用托管」场景用），
    // 不能用 || ——否则 "" 会被当成「没传」而自动解析出真入口。
    this.entry = opts.entry === undefined ? resolveRelayEntry() : opts.entry;
    this.nodePath = opts.nodePath || process.execPath;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.spawnFn = typeof opts.spawnFn === "function" ? opts.spawnFn : spawn;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    /** @type {object} */
    this.status = emptyStatus();
    /** 停止中的子进程（等它退出，避免重复 stop） */
    this.stopping = null;
  }

  /**
   * 确保本机中继在跑（幂等）。返回状态快照。
   *
   * 判定顺序：
   *   1. 没配 relayUrl / 配了 autoStartRelay=false → 不托管
   *   2. relayUrl 指向远端 → 不托管（别人的服务）
   *   3. 找不到中继入口（server.js）→ 不托管（给出提示）
   *   4. 端口已被占用 → 不托管（外部中继在跑），但标记 running
   *   5. 否则 spawn 一个（并等它打印「relay listening」）
   *
   * @param {string} relayUrl
   * @param {object} [opts]
   * @param {boolean} [opts.autoStart]  默认 true
   * @param {string} [opts.relayToken]  中继自身 token（配置了才带）
   * @returns {Promise<object>} 状态快照
   */
  async ensure(relayUrl, opts = {}) {
    const autoStart = opts.autoStart !== false;
    const target = parseRelayTarget(relayUrl);
    if (!target) {
      this.status = { ...emptyStatus(), detail: "未配置中继地址，暂不托管中继进程。" };
      return this.status;
    }
    if (!autoStart) {
      this.status = { ...emptyStatus(), port: target.port, detail: "已关闭「随插件启动中继」。" };
      return this.status;
    }
    if (!isLocalHost(target.host)) {
      this.status = {
        ...emptyStatus(),
        port: target.port,
        detail: "中继地址不在本机（远程中继），插件不托管进程。",
      };
      return this.status;
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      // 已经在托管且活着
      this.status = { ...this.status, managed: true, running: true, port: target.port };
      return this.status;
    }
    if (this.entry === "" || !existsSync(this.entry)) {
      this.status = {
        ...emptyStatus(),
        port: target.port,
        detail: "未找到中继程序（relay/server.js），插件不托管进程。",
      };
      return this.status;
    }
    if (await isPortListening(target.port)) {
      // 外部已有中继在监听：不抢、不杀，只如实报告
      this.status = {
        ...emptyStatus(),
        running: true,
        port: target.port,
        detail: `端口 ${target.port} 已有服务监听（中继可能已由外部启动），插件不重复启动。`,
      };
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
      this.status = { ...emptyStatus(), port, detail: "启动中继进程失败：" + String(e && e.message) };
      this.log("error", "relay spawn failed", { error: String(e && e.message) });
      return this.status;
    }
    this.child = child;
    this.status = { ...emptyStatus(), managed: true, running: true, pid: child.pid || 0, port };

    // 收集子进程输出：只用于识别「已监听」与排障，**不记录进插件日志**（中继日志自带）
    let out = "";
    const onData = (buf) => {
      out += String(buf);
      if (out.length > 4096) out = out.slice(-4096);
    };
    if (child.stdout) child.stdout.on("data", onData);
    if (child.stderr) child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      this.status = {
        ...emptyStatus(),
        port,
        detail: `托管的中继进程已退出（code=${String(code)} signal=${String(signal)}）。`,
      };
      this.child = null;
      this.log("warn", "managed relay exited", { code, signal, port });
    });
    child.on("error", (e) => {
      this.status = { ...emptyStatus(), port, detail: "中继进程出错：" + String(e && e.message) };
      this.log("error", "managed relay error", { error: String(e && e.message) });
    });

    // 等「listening」确认真的起来了（最多 8s）；没等到也不回滚——让上层看状态
    const ready = await this.waitForListening(child, 8000);
    this.status = {
      ...this.status,
      running: ready,
      detail: ready
        ? `中继进程由插件托管（pid ${child.pid || 0}，端口 ${port}）。`
        : `中继进程已启动（pid ${child.pid || 0}），但暂未确认监听成功，稍后自动重试。`,
    };
    this.log("info", ready ? "managed relay ready" : "managed relay starting", {
      pid: child.pid || 0,
      port,
    });
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
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const check = (buf) => {
        const s = String(buf);
        if (s.includes("relay listening") || s.includes("listening on ws://")) {
          clearTimeout(timer);
          finish(true);
        }
      };
      if (child.stdout) child.stdout.on("data", check);
      if (child.stderr) child.stderr.on("data", check);
      child.once("exit", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  }

  /**
   * 停止自己托管的中继（**只停这个 child handle**）。
   * SIGTERM → 宽限 3s → SIGKILL。绝不按名字/端口杀进程。
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        finish();
      }, 3000);
      if (typeof killTimer.unref === "function") killTimer.unref();
      try {
        child.once("exit", finish);
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    this.status = { ...emptyStatus(), detail: "已停止托管的中继进程。" };
  }
}

/** 插件根目录（导出以便测试与其它模块引用）。 */
export function pluginDir() {
  return PLUGIN_DIR;
}
