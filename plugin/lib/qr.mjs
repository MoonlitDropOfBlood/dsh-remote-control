// lib/qr.mjs —— 极小 QR 码编码器（运行时零依赖；byte 模式、ECC-M、版本自适应 1–10）。
//
// 实现移植/精简自 Project Nayuki 的 “QR Code generator library”
// （MIT License，Copyright (c) Project Nayuki，https://www.nayuki.io/page/qr-code-generator-library）。
// 本文件按本插件需要重写为紧凑 ESM：仅保留 byte 模式 + ECC-M + 版本 1–10，
// 去掉了原库的多模式编码与版本 11–40。QR 码格式本身是 ISO/IEC 18004 开放标准。
// 原作授权见上；本精简版随本插件以 MIT 发布（见 ../../LICENSE）。
//
// 对外 API：
//   encodeToMatrix(text)      -> { size, version, mask, modules }（modules[y][x] 为 true=黑）
//   toSvg(matrix, opts)       -> SVG 字符串（含 4 模块静区）
//   toAscii(matrix, opts)     -> 终端可直接扫的 ASCII 二维码字符串

// ---------------------------------------------------------------------------
// 版本参数表（仅 ECC-M 级、版本 1–10）。两张表均来自 ISO/IEC 18004 的标准
// RS 分块参数（已对照独立实现 jsqr 的 VERSIONS 表逐项核对：ecc/块数
// 10,16,26,18,24,16,18,22,22,26 与 1,1,1,2,2,4,4,4,5,5）。
// 注意：同一版本内各块数据长度可不同（短/长块由 (total, blocks) 推导，
// addEccAndInterleave 里 numShortBlocks/shortBlockLen 的算式即为此设计），
// 所以此表只需「每块 ecc 数」与「块数」两个维度。
// ---------------------------------------------------------------------------
const ECC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // 版本 1..10
const NUM_BLOCKS_M = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]; // 版本 1..10（v9=3×36+2×37，v10=4×43+1×44）
const MIN_VERSION = 1;
const MAX_VERSION = 10;
const ECC_FORMAT_BITS_M = 0; // 格式信息里的纠错级别位：L=1 M=0 Q=3 H=2

/** 版本 v 的原始数据模块数（去掉功能图形后的总容量，单位 bit）。 */
function getNumRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** 版本 v（ECC-M）可用的数据码字数。 */
function getNumDataCodewords(ver) {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver - 1] * NUM_BLOCKS_M[ver - 1];
}

// ---------------------------------------------------------------------------
// GF(256) Reed-Solomon（本原多项式 0x11D，与 QR 码标准一致）
// ---------------------------------------------------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 数据编码：分块 + RS 纠错 + 交织
// ---------------------------------------------------------------------------
function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_BLOCKS_M[ver - 1];
  const blockEccLen = ECC_PER_BLOCK_M[ver - 1];
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // 占位，使各块等长以便交织；交织时跳过
    blocks.push(dat.concat(Array.from(ecc)));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // 短块的占位字节在 data 段末尾（i == shortBlockLen - blockEccLen）被跳过
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

/** 把 UTF-8 文本编成数据码字序列（byte 模式 + 终止符 + 0xEC/0x11 填充）。 */
function buildDataCodewords(bytes, ver) {
  const capacityBits = getNumDataCodewords(ver) * 8;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte 模式指示符
  push(bytes.length, ver <= 9 ? 8 : 16); // 字符计数（版本 1–9 为 8 位，10+ 为 16 位）
  for (const b of bytes) push(b, 8);
  if (bits.length > capacityBits) throw new Error("QR: data too long for version " + ver);

  // 终止符（至多 4 个 0）→ 补齐到字节边界 → 0xEC/0x11 交替填充
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 矩阵：功能图形 / 数据布局 / 掩模 / 格式与版本信息
// ---------------------------------------------------------------------------
function getBit(x, i) {
  return ((x >>> i) & 1) !== 0;
}

/** 对齐图形中心坐标（版本 1 无对齐图形）。 */
function getAlignmentPatternPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function makeQrModules(ver, codewords) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunc = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  const drawFinder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunc(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };

  const drawAlignment = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunc(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  const drawFormatBits = (mask) => {
    const data = (ECC_FORMAT_BITS_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    // 第一份拷贝（左上角定位图形周围）
    for (let i = 0; i <= 5; i++) setFunc(8, i, getBit(bits, i));
    setFunc(8, 7, getBit(bits, 6));
    setFunc(8, 8, getBit(bits, 7));
    setFunc(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunc(14 - i, 8, getBit(bits, i));
    // 第二份拷贝（右上/左下）
    for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, getBit(bits, i));
    setFunc(8, size - 8, true); // 固定的黑模块
  };

  // 定时图形
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  // 三个定位图形（含分隔带）
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  // 对齐图形（避开与定位图形重叠的三个角）
  const alignPos = getAlignmentPatternPositions(ver);
  const n = alignPos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(alignPos[i], alignPos[j]);
    }
  }
  // 版本信息（版本 ≥7）
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }
  drawFormatBits(0); // 占位；选定掩模后重画

  // 数据布局：右下起蛇形上行/下行，每两列一组，跳过第 6 列
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < codewords.length * 8) {
          modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const maskFn = (mask, x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: throw new Error("QR: bad mask " + mask);
    }
  };

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskFn(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  // 掩模罚分（N1/N2/N3/N4，ISO/IEC 18000 定义）
  const finderPenaltyCountPatterns = (runHistory) => {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  };
  const finderPenaltyAddHistory = (currentRunLength, runHistory) => {
    if (runHistory[0] === 0) currentRunLength += size; // 初始亮边
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };
  const finderPenaltyTerminateAndCount = (currentRunColor, currentRunLength, runHistory) => {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += size; // 末尾亮边
    finderPenaltyAddHistory(currentRunLength, runHistory);
    return finderPenaltyCountPatterns(runHistory);
  };
  const getPenaltyScore = () => {
    let result = 0;
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3;
          else if (runX > 5) result++;
        } else {
          finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * 40;
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += 3;
          else if (runY > 5) result++;
        } else {
          finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * 40;
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of modules) for (const c of row) dark += c ? 1 : 0;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  // 选掩模：罚分最小者
  let bestMask = 0;
  let minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = getPenaltyScore();
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    applyMask(mask); // XOR 恢复
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return { size, modules, mask: bestMask };
}

/**
 * 把文本编码为 QR 矩阵（byte 模式，UTF-8，ECC-M，版本自适应 1–10）。
 * @param {string} text
 * @returns {{size:number, version:number, mask:number, modules:boolean[][]}}
 */
export function encodeToMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = -1;
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (getNumDataCodewords(v) * 8 >= 4 + ccBits + bytes.length * 8) {
      version = v;
      break;
    }
  }
  if (version < 0) {
    throw new Error("QR: payload too long for version ≤ " + MAX_VERSION + " (" + bytes.length + " bytes)");
  }
  const data = buildDataCodewords(bytes, version);
  const codewords = addEccAndInterleave(data, version);
  const { size, modules, mask } = makeQrModules(version, codewords);
  return { size, version, mask, modules };
}

/**
 * 渲染 SVG（默认 8px/模块 + 4 模块静区，黑底白底对比）。
 * @param {{size:number, modules:boolean[][]}} qr
 * @param {{scale?:number, quiet?:number, dark?:string, light?:string}} [opts]
 */
export function toSvg(qr, opts = {}) {
  const scale = Number.isInteger(opts.scale) && opts.scale > 0 ? opts.scale : 8;
  const quiet = Number.isInteger(opts.quiet) && opts.quiet >= 0 ? opts.quiet : 4;
  const dark = typeof opts.dark === "string" ? opts.dark : "#000000";
  const light = typeof opts.light === "string" ? opts.light : "#ffffff";
  const n = qr.size;
  const dim = (n + quiet * 2) * scale;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${n + quiet * 2} ${n + quiet * 2}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>\n`
  );
}

/**
 * 渲染 ASCII 二维码（每模块两字符宽以保持方形比例；含静区，可直接扫屏）。
 * @param {{size:number, modules:boolean[][]}} qr
 * @param {{quiet?:number}} [opts]
 */
export function toAscii(qr, opts = {}) {
  const quiet = Number.isInteger(opts.quiet) && opts.quiet >= 0 ? opts.quiet : 2;
  const on = "██";
  const off = "  ";
  const lines = [];
  const n = qr.size;
  const blank = off.repeat(n + quiet * 2);
  for (let i = 0; i < quiet; i++) lines.push(blank);
  for (let y = 0; y < n; y++) {
    let row = off.repeat(quiet);
    for (let x = 0; x < n; x++) row += qr.modules[y][x] ? on : off;
    lines.push(row + off.repeat(quiet));
  }
  for (let i = 0; i < quiet; i++) lines.push(blank);
  return lines.join("\n");
}
