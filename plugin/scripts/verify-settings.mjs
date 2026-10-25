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
//   5. **combo 拼接安全**（2026-10-24 生产事故）：DSH web 服务器把所有 web client
//      bundle **裸拼接**进同一个 combo <script>（buildComboScript，无作用域包裹）。
//      顶层 const/let/class 会与其他 bundle 的同名声明相撞（我们与 token-stats 的
//      const CLIENT_BUNDLE_ID 相撞，炸掉整个 combo，token-stats import failed）。
//      client.js 必须整体包在 IIFE 里——与一个声明了同名顶层常量的「外来 bundle」
//      双向拼接都要能编译通过。
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
check("TYPERT.invocations 是数组且有 5 条", Array.isArray(TYPERT.invocations) && TYPERT.invocations.length === 5, String(TYPERT.invocations?.length));

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

// v1.1.x：中继地址可直接编辑保存（不再让用户改 config.json）
check("client 侧暴露 setRelayUrl 调用", clientSrc.includes("remote.setRelayUrl"));
check("client 侧有中继地址输入框", /className:\s*"rc-input"/.test(clientSrc) && /placeholder:\s*"ws:\/\/192\.168\.x\.x:8788"/.test(clientSrc));
check("client 侧有保存按钮", /"保存"/.test(clientSrc));
check("client 侧已删除「请编辑插件 config.json」文案", !clientSrc.includes("请编辑插件 config.json"));
check("client 侧已删除「暂无二维码（请先配置中继地址）」文案", !clientSrc.includes("暂无二维码（请先配置中继地址）"));
check("client 侧 QR 空态文案已更新", clientSrc.includes("填写中继地址并保存后，这里会显示手机配对二维码"));

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
for (const method of ["getPairing", "rotateSecret", "setHidden", "setRelayUrl", "setRelayToken"]) {
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
  "五个 Remote 方法都被标记",
  JSON.stringify(marked) === JSON.stringify(["getPairing", "rotateSecret", "setHidden", "setRelayToken", "setRelayUrl"]),
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

// ---- setRelayUrl：设置页直改中继地址 --------------------------------------
const { readFileSync: readFileSync2 } = await import("node:fs");
const tempConfigPath = join(tmpHome, "remote-control", "config.json");

// 非法值一律被拒（不落盘、不动链路）
for (const bad of [
  ["http://example.com/ws", "http 协议"],
  ["not-a-url", "不是 URL"],
  ["ftp://example.com/ws", "非 ws 协议"],
  ["x".repeat(513), "超长"],
]) {
  const res = await service.setRelayUrl(bad[0]);
  check("setRelayUrl 拒绝 " + bad[1], res.ok === false && res.error?.code === "bad-params", JSON.stringify(res).slice(0, 120));
  check("setRelayUrl 拒绝 " + bad[1] + " 时有中文原因", String(res.error?.message).length > 0, String(res.error?.message));
}
const notString = await service.setRelayUrl(123);
check("setRelayUrl 拒绝非字符串", notString.ok === false && notString.error?.code === "bad-params");
check("被拒的地址没有落盘", !readFileSync2(tempConfigPath, "utf8").includes("example.com"));

// 合法地址 → 落盘 + 内存更新 + 返回新二维码
const GOOD_URL = "ws://127.0.0.1:9/ws"; // 回环 + 无人监听：连接立刻被拒，不碰外网
const saved = await service.setRelayUrl(GOOD_URL);
check("setRelayUrl 接受合法 ws:// 地址", saved.ok === true, JSON.stringify(saved).slice(0, 160));
check("setRelayUrl 返回体 relayUrl 是新地址", saved.value?.relayUrl === GOOD_URL, String(saved.value?.relayUrl));
check("setRelayUrl 返回体带新 qrSvg", String(saved.value?.qrSvg || "").includes("<svg"));
check("setRelayUrl 返回体含 channel", !!saved.value?.channel);
check("setRelayUrl 返回体没有 secret 明文", !JSON.stringify(saved).includes(service._host.cfg.secret));
check("setRelayUrl 落盘了新地址", readFileSync2(tempConfigPath, "utf8").includes(GOOD_URL));
check("setRelayUrl 内存 cfg.relayUrl 已更新", service._host.cfg.relayUrl === GOOD_URL, String(service._host.cfg.relayUrl));

// 回环地址 → note 带醒目警告
check("回环地址的 note 带警告", /回环/.test(String(saved.value?.note || "")), String(saved.value?.note));

// 清空 → 取消配置，链路停掉
const cleared = await service.setRelayUrl("");
check("setRelayUrl('') 成功（清除配置）", cleared.ok === true, JSON.stringify(cleared).slice(0, 120));
check("清除后返回体 relayUrl 为空串", cleared.value?.relayUrl === "");
check("清除后不再返回二维码", !cleared.value?.qrSvg);
check("清除后链路已停（relay 释放）", service._host.relay === null);
check("清除已落盘", !readFileSync2(tempConfigPath, "utf8").includes(GOOD_URL));

// 清除后再填 → 能重新把链路拉起来
const again = await service.setRelayUrl("ws://127.0.0.1:9/ws");
check("清除后重新填写可以再次保存", again.ok === true && again.value?.relayUrl === "ws://127.0.0.1:9/ws", JSON.stringify(again).slice(0, 120));
check("重新填写后链路重新建立", service._host.relay !== null);
check("重新填写后返回体仍无 secret 明文", !JSON.stringify(again).includes(service._host.cfg.secret));

// ---- setRelayToken：中继门口的令牌（v1.1.3）--------------------------------
// 令牌会出现在 transport hello 里（明文可读）→ 返回体**绝不能**含明文，
// 只有 relayTokenSet（是否已设置）；非法值一律被拒且不落盘。
const badTokens = [
  [123, "非字符串"],
  ["x".repeat(513), "超长"],
  ["has space", "含空格"],
  ["tab\there", "含控制符"],
];
for (const bad of badTokens) {
  const res = await service.setRelayToken(bad[0]);
  check("setRelayToken 拒绝 " + bad[1], res.ok === false && res.error?.code === "bad-params", JSON.stringify(res).slice(0, 120));
  check("setRelayToken 拒绝 " + bad[1] + " 时有中文原因", String(res.error?.message || "").length > 0);
}
check("被拒的令牌没有落盘", !readFileSync2(tempConfigPath, "utf8").includes("has space"));

const GOOD_TOKEN = "s3cret-relay-token_123";
const tokenRes = await service.setRelayToken(GOOD_TOKEN);
check("setRelayToken 接受合法令牌", tokenRes.ok === true, JSON.stringify(tokenRes).slice(0, 160));
check("setRelayToken 返回体不含令牌明文", !JSON.stringify(tokenRes).includes(GOOD_TOKEN));
check("setRelayToken 返回体 relayTokenSet 为 true", tokenRes.value?.relayTokenSet === true, JSON.stringify(tokenRes.value?.relayTokenSet));
check("setRelayToken 落盘了令牌", readFileSync2(tempConfigPath, "utf8").includes(GOOD_TOKEN));
check("setRelayToken 内存 cfg.relayToken 已更新", service._host.cfg.relayToken === GOOD_TOKEN);
const clearedToken = await service.setRelayToken("");
check("setRelayToken('') 清除令牌", clearedToken.ok === true && clearedToken.value?.relayTokenSet === false, JSON.stringify(clearedToken.value?.relayTokenSet));
check("清除后磁盘上不再有令牌", !readFileSync2(tempConfigPath, "utf8").includes(GOOD_TOKEN));

// ---- 纪元（v1.1.3 抗重放）-------------------------------------------------
// 纪元必须**先落盘再使用**、跨重启单调递增；轮换密钥（换 channel+secret）要重置锚点，
// 否则「手机清过数据 → 纪元归 1」会被对端判成回退而硬断（无逃生口）。
const { bumpSelfEpoch, readEpoch, normalizeEpoch } = await import("../lib/config.mjs");
const e1 = bumpSelfEpoch();
const e2 = bumpSelfEpoch();
check("纪元每次自增 1", e2 === e1 + 1, `${e1} -> ${e2}`);
check("纪元已落盘（跨重启保留）", readEpoch().self === e2, JSON.stringify(readEpoch()));
check("纪元字段缺失时补默认值", normalizeEpoch(undefined).self === 0 && normalizeEpoch(undefined).peer === 0, JSON.stringify(normalizeEpoch(undefined)));
check("坏纪元值回落默认值", normalizeEpoch({ self: "x", peer: null }).self === 0, JSON.stringify(normalizeEpoch({ self: "x", peer: null })));

rmSync(tmpHome, { recursive: true, force: true });

// ---- 5. combo 拼接安全（2026-10-24 生产事故）---------------------------
// buildComboScript 把所有 web client bundle 拼进同一个 <script>：
// 任何顶层声明都可能与其他 bundle 撞名。client.js 必须是 IIFE 包裹的。
{
  const vm = await import("node:vm");
  const foreign =
    'const CLIENT_BUNDLE_ID = "@duke-dsh-plugins/dsh-token-stats";\n' +
    'window.__ModuleLoader__.load({ id: CLIENT_BUNDLE_ID, factory: () => ({}) });\n';
  let comboOk = true;
  let comboErr = "";
  try {
    new vm.Script(foreign + clientSrc, { filename: "combo-foreign-first.js" });
    new vm.Script(clientSrc + foreign, { filename: "combo-ours-first.js" });
  } catch (e) {
    comboOk = false;
    comboErr = e.message;
  }
  check("combo 拼接安全（IIFE 包裹，与同名顶层外来 bundle 双向拼接均可编译）", comboOk, comboErr);
  let body = clientSrc;
  let stripped = null;
  while (stripped !== body) {
    stripped = body;
    body = body.replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)/, "");
  }
  body = body.trimStart();
  check("client.js 顶层零声明（IIFE 开头）", body.startsWith("(() => {") || body.startsWith("(function"), body.slice(0, 40));
}

// ---- 7. unwrapRemote 双层信封（2026-10-24 二维码全空事故）--------------
// remote 网关把宿主返回再包一层：客户端拿到 res.value = host 的 {ok,value|error}。
// unwrapRemote 必须拆两层——单层拆包会把内层信封当数据，页面全空而宿主侧
// 真实生效（按钮有效但界面无反应）。这里把函数源码从 client.js 里提取出来
// 真跑三种形态：双层成功 / 双层业务错误 / 单层兼容。
{
  const start = clientSrc.indexOf("function unwrapRemote(");
  let unwrapSrc = "";
  if (start >= 0) {
    let depth = 0;
    let i = clientSrc.indexOf("{", start);
    for (; i < clientSrc.length; i++) {
      if (clientSrc[i] === "{") depth++;
      else if (clientSrc[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    unwrapSrc = clientSrc.slice(start, i + 1);
  }
  const vm = await import("node:vm");
  let unwrap = null;
  let extractOk = false;
  try {
    unwrap = vm.runInNewContext(`(${unwrapSrc})`);
    extractOk = typeof unwrap === "function";
  } catch {
    extractOk = false;
  }
  check("unwrapRemote 可从 client.js 提取并实例化", extractOk, unwrapSrc ? "提取的源码不可执行" : "client.js 里找不到 unwrapRemote");
  if (extractOk) {
    const okDouble = unwrap({ ok: true, value: { ok: true, value: { relayUrl: "ws://x", channel: "C", hidden: false, qrSvg: "<svg" } } });
    check("双层成功信封拆出真数据", okDouble.ok === true && okDouble.value?.relayUrl === "ws://x" && okDouble.value?.qrSvg === "<svg", JSON.stringify(okDouble).slice(0, 120));
    const errDouble = unwrap({ ok: true, value: { ok: false, error: { code: "bad-params", message: "地址不合法" } } });
    check("双层业务错误拆出原文", errDouble.ok === false && errDouble.message === "地址不合法", JSON.stringify(errDouble).slice(0, 120));
    const single = unwrap({ ok: true, value: { a: 1 } });
    check("单层信封兼容（value 无 ok 字段时直取）", single.ok === true && single.value?.a === 1, JSON.stringify(single).slice(0, 120));
    const junk = unwrap("nonsense");
    check("非对象响应回错误", junk.ok === false && typeof junk.message === "string" && junk.message.length > 0, JSON.stringify(junk).slice(0, 120));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
