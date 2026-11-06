/*
 * Copyright (c) 2026 dukedsh.
 * 用户提示词附件的纯规划 / 校验逻辑（契约 §5.11，v1.2.0）。
 *
 * 本文件是**纯 TypeScript**（不依赖 ArkTS / 平台 API），同时被
 *  - entry/src/main/ets/model/attachments.ets（真机路径）
 *  - app/attachment-contract-test.mjs（node 行为回归）
 * 引用：分块计划、块大小 clamp、URI 取文件名、字节数格式化、上限校验。
 * 行为口径一旦变了，两侧一起变——不要把这里的规则复制到别处。
 */

/** 附件种类（wire 取值，契约 §5.11）。 */
export const ATTACHMENT_KIND_IMAGE: string = 'image';
export const ATTACHMENT_KIND_FILE: string = 'file';

/** 契约 §5.11.1 的缺省上限（宿主不回字段时按这些保守值处理）。 */
export const DEFAULT_MAX_COUNT: number = 9;
export const DEFAULT_MAX_ITEM_BYTES: number = 20 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES: number = 40 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES: number = 256 * 1024;

/**
 * 单块明文硬上限（256KiB）。
 * 256KiB 明文 → 约 341KB 标准 base64 → 约 460KB AES-GCM 密文帧，远低于中继 1MiB。
 * 客户端只能比 `caps.chunkBytes` **更小**，绝不能更大（否则可能撑爆中继单帧）。
 */
export const MAX_CHUNK_BYTES: number = 256 * 1024;

/** 宿主默认接受的图片媒体类型（契约 §5.11.1 imageMediaTypes）。 */
export const DEFAULT_IMAGE_MEDIA_TYPES: string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** 附件能力目录（规范化后：字段齐全、数值已 clamp）。 */
export interface AttachmentCaps {
  supported: boolean;
  maxCount: number;
  maxItemBytes: number;
  maxMessageBytes: number;
  chunkBytes: number;
  imageMediaTypes: string[];
}

/** 能力目录的 wire 形状（字段全可选：旧插件不带 attachments）。 */
export interface AttachmentCapsLike {
  supported?: boolean;
  maxCount?: number;
  maxItemBytes?: number;
  maxMessageBytes?: number;
  chunkBytes?: number;
  imageMediaTypes?: string[];
}

/** 待校验的附件草稿（只取上限校验需要的字段）。 */
export interface AttachmentDraftLike {
  kind: string;
  name: string;
  mediaType: string;
  bytes: number;
}

/** 上限校验结果（reason 供程序判断，message 直接给 toast）。 */
export interface AttachmentCheck {
  ok: boolean;
  reason: string;
  message: string;
}

/** 正整数兜底。 */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * 规范化 `session.capabilities.attachments`：
 * 缺字段按契约当前实现常量兜底；`supported` 缺失/false 一律 false（客户端隐藏入口）。
 */
export function normalizeAttachmentCaps(raw: AttachmentCapsLike | null | undefined): AttachmentCaps {
  const caps: AttachmentCaps = {
    supported: raw !== null && raw !== undefined && raw.supported === true,
    maxCount: positiveInt(raw?.maxCount, DEFAULT_MAX_COUNT),
    maxItemBytes: positiveInt(raw?.maxItemBytes, DEFAULT_MAX_ITEM_BYTES),
    maxMessageBytes: positiveInt(raw?.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
    chunkBytes: clampChunkBytes(raw?.chunkBytes),
    imageMediaTypes: DEFAULT_IMAGE_MEDIA_TYPES.slice()
  };
  const types: string[] | undefined = raw?.imageMediaTypes;
  if (types !== undefined && types.length > 0) {
    const list: string[] = [];
    for (let i: number = 0; i < types.length; i++) {
      const t: string = types[i];
      if (typeof t === 'string' && t.length > 0) {
        list.push(t);
      }
    }
    if (list.length > 0) {
      caps.imageMediaTypes = list;
    }
  }
  return caps;
}

/** 宿主是否支持附件（缺省 / false → 隐藏附件入口）。 */
export function attachmentSupported(raw: AttachmentCapsLike | null | undefined): boolean {
  return raw !== null && raw !== undefined && raw.supported === true;
}

/**
 * 单块明文大小 clamp：
 *  - 非正数 / 非有限值 → 缺省 256KiB；
 *  - 宿主给的更小值尊重之（客户端可更小）；
 *  - 超过 256KiB 一律夹到 256KiB（中继单帧 1MiB 硬约束）。
 */
export function clampChunkBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CHUNK_BYTES;
  }
  const n: number = Math.floor(value);
  return n > MAX_CHUNK_BYTES ? MAX_CHUNK_BYTES : n;
}

/** 分块数（bytes=0 → 0）。 */
export function chunkCount(bytes: number, chunkBytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  const size: number = clampChunkBytes(chunkBytes);
  return Math.ceil(bytes / size);
}

/**
 * 分块计划：返回每块的明文长度（前 n-1 块 = chunkBytes，最后一块可能更短）。
 * 例：planChunks(262145, 262144) = [262144, 1]。
 */
export function planChunks(bytes: number, chunkBytes: number): number[] {
  const out: number[] = [];
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return out;
  }
  const size: number = clampChunkBytes(chunkBytes);
  let remain: number = Math.floor(bytes);
  while (remain > 0) {
    const take: number = remain > size ? size : remain;
    out.push(take);
    remain = remain - take;
  }
  return out;
}

/** 从 URI 取文件名（去掉 query/fragment，取最后一段并解码；失败/空 → fallback）。 */
export function attachmentFileName(uri: string, fallback?: string): string {
  const tail: string = fallback !== undefined && fallback.length > 0 ? fallback : 'attachment';
  if (typeof uri !== 'string' || uri.length === 0) {
    return tail;
  }
  let path: string = uri;
  const q: number = path.indexOf('?');
  if (q >= 0) {
    path = path.substring(0, q);
  }
  const h: number = path.indexOf('#');
  if (h >= 0) {
    path = path.substring(0, h);
  }
  const slash: number = path.lastIndexOf('/');
  let name: string = slash >= 0 ? path.substring(slash + 1) : path;
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    // 非法百分号编码：保留原串（宿主会再净化文件名）
  }
  if (name.length === 0) {
    return tail;
  }
  // 宿主文件名上限 180 字符（§5.11.2 插件侧同名约束），这里先截断避免超长 toast
  return name.length > 180 ? name.substring(0, 180) : name;
}

/** 字节数 → 展示文本（B / KB / MB / GB，一位小数）。 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return Math.floor(bytes).toString() + ' B';
  }
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/** 图片媒体类型是否在宿主接受列表里（大小写不敏感）。 */
export function isAcceptedImageType(mediaType: string, accepted: string[]): boolean {
  if (typeof mediaType !== 'string' || mediaType.length === 0) {
    return false;
  }
  const want: string = mediaType.toLowerCase();
  for (let i: number = 0; i < accepted.length; i++) {
    if (accepted[i].toLowerCase() === want) {
      return true;
    }
  }
  return false;
}

/**
 * 把「已选附件 + 新附件」按契约 §5.11.1 上限校验一遍。
 * 校验顺序（先报最直观的原因）：参数 → 单项字节 → 数量 → 总字节。
 */
export function checkAttachmentDraft(existing: AttachmentDraftLike[], incoming: AttachmentDraftLike,
  caps: AttachmentCaps): AttachmentCheck {
  if (!caps.supported) {
    return { ok: false, reason: 'unsupported', message: '当前主机不支持附件' };
  }
  if (incoming.kind !== ATTACHMENT_KIND_IMAGE && incoming.kind !== ATTACHMENT_KIND_FILE) {
    return { ok: false, reason: 'bad-params', message: '附件类型不正确' };
  }
  if (!Number.isFinite(incoming.bytes) || incoming.bytes <= 0) {
    return { ok: false, reason: 'bad-params', message: '附件为空' };
  }
  if (incoming.kind === ATTACHMENT_KIND_FILE && incoming.name.trim().length === 0) {
    return { ok: false, reason: 'bad-params', message: '文件缺少文件名' };
  }
  if (incoming.kind === ATTACHMENT_KIND_IMAGE &&
    !isAcceptedImageType(incoming.mediaType, caps.imageMediaTypes)) {
    return { ok: false, reason: 'bad-params', message: '不支持的图片格式：' + incoming.mediaType };
  }
  if (incoming.bytes > caps.maxItemBytes) {
    return {
      ok: false,
      reason: 'too-large',
      message: '单个附件超过上限 ' + formatAttachmentSize(caps.maxItemBytes)
    };
  }
  if (existing.length + 1 > caps.maxCount) {
    return {
      ok: false,
      reason: 'too-many',
      message: '每条消息最多 ' + caps.maxCount.toString() + ' 个附件'
    };
  }
  let total: number = incoming.bytes;
  for (let i: number = 0; i < existing.length; i++) {
    if (Number.isFinite(existing[i].bytes) && existing[i].bytes > 0) {
      total = total + existing[i].bytes;
    }
  }
  if (total > caps.maxMessageBytes) {
    return {
      ok: false,
      reason: 'message-too-large',
      message: '附件总大小超过上限 ' + formatAttachmentSize(caps.maxMessageBytes)
    };
  }
  return { ok: true, reason: '', message: '' };
}
