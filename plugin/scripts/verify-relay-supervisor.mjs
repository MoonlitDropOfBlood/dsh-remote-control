// scripts/verify-relay-supervisor.mjs —— 中继进程托管（v1.1.1）门禁
//
// 覆盖：
//   1. 纯函数：relayUrl 解析、本机判定、入口解析
//   2. 决策：远端不托管 / autoStart=false 不托管 / 找不到入口不托管 / 端口被占用不抢
//   3. 生命周期：真 spawn 一个**桩中继**（临时脚本 + 临时端口）→ 确认监听 → stop() 收掉
//   4. 进程安全：端口占用时不 spawn；stop 只杀自己 handle 起的进程
//
// 无外部依赖（不碰真实中继端口，不连真实中继）。
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn as realSpawn } from "node:child_process";
import {
  RelaySupervisor,
  isLocalHost,
  isPortListening,
  isRelayPortBusy,
  parseRelayTarget,
  resolveRelayEntry,
  shouldRestartRelay,
  PLUGIN_DIR,
} from "../lib/relay-supervisor.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("ok: " + name);
  } else {
    fail++;
    console.log("FAIL: " + name + (extra ? " — " + String(extra).slice(0, 200) : ""));
  }
}

/** 清理临时目录（子进程刚退出时句柄可能还没释放 → 删不掉不该让门禁失败）。 */
function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录残留不影响验收 */
  }
}

/**
 * keep-alive：本门禁会 spawn 真实子进程，而 supervisor 在启动确认后会 unref 子进程句柄
 * （避免吊住宿主事件循环）。单独跑这个脚本时父进程可能没有别的 ref 句柄 → 事件循环一空，
 * 顶层 await 永远不落定（实测 unsettled top-level await）。用一个定时器兜住。
 */
const keepAlive = setInterval(() => {}, 200);

/** 找一个空闲端口（用完即释放，避免与真实服务撞）。 */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

/** 桩中继：行为对齐真中继的关键约定（打印 listening、支持 shutdown 命令、stdin EOF 退出）。 */
let stubCounter = 0;
function stubEntry() {
  const dir = mkdtempSync(join(tmpdir(), "dshrc-stub-relay-"));
  stubCounter++;
  const file = join(dir, "stub-" + stubCounter + ".mjs");
  writeFileSync(
    file,
    [
      "import { createServer } from 'node:net';",
      "const port = Number(process.env.PORT || 0);",
      "const srv = createServer();",
      "srv.listen(port, '0.0.0.0', () => {",
      "  console.log('relay listening port=' + srv.address().port + ' (pid ' + process.pid + ')');",
      "});",
      "const bye = () => { srv.close(() => process.exit(0)); };",
      "process.on('SIGTERM', bye);",
      "process.on('SIGINT', bye);",
      "if (process.env.DSHRC_RELAY_PARENT_WATCHDOG === '1' && process.stdin) {",
      "  let buf = '';",
      "  process.stdin.on('data', (c) => {",
      "    buf += String(c);",
      "    const i = buf.indexOf('\\n');",
      "    if (i >= 0) {",
      "      const line = buf.slice(0, i).trim();",
      "      if (line === 'shutdown') bye();",
      "    }",
      "  });",
      "  process.stdin.on('end', bye);",
      "  process.stdin.resume();",
      "}",
    ].join("\n"),
  );
  return file;
}

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------
{
  const t = parseRelayTarget("ws://192.168.3.2:8788");
  check("parseRelayTarget 解析 host/port", t && t.host === "192.168.3.2" && t.port === 8788, JSON.stringify(t));

  const d = parseRelayTarget("ws://example.com");
  check("parseRelayTarget 缺省端口 ws→80", d && d.port === 80, JSON.stringify(d));

  const s = parseRelayTarget("wss://example.com");
  check("parseRelayTarget 缺省端口 wss→443", s && s.port === 443, JSON.stringify(s));

  check("parseRelayTarget 拒绝非 ws 协议", parseRelayTarget("http://x:1") === null);
  check("parseRelayTarget 拒绝空串", parseRelayTarget("") === null);
  check("parseRelayTarget 拒绝垃圾", parseRelayTarget("not a url") === null);

  check("isLocalHost 认 localhost", isLocalHost("localhost"));
  check("isLocalHost 认 127.0.0.1", isLocalHost("127.0.0.1"));
  check("isLocalHost 认 ::1", isLocalHost("::1"));
  check("isLocalHost 认 0.0.0.0", isLocalHost("0.0.0.0"));
  check("isLocalHost 拒绝公网地址", !isLocalHost("8.8.8.8"));
  check("isLocalHost 拒绝空串", !isLocalHost(""));
  // 本机网卡地址
  const ifaces = { eth0: [{ address: "10.1.2.3", family: "IPv4", internal: false }] };
  check("isLocalHost 认本机网卡地址", isLocalHost("10.1.2.3", ifaces));
  check("isLocalHost 拒绝非本机地址", !isLocalHost("10.9.9.9", ifaces));

  const entry = resolveRelayEntry();
  check("resolveRelayEntry 找到中继入口（仓库布局）", typeof entry === "string" && entry.endsWith("server.js"), entry);
}

// ---------------------------------------------------------------------------
// 2. 决策（不 spawn）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: "", spawnFn: () => { throw new Error("不该 spawn"); } });
  const s1 = await sup.ensure("", {});
  check("未配 relayUrl → 不托管", s1.managed === false && s1.detail.includes("未配置"), JSON.stringify(s1));

  const s2 = await sup.ensure("ws://8.8.8.8:8788", {});
  check("远端中继 → 不托管", s2.managed === false && s2.detail.includes("不在本机"), JSON.stringify(s2));

  const s3 = await sup.ensure("ws://127.0.0.1:8788", { autoStart: false });
  check("autoStart=false → 不托管", s3.managed === false && s3.detail.includes("关闭"), JSON.stringify(s3));

  const s4 = await sup.ensure("ws://127.0.0.1:8788", {});
  check("找不到入口 → 不托管（不抛）", s4.managed === false && s4.detail.includes("未找到"), JSON.stringify(s4));
}

// ---------------------------------------------------------------------------
// 3. 端口占用 → 不抢（真实起一个监听端口验证）
// ---------------------------------------------------------------------------
{
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  check("isPortListening 探测到占用端口", (await isPortListening(port)) === true);

  let spawned = false;
  const sup = new RelaySupervisor({
    entry: resolveRelayEntry(),
    spawnFn: () => {
      spawned = true;
      throw new Error("不该 spawn");
    },
  });
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("端口被占用 → 不 spawn（不抢外部中继）", spawned === false && s.managed === false, JSON.stringify(s));
  check("端口被占用 → 状态标注已有服务", s.detail.includes("已有服务"), s.detail);

  await new Promise((r) => server.close(r));
  check("isPortListening 探测空闲端口为 false", (await isPortListening(port)) === false);
}

// ---------------------------------------------------------------------------
// 4. 生命周期：真 spawn 桩中继 → 监听 → stop() 收掉
// ---------------------------------------------------------------------------
{
  // 共享桩（与真中继的关键约定一致：打印 listening、支持 shutdown 命令、stdin EOF 退出）
  const entry = stubEntry();

  // 找一个空闲端口给桩用
  const port = await freePort();

  const sup = new RelaySupervisor({ entry });
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("托管模式：spawn 成功且 managed", s.managed === true && s.running === true, JSON.stringify(s));
  check("托管模式：拿到子进程 pid", s.pid > 0, String(s.pid));
  check("托管模式：端口被桩中继监听", (await isPortListening(port)) === true);

  // 幂等：再 ensure 一次不应重复 spawn（pid 不变）
  const s2 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("ensure 幂等：不重复 spawn（pid 不变）", s2.pid === s.pid, s2.pid + " vs " + s.pid);

  await sup.stop();
  check("stop() 后端口不再监听", (await isPortListening(port)) === false);
  check("stop() 后状态清空", sup.child === null);
}

// ---------------------------------------------------------------------------
// 5. 父进程看门狗：**真 relay/server.js**（不是自写桩！）
//    审计发现：原来这条测的是脚本自写桩 → 删掉 relay/server.js 的看门狗照样绿（假阳性）。
// ---------------------------------------------------------------------------
{
  const realEntry = resolveRelayEntry();
  const { spawn } = await import("node:child_process");

  // 注意：**直接跑真入口**，不要复制到临时目录——ESM 的依赖解析按**文件位置**走，
  // 复制出去就找不到 relay/node_modules 里的 ws 了（实测启动失败）。
  const port = await freePort();
  const child = spawn(process.execPath, [realEntry], {
    cwd: dirname(realEntry), // relay/ 目录：node_modules/ws 在这里
    env: { ...process.env, PORT: String(port), DSHRC_RELAY_PARENT_WATCHDOG: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sawListening = false;
  let stderrText = "";
  child.stderr.on("data", (b) => {
    stderrText += String(b);
  });
  await new Promise((r) => {
    child.stdout.on("data", (b) => {
      if (String(b).includes("listening")) sawListening = true;
    });
    setTimeout(r, 3000);
  });
  check("真中继：能启动并监听（看门狗变量下）", sawListening && (await isPortListening(port)), stderrText.slice(0, 300));

  // 父进程死亡模拟：stdin 写端关闭 → 真中继应自行退出
  child.stdin.end();
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  check("真中继看门狗：父进程 stdin 关闭 → 中继自行退出", exited === true);
  check("真中继退出后端口释放", (await isPortListening(port)) === false);

  // 手工启动（不带看门狗变量）：stdin EOF **不应**让它退出
  const child2 = spawn(process.execPath, [realEntry], {
    cwd: dirname(realEntry),
    env: { ...process.env, PORT: String(port), DSHRC_RELAY_PARENT_WATCHDOG: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((r) => setTimeout(r, 2500));
  child2.stdin.end();
  const exited2 = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2500);
    child2.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  check("手工启动行为不变（无看门狗变量时 stdin EOF 不退出）", exited2 === false);
  try {
    child2.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 6. 优雅停止通道：stdin 的 shutdown 命令 → 中继自己 relay.stop()（Windows 上 SIGTERM 是硬杀）
// ---------------------------------------------------------------------------
{
  const realEntry = resolveRelayEntry();
  const { spawn } = await import("node:child_process");
  const port = await freePort();
  const child = spawn(process.execPath, [realEntry], {
    cwd: dirname(realEntry),
    env: { ...process.env, PORT: String(port), DSHRC_RELAY_PARENT_WATCHDOG: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((r) => setTimeout(r, 2500));
  check("优雅停止前：端口在监听", (await isPortListening(port)) === true);
  child.stdin.write("shutdown\n");
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
  check("stdin shutdown 命令 → 中继优雅退出（exit code 0）", exited === true);
  check("优雅停止后端口释放", (await isPortListening(port)) === false);
}

// ---------------------------------------------------------------------------
// 7. 审计 S1：改端口 → 旧进程要收掉、新进程要拉起（原来只判「子进程活着」就 return）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const portA = await freePort();
  const portB = await freePort();
  const a = await sup.ensure("ws://127.0.0.1:" + portA, {});
  check("S1 前置：端口 A 已托管", a.managed && a.running && a.port === portA, JSON.stringify(a));
  const pidA = a.pid;
  const b = await sup.ensure("ws://127.0.0.1:" + portB, {});
  check("S1：改端口后 pid 变了（换了进程）", b.pid !== pidA, b.pid + " vs " + pidA);
  check("S1：状态端口 = 新端口", b.port === portB, JSON.stringify(b));
  check("S1：旧端口已释放", (await isPortListening(portA)) === false);
  check("S1：新端口在监听", (await isPortListening(portB)) === true);
  await sup.stop();
  check("S1 收尾：停止后新端口也释放", (await isPortListening(portB)) === false);
}

// ---------------------------------------------------------------------------
// 8. 审计 S3：并发 ensure → 只能 spawn 一次（in-flight 锁）
// ---------------------------------------------------------------------------
{
  let spawnCount = 0;
  const sup = new RelaySupervisor({
    entry: stubEntry(),
    spawnFn: (...args) => {
      spawnCount++;
      return realSpawn(...args);
    },
  });
  const port = await freePort();
  const [r1, r2, r3] = await Promise.all([
    sup.ensure("ws://127.0.0.1:" + port, {}),
    sup.ensure("ws://127.0.0.1:" + port, {}),
    sup.ensure("ws://127.0.0.1:" + port, {}),
  ]);
  check("S3：并发 ensure 只 spawn 一次", spawnCount === 1, "spawn=" + spawnCount);
  check("S3：并发结果一致（同 pid）", r1.pid === r2.pid && r2.pid === r3.pid, [r1.pid, r2.pid, r3.pid].join(","));
  check("S3：句柄没丢（child 仍被持有）", sup.child !== null && sup.child.pid === r1.pid);
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 9. 审计 S2：托管进程崩溃 → 看门狗能重拉（状态必须实时，不能是旧快照）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("S2 前置：已托管", s.managed && s.running, JSON.stringify(s));
  const pid = s.pid;
  // 模拟崩溃：强杀子进程
  try {
    sup.child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1200));
  check("S2：崩溃后 supervisor 状态实时更新为未运行", sup.status.running === false, JSON.stringify(sup.status));
  check("S2：崩溃后状态里的 pid 已清空", (sup.status.pid || 0) === 0, JSON.stringify(sup.status));
  // 看门狗逻辑（index.js 里就是这个判定）：读实时状态 → 应判定为「需要重拉」
  const live = sup.status;
  check("S2：看门狗判定为需要重拉（managed 且 !running）", live.managed === true && live.running === false);
  // 再 ensure 一次 → 应重新拉起
  const again = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("S2：重拉成功（新 pid）", again.running === true && again.pid !== pid, again.pid + " vs " + pid);
  check("S2：重拉后端口在监听", (await isPortListening(port)) === true);
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 10. 审计 S4：dispose（卸载）后在途 ensure 不会再拉起中继
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  const inflight = sup.ensure("ws://127.0.0.1:" + port, {});
  // 立刻 dispose（模拟插件卸载与 ensure 并发）
  await sup.dispose();
  await inflight;
  await new Promise((r) => setTimeout(r, 800));
  check("S4：dispose 后端口没有中继（无孤儿）", (await isPortListening(port)) === false);
  check("S4：dispose 后不再持有子进程", sup.child === null);
  const after = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("S4：dispose 后再 ensure 也不启动", after.managed === false && (await isPortListening(port)) === false, JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// 11. 审计 S5：unref 后父进程事件循环不被子进程管道吊住
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  const child = sup.child;
  const refd = typeof child._handle?.hasRef === "function" ? child._handle.hasRef() : null;
  check("S5：子进程句柄已 unref（不吊住父进程事件循环）", refd === false, String(refd));
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 12. 跨平台：Electron 宿主要注入 ELECTRON_RUN_AS_NODE（否则 macOS 的 .app 会再开一个应用）
// ---------------------------------------------------------------------------
{
  let capturedEnv = null;
  const sup = new RelaySupervisor({
    entry: stubEntry(),
    spawnFn: (file, args, opts) => {
      capturedEnv = opts.env;
      return realSpawn(file, args, opts);
    },
  });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  check("跨平台：spawn 带上 PORT 环境变量", capturedEnv && capturedEnv.PORT === String(port), JSON.stringify(capturedEnv?.PORT));
  check(
    "跨平台：Electron 宿主时注入 ELECTRON_RUN_AS_NODE（当前非 Electron 则不注入）",
    process.versions?.electron ? capturedEnv.ELECTRON_RUN_AS_NODE === "1" : capturedEnv.ELECTRON_RUN_AS_NODE === undefined,
    String(capturedEnv?.ELECTRON_RUN_AS_NODE),
  );
  check("跨平台：注入父子绑定变量", capturedEnv?.DSHRC_RELAY_PARENT_WATCHDOG === "1");
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 13. 审计 M1：端口探测要同时看 127.0.0.1 与目标 host（只绑 LAN IP 的外部服务不能漏判）
// ---------------------------------------------------------------------------
{
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  const port = server.address().port;
  const busyLocal = await isRelayPortBusy(port, "127.0.0.1");
  const busyLan = await isRelayPortBusy(port, "192.168.3.2");
  check("M1：0.0.0.0 监听的端口在探 127.0.0.1 时也判为占用", busyLocal === true, String(busyLocal));
  check("M1：0.0.0.0 监听的端口在探 LAN IP 时也判为占用", busyLan === true, String(busyLan));
  await new Promise((r) => server.close(r));
}

// ---------------------------------------------------------------------------
// 14. IPv6 / 边界（审计 L1）
// ---------------------------------------------------------------------------
{
  const t = parseRelayTarget("ws://[::1]:8788");
  check("IPv6：host 去掉方括号", t && t.host === "::1", JSON.stringify(t));
  check("IPv6：::1 认作本机", isLocalHost("::1"));
  check("边界：端口 0 视为非法", parseRelayTarget("ws://h:0") === null);
  check("边界：端口 70000 视为非法", parseRelayTarget("ws://h:70000") === null);
}

// ---------------------------------------------------------------------------
// 15. 看门狗判定（接线的纯函数部分——审计指出 index.js 接线零覆盖）
// ---------------------------------------------------------------------------
{
  check("看门狗：在跑 → 不重拉", shouldRestartRelay({ running: true, managed: true, reason: "managed" }) === false);
  check("看门狗：外部中继 → 要再探一次端口", shouldRestartRelay({ running: true, managed: false, external: true, reason: "external" }) === true);
  check("看门狗：我们托管的崩了 → 要重拉", shouldRestartRelay({ running: false, managed: true, external: false, reason: "managed" }) === true);
  check("看门狗：未配置 → 不重拉", shouldRestartRelay({ running: false, reason: "not-configured" }) === false);
  check("看门狗：远端中继 → 不重拉", shouldRestartRelay({ running: false, reason: "remote" }) === false);
  check("看门狗：关掉自动启动 → 不重拉", shouldRestartRelay({ running: false, reason: "disabled" }) === false);
  check("看门狗：找不到中继程序 → 不重拉", shouldRestartRelay({ running: false, reason: "no-entry" }) === false);
  check("看门狗：空状态 → 不重拉", shouldRestartRelay(null) === false);
  check("看门狗：undefined → 不重拉", shouldRestartRelay(undefined) === false);
  check("看门狗：旧版状态（无 reason）在跑 → 不重拉", shouldRestartRelay({ running: true }) === false);
}

// ---------------------------------------------------------------------------
// 16. 跨平台：POSIX 与 Windows 的停止路径差异（不能靠平台假设写死）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  const child = sup.child;
  // 优雅停止走 stdin 命令通道（所有平台都一样，Windows 上 SIGTERM 是硬杀不能用）
  await sup.stop();
  check("跨平台：stop 后子进程真的退出（不是只调了 kill）", child.exitCode !== null || child.signalCode !== null);
  check("跨平台：stop 后端口释放", (await isPortListening(port)) === false);
}

// ---------------------------------------------------------------------------
// 17. bundle 安装形态：包里必须带得动中继（vendor 副本 + ws 依赖）
// ---------------------------------------------------------------------------
{
  // 17a. vendor 副本必须与源文件同步（改了 relay/server.js 忘了重新生成 → 门禁 FAIL）
  const { execFileSync } = await import("node:child_process");
  let syncOk = true;
  let syncMsg = "";
  try {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "vendor-relay.mjs"), "--check"], {
      encoding: "utf8",
    });
    syncMsg = out.trim();
  } catch (e) {
    syncOk = false;
    syncMsg = String((e && e.stderr) || e).slice(0, 300);
  }
  check("bundle：vendor 中继副本与源文件同步", syncOk, syncMsg);

  // 17b. 插件包里必须有 vendor 副本（bundle 安装时唯一的入口来源）
  const vendorEntry = resolve(PLUGIN_DIR, "vendor", "relay", "server.js");
  check("bundle：插件包内含 vendor/relay/server.js", existsSync(vendorEntry), vendorEntry);
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
  check("bundle：package.json 的 files 含 vendor", Array.isArray(pkg.files) && pkg.files.includes("vendor"));
  check("bundle：package.json 依赖 ws（中继的唯一依赖）", !!(pkg.dependencies && pkg.dependencies.ws));

  // 17c. 模拟 bundle 布局（只有 plugin/ 目录，没有仓库的 relay/）→ 仍能解析到入口
  const fakePluginDir = mkdtempSync(join(tmpdir(), "dshrc-bundle-"));
  mkdirSync(join(fakePluginDir, "vendor", "relay"), { recursive: true });
  copyFileSync(vendorEntry, join(fakePluginDir, "vendor", "relay", "server.js"));
  const resolvedInBundle = resolveRelayEntry(fakePluginDir, {});
  check("bundle 布局：能解析到中继入口", resolvedInBundle.endsWith(join("vendor", "relay", "server.js")), resolvedInBundle);
  cleanupDir(fakePluginDir);
}

// ---------------------------------------------------------------------------
// 18. 回归：外部占用者消失后要能接管端口
//     （插件热重载的真实竞态：新实例启动时旧实例还占着端口 → 判 external；
//       随后旧实例被卸载把中继杀了 → 若看门狗被 external 挡住，中继就永远起不来）
// ---------------------------------------------------------------------------
{
  const { createServer } = await import("node:net");
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  // 模拟「旧实例的中继」占着端口
  const squatter = createServer();
  await new Promise((r) => squatter.listen(port, "127.0.0.1", r));

  const s1 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("回归：端口被占时不 spawn（判 external）", s1.external === true && s1.managed === false, JSON.stringify(s1));
  check("回归：external 状态下看门狗仍会再探端口", shouldRestartRelay(s1) === true);

  // 旧实例被卸载 → 占用者消失
  await new Promise((r) => squatter.close(r));
  await new Promise((r) => setTimeout(r, 400));
  check("回归：占用者消失后端口空闲", (await isPortListening(port)) === false);

  // 看门狗再跑一轮 → 插件接管
  const s2 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("回归：端口空了以后插件能接管（自己起中继）", s2.managed === true && s2.running === true, JSON.stringify(s2));
  check("回归：接管后端口在监听", (await isPortListening(port)) === true);
  await sup.stop();
}

console.log("\nverify-relay-supervisor: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
