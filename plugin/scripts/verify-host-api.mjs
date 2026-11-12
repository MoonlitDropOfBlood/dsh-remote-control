// scripts/verify-host-api.mjs —— 插件对**真实 DSH 宿主 API** 的假设自检（dev-only）。
//
// 为什么需要这个门禁：
//   v1.3.0 的排队/待答/Todo/Goal 全靠插件直连宿主的投影与服务
//   （values.inbox / values.todos / values.goal / values.userQuestions.active
//     + ctx.goals / ctx.userQuestions.answer）。
//   这些形状在 **mock host 上验证不了**——mock 是我们自己按契约写的实现，
//   写错了两边一起错，测不出「插件假设的宿主形状其实变了」。
//   本门禁直接读**本机真实安装的 DSH 宿主包源码**，把插件依赖的形状钉死：
//   DSH 升级改了投影 key / 字段名 / 服务方法签名 / CAS ref → 这里立刻红。
//
// 运行：node scripts/verify-host-api.mjs（在 plugin/ 目录下）
//   · 找不到本机 DSH 运行时 → 打印 SKIP 并以 0 退出（CI 无宿主也绿）。
//   · 指定运行时：DSH_RUNTIME="<...>/dsh/node_modules" node scripts/verify-host-api.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

/** 定位本机 DSH 运行时的 node_modules（找不到就 null）。 */
function findRuntime() {
  const candidates = [];
  if (process.env.DSH_RUNTIME) candidates.push(process.env.DSH_RUNTIME);
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  candidates.push(join(appData, "DeepSeek Harness Desktop", "dsh", "node_modules"));
  candidates.push(join(appData, "DeepSeek Harness", "dsh", "node_modules"));
  for (const c of candidates) {
    const pkg = join(c, "@deepseek-ai");
    if (existsSync(pkg)) return { root: c, pkg };
  }
  return null;
}

const runtime = findRuntime();
if (runtime === null) {
  console.log("SKIP: 本机未找到 DSH 运行时（设置 DSH_RUNTIME=<...>/dsh/node_modules 可强制检查）");
  process.exit(0);
}

/** 读宿主包的主实现文件（lib/index.js 或 lib/index.cjs）。 */
function hostSource(pkgName) {
  const base = join(runtime.pkg, pkgName, "lib");
  for (const f of ["index.js", "index.cjs", "index.mjs"]) {
    const p = join(base, f);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

/** 宿主包版本（用于报告本次核对的到底是哪一版宿主）。 */
function hostVersion(pkgName) {
  const p = join(runtime.pkg, pkgName, "package.json");
  if (!existsSync(p)) return "?";
  try {
    return JSON.parse(readFileSync(p, "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

const goal = hostSource("dsh-goal");
const todo = hostSource("dsh-tool-todo");
const userQuestions = hostSource("dsh-user-questions");
const agentLoop = hostSource("dsh-agent-loop");

check("宿主安装里有 dsh-goal", goal !== null);
check("宿主安装里有 dsh-tool-todo", todo !== null);
check("宿主安装里有 dsh-user-questions", userQuestions !== null);
check("宿主安装里有 dsh-agent-loop", agentLoop !== null);

// ---- Goal：投影 key/state + 服务方法 + CAS ref + 错误码 ----------------------
if (goal !== null) {
  check("goal 投影 key = \"goal\"", /key:\s*"goal"/.test(goal));
  check(
    "goal 投影视图含 goal/roundsStarted/createdAt/updatedAt",
    /goal:\s*\{\s*\.\.\.state\.goal\s*\}/.test(goal) && /roundsStarted:\s*state\.roundsStarted/.test(goal),
  );
  check("goal 持久状态键 = id/revision/objective/phase/maxGoalRounds",
    /"id,maxGoalRounds,objective,phase,revision"/.test(goal));
  check("blocked 状态额外带 blockedReason{code,message}",
    /blockedReason,\s*id,\s*maxGoalRounds/.test(goal) &&
      /code,\s*message/.test(goal));
  for (const m of ["get", "create", "edit", "pause", "resume", "complete", "clear"]) {
    check("goals 服务有 " + m + "()", new RegExp("\\b" + m + "\\(agent,").test(goal) || new RegExp("\\b" + m + "\\(agent\\)").test(goal));
  }
  check("CAS 引用按 {id, revision} 比对",
    /ref\.id\s*!==\s*current\.id\s*\|\|\s*ref\.revision\s*!==\s*current\.revision/.test(goal));
  check("陈旧引用错误码 = GOAL_STALE_REVISION", /GOAL_STALE_REVISION/.test(goal));
  check("goal 服务按 live agent 身份校验（assertLive）", /assertLive\(agent\)/.test(goal));
  check("activation 是进程内状态（view 里带 activation）",
    /activation:\s*runtime\.activation/.test(goal));
}

// ---- Todo：投影 key/schema + 事件语义 ----------------------------------------
if (todo !== null) {
  check("todo 投影 key = \"todos\"", /key:\s*"todos"/.test(todo));
  check("todo 形状 = [{content, status}]",
    /content:\s*z\$?1?\.?string\(\)/.test(todo) || /content:\s*z\.string\(\)/.test(todo));
  check("todo 三态 = pending/in_progress/completed",
    /"pending"/.test(todo) && /"in_progress"/.test(todo) && /"completed"/.test(todo));
  check("todo 投影可为 null（turn/start 清空）",
    /z\$?1?\.?union\(\[\s*z\$?1?\.?array/.test(todo) || /union\(\[\s*z\.array/.test(todo));
  check("todo/write 整表覆盖", /event\.type === "todo\/write"\s*\)\s*return event\.data\.todos/.test(todo));
  check("turn/start 把清单清成 null", /event\.type === "turn\/start"\s*\)\s*return null/.test(todo));
}

// ---- userQuestions：投影 active[] + answer(agent, callId, {answers}) ---------
if (userQuestions !== null) {
  check("userQuestions 投影 key = \"userQuestions\"", /key:\s*"userQuestions"/.test(userQuestions));
  check("active 项含 callId/questions/state",
    /callId:\s*z/.test(userQuestions) && /questions:\s*z/.test(userQuestions) &&
      /state:\s*z/.test(userQuestions));
  check("question 状态含 open/continued", /"open"/.test(userQuestions) && /"continued"/.test(userQuestions));
  check("答案形状 = {id, selected[], custom?}",
    /id:\s*z/.test(userQuestions) && /selected:\s*z/.test(userQuestions) &&
      /custom:\s*z/.test(userQuestions));
  check("answer(agent, callId, answer) 签名",
    /answer\(agent,\s*callId,\s*answer\)/.test(userQuestions));
  check("answer 必须逐题点名（answers 数组）",
    /answer\.answers\.map\(\(item\)\s*=>\s*item\.id\)/.test(userQuestions));
  check("只允许答 continued 问题", /this\.continued\(agent\)\.find/.test(userQuestions));
}

// ---- inbox：排队权威投影 ---------------------------------------------------
if (agentLoop !== null) {
  check("inbox 投影 key = \"inbox\"", /key:\s*"inbox"/.test(agentLoop));
  check("inbox 视图含 next-turn / next-step",
    /"next-turn":/.test(agentLoop) && /"next-step":/.test(agentLoop));
  check("inbox 由 agent/inbox/spliced 折叠", /event\.type !== "agent\/inbox\/spliced"\s*\)\s*return state/.test(agentLoop));
}

console.log(`verify-host-api: ${pass} passed, ${fail} failed (runtime=${runtime.root})`);
console.log(
  "宿主包版本：dsh-goal=" +
    hostVersion("dsh-goal") +
    " dsh-tool-todo=" +
    hostVersion("dsh-tool-todo") +
    " dsh-user-questions=" +
    hostVersion("dsh-user-questions") +
    " dsh-agent-loop=" +
    hostVersion("dsh-agent-loop"),
);
if (fail > 0) process.exit(1);
