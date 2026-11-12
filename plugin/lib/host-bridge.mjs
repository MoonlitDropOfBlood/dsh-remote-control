// lib/host-bridge.mjs — DSH Host 服务桥接（契约 §5 业务层 / §5.5 瀑布语义 /
// §5.2 事件桥接 / §5.7 工作步骤 / §5.8 模式与权限 / §8.1 模块划分）。
//
// 四个职责：
//   1. 业务请求分发：手机 → host 的请求（§5.1），全部经
//      sessionController / 本机状态处理，每个调用点 try/catch，
//      错误统一回 result {ok:false, error:{code,message}}。
//   2. 事件桥接（§5.2）：api-session/*、agent/assistant-stream（按
//      sessionId 合并节流 ≤8 条/秒）、agent/status、agent/error、
//      session/event 总闸（v1.0.6：tool.call / tool.result / system.message）
//      → 推给手机。
//   3. 瀑布答案器（§5.5，安全关键）：approval/request 与
//      user-questions/request 以 {prepend:true} 抢占在桌面答案器之前；
//      **仅当**手机在线且开关打开才拦截；超时（默认 120s）/出错/取消
//      一律 return next() 放行，绝不 fail-closed 卡死任务；
//      迟到的手机回答回 applied:false。
//   4. 新建会话的模式与权限（§5.8）：session.capabilities 目录 +
//      session.create 的 agentPreset / permission 字段。
//   5. v1.0.9（§5.10）：会话消息里的图片——历史消息带 images[]（内联缩略图）、
//      直播 assistant.image 事件、image.fetch 拉大图。
//   6. present 工具投递的文件（deliverables/presented 事件）里的**图片**：
//      宿主把它们记成「文件路径」，不是图片附件块 → 不桥接的话手机端永远看不到
//      （用户反馈：桌面看得到、手机消息里没有）。故按扩展名认图片、读字节、
//      生成缩略图，按 §5.10 的 assistant.image / image.fetch 通道发给手机。
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { msg, sanitizeEnvelope } from "./protocol.mjs";
import { ASSISTANT_THROTTLE_PER_SEC } from "./config.mjs";
import {
  LARGE_MAX_BASE64,
  REPLY_PLAIN_MAX_BYTES,
  THUMB_DATA_URI_PREFIX,
  THUMB_PAGE_BUDGET,
  attachmentRefOf,
  clampMaxEdge,
  fitReplyBudget,
  imageBlocksOf,
  imageMetaOf,
  imageRefMeta,
  makeLarge,
  makeThumb,
  mediaTypeOfPath,
} from "./images.mjs";
import {
  ATTACHMENT_KIND_IMAGE,
  AttachmentWireError,
  UploadRegistry,
  attachmentCapabilities,
  fileRefsOfContent,
  uploadedAttachmentOf,
} from "./attachments.mjs";

/**
 * present 投递文件的字节上限（超过就不桥接：内存与带宽都不值得）。
 * 20MB 足够覆盖绝大多数截图/预览图。
 */
const DELIVERED_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 单会话待发流式文本的字符上限（正文 + 思考合计）。
 *
 * 流式缓冲按「保序队列」实现：同一 125ms 窗口内的块都受这个上限约束，
 * 超了从**最旧**的内容开始丢（保留顺序，不丢新内容），
 * 避免长时间运行 / 异常事件流把内存吃满。
 */
const STREAM_BUFFER_MAX_CHARS = 65_536;

/**
 * 单会话待发流式**块**数的上限。
 *
 * 块只在「类型切换」时新增，125ms 窗口内正常也就几条；但异常事件流
 * （重连回放 / 高频交替）不该让块数无界增长——超了从最旧的块开始丢。
 */
const STREAM_BUFFER_MAX_BLOCKS = 256;

/**
 * 单会话待执行消息的条数上限（契约 §5.2 session.queue）。
 *
 * 内存态追踪，异常事件流（重连回放等）不该把内存吃满；超了就不再记新的。
 */
const QUEUE_MAX_ITEMS = 200;

/**
 * 宿主「繁忙时的发送行为」设置的命名空间与字段（契约 §5.1 v1.1.2）。
 *
 * 与 DSH 桌面端 composer 读的是**同一处**（ui-conversation 插件的 user-settings 文档，
 * 字段 busyEnter：'queue' | 'steer'，缺省 'queue'）。
 * 手机端不提供切换——发消息走哪种行为由宿主设置决定。
 */
const BUSY_ENTER_NAMESPACE = "ui-conversation";

/**
 * present 投递文件的 imageId：`d` + sha1(path+turn) 前 16 位。
 *
 * 命名空间与宿主附件 id（随机 uuid）不冲突；同一文件在同一 turn 里稳定，
 * 重复 present 同一张图 → 同一 imageId → 手机端幂等不重复挂。
 * @param {string} path 文件绝对路径
 * @param {unknown} turn 宿主回合号
 * @returns {string} imageId
 */
function deliveredImageId(path, turn) {
  const h = createHash("sha1").update(`${path}#${String(turn ?? "")}`).digest("hex");
  return `d${h.slice(0, 16)}`;
}

/** 从本包 package.json 读版本；失败给 unknown（不抛出）。 */
function pluginVersion() {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json");
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** DSH 运行时版本（尽力而为）。 */
function dshVersion() {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@deepseek-ai/dsh/package.json");
    if (pkg && typeof pkg.version === "string") return pkg.version;
  } catch {
    /* 包可能不暴露 ./package.json */
  }
  return process.env.DSH_VERSION || "unknown";
}

/** 契约 §5.3 SessionSummary ← Host SessionSummary（title 来自投影）。
 * v1.0.4：透传 Host 原生 origin/parentSessionId/blank（§5.3 客户端据此隐藏
 * subagent 行与 blank 会话；wire 字段名与 Host 逐字一致）。
 * v1.0.5：删 archived——Host 会话域无归档概念（归档属 Workspace 注册表），
 * 之前的常量 false 是纯误导。
 * v1.0.7：archived 重新加入，但**来源改为 Workspace 注册表**
 * （ctx.workspaceRegistry.archivedSessionIds，§5.9）——由调用方以可选参数
 * 传入；不传（宿主没有注册表）时**不产出该字段**，客户端按 false 处理，
 * 不在本机伪造归档状态。 */
function mapSummary(raw, archivedIds) {
  const values = raw?.projections?.values;
  const title = values && typeof values.title === "string" ? values.title : "";
  const sessionId = String(raw?.sessionId ?? "");
  const summary = {
    sessionId,
    title,
    cwd: typeof raw?.cwd === "string" ? raw.cwd : "",
    running: raw?.running === true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    origin: raw?.origin === "subagent" ? "subagent" : "",
    parentSessionId: typeof raw?.parentSessionId === "string" ? raw.parentSessionId : "",
    blank: raw?.blank === true,
  };
  if (Array.isArray(archivedIds)) {
    summary.archived = archivedIds.includes(sessionId);
  }
  return summary;
}

/** 契约 §5.1 session.history 默认/上限页大小（宿主 DEFAULT_MAX_MESSAGES=50）。 */
const HISTORY_DEFAULT_MAX = 50;
const HISTORY_MAX_LIMIT = 200;

/**
 * 内容块 → 纯文本（契约 §5.7 / 附录 B）。
 * text 块取 text 拼接；image/file 给占位符；reasoning/tool-call 等忽略。
 *
 * 注意：这是**工具结果**口径（§5.7 StepRecord.resultText）——工具结果里的图片没有
 * 独立的渲染通道，占位符是有用信息。会话消息正文用 messageText（§5.10：图片单独渲染）。
 * @param {unknown} blocks ContentBlock[]
 * @returns {string}
 */
export function contentText(blocks) {
  if (!Array.isArray(blocks)) return "";
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "image") {
      text += "[图片]";
    } else if (block.type === "file") {
      text += "[文件]";
    }
    // reasoning / tool-call / tool-addition / tool-removal / 未知块：跳过
  }
  return text;
}

/**
 * 会话消息正文文本（契约 §5.10 / §5.11.4）：**图片与文件块都不占位**。
 *
 * 图片在 ChatMessage.images[] 里单独渲染（客户端画缩略图气泡），
 * 文件在 ChatMessage.files[] 里单独渲染（文件卡片）；正文里再写一遍
 * "[图片]"/"[文件]" 会出现重复的假文字。v1.2.0 起 file 块也不再添加占位符
 * （旧客户端会少一行占位文本，属可接受降级）。
 * @param {unknown} blocks ContentBlock[]
 * @returns {string}
 */
export function messageText(blocks) {
  if (!Array.isArray(blocks)) return "";
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
    // image：单独渲染（§5.10）；file：单独渲染（§5.11.4）；
    // reasoning / tool-call 等：跳过
  }
  return text;
}

/**
 * 契约 §5.2 `session.queue`：待执行消息的文本口径。
 *
 * 只取 content 里 `type==='text'` 的块拼接——与正文口径（messageText）刻意不同：
 * 正文会把图片/文件块独立渲染（不占位），而排队列表要的是**用户实际打的字**
 * （附件-only 消息没有文本，不进队列展示；消息本身照常投递）。
 * @param {unknown} content ContentBlock[]
 * @returns {string}
 */
export function queueItemText(content) {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * Host `inbox` 投影视图 → 插件内部队列项（契约 §5.1/§5.2 v1.3.0）。
 *
 * `values.inbox` 形状为 `{ "next-turn": UserMessage[], "next-step": UserMessage[] }`
 * （Host 的 durable inbox 投影）。这里以消息 `id` 作为唯一身份，`rpcId` 只保留
 * 供旧宿主/旧事件回退使用；没有文本的消息与直播追踪同口径，不占队列展示。
 * @param {unknown} inbox Host inbox 投影视图
 * @returns {Array<{itemId:string,text:string,target:"next-turn"|"next-step",rpcId:string}>}
 */
export function queueItemsFromInbox(inbox) {
  const out = [];
  const seen = new Set();
  const push = (target, messages) => {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      const itemId = typeof message?.id === "string" ? message.id : "";
      if (itemId === "" || seen.has(itemId)) continue;
      const text = queueItemText(message?.content);
      if (text.trim() === "") continue;
      seen.add(itemId);
      out.push({
        itemId,
        text,
        target,
        rpcId: typeof message?.source?.rpcId === "string" ? message.source.rpcId : "",
      });
    }
  };
  push("next-turn", inbox?.["next-turn"]);
  push("next-step", inbox?.["next-step"]);
  return out.slice(0, QUEUE_MAX_ITEMS);
}

/**
 * 思考块 → 纯文本（契约 §5.3 / 附录 C）。
 * 只取 type==='reasoning' 的块；普通正文与工具结果**不**进这里。
 * @param {unknown} blocks ContentBlock[]
 * @returns {string}
 */
export function reasoningText(blocks) {
  if (!Array.isArray(blocks)) return "";
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "reasoning" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * 契约 §5.1 ChatMessage 提取（v1.0.7）：SessionWireEvent → ChatMessage[]。
 *
 * 一个事件可能产出**两条**消息：assistant/message 里 `type:"reasoning"` 的块
 * 独立成条（role:"reasoning"，id = "<sessionId>:<seq>:reasoning"），
 * 排在普通 assistant 正文**之前**；正文仍按 contentText 口径（忽略 reasoning）。
 *
 * 事件形态（@deepseek-ai/dsh-session 类型实证）：
 *   user/message      data = UserMessage  {content:[ContentBlock], source:{kind}}
 *   assistant/message data = {turn, step, message: AssistantMessage, stream, usage?}
 * 显示口径（自行权衡，宁缺勿崩）：
 *   - 只收 append-origin 表面事件（surfaceOp==='append'）——replace 副本是
 *     模型可见的压缩影子，不是人看的逐字记录（宿主 surface 语义）；
 *   - user 只收 source.kind==='user' 的真人输入（agent.inject 的注入跳过）；
 *   - ContentBlock 只取 type==='text' 的纯文本（reasoning/tool-call 跳过）；
 *     **image 块不占位**（v1.0.9 §5.10：图片单独渲染，见 messageText）；
 *   - v1.0.9（§5.10）：消息里有 image 块时，ChatMessage 追加 `images: ImageRef[]`
 *     （只带元数据，thumb 由上层 attachThumbs 补）；**纯图片消息（无正文）也要成条**，
 *     否则手机端永远看不到这张图；
 *   - v1.2.0（§5.11.4）：消息里有 file 块时，ChatMessage 追加 `files: FileRef[]`
 *     （fileId/name/bytes，手机端渲染文件卡片，不下载）；**纯文件消息也要成条**；
 *   - 没有任何内容的消息跳过（不产生空泡）；
 *   - 任何不认识的形态返回 []（跳过），绝不抛出。
 * @returns {object[]} ChatMessage[]
 */
/** v1.3.1：宿主唤醒消息的来源 → 客户端的触发卡类型（对齐桌面端 turnTriggerDetails）。 */
const WAKE_TRIGGER_KINDS = Object.freeze({
  goal: "goal",
  "agent-message": "agent",
  "team-message": "team",
  "subagent-settled": "subagent",
  webhook: "webhook",
  schedule: "schedule",
  "tool-jobs": "job",
  "cordis-host-runner": "plugin",
});

export function mapHistoryMessages(sessionId, record) {
  const event = record?.event ?? record;
  if (!event || typeof event !== "object") return [];
  const type = event.type;
  if (type !== "user/message" && type !== "assistant/message") return [];
  if (event.surfaceOp !== "append") return [];
  const seq = Number(event?.seq);
  const time = Number(event?.time);
  if (!Number.isSafeInteger(seq) || seq < 0) return [];
  const data = event.data;
  if (!data || typeof data !== "object") return [];

  let role;
  let content;
  let trigger = "";
  if (type === "user/message") {
    const sourceKind = data?.source?.kind;
    if (sourceKind === "user") {
      role = "user";
      content = data.content;
    } else {
      // v1.3.1（§5.3）：宿主**唤醒消息**（不是用户手打）——Goal 轮次提示就是这一类
      // （goal-round-driver 写入 source.kind='goal' 的 user/message）。
      // 桌面端把它渲染成「触发卡」（继续执行目标），旧实现直接 return [] →
      // 手机端整段缺失（用户反馈：消息列表里看不到目标消息）。
      const kind = WAKE_TRIGGER_KINDS[sourceKind];
      if (kind === undefined) return [];
      role = "user";
      trigger = kind;
      content = data.content;
    }
  } else {
    role = "assistant";
    content = data?.message?.content;
  }
  if (!Array.isArray(content)) return [];

  const ts = Number.isSafeInteger(time) && time > 0 ? time : 0;
  const out = [];
  // 思考过程独立成条，排在正文之前（v1.0.7 §5.3）
  if (role === "assistant") {
    const thinking = reasoningText(content);
    if (thinking.trim() !== "") {
      out.push({ id: `${sessionId}:${seq}:reasoning`, role: "reasoning", text: thinking, ts, seq });
    }
  }
  const text = messageText(content);
  // v1.0.9（§5.10）：图片单独成字段，**不带缩略图**（纯函数读不到附件字节）
  const images = imageBlocksOf(content).map((ref) => imageRefMeta(ref));
  // v1.2.0（§5.11.4）：文件块单独成字段（只有名称/大小，不需要读字节）
  const files = fileRefsOfContent(content);
  if (text.trim() !== "" || images.length > 0 || files.length > 0 || trigger !== "") {
    const message = { id: `${sessionId}:${seq}`, role, text, ts, seq };
    if (images.length > 0) message.images = images;
    if (files.length > 0) message.files = files;
    if (trigger !== "") {
      // 唤醒消息的原始注入正文由客户端隐藏（与桌面端一致），只显示触发卡。
      message.text = "";
      message.trigger = trigger;
    }
    out.push(message);
  }
  return out;
}

/**
 * 契约 §5.1 ChatMessage 提取（单条口径，保留旧签名）：只回**非思考**的那条，
 * 没有正文时返回 null（与 v1.0.6 行为逐字一致）。
 * @returns {object|null}
 */
export function mapHistoryMessage(sessionId, record) {
  for (const message of mapHistoryMessages(sessionId, record)) {
    if (message.role !== "reasoning") return message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// v1.0.9：会话消息里的图片（契约 §5.10）——附件读字节 + 缩略图补齐
// ---------------------------------------------------------------------------

/**
 * 取宿主附件服务（服务名 `attachments`；本地后端 dsh-attachment-local）。
 * ctx.get 对不存在的服务会抛，故 try/catch + ctx[name] 直取兜底。
 * @param {any} ctx Cordis ctx
 * @returns {any|null} 附件服务或 null（宿主没装附件后端）
 */
export function attachmentsOf(ctx) {
  try {
    const svc = ctx?.get?.("attachments");
    if (svc) return svc;
  } catch {
    /* 服务未注册 */
  }
  try {
    const svc = ctx?.attachments;
    return svc ?? null;
  } catch {
    return null;
  }
}

/**
 * 读一张附件的**原始字节**。
 *
 * 优先 `attachments.readImage(ref, signal)`（本地后端有实现，返回 {ref, data} 或裸字节，
 * 且带完整性校验）；不可用/失败时回退 `readFileSync(imageHostPath(ref))`
 * （宿主文件系统绝对路径；非文件后端时 imageHostPath 返回 undefined）。
 * @param {any} attachments 附件服务
 * @param {any} ref 宿主附件引用
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer|null>} 字节；读不到返回 null
 */
export async function readAttachmentBytes(attachments, ref, signal) {
  if (!attachments || !ref) return null;
  try {
    if (typeof attachments.readImage === "function") {
      const out = await attachments.readImage(ref, signal);
      const data = out && typeof out === "object" && "data" in out ? out.data : out;
      const bytes = toBuffer(data);
      if (bytes && bytes.length > 0) return bytes;
    }
  } catch {
    /* 落到回退路径 */
  }
  try {
    if (typeof attachments.imageHostPath === "function") {
      const path = attachments.imageHostPath(ref);
      if (typeof path === "string" && path !== "") {
        const bytes = readFileSync(path);
        if (bytes.length > 0) return bytes;
      }
    }
  } catch {
    /* 读不到就是读不到（上层降级） */
  }
  return null;
}

/** 各种字节形态 → Buffer。 */
function toBuffer(input) {
  if (input === null || input === undefined) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === "object" && input.data !== undefined && input.data !== null) return toBuffer(input.data);
  return null;
}

/**
 * 给消息里的图片补**内联缩略图**（契约 §5.10）。
 *
 * mapHistoryMessages 是纯函数（拿不到附件字节），只产元数据；这里负责读字节 +
 * 压缩，并把 base64 ≤96KB 的 JPEG data URI 写回 image.thumb。
 *
 * 降级（**绝不抛**）：附件服务缺失 / 读不到字节 / sharp 不可用 / 压不进 96KB
 * → thumb 留空，客户端显示占位框；图片功能失败**不影响**消息流其余内容。
 *
 * 预算（重要）：一页历史可能有几十张图，每张 96KB 内联会**顶爆中继的 1MiB 帧**
 * （帧里还有 base64 密文的 4/3 放大）。所以整页缩略图有**总预算**
 * （默认 THUMB_PAGE_BUDGET）；超预算的后续图片只发元数据（thumb 留空）。
 * 回包发出去前还有一道**帧预算守卫**（fitReplyBudget）兜底。
 *
 * @param {object[]} messages ChatMessage[]
 * @param {any} ctx Cordis ctx（用来取 attachments 服务）
 * @param {{budgetBytes?:number}} [options]
 * @returns {Promise<object[]>} 同一个 messages 数组
 */
export async function attachThumbs(messages, ctx, options) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return list;
  const attachments = attachmentsOf(ctx);
  if (!attachments) return list;
  const budget = Number.isSafeInteger(options?.budgetBytes) ? options.budgetBytes : THUMB_PAGE_BUDGET;
  let used = 0;
  for (const message of list) {
    const images = Array.isArray(message?.images) ? message.images : [];
    for (const image of images) {
      if (!image || typeof image !== "object") continue;
      if (typeof image.thumb === "string" && image.thumb !== "") continue;
      if (used >= budget) continue; // 整页预算用尽 → 只发元数据
      const ref = attachmentRefOf(image);
      if (!ref) continue;
      try {
        const bytes = await readAttachmentBytes(attachments, ref, undefined);
        if (!bytes) continue;
        const thumb = await makeThumb(bytes, image.mediaType);
        if (thumb === "") continue;
        const size = thumb.length - THUMB_DATA_URI_PREFIX.length;
        if (used + size > budget) continue; // 这张塞不进去 → 只发元数据
        image.thumb = thumb;
        used += size;
      } catch {
        /* 缩略图失败：只发元数据 */
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// v1.0.6：工作步骤（§5.7）/ 模式与权限（§5.8）——纯函数映射，便于单测
// ---------------------------------------------------------------------------

/** 事件里的时间戳（毫秒）；非法给 0。 */
function eventTime(event) {
  const time = Number(event?.time);
  return Number.isSafeInteger(time) && time > 0 ? time : 0;
}

/** 事件里的持久序号；非法给 -1。 */
function eventSeq(event) {
  const seq = Number(event?.seq);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : -1;
}

/**
 * 契约 §5.2 `tool.call` 事件映射（宿主 session/event 的 tool/call）。
 * data = { turn, step, callId, name, arguments }（arguments 是原始 JSON 字符串）。
 * @returns {{sessionId:string,callId:string,name:string,arguments:string,ts:number}|null}
 */
export function mapToolCallEvent(sessionId, event) {
  if (!event || typeof event !== "object" || event.type !== "tool/call") return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const callId = typeof data.callId === "string" ? data.callId : "";
  if (callId === "") return null;
  const rawArgs = data.arguments;
  const args =
    typeof rawArgs === "string"
      ? rawArgs
      : rawArgs === undefined || rawArgs === null
        ? ""
        : JSON.stringify(rawArgs);
  return {
    sessionId: String(sessionId ?? ""),
    callId,
    name: typeof data.name === "string" ? data.name : "",
    arguments: args,
    ts: eventTime(event),
  };
}

/**
 * 契约 §5.2 `tool.result` 事件映射（宿主 session/event 的 tool/result）。
 * data = { turn, step, message:{ role:'tool', toolCallId, isError?, content:[blocks] }, error? }
 * @returns {{sessionId:string,callId:string,status:"ok"|"error",resultText:string,errorText:string,ts:number}|null}
 */
export function mapToolResultEvent(sessionId, event) {
  if (!event || typeof event !== "object" || event.type !== "tool/result") return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const message = data.message && typeof data.message === "object" ? data.message : null;
  const callId = typeof message?.toolCallId === "string" ? message.toolCallId : "";
  if (callId === "") return null;
  const isError = message?.isError === true;
  const resultText = contentText(message?.content);
  const reason = data.error?.reason;
  const errorText =
    reason === undefined || reason === null ? (isError ? resultText : "") : String(reason);
  return {
    sessionId: String(sessionId ?? ""),
    callId,
    status: isError ? "error" : "ok",
    resultText,
    errorText,
    ts: eventTime(event),
  };
}

/**
 * 契约 §5.7 StepRecord 提取：session.history 的 page.records → steps[]。
 *
 * 规则：
 *   - 只看 type==='tool/call' 与 'tool/result' 的记录；
 *   - 按 callId 配对：一次调用合并成一条（call 的字段 + result 的状态/文本）；
 *   - seq：优先取 tool/call 事件的 seq；只有 tool/result 时取它的 seq；
 *   - status：tool/result 的 isError 决定 ok/error；只有 call 没有 result 时 running；
 *   - turn/step 取事件 data 里的 turn/step；ts 取事件 time（call 优先）。
 * 任何不认识的形状一律跳过，绝不抛出。
 * @param {any[]} records page.records
 * @returns {object[]} StepRecord[]（按 seq 升序）
 */
export function mapHistorySteps(records) {
  const list = Array.isArray(records) ? records : [];
  /** @type {Map<string, any>} */
  const byCall = new Map();
  /** @type {any[]} */
  const ordered = [];

  for (const record of list) {
    const event = record?.event ?? record;
    if (!event || typeof event !== "object") continue;
    const type = event.type;
    if (type !== "tool/call" && type !== "tool/result") continue;
    const data = event.data;
    if (!data || typeof data !== "object") continue;
    const ts = eventTime(event);
    const seq = eventSeq(event);
    const turn = Number.isSafeInteger(Number(data.turn)) ? Number(data.turn) : 0;
    const step = Number.isSafeInteger(Number(data.step)) ? Number(data.step) : 0;

    if (type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : "";
      if (callId === "") continue;
      const rawArgs = data.arguments;
      const args =
        typeof rawArgs === "string"
          ? rawArgs
          : rawArgs === undefined || rawArgs === null
            ? ""
            : JSON.stringify(rawArgs);
      let rec = byCall.get(callId);
      if (rec === undefined) {
        rec = {
          seq: seq < 0 ? 0 : seq,
          callId,
          name: "",
          arguments: "",
          status: "running",
          resultText: "",
          errorText: "",
          ts: 0,
          turn: 0,
          step: 0,
        };
        byCall.set(callId, rec);
        ordered.push(rec);
      }
      rec.name = typeof data.name === "string" ? data.name : rec.name;
      rec.arguments = args;
      rec.status = "running";
      if (ts > 0) rec.ts = ts;
      rec.turn = turn;
      rec.step = step;
      // seq 优先取 tool/call 的（result 晚到时不覆盖）
      if (seq >= 0) rec.seq = seq;
      continue;
    }

    // tool/result
    const message = data.message && typeof data.message === "object" ? data.message : null;
    const callId = typeof message?.toolCallId === "string" ? message.toolCallId : "";
    if (callId === "") continue;
    const isError = message?.isError === true;
    const resultText = contentText(message?.content);
    const reason = data.error?.reason;
    const errorText =
      reason === undefined || reason === null ? (isError ? resultText : "") : String(reason);
    let rec = byCall.get(callId);
    if (rec === undefined) {
      rec = {
        seq: seq < 0 ? 0 : seq,
        callId,
        name: "",
        arguments: "",
        status: "ok",
        resultText: "",
        errorText: "",
        ts: 0,
        turn: 0,
        step: 0,
      };
      byCall.set(callId, rec);
      ordered.push(rec);
    }
    rec.status = isError ? "error" : "ok";
    rec.resultText = resultText;
    rec.errorText = errorText;
    if (ts > 0 && rec.ts === 0) rec.ts = ts;
    rec.turn = turn;
    rec.step = step;
  }

  ordered.sort((a, b) => a.seq - b.seq);
  return ordered;
}

/**
 * 契约 §5.8 模式目录映射：宿主 AgentPreset[] → wire ModeOption[]。
 * broken 的预设也列出（name 回退 id）；默认 id 用 svc.defaultId。
 * @param {any[]} rows
 * @param {string} defaultId
 * @returns {{presets:{id:string,name:string,description:string}[],defaultPreset:string}}
 */
export function mapAgentPresetOptions(rows, defaultId) {
  const list = Array.isArray(rows) ? rows : [];
  const presets = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id === "") continue;
    const name = typeof row.name === "string" && row.name !== "" ? row.name : id;
    const description = typeof row.description === "string" ? row.description : "";
    presets.push({ id, name, description });
  }
  return { presets, defaultPreset: typeof defaultId === "string" ? defaultId : "" };
}

/**
 * 契约 §5.8 权限目录映射：宿主 PermissionCatalog → wire PermissionOption[]。
 * 宿主 PresetOption 的标识字段是 `value`（契约附录 B 的 `id` 是 wire 字段名），
 * 两种都兜住；`custom` 只是展示态，永不可选 → 跳过。
 * @param {any} catalog { options, defaultOptions, defaultPreset }
 * @returns {{permissions:{id:string,name:string,description:string}[],defaultPermission:string}}
 */
export function mapPermissionOptions(catalog) {
  const options = Array.isArray(catalog?.options) ? catalog.options : [];
  const permissions = [];
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const rawId =
      typeof option.id === "string" && option.id !== ""
        ? option.id
        : typeof option.value === "string"
          ? option.value
          : "";
    const id = rawId.trim();
    if (id === "") continue;
    if (id === "custom") continue; // 展示态，不可选
    const name = typeof option.name === "string" && option.name !== "" ? option.name : id;
    const description = typeof option.description === "string" ? option.description : "";
    permissions.push({ id, name, description });
  }
  const defaultPreset =
    typeof catalog?.defaultPreset === "string"
      ? catalog.defaultPreset
      : typeof catalog?.defaultPermission === "string"
        ? catalog.defaultPermission
        : "";
  return { permissions, defaultPermission: defaultPreset };
}

/** 宿主是否因为 agent preset 拒绝了 create（→ unsupported-agent-preset）。 */
export function isAgentPresetRejection(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  if (/agent[-_ ]?preset/i.test(code)) return true;
  const text = errText(e);
  return /preset/i.test(text);
}

/**
 * 契约 §5.8 模型目录映射（v1.0.7 + v1.0.8）：宿主 modelCatalog() → wire ModelOption[]。
 *
 * 宿主形状（附录 C / dsh-api-session-controller 实装）：
 *   { default:{provider,model,reasoningEffort?},
 *     groups:[{ id:providerId, name, models:[{id:modelId,name,description?,reasoning?}] }],
 *     failures:[…] }
 *   —— group.id 是 **provider**，models[].id 是 **model 名**。
 * wire 形状：{ id:"provider/model", provider, model, name, description,
 *              reasoningEffort?, efforts?:[{id,name,description?}] }
 *   - reasoningEffort 取该模型 reasoning.defaultEffort（没有就不产出该字段）；
 *   - efforts 拍平 reasoning.efforts（**合法思考强度集合**，v1.0.8）；
 *     模型没有 reasoning 时**不产出** efforts 字段。
 * @param {any} catalog
 * @returns {{models:object[],defaultModelId:string}}
 */
export function modelCatalogToWire(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const models = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const provider = typeof group.id === "string" ? group.id : "";
    if (provider === "") continue;
    const entries = Array.isArray(group.models) ? group.models : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const model = typeof entry.id === "string" ? entry.id : "";
      if (model === "") continue;
      const effort =
        typeof entry?.reasoning?.defaultEffort === "string" ? entry.reasoning.defaultEffort : "";
      const option = {
        id: `${provider}/${model}`,
        provider,
        model,
        name: typeof entry.name === "string" && entry.name !== "" ? entry.name : model,
        description: typeof entry.description === "string" ? entry.description : "",
      };
      if (effort !== "") option.reasoningEffort = effort;
      const efforts = mapReasoningEfforts(entry?.reasoning?.efforts);
      if (efforts.length > 0) option.efforts = efforts;
      models.push(option);
    }
  }
  const def = catalog?.default;
  const defaultModelId =
    def && typeof def === "object" && typeof def.provider === "string" && def.provider !== "" &&
    typeof def.model === "string" && def.model !== ""
      ? `${def.provider}/${def.model}`
      : "";
  return { models, defaultModelId };
}

/** 兼容别名（v1.0.7 旧名）。 */
export const mapModelCatalog = modelCatalogToWire;

/**
 * 契约 §5.8（v1.0.8）：宿主 reasoning.efforts → wire efforts[]。
 * @param {unknown} rows
 * @returns {{id:string,name:string,description:string}[]}
 */
export function mapReasoningEfforts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const efforts = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (id === "") continue;
    efforts.push({
      id,
      name: typeof row.name === "string" && row.name !== "" ? row.name : id,
      description: typeof row.description === "string" ? row.description : "",
    });
  }
  return efforts;
}

/**
 * v1.3.0：Host todo 行 → wire TodoItem[]（只保留 content/status，未知项丢弃）。
 * @param {unknown} raw
 * @returns {Array<{content:string,status:"pending"|"in_progress"|"completed"}>}
 */
export function mapTodoItems(raw) {
  if (!Array.isArray(raw)) return [];
  const statuses = new Set(["pending", "in_progress", "completed"]);
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const content = typeof item.content === "string" ? item.content : "";
    const status = typeof item.status === "string" ? item.status : "";
    if (content === "" || !statuses.has(status)) continue;
    out.push({ content, status });
  }
  return out;
}

/**
 * v1.3.0：Host GoalProjection/GoalView → 扁平 wire GoalWire。
 * 只接受 goal.id 与合法 phase；activation 由调用方按可用性提供。
 * @param {unknown} goal
 * @param {unknown} roundsStarted
 * @param {unknown} createdAt
 * @param {unknown} updatedAt
 * @param {"armed"|"disarmed"|null} activation
 * @returns {object|null}
 */
export function mapGoalWire(goal, roundsStarted, createdAt, updatedAt, activation) {
  if (!goal || typeof goal !== "object" || typeof goal.id !== "string" || goal.id === "") return null;
  const phases = new Set(["active", "paused", "blocked", "complete"]);
  if (!phases.has(goal.phase)) return null;
  const out = {
    id: goal.id,
    revision: Number(goal.revision) || 0,
    objective: typeof goal.objective === "string" ? goal.objective : "",
    phase: goal.phase,
    maxGoalRounds: Number(goal.maxGoalRounds) || 0,
    roundsStarted: Number(roundsStarted) || 0,
    createdAt: Number(createdAt) || 0,
    updatedAt: Number(updatedAt) || 0,
  };
  if (goal.blockedReason && typeof goal.blockedReason === "object") {
    const code = typeof goal.blockedReason.code === "string" ? goal.blockedReason.code : "";
    const message = typeof goal.blockedReason.message === "string" ? goal.blockedReason.message : "";
    if (code !== "" && message !== "") out.blockedReason = { code, message };
  }
  if (activation === "armed" || activation === "disarmed") out.activation = activation;
  return out;
}

/**
 * v1.3.0：Host AskUserQuestionItem[] → wire Question[]（不泄露 Host 私有字段）。
 * @param {unknown} raw
 * @returns {Array<object>}
 */
export function mapWireQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    const id = typeof q?.id === "string" ? q.id : "";
    if (id === "") continue;
    const options = Array.isArray(q?.options)
      ? q.options
          .map((o) => ({
            label: typeof o?.label === "string" ? o.label : "",
            description: typeof o?.description === "string" ? o.description : "",
          }))
          .filter((o) => o.label !== "")
      : [];
    out.push({
      id,
      question: typeof q?.question === "string" ? q.question : "",
      multiSelect: q?.multiSelect === true,
      options,
    });
  }
  return out;
}

/**
 * 契约 §5.8 ModelSelection：手机提交的 model → 提交给宿主的
 * {provider, model, reasoningEffort?}（id 不可反拆，只认 provider/model）。
 * @param {unknown} raw
 * @returns {{provider:string,model:string,reasoningEffort?:string}|null}
 */
export function parseModelSelection(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (provider === "" || model === "") return null;
  const selection = { provider, model };
  if (typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim() !== "") {
    selection.reasoningEffort = raw.reasoningEffort.trim();
  }
  return selection;
}

/** 兼容别名（v1.0.7 旧名）。 */
export const normalizeModelSelection = parseModelSelection;

/**
 * 契约 §5.8 ModelSelection 归一化：宿主 selection / model/selection 事件 data
 * → wire {provider, model, reasoningEffort?}（无 reasoningEffort 时省略该字段）。
 * @param {unknown} data
 * @returns {{provider:string,model:string,reasoningEffort?:string}|null}
 */
export function mapModelSelection(data) {
  return parseModelSelection(data);
}

/**
 * 契约 §5.1：会话历史读取地址（宿主 0.2.2+ 的 durable address）。
 *
 * 宿主对**普通会话**与**子代理会话**用两种地址：
 *   - 普通会话：{kind:'session', sessionId}
 *   - 子代理：{kind:'subagent', parentSessionId, childSessionId, mode:'unknown'}
 *     （子代理会话用 kind:'session' 会被宿主拒为 session/agent-busy）
 *
 * mode 固定 'unknown'：宿主在 mode==='unknown' 时跳过 mode 比对，
 * 免得我们还得额外读一次子代理目录去确认 one-shot/continuable。
 * @param {string} sessionId
 * @param {string} [parentSessionId] 子代理的父会话 id（普通会话留空）
 * @returns {{kind:string,sessionId?:string,parentSessionId?:string,childSessionId?:string,mode?:string}}
 */
export function historyAddress(sessionId, parentSessionId = "") {
  if (parentSessionId !== "") {
    return {
      kind: "subagent",
      parentSessionId,
      childSessionId: sessionId,
      mode: "unknown",
    };
  }
  return { kind: "session", sessionId };
}

/**
 * 契约 §5.9 归档：宿主错误的「原样」回传。
 * 优先用宿主的错误码（RemoteError.code，如 "workspace/active-session"），
 * 没有就用调用方给的兜底码；message 一律用宿主原文。
 * @param {unknown} e
 * @param {string} fallbackCode
 * @returns {{code:string,message:string}}
 */
export function hostErrorOf(e, fallbackCode) {
  const code = typeof e?.code === "string" && e.code !== "" ? e.code : fallbackCode;
  return { code, message: errText(e) };
}

/**
 * 契约 §5.1 session.create：**默认工作目录**。
 *
 * 手机端不传 cwd（或传空串）时，不再让宿主回退到 DSH 后端的 process.cwd()，
 * 而是解析为 Host 用户主目录下的 `.dsh/remote`（用 node:path.join 拼，
 * Windows / POSIX 都对）。
 * @param {string} [home] 用户主目录（默认 os.homedir()）
 * @returns {string} 绝对路径
 */
export function defaultSessionCwd(home = homedir()) {
  return join(home, ".dsh", "remote");
}

/**
 * 契约 §5.1 session.create：解析手机端传来的 cwd。
 *
 * 缺省 / undefined / 空串 / trim 后空串 → 默认目录（`~/.dsh/remote`）；
 * 其余按既有行为 trim 后返回；显式 cwd 不自动创建目录。
 * @param {unknown} raw payload.cwd
 * @param {string} [home] 用户主目录（默认 os.homedir()）
 * @returns {{cwd:string, isDefault:boolean}}
 */
export function resolveSessionCwd(raw, home = homedir()) {
  const explicit = typeof raw === "string" ? raw : "";
  if (explicit.trim() !== "") return { cwd: explicit.trim(), isDefault: false };
  return { cwd: defaultSessionCwd(home), isDefault: true };
}

/** result / error 信封（契约 §5）。 */
function resultOf(m, value) {
  return msg("result", { id: m.id, ok: true, value });
}
function errorOf(m, code, message) {
  return msg("result", { id: m.id, ok: false, error: { code, message } });
}

function errText(e) {
  return e && typeof e.message === "string" ? e.message : String(e);
}

export class HostBridge {
  #ctx;
  #relay; // { send(message, urgent): boolean, clientOnline: boolean, ready: boolean }
  #push; // PushSender
  #cfg;
  #log;
  #pluginVersion;
  // v1.1.4：session.create 的默认工作目录基准（用户主目录）+ 建目录实现
  // —— 二者都可注入，生产用 homedir() / fs.mkdir，测试用临时目录（不写真实 home）。
  #homeDir;
  #mkdir;
  #disposed = false; // dispose() 后禁止一切出站与拦截
  // v1.1.x：每个 session 一个**统一保序**的流式缓冲（正文 + 思考共用一条队列）
  // sessionId -> { blocks: [{kind:"text"|"reasoning", text}], timer }
  // 同一 125ms 窗口内只合并**相邻同类**块；不同类各占一块 → 冲刷时严格按
  // 原始 chunk 顺序发 assistant.delta / assistant.reasoningDelta（跨类型也保序）。
  #streamBuf = new Map();
  #modelSelections = new Map(); // sessionId -> {provider, model, reasoningEffort?}（v1.0.8 内存态）
  // v1.1.7：有效权限的直播兜底；权威查询仍优先走 permissions 持久投影。
  #permissionSelections = new Map(); // sessionId -> string（含派生态 custom）
  #pending = new Map(); // askId -> { resolve, kind, sessionId, timer, abortHandler, signal, meta }
  // v1.3.0：Host userQuestions 投影里仍可回答的问题（continued/open），
  // key = sessionId + "\0" + callId；用于快照、桌面端回答后清理与手机补答路由。
  #hostQuestions = new Map();
  // v1.3.0：goal/activation-changed 的进程内状态缓存（投影不含 activation）。
  #goalActivations = new Map(); // sessionId -> {id,revision,activation}
  #askQuestionCalls = new Set(); // v1.3.0：进行中的 ask_user_question callId（用于投影对账）
  #todoSessions = new Set(); // v1.3.0：已确认有 todo 投影的会话（降级时不能把 turn/start 当能力声明）
  #clientFeatures = new Set(); // v1.3.0：hello.features（旧 App 不声明新语义）
  #titles = new Map(); // sessionId -> title（turn.end 推送文案用）
  #pushToken = ""; // 手机 push.register 上报的 token（内存态）
  // v1.0.9（§5.10）：imageId -> 宿主附件引用（image.fetch 用；插件重启后为空）
  #imageRefs = new Map();
  // present 投递的图片文件：imageId -> { path, mediaType }（image.fetch 读盘用）
  #deliveredImages = new Map();
  // v1.0.9（§5.10）：`${imageId}:${maxEdge}` -> 已缩放的大图（避免重复压缩）
  #imageCache = new Map();
  // v1.1.1（§5.2）：会话的待执行消息（排队中 / 已插入当前 turn 但尚未消费）
  // sessionId -> [{itemId, text, target, rpcId}]
  // rpcId 只在插件内部用于「被消费时出队」的匹配，**不进 wire**。
  #queues = new Map();
  // v1.1.1（§5.10.2）：交付物图片的历史条目 sessionId -> [{seq, ts, imageId, …, path}]
  #deliveredEntries = new Map();
  // v1.1.1（§5.10.2）：交付物图片的缩略图缓存 imageId -> data URI（避免每次历史刷新都重压）
  #deliveredThumbs = new Map();
  // v1.1.2（§5.1）：运行中的会话（api-session/status 维护）——「繁忙时的发送行为」只在忙时有意义
  #runningSessions = new Set();
  // v1.2.0（§5.11）：手机端附件分块上传登记表（内存态；未提交缓冲 + 已提交 receipt）
  #uploads = new UploadRegistry();
  #disposers = [];
  #hostName = "";
  #dshVersion = "";

  /**
   * @param {{
   *   ctx: any,
   *   relay: { send:(m:object, urgent?:boolean)=>boolean, clientOnline:boolean, ready:boolean },
   *   push: { notify:(req:object)=>Promise<{ok:boolean,reason?:string}>, configured:boolean, unavailableReason?:()=>string },
   *   config: any,
   *   log: (level:"info"|"warn"|"error", message:string, extra?:object)=>void,
   *   homeDir?: string,   // v1.1.4：默认 cwd 的基准目录（默认 os.homedir()）
   *   mkdir?: (p:string)=>Promise<unknown>,  // v1.1.4：建默认目录（默认 fs.mkdir recursive）
   * }} deps
   */
  constructor(deps) {
    this.#ctx = deps.ctx;
    this.#relay = deps.relay;
    this.#push = deps.push;
    this.#cfg = deps.config;
    this.#log = deps.log;
    this.#homeDir =
      typeof deps.homeDir === "string" && deps.homeDir !== "" ? deps.homeDir : homedir();
    this.#mkdir =
      typeof deps.mkdir === "function"
        ? deps.mkdir
        : (p) => mkdir(p, { recursive: true });
    this.#pluginVersion = pluginVersion();
    this.#hostName = hostname();
    this.#dshVersion = dshVersion();
  }

  // ---- 生命周期 ------------------------------------------------------------

  /** 注册全部监听；返回卸载函数（由 index.js 挂进 ctx.effect）。 */
  attach() {
    const ctx = this.#ctx;

    // --- 瀑布答案器（§5.5）：prepend 抢在桌面人工答案器之前 ---
    ctx.on("approval/request", (req, next) => this.#onApprovalRequest(req, next), { prepend: true });
    ctx.on("user-questions/request", (req, next) => this.#onQuestionRequest(req, next), { prepend: true });

    // v1.3.0：Goal 进程内 activation（不持久，只能从 Host 事件拿）。
    this.#on("goal/activation-changed", (payload) => {
      const sessionId = String(payload?.sessionId ?? "");
      if (sessionId === "") return;
      const goal = payload?.goal;
      if (!goal || typeof goal.id !== "string") {
        this.#goalActivations.delete(sessionId);
        return;
      }
      const activation = goal.activation === "armed" ? "armed" : "disarmed";
      this.#goalActivations.set(sessionId, {
        id: goal.id,
        revision: Number(goal.revision) || 0,
        activation,
      });
      this.#sendEvent("session.goalActivationChanged", {
        sessionId,
        id: goal.id,
        revision: Number(goal.revision) || 0,
        activation,
      });
    });

    // --- 事件桥接（§5.2）---
    this.#on("api-session/added", (summary) => {
      const s = mapSummary(summary);
      if (s.sessionId) this.#titles.set(s.sessionId, s.title);
      this.#sendEvent("session.added", { session: s });
    });
    this.#on("api-session/removed", (sessionId) => {
      const key = String(sessionId);
      this.#titles.delete(key);
      this.#permissionSelections.delete(key);
      this.#goalActivations.delete(key);
      for (const mapKey of this.#hostQuestions.keys()) {
        if (mapKey.startsWith(key + "\0")) this.#hostQuestions.delete(mapKey);
      }
      // 会话没了，它的待执行列表与交付物历史条目也没有意义了（避免内存泄漏）
      this.#queues.delete(key);
      this.#deliveredEntries.delete(key);
      this.#runningSessions.delete(key);
      // 待发的流式增量也没意义了（定时器一并清掉，别在会话没了之后还出站）
      this.#dropStream(key);
      this.#sendEvent("session.removed", { sessionId: key });
    });
    this.#on("api-session/status", (sessionId, running) => {
      // v1.1.2：记运行态——「繁忙时的发送行为」只在 agent 忙时才有意义（§5.1）
      const key = String(sessionId);
      if (running === true) {
        this.#runningSessions.add(key);
      } else {
        this.#runningSessions.delete(key);
      }
      this.#sendEvent("session.status", { sessionId: key, running: running === true });
    });
    this.#on("api-session/activity", (sessionId, updatedAt) => {
      this.#sendEvent("session.activity", { sessionId: String(sessionId), updatedAt: Number(updatedAt) || 0 });
    });

    // agent/assistant-stream：文本增量与**思考增量分流**，按 sessionId 合并节流（≤8 条/秒）
    // v1.0.7：chunk.type==='reasoning-delta' → assistant.reasoningDelta（§5.2）
    // v1.1.x：两者进**同一条保序队列**——原先两个独立缓冲 + 固定「先正文后思考」
    // 的冲刷顺序会把 reasoning→text 的 wire 顺序倒过来（手机端按到达顺序渲染，
    // 与冷启动历史「思考在前」不一致，用户看到正文跑到思考前面）。
    this.#on("agent/assistant-stream", (payload) => {
      try {
        const frame = payload?.frame;
        if (!frame) return;
        const sessionId = payload?.agent?.session?.id;
        if (!sessionId) return;
        // 一条 assistant 流结束时立即冲刷，后续 tool.call/result、图片等持久事件
        // 不得越过尚未上屏的正文/思考。
        if (frame.type === "end") {
          this.#flushStream(String(sessionId));
          return;
        }
        if (frame.type !== "chunk") return;
        const chunk = frame.chunk;
        if (!chunk || typeof chunk.text !== "string" || chunk.text === "") return;
        if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return;
        // 正文与思考进**同一条保序队列**（v1.1.x）：跨类型的先后关系必须保住
        this.#queueStream(String(sessionId), chunk.type === "reasoning-delta" ? "reasoning" : "text", chunk.text);
      } catch (e) {
        this.#log("warn", "assistant-stream bridge error", { error: errText(e) });
      }
    });

    // agent/status → idle 时 turn.end（running 转换由 api-session/status 覆盖，避免双发）
    this.#on("agent/status", (payload) => {
      try {
        const sessionId = payload?.agent?.session?.id;
        if (!sessionId) return;
        if (payload.status === "idle") {
          // 先统一冲刷全部待发块（正文 + 思考，**保持原始顺序**），再发 turn.end
          this.#flushStream(String(sessionId));
          this.#sendEvent("turn.end", { sessionId: String(sessionId), status: "idle" });
          this.#maybeNotifyTurnEnd(String(sessionId));
        }
      } catch (e) {
        this.#log("warn", "agent/status bridge error", { error: errText(e) });
      }
    });

    this.#on("agent/error", (payload) => {
      try {
        const sessionId = payload?.agent?.session?.id;
        if (!sessionId) return;
        const err = payload.error;
        const message = err && typeof err.message === "string" ? err.message : String(err);
        // 与 idle 同口径：先统一冲刷（保序），再发 turn.end
        this.#flushStream(String(sessionId));
        this.#sendEvent("turn.end", { sessionId: String(sessionId), status: "error", error: message });
        this.#maybeNotifyTurnEnd(String(sessionId), message);
      } catch (e) {
        this.#log("warn", "agent/error bridge error", { error: errText(e) });
      }
    });

    // --- v1.0.6（§5.7）→ v1.1.4：会话事件总闸 → tool.call / tool.result ---
    // 宿主每写入一条会话日志事件就触发（覆盖所有会话，含 subagent）。
    // 按 session.id 寻址即可，**不过滤**子代理；不认识的事件类型直接忽略，
    // 绝不因为形状不认识而抛错（#on 包装器已兜底）。
    // v1.1.4：**不再桥接 system/message / developer/message**——宿主里它们是
    // 系统提示词节点与工具注册表变更（提示词组装记录，不是对话内容），
    // DSH 桌面端的聊天视图从不展示；手机端曾把它们当「系统消息」显示，
    // 造成时间线里出现大段多余的系统提示文本（用户反馈）。
    this.#on("session/event", (session, event) => {
      const sessionId = String(session?.id ?? "");
      if (sessionId === "") return;
      const type = event?.type;
      if (type === "tool/call") {
        const mapped = mapToolCallEvent(sessionId, event);
        if (mapped !== null) {
          this.#flushStream(sessionId);
          this.#sendEvent("tool.call", mapped);
        }
        if (event?.data?.name === "ask_user_question" && typeof event?.data?.callId === "string") {
          this.#askQuestionCalls.add(event.data.callId);
        }
        return;
      }
      if (type === "tool/result") {
        const mapped = mapToolResultEvent(sessionId, event);
        if (mapped !== null) {
          this.#flushStream(sessionId);
          this.#sendEvent("tool.result", mapped);
        }
        const callId = String(event?.data?.message?.toolCallId ?? "");
        let hasCachedQuestion = false;
        for (const key of this.#hostQuestions.keys()) {
          if (key.startsWith(sessionId + "\0")) {
            hasCachedQuestion = true;
            break;
          }
        }
        if ((callId !== "" && this.#askQuestionCalls.has(callId)) || hasCachedQuestion) {
          if (callId !== "") this.#askQuestionCalls.delete(callId);
          // Host timed 模式：tool/result 落成 pending 后，投影会从 open 变 continued；
          // 异步对账，绝不阻塞事件流。
          void this.#sweepHostQuestions(sessionId);
        }
        return;
      }
      if (type === "todo/write") {
        this.#todoSessions.add(sessionId);
        const todos = event?.data?.todos === null ? null : mapTodoItems(event?.data?.todos);
        this.#sendEvent("session.todosChanged", { sessionId, todos });
        return;
      }
      if (type === "turn/start") {
        // Host todo 投影语义：下一回合开始清空上一回合清单。
        // 只有在已确认该会话有 todo 投影时才发；否则没有 tool-todo 的宿主会因为
        // 普通 turn/start 被客户端误判为「支持 Todo」（capabilities 缺省必须隐藏）。
        if (this.#todoSessions.has(sessionId)) {
          this.#sendEvent("session.todosChanged", { sessionId, todos: null });
        }
        return;
      }
      if (type === "goal/change") {
        const data = event?.data;
        const operation = typeof data?.operation === "string" ? data.operation : "";
        let goal = null;
        if (operation !== "clear") {
          goal = mapGoalWire(data?.goal, data?.roundsStarted, data?.createdAt, data?.updatedAt, null);
          if (goal !== null) {
            const activation = this.#goalActivations.get(sessionId);
            if (activation && activation.id === goal.id && activation.revision === goal.revision) {
              goal.activation = activation.activation;
            }
          }
        } else {
          this.#goalActivations.delete(sessionId);
        }
        this.#sendEvent("session.goalChanged", { sessionId, goal, operation: operation || "edit" });
        return;
      }
      if (type === "model/selection") {
        // v1.0.8：会话模型/思考强度变化（桌面端或手机端 selectModel 都会追加）
        const selection = mapModelSelection(event.data);
        if (selection === null) return;
        this.#modelSelections.set(sessionId, selection);
        this.#sendEvent("session.modelChanged", { sessionId, model: selection });
        return;
      }
      if (type === "permission/preset" || type === "sandbox/mode" || type === "approval/policy") {
        // v1.1.7：桌面端当前权限由这三类 knob 事件共同折叠，不是单看 preset。
        // current(session) 与桌面端 permissions.currentValue 投影共用同一 derive；
        // 因而直接改 sandbox/approval 导致的 custom 也能同步到手机。
        this.#emitPermissionChanged(session, event);
        return;
      }
      if (type === "assistant/message") {
        // v1.0.9（§5.10）：助手消息里的图片 → 广播 assistant.image（带内联缩略图）。
        // 即便本条没有图片，也先把之前的流式文本/思考冲出去，保持时间线顺序。
        this.#flushStream(sessionId);
        this.#emitAssistantImages(sessionId, event);
        return;
      }
      if (type === "deliverables/presented") {
        // present 工具投递的文件：宿主记的是**路径**，不是图片附件块 →
        // 不桥接的话手机端永远看不到这些图（用户反馈：桌面有、手机没有）。
        this.#flushStream(sessionId);
        void this.#emitDeliveredImages(sessionId, event);
        return;
      }
      if (type === "agent/inbox/spliced") {
        // v1.1.1（§5.2）：宿主把「排队中 / 已插入当前 turn 但还没消费」的用户消息
        // 放进 Agent 的 inbox，并用这个事件通知客户端 → 维护待执行列表。
        this.#handleInboxSpliced(sessionId, event);
        return;
      }
      if (type === "user/message") {
        // v1.1.1（§5.2）：真人输入被消费（进入某个 turn）→ 从待执行列表里摘掉。
        this.#handleUserMessage(sessionId, event);
        // v1.3.0：迟到回答/桌面回答会以 user-question-reply 写入，对账投影并清卡。
        if (event?.data?.source?.kind === "user-question-reply") {
          void this.#sweepHostQuestions(sessionId);
        }
        // v1.3.1：Goal 轮次推进 = goal-round-driver 写入 source.kind="goal" 的
        // user/message，而 Host **只在 goal/change 发事件**（轮次推进不发）→
        // 不在这里补一次广播，手机端会一直停在上一个轮次。
        if (event?.data?.source?.kind === "goal") {
          void this.#emitGoalRound(sessionId);
        }
        return;
      }
      // 其余事件（turn/*、step/* …）忽略
    });

    // --- v1.0.7（§5.9）：Workspace 归档变化 → 广播归档全集 ---
    // 归档的权威数据是 workspaceRegistry.archivedSessionIds；注册表写盘后
    // 宿主发 domain/changed（domain="workspace"、table=""、operation="put"），
    // 此时读最新集合并广播 session.archives（**全集**，客户端覆盖各行 archived）。
    this.#on("domain/changed", (change) => {
      if (change?.domain !== "workspace") return;
      if (change?.table !== "") return;
      if (change?.operation !== "put") return;
      this.#broadcastArchives();
    });

    return () => this.dispose();
  }

  /**
   * 权限 knob 变化 → session.permissionChanged（v1.1.7）。
   * 新宿主用 permissionPresets.current(session) 取有效值；旧宿主没有 current 时，
   * 只在明确的 permission/preset 事件上回退其 preset，不对 sandbox/approval 臆造值。
   */
  #emitPermissionChanged(session, event) {
    const sessionId = String(session?.id ?? "");
    if (sessionId === "") return;
    const svc = this.#service("permissionPresets");
    let permission = null;
    if (svc && typeof svc.current === "function") {
      try {
        const current = svc.current(session);
        if (typeof current === "string" && current !== "") permission = current;
      } catch (e) {
        this.#log("warn", "permission current failed; change event skipped", {
          sessionId,
          error: errText(e),
        });
      }
    } else if (event?.type === "permission/preset") {
      const preset = event?.data?.preset;
      if (typeof preset === "string" && preset !== "") permission = preset;
    }
    if (permission === null) return;
    this.#permissionSelections.set(sessionId, permission);
    this.#sendEvent("session.permissionChanged", { sessionId, permission });
  }

  /** 广播归档全集（契约 §5.2 session.archives）。没有注册表 → 不发。 */
  #broadcastArchives() {
    const ids = this.#archivedSessionIds();
    if (ids === null) return;
    this.#sendEvent("session.archives", { archivedSessionIds: ids });
  }

  // ---- v1.1.1（§5.2）：待执行消息（排队中）追踪 ------------------------------

  /**
   * `agent/inbox/spliced` → 把插入的消息记进该会话的待执行列表。
   *
   * 宿主把「排队中 / 已插入当前 turn 但还没消费」的用户消息放在 Agent 的 inbox 里，
   * 并用这个事件通知客户端。`data.target` 取 'next-step'（插进正在跑的 turn）
   * 或 'next-turn'（排到下一个 turn）；**其它取值一律忽略**（不认识就不猜）。
   * `data.inserted` 是消息数组（`{id, source:{kind:'user', rpcId?}, content}`）。
   */
  #handleInboxSpliced(sessionId, event) {
    const data = event?.data;
    const target = data?.target;
    if (target !== "next-step" && target !== "next-turn") return;
    const items = this.#queueOf(sessionId);
    let changed = false;
    // 被取消的 splice（outcome:'canceled'）会移除若干条待执行消息：宿主不会再为
    // 它们发 user/message，故这里按目标从**最前面**摘掉（宿主的 claim 也是从前面取）。
    const removedCount = Number(data?.removedCount);
    if (data?.outcome === "canceled" && Number.isSafeInteger(removedCount) && removedCount > 0) {
      if (this.#dropQueuedFront(items, target, removedCount)) changed = true;
    }
    const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
    for (const message of inserted) {
      // v1.3.1：只跟踪**真人输入**。Goal 轮次提示（source.kind="goal"）等宿主自动注入
      // 的唤醒消息不进手机「排队消息」——它们由触发卡表达（「继续执行目标」），
      // 真进队列只会把注入的原始 prompt 漏出来，还容易看起来像「残留」。
      const sourceKind = message?.source?.kind;
      if (sourceKind !== undefined && sourceKind !== "user") continue;
      const itemId = typeof message?.id === "string" ? message.id : "";
      if (itemId === "") continue;
      if (items.some((item) => item.itemId === itemId)) continue; // 同一 Host 消息只能占一项
      const text = queueItemText(message?.content);
      if (text.trim() === "") continue; // 没有文本 → 不是一条可展示的待执行消息
      if (items.length >= QUEUE_MAX_ITEMS) {
        this.#log("warn", "session.queue item cap reached", { sessionId, target });
        break;
      }
      items.push({
        itemId,
        text,
        target,
        rpcId: typeof message?.source?.rpcId === "string" ? message.source.rpcId : "",
      });
      changed = true;
    }
    if (changed) this.#broadcastQueue(sessionId, target);
  }

  /**
   * `user/message`（真人输入）→ 该消息已被消费，从待执行列表里摘掉。
   *
   * 宿主用 `source.rpcId` 标记「这条是我发起的请求」（= 我们传给 prompt 的
   * requestId），与 inbox 里那一条一一对应；命中即出队。
   */
  #handleUserMessage(sessionId, event) {
    const data = event?.data;
    // v1.3.1：出队按 Host 消息身份（data.id）判定，**不再要求 source.kind==='user'**
    // ——凡进过队列的消息被消费就必须出队（旧实现只认真人来源，任何被跟踪的
    // 非 user 来源消息都会永久残留，这正是「排队残留」的一类）。
    const items = this.#queues.get(sessionId);
    if (!items || items.length === 0) return;
    // v1.3.0：Host 消息 id 是队列项的真实身份；子代理初始注入可以**没有 rpcId**
    // （source.kind='user' 但无 rpcId）。旧实现只认 rpcId → 消费后永远不出队。
    const itemId = typeof data?.id === "string" ? data.id : "";
    const rpcId = typeof data?.source?.rpcId === "string" ? data.source.rpcId : "";
    let index = itemId === "" ? -1 : items.findIndex((item) => item.itemId === itemId);
    if (index < 0 && rpcId !== "") {
      // 旧宿主/旧事件缺 id 时保留 rpcId 回退（只对带 rpcId 的项生效）。
      index = items.findIndex((item) => item.rpcId !== "" && item.rpcId === rpcId);
    }
    if (index < 0) return;
    const target = items[index]?.target ?? "";
    items.splice(index, 1);
    this.#broadcastQueue(sessionId, target);
  }

  /** 该会话的待执行列表（不存在则建一个）。一个 session 一个列表，不串台。 */
  #queueOf(sessionId) {
    let items = this.#queues.get(sessionId);
    if (items === undefined) {
      items = [];
      this.#queues.set(sessionId, items);
    }
    return items;
  }

  /** 从待执行列表里按目标摘掉最前面的 n 条（宿主取消排队时用）。 */
  #dropQueuedFront(items, target, count) {
    let dropped = 0;
    for (let i = 0; i < items.length && dropped < count; ) {
      if (items[i].target !== target) {
        i++;
        continue;
      }
      items.splice(i, 1);
      dropped += 1;
    }
    return dropped > 0;
  }

  /**
   * 广播该会话**当前全部**待执行消息（契约 §5.2 session.queue）。
   * items 为空数组 = 「没有待执行消息」——也要发，客户端靠它清掉排队列表。
   */
  #broadcastQueue(sessionId, target) {
    const items = this.#queueItemsOf(sessionId);
    // 日志只打 sessionId / 条数 / target——绝不输出消息正文（可能含敏感内容）
    this.#log("info", "session.queue", { sessionId, count: items.length, target });
    this.#sendEvent("session.queue", { sessionId, items });
  }

  /** 该会话当前待执行消息的 wire 形状（itemId/text/target，不含内部用的 rpcId）。 */
  #queueItemsOf(sessionId) {
    return (this.#queues.get(sessionId) ?? []).map((item) => ({
      itemId: item.itemId,
      text: item.text,
      target: item.target,
    }));
  }

  /**
   * 请求 `session.queue`：拉取该会话**当前**的待执行消息。
   *
   * 为什么要有「拉」这一路：事件只在**变化时**推。手机端断线重连后，
   * 若队列在断线期间变过（或断线前就有排队），光靠事件永远补不上
   * ——用户会看到「排队列表空着，但桌面端明明排着一条」。
   * 故客户端打开会话时拉一次全量快照（与事件同形状）。
   */
  async #rSessionQueue(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    // v1.3.0：优先读 Host 的 inbox 持久投影，事件缓存只作旧宿主回退。
    // 这样即使漏掉 inbox/spliced 或 user/message，回前台仍能对账出真实队列。
    try {
      const sc = this.#sc();
      if (typeof sc.projections === "function") {
        const projections = await sc.projections({ sessionId }, this.#signal(10_000));
        const inbox = projections?.values?.inbox;
        if (inbox !== undefined && inbox !== null && typeof inbox === "object") {
          const items = queueItemsFromInbox(inbox);
          this.#queues.set(sessionId, items.map((item) => ({ ...item })));
          this.#reply(m, resultOf(m, { sessionId, items: this.#queueItemsOf(sessionId) }));
          return;
        }
      }
    } catch (e) {
      this.#log("warn", "inbox projection unavailable; falling back to live queue tracking", {
        sessionId,
        error: errText(e),
      });
    }
    this.#reply(m, resultOf(m, { sessionId, items: this.#queueItemsOf(sessionId) }));
  }

  // ---- v1.3.0：待答交互 / Todo / Goal ------------------------------------

  /** 读一个会话的投影值；失败返回 null（调用方自行降级）。 */
  async #projectionValues(sessionId) {
    try {
      const sc = this.#sc();
      if (typeof sc.projections !== "function") return null;
      const projections = await sc.projections({ sessionId }, this.#signal(10_000));
      const values = projections?.values;
      return values && typeof values === "object" ? values : null;
    } catch (e) {
      this.#log("warn", "projection read failed", { sessionId, error: errText(e) });
      return null;
    }
  }

  /** 把一个 Host userQuestions active 行映射成 wire PendingQuestion。 */
  #hostQuestionWire(sessionId, row) {
    const callId = typeof row?.callId === "string" ? row.callId : "";
    if (callId === "") return null;
    const questions = mapWireQuestions(row?.questions);
    if (questions.length === 0) return null;
    const continued = row?.state === "continued";
    return {
      askId: callId,
      sessionId,
      callId,
      questions,
      state: continued ? "continued" : "open",
      answerable: continued,
      source: "host",
      multiSelect: questions.some((q) => q.multiSelect),
    };
  }

  /**
   * 对账 Host userQuestions 投影：把 active 行发布为 question.request，并清掉
   * 已从投影消失的卡片。`tool/result`、user-question-reply 与快照请求都会触发。
   * 任何异常只记录，绝不影响瀑布。
   */
  async #sweepHostQuestions(sessionId) {
    const values = await this.#projectionValues(sessionId);
    const active = values?.userQuestions?.active;
    if (!Array.isArray(active)) return;
    // 已经提交但尚在 Host inbox 等待接纳的迟到回答：桌面 UI 也会暂不显示该卡，
    // 避免用户回答后回前台又看到一张“可再次回答”的重复卡。
    const queuedReplies = new Set();
    const inbox = values?.inbox;
    for (const target of ["next-step", "next-turn"]) {
      const messages = inbox?.[target];
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        const source = message?.source;
        if (source?.kind === "user-question-reply" && typeof source.callId === "string") {
          queuedReplies.add(source.callId);
        }
      }
    }
    const prefix = sessionId + "\0";
    const nextKeys = new Set();
    for (const row of active) {
      const wire = this.#hostQuestionWire(sessionId, row);
      if (wire === null) continue;
      if (wire.state === "continued" && queuedReplies.has(wire.callId)) continue;
      const key = prefix + wire.callId;
      nextKeys.add(key);
      this.#hostQuestions.set(key, wire);
      // 同一 askId 重发 = 状态更新（客户端替换卡片，不叠加）。
      // 旧 App 会把重发当新卡，只有声明 session-state-v1 的客户端才接收状态更新。
      if (this.#clientFeatures.has("session-state-v1")) {
        this.#sendEvent("question.request", wire, wire.state === "continued");
      }
    }
    for (const [key, old] of this.#hostQuestions) {
      if (!key.startsWith(prefix) || nextKeys.has(key)) continue;
      this.#hostQuestions.delete(key);
      this.#sendEvent("question.resolved", { askId: old.askId, source: "desktop" });
    }
  }

  /** pending.interactions：插件实时待答 + Host 投影（指定会话时）合并且按 askId 去重。 */
  async #rPendingInteractions(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    // 能说新请求本身就是能力声明（旧 App 不会发）；幂等补进 feature 集合，
    // 避免新 App 忘记在 hello 声明时把遗留 continued 卡误当旧客户端。
    this.#clientFeatures.add("session-state-v1");
    const questions = [];
    const approvals = [];
    for (const [askId, entry] of this.#pending) {
      if (sessionId !== "" && entry.sessionId !== sessionId) continue;
      if (entry.kind === "approval") {
        approvals.push({
          ...entry.meta,
          askId,
          sessionId: entry.sessionId,
          answerable: true,
          source: "plugin",
          ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
        });
      } else {
        questions.push({
          ...entry.meta,
          askId,
          sessionId: entry.sessionId,
          state: "open",
          answerable: true,
          source: "plugin",
          ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
        });
      }
    }
    if (sessionId !== "") {
      await this.#sweepHostQuestions(sessionId);
      for (const wire of this.#hostQuestions.values()) {
        if (wire.sessionId !== sessionId) continue;
        if (questions.some((q) => q.askId === wire.askId)) continue;
        questions.push(wire);
      }
    }
    this.#reply(m, resultOf(m, { questions, approvals }));
  }

  /** session.todos：Host `todos` 持久投影（只读）。 */
  async #rSessionTodos(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const values = await this.#projectionValues(sessionId);
    const supported = values !== null && Object.prototype.hasOwnProperty.call(values, "todos");
    const todos = !supported || values.todos === null ? null : mapTodoItems(values.todos);
    if (supported) this.#todoSessions.add(sessionId);
    else this.#todoSessions.delete(sessionId);
    this.#reply(m, resultOf(m, { sessionId, todos, supported }));
  }

  /** Goal 人类操作集合（只暴露 Host GoalService 真正存在的方法）。 */
  #goalActions(goals) {
    if (!goals) return [];
    const wanted = ["create", "edit", "pause", "resume", "complete", "clear"];
    return wanted.filter((name) => typeof goals[name] === "function");
  }

  /** 读会话当前 goal + activation（不激活冷会话）。 */
  async #readGoal(sessionId) {
    const values = await this.#projectionValues(sessionId);
    const supported = values !== null && Object.prototype.hasOwnProperty.call(values, "goal");
    const raw = supported ? values.goal : null;
    let activation = null;
    let goal = null;
    if (raw && typeof raw === "object" && raw.goal && typeof raw.goal.id === "string") {
      const cached = this.#goalActivations.get(sessionId);
      if (cached && cached.id === raw.goal.id && cached.revision === raw.goal.revision) {
        activation = cached.activation;
      }
      // 有活 Agent 时从 Host 服务读准确的 activation；绝不为了查询激活冷会话。
      try {
        const agents = this.#service("agents");
        const live = agents && typeof agents.get === "function" ? agents.get(sessionId) : null;
        const goals = this.#service("goals");
        if (live && goals && typeof goals.get === "function") {
          const view = goals.get(live);
          if (view && view.id === raw.goal.id) activation = view.activation === "armed" ? "armed" : "disarmed";
        }
      } catch (e) {
        this.#log("warn", "goal activation read failed", { sessionId, error: errText(e) });
      }
      goal = mapGoalWire(raw.goal, raw.roundsStarted, raw.createdAt, raw.updatedAt, activation);
    }
    return { supported, goal, activation };
  }

  /** v1.3.1：轮次推进（Host 不发 goal/change）→ 重读投影并广播 operation="round"。 */
  async #emitGoalRound(sessionId) {
    try {
      const state = await this.#readGoal(sessionId);
      if (state.goal === null) return;
      const goal = state.goal;
      const cached = this.#goalActivations.get(sessionId);
      if (cached && cached.id === goal.id && cached.revision === goal.revision) {
        goal.activation = cached.activation;
      }
      this.#sendEvent("session.goalChanged", { sessionId, goal, operation: "round" });
    } catch (e) {
      this.#log("warn", "goal round broadcast failed", { sessionId, error: errText(e) });
    }
  }

  /** session.goal：读持久投影 + 进程内 activation。 */
  async #rSessionGoal(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const state = await this.#readGoal(sessionId);
    const goals = this.#service("goals");
    this.#reply(
      m,
      resultOf(m, {
        sessionId,
        goal: state.goal,
        activation: state.activation,
        supported: state.supported || goals !== null,
        actions: this.#goalActions(goals),
      }),
    );
  }

  /** session.goalAction：手机人类操作，走 Host GoalService + CAS ref。 */
  async #rSessionGoalAction(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const action = typeof p.action === "string" ? p.action : "";
    const allowed = ["create", "edit", "pause", "resume", "complete", "clear"];
    if (sessionId === "" || !allowed.includes(action)) {
      this.#reply(m, errorOf(m, "bad-params", "sessionId and a valid action required"));
      return;
    }
    const goals = this.#service("goals");
    if (!goals || typeof goals[action] !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "goals service unavailable"));
      return;
    }
    let agent = null;
    try {
      const sc = this.#sc();
      if (typeof sc.resolveAgent !== "function") throw new Error("sessionController.resolveAgent unavailable");
      const resolved = await sc.resolveAgent(sessionId);
      if (resolved?.error) throw resolved.error;
      agent = resolved?.agent ?? resolved?.session?.agent ?? null;
      if (!agent) throw new Error(`session "${sessionId}" has no live agent`);
    } catch (e) {
      const err = hostErrorOf(e, "goal-agent-unavailable");
      this.#reply(m, errorOf(m, err.code, err.message));
      return;
    }
    let expected = null;
    if (action !== "create") {
      const raw = p.expected;
      if (!raw || typeof raw.id !== "string" || !Number.isInteger(raw.revision) || raw.revision < 1) {
        this.#reply(m, errorOf(m, "bad-params", "expected {id, revision} required"));
        return;
      }
      expected = { id: raw.id, revision: raw.revision };
    }
    const objective = typeof p.objective === "string" ? p.objective.trim() : "";
    const maxGoalRounds = p.maxGoalRounds;
    if ((action === "create" || action === "edit") && objective === "" && action === "create") {
      this.#reply(m, errorOf(m, "bad-params", "objective required for create"));
      return;
    }
    if (action === "edit" && objective === "" && maxGoalRounds === undefined) {
      this.#reply(m, errorOf(m, "bad-params", "edit requires objective or maxGoalRounds"));
      return;
    }
    if (maxGoalRounds !== undefined && (!Number.isInteger(maxGoalRounds) || maxGoalRounds < 1)) {
      this.#reply(m, errorOf(m, "bad-params", "maxGoalRounds must be a positive integer"));
      return;
    }
    try {
      if (action === "create") {
        await goals.create(agent, {
          objective,
          ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
        });
      } else if (action === "edit") {
        await goals.edit(agent, expected, {
          ...(objective === "" ? {} : { objective }),
          ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
        });
      } else if (action === "clear") {
        await goals.clear(agent, expected);
      } else {
        await goals[action](agent, expected);
      }
      const state = await this.#readGoal(sessionId);
      this.#reply(m, resultOf(m, { sessionId, goal: state.goal }));
    } catch (e) {
      const err = hostErrorOf(e, "goal-action-failed");
      this.#log("warn", "goal action failed", { sessionId, action, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  /** 归档集合（宿主没有 Workspace 注册表 → null，表示「不知道」而不是「空」）。 */
  #archivedSessionIds() {
    const reg = this.#workspaceRegistry();
    if (!reg) return null;
    try {
      const ids = reg.archivedSessionIds;
      if (!Array.isArray(ids)) return null;
      return ids.map((id) => String(id));
    } catch (e) {
      this.#log("warn", "archivedSessionIds read failed", { error: errText(e) });
      return null;
    }
  }

  /** Workspace 注册表（宿主没装 dsh-workspace → null）。 */
  #workspaceRegistry() {
    return this.#service("workspaceRegistry");
  }

  /**
   * v1.1.4：按 cwd 反查它是否属于某个**已注册工作区**的目录。
   * 命中返回该工作区的 id（供 `session.create` 传 `workspaceId` 归组），
   * 否则返回 null（调用方退回传 cwd，与 PC 在普通目录新建一样 = 未分组）。
   *
   * 用宿主 `workspaceRegistry.resolveByPath`：按 canonical path 匹配，
   * **不创建**工作区、不改写注册表；目录不存在会 reject。
   * 任何异常（服务缺失 / 方法不存在 / 路径解析失败）都兜底回 null——
   * 归组是增强，绝不能因此让 session.create 失败。
   * @param {string} cwd
   * @returns {Promise<string|null>}
   */
  async #resolveWorkspaceByCwd(cwd) {
    try {
      const reg = this.#workspaceRegistry();
      if (!reg || typeof reg.resolveByPath !== "function") return null;
      const ws = await reg.resolveByPath(cwd);
      const id = typeof ws?.id === "string" && ws.id !== "" ? ws.id : null;
      if (id !== null) {
        this.#log("info", "session.create cwd matches a workspace; attaching to it", {
          workspaceId: id,
        });
      }
      return id;
    } catch (e) {
      this.#log("warn", "resolveByPath failed; session stays ungrouped", { error: errText(e) });
      return null;
    }
  }

  /** 事件监听包装：emit 监听必须永不抛出。 */
  #on(name, handler) {
    const wrapped = (...args) => {
      try {
        handler(...args);
      } catch (e) {
        this.#log("warn", "event listener error", { event: name, error: errText(e) });
      }
    };
    this.#ctx.on(name, wrapped);
    this.#disposers.push(() => {
      try {
        this.#ctx.off?.(name, wrapped);
      } catch {
        /* ctx 生命周期自行回收 */
      }
    });
  }

  /** 释放全部资源（定时器/待答项/监听）。 */
  dispose() {
    this.#disposed = true;
    for (const b of this.#streamBuf.values()) {
      if (b.timer !== null) clearTimeout(b.timer);
    }
    this.#streamBuf.clear();
    for (const entry of this.#pending.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (entry.signal && entry.abortHandler) {
        try {
          entry.signal.removeEventListener("abort", entry.abortHandler);
        } catch {
          /* ignore */
        }
      }
      // 插件卸载：待答项一律以超时语义放行（next() 已在其 promise 里挂好）
      entry.resolve({ settled: "timeout" });
    }
    this.#pending.clear();
    this.#hostQuestions.clear();
    this.#goalActivations.clear();
    this.#askQuestionCalls.clear();
    this.#todoSessions.clear();
    this.#clientFeatures.clear();
    for (const off of this.#disposers) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.#disposers = [];
  }

  // ---- 出站事件 ------------------------------------------------------------

  /**
   * 发一条 §5.2 事件；链路未就绪返回 false（中继另有离线缓存）。
   * @returns {boolean} 帧是否交给了链路
   */
  #sendEvent(topic, data, urgent = false) {
    try {
      return this.#relay.send(msg("event", { topic, data }), urgent) === true;
    } catch (e) {
      this.#log("warn", "event send failed", { topic, error: errText(e) });
      return false;
    }
  }

  /** 推送通道状态（契约 §5.2 push.state）。 */
  sendPushState() {
    const cfg = this.#cfg.push;
    const configured = this.#push.configured === true;
    const data = configured
      ? { enabled: true }
      : { enabled: false, reason: this.#push.unavailableReason ? this.#push.unavailableReason() : "not configured" };
    this.#sendEvent("push.state", data);
    void cfg;
  }

  // ---- v1.0.9：会话消息里的图片（契约 §5.10）-------------------------------

  /**
   * 记下 imageId → 宿主附件引用（image.fetch 要用原始字节）。
   * 插件重启后这张表是空的——此时 image.fetch 回明确错误（不是崩溃）。
   * @param {object[]} images ImageRef[]
   */
  #rememberImages(images) {
    for (const image of Array.isArray(images) ? images : []) {
      const imageId = typeof image?.imageId === "string" ? image.imageId : "";
      if (imageId === "") continue;
      const ref = attachmentRefOf(image);
      if (ref) this.#imageRefs.set(imageId, ref);
    }
  }

  /**
   * assistant/message 事件里的图片 → 广播 `assistant.image`（契约 §5.2/§5.10）。
   *
   * 缩略图必须**内联**（客户端立刻显示），所以这里要读字节 + 压缩（异步）；
   * 压缩失败/附件读不到 → thumb 留空，只发元数据（客户端画占位框）。
   * @param {string} sessionId
   * @param {any} event 宿主会话事件
   */
  #emitAssistantImages(sessionId, event) {
    try {
      // 与历史同口径：只收 append 表面事件（replace 是模型可见的影子副本）
      if (event?.surfaceOp !== "append") return;
      const refs = imageBlocksOf(event?.data?.message?.content);
      if (refs.length === 0) return;
      void this.#sendAssistantImages(sessionId, refs);
    } catch (e) {
      this.#log("warn", "assistant image bridge error", { sessionId, error: errText(e) });
    }
  }

  /**
   * 逐张生成缩略图并广播 assistant.image。
   * @param {string} sessionId
   * @param {object[]} refs 宿主附件引用
   */  async #sendAssistantImages(sessionId, refs) {
    const attachments = attachmentsOf(this.#ctx);
    for (const ref of refs) {
      const image = imageRefMeta(ref);
      if (image.imageId === "") continue;
      this.#imageRefs.set(image.imageId, ref);
      try {
        const bytes = await readAttachmentBytes(attachments, ref, undefined);
        if (bytes) image.thumb = await makeThumb(bytes, image.mediaType);
      } catch (e) {
        // 只发元数据（thumb 留空）——图片失败不影响消息流
        this.#log("warn", "assistant image thumb failed", { sessionId, imageId: image.imageId, error: errText(e) });
      }
      // 注意：日志里**绝不**输出 data URI / base64（可能含敏感图片内容）
      this.#log("info", "assistant.image", {
        sessionId,
        imageId: image.imageId,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
        thumbBytes: image.thumb.length,
      });
      this.#sendEvent("assistant.image", { sessionId, image });
    }
  }

  /**
   * present 投递的文件（deliverables/presented）里的**图片** → assistant.image。
   *
   * 宿主对「present 出来的文件」只记路径（没有附件引用、没有尺寸），
   * 所以图片块那条路（imageBlocksOf）永远看不到它们 → 手机端一片空白。
   * 这里自己认类型、读字节、量尺寸、压缩略图，按 §5.10 同一套通道发出去。
   *
   * 非图片文件（.md/.zip/…）跳过：文件卡片是另一条通道，不在本轮范围。
   * @param {string} sessionId
   * @param {any} event 宿主会话事件（data.files = [{path, name?, description?}]）
   */
  async #emitDeliveredImages(sessionId, event) {
    try {
      const files = Array.isArray(event?.data?.files) ? event.data.files : [];
      for (const file of files) {
        const path = typeof file?.path === "string" ? file.path.trim() : "";
        if (path === "") continue;
        const mediaType = mediaTypeOfPath(path);
        if (mediaType === "") continue; // 非图片 → 跳过
        const bytes = await this.#readDeliveredFile(path);
        if (bytes === null) continue;
        const meta = await imageMetaOf(bytes);
        const imageId = deliveredImageId(path, event?.data?.turn);
        this.#deliveredImages.set(imageId, { path, mediaType });
        const image = {
          imageId,
          mediaType,
          width: meta.width,
          height: meta.height,
          bytes: bytes.length,
          // v1.1.1（契约 §5.10.1）：交付物图片的 ImageRef 带 source:"deliverable"
          // （附件来源的图片**不带**这个字段——旧客户端按缺省 "attachment" 处理）。
          source: "deliverable",
          thumb: await makeThumb(bytes, mediaType),
        };
        // v1.1.1（契约 §5.10.2）：记进本会话的交付物历史条目——否则 turn 结束
        // 刷新历史时，那条挂着图片的 assistant 消息被宿主的持久副本替换 →
        // 图片「一闪而过然后消失」。
        this.#rememberDeliveredImage(sessionId, {
          seq: Math.max(0, eventSeq(event)),
          ts: eventTime(event),
          imageId,
          mediaType,
          width: meta.width,
          height: meta.height,
          bytes: bytes.length,
          path,
        });
        // 日志绝不输出路径/字节内容（路径可能含敏感目录名，base64 更不能落日志）
        this.#log("info", "delivered image bridged", {
          sessionId,
          imageId,
          mediaType,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
          thumbBytes: image.thumb.length,
        });
        this.#sendEvent("assistant.image", { sessionId, image });
      }
    } catch (e) {
      this.#log("warn", "delivered image bridge error", { sessionId, error: errText(e) });
    }
  }

  /**
   * 读 present 投递的文件字节（超限 / 读不到 → null，绝不抛）。
   * @param {string} path 绝对路径
   * @returns {Promise<Buffer|null>}
   */
  async #readDeliveredFile(path) {
    try {
      const bytes = await readFile(path);
      if (!bytes || bytes.length === 0) return null;
      if (bytes.length > DELIVERED_MAX_BYTES) return null; // 太大不桥接（避免内存/带宽事故）
      return bytes;
    } catch {
      return null;
    }
  }

  // ---- v1.1.1（契约 §5.10.2）：交付物图片在历史里的位置 ------------------------

  /**
   * 记下本会话交付过的一张图片（历史回包要靠它补出独立图片消息）。
   * 同一 imageId 重复 present（同一文件同一 turn）→ 幂等，不重复入列。
   * @param {string} sessionId
   * @param {object} entry {seq, ts, imageId, mediaType, width, height, bytes, path}
   */
  #rememberDeliveredImage(sessionId, entry) {
    let entries = this.#deliveredEntries.get(sessionId);
    if (entries === undefined) {
      entries = [];
      this.#deliveredEntries.set(sessionId, entries);
    }
    if (entries.some((item) => item.imageId === entry.imageId)) return;
    entries.push(entry);
  }

  /**
   * 交付物图片 → **独立**的历史消息（契约 §5.10.2）。
   *
   * 交付物图片**不挂**在 assistant 气泡上：那条气泡在 turn 结束后的历史刷新里
   * 会被宿主的持久副本替换（副本里没有交付物图片）→ 图片闪一下就没了。
   * 故这里补一条正文为空串的独立消息，缩略图内联（读不到文件则 thumb 留空，
   * 只发元数据）。整页缩略图有总预算，超了后续图片只发元数据——但**消息本身保留**
   * （客户端至少知道有这么一张图）。
   * @param {string} sessionId
   * @returns {Promise<object[]>} ChatMessage[]
   */
  async #deliveredHistoryMessages(sessionId) {
    const entries = this.#deliveredEntries.get(sessionId);
    if (!entries || entries.length === 0) return [];
    const out = [];
    let used = 0;
    for (const entry of entries) {
      let thumb = await this.#deliveredThumb(entry);
      if (thumb !== "") {
        const size = thumb.length - THUMB_DATA_URI_PREFIX.length;
        if (used + size > THUMB_PAGE_BUDGET) thumb = "";
        else used += size;
      }
      out.push({
        id: `d${entry.imageId}`,
        role: "assistant",
        text: "",
        ts: entry.ts,
        seq: entry.seq,
        images: [
          {
            imageId: entry.imageId,
            mediaType: entry.mediaType,
            width: entry.width,
            height: entry.height,
            bytes: entry.bytes,
            source: "deliverable",
            thumb,
          },
        ],
      });
    }
    return out;
  }

  /** 交付物图片的缩略图（读盘 → 压缩）；读不到就只发元数据（thumb 留空）。 */
  async #deliveredThumb(entry) {
    const cached = this.#deliveredThumbs.get(entry.imageId);
    if (cached !== undefined) return cached;
    let thumb = "";
    const bytes = await this.#readDeliveredFile(entry.path);
    if (bytes !== null) {
      try {
        thumb = await makeThumb(bytes, entry.mediaType);
      } catch {
        thumb = "";
      }
    }
    this.#deliveredThumbs.set(entry.imageId, thumb);
    this.#pruneDeliveredThumbs();
    return thumb;
  }

  /** 交付物缩略图缓存上限（避免长期运行把内存吃满）。 */
  #pruneDeliveredThumbs() {
    const limit = 64;
    while (this.#deliveredThumbs.size > limit) {
      const oldest = this.#deliveredThumbs.keys().next();
      if (oldest.done) break;
      this.#deliveredThumbs.delete(oldest.value);
    }
  }

  /**
   * 契约 §5.1 image.fetch：拉取大图（等比缩放 + JPEG q85，base64 ≤ 1MiB 预算）。
   *
   * 失败**不影响**会话其余功能（图片可选，不阻塞消息流）：一切失败都回 error。
   * @param {object} m 入站信封
   */
  async #rImageFetch(m) {
    const p = m.payload ?? {};
    const imageId = typeof p.imageId === "string" ? p.imageId.trim() : "";
    if (imageId === "") {
      this.#reply(m, errorOf(m, "bad-params", "imageId required"));
      return;
    }
    const maxEdge = clampMaxEdge(p.maxEdge);
    const ref = this.#imageRefs.get(imageId);
    const delivered = ref ? null : this.#deliveredImages.get(imageId);
    if (!ref && !delivered) {
      // 插件重启后缓存为空（或该图不在本次会话里）——回明确文案，不崩
      this.#reply(
        m,
        errorOf(
          m,
          "image-not-found",
          "图片不可用，请重新加载会话后再试（插件重启后图片缓存已清空）。",
        ),
      );
      return;
    }
    const cacheKey = `${imageId}:${maxEdge}`;
    const cached = this.#imageCache.get(cacheKey);
    if (cached !== undefined) {
      this.#reply(m, resultOf(m, cached));
      return;
    }
    try {
      // 两条来源：宿主附件（读附件服务）/ present 投递的文件（直接读盘）
      let bytes = null;
      let mediaType = "";
      if (delivered) {
        bytes = await this.#readDeliveredFile(delivered.path);
        mediaType = delivered.mediaType;
      } else {
        const attachments = attachmentsOf(this.#ctx);
        if (!attachments) {
          this.#reply(m, errorOf(m, "service-unavailable", "attachments service unavailable"));
          return;
        }
        bytes = await readAttachmentBytes(attachments, ref, this.#signal(30_000));
        mediaType = typeof ref?.mediaType === "string" ? ref.mediaType : "";
      }
      if (!bytes) {
        this.#reply(m, errorOf(m, "image-read-failed", "无法读取该图片的原始字节。"));
        return;
      }
      const out = await makeLarge(bytes, mediaType, maxEdge);
      const value = {
        imageId,
        mediaType: out.mediaType,
        width: out.width,
        height: out.height,
        data: out.data,
      };
      // 帧预算守卫：中继 1MiB 是 ws 单帧上限（超了断链）——大图回包必须自己守住
      if (JSON.stringify(value).length > REPLY_PLAIN_MAX_BYTES) {
        this.#reply(
          m,
          errorOf(m, "image-too-large", "原图过大，仅可看缩略图（请以更小的尺寸重试）。"),
        );
        return;
      }
      this.#imageCache.set(cacheKey, value);
      this.#pruneImageCache();
      // 日志只打 imageId/尺寸/字节数——**绝不**输出 data URI / base64
      this.#log("info", "image.fetch served", {
        imageId,
        maxEdge,
        width: out.width,
        height: out.height,
        sourceBytes: bytes.length,
        dataBytes: out.data.length,
      });
      this.#reply(m, resultOf(m, value));
    } catch (e) {
      this.#log("warn", "image.fetch failed", { imageId, maxEdge, error: errText(e) });
      this.#reply(m, errorOf(m, "image-encode-failed", errText(e)));
    }
  }

  /** 大图缓存上限（避免长期运行把内存吃满）。 */
  #pruneImageCache() {
    const limit = 32;
    while (this.#imageCache.size > limit) {
      const oldest = this.#imageCache.keys().next();
      if (oldest.done) break;
      this.#imageCache.delete(oldest.value);
    }
  }

  // ---- assistant 流式增量：统一保序缓冲（正文 + 思考，v1.1.x）---------------

  /**
   * 入队一个流式增量块。
   *
   * 规则：
   *  - 正文（text）与思考（reasoning）进**同一条队列**，块按到达顺序排；
   *  - 同一窗口内**只合并相邻同类**块（尾块同类就并进去）；
   *  - 不同类**不跨块合并**——否则 reasoning 与 text 会糊成一条，
   *    冲刷时无法还原原始先后顺序。
   *
   * @param {string} sessionId
   * @param {"text"|"reasoning"} kind
   * @param {string} text
   */
  #queueStream(sessionId, kind, text) {
    if (this.#disposed) return; // dispose() 后不再产生任何出站
    let b = this.#streamBuf.get(sessionId);
    if (b === undefined) {
      b = { blocks: [], timer: null };
      this.#streamBuf.set(sessionId, b);
    }
    const last = b.blocks[b.blocks.length - 1];
    if (last !== undefined && last.kind === kind) {
      last.text += text;
    } else {
      b.blocks.push({ kind, text });
    }
    this.#trimStreamBuffer(b);
    if (b.timer === null) {
      b.timer = setTimeout(() => this.#flushStream(sessionId), Math.ceil(1000 / ASSISTANT_THROTTLE_PER_SEC));
    }
  }

  /**
   * 内存上限：单会话待发文本（正文 + 思考合计）不超过 STREAM_BUFFER_MAX_CHARS。
   *
   * 超了从**最旧**的内容开始丢（保序：只丢头，不动类型顺序，也不丢新内容）。
   * 块数另有 STREAM_BUFFER_MAX_BLOCKS 上限（类型频繁切换时的兜底）。
   * @param {{blocks:{kind:string,text:string}[]}} b
   */
  #trimStreamBuffer(b) {
    let total = 0;
    for (const blk of b.blocks) total += blk.text.length;
    let excess = total - STREAM_BUFFER_MAX_CHARS;
    while (excess > 0 && b.blocks.length > 0) {
      const first = b.blocks[0];
      if (first.text.length <= excess) {
        excess -= first.text.length;
        b.blocks.shift();
      } else {
        first.text = first.text.slice(excess);
        excess = 0;
      }
    }
    while (b.blocks.length > STREAM_BUFFER_MAX_BLOCKS) b.blocks.shift();
  }

  /**
   * 冲刷一个会话的全部待发块：**严格按原始 chunk 顺序**逐块发
   * （assistant.delta / assistant.reasoningDelta），跨类型也保序。
   * @param {string} sessionId
   */
  #flushStream(sessionId) {
    const b = this.#streamBuf.get(sessionId);
    if (b === undefined) return;
    if (b.timer !== null) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    const blocks = b.blocks;
    b.blocks = [];
    // 空了就别占着 map（会话很多时避免无界增长）
    if (this.#streamBuf.get(sessionId) === b) this.#streamBuf.delete(sessionId);
    if (this.#disposed) return; // dispose() 后不再产生任何出站
    for (const blk of blocks) {
      if (blk.text === "") continue;
      if (blk.kind === "reasoning") {
        this.#sendEvent("assistant.reasoningDelta", { sessionId, text: blk.text });
      } else {
        this.#sendEvent("assistant.delta", { sessionId, text: blk.text });
      }
    }
  }

  /** 丢弃某会话的待发块（会话没了）——清定时器 + 清队列。 */
  #dropStream(sessionId) {
    const b = this.#streamBuf.get(sessionId);
    if (b === undefined) return;
    if (b.timer !== null) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    b.blocks = [];
    this.#streamBuf.delete(sessionId);
  }

  // ---- 业务请求分发（§5.1）---------------------------------------------------

  /**
   * 分发一条已解密、已消毒的入站业务消息；异步，内部全量兜底。
   * @param {object} m
   */
  async dispatch(m) {
    try {
      switch (m.type) {
        case "hello":
          return this.#rHello(m);
        case "ping":
          return this.#reply(m, resultOf(m, { pong: Date.now() }));
        case "session.list":
          return await this.#rSessionList(m);
        case "session.history":
          return await this.#rSessionHistory(m);
        case "session.subagents":
          return await this.#rSessionSubagents(m);
        case "session.subagentPrompt":
          return await this.#rSubagentPrompt(m);
        case "session.subagentCancel":
          return await this.#rSubagentCancel(m);
        case "session.create":
          return await this.#rSessionCreate(m);
        case "session.capabilities":
          return await this.#rSessionCapabilities(m);
        case "session.selectModel":
          return await this.#rSessionSelectModel(m);
        case "session.model":
          return await this.#rSessionModel(m);
        case "session.selectPermission":
          return await this.#rSessionSelectPermission(m);
        case "session.permission":
          return await this.#rSessionPermission(m);
        case "session.queue":
          return await this.#rSessionQueue(m);
        case "pending.interactions":
          return await this.#rPendingInteractions(m);
        case "session.todos":
          return await this.#rSessionTodos(m);
        case "session.goal":
          return await this.#rSessionGoal(m);
        case "session.goalAction":
          return await this.#rSessionGoalAction(m);
        case "session.archive":
          return await this.#rSessionArchive(m);
        case "session.unarchive":
          return await this.#rSessionUnarchive(m);
        case "session.prompt":
          return await this.#rSessionPrompt(m);
        case "attachment.upload.begin":
          return await this.#rAttachmentUploadBegin(m);
        case "attachment.upload.chunk":
          return await this.#rAttachmentUploadChunk(m);
        case "attachment.upload.commit":
          return await this.#rAttachmentUploadCommit(m);
        case "attachment.upload.abort":
          return await this.#rAttachmentUploadAbort(m);
        case "session.cancel":
          return await this.#rSessionCancel(m);
        case "session.rename":
          return await this.#rSessionRename(m);
        case "image.fetch":
          // v1.0.9（§5.10）：拉取大图（缩略图已内联，这里按需给原图）
          return await this.#rImageFetch(m);
        case "approval.answer":
          return this.#rApprovalAnswer(m);
        case "question.answer":
          return await this.#rQuestionAnswer(m);
        case "push.register":
          return this.#rPushRegister(m);
        default:
          return this.#reply(m, errorOf(m, "bad-type", "unknown type: " + m.type));
      }
    } catch (e) {
      this.#log("error", "dispatch failed", { type: m.type, error: errText(e) });
      try {
        this.#reply(m, errorOf(m, "internal", errText(e)));
      } catch {
        /* 链路已断 */
      }
    }
  }

  /** 入站信封消毒入口（relay onMessage 调用）。 */
  onPlainMessage(plain) {
    const m = sanitizeEnvelope(plain);
    if (m === null) {
      this.#log("warn", "dropped malformed envelope");
      return;
    }
    void this.dispatch(m);
  }

  #reply(m, envelope) {
    this.#relay.send(envelope, false);
  }

  /** sessionController（缺失时回 service-unavailable，不抛）。 */
  #sc() {
    const sc = this.#ctx.get("sessionController");
    if (!sc) throw new Error("sessionController unavailable");
    return sc;
  }

  /**
   * 取一个宿主服务（agentPresets / permissionPresets …）。
   * ctx.get 对不存在的服务会抛（不同宿主版本行为不一致），故 try/catch + 判空，
   * 再兜一层 ctx[name] 直取。取不到一律返回 null（能力目录降级为空）。
   */
  #service(name) {
    try {
      const svc = this.#ctx.get(name);
      if (svc) return svc;
    } catch {
      /* 服务未注册 */
    }
    try {
      const svc = this.#ctx[name];
      return svc ?? null;
    } catch {
      return null;
    }
  }

  /** 带超时的 AbortSignal（Remote 方法都收 signal）。 */
  #signal(ms = 15_000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    // 不 unref：abort 超时必须真正触发。abort 事件里 clearTimeout，
    // 所以定时器不会阻止进程退出，也不泄漏。
    ac.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    return ac.signal;
  }

  #rHello(m) {
    const p = m.payload ?? {};
    if (typeof p.pushToken === "string" && p.pushToken !== "") this.#pushToken = p.pushToken;
    this.#clientFeatures = new Set(
      Array.isArray(p.features)
        ? p.features.filter((f) => typeof f === "string" && f !== "").slice(0, 16)
        : [],
    );
    this.#reply(
      m,
      resultOf(m, {
        hostName: this.#hostName,
        dshVersion: this.#dshVersion,
        pluginVersion: this.#pluginVersion,
      }),
    );
    // 每次连接（含重连）同步一次推送通道状态（契约 §5.2 push.state）
    this.sendPushState();
  }

  async #rSessionList(m) {
    try {
      const value = await this.#sc().list({}, this.#signal());
      // v1.0.7（§5.9）：归档标记来自 Workspace 注册表（不是本机伪造状态）。
      // 宿主没有注册表 → 不产出 archived 字段（客户端按 false 处理）。
      const archivedIds = this.#archivedSessionIds();
      const sessions = [];
      for (const item of value?.items ?? []) {
        const s = mapSummary(item, archivedIds ?? undefined);
        if (s.sessionId) {
          if (s.title) this.#titles.set(s.sessionId, s.title);
          sessions.push(s);
        }
      }
      this.#reply(m, resultOf(m, { sessions }));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-list-failed", errText(e)));
    }
  }

  /** 契约 §5.1 session.history：向后翻页的历史消息页（v1.0.4）。
   *
   *  宿主 API 分代（DSH 0.2.2-rc.1 起换了历史入口）：
   *   - 新宿主：sessionController.events({address, throughSeq?, beforeSeq?, maxMessages?})。
   *     **省略 throughSeq 即取当前日志末尾**（宿主自己算 observation.cursor），
   *     所以不再需要先 inspect() 拿尾 seq——旧宿主那套 inspect()+page() 在新宿主上
   *     会直接抛 "sc.inspect is not a function"，手机端表现为「历史消息加载不了」。
   *   - 旧宿主：只有 inspect()（拿日志尾 seq + subagent 身份）与 page()，保留原路径。
   *
   *  向前翻页：客户端回传上一页的 oldestSeq 作 beforeSeq（开区间）。 */
  async #rSessionHistory(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    let maxMessages = Number.isSafeInteger(p.maxMessages) ? p.maxMessages : HISTORY_DEFAULT_MAX;
    if (maxMessages <= 0) maxMessages = HISTORY_DEFAULT_MAX;
    if (maxMessages > HISTORY_MAX_LIMIT) maxMessages = HISTORY_MAX_LIMIT;
    const beforeSeq =
      Number.isSafeInteger(p.beforeSeq) && p.beforeSeq >= 0 ? p.beforeSeq : undefined;
    const signal = this.#signal(30_000);
    try {
      const sc = this.#sc();
      while (true) {
        // 每轮都重建完整回包：fitReplyBudget 会就地剥缩略图 / 删 images[]，
        // 尤其不能把上一轮已追加的交付物图片对象带进下一次重试。
        const delivered = await this.#deliveredHistoryMessages(sessionId);
        const page = await this.#readHistoryPage(sc, sessionId, maxMessages, beforeSeq, signal);
        const messages = [];
        let oldestSeq = Number.MAX_SAFE_INTEGER;
        let oldestEventSeq = Number.MAX_SAFE_INTEGER;
        for (const record of page?.records ?? []) {
          const rawSeq = Number(record?.event?.seq);
          if (Number.isSafeInteger(rawSeq) && rawSeq >= 0 && rawSeq < oldestEventSeq) {
            oldestEventSeq = rawSeq;
          }
          // v1.0.7：一条事件可能产出「思考 + 正文」两条（mapHistoryMessages）
          for (const mapped of mapHistoryMessages(sessionId, record)) {
            messages.push(mapped);
            // v1.0.9（§5.10）：记下 imageId → 附件引用（image.fetch 要用原始字节）
            this.#rememberImages(mapped.images);
            if (mapped.seq < oldestSeq) oldestSeq = mapped.seq;
          }
        }
        if (oldestSeq === Number.MAX_SAFE_INTEGER) {
          // 本页无可聊消息（全被过滤）→ 用页内最老事件 seq 续翻，避免卡页
          oldestSeq = oldestEventSeq === Number.MAX_SAFE_INTEGER ? 0 : oldestEventSeq;
        }
        // v1.0.9（§5.10）：缩略图必须内联（客户端立刻显示）——这里补齐
        await attachThumbs(messages, this.#ctx);
        // v1.1.1（§5.10.2）：交付物图片作为**独立**的历史消息追加进去
        // （宿主的持久副本里没有它们 → 不补的话图片「一闪而过然后消失」）。
        messages.push(...delivered);
        // v1.0.6（§5.7）：工作步骤（工具调用）——旧客户端只读 messages，不受影响
        const steps = mapHistorySteps(page?.records ?? []);
        // v1.0.9：帧预算守卫——中继的 1MiB 是 **ws 单帧**上限，超了 ws 直接断链
        // （不是丢一帧）。先剥缩略图、再丢 images[]；只剩文字仍超限时自动减半
        // 页大小并重读。只有单条消息仍装不下时才回 history-too-large。
        const value = { messages, steps, hasMore: page?.hasMore === true, oldestSeq };
        const fit = fitReplyBudget(value);
        if (fit.strippedThumbs > 0 || fit.strippedImages > 0) {
          this.#log("warn", "history reply trimmed to fit the relay frame budget", {
            sessionId,
            strippedThumbs: fit.strippedThumbs,
            strippedImages: fit.strippedImages,
            bytes: fit.bytes,
          });
        }
        if (!fit.overflow) {
          // 游标必须属于实际成功的这一页，而不是首次超限的大页。
          this.#reply(m, resultOf(m, fit.value));
          return;
        }
        if (maxMessages <= 1) {
          this.#reply(
            m,
            errorOf(
              m,
              "history-too-large",
              "这一页会话内容过大，无法在一帧内传输（请缩小每页条数后重试）。",
            ),
          );
          return;
        }
        const retryMaxMessages = Math.max(1, Math.floor(maxMessages / 2));
        this.#log("warn", "history reply still too large; retrying with fewer messages", {
          sessionId,
          maxMessages,
          retryMaxMessages,
          bytes: fit.bytes,
        });
        maxMessages = retryMaxMessages;
      }
    } catch (e) {
      this.#reply(m, errorOf(m, "session-history-failed", errText(e)));
    }
  }

  /**
   * 读一页会话历史（宿主 API 分代适配层）。
   *
   * 新宿主（DSH 0.2.2-rc.1+）：走 events()。
   *   - **不传 throughSeq**：宿主会自己取当前日志末尾作为切点
   *     （resolveHistoryRequest 允许省略；history() 用 observation.cursor，
   *     它就是日志最后一条事件的 seq —— 与旧路径 inspect() 算出的 cursor 等价）。
   *   - 向前翻页只传 beforeSeq（开区间），宿主自己与末尾取交集。
   * 旧宿主（0.2.1 及更早）：先 inspect() 冷读拿日志尾 seq（throughSeq 必须是真实
   *   存在的 seq，传 MAX_SAFE_INTEGER 会被 bad-request 拒为 past cursor），再 page()。
   *
   * 版本判据（实测 0.2.1-rc.5 无 events()、有 inspect()；0.2.2-rc.1 有 events()、
   * 无 inspect()）：**以 events() 的存在与否分流**，不靠版本号猜。
   *
   * @param {any} sc sessionController
   * @param {string} sessionId
   * @param {number} maxMessages
   * @param {number|undefined} beforeSeq
   * @param {AbortSignal} signal
   * @returns {Promise<{records:any[],hasMore:boolean}>}
   */
  async #readHistoryPage(sc, sessionId, maxMessages, beforeSeq, signal) {
    if (typeof sc.events === "function") {
      const address = await this.#historyAddress(sc, sessionId, signal);
      const request = { address, maxMessages };
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
      const page = await sc.events(request, signal);
      return { records: page?.records ?? [], hasMore: page?.hasMore === true };
    }
    // 旧宿主：inspect + page。
    const inspected = await sc.inspect(sessionId, signal);
    const events = inspected?.events;
    let cursor = -1;
    let address = historyAddress(sessionId);
    if (Array.isArray(events) && events.length > 0) {
      const lastSeq = Number(events[events.length - 1]?.seq);
      if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) cursor = lastSeq;
    }
    // subagent 会话必须走 durable subagent 地址（宿主校验：kind:'session' 会被拒）
    const header = inspected?.meta;
    const parent = typeof header?.parentSession === "string" ? header.parentSession : "";
    if (header?.origin === "subagent" && parent !== "") {
      address = historyAddress(sessionId, parent);
    }
    if (cursor < 0) {
      // 空会话（无任何事件）：直接回空页，不折腾 page
      // （交付物图片仍要带上——它们不在宿主的会话日志里）
      return { records: [], hasMore: false };
    }
    const request = { address, throughSeq: cursor, maxMessages };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    const page = await sc.page(request, signal);
    return { records: page?.records ?? [], hasMore: page?.hasMore === true };
  }

  /**
   * 解析会话历史的宿主地址（新宿主路径）。
   *
   * 子代理会话必须用 durable subagent 地址；它的父会话 id 从**冷读**的
   * sessionController.list() 里取（list 不激活 Agent）。
   * list() 拿不到（例如会话已不在可见列表里）→ 退回普通会话地址，
   * 由宿主自己判定（子代理用 kind:'session' 会被拒为 session/agent-busy，
   * 错误原样回给手机端，不静默吞掉）。
   * @param {any} sc sessionController
   * @param {string} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<{kind:string,sessionId?:string,parentSessionId?:string,childSessionId?:string,mode?:string}>}
   */
  async #historyAddress(sc, sessionId, signal) {
    try {
      const listed = await sc.list({}, signal);
      for (const raw of listed?.items ?? []) {
        if (String(raw?.sessionId ?? "") !== sessionId) continue;
        const parent = typeof raw?.parentSessionId === "string" ? raw.parentSessionId : "";
        if (raw?.origin === "subagent" && parent !== "") {
          return historyAddress(sessionId, parent);
        }
        return historyAddress(sessionId);
      }
    } catch (e) {
      this.#log("warn", "history address lookup failed; using plain session address", {
        sessionId,
        error: errText(e),
      });
    }
    return historyAddress(sessionId);
  }

  /**
   * 冷读判定一个会话是不是子代理（**绝不激活 Agent**）。
   *
   * 新宿主没有 inspect() 了 → 用 list() 的 origin/parentSessionId 字段
   * （宿主 listFields(header) 直接带出这两个字段，与旧宿主 inspect().meta 同源）。
   * 旧宿主仍走 inspect()（更快，且不必列举全部会话）。
   *
   * 用途：权限查询的 live 降级前必须先判身份——子代理绝不能为了显示权限
   * 而 resolveAgent 激活它（v1.1.7 规则）。
   * @param {any} sc sessionController
   * @param {string} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<boolean>}
   */
  async #isSubagentSession(sc, sessionId, signal) {
    try {
      if (typeof sc.inspect === "function") {
        const inspected = await sc.inspect(sessionId, signal);
        const meta = inspected?.meta;
        return (
          meta?.origin === "subagent" ||
          (typeof meta?.parentSession === "string" && meta.parentSession !== "") ||
          (typeof meta?.parentSessionId === "string" && meta.parentSessionId !== "")
        );
      }
      const listed = await sc.list({}, signal);
      for (const raw of listed?.items ?? []) {
        if (String(raw?.sessionId ?? "") !== sessionId) continue;
        if (raw?.origin === "subagent") return true;
        return typeof raw?.parentSessionId === "string" && raw.parentSessionId !== "";
      }
      return false;
    } catch (e) {
      this.#log("warn", "subagent identity cold read unavailable", {
        sessionId,
        error: errText(e),
      });
      // 判不出来 → 按“不是子代理”处理（宿主对普通会话的权限查询是安全的）；
      // 真子代理会走 resolveAgent 路径，但那是宿主的既有行为，不是我们引入的。
      return false;
    }
  }

  /** 契约 §5.1 session.subagents（v1.0.5）：父会话直接子代理目录。
   *  数据组合：父会话 subagentCatalog 持久投影（mode/label/createdAt/顺序，
   *  经 sessionController.projections 冷读，无 Agent 激活）+ list 全量行
   *  （running / hasChildren 血缘推断）。投影缺失/冷会话 → 空目录（不报错）。 */
  async #rSessionSubagents(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    try {
      const sc = this.#sc();
      const signal = this.#signal(20_000);
      let entries = [];
      try {
        const projections = await sc.projections({ sessionId }, signal);
        const values = projections?.values;
        const catalog = values?.subagentCatalog;
        if (Array.isArray(catalog)) entries = catalog;
      } catch {
        entries = []; // 无投影/冷会话 → 空目录
      }
      let rowsById = null;
      let allRows = [];
      if (entries.length > 0) {
        try {
          const listed = await sc.list({}, signal);
          rowsById = new Map();
          for (const raw of listed?.items ?? []) {
            const s = mapSummary(raw);
            if (!s.sessionId) continue;
            rowsById.set(s.sessionId, s);
            allRows.push(s);
          }
        } catch {
          rowsById = null; // list 失败 → running/hasChildren 退化默认值
          allRows = [];
        }
      }
      const subagents = [];
      for (const e of entries) {
        const id = typeof e?.id === "string" ? e.id : "";
        if (id === "") continue;
        const mode = e?.mode === "one-shot" ? "one-shot" : "continuable";
        const row = rowsById !== null ? rowsById.get(id) : undefined;
        let hasChildren = false;
        if (row !== undefined) {
          for (const r of allRows) {
            if (r.parentSessionId === id) {
              hasChildren = true;
              break;
            }
          }
        }
        subagents.push({
          sessionId: id,
          label: typeof e?.label === "string" ? e.label : "",
          mode,
          running: row ? row.running === true : false,
          hasChildren,
          createdAt: Number.isSafeInteger(e?.createdAt) ? e.createdAt : 0,
        });
      }
      this.#reply(m, resultOf(m, { subagents }));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-subagents-failed", errText(e)));
    }
  }

  /** 契约 §5.1 session.subagentPrompt（v1.0.5）：向 continuable 子代理发消息。
   *  走宿主 subagents 服务 prompt（delivery:'queue'）；one-shot/不存在会被
   *  宿主拒绝 → 包成 unsupported 错误回给手机（不是 500）。 */
  async #rSubagentPrompt(m) {
    const p = m.payload ?? {};
    const parentSessionId = typeof p.parentSessionId === "string" ? p.parentSessionId : "";
    const childSessionId = typeof p.childSessionId === "string" ? p.childSessionId : "";
    const text = typeof p.text === "string" ? p.text : "";
    // v1.2.0（§5.11.1）：附件只对根会话开放；subagent 的输入不接收 uploads（不静默丢）。
    if (Array.isArray(p.uploads) && p.uploads.length > 0) {
      this.#reply(m, errorOf(m, "attachment-unsupported", "subagent 不支持附件"));
      return;
    }
    if (parentSessionId === "" || childSessionId === "" || text === "") {
      this.#reply(m, errorOf(m, "bad-params", "parentSessionId/childSessionId/text required"));
      return;
    }
    let svc = null;
    try {
      svc = this.#ctx.get("subagents");
    } catch {
      svc = null;
    }
    if (!svc || typeof svc.prompt !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "subagents service unavailable"));
      return;
    }
    try {
      const req = {
        requestId: crypto.randomUUID(),
        parentSessionId,
        childSessionId,
        mode: "continuable",
        delivery: "queue",
        content: [{ type: "text", text }],
      };
      const receipt = await svc.prompt(req, this.#signal(15_000));
      this.#log("info", "subagent prompt accepted", { childSessionId });
      this.#reply(m, resultOf(m, { accepted: true }));
      void receipt;
    } catch (e) {
      const msg = errText(e);
      const unsupported = /one-shot|not continuable|unsupported/i.test(msg);
      this.#reply(m, errorOf(m, unsupported ? "unsupported" : "subagent-prompt-failed", msg));
    }
  }

  /** 契约 §5.1 session.subagentCancel（v1.0.5）：取消 continuable 子代理当前 turn。
   *  interruptByParent 是 fire-and-return（accepted=信号已受理非已停止）；
   *  任何失败回 accepted:false + 原因（尽力而为，手机 UI 自行提示）。 */
  async #rSubagentCancel(m) {
    const p = m.payload ?? {};
    const parentSessionId = typeof p.parentSessionId === "string" ? p.parentSessionId : "";
    const childSessionId = typeof p.childSessionId === "string" ? p.childSessionId : "";
    if (parentSessionId === "" || childSessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "parentSessionId/childSessionId required"));
      return;
    }
    let svc = null;
    try {
      svc = this.#ctx.get("subagents");
    } catch {
      svc = null;
    }
    if (!svc || typeof svc.interruptByParent !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "subagents service unavailable"));
      return;
    }
    try {
      await svc.interruptByParent(parentSessionId, childSessionId, "continuable");
      this.#reply(m, resultOf(m, { accepted: true }));
    } catch (e) {
      this.#reply(m, resultOf(m, { accepted: false, message: errText(e) }));
    }
  }

  async #rSessionCreate(m) {
    const p = m.payload ?? {};
    const agentPreset = typeof p.agentPreset === "string" ? p.agentPreset.trim() : "";
    const permission = typeof p.permission === "string" ? p.permission.trim() : "";
    // v1.0.7：model={provider,model,reasoningEffort?}（id 不可反拆，只认 provider/model）
    const model = normalizeModelSelection(p.model);
    if (p.model !== undefined && p.model !== null && model === null) {
      this.#log("warn", "session.create got an invalid model selection; ignored", {
        model: typeof p.model === "object" ? Object.keys(p.model) : typeof p.model,
      });
    }
    try {
      const sc = this.#sc();
      const req = {};
      // v1.1.4：cwd 缺省 / undefined / 空串 / trim 后空串时，**不再**交给宿主
      // 回退到 DSH 后端的 process.cwd()——解析为 Host 用户主目录下的
      // `~/.dsh/remote`，并**先确保目录存在**（失败直接回错，不静默回退）。
      // 显式非空 cwd 保持原行为（不自动建目录）。
      const { cwd, isDefault } = resolveSessionCwd(p.cwd, this.#homeDir);
      if (isDefault) {
        if (p.cwd !== undefined && p.cwd !== null && typeof p.cwd !== "string") {
          this.#log("warn", "session.create got a non-string cwd; using the default directory", {
            type: typeof p.cwd,
          });
        }
        try {
          await this.#mkdir(cwd);
        } catch (e) {
          this.#log("error", "failed to create the default session directory", {
            error: errText(e),
          });
          this.#reply(
            m,
            errorOf(m, "session-create-failed", "cannot create session directory: " + errText(e)),
          );
          return;
        }
      }
      // v1.1.4：cwd 若命中某个**已注册工作区**的目录，改传 `workspaceId`
      // 让会话自动归到该工作区下面（与 PC 端「在工作区里新建」一致——
      // PC 走 createInWorkspace → createNamed({workspaceId})）。
      // 旧实现只传 cwd，宿主不会 attach 到任何工作区 → PC 上显示「未分组」。
      // 未命中（普通目录）保持传 cwd，与 PC 在任意目录新建一样 = 未分组。
      // resolveByPath 不创建工作区、不改写注册表；路径不存在会 reject → 兜底回 cwd。
      // 默认目录（~/.dsh/remote）同样走这条反查：已注册 → 传 workspaceId，
      // 未注册 → 传该 cwd（**不自动注册工作区**）。
      const ws = await this.#resolveWorkspaceByCwd(cwd);
      if (ws !== null) {
        req.workspaceId = ws;
      } else {
        req.cwd = cwd;
      }
      if (agentPreset !== "") req.agentPreset = agentPreset;
      let value;
      try {
        value = await sc.create(req);
      } catch (e) {
        // 宿主拒绝该模式（preset 不存在等）→ 回 unsupported-agent-preset，
        // 手机端会回退成「不带选项」重试（契约 §5.8）。
        if (agentPreset !== "" && isAgentPresetRejection(e)) {
          this.#log("warn", "host rejected agent preset; phone should retry without it", {
            agentPreset,
          });
          this.#reply(m, errorOf(m, "unsupported-agent-preset", errText(e)));
          return;
        }
        throw e;
      }
      const sessionId = value?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        this.#reply(m, errorOf(m, "session-create-failed", "no sessionId returned"));
        return;
      }
      if (typeof p.title === "string" && p.title.trim() !== "") {
        try {
          await sc.rename({ sessionId, title: p.title.trim() });
        } catch (e) {
          this.#log("warn", "rename after create failed", { error: errText(e) });
        }
      }
      // 权限档位：创建成功后写入（宿主语义：写进「首次发布」前的种子）。
      // 失败只 warn，不阻断创建（会话照常返回 sessionId）。
      if (permission !== "") await this.#applyPermissionPreset(sessionId, permission);
      // v1.0.7（§5.8）：模型选择——创建成功后、首条 prompt 前 selectModel。
      // **失败绝不能回 error**（会话已创建，回 error 会让手机重复创建）：
      // 仍回 sessionId，附 modelError 让客户端提示「已用默认模型」。
      let modelOut = null;
      let modelError = "";
      if (model !== null) {
        try {
          const selected = await sc.selectModel({ sessionId, ...model });
          modelOut = selected?.selected ?? null;
        } catch (e) {
          modelError = errText(e);
          this.#log("warn", "selectModel failed; session created with default model", {
            sessionId,
            error: modelError,
          });
        }
      }
      const out = { sessionId };
      const echoed =
        typeof value?.agentPreset === "string" && value.agentPreset !== ""
          ? value.agentPreset
          : agentPreset;
      if (echoed !== "") out.agentPreset = echoed;
      if (modelOut !== null) out.model = modelOut;
      if (modelError !== "") out.modelError = modelError;
      this.#reply(m, resultOf(m, out));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-create-failed", errText(e)));
    }
  }

  /** 契约 §5.8/§5.9 session.capabilities：模式、权限、模型目录 + 归档能力标记。
   *  宿主没有对应能力 → 对应数组为空 / archiveSupported=false，不得报错。 */
  async #rSessionCapabilities(m) {
    const presets = await this.#loadAgentPresets();
    const permissions = await this.#loadPermissionPresets();
    const models = await this.#loadModelCatalog();
    const capabilities = {
      presets: presets.presets,
      permissions: permissions.permissions,
      defaultPreset: presets.defaultPreset,
      defaultPermission: permissions.defaultPermission,
      models: models.models,
      defaultModelId: models.defaultModelId,
      archiveSupported: this.#archiveSupported(),
      // v1.1.2：宿主「繁忙时的发送行为」设置（排队发送/插话发送）。
      // 客户端**只读不选**——发消息走哪种行为由宿主的设置决定（用户明确要求）。
      busyEnter: this.#busyEnterMode(),
    };
    // v1.2.0（§5.11.1）：宿主具备附件服务（attachments + fileUploads）才声明附件能力；
    // 否则**省略该字段**，客户端隐藏附件入口（旧插件也没有该字段）。
    if (this.#attachmentHostReady()) capabilities.attachments = attachmentCapabilities();
    // v1.3.0：新协议能力（字段缺省 = 旧 Host 不支持）。
    const goals = this.#service("goals");
    capabilities.todos = { supported: true }; // 具体会话是否有 todo 投影由 session.todos.supported 判定
    capabilities.goal = { read: true, actions: this.#goalActions(goals) };
    let hostContinued = false;
    try {
      hostContinued = typeof this.#sc().projections === "function";
    } catch {
      hostContinued = false;
    }
    capabilities.pendingInteractions = {
      questions: true,
      approvals: true,
      hostContinued,
    };
    this.#reply(m, resultOf(m, capabilities));
  }

  /**
   * 宿主「繁忙时的发送行为」设置（契约 §5.1 v1.1.2）。
   *
   * DSH 桌面端的 composer 也读同一个设置（`ui-conversation` 命名空间的 `busyEnter` 字段，
   * 落在宿主 user-settings 文档里；缺省 'queue'）。手机端**不提供切换**——
   * 「插话还是排队」是宿主的设置，不是手机端的选项（用户明确要求：跟随 DSH 的设置）。
   *
   * **每次都现读**（不缓存）：用户刚在 DSH 设置里改过，下一条手机消息就该跟随新行为。
   * 读设置的时机只有「发提示词」与「回 capabilities」——都是低频，缓存反而会引入滞后。
   *
   * 读不到（服务缺失/命名空间不在/字段非法）→ 退回 'queue'（最保守：消息不会丢）。
   */
  #busyEnterMode() {
    try {
      const settings = this.#service("settings");
      if (settings && typeof settings.describe === "function") {
        const rows = settings.describe({ redactSecrets: true });
        const row = (Array.isArray(rows) ? rows : []).find((r) => r?.ns === BUSY_ENTER_NAMESPACE);
        const raw = row?.user?.busyEnter ?? row?.value?.busyEnter;
        if (raw === "steer" || raw === "queue") {
          return raw;
        }
      }
    } catch (e) {
      // 宿主没有设置服务 / 读失败 → 保守用 queue
      this.#log("warn", "busyEnter read failed", { error: errText(e) });
    }
    return "queue";
  }

  /**
   * 这次提示词用哪种投递行为（'queue' | 'steer'）。
   * 跟宿主设置走：agent 忙时用设置值；空闲时总是 queue（= 立即执行，没有「繁忙」可言）。
   */
  #resolvePromptMode(sessionId) {
    if (!this.#isSessionRunning(sessionId)) {
      return "queue";
    }
    return this.#busyEnterMode();
  }

  /** 该会话当前是否在跑（api-session/status 维护的内存态）。 */
  #isSessionRunning(sessionId) {
    return this.#runningSessions.has(String(sessionId));
  }

  /** 归档能力（§5.9）：宿主有 Workspace 注册表**且**有归档方法才为 true。 */
  #archiveSupported() {
    const reg = this.#workspaceRegistry();
    if (!reg) return false;
    return typeof reg.archiveSession === "function" && typeof reg.unarchiveSession === "function";
  }

  /** 模型目录（宿主 sessionController.modelCatalog()）。失败/无方法 → 空目录。 */
  async #loadModelCatalog() {
    let sc = null;
    try {
      sc = this.#sc();
    } catch {
      return { models: [], defaultModelId: "" };
    }
    if (typeof sc.modelCatalog !== "function") return { models: [], defaultModelId: "" };
    let catalog = null;
    try {
      catalog = await sc.modelCatalog();
    } catch (e) {
      this.#log("warn", "model catalog failed; capabilities degrade to empty", { error: errText(e) });
      return { models: [], defaultModelId: "" };
    }
    return modelCatalogToWire(catalog);
  }

  /** 契约 §5.1/§5.8（v1.0.8）session.selectModel：对**已存在会话**切换模型/思考强度。
   *  无效 selection → result.error；宿主拒绝 → 原文带出（不假成功）；
   *  成功 → 回宿主归一化后的 {model}。 */
  async #rSessionSelectModel(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const selection = parseModelSelection(p.model);
    if (selection === null) {
      this.#reply(m, errorOf(m, "bad-params", "invalid model selection (provider/model required)"));
      return;
    }
    let sc = null;
    try {
      sc = this.#sc();
    } catch (e) {
      this.#reply(m, errorOf(m, "service-unavailable", errText(e)));
      return;
    }
    if (typeof sc.selectModel !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "sessionController.selectModel unavailable"));
      return;
    }
    try {
      const value = await sc.selectModel({ sessionId, ...selection });
      const model = mapModelSelection(value?.selected) ?? selection;
      this.#reply(m, resultOf(m, { model }));
    } catch (e) {
      const err = hostErrorOf(e, "session-select-model-failed");
      this.#log("warn", "selectModel failed", { sessionId, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  /** 契约 §5.1/§5.8 session.model：查询会话当前模型/思考强度（v1.0.8 引入，
   *  v1.1.4 数据源升级）。
   *
   *  权威数据源 = 宿主 **modelSelection 持久投影**（`sessionController.projections`
   *  的 `values.modelSelection`，视图形状 `{lastUsed, next}`，`next = pending ?? lastUsed`）。
   *  这与 DSH 桌面端 composer 显示的是**同一份**（dsh-client-ui-model-selection 的
   *  syncInputs：`selection = projected.next ?? catalog.default`）：
   *  - `pending`：用户在会话里显式切换过、还没被请求消费的模型；
   *  - `lastUsed`：上一个 `request/header` 实际使用的模型（旧实现完全漏掉它——
   *    从没显式切换过的会话在旧实现里永远回 null，手机端就总显示目录默认，
   *    与 PC 对不上，用户实测反馈）；
   *  - 两者都空（从未跑过也没选过的空白会话）→ null，客户端回退目录默认
   *    （= PC 的 catalog.default 回退，天然一致）。
   *
   *  投影不可用（旧宿主没注册）/读取失败 → 退回 `model/selection` 直播事件维护的
   *  内存态（v1.0.8 行为）；再没有 → null。**不得臆造**。 */
  async #rSessionModel(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    try {
      const sc = this.#sc();
      if (typeof sc.projections === "function") {
        const projections = await sc.projections({ sessionId }, this.#signal(10_000));
        const view = projections?.values?.modelSelection;
        if (view !== undefined && view !== null) {
          const model = mapModelSelection(view.next ?? view.lastUsed ?? null);
          this.#reply(m, resultOf(m, { model }));
          return;
        }
      }
    } catch (e) {
      // 投影缺失/读取失败 → 退回直播事件内存态（不报错，静默降级）
      this.#log("warn", "modelSelection projection unavailable; falling back to live tracking", {
        sessionId,
        error: errText(e),
      });
    }
    this.#reply(m, resultOf(m, { model: this.#modelSelections.get(sessionId) ?? null }));
  }

  /** 契约 §5.1/§5.8（v1.1.7）session.selectPermission：切换已存在会话的权限。
   *  Host 不做根会话/subagent 的额外限制（App 自行限制入口）；未知 preset、Auto 准入
   *  与 resolveAgent 的宿主拒绝均按原错误码/原文回传，绝不在本机假成功。 */
  async #rSessionSelectPermission(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const permission = typeof p.permission === "string" ? p.permission.trim() : "";
    if (sessionId === "" || permission === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId and permission required"));
      return;
    }
    const svc = this.#service("permissionPresets");
    if (!svc || typeof svc.set !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "permissionPresets.set unavailable"));
      return;
    }
    let sc = null;
    try {
      sc = this.#sc();
    } catch (e) {
      this.#reply(m, errorOf(m, "service-unavailable", errText(e)));
      return;
    }
    if (typeof sc.resolveAgent !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "sessionController.resolveAgent unavailable"));
      return;
    }
    let session = null;
    try {
      const agentRes = await sc.resolveAgent(sessionId);
      // 与创建时一致：兼容直接 Agent、{agent} 与旧版 {error}；拒绝不得改写。
      if (agentRes?.error) throw agentRes.error;
      session = agentRes?.agent?.session ?? agentRes?.session ?? null;
      if (!session) {
        this.#reply(m, errorOf(m, "session-not-found", `session "${sessionId}" has no live agent`));
        return;
      }
    } catch (e) {
      const err = hostErrorOf(e, "session-select-permission-failed");
      this.#log("warn", "resolveAgent for selectPermission failed", { sessionId, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
      return;
    }
    try {
      await svc.set(session, permission);
    } catch (e) {
      const err = hostErrorOf(e, "session-select-permission-failed");
      this.#log("warn", "selectPermission failed", { sessionId, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
      return;
    }
    // set() 已成功即不能把它伪装成失败。新宿主回读有效值（与桌面端同 derive），
    // 旧宿主没有 current() 时回显刚被 set 接受的 preset。
    let selected = permission;
    if (typeof svc.current === "function") {
      try {
        const current = svc.current(session);
        if (typeof current === "string" && current !== "") selected = current;
      } catch (e) {
        this.#log("warn", "permission current readback failed; returning accepted preset", {
          sessionId,
          error: errText(e),
        });
      }
    }
    this.#permissionSelections.set(sessionId, selected);
    this.#reply(m, resultOf(m, { permission: selected }));
  }

  /** 契约 §5.1/§5.8（v1.1.7）session.permission：查询有效权限。
   *  权威来源是 permissions 持久投影 values.permissions.currentValue（桌面端同源），
   *  因而根会话与 subagent 都可冷读，且不要求激活 live Agent。投影不可用时依次退回
   *  permissionPresets.current(liveSession) 与直播内存态；全部不可用回 null，不臆造。 */
  async #rSessionPermission(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    try {
      const sc = this.#sc();
      if (typeof sc.projections === "function") {
        const projections = await sc.projections({ sessionId }, this.#signal(10_000));
        const view = projections?.values?.permissions;
        if (view !== undefined && view !== null) {
          const permission =
            typeof view.currentValue === "string" && view.currentValue !== "" ? view.currentValue : null;
          if (permission !== null) this.#permissionSelections.set(sessionId, permission);
          this.#reply(m, resultOf(m, { permission }));
          return;
        }
      }
    } catch (e) {
      this.#log("warn", "permissions projection unavailable; falling back to live tracking", {
        sessionId,
        error: errText(e),
      });
    }

    // 旧宿主没有 permissions 投影时，live Session 的 current() 仍是有效值权威来源。
    // 但 subagent 查询绝不能为了兜底而激活 Agent：先冷读身份，命中即只回内存态。
    // 新宿主（0.2.2-rc.1+）没有 inspect() 了 → 冷读改走 list() 的 origin/parentSessionId
    // （同样不激活 Agent），否则会误把子代理 resolveAgent 起来（违反 v1.1.7）。
    try {
      const svc = this.#service("permissionPresets");
      const sc = this.#sc();
      const coldSubagent = await this.#isSubagentSession(sc, sessionId, this.#signal(10_000));
      if (!coldSubagent && svc && typeof svc.current === "function" && typeof sc.resolveAgent === "function") {
        const agentRes = await sc.resolveAgent(sessionId);
        const session = agentRes?.agent?.session ?? agentRes?.session ?? null;
        if (session) {
          const current = svc.current(session);
          if (typeof current === "string" && current !== "") {
            this.#permissionSelections.set(sessionId, current);
            this.#reply(m, resultOf(m, { permission: current }));
            return;
          }
        }
      }
    } catch (e) {
      this.#log("warn", "live permission read unavailable; falling back to tracked value", {
        sessionId,
        error: errText(e),
      });
    }
    this.#reply(m, resultOf(m, { permission: this.#permissionSelections.get(sessionId) ?? null }));
  }

  /** 模式目录（宿主 Agent preset 目录）。服务缺失/抛错 → 空目录。 */
  async #loadAgentPresets() {
    const svc = this.#service("agentPresets");
    if (!svc || typeof svc.list !== "function") return { presets: [], defaultPreset: "" };
    let rows;
    try {
      rows = await svc.list();
    } catch (e) {
      this.#log("warn", "agent preset list failed; capabilities degrade to empty", {
        error: errText(e),
      });
      return { presets: [], defaultPreset: "" };
    }
    const list = Array.isArray(rows) ? rows : Array.isArray(rows?.presets) ? rows.presets : [];
    let defaultId = "";
    try {
      defaultId = typeof svc.defaultId === "string" ? svc.defaultId : "";
    } catch {
      defaultId = "";
    }
    return mapAgentPresetOptions(list, defaultId);
  }

  /** 权限目录（宿主 permission preset 目录）。服务缺失/抛错 → 空目录。 */
  async #loadPermissionPresets() {
    const svc = this.#service("permissionPresets");
    if (!svc || typeof svc.catalog !== "function") return { permissions: [], defaultPermission: "" };
    let catalog;
    try {
      catalog = await svc.catalog();
    } catch (e) {
      this.#log("warn", "permission preset catalog failed; capabilities degrade to empty", {
        error: errText(e),
      });
      return { permissions: [], defaultPermission: "" };
    }
    return mapPermissionOptions(catalog);
  }

  /** 把权限档位写进一个已创建的会话（契约 §5.8）。
   *  宿主版本没有 resolveAgent / 没有 permissionPresets 服务 → 只 warn，不阻断。 */
  async #applyPermissionPreset(sessionId, permission) {
    const svc = this.#service("permissionPresets");
    if (!svc || typeof svc.set !== "function") {
      this.#log("warn", "permissionPresets service unavailable; permission not applied", {
        sessionId,
      });
      return;
    }
    let sc = null;
    try {
      sc = this.#sc();
    } catch (e) {
      this.#log("warn", "sessionController unavailable; permission not applied", {
        sessionId,
        error: errText(e),
      });
      return;
    }
    if (typeof sc.resolveAgent !== "function") {
      this.#log("warn", "sessionController.resolveAgent unavailable; permission not applied", {
        sessionId,
      });
      return;
    }
    let agentRes = null;
    try {
      agentRes = await sc.resolveAgent(sessionId);
    } catch (e) {
      this.#log("warn", "resolveAgent failed; permission not applied", {
        sessionId,
        error: errText(e),
      });
      return;
    }
    // 宿主两种形状都兜住：{ agent } | { error }（旧版）与直接返回 Agent 的新版
    const agent = agentRes?.agent ?? agentRes;
    const session = agent?.session;
    if (!session) {
      this.#log("warn", "resolveAgent returned no session; permission not applied", { sessionId });
      return;
    }
    try {
      svc.set(session, permission);
    } catch (e) {
      this.#log("warn", "permission preset set failed; session kept", {
        sessionId,
        error: errText(e),
      });
    }
  }

  /** 契约 §5.1/§5.9 session.archive：写入 Workspace 真实归档集合。
   *  宿主错误**原样**回给客户端（不得在本机假成功）；归档广播由
   *  domain/changed 驱动（#broadcastArchives）。 */
  async #rSessionArchive(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const reg = this.#workspaceRegistry();
    if (!reg || typeof reg.archiveSession !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "workspace registry unavailable"));
      return;
    }
    const stopActivity = p.stopActivity === true;
    try {
      await reg.archiveSession(sessionId, { stopActivity });
      this.#reply(m, resultOf(m, { sessionId, archived: true }));
    } catch (e) {
      const err = hostErrorOf(e, "session-archive-failed");
      this.#log("warn", "archive failed", { sessionId, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  /** 契约 §5.1/§5.9 session.unarchive：从 Workspace 归档集合恢复（幂等）。 */
  async #rSessionUnarchive(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const reg = this.#workspaceRegistry();
    if (!reg || typeof reg.unarchiveSession !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "workspace registry unavailable"));
      return;
    }
    try {
      await reg.unarchiveSession(sessionId);
      this.#reply(m, resultOf(m, { sessionId, archived: false }));
    } catch (e) {
      const err = hostErrorOf(e, "session-unarchive-failed");
      this.#log("warn", "unarchive failed", { sessionId, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  async #rSessionPrompt(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const text = typeof p.text === "string" ? p.text : "";
    const rawUploads = p.uploads;
    // v1.2.0（§5.11.3）：text 与 uploads 至少一项非空——附件可以单独发送。
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const hasUploads = Array.isArray(rawUploads) && rawUploads.length > 0;
    if (text.trim() === "" && !hasUploads) {
      this.#reply(m, errorOf(m, "bad-params", "text or uploads required"));
      return;
    }
    // v1.1.2（契约 §5.1）：**投递行为由宿主设置决定**，客户端不参与选择。
    // DSH 桌面端 composer 读的是同一处设置（ui-conversation.busyEnter：
    // 「排队发送」/「插话发送」），手机端只跟随——用户明确要求「不应该手机上设置」。
    // 客户端若仍带 mode（旧客户端），**忽略**它，不报错也不改变行为。
    const mode = this.#resolvePromptMode(sessionId);
    const requestId = randomUUID();
    // v1.2.0（§5.11.3）：把 uploadId 换成宿主 receipt（图片/文件都走 file receipt
    // 通道；宿主在 prompt 准入时解成附件块）。未知/过期/跨会话/已消费 → 明确错误。
    let content;
    let uploadIds = [];
    try {
      const staged = this.#uploads.promptUploads(sessionId, rawUploads);
      content = [];
      if (text.trim() !== "") content.push({ type: "text", text });
      for (const item of staged) content.push({ type: "file", receiptId: item.receiptId });
      uploadIds = staged.map((item) => item.uploadId);
    } catch (e) {
      this.#replyAttachmentError(m, e);
      return;
    }
    const send = async (delivery) =>
      this.#sc().prompt(
        {
          requestId,
          sessionId,
          mode: delivery,
          content,
        },
        this.#signal(30_000),
      );
    try {
      const value = await send(mode);
      const accepted = value?.accepted === true;
      // 宿主已接受 → 这批 receipt 被 bindPrompt 消费；墓碑保证同一 uploadId
      // 不能被第二条消息复用（重复用自己的附件 → attachment-upload-consumed）。
      // 未真正接受时不消费，让客户端可以重试。
      if (accepted) this.#uploads.markConsumed(uploadIds);
      this.#reply(m, resultOf(m, { accepted, mode }));
    } catch (e) {
      // 宿主拒绝插话（session/steer-unavailable：当前 turn 不再接受插入）时
      // **自动退回排队**——桌面端此时是把 steer 动作置灰，手机不能把用户的消息弄丢。
      const err = hostErrorOf(e, "prompt-failed");
      if (mode === "steer" && err.code === "session/steer-unavailable") {
        this.#log("warn", "steer unavailable, falling back to queue", { sessionId });
        try {
          const value = await send("queue");
          const accepted = value?.accepted === true;
          if (accepted) this.#uploads.markConsumed(uploadIds);
          this.#reply(m, resultOf(m, { accepted, mode: "queue" }));
          return;
        } catch (e2) {
          const err2 = hostErrorOf(e2, "prompt-failed");
          this.#log("warn", "prompt failed", { sessionId, mode: "queue", code: err2.code });
          this.#reply(m, errorOf(m, err2.code, err2.message));
          return;
        }
      }
      // 其余宿主错误**原样**回客户端（不得吞掉）——附件校验失败（如模型不支持
      // 图片输入、单图超限）也走这里，客户端据此提示；uploadId 仍可重试。
      this.#log("warn", "prompt failed", { sessionId, mode, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  // ---- v1.2.0（§5.11）：附件分块上传 ---------------------------------------

  /** 附件服务的宿主能力判断：两个服务都在才支持（§5.11.1 supported）。 */
  #attachmentHostReady() {
    const fileUploads = this.#service("fileUploads");
    if (!fileUploads) return false;
    if (typeof fileUploads.uploadImageStream !== "function") return false;
    if (typeof fileUploads.uploadStream !== "function") return false;
    return this.#service("attachments") !== null;
  }

  /** 统一回附件错误（AttachmentWireError 用契约错误码；宿主错误原样透传）。 */
  #replyAttachmentError(m, e) {
    if (e instanceof AttachmentWireError) {
      this.#reply(m, errorOf(m, e.code, e.message));
      return;
    }
    const err = hostErrorOf(e, "attachment-upload-failed");
    this.#log("warn", "attachment operation failed", { code: err.code });
    this.#reply(m, errorOf(m, err.code, err.message));
  }

  async #rAttachmentUploadBegin(m) {
    if (!this.#attachmentHostReady()) {
      this.#reply(m, errorOf(m, "attachment-unsupported", "当前宿主未提供附件上传服务"));
      return;
    }
    try {
      const begun = this.#uploads.begin(m.payload ?? {});
      this.#reply(m, resultOf(m, begun));
    } catch (e) {
      this.#replyAttachmentError(m, e);
    }
  }

  async #rAttachmentUploadChunk(m) {
    try {
      const p = m.payload ?? {};
      const result = this.#uploads.chunk(p);
      this.#reply(m, resultOf(m, result));
    } catch (e) {
      this.#replyAttachmentError(m, e);
    }
  }

  /**
   * 提交：把内存缓冲写进宿主附件存储。
   *
   * 为什么走 `ctx.fileUploads`（而不是直接 `attachments.saveFile`）：
   * 宿主 prompt 只认 receipt——`resolvePromptFileReceipts()` 会把 content 里的
   * `{type:'file',receiptId}` 解回 staged 的图片/文件块；直接塞 attachment ref 会被
   * 拒为 `FILE_NOT_STAGED`（附录 D）。图片与文件都用同一条 receipt 通道（桌面端
   * composer 的图片上传也是这么做的：图片 receipt 在 prompt 里以 file part 提交）。
   */
  async #rAttachmentUploadCommit(m) {
    const p = m.payload ?? {};
    const uploadId = typeof p.uploadId === "string" ? p.uploadId : "";
    let record;
    try {
      record = this.#uploads.beginCommit(uploadId);
    } catch (e) {
      this.#replyAttachmentError(m, e);
      return;
    }
    const svc = this.#service("fileUploads");
    if (!svc) {
      this.#uploads.failCommit(uploadId);
      this.#reply(m, errorOf(m, "attachment-unsupported", "当前宿主未提供附件上传服务"));
      return;
    }
    const chunks = record.chunks;
    const iterate = async function* () {
      for (const chunk of chunks) yield new Uint8Array(chunk);
    };
    // 宿主归一化/落盘可能较慢（sharp 压缩大图），给 120s；**完成后必须清定时器**
    // ——否则每个 commit 都会留下一个 2 分钟的空定时器（测试进程也被吊住）。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      let result;
      if (record.kind === ATTACHMENT_KIND_IMAGE) {
        result = await svc.uploadImageStream({
          sessionId: record.sessionId,
          data: iterate(),
          mediaType: record.mediaType,
          ...(record.name !== "" ? { name: record.name } : {}),
          signal: ac.signal,
        });
        if (!result || typeof result.receiptId !== "string" || !result.image) {
          throw new Error("宿主未返回图片附件凭据");
        }
        this.#uploads.completeCommit(uploadId, {
          receiptId: result.receiptId,
          attachment: result.image,
          kind: record.kind,
          mediaType: record.mediaType,
          requestedName: record.name,
          bytes: record.bytes,
        });
        const attachment = uploadedAttachmentOf({
          kind: record.kind,
          mediaType: record.mediaType,
          requestedName: record.name,
          bytes: record.bytes,
          attachment: result.image,
        });
        // 日志只打 kind/字节数/尺寸——**绝不**打文件名或字节内容
        this.#log("info", "attachment committed", {
          uploadId: uploadId.slice(0, 10),
          kind: "image",
          bytes: attachment.bytes,
        });
        this.#reply(m, resultOf(m, { uploadId, attachment }));
        return;
      }
      result = await svc.uploadStream({
        sessionId: record.sessionId,
        data: iterate(),
        ...(record.name !== "" ? { name: record.name } : {}),
        signal: ac.signal,
      });
      if (!result || typeof result.receiptId !== "string" || !result.file) {
        throw new Error("宿主未返回文件附件凭据");
      }
      this.#uploads.completeCommit(uploadId, {
        receiptId: result.receiptId,
        attachment: result.file,
        kind: record.kind,
        mediaType: record.mediaType,
        requestedName: record.name,
        bytes: record.bytes,
      });
      const attachment = uploadedAttachmentOf({
        kind: record.kind,
        requestedName: record.name,
        bytes: record.bytes,
        attachment: result.file,
      });
      this.#log("info", "attachment committed", {
        uploadId: uploadId.slice(0, 10),
        kind: "file",
        bytes: attachment.bytes,
      });
      this.#reply(m, resultOf(m, { uploadId, attachment }));
    } catch (e) {
      // 宿主失败 → 退回 receiving（缓冲还在），客户端可重试 commit
      this.#uploads.failCommit(uploadId);
      this.#replyAttachmentError(m, e);
    } finally {
      clearTimeout(timer);
    }
  }

  async #rAttachmentUploadAbort(m) {
    const p = m.payload ?? {};
    const uploadId = typeof p.uploadId === "string" ? p.uploadId : "";
    const aborted = uploadId === "" ? false : this.#uploads.abort(uploadId);
    this.#reply(m, resultOf(m, { aborted }));
  }

  async #rSessionCancel(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    try {
      const value = await this.#sc().cancel({ sessionId });
      this.#reply(m, resultOf(m, { cancelled: value?.accepted === true }));
    } catch (e) {
      this.#reply(m, errorOf(m, "cancel-failed", errText(e)));
    }
  }

  async #rSessionRename(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const title = typeof p.title === "string" ? p.title : "";
    if (sessionId === "" || title.trim() === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId and non-empty title required"));
      return;
    }
    try {
      const value = await this.#sc().rename({ sessionId, title: title.trim() });
      const accepted = typeof value?.title === "string" ? value.title : title.trim();
      this.#titles.set(sessionId, accepted);
      this.#reply(m, resultOf(m, { title: accepted }));
    } catch (e) {
      this.#reply(m, errorOf(m, "rename-failed", errText(e)));
    }
  }

  #rApprovalAnswer(m) {
    const p = m.payload ?? {};
    const askId = typeof p.askId === "string" ? p.askId : "";
    const decision = p.decision;
    if (decision !== "approved" && decision !== "rejected") {
      this.#reply(m, errorOf(m, "bad-decision", 'decision must be "approved" or "rejected"'));
      return;
    }
    const entry = askId === "" ? undefined : this.#pending.get(askId);
    if (entry === undefined || entry.kind !== "approval") {
      // 未命中 = 超时后迟到 / 未知 askId（契约 §5.1：applied:false）
      this.#reply(m, resultOf(m, { applied: false }));
      return;
    }
    this.#settle(entry, "phone", { decision });
    this.#reply(m, resultOf(m, { applied: true }));
  }

  async #rQuestionAnswer(m) {
    const p = m.payload ?? {};
    const askId = typeof p.askId === "string" ? p.askId : "";
    const answers = p.answers;
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
      this.#reply(m, errorOf(m, "bad-answers", "answers must be an object of questionId -> label(s)"));
      return;
    }
    const freeText = typeof p.freeText === "string" ? p.freeText : "";
    const entry = askId === "" ? undefined : this.#pending.get(askId);
    if (entry !== undefined && entry.kind === "question") {
      this.#settle(entry, "phone", { answers, freeText });
      this.#reply(m, resultOf(m, { applied: true }));
      return;
    }

    // v1.3.0：超过插件独占窗口后，Host timed 模式仍将问题保持在 continued；
    // 此时必须走 Host 官方 answer（steer 一条 user-question-reply），禁止伪造消息。
    let hostQuestion = null;
    for (const wire of this.#hostQuestions.values()) {
      if (wire.askId === askId || wire.callId === askId) {
        hostQuestion = wire;
        break;
      }
    }
    if (hostQuestion === null || hostQuestion.state !== "continued") {
      this.#reply(m, resultOf(m, { applied: false }));
      return;
    }
    const questions = hostQuestion.questions;
    const userQuestions = this.#service("userQuestions");
    if (!userQuestions || typeof userQuestions.answer !== "function") {
      this.#reply(m, errorOf(m, "service-unavailable", "userQuestions.answer unavailable"));
      return;
    }
    let agent = null;
    try {
      const sc = this.#sc();
      const resolved = await sc.resolveAgent(hostQuestion.sessionId);
      if (resolved?.error) throw resolved.error;
      agent = resolved?.agent ?? resolved?.session?.agent ?? null;
      if (!agent) throw new Error(`session "${hostQuestion.sessionId}" has no live agent`);
    } catch (e) {
      const err = hostErrorOf(e, "question-agent-unavailable");
      this.#reply(m, errorOf(m, err.code, err.message));
      return;
    }
    try {
      const answer = toAskUserQuestionAnswer(questions, answers, freeText);
      const accepted =
        questions.every((q) => answer.answers.some((a) => a.id === q.id)) &&
        userQuestions.answer(agent, hostQuestion.callId, answer) === true;
      if (!accepted) {
        this.#reply(m, resultOf(m, { applied: false }));
        return;
      }
      this.#hostQuestions.delete(hostQuestion.sessionId + "\0" + hostQuestion.callId);
      this.#sendEvent("question.resolved", { askId: hostQuestion.askId, source: "phone" });
      this.#reply(m, resultOf(m, { applied: true }));
    } catch (e) {
      const err = hostErrorOf(e, "question-answer-failed");
      this.#log("warn", "continued question answer failed", {
        sessionId: hostQuestion.sessionId,
        code: err.code,
      });
      // Host 错误码原样给客户端，便于展示 REPLY_QUEUED / BAD_ANSWER。
      this.#reply(m, errorOf(m, err.code, err.message));
    }
  }

  #rPushRegister(m) {
    const p = m.payload ?? {};
    const token = typeof p.pushToken === "string" ? p.pushToken : "";
    const platform = typeof p.platform === "string" ? p.platform : "";
    if (token === "") {
      this.#reply(m, errorOf(m, "bad-params", "pushToken required"));
      return;
    }
    if (platform !== "" && platform !== "harmonyos") {
      this.#reply(m, errorOf(m, "bad-platform", 'platform must be "harmonyos"'));
      return;
    }
    this.#pushToken = token;
    this.#reply(m, resultOf(m, { registered: true }));
    this.sendPushState();
  }

  // ---- 瀑布答案器（§5.5）-----------------------------------------------------

  /** 手机在线且开关打开才拦截；否则 next() 原样放行。 */
  #shouldIntercept(kind) {
    try {
      if (this.#disposed) return false;
      if (this.#cfg.enabled !== true) return false;
      if (kind === "approval" && this.#cfg.interceptApprovals !== true) return false;
      if (kind === "question" && this.#cfg.interceptQuestions !== true) return false;
      return this.#relay.clientOnline === true;
    } catch {
      return false;
    }
  }

  /**
   * approval/request 拦截器。契约 §5.5：
   * 拦截 → 推 approval.request + Push → 等 approval.answer（默认 120s）；
   * 超时/出错/取消 → return next()（绝不 fail-closed）；迟到回答回 applied:false。
   */
  async #onApprovalRequest(req, next) {
    if (!this.#shouldIntercept("approval")) return next();
    const askId = randomUUID();
    const sessionId = String(req?.agent?.session?.id ?? "");
    const timeoutMs = Number(this.#cfg.approvalTimeoutMs) || 120_000;
    const expiresAt = Date.now() + timeoutMs;
    const meta = {
      toolName: String(req?.toolName ?? "unknown"),
      reason: typeof req?.reason === "string" ? req.reason : "",
      argsPreview: this.#argsPreviewOf(req?.agent, req?.callId),
      timeoutMs,
    };
    const sent = this.#sendEvent(
      "approval.request",
      { askId, sessionId, ...meta, expiresAt },
      true, // urgent：离线时优先补发（契约 §4）
    );
    if (!sent) {
      // 帧没进链路（socket 刚断）→ 白等 120s 没意义，直接放行桌面答案器
      return next();
    }
    this.#notifyKind("approval", sessionId, askId, {
      title: "需要审批",
      body: `${req?.toolName ?? "tool"}：${(typeof req?.reason === "string" && req.reason) || "请求提权"}`.slice(0, 200),
    });

    const outcome = await this.#waitForAnswer({
      askId,
      kind: "approval",
      sessionId,
      signal: req?.signal,
      timeoutMs,
      expiresAt,
      meta,
    });
    if (outcome.settled === "phone") {
      const decision = outcome.decision === "approved" ? "approved" : "rejected";
      this.#sendEvent("approval.resolved", { askId, decision, source: "phone" });
      return decision === "approved" ? "allowed-once" : "rejected";
    }
    // timeout / abort / 插件卸载 → 放行桌面答案器（契约 §5.5 硬性要求）
    this.#sendEvent("approval.resolved", { askId, decision: "pending", source: "timeout" });
    let final = "unavailable";
    try {
      final = await next();
    } catch (e) {
      // 桌面链条自身故障：向上传播，由核心决定（我们已尽放行义务）
      this.#log("warn", "next() after approval timeout failed", { error: errText(e) });
      throw e;
    }
    this.#sendEvent("approval.resolved", {
      askId,
      decision: final === "allowed-once" ? "approved" : "rejected",
      source: "desktop",
    });
    return final;
  }

  /** user-questions/request 拦截器（同 §5.5 语义，答案是 AskUserQuestionAnswer）。 */
  async #onQuestionRequest(req, next) {
    if (!this.#shouldIntercept("question")) return next();
    // v1.3.0：timed 模式带 Host callId；用它作为稳定 askId，双端才能围绕
    // 同一个问题对象回答/关闭。legacy 没有 wait，仍用随机 id。
    const callId = typeof req?.wait?.callId === "string" ? req.wait.callId : "";
    const askId = callId !== "" ? callId : randomUUID();
    const sessionId = String(req?.agent?.session?.id ?? "");
    const timeoutMs = Number(this.#cfg.approvalTimeoutMs) || 120_000;
    const expiresAt = Date.now() + timeoutMs;
    const questions = mapWireQuestions(req?.questions);
    if (questions.length === 0) return next(); // 形状不对，放行
    const meta = {
      callId,
      questions,
      timeoutMs,
      multiSelect: questions.some((q) => q.multiSelect),
    };
    const sent = this.#sendEvent(
      "question.request",
      {
        askId,
        sessionId,
        callId,
        state: "open",
        answerable: true,
        source: "plugin",
        ...meta,
        expiresAt,
      },
      true,
    );
    if (!sent) {
      // 帧没进链路 → 不白等，直接放行桌面答案器
      return next();
    }
    this.#notifyKind("question", sessionId, askId, {
      title: "需要回答",
      body: questions[0]?.question?.slice(0, 160) || "助手向你提问",
    });

    const outcome = await this.#waitForAnswer({
      askId,
      kind: "question",
      sessionId,
      signal: req?.signal,
      timeoutMs,
      expiresAt,
      meta,
    });
    if (outcome.settled === "phone") {
      this.#sendEvent("question.resolved", { askId, source: "phone" });
      this.#hostQuestions.delete(sessionId + "\0" + (callId || askId));
      return toAskUserQuestionAnswer(questions, outcome.answers, outcome.freeText);
    }
    // legacy：没有 Host 投影，超时后问题真的交给桌面，手机卡片必须结束。
    // timed：同一请求已有 callId；超时只结束手机独占窗口，随后由投影以
    // state:'continued' 重新发布，不能提前发 resolved 把卡片删掉。
    if (callId === "" || !this.#clientFeatures.has("session-state-v1")) {
      // legacy，或旧 App 不认识 continued：保持旧语义，超时即清卡。
      this.#sendEvent("question.resolved", { askId, source: "timeout" });
    }
    try {
      return await next();
    } catch (e) {
      this.#log("warn", "next() after question timeout failed", { error: errText(e) });
      throw e;
    } finally {
      if (callId !== "") void this.#sweepHostQuestions(sessionId);
    }
  }

  /**
   * 等待手机应答：Promise 竞速 [answer, timeout, abort]。
   * settle 后从 #pending 移除——迟到的手机回答回 applied:false（§5.5）。
   * @returns {Promise<{settled:"phone", ...}|{settled:"timeout"}>}
   */
  #waitForAnswer({ askId, kind, sessionId, signal, timeoutMs, expiresAt, meta }) {
    return new Promise((resolve) => {
      const entry = {
        kind,
        sessionId,
        resolve,
        timer: null,
        signal,
        abortHandler: null,
        expiresAt: Number(expiresAt) || 0,
        meta: meta && typeof meta === "object" ? meta : {},
      };
      const finish = (result) => {
        if (this.#pending.get(askId) !== entry) return;
        this.#pending.delete(askId);
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (signal && entry.abortHandler) {
          try {
            signal.removeEventListener("abort", entry.abortHandler);
          } catch {
            /* ignore */
          }
        }
        resolve(result);
      };
      // 先登记再武装定时器/abort：finish 的幂等守卫要求 entry 已在 #pending，
      // 否则「注册时已 abort」的路径会早退且永不 resolve（死锁任务）。
      this.#pending.set(askId, entry);
      entry.timer = setTimeout(() => finish({ settled: "timeout" }), timeoutMs);
      // 不 unref：超时放行是 fail-open 的触发器，必须真正触发。finish 里
      // 已 clearTimeout，故不会阻止进程退出、也不泄漏。
      if (signal) {
        if (signal.aborted) {
          finish({ settled: "timeout" });
          return;
        }
        entry.abortHandler = () => finish({ settled: "timeout" });
        try {
          signal.addEventListener("abort", entry.abortHandler, { once: true });
        } catch {
          /* ignore */
        }
      }
    });
  }

  #settle(entryRef, source, extra) {
    // entry 由 #pending 持有；这里按 askId 摘除并 resolve
    for (const [askId, entry] of this.#pending) {
      if (entry === entryRef) {
        this.#pending.delete(askId);
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (entry.signal && entry.abortHandler) {
          try {
            entry.signal.removeEventListener("abort", entry.abortHandler);
          } catch {
            /* ignore */
          }
        }
        entry.resolve({ settled: source, ...extra });
        return true;
      }
    }
    return false;
  }

  /** 审批参数预览：从会话日志按 callId 倒查 tool/call 的 arguments（截断）。 */
  #argsPreviewOf(agent, callId) {
    if (!callId) return "";
    try {
      const session = agent?.session;
      if (!session) return "";
      const events =
        typeof session.snapshotEvents === "function"
          ? session.snapshotEvents()
          : Array.isArray(session.events)
            ? session.events
            : [];
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e && e.type === "tool/call" && e.data && e.data.callId === callId) {
          const raw = typeof e.data.arguments === "string" ? e.data.arguments : JSON.stringify(e.data.arguments ?? "");
          return raw.length > 400 ? raw.slice(0, 400) + "…[truncated]" : raw;
        }
      }
    } catch {
      /* 预览尽力而为，失败给空串 */
    }
    return "";
  }

  // ---- Push（§6，任何异常不打断主流程）---------------------------------------

  #notifyKind(kind, sessionId, askId, { title, body }) {
    const push = this.#push;
    if (!push || push.configured !== true) return;
    if (!this.#pushToken) return;
    Promise.resolve()
      .then(() =>
        push.notify({
          pushToken: this.#pushToken,
          title,
          body,
          kind,
          sessionId,
          askId,
        }),
      )
      .then((r) => {
        if (r && r.ok === false && r.reason) {
          this.#log("info", "push not delivered", { reason: r.reason });
        }
      })
      .catch((e) => {
        this.#log("warn", "push notify threw", { error: errText(e) });
      });
  }

  #maybeNotifyTurnEnd(sessionId, errorMessage) {
    try {
      if (this.#cfg.push?.notifyTurnEnd !== true) return;
      if (!this.#push || this.#push.configured !== true) return;
      if (!this.#pushToken) return;
      const title = this.#titles.get(sessionId) || "会话 " + sessionId.slice(0, 12);
      this.#notifyKind("turn-end", sessionId, undefined, {
        title: errorMessage ? "任务出错" : "任务完成",
        body: errorMessage ? `${title}：${errorMessage}`.slice(0, 200) : `${title} 已完成`.slice(0, 200),
      });
    } catch (e) {
      this.#log("warn", "turn.end push error", { error: errText(e) });
    }
  }
}

/**
 * 手机 question.answer 的 answers（§5.4：qid -> label | label[]）
 * → Host AskUserQuestionAnswer（{answers:[{id, selected, custom?}]}）。
 * freeText 挂到第一个作答项（宿主按 custom 字段消费）。
 */
export function toAskUserQuestionAnswer(questions, answers, freeText) {
  const items = [];
  for (const q of questions) {
    const v = answers?.[q.id];
    if (v === undefined) continue;
    const selected = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
    items.push({ id: q.id, selected });
  }
  if (items.length === 0 && typeof freeText === "string" && freeText !== "" && questions.length > 0) {
    items.push({ id: questions[0].id, selected: [], custom: freeText });
  } else if (typeof freeText === "string" && freeText !== "" && items.length > 0) {
    items[0].custom = freeText;
  }
  return { answers: items };
}
