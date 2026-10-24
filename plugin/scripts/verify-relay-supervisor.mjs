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
  isLocalHostResolved,
  isPortListening,
  isRelayPortBusy,
  parseRelayTarget,
  resolveRelayEntry,
  shouldRestartRelay,
  shouldTickWatchdog,
  setDnsLookup,
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
/** 所有桩目录登记在册，退出时统一清理（N9：每次门禁泄漏 8 个临时目录）。 */
const stubDirs = [];
function stubEntry() {
  const dir = mkdtempSync(join(tmpdir(), "dshrc-stub-relay-"));
  stubDirs.push(dir);
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
  // **嵌套父目录**（第三轮审计 #5）：直接放 TEMP 根的话，`../relay/server.js` 会撞上
  // 共享 TEMP 里的残留 relay/（审计遗留过一次 → 全机门禁假红）。嵌套一层就隔离了。
  const nestDir = mkdtempSync(join(tmpdir(), "dshrc-bundle-nest-"));
  const fakePluginDir = join(nestDir, "plugin");
  mkdirSync(join(fakePluginDir, "vendor", "relay"), { recursive: true });
  copyFileSync(vendorEntry, join(fakePluginDir, "vendor", "relay", "server.js"));
  const resolvedInBundle = resolveRelayEntry(fakePluginDir, {});
  check("bundle 布局：能解析到中继入口", resolvedInBundle.endsWith(join("vendor", "relay", "server.js")), resolvedInBundle);
  cleanupDir(nestDir);
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

// ---------------------------------------------------------------------------
// 19. 回归 N1：插件被禁用 / 未配置时，看门狗绝不能把中继拉起来
//     （审计实测：enabled=false 时看门狗 34s 后照样起了 0.0.0.0 的中继）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  const s = await sup.ensure("ws://127.0.0.1:" + port, { autoStart: false });
  check("N1：autoStart=false → 不托管", s.managed === false && s.running === false, JSON.stringify(s));
  check("N1：autoStart=false → 看门狗不重拉", shouldRestartRelay(s) === false, JSON.stringify(s));
  check("N1：autoStart=false → 端口没人监听", (await isPortListening(port)) === false);
  check("N1：未配置地址 → 看门狗不重拉", shouldRestartRelay({ running: false, reason: "not-configured" }) === false);
  check("N1：远端中继 → 看门狗不重拉", shouldRestartRelay({ running: false, reason: "remote" }) === false);
  check("N1：找不到入口 → 看门狗不重拉", shouldRestartRelay({ running: false, reason: "no-entry" }) === false);
  // 旧状态（无 reason 字段）也必须靠 managed 判定挡住
  check("N1：无 reason 且 managed=false → 不重拉", shouldRestartRelay({ running: false, managed: false }) === false);
  check("N1：无 reason 且 managed=true 且没跑 → 要重拉", shouldRestartRelay({ running: false, managed: true }) === true);
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 20. 回归 N2：dispose 后「重新加载」要能重新托管（否则 set_plugin 关→开就废了）
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  const first = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("N2 前置：首次托管成功", first.running === true, JSON.stringify(first));
  await sup.dispose();
  check("N2：dispose 后 disposed=true", sup.disposed === true);
  // 重新加载 = 新实例（index.js 卸载时会 HOST_STATES.delete(ctx) → 重建）
  const sup2 = new RelaySupervisor({ entry: stubEntry() });
  const again = await sup2.ensure("ws://127.0.0.1:" + port, {});
  check("N2：新实例能重新托管（端口已释放）", again.managed === true && again.running === true, JSON.stringify(again));
  check("N2：新实例后端口在监听", (await isPortListening(port)) === true);
  await sup2.stop();
  await sup.dispose();
}

// ---------------------------------------------------------------------------
// 21. 回归 N3：崩溃时子进程输出必须进日志（否则崩溃循环无痕）
// ---------------------------------------------------------------------------
{
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), "dshrc-crash-"));
  const entry = join(dir, "crasher.mjs");
  writeFileSync(
    entry,
    [
      "console.error('FATAL: EADDRINUSE port already in use');",
      "process.exit(3);",
    ].join("\n"),
  );
  const sup = new RelaySupervisor({
    entry,
    log: (level, msg, extra) => logs.push({ level, msg, extra }),
  });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  await new Promise((r) => setTimeout(r, 1500));
  const text = JSON.stringify(logs);
  check("N3：崩溃原因进了日志", text.includes("EADDRINUSE"), text.slice(0, 300));
  check("N3：崩溃后状态 running=false（可重拉）", sup.status.running === false, JSON.stringify(sup.status));
  check("N3：崩溃后状态 reason=managed（看门狗会重拉）", sup.status.reason === "managed");
  check("N3：崩溃后看门狗判定要重拉", shouldRestartRelay(sup.status) === true);
  await sup.stop();
  cleanupDir(dir);
}

// ---------------------------------------------------------------------------
// 22. 回归 N6：从未确认过监听的进程（还在启动等待期）——不谎报 running，也不急着换
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "dshrc-silent-"));
  const entry = join(dir, "silent.mjs");
  // **什么都不打印**（waitForListening 8s 超时 → 从未确认监听）
  writeFileSync(entry, ["setInterval(() => {}, 1000);"].join("\n"));
  const sup = new RelaySupervisor({ entry });
  const port = await freePort();
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("N6：确认监听后才报 running=true", s.running === false, JSON.stringify(s));
  // 再 ensure 一次：进程活着但从未确认监听 → 还在启动等待期 → 不换进程、不谎报
  const s2 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("N6：端口没监听时 running=false（不谎报）", s2.running === false, JSON.stringify(s2));
  check("N6：从未确认监听 → 不替换进程（还在启动期）", s2.pid === s.pid, s2.pid + " vs " + s.pid);
  check("N6：端口没监听时看门狗仍会重试", shouldRestartRelay(s2) === true);
  await sup.stop();
  cleanupDir(dir);
}

// ---------------------------------------------------------------------------
// 22b. 第三轮审计 #2：僵尸子进程（曾确认监听、现在不监听）必须被**替换**
//     （真中继的 wss 'error' 只记日志不退出 → 进程活着但不服务 → 原实现永不换）
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "dshrc-zombie-"));
  const entry = join(dir, "zombie.mjs");
  // 打印 listening 关键字（骗过 waitForListening）但**不真的监听**
  writeFileSync(entry, ["console.log('relay listening (pretend)');", "setInterval(() => {}, 1000);"].join("\n"));
  const sup = new RelaySupervisor({ entry });
  const port = await freePort();
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("僵尸：首次 ensure 确认过 listening（骗过）", s.running === true && sup.childReady === true, JSON.stringify(s));
  const pid1 = s.pid;
  const s2 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("僵尸：探不到监听 → 替换进程（新 pid）", s2.pid !== pid1, s2.pid + " vs " + pid1);
  check("僵尸：替换后状态回到 running=true", s2.running === true, JSON.stringify(s2));
  await sup.stop();
  cleanupDir(dir);
}

// ---------------------------------------------------------------------------
// 22c. 第三轮审计 #1：stop() 与在途 ensure 竞态 → 不得留下孤儿中继
//     （设置页清空中继地址走 stop()；若在途 ensure 照常 spawn，中继就成了没人管的孤儿）
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "dshrc-stoprace-"));
  const entry = join(dir, "slow.mjs");
  // 延迟 1.2s 才打印 listening → ensure 还在 waitForListening 时我们就喊停
  writeFileSync(
    entry,
    ["setTimeout(() => console.log('relay listening port=' + process.env.PORT), 1200);", "setInterval(() => {}, 1000);"].join("\n"),
  );
  const sup = new RelaySupervisor({ entry });
  const port = await freePort();
  const inflight = sup.ensure("ws://127.0.0.1:" + port, {});
  await new Promise((r) => setTimeout(r, 300)); // ensure 已 spawn、正在等 listening
  await sup.stop(); // 模拟「设置页清空中继地址」
  const s = await inflight;
  await new Promise((r) => setTimeout(r, 1600)); // 给「本不该发生的二次 spawn」留时间
  check("stop 竞态：ensure 返回后没有新进程在跑", sup.child === null, JSON.stringify(sup.status));
  check("stop 竞态：端口无人监听（无孤儿）", (await isPortListening(port)) === false);
  check("stop 竞态：世代号已递增", sup.epoch >= 1, String(sup.epoch));
  cleanupDir(dir);
}

// ---------------------------------------------------------------------------
// 22d. 第三轮审计 #3：三路并发 ensure（A→p1, B→p2, C→p1）→ C 不得拿到陈旧端口
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const p1 = await freePort();
  const p2 = await freePort();
  const [r1, r2, r3] = await Promise.all([sup.ensure("ws://127.0.0.1:" + p1, {}), sup.ensure("ws://127.0.0.1:" + p2, {}), sup.ensure("ws://127.0.0.1:" + p1, {})]);
  check("N8 三路：C 返回自己的目标端口（不是陈旧值）", r3.port === p1, JSON.stringify(r3));
  check("N8 三路：最终托管在 C 的目标上", sup.status.port === p1, JSON.stringify(sup.status));
  check("N8 三路：C 的端口真的在监听", (await isPortListening(p1)) === true);
  check("N8 三路：B 的端口已释放（被 S1 换掉）", (await isPortListening(p2)) === false);
  check("N8 三路：三路结果各自带各自的端口", r1.port === p1 && r2.port === p2, r1.port + "," + r2.port);
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 23. 回归 N4：IPv6 端口探测不能漏判
// ---------------------------------------------------------------------------
{
  const { createServer } = await import("node:net");
  const server = createServer();
  let bound = false;
  try {
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(0, "::1", () => {
        bound = true;
        r();
      });
    });
  } catch {
    // 设备不支持 IPv6 → 跳过（不算失败）
    bound = false;
  }
  if (bound) {
    const p6 = server.address().port;
    check("N4：只绑 [::1] 的端口也判为占用", (await isRelayPortBusy(p6, "::1")) === true, String(p6));
  } else {
    check("N4：本机不支持 IPv6（跳过 IPv6 探测断言）", true);
  }
  await new Promise((r) => server.close(r));
}

// ---------------------------------------------------------------------------
// 24. 回归 N8：并发 ensure 不同目标地址 → 不能返回陈旧端口
// ---------------------------------------------------------------------------
{
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const portA = await freePort();
  const portB = await freePort();
  const [ra, rb] = await Promise.all([
    sup.ensure("ws://127.0.0.1:" + portA, {}),
    sup.ensure("ws://127.0.0.1:" + portB, {}),
  ]);
  check("N8：并发不同目标不会都返回同一个端口", ra.port !== rb.port, ra.port + " vs " + rb.port);
  check("N8：最终状态端口 = 后一个目标", sup.status.port === portB, JSON.stringify(sup.status));
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 25. 变异级盲区补齐（第二轮审计用变异测试找出：这些点改了代码，71 项照样全绿）
// ---------------------------------------------------------------------------
{
  // 盲区①：exit 回调的**归属判断**（S3）——去掉 `this.child === child` 就会把
  // 胜者的句柄清掉变成孤儿。用「先起 A、再 ensure 到 B（端口变了→A 被 stop）」验证。
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const portA = await freePort();
  const portB = await freePort();
  const a = await sup.ensure("ws://127.0.0.1:" + portA, {});
  const pidA = a.pid;
  check("变异盲区①：先起了 A", pidA > 0 && (await isPortListening(portA)) === true);
  await sup.ensure("ws://127.0.0.1:" + portB, {});
  await new Promise((r) => setTimeout(r, 600));
  check("变异盲区①：换端口后旧进程真的退出了", (await isPortListening(portA)) === false);
  check("变异盲区①：句柄指向新进程（不是被清空的旧句柄）", sup.child !== null && sup.child.pid !== pidA);
  check("变异盲区①：新端口在监听", (await isPortListening(portB)) === true);
  await sup.stop();
}
{
  // 盲区②：unref 时机（S5）——提前 unref 会让父进程事件循环空掉、await 永不落定。
  // 这里直接检查「启动确认前句柄是 ref 的、确认后是 unref 的」。
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  const child = sup.child;
  const hasRef = typeof child._handle?.hasRef === "function" ? child._handle.hasRef() : null;
  check("变异盲区②：启动确认后子进程已 unref（不吊住宿主事件循环）", hasRef === false, String(hasRef));
  await sup.stop();
}
{
  // 盲区③：stop 走 stdin 的 shutdown 命令（Windows 上 SIGTERM 是硬杀，这条是唯一的优雅路径）
  // —— 断言「子进程是被命令停掉的」：桩中继在收到 shutdown 时才打印一行。
  const dir = mkdtempSync(join(tmpdir(), "dshrc-shutdown-"));
  const entry = join(dir, "shut.mjs");
  writeFileSync(
    entry,
    [
      "import { createServer } from 'node:net';",
      "const srv = createServer();",
      "srv.listen(Number(process.env.PORT || 0), '0.0.0.0', () => console.log('relay listening port=' + srv.address().port));",
      "let buf = '';",
      "process.stdin.on('data', (c) => {",
      "  buf += String(c);",
      "  const i = buf.indexOf('\\n');",
      "  if (i >= 0 && buf.slice(0, i).trim() === 'shutdown') {",
      "    console.log('GOT_SHUTDOWN_COMMAND');",
      "    srv.close(() => process.exit(0));",
      "  }",
      "});",
      "process.stdin.resume();",
    ].join("\n"),
  );
  const sup = new RelaySupervisor({ entry });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  const child = sup.child;
  let sawCommand = false;
  child.stdout.on("data", (b) => {
    if (String(b).includes("GOT_SHUTDOWN_COMMAND")) sawCommand = true;
  });
  await sup.stop();
  await new Promise((r) => setTimeout(r, 300));
  check("变异盲区③：stop 真的下了 shutdown 命令（不是靠 SIGTERM 硬杀）", sawCommand === true);
  cleanupDir(dir);
}
{
  // 盲区④：端口探测要同时看 127.0.0.1 与目标 host（M1）
  // —— 用一个**只绑 192.168.3.2** 的服务验证（127.0.0.1 连不上，但 LAN IP 连得上）。
  const { createServer } = await import("node:net");
  const { networkInterfaces } = await import("node:os");
  const lanAddr = Object.values(networkInterfaces())
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal);
  if (lanAddr) {
    const server = createServer();
    await new Promise((r) => server.listen(0, lanAddr.address, r));
    const p = server.address().port;
    const localOnly = await isPortListening(p, "127.0.0.1");
    const lanOnly = await isPortListening(p, lanAddr.address);
    check("变异盲区④：只绑 LAN IP 的服务在 127.0.0.1 上连不上", localOnly === false, String(localOnly));
    check("变异盲区④：只绑 LAN IP 的服务在 LAN IP 上连得上", lanOnly === true, String(lanOnly));
    check("变异盲区④：isRelayPortBusy 能识别它（不漏判）", (await isRelayPortBusy(p, lanAddr.address)) === true);
    await new Promise((r) => server.close(r));
  } else {
    check("变异盲区④：本机没有非内网 IPv4（跳过该断言）", true);
  }
}
{
  // 盲区⑤：stop 的早退条件要用 exitCode/signalCode（不是 child.killed）
  // —— 「调过 kill 但没死透」的进程第二次 stop 仍应被继续处理，而不是丢句柄。
  const sup = new RelaySupervisor({ entry: stubEntry() });
  const port = await freePort();
  await sup.ensure("ws://127.0.0.1:" + port, {});
  const child = sup.child;
  child.killed = true; // 模拟「曾经调过 kill 但进程还活着」
  await sup.stop();
  check("变异盲区⑤：child.killed=true 但进程仍活时，stop 仍会真停它", child.exitCode !== null || child.signalCode !== null);
  check("变异盲区⑤：端口已释放", (await isPortListening(port)) === false);
}
{
  // 盲区⑥：relay 侧停止的幂等闩锁（SIGTERM 与 stdin 命令可能同时到）
  const realEntry = resolveRelayEntry();
  const { spawn } = await import("node:child_process");
  const port = await freePort();
  const child = spawn(process.execPath, [realEntry], {
    cwd: dirname(realEntry),
    env: { ...process.env, PORT: String(port), DSHRC_RELAY_PARENT_WATCHDOG: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((r) => setTimeout(r, 2500));
  // **按平台镜像真实 stop() 的行为**：
  // Windows 上 child.kill('SIGTERM') 是**硬杀**（不走 handler）→ 只能发命令；
  // POSIX 上命令 + 信号都发（信号是优雅路径，命令是冗余保险）。
  child.stdin.write("shutdown\n");
  if (process.platform !== "win32") {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
  check(
    "变异盲区⑥：命令(+POSIX 信号)只停一次且优雅退出（exit code 0）",
    exited !== null && exited.code === 0,
    JSON.stringify(exited),
  );
  check("变异盲区⑥：优雅退出后端口释放", (await isPortListening(port)) === false);
}

// ---------------------------------------------------------------------------
// 26. 接线层覆盖（审计：index.js 的接线是唯一没被测到、又已经出事的部分）
// ---------------------------------------------------------------------------
{
  const { shouldTickWatchdog } = await import("../lib/relay-supervisor.mjs");
  // N1 的实际接线：插件被禁用时看门狗不得动
  check("接线：enabled=false → 看门狗不动", shouldTickWatchdog({ running: false, reason: "managed", managed: true }, { enabled: false }) === false);
  check("接线：enabled 缺失 → 看门狗不动", shouldTickWatchdog({ running: false, reason: "managed" }, {}) === false);
  check("接线：autoStartRelay=false → 看门狗不动", shouldTickWatchdog({ running: false, reason: "managed" }, { enabled: true, autoStartRelay: false }) === false);
  check("接线：enabled=true 且托管的崩了 → 看门狗要动", shouldTickWatchdog({ running: false, reason: "managed", managed: true }, { enabled: true }) === true);
  check("接线：enabled=true 且在跑 → 看门狗不动", shouldTickWatchdog({ running: true, reason: "managed", managed: true }, { enabled: true }) === false);
  check("接线：enabled=true 且外部占用 → 看门狗要重探", shouldTickWatchdog({ running: true, reason: "external", external: true }, { enabled: true }) === true);

  // N2 的实际接线：卸载必须清 HOST_STATES（源码级断言——接线路径要真实 ctx，成本高）
  const src = readFileSync(join(PLUGIN_DIR, "index.js"), "utf8");
  check("接线：卸载时清理 HOST_STATES（N2）", /HOST_STATES\.delete\(ctx\)/.test(src));
  check("接线：startRemoteHost 会丢弃已 dispose 的旧 state（N2）", /disposed === true/.test(src));
  check("接线：autoStart 折进了 cfg.enabled（N1）", /enabled === true && state\.cfg\.autoStartRelay !== false/.test(src));
  check("接线：看门狗用纯函数判定", /shouldTickWatchdog\(supervisor\.status, state\.cfg\)/.test(src));

  // ---- 第三轮审计：接线断言收紧（M11/M32/M33 变异存活过）----
  // M11：`HOST_STATES.delete(ctx)` 在 startRemoteHost 里也有一处（ disposed 旧 state 的丢弃），
  // 松正则会被那处顶替 → 要求「dispose() 之后 200 字符内必须跟着 HOST_STATES.delete」
  //（即卸载清理块里的那一对）。
  check(
    "接线：卸载清理块内 dispose() 与 HOST_STATES.delete 相邻（N2 收紧）",
    /void supervisor\.dispose\(\);[\s\S]{0,200}?HOST_STATES\.delete\(ctx\);/.test(src),
  );
  // M32：卸载走 dispose 而非 stop（S4 语义——stop 后在途 ensure 仍会 spawn）
  check("接线：卸载清理走 dispose（不是 stop）", /ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,400}?supervisor\.dispose\(\)/.test(src));
  // M33：看门狗 tick 的**第一条有效语句**就是判定（插了提前 return 也不行）
  {
    const mm = src.match(/state\.relayWatchdog = setInterval\(\(\) => \{([\s\S]*?)\}, 15_000\)/);
    const body = mm
      ? mm[1].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n").trim()
      : "";
    check("接线：看门狗 tick 第一条语句就是判定（无提前 return）", body.startsWith("if (!shouldTickWatchdog"), body.slice(0, 120));
  }
  // M16/M31：设置页快照必须透传 external 与 reason
  check("N11：withRelayProcess 透传 external", /external:\s*snap\?\.external === true/.test(src));
  check("N11：withRelayProcess 透传 reason", /reason:\s*typeof snap\?\.reason === "string"/.test(src));
}

// ---------------------------------------------------------------------------
// 27. 第三轮审计：结构断言 + 行为级补盲（M01/M02/M08/M13/M17/M19/M28/M29/M15）
// ---------------------------------------------------------------------------
{
  // ---- 结构断言（针对「行为测不到、一改就哑」的点）----
  const supSrc = readFileSync(resolve(PLUGIN_DIR, "lib", "relay-supervisor.mjs"), "utf8");
  // M02/M28：unref 必须在 waitForListening **之后**才调用；stop() 里要临时 ref 回来
  const iWait = supSrc.indexOf("await this.waitForListening(child, 8000)");
  const iFirstUnref = supSrc.indexOf("unrefAll();");
  check("结构：unref 只出现在启动确认之后（M02）", iWait >= 0 && iFirstUnref > iWait, iWait + " vs " + iFirstUnref);
  const iStop = supSrc.indexOf("async stop() {");
  check("结构：stop() 等待期间临时 ref 回来（M28）", iStop >= 0 && /child\.ref\?\.\(\)/.test(supSrc.slice(iStop, iStop + 4000)));
  // M19：「未确认监听」的输出日志必须在早退**之前**
  const iNoConfirm = supSrc.indexOf("did not confirm listening");
  const iEarly = supSrc.indexOf("managed relay was stopped while starting");
  check("结构：「未确认监听」日志在早退之前（M19）", iNoConfirm >= 0 && iEarly >= 0 && iNoConfirm < iEarly);
  // 第三轮 #1/#2：世代号守卫要夹在端口探测与 start() 之间
  const iProbe = supSrc.indexOf("await isRelayPortBusy(target.port, target.host)");
  const iEpoch = supSrc.indexOf("this.epoch !== baseEpoch");
  const iStart = supSrc.indexOf("await this.start(target.port, opts.relayToken)");
  check("结构：世代号守卫夹在探测与 start 之间（stop 竞态）", iProbe >= 0 && iEpoch > iProbe && iStart > iEpoch);

  // M29：isChildAlive 要同时看 exitCode 与 signalCode
  {
    const sup2 = new RelaySupervisor({ entry: "" });
    sup2.child = { exitCode: null, signalCode: "SIGKILL" };
    check("isChildAlive：signalCode 非空算已死（M29）", sup2.isChildAlive() === false);
  }

  // M15：DNS 挂起时 2s 超时按「非本机」处理（lookup 可注入）
  {
    setDnsLookup(() => new Promise(() => {}));
    const t0 = Date.now();
    const r = await isLocalHostResolved("some.host.invalid");
    const dt = Date.now() - t0;
    setDnsLookup(null);
    check("N10：DNS 挂起时超时返回且不拖死看门狗（M15）", r === false && dt < 3500, dt + "ms");
  }

  // ---- M08 专用：ready 之后才崩溃 → 只有 exit 日志带 output ----
  {
    const logs = [];
    const dir = mkdtempSync(join(tmpdir(), "dshrc-exitlog-"));
    const entry = join(dir, "crash-after-ready.mjs");
    writeFileSync(
      entry,
      [
        "console.log('relay listening port=' + process.env.PORT);",
        "setTimeout(() => { console.error('EXIT_FATAL: crashed after ready'); process.exit(1); }, 300);",
      ].join("\n"),
    );
    const sup = new RelaySupervisor({ entry, log: (level, msg, extra) => logs.push({ level, msg, extra }) });
    const port = await freePort();
    await sup.ensure("ws://127.0.0.1:" + port, {});
    await new Promise((r) => setTimeout(r, 1500));
    const text = JSON.stringify(logs);
    check("N3：ready 后崩溃的原因也进日志（M08）", text.includes("EXIT_FATAL"), text.slice(0, 300));
    cleanupDir(dir);
  }

  // ---- N7：spawn 失败（'error' 事件，Node 不发 exit）→ 句柄必须被清 ----
  {
    const sup = new RelaySupervisor({
      entry: stubEntry(),
      nodePath: join(tmpdir(), "definitely-no-such-node-" + Date.now()),
    });
    const port = await freePort();
    const s = await sup.ensure("ws://127.0.0.1:" + port, {});
    check("N7：spawn 失败后句柄被清（不卡「运行中 pid 0」）", sup.child === null && sup.isChildAlive() === false, JSON.stringify(sup.status));
    check("N7：状态 running=false（看门狗可重拉）", sup.status.running === false && sup.status.reason === "managed");
    cleanupDir(join(dirname(sup.entry), "..") === tmpdir() ? dirname(sup.entry) : dirname(sup.entry));
  }

  // ---- M19 专用：进程活着但从未打印 listening → 只有「未确认监听」日志带 output ----
  {
    const logs = [];
    const dir = mkdtempSync(join(tmpdir(), "dshrc-noready-"));
    const entry = join(dir, "boot-fail.mjs");
    // 往 stderr 写启动失败原因，但**永不打印 listening**（8s 超时）→
    // exit 不发生、exit 日志不触发 →「未确认监听」日志是唯一的输出出口
    writeFileSync(
      entry,
      ["console.error('BOOT_FATAL: bad relay config');", "setInterval(() => {}, 1000);"].join("\n"),
    );
    const sup = new RelaySupervisor({ entry, log: (level, msg, extra) => logs.push({ level, msg, extra }) });
    const port = await freePort();
    await sup.ensure("ws://127.0.0.1:" + port, {});
    const text = JSON.stringify(logs);
    check("N3：启动期失败的原因经「未确认监听」日志可见（M19）", text.includes("BOOT_FATAL"), text.slice(0, 300));
    await sup.stop();
    cleanupDir(dir);
  }

  // ---- M01/M17：exit 归属判断 + superseded 不刷 warn（假子进程，精确控制时序）----
  {
    const { EventEmitter } = await import("node:events");
    const logs = [];
    const makeFake = (pid) => {
      const c = new EventEmitter();
      c.pid = pid;
      c.exitCode = null;
      c.signalCode = null;
      c.killed = false;
      c.stdin = { write: () => true, destroyed: false, unref: () => {}, ref: () => {} };
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      // kill 不让它退出（stop 只能等宽限+兜底）——退出由测试**手动**在恰当的时机触发
      c.kill = () => {
        c.killed = true;
        return true;
      };
      c.unref = () => {};
      c.ref = () => {};
      return c;
    };
    const spawned = [];
    const sup = new RelaySupervisor({
      entry: stubEntry(), // 入口检查要求文件存在；spawnFn 会把它替换成假子进程
      spawnFn: () => {
        const c = makeFake(200 + spawned.length);
        spawned.push(c);
        return c;
      },
      log: (level, msg) => logs.push({ level, msg }),
    });
    const portA = await freePort();
    const pA = sup.ensure("ws://127.0.0.1:" + portA, {});
    await new Promise((r) => setTimeout(r, 30));
    spawned[0].stdout.emit("data", "relay listening port=" + portA);
    const a = await pA;
    check("归属：假子进程 A 被确认监听", a.running === true && spawned.length === 1);

    const portB = await freePort();
    const pB = sup.ensure("ws://127.0.0.1:" + portB, {});
    // stop(c1) 要等宽限兜底（fake 的 kill 不退出 → 约 5s）后才 spawn B → 轮询等它出现
    const waitSpawn = async (n) => {
      for (let i = 0; i < 200 && spawned.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    };
    await waitSpawn(2);
    if (spawned[1]) spawned[1].stdout.emit("data", "relay listening port=" + portB);
    const b = await pB; // stop(c1) 等宽限兜底后 start(c2)
    check("归属：换端口后 B 在跑", b.running === true && sup.child === spawned[1], JSON.stringify(b));

    // **关键时序**：A 的 exit 现在（B 已 spawn 之后）才到 —— 归属判断必须保住 B 的句柄
    spawned[0].exitCode = 0;
    spawned[0].emit("exit", 0, null);
    check("归属：A 迟到的 exit 不清掉 B 的句柄（M01）", sup.child === spawned[1]);
    check("归属：A 的退出按 superseded 记 info，不刷 warn（M17）", logs.some((l) => l.level === "info" && /superseded/.test(l.msg)) && !logs.some((l) => l.level === "warn" && /managed relay exited/.test(l.msg)));
    await sup.stop();
  }
}

console.log("\nverify-relay-supervisor: " + pass + " passed, " + fail + " failed");
// N9：清理所有桩目录（门禁不该在系统临时目录里留垃圾）
for (const dir of stubDirs) cleanupDir(dir);
process.exit(fail === 0 ? 0 : 1);
