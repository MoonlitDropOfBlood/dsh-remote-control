// DSH Pocket icon — contact sheet of 4 directions (one image, easy to compare).
//
// v6a/v6b (hand-drawn fluke) were rejected by eyeball: the fluke kept rendering as
// thin horns/tulip and the pocket as a bowl. This sheet therefore uses the OFFICIAL
// DSH whale silhouette (dsh-desktop/build/whale.svg) for every whale-bearing
// candidate, and varies only the container:
//   0) current v3 (whale on a line-art U pocket)  — for reference
//   1) whale alone                                — clean, brand-first
//   2) line-art pocket, whale fully inside        — "DSH in your pocket"
//   3) line-art phone, whale inside the screen     — "DSH on your phone"
//
// Usage: node tools/icon/preview-sheet.mjs   → preview-sheet.png (4 × 256 tiles)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const { Resvg } = require2('D:/ai-projects/dsh/dsh-desktop/node_modules/@resvg/resvg-js/index.js');
const fs = require2('node:fs');

const whaleSvg = fs.readFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', 'utf8');
const WHALE_D = /<path d="([^"]+)"/.exec(whaleSvg)[1];

const GRAD = (id) =>
  `    <linearGradient id="${id}" x1="2" y1="2" x2="46" y2="46" gradientUnits="userSpaceOnUse">\n` +
  `      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n` +
  `    </linearGradient>`;
const TILE = (id) => `    <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#${id})"/>`;
const WAVE =
  '  <path d="M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>';

// 官方鲸鱼：按目标宽度等比缩放并居中（fill 白）
const whale = (width, cx, top, fill) => {
  const scale = (width / 23.16).toFixed(4);
  const tx = (cx - width / 2).toFixed(2);
  return `  <g transform="translate(${tx},${top}) scale(${scale})"><path d="${WHALE_D}" fill="${fill}"/></g>`;
};

// ---- 0) 当前 v3：实心鲸鱼 + 描线 U 形口袋 ----
const v3 =
  `  <path d="M10.5 20.5 H37.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>\n` +
  `  <path d="M13.5 23 v5 a7.4 7.4 0 0 0 7.4 7.4 h6.2 a7.4 7.4 0 0 0 7.4 -7.4 V23" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>\n` +
  whale(21, 24, 4.2, '#fff');

// ---- 1) 鲸鱼单独 ----
const v1 = whale(27, 24, 11, '#fff');

// ---- 2) 描线口袋 + 鲸鱼完整在内 ----
const pocketShape =
  'M11 13.5 Q24 16 37 13.5 L37 27 A10.5 10.5 0 0 1 26.5 37.5 H21.5 A10.5 10.5 0 0 1 11 27 Z';
const v2 =
  `  <path d="${pocketShape}" fill="url(#g2)" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>\n` +
  `  <path d="M14.5 17.5 Q24 19.3 33.5 17.5" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.3" stroke-linecap="round"/>\n` +
  whale(21, 24, 19.5, '#fff');

// ---- 3) 描线手机 + 鲸鱼在屏内 ----
const v3b =
  `  <rect x="12" y="8" width="24" height="31" rx="4.6" fill="url(#g3)" stroke="#fff" stroke-width="2.8"/>\n` +
  `  <path d="M19 34.5 H29" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>\n` +
  whale(19, 24, 15.5, '#fff');

const tileSvg = (id, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <defs>\n    ${GRAD(id)}\n  </defs>\n${TILE(id)}\n${body}\n${WAVE}\n</svg>\n`;

const variants = [
  ['preview-opt0-current', tileSvg('g0', v3)],
  ['preview-opt1-whale-only', tileSvg('g1', v1)],
  ['preview-opt2-pocket-whale', tileSvg('g2', v2)],
  ['preview-opt3-phone-whale', tileSvg('g3', v3b)],
];

for (const [name, svg] of variants) {
  writeFileSync(join(here, name + '.svg'), svg);
  const r = new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: 288 } });
  writeFileSync(join(here, name + '.png'), r.render().asPng());
  console.log('rendered ' + name);
}

// 拼接成一张对比图（4 × 288 + 间隔 16，深色底）
const W = 288, H = 288, GAP = 16, PAD = 16;
const sheetW = PAD * 2 + W * 4 + GAP * 3;
const sheetH = PAD * 2 + H;
const imgs = variants.map(([name]) => ({
  name,
  png: new Resvg(Buffer.from(require2('node:fs').readFileSync(join(here, name + '.svg'))), {
    fitTo: { mode: 'width', value: W },
  }).render().asPng(),
}));

// 用 resvg 渲染一个引用外部 PNG 的 svg 不可行 → 改用 sharp（DSH 部署目录里有）
const sharpPath = 'C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules/sharp';
let sharp;
try {
  sharp = require2(sharpPath);
} catch (e) {
  sharp = null;
}
if (sharp) {
  const bg = { create: { width: sheetW, height: sheetH, channels: 4, background: '#101418' } };
  const composites = [];
  for (let i = 0; i < imgs.length; i++) {
    composites.push({
      input: imgs[i].png,
      left: PAD + i * (W + GAP),
      top: PAD,
    });
  }
  sharp(bg).composite(composites).png().toFile(join(here, 'preview-sheet.png'))
    .then(() => console.log('wrote preview-sheet.png (' + sheetW + 'x' + sheetH + ')'))
    .catch((e) => console.error('sheet failed: ' + e.message));
} else {
  console.log('sharp unavailable — individual PNGs written, no sheet');
}
