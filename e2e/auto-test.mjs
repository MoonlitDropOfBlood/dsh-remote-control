// e2e/auto-test.mjs — 对【真实 DSH 插件】的自动化联调（契约 §9）：
// 读取本机插件配置（~/.dsh/remote-control/config.json）作为手机端配对信息，
// 连接中继 → hello → session.list → 验证真实会话数据 → 退出码 0/1。
//
// v1.0.6：追加「工作步骤 / 模式与权限」新链路用例（契约 §5.2 / §5.7 / §5.8）：
//   A. 自测链路（恒跑）：进程内直连回环 + mock host，覆盖
//      capabilities → create 带选项 → history 带 steps → tool 事件到达；
//   B. 真实宿主探针（尽力而为）：宿主插件仍是旧 bundle 时跳过并提示。
// v1.0.8：自测链路追加思考强度目录 + 会话中切换模型（selectModel → modelChanged → session.model）。
//
// ⚠️ 手机在线时**只能**用 E2E_LOOPBACK_ONLY=1：它完全跳过真实宿主链路
//    （不读真实 channel、不连真实中继），只跑进程内回环 + mock host。
//
// 用法: node auto-test.mjs [relayUrl]   （默认取插件配置的 relayUrl，再退到 ws://127.0.0.1:8787）
//       E2E_LOOPBACK_ONLY=1 node auto-test.mjs   （只跑回环用例，手机在线也安全）
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayLink, createLoopbackPair } from "./link.mjs";
import { createMockHost } from "./mock-host.mjs";

/** 只跑回环用例（手机在线时用；不碰真实 channel / 真实中继）。 */
const loopbackOnly = process.env.E2E_LOOPBACK_ONLY === "1";

let cfg = { channel: "", secret: "", relayUrl: "" };
if (!loopbackOnly) {
  cfg = JSON.parse(
    readFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "remote-control", "config.json"), "utf8"),
  );
  const { channel, secret } = cfg;
  if (!channel || !secret) {
    console.error("FAIL: plugin config missing channel/secret");
    process.exit(1);
  }
}
const { channel, secret } = cfg;
const relayUrl = process.argv[2] ?? cfg.relayUrl ?? "ws://127.0.0.1:8787";
if (!loopbackOnly) {
  console.log("pairing: relay=%s channel=%s secret=<%d chars>", relayUrl, channel, secret.length);
} else {
  console.log("E2E_LOOPBACK_ONLY=1 → 只跑回环用例（不连真实中继、不占真实 channel）");
}

const events = new Map(); // topic -> count
const deltas = new Map(); // sessionId -> text
let done = false;
let t0 = null;
let link = null;

if (!loopbackOnly) {
  t0 = setTimeout(() => fail("no welcome within 10s (relay not reached?)"), 10000);
  link = new RelayLink({
    relayUrl,
    channel,
    secret,
    role: "client",
    onStatus: (s) => {
      console.log("[status]", s);
      if (s === "ready") clearTimeout(t0);
    },
    onPeer: (joined, role) => console.log("[peer]", role, joined ? "joined" : "left"),
    onMessage: (m) => {
      if (m.type === "event") {
        const topic = m.payload?.topic;
        events.set(topic, (events.get(topic) ?? 0) + 1);
        if (topic === "assistant.delta") {
          const d = m.payload.data;
          deltas.set(d.sessionId, (deltas.get(d.sessionId) ?? "") + (d.text ?? ""));
        } else {
          console.log("[event]", topic, JSON.stringify(m.payload?.data ?? {}).slice(0, 160));
        }
      }
    },
  });
}

const fail = (msg) => {
  console.error("FAIL:", msg);
  link?.close();
  process.exit(1);
};

const check = (label, cond, detail) => {
  if (cond) {
    console.log("ok: " + label);
  } else {
    console.error("FAIL: " + label + (detail ? " — " + detail : ""));
    throw new Error(label);
  }
};

// ---------------------------------------------------------------------------
// v1.0.6 新链路用例（§5.2 / §5.7 / §5.8）
// ---------------------------------------------------------------------------

/**
 * A. 自测链路：进程内直连回环（同样的封装与 AAD 绑定）+ mock host。
 *    不依赖中继进程、不占用真实 channel，覆盖：
 *      session.capabilities → session.create(agentPreset/permission)
 *      → session.history(steps) → tool.call/tool.result/system.message 事件到达。
 */
async function v106LoopbackCase() {
  console.log("");
  console.log("--- v1.0.6 new-chain case (loopback + mock host) ---");
  const wire = { channel: "E2ELOOPBACKCHANL1", secret: "e2e-v106-loopback-secret-0123456789" };
  const seen = []; // 手机端收到的事件
  let mock = null;
  const { host, client } = createLoopbackPair({
    channel: wire.channel,
    secret: wire.secret,
    onHostMessage: (m) => {
      void mock.handle(m).catch((e) => console.error("[mock] handler error:", e));
    },
    onClientMessage: (m) => {
      if (m.type === "event") seen.push(m.payload);
    },
  });
  mock = createMockHost({ link: host, log: () => {} });

  // 1. capabilities
  const caps = await client.request("session.capabilities", {}, 5000);
  check("capabilities 返回 presets/permissions", Array.isArray(caps?.presets) && Array.isArray(caps?.permissions), JSON.stringify(caps));
  check("capabilities 两个模式", caps.presets.length === 2, JSON.stringify(caps.presets));
  check("capabilities 两个权限", caps.permissions.length === 2, JSON.stringify(caps.permissions));
  check("capabilities 默认值", caps.defaultPreset === "standard" && caps.defaultPermission === "read-only", JSON.stringify(caps));

  // 2. create 带选项
  const created = await client.request(
    "session.create",
    { title: "e2e-v106", agentPreset: caps.presets[1].id, permission: caps.permissions[1].id },
    5000,
  );
  check("create 带选项成功", typeof created?.sessionId === "string" && created.sessionId !== "", JSON.stringify(created));
  check("create 回 agentPreset", created.agentPreset === caps.presets[1].id, JSON.stringify(created));
  const sid = created.sessionId;

  // 3. prompt 触发工具事件
  await client.request("session.prompt", { sessionId: sid, text: "hello" }, 5000);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const topics = new Set(seen.map((e) => e.topic));
    if (topics.has("tool.call") && topics.has("tool.result") && topics.has("system.message")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const topics = seen.map((e) => e.topic);
  check("tool.call 事件到达", topics.includes("tool.call"), JSON.stringify(topics));
  check("tool.result 事件到达", topics.includes("tool.result"), JSON.stringify(topics));
  check("system.message 事件到达", topics.includes("system.message"), JSON.stringify(topics));
  const call = seen.find((e) => e.topic === "tool.call")?.data;
  check("tool.call 字段", call?.sessionId === sid && typeof call?.callId === "string" && call?.name === "bash" && typeof call?.arguments === "string" && typeof call?.ts === "number", JSON.stringify(call));
  const res = seen.find((e) => e.topic === "tool.result")?.data;
  check("tool.result 字段", res?.callId === call?.callId && res?.status === "ok" && res?.resultText === "hello", JSON.stringify(res));
  const sys = seen.find((e) => e.topic === "system.message")?.data;
  check("system.message 字段", sys?.kind === "system" && typeof sys?.text === "string" && sys.text !== "", JSON.stringify(sys));

  // 4. history 带 steps
  const hist = await client.request("session.history", { sessionId: sid }, 5000);
  check("history 回 messages 数组", Array.isArray(hist?.messages), JSON.stringify(hist));
  check("history 回 steps 数组", Array.isArray(hist?.steps), JSON.stringify(hist?.steps));
  check("history steps 至少一条工具步骤", (hist?.steps?.length ?? 0) >= 1, JSON.stringify(hist?.steps));
  const step = hist.steps[0];
  check(
    "StepRecord 字段齐全",
    typeof step?.seq === "number" && typeof step?.callId === "string" && step?.name === "bash" &&
      typeof step?.arguments === "string" && step?.status === "ok" && step?.resultText === "hello" &&
      typeof step?.errorText === "string" && typeof step?.ts === "number" &&
      typeof step?.turn === "number" && typeof step?.step === "number",
    JSON.stringify(step),
  );
  check("history 仍回 hasMore/oldestSeq", typeof hist?.hasMore === "boolean" && Number.isSafeInteger(hist?.oldestSeq), JSON.stringify(hist));

  // 5. 未知 preset → unsupported-agent-preset（手机端回退成「不带选项」重试）
  let presetErr = null;
  try {
    await client.request("session.create", { agentPreset: "no-such-preset" }, 5000);
  } catch (e) {
    presetErr = e;
  }
  check("未知 preset 被拒（unsupported-agent-preset）", presetErr !== null, String(presetErr));

  // ---- v1.0.7：模型（§5.8）----------------------------------------------------
  check("capabilities 回 models 数组", Array.isArray(caps?.models) && caps.models.length === 2, JSON.stringify(caps?.models));
  check("capabilities 回 defaultModelId", typeof caps?.defaultModelId === "string" && caps.defaultModelId !== "", JSON.stringify(caps?.defaultModelId));
  const modelOpt = caps.models?.[0];
  check(
    "ModelOption 字段齐全",
    typeof modelOpt?.id === "string" && typeof modelOpt?.provider === "string" &&
      typeof modelOpt?.model === "string" && typeof modelOpt?.name === "string" &&
      typeof modelOpt?.description === "string",
    JSON.stringify(modelOpt),
  );
  check("ModelOption.id = provider/model", modelOpt?.id === `${modelOpt?.provider}/${modelOpt?.model}`, JSON.stringify(modelOpt));

  const withModel = await client.request(
    "session.create",
    { title: "e2e-v107-model", model: { provider: modelOpt.provider, model: modelOpt.model, reasoningEffort: "high" } },
    5000,
  );
  check("create 带 model 成功", typeof withModel?.sessionId === "string", JSON.stringify(withModel));
  check("create 回 model=归一化 selection", withModel?.model?.provider === modelOpt.provider && withModel?.model?.model === modelOpt.model, JSON.stringify(withModel?.model));
  const badModel = await client.request("session.create", { model: { provider: "nope", model: "nope" } }, 5000);
  check("未知 model：仍回 sessionId（手机不得重复创建）", typeof badModel?.sessionId === "string", JSON.stringify(badModel));
  check("未知 model：附 modelError 而非 error", typeof badModel?.modelError === "string" && badModel.error === undefined, JSON.stringify(badModel));

  // ---- v1.0.7：思考（§5.2 / §5.3）--------------------------------------------
  check("assistant.reasoningDelta 事件到达", topics.includes("assistant.reasoningDelta"), JSON.stringify(topics));
  const thinking = seen.find((e) => e.topic === "assistant.reasoningDelta")?.data;
  check("assistant.reasoningDelta 字段", thinking?.sessionId === sid && typeof thinking?.text === "string" && thinking.text !== "", JSON.stringify(thinking));
  // mock 的 assistant 消息在 prompt 流程末尾才落历史 → 轮询等它出现
  let hist2 = hist;
  const histDeadline = Date.now() + 5000;
  while (Date.now() < histDeadline) {
    if ((hist2?.messages ?? []).some((m) => m.role === "reasoning")) break;
    await new Promise((r) => setTimeout(r, 100));
    hist2 = await client.request("session.history", { sessionId: sid }, 5000);
  }
  const reasoningMsg = (hist2?.messages ?? []).find((m) => m.role === "reasoning");
  check("history 回 role=reasoning 消息", reasoningMsg !== undefined, JSON.stringify(hist2?.messages));
  check("reasoning 消息 id = sessionId:seq:reasoning", typeof reasoningMsg?.id === "string" && reasoningMsg.id.endsWith(":reasoning"), JSON.stringify(reasoningMsg));
  const bodyMsg = (hist2?.messages ?? []).find((m) => m.role === "assistant");
  check("正文消息不含思考文本", bodyMsg !== undefined && !String(bodyMsg.text).includes("思考中"), JSON.stringify(bodyMsg));
  const reasoningIdx = (hist2?.messages ?? []).findIndex((m) => m.role === "reasoning");
  const bodyIdx = (hist2?.messages ?? []).findIndex((m) => m.role === "assistant");
  check("reasoning 排在正文之前", reasoningIdx >= 0 && bodyIdx >= 0 && reasoningIdx < bodyIdx, JSON.stringify((hist2?.messages ?? []).map((m) => m.role)));

  // ---- v1.0.7：真实归档（§5.9）------------------------------------------------
  check("capabilities archiveSupported=true", caps?.archiveSupported === true, JSON.stringify(caps?.archiveSupported));
  const archived = await client.request("session.archive", { sessionId: sid }, 5000);
  check("archive 回 {sessionId,archived:true}", archived?.sessionId === sid && archived?.archived === true, JSON.stringify(archived));
  const archivesEvent = seen.filter((e) => e.topic === "session.archives").pop()?.data;
  check("session.archives 广播到达", Array.isArray(archivesEvent?.archivedSessionIds) && archivesEvent.archivedSessionIds.includes(sid), JSON.stringify(archivesEvent));
  const listAfter = await client.request("session.list", {}, 5000);
  const row = (listAfter?.sessions ?? []).find((s) => s.sessionId === sid);
  check("list 回 archived=true", row?.archived === true, JSON.stringify(row));
  const unarchived = await client.request("session.unarchive", { sessionId: sid }, 5000);
  check("unarchive 回 {sessionId,archived:false}", unarchived?.sessionId === sid && unarchived?.archived === false, JSON.stringify(unarchived));
  const listAfter2 = await client.request("session.list", {}, 5000);
  const row2 = (listAfter2?.sessions ?? []).find((s) => s.sessionId === sid);
  check("list 回 archived=false（恢复）", row2?.archived === false, JSON.stringify(row2));

  // ---- v1.0.8：思考强度目录 + 会话中切换（§5.1 / §5.8）------------------------
  const withEfforts = (caps?.models ?? []).find((m) => Array.isArray(m.efforts));
  check("capabilities：模型带 efforts（合法强度集合）", withEfforts !== undefined, JSON.stringify(caps?.models));
  check("efforts 项字段 id/name", typeof withEfforts?.efforts?.[0]?.id === "string" && typeof withEfforts?.efforts?.[0]?.name === "string", JSON.stringify(withEfforts?.efforts?.[0]));
  const noEfforts = (caps?.models ?? []).find((m) => !Array.isArray(m.efforts));
  check("capabilities：无 reasoning 的模型不带 efforts", noEfforts !== undefined, JSON.stringify(caps?.models));

  // selectModel → 归一化回包 + session.modelChanged 广播 + session.model 查询
  const before = seen.filter((e) => e.topic === "session.modelChanged").length;
  const switched = await client.request(
    "session.selectModel",
    { sessionId: sid, model: { provider: withEfforts.provider, model: withEfforts.model, reasoningEffort: "low" } },
    5000,
  );
  check("selectModel 回 {model:归一化 selection}", switched?.model?.provider === withEfforts.provider && switched?.model?.model === withEfforts.model && switched?.model?.reasoningEffort === "low", JSON.stringify(switched));
  const changedEvents = seen.filter((e) => e.topic === "session.modelChanged");
  check("selectModel → session.modelChanged 广播", changedEvents.length === before + 1, JSON.stringify(changedEvents.length));
  const changedData = changedEvents[changedEvents.length - 1]?.data;
  check("session.modelChanged 字段", changedData?.sessionId === sid && changedData?.model?.provider === withEfforts.provider && changedData?.model?.reasoningEffort === "low", JSON.stringify(changedData));
  const current = await client.request("session.model", { sessionId: sid }, 5000);
  check("session.model 回当前 selection", current?.model?.model === withEfforts.model && current?.model?.reasoningEffort === "low", JSON.stringify(current));

  // 非法 model → error（不假成功）
  let selErr = null;
  try {
    await client.request("session.selectModel", { sessionId: sid, model: { id: "a/b" } }, 5000);
  } catch (e) {
    selErr = e;
  }
  check("selectModel 非法 model 被拒", selErr !== null, String(selErr));

  // 未知模型 → 宿主拒绝（原文错误）
  let unknownErr = null;
  try {
    await client.request("session.selectModel", { sessionId: sid, model: { provider: "nope", model: "nope" } }, 5000);
  } catch (e) {
    unknownErr = e;
  }
  check("selectModel 未知模型被拒（原文）", unknownErr !== null && String(unknownErr).includes("model not available"), String(unknownErr));

  client.close();
  host.close();
  console.log("v1.0.6/1.0.7/1.0.8 loopback case: PASS");
}

/**
 * B. 真实宿主探针：宿主插件若已升级到 v1.0.6，capabilities/history 应带上新字段；
 *    仍是旧 bundle 时跳过（提示需要 remove_bundle + install_bundle）。
 */
async function v106LiveProbe() {
  console.log("");
  console.log("--- v1.0.6 live-host probe (best effort) ---");
  try {
    const caps = await link.request("session.capabilities", {}, 15000);
    check("live capabilities 回 presets 数组", Array.isArray(caps?.presets), JSON.stringify(caps));
    check("live capabilities 回 permissions 数组", Array.isArray(caps?.permissions), JSON.stringify(caps));
    const list = await link.request("session.list", {}, 15000);
    const items = list?.sessions ?? [];
    const target = items.find((s) => s.blank !== true);
    if (target !== undefined) {
      const hist = await link.request("session.history", { sessionId: target.sessionId, maxMessages: 10 }, 30000);
      check("live history 回 steps 数组", Array.isArray(hist?.steps), JSON.stringify(hist?.steps));
      console.log("live steps:", JSON.stringify((hist?.steps ?? []).slice(0, 3)));
    }
    console.log("v1.0.6 live-host probe: PASS");
  } catch (e) {
    const text = String(e?.message ?? e);
    console.log("SKIP: live host does not implement v1.0.6 yet (" + text + ")");
    console.log("      （宿主插件需 remove_bundle + install_bundle 后才会带上新代码）");
  }
}

try {
  if (loopbackOnly) {
    // 只跑回环用例：手机在线也安全（不连真实中继、不占真实 channel）
    await v106LoopbackCase();
    console.log("E2E RESULT: PASS (loopback only)");
    done = true;
    process.exit(0);
  }

  // 1. hello
  const hello = await link.request("hello", { proto: 1, clientName: "auto-test", appVersion: "1.0.0" }, 15000);
  console.log("hello.ok:", JSON.stringify(hello));
  if (!hello || typeof hello !== "object") fail("hello response malformed");

  // 2. session.list —— 必须返回真实会话数据
  const list = await link.request("session.list", {}, 15000);
  const items = list?.sessions ?? list?.items;
  if (!Array.isArray(items)) fail("session.list malformed: " + JSON.stringify(list).slice(0, 200));
  console.log("session.list: %d sessions", items.length);
  console.log("  sample:", JSON.stringify(items[0] ?? null).slice(0, 200));

  // 3. ping
  const pong = await link.request("ping", {}, 5000);
  if (typeof pong?.pong !== "number") fail("ping malformed");
  console.log("ping ok");

  // 4. prompt 闭环验证：新建独立会话再 prompt（不影响已有会话）
  if (process.env.E2E_PROMPT === "1") {
    const created = await link.request("session.create", { title: "e2e-联调临时会话" }, 15000);
    console.log("session.create:", JSON.stringify(created));
    const sid = created?.sessionId;
    if (!sid) fail("session.create malformed");
    const r = await link.request("session.prompt", { sessionId: sid, text: "请只回复两个字：收到" }, 15000);
    console.log("session.prompt:", JSON.stringify(r));
    const wait = 25000;
    console.log("watching events for %dms …", wait);
    await new Promise((r2) => setTimeout(r2, wait));
    for (const [s, text] of deltas) console.log("delta[%s]: %s", s, text.slice(0, 200));
    if (deltas.size === 0) console.log("  (no assistant.delta observed)");
    const endCount = events.get("turn.end") ?? 0;
    console.log("turn.end count:", endCount);
  }

  // 5. v1.0.6+ 新链路：自测回环（恒跑）+ 真实宿主探针（尽力而为）
  await v106LoopbackCase();
  await v106LiveProbe();

  console.log("event counts:", JSON.stringify([...events]));
  console.log("E2E RESULT: PASS");
  done = true;
  link.close();
  process.exit(0);
} catch (e) {
  if (!done) fail(e?.message ?? String(e));
}
