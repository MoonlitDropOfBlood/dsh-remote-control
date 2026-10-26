// market/generate-index.mjs —— 生成 DSH 插件市场索引（format 1，契约见
// @deepseek-ai/dsh-plugin-market-index）。
//
// 用法：
//   node market/generate-index.mjs            # 生成 market/index.json
//   node market/generate-index.mjs --check    # 校验磁盘上的 index.json 与应生成内容一致（CI 用）
//
// 数据来源（零依赖，Node ≥18）：
//   - 版本与 engines：../plugin/package.json
//   - 各版本发布时间：npm registry 的 time 字段（拉不到 → 回退 git tag 时间 → 再回退 now）
//
// 索引里**只放插件包**（@duke-dsh-plugins/dsh-remote-control）——中继是服务器包、
// 不是 DSH bundle，进了市场也没法被 plugin_manager 安装；描述里给它的链接即可。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PKG = "@duke-dsh-plugins/dsh-remote-control";
const RELAY_PKG = "@duke-dsh-plugins/dsh-remote-control-relay";
const REPO = "https://github.com/MoonlitDropOfBlood/dsh-remote-control";
const RAW_BASE = "https://raw.githubusercontent.com/MoonlitDropOfBlood/dsh-remote-control/main";

const pluginPkg = JSON.parse(readFileSync(join(here, "..", "plugin", "package.json"), "utf8"));
if (pluginPkg.name !== PLUGIN_PKG) throw new Error("plugin/package.json 的名字变了，请同步本脚本");

/** 拉注册表文档（失败回 null，生成器离线也能跑）。 */
async function registryDoc(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** npm time 字段（ISO）→ Unix 秒；registry 缺版本 → git tag v<ver> 时间 → now。 */
function publishTimestamp(doc, version) {
  const iso = doc?.time?.[version];
  if (typeof iso === "string") return Math.floor(Date.parse(iso) / 1000);
  try {
    const out = execSync(`git log -1 --format=%ct "v${version}" 2>/dev/null || git log -1 --format=%ct`, { encoding: "utf8" });
    const n = parseInt(out.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* fallthrough */ }
  return Math.floor(Date.now() / 1000);
}

/** 简易 SemVer 降序比较（x.y.z[-pre]；本项目版本没有 build 段）。 */
function semverDesc(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []];
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? 1 : -1; // 非法值排后面且保持稳定
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  const preA = pa[3], preB = pb[3];
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return -1; // 无预发布 > 有预发布
  if (preB.length === 0) return 1;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i], y = preB[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (typeof x === "number" && typeof y === "string") return -1;
    if (typeof x === "string" && typeof y === "number") return 1;
    if (x !== y) return x < y ? 1 : -1;
  }
  return 0;
}

const doc = await registryDoc(PLUGIN_PKG);
// 版本集合：registry 已发布版本 ∪ 本地 package.json 版本（CI 在 publish 后跑，两者一致）。
// 过滤：`0.0.0-stage` 是 npm 的暂存伪版本（实测会出现在 versions 里），非 SemVer 一律不进索引。
// --only-published：**只列 registry 上已存在的版本**——市场索引包的「首包」场景要用
// （Trusted Publisher 只能给已存在的包配，市场包得先手工发一版；那一版不能把还没
// 发布的插件版本列进索引，否则市场会给出装不上的版本）。
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const onlyPublished = process.argv.includes("--only-published");
const published = new Set(Object.keys(doc?.versions ?? {}));
const versionSet = new Set(
  [...published, ...(onlyPublished ? [] : [pluginPkg.version])].filter(
    (v) => SEMVER_RE.test(v) && v !== "0.0.0-stage",
  ),
);
if (onlyPublished && versionSet.size === 0) {
  throw new Error("--only-published：registry 上没有可索引的版本（拉不到注册表文档？）");
}
const versions = [...versionSet].sort(semverDesc).map((v) => ({
  version: v,
  publishTimestamp: publishTimestamp(doc, v),
  source: { type: "npm" },
  engines: { dsh: pluginPkg.dsh?.engines?.dsh ?? "" },
}));
if (versions.length === 0) throw new Error("没有任何版本可索引（registry 不可达且本地版本缺失？）");
if (versions[0].engines.dsh === "") throw new Error("plugin/package.json 缺 dsh.engines.dsh——市场兼容性判定需要它");

const index = {
  format: 1,
  title: { en: "DSH Pocket Market", zh: "DSH Pocket 插件市场" },
  description: {
    en: "Plugin index for DSH Pocket: remote-control DeepSeek Harness from a HarmonyOS phone over an end-to-end-encrypted relay.",
    zh: "DSH Pocket 的插件索引：通过端到端加密中继，用 HarmonyOS 手机遥控 DeepSeek Harness。",
  },
  metadata: {
    categories: {
      "remote-control": { title: { en: "Remote Control", zh: "远程控制" } },
    },
    labels: {
      phone: { title: { en: "Phone", zh: "手机" } },
      "e2e-encrypted": { title: { en: "End-to-end encrypted", zh: "端到端加密" } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: PLUGIN_PKG,
      title: { en: "DSH Pocket", zh: "DSH Pocket 手机遥控" },
      description: {
        en: "Control DeepSeek Harness from your phone: sessions, prompts, streamed replies, approvals, images and model switching over an E2E-encrypted relay. Fail-open by design. The relay can also be installed standalone (" + RELAY_PKG + ") for VPS deployment.",
        zh: "在手机上遥控 DeepSeek Harness：会话、发送提示词、流式回复、审批应答、图片与模型切换，全程端到端加密。审批缺省放行（fail-open）。中继可独立安装（" + RELAY_PKG + "）部署到 VPS。",
      },
      icon: `${RAW_BASE}/plugin/icon.svg`,
      author: "dukebywwh",
      homepage: `${REPO}#readme`,
      repository: { url: REPO, directory: "plugin" },
      metadata: {
        category: "remote-control",
        keywords: ["dsh", "remote-control", "harmonyos", "phone", "relay", "e2e", "approval"],
        labels: ["phone", "e2e-encrypted"],
        sortKeys: {},
      },
      versions,
    },
  ],
};

const json = JSON.stringify(index, null, 2) + "\n";
const outPath = join(here, "index.json");

if (process.argv.includes("--check")) {
  const disk = readFileSync(outPath, "utf8");
  if (disk !== json) {
    console.error("market/index.json 与应生成内容不一致——跑 node market/generate-index.mjs 重新生成并提交");
    process.exit(1);
  }
  console.log("market/index.json up to date");
} else {
  writeFileSync(outPath, json);
  console.log(`market/index.json written: ${versions.length} 个版本（最新 ${versions[0].version}）`);
}
