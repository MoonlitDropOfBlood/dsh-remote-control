// e2e/mock-host.mjs — 模拟 DSH 插件端（host 角色）：用于在没有真实 DSH 的情况下
// 测试中继与 HarmonyOS App。业务消息 schema 见契约 §5。
// 用法: node mock-host.mjs wss://relay.example.com/ws CHANNEL SECRET
import { RelayLink, msg } from "./link.mjs";

const [relayUrl, channel, secret] = process.argv.slice(2);
if (!relayUrl || !channel || !secret) {
  console.error("usage: node mock-host.mjs <relayUrl> <channel> <secret>");
  process.exit(1);
}

const sessions = new Map([
  ["s-demo-1", { sessionId: "s-demo-1", title: "示例会话", cwd: "D:/demo", running: false, updatedAt: Date.now(), archived: false }],
]);
let askSeq = 0;
const pendingAsks = new Map(); // askId -> {resolve}

function resultOf(m, value) {
  return msg("result", { id: m.id, ok: true, value });
}
function errorOf(m, code, message) {
  return msg("result", { id: m.id, ok: false, error: { code, message } });
}

const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "host",
  onStatus: (s) => console.log("[host] status:", s),
  onPeer: (joined, role) => console.log("[host] peer", role, joined ? "joined" : "left"),
  onMessage: (m) => {
    console.log("[host] <-", m.type, m.id ?? m.payload?.topic ?? "");
    handle(m).catch((e) => {
      console.error("[host] handler error:", e);
      try {
        link.send(errorOf(m, "internal", String(e?.message ?? e)));
      } catch {
        /* ignore */
      }
    });
  },
});

async function handle(m) {
  const p = m.payload ?? {};
  switch (m.type) {
    case "hello":
      return link.send(resultOf(m, { hostName: "mock-host", dshVersion: "0.2.x-mock", pluginVersion: "1.0.0-mock" }));
    case "ping":
      return link.send(resultOf(m, { pong: Date.now() }));
    case "session.list":
      return link.send(resultOf(m, { sessions: [...sessions.values()] }));
    case "session.create": {
      const id = "s-" + Math.random().toString(36).slice(2, 8);
      const s = { sessionId: id, title: p.title || "新会话", cwd: p.cwd || "D:/demo", running: false, updatedAt: Date.now(), archived: false };
      sessions.set(id, s);
      link.send(msg("event", { topic: "session.added", data: { session: s } }));
      return link.send(resultOf(m, { sessionId: id }));
    }
    case "session.rename": {
      const s = sessions.get(p.sessionId);
      if (!s) return link.send(errorOf(m, "not-found", "session not found"));
      s.title = p.title;
      return link.send(resultOf(m, { title: s.title }));
    }
    case "session.prompt": {
      const s = sessions.get(p.sessionId);
      if (!s) return link.send(errorOf(m, "not-found", "session not found"));
      link.send(resultOf(m, { accepted: true }));
      s.running = true;
      link.send(msg("event", { topic: "session.status", data: { sessionId: s.sessionId, running: true } }));
      // 流式回复
      const reply = `已收到：「${p.text}」。这是 mock-host 的流式回复。`;
      for (const ch of reply.match(/.{1,8}/g) ?? []) {
        link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text: ch } }));
        await new Promise((r) => setTimeout(r, 60));
      }
      // 文本含 "approve" 触发一次审批问答演示
      if (/approve/i.test(p.text)) {
        const askId = "ask-" + ++askSeq;
        link.send(msg("event", { topic: "approval.request", data: { askId, sessionId: s.sessionId, toolName: "bash", reason: "mock: 运行一条命令", argsPreview: 'echo "hello"', timeoutMs: 120000 } }), true);
        const decision = await new Promise((resolve) => {
          pendingAsks.set(askId, resolve);
          setTimeout(() => {
            if (pendingAsks.has(askId)) {
              pendingAsks.delete(askId);
              resolve("timeout");
            }
          }, 120000);
        });
        link.send(msg("event", { topic: "approval.resolved", data: { askId, decision: decision === "timeout" ? "pending" : decision, source: decision === "timeout" ? "timeout" : "phone" } }));
        link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text: `\n[审批结果: ${decision}]` } }));
      }
      s.running = false;
      link.send(msg("event", { topic: "turn.end", data: { sessionId: s.sessionId, status: "idle" } }));
      link.send(msg("event", { topic: "session.status", data: { sessionId: s.sessionId, running: false } }));
      return;
    }
    case "session.cancel": {
      const s = sessions.get(p.sessionId);
      if (!s) return link.send(errorOf(m, "not-found", "session not found"));
      s.running = false;
      link.send(msg("event", { topic: "turn.end", data: { sessionId: s.sessionId, status: "idle" } }));
      return link.send(resultOf(m, { cancelled: true }));
    }
    case "approval.answer": {
      const resolve = pendingAsks.get(p.askId);
      if (resolve === undefined) return link.send(resultOf(m, { applied: false }));
      pendingAsks.delete(p.askId);
      resolve(p.decision);
      return link.send(resultOf(m, { applied: true }));
    }
    case "question.answer":
      return link.send(resultOf(m, { applied: true }));
    case "push.register":
      return link.send(resultOf(m, { registered: true }));
    default:
      return link.send(errorOf(m, "bad-type", "unknown type: " + m.type));
  }
}

console.log("[host] mock DSH host up. relay =", relayUrl, "channel =", channel);
