// e2e/deliver-queue-probe.mjs — 一次性探针（不提交）：
// 1) 契约 §5.10.2：交付物图片在 session.history 里是否是**独立消息**（text 为空 + images 带 source:'deliverable'）
// 2) 契约 §5.2：session.queue 事件是否推来（items 形状）
// 注意：同 channel 同 role 与真机互抢（新顶旧）→ 跑完要重新拉起手机 App。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayLink } from "./link.mjs";

const cfg = JSON.parse(
  readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "remote-control", "config.json"), "utf8"),
);
const { relayUrl, channel, secret } = cfg;
console.log("relay=%s channel=%s", relayUrl, channel);

const queueEvents = [];
const imageEvents = [];

const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "client",
  onStatus: (s) => console.log("[status]", s),
  onMessage: (m) => {
    if (m?.type === "event") {
      const topic = m?.payload?.topic;
      if (topic === "session.queue") queueEvents.push(m.payload.data);
      if (topic === "assistant.image") imageEvents.push(m.payload.data);
    }
  },
});

await new Promise((r) => setTimeout(r, 2500));
const hello = await link.request("hello", { proto: 1, clientName: "deliver-probe", appVersion: "1.0.0" }, 15000);
console.log("hello ok:", !!hello);

const list = await link.request("session.list", {}, 15000);
const items = list?.sessions ?? list?.items ?? [];
const target = items
  .filter((s) => s.blank !== true)
  .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
if (!target) {
  console.log("no session to probe");
  process.exit(0);
}
console.log("probe session:", target.sessionId, JSON.stringify((target.title || "").slice(0, 30)));

const page = await link.request("session.history", { sessionId: target.sessionId, maxMessages: 40 }, 30000);
const msgs = page?.messages ?? [];
console.log("history messages:", msgs.length);
let delivered = 0;
for (const m of msgs) {
  for (const im of m?.images ?? []) {
    if (im?.source === "deliverable") {
      delivered++;
      console.log("  DELIVERABLE: msgId=%s text=%j seq=%s imageId=%s %sx%s thumbLen=%s",
        m.id, m.text, m.seq, im.imageId, im.width, im.height, (im.thumb || "").length);
    }
  }
}
console.log(">> deliverable image messages in history:", delivered);
console.log(">> assistant.image live events seen:", imageEvents.length);
console.log(">> queue events seen:", queueEvents.length);

// 排队验证：给**正在运行**的会话发一条 queue 提示词 → 宿主排队 → 插件广播 session.queue
if (process.env.PROBE_QUEUE === "1") {
  console.log("--- 发送 queue 模式提示词（观察 session.queue 广播）---");
  await link.request("session.prompt", {
    sessionId: target.sessionId,
    text: "[probe] 排队链路自检（可忽略）",
    mode: "queue",
  }, 20000);
  await new Promise((r) => setTimeout(r, 4000));
  console.log(">> queue events after prompt:", queueEvents.length);
  for (const q of queueEvents) console.log("  QUEUE", q.sessionId, JSON.stringify(q.items));
}

link.close();
process.exit(0);
