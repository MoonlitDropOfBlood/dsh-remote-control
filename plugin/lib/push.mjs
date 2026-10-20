// lib/push.mjs — 华为 Push Kit REST 旁路（契约 §6）。
//
// 纯 REST、无 SDK：
//   1. POST https://oauth2.cloud.huawei.com/oauth2/v1/token
//      (grant_type=client_credentials&client_id&client_secret)
//      → access_token，缓存至过期前 60s。
//   2. POST https://push-api.cloud.huawei.com/v1/{appId}/messages:send
//      Authorization: Bearer <token>；push_type:"notify"，
//      target 用手机上报的 push_token；harmonyOS 载荷带标题/正文/intent
//      （extra：sessionId、askId、kind，点击拉起 App 直达对应会话）。
//
// 契约硬性要求：任何异常不得打断主流程——本模块**所有**公开方法都不抛出，
// 失败静默重试一次后返回 {ok:false}。未配置（enabled=false 或字段缺失）
// 时直接返回 {ok:false, reason:"not-configured"}，由上层在 push.state 事件
// 里说明（契约 §6）。
const TOKEN_URL = "https://oauth2.cloud.huawei.com/oauth2/v1/token";
const SEND_URL_BASE = "https://push-api.cloud.huawei.com/v1";
const TOKEN_REFRESH_MARGIN_MS = 60_000; // 过期前 60s 刷新（契约 §6）
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {{
 *   enabled: boolean, appId: string, clientId: string, clientSecret: string,
 *   channelId: string, topic?: string, notifyTurnEnd?: boolean,
 * }} PushConfig
 * @typedef {{ok: boolean, reason?: string, status?: number}} PushResult
 */

/** 配置是否足以发送（enabled + 三个凭证 + appId + channelId）。 */
export function pushConfigured(cfg) {
  if (!cfg || cfg.enabled !== true) return false;
  return (
    typeof cfg.appId === "string" && cfg.appId !== "" &&
    typeof cfg.clientId === "string" && cfg.clientId !== "" &&
    typeof cfg.clientSecret === "string" && cfg.clientSecret !== "" &&
    typeof cfg.channelId === "string" && cfg.channelId !== ""
  );
}

/** 配置不可用的统一原因（进 push.state.reason）。 */
export function pushUnavailableReason(cfg) {
  if (!cfg || cfg.enabled !== true) return "push disabled";
  if (!cfg.appId) return "push.appId missing";
  if (!cfg.clientId) return "push.clientId missing";
  if (!cfg.clientSecret) return "push.clientSecret missing";
  if (!cfg.channelId) return "push.channelId missing";
  return "not configured";
}

/** 带超时的 fetch（AbortController）；网络层异常原样抛出，由调用方归一。 */
async function fetchWithTimeout(url, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class PushSender {
  #cfg;
  #token = null;
  #tokenExpiresAt = 0;
  #inFlight = null;
  #log;

  /**
   * @param {PushConfig} cfg
   * @param {(level:"info"|"warn"|"error", message:string, extra?:object)=>void} [log]
   */
  constructor(cfg, log) {
    this.#cfg = cfg;
    this.#log = log;
  }

  /** 配置热更新（上层重载 config 后调用；换凭证则丢弃缓存 token）。 */
  updateConfig(cfg) {
    const old = this.#cfg;
    if (old && cfg && (old.clientId !== cfg.clientId || old.clientSecret !== cfg.clientSecret || old.clientId !== cfg.clientId)) {
      this.#token = null;
      this.#tokenExpiresAt = 0;
    }
    this.#cfg = cfg;
  }

  get configured() {
    return pushConfigured(this.#cfg);
  }

  /**
   * 获取 access_token（内存缓存至过期前 60s；并发合并为单次请求）。
   * @returns {Promise<string|null>} 失败返回 null（不抛）
   */
  async accessToken() {
    if (!this.configured) return null;
    if (this.#token !== null && Date.now() < this.#tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.#token;
    }
    if (this.#inFlight !== null) return this.#inFlight;
    const cfg = this.#cfg;
    this.#inFlight = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        });
        const res = await fetchWithTimeout(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: String(body),
        });
        if (!res.ok) {
          this.#log?.("warn", "push token request failed", { status: res.status });
          return null;
        }
        const data = await res.json();
        const token = data && typeof data.access_token === "string" ? data.access_token : null;
        if (token === null) {
          this.#log?.("warn", "push token response missing access_token");
          return null;
        }
        const expiresIn = Number(data.expires_in);
        this.#tokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000);
        this.#token = token;
        return token;
      } catch (e) {
        this.#log?.("warn", "push token request error", { error: String(e && e.message) });
        return null;
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }

  /**
   * 发送一条通知（失败静默重试一次；绝不抛出）。
   * @param {{
   *   pushToken: string, title: string, body: string,
   *   kind: "approval"|"question"|"turn-end",
   *   sessionId?: string, askId?: string,
   * }} req
   * @returns {Promise<PushResult>}
   */
  async notify(req) {
    try {
      if (!this.configured) return { ok: false, reason: pushUnavailableReason(this.#cfg) };
      if (typeof req?.pushToken !== "string" || req.pushToken === "") {
        return { ok: false, reason: "no push token registered" };
      }
      const first = await this.#attempt(req);
      if (first.ok) return first;
      // 静默重试一次（契约 §6：失败静默重试一次）
      const second = await this.#attempt(req);
      return second;
    } catch (e) {
      this.#log?.("warn", "push notify error", { error: String(e && e.message) });
      return { ok: false, reason: "error" };
    }
  }

  /** 单次发送尝试。 */
  async #attempt(req) {
    const cfg = this.#cfg;
    const token = await this.accessToken();
    if (token === null) return { ok: false, reason: "token unavailable" };

    // harmonyOS 载荷：标题 / 正文 / intent（点击拉起 App 直达会话，契约 §6）
    const extras = [];
    if (req.sessionId) extras.push({ key: "sessionId", value: String(req.sessionId) });
    if (req.askId) extras.push({ key: "askId", value: String(req.askId) });
    extras.push({ key: "kind", value: String(req.kind) });

    // Push 是独立 REST 协议（非本插件的 E2E 信封），直接构造华为请求体
    const payload = {
      push_type: "notify",
      token: req.pushToken,
      message: {
        notification: {
          title: String(req.title).slice(0, 256),
          body: String(req.body).slice(0, 1024),
        },
        android: {
          channel_id: cfg.channelId,
          ...(cfg.topic ? { topic: cfg.topic } : {}),
          click_action: {
            // 拉起 App 并携带直达参数（App 侧 intent 解析同名 extra）
            url: "dshremote://open?" + new URLSearchParams(
              Object.fromEntries(extras.map((e) => [e.key, e.value])),
            ).toString(),
          },
        },
      },
    };

    try {
      const res = await fetchWithTimeout(`${SEND_URL_BASE}/${encodeURIComponent(cfg.appId)}/messages:send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const code = data && data.code;
        // 华为侧业务错误码非 "80000000" 也算失败
        if (typeof code === "string" && code !== "80000000") {
          this.#log?.("warn", "push send business error", { code, msg: data.msg });
          return { ok: false, reason: String(code), status: res.status };
        }
        return { ok: true, status: res.status };
      }
      if (res.status === 401) {
        // token 失效：丢弃缓存，重试时会重新取
        this.#token = null;
        this.#tokenExpiresAt = 0;
      }
      this.#log?.("warn", "push send failed", { status: res.status });
      return { ok: false, status: res.status };
    } catch (e) {
      this.#log?.("warn", "push send error", { error: String(e && e.message) });
      return { ok: false, reason: "network" };
    }
  }
}
