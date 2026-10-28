// tools/attach-session-to-workspace.mjs
// 把一个已有会话挂进工作区（成员资格补写）——宿主**没有**这个 API：
//   · `sc.create({workspaceId})` 只能在**新建**时归组；
//   · `insertSessionBefore` 只能重排**已在工作区内**的会话；
//   · 按 cwd 自动归账（bootstrap）只在注册表**首次初始化**跑一次。
// 所以历史会话（含手机端创建的）只能直接改注册表存储
// `%DSH_HOME%/storages/workspace.json`（纯 JSON）。
//
// ⚠️ 必须**先退出 DSH 桌面端**：运行中的宿主持有内存态，重启/写盘时会用内存态
//    覆盖我们改的文件。本脚本会检查 127.0.0.1:3080 是否可达，DSH 在跑就拒绝执行。
//
// 用法：
//   node tools/attach-session-to-workspace.mjs <sessionId> <workspacePath> [--dry-run]
// 例：
//   node tools/attach-session-to-workspace.mjs \
//     session-5f568d74-e158-438f-8152-ed62ddce627f "D:\ai-projects\dsh\dsh-remote-control"
//
// 为什么还要校验 cwd：宿主 `Workspace.entity.sessionIds` 的 getter 会按
// 「会话存储里的 cwd 是否等于工作区 path」过滤成员（`candidateMatches`），
// cwd 不匹配的成员会被静默过滤掉 —— 挂上了也看不见。
//
// 幂等：已在成员里就直接退出 0；写盘用「临时文件 + rename」原子替换，并先备份。

import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import net from "node:net";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [sessionId, workspacePath] = args.filter((a) => a !== "--dry-run");

if (!sessionId || !workspacePath) {
  console.error("用法: node tools/attach-session-to-workspace.mjs <sessionId> <workspacePath> [--dry-run]");
  process.exit(2);
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const storePath = join(dshHome, "storages", "workspace.json");
const projDir = join(dshHome, "storages", "session_projcache", "sessions");

/** DSH 桌面端在跑吗（3080 是它的 web 端口）——在跑就不能改存储。 */
function dshIsRunning() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 3080 });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1200, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** 归一化路径用于比较：统一分隔符、去掉尾部斜杠、忽略大小写。 */
function normalizePath(p) {
  return String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

if (!existsSync(storePath)) {
  console.error("找不到工作区存储:", storePath);
  process.exit(1);
}

// 应急开关：确知宿主没在跑（或只是想在沙箱里试）时可跳过检查。
const force = process.env.DSHRC_FORCE === "1";

if (!force && (await dshIsRunning())) {
  console.error(
    "DSH 桌面端正在运行（127.0.0.1:3080 可达）——**请先退出 DSH**再执行。\n" +
      "运行中的宿主会用内存态覆盖我们改的文件。\n" +
      "（确知宿主没在跑可设 DSHRC_FORCE=1 跳过此检查）",
  );
  process.exit(1);
}

const store = JSON.parse(readFileSync(storePath, "utf8"));
const workspaces = store?.tables?.workspaces ?? {};

// 1) 按 path 找工作区（路径完全一致才认）
const wanted = normalizePath(workspacePath);
const hit = Object.entries(workspaces).find(([, r]) => normalizePath(r.path ?? "") === wanted);
if (!hit) {
  console.error("没找到 path 完全匹配的工作区:", workspacePath);
  console.error("现有工作区：");
  for (const [id, r] of Object.entries(workspaces)) {
    console.error("  ", id.slice(0, 8), "|", r.path, "|", (r.sessionIds ?? []).length, "个会话");
  }
  process.exit(1);
}
const [wsId, wsRecord] = hit;

// 2) 校验会话的 cwd 必须等于工作区 path（否则成员会被宿主过滤掉）
const projPath = join(projDir, sessionId + ".json");
if (!existsSync(projPath)) {
  console.error("找不到该会话的投影缓存:", projPath);
  console.error("（sessionId 拼错，或该会话从未落盘）");
  process.exit(1);
}
const proj = JSON.parse(readFileSync(projPath, "utf8"));
const sessionCwd = proj?.record?.identity?.cwd ?? "";
if (normalizePath(sessionCwd) !== wanted) {
  console.error("会话 cwd 与工作区 path 不一致，宿主会把该成员过滤掉：");
  console.error("  会话 cwd :", sessionCwd);
  console.error("  工作区   :", wsRecord.path);
  process.exit(1);
}

// 3) 幂等写入
const members = Array.isArray(wsRecord.sessionIds) ? wsRecord.sessionIds : [];
if (members.includes(sessionId)) {
  console.log("已经在工作区里，无需改动:", wsId);
  process.exit(0);
}
const nextMembers = [sessionId, ...members];

if (dryRun) {
  console.log("[dry-run] 会写入：");
  console.log("  工作区 :", wsId, "|", wsRecord.path);
  console.log("  成员   :", nextMembers.length, "个（原", members.length, "）");
  console.log("  新增   :", sessionId);
  process.exit(0);
}

// 4) 备份 + 原子替换
const backup = storePath + ".bak-before-attach";
copyFileSync(storePath, backup);
workspaces[wsId] = { ...wsRecord, sessionIds: nextMembers };
store.tables.workspaces = workspaces;
const tmp = storePath + ".tmp-attach";
writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
renameSync(tmp, storePath);

console.log("已挂进工作区：");
console.log("  工作区 :", wsId, "|", wsRecord.path);
console.log("  成员   :", nextMembers.length, "个（原", members.length, "）");
console.log("  备份   :", backup);
console.log("");
console.log("现在可以重新打开 DSH 桌面端 —— 该会话应出现在该工作区分组下。");
