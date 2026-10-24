// lib/pairing.mjs —— 配对二维码（契约 §3.5，v1.0.3；v1.1.x 入口搬到设置面板）。
//
// 职责：
//   1. buildPairingUri：按 §3.5 逐字组装
//        dshrc://pair?r=<encodeURIComponent(relayUrl)>&c=<channel>&s=<secret>[&t=<encodeURIComponent(relayToken)>]
//      relayUrl 为空时抛出带明确指引的错误（先配置 relayUrl）。
//   2. 渲染产物：矩阵 + SVG（设置面板注入 qrSvg；ASCII 供终端参考）。
//   3. rotatePairingIdentity / setPairingHidden：轮换配对信息、隐藏/恢复配对
//      （v1.1.x：入口是 DSH 设置面板的 Remote 方法，命令已删；逻辑留在这里复用）。
//
// **安全**：URI/二维码内容含 secret 明文，**绝不写日志**——日志只允许 redactUri 的脱敏形式。
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, generateChannel, generateSecret, loadConfig, saveConfig } from "./config.mjs";
import { encodeToMatrix, toAscii, toSvg } from "./qr.mjs";

/** 二维码 SVG 文件名（位于 dataDir() 下）。 */
export const PAIRING_SVG_NAME = "pairing.svg";

/** pairing.svg 的绝对路径。 */
export function pairingSvgPath() {
  return join(dataDir(), PAIRING_SVG_NAME);
}

/**
 * 按契约 §3.5 组装配对 URI。
 * @param {{relayUrl:string, channel:string, secret:string, relayToken?:string}} cfg
 * @returns {string} dshrc://pair?...
 */
export function buildPairingUri(cfg) {
  const relayUrl = typeof cfg?.relayUrl === "string" ? cfg.relayUrl.trim() : "";
  if (relayUrl === "") {
    throw new Error(
      "relayUrl 尚未配置：请先在 config.json（" +
        join(dataDir(), "config.json") +
        "）里设置 relayUrl（如 wss://relay.example.com/ws），再生成配对二维码。",
    );
  }
  const channel = typeof cfg?.channel === "string" ? cfg.channel : "";
  if (!/^[A-Z2-7]{16,64}$/.test(channel)) {
    throw new Error("channel 不符合 ^[A-Z2-7]{16,64}$（应由插件自动生成；config.json 被改坏时可删除后重启插件重建）。");
  }
  const secret = typeof cfg?.secret === "string" ? cfg.secret : "";
  if (secret.length < 32) {
    throw new Error("secret 无效（应为 ≥32 字符的 base64url 串；config.json 被改坏时可删除后重启插件重建）。");
  }
  // §3.5：r 必须 URL 编码；c/s 为 URL 安全字符集无需编码；t 可选、同样编码。
  let uri = "dshrc://pair?r=" + encodeURIComponent(relayUrl) + "&c=" + channel + "&s=" + secret;
  const relayToken = typeof cfg?.relayToken === "string" ? cfg.relayToken : "";
  if (relayToken !== "") uri += "&t=" + encodeURIComponent(relayToken);
  return uri;
}

/**
 * 日志脱敏（§3.5：URI/二维码内容不得写入日志）。保留形状、抹掉 secret/token。
 * @param {string} uri
 */
export function redactUri(uri) {
  return String(uri)
    .replace(/([?&]s=)[^&]*/g, "$1***")
    .replace(/([?&]t=)[^&]*/g, "$1***");
}

/**
 * 渲染配对二维码（矩阵 + ASCII + SVG）。
 * @param {string} uri
 * @returns {{uri:string, version:number, size:number, ascii:string, svg:string}}
 */
export function renderPairing(uri) {
  const qr = encodeToMatrix(uri);
  return {
    uri,
    version: qr.version,
    size: qr.size,
    ascii: toAscii(qr),
    svg: toSvg(qr),
  };
}

/**
 * 把 SVG 写到 %DSH_HOME%/remote-control/pairing.svg（原子写：tmp + rename）。
 * @param {string} svg
 * @returns {string} 写入路径
 */
export function writePairingSvg(svg) {
  const path = pairingSvgPath();
  mkdirSync(dataDir(), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, svg, "utf8");
  // 同目录 rename（与 config.mjs 同一原子写范式）；Windows 上 rename 覆盖
  // 已存在目标前先 unlink，规避个别版本的 EPERM。
  try {
    unlinkSync(path);
  } catch {
    /* 目标不存在即可 */
  }
  renameSync(tmp, path);
  return path;
}

/** 删除 pairing.svg（§3.5 隐藏能力）。@returns {{removed:boolean, path:string}} */
export function hidePairingSvg() {
  const path = pairingSvgPath();
  try {
    unlinkSync(path);
    return { removed: true, path };
  } catch {
    return { removed: false, path };
  }
}

/**
 * 用系统默认程序打开文件（win32: cmd /c start ""；macOS: open；linux: xdg-open）。
 * 失败只返回 false，绝不抛出、绝不阻塞命令。
 * v1.1.x：/remote-pairing 命令已删，这里暂留为通用工具（设置页未来加「打开配对文件」
 * 按钮时可直接用；当前无调用方）。
 * @param {string} path
 * @returns {boolean} 是否成功发起（不代表程序已打开）
 */
export function openFileDefault(path) {
  try {
    const quoted = '"' + String(path).replace(/"/g, '\\"') + '"';
    let child;
    if (process.platform === "win32") {
      child = spawn("cmd /c start \"\" " + quoted, { shell: true, detached: true, stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      child = spawn("open " + quoted, { shell: true, detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open " + quoted, { shell: true, detached: true, stdio: "ignore" });
    }
    child.on("error", () => {
      /* 打开失败不影响命令回复 */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮换配对信息（契约 §3.5 rotate）：换 channel+secret → 落盘 → 内存同步 →
 * 链路热更换（旧 secret 不再保留，旧二维码立即失效）。
 * @param {{config:any, configPath:string, log:Function, getRelay:()=>({reload?:(o:object)=>void}|null)}} deps
 * @returns {{ok:boolean, channel?:string, savedPath?:string, note?:string, error?:string}}
 */
export function rotatePairingIdentity(deps) {
  const { config: cfg, configPath, log, getRelay } = deps;
  const newChannel = generateChannel();
  const newSecret = generateSecret();
  // 只把 channel/secret 写回磁盘配置（磁盘文件为准，避免把行内紧急覆盖持久化）
  let savedPath = "";
  try {
    const fresh = loadConfig().config;
    fresh.channel = newChannel;
    fresh.secret = newSecret;
    savedPath = saveConfig(fresh);
  } catch (e) {
    return {
      ok: false,
      error: "配对信息已生成但保存失败：" + String(e && e.message) + "（请检查 " + configPath + "）",
    };
  }
  // 内存配置同步更新（HostBridge 等持有同一对象）
  cfg.channel = newChannel;
  cfg.secret = newSecret;
  // 链路热更换（§3.5：旧 secret 不再保留，旧二维码立即失效）
  const relay = getRelay();
  let note;
  if (relay && typeof relay.reload === "function") {
    try {
      relay.reload({ channel: newChannel, secret: newSecret, relayToken: cfg.relayToken });
      note = "中继链路已用新配对信息重连；旧配对信息（及旧二维码）即刻失效。";
    } catch (e) {
      log("warn", "relay reload after rotate failed", { error: String(e && e.message) });
      note = "链路重连失败（" + String(e && e.message) + "）——请用 plugin_manager 重载本插件。";
    }
  } else {
    note = "当前链路未启用（未配置 relayUrl / 插件空转 / KAT 失败），新配对信息将在下次连接时生效。";
  }
  // §3.5：只记 channel 与落盘路径，**不记 secret**
  log("info", "pairing identity rotated", { channel: newChannel, savedPath });
  return { ok: true, channel: newChannel, savedPath, note };
}

/**
 * 隐藏 / 恢复配对（对应原 /remote-pairing hide 的语义）：
 *   hidden=true  → 删除本机 pairing.svg，并把 hidden=true 记进 config（设置页不再展示二维码）；
 *   hidden=false → 重新生成并落盘 pairing.svg，hidden=false。
 * @param {boolean} hidden
 * @param {{config:any, log:Function}} deps
 * @returns {{ok:boolean, hidden?:boolean, path?:string, removed?:boolean, error?:string}}
 */
export function setPairingHidden(hidden, deps) {
  const { config: cfg, log } = deps;
  const want = hidden === true;
  try {
    const fresh = loadConfig().config;
    fresh.hidden = want;
    saveConfig(fresh);
  } catch (e) {
    return { ok: false, error: "配对隐藏状态保存失败：" + String(e && e.message) };
  }
  cfg.hidden = want;
  if (want) {
    const { removed, path } = hidePairingSvg();
    log("info", "pairing hidden", { removed, path });
    return { ok: true, hidden: true, removed, path };
  }
  // 恢复：重新渲染并落盘（失败不致命——设置页仍可直接展示内联二维码）
  let path = "";
  try {
    const uri = buildPairingUri(cfg);
    path = writePairingSvg(renderPairing(uri).svg);
  } catch (e) {
    log("warn", "pairing svg rewrite failed", { error: String(e && e.message) });
  }
  log("info", "pairing shown", { path: path || "(none)" });
  return { ok: true, hidden: false, path };
}
