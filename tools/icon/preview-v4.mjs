// Preview icon variants for DSH Pocket (v4r2).
// A: line-art pocket with dark inner slot + white fluke (two tilted lobes + stem)
// B: solid white pocket + gradient fluke
// Usage: node tools/icon/preview-v4.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const { Resvg } = require2('D:/ai-projects/dsh/dsh-desktop/node_modules/@resvg/resvg-js/index.js');

const gradient = (id) =>
  `  <defs>\n    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n    </linearGradient>\n  </defs>`;
const tile = (id) =>
  `${gradient(id)}\n  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#${id})"/>`;
const wave =
  '  <path d="M10 40.5 q3.5 -2.4 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.5" stroke-linecap="round"/>';

// 鲸尾鳍 v2 = 两片斜置椭圆（左 -34° / 右 +34°）+ 中央尾柄；同色填充自然并集成剪影。
// 椭圆内端在中央上方形成天然凹口（notch），尾柄向下没入袋口。
const fluke =
  '  <g fill="#fff">\n' +
  '    <ellipse cx="17.6" cy="12.6" rx="7.6" ry="4.6" transform="rotate(-34 17.6 12.6)"/>\n' +
  '    <ellipse cx="30.4" cy="12.6" rx="7.6" ry="4.6" transform="rotate(34 30.4 12.6)"/>\n' +
  '    <path d="M22.2 26 L22.2 13.6 Q24 10.8 25.8 13.6 L25.8 26 Z"/>\n' +
  '  </g>';

// 口袋内衬暗槽（开口提示）：fluke 从这里钻出来
const slot = '  <rect x="13.5" y="19" width="21" height="7.5" rx="3.2" fill="#000" opacity=".18"/>';

// 口袋前片：唇线 y=23.5（布料下坠感：上缘中央微微下凹），gradient 填充盖尾柄 + 白描边
const pocketFront =
  'M11.5 23.5 Q24 25.2 36.5 23.5 V26.5 A10.5 10.5 0 0 1 26 37 H22 A10.5 10.5 0 0 1 11.5 26.5 Z';

// ---- A：白描线口袋（gradient 前片 + 白描边）+ 白鲸尾 + 内衬暗槽 ----
const svgA =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v4r2-A: white fluke rising from a line-art pocket -->\n` +
  `${tile('gA')}\n${wave}\n${slot}\n${fluke}\n` +
  `  <path d="${pocketFront}" fill="url(#gA)" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>\n` +
  `</svg>\n`;

// ---- B：实色白口袋 + 渐变鲸尾（白面板盖尾柄，开口缝露 tile 底色）----
const svgB =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket v4r2-B: gradient fluke into a solid white pocket -->\n` +
  `${tile('gB')}\n${wave}\n${fluke}\n` +
  `  <path d="${pocketFront}" fill="#fff"/>\n` +
  `  <!-- 开口缝：白面板上缘与尾柄之间露出 1.6 高的 tile 底色 -->\n` +
  `  <path d="M13.2 22.9 Q24 24.5 34.8 22.9 L34.8 24.4 Q24 26 13.2 24.4 Z" fill="url(#gB)"/>\n` +
  `</svg>\n`;

const render = (svg, size, out) => {
  const r = new Resvg(Buffer.from(svg), { fitTo: { mode: 'width', value: size } });
  writeFileSync(join(here, out), r.render().asPng());
  console.log('rendered ' + out + ' @' + size);
};

for (const [name, svg] of [['preview-v4-a', svgA], ['preview-v4-b', svgB]]) {
  writeFileSync(join(here, name + '.svg'), svg);
  render(svg, 512, name + '-512.png');
  render(svg, 96, name + '-96.png');
}
console.log('done');
