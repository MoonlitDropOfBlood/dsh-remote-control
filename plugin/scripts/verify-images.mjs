// scripts/verify-images.mjs —— v1.0.9 会话消息里的图片自检（dev-only，无外部依赖）。
//
// 契约 §5.10「会话消息里的图片（缩略图内联 + 大图按需拉取）」+ §5.1 `image.fetch`。
//
// 覆盖三块：
//   1. **纯函数层**（mapHistoryMessages / messageText / imageRefMeta …）：
//      历史消息只产**元数据**（images[] 里 thumb 留空），正文里**不出现** "[图片]" 占位符；
//      纯图片消息（无正文）也要成条，否则手机端永远看不到这张图。
//   2. **缩略图补齐层**（attachThumbs）：拿到 ctx 后才读附件字节 + 压缩；
//      读不到 / sharp 不可用 / 压不进 96KB → 优雅降级（thumb 留空），绝不抛。
//   3. **大图拉取层**（image.fetch）：按 (imageId, maxEdge) 缓存、插件重启后缓存为空时
//      回明确中文错误（不崩）、日志里**绝不**出现 data URI / base64。
//
// 用法：node scripts/verify-images.mjs（在 plugin/ 目录下）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostBridge,
  attachThumbs,
  contentText,
  mapHistoryMessages,
  messageText,
} from "../lib/host-bridge.mjs";
import {
  IMAGE_MEDIA_TYPES,
  LARGE_DEFAULT_MAX_EDGE,
  LARGE_MAX_BASE64,
  LARGE_MAX_EDGE,
  REPLY_PLAIN_MAX_BYTES,
  RELAY_MAX_FRAME_BYTES,
  THUMB_MAX_BASE64,
  THUMB_PAGE_BUDGET,
  attachmentRefOf,
  clampMaxEdge,
  fitReplyBudget,
  imageBlocksOf,
  imageMetaOf,
  imageRefMeta,
  loadSharp,
  makeLarge,
  makeThumb,
  mediaTypeOfPath,
  setSharpResolver,
} from "../lib/images.mjs";

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

// ---------------------------------------------------------------------------
// 桩：假 ctx / 假 relay / 假附件服务 / 假 sharp
// ---------------------------------------------------------------------------

/** 假 ctx：事件总线 + 服务表（ctx.get 对缺失服务抛，模拟宿主行为）。 */
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

/** 假 relay：记录发出去的信封。 */
function makeRelay() {
  const sent = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return true;
    },
  };
}

/** 日志收集（用于检查"日志里没有 base64"）。 */
const logs = [];
const log = (level, message, extra) => {
  logs.push(level + " " + message + (extra ? " " + JSON.stringify(extra) : ""));
};

const CFG = {
  enabled: true,
  interceptApprovals: false,
  interceptQuestions: false,
  approvalTimeoutMs: 1000,
  push: { notifyTurnEnd: false },
};

/**
 * 假 sharp：链式 API，输出字节数随 edge×quality 变化。
 * alwaysHuge=true 时永远输出 2MB（用来测"压不进预算"的降级路径）。
 */
function makeFakeSharp({ alwaysHuge = false } = {}) {
  const calls = [];
  const sharp = (input) => {
    const state = { edge: 0, quality: 0 };
    const chain = {
      rotate() {
        return chain;
      },
      resize(opts) {
        state.edge = Math.min(opts?.width ?? 0, opts?.height ?? 0) || 0;
        return chain;
      },
      jpeg(opts) {
        state.quality = opts?.quality ?? 0;
        return chain;
      },
      async toBuffer() {
        calls.push({ ...state });
        if (alwaysHuge) {
          return { data: Buffer.alloc(2 * 1024 * 1024, 3), info: { width: state.edge, height: state.edge } };
        }
        const size = Math.max(1, Math.round((state.edge * state.quality) / 100) * 64);
        return {
          data: Buffer.alloc(size, 7),
          info: { width: state.edge, height: Math.max(1, Math.round(state.edge * 0.75)) },
        };
      },
    };
    return chain;
  };
  sharp.calls = calls;
  return sharp;
}

/** 假附件服务：readImage 返回固定字节。 */
function makeAttachments(bytes = "fake-image-bytes") {
  return {
    async readImage(ref) {
      return { data: Buffer.from(bytes) };
    },
  };
}

/** 一条带图片块的 assistant 消息事件。 */
function assistantImageEvent(seq = 1, attachmentId = "att-1") {
  return {
    type: "assistant/message",
    seq,
    time: 1000 + seq,
    surfaceOp: "append",
    data: {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "看这张图" },
          {
            type: "image",
            attachment: { attachmentId, mediaType: "image/png", bytes: 123456, width: 800, height: 600 },
          },
        ],
      },
    },
  };
}

/** 取最后一条 result 回包。 */
function lastResult(sent, id) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m.type === "result" && m.payload?.id === id) {
      return m.payload.ok ? { value: m.payload.value } : { error: m.payload.error };
    }
  }
  return null;
}

/** 取某 topic 的事件负载。 */
function eventsOf(sent, topic) {
  return sent.filter((m) => m.type === "event" && m.payload?.topic === topic).map((m) => m.payload.data);
}

// ===========================================================================
// 场景 1：纯函数层 —— 历史消息只产元数据，正文无 "[图片]" 占位符
// ===========================================================================
{
  const record = { event: assistantImageEvent(1) };
  const out = mapHistoryMessages("sess-1", record);
  check("历史消息：一条 assistant 消息", out.length === 1, JSON.stringify(out));
  const message = out[0] ?? {};
  check("历史消息：正文不含 [图片] 占位符", !String(message.text ?? "").includes("[图片]"), message.text);
  check("历史消息：正文保留文本", message.text === "看这张图", message.text);
  check("历史消息：images 数组存在", Array.isArray(message.images) && message.images.length === 1, JSON.stringify(message.images));
  const image = (message.images ?? [])[0] ?? {};
  check("历史消息：imageId = 宿主 attachmentId", image.imageId === "att-1", image.imageId);
  check("历史消息：mediaType 透传", image.mediaType === "image/png", image.mediaType);
  check("历史消息：width/height/bytes 透传", image.width === 800 && image.height === 600 && image.bytes === 123456, JSON.stringify(image));
  check("历史消息：thumb 留空（纯函数无字节）", image.thumb === "", JSON.stringify(image.thumb));

  // 纯图片消息（无正文）也必须成条
  const pure = mapHistoryMessages("sess-1", {
    event: {
      type: "assistant/message",
      seq: 2,
      time: 1002,
      surfaceOp: "append",
      data: {
        message: {
          role: "assistant",
          content: [
            { type: "image", attachment: { attachmentId: "att-2", mediaType: "image/png", bytes: 10, width: 4, height: 3 } },
          ],
        },
      },
    },
  });
  check("纯图片消息也成条", pure.length === 1, JSON.stringify(pure));
  check("纯图片消息正文为空", (pure[0]?.text ?? "") === "", pure[0]?.text);
  check("纯图片消息带 images", (pure[0]?.images ?? []).length === 1, JSON.stringify(pure[0]?.images));

  // 消息正文口径：图片不占位、文件仍占位
  check("messageText：图片不占位", messageText([{ type: "image", attachment: {} }]) === "", JSON.stringify(messageText([{ type: "image" }])));
  check("messageText：文件仍占位", messageText([{ type: "file" }]) === "[文件]", messageText([{ type: "file" }]));
  check("messageText：文本拼接", messageText([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "ab");
  check("contentText（工具结果口径）仍给 [图片] 占位", contentText([{ type: "image" }, { type: "file" }]) === "[图片][文件]", contentText([{ type: "image" }, { type: "file" }]));

  // 图片块提取
  check("imageBlocksOf 只认 image 块", imageBlocksOf([{ type: "text", text: "x" }, { type: "image", attachment: { attachmentId: "a" } }]).length === 1);
  check("imageBlocksOf 跳过无 attachment 的 image 块", imageBlocksOf([{ type: "image" }]).length === 0);
  check("imageBlocksOf 非数组返回空", imageBlocksOf(null).length === 0);
  check("imageBlocksOf 跳过非对象块", imageBlocksOf([null, "x", { type: "image", attachment: { attachmentId: "b" } }]).length === 1);

  // 元数据归一
  const bad = imageRefMeta({});
  check("imageRefMeta：缺字段不抛，填 0/空串", bad.imageId === "" && bad.mediaType === "" && bad.width === 0 && bad.height === 0 && bad.bytes === 0, JSON.stringify(bad));
  const meta = imageRefMeta({ attachmentId: "att-x", mediaType: "image/jpeg", width: 10, height: 20, bytes: 30 });
  check("attachmentRefOf 取回宿主引用", attachmentRefOf(meta)?.attachmentId === "att-x", JSON.stringify(attachmentRefOf(meta)));
  check("宿主引用不进 JSON", !JSON.stringify(meta).includes("attachmentRef") && Object.keys(meta).length === 6, JSON.stringify(meta));

  // maxEdge 归一
  check("clampMaxEdge 缺省 1600", clampMaxEdge(undefined) === LARGE_DEFAULT_MAX_EDGE, String(clampMaxEdge(undefined)));
  check("clampMaxEdge 上限 4096", clampMaxEdge(99999) === LARGE_MAX_EDGE, String(clampMaxEdge(99999)));
  check("clampMaxEdge 保留合法值", clampMaxEdge(800) === 800, String(clampMaxEdge(800)));
  check("clampMaxEdge 非法值回落 1600", clampMaxEdge("abc") === 1600 && clampMaxEdge(0) === 1600 && clampMaxEdge(-5) === 1600, String(clampMaxEdge("abc")));
  check("大图预算 ≤ 1MiB", LARGE_MAX_BASE64 <= 1024 * 1024, String(LARGE_MAX_BASE64));
  check("缩略图预算 = 96KB", THUMB_MAX_BASE64 === 96 * 1024, String(THUMB_MAX_BASE64));
  check("宿主图片类型目录", IMAGE_MEDIA_TYPES.includes("image/png") && IMAGE_MEDIA_TYPES.includes("image/jpeg") && IMAGE_MEDIA_TYPES.includes("image/webp") && IMAGE_MEDIA_TYPES.includes("image/gif"), JSON.stringify(IMAGE_MEDIA_TYPES));
}

// ===========================================================================
// 场景 2：缩略图补齐层（attachThumbs）
// ===========================================================================
{
  const fake = makeFakeSharp();
  setSharpResolver(() => fake);
  const record = { event: assistantImageEvent(1) };
  const messages = mapHistoryMessages("sess-1", record);
  const ctx = makeCtx({ attachments: makeAttachments() });
  await attachThumbs(messages, ctx);
  const thumb = messages[0]?.images?.[0]?.thumb ?? "";
  check("attachThumbs：补上内联缩略图", thumb.startsWith("data:image/jpeg;base64,"), thumb.slice(0, 40));
  check("attachThumbs：base64 ≤ 96KB", thumb.length - "data:image/jpeg;base64,".length <= THUMB_MAX_BASE64, String(thumb.length));
  check("attachThumbs：元数据保留", messages[0]?.images?.[0]?.imageId === "att-1" && messages[0]?.images?.[0]?.width === 800);

  // 已有 thumb 的不重复压
  const fake2 = makeFakeSharp();
  setSharpResolver(() => fake2);
  const again = mapHistoryMessages("sess-1", record);
  again[0].images[0].thumb = "data:image/jpeg;base64,QUJD";
  await attachThumbs(again, ctx);
  check("attachThumbs：已有 thumb 不重复压缩", fake2.calls.length === 0, String(fake2.calls.length));
  check("attachThumbs：已有 thumb 保持不变", again[0].images[0].thumb === "data:image/jpeg;base64,QUJD", again[0].images[0].thumb);

  // 无附件服务 → 优雅降级
  setSharpResolver(() => makeFakeSharp());
  const noSvc = mapHistoryMessages("sess-1", record);
  await attachThumbs(noSvc, makeCtx({}));
  check("attachThumbs：无附件服务不抛、thumb 留空", (noSvc[0]?.images?.[0]?.thumb ?? "") === "", JSON.stringify(noSvc[0]?.images?.[0]?.thumb));

  // sharp 不可用 → 优雅降级
  setSharpResolver(() => null);
  const noSharp = mapHistoryMessages("sess-1", record);
  await attachThumbs(noSharp, ctx);
  check("attachThumbs：sharp 不可用不抛、thumb 留空", (noSharp[0]?.images?.[0]?.thumb ?? "") === "", JSON.stringify(noSharp[0]?.images?.[0]?.thumb));

  // 读字节抛错 → 优雅降级
  setSharpResolver(() => makeFakeSharp());
  const broken = mapHistoryMessages("sess-1", record);
  const brokenCtx = makeCtx({
    attachments: {
      readImage() {
        throw new Error("boom");
      },
    },
  });
  await attachThumbs(broken, brokenCtx);
  check("attachThumbs：读字节失败不抛、thumb 留空", (broken[0]?.images?.[0]?.thumb ?? "") === "", JSON.stringify(broken[0]?.images?.[0]?.thumb));

  // 无 images 字段的消息 → 不炸
  const plain = [{ id: "x", role: "user", text: "hi", ts: 1, seq: 1 }];
  await attachThumbs(plain, ctx);
  check("attachThumbs：无 images 的消息安全返回", plain[0]?.text === "hi");
  await attachThumbs(null, ctx);
  check("attachThumbs：null 输入安全返回", true);
}

// ===========================================================================
// 场景 3：makeThumb / makeLarge 的降级阶梯
// ===========================================================================
{
  setSharpResolver(() => makeFakeSharp({ alwaysHuge: true }));
  const bytes = Buffer.from("x");
  check("makeThumb：压不进 96KB → 返回空串", (await makeThumb(bytes, "image/png")) === "");
  let threw = null;
  try {
    await makeLarge(bytes, "image/png", 1600);
  } catch (e) {
    threw = e;
  }
  check("makeLarge：压不进预算 → 抛错（上层回 error）", threw !== null && /too large/i.test(String(threw?.message ?? "")), String(threw?.message ?? threw));

  setSharpResolver(() => makeFakeSharp());
  const thumb = await makeThumb(bytes, "image/png");
  check("makeThumb：正常产出 jpeg data URI", thumb.startsWith("data:image/jpeg;base64,"), thumb.slice(0, 32));
  const large = await makeLarge(bytes, "image/png", 1600);
  check("makeLarge：正常产出 jpeg data URI", large.data.startsWith("data:image/jpeg;base64,"), large.data.slice(0, 32));
  check("makeLarge：mediaType=image/jpeg", large.mediaType === "image/jpeg", large.mediaType);
  check("makeLarge：base64 ≤ 预算", large.data.length - "data:image/jpeg;base64,".length <= LARGE_MAX_BASE64, String(large.data.length));
  check("makeThumb：空字节返回空串", (await makeThumb(Buffer.alloc(0), "image/png")) === "");
  setSharpResolver(null);
  const real = loadSharp();
  check("loadSharp 不抛（真实环境解析或降级）", real === null || typeof real === "object" || typeof real === "function", String(typeof real));
}

// ===========================================================================
// 场景 4：wire 层 —— session.history 内联缩略图 + image.fetch 拉大图
// ===========================================================================
{
  const fake = makeFakeSharp();
  setSharpResolver(() => fake);
  const events = [assistantImageEvent(1)];
  const sessionController = {
    async inspect() {
      return { events };
    },
    async page() {
      return { records: events.map((e) => ({ event: e })), hasMore: false };
    },
  };
  const attachments = makeAttachments();
  const ctx = makeCtx({ sessionController, attachments });
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  // --- session.history：messages 带 images[] 且缩略图内联 ---
  const histId = "req-hist";
  await bridge.dispatch({ id: histId, type: "session.history", ts: Date.now(), payload: { sessionId: "sess-1" } });
  const hist = lastResult(relay.sent, histId);
  check("session.history：ok", hist?.value !== undefined, JSON.stringify(hist));
  const histMessage = hist?.value?.messages?.[0] ?? {};
  check("session.history：消息带 images[]", (histMessage.images ?? []).length === 1, JSON.stringify(histMessage));
  check("session.history：缩略图内联", String(histMessage.images?.[0]?.thumb ?? "").startsWith("data:image/jpeg;base64,"), String(histMessage.images?.[0]?.thumb).slice(0, 32));
  check("session.history：正文无 [图片] 占位符", !String(histMessage.text ?? "").includes("[图片]"), histMessage.text);

  // --- image.fetch：命中缓存前先压缩一次 ---
  const fetchId = "req-fetch";
  await bridge.dispatch({ id: fetchId, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1" } });
  const fetched = lastResult(relay.sent, fetchId);
  check("image.fetch：ok", fetched?.value !== undefined, JSON.stringify(fetched));
  check("image.fetch：imageId 回显", fetched?.value?.imageId === "att-1", JSON.stringify(fetched?.value?.imageId));
  check("image.fetch：data 是 jpeg data URI", String(fetched?.value?.data ?? "").startsWith("data:image/jpeg;base64,"), String(fetched?.value?.data).slice(0, 32));
  check("image.fetch：带 width/height", Number(fetched?.value?.width) > 0 && Number(fetched?.value?.height) > 0, JSON.stringify(fetched?.value));
  check("image.fetch：base64 ≤ 1MiB 预算", String(fetched?.value?.data ?? "").length <= LARGE_MAX_BASE64 + 64, String(fetched?.value?.data?.length));

  const callsAfterFirst = fake.calls.length;
  const fetchId2 = "req-fetch-2";
  await bridge.dispatch({ id: fetchId2, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1" } });
  const fetched2 = lastResult(relay.sent, fetchId2);
  check("image.fetch：同 (imageId,maxEdge) 命中缓存，不重复压缩", fake.calls.length === callsAfterFirst, `${callsAfterFirst} → ${fake.calls.length}`);
  check("image.fetch：缓存命中结果一致", fetched2?.value?.data === fetched?.value?.data);

  // 不同 maxEdge → 不同缓存条目
  const fetchId3 = "req-fetch-3";
  await bridge.dispatch({ id: fetchId3, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1", maxEdge: 800 } });
  const fetched3 = lastResult(relay.sent, fetchId3);
  check("image.fetch：不同 maxEdge 重新缩放", fake.calls.length > callsAfterFirst, `${callsAfterFirst} → ${fake.calls.length}`);
  check("image.fetch：maxEdge 生效（尺寸不同）", fetched3?.value?.data !== fetched?.value?.data);

  // 越界 maxEdge 归一到 4096 → 与显式 4096 共用缓存
  const before = fake.calls.length;
  const fetchId4 = "req-fetch-4";
  await bridge.dispatch({ id: fetchId4, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1", maxEdge: 99999 } });
  const afterBig = fake.calls.length;
  await bridge.dispatch({ id: "req-fetch-5", type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1", maxEdge: 4096 } });
  check("image.fetch：maxEdge 上限 4096", afterBig === before + 1, `${before} → ${afterBig}`);
  check("image.fetch：越界 maxEdge 与 4096 共用缓存条目", fake.calls.length === afterBig, `${afterBig} → ${fake.calls.length}`);

  // 未知 imageId → 明确中文错误（插件重启后缓存为空的情形）
  const missId = "req-miss";
  await bridge.dispatch({ id: missId, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-unknown" } });
  const miss = lastResult(relay.sent, missId);
  check("image.fetch：未知 imageId 回 error", miss?.error !== undefined, JSON.stringify(miss));
  check("image.fetch：未知 imageId 有明确中文文案", /重新加载会话/.test(String(miss?.error?.message ?? "")), String(miss?.error?.message));
  check("image.fetch：未知 imageId 有错误码", typeof miss?.error?.code === "string" && miss.error.code !== "", String(miss?.error?.code));

  // 空 imageId → bad-params
  const badId = "req-bad";
  await bridge.dispatch({ id: badId, type: "image.fetch", ts: Date.now(), payload: {} });
  const bad = lastResult(relay.sent, badId);
  check("image.fetch：缺 imageId 回 bad-params", bad?.error?.code === "bad-params", JSON.stringify(bad));

  // 日志里没有 base64 / data URI
  const joined = logs.join("\n");
  check("日志不含 data URI", !joined.includes("data:image"), joined.slice(-200));
  check("日志不含 base64 载荷", !/base64,[A-Za-z0-9+/=]{16,}/.test(joined), joined.slice(-200));
  check("日志记录了 imageId 与尺寸", joined.includes("att-1"), joined.slice(-200));
}

// ===========================================================================
// 场景 5：插件重启（缓存为空）与附件服务缺失 → 不崩
// ===========================================================================
{
  setSharpResolver(() => makeFakeSharp());
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();
  const id = "req-restart";
  await bridge.dispatch({ id, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-1" } });
  const res = lastResult(relay.sent, id);
  check("重启后 image.fetch：回 error 而非崩溃", res?.error !== undefined, JSON.stringify(res));
  check("重启后 image.fetch：文案提示重新加载会话", /重新加载会话/.test(String(res?.error?.message ?? "")), String(res?.error?.message));
}

// ===========================================================================
// 场景 6：直播图片（assistant/message 事件）→ assistant.image 广播
// ===========================================================================
{
  setSharpResolver(() => makeFakeSharp());
  const attachments = makeAttachments();
  const ctx = makeCtx({ attachments });
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  ctx.emit("session/event", { id: "sess-9" }, assistantImageEvent(5, "att-live"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const evs = eventsOf(relay.sent, "assistant.image");
  check("直播图片：广播 assistant.image", evs.length === 1, JSON.stringify(evs));
  check("直播图片：ImageRef 带 imageId", evs[0]?.image?.imageId === "att-live", JSON.stringify(evs[0]));
  check("直播图片：缩略图内联", String(evs[0]?.image?.thumb ?? "").startsWith("data:image/jpeg;base64,"), String(evs[0]?.image?.thumb).slice(0, 32));
  check("直播图片：带 sessionId", evs[0]?.sessionId === "sess-9", JSON.stringify(evs[0]));

  // 直播图片也可直接 image.fetch（无需先拉历史）
  const id = "req-live";
  await bridge.dispatch({ id, type: "image.fetch", ts: Date.now(), payload: { imageId: "att-live" } });
  const res = lastResult(relay.sent, id);
  check("直播图片：可直接 image.fetch", res?.value?.data?.startsWith("data:image/jpeg;base64,") === true, JSON.stringify(res));

  // replace 表面副本不重复广播
  const before = eventsOf(relay.sent, "assistant.image").length;
  const replaceEvent = assistantImageEvent(6, "att-replace");
  replaceEvent.surfaceOp = "replace";
  ctx.emit("session/event", { id: "sess-9" }, replaceEvent);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("直播图片：replace 副本不广播", eventsOf(relay.sent, "assistant.image").length === before, String(before));
}

setSharpResolver(null);

// ===========================================================================
// 场景 6：帧预算守卫（中继 1MiB 是 ws **单帧**上限，超了直接断链）
// ===========================================================================
{
  // 纯函数：超预算 → 先剥缩略图（保留元数据）
  const one = {
    messages: [
      {
        id: "m1",
        role: "assistant",
        text: "看图",
        ts: 1,
        seq: 1,
        images: [
          {
            imageId: "a1",
            mediaType: "image/jpeg",
            width: 800,
            height: 600,
            bytes: 123,
            thumb: "data:image/jpeg;base64," + "A".repeat(200_000),
          },
        ],
      },
    ],
  };
  const fit1 = fitReplyBudget(one, 10_000);
  check("帧预算：超预算时剥掉缩略图", fit1.strippedThumbs === 1 && one.messages[0].images[0].thumb === "", JSON.stringify(fit1));
  check("帧预算：剥缩略图后保留元数据", one.messages[0].images[0].imageId === "a1" && one.messages[0].images[0].width === 800);
  check("帧预算：剥完落在预算内", fit1.bytes <= 10_000 && fit1.overflow === false, String(fit1.bytes));

  // 纯函数：剥完缩略图还超 → 整条 images[] 丢掉
  const two = {
    messages: [
      {
        id: "m2",
        role: "assistant",
        text: "C".repeat(30_000),
        ts: 1,
        seq: 1,
        images: [{ imageId: "a2", mediaType: "image/jpeg", width: 1, height: 1, bytes: 1, thumb: "" }],
      },
    ],
  };
  const fit2 = fitReplyBudget(two, 10_000);
  check("帧预算：剥完缩略图还超 → 丢 images[]", fit2.strippedImages === 1 && two.messages[0].images === undefined, JSON.stringify(fit2));

  // 纯函数：只剩文字还超 → overflow（调用方回 error，绝不发爆帧）
  const three = { messages: [{ id: "m3", role: "assistant", text: "D".repeat(50_000), ts: 1, seq: 1 }] };
  const fit3 = fitReplyBudget(three, 10_000);
  check("帧预算：只剩文字仍超 → overflow", fit3.overflow === true, String(fit3.bytes));

  // 纯函数：不超预算 → 不动数据
  const four = { messages: [{ id: "m4", role: "assistant", text: "ok", ts: 1, seq: 1 }] };
  const fit4 = fitReplyBudget(four, 10_000);
  check("帧预算：不超预算不动数据", fit4.strippedThumbs === 0 && fit4.strippedImages === 0 && fit4.overflow === false);

  // 常量关系：明文预算 ×4/3（base64 密文）必须 < 中继单帧上限
  check("大图预算 ≤ 明文预算", LARGE_MAX_BASE64 <= REPLY_PLAIN_MAX_BYTES, String(LARGE_MAX_BASE64));
  check("页缩略图预算 ≤ 明文预算", THUMB_PAGE_BUDGET <= REPLY_PLAIN_MAX_BYTES, String(THUMB_PAGE_BUDGET));
  check(
    "明文预算 ×4/3 < 中继单帧上限",
    Math.ceil((REPLY_PLAIN_MAX_BYTES * 4) / 3) < RELAY_MAX_FRAME_BYTES,
    `${Math.ceil((REPLY_PLAIN_MAX_BYTES * 4) / 3)} vs ${RELAY_MAX_FRAME_BYTES}`,
  );

  // 端到端：一页 10 张图（每张缩略图 ~95KB）→ 回包必须落在明文预算内
  const fake = makeFakeSharp();
  setSharpResolver(() => {
    const wrapped = (input) => {
      const chain = fake(input);
      const orig = chain.toBuffer;
      chain.toBuffer = async () => {
        const out = await orig.call(chain);
        return { data: Buffer.alloc(70 * 1024, 9), info: out.info };
      };
      return chain;
    };
    wrapped.calls = fake.calls;
    return wrapped;
  });
  const manyEvents = [];
  for (let i = 1; i <= 10; i++) manyEvents.push(assistantImageEvent(i, "att-" + i));
  const sc = {
    async inspect() {
      return { events: manyEvents };
    },
    async page() {
      return { records: manyEvents.map((e) => ({ event: e })), hasMore: false };
    },
  };
  const ctx = makeCtx({ sessionController: sc, attachments: makeAttachments() });
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();
  const histId = "req-hist-big";
  await bridge.dispatch({ id: histId, type: "session.history", ts: Date.now(), payload: { sessionId: "sess-big" } });
  const hist = lastResult(relay.sent, histId);
  const replyBytes = JSON.stringify(hist?.value ?? {}).length;
  check("多图历史：回包落在明文预算内", replyBytes <= REPLY_PLAIN_MAX_BYTES, String(replyBytes));
  const thumbs = (hist?.value?.messages ?? []).reduce(
    (n, m) => n + (m?.images ?? []).filter((i) => typeof i?.thumb === "string" && i.thumb !== "").length,
    0,
  );
  check("多图历史：缩略图总量受页预算约束", thumbs <= 10 && replyBytes <= REPLY_PLAIN_MAX_BYTES, `${thumbs} 张缩略图`);
}

// ---------------------------------------------------------------------------
// present 投递的文件（deliverables/presented）→ 图片桥接
//
// 宿主把 present 出来的文件记成**路径**（deliverables/presented 事件），
// 不是图片附件块 → 插件的图片桥（imageBlocksOf）看不到它们 →
// 手机端消息里永远没有这些图（用户反馈：桌面看得到、手机没有）。
//
// 覆盖：类型识别 / 尺寸读取 / 事件桥接 / image.fetch 取大图 / 非图片跳过 /
//       日志脱敏 / 接线层断言。
// ---------------------------------------------------------------------------
{
  // 纯函数：扩展名 → 媒体类型
  check("present 文件：png/jpg/jpeg/gif/webp 认得出类型", mediaTypeOfPath("a/b/c.PNG") === "image/png"
    && mediaTypeOfPath("x.jpg") === "image/jpeg"
    && mediaTypeOfPath("x.JPEG") === "image/jpeg"
    && mediaTypeOfPath("x.gif") === "image/gif"
    && mediaTypeOfPath("x.webp") === "image/webp", mediaTypeOfPath("x.png"));
  check("present 文件：非图片/无扩展名返回空串", mediaTypeOfPath("notes.md") === ""
    && mediaTypeOfPath("archive.zip") === ""
    && mediaTypeOfPath("noext") === ""
    && mediaTypeOfPath("") === ""
    && mediaTypeOfPath(undefined) === "", "非图片应为空");

  // 假 sharp 要能报尺寸（imageMetaOf 走 metadata()）
  const fakeSharp2 = (input) => {
    const chain = {
      _edge: 0,
      _q: 0,
      rotate() { return chain; },
      resize(opts) {
        chain._edge = Math.min(opts?.width ?? 0, opts?.height ?? 0) || 0;
        return chain;
      },
      jpeg(opts) {
        chain._q = opts?.quality ?? 0;
        return chain;
      },
      async metadata() {
        return { width: 640, height: 480 };
      },
      async toBuffer() {
        const edge = chain._edge || 0;
        const size = Math.max(1, Math.round((edge * (chain._q || 70)) / 100) * 64);
        return { data: Buffer.alloc(size, 9), info: { width: edge, height: Math.max(1, Math.round(edge * 0.75)) } };
      },
    };
    return chain;
  };
  setSharpResolver(() => fakeSharp2);
  const meta = await imageMetaOf(Buffer.from("fake"));
  check("present 文件：能读出图片尺寸", meta.width === 640 && meta.height === 480, JSON.stringify(meta));

  // 端到端：deliverables/presented 事件 → assistant.image
  const dir = mkdtempSync(join(tmpdir(), "dshrc-delivered-"));
  const pngPath = join(dir, "shot.png");
  const mdPath = join(dir, "notes.md");
  writeFileSync(pngPath, Buffer.from("fake-png-bytes"));
  writeFileSync(mdPath, "# 不是图片");

  const ctx2 = makeCtx({});
  const relay2 = makeRelay();
  const bridge2 = new HostBridge({
    ctx: ctx2,
    relay: relay2,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge2.attach();

  ctx2.emit("session/event", { id: "sess-deliv" }, {
    type: "deliverables/presented",
    seq: 90,
    time: 2000,
    data: { turn: 7, callId: "call-1", files: [{ path: pngPath, name: "shot.png" }] },
  });
  // 异步（读文件 + 压缩）→ 让出事件循环
  await new Promise((r) => setTimeout(r, 150));
  const imgEvents = relay2.sent.filter((m) => m?.payload?.topic === "assistant.image");
  check("present 图片：广播了 assistant.image 事件", imgEvents.length === 1, `events=${imgEvents.length}`);
  const bridged = imgEvents[0]?.payload?.data?.image;
  check("present 图片：imageId 有 d 前缀（与宿主附件 id 命名空间隔离）",
    typeof bridged?.imageId === "string" && bridged.imageId.startsWith("d") && bridged.imageId.length === 17,
    String(bridged?.imageId));
  check("present 图片：带 mediaType/尺寸/字节数", bridged?.mediaType === "image/png"
    && bridged?.width === 640 && bridged?.height === 480 && bridged?.bytes > 0,
    JSON.stringify({ mt: bridged?.mediaType, w: bridged?.width, h: bridged?.height, b: bridged?.bytes }));
  check("present 图片：内联缩略图（手机端立刻能显示）",
    typeof bridged?.thumb === "string" && bridged.thumb.startsWith("data:image/jpeg;base64,"),
    String(bridged?.thumb).slice(0, 40));

  // 非图片文件跳过
  ctx2.emit("session/event", { id: "sess-deliv" }, {
    type: "deliverables/presented",
    seq: 91,
    time: 2100,
    data: { turn: 8, callId: "call-2", files: [{ path: mdPath, name: "notes.md" }] },
  });
  await new Promise((r) => setTimeout(r, 150));
  const imgEvents2 = relay2.sent.filter((m) => m?.payload?.topic === "assistant.image");
  check("present 非图片文件：跳过（不误报成图片）", imgEvents2.length === 1, `events=${imgEvents2.length}`);

  // image.fetch 能取回这张图的大图
  const fetchId = "req-fetch-deliv";
  await bridge2.dispatch({
    id: fetchId,
    type: "image.fetch",
    ts: Date.now(),
    payload: { imageId: bridged?.imageId ?? "", maxEdge: 800 },
  });
  const fetched = lastResult(relay2.sent, fetchId);
  const fv = fetched?.value;
  check("present 图片：image.fetch 能取到大图", fetched?.value !== undefined && fetched?.error === undefined
    && typeof fv?.data === "string" && fv.data.startsWith("data:image/jpeg;base64,")
    && fv?.imageId === bridged?.imageId,
    JSON.stringify({ hasValue: fetched?.value !== undefined, code: fetched?.error?.code }));

  // 未知 imageId → 明确错误，不崩
  const missId = "req-fetch-miss";
  await bridge2.dispatch({
    id: missId,
    type: "image.fetch",
    ts: Date.now(),
    payload: { imageId: "d0000000000000000" },
  });
  const missed = lastResult(relay2.sent, missId);
  check("present 图片：未知 imageId 回明确错误", missed?.value === undefined && missed?.error?.code === "image-not-found",
    JSON.stringify(missed?.error?.code));

  // 接线层：事件闸必须认 deliverables/presented（源码断言）
  const src = readFileSync(new URL("../lib/host-bridge.mjs", import.meta.url), "utf8");
  check("present 图片：事件闸认 deliverables/presented（源码断言）",
    src.includes('type === "deliverables/presented"'), "事件闸缺分支");
  check("present 图片：日志不含文件路径（脱敏）",
    !logs.some((l) => l.includes(pngPath)), "日志里出现了文件路径");
  rmSync(dir, { recursive: true, force: true });
}

setSharpResolver(null);

// ---------------------------------------------------------------------------
// v1.1.1：session.prompt 的 mode（契约 §5.1）
//
// mode 只认两个字面量 'queue' / 'steer'，缺省 'queue'；其它值必须回 bad-params
// （**不得**默默当 queue——那会让用户以为消息插进了正在跑的 turn）。
// 宿主拒绝 steer（如 session/steer-unavailable）时原样回宿主的错误码。
// ---------------------------------------------------------------------------
{
  const promptCalls = [];
  let rejectSteer = false;
  const sc = {
    async prompt(request) {
      promptCalls.push(request);
      if (rejectSteer) {
        const err = new Error("current turn no longer accepts steering");
        err.code = "session/steer-unavailable";
        throw err;
      }
      return { accepted: true };
    },
  };
  const ctx = makeCtx({ sessionController: sc });
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  const promptReq = (id, payload) =>
    bridge.dispatch({ id, type: "session.prompt", ts: Date.now(), payload: { sessionId: "sess-p", text: "你好", ...payload } });

  // 1) mode:'steer' → 原样转发给宿主
  await promptReq("p-steer", { mode: "steer" });
  check("session.prompt：mode=steer 转发给宿主", promptCalls[0]?.mode === "steer", JSON.stringify(promptCalls[0]));
  check("session.prompt：steer 被接受", lastResult(relay.sent, "p-steer")?.value?.accepted === true, JSON.stringify(lastResult(relay.sent, "p-steer")));
  check("session.prompt：带 requestId/sessionId/content",
    typeof promptCalls[0]?.requestId === "string" && promptCalls[0]?.requestId !== ""
    && promptCalls[0]?.sessionId === "sess-p"
    && Array.isArray(promptCalls[0]?.content) && promptCalls[0].content[0]?.type === "text"
    && promptCalls[0].content[0]?.text === "你好", JSON.stringify(promptCalls[0]));

  // 2) 不带 mode → 缺省 queue
  await promptReq("p-queue", {});
  check("session.prompt：不带 mode 缺省 queue", promptCalls[1]?.mode === "queue", JSON.stringify(promptCalls[1]));
  check("session.prompt：缺省 queue 被接受", lastResult(relay.sent, "p-queue")?.value?.accepted === true, JSON.stringify(lastResult(relay.sent, "p-queue")));

  // 3) 非法 mode → bad-params，且**不**转发给宿主
  const before = promptCalls.length;
  await promptReq("p-bogus", { mode: "bogus" });
  const bogus = lastResult(relay.sent, "p-bogus");
  check("session.prompt：非法 mode 回 bad-params", bogus?.error?.code === "bad-params", JSON.stringify(bogus));
  check("session.prompt：非法 mode 有中文原因（说清只支持 queue / steer）",
    /mode 只支持 queue \/ steer/.test(String(bogus?.error?.message ?? "")), String(bogus?.error?.message));
  check("session.prompt：非法 mode 不转发给宿主（没被默默当 queue）", promptCalls.length === before, `${before} → ${promptCalls.length}`);

  // 4) 其它非法取值一律回 bad-params（空串 / 大写 / null / 数字）
  for (const [label, value] of [["空串", ""], ["大写", "QUEUE"], ["null", null], ["数字", 7]]) {
    const id = "p-bad-" + label;
    await promptReq(id, { mode: value });
    check(`session.prompt：mode=${label} 回 bad-params`, lastResult(relay.sent, id)?.error?.code === "bad-params", JSON.stringify(lastResult(relay.sent, id)));
  }
  check("session.prompt：非法 mode 一律不转发给宿主", promptCalls.length === before, `${before} → ${promptCalls.length}`);

  // 5) 宿主拒绝 steer → 原样回宿主错误码（不吞掉）
  rejectSteer = true;
  await promptReq("p-steer-reject", { mode: "steer" });
  const rejected = lastResult(relay.sent, "p-steer-reject");
  check("session.prompt：宿主拒绝 steer 时回宿主错误码",
    rejected?.error?.code === "session/steer-unavailable", JSON.stringify(rejected?.error));
  check("session.prompt：宿主拒绝 steer 时保留宿主文案",
    /no longer accepts steering/.test(String(rejected?.error?.message ?? "")), String(rejected?.error?.message));
  rejectSteer = false;
}

// ---------------------------------------------------------------------------
// v1.1.1：待执行消息（排队中）追踪 → session.queue 事件（契约 §5.2）
//
// 源为宿主会话事件 agent/inbox/spliced（入队）与 user/message（被消费时出队）。
// 一个 session 一个列表——不同会话互不干扰。
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({});
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  const splice = (sessionId, target, inserted, extra = {}) =>
    ctx.emit("session/event", { id: sessionId }, {
      type: "agent/inbox/spliced",
      seq: 10,
      time: 100,
      data: { target, start: 0, inserted, ...extra },
    });

  // 1) 入队 → 广播 session.queue
  splice("sess-q", "next-turn", [
    { id: "m-1", source: { kind: "user", rpcId: "rpc-1" }, content: [{ type: "text", text: "排队的消息" }] },
  ]);
  const q1 = eventsOf(relay.sent, "session.queue");
  check("session.queue：入队后广播 session.queue", q1.length === 1, `events=${q1.length}`);
  check("session.queue：带 sessionId", q1[0]?.sessionId === "sess-q", JSON.stringify(q1[0]));
  check("session.queue：items 形状正确（itemId/text/target）",
    Array.isArray(q1[0]?.items) && q1[0].items.length === 1
    && q1[0].items[0]?.itemId === "m-1"
    && q1[0].items[0]?.text === "排队的消息"
    && q1[0].items[0]?.target === "next-turn", JSON.stringify(q1[0]?.items));
  check("session.queue：item 只带三个字段（不泄露 rpcId）",
    Object.keys(q1[0]?.items?.[0] ?? {}).length === 3, JSON.stringify(q1[0]?.items?.[0]));
  check("session.queue：wire 里没有 rpcId", !JSON.stringify(q1[0] ?? {}).includes("rpc-1"), JSON.stringify(q1[0]));

  // 2) 未知 target → 忽略
  splice("sess-q", "next-week", [{ id: "m-x", content: [{ type: "text", text: "x" }] }]);
  check("session.queue：未知 target 忽略", eventsOf(relay.sent, "session.queue").length === 1, "不该广播");

  // 3) 没有文本 → 跳过该条
  splice("sess-q", "next-turn", [{ id: "m-y", content: [{ type: "image" }] }]);
  check("session.queue：没有文本的条目跳过", eventsOf(relay.sent, "session.queue").length === 1, "不该广播");

  // 4) 另一个会话入队 → 各自独立
  splice("sess-q2", "next-step", [
    { id: "m-2", source: { kind: "user", rpcId: "rpc-2" }, content: [{ type: "text", text: "别的会话" }] },
  ]);
  const q2 = eventsOf(relay.sent, "session.queue");
  check("session.queue：不同 session 各自一条队列",
    q2[1]?.sessionId === "sess-q2" && q2[1]?.items?.length === 1 && q2[1].items[0]?.itemId === "m-2",
    JSON.stringify(q2[1]));

  // 5) 别的会话消费了同 rpcId → 不影响本会话的队列
  ctx.emit("session/event", { id: "sess-q2" }, {
    type: "user/message",
    seq: 11,
    time: 110,
    surfaceOp: "append",
    data: { id: "m-1", source: { kind: "user", rpcId: "rpc-1" }, content: [{ type: "text", text: "排队的消息" }] },
  });
  check("session.queue：别的会话消费不影响本会话", eventsOf(relay.sent, "session.queue").length === 2, "不该广播");

  // 6) 本会话的消息被消费（rpcId 命中）→ 再次广播，items 变空
  ctx.emit("session/event", { id: "sess-q" }, {
    type: "user/message",
    seq: 12,
    time: 120,
    surfaceOp: "append",
    data: { id: "m-1", source: { kind: "user", rpcId: "rpc-1" }, content: [{ type: "text", text: "排队的消息" }] },
  });
  const q3 = eventsOf(relay.sent, "session.queue");
  check("session.queue：消费后再次广播", q3.length === 3, `events=${q3.length}`);
  check("session.queue：消费后 items 变空（空数组也要发）",
    Array.isArray(q3[2]?.items) && q3[2].items.length === 0, JSON.stringify(q3[2]));
  check("session.queue：消费广播的 sessionId 正确", q3[2]?.sessionId === "sess-q", JSON.stringify(q3[2]));

  // 7) 另一会话的队列仍在自己那儿（再插一条看它还在）
  splice("sess-q2", "next-step", [
    { id: "m-3", source: { kind: "user", rpcId: "rpc-3" }, content: [{ type: "text", text: "第三条" }] },
  ]);
  const q4 = eventsOf(relay.sent, "session.queue");
  check("session.queue：另一会话的旧条目仍在（不串台）",
    q4[3]?.sessionId === "sess-q2" && q4[3]?.items?.length === 2
    && q4[3].items.map((i) => i.itemId).join(",") === "m-2,m-3", JSON.stringify(q4[3]));

  // 8) 非真人来源的 user/message（agent 注入）→ 不出队
  splice("sess-q", "next-turn", [
    { id: "m-4", source: { kind: "user", rpcId: "rpc-4" }, content: [{ type: "text", text: "第四条" }] },
  ]);
  ctx.emit("session/event", { id: "sess-q" }, {
    type: "user/message",
    seq: 13,
    time: 130,
    surfaceOp: "append",
    data: { id: "m-4", source: { kind: "agent" }, content: [{ type: "text", text: "注入" }] },
  });
  const q5 = eventsOf(relay.sent, "session.queue");
  check("session.queue：非真人来源的 user/message 不出队", q5.length === 5, `events=${q5.length}`);
}

// ---------------------------------------------------------------------------
// v1.1.1：交付物图片在历史里也留着（契约 §5.10.2）
//
// 直播时交付物图片挂在「正在流式的 assistant 消息」上 → turn 结束刷新历史时，
// 那条消息被宿主的持久副本替换 → 图片一闪而过然后消失。
// 故 session.history 的回包里要补一条**独立**的图片消息（正文空串）。
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "dshrc-hist-"));
  const pngPath = join(dir, "shot.png");
  writeFileSync(pngPath, Buffer.from("fake-png-bytes"));
  // 交付物图片的尺寸走 imageMetaOf（sharp.metadata()），故桩要能报 metadata
  const sharpWithMeta = () => {
    const chain = {
      _edge: 0,
      _q: 0,
      rotate() { return chain; },
      resize(opts) {
        chain._edge = Math.min(opts?.width ?? 0, opts?.height ?? 0) || 0;
        return chain;
      },
      jpeg(opts) {
        chain._q = opts?.quality ?? 0;
        return chain;
      },
      async metadata() {
        return { width: 640, height: 480 };
      },
      async toBuffer() {
        const edge = chain._edge || 0;
        const size = Math.max(1, Math.round((edge * (chain._q || 70)) / 100) * 64);
        return { data: Buffer.alloc(size, 9), info: { width: edge, height: Math.max(1, Math.round(edge * 0.75)) } };
      },
    };
    return chain;
  };
  // 桩要**可调用**（loadSharp() 的返回值会被当 sharp(input, opts) 调）
  setSharpResolver(() => () => sharpWithMeta());

  // 会话日志里有一条普通助手消息（**非空**历史 → 走 page 那条回包路径）
  const histEvents = [
    {
      type: "assistant/message",
      seq: 1,
      time: 100,
      surfaceOp: "append",
      data: { message: { role: "assistant", content: [{ type: "text", text: "在的" }] } },
    },
  ];
  const sc = {
    async inspect() {
      return { events: histEvents };
    },
    async page() {
      return { records: histEvents.map((e) => ({ event: e })), hasMore: false };
    },
  };
  const ctx = makeCtx({ sessionController: sc });
  const relay = makeRelay();
  const bridge = new HostBridge({
    ctx,
    relay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  bridge.attach();

  ctx.emit("session/event", { id: "sess-hist" }, {
    type: "deliverables/presented",
    seq: 42,
    time: 4242,
    data: { turn: 3, callId: "call-1", files: [{ path: pngPath, name: "shot.png" }] },
  });
  await new Promise((r) => setTimeout(r, 150));

  const imgs = eventsOf(relay.sent, "assistant.image");
  check("交付物图片：assistant.image 带 source:'deliverable'",
    imgs[0]?.image?.source === "deliverable", JSON.stringify(imgs[0]?.image));

  const histId = "req-hist-deliv";
  await bridge.dispatch({ id: histId, type: "session.history", ts: Date.now(), payload: { sessionId: "sess-hist" } });
  const hist = lastResult(relay.sent, histId);
  const msgs = hist?.value?.messages ?? [];
  check("交付物图片：历史回包里既有原消息也有独立图片消息", msgs.length === 2, JSON.stringify(msgs.map((m) => m?.id)));
  check("交付物图片：原消息顺序/字段口径保持原样",
    msgs[0]?.text === "在的" && msgs[0]?.role === "assistant" && msgs[0]?.seq === 1, JSON.stringify(msgs[0]));
  const dm = msgs[1] ?? {};
  check("交付物图片：历史回包里有独立图片消息", dm !== undefined && Array.isArray(dm.images), JSON.stringify(dm));
  check("交付物图片：独立消息正文为空串", dm.text === "", JSON.stringify(dm.text));
  check("交付物图片：独立消息 role=assistant", dm.role === "assistant", String(dm.role));
  check("交付物图片：seq 用宿主事件 seq", dm.seq === 42, String(dm.seq));
  check("交付物图片：ts 用宿主事件时间", dm.ts === 4242, String(dm.ts));
  check("交付物图片：消息带 images[]", Array.isArray(dm.images) && dm.images.length === 1, JSON.stringify(dm.images));
  const dim = dm.images?.[0] ?? {};
  check("交付物图片：历史 ImageRef 带 source:'deliverable'", dim.source === "deliverable", JSON.stringify(dim));
  check("交付物图片：历史 ImageRef 缩略图内联",
    typeof dim.thumb === "string" && dim.thumb.startsWith("data:image/jpeg;base64,"), String(dim.thumb).slice(0, 40));
  check("交付物图片：历史 ImageRef 的 imageId 与事件一致",
    dim.imageId === imgs[0]?.image?.imageId, `${dim.imageId} vs ${imgs[0]?.image?.imageId}`);
  check("交付物图片：历史 ImageRef 带元数据（mediaType/尺寸/字节）",
    dim.mediaType === "image/png" && dim.width === 640 && dim.height === 480 && dim.bytes > 0,
    JSON.stringify({ mt: dim.mediaType, w: dim.width, h: dim.height, b: dim.bytes }));
  check("交付物图片：日志不含文件路径", !logs.some((l) => l.includes(pngPath)), "日志里出现了文件路径");

  // 空会话（宿主日志为空）→ 另一条回包路径，也要带上交付物图片
  const emptySc = {
    async inspect() {
      return { events: [] };
    },
    async page() {
      return { records: [], hasMore: false };
    },
  };
  const emptyCtx = makeCtx({ sessionController: emptySc });
  const emptyRelay = makeRelay();
  const emptyBridge = new HostBridge({
    ctx: emptyCtx,
    relay: emptyRelay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  emptyBridge.attach();
  emptyCtx.emit("session/event", { id: "sess-empty" }, {
    type: "deliverables/presented",
    seq: 7,
    time: 700,
    data: { turn: 4, callId: "call-2", files: [{ path: pngPath, name: "shot.png" }] },
  });
  await new Promise((r) => setTimeout(r, 150));
  await emptyBridge.dispatch({ id: "req-hist-empty", type: "session.history", ts: Date.now(), payload: { sessionId: "sess-empty" } });
  const emptyHist = lastResult(emptyRelay.sent, "req-hist-empty");
  const emptyMsgs = emptyHist?.value?.messages ?? [];
  check("交付物图片：空会话历史里也带独立图片消息",
    emptyMsgs.length === 1 && emptyMsgs[0]?.text === "" && (emptyMsgs[0]?.images ?? []).length === 1,
    JSON.stringify(emptyMsgs.map((m) => m?.id)));
  rmSync(dir, { recursive: true, force: true });

  // 附件来源的图片**不带** source 字段（只有交付物图片带）
  setSharpResolver(() => makeFakeSharp());
  const attCtx = makeCtx({ attachments: makeAttachments() });
  const attRelay = makeRelay();
  const attBridge = new HostBridge({
    ctx: attCtx,
    relay: attRelay,
    push: { configured: false, notify: async () => ({ ok: true }) },
    config: CFG,
    log,
  });
  attBridge.attach();
  attCtx.emit("session/event", { id: "sess-att" }, assistantImageEvent(3, "att-src"));
  await new Promise((r) => setTimeout(r, 30));
  const attImgs = eventsOf(attRelay.sent, "assistant.image");
  check("附件图片：ImageRef 不带 source 字段",
    attImgs[0]?.image !== undefined && !Object.hasOwn(attImgs[0].image, "source"), JSON.stringify(attImgs[0]?.image));
}

// ---------------------------------------------------------------------------
// v1.1.1：接线层断言（源码级）
//
// 这些断言的意义在于「把实现改坏时门禁会红」——比如把 mode 又写死成 queue、
// 或把事件闸的分支删掉。
// ---------------------------------------------------------------------------
{
  const src = readFileSync(new URL("../lib/host-bridge.mjs", import.meta.url), "utf8");
  check("接线层：事件闸认 agent/inbox/spliced",
    src.includes('type === "agent/inbox/spliced"'), "事件闸缺分支");
  check("接线层：事件闸认 user/message",
    src.includes('type === "user/message"'), "事件闸缺分支");
  check("接线层：prompt 分支读 payload.mode",
    src.includes('p.mode === undefined ? "queue" : p.mode'), "prompt 分支没读 mode");
  check("接线层：prompt 不再写死 mode:'queue'",
    !src.includes('mode: "queue",'), "mode 又被写死了");
  check("接线层：广播 session.queue 事件",
    src.includes('this.#sendEvent("session.queue"'), "没有广播 session.queue");
  check("接线层：session.history 追加交付物图片消息",
    src.includes("#deliveredHistoryMessages(sessionId)"), "历史回包没带交付物图片");
}

setSharpResolver(null);

console.log("");
console.log("verify-images: " + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
