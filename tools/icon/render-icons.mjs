// Render DSH Pocket icon layers to the app resource directories.
// Usage: node tools/icon/render-icons.mjs  (uses @resvg/resvg-js from the dsh-desktop checkout)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Resvg } = require('D:/ai-projects/dsh/dsh-desktop/node_modules/@resvg/resvg-js/index.js');

const dir = new URL('.', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir));
const render = (svgBuffer, size, out) => {
  const resvg = new Resvg(svgBuffer, { fitTo: { mode: 'width', value: size } });
  writeFileSync(new URL(out, dir), resvg.render().asPng());
  console.log(`rendered ${out} @${size}`);
};

const bg = read('app-background.svg');
const fg = read('app-foreground.svg');
const full = read('app-full.svg');

const app = '../../app';
render(bg, 1024, `${app}/AppScope/resources/base/media/background.png`);
render(fg, 1024, `${app}/AppScope/resources/base/media/foreground.png`);
render(bg, 1024, `${app}/entry/src/main/resources/base/media/background.png`);
render(fg, 1024, `${app}/entry/src/main/resources/base/media/foreground.png`);
render(full, 288, `${app}/entry/src/main/resources/base/media/startIcon.png`);
