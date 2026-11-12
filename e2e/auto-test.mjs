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
import { readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RelayLink, createLoopbackPair } from "./link.mjs";
import { createMockHost } from "./mock-host.mjs";
import {
  assertKat,
  deriveKey,
  makeProof,
  verifyProof,
  seal,
  open,
  EpochStore,
  PROOF_VERSION,
} from "./protocol.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RELAY_SERVER = join(HERE, "..", "relay", "server.js");

/** 只跑回环用例（手机在线时用；不碰真实 channel / 真实中继）。 */
const loopbackOnly = process.env.E2E_LOOPBACK_ONLY === "1";

let cfg = { channel: "", secret: "", relayUrl: "", relayToken: "" };
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
    // 中继自身鉴权（契约 §4 RELAY_TOKEN）：配置后 hello 必须带 token
    token: cfg.relayToken || undefined,
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
 *      → session.history(steps) → tool.call/tool.result 事件到达。
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
    if (topics.has("tool.call") && topics.has("tool.result")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const topics = seen.map((e) => e.topic);
  check("tool.call 事件到达", topics.includes("tool.call"), JSON.stringify(topics));
  check("tool.result 事件到达", topics.includes("tool.result"), JSON.stringify(topics));
  // v1.1.4：system.message 已从协议移除（宿主 system/developer 消息是提示词组装
  // 记录，不是对话内容，PC 聊天视图从不展示）→ 不应再出现该 topic。
  check("system.message 事件已移除（v1.1.4）", !topics.includes("system.message"), JSON.stringify(topics));
  const call = seen.find((e) => e.topic === "tool.call")?.data;
  check("tool.call 字段", call?.sessionId === sid && typeof call?.callId === "string" && call?.name === "bash" && typeof call?.arguments === "string" && typeof call?.ts === "number", JSON.stringify(call));
  const res = seen.find((e) => e.topic === "tool.result")?.data;
  check("tool.result 字段", res?.callId === call?.callId && res?.status === "ok" && res?.resultText === "hello", JSON.stringify(res));

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
 * v1.2.0（契约 §5.11）：输入框附件——分块上传 + session.prompt uploads + 历史 files[]。
 * 进程内回环 + mock host（不碰真实 channel/中继）。
 */
async function v120AttachmentLoopbackCase() {
  console.log("");
  console.log("--- v1.2.0 attachment case (loopback + mock host) ---");
  const wire = { channel: "E2ELOOPBACKCHANL1", secret: "e2e-v120-loopback-secret-0123456789" };
  let mock = null;
  const { host, client } = createLoopbackPair({
    channel: wire.channel,
    secret: wire.secret,
    onHostMessage: (m) => {
      void mock.handle(m).catch((e) => console.error("[mock] handler error:", e));
    },
    onClientMessage: () => {},
  });
  mock = createMockHost({ link: host, log: () => {} });

  const caps = await client.request("session.capabilities", {}, 5000);
  check("capabilities 声明 attachments", caps?.attachments?.supported === true, JSON.stringify(caps?.attachments));
  check("capabilities.attachments 上限字段", caps.attachments.maxCount === 9 && caps.attachments.chunkBytes === 262144 && Array.isArray(caps.attachments.imageMediaTypes), JSON.stringify(caps.attachments));

  const created = await client.request("session.create", { title: "e2e-v120" }, 5000);
  check("create 会话成功", typeof created?.sessionId === "string", JSON.stringify(created));
  const sid = created.sessionId;

  // ---- 图片上传（320×200 的 PNG 头）----
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.write("IHDR", 12);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(200, 20);
  const begun = await client.request(
    "attachment.upload.begin",
    { sessionId: sid, kind: "image", name: "shot.png", mediaType: "image/png", bytes: png.length },
    5000,
  );
  check("upload.begin 图片回 uploadId/chunkBytes", typeof begun?.uploadId === "string" && begun.chunkBytes === 262144, JSON.stringify(begun));
  const imageUploadId = begun.uploadId;
  const cut = 20;
  const rc0 = await client.request(
    "attachment.upload.chunk",
    { uploadId: imageUploadId, index: 0, data: png.subarray(0, cut).toString("base64") },
    5000,
  );
  check("upload.chunk 0 回 received", rc0?.received === cut, JSON.stringify(rc0));
  const rc1 = await client.request(
    "attachment.upload.chunk",
    { uploadId: imageUploadId, index: 1, data: png.subarray(cut).toString("base64") },
    5000,
  );
  check("upload.chunk 1 收满", rc1?.received === png.length, JSON.stringify(rc1));
  const committed = await client.request("attachment.upload.commit", { uploadId: imageUploadId }, 5000);
  check("upload.commit 图片回 UploadedAttachment", committed?.attachment?.kind === "image" && committed.attachment.bytes === png.length, JSON.stringify(committed));
  check("upload.commit 图片带归一化尺寸", committed.attachment.width === 320 && committed.attachment.height === 200, JSON.stringify(committed.attachment));

  // ---- 文件上传 ----
  const fileBytes = Buffer.from("attachment body");
  const fileBegun = await client.request(
    "attachment.upload.begin",
    { sessionId: sid, kind: "file", name: "说明.txt", bytes: fileBytes.length },
    5000,
  );
  const fileUploadId = fileBegun.uploadId;
  await client.request(
    "attachment.upload.chunk",
    { uploadId: fileUploadId, index: 0, data: fileBytes.toString("base64") },
    5000,
  );
  const fileCommitted = await client.request("attachment.upload.commit", { uploadId: fileUploadId }, 5000);
  check("upload.commit 文件回 kind/name/bytes", fileCommitted?.attachment?.kind === "file" && fileCommitted.attachment.name === "说明.txt" && fileCommitted.attachment.bytes === fileBytes.length, JSON.stringify(fileCommitted));

  // ---- prompt 带图片 + 文件 ----
  const promptRes = await client.request("session.prompt", { sessionId: sid, text: "看附件", uploads: [imageUploadId, fileUploadId] }, 5000);
  check("session.prompt 带 uploads 被接受", promptRes?.accepted === true, JSON.stringify(promptRes));

  let hist = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    hist = await client.request("session.history", { sessionId: sid }, 5000);
    const user = (hist?.messages ?? []).find((m) => m.role === "user" && (m.images ?? []).length > 0);
    if (user !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const userMsg = (hist?.messages ?? []).find((m) => m.role === "user" && (m.images ?? []).length > 0);
  check("history 用户消息带 images[]", userMsg !== undefined && userMsg.images[0].imageId === committed.attachment.attachmentId, JSON.stringify(userMsg));
  check("history 用户消息带 files[]", (userMsg?.files ?? []).length === 1 && userMsg.files[0].name === "说明.txt", JSON.stringify(userMsg?.files));
  check("history 用户消息正文不含占位符", userMsg?.text === "看附件", JSON.stringify(userMsg?.text));

  // 同一 uploadId 复用 → attachment-upload-consumed
  let reuseErr = null;
  try {
    await client.request("session.prompt", { sessionId: sid, text: "again", uploads: [imageUploadId] }, 5000);
  } catch (e) {
    reuseErr = e;
  }
  check("消费后的 uploadId 复用被拒", String(reuseErr).includes("已用于上一条消息"), String(reuseErr));

  // 附件-only（正式协议允许 text 为空串）
  const onlyBytes = Buffer.from("only");
  const onlyBegun = await client.request(
    "attachment.upload.begin",
    { sessionId: sid, kind: "file", name: "only.txt", bytes: onlyBytes.length },
    5000,
  );
  await client.request("attachment.upload.chunk", { uploadId: onlyBegun.uploadId, index: 0, data: onlyBytes.toString("base64") }, 5000);
  await client.request("attachment.upload.commit", { uploadId: onlyBegun.uploadId }, 5000);
  const onlyPrompt = await client.request("session.prompt", { sessionId: sid, text: "", uploads: [onlyBegun.uploadId] }, 5000);
  check("附件-only prompt 被接受", onlyPrompt?.accepted === true, JSON.stringify(onlyPrompt));
  const histDeadline = Date.now() + 8000;
  let onlyMsg = undefined;
  while (Date.now() < histDeadline) {
    const h2 = await client.request("session.history", { sessionId: sid }, 5000);
    onlyMsg = (h2?.messages ?? []).find((m) => m.role === "user" && m.text === "" && (m.files ?? []).some((f) => f.name === "only.txt"));
    if (onlyMsg !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("附件-only 用户消息进历史（纯附件成条）", onlyMsg !== undefined && onlyMsg.text === "", JSON.stringify(onlyMsg));

  // abort 幂等
  const abortBegun = await client.request("attachment.upload.begin", { sessionId: sid, kind: "file", name: "a.txt", bytes: 1 }, 5000);
  const aborted = await client.request("attachment.upload.abort", { uploadId: abortBegun.uploadId }, 5000);
  check("upload.abort 未提交上传回 aborted:true", aborted?.aborted === true, JSON.stringify(aborted));
  const aborted2 = await client.request("attachment.upload.abort", { uploadId: abortBegun.uploadId }, 5000);
  check("upload.abort 幂等 false", aborted2?.aborted === false, JSON.stringify(aborted2));

  // text/uploads 同时为空 → bad-params
  let emptyErr = null;
  try {
    await client.request("session.prompt", { sessionId: sid, text: "  " }, 5000);
  } catch (e) {
    emptyErr = e;
  }
  check("text/uploads 同时为空被拒", emptyErr !== null, String(emptyErr));

  client.close();
  host.close();
  console.log("v1.2.0 attachment loopback case: PASS");
}

/**
 * v1.3.0（契约 §5.12 / §5.13 / §5.14）：待答交互 / Todo / Goal。
 * 进程内回环 + mock host（不碰真实 channel / 真实中继）。
 *
 * 覆盖：
 *   - session.queue 权威快照（按 itemId 出队、空快照=清空）；
 *   - pending.interactions 恢复合并（live plugin pending + host continued）；
 *   - question.request 新字段 / question.answer 的 live 与 continued 路由；
 *   - timeout 不清 continued 卡片（随后以 continued 重发）；
 *   - todo 的 null（无清单）vs unsupported（宿主无该能力）；
 *   - goal CAS（陈旧 revision → GOAL_STALE_REVISION）与各人类操作；
 *   - goalChanged / goalActivationChanged / todosChanged 事件；
 *   - 子代理会话与根会话的差异。
 */
async function v130LoopbackCase() {
  console.log("");
  console.log("--- v1.3.0 pending/todo/goal case (loopback + mock host) ---");
  const wire = { channel: "E2ELOOPBACKCHANEL", secret: "e2e-v130-loopback-secret-0123456789" };
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

  // ---- 0. hello 声明能力（v1.3.0：hello.features = ["session-state-v1"]）------------
  const hello = await client.request(
    "hello",
    { proto: 1, clientName: "auto-test", appVersion: "1.0.0", features: ["session-state-v1"] },
    5000,
  );
  check("hello 正常回包", typeof hello?.hostName === "string", JSON.stringify(hello));
  check(
    "mock 记录了客户端声明的 features（§5.12 不变量 6）",
    mock.clientFeatures.has("session-state-v1"),
    JSON.stringify([...mock.clientFeatures]),
  );

  // ---- 1. capabilities 新字段（§5.1）------------------------------------------------
  const caps = await client.request("session.capabilities", {}, 5000);
  check("capabilities.todos 能力目录", caps?.todos?.supported === true, JSON.stringify(caps?.todos));
  check(
    "capabilities.goal 能力目录（read + 6 个动作，且不含 block）",
    caps?.goal?.read === true &&
      Array.isArray(caps.goal.actions) &&
      caps.goal.actions.length === 6 &&
      !caps.goal.actions.includes("block"),
    JSON.stringify(caps?.goal),
  );
  check(
    "capabilities.pendingInteractions 能力目录",
    caps?.pendingInteractions?.questions === true &&
      caps?.pendingInteractions?.approvals === true &&
      caps?.pendingInteractions?.hostContinued === true,
    JSON.stringify(caps?.pendingInteractions),
  );

  const created = await client.request("session.create", { title: "e2e-v130" }, 5000);
  check("create 会话成功", typeof created?.sessionId === "string", JSON.stringify(created));
  const sid = created.sessionId;
  const s = mock.sessions.get(sid);

  // ---- 2. session.queue 权威快照（§5.1 v1.3.0 权威口径）------------------------------
  mock.enqueue(s, { itemId: "msg-a", text: "排队 A", target: "next-turn" });
  mock.enqueue(s, { itemId: "msg-b", text: "排队 B", target: "next-step" });
  let queue = await client.request("session.queue", { sessionId: sid }, 5000);
  check(
    "session.queue 回权威快照（以 itemId 为主键）",
    queue?.items?.length === 2 && queue.items[0].itemId === "msg-a" && queue.items[1].itemId === "msg-b",
    JSON.stringify(queue),
  );
  check(
    "session.queue 项字段 itemId/text/target 齐全",
    (queue?.items ?? []).every(
      (i) =>
        typeof i.itemId === "string" &&
        typeof i.text === "string" &&
        ["next-turn", "next-step"].includes(i.target),
    ),
    JSON.stringify(queue?.items),
  );
  mock.consume(s, "msg-a");
  queue = await client.request("session.queue", { sessionId: sid }, 5000);
  check(
    "session.queue 按 itemId 精确出队（只删那一条）",
    queue?.items?.length === 1 && queue.items[0].itemId === "msg-b",
    JSON.stringify(queue),
  );
  mock.clearQueue(s);
  queue = await client.request("session.queue", { sessionId: sid }, 5000);
  check(
    "空 session.queue 清除（items=[]，客户端必须清空排队列表）",
    Array.isArray(queue?.items) && queue.items.length === 0,
    JSON.stringify(queue),
  );
  const queueEvents = seen.filter((e) => e.topic === "session.queue");
  check(
    "session.queue 事件最后一帧也是权威空快照",
    queueEvents.length >= 3 &&
      Array.isArray(queueEvents[queueEvents.length - 1]?.data?.items) &&
      queueEvents[queueEvents.length - 1].data.items.length === 0,
    JSON.stringify(queueEvents.map((e) => (e.data?.items ?? []).length)),
  );

  // ---- 3. 待答恢复合并（§5.12）------------------------------------------------------
  const liveAskId = mock.openPluginQuestion(s, {
    callId: "call-v130-live",
    hostBacked: true,
    questions: [
      { id: "q1", question: "继续吗？", multiSelect: false, options: [{ label: "继续", description: "" }] },
    ],
  });
  const continuedAskId = mock.openHostQuestion(s, {
    callId: "call-v130-cont",
    state: "continued",
    questions: [
      { id: "q2", question: "补答", multiSelect: false, options: [{ label: "好", description: "" }] },
    ],
  });
  const pending = await client.request("pending.interactions", { sessionId: sid }, 5000);
  check(
    "pending 快照合并 live plugin pending + host continued",
    pending?.questions?.length === 2,
    JSON.stringify(pending),
  );
  const liveRow = pending.questions.find((q) => q.askId === liveAskId);
  const contRow = pending.questions.find((q) => q.askId === continuedAskId);
  check(
    "pending live 行 source=plugin/state=open/answerable=true",
    liveRow?.source === "plugin" && liveRow?.state === "open" && liveRow?.answerable === true,
    JSON.stringify(liveRow),
  );
  check(
    "pending continued 行 source=host/state=continued/answerable=true",
    contRow?.source === "host" && contRow?.state === "continued" && contRow?.answerable === true,
    JSON.stringify(contRow),
  );
  check(
    "pending 行带 callId 与 questions",
    liveRow?.callId === "call-v130-live" &&
      Array.isArray(liveRow?.questions) &&
      liveRow.questions.length === 1 &&
      liveRow.questions[0]?.id === "q1",
    JSON.stringify(liveRow),
  );
  check(
    "pending 含 approvals 数组（审批与提问共用同一快照通道）",
    Array.isArray(pending?.approvals),
    JSON.stringify(pending),
  );
  const globalPending = await client.request("pending.interactions", {}, 5000);
  check(
    "pending 不带 sessionId 只回插件持有的全局待答（不做全量冷读）",
    globalPending?.questions?.length === 1 && globalPending.questions[0].askId === liveAskId,
    JSON.stringify(globalPending),
  );

  // ---- 4. question.request 新字段（§5.2）---------------------------------------------
  const reqEvent = seen
    .filter((e) => e.topic === "question.request" && e.data?.askId === liveAskId)
    .pop()?.data;
  check(
    "question.request 带 askId/callId/state/answerable/expiresAt",
    reqEvent?.askId === liveAskId &&
      reqEvent?.callId === "call-v130-live" &&
      reqEvent?.state === "open" &&
      reqEvent?.answerable === true &&
      Number.isSafeInteger(reqEvent?.expiresAt),
    JSON.stringify(reqEvent),
  );
  const contEvent = seen
    .filter((e) => e.topic === "question.request" && e.data?.askId === continuedAskId)
    .pop()?.data;
  check(
    "question.request（host continued）state=continued/answerable=true",
    contEvent?.state === "continued" && contEvent?.answerable === true,
    JSON.stringify(contEvent),
  );

  // ---- 5. question.answer 路由：live / continued（§5.1 / §5.12）--------------------
  const contAns = await client.request(
    "question.answer",
    { askId: continuedAskId, answers: { q2: "好" } },
    5000,
  );
  check("continued 补答 applied=true", contAns?.applied === true, JSON.stringify(contAns));
  const afterCont = await client.request("pending.interactions", { sessionId: sid }, 5000);
  check(
    "补答后 continued 从快照消失",
    (afterCont?.questions ?? []).every((q) => q.askId !== continuedAskId),
    JSON.stringify(afterCont),
  );
  const contAns2 = await client.request(
    "question.answer",
    { askId: continuedAskId, answers: { q2: "好" } },
    5000,
  );
  check(
    "重复补答 applied=false（已失效或已由另一端处理）",
    contAns2?.applied === false,
    JSON.stringify(contAns2),
  );
  const liveAns = await client.request(
    "question.answer",
    { askId: liveAskId, answers: { q1: "继续" } },
    5000,
  );
  check("live 补答 applied=true（走插件原瀑布）", liveAns?.applied === true, JSON.stringify(liveAns));
  check(
    "mock 记录的路由：live / continued 各自命中",
    mock.lastAnswer?.route === "live" && mock.lastAnswer?.askId === liveAskId,
    JSON.stringify(mock.lastAnswer),
  );
  let unknownAns = null;
  try {
    await client.request("question.answer", { askId: "no-such-ask", answers: { q1: "x" } }, 5000);
  } catch (e) {
    unknownAns = e;
  }
  check("未知 askId 回 applied=false（不报错，客户端随后重拉快照）", unknownAns === null, String(unknownAns));
  let shapeErr = null;
  try {
    await client.request("question.answer", { askId: liveAskId, answers: "not-an-object" }, 5000);
  } catch (e) {
    shapeErr = e;
  }
  check(
    "answers 非对象回 bad-answers",
    shapeErr !== null && String(shapeErr).includes("bad-answers"),
    String(shapeErr),
  );

  // ---- 6. timeout 不清 continued 卡片（§5.12 不变量 ② / ⑥）--------------------------
  const timeoutAskId = mock.openPluginQuestion(s, {
    callId: "call-v130-timeout",
    hostBacked: true,
    questions: [
      { id: "q3", question: "超时？", multiSelect: false, options: [{ label: "是", description: "" }] },
    ],
  });
  mock.timeoutQuestion(timeoutAskId);
  const afterTimeout = await client.request("pending.interactions", { sessionId: sid }, 5000);
  const kept = (afterTimeout?.questions ?? []).find((q) => q.askId === timeoutAskId);
  check(
    "timeout 后 continued 卡片仍在快照（不得删除）",
    kept !== undefined && kept.state === "continued" && kept.answerable === true,
    JSON.stringify(kept),
  );
  const republished = seen
    .filter((e) => e.topic === "question.request" && e.data?.askId === timeoutAskId)
    .pop()?.data;
  check(
    "timeout 后以 question.request{state:continued} 重发",
    republished?.state === "continued" && republished?.answerable === true,
    JSON.stringify(republished),
  );
  const timeoutResolved = seen.find(
    (e) => e.topic === "question.resolved" && e.data?.askId === timeoutAskId,
  );
  check(
    "声明 session-state-v1 的客户端：timeout 不发 resolved（卡片不得被删）",
    timeoutResolved === undefined,
    JSON.stringify(timeoutResolved?.data),
  );

  // ---- 6b. 旧客户端（未声明 session-state-v1）：保持旧语义 ---------------------------
  // §5.12 不变量 6：旧客户端在 timed 超时时收 question.resolved，且**不得**收到
  // question.request{state:"continued"} 重发（旧 UI 会重复建卡）。
  const legacySeen = [];
  let mockLegacy = null;
  const { host: hostL, client: clientL } = createLoopbackPair({
    channel: "E2ELOOPBACKCHANEL3",
    secret: "e2e-v130-loopback-secret-0123456789",
    onHostMessage: (m) => {
      void mockLegacy.handle(m).catch((e) => console.error("[mockLegacy] handler error:", e));
    },
    onClientMessage: (m) => {
      if (m.type === "event") legacySeen.push(m.payload);
    },
  });
  mockLegacy = createMockHost({ link: hostL, log: () => {} });
  await clientL.request("hello", { proto: 1, clientName: "legacy-phone", appVersion: "0.9.0" }, 5000);
  const legacyCreated = await clientL.request("session.create", { title: "legacy" }, 5000);
  const legacySession = mockLegacy.sessions.get(legacyCreated.sessionId);
  const legacyAskId = mockLegacy.openPluginQuestion(legacySession, {
    callId: "call-v130-legacy",
    hostBacked: true,
    questions: [
      { id: "q9", question: "旧客户端问题", multiSelect: false, options: [{ label: "好", description: "" }] },
    ],
  });
  mockLegacy.timeoutQuestion(legacyAskId);
  // 回环投递走微任务队列 → 先让出一次事件循环再断言事件
  await new Promise((r) => setTimeout(r, 50));
  const legacyResolved = legacySeen.find(
    (e) => e.topic === "question.resolved" && e.data?.askId === legacyAskId,
  );
  check(
    "旧客户端：timed 超时收 question.resolved{source:timeout}（旧语义清卡）",
    legacyResolved?.data?.source === "timeout",
    JSON.stringify(legacyResolved?.data),
  );
  const legacyContinued = legacySeen.find(
    (e) => e.topic === "question.request" && e.data?.askId === legacyAskId && e.data?.state === "continued",
  );
  check(
    "旧客户端：不得收到 question.request{state:continued} 重发（避免重复建卡）",
    legacyContinued === undefined,
    JSON.stringify(legacyContinued?.data),
  );
  clientL.close();
  hostL.close();

  // ---- 6c. 审批与提问共用同一快照通道（§5.12 不变量 7）-----------------------------
  const approvalAskId = mock.openPluginApproval(s, { toolName: "bash", reason: "跑一条命令" });
  const withApproval = await client.request("pending.interactions", { sessionId: sid }, 5000);
  const approvalRow = (withApproval?.approvals ?? []).find((a) => a.askId === approvalAskId);
  check(
    "待答审批出现在 pending 快照的 approvals[]（与提问同一通道）",
    approvalRow !== undefined &&
      approvalRow.source === "plugin" &&
      approvalRow.answerable === true &&
      Number.isSafeInteger(approvalRow.expiresAt),
    JSON.stringify(withApproval?.approvals),
  );
  const approvalEvt = seen
    .filter((e) => e.topic === "approval.request" && e.data?.askId === approvalAskId)
    .pop()?.data;
  check(
    "approval.request 带 expiresAt（§5.2 v1.3.0）",
    Number.isSafeInteger(approvalEvt?.expiresAt),
    JSON.stringify(approvalEvt),
  );
  mock.pluginPending.delete(approvalAskId);

  // ---- 7. Todo：null（无清单）vs unsupported（宿主无该能力）（§5.13）----------------
  let todos = await client.request("session.todos", { sessionId: sid }, 5000);
  check(
    "todos supported=true 且 todos=null（本回合尚无清单）",
    todos?.supported === true && todos?.todos === null,
    JSON.stringify(todos),
  );
  mock.setTodos(s, [
    { content: "读契约", status: "completed" },
    { content: "写用例", status: "in_progress" },
  ]);
  todos = await client.request("session.todos", { sessionId: sid }, 5000);
  check(
    "todos 整表覆盖（2 条）",
    todos?.todos?.length === 2 &&
      todos.todos[0].content === "读契约" &&
      todos.todos[0].status === "completed" &&
      todos.todos[1].status === "in_progress",
    JSON.stringify(todos),
  );
  const todosEvt = seen.filter((e) => e.topic === "session.todosChanged").pop()?.data;
  check(
    "session.todosChanged 事件整表到达",
    todosEvt?.sessionId === sid && todosEvt?.todos?.length === 2,
    JSON.stringify(todosEvt),
  );
  mock.setTodos(s, null);
  todos = await client.request("session.todos", { sessionId: sid }, 5000);
  check(
    "turn/start 清清单 → todos=null（supported 仍为 true）",
    todos?.supported === true && todos?.todos === null,
    JSON.stringify(todos),
  );

  // 宿主不支持 todos：另起一个 mock（todosSupported:false）
  let mock2 = null;
  const { host: host2, client: client2 } = createLoopbackPair({
    channel: "E2ELOOPBACKCHANEL2",
    secret: "e2e-v130-loopback-secret-0123456789",
    onHostMessage: (m) => {
      void mock2.handle(m).catch((e) => console.error("[mock2] handler error:", e));
    },
    onClientMessage: () => {},
  });
  mock2 = createMockHost({ link: host2, log: () => {}, todosSupported: false });
  const caps2 = await client2.request("session.capabilities", {}, 5000);
  check(
    "宿主不支持 todos → capabilities.todos.supported=false",
    caps2?.todos?.supported === false,
    JSON.stringify(caps2?.todos),
  );
  const created2 = await client2.request("session.create", { title: "e2e-v130-no-todo" }, 5000);
  const todos2 = await client2.request("session.todos", { sessionId: created2.sessionId }, 5000);
  check(
    "unsupported 与 null 可区分（隐藏 UI vs 显示「暂无任务」）",
    todos2?.supported === false && todos2?.todos === null,
    JSON.stringify(todos2),
  );
  client2.close();
  host2.close();

  // ---- 8. Goal：CAS + 人类操作（§5.14）----------------------------------------------
  const goalCreate = await client.request(
    "session.goalAction",
    { sessionId: sid, action: "create", objective: "完成 v1.3.0 的 e2e 覆盖" },
    5000,
  );
  check(
    "goal create 成功（phase=active/revision=1）",
    goalCreate?.goal?.phase === "active" &&
      goalCreate?.goal?.revision === 1 &&
      typeof goalCreate.goal.id === "string",
    JSON.stringify(goalCreate),
  );
  const goalRead = await client.request("session.goal", { sessionId: sid }, 5000);
  check(
    "session.goal 回 goal/activation/supported/actions",
    goalRead?.goal?.id === goalCreate.goal.id &&
      goalRead?.activation === "armed" &&
      goalRead?.supported === true &&
      goalRead?.actions?.length === 6,
    JSON.stringify(goalRead),
  );
  check("session.goal 的 goal 带 activation（已知时）", goalRead?.goal?.activation === "armed", JSON.stringify(goalRead?.goal));

  // 另一端改了目标 → revision 前进 → 客户端缓存的 expected 变陈旧
  mock.bumpGoalRevision(s);
  let staleErr = null;
  try {
    await client.request(
      "session.goalAction",
      { sessionId: sid, action: "pause", expected: { id: goalRead.goal.id, revision: goalRead.goal.revision } },
      5000,
    );
  } catch (e) {
    staleErr = e;
  }
  check(
    "goal CAS：陈旧 revision 回 GOAL_STALE_REVISION",
    staleErr !== null && String(staleErr).includes("GOAL_STALE_REVISION"),
    String(staleErr),
  );
  const goalAfterStale = await client.request("session.goal", { sessionId: sid }, 5000);
  check(
    "陈旧操作未覆盖新状态（phase 仍是 active）",
    goalAfterStale?.goal?.phase === "active",
    JSON.stringify(goalAfterStale?.goal),
  );
  const paused = await client.request(
    "session.goalAction",
    { sessionId: sid, action: "pause", expected: { id: goalAfterStale.goal.id, revision: goalAfterStale.goal.revision } },
    5000,
  );
  check(
    "重拉后 pause 成功（phase=paused，revision 前进）",
    paused?.goal?.phase === "paused" && paused.goal.revision > goalAfterStale.goal.revision,
    JSON.stringify(paused),
  );
  const resumed = await client.request(
    "session.goalAction",
    { sessionId: sid, action: "resume", expected: { id: paused.goal.id, revision: paused.goal.revision } },
    5000,
  );
  check("resume 成功（phase=active）", resumed?.goal?.phase === "active", JSON.stringify(resumed));
  const edited = await client.request(
    "session.goalAction",
    {
      sessionId: sid,
      action: "edit",
      expected: { id: resumed.goal.id, revision: resumed.goal.revision },
      objective: "改过的目标",
      maxGoalRounds: 20,
    },
    5000,
  );
  check(
    "edit 成功（objective/maxGoalRounds 更新）",
    edited?.goal?.objective === "改过的目标" && edited.goal.maxGoalRounds === 20,
    JSON.stringify(edited),
  );
  const completed = await client.request(
    "session.goalAction",
    { sessionId: sid, action: "complete", expected: { id: edited.goal.id, revision: edited.goal.revision } },
    5000,
  );
  check("complete 成功（phase=complete）", completed?.goal?.phase === "complete", JSON.stringify(completed));
  const cleared = await client.request(
    "session.goalAction",
    { sessionId: sid, action: "clear", expected: { id: completed.goal.id, revision: completed.goal.revision } },
    5000,
  );
  check("clear 成功（goal=null）", cleared?.goal === null, JSON.stringify(cleared));

  const goalEvents = seen.filter((e) => e.topic === "session.goalChanged");
  check(
    "session.goalChanged 事件覆盖 create/edit/pause/resume/complete/clear",
    ["create", "edit", "pause", "resume", "complete", "clear"].every((op) =>
      goalEvents.some((e) => e.data?.operation === op),
    ),
    JSON.stringify(goalEvents.map((e) => e.data?.operation)),
  );
  const clearEvent = goalEvents.filter((e) => e.data?.operation === "clear").pop()?.data;
  check("clear 事件的 goal 为 null", clearEvent?.goal === null, JSON.stringify(clearEvent));
  check(
    "goalChanged 载荷不含 activation（§5.2：不含 activation）",
    goalEvents.every((e) => e.data?.goal === null || e.data.goal.activation === undefined),
    JSON.stringify(goalEvents.map((e) => e.data?.goal?.activation)),
  );
  const actEvents = seen.filter((e) => e.topic === "session.goalActivationChanged");
  check(
    "session.goalActivationChanged 事件（armed/disarmed）到达",
    actEvents.length >= 2 &&
      actEvents.some((e) => e.data?.activation === "armed") &&
      actEvents.some((e) => e.data?.activation === "disarmed"),
    JSON.stringify(actEvents.map((e) => e.data?.activation)),
  );
  check(
    "goalActivationChanged 带 id/revision",
    actEvents.every((e) => typeof e.data?.id === "string" && Number.isSafeInteger(e.data?.revision)),
    JSON.stringify(actEvents[0]?.data),
  );
  let blockErr = null;
  try {
    await client.request(
      "session.goalAction",
      { sessionId: sid, action: "block", expected: { id: "goal-x", revision: 1 } },
      5000,
    );
  } catch (e) {
    blockErr = e;
  }
  check("手机不得触发 block（§5.14）", blockErr !== null, String(blockErr));

  // ---- 9. 子代理会话 vs 根会话（§5.3 / §5.13 / §5.14）-------------------------------
  const list = await client.request("session.list", {}, 5000);
  const listIds = (list?.sessions ?? []).map((x) => x.sessionId);
  check(
    "session.list 只列根会话（子代理不出现在列表，§5.3）",
    !listIds.includes("s-demo-1:sub-1") && listIds.includes("s-demo-1"),
    JSON.stringify(listIds),
  );
  const subs = await client.request("session.subagents", { sessionId: "s-demo-1" }, 5000);
  check("session.subagents 目录仍含子代理（入口在父会话详情页）", subs?.subagents?.length === 2, JSON.stringify(subs));
  const subTodos = await client.request("session.todos", { sessionId: "s-demo-1:sub-1" }, 5000);
  check(
    "子代理会话的 todo 独立于根会话（null ≠ 根会话的清单）",
    subTodos?.supported === true && subTodos?.todos === null,
    JSON.stringify(subTodos),
  );
  const subGoal = await client.request("session.goal", { sessionId: "s-demo-1:sub-1" }, 5000);
  check(
    "子代理会话无自己的 goal（null，但能力 supported=true）",
    subGoal?.goal === null && subGoal?.supported === true,
    JSON.stringify(subGoal),
  );
  const rootBefore = await client.request("session.goal", { sessionId: "s-demo-1" }, 5000);
  const subGoalCreate = await client.request(
    "session.goalAction",
    { sessionId: "s-demo-1:sub-1", action: "create", objective: "子代理目标" },
    5000,
  );
  check("子代理会话可独立建目标", subGoalCreate?.goal?.objective === "子代理目标", JSON.stringify(subGoalCreate));
  const rootAfter = await client.request("session.goal", { sessionId: "s-demo-1" }, 5000);
  check(
    "子代理建目标不影响根会话",
    (rootAfter?.goal?.id ?? null) === (rootBefore?.goal?.id ?? null),
    JSON.stringify({ before: rootBefore?.goal, after: rootAfter?.goal }),
  );

  client.close();
  host.close();
  console.log("v1.3.0 pending/todo/goal loopback case: PASS");
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

// ---------------------------------------------------------------------------
// v1.1.3 用例（契约 §3.4.1 会话纪元 / §7 AAD 绑定 sid / §4 证明透传）
// ---------------------------------------------------------------------------

/**
 * v1.1.3 自测链路（恒跑，不依赖真实中继/真实宿主）：
 *   ① 证明 v2 自洽 + 验签（改一个字节即验签失败）
 *   ② 加固模式往返（LoopbackLink 双端 pv>=2 → AAD 绑定 sid）
 *   ③ 换 sid 解密必须失败（契约 §7 ③）
 *   ④ 纪元回退必须被拒 + 同一证明重复幂等接受（契约 §7 ④）
 *   ⑤ 收到的帧 sid 与钉扎值不符必须丢弃（契约 §7 ⑤）
 *   ⑥ 纪元持久化：重启（新建 store）后继续递增
 */
async function v113ProofCase() {
  console.log("");
  console.log("--- v1.1.3 session-epoch / hardened-mode case (loopback) ---");
  const channel = "E2EPROOFCANAL2345";
  const secret = "e2e-v113-session-epoch-secret-0123456789";
  const key = deriveKey(secret, channel);

  // ① 证明 v2 自洽 + 验签
  const proof = makeProof(key, "host", channel, { e: 3, ts: 1760000000123, pv: PROOF_VERSION, sid: "a1b2c3d4" });
  check("证明 v2 字段齐全", proof.e === 3 && proof.ts === 1760000000123 && proof.pv === 2 && proof.sid === "a1b2c3d4" && typeof proof.sig === "string", JSON.stringify(proof));
  check("证明 v2 验签通过", verifyProof(key, "host", channel, proof) === true);
  check("证明 v2 换 role 验签失败", verifyProof(key, "client", channel, proof) === false);
  check("证明 v2 篡改 e 后验签失败", verifyProof(key, "host", channel, { ...proof, e: 4 }) === false);
  check("证明 v2 篡改 sid 后验签失败", verifyProof(key, "host", channel, { ...proof, sid: "ffffffff" }) === false);

  // ③ 换 sid 解密必须失败（加固 AAD = "dshrc|role|seq|sid"）
  const hardData = seal(key, "host", 7, { hello: "v113" }, undefined, "a1b2c3d4");
  check("加固模式往返（同一 sid 可解密）", open(key, "host", 7, hardData, "a1b2c3d4").hello === "v113");
  let sidSwapFailed = false;
  try {
    open(key, "host", 7, hardData, "ffffffff");
  } catch {
    sidSwapFailed = true;
  }
  check("换 sid 解密必须失败（契约 §7 ③）", sidSwapFailed === true);

  // ② 加固模式往返（两端都 pv>=2 → 加固）
  const seenHost = [];
  const seenClient = [];
  const { host, client } = createLoopbackPair({
    channel,
    secret,
    onHostMessage: (m) => seenHost.push(m),
    onClientMessage: (m) => seenClient.push(m),
  });
  check("回环两端都进入加固模式", host.mode === "hardened" && client.mode === "hardened", host.mode + "/" + client.mode);
  check("回环两端互钉对方 sid", host.peerSid === client.sid && client.peerSid === host.sid, host.peerSid + "/" + client.sid);
  client.send({ id: "x1", type: "ping", ts: Date.now(), payload: { n: 1 } });
  await new Promise((r) => setTimeout(r, 50));
  check("加固模式业务帧往返成功", seenHost.length === 1 && seenHost[0]?.payload?.n === 1, JSON.stringify(seenHost));

  // ⑤ 收到的帧 sid 与钉扎值不符 → 丢弃
  let delivered = null;
  client.opts.onMessage = (m) => {
    delivered = m;
  };
  const badSeq = 900;
  const badData = seal(key, "host", badSeq, { hello: "mismatch" }, undefined, host.sid);
  client._deliver(badData, badSeq, "host", "ffffffff");
  check("sid 不匹配的帧被丢弃（契约 §7 ⑤）", delivered === null, JSON.stringify(delivered));
  client._deliver(badData, badSeq, "host", host.sid);
  check("sid 匹配的帧正常解出", delivered !== null && delivered.hello === "mismatch", JSON.stringify(delivered));

  // ④ 纪元回退被拒 + 同一证明重复幂等接受
  const store = new EpochStore(null);
  const p5 = makeProof(key, "client", channel, { e: 5, ts: 1000, pv: 2, sid: "11111111" });
  const p4 = makeProof(key, "client", channel, { e: 4, ts: 2000, pv: 2, sid: "22222222" });
  const acc1 = store.acceptPeer("host", p5);
  check("对端纪元首次接受", acc1.ok === true && acc1.duplicate === false, JSON.stringify(acc1));
  const acc2 = store.acceptPeer("host", p5);
  check("同一证明重复出现 → 幂等接受", acc2.ok === true && acc2.duplicate === true, JSON.stringify(acc2));
  const acc3 = store.acceptPeer("host", p4);
  check("纪元回退（e 更小）→ 拒绝", acc3.ok === false && acc3.reason === "epoch-regression", JSON.stringify(acc3));
  const p5bis = makeProof(key, "client", channel, { e: 5, ts: 1000, pv: 2, sid: "33333333" });
  const acc4 = store.acceptPeer("host", p5bis);
  check("同纪元但 sid 不同（疑似重放）→ 拒绝", acc4.ok === false && acc4.reason === "epoch-regression", JSON.stringify(acc4));

  // ④b 链路层：纪元回退 → **拒绝连接**（不是只丢帧）
  const storeA = new EpochStore(null);
  const storeB = new EpochStore(null);
  // client 侧先接受过一个「纪元 10」的对端证明
  const highProof = makeProof(key, "host", channel, { e: 10, ts: 1, pv: 2, sid: "aaaaaaaa" });
  storeB.acceptPeer("host", highProof);
  let rejectedStatus = "";
  const { host: h2, client: c2 } = createLoopbackPair({
    channel,
    secret,
    hostEpochStore: storeA,
    clientEpochStore: storeB,
    onStatus: (s) => {
      if (String(s).includes("epoch")) rejectedStatus = String(s);
    },
  });
  check("链路层纪元回退 → 拒绝连接", c2.closed === true && rejectedStatus.includes("epoch"), `closed=${c2.closed} status=${rejectedStatus}`);
  h2.close();
  c2.close();

  // ⑥ 纪元持久化：换一个 store（模拟进程重启）后继续递增
  const epochFile = join(tmpdir(), `dshrc-e2e-kat-epoch-${process.pid}.json`);
  const s1 = new EpochStore(epochFile);
  const e1 = s1.next();
  const s2 = new EpochStore(epochFile); // 模拟重启
  const e2 = s2.next();
  check("纪元持久化：重启后继续递增", e2 === e1 + 1, `${e1} → ${e2}`);
  try {
    unlinkSync(epochFile);
  } catch {
    /* ignore */
  }

  host.close();
  client.close();
  console.log("v1.1.3 loopback case: PASS");
}

/**
 * v1.1.3 中继侧用例（真实 relay 进程，临时端口 / 临时 channel，不碰真实链路）：
 *   - welcome.peer / peer-joined.peer **逐字**复制对端证明
 *   - 中继**不校验 sig**（错的 sig 也能连上）
 *   - 双方 pv>=2 → 加固模式，业务帧经真实中继往返成功
 */
async function v113RelayCase() {
  console.log("");
  console.log("--- v1.1.3 relay proof-passthrough case (real relay, temp port) ---");
  const channel = "E2EPROOFCANAL2345";
  const secret = "e2e-v113-relay-secret-0123456789";
  const key = deriveKey(secret, channel);

  // 起一个临时中继（PORT=0 → 内核分配端口）
  const child = spawn(process.execPath, [RELAY_SERVER], {
    cwd: join(HERE, "..", "relay"),
    env: { ...process.env, PORT: "0", LOG_LEVEL: "error" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay start timeout: " + out)), 5000);
    child.stdout.on("data", () => {
      const m = out.match(/relay listening port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("relay exited early: code=" + code + " " + out));
    });
  });
  const relayUrl = `ws://127.0.0.1:${port}`;

  try {
    const hostGot = [];
    const clientGot = [];
    const hostLink = new RelayLink({
      relayUrl,
      channel,
      secret,
      role: "host",
      epochFile: join(tmpdir(), `dshrc-e2e-v113-relay-epoch-host-${process.pid}.json`),
      onStatus: () => {},
      onMessage: (m) => hostGot.push(m),
    });
    await waitUntil(() => hostLink.proof !== null, 3000);
    await waitUntil(() => hostLink.peerProof !== null || hostLink.mode !== "compat", 3000);
    // host 先上线：对端不在线 → welcome 不带 peer
    check("中继：对端不在线时 welcome 不带 peer", hostLink.peerProof === null, JSON.stringify(hostLink.peerProof));

    const clientLink = new RelayLink({
      relayUrl,
      channel,
      secret,
      role: "client",
      epochFile: join(tmpdir(), `dshrc-e2e-v113-relay-epoch-client-${process.pid}.json`),
      onStatus: () => {},
      onMessage: (m) => clientGot.push(m),
    });
    await waitUntil(() => clientLink.peerProof !== null, 5000);
    await waitUntil(() => hostLink.peerProof !== null, 5000);

    // 证明逐字一致（e/ts/pv/sid/sig 全等）
    const cp = clientLink.peerProof;
    const hp = hostLink.peerProof;
    check("welcome.peer 逐字复制对端证明", cp.role === "host" && cp.e === hostLink.proof.e && cp.ts === hostLink.proof.ts && cp.pv === hostLink.proof.pv && cp.sid === hostLink.proof.sid && cp.sig === hostLink.proof.sig, JSON.stringify(cp));
    check("peer-joined.peer 逐字复制新上线方证明", hp.role === "client" && hp.e === clientLink.proof.e && hp.ts === clientLink.proof.ts && hp.pv === clientLink.proof.pv && hp.sid === clientLink.proof.sid && hp.sig === clientLink.proof.sig, JSON.stringify(hp));
    check("对端证明验签通过", verifyProof(key, "host", channel, cp) === true && verifyProof(key, "client", channel, hp) === true);
    check("双方 pv>=2 → 加固模式", clientLink.mode === "hardened" && hostLink.mode === "hardened", clientLink.mode + "/" + hostLink.mode);

    // 经真实中继的业务帧往返（加固 AAD）
    clientLink.send({ id: "r1", type: "ping", ts: Date.now(), payload: { via: "relay" } });
    await waitUntil(() => hostGot.length > 0, 3000);
    check("经真实中继的业务帧往返成功（加固 AAD）", hostGot.length === 1 && hostGot[0]?.payload?.via === "relay", JSON.stringify(hostGot));

    hostLink.close();
    clientLink.close();
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  console.log("v1.1.3 relay case: PASS");
}

/** 等条件成立（最多 timeoutMs） */
async function waitUntil(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

try {
  if (loopbackOnly) {
    // 只跑回环用例：手机在线也安全（不连真实中继、不占真实 channel）
    await v106LoopbackCase();
    await v120AttachmentLoopbackCase();
    await v130LoopbackCase();
    await v113ProofCase();
    await v113RelayCase();
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
  await v120AttachmentLoopbackCase();
  await v130LoopbackCase();
  await v113ProofCase();
  await v113RelayCase();
  await v106LiveProbe();

  console.log("event counts:", JSON.stringify([...events]));
  console.log("E2E RESULT: PASS");
  done = true;
  link.close();
  process.exit(0);
} catch (e) {
  if (!done) fail(e?.message ?? String(e));
}
