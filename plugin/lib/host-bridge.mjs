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
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
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

/**
 * present 投递文件的字节上限（超过就不桥接：内存与带宽都不值得）。
 * 20MB 足够覆盖绝大多数截图/预览图。
 */
const DELIVERED_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 单会话待执行消息的条数上限（契约 §5.2 session.queue）。
 *
 * 内存态追踪，异常事件流（重连回放等）不该把内存吃满；超了就不再记新的。
 */
const QUEUE_MAX_ITEMS = 200;

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
 * 会话消息正文文本（契约 §5.10）：**图片块不占位**。
 *
 * 图片在 ChatMessage.images[] 里单独渲染（客户端画缩略图气泡），正文里再写一遍
 * "[图片]" 会出现重复的假文字。file 块仍保留占位符（文件没有独立渲染通道）。
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
    } else if (block.type === "file") {
      text += "[文件]";
    }
    // image：单独渲染（§5.10），不占位；reasoning / tool-call 等：跳过
  }
  return text;
}

/**
 * 契约 §5.2 `session.queue`：待执行消息的文本口径。
 *
 * 只取 content 里 `type==='text'` 的块拼接——与正文口径（messageText）刻意不同：
 * 正文会把 file 块渲染成 "[文件]" 占位符，而排队列表要的是**用户实际打的字**。
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
 *   - 没有任何内容的消息跳过（不产生空泡）；
 *   - 任何不认识的形态返回 []（跳过），绝不抛出。
 * @returns {object[]} ChatMessage[]
 */
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
  if (type === "user/message") {
    if (data?.source?.kind !== "user") return [];
    role = "user";
    content = data.content;
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
  if (text.trim() !== "" || images.length > 0) {
    const message = { id: `${sessionId}:${seq}`, role, text, ts, seq };
    if (images.length > 0) message.images = images;
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
 * 契约 §5.2 `system.message` 事件映射（宿主 session/event 的
 * system/message 与 developer/message；两者共用一个 topic，用 kind 区分）。
 * message 可能是 {content:[blocks]}，也可能是字符串——两种都兜住。
 * @returns {{sessionId:string,kind:"system"|"developer",text:string,ts:number}|null}
 */
export function mapSystemMessageEvent(sessionId, event, kind) {
  if (!event || typeof event !== "object") return null;
  if (event.type !== "system/message" && event.type !== "developer/message") return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const message = data.message !== undefined ? data.message : data;
  let text = "";
  if (typeof message === "string") {
    text = message;
  } else if (message && typeof message === "object") {
    text = contentText(message.content);
  }
  if (text.trim() === "") return null;
  return {
    sessionId: String(sessionId ?? ""),
    kind: kind === "developer" ? "developer" : "system",
    text,
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
  #disposed = false; // dispose() 后禁止一切出站与拦截
  #deltaBuf = new Map(); // sessionId -> { text, timer }（正文增量）
  #reasoningBuf = new Map(); // sessionId -> { text, timer }（思考增量，v1.0.7 与正文分流）
  #modelSelections = new Map(); // sessionId -> {provider, model, reasoningEffort?}（v1.0.8 内存态）
  #pending = new Map(); // askId -> { resolve, kind, sessionId, timer, abortHandler, signal }
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
   * }} deps
   */
  constructor(deps) {
    this.#ctx = deps.ctx;
    this.#relay = deps.relay;
    this.#push = deps.push;
    this.#cfg = deps.config;
    this.#log = deps.log;
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

    // --- 事件桥接（§5.2）---
    this.#on("api-session/added", (summary) => {
      const s = mapSummary(summary);
      if (s.sessionId) this.#titles.set(s.sessionId, s.title);
      this.#sendEvent("session.added", { session: s });
    });
    this.#on("api-session/removed", (sessionId) => {
      const key = String(sessionId);
      this.#titles.delete(key);
      // 会话没了，它的待执行列表与交付物历史条目也没有意义了（避免内存泄漏）
      this.#queues.delete(key);
      this.#deliveredEntries.delete(key);
      this.#sendEvent("session.removed", { sessionId: key });
    });
    this.#on("api-session/status", (sessionId, running) => {
      this.#sendEvent("session.status", { sessionId: String(sessionId), running: running === true });
    });
    this.#on("api-session/activity", (sessionId, updatedAt) => {
      this.#sendEvent("session.activity", { sessionId: String(sessionId), updatedAt: Number(updatedAt) || 0 });
    });

    // agent/assistant-stream：文本增量与**思考增量分流**，按 sessionId 合并节流（≤8 条/秒）
    // v1.0.7：chunk.type==='reasoning-delta' → assistant.reasoningDelta（§5.2）
    this.#on("agent/assistant-stream", (payload) => {
      try {
        const frame = payload?.frame;
        if (!frame || frame.type !== "chunk") return;
        const chunk = frame.chunk;
        if (!chunk || typeof chunk.text !== "string" || chunk.text === "") return;
        if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return;
        const sessionId = payload?.agent?.session?.id;
        if (!sessionId) return;
        if (chunk.type === "reasoning-delta") {
          this.#queueReasoning(String(sessionId), chunk.text);
          return;
        }
        this.#queueDelta(String(sessionId), chunk.text);
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
          this.#flushDelta(String(sessionId));
          this.#flushReasoning(String(sessionId));
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
        this.#flushDelta(String(sessionId));
        this.#flushReasoning(String(sessionId));
        this.#sendEvent("turn.end", { sessionId: String(sessionId), status: "error", error: message });
        this.#maybeNotifyTurnEnd(String(sessionId), message);
      } catch (e) {
        this.#log("warn", "agent/error bridge error", { error: errText(e) });
      }
    });

    // --- v1.0.6（§5.7）：会话事件总闸 → tool.call / tool.result / system.message ---
    // 宿主每写入一条会话日志事件就触发（覆盖所有会话，含 subagent）。
    // 按 session.id 寻址即可，**不过滤**子代理；不认识的事件类型直接忽略，
    // 绝不因为形状不认识而抛错（#on 包装器已兜底）。
    this.#on("session/event", (session, event) => {
      const sessionId = String(session?.id ?? "");
      if (sessionId === "") return;
      const type = event?.type;
      if (type === "tool/call") {
        const mapped = mapToolCallEvent(sessionId, event);
        if (mapped !== null) this.#sendEvent("tool.call", mapped);
        return;
      }
      if (type === "tool/result") {
        const mapped = mapToolResultEvent(sessionId, event);
        if (mapped !== null) this.#sendEvent("tool.result", mapped);
        return;
      }
      if (type === "system/message" || type === "developer/message") {
        const kind = type === "developer/message" ? "developer" : "system";
        const mapped = mapSystemMessageEvent(sessionId, event, kind);
        if (mapped !== null) this.#sendEvent("system.message", mapped);
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
      if (type === "assistant/message") {
        // v1.0.9（§5.10）：助手消息里的图片 → 广播 assistant.image（带内联缩略图）
        this.#emitAssistantImages(sessionId, event);
        return;
      }
      if (type === "deliverables/presented") {
        // present 工具投递的文件：宿主记的是**路径**，不是图片附件块 →
        // 不桥接的话手机端永远看不到这些图（用户反馈：桌面有、手机没有）。
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
      const itemId = typeof message?.id === "string" ? message.id : "";
      if (itemId === "") continue;
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
    if (data?.source?.kind !== "user") return;
    const rpcId = typeof data?.source?.rpcId === "string" ? data.source.rpcId : "";
    if (rpcId === "") return;
    const items = this.#queues.get(sessionId);
    if (!items || items.length === 0) return;
    const index = items.findIndex((item) => item.rpcId !== "" && item.rpcId === rpcId);
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
    const items = (this.#queues.get(sessionId) ?? []).map((item) => ({
      itemId: item.itemId,
      text: item.text,
      target: item.target,
    }));
    // 日志只打 sessionId / 条数 / target——绝不输出消息正文（可能含敏感内容）
    this.#log("info", "session.queue", { sessionId, count: items.length, target });
    this.#sendEvent("session.queue", { sessionId, items });
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
    for (const b of this.#deltaBuf.values()) {
      if (b.timer !== null) clearTimeout(b.timer);
    }
    this.#deltaBuf.clear();
    for (const b of this.#reasoningBuf.values()) {
      if (b.timer !== null) clearTimeout(b.timer);
    }
    this.#reasoningBuf.clear();
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

  // ---- assistant.delta 节流 -------------------------------------------------

  #queueDelta(sessionId, text) {
    let b = this.#deltaBuf.get(sessionId);
    if (b === undefined) {
      b = { text: "", timer: null };
      this.#deltaBuf.set(sessionId, b);
    }
    b.text += text;
    if (b.text.length > 65_536) b.text = b.text.slice(-65_536); // 内存上限
    if (b.timer === null) {
      b.timer = setTimeout(() => this.#flushDelta(sessionId), Math.ceil(1000 / ASSISTANT_THROTTLE_PER_SEC));
    }
  }

  #flushDelta(sessionId) {
    const b = this.#deltaBuf.get(sessionId);
    if (b === undefined) return;
    if (b.timer !== null) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    const text = b.text;
    b.text = "";
    if (text !== "") this.#sendEvent("assistant.delta", { sessionId, text });
  }

  // ---- assistant.reasoningDelta 节流（v1.0.7，与正文同口径 ≤8 条/秒）--------

  #queueReasoning(sessionId, text) {
    let b = this.#reasoningBuf.get(sessionId);
    if (b === undefined) {
      b = { text: "", timer: null };
      this.#reasoningBuf.set(sessionId, b);
    }
    b.text += text;
    if (b.text.length > 65_536) b.text = b.text.slice(-65_536); // 内存上限
    if (b.timer === null) {
      b.timer = setTimeout(() => this.#flushReasoning(sessionId), Math.ceil(1000 / ASSISTANT_THROTTLE_PER_SEC));
    }
  }

  #flushReasoning(sessionId) {
    const b = this.#reasoningBuf.get(sessionId);
    if (b === undefined) return;
    if (b.timer !== null) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    const text = b.text;
    b.text = "";
    if (text !== "") this.#sendEvent("assistant.reasoningDelta", { sessionId, text });
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
          return this.#rSessionModel(m);
        case "session.archive":
          return await this.#rSessionArchive(m);
        case "session.unarchive":
          return await this.#rSessionUnarchive(m);
        case "session.prompt":
          return await this.#rSessionPrompt(m);
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
          return this.#rQuestionAnswer(m);
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
   *  throughSeq（宿主实证）必须是日志中真实存在的末尾 seq——直接传
   *  MAX_SAFE_INTEGER 会被宿主 bad-request 拒绝（past cursor），-1 只用于空日志；
   *  故先 inspect 冷读拿日志尾 seq 作为切点，再 page 取消息对齐的一页。
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
      // v1.1.1（§5.10.2）：交付物图片作为**独立**的历史消息（两条回包路径都要带上）
      const delivered = await this.#deliveredHistoryMessages(sessionId);
      let cursor = -1;
      let address = { kind: "session", sessionId };
      try {
        const inspected = await sc.inspect(sessionId, signal);
        const events = inspected?.events;
        if (Array.isArray(events) && events.length > 0) {
          const lastSeq = Number(events[events.length - 1]?.seq);
          if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) cursor = lastSeq;
        }
        // subagent 会话必须走 durable subagent 地址（宿主校验：kind:'session' 会被拒）
        const header = inspected?.meta;
        const parent = typeof header?.parentSession === "string" ? header.parentSession : "";
        if (header?.origin === "subagent" && parent !== "") {
          address = { kind: "subagent", parentSessionId: parent, childSessionId: sessionId, mode: "unknown" };
        }
      } catch (e) {
        // inspect 失败（会话不存在等）→ 直接把错误回给手机端
        throw e;
      }
      if (cursor < 0) {
        // 空会话（无任何事件）：直接回空页，不折腾 page
        // （交付物图片仍要带上——它们不在宿主的会话日志里）
        this.#reply(m, resultOf(m, { messages: delivered, steps: [], hasMore: false, oldestSeq: 0 }));
        return;
      }
      const request = { address, throughSeq: cursor, maxMessages };
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
      const page = await sc.page(request, signal);
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
      //（不是丢一帧）。先剥缩略图、再丢 images[]；实在装不下（只剩文字就超了）
      // → 回 error，宁可这一页失败也不能把整条链路顶爆。
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
      if (fit.overflow) {
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
      this.#reply(m, resultOf(m, fit.value));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-history-failed", errText(e)));
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
      if (typeof p.cwd === "string" && p.cwd !== "") req.cwd = p.cwd;
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
    this.#reply(
      m,
      resultOf(m, {
        presets: presets.presets,
        permissions: permissions.permissions,
        defaultPreset: presets.defaultPreset,
        defaultPermission: permissions.defaultPermission,
        models: models.models,
        defaultModelId: models.defaultModelId,
        archiveSupported: this.#archiveSupported(),
      }),
    );
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

  /** 契约 §5.1/§5.8（v1.0.8）session.model：查询会话当前模型/思考强度。
   *  数据源是 model/selection 会话事件维护的**内存态**——插件重启后无记录 → null
   *  （**不得臆造**；客户端回退展示目录默认）。 */
  #rSessionModel(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    if (sessionId === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId required"));
      return;
    }
    const model = this.#modelSelections.get(sessionId) ?? null;
    this.#reply(m, resultOf(m, { model }));
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
    if (sessionId === "" || text.trim() === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId and non-empty text required"));
      return;
    }
    // v1.1.1（契约 §5.1）：mode 只认两个字面量，缺省 'queue'。
    // 其它值（含 null / 空串 / 大写）一律回 bad-params —— 默默当 queue 会让用户
    // 以为消息插进了正在跑的 turn，实际却排在后面（行为与预期不符，且难排查）。
    const mode = p.mode === undefined ? "queue" : p.mode;
    if (mode !== "queue" && mode !== "steer") {
      this.#reply(m, errorOf(m, "bad-params", "mode 只支持 queue / steer（缺省 queue）。"));
      return;
    }
    try {
      const value = await this.#sc().prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode,
          content: [{ type: "text", text }],
        },
        this.#signal(30_000),
      );
      this.#reply(m, resultOf(m, { accepted: value?.accepted === true }));
    } catch (e) {
      // 宿主拒绝（如 steer 不可用：session/steer-unavailable）时**原样**回宿主的
      // 错误码与文案——吞掉的话客户端没法退回 queue 重发。
      const err = hostErrorOf(e, "prompt-failed");
      this.#log("warn", "prompt failed", { sessionId, mode, code: err.code });
      this.#reply(m, errorOf(m, err.code, err.message));
    }
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

  #rQuestionAnswer(m) {
    const p = m.payload ?? {};
    const askId = typeof p.askId === "string" ? p.askId : "";
    const entry = askId === "" ? undefined : this.#pending.get(askId);
    if (entry === undefined || entry.kind !== "question") {
      this.#reply(m, resultOf(m, { applied: false }));
      return;
    }
    const answers = p.answers;
    if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
      this.#reply(m, errorOf(m, "bad-answers", "answers must be an object of questionId -> label(s)"));
      return;
    }
    this.#settle(entry, "phone", { answers, freeText: typeof p.freeText === "string" ? p.freeText : "" });
    this.#reply(m, resultOf(m, { applied: true }));
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
    const sent = this.#sendEvent(
      "approval.request",
      {
        askId,
        sessionId,
        toolName: String(req?.toolName ?? "unknown"),
        reason: typeof req?.reason === "string" ? req.reason : "",
        argsPreview: this.#argsPreviewOf(req?.agent, req?.callId),
        timeoutMs,
      },
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
    const askId = randomUUID();
    const sessionId = String(req?.agent?.session?.id ?? "");
    const timeoutMs = Number(this.#cfg.approvalTimeoutMs) || 120_000;
    const questions = (Array.isArray(req?.questions) ? req.questions : []).map((q) => ({
      id: String(q?.id ?? ""),
      question: String(q?.question ?? ""),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: String(o?.label ?? ""),
        description: typeof o?.description === "string" ? o.description : "",
      })),
    }));
    if (questions.length === 0 || questions.some((q) => q.id === "")) return next(); // 形状不对，放行
    const sent = this.#sendEvent(
      "question.request",
      {
        askId,
        sessionId,
        questions,
        timeoutMs,
        multiSelect: questions.some((q) => q.multiSelect),
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
    });
    if (outcome.settled === "phone") {
      this.#sendEvent("question.resolved", { askId, source: "phone" });
      return toAskUserQuestionAnswer(questions, outcome.answers, outcome.freeText);
    }
    this.#sendEvent("question.resolved", { askId, source: "timeout" });
    try {
      return await next();
    } catch (e) {
      this.#log("warn", "next() after question timeout failed", { error: errText(e) });
      throw e;
    }
  }

  /**
   * 等待手机应答：Promise 竞速 [answer, timeout, abort]。
   * settle 后从 #pending 移除——迟到的手机回答回 applied:false（§5.5）。
   * @returns {Promise<{settled:"phone", ...}|{settled:"timeout"}>}
   */
  #waitForAnswer({ askId, kind, sessionId, signal, timeoutMs }) {
    return new Promise((resolve) => {
      const entry = {
        kind,
        sessionId,
        resolve,
        timer: null,
        signal,
        abortHandler: null,
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
