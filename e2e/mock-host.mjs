// e2e/mock-host.mjs — 模拟 DSH 插件端（host 角色）：用于在没有真实 DSH 的情况下
// 测试中继与 HarmonyOS App。业务消息 schema 见契约 §5。
// 用法: node mock-host.mjs wss://relay.example.com/ws CHANNEL SECRET [RELAY_TOKEN]
//   RELAY_TOKEN：中继配置了鉴权（契约 §4）时必填，否则握手被拒 bad-hello。
//
// v1.0.6：支持 session.capabilities（模式/权限目录）、session.create 的
// agentPreset / permission、session.history 的 steps，以及 tool.call /
// tool.result 事件推送（契约 §5.2 / §5.7 / §5.8）。
// v1.1.4：system.message 事件**已移除**（宿主 system/developer 消息是提示词组装
// 记录，不是对话内容，PC 聊天视图从不展示）。
// v1.0.7：追加模型目录（capabilities.models / defaultModelId）、真实归档
// （session.archive / session.unarchive / session.archives 广播 / list 的 archived）、
// 以及思考过程（assistant.reasoningDelta 事件 + 历史 role:"reasoning" 消息）。
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { RelayLink, msg } from "./link.mjs";

/** mock 的模式目录（宿主 Agent preset 的等价物）。 */
export const MOCK_PRESETS = [
  { id: "standard", name: "Standard", description: "标准模式" },
  { id: "creator", name: "Creator", description: "创作模式" },
];

/** mock 的权限目录（宿主 permission preset 的等价物）。 */
export const MOCK_PERMISSIONS = [
  { id: "read-only", name: "只读", description: "仅可查看" },
  { id: "workspace-write", name: "工作区内修改", description: "工作区内可修改" },
];

/** mock 的模型目录（宿主 modelCatalog 的等价物；id = provider/model）。 */
export const MOCK_MODELS = [
  {
    id: "deepseek/deepseek-chat",
    provider: "deepseek",
    model: "deepseek-chat",
    name: "DeepSeek Chat",
    description: "通用对话",
    reasoningEffort: "high",
    efforts: [
      { id: "minimal", name: "最少", description: "" },
      { id: "low", name: "低", description: "" },
      { id: "medium", name: "中", description: "" },
      { id: "high", name: "高", description: "" },
    ],
  },
  { id: "zai/glm-4.6", provider: "zai", model: "glm-4.6", name: "GLM 4.6", description: "" },
];

export const MOCK_DEFAULT_PRESET = "standard";
/**
 * 默认权限。默认仍是 `read-only`（与 v1.0.7 起的行为一致），
 * 需要验证「可写会话」路径（如手机端权限切换 + 发消息闭环）时用
 * `MOCK_PERMISSION=workspace-write node mock-host.mjs …` 覆盖。
 */
export const MOCK_DEFAULT_PERMISSION = process.env.MOCK_PERMISSION || "read-only";
export const MOCK_DEFAULT_MODEL = "deepseek/deepseek-chat";

/**
 * `MOCK_PROMPT_RESULT_LAST=1`：**把 session.prompt 的 accepted 回包挪到流式回复之后**。
 *
 * 插件端 `#rSessionPrompt` 是先 await 宿主 prompt、之后才回 accepted → 手机的
 * `assistant.delta` 可能**先于** prompt 回包到达（契约 §5.1：回包与直播事件是两条独立的时序）。
 * 默认（先回 accepted）复现不出这个顺序，客户端「等 accepted 再上屏」的写法就会把用户气泡
 * 插进流式回复中间（一条回复被切成两个气泡）。打开这个开关即可让联调用例**稳定复现**该顺序。
 */
export const MOCK_PROMPT_RESULT_LAST = process.env.MOCK_PROMPT_RESULT_LAST === "1";

/** v1.2.0（契约 §5.11.1）：mock 声明与插件一致的附件目录。 */
export const MOCK_ATTACHMENT_CAPS = {
  supported: true,
  maxCount: 9,
  maxItemBytes: 20 * 1024 * 1024,
  maxMessageBytes: 40 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  imageMediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

function resultOf(m, value) {
  return msg("result", { id: m.id, ok: true, value });
}
function errorOf(m, code, message) {
  return msg("result", { id: m.id, ok: false, error: { code, message } });
}

/** 内容块 → 纯文本（契约 §5.7 口径：text 拼接，image/file 占位符；忽略 reasoning）。 */
function contentText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "image") text += "[图片]";
    else if (block.type === "file") text += "[文件]";
  }
  return text;
}

/** v1.2.0（契约 §5.11.4）：正文口径——图片/文件都独立渲染，不写占位符。 */
function messageText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/** v1.2.0：图片块 → wire ImageRef（mock 无缩略图字节，thumb 留空）。 */
function imageRefsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "image") continue;
    const a = block.attachment;
    if (!a || typeof a !== "object" || typeof a.attachmentId !== "string") continue;
    out.push({
      imageId: a.attachmentId,
      mediaType: typeof a.mediaType === "string" ? a.mediaType : "",
      width: Number.isSafeInteger(a.width) ? a.width : 0,
      height: Number.isSafeInteger(a.height) ? a.height : 0,
      bytes: Number.isSafeInteger(a.bytes) ? a.bytes : 0,
      thumb: "",
    });
  }
  return out;
}

/** v1.2.0：文件块 → wire FileRef。 */
function fileRefsOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "file") continue;
    const a = block.attachment;
    if (!a || typeof a !== "object" || typeof a.attachmentId !== "string") continue;
    if (typeof a.name !== "string" || a.name === "") continue;
    out.push({
      fileId: a.attachmentId,
      name: a.name,
      bytes: Number.isSafeInteger(a.bytes) ? a.bytes : 0,
    });
  }
  return out;
}

/** 思考块 → 纯文本（契约 §5.3：独立成 role:"reasoning" 的消息）。 */
function reasoningText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "reasoning" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * mock 会话 → 契约 §5.1 session.history 的 {messages, steps, hasMore, oldestSeq}。
 * 与插件侧同一口径：tool/call 与 tool/result 按 callId 配对成一条 StepRecord。
 */
export function mockHistory(session) {
  const messages = [];
  const steps = [];
  const byCall = new Map();
  for (const ev of session.events ?? []) {
    if (!ev || typeof ev !== "object") continue;
    const seq = Number(ev.seq);
    const ts = Number(ev.time) || 0;
    const data = ev.data ?? {};
    if (ev.type === "user/message" || ev.type === "assistant/message") {
      const content =
        ev.type === "user/message" ? data.content : data?.message?.content;
      // v1.0.7：思考块独立成条，排在正文之前（§5.3）
      if (ev.type === "assistant/message") {
        const thinking = reasoningText(content);
        if (thinking.trim() !== "") {
          messages.push({
            id: `${session.sessionId}:${seq}:reasoning`,
            role: "reasoning",
            text: thinking,
            ts,
            seq,
          });
        }
      }
      // v1.2.0：正文与图片/文件都独立映射（纯附件消息也要成条）
      const text = messageText(content);
      const images = imageRefsOf(content);
      const files = fileRefsOf(content);
      if (text.trim() === "" && images.length === 0 && files.length === 0) continue;
      const mapped = {
        id: `${session.sessionId}:${seq}`,
        role: ev.type === "user/message" ? "user" : "assistant",
        text,
        ts,
        seq,
      };
      if (images.length > 0) mapped.images = images;
      if (files.length > 0) mapped.files = files;
      messages.push(mapped);
      continue;
    }
    if (ev.type === "tool/call") {
      const rec = {
        seq,
        callId: data.callId,
        name: data.name ?? "",
        arguments: typeof data.arguments === "string" ? data.arguments : "",
        status: "running",
        resultText: "",
        errorText: "",
        ts,
        turn: data.turn ?? 0,
        step: data.step ?? 0,
      };
      byCall.set(data.callId, rec);
      steps.push(rec);
      continue;
    }
    if (ev.type === "tool/result") {
      const callId = data?.message?.toolCallId;
      if (typeof callId !== "string") continue;
      const isError = data.message?.isError === true;
      const resultText = contentText(data.message?.content);
      const reason = data.error?.reason;
      const errorText =
        reason === undefined || reason === null ? (isError ? resultText : "") : String(reason);
      const rec = byCall.get(callId);
      if (rec !== undefined) {
        rec.status = isError ? "error" : "ok";
        rec.resultText = resultText;
        rec.errorText = errorText;
      } else {
        byCall.set(callId, {
          seq,
          callId,
          name: "",
          arguments: "",
          status: isError ? "error" : "ok",
          resultText,
          errorText,
          ts,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
        });
        steps.push(byCall.get(callId));
      }
      continue;
    }
    // system/message / developer/message → 只进事件流，不进 messages
  }
  steps.sort((a, b) => a.seq - b.seq);
  let oldest = Number.MAX_SAFE_INTEGER;
  for (const m of messages) if (m.seq < oldest) oldest = m.seq;
  return { messages, steps, hasMore: false, oldestSeq: oldest === Number.MAX_SAFE_INTEGER ? 0 : oldest };
}

/**
 * 建一个 mock host（可注入任意 link：RelayLink 或 LoopbackLink）。
 * @param {{link:{send:(m:any,urgent?:boolean)=>any}, log?:(s:string)=>void}} deps
 */
export function createMockHost(deps) {
  const link = deps.link;
  const log = deps.log ?? (() => {});
  const sessions = new Map([
    [
      "s-demo-1",
      {
        sessionId: "s-demo-1",
        title: "示例会话",
        cwd: "D:/demo",
        running: false,
        updatedAt: Date.now(),
        agentPreset: MOCK_DEFAULT_PRESET,
        permission: MOCK_DEFAULT_PERMISSION,
        events: [],
        // v1.0.5（§5.6）：父会话的直接子代理目录（mock 造一条，覆盖客户端子代理目录 UI）
        subagents: [
          {
            sessionId: "s-demo-1:sub-1",
            label: "fix-login",
            mode: "continuable",
            running: false,
            hasChildren: false,
            createdAt: Date.now() - 60_000,
          },
          {
            sessionId: "s-demo-1:sub-2",
            label: "",
            mode: "one-shot",
            running: false,
            hasChildren: false,
            createdAt: Date.now() - 30_000,
          },
        ],
        // v1.1.2（§5.1）：当前待执行消息（全量快照）
        queue: [],
      },
    ],
  ]);
  let askSeq = 0;
  const pendingAsks = new Map(); // askId -> {resolve}
  let eventSeq = 0;
  /** v1.0.7：真实归档集合（对应宿主 workspaceRegistry.archivedSessionIds）。 */
  const archivedSessionIds = new Set();
  // v1.2.0（§5.11）：附件分块上传（内存态，mock 用，不落盘）
  /** uploadId -> {sessionId,kind,name,mediaType,bytes,received,chunks} */
  const uploads = new Map();
  /** uploadId -> {sessionId,kind,name,mediaType,attachment}（已提交、可用一次） */
  const stagedAttachments = new Map();
  /** 已被 prompt 消费的 uploadId（重复使用回 attachment-upload-consumed） */
  const consumedUploads = new Set();
  let uploadSeq = 0;
  const ATTACHMENT_IMAGE_TYPES = MOCK_ATTACHMENT_CAPS.imageMediaTypes;

  /** 图片尺寸（PNG/GIF/JPEG 最小解析；失败回 0×0）。 */
  const imageDimensions = (buf, mediaType) => {
    try {
      if (mediaType === "image/png" && buf.length >= 24) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (mediaType === "image/gif" && buf.length >= 10) {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (mediaType === "image/jpeg") {
        let off = 2;
        while (off + 9 < buf.length) {
          if (buf[off] !== 0xff) return { width: 0, height: 0 };
          const marker = buf[off + 1];
          const size = buf.readUInt16BE(off + 2);
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
          }
          off += 2 + size;
        }
      }
    } catch {
      /* 解析失败回 0 */
    }
    return { width: 0, height: 0 };
  };

  /** 附件请求统一错误（code 与契约 §5.11.5 对齐）。 */
  const attachError = (m, code, message) => link.send(errorOf(m, code, message));

  /** 解析一个 uploadId 对应的**已提交**附件（消费前检查会话归属）。 */
  const takeStaged = (sessionId, uploadId) => {
    if (consumedUploads.has(uploadId)) return { error: ["attachment-upload-consumed", "该附件已用于上一条消息"] };
    const staged = stagedAttachments.get(uploadId);
    if (staged === undefined) return { error: ["attachment-upload-not-found", "附件上传记录不存在或已过期"] };
    if (staged.sessionId !== sessionId) return { error: ["attachment-upload-not-found", "附件不属于该会话"] };
    return { staged };
  };

  /** 记一条会话事件（进历史）。 */
  const record = (session, type, data, time) => {
    session.events.push({ type, seq: ++eventSeq, time: time ?? Date.now(), data });
  };

  /**
 * 推一条 wire 事件（契约 §5.2 的 topic），并把**宿主形状**的事件记入会话历史。
 * @param {object} session
 * @param {string} topic wire topic（tool.call / tool.result）
 * @param {object} wireData 推给手机的事件 data
 * @param {string} historyType 宿主事件类型（tool/call …）
 * @param {object} historyData 宿主事件 data（历史回放用）
 */
  const emit = (session, topic, wireData, historyType, historyData) => {
    record(session, historyType, historyData);
    link.send(msg("event", { topic, data: wireData }));
  };

  /**
   * 演示推送（`MOCK_PUSH_DEMO=1` 开启，默认关）：
   * 连接稳定后给每个会话推一条**带 markdown 语法**的助手消息，
   * 供各端 App 验证 markdown 渲染（流式气泡 + 代码块）。
   */
  if (process.env.MOCK_PUSH_DEMO === "1") {
    const pushDemo = () => {
      for (const s of sessions.values()) {
        const text =
          "**markdown 渲染验证**：这条消息由 mock host 主动推送。\n\n" +
          "- 列表项 A\n" +
          "- 列表项 B\n\n" +
          "```\n代码块\n```\n";
        link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text } }));
      }
    };
    setTimeout(pushDemo, 3_000);
    setInterval(pushDemo, 20_000);
  }

  /** v1.0.7（§5.9）：广播归档全集（对应宿主的 domain/changed 触发）。 */
  const broadcastArchives = () => {
    link.send(
      msg("event", {
        topic: "session.archives",
        data: { archivedSessionIds: [...archivedSessionIds] },
      }),
    );
  };

  /** v1.0.8：设置会话模型并广播 session.modelChanged（对应宿主的 model/selection 事件）。 */
  const applyModel = (session, selection) => {
    session.model = { ...selection };
    link.send(
      msg("event", {
        topic: "session.modelChanged",
        data: { sessionId: session.sessionId, model: { ...selection } },
      }),
    );
  };

  /** 宿主口径的 selection 校验：provider/model 必填，模型必须在目录里。 */
  const knownModel = (provider, model) =>
    MOCK_MODELS.find((x) => x.provider === provider && x.model === model);

  const handle = async (m) => {
    const p = m.payload ?? {};
    switch (m.type) {
      case "hello":
        return link.send(resultOf(m, { hostName: "mock-host", dshVersion: "0.2.x-mock", pluginVersion: "1.0.0-mock" }));
      case "ping":
        return link.send(resultOf(m, { pong: Date.now() }));
      case "session.list":
        return link.send(
          resultOf(m, {
            sessions: [...sessions.values()].map((s) => ({
              ...s,
              archived: archivedSessionIds.has(s.sessionId),
            })),
          }),
        );
      case "session.capabilities":
        // 契约 §5.8/§5.9：模式 + 权限 + 模型目录 + 归档能力标记
        return link.send(
          resultOf(m, {
            presets: MOCK_PRESETS.map((x) => ({ ...x })),
            permissions: MOCK_PERMISSIONS.map((x) => ({ ...x })),
            defaultPreset: MOCK_DEFAULT_PRESET,
            defaultPermission: MOCK_DEFAULT_PERMISSION,
            models: MOCK_MODELS.map((x) => ({ ...x })),
            defaultModelId: MOCK_DEFAULT_MODEL,
            archiveSupported: true,
            attachments: { ...MOCK_ATTACHMENT_CAPS, imageMediaTypes: [...MOCK_ATTACHMENT_CAPS.imageMediaTypes] },
          }),
        );
      case "session.create": {
        const agentPreset = typeof p.agentPreset === "string" ? p.agentPreset : "";
        if (agentPreset !== "" && !MOCK_PRESETS.some((x) => x.id === agentPreset)) {
          // 与宿主一致：未知 preset → 客户端回退成「不带选项」重试
          return link.send(errorOf(m, "unsupported-agent-preset", `Unknown agent preset: ${agentPreset}`));
        }
        const id = "s-" + Math.random().toString(36).slice(2, 8);
        const s = {
          sessionId: id,
          title: p.title || "新会话",
          cwd: p.cwd || "D:/demo",
          running: false,
          updatedAt: Date.now(),
          agentPreset: agentPreset !== "" ? agentPreset : MOCK_DEFAULT_PRESET,
          permission: typeof p.permission === "string" && p.permission !== "" ? p.permission : MOCK_DEFAULT_PERMISSION,
          events: [],
        };
        sessions.set(id, s);
        link.send(msg("event", { topic: "session.added", data: { session: s } }));
        const value = { sessionId: id };
        if (agentPreset !== "") value.agentPreset = agentPreset;
        // v1.0.7：模型选择——未知模型**不回 error**（会话已创建），只附 modelError
        const model = p.model;
        if (model && typeof model === "object") {
          const known = knownModel(model.provider, model.model);
          if (known) {
            const selection = {
              provider: String(model.provider),
              model: String(model.model),
              ...(typeof model.reasoningEffort === "string" && model.reasoningEffort !== ""
                ? { reasoningEffort: model.reasoningEffort }
                : {}),
            };
            value.model = { ...selection };
            // v1.0.8：选模型即会话模型变化（对应宿主的 model/selection 事件）
            applyModel(s, selection);
          } else {
            value.modelError = `model not available: ${model.provider}/${model.model}`;
          }
        }
        return link.send(resultOf(m, value));
      }
      case "session.selectModel": {
        // v1.0.8：会话中切换模型/思考强度
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        const model = p.model;
        if (!model || typeof model !== "object" || !model.provider || !model.model) {
          return link.send(errorOf(m, "bad-params", "invalid model selection"));
        }
        const known = knownModel(model.provider, model.model);
        if (!known) {
          return link.send(
            errorOf(m, "session/model-unavailable", `model not available: ${model.provider}/${model.model}`),
          );
        }
        const selection = { provider: String(model.provider), model: String(model.model) };
        if (typeof model.reasoningEffort === "string" && model.reasoningEffort !== "") {
          selection.reasoningEffort = model.reasoningEffort;
        }
        applyModel(s, selection);
        return link.send(resultOf(m, { model: { ...selection } }));
      }
      case "session.queue": {
        // v1.1.2（§5.1）：拉取该会话**当前**待执行消息的全量快照（断线重连补状态）
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, { sessionId, items: Array.isArray(s.queue) ? s.queue : [] }));
      }
      case "session.subagents": {
        // v1.0.5（§5.6）：父会话的直接子代理目录
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, { subagents: Array.isArray(s.subagents) ? s.subagents : [] }));
      }
      case "session.model": {
        // v1.0.8：查询会话当前模型/思考强度（没有则 null）
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, { model: s.model ? { ...s.model } : null }));
      }
      case "session.permission": {
        // 契约 §5.8：查询会话有效当前权限（无则 null）
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, { permission: typeof s.permission === "string" ? s.permission : null }));
      }
      case "session.selectPermission": {
        // 契约 §5.8：提交权限选择 → 广播 session.permissionChanged（客户端据此刷新显示）
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        const s = sessions.get(sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        const permission = typeof p.permission === "string" ? p.permission : "";
        if (!MOCK_PERMISSIONS.some((x) => x.id === permission)) {
          return link.send(errorOf(m, "bad-params", `invalid permission: ${permission}`));
        }
        s.permission = permission;
        link.send(msg("event", { topic: "session.permissionChanged", data: { sessionId, permission } }));
        return link.send(resultOf(m, { permission }));
      }
      case "session.archive": {
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        if (!sessions.has(sessionId)) {
          return link.send(
            errorOf(m, "workspace/unknown-session", `unknown session: ${sessionId}`),
          );
        }
        archivedSessionIds.add(sessionId);
        broadcastArchives();
        return link.send(resultOf(m, { sessionId, archived: true }));
      }
      case "session.unarchive": {
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        if (sessionId === "") return link.send(errorOf(m, "bad-params", "sessionId required"));
        archivedSessionIds.delete(sessionId);
        broadcastArchives();
        return link.send(resultOf(m, { sessionId, archived: false }));
      }
      case "session.history": {
        const s = sessions.get(p.sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        return link.send(resultOf(m, mockHistory(s)));
      }
      case "session.rename": {
        const s = sessions.get(p.sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        s.title = p.title;
        return link.send(resultOf(m, { title: s.title }));
      }
      case "session.prompt": {
        const s = sessions.get(p.sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        // v1.2.0（§5.11.3）：先校验/消费 uploads，再回 accepted（绝不假成功）
        const promptText = typeof p.text === "string" ? p.text : "";
        const uploadIds = Array.isArray(p.uploads) ? p.uploads : [];
        if (promptText.trim() === "" && uploadIds.length === 0) {
          return attachError(m, "attachment-bad-params", "text or uploads required");
        }
        if (uploadIds.length > MOCK_ATTACHMENT_CAPS.maxCount) {
          return attachError(m, "attachment-too-many", "附件过多");
        }
        // 先全量校验（任一失败则整条 prompt 拒绝，绝不消费一部分附件）
        const resolved = [];
        for (const uploadId of uploadIds) {
          const found = takeStaged(s.sessionId, uploadId);
          if (found.error !== undefined) return attachError(m, found.error[0], found.error[1]);
          resolved.push({ uploadId, staged: found.staged });
        }
        const content = [];
        if (promptText.trim() !== "") content.push({ type: "text", text: promptText });
        for (const { uploadId, staged } of resolved) {
          const attachment = staged.attachment;
          if (staged.kind === "image") {
            const image = {
              attachmentId: attachment.attachmentId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              width: attachment.width,
              height: attachment.height,
            };
            if (typeof attachment.name === "string") image.name = attachment.name;
            content.push({ type: "image", attachment: image });
          } else {
            content.push({ type: "file", attachment: { ...attachment } });
          }
          stagedAttachments.delete(uploadId);
          consumedUploads.add(uploadId);
        }
        if (!MOCK_PROMPT_RESULT_LAST) link.send(resultOf(m, { accepted: true }));
        s.running = true;
        link.send(msg("event", { topic: "session.status", data: { sessionId: s.sessionId, running: true } }));
        // 用户输入进历史（正文 + 图片/文件附件块）
        record(s, "user/message", { source: { kind: "user" }, content });
        // v1.0.6：工具调用/结果（§5.2 / §5.7）
        // v1.1.4：不再发 system.message——宿主 system/developer 消息是提示词组装
        // 记录，不是对话内容（PC 聊天视图从不展示），协议已移除该 topic。
        const callId = "call-" + Math.random().toString(36).slice(2, 8);
        const now = Date.now();
        const args = JSON.stringify({ command: "echo hello" });
        emit(
          s,
          "tool.call",
          { sessionId: s.sessionId, callId, name: "bash", arguments: args, ts: now },
          "tool/call",
          { turn: 1, step: 1, callId, name: "bash", arguments: args },
        );
        emit(
          s,
          "tool.result",
          { sessionId: s.sessionId, callId, status: "ok", resultText: "hello", errorText: "", ts: now },
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: { role: "tool", toolCallId: callId, content: [{ type: "text", text: "hello" }] },
          },
        );
        // v1.0.7：思考增量（§5.2 assistant.reasoningDelta，与正文分流）
        link.send(
          msg("event", {
            topic: "assistant.reasoningDelta",
            data: { sessionId: s.sessionId, text: "mock: 思考中…" },
          }),
        );
        // 流式回复
        // 流式回复（带 markdown 语法：给各端验证 markdown 渲染用）
        const reply =
          `已收到：**${promptText.trim() !== "" ? promptText : "（附件）"}**。\n\n` +
          `- 这是 mock-host 的流式回复\n` +
          `- 用于验证 **markdown** 渲染\n\n` +
          "```\n代码块走同一套渲染\n```";
        for (const ch of reply.match(/.{1,8}/g) ?? []) {
          link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text: ch } }));
          await new Promise((r) => setTimeout(r, 60));
        }
        // MOCK_PROMPT_RESULT_LAST=1：accepted 回包挪到流式回复之后（复现插件端的真实顺序）
        if (MOCK_PROMPT_RESULT_LAST) link.send(resultOf(m, { accepted: true }));
        // 历史里带一条 reasoning 块（§5.3：独立成 role:"reasoning" 的消息）
        record(s, "assistant/message", {
          turn: 1,
          step: 2,
          message: {
            content: [
              { type: "reasoning", text: "mock: 思考中…" },
              { type: "text", text: reply },
            ],
          },
        });
        // 文本含 "approve" 触发一次审批问答演示
        if (/approve/i.test(promptText)) {
          const askId = "ask-" + ++askSeq;
          link.send(msg("event", { topic: "approval.request", data: { askId, sessionId: s.sessionId, toolName: "bash", reason: "mock: 运行一条命令", argsPreview: 'echo "hello"', timeoutMs: 120000 } }), true);
          const decision = await new Promise((resolve) => {
            pendingAsks.set(askId, resolve);
            setTimeout(() => {
              if (pendingAsks.has(askId)) {
                pendingAsks.delete(askId);
                resolve("timeout");
              }
            }, 120000);
          });
          link.send(msg("event", { topic: "approval.resolved", data: { askId, decision: decision === "timeout" ? "pending" : decision, source: decision === "timeout" ? "timeout" : "phone" } }));
          link.send(msg("event", { topic: "assistant.delta", data: { sessionId: s.sessionId, text: `\n[审批结果: ${decision}]` } }));
        }
        s.running = false;
        link.send(msg("event", { topic: "turn.end", data: { sessionId: s.sessionId, status: "idle" } }));
        link.send(msg("event", { topic: "session.status", data: { sessionId: s.sessionId, running: false } }));
        return;
      }
      case "attachment.upload.begin": {
        const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
        const kind = p.kind;
        const bytes = p.bytes;
        if (sessionId === "") return attachError(m, "attachment-bad-params", "sessionId required");
        if (kind !== "image" && kind !== "file") return attachError(m, "attachment-bad-params", "kind must be image or file");
        if (!Number.isSafeInteger(bytes) || bytes < 0) return attachError(m, "attachment-bad-params", "bytes must be a non-negative safe integer");
        if (bytes > MOCK_ATTACHMENT_CAPS.maxItemBytes) return attachError(m, "attachment-too-large", "附件过大");
        const name = typeof p.name === "string" ? p.name.split(/[\/]/).pop() : "";
        let mediaType = "";
        if (kind === "image") {
          if (!ATTACHMENT_IMAGE_TYPES.includes(p.mediaType)) return attachError(m, "attachment-bad-params", "图片 mediaType 非法");
          mediaType = p.mediaType;
        } else if (name === "") {
          return attachError(m, "attachment-bad-params", "文件附件必须带 name");
        }
        if (uploads.size >= 4) return attachError(m, "attachment-too-many", "未完成上传过多");
        const uploadId = "up-" + ++uploadSeq;
        uploads.set(uploadId, { sessionId, kind, name, mediaType, bytes, received: 0, chunks: [] });
        return link.send(resultOf(m, { uploadId, chunkBytes: MOCK_ATTACHMENT_CAPS.chunkBytes }));
      }
      case "attachment.upload.chunk": {
        const rec = uploads.get(p.uploadId);
        if (rec === undefined) return attachError(m, "attachment-upload-not-found", "上传不存在或已过期");
        if (!Number.isSafeInteger(p.index) || p.index !== rec.chunks.length) {
          return attachError(m, "attachment-chunk-mismatch", "分块序号不连续");
        }
        if (typeof p.data !== "string" || p.data === "") return attachError(m, "attachment-bad-params", "chunk data 非法");
        const buf = Buffer.from(p.data, "base64");
        if (buf.toString("base64") !== p.data) return attachError(m, "attachment-bad-params", "chunk data 必须是 canonical base64");
        if (rec.received + buf.length > rec.bytes) return attachError(m, "attachment-chunk-mismatch", "分块超过声明字节数");
        rec.chunks.push(buf);
        rec.received += buf.length;
        return link.send(resultOf(m, { received: rec.received }));
      }
      case "attachment.upload.commit": {
        const rec = uploads.get(p.uploadId);
        if (rec === undefined) return attachError(m, "attachment-upload-not-found", "上传不存在或已过期");
        if (rec.received !== rec.bytes) return attachError(m, "attachment-chunk-mismatch", "附件未收完");
        const data = Buffer.concat(rec.chunks);
        uploads.delete(p.uploadId);
        let attachment;
        if (rec.kind === "image") {
          const dims = imageDimensions(data, rec.mediaType);
          attachment = {
            kind: "image",
            mediaType: rec.mediaType,
            bytes: data.length,
            width: dims.width,
            height: dims.height,
            attachmentId: "att-" + createHash("sha256").update(data).digest("hex").slice(0, 16),
          };
          if (rec.name !== "") attachment.name = rec.name;
        } else {
          attachment = {
            kind: "file",
            attachmentId: "sha256:" + createHash("sha256").update(data).digest("hex"),
            name: rec.name,
            bytes: data.length,
          };
        }
        stagedAttachments.set(p.uploadId, { sessionId: rec.sessionId, kind: rec.kind, attachment });
        return link.send(resultOf(m, { uploadId: p.uploadId, attachment }));
      }
      case "attachment.upload.abort": {
        const existed = uploads.delete(p.uploadId);
        return link.send(resultOf(m, { aborted: existed }));
      }
      case "session.cancel": {
        const s = sessions.get(p.sessionId);
        if (!s) return link.send(errorOf(m, "not-found", "session not found"));
        s.running = false;
        link.send(msg("event", { topic: "turn.end", data: { sessionId: s.sessionId, status: "idle" } }));
        return link.send(resultOf(m, { cancelled: true }));
      }
      case "approval.answer": {
        const resolve = pendingAsks.get(p.askId);
        if (resolve === undefined) return link.send(resultOf(m, { applied: false }));
        pendingAsks.delete(p.askId);
        resolve(p.decision);
        return link.send(resultOf(m, { applied: true }));
      }
      case "question.answer":
        return link.send(resultOf(m, { applied: true }));
      case "push.register":
        return link.send(resultOf(m, { registered: true }));
      default:
        return link.send(errorOf(m, "bad-type", "unknown type: " + m.type));
    }
  };

  return { handle, sessions, pendingAsks, log };
}

// ---------------------------------------------------------------------------
// CLI 入口（保持原用法：node mock-host.mjs <relayUrl> <channel> <secret>）
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [relayUrl, channel, secret, token] = process.argv.slice(2);
  if (!relayUrl || !channel || !secret) {
    console.error("usage: node mock-host.mjs <relayUrl> <channel> <secret> [relayToken]");
    process.exit(1);
  }

  const link = new RelayLink({
    relayUrl,
    channel,
    secret,
    token: token || undefined,
    role: "host",
    onStatus: (s) => console.log("[host] status:", s),
    onPeer: (joined, role) => console.log("[host] peer", role, joined ? "joined" : "left"),
    onMessage: (m) => {
      console.log("[host] <-", m.type, m.id ?? m.payload?.topic ?? "");
      mock.handle(m).catch((e) => {
        console.error("[host] handler error:", e);
        try {
          link.send(errorOf(m, "internal", String(e?.message ?? e)));
        } catch {
          /* ignore */
        }
      });
    },
  });
  const mock = createMockHost({ link, log: (s) => console.log("[host]", s) });
  console.log("[host] mock DSH host up. relay =", relayUrl, "channel =", channel);
}
