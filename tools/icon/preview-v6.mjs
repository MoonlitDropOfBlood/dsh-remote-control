// DSH Pocket icon — v6r2 candidates (family line-art style).
//
// Family style (from dsh-whale-pet / dsh-token-stats / dsh-git-manager):
//   - 44x44 rx11 gradient tile (#4D6BFE -> #00B8A9) at (2,2)
//   - WHITE LINE ART: fill="none" stroke="#fff" stroke-width 2.6~3.4, round caps/joins
//   - signature bottom wave: M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0 (opacity .5, w 1.6)
//
// v6r2 changes vs v6: the fluke is now TWO wide lobes (real whale-tail silhouette,
// v6's single-curve version rendered as thin horns), and the pocket is smaller and
// shallower (v6's was a tall bowl).
//
// A: line-art pocket + white fluke diving into it (gradient-filled front masks the stem)
// B: line-art phone + white fluke rising out of the screen
//
// Usage: node tools/icon/preview-v6.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const { Resvg } = require2('D:/ai-projects/dsh/dsh-desktop/node_modules/@resvg/resvg-js/index.js');

const GRAD = (id) =>
  `  <defs>\n    <linearGradient id="${id}" x1="2" y1="2" x2="46" y2="46" gradientUnits="userSpaceOnUse">\n` +
  `      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n` +
  `    </linearGradient>\n  </defs>`;
const TILE = (id) => `  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#${id})"/>`;
const WAVE =
  '  <path d="M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>';

// 鲸尾鳍 = 两片肥厚叶瓣（左/右），顶部中央天然形成 V 形凹口（鲸尾特征），下端并成尾柄。
// 每片 = 凹弧上缘(到尾尖) + 凸弧下缘(到尾柄) → 叶片厚实，不是细角。
const lobeL =
  'M24 16.6 C19.6 15.2 14.2 12.4 9.8 8.6 C14.2 14.4 18.2 20.2 19.6 26.4 ' +
  'C20 28.2 21.6 29 23 28.4 C24.2 27.9 24 17 24 16.6 Z';
const lobeR =
  'M24 16.6 C28.4 15.2 33.8 12.4 38.2 8.6 C33.8 14.4 29.8 20.2 28.4 26.4 ' +
  'C28 28.2 26.4 29 25 28.4 C23.8 27.9 24 17 24 16.6 Z';
const FLUKE = `  <g fill="#fff">\n    <path d="${lobeL}"/>\n    <path d="${lobeR}"/>\n  </g>`;

// ---- A：描线口袋（浅、宽、有袋口开缝）+ 尾鳍没入口袋 ----
const POCKET =
  '  <path d="M12.6 20.6 Q24 22.8 35.4 20.6 L35.4 27.4 A9 9 0 0 1 26.4 36.4 H21.6 ' +
  'A9 9 0 0 1 12.6 27.4 Z" fill="url(#gA)" stroke="#fff" stroke-width="2.8" stroke-linejoin="round"/>';
// 袋口开缝（弱化双线 = 开口）
const POCKET_LIP =
  '  <path d="M15.4 24 Q24 25.6 32.6 24" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>';

const svgA =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v6r2-A: line-art pocket + white whale fluke diving in -->\n` +
  `${GRAD('gA')}\n${TILE('gA')}\n${FLUKE}\n${POCKET}\n${POCKET_LIP}\n${WAVE}\n</svg>\n`;

// ---- B：描线手机 + 尾鳍从屏幕升起 ----
const PHONE =
  '  <rect x="12.8" y="10" width="22.4" height="29" rx="4.4" fill="url(#gB)" stroke="#fff" stroke-width="2.8"/>';
const PHONE_SCREEN =
  '  <path d="M15.8 16 H32.2" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>';
const FLUKE_B =
  `  <g fill="#fff">\n` +
  `    <path d="M24 15 C20.2 13.8 15.6 11.4 11.6 8.2 C15.6 13.4 19.2 18.6 20.4 24.2 ` +
  `C20.8 25.8 22.2 26.6 23.4 26 C24.4 25.5 24 15.3 24 15 Z"/>\n` +
  `    <path d="M24 15 C27.8 13.8 32.4 11.4 36.4 8.2 C32.4 13.4 28.8 18.6 27.6 24.2 ` +
  `C27.2 25.8 25.8 26.6 24.6 26 C23.6 25.5 24 15.3 24 15 Z"/>\n` +
  `  </g>`;

const svgB =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v6r2-B: line-art phone + white whale fluke rising from the screen -->\n` +
  `${GRAD('gB')}\n${TILE('gB')}\n${FLUKE_B}\n${PHONE}\n${PHONE_SCREEN}\n${WAVE}\n</svg>\n`;

const render = (svg, size, out) => {
  const r = new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: size } });
  writeFileSync(join(here, out), r.render().asPng());
  console.log('rendered ' + out + ' @' + size);
};

for (const [name, svg] of [['preview-v6-a', svgA], ['preview-v6-b', svgB]]) {
  writeFileSync(join(here, name + '.svg'), svg);
  render(svg, 512, name + '-512.png');
  render(svg, 288, name + '-288.png');
  render(svg, 96, name + '-96.png');
}
console.log('done');
