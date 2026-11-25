#!/usr/bin/env node
/*
 * Copyright (c) 2026 dukedsh.
 * 两端 App 的版本号同步器 —— 消灭「手写常量漂移」。
 *
 * 背景（2026-11-26 实测）：仓库发到 v1.3.5，但
 *   - app/AppScope/app.json5 的 versionName 还是 "1.3.4"（versionCode 1003004）
 *   - app-android/app/build.gradle.kts 的 versionName 还是 "1.3.4"
 * → 设备上装到的 / 应用市场显示的版本永远落后一版；release workflow 只校验
 *   relay/plugin 两个 npm 包与标签一致，**不查 App**，所以漏 bump 不会让发版失败。
 *
 * 单一事实源 = plugin/package.json 的 version（发版流水线已强制它与标签一致）。
 *   - Android：build.gradle.kts 在配置期**直接读** plugin/package.json → 永不漂移。
 *   - HarmonyOS：app.json5 是静态 JSON5（DevEco 直接读，构建期无法注入）→
 *     由本脚本写入，并在 CI / release 里用 --check 断言不漂移。
 *
 * 用法：
 *   node tools/sync-app-versions.mjs            # 写入（把 App 版本号同步到事实源）
 *   node tools/sync-app-versions.mjs --check    # 只校验（CI / release 门禁用，漂移即退出码 1）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/** 事实源：插件包版本（发版流水线保证它与标签一致）。 */
function sourceVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8'));
  return String(pkg.version);
}

/**
 * 版本号 → 数字版本号（两端共用同一套编码，便于比对与递增）：
 *   major*1000000 + minor*1000 + patch
 * 例：1.3.4 → 1003004（与历史 HarmonyOS versionCode 一致）、1.3.5 → 1003005。
 */
export function versionCodeOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) {
    throw new Error(`版本号格式非法（期望 major.minor.patch）：${version}`);
  }
  return Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]);
}

/** 读 HarmonyOS app.json5 的当前 versionName / versionCode。 */
function readHarmonyVersion() {
  const raw = readFileSync(join(ROOT, 'app', 'AppScope', 'app.json5'), 'utf8');
  const name = /"versionName"\s*:\s*"([^"]+)"/.exec(raw);
  const code = /"versionCode"\s*:\s*(\d+)/.exec(raw);
  return { raw, name: name ? name[1] : '', code: code ? Number(code[1]) : 0 };
}

/** 把 HarmonyOS app.json5 的版本号替换成目标值（只动这两个键，其余原样保留）。 */
function writeHarmonyVersion(version) {
  const file = join(ROOT, 'app', 'AppScope', 'app.json5');
  const raw = readFileSync(file, 'utf8');
  const code = versionCodeOf(version);
  const next = raw
    .replace(/"versionCode"\s*:\s*\d+/, `"versionCode": ${code}`)
    .replace(/"versionName"\s*:\s*"[^"]+"/, `"versionName": "${version}"`);
  writeFileSync(file, next, 'utf8');
}

/**
 * 读 Android build.gradle.kts 的当前 versionName。
 *
 * 只认**代码行**里的赋值（`versionName = "..."`），跳过注释——注释里为了说明历史
 * 会写出旧版本号字面量，误匹配会报假漂移。
 */
function readAndroidVersion() {
  const raw = readFileSync(join(ROOT, 'app-android', 'app', 'build.gradle.kts'), 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue; // 注释行
    }
    const m = /versionName\s*=\s*"([^"]+)"/.exec(trimmed);
    if (m) {
      return m[1];
    }
  }
  return '';
}

const version = sourceVersion();
const code = versionCodeOf(version);
const harmony = readHarmonyVersion();
const android = readAndroidVersion();
const problems = [];

if (harmony.name !== version) {
  problems.push(`app/AppScope/app.json5 的 versionName=${harmony.name}，应为 ${version}`);
}
if (harmony.code !== code) {
  problems.push(`app/AppScope/app.json5 的 versionCode=${harmony.code}，应为 ${code}`);
}
// Android 的 versionName 在 build.gradle.kts 里由构建期从事实源推导，
// 这里的字面量只允许是「占位说明」，不允许再写死具体版本。
if (android && android !== version && !android.includes('PLACEHOLDER')) {
  problems.push(`app-android/app/build.gradle.kts 的 versionName=${android}（应为构建期推导，不要写死）`);
}

if (problems.length > 0) {
  console.error('版本号漂移：');
  for (const p of problems) {
    console.error('  - ' + p);
  }
  if (CHECK_ONLY) {
    console.error(`\n事实源（plugin/package.json）= ${version}。请运行：node tools/sync-app-versions.mjs`);
    process.exit(1);
  }
}

if (CHECK_ONLY) {
  console.log(`app-versions: OK（两端 App 版本号与事实源一致：${version} / ${code}）`);
  process.exit(0);
}

writeHarmonyVersion(version);
console.log(`已同步 HarmonyOS app.json5 → versionName=${version} versionCode=${code}`);
console.log(`Android versionName 由构建期从 plugin/package.json 推导（无需改文件）`);
console.log(`事实源（plugin/package.json）= ${version}`);
