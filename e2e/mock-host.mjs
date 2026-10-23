// e2e/mock-host.mjs — 模拟 DSH 插件端（host 角色）：用于在没有真实 DSH 的情况下
// 测试中继与 HarmonyOS App。业务消息 schema 见契约 §5。
// 用法: node mock-host.mjs wss://relay.example.com/ws CHANNEL SECRET
//
// v1.0.6：支持 session.capabilities（模式/权限目录）、session.create 的
// agentPreset / permission、session.history 的 steps，以及 tool.call /
// tool.result / system.message 事件推送（契约 §5.2 / §5.7 / §5.8）。
import { pathToFileURL } from "node:url";
import { RelayLink, msg } from "./link.mjs";

/** mock 的模式目录（宿主 Agent preset 的等价物）。 */
export const MOCK_PRESETS = [
  { id: "standard", name: "Standard", description: "标准模式" },
  { id: "creator", name: "Creator", description: "创作模式" },
];

/** mock 的权限目录（宿主 permission preset 的等价物）。 */
export const MOCK_PERMISSIONS = [
  { id: "read-only", name: "只读", description: "仅可查看" },
  { id: "workspace-write", name: "工作区内修改", description: "工作区内可修改" },
];

export const MOCK_DEFAULT_PRESET = "standard";
export const MOCK_DEFAULT_PERMISSION = "read-only";

function resultOf(m, value) {
  return msg("result", { id: m.id, ok: true, value });
}
function errorOf(m, code, message) {
  return msg("result", { id: m.id, ok: false, error: { code, message } });
}

/** 内容块 → 纯文本（契约 §5.7 口径：text 拼接，image/file 占位符）。 */
function contentText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "image") text += "[图片]";
    else if (block.type === "file") text += "[文件]";
  }
  return text;
}

/**
 * mock 会话 → 契约 §5.1 session.history 的 {messages, steps, hasMore, oldestSeq}。
 * 与插件侧同一口径：tool/call 与 tool/result 按 callId 配对成一条 StepRecord。
 */
export function mockHistory(session) {
  const messages = [];
  const steps = [];
  const byCall = new Map();
  for (const ev of session.events ?? []) {
    if (!ev || typeof ev !== "object") continue;
    const seq = Number(ev.seq);
    const ts = Number(ev.time) || 0;
    const data = ev.data ?? {};
    if (ev.type === "user/message" || ev.type === "assistant/message") {
      const content =
        ev.type === "user/message" ? data.content : data?.message?.content;
      const text = contentText(content);
      if (text.trim() === "") continue;
      messages.push({
        id: `${session.sessionId}:${seq}`,
        role: ev.type === "user/message" ? "user" : "assistant",
        text,
        ts,
        seq,
      });
      continue;
    }
    if (ev.type === "tool/call") {
      const rec = {
        seq,
        callId: data.callId,
        name: data.name ?? "",
        arguments: typeof data.arguments === "string" ? data.arguments : "",
        status: "running",
        resultText: "",
        errorText: "",
        ts,
        turn: data.turn ?? 0,
        step: data.step ?? 0,
      };
      byCall.set(data.callId, rec);
      steps.push(rec);
      continue;
    }
    if (ev.type === "tool/result") {
      const callId = data?.message?.toolCallId;
      if (typeof callId !== "string") continue;
      const isError = data.message?.isError === true;
      const resultText = contentText(data.message?.content);
      const reason = data.error?.reason;
      const errorText =
        reason === undefined || reason === null ? (isError ? resultText : "") : String(reason);
      const rec = byCall.get(callId);
      if (rec !== undefined) {
        rec.status = isError ? "error" : "ok";
        rec.resultText = resultText;
        rec.errorText = errorText;
      } else {
        byCall.set(callId, {
          seq,
          callId,
          name: "",
          arguments: "",
          status: isError ? "error" : "ok",
          resultText,
          errorText,
          ts,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
        });
        steps.push(byCall.get(callId));
      }
      continue;
    }
    // system/message / developer/message → 只进事件流，不进 messages
  }
  steps.sort((a, b) => a.seq - b.seq);
  let oldest = Number.MAX_SAFE_INTEGER;
  for (const m of messages) if (m.seq < oldest) oldest = m.seq;
  return { messages, steps, hasMore: false, oldestSeq: oldest === Number.MAX_SAFE_INTEGER ? 0 : oldest };
}

/**
 * 建一个 mock host（可注入任意 link：RelayLink 或 LoopbackLink）。
 * @param {{link:{send:(m:any,urgent?:boolean)=>any}, log?:(s:string)=>void}} deps
 */
export function createMockHost(deps) {
  const link = deps.link;
  const log = deps.log ?? (() => {});
  const sessions = new Map([
    [
      "s-demo-1",
      {
        sessionId: "s-demo-1",
        title: "示例会话",
        cwd: "D:/demo",
        running: false,
        updatedAt: Date.now(),
        agentPreset: MOCK_DEFAULT_PRESET,
        permission: MOCK_DEFAULT_PERMISSION,
        events: [],
      },
    ],
  ]);
  let askSeq = 0;
  const pendingAsks = new Map(); // askId -> {resolve}
  let eventSeq = 0;

  /** 记一条会话事件（进历史）。 */
  const record = (session, type, data, time) => {
    session.events.push({ type, seq: ++eventSeq, time: time ?? Date.now(), data });
  };

  /**
 * 推一条 wire 事件（契约 §5.2 的 topic），并把**宿主形状**的事件记入会话历史。
 * @param {object} session
 * @param {string} topic wire topic（tool.call / tool.result / system.message）
 * @param {object} wireData 推给手机的事件 data
 * @param {string} historyType 宿主事件类型（tool/call …）
 * @param {object} historyData 宿主事件 data（历史回放用）
 */
  const emit = (session, topic, wireData, historyType, historyData) => {
    record(session, historyType, historyData);
    link.send(msg("event", { topic, data: wireData }));
  };

  const handle = async (m) => {
    const p = m.payload ?? {};
    switch (m.type) {
      case "hello":
        return link.send(resultOf(m, { hostName: "mock-host", dshVersion: "0.2.x-mock", pluginVersion: "1.0.0-mock" }));
      case "ping":
        return link.send(resultOf(m, { pong: Date.now() }));
      case "session.list":
        return link.send(resultOf(m, { sessions: [...sessions.values()] }));
      case "session.capabilities":
        // 契约 §5.8：模式 + 权限目录（宿主没有的能力这里是空数组）
        return link.send(
          resultOf(m, {
            presets: MOCK_PRESETS.map((x) => ({ ...x })),
            permissions: MOCK_PERMISSIONS.map((x) => ({ ...x })),
            defaultPreset: MOCK_DEFAULT_PRESET,
            defaultPermission: MOCK_DEFAULT_PERMISSION,
          }),
        );
      case "session.create": {
        const agentPreset = typeof p.agentPreset === "string" ? p.agentPreset : "";
        if (agentPreset !== "" && !MOCK_PRESETS.some((x) => x.id === agentPreset)) {
          // 与宿主一致：未知 preset → 客户端回退成「不带选项」重试
          return link.send(errorOf(m, "unsupported-agent-preset", `Unknown agent preset: ${agentPreset}`));
        }
        const id = "s-" + Math.random().toString(36).slice(2, 8);
        const s = {
          sessionId: id,
          title: p.title || "新会话",
          cwd: p.cwd || "D:/demo",
          running: false,
          updatedAt: Date.now(),
          agentPreset: agentPreset !== "" ? agentPreset : MOCK_DEFAULT_PRESET,
          permission: typeof p.permission === "string" && p.permission !== "" ? p.permission : MOCK_DEFAULT_PERMISSION,
          events: [],
        };
        sessions.set(id, s);
        link.send(msg("event", { topic: "session.added", data: { session: s } }));
        const value = { sessionId: id };
        if (agentPreset !== "") value.agentPreset = agentPreset;
        return link.send(resultOf(m, value));
      }
      case "session.history": {
        const s = sessions.get(p.sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, mockHistory(s)));
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
        // 用户输入进历史
        record(s, "user/message", { source: { kind: "user" }, content: [{ type: "text", text: p.text ?? "" }] });
        // v1.0.6：系统提示 + 工具调用/结果（§5.2 / §5.7）
        const callId = "call-" + Math.random().toString(36).slice(2, 8);
        const now = Date.now();
        const args = JSON.stringify({ command: "echo hello" });
        emit(
          s,
          "system.message",
          { sessionId: s.sessionId, kind: "system", text: "mock: 系统提示", ts: now },
          "system/message",
          { turn: 1, step: 1, message: { content: [{ type: "text", text: "mock: 系统提示" }] } },
        );
        emit(
          s,
          "tool.call",
          { sessionId: s.sessionId, callId, name: "bash", arguments: args, ts: now },
          "tool/call",
          { turn: 1, step: 1, callId, name: "bash", arguments: args },
        );
        emit(
          s,
          "tool.result",
          { sessionId: s.sessionId, callId, status: "ok", resultText: "hello", errorText: "", ts: now },
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: { role: "tool", toolCallId: callId, content: [{ type: "text", text: "hello" }] },
          },
        );
        // 流式回复
        const reply = `已收到：「${p.text}」。这是 mock-host 的流式回复。`;
        for (const ch of reply.match(/.{1,8}/g) ?? []) {
          link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text: ch } }));
          await new Promise((r) => setTimeout(r, 60));
        }
        record(s, "assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: reply }] } });
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
  };

  return { handle, sessions, pendingAsks, log };
}

// ---------------------------------------------------------------------------
// CLI 入口（保持原用法：node mock-host.mjs <relayUrl> <channel> <secret>）
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [relayUrl, channel, secret] = process.argv.slice(2);
  if (!relayUrl || !channel || !secret) {
    console.error("usage: node mock-host.mjs <relayUrl> <channel> <secret>");
    process.exit(1);
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
      mock.handle(m).catch((e) => {
        console.error("[host] handler error:", e);
        try {
          link.send(errorOf(m, "internal", String(e?.message ?? e)));
        } catch {
          /* ignore */
        }
      });
    },
  });
  const mock = createMockHost({ link, log: (s) => console.log("[host]", s) });
  console.log("[host] mock DSH host up. relay =", relayUrl, "channel =", channel);
}
