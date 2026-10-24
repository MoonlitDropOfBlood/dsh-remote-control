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
    /** 中继自身鉴权 token（可选，部署方配置 RELAY_TOKEN 时填写）。 */
    relayToken: "",
    /** 配对 channel / secret（首次启动生成；手机端配对页输入同样值）。 */
    channel: "",
    secret: "",
    /** 配对是否隐藏（设置页「隐藏配对」）：true 时界面不展示二维码。 */
    hidden: false,
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
 */
export function saveConfig(config) {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  renameSync(tmp, path);
  return path;
}
