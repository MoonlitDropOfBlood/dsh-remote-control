// scripts/smoke-link.mjs —— 链路冒烟（不写入范围外，仅用于本地验收）。
// 真实中继 + 本插件 host 端 RelayClient ↔ e2e 手机端 RelayLink。
// 覆盖：hello/welcome、双向业务帧、seq 去重、断线重连、离线缓存补发。
import { RelayClient } from "../lib/relay-client.mjs";
import { RelayLink, msg } from "../../dsh-remote-control-e2e/link.mjs";
import { seal } from "../../dsh-remote-control-e2e/protocol.mjs";

const RELAY = process.env.SMOKE_RELAY || "ws://127.0.0.1:8787";
const CHANNEL = "SMOKETEST234567AB"; // Crockford base32：仅 A-Z 与 2-7（契约 §3）
const SECRET = "smoke-secret-0123456789abcdef";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 有界轮询：消除硬编码 sleep 造成的偶发时序失败
const waitFor = async (pred, timeoutMs = 8000, stepMs = 50) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (pred()) return true; await sleep(stepMs); }
  return pred();
};
const results = [];
const check = (label, cond) => {
  console.log((cond ? "ok: " : "FAIL: ") + label);
  if (!cond) { console.log("\nSMOKE FAIL"); process.exit(1); }
  results.push(label);
};

const hostEvents = [];
let hostReady = false;
const host = new RelayClient({
  relayUrl: RELAY, channel: CHANNEL, secret: SECRET, role: "host",
  onStatus: (s) => { if (s === "ready") hostReady = true; },
  onMessage: (m) => {
    hostEvents.push(m);
    // 中继是哑管道，业务 ping 的 pong 由 host 端应答（对齐 mock-host 行为）
    if (m.type === "ping") host.send(msg("result", { id: m.id, ok: true, value: { pong: Date.now() } }));
  },
  log: (l, m, e) => console.log("  [host:" + l + "] " + m, e ?? ""),
});

const phoneEvents = [];
const phone = new RelayLink({
  relayUrl: RELAY, channel: CHANNEL, secret: SECRET, role: "client",
  onMessage: (m) => { phoneEvents.push(m); },
  onStatus: () => {},
});

host.start();
check("host handshake ready (hello/welcome)", await waitFor(() => hostReady));

// 中继是哑管道，业务 ping 的 pong 需由对端应答；这里由 host 侧自动回 pong。
const phonePing = phone.request("ping", {}, 8000).then(() => true).catch(() => false);
check("phone connects + ping/pong round trip", await phonePing);

host.send(msg("event", { topic: "session.status", data: { sessionId: "s1", running: true } }));
check("host -> phone business frame delivered", await waitFor(
  () => phoneEvents.some((m) => m.type === "event" && m.payload?.topic === "session.status"),
));

phone.send(msg("session.prompt", { sessionId: "s1", text: "hello" }));
check("phone -> host business frame delivered", await waitFor(
  () => hostEvents.some((m) => m.type === "session.prompt"),
));

// seq 去重（契约 §4 v1.0.2：接收端去重键 = sid + ":" + seq，同一键只处理一次）。
// RelayLink.send() 每次自增 seq，制造不出重复 seq；这里用公有 ws 直接注入两条
// 同 sid、同 seq 的 frame（中继不校验 seq 连续性、原样透传），断言 host 只上交一次。
// sid 必须带上：裸 seq 帧会被接收端按 legacy 归桶，测不到真实去重键。
const dedupeSeq = phone.seq + 1;
const dedupeTag = "dedupe-" + Date.now();
const raw = JSON.stringify({
  t: "frame",
  sid: phone.sid,
  seq: dedupeSeq,
  data: seal(phone.key, "client", dedupeSeq, msg("session.prompt", { sessionId: "s1", text: dedupeTag })),
});
phone.ws.send(raw);
phone.ws.send(raw);
// 关键：注入消耗了 seq=dedupeSeq 但没推进 phone.seq；不同步的话，下一条真实
// 帧会复用同一 seq，被接收端按契约 §4「同一 seq 只处理一次」正确丢弃（自污染）。
phone.seq = dedupeSeq;
const countTag = () => hostEvents.filter((m) => m.payload?.text === dedupeTag).length;
check("duplicate seq delivered once (dedupe): first arrival", await waitFor(() => countTag() >= 1, 6000));
await sleep(400); // 静默窗口：若去重失效，第二帧此时已到
check("duplicate seq delivered once (dedupe): no second copy", countTag() === 1);

// 断线 → 手机离线发帧（中继缓存）→ host 自动重连补发。
// 注意：close() 是终态（#closed 置位后 start() 永久 no-op，用于插件卸载），
// 所以这里用 socket 级强制断开触发 RelayClient 的指数退避自动重连。
host.dropConnection();
await sleep(400); // 等中继感知 host 断开，后续帧才会进离线缓存
phone.send(msg("session.prompt", { sessionId: "s1", text: "while-host-down" }));
check("host reconnects + receives offline-cached frame", await waitFor(
  () => hostEvents.some((m) => m.type === "session.prompt" && m.payload?.text === "while-host-down"),
  12000,
));

console.log("\nSMOKE PASS (" + results.length + " checks)");
host.close();
phone.close();
process.exit(0);
