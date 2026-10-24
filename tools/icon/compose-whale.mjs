// Compose DSH Pocket icons with the official DSH whale glyph.
// Whale source: dsh-desktop/build/whale.svg (single-path silhouette, viewBox 0 0 23.16 17.04).
// We keep the dsh plugin family tile (blue->teal gradient + signature bottom wave)
// and swim the whale above it, recolored white.
// Usage: node tools/icon/compose-whale.mjs   (then node tools/icon/render-icons.mjs)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const whale = readFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', 'utf8');
const d = /<path d="([^"]+)"/.exec(whale)[1];

// whale viewBox 23.16 x 17.04 (aspect ~1.358) -> width 26 => scale 1.1226, height ~19.13
const W = 26;
const SCALE = (W / 23.16).toFixed(4);
const TX = ((48 - W) / 2).toFixed(2); // centered horizontally
const TY = 10.5;                      // whale swims above the wave (wave top ~36.9)

const whaleGroup = `  <g transform="translate(${TX},${TY}) scale(${SCALE})">\n    <path d="${d}" fill="#fff"/>\n  </g>`;
const gradient = (gid) => `  <defs>\n    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n    </linearGradient>\n  </defs>`;
const wave = `  <path d="M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>`;

// 1) layered foreground: white whale only, inside the safe zone
writeFileSync(
  join(here, 'app-foreground.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket layered-icon foreground: official DSH whale, white, safe-zone sized -->\n` +
  `${whaleGroup}\n</svg>\n`,
);

// 2) composite (startIcon): family tile + wave + whale
writeFileSync(
  join(here, 'app-full.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket composite icon (startIcon / preview): family tile + wave + DSH whale -->\n` +
  `${gradient('g-dpw')}\n  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g-dpw)"/>\n` +
  `${whaleGroup}\n${wave}\n</svg>\n`,
);

// 3) plugin icon: same composite in family format, with provenance comment
writeFileSync(
  join(here, '../../plugin/icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!--\n    dsh-remote-control plugin icon, dsh plugin family style\n    (blue->teal gradient tile, white glyph, signature bottom wave).\n    Glyph: the official DSH whale from dsh-desktop/build/whale.svg, recolored white.\n  -->\n` +
  `${gradient('g-rcw')}\n  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g-rcw)"/>\n` +
  `${whaleGroup}\n${wave}\n</svg>\n`,
);

// 4) keep the original whale next to this script for provenance
copyFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', join(here, 'whale-orig.svg'));
console.log('composed whale foreground/full/plugin icons');
