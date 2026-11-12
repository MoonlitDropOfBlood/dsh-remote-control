// e2e/mock-phone.mjs — 模拟手机端（client 角色）的命令行 REPL：
// 用于在没有真机的情况下测试中继与（模拟或真实的）DSH 插件端。
//
// 用法:
//   node mock-phone.mjs <relayUrl> <channel> <secret>
//   node mock-phone.mjs --loopback          （进程内回环 + 自带 mock host；不连中继）
//
// 命令: list | new [title] | prompt <sessionId> <text> | cancel <sessionId>
//       answer <askId> <approved|rejected> | quit
// v1.3.0（契约 §5.12/§5.13/§5.14）新增：
//       caps                        能力目录（含 todos/goal/pendingInteractions）
//       pending [sessionId]         待答恢复快照（live plugin pending + host continued）
//       todos <sessionId>           Todo 清单（null=暂无任务 / unsupported=不支持）
//       goal <sessionId>            Goal + activation + 可执行动作
//       goalact <sid> <action> [rev] [objective]
//                                  执行 Goal 人类操作（pause/resume/… 需带 revision）
//       queue <sessionId>           权威排队快照（空数组=清空）
//       subagents <sessionId>       子代理目录
//       demo                        打印 TODO/Goal/待答 摘要（演示用）
//       （--loopback 模式额外支持：todoset / queueadd / goalbump 直接操作 mock）
import readline from "node:readline";
import { RelayLink, createLoopbackPair } from "./link.mjs";
import { createMockHost } from "./mock-host.mjs";

const argv = process.argv.slice(2);
const loopbackMode = argv.includes("--loopback") || process.env.E2E_LOOPBACK_ONLY === "1";
const positional = argv.filter((x) => !x.startsWith("--"));
const [relayUrl, channel, secret] = positional;

if (!loopbackMode && (!relayUrl || !channel || !secret)) {
  console.error("usage: node mock-phone.mjs <relayUrl> <channel> <secret>");
  console.error("       node mock-phone.mjs --loopback   （进程内回环 + mock host 演示）");
  process.exit(1);
}

/** v1.3.0：事件的中文可读摘要（便于手机端联调时肉眼核对）。 */
function describeEvent(payload) {
  const d = payload?.data ?? {};
  switch (payload?.topic) {
    case "question.request":
      return `待答 ${d.askId} state=${d.state} answerable=${d.answerable} source=${d.source} callId=${d.callId ?? "-"} expiresAt=${d.expiresAt ?? "-"}`;
    case "question.resolved":
      return `已解决 ${d.askId} source=${d.source}`;
    case "approval.request":
      return `审批 ${d.askId} tool=${d.toolName}`;
    case "approval.resolved":
      return `审批结束 ${d.askId} decision=${d.decision}`;
    case "session.todosChanged":
      return `TODO 变化 ${d.sessionId} → ${d.todos === null ? "(空/null)" : d.todos.map((t) => `${t.status}:${t.content}`).join(" | ")}`;
    case "session.goalChanged":
      return `GOAL 变化 ${d.sessionId} op=${d.operation} → ${d.goal === null ? "(清除)" : `#${d.goal.revision} ${d.goal.phase} ${d.goal.objective}`}`;
    case "session.goalActivationChanged":
      return `GOAL 激活态 ${d.sessionId} #${d.revision} → ${d.activation}`;
    case "session.queue":
      return `排队 ${d.sessionId} → ${d.items.length === 0 ? "(空)" : d.items.map((i) => `${i.itemId}:${i.text}`).join(" | ")}`;
    default:
      return null;
  }
}

function onPlainMessage(m) {
  if (m.type === "event") {
    const described = describeEvent(m.payload);
    if (described !== null) {
      console.log("\n[phone] event:", m.payload?.topic, described);
      return;
    }
    const d = m.payload?.data ?? {};
    if (m.payload?.topic === "assistant.delta") {
      process.stdout.write(d.text ?? "");
      return;
    }
    console.log("\n[phone] event:", m.payload?.topic, JSON.stringify(d).slice(0, 200));
  } else {
    console.log("\n[phone] <-", m.type, JSON.stringify(m.payload ?? {}).slice(0, 200));
  }
}

/** @type {any} 客户端链路（RelayLink 或 LoopbackLink）。 */
let link = null;
/** @type {any} 进程内 mock host（仅 --loopback 模式）。 */
let mock = null;

if (loopbackMode) {
  // 进程内直连回环：自带 mock host，**不连中继、不占真实 channel**。
  const wire = { channel: "E2ELOOPBACKCHANEL", secret: "e2e-mock-phone-loopback-secret-0123456789" };
  const pair = createLoopbackPair({
    channel: wire.channel,
    secret: wire.secret,
    onHostMessage: (m) => {
      void mock.handle(m).catch((e) => console.log("\n[phone] mock error:", e?.message ?? e));
    },
    onClientMessage: (m) => onPlainMessage(m),
  });
  link = pair.client;
  mock = createMockHost({ link: pair.host, log: () => {} });
  mock.seedDemo();
  console.log("[phone] loopback 模式：进程内 mock host 已就绪（TODO/Goal/待答演示数据已预置）");
} else {
  link = new RelayLink({
    relayUrl,
    channel,
    secret,
    role: "client",
    onStatus: (s) => console.log("[phone] status:", s),
    onPeer: (joined, role) => console.log("[phone] peer", role, joined ? "joined" : "left"),
    onMessage: (m) => onPlainMessage(m),
  });
}

// 连接建立后先握手（v1.3.0：声明 session-state-v1 能力 → 插件按新语义发
// question.request{state:"continued"} 状态重发，见契约 §5.12 不变量 6）
setTimeout(() => {
  link
    .request(
      "hello",
      {
        proto: 1,
        clientName: "mock-phone",
        appVersion: "1.0.0",
        features: ["session-state-v1"],
      },
    )
    .then((v) => console.log("\n[phone] hello.ok:", JSON.stringify(v)))
    .catch((e) => console.log("\n[phone] hello failed:", e.message));
}, 500);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "phone> " });
rl.prompt();

/** 打印待答恢复快照（人眼可读）。 */
function printPending(value) {
  const questions = value?.questions ?? [];
  const approvals = value?.approvals ?? [];
  console.log(`待答问题 ${questions.length} 条 / 待审批 ${approvals.length} 条`);
  for (const q of questions) {
    console.log(
      `  · askId=${q.askId} session=${q.sessionId} state=${q.state} answerable=${q.answerable} source=${q.source}` +
        (q.callId ? ` callId=${q.callId}` : "") +
        (q.expiresAt ? ` expiresAt=${q.expiresAt}` : ""),
    );
    for (const question of q.questions ?? []) {
      const opts = (question.options ?? []).map((o) => o.label).join("/");
      console.log(`      ${question.id}: ${question.question}${opts ? "  [" + opts + "]" : ""}`);
    }
  }
  for (const a of approvals) {
    console.log(`  · [审批] askId=${a.askId} session=${a.sessionId} tool=${a.toolName} answerable=${a.answerable}`);
  }
}

// 命令串行执行：readline 会把管道里的多行**同步**喂进来，
// 若不串行，`quit` 会在前一个异步请求完成前就 process.exit（演示脚本会丢输出）。
let chain = Promise.resolve();

async function handleLine(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case "list":
        console.log(JSON.stringify(await link.request("session.list", {}), null, 2));
        break;
      case "new":
        console.log(JSON.stringify(await link.request("session.create", { title: rest.join(" ") || undefined })));
        break;
      case "prompt": {
        const sessionId = rest.shift();
        console.log(JSON.stringify(await link.request("session.prompt", { sessionId, text: rest.join(" ") })));
        break;
      }
      case "cancel":
        console.log(JSON.stringify(await link.request("session.cancel", { sessionId: rest[0] })));
        break;
      case "answer": {
        const [askId, decision] = rest;
        console.log(JSON.stringify(await link.request("approval.answer", { askId, decision }, 5000)));
        break;
      }
      // ---- v1.3.0 ----
      case "caps": {
        const caps = await link.request("session.capabilities", {});
        console.log(
          `todos=${JSON.stringify(caps?.todos)} goal=${JSON.stringify(caps?.goal)} pendingInteractions=${JSON.stringify(caps?.pendingInteractions)}`,
        );
        break;
      }
      case "pending": {
        const payload = rest[0] ? { sessionId: rest[0] } : {};
        printPending(await link.request("pending.interactions", payload, 5000));
        break;
      }
      case "todos": {
        const value = await link.request("session.todos", { sessionId: rest[0] }, 5000);
        console.log(
          `supported=${value?.supported} todos=` +
            (value?.todos === null ? "(null = 本回合暂无任务)" : JSON.stringify(value?.todos)),
        );
        break;
      }
      case "goal": {
        const value = await link.request("session.goal", { sessionId: rest[0] }, 5000);
        console.log(
          `supported=${value?.supported} activation=${value?.activation ?? "null"} goal=` +
            (value?.goal === null ? "(null = 无目标)" : JSON.stringify(value?.goal)),
        );
        console.log("可执行动作:", JSON.stringify(value?.actions ?? []));
        break;
      }
      case "goalact": {
        const [sessionId, action, revision, ...objectiveRest] = rest;
        const payload = { sessionId, action };
        if (action !== "create") {
          const current = await link.request("session.goal", { sessionId }, 5000);
          const expected =
            revision !== undefined
              ? { id: current?.goal?.id, revision: Number(revision) }
              : { id: current?.goal?.id, revision: current?.goal?.revision };
          payload.expected = expected;
        }
        if (objectiveRest.length > 0) payload.objective = objectiveRest.join(" ");
        try {
          console.log(JSON.stringify(await link.request("session.goalAction", payload, 5000)));
        } catch (e) {
          console.log("goalAction 失败:", String(e?.message ?? e));
        }
        break;
      }
      case "queue": {
        const value = await link.request("session.queue", { sessionId: rest[0] }, 5000);
        const items = value?.items ?? [];
        console.log(items.length === 0 ? "排队为空（客户端应清空排队列表）" : JSON.stringify(items, null, 2));
        break;
      }
      case "subagents": {
        const value = await link.request("session.subagents", { sessionId: rest[0] }, 5000);
        console.log(JSON.stringify(value?.subagents ?? [], null, 2));
        break;
      }
      case "demo": {
        // 一次性汇总：TODO / Goal / 待答恢复（演示 §5.12/§5.13/§5.14）
        const list = await link.request("session.list", {}, 5000);
        const sessions = list?.sessions ?? [];
        console.log("会话:", sessions.map((s) => `${s.sessionId}(${s.title})`).join(", "));
        const sid = rest[0] ?? sessions[0]?.sessionId;
        if (!sid) break;
        const caps = await link.request("session.capabilities", {}, 5000);
        console.log("能力: todos=" + JSON.stringify(caps?.todos) + " goal=" + JSON.stringify(caps?.goal));
        const todos = await link.request("session.todos", { sessionId: sid }, 5000);
        console.log(
          "TODO(supported=" + todos?.supported + "): " +
            (todos?.todos === null ? "(null = 本回合暂无任务)" : JSON.stringify(todos?.todos)),
        );
        const goal = await link.request("session.goal", { sessionId: sid }, 5000);
        console.log("GOAL: " + (goal?.goal === null ? "(null = 无目标)" : JSON.stringify(goal?.goal)));
        console.log("待答恢复快照:");
        printPending(await link.request("pending.interactions", { sessionId: sid }, 5000));
        break;
      }
      // ---- 仅 --loopback：直接操作进程内 mock（演示用，不新增线协议 type）----
      case "todoset": {
        if (!mock) {
          console.log("仅 --loopback 模式支持");
          break;
        }
        const [sessionId, ...contentParts] = rest;
        const status = contentParts.pop();
        const content = contentParts.join(" ");
        mock.setTodos(mock.sessions.get(sessionId), [{ content, status }]);
        console.log("mock TODO 已更新:", sessionId);
        break;
      }
      case "queueadd": {
        if (!mock) {
          console.log("仅 --loopback 模式支持");
          break;
        }
        const [sessionId, ...textParts] = rest;
        const itemId = mock.enqueue(mock.sessions.get(sessionId), { text: textParts.join(" ") });
        console.log("mock 队列已入队:", itemId);
        break;
      }
      case "goalbump": {
        if (!mock) {
          console.log("仅 --loopback 模式支持");
          break;
        }
        const sessionId = rest[0];
        console.log("mock goal revision →", JSON.stringify(mock.bumpGoalRevision(mock.sessions.get(sessionId))));
        break;
      }
      case "quit":
        link.close();
        process.exit(0);
        break;
      default:
        if (cmd) {
          console.log(
            "commands: list | new | prompt | cancel | answer | caps | pending | todos | goal | goalact | queue | subagents | demo | quit",
          );
        }
    }
  } catch (e) {
    console.log("error:", e.message);
  }
  rl.prompt();
}

rl.on("line", (line) => {
  chain = chain.then(() => handleLine(line)).catch((e) => console.log("error:", e?.message ?? e));
});
