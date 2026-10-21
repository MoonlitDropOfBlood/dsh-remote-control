/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 加密层：HKDF-SHA256 + AES-256-GCM（@kit.CryptoArchitectureKit）。
 * 契约：仓库根 docs/PROTOCOL.md §3 / §7（v1.0.1 载荷布局；文档版本 v1.0.2）。
 *
 * 契约要点：
 *   - key = HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"),
 *                      info=UTF8("e2e|" + channel), L=32)
 *   - frame.data = base64url( iv(12) || ciphertext || tag(16) )   ← v1.0.1 布局
 *   - AAD = UTF8("dshrc|" + 发送方 role + "|" + seq)
 *   - KAT（契约 §7）：assertKat() 在连接建立前执行，逐字节核对 key/ct/tag（空 AAD）。
 *
 * cryptoFramework 的 GCM 用法（官方文档 crypto-aes-sym-encrypt-decrypt-gcm）：
 *   加密：initSync(ENCRYPT, key, GcmParamsSpec{iv, aad}) → updateSync(pt) 得密文，
 *         doFinalSync(null) 返回 16 字节 authTag（官方示例即此写法）。
 *   解密：把收到的 tag 填进 GcmParamsSpec.authTag → initSync(DECRYPT) →
 *         updateSync(ct) → doFinalSync(null)（GCM 解密时通常为空），
 *         认证失败在 doFinalSync 抛 BusinessError 17630001。
 *   小数据也可一次性 doFinalSync({data})：返回值 = ciphertext || authTag（末 16 字节为 tag）。
 */
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import {
  AAD_PREFIX,
  HELLO_SIG_PREFIX,
  HKDF_INFO_PREFIX,
  HKDF_KEY_LEN,
  HKDF_SALT,
  IV_LEN,
  KAT_CHANNEL,
  KAT_CT_HEX,
  KAT_IV_HEX,
  KAT_KEY_HEX,
  KAT_PT,
  KAT_SECRET,
  KAT_TAG_HEX,
  TAG_LEN
} from './protocol';

// AES-GCM 的 padding 字段被算法忽略；官方示例统一带 PKCS7 后缀。
const AES_GCM_ALG: string = 'AES256|GCM|PKCS7';
const HKDF_KDF_ALG: string = 'HKDF|SHA256|EXTRACT_AND_EXPAND';
const HKDF_SPEC_ALG: string = 'HKDF';
const HMAC_ALG: string = 'HMAC|SHA256';
const GCM_PARAMS_ALG: string = 'GcmParamsSpec';

const encHelper: util.Base64Helper = new util.Base64Helper();
const textEncoder: util.TextEncoder = new util.TextEncoder();
const textDecoder: util.TextDecoder = new util.TextDecoder();

/** UTF-8 编码。 */
export function utf8Encode(s: string): Uint8Array {
  return textEncoder.encodeInto(s);
}

/** UTF-8 解码。 */
export function utf8Decode(b: Uint8Array): string {
  return textDecoder.decodeToString(b);
}

/** base64url（RFC 4648 §5，无填充）编码。 */
export function base64UrlEncode(b: Uint8Array): string {
  const std: string = encHelper.encodeToStringSync(b, util.Type.BASIC);
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码（兼容有/无填充）。 */
export function base64UrlDecode(s: string): Uint8Array {
  let std: string = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad: number = std.length % 4;
  if (pad === 2) {
    std += '==';
  } else if (pad === 3) {
    std += '=';
  } else if (pad === 1) {
    // 非法 base64：交给 decodeSync 抛错
  }
  return encHelper.decodeSync(std, util.Type.BASIC);
}

/** 字节数组拼接。 */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 随机字节（CSPRNG）。注意 generateRandomSync 返回 DataBlob，取 .data。 */
export function randomBytes(len: number): Uint8Array {
  const rand: cryptoFramework.Random = cryptoFramework.createRandom();
  const blob: cryptoFramework.DataBlob = rand.generateRandomSync(len);
  return blob.data;
}

/** bytes → 小写 hex（KAT 用）。 */
export function toHex(b: Uint8Array): string {
  let s: string = '';
  for (let i = 0; i < b.length; i++) {
    const h: string = b[i].toString(16);
    s += h.length === 1 ? '0' + h : h;
  }
  return s;
}

/** hex → bytes（KAT 用）。非法字符抛错。 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('fromHex: odd length');
  }
  const out: Uint8Array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte: number = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('fromHex: bad hex at ' + i * 2);
    }
    out[i] = byte;
  }
  return out;
}

/**
 * E2E 密钥派生（契约 §3.3）。
 * HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"),
 *             info=UTF8("e2e|" + channel), L=32)
 */
export async function deriveKey(secret: string, channel: string): Promise<Uint8Array> {
  const spec: cryptoFramework.HKDFSpec = {
    algName: HKDF_SPEC_ALG,
    key: utf8Encode(secret),
    salt: utf8Encode(HKDF_SALT),
    info: utf8Encode(HKDF_INFO_PREFIX + channel),
    keySize: HKDF_KEY_LEN
  };
  const kdf: cryptoFramework.Kdf = cryptoFramework.createKdf(HKDF_KDF_ALG);
  const out: cryptoFramework.DataBlob | null = await kdf.generateSecret(spec);
  if (out === null) {
    throw new Error('hkdf generateSecret returned null');
  }
  return out.data;
}

/** 以 E2E key 为密钥的 HMAC-SHA256（契约 §3.4 hello 签名）。 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  // Mac.init 需要 SymKey：用 HMAC|SHA256 规格把 32 字节裸 key 转成对称密钥。
  const keyGen: cryptoFramework.SymKeyGenerator = cryptoFramework.createSymKeyGenerator(HMAC_ALG);
  const symKey: cryptoFramework.SymKey = await keyGen.convertKey({ data: key });
  const mac: cryptoFramework.Mac = cryptoFramework.createMac(HMAC_ALG);
  await mac.init(symKey);
  await mac.update({ data: data });
  const out: cryptoFramework.DataBlob | null = await mac.doFinal();
  if (out === null) {
    throw new Error('mac doFinal returned null');
  }
  return out.data;
}

/**
 * hello 帧 sig（契约 §3.4）：
 * base64url(HMAC-SHA256(key, UTF8("hello|" + role + "|" + channel)))
 */
export async function helloSig(key: Uint8Array, role: string, channel: string): Promise<string> {
  const macData: Uint8Array = utf8Encode(HELLO_SIG_PREFIX + role + '|' + channel);
  const macBytes: Uint8Array = await hmacSha256(key, macData);
  return base64UrlEncode(macBytes);
}

/** AAD（契约 §7）：UTF8("dshrc|" + 发送方 role + "|" + seq)。 */
export function aadOf(role: string, seq: number): Uint8Array {
  return utf8Encode(AAD_PREFIX + role + '|' + seq.toString());
}

/** 导入 32 字节裸 key 为 AES256 SymKey。 */
async function importAesKey(key: Uint8Array): Promise<cryptoFramework.SymKey> {
  const gen: cryptoFramework.SymKeyGenerator = cryptoFramework.createSymKeyGenerator('AES256');
  return await gen.convertKey({ data: key });
}

/**
 * AES-256-GCM 加密，返回 ct||tag（tag 恒为末 16 字节）。
 * 官方示例模式：initSync(ENCRYPT) → updateSync(pt) 得密文，doFinalSync(null) 得 authTag。
 */
async function gcmEncrypt(key: Uint8Array, ivBuf: Uint8Array, aad: Uint8Array,
  ptBuf: Uint8Array): Promise<Uint8Array> {
  const symKey: cryptoFramework.SymKey = await importAesKey(key);
  const cipher: cryptoFramework.Cipher = cryptoFramework.createCipher(AES_GCM_ALG);
  const params: cryptoFramework.GcmParamsSpec = {
    iv: { data: ivBuf },
    aad: { data: aad },
    authTag: { data: new Uint8Array(TAG_LEN) },
    algName: GCM_PARAMS_ALG
  };
  cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, symKey, params);
  // 真机语义（SDK d.ts doFinalSync 文档）：GCM 单次加密中 updateSync 与 doFinalSync
  // 的输出「拼接后」才是 ct||tag（authTag 恒为末 16 字节）；且真机上 updateSync 对
  // 小数据可能返回 null（输出被缓冲推迟到 doFinal）——两处都必须判空再拼接。
  const mid: cryptoFramework.DataBlob | null = cipher.updateSync({ data: ptBuf });
  const fin: cryptoFramework.DataBlob | null = cipher.doFinalSync(null);
  const out: Uint8Array = concatBytes(mid === null ? new Uint8Array(0) : mid.data,
    fin === null ? new Uint8Array(0) : fin.data);
  if (out.length < TAG_LEN) {
    throw new Error('gcm encrypt: output shorter than authTag');
  }
  return out;
}

/**
 * AES-256-GCM 解密，入参 ct||tag（tag 为末 16 字节），返回明文。
 * 认证失败在 doFinalSync 抛 BusinessError 17630001（调用方丢弃该帧）。
 */
async function gcmDecrypt(key: Uint8Array, ivBuf: Uint8Array, aad: Uint8Array,
  ctAndTag: Uint8Array): Promise<Uint8Array> {
  if (ctAndTag.length < TAG_LEN) {
    throw new Error('gcm decrypt: ciphertext too short');
  }
  const ct: Uint8Array = ctAndTag.slice(0, ctAndTag.length - TAG_LEN);
  const tag: Uint8Array = ctAndTag.slice(ctAndTag.length - TAG_LEN);
  const symKey: cryptoFramework.SymKey = await importAesKey(key);
  const cipher: cryptoFramework.Cipher = cryptoFramework.createCipher(AES_GCM_ALG);
  const params: cryptoFramework.GcmParamsSpec = {
    iv: { data: ivBuf },
    aad: { data: aad },
    authTag: { data: tag },
    algName: GCM_PARAMS_ALG
  };
  cipher.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, symKey, params);
  // 同 gcmEncrypt：update/doFinal 输出拼接才是明文；真机任一侧都可能返回 null。
  // 认证失败在 doFinalSync 抛 BusinessError 17630001（调用方丢弃该帧）。
  const mid: cryptoFramework.DataBlob | null = cipher.updateSync({ data: ct });
  const fin: cryptoFramework.DataBlob | null = cipher.doFinalSync(null);
  return concatBytes(mid === null ? new Uint8Array(0) : mid.data,
    fin === null ? new Uint8Array(0) : fin.data);
}

/**
 * 加密明文为 frame.data（契约 §7 v1.0.1）：base64url( iv(12) || ct || tag(16) )。
 * AAD = UTF8("dshrc|" + role + "|" + seq)。iv 缺省时用 CSPRNG 随机 12 字节；KAT 传固定 iv。
 */
export async function seal(key: Uint8Array, role: string, seq: number, plaintext: string,
  iv?: Uint8Array): Promise<string> {
  const ivBuf: Uint8Array = iv !== undefined ? iv : randomBytes(IV_LEN);
  const aad: Uint8Array = aadOf(role, seq);
  const ctTag: Uint8Array = await gcmEncrypt(key, ivBuf, aad, utf8Encode(plaintext));
  return base64UrlEncode(concatBytes(ivBuf, ctTag));
}

/**
 * 解密 frame.data（iv||ct||tag 布局）。role 为发送方 role（对 client 收帧而言是 "host"），
 * seq 为该消息的 frame.seq。认证失败抛错（调用方丢弃该帧）。
 */
export async function open(key: Uint8Array, role: string, seq: number, data: string): Promise<string> {
  const raw: Uint8Array = base64UrlDecode(data);
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error('open: ciphertext too short');
  }
  const ivBuf: Uint8Array = raw.slice(0, IV_LEN);
  const ctTag: Uint8Array = raw.slice(IV_LEN);
  const aad: Uint8Array = aadOf(role, seq);
  const pt: Uint8Array = await gcmDecrypt(key, ivBuf, aad, ctTag);
  return utf8Decode(pt);
}

/**
 * KAT 自检（契约 §7，连接建立前执行）。全部通过返回 true；任何一步失败抛出带明细的 Error。
 * 核对项：
 *  1. deriveKey(KAT_SECRET, KAT_CHANNEL) 的 hex == KAT_KEY_HEX
 *  2. 固定 ivHex 加密 KAT_PT（空 AAD）得到的 ct||tag hex == KAT_CT_HEX || KAT_TAG_HEX
 *  3. 用 ct||tag + 固定 iv 解密还原 KAT_PT
 *  4. AAD 绑定：seal(role=host,seq=7) 能被 open(role=host,seq=7) 还原，
 *     但 open(role=client,seq=7) 必须失败（防串帧/重放）
 */
export async function assertKat(): Promise<boolean> {
  // 1. HKDF key（契约 §7 keyHex）
  const key: Uint8Array = await deriveKey(KAT_SECRET, KAT_CHANNEL);
  const keyHex: string = toHex(key);
  if (keyHex !== KAT_KEY_HEX) {
    throw new Error('KAT key mismatch: got ' + keyHex + ' want ' + KAT_KEY_HEX);
  }

  // 2. 固定 iv + 空 AAD 加密（契约 §7 ctHex / tagHex）
  const ivBuf: Uint8Array = fromHex(KAT_IV_HEX);
  const emptyAad: Uint8Array = new Uint8Array(0);
  const ctTag: Uint8Array = await gcmEncrypt(key, ivBuf, emptyAad, utf8Encode(KAT_PT));
  const ctOnly: Uint8Array = ctTag.slice(0, ctTag.length - TAG_LEN);
  const tagOnly: Uint8Array = ctTag.slice(ctTag.length - TAG_LEN);
  const ctHex: string = toHex(ctOnly);
  const tagHex: string = toHex(tagOnly);
  if (ctHex !== KAT_CT_HEX) {
    throw new Error('KAT ct mismatch: got ' + ctHex + ' want ' + KAT_CT_HEX);
  }
  if (tagHex !== KAT_TAG_HEX) {
    throw new Error('KAT tag mismatch: got ' + tagHex + ' want ' + KAT_TAG_HEX);
  }

  // 3. 固定 iv + 空 AAD 解密还原
  const roundtrip: string = utf8Decode(await gcmDecrypt(key, ivBuf, emptyAad, ctTag));
  if (roundtrip !== KAT_PT) {
    throw new Error('KAT decrypt mismatch: got ' + roundtrip);
  }

  // 4. AAD 绑定往返 + 跨 role 必须失败
  const sample: string = '{"hello":"world"}';
  const sealed: string = await seal(key, 'host', 7, sample);
  const back: string = await open(key, 'host', 7, sealed);
  if (back !== sample) {
    throw new Error('KAT aad roundtrip mismatch: got ' + back);
  }
  let crossRejected: boolean = false;
  try {
    await open(key, 'client', 7, sealed);
  } catch (e) {
    crossRejected = true;
  }
  if (!crossRejected) {
    throw new Error('KAT aad role binding not enforced');
  }
  return true;
}

/** 便捷入口：把异常转成可展示文本（UI 自检用）。 */
export async function runKatCheck(): Promise<string> {
  try {
    const ok: boolean = await assertKat();
    return ok ? 'KAT 通过 ✓（HKDF / AES-256-GCM 与契约 §7 逐字节一致）' : 'KAT 失败';
  } catch (e) {
    const msg: string = e instanceof Error ? e.message : businessErrText(e);
    return 'KAT 失败：' + msg;
  }
}

/** 把未知异常安全地转成文本（避免 any）。 */
function businessErrText(e: Object): string {
  const err: BusinessError = e as BusinessError;
  return 'BusinessError code=' + err.code + ' ' + err.message;
}
