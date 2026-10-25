// Compose DSH Pocket icons: the official DSH whale inside a pocket.
//
// Whale source: dsh-desktop/build/whale.svg (single-path silhouette, viewBox 0 0 23.16 17.04).
// Style: DSH plugin family tile (blue->teal gradient 44x44 rx11) + WHITE LINE ART
// container (stroke 2.6~2.8, round caps/joins) + the official whale as a SOLID white
// mark sitting inside the pocket.
//
// 2026-10-25 (user feedback, v3 -> v8):
//   - v3（鲸鱼骑在 U 形口袋上）太挤、读不出「口袋」；改成鲸鱼**完整装进口袋**。
//   - 去掉家族签名底部波浪（用户：底下多了个波浪线，去掉）。
//   - 鲸鱼改回**官方 DeepSeek 鲸鱼剪影**（v4~v7 的家族线稿鲸/自绘尾鳍都不如它）。
//
// Usage: node tools/icon/compose-whale.mjs
//   (then node tools/icon/render-icons.mjs, then node plugin/scripts/sync-client-icon.mjs)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const whale = readFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', 'utf8');
const d = /<path d="([^"]+)"/.exec(whale)[1];

// --- 口袋（描线）：上缘是袋口（微垂的曲线），袋底是圆角 ---
const pocket =
  'M10.5 12.5 Q24 15 37.5 12.5 L37.5 27 A10.5 10.5 0 0 1 27 37.5 H21 A10.5 10.5 0 0 1 10.5 27 Z';
// 袋口开缝（弱化双线 = 开口）
const lip = 'M14 16.6 Q24 18.4 34 16.6';

// --- 官方鲸鱼：宽 20（scale 0.8636，高 14.72），居中于 x=24，落在袋口线之下 ---
const W = 20;
const SCALE = (W / 23.16).toFixed(4);
const TX = (24 - W / 2).toFixed(2);
const TY = '19.1';
const whaleGroup = `  <g transform="translate(${TX},${TY}) scale(${SCALE})">\n    <path d="${d}" fill="#fff"/>\n  </g>`;

const gradient = (gid) =>
  `  <defs>\n    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n    </linearGradient>\n  </defs>`;
const tile = (gid) => `  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#${gid})"/>`;

// 1) layered background：只有家族渐变方块（**无波浪**）
writeFileSync(
  join(here, 'app-background.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket layered-icon background: family tile (blue->teal gradient) -->\n` +
  `${gradient('g-dpb')}\n${tile('g-dpb')}\n</svg>\n`,
);

// 2) layered foreground：描线口袋 + 实心官方鲸鱼（白）
writeFileSync(
  join(here, 'app-foreground.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket layered-icon foreground: official DSH whale inside a line-art pocket, white -->\n` +
  `  <g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">\n` +
  `    <path d="${pocket}"/>\n` +
  `    <path d="${lip}" stroke-opacity=".4" stroke-width="1.3"/>\n` +
  `  </g>\n${whaleGroup}\n</svg>\n`,
);

// 3) composite（startIcon / 预览）
writeFileSync(
  join(here, 'app-full.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket composite icon (startIcon / preview): tile + pocket + official whale -->\n` +
  `${gradient('g-dpf')}\n${tile('g-dpf')}\n` +
  `  <g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">\n` +
  `    <path d="${pocket}"/>\n` +
  `    <path d="${lip}" stroke-opacity=".4" stroke-width="1.3"/>\n` +
  `  </g>\n${whaleGroup}\n</svg>\n`,
);

// 4) plugin icon：同一标记，家族格式
writeFileSync(
  join(here, '../../plugin/icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!--\n` +
  `    dsh-remote-control plugin icon, dsh plugin family style\n` +
  `    (blue->teal gradient tile, white line-art pocket, official DSH whale inside).\n` +
  `  -->\n` +
  `${gradient('g-rcw')}\n${tile('g-rcw')}\n` +
  `  <g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">\n` +
  `    <path d="${pocket}"/>\n` +
  `    <path d="${lip}" stroke-opacity=".4" stroke-width="1.3"/>\n` +
  `  </g>\n${whaleGroup}\n</svg>\n`,
);

// 5) 留档官方鲸鱼源
copyFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', join(here, 'whale-orig.svg'));

console.log('composed: app-background / app-foreground / app-full / plugin/icon.svg');
