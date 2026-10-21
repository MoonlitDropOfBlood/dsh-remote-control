// scripts/verify-pairing.mjs —— /remote-pairing 命令逻辑自检（dev-only）。
//
// 用 mock ctx + 临时 DSH_HOME + mock relay 走一遍命令全路径：
//   1. relayUrl 未配置 → error 提示「先配置 relayUrl」；
//   2. show：成功渲染（ASCII+URI+SVG 落盘、尝试打开）；
//   3. rotate：换 channel/secret 并落盘、内存同步、relay.reload 收到新配对信息、
//      旧 secret 不再出现在磁盘文件与新 URI 中；
//   4. hide：删除 pairing.svg；
//   5. 日志脱敏：全程日志里不出现 secret/token 明文（§3.5）；
//   6. 未知子命令 → error 用法提示。
//
// 用法：node scripts/verify-pairing.mjs（在 plugin/ 目录下）
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
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

// 临时数据目录（必须在 import config.mjs 前设置——dataDir() 每次调用读 env，
// 但保持先设为稳妥）
const tmpHome = mkdtempSync(join(tmpdir(), "dshrc-pairing-"));
process.env.DSH_HOME = tmpHome;

const { registerPairingCommand, buildPairingUri, pairingSvgPath, renderPairing, redactUri } = await import("../lib/pairing.mjs");
const { loadConfig } = await import("../lib/config.mjs");
const { encodeToMatrix } = await import("../lib/qr.mjs");
const jsqrMod = await import("jsqr");
const jsqr = jsqrMod.default ?? jsqrMod;

// ---- mock ctx：捕获 register 的命令 -------------------------------------------
let registered = null;
const ctx = {
  commands: {
    register(def) {
      registered = def;
      return () => {
        registered = null;
      };
    },
  },
};

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
const dispose = registerPairingCommand(ctx, deps);

check("命令已注册且 name=remote-pairing", registered?.name === "remote-pairing", String(registered?.name));
check("命令带 input hint", typeof registered?.input?.hint === "string");

const invoke = (rawInput) => registered.handler({ rawInput, agent: { session: { id: "s1" } } });

// ---- 1. relayUrl 为空 → 明确错误 ------------------------------------------------
let r = invoke("");
check("无 relayUrl 时返回 error", r?.kind === "error", JSON.stringify(r)?.slice(0, 120));
check("错误提示含「先配置 relayUrl」语义", String(r?.text).includes("relayUrl"), String(r?.text).slice(0, 160));
check("错误提示不泄露 secret", !String(r?.text).includes(oldSecret));

// ---- 2. 配置 relayUrl 后 show ---------------------------------------------------
cfg.relayUrl = "wss://relay.example.com/ws";
cfg.relayToken = "relay-token-abc";
r = invoke("");
check("show 返回 success", r?.kind === "success", String(r?.text).slice(0, 200));
check("show 文本含 ASCII 二维码（█）", String(r?.text).includes("██"));
const uriInText = String(r?.text).match(/dshrc:\/\/pair\?\S+/)?.[0] ?? "";
check("show 文本含配对 URI", uriInText.startsWith("dshrc://pair?r="), uriInText.slice(0, 60));
check("show 文本含使用说明（扫码）", String(r?.text).includes("扫码"));
check("show 文本含安全提示（rotate/hide）", String(r?.text).includes("rotate") && String(r?.text).includes("hide"));

// SVG 已落盘且可解码
const svgPath = pairingSvgPath();
check("pairing.svg 已写盘", existsSync(svgPath), svgPath);
check("路径位于临时 DSH_HOME/remote-control 下", svgPath.startsWith(tmpHome), svgPath);
// SVG → 矩阵（按 viewBox 数黑块，再用 svg 矩阵直接解码不现实——这里验证 SVG 与
// renderPairing 的输出一致性，并对同 URI 的矩阵做 jsqr 解码）
const svgText = readFileSync(svgPath, "utf8");
const uriNow = buildPairingUri(cfg);
const rendered = renderPairing(uriNow);
check("盘上 SVG 与 renderPairing 输出一致", svgText === rendered.svg);
const scale = 6, quiet = 4;
const dim = (rendered.size + quiet * 2) * scale;
const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
const qr = encodeToMatrix(uriNow);
for (let y = 0; y < qr.size; y++) {
  for (let x = 0; x < qr.size; x++) {
    if (!qr.modules[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
        rgba[px * 4] = 0;
        rgba[px * 4 + 1] = 0;
        rgba[px * 4 + 2] = 0;
      }
    }
  }
}
const svgDecoded = jsqr(rgba, dim, dim);
check("show 的 URI 可被 jsqr 解回（二维码内容正确）", svgDecoded?.data === uriNow, svgDecoded?.data?.slice(0, 60) ?? "无");

// ---- 3. rotate ------------------------------------------------------------------
const oldUri = uriNow;
reloadArgs = null;
r = invoke("rotate");
check("rotate 返回 success", r?.kind === "success", String(r?.text).slice(0, 200));
const newChannel = cfg.channel;
const newSecret = cfg.secret;
check("rotate 换了 channel", newChannel !== oldChannel, oldChannel + " -> " + newChannel);
check("rotate 换了 secret", newSecret !== oldSecret);
check("rotate 后 channel 仍合法", /^[A-Z2-7]{16,64}$/.test(newChannel));
check("rotate 调用了 relay.reload 且带新配对信息", reloadArgs?.channel === newChannel && reloadArgs?.secret === newSecret, JSON.stringify(reloadArgs && { channel: reloadArgs.channel }));
// 磁盘落盘
const diskCfg = JSON.parse(readFileSync(configPath, "utf8"));
check("新配对信息已落盘", diskCfg.channel === newChannel && diskCfg.secret === newSecret);
check("旧 secret 不在磁盘配置中（§3.5 rotate 后不保留）", !JSON.stringify(diskCfg).includes(oldSecret));
const newUriInText = String(r?.text).match(/dshrc:\/\/pair\?\S+/)?.[0] ?? "";
check("rotate 文本展示的是新 URI", newUriInText !== oldUri && newUriInText.includes(newChannel));
check("rotate 文本不再含旧 secret", !String(r?.text).includes(oldSecret));
// 落盘 SVG 已更新为新 URI
check("盘上 SVG 已是新二维码（旧二维码即失效）", readFileSync(svgPath, "utf8") === renderPairing(buildPairingUri(cfg)).svg);

// ---- 4. hide --------------------------------------------------------------------
r = invoke("hide");
check("hide 返回 success", r?.kind === "success", String(r?.text));
check("pairing.svg 已删除", !existsSync(svgPath));
r = invoke("hide");
check("重复 hide 仍 success（文件不存在）", r?.kind === "success" && String(r?.text).includes("不存在"), String(r?.text));

// ---- 5. 未知子命令 ---------------------------------------------------------------
r = invoke("bogus");
check("未知子命令返回 error 用法", r?.kind === "error" && String(r?.text).includes("用法"), String(r?.text).slice(0, 100));

// ---- 6. 日志脱敏（§3.5：URI/二维码内容不得写入日志）-----------------------------
// 日志里允许出现的 URI 形态只有 redactUri 的脱敏形式（s=***、t=***）。
const logAll = logLines.join("\n");
const fullUris = [oldUri, newUriInText].filter((u) => u.length > 0);
check("日志未出现旧 secret", !logAll.includes(oldSecret));
check("日志未出现新 secret", !logAll.includes(newSecret));
check("日志未出现 relayToken", !logAll.includes("relay-token-abc"));
check("日志未出现任何完整 URI", fullUris.every((u) => !logAll.includes(u)));
check("日志中的 URI 均为脱敏形式（含 s=***）", logAll.includes(redactUri(newUriInText)) && logAll.includes("s=***"));

// 注销
dispose();
check("dispose 后命令已注销", registered === null);

rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
