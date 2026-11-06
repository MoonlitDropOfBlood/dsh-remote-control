// lib/attachments.mjs —— 用户提示词的附件（契约 §5.11，v1.2.0）。
//
// 手机端输入框与 DSH 桌面端 composer 一样支持图片/文件附件。中继单帧上限
// 1MiB（密文帧），原图/大文件不能塞进一条 `session.prompt`，所以走**分块上传**：
//
//   begin {sessionId,kind,name?,mediaType?,bytes} → {uploadId,chunkBytes}
//   chunk {uploadId,index,data}                   → {received}
//   commit{uploadId}                              → {attachment}
//   prompt {sessionId,text,uploads:[uploadId…]}    → 插件换宿主 receipt 再 prompt
//
// 本模块只做**纯状态机 + 校验 + wire 映射**（不碰 ctx、不读盘、不写盘），
// 便于 scripts/verify-attachments.mjs 直接单测。真正的附件落盘由 host-bridge
// 调宿主 `ctx.fileUploads.uploadImageStream / uploadStream` 完成（见附录 D）：
// 宿主 receipt 是 prompt 准入时唯一认可的附件凭据（直接塞 attachment ref 会被
// 宿主拒为 FILE_NOT_STAGED）。
import { randomBytes } from "node:crypto";

/** 附件种类（wire 取值）。 */
export const ATTACHMENT_KIND_IMAGE = "image";
export const ATTACHMENT_KIND_FILE = "file";

/** 宿主接受的图片媒体类型（dsh-attachment 的 ImageMediaType，§5.11.1）。 */
export const ATTACHMENT_IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * 契约 §5.11.1 的固定上限（插件侧实现常量；wire 上由 session.capabilities 暴露）。
 * 这些是**手机端单条消息**的保守上限，不是宿主部署上限（宿主另有自己的准入）。
 */
export const ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 9,
  maxItemBytes: 20 * 1024 * 1024,
  maxMessageBytes: 40 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  imageMediaTypes: ATTACHMENT_IMAGE_TYPES,
});

/** 未提交上传的存活时间（契约 §5.11.2：begin 后 5 分钟内必须 commit）。 */
export const UPLOAD_TTL_MS = 5 * 60 * 1000;

/** 已提交附件的可用时间（契约 §5.11.2：commit 后 60 分钟内可用于一次 prompt）。 */
export const STAGED_TTL_MS = 60 * 60 * 1000;

/** 同时未提交的上传上限（契约 §5.11.2：第 5 个回 attachment-too-many）。 */
export const MAX_PENDING_UPLOADS = 4;

/** 已消费 uploadId 的墓碑上限（用于区分「用过了」与「没收到过」，避免无限增长）。 */
const CONSUMED_TOMBSTONE_MAX = 256;

/** 附件文件名净化后的最大长度（字符）。 */
const MAX_NAME_LENGTH = 180;

/**
 * 附件处理的稳定错误（host-bridge 直接映射成 result.error.code）。
 * @param {string} code 契约 §5.11.5 的错误码
 * @param {string} message 面向用户的中文原因
 */
export class AttachmentWireError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "AttachmentWireError";
    this.code = code;
  }
}

/** 契约 §5.11.1 能力目录（插件支持时固定输出；不支持时 host-bridge 省略该字段）。 */
export function attachmentCapabilities() {
  return {
    supported: true,
    maxCount: ATTACHMENT_LIMITS.maxCount,
    maxItemBytes: ATTACHMENT_LIMITS.maxItemBytes,
    maxMessageBytes: ATTACHMENT_LIMITS.maxMessageBytes,
    chunkBytes: ATTACHMENT_LIMITS.chunkBytes,
    imageMediaTypes: [...ATTACHMENT_IMAGE_TYPES],
  };
}

/**
 * 是否为宿主接受的图片类型（大小写敏感，wire 规定小写）。
 * @param {unknown} mediaType
 * @returns {boolean}
 */
export function isImageMediaType(mediaType) {
  return typeof mediaType === "string" && ATTACHMENT_IMAGE_TYPES.includes(mediaType);
}

/**
 * 净化显示文件名：去路径、去控制字符、限长；空/非法 → 空串（由调用方决定是否拒绝）。
 * 附件服务自己还会再净化一次（它不接受路径），这里只保证不把路径带进 wire/日志。
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeAttachmentName(name) {
  if (typeof name !== "string") return "";
  let out = "";
  for (const ch of name.replace(/\\/g, "/").split("/").pop() ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // 控制字符
    out += ch;
    if (out.length >= MAX_NAME_LENGTH) break;
  }
  return out.trim();
}

/**
 * 生成 uploadId（24 位十六进制；只用于插件内存索引，不落盘、不进日志）。
 * @returns {string}
 */
export function newUploadId() {
  return `up_${randomBytes(12).toString("hex")}`;
}

/**
 * 校验并解码一个 chunk 的 canonical base64。
 *
 * 契约要求 `data` 是**标准 base64（canonical）**：解码后重编码必须逐字相同
 * （否则同一个字节串有多个合法写法，分块校验会失去确定性）。
 * @param {unknown} data
 * @param {number} maxBytes 单块明文上限（最后一小块可短）
 * @returns {Buffer} 解码后的明文块
 * @throws {AttachmentWireError} 非字符串 / 非 canonical / 空块 / 超长
 */
export function decodeChunkData(data, maxBytes = ATTACHMENT_LIMITS.chunkBytes) {
  if (typeof data !== "string") {
    throw new AttachmentWireError("attachment-bad-params", "chunk data 必须是 base64 字符串");
  }
  if (data.length === 0) {
    throw new AttachmentWireError("attachment-chunk-mismatch", "空分块（附件字节数 > 0）");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new AttachmentWireError("attachment-bad-params", "chunk data 必须是标准 base64（canonical）");
  }
  if (bytes.length === 0) {
    throw new AttachmentWireError("attachment-chunk-mismatch", "空分块（附件字节数 > 0）");
  }
  if (bytes.length > maxBytes) {
    throw new AttachmentWireError("attachment-chunk-mismatch", "分块超过 chunkBytes 上限");
  }
  return bytes;
}

/**
 * 校验 `attachment.upload.begin` 的 payload（纯函数）。
 * @param {any} payload 业务信封 payload
 * @param {{maxItemBytes?:number, imageMediaTypes?:readonly string[]}} [limits]
 * @returns {{sessionId:string,kind:string,name:string,mediaType:string,bytes:number}}
 * @throws {AttachmentWireError}
 */
export function parseUploadBegin(payload, limits = ATTACHMENT_LIMITS) {
  const p = payload ?? {};
  const sessionId = typeof p.sessionId === "string" ? p.sessionId.trim() : "";
  if (sessionId === "") {
    throw new AttachmentWireError("attachment-bad-params", "sessionId required");
  }
  const kind = p.kind;
  if (kind !== ATTACHMENT_KIND_IMAGE && kind !== ATTACHMENT_KIND_FILE) {
    throw new AttachmentWireError("attachment-bad-params", 'kind must be "image" or "file"');
  }
  const bytes = p.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new AttachmentWireError("attachment-bad-params", "bytes must be a non-negative safe integer");
  }
  const maxItemBytes = Number.isSafeInteger(limits?.maxItemBytes)
    ? limits.maxItemBytes
    : ATTACHMENT_LIMITS.maxItemBytes;
  if (bytes > maxItemBytes) {
    throw new AttachmentWireError(
      "attachment-too-large",
      `附件过大（${bytes} 字节，上限 ${maxItemBytes} 字节）`,
    );
  }
  const name = sanitizeAttachmentName(p.name);
  let mediaType = "";
  if (kind === ATTACHMENT_KIND_IMAGE) {
    const accepted = Array.isArray(limits?.imageMediaTypes)
      ? limits.imageMediaTypes
      : ATTACHMENT_IMAGE_TYPES;
    if (typeof p.mediaType !== "string" || !accepted.includes(p.mediaType)) {
      throw new AttachmentWireError(
        "attachment-bad-params",
        `图片 mediaType 必须是 ${accepted.join(" / ")} 之一`,
      );
    }
    mediaType = p.mediaType;
    if (bytes === 0) {
      throw new AttachmentWireError("attachment-bad-params", "图片附件不能是空文件");
    }
  } else if (name === "") {
    // 文件必须有显示名（宿主用它做存储别名与模型末端的提示行）
    throw new AttachmentWireError("attachment-bad-params", "文件附件必须带 name");
  }
  return { sessionId, kind, name, mediaType, bytes };
}

/**
 * 分块总数（bytes=0 → 0；否则 ceil）。
 * @param {number} bytes
 * @param {number} [chunkBytes]
 * @returns {number}
 */
export function chunkCountOf(bytes, chunkBytes = ATTACHMENT_LIMITS.chunkBytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return 0;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) return 0;
  return Math.ceil(bytes / chunkBytes);
}

/**
 * 一个 uploadId 当前已收字节数（供 `received` 回包 / 校验）。
 * @param {{received:number}} record
 * @returns {number}
 */
export function receivedOf(record) {
  return Number.isSafeInteger(record?.received) ? record.received : 0;
}

/**
 * commit 成功后附件 → wire UploadedAttachment（契约 §5.11.2）。
 * @param {{kind:string,name?:string,mediaType?:string,bytes:number,width?:number,height?:number,
 *          attachment?:any,requestedName?:string}} record
 * @returns {{kind:string,name?:string,mediaType?:string,bytes:number,width?:number,height?:number}}
 */
export function uploadedAttachmentOf(record) {
  const attachment = record?.attachment ?? {};
  const bytes =
    Number.isSafeInteger(attachment.bytes) && attachment.bytes >= 0
      ? attachment.bytes
      : Number.isSafeInteger(record?.bytes)
        ? record.bytes
        : 0;
  /** @type {{kind:string,name?:string,mediaType?:string,bytes:number,width?:number,height?:number}} */
  const out = { kind: record?.kind === ATTACHMENT_KIND_IMAGE ? ATTACHMENT_KIND_IMAGE : ATTACHMENT_KIND_FILE };
  const name =
    sanitizeAttachmentName(attachment.name) ||
    sanitizeAttachmentName(record?.requestedName) ||
    sanitizeAttachmentName(record?.name);
  if (name !== "") out.name = name;
  if (out.kind === ATTACHMENT_KIND_IMAGE) {
    const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType : record?.mediaType;
    if (typeof mediaType === "string" && mediaType !== "") out.mediaType = mediaType;
    out.width = Number.isSafeInteger(attachment.width) && attachment.width > 0 ? attachment.width : 0;
    out.height = Number.isSafeInteger(attachment.height) && attachment.height > 0 ? attachment.height : 0;
  }
  out.bytes = bytes;
  return out;
}

/**
 * 校验 prompt 的 `uploads` 列表（纯函数）：类型、条数、总字节、去重。
 * 上传记录的可用性（存在/会话匹配/未消费/未过期）由 registry 负责——本函数只守 wire。
 * @param {any} uploads
 * @param {{maxCount?:number, maxMessageBytes?:number}} [limits]
 * @returns {string[]} 去重后的 uploadId 列表（保留首次出现顺序）
 * @throws {AttachmentWireError}
 */
export function parseUploadIds(uploads, limits = ATTACHMENT_LIMITS) {
  if (uploads === undefined || uploads === null) return [];
  if (!Array.isArray(uploads)) {
    throw new AttachmentWireError("attachment-bad-params", "uploads must be an array of uploadId");
  }
  const maxCount = Number.isSafeInteger(limits?.maxCount) ? limits.maxCount : ATTACHMENT_LIMITS.maxCount;
  if (uploads.length > maxCount) {
    throw new AttachmentWireError("attachment-too-many", `单条消息最多 ${maxCount} 个附件`);
  }
  const out = [];
  for (const id of uploads) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new AttachmentWireError("attachment-bad-params", "uploads 含非法 uploadId");
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 附件上传登记表（内存）：未提交缓冲 + 已提交 staged receipt + 已消费墓碑。
 *
 * 生命周期（契约 §5.11.2）：
 *  - `receiving`：begin 后收 chunk；5 分钟未 commit 即过期；
 *  - `committing`：已进入宿主落盘（期间不再收 chunk）；宿主失败可退回 `receiving`；
 *  - `staged`：commit 成功，60 分钟内可用于**一次** prompt；
 *  - `consumed`：prompt 已被宿主接受（墓碑只用于给出准确错误码）。
 *
 * 线程模型：Node 单线程；方法都是同步的，唯一 await 在 host-bridge 调宿主时。
 */
export class UploadRegistry {
  /** @type {Map<string, any>} */
  #receiving = new Map();
  /** @type {Map<string, any>} */
  #staged = new Map();
  /** @type {Map<string, number>} consumed uploadId → 消费时间 */
  #consumed = new Map();
  #now;
  #limits;
  #pendingTtlMs;
  #stagedTtlMs;
  #maxPending;
  #seq = 0;

  /**
   * @param {{now?:()=>number, limits?:any, pendingTtlMs?:number, stagedTtlMs?:number,
   *          maxPending?:number}} [options]
   */
  constructor(options = {}) {
    this.#now = typeof options.now === "function" ? options.now : () => Date.now();
    this.#limits = options.limits ?? ATTACHMENT_LIMITS;
    this.#pendingTtlMs = Number.isSafeInteger(options.pendingTtlMs)
      ? options.pendingTtlMs
      : UPLOAD_TTL_MS;
    this.#stagedTtlMs = Number.isSafeInteger(options.stagedTtlMs) ? options.stagedTtlMs : STAGED_TTL_MS;
    this.#maxPending = Number.isSafeInteger(options.maxPending) ? options.maxPending : MAX_PENDING_UPLOADS;
  }

  /** 当前未提交 + 已提交（未消费）的条数（诊断/测试用）。 */
  get size() {
    return this.#receiving.size + this.#staged.size;
  }

  /**
   * begin：登记一次上传。
   * @param {any} payload
   * @returns {{uploadId:string, chunkBytes:number}}
   */
  begin(payload) {
    this.prune();
    const parsed = parseUploadBegin(payload, this.#limits);
    if (this.#receiving.size >= this.#maxPending) {
      throw new AttachmentWireError(
        "attachment-too-many",
        `已有 ${this.#receiving.size} 个未完成上传（上限 ${this.#maxPending}）`,
      );
    }
    const uploadId = newUploadId();
    this.#receiving.set(uploadId, {
      uploadId,
      sessionId: parsed.sessionId,
      kind: parsed.kind,
      name: parsed.name,
      mediaType: parsed.mediaType,
      bytes: parsed.bytes,
      received: 0,
      chunks: [],
      state: "receiving",
      beganAt: this.#now(),
      seq: ++this.#seq,
    });
    return { uploadId, chunkBytes: this.#limits.chunkBytes ?? ATTACHMENT_LIMITS.chunkBytes };
  }

  /**
   * 收一个分块：index 必须连续、长度不得超过 begin.bytes、每块只发一次。
   * @param {any} payload `{uploadId,index,data}`
   * @returns {{received:number}}
   */
  chunk(payload) {
    this.prune();
    const p = payload ?? {};
    const uploadId = typeof p.uploadId === "string" ? p.uploadId : "";
    const record = this.#receivingRecord(uploadId);
    if (record.state !== "receiving") {
      throw new AttachmentWireError("attachment-upload-consumed", "该上传正在提交，不能再追加分块");
    }
    if (!Number.isSafeInteger(p.index) || p.index < 0) {
      throw new AttachmentWireError("attachment-bad-params", "index must be a non-negative safe integer");
    }
    if (p.index !== record.chunks.length) {
      throw new AttachmentWireError(
        "attachment-chunk-mismatch",
        `分块序号不连续（期望 ${record.chunks.length}，收到 ${p.index}）`,
      );
    }
    if (record.received >= record.bytes) {
      throw new AttachmentWireError("attachment-chunk-mismatch", "附件已收满，不能继续追加分块");
    }
    const remaining = record.bytes - record.received;
    const maxChunk = Math.min(
      this.#limits.chunkBytes ?? ATTACHMENT_LIMITS.chunkBytes,
      remaining,
    );
    const bytes = decodeChunkData(p.data, maxChunk);
    record.chunks.push(bytes);
    record.received += bytes.length;
    return { received: record.received };
  }

  /**
   * 进入提交：把上传从「收块」切到「落盘」。宿主失败时必须调 `failCommit` 退回。
   * @param {unknown} uploadId
   * @returns {any} 上传记录（含 chunks 与 bytes）
   * @throws {AttachmentWireError} 未知/过期/未收满
   */
  beginCommit(uploadId) {
    this.prune();
    const record = this.#receivingRecord(uploadId);
    if (record.state !== "receiving") {
      throw new AttachmentWireError("attachment-upload-consumed", "该上传正在提交，请勿重复 commit");
    }
    if (record.received !== record.bytes) {
      throw new AttachmentWireError(
        "attachment-chunk-mismatch",
        `附件未收完（已收 ${record.received}/${record.bytes} 字节）`,
      );
    }
    record.state = "committing";
    return record;
  }

  /**
   * 提交失败：把记录退回 receiving（保留缓冲，允许客户端重试 commit）。
   * @param {unknown} uploadId
   */
  failCommit(uploadId) {
    const record = this.#receiving.get(typeof uploadId === "string" ? uploadId : "");
    if (record !== undefined && record.state === "committing") {
      record.state = "receiving";
    }
  }

  /**
   * 提交成功：转入 staged（保存宿主 receipt，供后续 prompt 使用）。
   * @param {unknown} uploadId
   * @param {{receiptId:string, attachment:any}} input
   * @returns {any} staged 记录
   */
  completeCommit(uploadId, input) {
    const id = typeof uploadId === "string" ? uploadId : "";
    const record = this.#receiving.get(id);
    if (record === undefined) {
      throw new AttachmentWireError("attachment-upload-not-found", "上传不存在或已过期");
    }
    const receiptId = typeof input?.receiptId === "string" ? input.receiptId : "";
    if (receiptId === "") {
      // 宿主没给 receipt，这条上传没法用于 prompt —— 不能假装成功
      this.failCommit(id);
      throw new AttachmentWireError("attachment-upload-failed", "宿主未返回附件凭据");
    }
    this.#receiving.delete(id);
    const staged = {
      uploadId: id,
      sessionId: record.sessionId,
      kind: record.kind,
      name: record.name,
      mediaType: record.mediaType,
      bytes: record.bytes,
      receiptId,
      attachment: input?.attachment ?? {},
      state: "staged",
      committedAt: this.#now(),
      seq: record.seq,
    };
    this.#staged.set(id, staged);
    return staged;
  }

  /**
   * 放弃上传（幂等）：只对未提交记录生效；已 staged 的返回 false（宿主附件不可删除）。
   * @param {unknown} uploadId
   * @returns {boolean}
   */
  abort(uploadId) {
    const id = typeof uploadId === "string" ? uploadId : "";
    const record = this.#receiving.get(id);
    // 正在落盘的附件不能撤（宿主可能已经写入存储）；只有还在收块的才能放弃。
    if (record === undefined || record.state !== "receiving") return false;
    this.#receiving.delete(id);
    return true;
  }

  /**
   * 提示词前解析 uploads：全集校验（会话绑定 / 未消费 / 未过期 / 条数与总字节）。
   * 不在这里标记消费——宿主接受 prompt 后才调 `markConsumed`。
   * @param {string} sessionId
   * @param {unknown} uploadIds
   * @returns {{uploadId:string, receiptId:string, kind:string, bytes:number, seq:number}[]}
   */
  promptUploads(sessionId, uploadIds) {
    this.prune();
    const ids = parseUploadIds(uploadIds, this.#limits);
    const out = [];
    let total = 0;
    for (const id of ids) {
      if (this.#consumed.has(id)) {
        throw new AttachmentWireError("attachment-upload-consumed", "该附件已用于上一条消息");
      }
      const staged = this.#staged.get(id);
      if (staged === undefined) {
        throw new AttachmentWireError("attachment-upload-not-found", "附件上传记录不存在或已过期");
      }
      if (staged.sessionId !== sessionId) {
        throw new AttachmentWireError("attachment-upload-not-found", "附件不属于该会话");
      }
      total += staged.bytes;
      out.push({
        uploadId: id,
        receiptId: staged.receiptId,
        kind: staged.kind,
        bytes: staged.bytes,
        seq: staged.seq,
      });
    }
    const maxMessageBytes = Number.isSafeInteger(this.#limits.maxMessageBytes)
      ? this.#limits.maxMessageBytes
      : ATTACHMENT_LIMITS.maxMessageBytes;
    if (total > maxMessageBytes) {
      throw new AttachmentWireError(
        "attachment-too-large",
        `附件总大小超限（${total} 字节，上限 ${maxMessageBytes} 字节）`,
      );
    }
    return out;
  }

  /**
   * 宿主要求 prompt 成功接受后调用：staged → consumed 墓碑。
   * @param {readonly string[]} uploadIds
   */
  markConsumed(uploadIds) {
    if (!Array.isArray(uploadIds)) return;
    const now = this.#now();
    for (const id of uploadIds) {
      if (typeof id !== "string" || id === "") continue;
      this.#staged.delete(id);
      this.#consumed.set(id, now);
    }
    // 墓碑裁剪（按插入序淘汰最旧）
    while (this.#consumed.size > CONSUMED_TOMBSTONE_MAX) {
      const oldest = this.#consumed.keys().next();
      if (oldest.done === true) break;
      this.#consumed.delete(oldest.value);
    }
  }

  /** 清理过期记录（begin 后 5 分钟 / commit 后 60 分钟）。 */
  prune() {
    const now = this.#now();
    for (const [id, record] of this.#receiving) {
      const beganAt = Number.isSafeInteger(record.beganAt) ? record.beganAt : now;
      if (now - beganAt > this.#pendingTtlMs) this.#receiving.delete(id);
    }
    for (const [id, record] of this.#staged) {
      const committedAt = Number.isSafeInteger(record.committedAt) ? record.committedAt : now;
      if (now - committedAt > this.#stagedTtlMs) this.#staged.delete(id);
    }
    for (const [id, at] of this.#consumed) {
      if (now - at > this.#stagedTtlMs) this.#consumed.delete(id);
    }
  }

  /**
   * 取一个未提交记录；不存在/过期 → `attachment-upload-not-found`。
   * @param {unknown} uploadId
   * @returns {any}
   */
  #receivingRecord(uploadId) {
    const id = typeof uploadId === "string" ? uploadId : "";
    if (id === "") {
      throw new AttachmentWireError("attachment-bad-params", "uploadId required");
    }
    const record = this.#receiving.get(id);
    if (record === undefined) {
      throw new AttachmentWireError("attachment-upload-not-found", "上传不存在或已过期");
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// 历史消息里的文件块（契约 §5.11.4）
// ---------------------------------------------------------------------------

/**
 * 从 ContentBlock[] 里取文件附件（与 imageBlocksOf 同口径：只认结构，不读字节）。
 *
 * 宿主 `FileBlock = { type:'file', attachment:{ attachmentId, name, bytes } }`；
 * 其他形态（缺 attachment/缺 name）跳过，绝不抛。
 * @param {unknown} content ContentBlock[]
 * @returns {any[]} FileAttachmentRef[]
 */
export function fileBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "file") continue;
    const attachment = block.attachment;
    if (!attachment || typeof attachment !== "object") continue;
    if (typeof attachment.attachmentId !== "string" || attachment.attachmentId === "") continue;
    if (typeof attachment.name !== "string" || attachment.name === "") continue;
    out.push(attachment);
  }
  return out;
}

/**
 * FileAttachmentRef → wire `FileRef`（契约 §5.11.4）。
 * `fileId` = 宿主附件 id（内容摘要），手机端只用于去重，不做下载。
 * @param {any} ref
 * @returns {{fileId:string,name:string,bytes:number}|null}
 */
export function fileRefMeta(ref) {
  if (!ref || typeof ref !== "object") return null;
  const fileId = typeof ref.attachmentId === "string" ? ref.attachmentId : "";
  const name = sanitizeAttachmentName(ref.name);
  if (fileId === "" || name === "") return null;
  const bytes = Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 ? ref.bytes : 0;
  return { fileId, name, bytes };
}

/**
 * 消息里的文件块 → wire `files[]`（跳过非法项；空数组不产出字段）。
 * @param {unknown} content ContentBlock[]
 * @returns {{fileId:string,name:string,bytes:number}[]}
 */
export function fileRefsOfContent(content) {
  const out = [];
  for (const ref of fileBlocksOf(content)) {
    const wire = fileRefMeta(ref);
    if (wire !== null) out.push(wire);
  }
  return out;
}

/**
 * 附件大小的人类可读文本（契约：客户端可以自己格式化；插件不用它渲染，只给日志/测试）。
 * @param {number} bytes
 * @returns {string}
 */
export function formatAttachmentBytes(bytes) {
  const n = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
