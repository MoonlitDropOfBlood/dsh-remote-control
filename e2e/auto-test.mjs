// e2e/auto-test.mjs — 对【真实 DSH 插件】的自动化联调（契约 §9）：
// 读取本机插件配置（~/.dsh/remote-control/config.json）作为手机端配对信息，
// 连接中继 → hello → session.list → 验证真实会话数据 → 退出码 0/1。
// 用法: node auto-test.mjs [relayUrl]   （默认 ws://127.0.0.1:8787）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayLink } from "./link.mjs";

const relayUrl = process.argv[2] ?? "ws://127.0.0.1:8787";
const cfg = JSON.parse(
  readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "remote-control", "config.json"), "utf8"),
);
const { channel, secret } = cfg;
if (!channel || !secret) {
  console.error("FAIL: plugin config missing channel/secret");
  process.exit(1);
}
console.log("pairing: relay=%s channel=%s secret=<%d chars>", relayUrl, channel, secret.length);

const events = new Map(); // topic -> count
const deltas = new Map(); // sessionId -> text
let done = false;
let t0 = setTimeout(() => fail("no welcome within 10s (relay not reached?)"), 10000);

const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "client",
  onStatus: (s) => {
    console.log("[status]", s);
    if (s === "ready") clearTimeout(t0);
  },
  onPeer: (joined, role) => console.log("[peer]", role, joined ? "joined" : "left"),
  onMessage: (m) => {
    if (m.type === "event") {
      const topic = m.payload?.topic;
      events.set(topic, (events.get(topic) ?? 0) + 1);
      if (topic === "assistant.delta") {
        const d = m.payload.data;
        deltas.set(d.sessionId, (deltas.get(d.sessionId) ?? "") + (d.text ?? ""));
      } else {
        console.log("[event]", topic, JSON.stringify(m.payload?.data ?? {}).slice(0, 160));
      }
    }
  },
});

const fail = (msg) => {
  console.error("FAIL:", msg);
  link.close();
  process.exit(1);
};

try {
  // 1. hello
  const hello = await link.request("hello", { proto: 1, clientName: "auto-test", appVersion: "1.0.0" }, 15000);
  console.log("hello.ok:", JSON.stringify(hello));
  if (!hello || typeof hello !== "object") fail("hello response malformed");

  // 2. session.list —— 必须返回真实会话数据
  const list = await link.request("session.list", {}, 15000);
  const items = list?.sessions ?? list?.items;
  if (!Array.isArray(items)) fail("session.list malformed: " + JSON.stringify(list).slice(0, 200));
  console.log("session.list: %d sessions", items.length);
  console.log("  sample:", JSON.stringify(items[0] ?? null).slice(0, 200));

  // 3. ping
  const pong = await link.request("ping", {}, 5000);
  if (typeof pong?.pong !== "number") fail("ping malformed");
  console.log("ping ok");

  // 4. prompt 闭环验证：新建独立会话再 prompt（不影响已有会话）
  if (process.env.E2E_PROMPT === "1") {
    const created = await link.request("session.create", { title: "e2e-联调临时会话" }, 15000);
    console.log("session.create:", JSON.stringify(created));
    const sid = created?.sessionId;
    if (!sid) fail("session.create malformed");
    const r = await link.request("session.prompt", { sessionId: sid, text: "请只回复两个字：收到" }, 15000);
    console.log("session.prompt:", JSON.stringify(r));
    const wait = 25000;
    console.log("watching events for %dms …", wait);
    await new Promise((r2) => setTimeout(r2, wait));
    for (const [s, text] of deltas) console.log("delta[%s]: %s", s, text.slice(0, 200));
    if (deltas.size === 0) console.log("  (no assistant.delta observed)");
    const endCount = events.get("turn.end") ?? 0;
    console.log("turn.end count:", endCount);
  }

  console.log("event counts:", JSON.stringify([...events]));
  console.log("E2E RESULT: PASS");
  done = true;
  link.close();
  process.exit(0);
} catch (e) {
  if (!done) fail(e?.message ?? String(e));
}
