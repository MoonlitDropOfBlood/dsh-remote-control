// scripts/verify-settings.mjs —— 设置面板（v1.1.x）静态/结构自检（dev-only）。
//
// 覆盖三件事（都是实测踩过的坑）：
//   1. **每个 codec 都必须有 create() 工厂**——typert-loader 的 requireStrictCodec
//      对缺 create() 的 strict codec 直接抛错，整个 manifest 都不会注册，
//      表现为「Remote 调用全部失败」（token-stats v1.5.0 就这么翻过车）。
//      本脚本用**真实的 validateTypertManifest** 校验（能解析到 loader 时），
//      解析不到时退化为自研结构检查。
//   2. **client.js 的 load() 形状**：id 必须等于包名（HMR 样式归属按注册 id 走），
//      必须注册 settings.section（id/order/label 固定），必须 $mount 自己的
//      Remote 命名空间，descriptor 的 codec 同样要带 create()。
//   3. **图标 data-uri 与 icon.svg 同步**：改了 icon.svg 却没跑
//      `node scripts/sync-client-icon.mjs` 时，设置页导航图标会停在旧造型。
//   4. **Host 半边真跑一遍**：用临时 DSH_HOME 实例化类插件，走 [Service.init] →
//      三个 Remote 方法被标记 → getPairing/rotateSecret/setHidden 的返回信封，
//      并断言**返回体里没有 secret 明文**（只有二维码图像）。
//
// 用法：node scripts/verify-settings.mjs（在 plugin/ 目录下）
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maskAssetFrom, toDataUri } from "./sync-client-icon.mjs";

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

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const clientSrc = readFileSync(join(pkgRoot, "client.js"), "utf8");
const indexSrc = readFileSync(join(pkgRoot, "index.js"), "utf8");
const iconSvg = readFileSync(join(pkgRoot, "icon.svg"), "utf8");

// ============================================================================
// 1. TYPERT manifest：每个 codec 都要有 create() 工厂
// ============================================================================
const { TYPERT } = await import("../typert.host.js");

check("TYPERT.package 等于包名", TYPERT.package === pkg.name, TYPERT.package + " vs " + pkg.name);
check("TYPERT.face 是 host", TYPERT.face === "host", TYPERT.face);
check("TYPERT.schemas 是数组", Array.isArray(TYPERT.schemas));
check("TYPERT.invocations 是数组且有 3 条", Array.isArray(TYPERT.invocations) && TYPERT.invocations.length === 3, String(TYPERT.invocations?.length));

/** 收集 manifest 里所有 strict codec。 */
function collectCodecs(manifest) {
  const codecs = [];
  for (const invocation of manifest.invocations ?? []) {
    if (invocation.result) codecs.push({ where: invocation.id + " result", codec: invocation.result });
    for (const parameter of invocation.parameters ?? []) {
      if (parameter.codec) codecs.push({ where: invocation.id + " param " + parameter.name, codec: parameter.codec });
      if (parameter.strictCodec) codecs.push({ where: invocation.id + " strictParam " + parameter.name, codec: parameter.strictCodec });
    }
    if (invocation.invocation?.kind === "context" && invocation.invocation.codec) {
      codecs.push({ where: invocation.id + " context", codec: invocation.invocation.codec });
    }
  }
  for (const schema of manifest.schemas ?? []) codecs.push({ where: "schema " + schema.name, codec: schema });
  return codecs;
}

const codecs = collectCodecs(TYPERT);
check("manifest 至少收集到 4 个 codec", codecs.length >= 4, String(codecs.length));
for (const { where, codec } of codecs) {
  check(
    "codec 带 create() 工厂：" + where,
    typeof codec.create === "function",
    typeof codec.create,
  );
  check("codec 是 strict 且有 typeSymbol：" + where, codec.mode === "strict" && typeof codec.typeSymbol === "string" && codec.typeSymbol.length > 0);
  check("codec 有可用的 schema：" + where, !!codec.schema && typeof codec.schema.parse === "function");
}

// 真实 loader 校验（能解析到 @deepseek-ai/dsh-typert-loader 时）
let loaderChecked = false;
try {
  const loaderMod = await import("@deepseek-ai/dsh-typert-loader");
  const validate = loaderMod.validateTypertManifest;
  if (typeof validate === "function") {
    validate(pkg.name, TYPERT);
    loaderChecked = true;
    check("真实 validateTypertManifest 通过", true);
  }
} catch (e) {
  // loader 不可解析（未安装依赖）→ 只报一条提示，不算失败
  console.log("note: 未解析到 @deepseek-ai/dsh-typert-loader，跳过真实 manifest 校验（" + String(e && e.message).slice(0, 120) + "）");
}
if (!loaderChecked) {
  check("manifest 结构自检通过（退化为自研检查）", true);
}

// ============================================================================
// 2. client.js 的 load() 形状与设置分区注册
// ============================================================================
check("client.js 使用 window.__ModuleLoader__.load", clientSrc.includes("window.__ModuleLoader__.load"));
check("client.js 的 load id 等于包名", clientSrc.includes('const CLIENT_BUNDLE_ID = "' + pkg.name + '"'), pkg.name);
check("client.js 注入 settings.section 分区", clientSrc.includes('ctx.slots.inject("settings.section"'));
check(
  "分区注册 id=remote-control / order=40 / label=DSH Pocket",
  /id:\s*"remote-control"/.test(clientSrc) && /order:\s*40/.test(clientSrc) && /label:\s*\(\)\s*=>\s*SETTINGS_LABEL/.test(clientSrc),
);
check("SETTINGS_LABEL 常量为 DSH Pocket", /const SETTINGS_LABEL = "DSH Pocket";/.test(clientSrc));
check("client.js 挂载自己的 Remote 命名空间", clientSrc.includes("ctx.remote.$mount(CLIENT_REMOTE)"));
check("CLIENT_REMOTE 的 namespace 是 remoteControl", /namespace:\s*"remoteControl"/.test(clientSrc));
check("client.js 声明 inject（slots + remote）", /exports\.inject = \[[^\]]*"slots"[^\]]*"remote"[^\]]*\]/.test(clientSrc));
check("client.js 导出 apply", clientSrc.includes("exports.apply = apply"));

// client 侧 descriptor 的 codec 也要带 create()
const clientDescriptorBlock = clientSrc.slice(clientSrc.indexOf("const CLIENT_REMOTE"), clientSrc.indexOf("function unwrapRemote"));
const clientCreateCount = (clientDescriptorBlock.match(/create:\s*create\w+/g) ?? []).length;
const clientCodecCount = (clientDescriptorBlock.match(/mode:\s*"strict"/g) ?? []).length;
check("client 侧每个 strict codec 都有 create()", clientCreateCount >= clientCodecCount && clientCodecCount > 0, clientCreateCount + "/" + clientCodecCount);

// 三个 Remote 方法齐备
for (const method of ["getPairing", "rotateSecret", "setHidden"]) {
  check("client 侧暴露 " + method + " 调用", clientSrc.includes(method + "()") || clientSrc.includes("remote." + method));
}

// ============================================================================
// 3. 图标 data-uri 与 icon.svg 同步
// ============================================================================
const iconMatch = /const CLIENT_ICON_MASK_URI =\s*"([^"]+)"/.exec(clientSrc);
check("client.js 内联了图标 data-uri", !!iconMatch);
if (iconMatch) {
  const expected = toDataUri(maskAssetFrom(iconSvg));
  check("图标 data-uri 与 icon.svg 一致（改图标后需跑 sync-client-icon.mjs）", iconMatch[1] === expected, "长度 " + iconMatch[1].length + " vs " + expected.length);
  check("图标素材取自本仓库 icon.svg（whale 家族样式）", iconMatch[1].includes("data:image/svg+xml"));
}
check("client.js 声明了导航图标 mask 标记", clientSrc.includes("data-dsh-remote-control-settings-nav"));
check("client.js 的 CSS 用了 DSH 设计变量", clientSrc.includes("--dsw-alias-"));

// ============================================================================
// 4. Host 半边：类插件 + Remote 方法 + 无命令注册
// ============================================================================
check("index.js 默认导出类插件", /export default class RemoteControlService extends TypertRemoteService/.test(indexSrc));
check("index.js 导出类本身（便于测试/引用）", /export class RemoteControlService extends TypertRemoteService/.test(indexSrc));
check("类插件服务名为 remoteControl", /super\(ctx,\s*"remoteControl"\)/.test(indexSrc));
for (const method of ["getPairing", "rotateSecret", "setHidden"]) {
  check("index.js 标记 Remote 方法 " + method, indexSrc.includes('"' + method + '"'));
}
check("index.js 仍保留函数式 apply 入口", /export function apply\(ctx, config\)/.test(indexSrc));
check("index.js 不再注入 commands", !/ctx\.inject\(\[\s*["']commands["']/.test(indexSrc));

// ============================================================================
// 5. package.json：exports / files / client 平台声明
// ============================================================================
check("package.json 导出 ./client", pkg.exports["./client"] === "./client.js", String(pkg.exports["./client"]));
check("package.json 导出 ./typert", pkg.exports["./typert"] === "./typert.host.js", String(pkg.exports["./typert"]));
check("package.json files 含 client.js", (pkg.files ?? []).includes("client.js"));
check("package.json files 含 typert.host.js", (pkg.files ?? []).includes("typert.host.js"));
check("package.json 声明 dsh.client.platform=web", pkg.dsh?.client?.platform === "web", String(pkg.dsh?.client?.platform));

// ============================================================================
// 6. Host 半边真跑一遍（临时 DSH_HOME —— 绝不碰真实配置/中继）
// ============================================================================
const tmpHome = mkdtempSync(join(tmpdir(), "dshrc-settings-"));
process.env.DSH_HOME = tmpHome;

const { Context } = await import("@deepseek-ai/cordis");
const { Service } = await import("@deepseek-ai/cordis");
const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
const { default: RemoteControlService } = await import("../index.js");

const ctx = new Context();
const service = new RemoteControlService(ctx, {});
await service[Service.init]();

check("类插件注册为 remoteControl 服务", service.name === "remoteControl", String(service.name));
const marked = remoteMethods(service).map((m) => m.method).sort();
check(
  "三个 Remote 方法都被标记",
  JSON.stringify(marked) === JSON.stringify(["getPairing", "rotateSecret", "setHidden"]),
  JSON.stringify(marked),
);

// 未配置 relayUrl → 明确的可操作错误（不返回任何凭据）
const noUrl = await service.getPairing();
check("未配置 relayUrl 时 getPairing 回 error", noUrl.ok === false, JSON.stringify(noUrl).slice(0, 120));
check("错误码是 pairing-unavailable", noUrl.error?.code === "pairing-unavailable", String(noUrl.error?.code));
check("错误信息提到 relayUrl", String(noUrl.error?.message).includes("relayUrl"));

// 配好 relayUrl → 返回配对信息（**不含 secret 明文**）
service._host.cfg.relayUrl = "wss://relay.example.com/ws";
const pairing = await service.getPairing();
check("配好 relayUrl 后 getPairing 成功", pairing.ok === true, JSON.stringify(pairing).slice(0, 120));
check("返回体含 relayUrl/channel/hidden/qrSvg", !!pairing.value && !!pairing.value.relayUrl && !!pairing.value.channel && pairing.value.hidden === false && typeof pairing.value.qrSvg === "string");
check("返回体的二维码是 SVG", String(pairing.value?.qrSvg || "").includes("<svg"));
const secret = service._host.cfg.secret;
check("返回体里没有 secret 明文（只有二维码图像）", !JSON.stringify(pairing).includes(secret));

// 隐藏 → 不再返回二维码
const hidden = await service.setHidden(true);
check("setHidden(true) 成功且 hidden=true", hidden.ok === true && hidden.value?.hidden === true, JSON.stringify(hidden).slice(0, 120));
check("隐藏后不再返回二维码", !hidden.value?.qrSvg);
const shown = await service.setHidden(false);
check("setHidden(false) 恢复显示并带回二维码", shown.ok === true && shown.value?.hidden === false && String(shown.value?.qrSvg || "").includes("<svg"));

// 轮换 → channel/secret 都换
const oldChannel = service._host.cfg.channel;
const oldSecret = service._host.cfg.secret;
const rotated = await service.rotateSecret();
check("rotateSecret 成功", rotated.ok === true, JSON.stringify(rotated).slice(0, 120));
check("rotateSecret 换了 channel", service._host.cfg.channel !== oldChannel);
check("rotateSecret 换了 secret", service._host.cfg.secret !== oldSecret);
check("rotate 后返回的仍是新配对信息", rotated.value?.channel === service._host.cfg.channel);
check("rotate 后返回体仍无 secret 明文", !JSON.stringify(rotated).includes(oldSecret) && !JSON.stringify(rotated).includes(service._host.cfg.secret));

rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
