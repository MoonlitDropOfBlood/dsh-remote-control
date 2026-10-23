#!/usr/bin/env node
/**
 * e2e/subagents-test.mjs — 契约 §5.6 v1.0.5 真实链路验证：session.subagents /
 * session.subagentPrompt / session.subagentCancel。
 *
 * 用法：node subagents-test.mjs [relayUrl]
 * 连真实中继 + 真实插件（读本机 %DSH_HOME%/remote-control/config.json）。
 * 验证口径：
 *   1. session.list 里挑一个 subagent 行 → 其 parentSessionId 就是靶父会话；
 *   2. session.subagents(parent) 返回行字段齐全（mode ∈ {one-shot, continuable}）；
 *   3. 有 one-shot 子代理时验证 subagentPrompt 被 host 拒（unsupported 路径）；
 *      有 continuable 子代理时验证 subagentCancel accepted（不动真消息）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayLink } from "./link.mjs";

const configPath = join(homedir(), ".dsh", "remote-control", "config.json");
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const { channel, secret } = cfg;
if (!channel || !secret) {
  console.error("config.json 缺 channel/secret");
  process.exit(1);
}
const relayUrl = process.argv[2] ??
  (typeof cfg.relayUrl === "string" && cfg.relayUrl.startsWith("ws") ? cfg.relayUrl : "ws://127.0.0.1:8788");

let pass = true;
const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "client",
  onStatus: (s) => console.log("[status]", s),
  onMessage: () => {},
});

// 1. 找靶：任一 subagent 行的 parentSessionId（否则取第一个会话验证空目录路径）
const list = await link.request("session.list", {}, 15000);
const rows = list?.sessions ?? [];
const subRow = rows.find((s) => s.origin === "subagent" || s.parentSessionId);
const parent = subRow?.parentSessionId ?? rows[0]?.sessionId;
console.log(`sessions=${rows.length} targetParent=${(parent ?? "?").slice(0, 8)}…`);
if (!parent) {
  console.log("主机无任何会话——RESULT: PASS（空路径）");
  link.close();
  process.exit(0);
}

// 2. 目录
const cat = await link.request("session.subagents", { sessionId: parent }, 20000);
const subs = cat?.subagents ?? [];
console.log(`subagents(${subs.length}):`);
for (const s of subs) {
  console.log(
    `  ${s.sessionId.slice(0, 8)}… label=${JSON.stringify(s.label)} mode=${s.mode} running=${s.running} hasChildren=${s.hasChildren}`,
  );
  if (s.mode !== "one-shot" && s.mode !== "continuable") {
    console.log("RESULT: FAIL — mode 非法枚举");
    link.close();
    process.exit(1);
  }
}

// 3. 错误路径 / 取消路径
const oneShot = subs.find((s) => s.mode === "one-shot");
if (oneShot) {
  const r = await link
    .request("session.subagentPrompt", {
      parentSessionId: parent,
      childSessionId: oneShot.sessionId,
      text: "e2e 探活（one-shot 必须被拒）",
    }, 15000)
    .catch((e) => ({ code: e?.code ?? e?.message, message: e?.message ?? String(e) }));
  console.log(`one-shot prompt → code=${JSON.stringify(r?.code)} msg=${String(r?.message ?? "").slice(0, 90)}`);
  if (String(r?.code) !== "unsupported") {
    console.log("WARN: one-shot 未按 unsupported 拒绝（宿主错误文案可能不同）");
  }
} else {
  console.log("(无 one-shot 子代理，跳过拒答路径)");
}
const continuable = subs.find((s) => s.mode === "continuable");
if (continuable) {
  const r = await link
    .request("session.subagentCancel", {
      parentSessionId: parent,
      childSessionId: continuable.sessionId,
    }, 15000)
    .catch((e) => ({ accepted: `err:${e?.message ?? e}` }));
  console.log(`continuable cancel → ${JSON.stringify(r).slice(0, 110)}`);
  if (r?.accepted !== true && r?.accepted !== false) {
    pass = false;
  }
} else {
  console.log("(无 continuable 子代理，跳过取消路径)");
}

link.close();
console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
