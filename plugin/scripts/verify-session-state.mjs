// scripts/verify-session-state.mjs —— v1.3.0 排队/待答/Todo/Goal 自检
// （dev-only，无外部依赖）。
//
// 覆盖契约：
//   §5.1 session.queue 读 Host inbox 投影、按 itemId 空快照对账；
//   §5.2 question.request 重发/continued、todosChanged、goalChanged；
//   §5.12 pending.interactions、continued 补答；
//   §5.13 session.todos；§5.14 session.goal / goalAction / CAS。
//
// 用法：node scripts/verify-session-state.mjs（在 plugin/ 目录下）
import {
  HostBridge,
  mapHistoryMessages,
  mapTodoItems,
  mapGoalWire,
  mapWireQuestions,
  queueItemsFromInbox,
} from "../lib/host-bridge.mjs";

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
      const out = [];
      for (const fn of [...(handlers.get(name) ?? [])]) out.push(fn(...args));
      return Promise.allSettled(out);
    },
    get(name) {
      if (!Object.hasOwn(services, name)) throw new Error("service not found: " + name);
      return services[name];
    },
    services,
  };
}

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
  interceptApprovals: true,
  interceptQuestions: true,
  approvalTimeoutMs: 500,
  push: { notifyTurnEnd: false },
};

function makeBridge(ctx, relay, config = CFG) {
    return new HostBridge({
      ctx,
      relay,
      push: { configured: false, notify: async () => ({ ok: true }) },
      config,
      log,
      homeDir: "C:/fake-home",
      mkdir: async () => {},
    });
}

function lastResult(sent, id) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m.type === "result" && m.payload?.id === id) {
      return m.payload.ok ? { value: m.payload.value } : { error: m.payload.error };
    }
  }
  return null;
}

function eventsOf(sent, topic) {
  return sent
    .filter((m) => m.type === "event" && m.payload?.topic === topic)
    .map((m) => m.payload.data);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------
// 纯映射
// ---------------------------------------------------------------------------
check(
  "todo 映射只保留三态合法项",
  mapTodoItems([
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "completed" },
    { content: "bad", status: "unknown" },
    { content: "", status: "pending" },
  ]).length === 3,
);
check(
  "Host Question 映射不泄露 header/detail/intent",
  JSON.stringify(mapWireQuestions([
    {
      id: "q1",
      question: "Q",
      options: [{ label: "A", description: "d" }],
      header: "secret-header",
      detail: "secret-detail",
      intent: { kind: "plan-review", approve: "A" },
    },
  ])) === JSON.stringify([{ id: "q1", question: "Q", multiSelect: false, options: [{ label: "A", description: "d" }] }]),
);
check(
  "Goal 映射保留 blockedReason/rounds/activation",
  mapGoalWire(
    {
      id: "g1",
      revision: 2,
      objective: "obj",
      phase: "blocked",
      blockedReason: { code: "policy", message: "no" },
      maxGoalRounds: 8,
    },
    3,
    100,
    200,
    "disarmed",
  )?.blockedReason?.code === "policy",
);
check(
  "inbox 投影：没有文本的项不进队列，itemId 去重",
  queueItemsFromInbox({
    "next-turn": [
      { id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "queued" }] },
      { id: "m1", source: { kind: "user" }, content: [{ type: "text", text: "dupe" }] },
      { id: "m2", source: { kind: "agent" }, content: [{ type: "image" }] },
    ],
    "next-step": [],
  }).length === 1,
);

// ---------------------------------------------------------------------------
// 排队：无 rpcId 的子代理注入消息消费后出队；投影空快照覆盖旧缓存
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();

  ctx.emit(
    "session/event",
    { id: "sess-q" },
    {
      type: "agent/inbox/spliced",
      seq: 1,
      data: {
        target: "next-turn",
        start: 0,
        inserted: [
          { id: "m-inject", source: { kind: "user" }, content: [{ type: "text", text: "子代理注入任务" }] },
        ],
      },
    },
  );
  await tick();
  const q1 = eventsOf(relay.sent, "session.queue");
  check("排队：初始注入无 rpcId 也入队", q1.at(-1)?.items?.[0]?.itemId === "m-inject", JSON.stringify(q1.at(-1)));

  ctx.emit(
    "session/event",
    { id: "sess-q" },
    {
      type: "user/message",
      seq: 2,
      data: {
        id: "m-inject",
        source: { kind: "user" },
        content: [{ type: "text", text: "子代理注入任务" }],
      },
    },
  );
  await tick();
  const q2 = eventsOf(relay.sent, "session.queue");
  check("排队：无 rpcId 的注入消息按 itemId 出队", q2.at(-1)?.items?.length === 0, JSON.stringify(q2.at(-1)));

  // Host inbox 投影是权威：即使事件漏掉，拉取也必须清掉旧缓存。
  const values = { inbox: { "next-turn": [], "next-step": [] } };
  ctx.services.sessionController = {
    projections: async () => ({ kind: "sequenced", values }),
  };
  await bridge.dispatch({ id: "q-empty", type: "session.queue", payload: { sessionId: "sess-q" } });
  check(
    "排队：权威 inbox 空快照清空缓存",
    lastResult(relay.sent, "q-empty")?.value?.items?.length === 0,
    JSON.stringify(lastResult(relay.sent, "q-empty")),
  );
}

// ---------------------------------------------------------------------------
// 实时提问：快照恢复 + phone answer，askId 使用 Host callId
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay);
  bridge.attach();

  const requestPromise = ctx.emit(
    "user-questions/request",
    {
      questions: [{ id: "q1", question: "选一个", options: [{ label: "A" }] }],
      agent: { session: { id: "sess-q-live" } },
      signal: new AbortController().signal,
      wait: { callId: "call-q-live", timed: true },
    },
    async () => ({ answers: [{ id: "q1", selected: ["A"] }] }),
  );
  await tick();
  const req = eventsOf(relay.sent, "question.request").at(-1);
  check(
    "提问：timed callId 成为稳定 askId，并带 expiresAt",
    req?.askId === "call-q-live" && req?.callId === "call-q-live"
      && req?.state === "open" && req?.answerable === true
      && Number.isSafeInteger(req?.expiresAt),
    JSON.stringify(req),
  );

  await bridge.dispatch({ id: "p-snap", type: "pending.interactions", payload: { sessionId: "sess-q-live" } });
  check(
    "待答快照：恢复仍 open 的插件问题",
    lastResult(relay.sent, "p-snap")?.value?.questions?.[0]?.askId === "call-q-live",
    JSON.stringify(lastResult(relay.sent, "p-snap")),
  );

  await bridge.dispatch({
    id: "q-ans",
    type: "question.answer",
    payload: { askId: "call-q-live", answers: { q1: "A" } },
  });
  const settled = await requestPromise;
  check("提问：手机回答 applied", lastResult(relay.sent, "q-ans")?.value?.applied === true);
  check(
    "提问：回答后瀑布返回 Host 答案形状",
    settled[0]?.value?.answers?.[0]?.selected?.[0] === "A",
    JSON.stringify(settled),
  );
  check(
    "提问：回答后清卡事件",
    eventsOf(relay.sent, "question.resolved").at(-1)?.source === "phone",
    JSON.stringify(eventsOf(relay.sent, "question.resolved")),
  );
}

// ---------------------------------------------------------------------------
// Host continued：快照恢复 + ctx.userQuestions.answer 补答；不伪造消息
// ---------------------------------------------------------------------------
{
  const calls = [];
  const agent = { session: { id: "sess-cont" } };
  const projections = {
    values: {
      userQuestions: {
        active: [
          {
            callId: "call-cont",
            state: "continued",
            questions: [{ id: "q1", question: "继续？", options: [{ label: "是" }, { label: "否" }] }],
          },
        ],
      },
    },
  };
  const ctx = makeCtx({
    sessionController: {
      projections: async () => ({ kind: "sequenced", values: projections.values }),
      resolveAgent: async () => ({ agent }),
    },
    userQuestions: {
      answer: (a, callId, answer) => {
        calls.push({ agent: a, callId, answer });
        return true;
      },
    },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({
    id: "hello-cont",
    type: "hello",
    payload: { features: ["session-state-v1"] },
  });

  await bridge.dispatch({ id: "p-cont", type: "pending.interactions", payload: { sessionId: "sess-cont" } });
  const pending = lastResult(relay.sent, "p-cont")?.value?.questions?.[0];
  check(
    "continued 快照：state/answerable/source 正确",
    pending?.askId === "call-cont" && pending?.state === "continued"
      && pending?.answerable === true && pending?.source === "host",
    JSON.stringify(pending),
  );
  check(
    "continued 快照：重发 question.request",
    eventsOf(relay.sent, "question.request").at(-1)?.state === "continued",
    JSON.stringify(eventsOf(relay.sent, "question.request")),
  );

  await bridge.dispatch({
    id: "q-cont-ans",
    type: "question.answer",
    payload: { askId: "call-cont", answers: { q1: "是" }, freeText: "补充" },
  });
  check("continued：走 Host 官方 answer 并 applied", lastResult(relay.sent, "q-cont-ans")?.value?.applied === true);
  check(
    "continued：只经 Host 官方 answer，参数完整",
    calls.length === 1 && calls[0].callId === "call-cont"
      && calls[0].answer.answers.length === 1,
    JSON.stringify(calls),
  );
}

// ---------------------------------------------------------------------------
// legacy 模式：超时仍按 DSH/fail-open 语义交给桌面，不伪装 continued
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, approvalTimeoutMs: 60 });
  bridge.attach();
  await bridge.dispatch({
    id: "hello-legacy",
    type: "hello",
    payload: { features: ["session-state-v1"] },
  });
  const requestPromise = ctx.emit(
    "user-questions/request",
    {
      questions: [{ id: "q1", question: "legacy" }],
      agent: { session: { id: "sess-legacy" } },
      signal: new AbortController().signal,
    },
    async () => ({ answers: [{ id: "q1", selected: ["desktop"] }] }),
  );
  const settled = await requestPromise;
  await tick();
  check(
    "legacy：无 Host callId 时超时发 resolved 并交桌面",
    eventsOf(relay.sent, "question.resolved").at(-1)?.source === "timeout"
      && settled[0]?.value?.answers?.[0]?.selected?.[0] === "desktop",
    JSON.stringify({ events: eventsOf(relay.sent, "question.resolved"), settled }),
  );
}

// ---------------------------------------------------------------------------
// 旧 App 兼容：未声明 session-state-v1 不重发 continued 卡
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({
    sessionController: {
      projections: async () => ({
        kind: "sequenced",
        values: {
          userQuestions: {
            active: [{
              callId: "call-old",
              state: "continued",
              questions: [{ id: "q1", question: "旧客户端" }],
            }],
          },
        },
      }),
    },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "hello-old", type: "hello", payload: {} });
  await bridge.dispatch({ id: "p-old", type: "pending.interactions", payload: { sessionId: "sess-old" } });
  check(
    "新能力兜底：请求 pending.interactions 本身也会声明 session-state-v1",
    lastResult(relay.sent, "p-old")?.value?.questions?.[0]?.state === "continued"
      && eventsOf(relay.sent, "question.request").length === 1
      && eventsOf(relay.sent, "question.request")[0]?.state === "continued",
    JSON.stringify({ pull: lastResult(relay.sent, "p-old"), events: eventsOf(relay.sent, "question.request") }),
  );
}

// ---------------------------------------------------------------------------
// 桌面端已回答：投影消失 → 手机卡清掉
// ---------------------------------------------------------------------------
{
  let values = {
    userQuestions: {
      active: [{
        callId: "call-desktop",
        state: "continued",
        questions: [{ id: "q1", question: "桌面答" }],
      }],
    },
  };
  const ctx = makeCtx({
    sessionController: { projections: async () => ({ kind: "sequenced", values }) },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({
    id: "hello-desk",
    type: "hello",
    payload: { features: ["session-state-v1"] },
  });
  await bridge.dispatch({ id: "p-desk", type: "pending.interactions", payload: { sessionId: "sess-desk" } });
  values = { userQuestions: { active: [] } };
  ctx.emit(
    "session/event",
    { id: "sess-desk" },
    {
      type: "user/message",
      data: {
        id: "reply-desk",
        source: { kind: "user-question-reply", callId: "call-desktop" },
        content: [{ type: "text", text: "{}" }],
      },
    },
  );
  await tick();
  check(
    "桌面端回答后：投影对账清掉手机卡",
    eventsOf(relay.sent, "question.resolved").at(-1)?.askId === "call-desktop"
      && eventsOf(relay.sent, "question.resolved").at(-1)?.source === "desktop",
    JSON.stringify(eventsOf(relay.sent, "question.resolved")),
  );
}

// ---------------------------------------------------------------------------
// 已提交但未接纳的 continued 回答：暂时不恢复可编辑卡（防重复）
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({
    sessionController: {
      projections: async () => ({
        kind: "sequenced",
        values: {
          userQuestions: {
            active: [{
              callId: "call-queued",
              state: "continued",
              questions: [{ id: "q1", question: "已提交" }],
            }],
          },
          inbox: {
            "next-turn": [{
              id: "reply-queued",
              source: { kind: "user-question-reply", callId: "call-queued" },
              content: [{ type: "text", text: "{}" }],
            }],
            "next-step": [],
          },
        },
      }),
    },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "hello-q", type: "hello", payload: { features: ["session-state-v1"] } });
  await bridge.dispatch({ id: "p-q", type: "pending.interactions", payload: { sessionId: "sess-q" } });
  check(
    "待答快照：已排队 answer 的 continued 卡暂不恢复",
    lastResult(relay.sent, "p-q")?.value?.questions?.length === 0,
    JSON.stringify(lastResult(relay.sent, "p-q")),
  );
}

// ---------------------------------------------------------------------------
// Todo：supported 与 null 分开；事件覆盖/清空
// ---------------------------------------------------------------------------
{
  const values = { todos: [{ content: "写代码", status: "in_progress" }] };
  const ctx = makeCtx({
    sessionController: { projections: async () => ({ kind: "sequenced", values }) },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay);
  bridge.attach();

  await bridge.dispatch({ id: "todo-a", type: "session.todos", payload: { sessionId: "sess-todo" } });
  check(
    "todo：支持且返回三态项",
    lastResult(relay.sent, "todo-a")?.value?.todos?.[0]?.status === "in_progress",
    JSON.stringify(lastResult(relay.sent, "todo-a")),
  );

  const valuesNull = { todos: null };
  const ctx2 = makeCtx({
    sessionController: { projections: async () => ({ kind: "sequenced", values: valuesNull }) },
  });
  const relay2 = makeRelay();
  const bridge2 = makeBridge(ctx2, relay2);
  await bridge2.dispatch({ id: "todo-null", type: "session.todos", payload: { sessionId: "sess-todo" } });
  check(
    "todo：null 表示暂无清单而非不支持",
    lastResult(relay2.sent, "todo-null")?.value?.todos === null
      && lastResult(relay2.sent, "todo-null")?.value?.supported === true,
    JSON.stringify(lastResult(relay2.sent, "todo-null")),
  );

  const ctx3 = makeCtx({
    sessionController: { projections: async () => ({ kind: "sequenced", values: { modelSelection: {} } }) },
  });
  const relay3 = makeRelay();
  const bridge3 = makeBridge(ctx3, relay3);
  await bridge3.dispatch({ id: "todo-miss", type: "session.todos", payload: { sessionId: "sess-todo" } });
  check(
    "todo：缺 key => supported:false",
    lastResult(relay3.sent, "todo-miss")?.value?.supported === false,
    JSON.stringify(lastResult(relay3.sent, "todo-miss")),
  );
  ctx3.emit("session/event", { id: "sess-todo" }, { type: "turn/start", data: {} });
  await tick();
  check(
    "todo：无能力宿主不能因 turn/start 泄露 todosChanged",
    eventsOf(relay3.sent, "session.todosChanged").length === 0,
    JSON.stringify(eventsOf(relay3.sent, "session.todosChanged")),
  );

  ctx.emit(
    "session/event",
    { id: "sess-todo" },
    { type: "todo/write", data: { todos: [{ content: "完成", status: "completed" }] } },
  );
  await tick();
  check(
    "todo：todo/write 整表覆盖",
    eventsOf(relay.sent, "session.todosChanged").at(-1)?.todos?.[0]?.status === "completed",
    JSON.stringify(eventsOf(relay.sent, "session.todosChanged")),
  );
  ctx.emit("session/event", { id: "sess-todo" }, { type: "turn/start", data: {} });
  await tick();
  check(
    "todo：turn/start 清为 null",
    eventsOf(relay.sent, "session.todosChanged").at(-1)?.todos === null,
    JSON.stringify(eventsOf(relay.sent, "session.todosChanged")),
  );
}

// ---------------------------------------------------------------------------
// Goal：投影/activation、动作、CAS 错误
// ---------------------------------------------------------------------------
{
  let goalState = {
    goal: {
      id: "g-1",
      revision: 1,
      objective: "目标",
      phase: "active",
      maxGoalRounds: 5,
    },
    roundsStarted: 2,
    createdAt: 100,
    updatedAt: 100,
  };
  const agent = { session: { id: "sess-goal" } };
  const goals = {
    get: () => ({ ...goalState.goal, ...goalState, activation: "armed" }),
    pause: (_agent, ref) => {
      if (ref.revision !== goalState.goal.revision) {
        const e = new Error("stale");
        e.code = "GOAL_STALE_REVISION";
        throw e;
      }
      goalState = { ...goalState, goal: { ...goalState.goal, revision: 2, phase: "paused" }, updatedAt: 200 };
      return { ...goalState.goal };
    },
    resume: async () => {},
    edit: async () => {},
    complete: async () => {},
    clear: async () => {},
    create: async () => {},
      };
  const ctx = makeCtx({
    sessionController: {
      projections: async () => ({ kind: "sequenced", values: { goal: goalState } }),
      resolveAgent: async () => ({ agent }),
    },
    agents: { get: () => agent },
    goals,
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay);
  bridge.attach();

  await bridge.dispatch({ id: "goal-get", type: "session.goal", payload: { sessionId: "sess-goal" } });
  const gv = lastResult(relay.sent, "goal-get")?.value;
  check(
    "goal：读投影+activation+actions",
    gv?.goal?.phase === "active" && gv?.activation === "armed"
      && Array.isArray(gv?.actions) && gv.actions.includes("pause"),
    JSON.stringify(gv),
  );

  await bridge.dispatch({
    id: "goal-pause",
    type: "session.goalAction",
    payload: { sessionId: "sess-goal", action: "pause", expected: { id: "g-1", revision: 1 } },
  });
  check(
    "goal：pause 成功并回最新 revision",
    lastResult(relay.sent, "goal-pause")?.value?.goal?.phase === "paused"
      && lastResult(relay.sent, "goal-pause")?.value?.goal?.revision === 2,
    JSON.stringify(lastResult(relay.sent, "goal-pause")),
  );

  await bridge.dispatch({
    id: "goal-stale",
    type: "session.goalAction",
    payload: { sessionId: "sess-goal", action: "pause", expected: { id: "g-1", revision: 1 } },
  });
  check(
    "goal：陈旧 revision 原样回 GOAL_STALE_REVISION",
    lastResult(relay.sent, "goal-stale")?.error?.code === "GOAL_STALE_REVISION",
    JSON.stringify(lastResult(relay.sent, "goal-stale")),
  );

  await bridge.dispatch({
    id: "goal-bad",
    type: "session.goalAction",
    payload: { sessionId: "sess-goal", action: "pause" },
  });
  check(
    "goal：非 create 缺 expected 回 bad-params",
    lastResult(relay.sent, "goal-bad")?.error?.code === "bad-params",
    JSON.stringify(lastResult(relay.sent, "goal-bad")),
  );
}

// ---------------------------------------------------------------------------
// 能力目录
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "caps", type: "session.capabilities", payload: {} });
  const caps = lastResult(relay.sent, "caps")?.value;
  check(
    "capabilities：todos/goal/pendingInteractions 出现",
    caps?.todos?.supported === true && caps?.goal?.read === true
      && caps?.pendingInteractions?.questions === true,
    JSON.stringify(caps),
  );
}

// ---------------------------------------------------------------------------
// v1.3.1：唤醒消息（Goal 轮次提示）不再被丢弃 + 轮次推进广播 + 队列不残留
// ---------------------------------------------------------------------------

// ① 历史映射：goal 唤醒消息 → trigger=goal、隐藏注入正文；未知来源仍跳过。
{
  const goalMsg = mapHistoryMessages("sess-g", {
    type: "user/message",
    seq: 41,
    time: 1760000000000,
    surfaceOp: "append",
    data: {
      id: "round-6",
      source: { kind: "goal", goalId: "goal-1", revision: 3, round: 6 },
      content: [{ type: "text", text: "<goal_round>Objective</goal_round>" }],
    },
  });
  check(
    "goal 唤醒消息成条并带 trigger=goal",
    goalMsg.length === 1 && goalMsg[0].role === "user" && goalMsg[0].trigger === "goal",
    JSON.stringify(goalMsg),
  );
  check("goal 唤醒消息隐藏注入的原始正文", goalMsg[0].text === "", JSON.stringify(goalMsg[0].text));
  check("goal 唤醒消息保留 seq（参与合并排序）", goalMsg[0].seq === 41, String(goalMsg[0].seq));

  const unknown = mapHistoryMessages("sess-g", {
    type: "user/message",
    seq: 42,
    time: 1760000000000,
    surfaceOp: "append",
    data: { id: "x", source: { kind: "unknown-kind" }, content: [{ type: "text", text: "x" }] },
  });
  check("未知唤醒来源仍然跳过（不臆造消息）", unknown.length === 0, JSON.stringify(unknown));

  const normal = mapHistoryMessages("sess-g", {
    type: "user/message",
    seq: 43,
    time: 1760000000000,
    surfaceOp: "append",
    data: { id: "u1", source: { kind: "user", rpcId: "r" }, content: [{ type: "text", text: "手打" }] },
  });
  check(
    "用户手打消息不带 trigger",
    normal.length === 1 && normal[0].trigger === undefined,
    JSON.stringify(normal),
  );
}

// ② 轮次推进：Host 不发 goal/change，插件必须补广播 session.goalChanged(operation=round)。
{
  let values = {
    goal: {
      goal: { id: "goal-1", revision: 3, objective: "目标", phase: "active", maxGoalRounds: 12 },
      roundsStarted: 5,
      createdAt: 1,
      updatedAt: 2,
    },
  };
  const ctx = makeCtx({
    sessionController: { projections: async () => ({ kind: "sequenced", values }) },
  });
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "hello-round", type: "hello", payload: { features: ["session-state-v1"] } });
  values = {
    goal: {
      goal: { id: "goal-1", revision: 3, objective: "目标", phase: "active", maxGoalRounds: 12 },
      roundsStarted: 6,
      createdAt: 1,
      updatedAt: 2,
    },
  };
  ctx.emit(
    "session/event",
    { id: "sess-round" },
    {
      type: "user/message",
      data: { id: "round-6", source: { kind: "goal", round: 6 }, content: [{ type: "text", text: "<goal_round/>" }] },
    },
  );
  await tick();
  const changed = eventsOf(relay.sent, "session.goalChanged").at(-1);
  check(
    "轮次推进补广播 session.goalChanged(operation=round)",
    changed?.operation === "round" && changed?.goal?.roundsStarted === 6,
    JSON.stringify(changed),
  );
}

// ③ 队列残留：goal 轮次提示**不进**手机待执行列表；真人输入进队、消费后必须出队。
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "hello-q", type: "hello", payload: { features: ["session-state-v1"] } });
  const twice = async (target, inserted) => {
    ctx.emit("session/event", { id: "sess-q" }, {
      type: "agent/inbox/spliced",
      data: { target, start: 0, removedCount: 0, inserted },
    });
    await tick();
  };
  // goal 轮次提示（宿主自动注入）——不进队列
  await twice("next-turn", [
    { id: "round-7", source: { kind: "goal", round: 7 }, content: [{ type: "text", text: "<goal_round/>" }] },
  ]);
  // 真人输入——进队列
  await twice("next-turn", [
    { id: "msg-a", source: { kind: "user", rpcId: "req-a" }, content: [{ type: "text", text: "排队 A" }] },
  ]);
  const queued = eventsOf(relay.sent, "session.queue").at(-1);
  check(
    "goal 轮次提示不进手机待执行列表（真人输入才进）",
    Array.isArray(queued?.items) &&
      queued.items.length === 1 &&
      queued.items[0].itemId === "msg-a",
    JSON.stringify(queued),
  );
  // 消费（Host 写入 user/message，身份 = 同一 id）→ 出队
  ctx.emit("session/event", { id: "sess-q" }, {
    type: "user/message",
    data: { id: "msg-a", source: { kind: "user", rpcId: "req-a" }, content: [{ type: "text", text: "排队 A" }] },
  });
  await tick();
  const after = eventsOf(relay.sent, "session.queue").at(-1);
  check(
    "被消费后队列清空（按 Host 消息 id 出队，不残留）",
    Array.isArray(after?.items) && after.items.length === 0,
    JSON.stringify(after),
  );
}

// ④ 子代理两类注入：初始提示（kind=user、无 rpcId）进队且能出队；
//    完成唤醒（kind=subagent-settled）不进队、按触发卡表达。
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = makeBridge(ctx, relay, { ...CFG, interceptQuestions: false });
  bridge.attach();
  await bridge.dispatch({ id: "hello-sub", type: "hello", payload: { features: ["session-state-v1"] } });
  const splice = async (inserted) => {
    ctx.emit("session/event", { id: "sess-sub" }, {
      type: "agent/inbox/spliced",
      data: { target: "next-turn", start: 0, removedCount: 0, inserted },
    });
    await tick();
  };
  // 子代理初始注入：source.kind='user' 但没有 rpcId（v1.3.0 之前永久残留的那一类）
  await splice([
    { id: "sub-init", source: { kind: "user" }, content: [{ type: "text", text: "子代理任务" }] },
  ]);
  const queued = eventsOf(relay.sent, "session.queue").at(-1);
  check(
    "子代理初始注入（kind=user 无 rpcId）照样进队",
    queued?.items?.some((it) => it.itemId === "sub-init"),
    JSON.stringify(queued),
  );
  ctx.emit("session/event", { id: "sess-sub" }, {
    type: "user/message",
    data: { id: "sub-init", source: { kind: "user" }, content: [{ type: "text", text: "子代理任务" }] },
  });
  await tick();
  const afterInit = eventsOf(relay.sent, "session.queue").at(-1);
  check(
    "子代理初始注入被消费后出队（按 id，不残留）",
    Array.isArray(afterInit?.items) && afterInit.items.length === 0,
    JSON.stringify(afterInit),
  );
  // 子代理完成唤醒：不是用户输入 → 不进队
  await splice([
    {
      id: "sub-done",
      source: { kind: "subagent-settled", childSessionId: "child-1" },
      content: [{ type: "text", text: "子代理已完成" }],
    },
  ]);
  const afterDone = eventsOf(relay.sent, "session.queue").at(-1);
  check(
    "子代理完成唤醒不进待执行列表",
    Array.isArray(afterDone?.items) && afterDone.items.length === 0,
    JSON.stringify(afterDone),
  );
  const doneMsg = mapHistoryMessages("sess-sub", {
    type: "user/message",
    seq: 51,
    time: 1760000000000,
    surfaceOp: "append",
    data: {
      id: "sub-done",
      source: { kind: "subagent-settled", childSessionId: "child-1" },
      content: [{ type: "text", text: "子代理已完成" }],
    },
  });
  check(
    "子代理完成消息映射成 trigger=subagent 触发卡",
    doneMsg.length === 1 && doneMsg[0].trigger === "subagent" && doneMsg[0].text === "",
    JSON.stringify(doneMsg),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
