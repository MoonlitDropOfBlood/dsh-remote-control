// scripts/verify-qr.mjs —— 配对二维码正确性自检（dev-only；运行时零依赖）。
//
// 验证四件事：
//   1. §3.5 URI 格式逐字正确（编码规则、字段顺序、可选 t、空 relayUrl 报错）；
//   2. 生成的 QR 可被**独立解码器** jsqr（devDependency）解回原 URI——
//      jsqr 与内嵌编码器是完全无关的两个实现，能解回即格式级正确；
//   3. 矩阵级自检：读回格式信息（BCH 校验、ECC 级别=M、掩模号一致）、
//      反向布局回读码字、每块 RS syndrome 全零、按 byte 模式解析出原 URI；
//   4. SVG/ASCII 渲染形态一致（黑模块数、静区、行宽），ASCII 也可被 jsqr 解码。
//
// 用法：node scripts/verify-qr.mjs（在 plugin/ 目录；需先 npm install 装 devDeps）
import { encodeToMatrix } from "../lib/qr.mjs";
import { buildPairingUri, redactUri, renderPairing } from "../lib/pairing.mjs";

let pass = 0;
let fail = 0;
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    console.log("ok: " + label);
  } else {
    fail++;
    console.log("FAIL: " + label + (detail ? " — " + detail : ""));
  }
};

// ---- 1. URI 格式（§3.5 逐字）--------------------------------------------------
const sample = {
  relayUrl: "wss://relay.example.com/ws?opt=1&mode=strict", // 含需编码字符
  channel: "KMNPQRTVWXY23456", // §3.5 示例字母表（A-Z2-7）
  secret: "dsh-remote-demo-secret-0123456789", // ≥32 字符；含 -（URL 安全）
  relayToken: "tok en+/=特殊", // 含空格与特殊字符，必须整体编码
};
const uri = buildPairingUri(sample);
console.log("样例 URI:\n  " + uri + "\n");

check("§3.5 前缀 dshrc://pair?", uri.startsWith("dshrc://pair?"), uri.slice(0, 20));
check("字段顺序 r&c&s&t", /^dshrc:\/\/pair\?r=[^&]+&c=[A-Z2-7]{16,64}&s=[^&]+&t=[^&]+$/.test(uri), uri);
check("r 为 encodeURIComponent(relayUrl)", uri.includes("r=" + encodeURIComponent(sample.relayUrl)));
check("r 的冒号/斜杠已编码（无裸 ://）", uri.split("&")[0].includes("wss%3A%2F%2F"));
check("c 原样不编码（base32 无需编码）", uri.includes("&c=" + sample.channel));
check("s 原样不编码（base64url/- 字符集 URL 安全）", uri.includes("&s=" + sample.secret));
check("t 整体 encodeURIComponent", uri.includes("&t=" + encodeURIComponent(sample.relayToken)));
const noToken = buildPairingUri({ ...sample, relayToken: "" });
check(
  "relayToken 为空时省略 &t=（§3.5 可选）",
  !noToken.includes("&t=") && /^dshrc:\/\/pair\?r=[^&]+&c=[^&]+&s=[^&]+$/.test(noToken),
);
let threw = "";
try {
  buildPairingUri({ ...sample, relayUrl: "" });
} catch (e) {
  threw = String(e.message);
}
check("relayUrl 为空抛出明确提示（先配置 relayUrl）", threw.includes("relayUrl"), threw);

// ---- 2. QR 矩阵生成 + 独立解码器 jsqr 回读 --------------------------------------
const jsqrMod = await import("jsqr").catch(() => null);
if (!jsqrMod) {
  console.log("FAIL: jsqr 未安装（先在 plugin/ 下 npm install）");
  process.exit(1);
}
const jsqr = jsqrMod.default ?? jsqrMod;

function rasterizeMatrix(qr, scale = 6, quiet = 4) {
  const dim = (qr.size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + ((x + quiet) * scale + dx);
          rgba[px * 4] = 0;
          rgba[px * 4 + 1] = 0;
          rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data: rgba, width: dim, height: dim };
}
const decodeWithJsqr = (qr) => {
  const img = rasterizeMatrix(qr);
  const res = jsqr(img.data, img.width, img.height);
  return res ? res.data : null;
};

const cases = [
  { name: "样例 URI（含编码字符与 token）", uri },
  {
    name: "短 URI（无 token、内网 relayUrl）",
    uri: buildPairingUri({ relayUrl: "ws://192.168.3.2:8787", channel: sample.channel, secret: sample.secret }),
  },
  {
    name: "长 URI（64 位 channel + 长 secret + 长 token，落在版本 10）",
    uri: buildPairingUri({
      relayUrl: "wss://relay.example.com/ws?env=prod&region=cn-north-1",
      channel: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCD", // 36 位
      secret: "dsh-remote-control-secret-0123456789", // 36 字符
      relayToken: "RELAY-TOKEN-0123456789abcdefgh",
    }),
  },
];

for (const c of cases) {
  const qr = encodeToMatrix(c.uri);
  const decoded = decodeWithJsqr(qr);
  check(
    `jsqr 解码回原文：${c.name}（v${qr.version}, mask ${qr.mask}, ${qr.size}×${qr.size}）`,
    decoded === c.uri,
    decoded === null ? "jsqr 无法识别" : "解码不一致: " + decoded?.slice(0, 80),
  );
  check(`  尺寸 = 4×version+17：${c.name}`, qr.size === qr.version * 4 + 17);
  check(`  版本在 1–10（byte/ECC-M 范围）：${c.name}`, qr.version >= 1 && qr.version <= 10);
}

// ---- 3. 矩阵级自检：格式信息 + 反向布局 + RS 校验 --------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function gfPow(base, exp) {
  let r = 1;
  for (let i = 0; i < exp; i++) r = gfMul(r, base);
  return r;
}
/** RS 码字在 α^0..α^(eccLen-1) 处的校验子；全零 = ECC 自洽。 */
function syndromesAllZero(codeword, eccLen) {
  for (let s = 0; s < eccLen; s++) {
    let x = 0;
    const alphaS = gfPow(2, s);
    for (const c of codeword) x = gfMul(x, alphaS) ^ c;
    if (x !== 0) return false;
  }
  return true;
}

const ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]; // v9=5(3×36+2×37), v10=5(4×43+1×44)

function selfCheckDecode(qr) {
  const size = qr.size;
  const version = (size - 17) / 4;

  // 读第一份格式信息（左上角；LSB-first）
  const read = [];
  for (let i = 0; i <= 5; i++) read.push(qr.modules[i][8] ? 1 : 0);
  read.push(qr.modules[7][8] ? 1 : 0);
  read.push(qr.modules[8][8] ? 1 : 0);
  read.push(qr.modules[8][7] ? 1 : 0);
  for (let i = 9; i < 15; i++) read.push(qr.modules[8][14 - i] ? 1 : 0);
  let fmtBits = 0;
  for (let i = 0; i < 15; i++) fmtBits |= read[i] << i;
  const unmasked = fmtBits ^ 0x5412;
  // BCH(15,5)：用高 5 位重算低 10 位
  let rem = unmasked >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bchOk = rem === (unmasked & 0x3ff);
  const eclBits = (unmasked >>> 13) & 0x3;
  const mask = (unmasked >>> 10) & 0x7;

  // 独立重建功能模块图
  const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) isFunc[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const alignPos = [6];
  for (let pos = size - 7; alignPos.length < numAlign; pos -= step) alignPos.splice(1, 0, pos);
  for (let i = 0; i < numAlign; i++) {
    for (let j = 0; j < numAlign; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(alignPos[i] + dx, alignPos[j] + dy);
    }
  }
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 0; i < 7; i++) mark(8, size - 1 - i);
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }

  const maskFn = (m, x, y) => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  };

  // 反掩模 + 蛇形回读码字（rawModules 含对齐/版本图形扣减）
  const numAlign0 = Math.floor(version / 7) + 2;
  let rawModules = (16 * version + 128) * version + 64;
  if (version >= 2) rawModules -= (25 * numAlign0 - 10) * numAlign0 - 55;
  if (version >= 7) rawModules -= 36;
  const totalCodewords = Math.floor(rawModules / 8);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && bits.length < totalCodewords * 8) {
          bits.push(qr.modules[y][x] !== maskFn(mask, x, y) ? 1 : 0);
        }
      }
    }
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // 反交织：短块在 data/ecc 交界处（i == shortBlockLen - eccLen）跳过一个占位
  const numBlocks = NUM_BLOCKS_M[version - 1];
  const eccLen = ECC_PER_BLOCK_M[version - 1];
  const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
  const shortBlockLen = Math.floor(totalCodewords / numBlocks);
  const blocks = Array.from({ length: numBlocks }, () => []);
  let idx = 0;
  for (let i = 0; i <= shortBlockLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortBlockLen - eccLen && j < numShortBlocks) continue; // 占位字节
      blocks[j].push(codewords[idx++]);
    }
  }
  const rsOk = blocks.every((b) => syndromesAllZero(b, eccLen));

  // 拼接数据段 → byte 模式解析
  const dataBytes = [];
  for (const b of blocks) for (let i = 0; i < b.length - eccLen; i++) dataBytes.push(b[i]);
  const dbits = [];
  for (const byte of dataBytes) for (let i = 7; i >= 0; i--) dbits.push((byte >>> i) & 1);
  let p = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++];
    return v;
  };
  const mode = take(4);
  const len = take(version <= 9 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));

  return { bchOk, eclBits, mask, rsOk, mode, payload: new TextDecoder().decode(new Uint8Array(out)) };
}

const qrMain = encodeToMatrix(uri);
const self = selfCheckDecode(qrMain);
check("格式信息 BCH(15,5) 校验通过", self.bchOk);
check("格式信息 ECC 级别 = M（格式位 00）", self.eclBits === 0, "got " + self.eclBits);
check("反向读出的掩模号与编码器一致（" + qrMain.mask + "）", self.mask === qrMain.mask, "got " + self.mask);
check("所有数据块 RS syndrome 全零（ECC 自洽）", self.rsOk);
check("模式指示符 = byte 模式（0100）", self.mode === 0b0100, "got " + self.mode.toString(2));
check("矩阵级解析回原 URI", self.payload === uri, self.payload?.slice(0, 80));

// ---- 4. 全版本回归（1–10，每版取该版 byte 容量上限，jsqr 解码）-----------------
// 容量 = dataCodewords*8 - 4(mode) - (8|16)(count) 再除 8，逐版为
// 14/26/42/62/84/106/122/152/180/213（v9=180 是 5 块结构 182 数据码字的推论）。
const CAPACITIES = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
let sweepOk = true;
const sweepDetail = [];
for (const [verStr, cap] of Object.entries(CAPACITIES)) {
  const ver = Number(verStr);
  // 载荷用可打印 ASCII（含 URL 编码形态的字符集），长度 = 容量上限
  const payload = Array.from({ length: cap }, (_, i) => String.fromCharCode(0x30 + (i % 10))).join("");
  let qr;
  try {
    qr = encodeToMatrix(payload);
  } catch (e) {
    sweepOk = false;
    sweepDetail.push(`v${ver} 抛错: ${e.message}`);
    continue;
  }
  const decoded = decodeWithJsqr(qr);
  if (qr.version !== ver || decoded !== payload) {
    sweepOk = false;
    sweepDetail.push(`v${ver}: 实际 v${qr.version} ${decoded === payload ? "" : "解码不一致"}`);
  }
}
check("全版本 1–10 容量上限载荷均可生成并被 jsqr 解回", sweepOk, sweepDetail.join("; "));
if (sweepOk) console.log("      " + Object.entries(CAPACITIES).map(([v, c]) => `v${v}:${c}B`).join(" "));

// ---- 5. SVG / ASCII 渲染管线 ---------------------------------------------------
const rendered = renderPairing(uri);
check("SVG 根为 <svg …> 且闭合", rendered.svg.startsWith("<svg") && rendered.svg.trim().endsWith("</svg>"));
check("SVG viewBox 含 4 模块静区（size+8）", rendered.svg.includes(`viewBox="0 0 ${rendered.size + 8} ${rendered.size + 8}"`));
const svgPathCount = (rendered.svg.match(/M\d+ \d+h1v1h-1z/g) || []).length;
const darkCount = qrMain.modules.reduce((acc, row) => acc + row.filter(Boolean).length, 0);
check("SVG path 黑模块数与矩阵一致（" + darkCount + "）", svgPathCount === darkCount, svgPathCount + " vs " + darkCount);
check("ASCII 行数 = size + 2×静区(2)", rendered.ascii.split("\n").length === rendered.size + 4);
check(
  "ASCII 每行等宽（每模块 2 字符）且含黑块",
  rendered.ascii.split("\n").every((l) => l.length === (rendered.size + 4) * 2) && rendered.ascii.includes("██"),
);

// ASCII 形态过 jsqr（每模块 2 字符宽抵消终端字符 2:1 宽高比，栅格化后为正方形）
function asciiToRaster(ascii, scale = 4) {
  const lines = ascii.split("\n");
  const rows = lines.length;
  const cols = lines[0].length / 2;
  const dim = cols * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (lines[r].slice(c * 2, c * 2 + 2) !== "██") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (r * scale + dy) * dim + (c * scale + dx);
          rgba[px * 4] = 0;
          rgba[px * 4 + 1] = 0;
          rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data: rgba, width: dim, height: dim };
}
const asciiImg = asciiToRaster(rendered.ascii);
const asciiDecoded = jsqr(asciiImg.data, asciiImg.width, asciiImg.height);
check("ASCII 二维码可被 jsqr 解码回原 URI", asciiDecoded?.data === uri, asciiDecoded?.data?.slice(0, 80) ?? "无法识别");

// ---- 6. 脱敏（§3.5 日志安全）---------------------------------------------------
const red = redactUri(uri);
check("redactUri 抹掉 secret", !red.includes(sample.secret) && red.includes("s=***"), red);
check("redactUri 抹掉 token", !red.includes(encodeURIComponent(sample.relayToken)) && red.includes("t=***"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
