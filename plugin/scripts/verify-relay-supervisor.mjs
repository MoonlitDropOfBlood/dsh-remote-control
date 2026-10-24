// scripts/verify-relay-supervisor.mjs —— 中继进程托管（v1.1.1）门禁
//
// 覆盖：
//   1. 纯函数：relayUrl 解析、本机判定、入口解析
//   2. 决策：远端不托管 / autoStart=false 不托管 / 找不到入口不托管 / 端口被占用不抢
//   3. 生命周期：真 spawn 一个**桩中继**（临时脚本 + 临时端口）→ 确认监听 → stop() 收掉
//   4. 进程安全：端口占用时不 spawn；stop 只杀自己 handle 起的进程
//
// 无外部依赖（不碰真实中继端口，不连真实中继）。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  RelaySupervisor,
  isLocalHost,
  isPortListening,
  parseRelayTarget,
  resolveRelayEntry,
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
  const dir = mkdtempSync(join(tmpdir(), "dshrc-relay-sup-"));
  const entry = join(dir, "stub-relay.mjs");
  // 桩中继：行为对齐真中继的关键约定——打印 "relay listening"、支持 SIGTERM 退出、
  // 支持父进程看门狗（stdin EOF → 退出）
  writeFileSync(
    entry,
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
      "  process.stdin.on('end', bye);",
      "  process.stdin.resume();",
      "}",
    ].join("\n"),
  );

  // 找一个空闲端口给桩用
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const sup = new RelaySupervisor({ entry });
  const s = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("托管模式：spawn 成功且 managed", s.managed === true && s.running === true, JSON.stringify(s));
  check("托管模式：拿到子进程 pid", s.pid > 0, String(s.pid));
  check("托管模式：端口被桩中继监听", (await isPortListening(port)) === true);

  // 幂等：再 ensure 一次不应重复 spawn（pid 不变）
  const s2 = await sup.ensure("ws://127.0.0.1:" + port, {});
  check("ensure 幂等：不重复 spawn（pid 不变）", s2.pid === s.pid, s2.pid + " vs " + s.pid);

  // 父进程看门狗：桩进程在 stdin EOF 时应自行退出
  await sup.stop();
  check("stop() 后端口不再监听", (await isPortListening(port)) === false);
  check("stop() 后状态清空", sup.child === null);

  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. 父进程看门狗真实验证：spawn 的子进程在父 stdin 关闭时退出
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "dshrc-relay-wd-"));
  const entry = join(dir, "wd.mjs");
  writeFileSync(
    entry,
    [
      "process.stdin.on('end', () => process.exit(0));",
      "process.stdin.resume();",
      "console.log('relay listening stub');",
    ].join("\n"),
  );
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DSHRC_RELAY_PARENT_WATCHDOG: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 等桩进程起来（它会打印一行）
  await new Promise((r) => {
    child.stdout.once("data", r);
    setTimeout(r, 2000);
  });
  // 模拟「父进程死亡」：父进程持有的写端关闭 → 子进程 stdin 收到 EOF
  child.stdin.end();
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  check("看门狗：父进程 stdin 关闭 → 子进程自行退出", exited === true);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nverify-relay-supervisor: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
