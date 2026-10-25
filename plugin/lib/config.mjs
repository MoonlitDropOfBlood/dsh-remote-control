// lib/config.mjs — 插件自有 config.json 的读写与默认值（契约 §3.1 / §6）。
//
// 存放位置：<DSH_HOME || ~/.dsh>/remote-control/config.json
// （与 dsh-agent-approval 同一范式：放在 DSH_HOME 下，不在 profile 的
// node_modules 里，重装/升级插件不丢配对信息。）
//
// 首次加载时若无 channel/secret 则随机生成并落盘（契约 §3.1）：
//   - channel：16 位 base32（字母表 A-Z2-7，满足中继 ^[A-Z2-7]{16,64}$）
//   - secret ：base64url 编码的 24 字节随机（32 字符，≥32 字符要求）
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 中继 channel 合法字母表（RFC 4648 base32，满足中继的 ^[A-Z2-7]{16,64}$）。 */
const CHANNEL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CHANNEL_LEN = 16;
const SECRET_BYTES = 24; // base64url 后 32 字符

/** 审批/提问拦截的默认与钳制边界（毫秒）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const MIN_APPROVAL_TIMEOUT_MS = 10_000;
export const MAX_APPROVAL_TIMEOUT_MS = 600_000;

/** assistant.delta 按会话合并节流：每秒最多 8 条（契约 §5.2）。 */
export const ASSISTANT_THROTTLE_PER_SEC = 8;

/**
 * v1.1.3 会话纪元的出厂默认值（契约 §3.4.1）。
 *   self    —— 本端自己的纪元号（每开一条新连接 +1，跨进程重启单调递增）
 *   peer    —— 已接受的对端最高纪元（回退检测的锚点）
 *   peerSid —— 已钉扎的对端连接实例 id（8 位十六进制）
 */
export function defaultEpoch() {
  return { self: 0, peer: 0, peerSid: "" };
}

/**
 * 规范化 epoch 字段：老配置没有该字段 → 补默认值；坏值 → 回落默认值。
 * @param {unknown} raw
 * @returns {{self:number, peer:number, peerSid:string}}
 */
export function normalizeEpoch(raw) {
  const out = defaultEpoch();
  if (raw !== null && typeof raw === "object") {
    const r = /** @type {Record<string, unknown>} */ (raw);
    if (Number.isInteger(r.self) && /** @type {number} */ (r.self) >= 0) out.self = /** @type {number} */ (r.self);
    if (Number.isInteger(r.peer) && /** @type {number} */ (r.peer) >= 0) out.peer = /** @type {number} */ (r.peer);
    if (typeof r.peerSid === "string" && /^[0-9a-f]{8}$/i.test(r.peerSid)) out.peerSid = r.peerSid;
  }
  return out;
}

export function dataDir() {
  return join(process.env.DSH_HOME || join(homedir(), ".dsh"), "remote-control");
}

export function configFile() {
  return join(dataDir(), "config.json");
}

/** 生成 16 位 base32 channel。 */
export function generateChannel() {
  const buf = randomBytes(CHANNEL_LEN);
  let out = "";
  for (let i = 0; i < CHANNEL_LEN; i++) out += CHANNEL_ALPHABET[buf[i] % CHANNEL_ALPHABET.length];
  return out;
}

/** 生成 base64url secret（24 字节 → 32 字符）。 */
export function generateSecret() {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/** 出厂默认配置（契约 §6 配置项 + §5.5 开关）。 */
export function defaultConfig() {
  return {
    /** 总开关：false 时完全不连接中继、不拦截任何请求。 */
    enabled: true,
    /** 中继地址，如 wss://relay.example.com/ws；空串 = 未配置，插件空转。 */
    relayUrl: "",
    /** v1.1.1：是否由插件托管本机中继进程（随插件启动/停止）。false = 保持旧行为（外部自己起）。 */
    autoStartRelay: true,
    /** 中继自身鉴权 token（可选，部署方配置 RELAY_TOKEN 时填写）。 */
    relayToken: "",
    /**
     * v1.1.3：中继 TLS（契约 §3.4.2）——托管的本机中继起 **wss://** 时的
     * 证书链 / 私钥**文件路径**。两个都填才启用；只填一个 → 中继启动即失败
     * （绝不静默降级成明文）。留空 = 明文 ws://（默认，局域网部署够用）。
     */
    relayTlsCert: "",
    relayTlsKey: "",
    /** 配对 channel / secret（首次启动生成；手机端配对页输入同样值）。 */
    channel: "",
    secret: "",
    /** 配对是否隐藏（设置页「隐藏配对」）：true 时界面不展示二维码。 */
    hidden: false,
    /**
     * v1.1.3 会话纪元（契约 §3.4.1）：抗重放的持久化锚点。
     * 自纪元每开一条新连接 +1（**先落盘再使用**）；对端纪元/钉扎 sid 用于回退检测。
     */
    epoch: defaultEpoch(),
    /** approval.request / question.request 拦截开关（契约 §5.5）。 */
    interceptApprovals: true,
    interceptQuestions: true,
    /** 手机应答等待超时（毫秒），超时 next() 放行给桌面答案器。 */
    approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    /** Push Kit 旁路（契约 §6）；未配置 = enabled false，优雅降级。 */
    push: {
      enabled: false,
      appId: "",
      clientId: "",
      clientSecret: "",
      /** 通知渠道 id（HarmonyOS 通知渠道）。 */
      channelId: "",
      /** 可选推送 topic。 */
      topic: "",
      /** turn.end 是否推送（默认推送完成通知）。 */
      notifyTurnEnd: true,
    },
  };
}

/** 深合并（只合并已知的对象字段，未知字段保留默认行为）。 */
function mergeKnown(base, over) {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (over === null || typeof over !== "object" || !(k in over)) continue;
    if (base[k] !== null && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = mergeKnown(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}

/** 超时钳制到 [MIN, MAX]。 */
export function clampApprovalTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.floor(n)));
}

/**
 * 加载配置；channel/secret 缺失时生成并持久化（首次启动生成，契约 §3.1）。
 * 文件损坏不抛出：退回默认 + 重新生成身份（损坏的旧文件被覆盖前先备份）。
 * @returns {{config: any, generated: boolean, repaired: boolean, path: string}}
 */
export function loadConfig() {
  const path = configFile();
  let raw = null;
  let existed = false;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
    existed = true;
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      // 文件存在但读坏/解析坏 → 备份后重置
      try {
        renameSync(path, path + ".corrupt-" + Date.now());
      } catch {
        /* 备份失败也不阻塞 */
      }
    }
  }
  let config = mergeKnown(defaultConfig(), raw && typeof raw === "object" ? raw : {});
  config.approvalTimeoutMs = clampApprovalTimeout(config.approvalTimeoutMs);
  // v1.1.3：老配置没有 epoch 字段 → 补默认值（迁移，§3.4.1）。
  config.epoch = normalizeEpoch(config.epoch);
  let generated = false;
  let repaired = false;
  if (typeof config.channel !== "string" || !/^[A-Z2-7]{16,64}$/.test(config.channel)) {
    config.channel = generateChannel();
    generated = true;
    repaired = existed;
  }
  if (typeof config.secret !== "string" || config.secret.length < 32) {
    config.secret = generateSecret();
    generated = true;
    repaired = existed;
  }
  if (generated) saveConfig(config);
  return { config, generated, repaired, path };
}

/**
 * 原子写回配置（tmp + rename，避免半写文件）。
 * 任何失败抛给调用方决定；上层应吞错并只记日志——配置写失败绝不阻断运行。
 *
 * **纪元只由专用写入器维护**（bumpSelfEpoch / savePeerEpoch：读-改-写、只动 epoch 字段）。
 * 这里的快照可能陈旧（例如设置页改了中继地址后回写整份配置）→ 一律沿用盘上最新纪元，
 * 避免自增纪元被回退覆盖（纪元复用 = 重放窗口）。
 */
export function saveConfig(config) {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const out = { ...config };
  out.epoch = readEpoch();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(out, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * 读盘上的纪元状态（契约 §3.4.1）。文件缺失/读坏 → 出厂默认值。
 * @returns {{self:number, peer:number, peerSid:string}}
 */
export function readEpoch() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8"));
    return normalizeEpoch(raw && raw.epoch);
  } catch {
    return defaultEpoch();
  }
}

/**
 * 读盘纪元（严格版）：文件读坏/缺失时**抛错**——
 * 纪元读不出来就不能安全地自增（宁可不开链路，也不复用纪元）。
 * @returns {{self:number, peer:number, peerSid:string}}
 */
function readEpochStrict() {
  const raw = JSON.parse(readFileSync(configFile(), "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error("config.json is not an object");
  return normalizeEpoch(raw.epoch);
}

/**
 * 只改 epoch 字段的原子写（读-改-写；**不动**其它配置字段）。
 * 文件读坏时抛错——绝不覆盖可能仍带着配对身份的文件。
 * @param {{self:number, peer:number, peerSid:string}} epoch
 */
function writeEpochToDisk(epoch) {
  const path = configFile();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error("config.json is not an object");
  raw.epoch = epoch;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * 自纪元 +1 并**先落盘再返回**（契约 §3.4.1：崩溃也不能复用纪元）。
 * 落盘失败抛错——调用方必须拒绝开链路（带病上线 = 重放窗口）。
 * @returns {number} 新的自纪元号
 */
export function bumpSelfEpoch() {
  const epoch = readEpochStrict();
  epoch.self += 1;
  writeEpochToDisk(epoch);
  return epoch.self;
}

/**
 * 持久化「已接受的对端纪元 + 钉扎的 sid」（回退检测的锚点，跨重启有效）。
 * @param {number} peer 对端纪元号
 * @param {string} peerSid 对端连接实例 id（8 位十六进制）
 */
export function savePeerEpoch(peer, peerSid) {
  const epoch = readEpochStrict();
  epoch.peer = peer;
  epoch.peerSid = peerSid;
  writeEpochToDisk(epoch);
  return epoch;
}
