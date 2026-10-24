// scripts/verify-pairing.mjs —— 配对信息逻辑自检（dev-only，v1.1.x）。
//
// v1.1.x 起配对入口从 /remote-pairing 命令搬到 DSH 设置面板
// （Remote 方法 getPairing/rotateSecret/setHidden），命令已删。
// 这里用**临时 DSH_HOME** 走一遍新的配对 API 全路径：
//   1. buildPairingUri：格式/校验（relayUrl 缺失、channel 非法、secret 过短、relayToken 可选）；
//   2. redactUri：脱敏形态（s=***、t=***）；
//   3. renderPairing：矩阵 + ASCII + SVG；
//   4. writePairingSvg / hidePairingSvg：落盘与删除；
//   5. rotatePairingIdentity：换 channel/secret → 落盘 → 内存同步 → relay.reload，
//      旧 secret 不再出现在磁盘配置中；日志不出现 secret 明文（§3.5）；
//   6. setPairingHidden：隐藏（删盘上二维码 + 记 hidden=true）/ 恢复（重建 + hidden=false）；
//   7. 仓库里不再有 /remote-pairing 命令注册（命令已删）。
//
// 用法：node scripts/verify-pairing.mjs（在 plugin/ 目录下）
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// 临时数据目录（config.mjs 每次调用读 env，但先设稳妥）
const tmpHome = mkdtempSync(join(tmpdir(), "dshrc-pairing-"));
process.env.DSH_HOME = tmpHome;

const {
  buildPairingUri,
  pairingSvgPath,
  renderPairing,
  redactUri,
  writePairingSvg,
  hidePairingSvg,
  rotatePairingIdentity,
  setPairingHidden,
} = await import("../lib/pairing.mjs");
const { loadConfig } = await import("../lib/config.mjs");

// ---- mock 日志：全部收集（用于脱敏断言）----------------------------------------
const logLines = [];
const log = (level, message, extra) => {
  logLines.push(level + " " + message + " " + (extra ? JSON.stringify(extra) : ""));
};

// ---- mock relay：记录 reload 参数 ----------------------------------------------
let reloadArgs = null;
const mockRelay = {
  reload(o) {
    reloadArgs = o;
  },
};

// ---- 起始配置：首次 loadConfig 自动生成 channel/secret ---------------------------
let cfg = loadConfig().config;
const oldChannel = cfg.channel;
const oldSecret = cfg.secret;
check("首次 loadConfig 自动生成合法 channel", /^[A-Z2-7]{16,64}$/.test(oldChannel), oldChannel);
check("首次 loadConfig 自动生成 ≥32 字符 secret", oldSecret.length >= 32, String(oldSecret.length));

const configPath = join(tmpHome, "remote-control", "config.json");
const deps = { config: cfg, configPath, log, getRelay: () => mockRelay };

// ---- 1. buildPairingUri 校验 -----------------------------------------------------
let threw = null;
try {
  buildPairingUri({ relayUrl: "", channel: oldChannel, secret: oldSecret });
} catch (e) {
  threw = e;
}
check("relayUrl 缺失时抛错并提示先配置", !!threw && String(threw.message).includes("relayUrl"), String(threw && threw.message).slice(0, 120));

threw = null;
try {
  buildPairingUri({ relayUrl: "wss://relay.example.com/ws", channel: "bad-channel", secret: oldSecret });
} catch (e) {
  threw = e;
}
check("channel 非法时抛错", !!threw && String(threw.message).includes("channel"), String(threw && threw.message).slice(0, 120));

threw = null;
try {
  buildPairingUri({ relayUrl: "wss://relay.example.com/ws", channel: oldChannel, secret: "short" });
} catch (e) {
  threw = e;
}
check("secret 过短时抛错", !!threw && String(threw.message).includes("secret"), String(threw && threw.message).slice(0, 120));

// ---- 2. URI 格式（§3.5）--------------------------------------------------------
cfg.relayUrl = "wss://relay.example.com/ws";
cfg.relayToken = "relay-token-abc";
const uri = buildPairingUri(cfg);
check("URI 前缀为 dshrc://pair?", uri.startsWith("dshrc://pair?r="), uri.slice(0, 40));
check("URI 含 URL 编码后的 relayUrl", uri.includes("r=" + encodeURIComponent(cfg.relayUrl)), uri.slice(0, 80));
check("URI 含 channel", uri.includes("&c=" + cfg.channel));
check("URI 含 secret", uri.includes("&s=" + cfg.secret));
check("URI 含 relayToken（可选段）", uri.includes("&t=" + encodeURIComponent(cfg.relayToken)));

// ---- 3. redactUri 脱敏 ----------------------------------------------------------
const redacted = redactUri(uri);
check("redactUri 抹掉 secret", !redacted.includes(cfg.secret) && redacted.includes("s=***"), redacted);
check("redactUri 抹掉 relayToken", !redacted.includes(cfg.relayToken) && redacted.includes("t=***"), redacted);
check("redactUri 保留 relayUrl 与 channel", redacted.includes(encodeURIComponent(cfg.relayUrl)) && redacted.includes(cfg.channel));

// ---- 4. renderPairing ------------------------------------------------------------
const rendered = renderPairing(uri);
check("renderPairing 返回 version/size", typeof rendered.version === "number" && rendered.size > 0, String(rendered.size));
check("renderPairing 返回 SVG", typeof rendered.svg === "string" && rendered.svg.includes("<svg"), rendered.svg.slice(0, 40));
check("renderPairing 返回 ASCII", typeof rendered.ascii === "string" && rendered.ascii.includes("█"), rendered.ascii.slice(0, 20));

// ---- 5. 落盘 / 删除 pairing.svg -------------------------------------------------
const svgPath = pairingSvgPath();
check("pairingSvgPath 位于临时 DSH_HOME/remote-control 下", svgPath.startsWith(tmpHome), svgPath);
const written = writePairingSvg(rendered.svg);
check("writePairingSvg 返回路径", written === svgPath, written);
check("pairing.svg 已写盘", existsSync(svgPath));
check("盘上 SVG 与 renderPairing 输出一致", readFileSync(svgPath, "utf8") === rendered.svg);
const removed = hidePairingSvg();
check("hidePairingSvg 报告已删除", removed.removed === true && !existsSync(svgPath));
const removedAgain = hidePairingSvg();
check("重复 hide 不报错（文件不存在）", removedAgain.removed === false && !existsSync(svgPath));

// ---- 6. rotatePairingIdentity ----------------------------------------------------
reloadArgs = null;
const rot = rotatePairingIdentity(deps);
check("rotate 返回 ok", rot.ok === true, JSON.stringify(rot).slice(0, 160));
const newChannel = cfg.channel;
const newSecret = cfg.secret;
check("rotate 换了 channel", newChannel !== oldChannel, oldChannel + " -> " + newChannel);
check("rotate 换了 secret", newSecret !== oldSecret);
check("rotate 后 channel 仍合法", /^[A-Z2-7]{16,64}$/.test(newChannel));
check("rotate 调用 relay.reload 且带新配对信息", reloadArgs?.channel === newChannel && reloadArgs?.secret === newSecret, JSON.stringify(reloadArgs && { channel: reloadArgs.channel }));
check("rotate 返回 note", typeof rot.note === "string" && rot.note.length > 0);
const diskCfg = JSON.parse(readFileSync(configPath, "utf8"));
check("新配对信息已落盘", diskCfg.channel === newChannel && diskCfg.secret === newSecret);
check("旧 secret 不在磁盘配置中（rotate 后不保留）", !JSON.stringify(diskCfg).includes(oldSecret));
const newUri = buildPairingUri(cfg);
check("新 URI 含新 channel 且不含旧 secret", newUri.includes(newChannel) && !newUri.includes(oldSecret));

// ---- 7. setPairingHidden ---------------------------------------------------------
writePairingSvg(renderPairing(newUri).svg);
const hid = setPairingHidden(true, { config: cfg, log });
check("hide 返回 ok", hid.ok === true, JSON.stringify(hid).slice(0, 120));
check("hide 后盘上 pairing.svg 已删除", !existsSync(svgPath));
check("hide 后内存 cfg.hidden=true", cfg.hidden === true);
check("hide 已落盘 hidden=true", JSON.parse(readFileSync(configPath, "utf8")).hidden === true);

const shown = setPairingHidden(false, { config: cfg, log });
check("show 返回 ok", shown.ok === true, JSON.stringify(shown).slice(0, 120));
check("show 后内存 cfg.hidden=false", cfg.hidden === false);
check("show 已落盘 hidden=false", JSON.parse(readFileSync(configPath, "utf8")).hidden === false);
check("show 后盘上 pairing.svg 已重建", existsSync(svgPath));
check("重建的 SVG 是当前配对信息", readFileSync(svgPath, "utf8") === renderPairing(buildPairingUri(cfg)).svg);
check("pairing.svg 非空", statSync(svgPath).size > 100);

// ---- 8. 日志脱敏（§3.5：URI/二维码内容不得写入日志）-----------------------------
const logAll = logLines.join("\n");
check("日志未出现旧 secret", !logAll.includes(oldSecret));
check("日志未出现新 secret", !logAll.includes(newSecret));
check("日志未出现 relayToken", !logAll.includes("relay-token-abc"));
check("日志未出现任何完整 URI", !logAll.includes(uri) && !logAll.includes(newUri));

// ---- 9. 命令已删（v1.1.x）--------------------------------------------------------
// 注意：这里只断言**注册行为**消失，文档注释里提到旧命令名是允许的。
const pairingSrc = readFileSync(new URL("../lib/pairing.mjs", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../index.js", import.meta.url), "utf8");
check(
  "pairing.mjs 不再注册命令（无 commands.register / registerPairingCommand）",
  !pairingSrc.includes("commands.register") &&
    !pairingSrc.includes("registerPairingCommand") &&
    !/name\s*:\s*["']remote-pairing["']/.test(pairingSrc),
);
check(
  "index.js 不再注册 /remote-pairing 命令（无 commands 注入 / 无注册调用）",
  !indexSrc.includes("registerPairingCommand") &&
    !/ctx\.inject\(\[\s*["']commands["']/.test(indexSrc) &&
    !/name\s*:\s*["']remote-pairing["']/.test(indexSrc),
);

rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
