#!/usr/bin/env node
// scripts/vendor-relay.mjs — 把 relay/server.js 复制进插件包（vendor/relay/server.js）
//
// 为什么需要：插件以 **bundle 形式安装**（非 link）时，包里只有 plugin/ 目录，
// 没有仓库里的 relay/ → 插件找不到中继程序 → 「随插件启动中继」整体失效。
// 把中继源码带进包里（vendor/），并让 plugin 依赖 ws（中继唯一的依赖），
// 任何安装形态都能自动起中继。
//
// 用法：
//   node scripts/vendor-relay.mjs          # 生成/更新 vendor/relay/server.js
//   node scripts/vendor-relay.mjs --check  # 只校验是否与源文件同步（门禁用；不同步则退出码 1）
//
// 注意：vendor/ 是**生成物**，源文件永远是 relay/server.js；
// 改完源文件必须重新跑本脚本（门禁 verify-relay-supervisor.mjs 会校验同步）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（plugin/）。 */
const PLUGIN_DIR = resolve(SCRIPT_DIR, "..");
/** 仓库根目录（dsh-remote-control/）。 */
const REPO_DIR = resolve(PLUGIN_DIR, "..");

const SOURCE = join(REPO_DIR, "relay", "server.js");
const TARGET = join(PLUGIN_DIR, "vendor", "relay", "server.js");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** 生成 vendor 文件的内容（源文件 + 生成头）。 */
function buildVendorContent(sourceText) {
  const rel = relative(PLUGIN_DIR, SOURCE).split("\\").join("/");
  const header = [
    "// ⚠️ 自动生成，请勿手改 —— 源文件：" + rel,
    "// 生成方式：node scripts/vendor-relay.mjs",
    "// 改动源文件后必须重新生成（门禁 scripts/verify-relay-supervisor.mjs 会校验同步）。",
    "// source-sha256:" + sha256(sourceText),
  ];
  // **shebang 必须留在第一行**（插在中间会直接语法错）
  const lines = sourceText.split("\n");
  if (lines[0] && lines[0].startsWith("#!")) {
    return [lines[0], ...header, ...lines.slice(1)].join("\n");
  }
  return [...header, "", sourceText].join("\n");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  if (!existsSync(SOURCE)) {
    console.error("vendor-relay: 找不到源文件 " + SOURCE);
    process.exit(1);
  }
  const sourceText = readFileSync(SOURCE, "utf8");
  const expected = buildVendorContent(sourceText);

  if (checkOnly) {
    if (!existsSync(TARGET)) {
      console.error("vendor-relay: 缺少 " + relative(REPO_DIR, TARGET) + "（跑 node scripts/vendor-relay.mjs 生成）");
      process.exit(1);
    }
    const actual = readFileSync(TARGET, "utf8");
    if (actual !== expected) {
      console.error(
        "vendor-relay: " + relative(REPO_DIR, TARGET) + " 与源文件不同步（跑 node scripts/vendor-relay.mjs 重新生成）",
      );
      process.exit(1);
    }
    console.log("vendor-relay: 同步 OK（" + relative(REPO_DIR, TARGET) + "）");
    return;
  }

  mkdirSync(dirname(TARGET), { recursive: true });
  const old = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  if (old === expected) {
    console.log("vendor-relay: 已是最新（" + relative(REPO_DIR, TARGET) + "）");
    return;
  }
  writeFileSync(TARGET, expected, "utf8");
  console.log("vendor-relay: 已生成 " + relative(REPO_DIR, TARGET) + "（" + expected.length + " 字节）");
}

main();
