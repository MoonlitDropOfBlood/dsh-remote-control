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
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { msg, sanitizeEnvelope } from "./protocol.mjs";
import { ASSISTANT_THROTTLE_PER_SEC } from "./config.mjs";

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
 * 之前的常量 false 是纯误导。 */
function mapSummary(raw) {
  const values = raw?.projections?.values;
  const title = values && typeof values.title === "string" ? values.title : "";
  return {
    sessionId: String(raw?.sessionId ?? ""),
    title,
    cwd: typeof raw?.cwd === "string" ? raw.cwd : "",
    running: raw?.running === true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    origin: raw?.origin === "subagent" ? "subagent" : "",
    parentSessionId: typeof raw?.parentSessionId === "string" ? raw.parentSessionId : "",
    blank: raw?.blank === true,
  };
}

/** 契约 §5.1 session.history 默认/上限页大小（宿主 DEFAULT_MAX_MESSAGES=50）。 */
const HISTORY_DEFAULT_MAX = 50;
const HISTORY_MAX_LIMIT = 200;

/**
 * 内容块 → 纯文本（契约 §5.7 / 附录 B）。
 * text 块取 text 拼接；image/file 给占位符；reasoning/tool-call 等忽略。
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
 * 契约 §5.1 ChatMessage 提取：SessionWireEvent → {id,role,text,ts,seq} 或 null。
 *
 * 事件形态（@deepseek-ai/dsh-session 类型实证）：
 *   user/message      data = UserMessage  {content:[ContentBlock], source:{kind}}
 *   assistant/message data = {turn, step, message: AssistantMessage, stream, usage?}
 * 显示口径（自行权衡，宁缺勿崩）：
 *   - 只收 append-origin 表面事件（surfaceOp==='append'）——replace 副本是
 *     模型可见的压缩影子，不是人看的逐字记录（宿主 surface 语义）；
 *   - user 只收 source.kind==='user' 的真人输入（agent.inject 的注入跳过）；
 *   - ContentBlock 只取 type==='text' 的纯文本（reasoning/tool-call 跳过，
 *     image/file 给占位符）；空文本一律跳过（不产生空泡）；
 *   - 任何不认识的形态返回 null（跳过），绝不抛出。
 */
export function mapHistoryMessage(sessionId, record) {
  const event = record?.event ?? record;
  if (!event || typeof event !== "object") return null;
  const type = event.type;
  if (type !== "user/message" && type !== "assistant/message") return null;
  if (event.surfaceOp !== "append") return null;
  const seq = Number(event?.seq);
  const time = Number(event?.time);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;

  let role;
  let content;
  if (type === "user/message") {
    if (data?.source?.kind !== "user") return null;
    role = "user";
    content = data.content;
  } else {
    role = "assistant";
    content = data?.message?.content;
  }
  if (!Array.isArray(content)) return null;

  const text = contentText(content);
  if (text.trim() === "") return null;
  return {
    id: `${sessionId}:${seq}`,
    role,
    text,
    ts: Number.isSafeInteger(time) && time > 0 ? time : 0,
    seq,
  };
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
  #deltaBuf = new Map(); // sessionId -> { text, timer }
  #pending = new Map(); // askId -> { resolve, kind, sessionId, timer, abortHandler, signal }
  #titles = new Map(); // sessionId -> title（turn.end 推送文案用）
  #pushToken = ""; // 手机 push.register 上报的 token（内存态）
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
      this.#titles.delete(String(sessionId));
      this.#sendEvent("session.removed", { sessionId: String(sessionId) });
    });
    this.#on("api-session/status", (sessionId, running) => {
      this.#sendEvent("session.status", { sessionId: String(sessionId), running: running === true });
    });
    this.#on("api-session/activity", (sessionId, updatedAt) => {
      this.#sendEvent("session.activity", { sessionId: String(sessionId), updatedAt: Number(updatedAt) || 0 });
    });

    // agent/assistant-stream：只取文本增量，按 sessionId 合并节流（≤8 条/秒）
    this.#on("agent/assistant-stream", (payload) => {
      try {
        const frame = payload?.frame;
        if (!frame || frame.type !== "chunk") return;
        const chunk = frame.chunk;
        if (!chunk || chunk.type !== "text-delta" || typeof chunk.text !== "string" || chunk.text === "") return;
        const sessionId = payload?.agent?.session?.id;
        if (!sessionId) return;
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
      // 其余事件（assistant/message、user/message、turn/*、step/* …）忽略
    });

    return () => this.dispose();
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
        case "session.prompt":
          return await this.#rSessionPrompt(m);
        case "session.cancel":
          return await this.#rSessionCancel(m);
        case "session.rename":
          return await this.#rSessionRename(m);
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
      const sessions = [];
      for (const item of value?.items ?? []) {
        const s = mapSummary(item);
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
        this.#reply(m, resultOf(m, { messages: [], steps: [], hasMore: false, oldestSeq: 0 }));
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
        const mapped = mapHistoryMessage(sessionId, record);
        if (mapped !== null) {
          messages.push(mapped);
          if (mapped.seq < oldestSeq) oldestSeq = mapped.seq;
        }
      }
      if (oldestSeq === Number.MAX_SAFE_INTEGER) {
        // 本页无可聊消息（全被过滤）→ 用页内最老事件 seq 续翻，避免卡页
        oldestSeq = oldestEventSeq === Number.MAX_SAFE_INTEGER ? 0 : oldestEventSeq;
      }
      // v1.0.6（§5.7）：工作步骤（工具调用）——旧客户端只读 messages，不受影响
      const steps = mapHistorySteps(page?.records ?? []);
      this.#reply(m, resultOf(m, { messages, steps, hasMore: page?.hasMore === true, oldestSeq }));
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
      const out = { sessionId };
      const echoed =
        typeof value?.agentPreset === "string" && value.agentPreset !== ""
          ? value.agentPreset
          : agentPreset;
      if (echoed !== "") out.agentPreset = echoed;
      this.#reply(m, resultOf(m, out));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-create-failed", errText(e)));
    }
  }

  /** 契约 §5.8 session.capabilities：新建会话可选的「模式」与「权限」目录。
   *  宿主没有对应能力 → 对应数组为空（客户端隐藏选择区），不得报错。 */
  async #rSessionCapabilities(m) {
    const presets = await this.#loadAgentPresets();
    const permissions = await this.#loadPermissionPresets();
    this.#reply(
      m,
      resultOf(m, {
        presets: presets.presets,
        permissions: permissions.permissions,
        defaultPreset: presets.defaultPreset,
        defaultPermission: permissions.defaultPermission,
      }),
    );
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

  async #rSessionPrompt(m) {
    const p = m.payload ?? {};
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
    const text = typeof p.text === "string" ? p.text : "";
    if (sessionId === "" || text.trim() === "") {
      this.#reply(m, errorOf(m, "bad-params", "sessionId and non-empty text required"));
      return;
    }
    try {
      const value = await this.#sc().prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        },
        this.#signal(30_000),
      );
      this.#reply(m, resultOf(m, { accepted: value?.accepted === true }));
    } catch (e) {
      this.#reply(m, errorOf(m, "prompt-failed", errText(e)));
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
