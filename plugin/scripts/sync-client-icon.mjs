// scripts/sync-client-icon.mjs —— 把 plugin/icon.svg 同步成 client.js 里的 CSS mask 素材。
//
// 为什么需要它：client.js 是**静态**浏览器包（无打包器），拿不到包内的
// icon.svg 文件；设置页导航图标只能用内联的 data-uri。而 icon.svg 是
// 填充式彩色图（渐变底板 + 白色鲸鱼），直接当 mask 会变成一个实心方块。
// 因此这里取 icon.svg 的**图形部分**（去掉渐变底板 rect 与 <defs>），
// 保留白色描边/填充——白色在 alpha mask 里正好是「不透明」的区域，
// 于是导航图标随 currentColor 变色，又保留了家族风格鲸鱼造型。
//
// 用法：node scripts/sync-client-icon.mjs（在 plugin/ 目录下）
//       改了 icon.svg 后跑一次；scripts/verify-settings.mjs 会检查是否过期。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iconPath = join(pkgRoot, "icon.svg");
const clientPath = join(pkgRoot, "client.js");

const BEGIN = "// ==== BEGIN GENERATED ICON (scripts/sync-client-icon.mjs) ====";
const END = "// ==== END GENERATED ICON ====";

/**
 * icon.svg → alpha mask 用的 SVG（只留图形，白色=不透明）。
 * @param {string} svg
 * @returns {string}
 */
export function maskAssetFrom(svg) {
  const body = svg
    // 去掉注释
    .replace(/<!--[\s\S]*?-->/g, "")
    // 去掉渐变等 <defs>
    .replace(/<defs>[\s\S]*?<\/defs>/g, "")
    // 去掉底板矩形（<rect …/>）——它是渐变底板，不该进 mask
    .replace(/<rect\b[^>]*\/>/g, "")
    .trim();
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 48 48";
  // 只取根 <svg> 的内部内容（否则会套出两层 <svg>）
  const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(body)?.[1] ?? body;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
    viewBox +
    '" fill="none">' +
    inner +
    "</svg>"
  );
}

/** SVG → data: URI（CSS mask 用；保留 # 与引号的可读编码）。 */
export function toDataUri(svg) {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(svg)
      .replace(/'/g, "%27")
      .replace(/"/g, "%22")
      .replace(/%20/g, " ")
  );
}

/** 计算 client.js 里应该内联的那段常量文本。 */
export function generatedBlock() {
  const svg = readFileSync(iconPath, "utf8");
  const uri = toDataUri(maskAssetFrom(svg));
  return (
    BEGIN +
    "\n// Auto-generated from icon.svg — run `node scripts/sync-client-icon.mjs` after changing the icon.\n" +
    'const CLIENT_ICON_MASK_URI =\n  "' +
    uri +
    '";\n' +
    END
  );
}

if (process.argv[1] && process.argv[1].endsWith("sync-client-icon.mjs")) {
  const block = generatedBlock();
  const client = readFileSync(clientPath, "utf8");
  const start = client.indexOf(BEGIN);
  const end = client.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    console.error("sync-client-icon: client.js 里找不到生成标记（" + BEGIN + " / " + END + "）");
    process.exit(1);
  }
  const next = client.slice(0, start) + block + client.slice(end + END.length);
  writeFileSync(clientPath, next, "utf8");
  console.log("sync-client-icon: client.js 的图标 data-uri 已更新");
}
