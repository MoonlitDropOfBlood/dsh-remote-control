// lib/protocol.mjs — dsh-remote-control 协议 v1 的加密与信封层（契约
// docs/plans/2026-10-20-dsh-remote-control-protocol.md §3 / §5 / §7）。
//
// 职责（严格限定在协议内，不含传输与业务）：
//   - HKDF-SHA256 E2E 密钥派生（§3.3）
//   - hello 帧 HMAC 签名（§3.4）
//   - AES-256-GCM 业务消息封解（§7：base64url(iv(12) || ct || tag(16))，
//     AAD = UTF8("dshrc|" + 发送方 role + "|" + seq)）
//   - 业务信封编解码（§5：{id, type, ts, payload}）
//   - 契约 §7 KAT 自测 assertKat()：启动时调用，失败必须禁用连接。
//
// 与 dsh-remote-control-e2e/protocol.mjs（Lead 维护的第三份实现）逐字节
// 兼容；两份实现的 KAT 向量一致即证明两端互通。
import crypto from "node:crypto";

export const PROTO_VERSION = 1;
export const ROLE_HOST = "host";
export const ROLE_CLIENT = "client";

const HKDF_SALT = "dsh-remote-control/v1";
const HKDF_INFO_PREFIX = "e2e|";

/**
 * HKDF-SHA256 派生 32 字节 E2E key（契约 §3.3）。
 * key = HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"),
 *                   info=UTF8("e2e|" + channel), L=32)
 * @param {string} secret 配对 secret（≥32 字符随机串）
 * @param {string} channel 配对 channel（16 位 base32）
 * @returns {Buffer} 32 字节密钥
 */
export function deriveKey(secret, channel) {
  if (typeof secret !== "string" || secret === "") throw new Error("deriveKey: secret required");
  if (typeof channel !== "string" || channel === "") throw new Error("deriveKey: channel required");
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(HKDF_SALT, "utf8"),
      Buffer.from(HKDF_INFO_PREFIX + channel, "utf8"),
      32,
    ),
  );
}

/**
 * hello 帧轻量握手证明（契约 §3.4）：
 * sig = base64url(HMAC-SHA256(key, UTF8("hello|" + role + "|" + channel)))
 * @param {Buffer} key deriveKey 的产物
 * @param {"host"|"client"} role
 * @param {string} channel
 */
export function helloSig(key, role, channel) {
  return crypto
    .createHmac("sha256", key)
    .update("hello|" + role + "|" + channel, "utf8")
    .digest("base64url");
}

/** AAD（契约 §7）：UTF8("dshrc|" + 发送方 role + "|" + seq)。 */
function aadOf(role, seq) {
  return Buffer.from("dshrc|" + role + "|" + seq, "utf8");
}

/**
 * 加密一条业务消息为 frame.data（契约 §7）。
 * 载荷布局：base64url( iv(12) || ciphertext || tag(16) )；iv 每消息随机。
 * @param {Buffer} key
 * @param {"host"|"client"} role 发送方 role（进入 AAD）
 * @param {number} seq 该消息的 frame.seq（进入 AAD，防重放/串帧）
 * @param {object} message 明文业务消息（JSON 可序列化）
 * @param {Buffer} [iv] 固定 iv（仅供 KAT；正常发送省略 = CSPRNG 随机）
 * @returns {string} base64url 密文
 */
export function seal(key, role, seq, message, iv) {
  const ivBuf = iv ?? crypto.randomBytes(12);
  if (ivBuf.length !== 12) throw new Error("seal: iv must be 12 bytes");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(aadOf(role, seq));
  const pt = Buffer.from(JSON.stringify(message), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([ivBuf, ct, cipher.getAuthTag()]).toString("base64url");
}

/**
 * 解密 frame.data（iv||ct||tag 布局）。认证失败抛错，调用方必须丢弃该帧。
 * @param {Buffer} key
 * @param {"host"|"client"} role **发送方** role（接收端解密时传对端的 role）
 * @param {number} seq
 * @param {string} dataB64
 * @returns {object} 解密后的业务消息
 */
export function open(key, role, seq, dataB64) {
  const raw = Buffer.from(dataB64, "base64url");
  if (raw.length < 12 + 16 + 1) throw new Error("open: ciphertext too short");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aadOf(role, seq));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

/**
 * 业务消息工厂（契约 §5）：{id: uuid-v4, type, ts, payload}。
 * @param {string} type
 * @param {object} [payload]
 * @param {string} [id] 已有 id 时复用（result 回包用请求的 id）
 */
export function msg(type, payload, id) {
  return {
    id: id ?? crypto.randomUUID(),
    type,
    ts: Date.now(),
    payload: payload ?? {},
  };
}

/**
 * 校验一条**入站明文**业务消息的信封形状（解密之后、分发之前调用）。
 * 非法信封返回 null，调用方丢弃（不回包——对端可能在探测）。
 * @param {unknown} m
 * @returns {{id:string,type:string,ts:number,payload:object}|null}
 */
export function sanitizeEnvelope(m) {
  if (m === null || typeof m !== "object") return null;
  const { id, type, ts, payload } = /** @type {Record<string, unknown>} */ (m);
  if (typeof id !== "string" || id === "") return null;
  if (typeof type !== "string" || type === "") return null;
  if (ts !== undefined && typeof ts !== "number") return null;
  if (payload !== undefined && (payload === null || typeof payload !== "object")) return null;
  return { id, type, ts: typeof ts === "number" ? ts : 0, payload: payload === undefined ? {} : payload };
}

/**
 * 契约 §7 KAT（已知答案测试）：两端实现必须逐字节一致。
 * 校验点：① key 派生；② 固定 iv 下 ct/tag 与契约向量一致；
 * ③ AAD 绑定（role 交叉解密必须失败）。
 * @returns {true} 失败抛错
 */
export function assertKat() {
  // ① key 派生
  const key = deriveKey("dsh-remote-demo-secret-0123456789", "ABCDEFGH23456789");
  const keyHex = key.toString("hex");
  const expectKey = "6a76161fb789e8a48e1004cdcba483c2908bf4123180dae162dfb7e61e342a1d";
  if (keyHex !== expectKey) throw new Error("KAT key mismatch: " + keyHex);

  // ② 固定 iv 的 ct/tag 向量（契约 §7，空 AAD）
  const ivBuf = Buffer.from("000102030405060708090a0b", "hex");
  const pt = Buffer.from('{"id":"r1","type":"ping","ts":1700000000000,"payload":{}}', "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(Buffer.alloc(0));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const ctHex = ct.toString("hex");
  const tagHex = cipher.getAuthTag().toString("hex");
  const expectCt =
    "72b6fd46c5981533620ae9edc88cf0d607c89b5ad3da2d5ddd0548d6aef0c53e" +
    "4b242be9c97ead9930a1374918a2f46dc861811055c1cbe1a3";
  const expectTag = "292260ad46868699ac0bda00a1336cb4";
  if (ctHex !== expectCt) throw new Error("KAT ct mismatch: " + ctHex);
  if (tagHex !== expectTag) throw new Error("KAT tag mismatch: " + tagHex);

  // 反向：解密契约向量必须还原明文
  const vecData = Buffer.concat([ivBuf, Buffer.from(expectCt, "hex"), Buffer.from(expectTag, "hex")]).toString("base64url");
  const cipher2 = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
  cipher2.setAAD(Buffer.alloc(0));
  cipher2.setAuthTag(Buffer.from(expectTag, "hex"));
  const back = Buffer.concat([cipher2.update(Buffer.from(expectCt, "hex")), cipher2.final()]);
  if (back.toString("utf8") !== pt.toString("utf8")) throw new Error("KAT decrypt mismatch");
  void vecData;

  // ③ AAD 绑定往返（契约 §7：encrypt(role="host", seq=7) → AAD "dshrc|host|7"）
  const data = seal(key, "host", 7, { hello: "world" });
  const round = open(key, "host", 7, data);
  if (round.hello !== "world") throw new Error("KAT aad roundtrip failed");
  let crossRejected = false;
  try {
    open(key, "client", 7, data);
  } catch {
    crossRejected = true;
  }
  if (!crossRejected) throw new Error("KAT: AAD role binding not enforced");
  // seq 也必须绑定：换 seq 解密必须失败
  let seqRejected = false;
  try {
    open(key, "host", 8, data);
  } catch {
    seqRejected = true;
  }
  if (!seqRejected) throw new Error("KAT: AAD seq binding not enforced");
  return true;
}
