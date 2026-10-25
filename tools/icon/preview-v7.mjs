// DSH Pocket icon — v7 candidates, **family line-art language**.
//
// Why v7: v3–v6 all mixed a SOLID whale/blob with a line-art container.
// The DSH plugin family (dsh-whale-pet / dsh-token-stats / dsh-git-manager /
// dsh-deveco / dsh-memory-manager) is strictly:
//   44x44 rx11 gradient tile (#4D6BFE -> #00B8A9)
//   WHITE LINE ART: fill="none" stroke="#fff" stroke-width 2.6~3.4, round caps/joins
//   signature bottom wave: M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0 (opacity .5, w 1.6)
//
// v7 uses the **family's own whale** (dsh-whale-pet's line-art whale, same stroke
// language) and varies only the container:
//   A) line-art phone + whale inside the screen  — "DSH on your phone"
//   B) line-art pocket + whale inside           — "DSH in your pocket"
//   C) line-art pocket + whale peeking over the lip
//
// Usage: node tools/icon/preview-v7.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const { Resvg } = require2('D:/ai-projects/dsh/dsh-desktop/node_modules/@resvg/resvg-js/index.js');

const GRAD = (id) =>
  `  <defs>\n    <linearGradient id="${id}" x1="2" y1="2" x2="46" y2="46" gradientUnits="userSpaceOnUse">\n` +
  `      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n    </linearGradient>\n  </defs>`;
const TILE = (id) => `  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#${id})"/>`;
const WAVE =
  '  <path d="M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>';

// 家族鲸鱼（dsh-whale-pet 的描线鲸）：按出现顺序取路径 —— 0=身体 1=尾巴 2=水花（丢弃）
const WP = readFileSync('D:/ai-projects/dsh/dsh-whale-pet/icon.svg', 'utf8');
const WP_PATHS = [...WP.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
const whaleBody = WP_PATHS[0];
const whaleTail = WP_PATHS[1];
const whaleEye = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(WP);

// 家族鲸鱼本地包围盒：x 11.5..43.5（宽 32）、y 17.5..32.5 → 中心 (27.5, 25)
const WHALE_SPAN = 32;
const WHALE_CX = 27.5;
const WHALE_CY = 25;

/**
 * 家族鲸鱼：按目标宽度缩放，按包围盒**居中**到 (cx, top 为竖直中心）。
 * 描线风格保持不变（stroke 2.8、round join）。
 */
const whale = (width, cx, cy) => {
  const scale = width / WHALE_SPAN;
  const tx = cx - WHALE_CX * scale;
  const ty = cy - WHALE_CY * scale;
  const ex = (Number(whaleEye[1]) * scale + tx).toFixed(2);
  const ey = (Number(whaleEye[2]) * scale + ty).toFixed(2);
  return (
    `  <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)})">\n` +
    `    <path d="${whaleBody}" fill="none" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>\n` +
    `    <path d="${whaleTail}" fill="none" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>\n` +
    `    <circle cx="${ex}" cy="${ey}" r="${whaleEye[3]}" fill="#fff"/>\n` +
    `  </g>`
  );
};

// ---- A：描线手机 + 鲸鱼在屏内 ----
const svgA =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v7-A: line-art phone + family line-art whale -->\n` +
  `${GRAD('gA')}\n${TILE('gA')}\n` +
  `  <rect x="11" y="7" width="26" height="34" rx="5" fill="url(#gA)" stroke="#fff" stroke-width="2.8"/>\n` +
  `  <path d="M20.5 37.6 H27.5" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.8" stroke-linecap="round"/>\n` +
  whale(20, 24, 24) + `\n${WAVE}\n</svg>\n`;

// ---- B：描线口袋 + 鲸鱼完整在内 ----
const svgB =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v7-B: line-art pocket + family line-art whale -->\n` +
  `${GRAD('gB')}\n${TILE('gB')}\n` +
  `  <path d="M10.5 12.5 Q24 15 37.5 12.5 L37.5 27 A10.5 10.5 0 0 1 27 37.5 H21 A10.5 10.5 0 0 1 10.5 27 Z" fill="url(#gB)" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>\n` +
  `  <path d="M14 16.6 Q24 18.4 34 16.6" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.3" stroke-linecap="round"/>\n` +
  whale(21, 24, 27) + `\n${WAVE}\n</svg>\n`;

// ---- C：描线口袋 + 鲸尾探出口袋 ----
const svgC =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v7-C: line-art pocket + whale peeking over the lip -->\n` +
  `${GRAD('gC')}\n${TILE('gC')}\n` +
  whale(23, 23, 17) + `\n` +
  `  <path d="M11.5 20.5 Q24 23 36.5 20.5 L36.5 29 A9.6 9.6 0 0 1 26.9 38.6 H21.1 A9.6 9.6 0 0 1 11.5 29 Z" fill="url(#gC)" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>\n` +
  `  <path d="M14.8 24.2 Q24 25.8 33.2 24.2" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.3" stroke-linecap="round"/>\n` +
  `${WAVE}\n</svg>\n`;

const render = (svg, size, out) => {
  const r = new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: size } });
  writeFileSync(join(here, out), r.render().asPng());
  console.log('rendered ' + out + ' @' + size);
};

const variants = [['preview-v7-a', svgA], ['preview-v7-b', svgB], ['preview-v7-c', svgC]];
const pngs = [];
for (const [name, svg] of variants) {
  writeFileSync(join(here, name + '.svg'), svg);
  render(svg, 288, name + '-288.png');
  pngs.push({
    name,
    png: new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: 288 } }).render().asPng(),
  });
}

// 拼接对比图（3 × 288）
const sharpPath = 'C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules/sharp';
const sharp = require2(sharpPath);
const W = 288, GAP = 16, PAD = 16;
const sheetW = PAD * 2 + W * 3 + GAP * 2;
const sheetH = PAD * 2 + W;
const composites = pngs.map((p, i) => ({ input: p.png, left: PAD + i * (W + GAP), top: PAD }));
sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: '#101418' } })
  .composite(composites)
  .png()
  .toFile(join(here, 'preview-v7-sheet.png'))
  .then(() => console.log('wrote preview-v7-sheet.png (' + sheetW + 'x' + sheetH + ')'))
  .catch((e) => console.error('sheet failed: ' + e.message));
