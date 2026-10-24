// Compose DSH Pocket icons: the official DSH whale in a pocket.
// Whale source: dsh-desktop/build/whale.svg (single-path silhouette, viewBox 0 0 23.16 17.04).
// Family style: blue->teal gradient tile + white line art + signature bottom wave.
// "Pocket" concept (2026-10-24 user feedback): the whale dives INTO a pouch —
// pouch lip + U-shaped body (white stroke), whale bottom overlapping the lip so it
// reads as tucked into the pocket.
// Usage: node tools/icon/compose-whale.mjs   (then node tools/icon/render-icons.mjs
//        and  node plugin/scripts/sync-client-icon.mjs)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const whale = readFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', 'utf8');
const d = /<path d="([^"]+)"/.exec(whale)[1];

// whale: width 21 (scale ~0.9067, height ~15.4), centered; bottom edge (TY+15.4=19.6)
// overlaps the lip line (y 19.2..21.8 with stroke) so the whale reads as "in the pocket"
const W = 21;
const SCALE = (W / 23.16).toFixed(4);
const TX = ((48 - W) / 2).toFixed(2);
const TY = '4.2';

// pocket: lip line + U body (stroke 2.6, round caps), body bottom ~28+5+7.4 = 35.4 (+1.3 stroke)
const pocket = `  <g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.5 20.5 H37.5"/>
    <path d="M13.5 23 v5 a7.4 7.4 0 0 0 7.4 7.4 h6.2 a7.4 7.4 0 0 0 7.4 -7.4 V23"/>
  </g>`;
const whaleGroup = `  <g transform="translate(${TX},${TY}) scale(${SCALE})">\n    <path d="${d}" fill="#fff"/>\n  </g>`;
const gradient = (gid) => `  <defs>\n    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">\n      <stop offset="0" stop-color="#4D6BFE"/>\n      <stop offset="1" stop-color="#00B8A9"/>\n    </linearGradient>\n  </defs>`;
const wave = `  <path d="M10 39.5 q3.5 -2.6 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>`;

// 1) layered foreground: white pocket + whale (no tile — the background layer carries it)
writeFileSync(
  join(here, 'app-foreground.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket layered-icon foreground: whale diving into a pocket, white -->\n` +
  `${pocket}\n${whaleGroup}\n</svg>\n`,
);

// 2) composite (startIcon): family tile + wave + pocket + whale
writeFileSync(
  join(here, 'app-full.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!-- DSH Pocket composite icon (startIcon / preview): tile + wave + pocket + whale -->\n` +
  `${gradient('g-dpw')}\n  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g-dpw)"/>\n` +
  `${wave}\n${pocket}\n${whaleGroup}\n</svg>\n`,
);

// 3) plugin icon: same composite in family format, with provenance comment
writeFileSync(
  join(here, '../../plugin/icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">\n` +
  `  <!--\n    dsh-remote-control plugin icon, dsh plugin family style\n    (blue->teal gradient tile, white glyph, signature bottom wave).\n    Glyph: the official DSH whale (dsh-desktop/build/whale.svg) diving into a\n    pocket — "DSH in your pocket".\n  -->\n` +
  `${gradient('g-rcw')}\n  <rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g-rcw)"/>\n` +
  `${wave}\n${pocket}\n${whaleGroup}\n</svg>\n`,
);

// 4) keep the original whale next to this script for provenance
copyFileSync('D:/ai-projects/dsh/dsh-desktop/build/whale.svg', join(here, 'whale-orig.svg'));
console.log('composed pocket+whale foreground/full/plugin icons');
