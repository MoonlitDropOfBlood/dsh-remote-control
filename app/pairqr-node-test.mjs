// 临时脚本：pairqr.ets 解析逻辑的 Node 镜像（代码逐行对应 model/pairqr.ets + store.validatePairing），跑解析测试样例。
function validatePairing(cfg) {
  if (cfg.relayUrl.length === 0) return '请填写中继地址（wss://…）';
  if (!cfg.relayUrl.startsWith('ws://') && !cfg.relayUrl.startsWith('wss://')) return '中继地址必须以 ws:// 或 wss:// 开头';
  if (cfg.channel.length === 0) return '请填写配对频道（channel）';
  if (!/^[A-Z2-7]{16,64}$/.test(cfg.channel)) return 'channel 须为 16~64 位大写字母 A-Z / 数字 2-7';
  if (cfg.secret.length < 32) return 'secret 至少 32 个字符';
  return '';
}
const URI_PREFIX = 'dshrc://pair?';
const URI_BARE = 'dshrc://pair';
function emptyCfg() { return { relayUrl: '', channel: '', secret: '', relayToken: '' }; }
function decodeParam(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
function extractQuery(raw) {
  const lower = raw.toLowerCase();
  if (lower.startsWith(URI_PREFIX)) return raw.substring(URI_PREFIX.length);
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  if (hasScheme) return null;
  return raw;
}
function parseQuery(query) {
  const map = new Map();
  const pairs = query.split('&');
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) { map.set(pair, ''); continue; }
    map.set(pair.substring(0, eq), pair.substring(eq + 1));
  }
  return map;
}
function parsePairQr(text) {
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, reason: '扫码结果为空', cfg: emptyCfg() };
  const lower = raw.toLowerCase();
  if (lower.startsWith(URI_BARE) && !lower.startsWith(URI_PREFIX)) {
    return { ok: false, reason: '配对二维码缺少参数（应为 dshrc://pair?r=…&c=…&s=…）', cfg: emptyCfg() };
  }
  const query = extractQuery(raw);
  if (query === null) return { ok: false, reason: '不是 DSH 配对二维码（期望 dshrc://pair?… 或 r=…&c=…&s=…）', cfg: emptyCfg() };
  const map = parseQuery(query);
  const missing = [];
  const relayUrlRaw = map.get('r') ?? '';
  const channelRaw = map.get('c') ?? '';
  const secretRaw = map.get('s') ?? '';
  if (relayUrlRaw.length === 0) missing.push('r（中继地址）');
  if (channelRaw.length === 0) missing.push('c（channel）');
  if (secretRaw.length === 0) missing.push('s（secret）');
  const cfg = {
    relayUrl: decodeParam(relayUrlRaw).trim(),
    channel: decodeParam(channelRaw).trim(),
    secret: decodeParam(secretRaw).trim(),
    relayToken: decodeParam(map.get('t') ?? '').trim()
  };
  if (missing.length > 0) return { ok: false, reason: '配对二维码缺少必填字段：' + missing.join('、'), cfg };
  const invalid = validatePairing(cfg);
  if (invalid.length > 0) return { ok: false, reason: '配对二维码字段不合法：' + invalid, cfg };
  return { ok: true, reason: '', cfg };
}

const SEC = 'dshrc-demo-secret-0123456789abcdefgh'; // 36 chars ≥ 32
const CH = 'ABCDEFGHJKLMNPQR'; // 16 位 A-Z2-7 合法 channel
const cases = [
  ['① 完整 URI（r/t 均 encodeURIComponent）',
    `dshrc://pair?r=${encodeURIComponent('wss://relay.example.com/ws')}&c=${CH}&s=${SEC}&t=${encodeURIComponent('tok en/+=?x')}`],
  ['② 裸 query（无 dshrc://pair? 前缀，r 未编码）',
    `r=wss://relay.example.com/ws&c=${CH}&s=${SEC}`],
  ['③ 坏输入：扫到别的 scheme',
    'https://example.com/remote-pairing?ch=XXXX'],
  ['④ 缺字段（无 s）',
    `r=wss://relay.example.com/ws&c=${CH}`],
  ['⑤ 字段不合法（channel 小写/过短）', `r=wss://relay.example.com/ws&c=abcdefg&s=${SEC}`],
  ['⑥ dshrc://pair 裸前缀（无 query）', 'dshrc://pair'],
  ['⑦ 空串', '   '],
  ['⑧ secret 过短', `r=wss://relay.example.com/ws&c=${CH}&s=short`],
];
for (const [name, input] of cases) {
  const r = parsePairQr(input);
  console.log(`\n== ${name}\ninput: ${input}\nok=${r.ok} reason=${JSON.stringify(r.reason)}\ncfg=${JSON.stringify(r.cfg)}`);
}
