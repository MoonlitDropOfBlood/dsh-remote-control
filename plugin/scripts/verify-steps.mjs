// scripts/verify-steps.mjs —— v1.0.6 新链路自检（dev-only，无外部依赖）。
//
// 用 mock ctx（假 sessionController / agentPresets / permissionPresets）+ 假 relay
// 驱动真正的 HostBridge，覆盖契约 §5.7 / §5.8：
//   1. session/event 总闸 → tool.call / tool.result / system.message（§5.2 + §5.7）；
//   2. session.history → steps（StepRecord，tool/call 与 tool/result 按 callId 配对）；
//   3. session.capabilities → presets / permissions / defaultPreset / defaultPermission
//      （跳过 custom 展示态；宿主的 `value` 字段也兜住）；
//   4. session.create 带 agentPreset / permission → 宿主 create 收到 agentPreset、
//      权限档位写进新建会话；
//   5. 宿主拒绝 preset → 回 unsupported-agent-preset；
//   6. 降级：宿主没有 agentPresets / permissionPresets 服务 → 目录为空、
//      创建照常成功（只 warn，不阻断）。
//
// 用法：node scripts/verify-steps.mjs（在 plugin/ 目录下）
import { HostBridge, mapHistorySteps, mapPermissionOptions } from "../lib/host-bridge.mjs";

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log("ok: " + label);
  } else {
    fail++;
    console.log("FAIL: " + label + (detail ? " — " + detail : ""));
  }
};

// ---- mock ctx：事件总线 + 服务表（ctx.get 对缺失服务抛，模拟宿主行为）--------
function makeCtx(services = {}) {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => this.off(name, fn);
    },
    off(name, fn) {
      const arr = handlers.get(name) ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(name, ...args) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
    get(name) {
      if (!Object.hasOwn(services, name)) throw new Error("service not found: " + name);
      return services[name];
    },
  };
}

// ---- mock relay：收集出站消息 --------------------------------------------------
function makeRelay() {
  const sent = [];
  return {
    sent,
    clientOnline: true,
    ready: true,
    send(message) {
      sent.push(message);
      return true;
    },
  };
}

const logs = [];
const log = (level, message, extra) => {
  logs.push(level + " " + message + (extra ? " " + JSON.stringify(extra) : ""));
};

const CFG = {
  enabled: true,
  interceptApprovals: false,
  interceptQuestions: false,
  approvalTimeoutMs: 1000,
  push: { notifyTurnEnd: false },
};

/** 取最后一条 result 回包的值（ok=true）或错误码。 */
function lastResult(sent, id) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m.type === "result" && m.payload?.id === id) {
      return m.payload.ok ? { value: m.payload.value } : { error: m.payload.error };
    }
  }
  return null;
}

/** 取某 topic 的事件负载。 */
function eventsOf(sent, topic) {
  return sent.filter((m) => m.type === "event" && m.payload?.topic === topic).map((m) => m.payload.data);
}

// ===========================================================================
// 场景 1：完整宿主（模式 + 权限 + 工具事件）
// ===========================================================================
{
  const relay = makeRelay();
  let seq = 0;
  const created = [];
  const permissionApplied = [];
  const sessions = new Map();

  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1000,
      surfaceOp: "append",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "跑个命令" }] },
    },
    {
      type: "tool/call",
      seq: 2,
      time: 1100,
      data: { turn: 3, step: 2, callId: "call_abc", name: "bash", arguments: '{"command":"ls -la"}' },
    },
    {
      type: "tool/result",
      seq: 3,
      time: 1200,
      data: {
        turn: 3,
        step: 2,
        message: {
          role: "tool",
          toolCallId: "call_abc",
          content: [
            { type: "text", text: "total 0\n" },
            { type: "image" },
            { type: "file" },
            { type: "reasoning", text: "ignored" },
          ],
        },
      },
    },
    {
      type: "tool/call",
      seq: 4,
      time: 1300,
      data: { turn: 3, step: 3, callId: "call_err", name: "grep", arguments: '{"q":"x"}' },
    },
    {
      type: "tool/result",
      seq: 5,
      time: 1400,
      data: {
        turn: 3,
        step: 3,
        message: {
          role: "tool",
          toolCallId: "call_err",
          isError: true,
          content: [{ type: "text", text: "no match" }],
        },
        error: { name: "ToolError", code: "not-found", reason: "没有匹配" },
      },
    },
  ];

  const sessionController = {
    async create(req) {
      created.push(req);
      const id = "sess-" + ++seq;
      sessions.set(id, { id });
      return { sessionId: id, agentPreset: req.agentPreset };
    },
    async rename() {
      return { title: "t" };
    },
    async list() {
      return { items: [] };
    },
    async inspect() {
      return { events };
    },
    async page() {
      return { records: events.map((e) => ({ event: e })), hasMore: false };
    },
    async resolveAgent(sessionId) {
      // 旧版形状：{ agent: { session } }
      return { agent: { session: sessions.get(sessionId) } };
    },
  };

  const agentPresets = {
    defaultId: "standard",
    async list() {
      return [
        { id: "standard", name: "Standard", description: "标准模式", order: 1 },
        { id: "creator", description: "创作模式" },
        { id: "broken-one", name: "坏预设", broken: { reason: "boom" } },
      ];
    },
  };

  const permissionPresets = {
    catalog() {
      return {
        // 宿主用 `value` 作为标识字段（契约附录 B）
        options: [
          { value: "read-only", name: "只读", description: "仅可查看" },
          { value: "custom", name: "Custom", description: "当前自定义" },
          { value: "workspace-write", name: "工作区内修改" },
        ],
        defaultOptions: [{ value: "read-only", name: "只读" }],
        defaultPreset: "read-only",
      };
    },
    set(session, name) {
      permissionApplied.push({ sessionId: session?.id, name });
    },
  };

  const ctx = makeCtx({ sessionController, agentPresets, permissionPresets });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // --- 1. session.capabilities ---
  const capId = "req-caps";
  await bridge.dispatch({ id: capId, type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, capId);
  check("capabilities ok", caps?.value !== undefined, JSON.stringify(caps));
  check("capabilities presets=3（含 broken）", caps?.value?.presets?.length === 3, JSON.stringify(caps?.value?.presets));
  check("capabilities preset.name 回退 id", caps?.value?.presets?.[1]?.name === "creator", JSON.stringify(caps?.value?.presets?.[1]));
  check("capabilities preset.description 回退空串", caps?.value?.presets?.[2]?.description === "", JSON.stringify(caps?.value?.presets?.[2]));
  check("capabilities defaultPreset", caps?.value?.defaultPreset === "standard", JSON.stringify(caps?.value?.defaultPreset));
  check("capabilities permissions 跳过 custom", caps?.value?.permissions?.length === 2, JSON.stringify(caps?.value?.permissions));
  check("capabilities permission id 来自 value", caps?.value?.permissions?.[0]?.id === "read-only", JSON.stringify(caps?.value?.permissions?.[0]));
  check("capabilities defaultPermission", caps?.value?.defaultPermission === "read-only", JSON.stringify(caps?.value?.defaultPermission));

  // --- 2. session.create 带 agentPreset / permission ---
  const createId = "req-create";
  await bridge.dispatch({
    id: createId,
    type: "session.create",
    ts: Date.now(),
    payload: { title: "新会话", agentPreset: "creator", permission: "workspace-write" },
  });
  const createdRes = lastResult(relay.sent, createId);
  check("create ok", createdRes?.value?.sessionId?.startsWith("sess-") === true, JSON.stringify(createdRes));
  check("create 把 agentPreset 传给宿主", created[0]?.agentPreset === "creator", JSON.stringify(created[0]));
  check("create 回 agentPreset", createdRes?.value?.agentPreset === "creator", JSON.stringify(createdRes?.value));
  check(
    "create 把权限档位写进新会话",
    permissionApplied.length === 1 && permissionApplied[0].name === "workspace-write" &&
      permissionApplied[0].sessionId === createdRes?.value?.sessionId,
    JSON.stringify(permissionApplied),
  );

  // --- 3. session.history → steps ---
  const histId = "req-hist";
  await bridge.dispatch({
    id: histId,
    type: "session.history",
    ts: Date.now(),
    payload: { sessionId: createdRes.value.sessionId },
  });
  const hist = lastResult(relay.sent, histId);
  check("history 回 messages", Array.isArray(hist?.value?.messages) && hist.value.messages.length === 1, JSON.stringify(hist?.value?.messages));
  const steps = hist?.value?.steps;
  check("history 回 steps（2 条）", Array.isArray(steps) && steps.length === 2, JSON.stringify(steps));
  const s0 = steps?.[0];
  check("step0 字段", s0?.callId === "call_abc" && s0?.name === "bash" && s0?.arguments === '{"command":"ls -la"}', JSON.stringify(s0));
  check("step0 status=ok", s0?.status === "ok", JSON.stringify(s0));
  check("step0 resultText 文本拼接+占位符", s0?.resultText === "total 0\n[图片][文件]", JSON.stringify(s0?.resultText));
  check("step0 errorText 空串", s0?.errorText === "", JSON.stringify(s0?.errorText));
  check("step0 seq 取 tool/call 的 seq", s0?.seq === 2, JSON.stringify(s0?.seq));
  check("step0 turn/step", s0?.turn === 3 && s0?.step === 2, JSON.stringify(s0));
  check("step0 ts", s0?.ts === 1100, JSON.stringify(s0?.ts));
  const s1 = steps?.[1];
  check("step1 status=error", s1?.status === "error", JSON.stringify(s1));
  check("step1 errorText 取 error.reason", s1?.errorText === "没有匹配", JSON.stringify(s1?.errorText));
  check("step1 seq 取 tool/call 的 seq", s1?.seq === 4, JSON.stringify(s1?.seq));
  check("history 仍回 hasMore/oldestSeq", typeof hist?.value?.hasMore === "boolean" && Number.isSafeInteger(hist?.value?.oldestSeq), JSON.stringify(hist?.value));

  // --- 4. session/event 总闸 ---
  relay.sent.length = 0;
  const fakeSession = { id: "sess-live" };
  ctx.emit("session/event", fakeSession, {
    type: "tool/call",
    seq: 10,
    time: 2000,
    data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: '{"path":"a"}' },
  });
  ctx.emit("session/event", fakeSession, {
    type: "tool/result",
    seq: 11,
    time: 2100,
    data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } },
  });
  ctx.emit("session/event", fakeSession, {
    type: "system/message",
    seq: 12,
    time: 2200,
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "系统提示" }] } },
  });
  ctx.emit("session/event", fakeSession, {
    type: "developer/message",
    seq: 13,
    time: 2300,
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "开发者提示" }] } },
  });
  // 不认识的事件类型：不得抛错
  ctx.emit("session/event", fakeSession, { type: "weird/event", seq: 14, time: 2400, data: { foo: 1 } });
  ctx.emit("session/event", fakeSession, null);
  ctx.emit("session/event", null, null);

  const toolCalls = eventsOf(relay.sent, "tool.call");
  const toolResults = eventsOf(relay.sent, "tool.result");
  const sysMsgs = eventsOf(relay.sent, "system.message");
  check("tool.call 事件 1 条", toolCalls.length === 1, JSON.stringify(toolCalls));
  check("tool.call 字段", toolCalls[0]?.sessionId === "sess-live" && toolCalls[0]?.callId === "c1" && toolCalls[0]?.name === "read" && toolCalls[0]?.arguments === '{"path":"a"}' && toolCalls[0]?.ts === 2000, JSON.stringify(toolCalls[0]));
  check("tool.result 事件 1 条", toolResults.length === 1, JSON.stringify(toolResults));
  check("tool.result 字段", toolResults[0]?.callId === "c1" && toolResults[0]?.status === "ok" && toolResults[0]?.resultText === "ok" && toolResults[0]?.errorText === "", JSON.stringify(toolResults[0]));
  check("system.message 2 条（system + developer）", sysMsgs.length === 2, JSON.stringify(sysMsgs));
  check("system.message kind", sysMsgs[0]?.kind === "system" && sysMsgs[1]?.kind === "developer", JSON.stringify(sysMsgs));
  check("system.message text", sysMsgs[0]?.text === "系统提示" && sysMsgs[1]?.text === "开发者提示", JSON.stringify(sysMsgs));

  bridge.dispose();
}

// ===========================================================================
// 场景 2：宿主拒绝 preset → unsupported-agent-preset
// ===========================================================================
{
  const relay = makeRelay();
  const sessionController = {
    async create() {
      const e = new Error("Unknown agent preset: nope");
      e.code = "agent-preset/not-found";
      throw e;
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();
  await bridge.dispatch({ id: "r1", type: "session.create", ts: Date.now(), payload: { agentPreset: "nope" } });
  const res = lastResult(relay.sent, "r1");
  check("宿主拒绝 preset → unsupported-agent-preset", res?.error?.code === "unsupported-agent-preset", JSON.stringify(res));
  bridge.dispose();
}

// ===========================================================================
// 场景 3：降级——宿主没有 agentPresets / permissionPresets 服务
// ===========================================================================
{
  const relay = makeRelay();
  const created = [];
  const sessionController = {
    async create(req) {
      created.push(req);
      return { sessionId: "sess-x" };
    },
    async resolveAgent() {
      return { agent: { session: { id: "sess-x" } } };
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  await bridge.dispatch({ id: "c1", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "c1");
  check("无服务 → presets 空数组", Array.isArray(caps?.value?.presets) && caps.value.presets.length === 0, JSON.stringify(caps));
  check("无服务 → permissions 空数组", Array.isArray(caps?.value?.permissions) && caps.value.permissions.length === 0, JSON.stringify(caps));
  check("无服务 → 默认值空串", caps?.value?.defaultPreset === "" && caps?.value?.defaultPermission === "", JSON.stringify(caps?.value));

  await bridge.dispatch({ id: "c2", type: "session.create", ts: Date.now(), payload: { agentPreset: "std", permission: "read-only" } });
  const createdRes = lastResult(relay.sent, "c2");
  check("无权限服务 → 创建照常成功", createdRes?.value?.sessionId === "sess-x", JSON.stringify(createdRes));
  check("无权限服务 → 只 warn 不阻断", logs.some((l) => l.startsWith("warn") && l.includes("permission")), logs.join(" | "));
  bridge.dispose();
}

// ===========================================================================
// 纯函数：mapHistorySteps / mapPermissionOptions
// ===========================================================================
{
  const steps = mapHistorySteps([
    { event: { type: "tool/result", seq: 7, time: 5, data: { turn: 1, step: 1, message: { toolCallId: "only-result", content: [{ type: "text", text: "r" }] } } } },
    { event: { type: "assistant/message", seq: 8, data: {} } },
    { event: { type: "tool/call", seq: 9, time: 6, data: { turn: 1, step: 2, callId: "only-call", name: "bash", arguments: "{}" } } },
  ]);
  check("mapHistorySteps：只有 result 时 status=ok、seq=result 的 seq", steps[0]?.status === "ok" && steps[0]?.seq === 7, JSON.stringify(steps[0]));
  check("mapHistorySteps：只有 call 时 status=running", steps[1]?.status === "running" && steps[1]?.seq === 9, JSON.stringify(steps[1]));
  check("mapHistorySteps：忽略非工具事件", steps.length === 2, JSON.stringify(steps));

  const perm = mapPermissionOptions({ options: [{ value: "custom" }, { id: "a", name: "A" }], defaultPreset: "a" });
  check("mapPermissionOptions：跳过 custom、接受 id 字段", perm.permissions.length === 1 && perm.permissions[0].id === "a", JSON.stringify(perm));
  check("mapPermissionOptions：默认值", perm.defaultPermission === "a", JSON.stringify(perm));
}

console.log("");
console.log(fail === 0 ? "VERIFY-STEPS RESULT: PASS (" + pass + " checks)" : "VERIFY-STEPS RESULT: FAIL (" + fail + "/" + (pass + fail) + ")");
process.exit(fail === 0 ? 0 : 1);
