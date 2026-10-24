// lib/images.mjs —— 会话消息里的图片处理（契约 §5.10「会话消息里的图片（v1.0.9）」
// 与 §5.1 的 `image.fetch` 行）。
//
// 背景（宿主实证）：DSH 会话消息的 content 块里图片是**附件引用**，不是内联 base64：
//   { type:'image', attachment:{ attachmentId, mediaType, bytes, width, height, name? } }
// 附件服务在 Cordis ctx 里叫 `attachments`（本地后端 dsh-attachment-local 实现），
// 有 imageHostPath(ref)（宿主文件系统绝对路径）与 readImage(ref, signal)（原始字节）。
//
// 中继单帧上限 **1MiB**（密文帧），原图直传必然超限，故走契约的两段式：
//   ① 缩略图**内联**（长边 ≤480、JPEG q75、base64 ≤96KB）——事件/历史里立刻能显示；
//   ② 大图按需 `image.fetch` 拉取（等比缩放 + JPEG q85、base64 ≤1MiB 预算）。
//
// 本模块只做「图片 ↔ data URI」的纯加工；**读附件字节**在 host-bridge（那里才有 ctx）。
//
// sharp 不在插件自己的 node_modules 里（插件是 link 安装，依赖解析走真实路径），
// 故用 createRequire 从 **DSH 部署目录**动态解析；解析不到就**降级**（只发元数据、
// thumb 留空），绝不抛异常崩掉插件。
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** 宿主接受的图片类型（dsh-attachment 的 ImageMediaType）。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** 缩略图长边上限（契约 §5.10：长边 ≤ 480、JPEG q75）。 */
export const THUMB_MAX_EDGE = 480;

/** 缩略图 base64 字节上限（契约 §5.10：必须压缩到 ≤ 96KB base64）。 */
export const THUMB_MAX_BASE64 = 96 * 1024;

/** 大图缺省长边（契约 §5.1 image.fetch：maxEdge 缺省 1600）。 */
export const LARGE_DEFAULT_MAX_EDGE = 1600;

/** 大图长边上限（契约 §5.1 image.fetch：上限 4096）。 */
export const LARGE_MAX_EDGE = 4096;

/**
 * 大图 base64 字节上限。
 *
 * 契约写的是「单张回包 ≤ 1MiB（中继硬上限）」，但中继的 1MiB 限制落在 **密文帧**上
 * （relay/server.js 的 RELAY_MAX_PAYLOAD=1048576，ws maxPayload，收发两个方向都算），
 * 而密文帧 = base64url(iv+ct+tag)，明文 JSON 会被放大约 4/3 倍。所以这里给 base64
 * 留 750KB 预算：750KB base64 → 明文 ≈750KB → 密文 ≈750KB → base64url ≈1.02MB
 * < 1MiB（还留 2.4% 余量给信封/sid/seq 开销），**绝不会**把中继连接顶爆。
 * 取 750KB 也满足契约「≤1MiB」（更保守）。
 */
export const LARGE_MAX_BASE64 = 750 * 1024;

/** 缩略图 data URI 前缀（缩略图统一转 JPEG）。 */
export const THUMB_DATA_URI_PREFIX = "data:image/jpeg;base64,";

/** 缩略图质量阶梯（契约 §5.10：超限时「降质重压」）。 */
export const THUMB_LADDER = Object.freeze([
  { edge: THUMB_MAX_EDGE, quality: 75 },
  { edge: THUMB_MAX_EDGE, quality: 60 },
  { edge: 400, quality: 55 },
  { edge: 320, quality: 50 },
  { edge: 240, quality: 45 },
  { edge: 160, quality: 40 },
]);

/** 大图质量阶梯（先降质再降尺寸；每一步都保长边 ≤ maxEdge）。 */
export const LARGE_LADDER = Object.freeze([
  { scale: 1, quality: 85 },
  { scale: 1, quality: 70 },
  { scale: 0.8, quality: 70 },
  { scale: 0.8, quality: 60 },
  { scale: 0.6, quality: 60 },
  { scale: 0.45, quality: 55 },
  { scale: 0.3, quality: 50 },
  { scale: 0.2, quality: 45 },
  { scale: 0.12, quality: 40 },
]);

/**
 * 隐藏的附件引用槽位。
 *
 * ImageRef 走 wire（JSON.stringify）时不能带宿主引用对象（attachmentId 之外的字段
 * 是宿主内部结构，且可能很大）——所以用**不可枚举**的 symbol 挂上去：
 * 既能在插件内部拿到原始引用（读字节、缩略图），又绝不会进 JSON。
 */
const REF = Symbol("dshrc.attachmentRef");

/** sharp 解析器（默认按部署目录解析；可被单测替换）。null = 尚未尝试。 */
let sharpCache = null;

/** 单测注入点（生产代码不调用）：替换 sharp 解析器。传 null 恢复默认解析。 */
let sharpResolver = null;

/**
 * 注入 sharp 解析器（**仅供单测**）。
 * @param {(() => any)|null} provider 返回 sharp 模块；返回 null/抛错 = 视为不可用
 */
export function setSharpResolver(provider) {
  sharpResolver = typeof provider === "function" ? provider : null;
}

/** DSH 部署目录候选（sharp 就装在 <deploy>/node_modules/sharp）。 */
function deployRoots() {
  const roots = [];
  const env = process.env ?? {};
  if (typeof env.DSH_DEPLOY_DIR === "string" && env.DSH_DEPLOY_DIR !== "") roots.push(env.DSH_DEPLOY_DIR);
  const appdata = typeof env.APPDATA === "string" ? env.APPDATA : "";
  if (appdata !== "") roots.push(join(appdata, "DeepSeek Harness Desktop", "dsh"));
  // 同一台机器上的其它常见部署路径（Windows / Linux / macOS）
  roots.push(join(homedir(), "AppData", "Roaming", "DeepSeek Harness Desktop", "dsh"));
  roots.push(join(homedir(), ".local", "share", "DeepSeek Harness Desktop", "dsh"));
  roots.push(join(homedir(), "Library", "Application Support", "DeepSeek Harness Desktop", "dsh"));
  return roots;
}

/**
 * 解析 sharp 模块（尽力而为，**不抛**）。
 *
 * 插件自己的 node_modules 里没有 sharp（link 安装 + 依赖不打包），只能从 DSH 部署
 * 目录动态解析；解析不到时调用方必须降级（只发元数据），不能崩。
 * @returns {any|null} sharp 模块或 null
 */
export function loadSharp() {
  if (sharpResolver !== null) {
    try {
      return sharpResolver() ?? null;
    } catch {
      return null;
    }
  }
  if (sharpCache !== null) return sharpCache;
  // ① 插件自身依赖（万一以后把它列进 dependencies）
  try {
    sharpCache = createRequire(import.meta.url)("sharp");
    return sharpCache;
  } catch {
    /* 继续找部署目录 */
  }
  // ② DSH 部署目录
  for (const root of deployRoots()) {
    try {
      const req = createRequire(join(root, "package.json"));
      sharpCache = req("sharp");
      if (sharpCache) return sharpCache;
    } catch {
      /* 换下一个候选 */
    }
  }
  sharpCache = null;
  return null;
}

/** 各种字节形态 → Buffer（认 Buffer / Uint8Array / ArrayBuffer / {data}）。 */
function toBytes(input) {
  if (input === null || input === undefined) return null;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (typeof input === "object" && input.data !== undefined && input.data !== null) return toBytes(input.data);
  return null;
}

/**
 * 内容块数组 → 图片附件引用数组（契约 §5.10 的 `type:'image'` 块）。
 *
 * 只取带 `attachment` 的 image 块；结构不认识的一律跳过（绝不抛）。
 * @param {unknown} content ContentBlock[]
 * @returns {object[]} 附件引用（宿主 ImageAttachmentRef 原样）
 */
export function imageBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "image") continue;
    const ref = block.attachment;
    if (!ref || typeof ref !== "object") continue;
    out.push(ref);
  }
  return out;
}

/**
 * 附件引用 → wire ImageRef（契约 §5.10）。
 *
 * 只带**元数据**（imageId=宿主 attachmentId、mediaType、width、height、bytes），
 * thumb 留空——缩略图要读字节压缩，纯函数里做不了（见 host-bridge 的 attachThumbs）。
 * 原始附件引用挂在**不可枚举**的 symbol 上（不进 JSON）。
 * @param {any} ref 宿主附件引用
 * @returns {{imageId:string,mediaType:string,width:number,height:number,bytes:number,thumb:string}}
 */
export function imageRefMeta(ref) {
  const meta = {
    imageId: typeof ref?.attachmentId === "string" ? ref.attachmentId : "",
    mediaType: typeof ref?.mediaType === "string" ? ref.mediaType : "",
    width: Number.isSafeInteger(ref?.width) ? ref.width : 0,
    height: Number.isSafeInteger(ref?.height) ? ref.height : 0,
    bytes: Number.isSafeInteger(ref?.bytes) ? ref.bytes : 0,
    thumb: "",
  };
  try {
    Object.defineProperty(meta, REF, { value: ref, enumerable: false, configurable: true });
  } catch {
    /* 定义失败也不影响元数据本身 */
  }
  return meta;
}

/**
 * 取回 ImageRef 挂着的宿主附件引用（没有则 null）。
 * @param {any} imageRef
 * @returns {any|null}
 */
export function attachmentRefOf(imageRef) {
  if (!imageRef || typeof imageRef !== "object") return null;
  const ref = imageRef[REF];
  return ref && typeof ref === "object" ? ref : null;
}

/**
 * 渲染一档 JPEG（等比缩放 + 质量）。失败返回 null（不抛）。
 * @param {any} sharp sharp 模块
 * @param {Buffer} input 原始字节
 * @param {number} edge 长边上限
 * @param {number} quality JPEG 质量
 * @returns {Promise<{base64:string,width:number,height:number,bytes:number}|null>}
 */
async function renderJpeg(sharp, input, edge, quality) {
  try {
    // animated:false —— GIF 动图**只取首帧**（契约允许：缩略图/大图都是静态 JPEG）。
    // rotate() —— 按 EXIF 自动摆正（宿主归一化时已摆正，重复调用是幂等的）。
    const { data, info } = await sharp(input, { animated: false })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer({ resolveWithObject: true });
    return {
      base64: data.toString("base64"),
      width: Number(info?.width) || 0,
      height: Number(info?.height) || 0,
      bytes: data.length,
    };
  } catch {
    return null;
  }
}

/**
 * 缩略图（契约 §5.10）：长边 ≤480、JPEG q75，输出 `data:image/jpeg;base64,…`。
 *
 * 超 96KB base64 就沿阶梯降质/降尺寸重压；仍超限则返回 **''**（调用方只发元数据，
 * 客户端显示占位框）。sharp 不可用时同样返回 ''（**绝不抛**）。
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer 原始字节
 * @param {string} [mediaType] 原图类型（只用于诊断，不影响输出——统一转 JPEG）
 * @returns {Promise<string>} data URI 或 ''
 */
export async function makeThumb(buffer, mediaType) {
  void mediaType;
  const input = toBytes(buffer);
  if (input === null || input.length === 0) return "";
  const sharp = loadSharp();
  if (!sharp) return "";
  for (const step of THUMB_LADDER) {
    const out = await renderJpeg(sharp, input, step.edge, step.quality);
    if (out === null) continue;
    if (out.base64.length <= THUMB_MAX_BASE64) return THUMB_DATA_URI_PREFIX + out.base64;
  }
  // 压到最小一档还超限 → 只发元数据（契约允许 thumb 留空）
  return "";
}

/**
 * 大图（契约 §5.1 image.fetch）：等比缩到长边 ≤ maxEdge、JPEG q85，输出 data URI。
 *
 * maxEdge 缺省 1600、上限 4096。base64 必须 ≤ LARGE_MAX_BASE64（1MiB 预算内）；
 * 超了就沿阶梯降质/降尺寸；实在压不进去**抛错**（由上层回 error，客户端提示
 * 「原图过大，仅可看缩略图」）。
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer 原始字节
 * @param {string} [mediaType] 原图类型（统一输出 JPEG）
 * @param {number} [maxEdge] 长边上限
 * @returns {Promise<{data:string,mediaType:string,width:number,height:number,bytes:number}>}
 */
export async function makeLarge(buffer, mediaType, maxEdge) {
  void mediaType;
  const input = toBytes(buffer);
  if (input === null || input.length === 0) throw new Error("empty image buffer");
  const sharp = loadSharp();
  if (!sharp) throw new Error("sharp unavailable; cannot build large image");
  const edge = clampMaxEdge(maxEdge);
  for (const step of LARGE_LADDER) {
    const target = Math.max(1, Math.round(edge * step.scale));
    const out = await renderJpeg(sharp, input, target, step.quality);
    if (out === null) continue;
    if (out.base64.length <= LARGE_MAX_BASE64) {
      return {
        data: "data:image/jpeg;base64," + out.base64,
        mediaType: "image/jpeg",
        width: out.width,
        height: out.height,
        bytes: out.bytes,
      };
    }
  }
  throw new Error("image too large to fit the relay frame budget");
}

/**
 * maxEdge 归一化（契约 §5.1：缺省 1600、上限 4096）。
 * @param {unknown} value
 * @returns {number}
 */
export function clampMaxEdge(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return LARGE_DEFAULT_MAX_EDGE;
  const i = Math.round(n);
  if (i <= 0) return LARGE_DEFAULT_MAX_EDGE;
  return Math.min(LARGE_MAX_EDGE, i);
}
