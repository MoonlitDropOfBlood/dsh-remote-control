// scripts/verify-steps.mjs —— v1.0.6 / v1.0.7 新链路自检（dev-only，无外部依赖）。
//
// 用 mock ctx（假 sessionController / agentPresets / permissionPresets /
// workspaceRegistry）+ 假 relay 驱动真正的 HostBridge，覆盖契约 §5.7 / §5.8 / §5.9：
//   1. session/event 总闸 → tool.call / tool.result / system.message（§5.2 + §5.7）；
//   2. session.history → steps（StepRecord，tool/call 与 tool/result 按 callId 配对）；
//   3. session.capabilities → presets / permissions / defaultPreset / defaultPermission
//      （跳过 custom 展示态；宿主的 `value` 字段也兜住）；
//   4. session.create 带 agentPreset / permission → 宿主 create 收到 agentPreset、
//      权限档位写进新建会话；
//   5. 宿主拒绝 preset → 回 unsupported-agent-preset；
//   6. 降级：宿主没有 agentPresets / permissionPresets 服务 → 目录为空、
//      创建照常成功（只 warn，不阻断）。
//   7. v1.0.7 归档：session.list 补 archived、session.archive / session.unarchive、
//      domain/changed → session.archives 广播、capabilities.archiveSupported；
//   8. v1.0.7 模型：capabilities models / defaultModelId、session.create 带 model →
//      selectModel；selectModel 失败仍回 sessionId + modelError（**不回 error**）；
//   9. v1.0.7 思考：reasoning-delta → assistant.reasoningDelta；历史 reasoning 块
//      独立成 role:"reasoning" 的 ChatMessage，排在正文之前。
//
// 用法：node scripts/verify-steps.mjs（在 plugin/ 目录下）
import {
  HostBridge,
  mapHistorySteps,
  mapPermissionOptions,
  modelCatalogToWire,
  mapModelCatalog,
  normalizeModelSelection,
  parseModelSelection,
  mapModelSelection,
  mapReasoningEfforts,
  mapHistoryMessages,
  reasoningText,
  contentText,
  messageText,
  attachThumbs,
} from "../lib/host-bridge.mjs";
import {
  IMAGE_MEDIA_TYPES,
  LARGE_MAX_BASE64,
  LARGE_MAX_EDGE,
  THUMB_MAX_BASE64,
  imageBlocksOf,
  loadSharp,
  makeLarge,
  makeThumb,
  setSharpResolver,
} from "../lib/images.mjs";

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
  // v1.1.4：system/message 与 developer/message **不再桥接**（它们是宿主的
  // 系统提示词节点 / 工具注册表变更——提示词组装记录，不是对话内容，PC 聊天
  // 视图从不展示；手机端曾把它们显示成「系统消息」大段文本，用户反馈移除）。
  check("system.message 不再桥接（v1.1.4 移除）", sysMsgs.length === 0, JSON.stringify(sysMsgs));

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
// 场景 2b（v1.1.4）：session.create 的 cwd 归组到工作区
//
// PC 端「在工作区里新建」走 createInWorkspace → createNamed({workspaceId})，
// 会话挂到工作区下面；旧实现只传 cwd，宿主不 attach → PC 上显示「未分组」。
// 现在插件用 workspaceRegistry.resolveByPath(cwd) 反查：命中已注册工作区就
// 改传 workspaceId（自动归组），未命中/异常保持传 cwd（与 PC 普通目录一致）。
// ===========================================================================
{
  // 1) cwd 命中工作区 → create 收到 workspaceId（不带 cwd）
  {
    const relay = makeRelay();
    const createReqs = [];
    const sessionController = {
      async create(req) {
        createReqs.push(req);
        return { sessionId: "sess-ws1" };
      },
    };
    const workspaceRegistry = {
      async resolveByPath(path) {
        return path === "D:/proj" ? { id: "ws-1", path } : undefined;
      },
    };
    const ctx = makeCtx({ sessionController, workspaceRegistry });
    const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
    bridge.attach();
    await bridge.dispatch({ id: "ws-create1", type: "session.create", ts: Date.now(), payload: { cwd: "D:/proj" } });
    const res = lastResult(relay.sent, "ws-create1");
    check("归组：create 成功回 sessionId", res?.value?.sessionId === "sess-ws1", JSON.stringify(res));
    check("归组：命中工作区 → 传 workspaceId", createReqs[0]?.workspaceId === "ws-1", JSON.stringify(createReqs[0]));
    check("归组：命中工作区 → 不再传 cwd（互斥）", createReqs[0]?.cwd === undefined, JSON.stringify(createReqs[0]));
    bridge.dispose();
  }

  // 2) cwd 未命中任何工作区 → 保持传 cwd（= 未分组，与 PC 普通目录一致）
  {
    const relay = makeRelay();
    const createReqs = [];
    const sessionController = {
      async create(req) {
        createReqs.push(req);
        return { sessionId: "sess-ws2" };
      },
    };
    const workspaceRegistry = { async resolveByPath() { return undefined; } };
    const ctx = makeCtx({ sessionController, workspaceRegistry });
    const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
    bridge.attach();
    await bridge.dispatch({ id: "ws-create2", type: "session.create", ts: Date.now(), payload: { cwd: "D:/other" } });
    check("归组：未命中 → 仍传 cwd", createReqs[0]?.cwd === "D:/other" && createReqs[0]?.workspaceId === undefined, JSON.stringify(createReqs[0]));
    bridge.dispose();
  }

  // 3) 没有 workspaceRegistry 服务 → 保持传 cwd，不崩
  {
    const relay = makeRelay();
    const createReqs = [];
    const sessionController = {
      async create(req) {
        createReqs.push(req);
        return { sessionId: "sess-ws3" };
      },
    };
    const ctx = makeCtx({ sessionController });
    const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
    bridge.attach();
    await bridge.dispatch({ id: "ws-create3", type: "session.create", ts: Date.now(), payload: { cwd: "D:/x" } });
    const res = lastResult(relay.sent, "ws-create3");
    check("归组：无 registry 服务仍创建成功", res?.value?.sessionId === "sess-ws3", JSON.stringify(res));
    check("归组：无 registry → 传 cwd", createReqs[0]?.cwd === "D:/x", JSON.stringify(createReqs[0]));
    bridge.dispose();
  }

  // 4) resolveByPath 抛错（目录不存在等）→ 兜底传 cwd，不阻断创建
  {
    const relay = makeRelay();
    const createReqs = [];
    const sessionController = {
      async create(req) {
        createReqs.push(req);
        return { sessionId: "sess-ws4" };
      },
    };
    const workspaceRegistry = {
      async resolveByPath() { throw new Error("ENOENT: no such directory"); },
    };
    const ctx = makeCtx({ sessionController, workspaceRegistry });
    const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
    bridge.attach();
    await bridge.dispatch({ id: "ws-create4", type: "session.create", ts: Date.now(), payload: { cwd: "D:/gone" } });
    const res = lastResult(relay.sent, "ws-create4");
    check("归组：resolveByPath 抛错仍创建成功", res?.value?.sessionId === "sess-ws4", JSON.stringify(res));
    check("归组：resolveByPath 抛错 → 兜底传 cwd", createReqs[0]?.cwd === "D:/gone", JSON.stringify(createReqs[0]));
    bridge.dispose();
  }
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

// ===========================================================================
// 场景 4（v1.0.7）：真实归档 —— list 补 archived / archive / unarchive / 广播
// ===========================================================================
{
  const relay = makeRelay();
  const archived = new Set(["sess-old"]);
  const archiveCalls = [];
  const unarchiveCalls = [];
  const workspaceRegistry = {
    get archivedSessionIds() {
      return [...archived];
    },
    async archiveSession(sessionId, options) {
      archiveCalls.push({ sessionId, options });
      if (sessionId === "sess-busy") {
        const e = new Error("session is active");
        e.code = "workspace/active-session";
        throw e;
      }
      archived.add(sessionId);
    },
    async unarchiveSession(sessionId) {
      unarchiveCalls.push(sessionId);
      archived.delete(sessionId);
    },
  };
  const sessionController = {
    async list() {
      return {
        items: [
          { sessionId: "sess-old", cwd: "D:/x", running: false, updatedAt: 1 },
          { sessionId: "sess-new", cwd: "D:/x", running: true, updatedAt: 2 },
        ],
      };
    },
  };
  const ctx = makeCtx({ sessionController, workspaceRegistry });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // list：archived 来自注册表（**首屏即带**：归档早于插件启动、没有任何
  // domain/changed 事件发生，也必须在首次 list 里就带 archived=true）
  check("list 前没有任何 session.archives 广播", eventsOf(relay.sent, "session.archives").length === 0, JSON.stringify(relay.sent));
  await bridge.dispatch({ id: "a-list", type: "session.list", ts: Date.now(), payload: {} });
  const list = lastResult(relay.sent, "a-list");
  const oldRow = list?.value?.sessions?.find((s) => s.sessionId === "sess-old");
  const newRow = list?.value?.sessions?.find((s) => s.sessionId === "sess-new");
  check("list：已归档会话带 archived=true（首屏即带）", oldRow?.archived === true, JSON.stringify(oldRow));
  check("list：未归档会话带 archived=false", newRow?.archived === false, JSON.stringify(newRow));
  check("list：已归档会话仍在列表里（不隐藏）", list?.value?.sessions?.some((s) => s.sessionId === "sess-old") === true, JSON.stringify(list?.value?.sessions?.map((s) => s.sessionId)));

  // capabilities：archiveSupported
  await bridge.dispatch({ id: "a-caps", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "a-caps");
  check("capabilities：archiveSupported=true", caps?.value?.archiveSupported === true, JSON.stringify(caps?.value));

  // archive
  await bridge.dispatch({ id: "a-arch", type: "session.archive", ts: Date.now(), payload: { sessionId: "sess-new" } });
  const arch = lastResult(relay.sent, "a-arch");
  check("archive：回 {sessionId,archived:true}", arch?.value?.sessionId === "sess-new" && arch?.value?.archived === true, JSON.stringify(arch));
  check("archive：调 workspaceRegistry.archiveSession(sid,{stopActivity:false})", archiveCalls[0]?.sessionId === "sess-new" && archiveCalls[0]?.options?.stopActivity === false, JSON.stringify(archiveCalls[0]));

  // archive：stopActivity 透传
  await bridge.dispatch({ id: "a-arch2", type: "session.archive", ts: Date.now(), payload: { sessionId: "sess-new", stopActivity: true } });
  check("archive：stopActivity=true 透传", archiveCalls[1]?.options?.stopActivity === true, JSON.stringify(archiveCalls[1]));

  // 宿主错误原样回传
  await bridge.dispatch({ id: "a-busy", type: "session.archive", ts: Date.now(), payload: { sessionId: "sess-busy" } });
  const busy = lastResult(relay.sent, "a-busy");
  check("archive：宿主错误原样回传（code+message）", busy?.error?.code === "workspace/active-session" && busy?.error?.message === "session is active", JSON.stringify(busy));

  // unarchive
  await bridge.dispatch({ id: "a-un", type: "session.unarchive", ts: Date.now(), payload: { sessionId: "sess-old" } });
  const un = lastResult(relay.sent, "a-un");
  check("unarchive：回 {sessionId,archived:false}", un?.value?.sessionId === "sess-old" && un?.value?.archived === false, JSON.stringify(un));
  check("unarchive：调 workspaceRegistry.unarchiveSession(sid)", unarchiveCalls[0] === "sess-old", JSON.stringify(unarchiveCalls));

  // domain/changed → 广播归档全集
  relay.sent.length = 0;
  ctx.emit("domain/changed", { domain: "workspace", table: "", key: "", operation: "put", value: {} });
  const archives = eventsOf(relay.sent, "session.archives");
  check("domain/changed(workspace,'',put) → 广播 session.archives", archives.length === 1, JSON.stringify(archives));
  check("session.archives 带全集 archivedSessionIds", Array.isArray(archives[0]?.archivedSessionIds) && archives[0].archivedSessionIds.includes("sess-new"), JSON.stringify(archives[0]));

  // 其它 domain/table/operation 不触发
  relay.sent.length = 0;
  ctx.emit("domain/changed", { domain: "other", table: "", operation: "put" });
  ctx.emit("domain/changed", { domain: "workspace", table: "x", operation: "put" });
  ctx.emit("domain/changed", { domain: "workspace", table: "", operation: "deleted" });
  check("非 workspace/''/put 的 domain/changed 不广播", eventsOf(relay.sent, "session.archives").length === 0, JSON.stringify(relay.sent));

  bridge.dispose();
}

// ===========================================================================
// 场景 5（v1.0.7）：没有 Workspace 注册表 → archiveSupported=false + 归档不可用
// ===========================================================================
{
  const relay = makeRelay();
  const sessionController = { async list() { return { items: [{ sessionId: "s1" }] }; } };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  await bridge.dispatch({ id: "n-caps", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "n-caps");
  check("无注册表 → archiveSupported=false", caps?.value?.archiveSupported === false, JSON.stringify(caps?.value));

  await bridge.dispatch({ id: "n-list", type: "session.list", ts: Date.now(), payload: {} });
  const list = lastResult(relay.sent, "n-list");
  check("无注册表 → list 不产出 archived 字段", list?.value?.sessions?.[0] !== undefined && !("archived" in list.value.sessions[0]), JSON.stringify(list?.value?.sessions?.[0]));

  await bridge.dispatch({ id: "n-arch", type: "session.archive", ts: Date.now(), payload: { sessionId: "s1" } });
  const arch = lastResult(relay.sent, "n-arch");
  check("无注册表 → archive 回 service-unavailable", arch?.error?.code === "service-unavailable", JSON.stringify(arch));
  bridge.dispose();
}

// ===========================================================================
// 场景 6（v1.0.7）：模型 —— capabilities models + create 带 model
// ===========================================================================
{
  const relay = makeRelay();
  const selected = [];
  let selectModelFails = false;
  const catalog = {
    default: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    groups: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          { id: "deepseek-chat", name: "DeepSeek Chat", description: "通用", reasoning: { efforts: [{ id: "high" }], defaultEffort: "high" } },
          { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ],
      },
      { id: "zai", name: "ZAI", models: [{ id: "glm-4.6", name: "GLM 4.6" }] },
    ],
    failures: [],
  };
  const sessionController = {
    async create() {
      return { sessionId: "sess-m" };
    },
    async modelCatalog() {
      return catalog;
    },
    async selectModel(req) {
      selected.push(req);
      if (selectModelFails) {
        const e = new Error("model not available");
        e.code = "session/model-unavailable";
        throw e;
      }
      return { selected: { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort } };
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // capabilities：models 拍平
  await bridge.dispatch({ id: "m-caps", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "m-caps");
  const models = caps?.value?.models;
  check("capabilities：models 拍平 groups", Array.isArray(models) && models.length === 3, JSON.stringify(models));
  check("ModelOption.id = provider/model", models?.[0]?.id === "deepseek/deepseek-chat", JSON.stringify(models?.[0]));
  check("ModelOption.provider/model 分列", models?.[0]?.provider === "deepseek" && models?.[0]?.model === "deepseek-chat", JSON.stringify(models?.[0]));
  check("ModelOption.name/description", models?.[0]?.name === "DeepSeek Chat" && models?.[0]?.description === "通用", JSON.stringify(models?.[0]));
  check("ModelOption.reasoningEffort 取 reasoning.defaultEffort", models?.[0]?.reasoningEffort === "high", JSON.stringify(models?.[0]));
  check("无 reasoning 的模型不带 reasoningEffort", models?.[1]?.reasoningEffort === undefined, JSON.stringify(models?.[1]));
  check("capabilities：defaultModelId 由 catalog.default 生成", caps?.value?.defaultModelId === "deepseek/deepseek-chat", JSON.stringify(caps?.value?.defaultModelId));

  // create 带 model → selectModel
  await bridge.dispatch({
    id: "m-create",
    type: "session.create",
    ts: Date.now(),
    payload: { model: { provider: "zai", model: "glm-4.6", reasoningEffort: "max" } },
  });
  const created = lastResult(relay.sent, "m-create");
  check("create：回 sessionId", created?.value?.sessionId === "sess-m", JSON.stringify(created));
  check("create：调 selectModel({sessionId,provider,model,reasoningEffort})", selected[0]?.sessionId === "sess-m" && selected[0]?.provider === "zai" && selected[0]?.model === "glm-4.6" && selected[0]?.reasoningEffort === "max", JSON.stringify(selected[0]));
  check("create：回 model=归一化后的 selection", created?.value?.model?.provider === "zai" && created?.value?.model?.model === "glm-4.6", JSON.stringify(created?.value?.model));

  // selectModel 失败：仍回 sessionId + modelError（**绝不能回 error**）
  selectModelFails = true;
  await bridge.dispatch({
    id: "m-fail",
    type: "session.create",
    ts: Date.now(),
    payload: { model: { provider: "deepseek", model: "nope" } },
  });
  const failed = lastResult(relay.sent, "m-fail");
  check("selectModel 失败：仍回 ok + sessionId（手机不得重复创建）", failed?.value?.sessionId === "sess-m" && failed?.error === undefined, JSON.stringify(failed));
  check("selectModel 失败：附 modelError", typeof failed?.value?.modelError === "string" && failed.value.modelError.includes("model not available"), JSON.stringify(failed?.value?.modelError));

  bridge.dispose();
}

// ===========================================================================
// 场景 7（v1.0.7）：思考 —— reasoning-delta 事件 + 历史 reasoning 消息
// ===========================================================================
{
  const relay = makeRelay();
  const events = [
    {
      type: "assistant/message",
      seq: 20,
      time: 3000,
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "先想想…" },
            { type: "text", text: "结论如下" },
          ],
        },
      },
    },
    {
      type: "assistant/message",
      seq: 21,
      time: 3100,
      surfaceOp: "append",
      data: { turn: 1, step: 2, message: { content: [{ type: "reasoning", text: "只有思考" }] } },
    },
  ];
  const sessionController = {
    async inspect() {
      return { events };
    },
    async page() {
      return { records: events.map((e) => ({ event: e })), hasMore: false };
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // history：reasoning 独立成条，排在正文之前
  await bridge.dispatch({ id: "r-hist", type: "session.history", ts: Date.now(), payload: { sessionId: "sess-r" } });
  const hist = lastResult(relay.sent, "r-hist");
  const messages = hist?.value?.messages ?? [];
  check("history：reasoning 独立成条且排在正文之前", messages.length === 3 && messages[0]?.role === "reasoning" && messages[1]?.role === "assistant", JSON.stringify(messages));
  check("history：reasoning id = sessionId:seq:reasoning", messages[0]?.id === "sess-r:20:reasoning", JSON.stringify(messages[0]));
  check("history：reasoning 与正文同 seq/ts", messages[0]?.seq === 20 && messages[0]?.ts === 3000 && messages[1]?.seq === 20 && messages[1]?.ts === 3000, JSON.stringify(messages.slice(0, 2)));
  check("history：正文不含思考文本", messages[1]?.text === "结论如下", JSON.stringify(messages[1]));
  check("history：只有思考块也产出 reasoning 消息", messages[2]?.role === "reasoning" && messages[2]?.text === "只有思考", JSON.stringify(messages[2]));

  // live：reasoning-delta → assistant.reasoningDelta；text-delta 仍走 assistant.delta
  relay.sent.length = 0;
  const liveSession = { id: "sess-r" };
  ctx.emit("agent/assistant-stream", {
    agent: { session: { id: liveSession.id } },
    frame: { type: "chunk", chunk: { type: "reasoning-delta", text: "思考中…" } },
  });
  ctx.emit("agent/assistant-stream", {
    agent: { session: { id: liveSession.id } },
    frame: { type: "chunk", chunk: { type: "text-delta", text: "正文" } },
  });
  // 结束 turn → 两个缓冲分别冲刷
  ctx.emit("agent/status", { agent: { session: { id: liveSession.id } }, status: "idle" });
  const reasoningEvents = eventsOf(relay.sent, "assistant.reasoningDelta");
  const textEvents = eventsOf(relay.sent, "assistant.delta");
  check("live：reasoning-delta → assistant.reasoningDelta", reasoningEvents.length === 1 && reasoningEvents[0]?.text === "思考中…" && reasoningEvents[0]?.sessionId === "sess-r", JSON.stringify(reasoningEvents));
  check("live：text-delta 仍走 assistant.delta（分流）", textEvents.length === 1 && textEvents[0]?.text === "正文", JSON.stringify(textEvents));
  check("live：思考不进 assistant.delta", !eventsOf(relay.sent, "assistant.delta").some((d) => (d.text ?? "").includes("思考中")), JSON.stringify(textEvents));

  bridge.dispose();
}

// ===========================================================================
// 纯函数：mapModelCatalog / normalizeModelSelection / mapHistoryMessages
// ===========================================================================
{
  const cat = mapModelCatalog({
    default: { provider: "p", model: "m" },
    groups: [{ id: "p", name: "P", models: [{ id: "m", name: "M", reasoning: { defaultEffort: "low" } }] }],
  });
  check("mapModelCatalog：id=provider/model", cat.models[0]?.id === "p/m", JSON.stringify(cat.models[0]));
  check("mapModelCatalog：defaultModelId", cat.defaultModelId === "p/m", JSON.stringify(cat.defaultModelId));
  check("mapModelCatalog：空目录", mapModelCatalog({}).models.length === 0 && mapModelCatalog({}).defaultModelId === "", JSON.stringify(mapModelCatalog({})));
  check("mapModelCatalog：非法输入不抛", mapModelCatalog(null).models.length === 0, "null");

  check("normalizeModelSelection：正常", JSON.stringify(normalizeModelSelection({ provider: "a", model: "b", reasoningEffort: "high" })) === JSON.stringify({ provider: "a", model: "b", reasoningEffort: "high" }), JSON.stringify(normalizeModelSelection({ provider: "a", model: "b" })));
  check("normalizeModelSelection：缺字段回 null", normalizeModelSelection({ provider: "a" }) === null && normalizeModelSelection(null) === null, "null");
  check("normalizeModelSelection：不从 id 反拆", normalizeModelSelection({ id: "a/b" }) === null, "null");

  check("reasoningText：只取 reasoning 块", reasoningText([{ type: "reasoning", text: "a" }, { type: "text", text: "b" }]) === "a", reasoningText([{ type: "reasoning", text: "a" }]));
  check("contentText 不含 reasoning", contentText([{ type: "reasoning", text: "a" }, { type: "text", text: "b" }]) === "b", contentText([{ type: "reasoning", text: "a" }]));

  const msgs = mapHistoryMessages("s", {
    event: { type: "assistant/message", seq: 3, time: 9, surfaceOp: "append", data: { message: { content: [{ type: "reasoning", text: "r" }, { type: "text", text: "t" }] } } },
  });
  check("mapHistoryMessages：两条（reasoning 在前）", msgs.length === 2 && msgs[0].role === "reasoning" && msgs[1].role === "assistant", JSON.stringify(msgs));
  check("mapHistoryMessages：非对话事件回空数组", mapHistoryMessages("s", { event: { type: "tool/call", seq: 1 } }).length === 0, "[]");
}

// ===========================================================================
// 场景 8（v1.0.8）：思考强度目录 + 会话中切换模型
// ===========================================================================
{
  const relay = makeRelay();
  const selected = [];
  let selectFails = false;
  const catalog = {
    default: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" },
    groups: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            description: "通用",
            reasoning: {
              efforts: [
                { id: "minimal", name: "最少" },
                { id: "low", name: "低", description: "更快" },
                { id: "high", name: "高" },
              ],
              defaultEffort: "high",
            },
          },
          { id: "deepseek-plain", name: "Plain" }, // 无 reasoning → 不产出 efforts
        ],
      },
    ],
  };
  const sessionController = {
    async modelCatalog() {
      return catalog;
    },
    async selectModel(req) {
      selected.push(req);
      if (selectFails) {
        const e = new Error("model is not available");
        e.code = "session/model-unavailable";
        throw e;
      }
      return { selected: { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort } };
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // capabilities：efforts 目录
  await bridge.dispatch({ id: "v-caps", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "v-caps");
  const opt = caps?.value?.models?.[0];
  check("capabilities：ModelOption.efforts 拍平 reasoning.efforts", Array.isArray(opt?.efforts) && opt.efforts.length === 3, JSON.stringify(opt));
  check("efforts 字段：id/name/description", opt?.efforts?.[1]?.id === "low" && opt?.efforts?.[1]?.name === "低" && opt?.efforts?.[1]?.description === "更快", JSON.stringify(opt?.efforts?.[1]));
  check("efforts：name 回退 id", opt?.efforts?.[0]?.name === "最少" && opt?.efforts?.[0]?.description === "", JSON.stringify(opt?.efforts?.[0]));
  check("无 reasoning 的模型不产出 efforts", caps?.value?.models?.[1]?.efforts === undefined, JSON.stringify(caps?.value?.models?.[1]));
  check("capabilities：reasoningEffort 仍取 defaultEffort", opt?.reasoningEffort === "high", JSON.stringify(opt?.reasoningEffort));

  // session.model：初始为 null（内存态为空）
  await bridge.dispatch({ id: "v-model0", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-v" } });
  const m0 = lastResult(relay.sent, "v-model0");
  check("session.model：未追踪到时回 null（不臆造）", m0?.value?.model === null && m0?.error === undefined, JSON.stringify(m0));

  // session.selectModel：成功
  await bridge.dispatch({
    id: "v-sel",
    type: "session.selectModel",
    ts: Date.now(),
    payload: { sessionId: "sess-v", model: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" } },
  });
  const sel = lastResult(relay.sent, "v-sel");
  check("selectModel：成功回 {model}", sel?.value?.model?.provider === "deepseek" && sel?.value?.model?.model === "deepseek-chat" && sel?.value?.model?.reasoningEffort === "low", JSON.stringify(sel));
  check("selectModel：调宿主 selectModel({sessionId,...selection})", selected[0]?.sessionId === "sess-v" && selected[0]?.provider === "deepseek" && selected[0]?.model === "deepseek-chat" && selected[0]?.reasoningEffort === "low", JSON.stringify(selected[0]));

  // session.selectModel：无效 selection → result.error
  await bridge.dispatch({ id: "v-bad", type: "session.selectModel", ts: Date.now(), payload: { sessionId: "sess-v", model: { id: "a/b" } } });
  const bad = lastResult(relay.sent, "v-bad");
  check("selectModel：无效 selection 回 error", bad?.error?.code === "bad-params" && bad?.value === undefined, JSON.stringify(bad));

  // session.selectModel：宿主拒绝 → 原文带出（不假成功）
  selectFails = true;
  await bridge.dispatch({
    id: "v-reject",
    type: "session.selectModel",
    ts: Date.now(),
    payload: { sessionId: "sess-v", model: { provider: "deepseek", model: "nope" } },
  });
  const rej = lastResult(relay.sent, "v-reject");
  check("selectModel：宿主拒绝回原文 error", rej?.error?.code === "session/model-unavailable" && rej?.error?.message === "model is not available" && rej?.value === undefined, JSON.stringify(rej));
  selectFails = false;

  // model/selection 事件 → 内存态 + session.modelChanged 广播
  relay.sent.length = 0;
  ctx.emit("session/event", { id: "sess-v" }, { type: "model/selection", seq: 30, time: 4000, data: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "minimal" } });
  const changed = eventsOf(relay.sent, "session.modelChanged");
  check("model/selection → 广播 session.modelChanged", changed.length === 1, JSON.stringify(changed));
  check("session.modelChanged 字段", changed[0]?.sessionId === "sess-v" && changed[0]?.model?.provider === "deepseek" && changed[0]?.model?.model === "deepseek-chat" && changed[0]?.model?.reasoningEffort === "minimal", JSON.stringify(changed[0]));

  await bridge.dispatch({ id: "v-model1", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-v" } });
  const m1 = lastResult(relay.sent, "v-model1");
  check("session.model：追踪到后回当前 selection", m1?.value?.model?.reasoningEffort === "minimal", JSON.stringify(m1));

  // 无 reasoningEffort 的事件 → 省略该字段
  relay.sent.length = 0;
  ctx.emit("session/event", { id: "sess-v2" }, { type: "model/selection", seq: 31, time: 4100, data: { provider: "zai", model: "glm-4.6" } });
  const changed2 = eventsOf(relay.sent, "session.modelChanged");
  check("model/selection 无 reasoningEffort → 省略该字段", changed2[0]?.model?.provider === "zai" && changed2[0]?.model?.reasoningEffort === undefined, JSON.stringify(changed2[0]));

  await bridge.dispatch({ id: "v-model2", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-v2" } });
  const m2 = lastResult(relay.sent, "v-model2");
  check("session.model：无 reasoningEffort 的 selection", m2?.value?.model?.model === "glm-4.6" && m2?.value?.model?.reasoningEffort === undefined, JSON.stringify(m2));

  // 另一个会话的模型状态不串台
  await bridge.dispatch({ id: "v-model3", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-other" } });
  const m3 = lastResult(relay.sent, "v-model3");
  check("session.model：未追踪的会话回 null", m3?.value?.model === null, JSON.stringify(m3));

  bridge.dispose();
}

// ===========================================================================
// 场景 8b（v1.1.4）：session.model 走 **modelSelection 持久投影**
//
// 与桌面端 composer 同源（dsh-client-ui-model-selection 的 syncInputs：
//   selection = projected.next ?? catalog.default，
// 投影视图形状 {lastUsed, next}，next = pending ?? lastUsed）。
// 旧实现只认 model/selection 直播事件的内存态 → 从没显式切换过模型的会话
// 永远回 null，手机端就一直显示目录默认模型（与 PC 对不上，用户实测反馈）。
// ===========================================================================
{
  const relay = makeRelay();
  const projectionsBySession = new Map();
  let projectionsThrows = false;
  const sessionController = {
    async projections(req) {
      if (projectionsThrows) {
        const e = new Error("projection read failed");
        e.code = "session/projections-unavailable";
        throw e;
      }
      const view = projectionsBySession.get(req.sessionId);
      if (view === undefined) return null;
      return { kind: "sequenced", asOfSeq: 1, values: { modelSelection: view } };
    },
  };
  const ctx = makeCtx({ sessionController });
  const bridge = new HostBridge({ ctx, relay, push: { configured: false, notify: async () => ({ ok: true }) }, config: CFG, log });
  bridge.attach();

  // 1) pending（用户显式切换过、尚未被请求消费）优先
  projectionsBySession.set("sess-p", {
    lastUsed: { provider: "deepseek", model: "deepseek-chat" },
    next: { provider: "deepseek", model: "deepseek-reasoner", reasoningEffort: "high" },
  });
  await bridge.dispatch({ id: "v-p1", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-p" } });
  const p1 = lastResult(relay.sent, "v-p1");
  check("session.model：投影 next（pending）优先", p1?.value?.model?.model === "deepseek-reasoner" && p1?.value?.model?.reasoningEffort === "high", JSON.stringify(p1));

  // 2) 没有 pending → 回落 lastUsed（上一个 request/header 实际用的模型）
  projectionsBySession.set("sess-l", {
    lastUsed: { provider: "zai", model: "glm-4.6" },
    next: { provider: "zai", model: "glm-4.6" },
  });
  await bridge.dispatch({ id: "v-p2", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-l" } });
  const p2 = lastResult(relay.sent, "v-p2");
  check("session.model：投影 next 为空时回 lastUsed", p2?.value?.model?.provider === "zai" && p2?.value?.model?.model === "glm-4.6", JSON.stringify(p2));

  // 3) lastUsed 有 reasoningEffort → 原样带出（PC 显示的是同一个值）
  projectionsBySession.set("sess-e", {
    lastUsed: { provider: "deepseek", model: "deepseek-chat", reasoningEffort: "low" },
    next: null,
  });
  await bridge.dispatch({ id: "v-p3", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-e" } });
  const p3 = lastResult(relay.sent, "v-p3");
  check("session.model：投影带出 reasoningEffort", p3?.value?.model?.reasoningEffort === "low", JSON.stringify(p3));

  // 4) 空白会话（投影两项都空）→ null（客户端回退目录默认 = PC 的 catalog.default 回退）
  projectionsBySession.set("sess-empty", { lastUsed: null, next: null });
  await bridge.dispatch({ id: "v-p4", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-empty" } });
  const p4 = lastResult(relay.sent, "v-p4");
  check("session.model：空白会话回 null（不臆造）", p4?.value?.model === null && p4?.error === undefined, JSON.stringify(p4));

  // 5) 投影读取失败 → 退回直播事件内存态，不报错
  projectionsThrows = true;
  relay.sent.length = 0;
  ctx.emit("session/event", { id: "sess-fb" }, { type: "model/selection", seq: 40, time: 5000, data: { provider: "deepseek", model: "deepseek-chat" } });
  await bridge.dispatch({ id: "v-p5", type: "session.model", ts: Date.now(), payload: { sessionId: "sess-fb" } });
  const p5 = lastResult(relay.sent, "v-p5");
  check("session.model：投影读取失败退回内存态", p5?.value?.model?.model === "deepseek-chat" && p5?.error === undefined, JSON.stringify(p5));
  projectionsThrows = false;

  bridge.dispose();
}

// ===========================================================================
// 纯函数：modelCatalogToWire / mapReasoningEfforts / parseModelSelection
// ===========================================================================
{
  const cat = modelCatalogToWire({
    default: { provider: "p", model: "m" },
    groups: [
      {
        id: "p",
        name: "P",
        models: [{ id: "m", name: "M", reasoning: { efforts: [{ id: "high", name: "高" }], defaultEffort: "high" } }],
      },
    ],
  });
  check("modelCatalogToWire：efforts 拍平", cat.models[0]?.efforts?.[0]?.id === "high", JSON.stringify(cat.models[0]));
  check("modelCatalogToWire：无 efforts 的模型不带该字段", modelCatalogToWire({ groups: [{ id: "p", models: [{ id: "x" }] }] }).models[0]?.efforts === undefined, "undefined");
  check("mapReasoningEfforts：跳过非法项", mapReasoningEfforts([{ id: "" }, { id: "a", name: "A" }]).length === 1, JSON.stringify(mapReasoningEfforts([{ id: "" }, { id: "a" }])));
  check("mapReasoningEfforts：name 回退 id + description 空串", mapReasoningEfforts([{ id: "a" }])[0]?.name === "a" && mapReasoningEfforts([{ id: "a" }])[0]?.description === "", JSON.stringify(mapReasoningEfforts([{ id: "a" }])));
  check("parseModelSelection：无效回 null", parseModelSelection({ provider: "a" }) === null && parseModelSelection("x") === null, "null");
  check("mapModelSelection：省略空 reasoningEffort", mapModelSelection({ provider: "a", model: "b", reasoningEffort: "" })?.reasoningEffort === undefined, JSON.stringify(mapModelSelection({ provider: "a", model: "b" })));
}

// ===========================================================================
// 场景 9（v1.0.9）：会话消息里的图片（契约 §5.10 / §5.1 image.fetch）
//
// 用桩数据（假 attachments 服务 + 假 sharp）驱动真正的 HostBridge 与
// lib/images.mjs，不依赖真机/真宿主。覆盖：
//   1. image 块识别（imageBlocksOf）与 ImageRef 形状；
//   2. mapHistoryMessages 不再产生 "[图片]" 占位符（图片单独渲染）；
//   3. 缩略图超限降级（降质/降尺寸），压不进则只发元数据（thumb 留空）；
//   4. sharp 不可用时降级（不抛异常）；
//   5. assistant.image 直播事件（带内联缩略图）；
//   6. image.fetch 校验（非法/未知 imageId 回 error）与缩放缓存。
// ===========================================================================
{
  const refA = { attachmentId: "sha256:aaa", mediaType: "image/png", bytes: 1234, width: 800, height: 600, name: "a.png" };
  const refB = { attachmentId: "sha256:bbb", mediaType: "image/jpeg", bytes: 42, width: 20, height: 10 };
  const mixedContent = [
    { type: "text", text: "看图" },
    { type: "image", attachment: refA },
    { type: "reasoning", text: "r" },
    { type: "image", attachment: refB },
    { type: "file", attachment: { attachmentId: "sha256:fff", name: "a.txt", bytes: 3 } },
  ];

  // --- 1. image 块识别 ---
  const blocks = imageBlocksOf(mixedContent);
  check("imageBlocksOf：取出全部 image 块的 attachment 引用", blocks.length === 2 && blocks[0] === refA && blocks[1] === refB, JSON.stringify(blocks.map((b) => b.attachmentId)));
  check("imageBlocksOf：非数组回空数组", imageBlocksOf(null).length === 0 && imageBlocksOf("x").length === 0 && imageBlocksOf(undefined).length === 0, "[]");
  check("imageBlocksOf：没有 attachment 的 image 块跳过", imageBlocksOf([{ type: "image" }, { type: "text", text: "t" }]).length === 0, "[]");
  check("imageBlocksOf：非 image 块不误判", imageBlocksOf([{ type: "file", attachment: { attachmentId: "x" } }]).length === 0, "[]");
  check("IMAGE_MEDIA_TYPES：四种宿主图片类型", IMAGE_MEDIA_TYPES.length === 4 && IMAGE_MEDIA_TYPES.includes("image/webp") && IMAGE_MEDIA_TYPES.includes("image/gif"), JSON.stringify(IMAGE_MEDIA_TYPES));

  // --- 2. ChatMessage.images[]（ImageRef 形状）+ 正文不再有 "[图片]" ---
  const imgMsgs = mapHistoryMessages("s", {
    event: { type: "assistant/message", seq: 5, time: 11, surfaceOp: "append", data: { message: { content: mixedContent } } },
  });
  check("mapHistoryMessages：图片消息带 images[]", imgMsgs.length === 2 && Array.isArray(imgMsgs[1].images) && imgMsgs[1].images.length === 2, JSON.stringify(imgMsgs));
  const ir = imgMsgs[1]?.images?.[0];
  check(
    "ImageRef 形状（imageId/mediaType/width/height/bytes/thumb）",
    ir?.imageId === "sha256:aaa" && ir?.mediaType === "image/png" && ir?.width === 800 &&
      ir?.height === 600 && ir?.bytes === 1234 && ir?.thumb === "",
    JSON.stringify(ir),
  );
  check("ImageRef：附件引用不进 wire JSON", !JSON.stringify(imgMsgs[1]).includes("attachmentId"), JSON.stringify(imgMsgs[1]));
  check("mapHistoryMessages：正文不再出现 [图片] 占位符", !imgMsgs[1]?.text?.includes("[图片]"), JSON.stringify(imgMsgs[1]?.text));
  check("mapHistoryMessages：正文保留 file 占位符", imgMsgs[1]?.text === "看图[文件]", JSON.stringify(imgMsgs[1]?.text));
  check("messageText：图片块不占位", messageText(mixedContent) === "看图[文件]", messageText(mixedContent));
  check("contentText：工具结果口径仍给图片占位符（§5.7 不变）", contentText([{ type: "image" }]) === "[图片]", contentText([{ type: "image" }]));

  // 纯图片消息（无正文）也要成条，否则手机端看不到这张图
  const onlyImg = mapHistoryMessages("s", {
    event: { type: "user/message", seq: 6, time: 12, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "image", attachment: refA }] } },
  });
  check("mapHistoryMessages：纯图片消息也成条", onlyImg.length === 1 && onlyImg[0].text === "" && onlyImg[0].images?.length === 1, JSON.stringify(onlyImg));
  const noImg = mapHistoryMessages("s", {
    event: { type: "user/message", seq: 7, time: 13, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "text", text: "hi" }] } },
  });
  check("mapHistoryMessages：无图片不产 images 字段", noImg.length === 1 && noImg[0].images === undefined, JSON.stringify(noImg));

  // --- 3./4. 真实 sharp（有就用，没有就跳过；不依赖） ---
  const realSharp = loadSharp();
  if (realSharp) {
    try {
      const png = await realSharp({ create: { width: 900, height: 600, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
      const thumb = await makeThumb(png, "image/png");
      check(
        "真实 sharp：缩略图是 JPEG data URI 且 ≤96KB base64",
        thumb.startsWith("data:image/jpeg;base64,") && thumb.length - "data:image/jpeg;base64,".length <= THUMB_MAX_BASE64,
        thumb.slice(0, 48),
      );
      const big = await makeLarge(png, "image/png", 1600);
      check(
        "真实 sharp：大图 data URI、长边不放大、≤1MiB",
        big.data.startsWith("data:image/jpeg;base64,") && big.width === 900 && big.height === 600 && big.data.length <= 1024 * 1024,
        JSON.stringify({ w: big.width, h: big.height, len: big.data.length }),
      );
    } catch (e) {
      check("真实 sharp：图片往返", false, String(e && e.message));
    }
  }

  // --- 假 sharp：可控输出尺寸，用来验证降级阶梯 ---
  const fakeCalls = [];
  const fakeSharp = (sizeFor) => (input, opts) => {
    const state = { edge: 0, quality: 0, animated: opts?.animated === true };
    const api = {
      rotate() { return api; },
      resize(o) { state.edge = Math.min(o.width, o.height); return api; },
      jpeg(o) { state.quality = o.quality; return api; },
      async toBuffer(o) {
        fakeCalls.push({ ...state });
        const bytes = Math.max(1, Math.floor(sizeFor(state)));
        const data = Buffer.alloc(bytes, 0x41);
        if (o?.resolveWithObject) {
          return { data, info: { width: state.edge, height: state.edge, format: "jpeg", size: bytes } };
        }
        return data;
      },
    };
    return api;
  };

  // 缩略图：q75 压不进 96KB → 自动降质到 q60
  fakeCalls.length = 0;
  setSharpResolver(() => fakeSharp((s) => s.quality * 1000));
  const thumb2 = await makeThumb(Buffer.from("raw"), "image/png");
  check(
    "makeThumb：超 96KB 自动降质重压",
    thumb2.startsWith("data:image/jpeg;base64,") && thumb2.length - "data:image/jpeg;base64,".length <= THUMB_MAX_BASE64 &&
      fakeCalls.length === 2 && fakeCalls[0].quality === 75 && fakeCalls[1].quality === 60,
    JSON.stringify(fakeCalls),
  );
  check("makeThumb：长边 ≤480", fakeCalls[0].edge === 480, JSON.stringify(fakeCalls[0]));

  // 缩略图：怎么压都超限 → 返回 ''（只发元数据）
  fakeCalls.length = 0;
  setSharpResolver(() => fakeSharp(() => 5_000_000));
  const thumb3 = await makeThumb(Buffer.from("raw"), "image/png");
  check("makeThumb：压不进 96KB 返回空串（只发元数据）", thumb3 === "", JSON.stringify(thumb3));

  // sharp 不可用 → 降级不抛
  setSharpResolver(() => null);
  const thumb4 = await makeThumb(Buffer.from("raw"), "image/png");
  check("makeThumb：sharp 不可用返回空串（不抛）", thumb4 === "", JSON.stringify(thumb4));
  let largeThrew = false;
  try {
    await makeLarge(Buffer.from("raw"), "image/png", 1600);
  } catch {
    largeThrew = true;
  }
  check("makeLarge：sharp 不可用抛错（上层回 error）", largeThrew, "no throw");

  // 大图：先降质
  fakeCalls.length = 0;
  setSharpResolver(() => fakeSharp((s) => s.quality * 10000));
  const big2 = await makeLarge(Buffer.from("raw"), "image/png", 1600);
  check(
    "makeLarge：超预算自动降质且 ≤1MiB 预算",
    big2.data.startsWith("data:image/jpeg;base64,") && big2.data.length - "data:image/jpeg;base64,".length <= LARGE_MAX_BASE64,
    JSON.stringify(fakeCalls),
  );
  // 大图：只降质压不进去 → 降尺寸
  fakeCalls.length = 0;
  setSharpResolver(() => fakeSharp((s) => s.edge * 1000));
  const big3 = await makeLarge(Buffer.from("raw"), "image/png", 1600);
  check(
    "makeLarge：降质无用时降尺寸且 ≤1MiB 预算",
    big3.data.startsWith("data:image/jpeg;base64,") && big3.data.length - "data:image/jpeg;base64,".length <= LARGE_MAX_BASE64,
    JSON.stringify(fakeCalls),
  );
  // 大图：怎么都压不进去 → 抛错
  setSharpResolver(() => fakeSharp(() => 50_000_000));
  let largeThrew2 = false;
  try {
    await makeLarge(Buffer.from("raw"), "image/png", 1600);
  } catch {
    largeThrew2 = true;
  }
  check("makeLarge：实在压不进去抛错（上层回 error）", largeThrew2, "no throw");

  // maxEdge 归一化（缺省 1600、上限 4096）
  fakeCalls.length = 0;
  setSharpResolver(() => fakeSharp(() => 1000));
  await makeLarge(Buffer.from("raw"), "image/png", 999999);
  check("makeLarge：maxEdge 上限 4096", fakeCalls[0].edge === LARGE_MAX_EDGE, JSON.stringify(fakeCalls[0]));
  fakeCalls.length = 0;
  await makeLarge(Buffer.from("raw"), "image/png", undefined);
  check("makeLarge：maxEdge 缺省 1600", fakeCalls[0].edge === 1600, JSON.stringify(fakeCalls[0]));

  // --- 5./6. 桥接层：历史内联缩略图 + assistant.image 事件 + image.fetch ---
  const imgCalls = [];
  const attachments = {
    async readImage(ref) {
      imgCalls.push(ref.attachmentId);
      return { ref, data: Buffer.from("raw-image-bytes") };
    },
    imageHostPath() {
      return undefined;
    },
  };
  const imgEvents = [
    {
      type: "user/message",
      seq: 1,
      time: 100,
      surfaceOp: "append",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "看图" }, { type: "image", attachment: refA }] },
    },
  ];
  const imgRelay = makeRelay();
  const imgCtx = makeCtx({
    attachments,
    sessionController: {
      async inspect() { return { events: imgEvents }; },
      async page() { return { records: imgEvents.map((e) => ({ event: e })), hasMore: false }; },
      async list() { return { items: [] }; },
    },
  });
  const imgBridge = new HostBridge({
    ctx: imgCtx,
    relay: imgRelay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  imgBridge.attach();

  // 缩略图走假 sharp（可控体积）
  setSharpResolver(() => fakeSharp(() => 1000));

  await imgBridge.dispatch({ id: "img-hist", type: "session.history", ts: Date.now(), payload: { sessionId: "s-img" } });
  const hist = lastResult(imgRelay.sent, "img-hist");
  const hImg = hist?.value?.messages?.[0]?.images?.[0];
  check("session.history：消息带 images[] 且缩略图已内联", typeof hImg?.thumb === "string" && hImg.thumb.startsWith("data:image/jpeg;base64,"), JSON.stringify(hImg));
  check("session.history：缩略图 ≤96KB base64", (hImg?.thumb?.length ?? 0) - "data:image/jpeg;base64,".length <= THUMB_MAX_BASE64, String(hImg?.thumb?.length));
  check("session.history：正文没有 [图片] 占位符", !JSON.stringify(hist?.value?.messages).includes("[图片]"), JSON.stringify(hist?.value?.messages));

  // 整页缩略图预算：一页很多图时不能顶爆中继的 1MiB 帧
  const manyMessages = [];
  for (let i = 0; i < 5; i++) {
    const one = mapHistoryMessages("s", {
      event: { type: "user/message", seq: 100 + i, time: 1, surfaceOp: "append", data: { source: { kind: "user" }, content: [{ type: "image", attachment: { ...refA, attachmentId: "sha256:page" + i } }] } },
    })[0];
    manyMessages.push(one);
  }
  setSharpResolver(() => fakeSharp(() => 50_000)); // 每张 ~66KB base64（单张合格，但一页装不下）
  await attachThumbs(manyMessages, imgCtx, { budgetBytes: 100_000 });
  const inlined = manyMessages.filter((m) => m.images[0].thumb !== "").length;
  check("attachThumbs：整页预算用尽后只发元数据（不顶爆中继帧）", inlined === 1, JSON.stringify(inlined));
  check("attachThumbs：没有附件服务时不抛（只发元数据）", (await attachThumbs(manyMessages, makeCtx({}))).length === 5, "n/a");

  // image.fetch：非法 imageId
  await imgBridge.dispatch({ id: "img-bad", type: "image.fetch", ts: Date.now(), payload: { imageId: "" } });
  check("image.fetch：空 imageId 回 bad-params", lastResult(imgRelay.sent, "img-bad")?.error?.code === "bad-params", JSON.stringify(lastResult(imgRelay.sent, "img-bad")));

  // image.fetch：未知 imageId（插件重启后缓存为空）
  await imgBridge.dispatch({ id: "img-miss", type: "image.fetch", ts: Date.now(), payload: { imageId: "sha256:nope" } });
  const miss = lastResult(imgRelay.sent, "img-miss");
  check("image.fetch：未知 imageId 回 image-not-found 且文案明确", miss?.error?.code === "image-not-found" && String(miss?.error?.message).length > 0, JSON.stringify(miss));

  // image.fetch：命中已知图片
  const readsBefore = imgCalls.length;
  await imgBridge.dispatch({ id: "img-ok", type: "image.fetch", ts: Date.now(), payload: { imageId: "sha256:aaa" } });
  const ok = lastResult(imgRelay.sent, "img-ok");
  check(
    "image.fetch：回 {imageId,mediaType,width,height,data}",
    ok?.value?.imageId === "sha256:aaa" && ok?.value?.mediaType === "image/jpeg" &&
      typeof ok?.value?.width === "number" && typeof ok?.value?.height === "number" &&
      String(ok?.value?.data).startsWith("data:image/jpeg;base64,"),
    JSON.stringify({ ...ok?.value, data: String(ok?.value?.data).slice(0, 32) }),
  );
  check("image.fetch：大图 base64 ≤1MiB", String(ok?.value?.data).length <= 1024 * 1024, String(ok?.value?.data?.length));

  // image.fetch：同 (imageId,maxEdge) 命中缓存 → 不再读附件
  const readsAfter = imgCalls.length;
  await imgBridge.dispatch({ id: "img-ok2", type: "image.fetch", ts: Date.now(), payload: { imageId: "sha256:aaa" } });
  check("image.fetch：同 imageId+maxEdge 命中缓存（不再读附件）", imgCalls.length === readsAfter && readsAfter > readsBefore, JSON.stringify({ readsBefore, readsAfter, now: imgCalls.length }));

  // image.fetch：maxEdge 超上限 → 钳到 4096
  fakeCalls.length = 0;
  await imgBridge.dispatch({ id: "img-edge", type: "image.fetch", ts: Date.now(), payload: { imageId: "sha256:aaa", maxEdge: 999999 } });
  check("image.fetch：maxEdge 钳到 4096", fakeCalls[0]?.edge === LARGE_MAX_EDGE, JSON.stringify(fakeCalls[0]));

  // 直播：assistant/message 里的图片 → assistant.image 事件（带内联缩略图）
  imgRelay.sent.length = 0;
  imgCtx.emit("session/event", { id: "s-img" }, {
    type: "assistant/message",
    seq: 9,
    time: 200,
    surfaceOp: "append",
    data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "图来了" }, { type: "image", attachment: refB }] } },
  });
  await new Promise((r) => setTimeout(r, 30));
  const imgEventsOut = eventsOf(imgRelay.sent, "assistant.image");
  check(
    "assistant.image：直播推送且缩略图内联",
    imgEventsOut.length === 1 && imgEventsOut[0]?.sessionId === "s-img" &&
      imgEventsOut[0]?.image?.imageId === "sha256:bbb" &&
      String(imgEventsOut[0]?.image?.thumb).startsWith("data:image/jpeg;base64,"),
    JSON.stringify(imgEventsOut),
  );
  check("assistant.image：ImageRef 字段齐全", imgEventsOut[0]?.image?.mediaType === "image/jpeg" && imgEventsOut[0]?.image?.width === 20 && imgEventsOut[0]?.image?.height === 10 && imgEventsOut[0]?.image?.bytes === 42, JSON.stringify(imgEventsOut[0]?.image));
  check("assistant.image：附件引用不进 wire JSON", !JSON.stringify(imgEventsOut).includes("attachmentId"), JSON.stringify(imgEventsOut));

  // 日志里绝不出现 base64 / data URI
  const logBlob = logs.join("\n");
  check("日志不含 base64 / data URI", !logBlob.includes("base64") && !logBlob.includes("data:image"), "leak");

  imgBridge.dispose();
  setSharpResolver(null);
}

console.log("");
console.log(fail === 0 ? "VERIFY-STEPS RESULT: PASS (" + pass + " checks)" : "VERIFY-STEPS RESULT: FAIL (" + fail + "/" + (pass + fail) + ")");
process.exit(fail === 0 ? 0 : 1);
