/*
 * Copyright (c) 2026 dukedsh.
 * 用户提示词附件（契约 §5.11，v1.2.0）：选择 → 读字节 → 图片归一化 → 缩略图 → 分块上传。
 *
 * 数据流（手机端只做用户选择与编码，落盘/归一化在宿主）：
 *   图片：photoAccessHelper.PhotoViewPicker → file://media/Photo/... URI
 *   文件：picker.DocumentViewPicker          → file://docs/... URI
 *   字节：fs.openSync(uri)（openSync 明确支持 URI）→ statSync(fd).size →
 *         顺序 readSync（不传 offset：data 从当前 filePointer 读到 buffer 起始）→ closeSync
 *   图片策略（契约 §5.11.2 + 宿主准入）：宿主接受且 ≤8MiB / ≤6400 万像素 / 宽高 ≤65535
 *         → **原字节直传**；否则转码（透明 → webp，否则 jpeg；长边 2048；quality 85；
 *         EXIF ORIENTATION 6/3/8 → createPixelMap rotate 90/180/270）。
 *   HEIC 等非宿主格式一律转码 JPEG（宿主 ImageMediaType 只有 png/jpeg/webp/gif）。
 *   缩略图：长边 240、JPEG q70 的 data URI（附件 chip 与乐观气泡共用，不额外拉图）。
 *   上传：begin → chunk（串行、标准 base64、每块 ≤ min(caps.chunkBytes, 256KiB)）→ commit；
 *         已 commit 的 uploadId 记在草稿上，prompt 失败重试**不重复上传**。
 *
 * 上限规则不在这里：统一走 attachment-plan.ts（纯函数，node 回归共用同一份行为）。
 * 契约要求不把附件字节/文件名写日志——本文件日志只出现 kind / 数量 / uploadId。
 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { logDshrc } from './logger';
import { DshrcFileRef, DshrcImageRef, DshrcUploadBegin, DshrcUploadedAttachment } from './protocol';
import { dshrcLink } from './link';
import {
  ATTACHMENT_KIND_FILE,
  ATTACHMENT_KIND_IMAGE,
  AttachmentCaps,
  AttachmentCheck,
  AttachmentDraftLike,
  attachmentFileName,
  checkAttachmentDraft,
  clampChunkBytes,
  formatAttachmentSize,
  isAcceptedImageType,
  planChunks
} from './attachment-plan';

const TAG: string = 'dshrc-attachments';

/**
 * 读盘硬顶（256MiB）：OOM 防线——无论宿主上限多少，超过这个尺寸一律**不读**直接拒绝。
 * 真正的业务上限是 caps.maxItemBytes（读盘前先按 stat.size 判一次，见 ingestImage/ingestFile）。
 */
const HARD_MAX_READ_BYTES: number = 256 * 1024 * 1024;
/** 读文件的临时块大小（固定 1MiB，避免按剩余长度反复申请大块）。 */
const READ_CHUNK_BYTES: number = 1024 * 1024;
/** 原字节直传的字节上限（超过则转码；宿主 maxItemBytes 仍由草稿校验兜底）。 */
const IMAGE_PASS_MAX_BYTES: number = 8 * 1024 * 1024;
/** 原字节直传的像素上限（宿主部署限制 6400 万像素）。 */
const IMAGE_PASS_MAX_PIXELS: number = 64000000;
/** 原字节直传的宽高上限（避免超大尺寸解码溢出）。 */
const IMAGE_PASS_MAX_EDGE: number = 65535;
/** 转码长边（与宿主归一化口径一致，控制单图体积）。 */
const TRANSCODE_LONG_EDGE: number = 2048;
/** 缩略图长边（chips/气泡展示足够）。 */
const THUMB_LONG_EDGE: number = 240;
/** 转码质量。 */
const TRANSCODE_QUALITY: number = 85;
const THUMB_QUALITY: number = 70;
/** 缩略图 data URI 前缀（JPEG 固定）。 */
const THUMB_PREFIX: string = 'data:image/jpeg;base64,';

/** 附件字节缓存：localId → 原始/转码后的 ArrayBuffer（上传成功后释放）。 */
const payloads: Map<string, ArrayBuffer> = new Map<string, ArrayBuffer>();
let localSeq: number = 0;

/**
 * 待发送附件（V2 状态：@ObservedV2 + @Trace，页面直接读即自动刷新）。
 * 只放**元数据 + 展示用缩略图**；原始字节放模块级 payloads，避免大对象进状态树。
 */
@ObservedV2
export class DraftAttachment {
  /** 本地唯一 id（乐观上屏的 imageId/fileId = 'local:' + localId）。 */
  @Trace localId: string = '';
  /** 'image' | 'file'（契约 §5.11 wire 取值）。 */
  @Trace kind: string = '';
  @Trace name: string = '';
  @Trace mediaType: string = '';
  /** 待上传字节数（图片转码后 / 文件原始长度；commit 后更新为宿主归一化值）。 */
  @Trace bytes: number = 0;
  @Trace width: number = 0;
  @Trace height: number = 0;
  /** 缩略图 data URI（仅图片；文件为空串）。 */
  @Trace thumb: string = '';
  /** commit 成功后的 uploadId（重试时复用，不重复上传）。 */
  @Trace uploadId: string = '';
  /** 上传进度 0~1（UI 展示）。 */
  @Trace progress: number = 0;
  @Trace uploading: boolean = false;

  isImage(): boolean {
    return this.kind === ATTACHMENT_KIND_IMAGE;
  }

  /** commit 回包写回：宿主归一化后的 name/mediaType/bytes/width/height。 */
  applyUploaded(att: DshrcUploadedAttachment): void {
    if (att.name !== undefined && att.name.length > 0) {
      this.name = att.name;
    }
    if (att.mediaType !== undefined && att.mediaType.length > 0) {
      this.mediaType = att.mediaType;
    }
    if (att.bytes > 0) {
      this.bytes = att.bytes;
    }
    if (att.width !== undefined && att.width > 0) {
      this.width = att.width;
    }
    if (att.height !== undefined && att.height > 0) {
      this.height = att.height;
    }
  }

  /** 转成乐观气泡用的图片引用（本地缩略图垫底，宿主持久副本到达后由历史替换）。 */
  toImageRef(): DshrcImageRef {
    const ref: DshrcImageRef = {
      imageId: 'local:' + this.localId,
      mediaType: this.mediaType,
      width: this.width,
      height: this.height,
      bytes: this.bytes,
      source: 'local',
      thumb: this.thumb
    };
    return ref;
  }

  /** 转成乐观气泡用的文件引用。 */
  toFileRef(): DshrcFileRef {
    const ref: DshrcFileRef = { fileId: 'local:' + this.localId, name: this.name, bytes: this.bytes };
    return ref;
  }
}

/** 选择结果：items 为成功读入的附件（可能 0 个），error 为需要 toast 的文案（空 = 用户取消/无错）。 */
export interface AttachmentPickResult {
  items: DraftAttachment[];
  error: string;
}

/** 取附件待上传字节（页面/上传编排用）。 */
export function attachmentPayload(localId: string): ArrayBuffer | null {
  const data: ArrayBuffer | undefined = payloads.get(localId);
  return data !== undefined ? data : null;
}

/** 释放附件字节（发送成功 / 删除 chip 时调用，避免大对象常驻）。 */
export function releaseAttachmentPayload(localId: string): void {
  payloads.delete(localId);
}

/** 错误对象 → 可展示文案。 */
function errorText(e: Object): string {
  const err: BusinessError = e as BusinessError;
  if (err !== null && err !== undefined && err.message !== undefined && err.message.length > 0) {
    return err.message;
  }
  return '未知错误';
}

/** 用户取消选择不算错误（picker 取消的 BusinessError message 通常带 cancel / 取消）。 */
function isUserCancel(e: Object): boolean {
  const text: string = errorText(e).toLowerCase();
  return text.indexOf('cancel') >= 0 || text.indexOf('取消') >= 0;
}

/** 生成下一个本地 id。 */
function nextLocalId(): string {
  localSeq = localSeq + 1;
  return localSeq.toString();
}

/** 顺序读满整个 fd（从当前 filePointer 起；不传 offset，避免 offset 语义歧义）。 */
function readWholeFileSync(fd: number, size: number): ArrayBuffer {
  const out: ArrayBuffer = new ArrayBuffer(size);
  const view: Uint8Array = new Uint8Array(out);
  const temp: ArrayBuffer = new ArrayBuffer(Math.min(READ_CHUNK_BYTES, size));
  let read: number = 0;
  while (read < size) {
    const remain: number = size - read;
    const want: number = remain > READ_CHUNK_BYTES ? READ_CHUNK_BYTES : remain;
    const n: number = fs.readSync(fd, temp, { length: want });
    if (n <= 0) {
      break;
    }
    view.set(new Uint8Array(temp, 0, n), read);
    read = read + n;
  }
  if (read !== size) {
    throw new Error('读取文件不完整');
  }
  return out;
}

/**
 * 读盘前置校验（OOM 防线，先于任何 read 调用）：
 *  - 超过读盘硬顶 256MiB → 直接拒绝（用户选错文件时不能先吃满内存）；
 *  - 超过宿主单项上限 caps.maxItemBytes → 拒绝并给可读文案；
 *  - 0 字节 → 拒绝。
 * 注意：图片这里按**原始字节**判 caps.maxItemBytes（保守策略）——
 * 只有 ≤ maxItemBytes 的原图才会被读入再决定直传/转码。好处是「选错大文件」不会
 * 先把内存吃满；代价是略大于 20MiB 的原图不会走转码（手机照片通常远小于该值）。
 */
function assertReadableSize(size: number, caps: AttachmentCaps, kindLabel: string): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(kindLabel + '为空');
  }
  if (size > HARD_MAX_READ_BYTES) {
    throw new Error(kindLabel + '过大（超过 256MiB 读取上限）');
  }
  if (size > caps.maxItemBytes) {
    throw new Error(kindLabel + '超过单个附件上限 ' + formatAttachmentSize(caps.maxItemBytes));
  }
}

/** 等比缩放到长边 ≤ longEdge（不放大）。 */
function scaledSize(width: number, height: number, longEdge: number): image.Size {
  const maxSide: number = width > height ? width : height;
  if (maxSide <= 0) {
    const one: image.Size = { width: 1, height: 1 };
    return one;
  }
  const scale: number = maxSide > longEdge ? longEdge / maxSide : 1;
  const size: image.Size = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
  return size;
}

/** EXIF Orientation → createPixelMap 的 rotate 角度（契约实现口径：6→90 / 3→180 / 8→270）。 */
function orientationRotate(orientation: number): number {
  if (orientation === 6) {
    return 90;
  }
  if (orientation === 3) {
    return 180;
  }
  if (orientation === 8) {
    return 270;
  }
  return 0;
}

/** 读 EXIF ORIENTATION（无该属性/读失败按 1 = 正常处理）。 */
async function readOrientation(source: image.ImageSource): Promise<number> {
  try {
    const value: string = await source.getImageProperty(image.PropertyKey.ORIENTATION);
    const n: number = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch (e) {
    return 1;
  }
}

/** ArrayBuffer 的一段 → 标准 base64（canonical；复制成独占 Uint8Array，避免后端读到底层 buffer）。 */
function base64Of(data: ArrayBuffer, offset: number, length: number): string {
  const copy: Uint8Array = new Uint8Array(length);
  copy.set(new Uint8Array(data, offset, length));
  try {
    return new util.Base64Helper().encodeToStringSync(copy);
  } catch (e) {
    return '';
  }
}

/** 原图是否可直接直传（宿主接受的格式 + 字节/像素/宽高都在安全范围内）。 */
function canPassThrough(mediaType: string, bytes: number, width: number, height: number,
  caps: AttachmentCaps): boolean {
  if (!isAcceptedImageType(mediaType, caps.imageMediaTypes)) {
    return false;
  }
  if (bytes > IMAGE_PASS_MAX_BYTES) {
    return false;
  }
  if (width <= 0 || height <= 0 || width > IMAGE_PASS_MAX_EDGE || height > IMAGE_PASS_MAX_EDGE) {
    return false;
  }
  if (width * height > IMAGE_PASS_MAX_PIXELS) {
    return false;
  }
  return true;
}

/** 缩略图 data URI（长边 240 JPEG q70）。 */
async function encodeThumbnail(source: image.ImageSource, width: number, height: number,
  rotate: number): Promise<string> {
  const desired: image.Size = scaledSize(width, height, THUMB_LONG_EDGE);
  const pixelMap: image.PixelMap = await source.createPixelMap({ desiredSize: desired, rotate: rotate });
  try {
    const packer: image.ImagePacker = image.createImagePacker();
    try {
      const option: image.PackingOption = { format: 'image/jpeg', quality: THUMB_QUALITY };
      const data: ArrayBuffer = await packer.packToData(pixelMap, option);
      return THUMB_PREFIX + base64Of(data, 0, data.byteLength);
    } finally {
      await packer.release();
    }
  } finally {
    await pixelMap.release();
  }
}

/** 转码结果。 */
interface EncodedImage {
  data: ArrayBuffer;
  mediaType: string;
  width: number;
  height: number;
}

/**
 * 转码图片：长边 2048；透明 → webp（宿主不接受时退回 jpeg），否则 jpeg q85。
 * 旋转按 EXIF 方向应用，输出宽高按旋转后的实际方向上报。
 */
async function transcodeImage(source: image.ImageSource, width: number, height: number,
  rotate: number, alphaType: image.AlphaType, caps: AttachmentCaps): Promise<EncodedImage> {
  const desired: image.Size = scaledSize(width, height, TRANSCODE_LONG_EDGE);
  const wantWebp: boolean = alphaType !== image.AlphaType.OPAQUE &&
    isAcceptedImageType('image/webp', caps.imageMediaTypes);
  const pixelMap: image.PixelMap = await source.createPixelMap({ desiredSize: desired, rotate: rotate });
  try {
    const packer: image.ImagePacker = image.createImagePacker();
    try {
      let format: string = wantWebp ? 'image/webp' : 'image/jpeg';
      let packed: ArrayBuffer | null = null;
      try {
        const option: image.PackingOption = { format: format, quality: TRANSCODE_QUALITY };
        packed = await packer.packToData(pixelMap, option);
      } catch (e) {
        if (!wantWebp) {
          throw e as Error;
        }
        // 设备不支持 webp 编码 → 退回 jpeg（透明区域会变黑，属可接受降级）
        format = 'image/jpeg';
        const fallback: image.PackingOption = { format: format, quality: TRANSCODE_QUALITY };
        packed = await packer.packToData(pixelMap, fallback);
      }
      if (packed === null || packed.byteLength === 0) {
        throw new Error('图片转码失败');
      }
      const swapped: boolean = rotate === 90 || rotate === 270;
      const encoded: EncodedImage = {
        data: packed,
        mediaType: format,
        width: swapped ? desired.height : desired.width,
        height: swapped ? desired.width : desired.height
      };
      return encoded;
    } finally {
      await packer.release();
    }
  } finally {
    await pixelMap.release();
  }
}

/** 把一张已选图片读成草稿（读字节 → 判断直传/转码 → 生成缩略图）。 */
async function ingestImage(uri: string, caps: AttachmentCaps): Promise<DraftAttachment> {
  const file: fs.File = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  let name: string = '';
  let original: ArrayBuffer;
  try {
    name = attachmentFileName(uri, file.name);
    if (name.trim().length === 0) {
      name = '图片'; // 宿主图片 name 可缺省；这里仍给非空兜底，避免空白 chip
    }
    const stat: fs.Stat = fs.statSync(file.fd);
    const size: number = Math.floor(stat.size);
    // OOM 防线：先判尺寸再读字节（选错大文件不允许先把内存吃满）
    assertReadableSize(size, caps, '图片');
    original = readWholeFileSync(file.fd, size);
  } finally {
    fs.closeSync(file);
  }
  const source: image.ImageSource = image.createImageSource(original);
  try {
    const info: image.ImageInfo = await source.getImageInfo();
    const srcWidth: number = info.size.width;
    const srcHeight: number = info.size.height;
    if (srcWidth <= 0 || srcHeight <= 0) {
      throw new Error('图片尺寸无效');
    }
    const mimeType: string = info.mimeType !== undefined ? info.mimeType : '';
    const orientation: number = await readOrientation(source);
    // ⚠️ 真机待验证点：createPixelMap 的 rotate 与 ImageSource 是否已自动应用
    // EXIF 方向，当前 SDK 文档没有明确口径（不同设备/解码器可能不一致）→ 存在
    // 「双重旋转」风险。这里缩略图与转码**共用同一个 rotate**，至少保证两者朝向一致；
    // 若真机上发现方向被转了两次，只需把 orientation 读值改成 0 即可（一处开关）。
    const rotate: number = orientationRotate(orientation);
    const thumb: string = await encodeThumbnail(source, srcWidth, srcHeight, rotate);
    let mediaType: string = mimeType;
    let payload: ArrayBuffer = original;
    let outWidth: number = srcWidth;
    let outHeight: number = srcHeight;
    if (!canPassThrough(mimeType, original.byteLength, srcWidth, srcHeight, caps)) {
      const encoded: EncodedImage =
        await transcodeImage(source, srcWidth, srcHeight, rotate, info.alphaType, caps);
      payload = encoded.data;
      mediaType = encoded.mediaType;
      outWidth = encoded.width;
      outHeight = encoded.height;
    }
    const item: DraftAttachment = new DraftAttachment();
    item.localId = nextLocalId();
    item.kind = ATTACHMENT_KIND_IMAGE;
    item.name = name;
    item.mediaType = mediaType;
    item.bytes = payload.byteLength;
    item.width = outWidth;
    item.height = outHeight;
    item.thumb = thumb;
    payloads.set(item.localId, payload);
    return item;
  } finally {
    try {
      await source.release();
    } catch (e) {
      // release 失败不影响结果（GC 兜底）
    }
  }
}

/** 把一个已选文件读成草稿（逐字节原样上传）。 */
function ingestFile(uri: string, caps: AttachmentCaps): DraftAttachment {
  const file: fs.File = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  try {
    let name: string = attachmentFileName(uri, file.name);
    if (name.trim().length === 0) {
      name = '附件'; // 契约 §5.11.1：kind='file' 时 name 必填——这里保证非空
    }
    const stat: fs.Stat = fs.statSync(file.fd);
    const size: number = Math.floor(stat.size);
    // OOM 防线：文件不做转码，超限在读字节前直接拒绝
    assertReadableSize(size, caps, '文件');
    const payload: ArrayBuffer = readWholeFileSync(file.fd, size);
    const item: DraftAttachment = new DraftAttachment();
    item.localId = nextLocalId();
    item.kind = ATTACHMENT_KIND_FILE;
    item.name = name;
    item.mediaType = '';
    item.bytes = payload.byteLength;
    payloads.set(item.localId, payload);
    return item;
  } finally {
    fs.closeSync(file);
  }
}

/**
 * 打开图片选择器（契约 §5.11：PhotoViewPicker，IMAGE_TYPE，maxSelectNumber = 剩余名额）。
 * 逐张读入；单张失败只记 error（其余继续），用户取消返回空 items + 空 error。
 */
export async function pickImages(context: common.Context, remaining: number,
  caps: AttachmentCaps): Promise<AttachmentPickResult> {
  const result: AttachmentPickResult = { items: [], error: '' };
  if (remaining <= 0) {
    result.error = '附件数量已达上限';
    return result;
  }
  const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  options.maxSelectNumber = remaining;
  let uris: string[] = [];
  try {
    const picked: photoAccessHelper.PhotoSelectResult =
      await new photoAccessHelper.PhotoViewPicker().select(options);
    uris = picked.photoUris;
  } catch (e) {
    if (!isUserCancel(e)) {
      result.error = '打开图库失败：' + errorText(e);
    }
    return result;
  }
  for (let i: number = 0; i < uris.length; i++) {
    try {
      result.items.push(await ingestImage(uris[i], caps));
    } catch (e) {
      result.error = '读取图片失败：' + errorText(e);
    }
  }
  return result;
}

/**
 * 打开文件选择器（契约 §5.11：DocumentViewPicker，maxSelectNumber = 剩余名额）。
 * 与图片不同，文件不做格式转换/转码，逐字节原样上传。
 */
export async function pickFiles(context: common.Context, remaining: number,
  caps: AttachmentCaps): Promise<AttachmentPickResult> {
  const result: AttachmentPickResult = { items: [], error: '' };
  if (remaining <= 0) {
    result.error = '附件数量已达上限';
    return result;
  }
  const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
  options.maxSelectNumber = remaining;
  let uris: string[] = [];
  try {
    const pickerInst: picker.DocumentViewPicker = new picker.DocumentViewPicker(context);
    uris = await pickerInst.select(options);
  } catch (e) {
    if (!isUserCancel(e)) {
      result.error = '打开文件选择器失败：' + errorText(e);
    }
    return result;
  }
  for (let i: number = 0; i < uris.length; i++) {
    try {
      result.items.push(ingestFile(uris[i], caps));
    } catch (e) {
      result.error = '读取文件失败：' + errorText(e);
    }
  }
  return result;
}

/**
 * 上传一个草稿附件（契约 §5.11.2）：begin → chunk×N（串行、标准 base64）→ commit。
 *
 * - 已有 uploadId（上次 commit 成功、prompt 失败后重试）→ 直接复用，**不重复上传**；
 * - 失败时对未提交的 uploadId 尽力 abort（释放插件内存缓冲），错误原样抛出；
 * - commit 成功把宿主归一化后的元数据写回草稿（名称/字节/尺寸以宿主为准）。
 */
export async function uploadDraftAttachment(sessionId: string, item: DraftAttachment,
  caps: AttachmentCaps, onProgress: (p: number) => void): Promise<string> {
  if (item.uploadId.length > 0) {
    return item.uploadId; // 已提交且未被 prompt 消费：直接复用（一次 commit 只允许一条 prompt）
  }
  const payload: ArrayBuffer | null = attachmentPayload(item.localId);
  if (payload === null || payload.byteLength <= 0) {
    throw new Error('附件数据已失效，请重新选择');
  }
  const total: number = payload.byteLength;
  let uploadId: string = '';
  let committed: boolean = false;
  try {
    const begun: DshrcUploadBegin = await dshrcLink.attachmentUploadBegin(
      sessionId, item.kind, item.name, item.mediaType, total);
    uploadId = begun.uploadId;
    const chunkBytes: number = clampChunkBytes(begun.chunkBytes > 0 ? begun.chunkBytes : caps.chunkBytes);
    const chunks: number[] = planChunks(total, chunkBytes);
    let offset: number = 0;
    for (let i: number = 0; i < chunks.length; i++) {
      const b64: string = base64Of(payload, offset, chunks[i]);
      if (b64.length === 0) {
        throw new Error('附件编码失败');
      }
      await dshrcLink.attachmentUploadChunk(uploadId, i, b64);
      offset = offset + chunks[i];
      onProgress(total > 0 ? offset / total : 1);
    }
    const uploaded: DshrcUploadedAttachment = await dshrcLink.attachmentUploadCommit(uploadId);
    committed = true;
    item.uploadId = uploadId;
    item.applyUploaded(uploaded);
    // 字节**先不释放**：prompt 失败（宿主拒绝/凭据过期）后重试还可能要用。
    // 页面在 prompt accepted 之后统一 releaseAttachmentPayload（见 dispatchAttachmentPrompt）。
    // 正常窗口只有 commit→prompt 的几秒；失败重试期间保留是有意为之。
    logDshrc(TAG, 'info', 'attachment committed: kind=' + item.kind + ' chunks=' +
      chunks.length.toString() + ' id=' + uploadId.substring(0, 8));
    return uploadId;
  } catch (e) {
    if (uploadId.length > 0 && !committed) {
      // 尽力释放插件侧未提交缓冲（契约 §5.11.2：已 commit 的不可撤回）
      dshrcLink.attachmentUploadAbort(uploadId).catch((err: Error): void => {
        logDshrc(TAG, 'info', 'attachment abort failed: ' + err.message);
      });
    }
    throw e as Error;
  }
}

/**
 * 本地草稿上限校验（契约 §5.11.1）。页面在「加入 chip 之前」调用：
 * 超限 toast 拒绝并不加入（existing 不变）。
 */
export function checkNewAttachment(existing: DraftAttachment[], incoming: DraftAttachment,
  caps: AttachmentCaps): AttachmentCheck {
  const drafts: AttachmentDraftLike[] = [];
  for (let i: number = 0; i < existing.length; i++) {
    const item: AttachmentDraftLike = {
      kind: existing[i].kind,
      name: existing[i].name,
      mediaType: existing[i].mediaType,
      bytes: existing[i].bytes
    };
    drafts.push(item);
  }
  const incomingLike: AttachmentDraftLike = {
    kind: incoming.kind,
    name: incoming.name,
    mediaType: incoming.mediaType,
    bytes: incoming.bytes
  };
  return checkAttachmentDraft(drafts, incomingLike, caps);
}
