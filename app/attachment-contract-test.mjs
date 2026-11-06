// 附件契约回归（契约 §5.11，v1.2.0）：node attachment-contract-test.mjs
//
// 两层：
//  1) 纯行为断言——直接 import model/attachment-plan.ts 与 model/timeline-reconcile.ts
//     （node 24 自带 TS type-stripping，无需编译）；
//  2) 接线断言——对 protocol/link/store/page/timeline 的关键字符串做 grep，
//     防止「纯函数测试绿了、生产路径没接上」的假回归（参考 session-detail-contract-test.mjs）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_COUNT,
  DEFAULT_MAX_ITEM_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_CHUNK_BYTES,
  attachmentFileName,
  checkAttachmentDraft,
  chunkCount,
  clampChunkBytes,
  formatAttachmentSize,
  isAcceptedImageType,
  normalizeAttachmentCaps,
  planChunks
} from './entry/src/main/ets/model/attachment-plan.ts';
import { collectCoveredLiveAttachmentIds } from './entry/src/main/ets/model/timeline-reconcile.ts';

const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// 1) 分块计划（契约 §5.11.2：index 从 0 连续递增，最后一块可短）
// ---------------------------------------------------------------------------

{
  assert.deepEqual(planChunks(0, 262144), [], '空附件没有分块');
  assert.deepEqual(planChunks(1, 262144), [1], '单字节也得分一块');
  assert.deepEqual(planChunks(262144, 262144), [262144], '正好一块');
  assert.deepEqual(planChunks(262145, 262144), [262144, 1], '最后一块可短');
  const size = 262144 * 3 + 7;
  const chunks = planChunks(size, 262144);
  assert.deepEqual(chunks, [262144, 262144, 262144, 7]);
  assert.equal(chunks.length, chunkCount(size, 262144), 'chunkCount 与 planChunks 必须一致');
  assert.equal(chunks.reduce((a, b) => a + b, 0), size, '分块长度之和必须等于原字节数');
}

{
  assert.equal(clampChunkBytes(undefined), DEFAULT_CHUNK_BYTES, '缺省块大小 = 256KiB');
  assert.equal(clampChunkBytes(0), DEFAULT_CHUNK_BYTES, '非法 chunkBytes 回缺省');
  assert.equal(clampChunkBytes(-1), DEFAULT_CHUNK_BYTES, '负数回缺省');
  assert.equal(clampChunkBytes(64 * 1024), 64 * 1024, '宿主给更小的值必须尊重');
  assert.equal(clampChunkBytes(MAX_CHUNK_BYTES), MAX_CHUNK_BYTES);
  assert.equal(clampChunkBytes(8 * MIB), MAX_CHUNK_BYTES,
    '客户端不得用超过 256KiB 的块（中继单帧 1MiB 硬约束）');
  assert.equal(MAX_CHUNK_BYTES, 256 * 1024);
}

// ---------------------------------------------------------------------------
// 2) URI 取文件名 / 字节数格式化
// ---------------------------------------------------------------------------

{
  assert.equal(attachmentFileName('file://media/Photo/3/IMG_0001.jpg'), 'IMG_0001.jpg',
    '图库 URI → 原始文件名');
  assert.equal(attachmentFileName('file://docs/storage/Users/currentUser/Documents/report%20v2.pdf'),
    'report v2.pdf', '文件 URI 必须 percent-decode');
  assert.equal(attachmentFileName('file://docs/storage/x/a.pdf?x=1#frag'), 'a.pdf',
    'query/fragment 不得进文件名');
  assert.equal(attachmentFileName('', 'fallback.txt'), 'fallback.txt', '空 URI 用兜底');
  assert.equal(attachmentFileName('file://docs/storage/x/'), 'attachment',
    '结尾斜杠（空 basename）回兜底');
  const longName = 'a'.repeat(300);
  assert.equal(attachmentFileName('file://docs/x/' + longName).length, 180,
    '超长文件名截断到 180（与插件净化上限一致）');
}

{
  assert.equal(formatAttachmentSize(0), '0 B');
  assert.equal(formatAttachmentSize(512), '512 B');
  assert.equal(formatAttachmentSize(1024), '1.0 KB');
  assert.equal(formatAttachmentSize(1536), '1.5 KB');
  assert.equal(formatAttachmentSize(12345), '12.1 KB');
  assert.equal(formatAttachmentSize(1048576), '1.0 MB');
  assert.equal(formatAttachmentSize(5 * MIB), '5.0 MB');
  assert.equal(formatAttachmentSize(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatAttachmentSize(-5), '0 B', '非法字节数兜底 0 B');
}

// ---------------------------------------------------------------------------
// 3) 能力目录规范化（契约 §5.11.1：缺省 = 不支持 → 隐藏附件入口）
// ---------------------------------------------------------------------------

{
  const off = normalizeAttachmentCaps(null);
  assert.equal(off.supported, false, '缺省 attachments → supported=false（隐藏入口）');
  assert.equal(off.maxCount, DEFAULT_MAX_COUNT);
  assert.equal(off.maxItemBytes, DEFAULT_MAX_ITEM_BYTES);
  assert.equal(off.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
  assert.equal(off.chunkBytes, DEFAULT_CHUNK_BYTES);
  assert.deepEqual(off.imageMediaTypes, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  const on = normalizeAttachmentCaps({
    supported: true,
    maxCount: 3,
    maxItemBytes: 1024,
    maxMessageBytes: 2048,
    chunkBytes: 4 * MIB,
    imageMediaTypes: ['image/jpeg']
  });
  assert.equal(on.supported, true);
  assert.equal(on.maxCount, 3);
  assert.equal(on.maxItemBytes, 1024);
  assert.equal(on.maxMessageBytes, 2048);
  assert.equal(on.chunkBytes, MAX_CHUNK_BYTES, '宿主 chunkBytes 超限也要夹到 256KiB');
  assert.deepEqual(on.imageMediaTypes, ['image/jpeg']);

  const partial = normalizeAttachmentCaps({ supported: true });
  assert.equal(partial.maxCount, DEFAULT_MAX_COUNT);
  assert.equal(partial.chunkBytes, DEFAULT_CHUNK_BYTES);
  assert.equal(partial.supported, true);
}

{
  assert.equal(isAcceptedImageType('image/jpeg', ['image/png', 'image/JPEG']), true,
    '媒体类型比较不区分大小写');
  assert.equal(isAcceptedImageType('image/heic', ['image/jpeg', 'image/png']), false,
    'HEIC 不在宿主目录内 → 必须先转码');
  assert.equal(isAcceptedImageType('', ['image/jpeg']), false);
}

// ---------------------------------------------------------------------------
// 4) 草稿上限校验（契约 §5.11.1：maxCount / maxItemBytes / maxMessageBytes）
// ---------------------------------------------------------------------------

{
  const caps = normalizeAttachmentCaps({ supported: true });
  const png = { kind: 'image', name: 'a.png', mediaType: 'image/png', bytes: 1024 };

  assert.equal(checkAttachmentDraft([], png, caps).ok, true);
  assert.equal(checkAttachmentDraft([], png, normalizeAttachmentCaps(null)).reason, 'unsupported');
  assert.equal(checkAttachmentDraft([], { kind: 'file', name: '', mediaType: '', bytes: 10 }, caps).reason,
    'bad-params', '文件必须有文件名');
  assert.equal(checkAttachmentDraft([], { kind: 'image', name: 'a.heic', mediaType: 'image/heic', bytes: 10 },
    caps).reason, 'bad-params', '宿主不接受的图片格式必须拒绝（转码在 ingest 层做）');
  assert.equal(checkAttachmentDraft([], { kind: 'file', name: 'a', mediaType: '', bytes: 0 }, caps).reason,
    'bad-params', '空附件拒绝');
  assert.equal(checkAttachmentDraft([], {
    kind: 'file', name: 'big.bin', mediaType: '',
    bytes: DEFAULT_MAX_ITEM_BYTES + 1
  }, caps).reason, 'too-large', '单项超 maxItemBytes 拒绝');
  const many = [];
  for (let i = 0; i < DEFAULT_MAX_COUNT; i++) {
    many.push({ kind: 'file', name: 'f' + i, mediaType: '', bytes: 1 });
  }
  assert.equal(checkAttachmentDraft(many, { kind: 'file', name: 'x', mediaType: '', bytes: 1 }, caps).reason,
    'too-many', '超过 maxCount 拒绝');
  const c = normalizeAttachmentCaps({ supported: true, maxMessageBytes: 1000 });
  assert.equal(checkAttachmentDraft([{ kind: 'file', name: 'a', mediaType: '', bytes: 600 }],
    { kind: 'file', name: 'b', mediaType: '', bytes: 600 }, c).reason,
    'message-too-large', '合计超 maxMessageBytes 拒绝');
  assert.match(checkAttachmentDraft([], {
    kind: 'file', name: 'big.bin', mediaType: '', bytes: DEFAULT_MAX_ITEM_BYTES + 1
  }, caps).message, /20\.0 MB/, '超限文案带可读大小');
}

// ---------------------------------------------------------------------------
// 5) 附件-only 乐观消息去重（契约 §5.11.4：宿主持久副本到达后摘掉本地副本）
// ---------------------------------------------------------------------------

{
  const durable = [{ role: 'user', text: '', imageCount: 1, fileCount: 1 }];
  const live = [
    { itemId: 'local1', role: 'user', text: '', imageCount: 1, fileCount: 1 },
    { itemId: 'local2', role: 'user', text: '', imageCount: 1, fileCount: 1 }
  ];
  assert.deepEqual([...collectCoveredLiveAttachmentIds(durable, live)], ['local1'],
    '一条 durable 只消费一条 live（同 role + 同附件数量，先到先配）');
}

{
  assert.equal(collectCoveredLiveAttachmentIds(
    [{ role: 'user', text: 'hello', imageCount: 1, fileCount: 0 }],
    [{ itemId: 'x', role: 'user', text: '', imageCount: 1, fileCount: 0 }]
  ).size, 0, '带正文的 durable 不走附件计数去重（交给文本对账）');

  assert.equal(collectCoveredLiveAttachmentIds(
    [{ role: 'assistant', text: '', imageCount: 1, fileCount: 0 }],
    [{ itemId: 'x', role: 'assistant', text: '', imageCount: 1, fileCount: 0 }]
  ).size, 0, 'assistant 交付物图片仍走 imagesCoveredByPage（按 imageId 精确匹配）');

  assert.equal(collectCoveredLiveAttachmentIds(
    [{ role: 'user', text: '', imageCount: 1, fileCount: 0 }],
    [{ itemId: 'x', role: 'user', text: '', imageCount: 2, fileCount: 0 }]
  ).size, 0, '附件数量不同不得误删');

  assert.deepEqual([...collectCoveredLiveAttachmentIds(
    [{ role: 'user', text: '', imageCount: 0, fileCount: 1 }],
    [{ itemId: 'a', role: 'user', text: '', imageCount: 1, fileCount: 0 },
      { itemId: 'b', role: 'user', text: '', imageCount: 0, fileCount: 1 }]
  )], ['b'], '文件-only 消息按 fileCount 配对');

  assert.equal(collectCoveredLiveAttachmentIds(
    [{ role: 'user', text: '', imageCount: 0, fileCount: 0 }],
    [{ itemId: 'x', role: 'user', text: '', imageCount: 0, fileCount: 0 }]
  ).size, 0, '没有附件的空消息不参与');
}

// ---------------------------------------------------------------------------
// 6) 接线断言（生产路径真接上了才算过）
// ---------------------------------------------------------------------------

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const protocol = read('./entry/src/main/ets/model/protocol.ets');
const link = read('./entry/src/main/ets/model/link.ets');
const store = read('./entry/src/main/ets/model/sessionstore.ets');
const attachments = read('./entry/src/main/ets/model/attachments.ets');
const page = read('./entry/src/main/ets/pages/SessionDetailPage.ets');
const timeline = read('./entry/src/main/ets/pages/TimelineView.ets');

// protocol：版本 + 四个请求 + 类型
assert.match(protocol, /CONTRACT_VERSION: string = 'v1\.2\.0'/);
assert.match(protocol, /MSG_UPLOAD_BEGIN: string = 'attachment\.upload\.begin'/);
assert.match(protocol, /MSG_UPLOAD_CHUNK: string = 'attachment\.upload\.chunk'/);
assert.match(protocol, /MSG_UPLOAD_COMMIT: string = 'attachment\.upload\.commit'/);
assert.match(protocol, /MSG_UPLOAD_ABORT: string = 'attachment\.upload\.abort'/);
assert.match(protocol, /attachments\?: DshrcAttachmentCaps;/, 'capabilities.attachments 可选（缺省不支持）');
assert.match(protocol, /files\?: DshrcFileRef\[\];/, 'ChatMessage.files 可选');
assert.match(protocol, /uploads\?: string\[\];/, 'session.prompt.uploads 可选');
assert.match(protocol, /export interface DshrcUploadedAttachment \{/);

// link：四个上传请求 + sessionPromptResult 的 uploads 可选参数（旧签名兼容）
assert.match(link, /attachmentUploadBegin\(sessionId: string, kind: string, name: string, mediaType: string,/);
assert.match(link, /attachmentUploadChunk\(uploadId: string, index: number, data: string\): Promise<number>/);
assert.match(link, /attachmentUploadCommit\(uploadId: string\): Promise<DshrcUploadedAttachment>/);
assert.match(link, /attachmentUploadAbort\(uploadId: string\): Promise<boolean>/);
assert.match(link, /sessionPromptResult\(sessionId: string, text: string, uploads\?: string\[\]\)/,
  'uploads 必须是可选参数（旧调用点不受影响）');
assert.match(link, /p\.uploads = uploads;/, '只有在有 uploads 时才带字段');
assert.match(link, /caps\.attachments = v\.attachments;/, 'capabilities.attachments 必须解析');

// store：能力目录 + 历史 files 映射 + 附件去重 + pushLocalUser 附件参数
assert.match(store, /@Trace attachmentCaps: DshrcAttachmentCaps \| null = null;/);
assert.match(store, /attachmentLimits\(\): AttachmentCaps \{/);
assert.match(store, /attachmentsSupported\(\): boolean \{/);
assert.match(store, /this\.attachmentCaps = caps\.attachments !== undefined \? caps\.attachments : null;/);
assert.match(store, /mi\.files = msg\.files !== undefined \? msg\.files : \[\];/, '历史 messages.files 必须映射');
assert.match(store, /dst\.files = src\.files;/, 'Repeat 复用旧实例时要搬运 files 字段');
assert.match(store, /collectCoveredLiveAttachmentIds\(durable, live\)/, '附件-only 去重必须接进 mergeHistory');
assert.match(store, /coveredAttachments = this\.coveredLiveAttachmentIds\(items, messages\);/);
assert.match(store, /pushLocalUser\(sid: string, text: string, images\?: DshrcImageRef\[\], files\?: DshrcFileRef\[\]\): void/);
assert.match(store, /isAttachmentOnly\(\): boolean \{/);

// attachments.ets：选择器 / 读字节 / 分块上传 / 本地 id
assert.match(attachments, /new photoAccessHelper\.PhotoViewPicker\(\)\.select\(options\)/);
assert.match(attachments, /new picker\.DocumentViewPicker\(context\)/);
assert.match(attachments, /fs\.openSync\(uri, fs\.OpenMode\.READ_ONLY\)/);
assert.match(attachments, /encodeToStringSync\(copy\)/, '标准 base64 编码');
assert.match(attachments, /planChunks\(total, chunkBytes\)/);
assert.match(attachments, /clampChunkBytes\(begun\.chunkBytes > 0/, '块大小以 caps.chunkBytes 为准并 clamp');
assert.match(attachments, /assertReadableSize\(size, caps, '文件'\);\s*\n\s*const payload: ArrayBuffer = readWholeFileSync/,
  '文件必须先按 size 校验再读字节（OOM 防线）');
assert.match(attachments, /assertReadableSize\(size, caps, '图片'\);\s*\n\s*original = readWholeFileSync/,
  '图片必须先按 size 校验再读字节（OOM 防线）');
assert.match(attachments, /READ_CHUNK_BYTES: number = 1024 \* 1024;/, '读盘用固定 1MiB 临时块');
assert.match(attachments, /HARD_MAX_READ_BYTES: number = 256 \* 1024 \* 1024;/, '读盘硬顶 256MiB');
assert.match(attachments, /if \(!canPassThrough\(mimeType, original\.byteLength, srcWidth, srcHeight, caps\)\)/,
  '图片直传/转码必须按宿主媒体类型与尺寸判断');
assert.match(attachments, /image\.PropertyKey\.ORIENTATION/, '必须读 EXIF 方向');
assert.match(attachments, /orientation === 6[\s\S]{0,120}return 90;/, 'ORIENTATION 6 → rotate 90');
assert.match(attachments, /double|双重旋转|真机待验证/, 'EXIF 双重旋转风险必须留注（真机待验证）');
assert.match(attachments, /if \(item\.uploadId\.length > 0\) \{[\s\S]{0,120}return item\.uploadId;/,
  '已 commit 的附件重试必须复用 uploadId（不重复上传）');
assert.match(attachments, /toImageRef\(\): DshrcImageRef \{[\s\S]{0,160}'local:' \+ this\.localId/);

// page：入口可见性 / 菜单 / 上传编排 / 进度 / 失败保留
assert.match(page, /private attachmentEntryVisible\(\): boolean \{[\s\S]{0,220}isSubagentView\(\)[\s\S]{0,120}attachmentsSupported\(\)/,
  'subagent 与 caps 不支持时必须隐藏附件入口');
assert.match(page, /bindMenu\(this\.plusMenuItems\(\)\)/);
assert.match(page, /value: '图片'[\s\S]{0,160}value: '文件'/, '菜单两项：图片 / 文件');
assert.match(page, /this\.attachmentChips\(\)/, 'chips 必须在输入区渲染');
assert.match(page, /private async uploadAllAttachments\(/, '附件必须串行上传');
assert.match(page, /await uploadDraftAttachment\(sid, item, caps,/, '上传走 begin→chunks→commit 编排');
assert.match(page, /dshrcLink\.sessionPromptResult\(sid, text, uploadIds\)/, '全部 commit 之后才带 uploads 发 prompt');
assert.ok(page.indexOf('this.uploadAllAttachments(sid, items, caps)') <
  page.indexOf('dshrcLink.sessionPromptResult(sid, text, uploadIds)'),
  '必须先上传成功再发 prompt');
assert.match(page, /正在上传附件 '/, '上传期间显示进度文案');
assert.match(page, /private canSend\(\): boolean \{[\s\S]{0,240}!this\.uploading[\s\S]{0,240}attachments\.length > 0/,
  'send 可用性：上传中 / 空内容 / 离线禁用，附件-only 可发');
assert.match(page, /\.enabled\(this\.canSend\(\)\)/, '发送按钮绑定 canSend()');
assert.match(page, /checkNewAttachment\(this\.attachments, item, caps\)/, '加入 chip 前必须过上限校验');
assert.match(page, /releaseAttachmentPayload\(/, '删除/发送后要释放本地字节');
assert.match(page, /if \(this\.sessionId === sid\) \{[\s\S]{0,200}this\.attachments = \[\];/,
  '异步完成只清本会话的草稿与附件');
assert.doesNotMatch(page, /ForEach\(/, 'V2：列表必须 Repeat，禁 ForEach');
assert.doesNotMatch(page, /\[文件\]/, 'App 不再为文件块写「[文件]」占位（附件由 files[] 渲染）');

// timeline：文件卡片 + 纯附件不画空气泡 + 本地图片不可点开大图
assert.match(timeline, /struct MessageFiles \{/);
assert.match(timeline, /sys\.symbol\.doc_plaintext_fill_1/);
assert.match(timeline, /formatAttachmentSize\(cell\.item\.file\.bytes\)/);
assert.match(timeline, /if \(this\.item\.files\.length > 0\) \{/);
assert.match(timeline, /MessageFiles\(\{ files: this\.item\.files, alignEnd: true, onCard: false \}\)/);
assert.ok((timeline.match(/this\.item\.text\.length > 0/g) ?? []).length >= 2,
  '纯附件消息（text 为空）不得画空气泡');
assert.match(timeline, /private isLocal\(\): boolean \{/, 'local: 图片不得进大图页（image.fetch 必失败）');
assert.doesNotMatch(timeline, /ForEach\(/);

console.log('attachment-contract-test: 6 behavior groups + wiring assertions passed');
