// e2e/history-test.mjs — 对【真实 DSH 插件】验证契约 §5.1 session.history（v1.0.4）：
// 读取本机插件配置（~/.dsh/remote-control/config.json）作为手机端配对信息，
// 连接中继 → hello → session.list（顺带校验 §5.3 v1.0.4 三字段透传）
// → 对真实会话拉一页 session.history → 断言 messages 非空、ChatMessage 字段齐全；
//   hasMore 时用 oldestSeq 向前翻一页，断言无 seq 重叠且向更老方向推进。
// 用法: node history-test.mjs [relayUrl]   （默认取插件配置的 relayUrl）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayLink } from "./link.mjs";

const cfg = JSON.parse(
  readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "remote-control", "config.json"), "utf8"),
);
const relayUrl = process.argv[2] ?? cfg.relayUrl ?? "ws://127.0.0.1:8787";
const { channel, secret } = cfg;
if (!channel || !secret) {
  console.error("FAIL: plugin config missing channel/secret");
  process.exit(1);
}
console.log("pairing: relay=%s channel=%s secret=<%d chars>", relayUrl, channel, secret.length);

let t0 = setTimeout(() => fail("no welcome within 10s (relay not reached?)"), 10000);
const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "client",
  onStatus: (s) => {
    console.log("[status]", s);
    if (s === "ready") clearTimeout(t0);
  },
  onMessage: () => {
    /* 本测试只关心请求-响应；事件不参与断言 */
  },
});

const fail = (msg) => {
  console.error("FAIL:", msg);
  link.close();
  process.exit(1);
};

/** ChatMessage 字段齐全性（契约 §5.1 v1.0.4）。 */
function assertMessage(m, where) {
  if (typeof m?.id !== "string" || m.id === "") fail(where + ": id missing");
  if (m.role !== "user" && m.role !== "assistant") fail(where + ": bad role " + JSON.stringify(m.role));
  if (typeof m.text !== "string" || m.text.trim() === "") fail(where + ": empty text");
  if (typeof m.ts !== "number") fail(where + ": ts missing");
  if (!Number.isSafeInteger(m.seq) || m.seq < 0) fail(where + ": bad seq " + JSON.stringify(m.seq));
}

try {
  // 1. hello
  const hello = await link.request("hello", { proto: 1, clientName: "history-test", appVersion: "1.0.0" }, 15000);
  console.log("hello.ok:", JSON.stringify(hello));
  if (!hello || typeof hello !== "object") fail("hello response malformed");

  // 2. session.list —— 顺带校验 §5.3 v1.0.4 三字段透传（缺陷 1）
  const list = await link.request("session.list", {}, 15000);
  const items = list?.sessions ?? list?.items;
  if (!Array.isArray(items)) fail("session.list malformed: " + JSON.stringify(list).slice(0, 200));
  console.log("session.list: %d sessions", items.length);
  for (const s of items) {
    if (typeof s.blank !== "boolean") fail("session.summary missing blank: " + JSON.stringify(s).slice(0, 120));
    if (typeof s.origin !== "string") fail("session.summary missing origin: " + JSON.stringify(s).slice(0, 120));
    if (typeof s.parentSessionId !== "string") fail("session.summary missing parentSessionId");
  }
  const subs = items.filter((s) => s.origin === "subagent" || s.parentSessionId !== "");
  const blanks = items.filter((s) => s.blank === true);
  console.log("summary fields ok (v1.0.4): subagent=%d blank=%d", subs.length, blanks.length);

  // 3. 选一个真实非 blank 会话拉历史（按 updatedAt 最新优先，最多尝试 5 个）
  const candidates = items
    .filter((s) => s.blank !== true)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5);
  if (candidates.length === 0) fail("no non-blank session to test history against");

  let page = null;
  let picked = null;
  for (const s of candidates) {
    try {
      const v = await link.request("session.history", { sessionId: s.sessionId, maxMessages: 10 }, 30000);
      console.log("session.history[%s] title=%s → %d messages hasMore=%s oldestSeq=%s",
        s.sessionId, JSON.stringify((s.title || "").slice(0, 24)),
        v?.messages?.length ?? -1, v?.hasMore, v?.oldestSeq);
      if (Array.isArray(v?.messages) && v.messages.length > 0) {
        page = v;
        picked = s;
        break;
      }
    } catch (e) {
      if (String(e.message).includes("bad-type")) {
        fail("plugin does not implement session.history yet (remove+install the plugin first): " + e.message);
      }
      console.log("  (skip %s: %s)", s.sessionId, e.message);
    }
  }
  if (page === null) fail("no session returned a non-empty history page (tried " + candidates.length + ")");

  // 4. 断言本页字段齐全 + 样例输出
  for (let i = 0; i < page.messages.length; i++) assertMessage(page.messages[i], "messages[" + i + "]");
  if (typeof page.hasMore !== "boolean") fail("hasMore missing");
  if (!Number.isSafeInteger(page.oldestSeq) || page.oldestSeq < 0) fail("bad oldestSeq " + JSON.stringify(page.oldestSeq));
  console.log("sample messages (truncated):");
  for (const m of page.messages.slice(-4)) {
    console.log("  seq=%d role=%s ts=%d id=%s text=%s", m.seq, m.role, m.ts, m.id, JSON.stringify(m.text.slice(0, 60)));
  }

  // 5. 向前翻页（hasMore 时）：无 seq 重叠、且整体向更老方向推进
  if (page.hasMore) {
    const v2 = await link.request("session.history",
      { sessionId: picked.sessionId, beforeSeq: page.oldestSeq, maxMessages: 10 }, 30000);
    if (!Array.isArray(v2?.messages)) fail("page2 malformed");
    const page1Seqs = new Set(page.messages.map((m) => m.seq));
    for (const m of v2.messages) {
      if (page1Seqs.has(m.seq)) fail("page2 overlaps page1 at seq=" + m.seq);
      assertMessage(m, "page2");
      if (m.seq >= page.oldestSeq) fail("page2 not older: seq=" + m.seq + " >= oldestSeq=" + page.oldestSeq);
    }
    console.log("page2: %d messages, oldestSeq=%s (backward paging ok)", v2.messages.length, v2.oldestSeq);
  } else {
    console.log("hasMore=false（该会话一页到底，跳过翻页断言）");
  }

  console.log("HISTORY TEST RESULT: PASS");
  link.close();
  process.exit(0);
} catch (e) {
  fail(e?.message ?? String(e));
}
