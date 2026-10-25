// lib/protocol.mjs — dsh-remote-control 协议 v1 的加密与信封层（契约
// docs/PROTOCOL.md §3 / §5 / §7）。
//
// 职责（严格限定在协议内，不含传输与业务）：
//   - HKDF-SHA256 E2E 密钥派生（§3.3）
//   - hello 帧 HMAC 签名（§3.4 v1 旧格式 + §3.4.1 v2 会话纪元格式）
//   - AES-256-GCM 业务消息封解（§7：base64url(iv(12) || ct || tag(16))，
//     AAD = UTF8("dshrc|" + 发送方 role + "|" + seq [ + "|" + sid ])）
//   - 业务信封编解码（§5：{id, type, ts, payload}）
//   - 契约 §7 KAT 自测 assertKat()：启动时调用，失败必须禁用连接。
//
// **v1.1.3（契约 §3.4.1 会话纪元 / §4 传输层帧 / §7 AAD）**：
//   - hello 帧新增 e/ts/pv/sid 四个字段，sig 字段改用 v2 证明串
//     "hello2|role|channel|e|ts|pv|sid"（旧格式 helloSig 保留：旧端互操作 + 单测）。
//   - 业务帧 AAD 在**加固模式**（双方 pv≥2）额外绑定发送方的连接实例 id：
//     "dshrc|role|seq|sid"；兼容模式仍是旧的 "dshrc|role|seq"。
//   - 模式判定与纪元单调性是**纯函数**（negotiateMode / acceptPeerEpoch），
//     放在协议层便于两端与单测共用同一份判定口径。
//
// 与 dsh-remote-control-e2e/protocol.mjs（Lead 维护的第三份实现）逐字节
// 兼容；两份实现的 KAT 向量一致即证明两端互通。
import crypto from "node:crypto";

export const PROTO_VERSION = 1;
export const ROLE_HOST = "host";
export const ROLE_CLIENT = "client";

/**
 * v1.1.3 传输层协议版本（hello 帧的 pv 字段）。
 * 旧端不带 pv → 视为 1（§3.4.1）。
 */
export const HELLO_PROTO_VERSION = 2;

/** 握手模式：兼容模式（任一方 pv<2）与加固模式（双方 pv≥2）。 */
export const MODE_COMPAT = "compat";
export const MODE_HARDENED = "hardened";

const HKDF_SALT = "dsh-remote-control/v1";
const HKDF_INFO_PREFIX = "e2e|";
/** v2 证明串前缀（§3.4.1）："hello2|role|channel|e|ts|pv|sid"。 */
const HELLO_SIG2_PREFIX = "hello2|";
/** 连接实例 id 的形状：8 位十六进制（§3.4.1 / §4）。 */
const SID_RE = /^[0-9a-f]{8}$/i;

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

/**
 * hello 帧 **v2 会话纪元证明**（契约 §3.4.1）：
 * sig = base64url(HMAC-SHA256(key, UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)))
 *
 * 与旧格式 helloSig（"hello|role|channel"）并存：旧格式保留给旧端互操作与单测，
 * v2 证明串**取代** hello 帧 sig 字段里的旧内容。
 *
 * @param {Buffer} key deriveKey 的产物
 * @param {"host"|"client"} role
 * @param {string} channel
 * @param {number} e 会话纪元（跨进程重启单调递增）
 * @param {number} ts 发送时刻 Unix 毫秒（仅诊断用，不参与安全判定）
 * @param {number} pv 协议版本（v1.1.3 = 2）
 * @param {string} sid 发送方的连接实例 id（8 位十六进制）
 * @returns {string} base64url 证明串
 */
export function helloSig2(key, role, channel, e, ts, pv, sid) {
  return crypto
    .createHmac("sha256", key)
    .update(HELLO_SIG2_PREFIX + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid, "utf8")
    .digest("base64url");
}

/**
 * 校验对端的 v2 证明串（恒定时间比较；失败返回 false，调用方拒绝连接）。
 * 中继没有密钥、只能原样复制对端证明 → 验签通过即可信任对端的 e/ts/pv/sid。
 *
 * @param {Buffer} key deriveKey 的产物
 * @param {"host"|"client"} role 对端 role
 * @param {string} channel
 * @param {number} e
 * @param {number} ts
 * @param {number} pv
 * @param {string} sid
 * @param {string} sig 对端带来的证明串
 * @returns {boolean}
 */
export function verifyHelloSig2(key, role, channel, e, ts, pv, sid, sig) {
  if (typeof sig !== "string" || sig === "") return false;
  let expect;
  try {
    expect = Buffer.from(helloSig2(key, role, channel, e, ts, pv, sid), "utf8");
  } catch {
    return false;
  }
  const got = Buffer.from(sig, "utf8");
  if (expect.length !== got.length) return false;
  return crypto.timingSafeEqual(expect, got);
}

/**
 * AAD（契约 §7）：
 *   兼容模式 = UTF8("dshrc|" + 发送方 role + "|" + seq)
 *   加固模式 = UTF8("dshrc|" + 发送方 role + "|" + seq + "|" + sid)
 * sid 省略/空串 → 兼容模式（旧 AAD 格式，逐字节兼容 v1.1.2）。
 * @param {"host"|"client"} role 发送方 role
 * @param {number} seq 该消息的 frame.seq
 * @param {string} [sid] 发送方的连接实例 id（加固模式）
 * @returns {Buffer}
 */
export function aadOf(role, seq, sid) {
  const base = "dshrc|" + role + "|" + seq;
  const hardened = typeof sid === "string" && sid !== "";
  return Buffer.from(hardened ? base + "|" + sid : base, "utf8");
}

/**
 * 加密一条业务消息为 frame.data（契约 §7）。
 * 载荷布局：base64url( iv(12) || ciphertext || tag(16) )；iv 每消息随机。
 * @param {Buffer} key
 * @param {"host"|"client"} role 发送方 role（进入 AAD）
 * @param {number} seq 该消息的 frame.seq（进入 AAD，防重放/串帧）
 * @param {object} message 明文业务消息（JSON 可序列化）
 * @param {Buffer} [iv] 固定 iv（仅供 KAT；正常发送省略 = CSPRNG 随机）
 * @param {string} [sid] 发送方的连接实例 id（**加固模式**；省略 = 兼容模式旧 AAD）
 * @returns {string} base64url 密文
 */
export function seal(key, role, seq, message, iv, sid) {
  const ivBuf = iv ?? crypto.randomBytes(12);
  if (ivBuf.length !== 12) throw new Error("seal: iv must be 12 bytes");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(aadOf(role, seq, sid));
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
 * @param {string} [sid] 发送方的连接实例 id（**加固模式**；省略 = 兼容模式旧 AAD）
 * @returns {object} 解密后的业务消息
 */
export function open(key, role, seq, dataB64, sid) {
  const raw = Buffer.from(dataB64, "base64url");
  if (raw.length < 12 + 16 + 1) throw new Error("open: ciphertext too short");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aadOf(role, seq, sid));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

/**
 * 握手模式判定（契约 §3.4.1，**双方各自独立判断、必须一致**）：
 *   加固模式 = 本端 pv≥2 **且** 对端 pv≥2；任一方 pv<2 → 兼容模式。
 * 对端 pv 未知（旧端 / 中继没透传证明）按 1 处理 → 兼容模式。
 * @param {number} selfPv 本端协议版本
 * @param {number} peerPv 对端协议版本（undefined/非法 → 1）
 * @returns {typeof MODE_COMPAT | typeof MODE_HARDENED}
 */
export function negotiateMode(selfPv, peerPv) {
  const s = Number.isInteger(selfPv) ? selfPv : 1;
  const p = Number.isInteger(peerPv) ? peerPv : 1;
  return s >= 2 && p >= 2 ? MODE_HARDENED : MODE_COMPAT;
}

/**
 * 对端会话纪元的单调性判定（契约 §3.4.1，纯函数，便于两端与单测共用口径）。
 *
 * 规则（state = 已接受的对端纪元锚点 {peerEpoch, peerSid}）：
 *   - e === peerEpoch && sid === peerSid → 同一证明的重复（welcome 与 peer-joined 都带它）
 *     → **幂等接受**，不更新锚点；
 *   - 否则 e <= peerEpoch → **纪元回退**（疑似重放）→ 拒绝连接；
 *   - 否则 → 接受，钉扎 (e, sid)。
 *
 * @param {{peerEpoch?:number, peerSid?:string}} state 已接受的对端纪元锚点
 * @param {{e:number, sid:string}} proof 对端证明里的纪元与连接实例 id
 * @returns {{ok:boolean, duplicate?:boolean, reason?:string, peerEpoch:number, peerSid:string}}
 */
export function acceptPeerEpoch(state, proof) {
  const e = proof && proof.e;
  const sid = proof && proof.sid;
  const lastEpoch = state && Number.isInteger(state.peerEpoch) ? state.peerEpoch : 0;
  const lastSid = state && typeof state.peerSid === "string" ? state.peerSid : "";
  if (!Number.isInteger(e) || e < 0) {
    return { ok: false, reason: "bad-epoch", peerEpoch: lastEpoch, peerSid: lastSid };
  }
  if (typeof sid !== "string" || !SID_RE.test(sid)) {
    return { ok: false, reason: "bad-sid", peerEpoch: lastEpoch, peerSid: lastSid };
  }
  // 还没接受过任何对端证明（首次）：直接钉扎（对端从 1 开始自增，不会撞）。
  if (lastSid === "") {
    return { ok: true, duplicate: false, peerEpoch: e, peerSid: sid };
  }
  // 同一证明的重复：幂等接受（不更新锚点）。
  if (e === lastEpoch && sid === lastSid) {
    return { ok: true, duplicate: true, peerEpoch: lastEpoch, peerSid: lastSid };
  }
  // 纪元回退 = 疑似重放 → 拒绝连接。
  if (e <= lastEpoch) {
    return { ok: false, reason: "epoch-regression", peerEpoch: lastEpoch, peerSid: lastSid };
  }
  return { ok: true, duplicate: false, peerEpoch: e, peerSid: sid };
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
 * ③ AAD 绑定（role 交叉解密必须失败）；
 * ④ **v1.1.3 加固模式**：AAD 绑定 sid（换 sid 解密必须失败）；兼容模式仍是旧格式；
 * ⑤ v2 握手证明串自洽（helloSig2 / verifyHelloSig2）与模式/纪元判定口径。
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

  // ④ v1.1.3 加固模式 AAD（契约 §7："dshrc|host|7|a1b2c3d4"）
  const hardSid = "a1b2c3d4";
  const hardData = seal(key, "host", 7, { hello: "world" }, undefined, hardSid);
  const hardRound = open(key, "host", 7, hardData, hardSid);
  if (hardRound.hello !== "world") throw new Error("KAT: hardened aad roundtrip failed");
  // 换 sid 解密必须失败（加固模式绑定连接实例 id）
  let sidRejected = false;
  try {
    open(key, "host", 7, hardData, "b1b2b3b4");
  } catch {
    sidRejected = true;
  }
  if (!sidRejected) throw new Error("KAT: AAD sid binding not enforced");
  // 加固密文用兼容 AAD 解也必须失败（模式不得混用）
  let modeRejected = false;
  try {
    open(key, "host", 7, hardData);
  } catch {
    modeRejected = true;
  }
  if (!modeRejected) throw new Error("KAT: hardened/compat AAD mixing not rejected");
  // 兼容模式的 AAD 逐字节等于旧格式（不带 sid）
  if (aadOf("host", 7).toString("utf8") !== "dshrc|host|7") throw new Error("KAT: compat AAD format changed");
  if (aadOf("host", 7, hardSid).toString("utf8") !== "dshrc|host|7|a1b2c3d4") throw new Error("KAT: hardened AAD format changed");

  // ⑤ v2 握手证明串（契约 §3.4.1）
  const sig2 = helloSig2(key, "host", "ABCDEFGH23456789", 3, 1700000000000, HELLO_PROTO_VERSION, hardSid);
  if (!verifyHelloSig2(key, "host", "ABCDEFGH23456789", 3, 1700000000000, HELLO_PROTO_VERSION, hardSid, sig2)) {
    throw new Error("KAT: hello2 proof self-verification failed");
  }
  if (verifyHelloSig2(key, "client", "ABCDEFGH23456789", 3, 1700000000000, HELLO_PROTO_VERSION, hardSid, sig2)) {
    throw new Error("KAT: hello2 proof role binding not enforced");
  }
  if (verifyHelloSig2(key, "host", "ABCDEFGH23456789", 4, 1700000000000, HELLO_PROTO_VERSION, hardSid, sig2)) {
    throw new Error("KAT: hello2 proof epoch binding not enforced");
  }
  if (verifyHelloSig2(key, "host", "ABCDEFGH23456789", 3, 1700000000000, HELLO_PROTO_VERSION, "b1b2b3b4", sig2)) {
    throw new Error("KAT: hello2 proof sid binding not enforced");
  }
  // 模式判定口径（契约 §3.4.1）
  if (negotiateMode(HELLO_PROTO_VERSION, HELLO_PROTO_VERSION) !== MODE_HARDENED) {
    throw new Error("KAT: mode negotiation (both pv>=2) must be hardened");
  }
  if (negotiateMode(HELLO_PROTO_VERSION, 1) !== MODE_COMPAT) {
    throw new Error("KAT: mode negotiation (peer pv<2) must be compat");
  }
  if (negotiateMode(HELLO_PROTO_VERSION, undefined) !== MODE_COMPAT) {
    throw new Error("KAT: mode negotiation (unknown peer) must be compat");
  }
  // 纪元单调性判定口径（契约 §3.4.1）
  const first = acceptPeerEpoch({ peerEpoch: 0, peerSid: "" }, { e: 5, sid: "aaaaaaaa" });
  if (!first.ok || first.duplicate) throw new Error("KAT: first peer epoch must be accepted");
  const dup = acceptPeerEpoch({ peerEpoch: 5, peerSid: "aaaaaaaa" }, { e: 5, sid: "aaaaaaaa" });
  if (!dup.ok || !dup.duplicate) throw new Error("KAT: duplicate peer proof must be idempotent");
  const regress = acceptPeerEpoch({ peerEpoch: 5, peerSid: "aaaaaaaa" }, { e: 4, sid: "aaaaaaaa" });
  if (regress.ok) throw new Error("KAT: peer epoch regression must be rejected");
  return true;
}
