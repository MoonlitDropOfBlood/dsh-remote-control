/*
 * Copyright (c) 2026 dukedsh.
 * 配对二维码解析（契约 docs/PROTOCOL.md §3.5，v1.0.3）。
 *
 * PC 端（DSH 插件 /remote-pairing）出码：
 *   dshrc://pair?r=<encodeURIComponent(relayUrl)>&c=<channel>&s=<secret>[&t=<encodeURIComponent(relayToken)>]
 *
 * 手机端必须同时接受两种扫描结果形态（§3.5 明文要求）：
 *   1) 完整 URI：含 `dshrc://pair?` 前缀；
 *   2) 裸 query：`r=…&c=…&s=…[&t=…]`（用户复制/系统裁剪掉前缀的情形）。
 *
 * 解析失败 / 字段缺失时：返回明确 reason 由 UI 层 Toast 并回落手动输入（不静默丢弃）；
 * 已解析出的字段照常随结果返回，由 UI 层回填输入框，方便用户手动修补。
 * 字段级校验复用 store.validatePairing（channel 正则 / ws(s) 前缀 / secret 长度）。
 *
 * 本文件不改动 protocol/crypto/link 的任何协议与加密逻辑。
 */
import { PairingConfig, validatePairing } from './store';

/** 完整 URI 前缀（比较时不区分大小写；长度与大小写无关，可直接按前缀切）。 */
const URI_PREFIX: string = 'dshrc://pair?';
/** 仅 `dshrc://pair` 没有 query 的情形也归为「配对码但缺参数」。 */
const URI_BARE: string = 'dshrc://pair';

/** 解析结果：ok=false 时 reason 为可直接 Toast 的原因；cfg 为已解析出的字段（可能部分有值）。 */
export interface PairQrResult {
  ok: boolean;
  reason: string;
  cfg: PairingConfig;
}

function emptyCfg(): PairingConfig {
  const cfg: PairingConfig = { relayUrl: '', channel: '', secret: '', relayToken: '' };
  return cfg;
}

/**
 * 解码单个 query 值：契约要求 r/t 为 encodeURIComponent 编码，c/s 为免编码字符集。
 * 若值本身未编码（编码非法导致 decodeURIComponent 抛错），按原样返回，交给后续字段校验报错。
 */
function decodeParam(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return v;
  }
}

/**
 * 从扫描文本中取出 query 部分。
 * 判定规则：以「scheme://」开头的才算 URI 形态（scheme 必须出现在字符串开头，
 * 不能用 contains('://') —— 裸 query 里的 relayUrl 本身就含 wss://）；
 * 是 URI 却不是 dshrc://pair?… 的返回 null（形态无法识别）。
 */
function extractQuery(raw: string): string | null {
  const lower: string = raw.toLowerCase();
  if (lower.startsWith(URI_PREFIX)) {
    return raw.substring(URI_PREFIX.length);
  }
  const hasScheme: boolean = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  if (hasScheme) {
    return null;
  }
  return raw;
}

/** 解析裸 query 串为 k=v 映射（以第一个 `=` 切分，值内可含 `=`；重复 key 后者覆盖）。 */
function parseQuery(query: string): Map<string, string> {
  const map: Map<string, string> = new Map<string, string>();
  const pairs: string[] = query.split('&');
  for (const pair of pairs) {
    if (pair.length === 0) {
      continue;
    }
    const eq: number = pair.indexOf('=');
    if (eq < 0) {
      map.set(pair, '');
      continue;
    }
    map.set(pair.substring(0, eq), pair.substring(eq + 1));
  }
  return map;
}

/**
 * 解析配对二维码扫描文本（契约 §3.5）。
 * 成功：ok=true，cfg 四字段齐全且通过字段级校验（可直接保存并连接）。
 * 失败：ok=false，reason 为明确原因（形态不认识 / 缺字段 / 字段不合法），
 *       cfg 里保留已经解析出来的部分字段供回填。
 */
export function parsePairQr(text: string): PairQrResult {
  const raw: string = text.trim();
  if (raw.length === 0) {
    return { ok: false, reason: '扫码结果为空', cfg: emptyCfg() };
  }
  const lower: string = raw.toLowerCase();
  if (lower.startsWith(URI_BARE) && !lower.startsWith(URI_PREFIX)) {
    return { ok: false, reason: '配对二维码缺少参数（应为 dshrc://pair?r=…&c=…&s=…）', cfg: emptyCfg() };
  }
  const query: string | null = extractQuery(raw);
  if (query === null) {
    return { ok: false, reason: '不是 DSH 配对二维码（期望 dshrc://pair?… 或 r=…&c=…&s=…）', cfg: emptyCfg() };
  }
  const map: Map<string, string> = parseQuery(query);

  const missing: string[] = [];
  const relayUrlRaw: string = map.get('r') ?? '';
  const channelRaw: string = map.get('c') ?? '';
  const secretRaw: string = map.get('s') ?? '';
  if (relayUrlRaw.length === 0) {
    missing.push('r（中继地址）');
  }
  if (channelRaw.length === 0) {
    missing.push('c（channel）');
  }
  if (secretRaw.length === 0) {
    missing.push('s（secret）');
  }

  const cfg: PairingConfig = {
    relayUrl: decodeParam(relayUrlRaw).trim(),
    channel: decodeParam(channelRaw).trim(),
    secret: decodeParam(secretRaw).trim(),
    relayToken: decodeParam(map.get('t') ?? '').trim()
  };
  if (missing.length > 0) {
    return { ok: false, reason: '配对二维码缺少必填字段：' + missing.join('、'), cfg: cfg };
  }

  const invalid: string = validatePairing(cfg);
  if (invalid.length > 0) {
    return { ok: false, reason: '配对二维码字段不合法：' + invalid, cfg: cfg };
  }
  return { ok: true, reason: '', cfg: cfg };
}
