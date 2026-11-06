// scripts/verify-attachments.mjs —— 用户提示词的附件（契约 §5.11，v1.2.0）回归。
//
// 覆盖：
//   1. 纯函数：能力目录 / 文件名净化 / canonical base64 / begin 校验 /
//      uploads 解析 / UploadedAttachment 映射 / 文件块映射（files[]）。
//   2. 上传登记表状态机：分块顺序/重复/超长、未收满 commit、abort 幂等、
//      并发上限、TTL 过期、宿主 commit 失败可重试、消费墓碑。
//   3. HostBridge 真接线：附件四请求 + session.prompt uploads（text/附件-only/
//      顺序/消费/错误透传）+ session.capabilities.attachments 有无降级 +
//      session.history 的 files[]。
//   4. 源码级接线断言（改坏即红）：不直接塞 attachment ref、成功后才 markConsumed、
//      日志不写文件名/字节。
//
// 运行：node scripts/verify-attachments.mjs（无第三方依赖）
import { readFileSync } from "node:fs";
import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_KIND_FILE,
  ATTACHMENT_KIND_IMAGE,
  ATTACHMENT_LIMITS,
  AttachmentWireError,
  MAX_PENDING_UPLOADS,
  UploadRegistry,
  attachmentCapabilities,
  chunkCountOf,
  decodeChunkData,
  fileBlocksOf,
  fileRefMeta,
  fileRefsOfContent,
  formatAttachmentBytes,
  isImageMediaType,
  parseUploadBegin,
  parseUploadIds,
  sanitizeAttachmentName,
  uploadedAttachmentOf,
} from "../lib/attachments.mjs";
import { HostBridge, mapHistoryMessages, messageText } from "../lib/host-bridge.mjs";

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log("ok: " + label);
  } else {
    fail++;
    console.log("FAIL: " + label + (detail ? " — " + detail : ""));
  }
};

/** 应抛出指定 code 的 AttachmentWireError。 */
function throwsAttachment(label, fn, code) {
  try {
    fn();
    check(label, false, "未抛错");
  } catch (e) {
    const ok = e instanceof AttachmentWireError && (code === undefined || e.code === code);
    check(label, ok, `${e?.name}:${e?.code}:${e?.message}`);
  }
}

// ===========================================================================
// 场景 1：纯函数 —— 能力目录与基础校验
// ===========================================================================
{
  const caps = attachmentCapabilities();
  check("capabilities.supported=true", caps.supported === true);
  check("capabilities 上限与契约一致", caps.maxCount === 9 && caps.maxItemBytes === 20 * 1024 * 1024 && caps.maxMessageBytes === 40 * 1024 * 1024 && caps.chunkBytes === 256 * 1024, JSON.stringify(caps));
  check("capabilities.imageMediaTypes 顺序与常量一致", JSON.stringify(caps.imageMediaTypes) === JSON.stringify(ATTACHMENT_IMAGE_TYPES), JSON.stringify(caps.imageMediaTypes));
  check("capabilities 每次返回新数组（不可被调用方污染常量）", (() => {
    const a = attachmentCapabilities();
    a.imageMediaTypes.push("image/heic");
    return attachmentCapabilities().imageMediaTypes.length === 4;
  })());

  check("isImageMediaType 接受四种宿主格式", ["image/png", "image/jpeg", "image/webp", "image/gif"].every((t) => isImageMediaType(t)));
  check("isImageMediaType 拒绝 heic/svg/空", !isImageMediaType("image/heic") && !isImageMediaType("image/svg+xml") && !isImageMediaType(""));

  check("sanitizeAttachmentName 去路径（Windows 反斜杠）", sanitizeAttachmentName("C:\\Users\\a\\b.png") === "b.png");
  check("sanitizeAttachmentName 去路径（POSIX 正斜杠）", sanitizeAttachmentName("/tmp/x/report.pdf") === "report.pdf");
  check("sanitizeAttachmentName 去控制字符", sanitizeAttachmentName("a\u0000b\u001fc.txt") === "abc.txt");
  check("sanitizeAttachmentName 空/非字符串为空串", sanitizeAttachmentName("") === "" && sanitizeAttachmentName(null) === "" && sanitizeAttachmentName(42) === "");
  check("sanitizeAttachmentName 限长 180", sanitizeAttachmentName("x".repeat(500)).length === 180);
  check("sanitizeAttachmentName 只留空格 → trim 后空", sanitizeAttachmentName("   ") === "");
}

// ===========================================================================
// 场景 2：纯函数 —— chunk base64 与分块计数
// ===========================================================================
{
  const plain = Buffer.from("hello attachment");
  const b64 = plain.toString("base64");
  check("decodeChunkData 正常解码", decodeChunkData(b64).equals(plain));
  throwsAttachment("decodeChunkData 拒绝非 canonical base64（尾部换行）", () => decodeChunkData(b64 + "\n"), "attachment-bad-params");
  throwsAttachment("decodeChunkData 拒绝空串", () => decodeChunkData(""), "attachment-chunk-mismatch");
  throwsAttachment("decodeChunkData 拒绝非字符串", () => decodeChunkData(123), "attachment-bad-params");
  throwsAttachment("decodeChunkData 拒绝超长块", () => decodeChunkData(Buffer.alloc(8).toString("base64"), 4), "attachment-chunk-mismatch");
  check("decodeChunkData 允许最后一小块", decodeChunkData(Buffer.from("abcd").toString("base64"), 8).length === 4);

  check("chunkCountOf 0 字节 = 0 块", chunkCountOf(0) === 0);
  check("chunkCountOf 1 字节 = 1 块", chunkCountOf(1) === 1);
  check("chunkCountOf 恰好一块", chunkCountOf(ATTACHMENT_LIMITS.chunkBytes) === 1);
  check("chunkCountOf 多一块", chunkCountOf(ATTACHMENT_LIMITS.chunkBytes + 1) === 2);
  check("chunkCountOf 非法输入回 0", chunkCountOf(-1) === 0 && chunkCountOf(1.5) === 0);
}

// ===========================================================================
// 场景 3：纯函数 —— begin / uploads / UploadedAttachment / 文件块
// ===========================================================================
{
  const img = parseUploadBegin({ sessionId: "s1", kind: "image", mediaType: "image/png", bytes: 10, name: "a.png" });
  check("parseUploadBegin 图片合法", img.kind === ATTACHMENT_KIND_IMAGE && img.mediaType === "image/png" && img.name === "a.png" && img.bytes === 10);
  const file = parseUploadBegin({ sessionId: "s1", kind: "file", name: "C:\\x\\a.pdf", bytes: 0 });
  check("parseUploadBegin 文件允许 0 字节且净化名字", file.kind === ATTACHMENT_KIND_FILE && file.name === "a.pdf" && file.bytes === 0);
  throwsAttachment("parseUploadBegin 缺 sessionId", () => parseUploadBegin({ kind: "file", name: "a", bytes: 1 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin 非法 kind", () => parseUploadBegin({ sessionId: "s", kind: "video", bytes: 1 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin 图片缺 mediaType", () => parseUploadBegin({ sessionId: "s", kind: "image", bytes: 1 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin 图片 0 字节", () => parseUploadBegin({ sessionId: "s", kind: "image", mediaType: "image/png", bytes: 0 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin 文件缺 name", () => parseUploadBegin({ sessionId: "s", kind: "file", bytes: 1 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin bytes 负数", () => parseUploadBegin({ sessionId: "s", kind: "file", name: "a", bytes: -1 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin bytes 非整数", () => parseUploadBegin({ sessionId: "s", kind: "file", name: "a", bytes: 1.5 }), "attachment-bad-params");
  throwsAttachment("parseUploadBegin 单附件超限", () => parseUploadBegin({ sessionId: "s", kind: "file", name: "a", bytes: ATTACHMENT_LIMITS.maxItemBytes + 1 }), "attachment-too-large");
  throwsAttachment("parseUploadBegin 不接受 image/heic", () => parseUploadBegin({ sessionId: "s", kind: "image", mediaType: "image/heic", bytes: 1 }), "attachment-bad-params");

  const ids = parseUploadIds(["a", "b", "a", "c"]);
  check("parseUploadIds 去重保序", JSON.stringify(ids) === JSON.stringify(["a", "b", "c"]), JSON.stringify(ids));
  check("parseUploadIds 缺省 = 空数组", parseUploadIds(undefined).length === 0 && parseUploadIds(null).length === 0);
  throwsAttachment("parseUploadIds 非数组", () => parseUploadIds("x"), "attachment-bad-params");
  throwsAttachment("parseUploadIds 超条数", () => parseUploadIds(Array.from({ length: 10 }, (_, i) => "u" + i)), "attachment-too-many");
  throwsAttachment("parseUploadIds 含空串", () => parseUploadIds(["a", ""]), "attachment-bad-params");

  const imgWire = uploadedAttachmentOf({
    kind: "image",
    mediaType: "image/png",
    requestedName: "请求名.png",
    bytes: 99,
    attachment: { attachmentId: "att", name: "存储名.png", mediaType: "image/jpeg", bytes: 42, width: 20, height: 10 },
  });
  check("uploadedAttachmentOf 图片取存储元数据", imgWire.kind === "image" && imgWire.name === "存储名.png" && imgWire.mediaType === "image/jpeg" && imgWire.bytes === 42 && imgWire.width === 20 && imgWire.height === 10, JSON.stringify(imgWire));
  const fileWire = uploadedAttachmentOf({
    kind: "file",
    requestedName: "报告.pdf",
    bytes: 7,
    attachment: { attachmentId: "sha256:x", name: "报告.pdf", bytes: 7 },
  });
  check("uploadedAttachmentOf 文件不带 mediaType/尺寸", fileWire.kind === "file" && fileWire.name === "报告.pdf" && fileWire.bytes === 7 && fileWire.mediaType === undefined && fileWire.width === undefined, JSON.stringify(fileWire));

  const blocks = [
    { type: "text", text: "hi" },
    { type: "file", attachment: { attachmentId: "sha256:f1", name: "a.txt", bytes: 3 } },
    { type: "file", attachment: { attachmentId: "", name: "bad", bytes: 1 } },
    { type: "file", attachment: { attachmentId: "sha256:f2", name: "", bytes: 1 } },
    { type: "file" },
    null,
    "x",
  ];
  check("fileBlocksOf 只收合法文件块", fileBlocksOf(blocks).length === 1, JSON.stringify(fileBlocksOf(blocks)));
  check("fileBlocksOf 非数组回空", fileBlocksOf(null).length === 0);
  const refs = fileRefsOfContent(blocks);
  check("fileRefsOfContent → FileRef{fileId,name,bytes}", refs.length === 1 && refs[0].fileId === "sha256:f1" && refs[0].name === "a.txt" && refs[0].bytes === 3, JSON.stringify(refs));
  check("fileRefMeta 非法返回 null", fileRefMeta({}) === null && fileRefMeta(null) === null);
  check("messageText 文件不占位（v1.2.0）", messageText(blocks) === "hi", messageText(blocks));
  check("formatAttachmentBytes 单位", formatAttachmentBytes(0) === "0 B" && formatAttachmentBytes(2048) === "2.0 KB" && formatAttachmentBytes(3 * 1024 * 1024) === "3.0 MB", formatAttachmentBytes(3 * 1024 * 1024));
}

// ===========================================================================
// 场景 4：UploadRegistry 状态机
// ===========================================================================
{
  let now = 1000;
  const limits = { ...ATTACHMENT_LIMITS, maxMessageBytes: 20, maxCount: 3, chunkBytes: 4 };
  const reg = new UploadRegistry({ now: () => now, limits, pendingTtlMs: 100, stagedTtlMs: 200, maxPending: 2 });
  const begun = reg.begin({ sessionId: "s1", kind: "file", name: "a.bin", bytes: 6 });
  check("begin 回 uploadId/chunkBytes", begun.uploadId.startsWith("up_") && begun.chunkBytes === 4, JSON.stringify(begun));

  throwsAttachment("chunk 跳号报错", () => reg.chunk({ uploadId: begun.uploadId, index: 1, data: Buffer.from("abcd").toString("base64") }), "attachment-chunk-mismatch");
  throwsAttachment("chunk 非 canonical 报错", () => reg.chunk({ uploadId: begun.uploadId, index: 0, data: "YWJjZA" }), "attachment-bad-params");
  const c1 = reg.chunk({ uploadId: begun.uploadId, index: 0, data: Buffer.from("abcd").toString("base64") });
  check("chunk 0 累计 4 字节", c1.received === 4, JSON.stringify(c1));
  throwsAttachment("chunk 超总长报错（块 4 字节 > 剩余 2）", () => reg.chunk({ uploadId: begun.uploadId, index: 1, data: Buffer.from("abcde").toString("base64") }), "attachment-chunk-mismatch");
  const c2 = reg.chunk({ uploadId: begun.uploadId, index: 1, data: Buffer.from("ef").toString("base64") });
  check("最后一块可短", c2.received === 6, JSON.stringify(c2));
  throwsAttachment("收满后再发 chunk 报错", () => reg.chunk({ uploadId: begun.uploadId, index: 2, data: Buffer.from("x").toString("base64") }), "attachment-chunk-mismatch");

  const commitRecord = reg.beginCommit(begun.uploadId);
  check("beginCommit 返回完整缓冲", commitRecord.received === 6 && commitRecord.chunks.length === 2);
  check("提交中的上传不可 abort（可能已落盘）", reg.abort(begun.uploadId) === false);
  throwsAttachment("committing 期间重复 chunk 报错", () => reg.chunk({ uploadId: begun.uploadId, index: 2, data: Buffer.from("y").toString("base64") }), "attachment-upload-consumed");
  reg.failCommit(begun.uploadId);
  const again = reg.beginCommit(begun.uploadId);
  check("failCommit 后可重新 commit", again.received === 6);
  const staged = reg.completeCommit(begun.uploadId, { receiptId: "rcpt-1", attachment: { attachmentId: "sha256:f", name: "a.bin", bytes: 6 } });
  check("completeCommit → staged", staged.state === "staged" && staged.receiptId === "rcpt-1");
  check("staged 不占未提交并发额度", reg.size === 1);

  throwsAttachment("promptUploads 会话不匹配", () => reg.promptUploads("s2", [begun.uploadId]), "attachment-upload-not-found");
  const stagedList = reg.promptUploads("s1", [begun.uploadId]);
  check("promptUploads 返回 receipt/字节", stagedList.length === 1 && stagedList[0].receiptId === "rcpt-1" && stagedList[0].bytes === 6, JSON.stringify(stagedList));
  check("promptUploads 不消费（可重试）", (() => {
    try {
      return reg.promptUploads("s1", [begun.uploadId]).length === 1;
    } catch {
      return false;
    }
  })());
  reg.markConsumed([begun.uploadId]);
  throwsAttachment("消费后复用报 attachment-upload-consumed", () => reg.promptUploads("s1", [begun.uploadId]), "attachment-upload-consumed");

  // 未收满 commit
  const partial = reg.begin({ sessionId: "s1", kind: "file", name: "p.bin", bytes: 5 });
  reg.chunk({ uploadId: partial.uploadId, index: 0, data: Buffer.from("ab").toString("base64") });
  throwsAttachment("未收满 commit 报 chunk-mismatch", () => reg.beginCommit(partial.uploadId), "attachment-chunk-mismatch");
  check("abort receiving 成功", reg.abort(partial.uploadId) === true);
  throwsAttachment("abort 后 chunk 报 not-found", () => reg.chunk({ uploadId: partial.uploadId, index: 1, data: "YQ==" }), "attachment-upload-not-found");
  check("abort 未知 uploadId 幂等 false", reg.abort("nope") === false);
  const stagedAbort = reg.begin({ sessionId: "s1", kind: "file", name: "q.bin", bytes: 1 });
  reg.chunk({ uploadId: stagedAbort.uploadId, index: 0, data: "YQ==" });
  reg.beginCommit(stagedAbort.uploadId);
  reg.completeCommit(stagedAbort.uploadId, { receiptId: "r2", attachment: { attachmentId: "f2", name: "q.bin", bytes: 1 } });
  check("已提交附件不可 abort（宿主不可删除）", reg.abort(stagedAbort.uploadId) === false);

  // 并发上限（maxPending=2）
  const r2 = new UploadRegistry({ now: () => now, limits, maxPending: 2 });
  r2.begin({ sessionId: "s", kind: "file", name: "1", bytes: 1 });
  const second = r2.begin({ sessionId: "s", kind: "file", name: "2", bytes: 1 });
  throwsAttachment("未提交并发上限", () => r2.begin({ sessionId: "s", kind: "file", name: "3", bytes: 1 }), "attachment-too-many");
  check("上限常量 = 4", MAX_PENDING_UPLOADS === 4);
  r2.abort(second.uploadId);
  check("abort 后释放并发额度", (() => {
    try {
      r2.begin({ sessionId: "s", kind: "file", name: "4", bytes: 1 });
      return true;
    } catch {
      return false;
    }
  })());

  // 总字节上限（maxMessageBytes=20；默认块大小，单块 12 字节合法）
  const total = new UploadRegistry({ now: () => now, limits: { ...ATTACHMENT_LIMITS, maxMessageBytes: 20 }, maxPending: 4 });
  const t1 = total.begin({ sessionId: "s", kind: "file", name: "t1", bytes: 12 });
  total.chunk({ uploadId: t1.uploadId, index: 0, data: Buffer.from("abcdefghijkl").toString("base64") });
  total.beginCommit(t1.uploadId);
  total.completeCommit(t1.uploadId, { receiptId: "r-t1", attachment: { attachmentId: "t1", name: "t1", bytes: 12 } });
  const t2 = total.begin({ sessionId: "s", kind: "file", name: "t2", bytes: 12 });
  total.chunk({ uploadId: t2.uploadId, index: 0, data: Buffer.from("abcdefghijkl").toString("base64") });
  total.beginCommit(t2.uploadId);
  total.completeCommit(t2.uploadId, { receiptId: "r-t2", attachment: { attachmentId: "t2", name: "t2", bytes: 12 } });
  throwsAttachment("单条消息附件总字节超限", () => total.promptUploads("s", [t1.uploadId, t2.uploadId]), "attachment-too-large");

  // TTL
  let clock = 5000;
  const ttl = new UploadRegistry({ now: () => clock, limits, pendingTtlMs: 100, stagedTtlMs: 200 });
  const exp = ttl.begin({ sessionId: "s", kind: "file", name: "e", bytes: 1 });
  clock += 101;
  throwsAttachment("未提交上传 5 分钟 TTL 过期（可注入时钟）", () => ttl.chunk({ uploadId: exp.uploadId, index: 0, data: "YQ==" }), "attachment-upload-not-found");
  const exp2 = ttl.begin({ sessionId: "s", kind: "file", name: "e2", bytes: 1 });
  ttl.chunk({ uploadId: exp2.uploadId, index: 0, data: "YQ==" });
  ttl.beginCommit(exp2.uploadId);
  ttl.completeCommit(exp2.uploadId, { receiptId: "r3", attachment: { attachmentId: "e2", name: "e2", bytes: 1 } });
  clock += 201;
  throwsAttachment("已提交附件 60 分钟 TTL 过期", () => ttl.promptUploads("s", [exp2.uploadId]), "attachment-upload-not-found");

  // completeCommit 缺 receipt → 失败且可重试
  const noReceipt = new UploadRegistry({ now: () => now, limits });
  const nr = noReceipt.begin({ sessionId: "s", kind: "file", name: "n", bytes: 1 });
  noReceipt.chunk({ uploadId: nr.uploadId, index: 0, data: "YQ==" });
  noReceipt.beginCommit(nr.uploadId);
  throwsAttachment("completeCommit 缺 receipt 报 upload-failed", () => noReceipt.completeCommit(nr.uploadId, {}), "attachment-upload-failed");
  check("缺 receipt 失败后退回 receiving（可重试）", (() => {
    try {
      noReceipt.beginCommit(nr.uploadId);
      return true;
    } catch {
      return false;
    }
  })());
}

// ===========================================================================
// 场景 5：HostBridge 真接线 —— 上传 + prompt
// ===========================================================================
const CFG = {
  enabled: true,
  interceptApprovals: false,
  interceptQuestions: false,
  approvalTimeoutMs: 1000,
  push: { notifyTurnEnd: false },
};
const logs = [];
const log = (level, message, extra) => {
  logs.push(level + " " + message + (extra ? " " + JSON.stringify(extra) : ""));
};

function makeCtx(services = {}) {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => this.off(name, fn);
    },
    off(name, fn) {
      const arr = handlers.get(name) ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(name, ...args) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
    get(name) {
      if (!Object.hasOwn(services, name)) throw new Error("service not found: " + name);
      return services[name];
    },
  };
}

function makeRelay() {
  const sent = [];
  return {
    sent,
    clientOnline: true,
    ready: true,
    send(message) {
      sent.push(message);
      return true;
    },
  };
}

function lastResult(sent, id) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m.type === "result" && m.payload?.id === id) {
      return m.payload.ok ? { value: m.payload.value } : { error: m.payload.error };
    }
  }
  return null;
}

async function collectBytes(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

{
  const relay = makeRelay();
  const prompts = [];
  const uploadImageCalls = [];
  const uploadFileCalls = [];
  let promptError = null;
  const sessionController = {
    async prompt(req) {
      prompts.push(req);
      if (promptError !== null) {
        const e = new Error(promptError.message);
        e.code = promptError.code;
        throw e;
      }
      return { accepted: true };
    },
  };
  const fileUploads = {
    async uploadImageStream(req) {
      const bytes = await collectBytes(req.data);
      uploadImageCalls.push({ mediaType: req.mediaType, name: req.name, bytes });
      return {
        receiptId: "rcpt-img-1",
        image: { attachmentId: "sha256:img", mediaType: "image/jpeg", bytes: bytes.length, width: 4, height: 3, name: req.name },
      };
    },
    async uploadStream(req) {
      const bytes = await collectBytes(req.data);
      uploadFileCalls.push({ name: req.name, bytes });
      return {
        receiptId: "rcpt-file-1",
        file: { attachmentId: "sha256:file", name: req.name ?? "file", bytes: bytes.length },
      };
    },
  };
  const ctx = makeCtx({ sessionController, fileUploads, attachments: {} });
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  // capabilities 声明附件能力
  await bridge.dispatch({ id: "cap-1", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "cap-1");
  check("capabilities 带 attachments", caps?.value?.attachments?.supported === true, JSON.stringify(caps?.value?.attachments));
  check("capabilities.attachments.chunkBytes=262144", caps?.value?.attachments?.chunkBytes === 262144);

  // ---- 图片上传 ----
  const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  await bridge.dispatch({
    id: "begin-img",
    type: "attachment.upload.begin",
    ts: Date.now(),
    payload: { sessionId: "sess-1", kind: "image", name: "cat.png", mediaType: "image/png", bytes: imgBytes.length },
  });
  const begun = lastResult(relay.sent, "begin-img");
  check("begin 图片 ok", typeof begun?.value?.uploadId === "string" && begun.value.chunkBytes === 262144, JSON.stringify(begun));
  const imgUploadId = begun.value.uploadId;
  const half = Math.ceil(imgBytes.length / 2);
  await bridge.dispatch({ id: "chunk-img-0", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: imgUploadId, index: 0, data: imgBytes.subarray(0, half).toString("base64") } });
  check("chunk 0 回 received", lastResult(relay.sent, "chunk-img-0")?.value?.received === half, JSON.stringify(lastResult(relay.sent, "chunk-img-0")));
  await bridge.dispatch({ id: "chunk-img-1", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: imgUploadId, index: 1, data: imgBytes.subarray(half).toString("base64") } });
  check("chunk 1 累计收满", lastResult(relay.sent, "chunk-img-1")?.value?.received === imgBytes.length);
  await bridge.dispatch({ id: "commit-img", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: imgUploadId } });
  const imgCommit = lastResult(relay.sent, "commit-img");
  check("commit 图片回 UploadedAttachment", imgCommit?.value?.attachment?.kind === "image" && imgCommit.value.attachment.mediaType === "image/jpeg" && imgCommit.value.attachment.width === 4 && imgCommit.value.attachment.height === 3 && imgCommit.value.attachment.bytes === imgBytes.length, JSON.stringify(imgCommit));
  check("宿主 uploadImageStream 收到完整字节", uploadImageCalls.length === 1 && uploadImageCalls[0].bytes.equals(imgBytes) && uploadImageCalls[0].mediaType === "image/png", JSON.stringify(uploadImageCalls.map((c) => c.bytes.length)));
  check("宿主收到显示名", uploadImageCalls[0].name === "cat.png");

  // ---- 文件上传（0 字节 + 非 0 字节各一）----
  const fileBytes = Buffer.from("report-body");
  await bridge.dispatch({ id: "begin-file", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "报告.pdf", bytes: fileBytes.length } });
  const beganFile = lastResult(relay.sent, "begin-file");
  const fileUploadId = beganFile.value.uploadId;
  await bridge.dispatch({ id: "chunk-file", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: fileUploadId, index: 0, data: fileBytes.toString("base64") } });
  await bridge.dispatch({ id: "commit-file", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: fileUploadId } });
  const fileCommit = lastResult(relay.sent, "commit-file");
  check("commit 文件回 kind/name/bytes", fileCommit?.value?.attachment?.kind === "file" && fileCommit.value.attachment.name === "报告.pdf" && fileCommit.value.attachment.bytes === fileBytes.length, JSON.stringify(fileCommit));
  check("宿主 uploadStream 收到完整字节与名字", uploadFileCalls.length === 1 && uploadFileCalls[0].bytes.equals(fileBytes));

  await bridge.dispatch({ id: "begin-empty", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "empty.txt", bytes: 0 } });
  const emptyId = lastResult(relay.sent, "begin-empty").value.uploadId;
  await bridge.dispatch({ id: "commit-empty", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: emptyId } });
  check("0 字节文件可直接 commit", lastResult(relay.sent, "commit-empty")?.value?.attachment?.bytes === 0, JSON.stringify(lastResult(relay.sent, "commit-empty")));
  check("0 字节文件宿主收到空字节流", uploadFileCalls.length === 2 && uploadFileCalls[1].bytes.length === 0, JSON.stringify(uploadFileCalls.map((c) => c.bytes.length)));

  // ---- prompt 带图片 + 文件 ----
  await bridge.dispatch({ id: "prompt-1", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "看看这两个", uploads: [imgUploadId, fileUploadId] } });
  const promptRes = lastResult(relay.sent, "prompt-1");
  check("prompt 带附件 accepted", promptRes?.value?.accepted === true, JSON.stringify(promptRes));
  const req = prompts[prompts.length - 1];
  check("prompt content 首块是正文", req.content[0]?.type === "text" && req.content[0]?.text === "看看这两个", JSON.stringify(req.content));
  check("prompt content 附件走 file receipt", req.content[1]?.type === "file" && req.content[1]?.receiptId === "rcpt-img-1" && req.content[2]?.type === "file" && req.content[2]?.receiptId === "rcpt-file-1", JSON.stringify(req.content));
  check("prompt 不传客户端 mode（由宿主设置决定）", req.mode === "queue" || req.mode === "steer");

  // 宿主返回 accepted:false（未真正接受）→ 不消费，可重试
  await bridge.dispatch({ id: "begin-notacc", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "na.txt", bytes: 2 } });
  const notAccId = lastResult(relay.sent, "begin-notacc").value.uploadId;
  await bridge.dispatch({ id: "chunk-notacc", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: notAccId, index: 0, data: Buffer.from("na").toString("base64") } });
  await bridge.dispatch({ id: "commit-notacc", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: notAccId } });
  const savedPrompt = sessionController.prompt;
  sessionController.prompt = async (req) => {
    prompts.push(req);
    return { accepted: false };
  };
  await bridge.dispatch({ id: "prompt-notacc", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "x", uploads: [notAccId] } });
  check("宿主 accepted:false → 回 accepted:false 且不消费", lastResult(relay.sent, "prompt-notacc")?.value?.accepted === false, JSON.stringify(lastResult(relay.sent, "prompt-notacc")));
  sessionController.prompt = savedPrompt;
  await bridge.dispatch({ id: "prompt-notacc-retry", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "x", uploads: [notAccId] } });
  check("accepted:false 后同一 uploadId 可重试", lastResult(relay.sent, "prompt-notacc-retry")?.value?.accepted === true, JSON.stringify(lastResult(relay.sent, "prompt-notacc-retry")));

  // 附件-only（无正文）：再传一个文件，单独发送
  const onlyBytes = Buffer.from("only");
  await bridge.dispatch({ id: "begin-only", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "only.txt", bytes: onlyBytes.length } });
  const onlyId = lastResult(relay.sent, "begin-only").value.uploadId;
  await bridge.dispatch({ id: "chunk-only", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: onlyId, index: 0, data: onlyBytes.toString("base64") } });
  await bridge.dispatch({ id: "commit-only", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: onlyId } });
  await bridge.dispatch({ id: "prompt-2", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "", uploads: [onlyId] } });
  check("附件可单独发送（text 空，uploads 非空）", lastResult(relay.sent, "prompt-2")?.value?.accepted === true, JSON.stringify(lastResult(relay.sent, "prompt-2")));
  const req2 = prompts[prompts.length - 1];
  check("附件-only content 不含 text 块", req2.content.length === 1 && req2.content[0].type === "file", JSON.stringify(req2.content));

  // 同一 uploadId 被消费后不能再用
  await bridge.dispatch({ id: "prompt-3", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "again", uploads: [fileUploadId] } });
  check("消费后的 uploadId 复用报 attachment-upload-consumed", lastResult(relay.sent, "prompt-3")?.error?.code === "attachment-upload-consumed", JSON.stringify(lastResult(relay.sent, "prompt-3")));

  // 未知 uploadId
  await bridge.dispatch({ id: "prompt-4", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "x", uploads: ["up_doesnotexist"] } });
  check("未知 uploadId 报 attachment-upload-not-found", lastResult(relay.sent, "prompt-4")?.error?.code === "attachment-upload-not-found", JSON.stringify(lastResult(relay.sent, "prompt-4")));

  // text 与 uploads 同时为空
  await bridge.dispatch({ id: "prompt-5", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "  " } });
  check("text/uploads 同时为空报 bad-params", lastResult(relay.sent, "prompt-5")?.error?.code === "bad-params", JSON.stringify(lastResult(relay.sent, "prompt-5")));

  // 宿主拒绝后 uploadId 仍可重试（receipt 未被消费）
  const retryBytes = Buffer.from("retry");
  await bridge.dispatch({ id: "begin-retry", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "retry.txt", bytes: retryBytes.length } });
  const retryId = lastResult(relay.sent, "begin-retry").value.uploadId;
  await bridge.dispatch({ id: "chunk-retry", type: "attachment.upload.chunk", ts: Date.now(), payload: { uploadId: retryId, index: 0, data: retryBytes.toString("base64") } });
  await bridge.dispatch({ id: "commit-retry", type: "attachment.upload.commit", ts: Date.now(), payload: { uploadId: retryId } });
  promptError = { code: "session/attachment-invalid", message: "Model does not support image input." };
  await bridge.dispatch({ id: "prompt-reject", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "retry", uploads: [retryId] } });
  const rejected = lastResult(relay.sent, "prompt-reject");
  check("宿主错误码原样透传", rejected?.error?.code === "session/attachment-invalid" && rejected.error.message.includes("does not support"), JSON.stringify(rejected));
  promptError = null;
  await bridge.dispatch({ id: "prompt-retry", type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-1", text: "retry", uploads: [retryId] } });
  check("宿主拒绝后同一 uploadId 可重试", lastResult(relay.sent, "prompt-retry")?.value?.accepted === true, JSON.stringify(lastResult(relay.sent, "prompt-retry")));

  // abort
  await bridge.dispatch({ id: "begin-abort", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "sess-1", kind: "file", name: "abort.txt", bytes: 3 } });
  const abortId = lastResult(relay.sent, "begin-abort").value.uploadId;
  await bridge.dispatch({ id: "abort-1", type: "attachment.upload.abort", ts: Date.now(), payload: { uploadId: abortId } });
  check("abort 未提交上传回 aborted:true", lastResult(relay.sent, "abort-1")?.value?.aborted === true, JSON.stringify(lastResult(relay.sent, "abort-1")));
  await bridge.dispatch({ id: "abort-2", type: "attachment.upload.abort", ts: Date.now(), payload: { uploadId: abortId } });
  check("abort 幂等 false", lastResult(relay.sent, "abort-2")?.value?.aborted === false);

  // 日志不得出现文件名/字节内容
  check("日志不写附件名", !logs.some((line) => line.includes("cat.png") || line.includes("报告.pdf") || line.includes("retry.txt")));
  check("日志不写 base64 内容", !logs.some((line) => line.includes(imgBytes.toString("base64"))));

  bridge.dispose();
}

// ===========================================================================
// 场景 6：无附件服务时 capabilities 省略 attachments + 请求降级
// ===========================================================================
{
  const relay = makeRelay();
  const ctx = makeCtx({ sessionController: { async prompt() { return { accepted: true }; } } });
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();
  await bridge.dispatch({ id: "cap-2", type: "session.capabilities", ts: Date.now(), payload: {} });
  const caps = lastResult(relay.sent, "cap-2");
  check("旧宿主无附件服务 → capabilities 不带 attachments", caps?.value !== undefined && caps.value.attachments === undefined, JSON.stringify(caps?.value));
  await bridge.dispatch({ id: "begin-no-svc", type: "attachment.upload.begin", ts: Date.now(), payload: { sessionId: "s", kind: "file", name: "a", bytes: 1 } });
  check("无附件服务 begin 回 attachment-unsupported", lastResult(relay.sent, "begin-no-svc")?.error?.code === "attachment-unsupported", JSON.stringify(lastResult(relay.sent, "begin-no-svc")));
  bridge.dispose();
}

// ===========================================================================
// 场景 7：会话历史里的用户消息附件（images + files 并存）
// ===========================================================================
{
  const relay = makeRelay();
  const record = {
    event: {
      type: "user/message",
      seq: 7,
      time: 1760000000000,
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [
          { type: "text", text: "" },
          {
            type: "image",
            attachment: { attachmentId: "att-user-1", mediaType: "image/png", bytes: 120, width: 8, height: 6 },
          },
          { type: "file", attachment: { attachmentId: "sha256:file-1", name: "notes.md", bytes: 321 } },
        ],
      },
    },
  };
  const messages = mapHistoryMessages("sess-u", record);
  check("用户附件消息成条（正文为空）", messages.length === 1 && messages[0].role === "user", JSON.stringify(messages));
  check("用户消息 images 映射", messages[0]?.images?.length === 1 && messages[0].images[0].imageId === "att-user-1", JSON.stringify(messages[0]?.images));
  check("用户消息 files 映射", messages[0]?.files?.length === 1 && messages[0].files[0].fileId === "sha256:file-1" && messages[0].files[0].name === "notes.md" && messages[0].files[0].bytes === 321, JSON.stringify(messages[0]?.files));
  check("用户消息正文不含占位符", messages[0]?.text === "", messages[0]?.text);

  const ctx = makeCtx({
    sessionController: {
      async list() {
        return { items: [] };
      },
      async events() {
        return { records: [record], hasMore: false };
      },
    },
    attachments: {},
  });
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();
  await bridge.dispatch({ id: "hist-user", type: "session.history", ts: Date.now(), payload: { sessionId: "sess-u" } });
  const hist = lastResult(relay.sent, "hist-user");
  const msg = hist?.value?.messages?.find((m) => m.seq === 7);
  check("session.history 回用户附件消息", msg !== undefined && msg.files?.length === 1 && msg.images?.length === 1, JSON.stringify(hist?.value?.messages));
  check("history 正文不含占位符", msg?.text === "", msg?.text);
  bridge.dispose();
}

// ===========================================================================
// 场景 7b：subagent 输入不接收附件（契约 §5.11.1）
// ===========================================================================
{
  const relay = makeRelay();
  const ctx = makeCtx({
    sessionController: { async prompt() { return { accepted: true }; } },
    subagents: {
      async prompt() {
        throw new Error("should not be called");
      },
    },
    attachments: {},
    fileUploads: { async uploadImageStream() {}, async uploadStream() {} },
  });
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();
  await bridge.dispatch({
    id: "subagent-attach",
    type: "session.subagentPrompt",
    ts: Date.now(),
    payload: { parentSessionId: "p", childSessionId: "c", text: "hi", uploads: ["up_x"] },
  });
  check("subagent prompt 带附件被拒（attachment-unsupported）", lastResult(relay.sent, "subagent-attach")?.error?.code === "attachment-unsupported", JSON.stringify(lastResult(relay.sent, "subagent-attach")));
  bridge.dispose();
}

// ===========================================================================
// 场景 8：源码级接线断言（改坏即红）
// ===========================================================================
{
  const src = readFileSync(new URL("../lib/host-bridge.mjs", import.meta.url), "utf8");
  check("接线：import 附件模块", /from "\.\/attachments\.mjs"/.test(src));
  check("接线：HostBridge 持有 UploadRegistry", /#uploads = new UploadRegistry\(\)/.test(src));
  check("接线：dispatch 有 4 个附件请求", ["attachment.upload.begin", "attachment.upload.chunk", "attachment.upload.commit", "attachment.upload.abort"].every((t) => src.includes(`case "${t}"`)));
  check("接线：commit 走宿主 uploadImageStream", /uploadImageStream\(\{/.test(src));
  check("接线：commit 走宿主 uploadStream", /uploadStream\(\{/.test(src));
  check("接线：不直接调用 attachments.saveFile（必须经 fileUploads receipt）", !/attachments\.saveFile\(/.test(src));
  check("接线：prompt 把附件换 receipt 后再调宿主", /receiptId: item\.receiptId/.test(src) && /this\.#sc\(\)\.prompt\(/.test(src));
  check("接线：prompt 成功后 markConsumed", /this\.#uploads\.markConsumed\(uploadIds\);/.test(src));
  check("接线：prompt 最终失败分支不 markConsumed（只有成功/steer 回退成功才消费）", (() => {
    const marker = 'this.#log("warn", "prompt failed", { sessionId, mode, code: err.code });';
    const at = src.indexOf(marker);
    if (at < 0) return false;
    const tail = src.slice(at, src.indexOf("// ---- v1.2.0（§5.11）：附件分块上传", at));
    return tail.length > 0 && !tail.includes("markConsumed");
  })());
  check("接线：capabilities 只在宿主就绪时声明 attachments", /if \(this\.#attachmentHostReady\(\)\) capabilities\.attachments = attachmentCapabilities\(\);/.test(src));
  check("接线：mapHistoryMessages 产出 files", /fileRefsOfContent\(content\)/.test(src) && /message\.files = files/.test(src));
  check("接线：messageText 不再写 [文件] 占位", (() => {
    const start = src.indexOf("export function messageText(");
    const end = src.indexOf("export function queueItemText(", start);
    const body = src.slice(start, end);
    return start > 0 && end > start && !body.includes("[文件]") && !body.includes("[图片]");
  })());
  check("接线：历史里的用户图片共享 image.fetch 登记（#rememberImages(mapped.images)）", /this\.#rememberImages\(mapped\.images\);/.test(src));
  check("接线：附件校验失败不吞错误（replyAttachmentError）", /#replyAttachmentError\(m, e\)/.test(src));
}

console.log("");
console.log(`verify-attachments: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
