// lib/host-bridge.mjs — DSH Host 服务桥接（契约 §5 业务层 / §5.5 瀑布语义 /
// §5.2 事件桥接 / §8.1 模块划分）。
//
// 三个职责：
//   1. 业务请求分发：手机 → host 的 10 种请求（§5.1），全部经
//      sessionController / 本机状态处理，每个调用点 try/catch，
//      错误统一回 result {ok:false, error:{code,message}}。
//   2. 事件桥接（§5.2）：api-session/*、agent/assistant-stream（按
//      sessionId 合并节流 ≤8 条/秒）、agent/status、agent/error → 推给手机。
//   3. 瀑布答案器（§5.5，安全关键）：approval/request 与
//      user-questions/request 以 {prepend:true} 抢占在桌面答案器之前；
//      **仅当**手机在线且开关打开才拦截；超时（默认 120s）/出错/取消
//      一律 return next() 放行，绝不 fail-closed 卡死任务；
//      迟到的手机回答回 applied:false。
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

/** 契约 §5.3 SessionSummary ← Host SessionSummary（title 来自投影）。 */
function mapSummary(raw) {
  const values = raw?.projections?.values;
  const title = values && typeof values.title === "string" ? values.title : "";
  return {
    sessionId: String(raw?.sessionId ?? ""),
    title,
    cwd: typeof raw?.cwd === "string" ? raw.cwd : "",
    running: raw?.running === true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
    archived: false,
  };
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
        case "session.create":
          return await this.#rSessionCreate(m);
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

  async #rSessionCreate(m) {
    const p = m.payload ?? {};
    try {
      const sc = this.#sc();
      const req = {};
      if (typeof p.cwd === "string" && p.cwd !== "") req.cwd = p.cwd;
      const value = await sc.create(req);
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
      this.#reply(m, resultOf(m, { sessionId }));
    } catch (e) {
      this.#reply(m, errorOf(m, "session-create-failed", errText(e)));
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
