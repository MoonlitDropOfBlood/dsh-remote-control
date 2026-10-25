// e2e/protocol.mjs — dsh-remote-control 协议 v1 的独立参考实现（Lead 维护的第三份实现，
// 用于与 DSH 插件、HarmonyOS App 交叉验证）。契约：docs/plans/2026-10-20-dsh-remote-control-protocol.md
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const PROTO_VERSION = 1;
export const ROLE_HOST = "host";
export const ROLE_CLIENT = "client";

/**
 * **握手证明版本 pv**（契约 §3.4.1）：v1.1.3 = 2。
 * （v1.1.2 及以前不带该字段，视为 pv = 1）
 */
export const PROOF_VERSION = 2;

/** HKDF-SHA256 派生 E2E key（契约 §3） */
export function deriveKey(secret, channel) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("dsh-remote-control/v1", "utf8"),
      Buffer.from("e2e|" + channel, "utf8"),
      32,
    ),
  );
}

/** hello 帧 sig（契约 §3.4，**v1 旧格式**，保留供兼容/对照使用） */
export function helloSig(key, role, channel) {
  return crypto
    .createHmac("sha256", key)
    .update("hello|" + role + "|" + channel, "utf8")
    .digest("base64url");
}

/**
 * **v2 握手证明 sig**（契约 §3.4.1）：
 *   sig = base64url(HMAC-SHA256(key, UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)))
 *
 * @param {Buffer} key
 * @param {"host"|"client"} role 本端 role
 * @param {string} channel
 * @param {{e:number, ts:number, pv:number, sid:string}} proof
 */
export function helloSig2(key, role, channel, proof) {
  const { e, ts, pv, sid } = proof;
  return crypto
    .createHmac("sha256", key)
    .update("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid, "utf8")
    .digest("base64url");
}

/**
 * 构造本端的握手证明（契约 §3.4.1）。
 * @param {Buffer} key
 * @param {"host"|"client"} role
 * @param {string} channel
 * @param {{e:number, ts?:number, pv?:number, sid:string}} parts
 */
export function makeProof(key, role, channel, parts) {
  const proof = {
    e: parts.e,
    ts: parts.ts ?? Date.now(),
    pv: parts.pv ?? PROOF_VERSION,
    sid: parts.sid,
  };
  proof.sig = helloSig2(key, role, channel, proof);
  return proof;
}

/**
 * 校验对端证明（契约 §3.4.1）：用本端 key 重算 sig 并**逐字**比对。
 *
 * 注意：v1 旧端（只带 sig、没有 e/ts/pv/sid）在这里**返回 false**——
 * 那不是「伪造」，而是「旧端没有 v2 证明」→ 调用方按 pv<2 走兼容模式。
 */
export function verifyProof(key, role, channel, proof) {
  if (!proof || typeof proof !== "object") return false;
  if (!Number.isFinite(proof.e) || !Number.isFinite(proof.ts) || !Number.isFinite(proof.pv)) return false;
  if (typeof proof.sid !== "string" || proof.sid === "") return false;
  if (typeof proof.sig !== "string" || proof.sig === "") return false;
  const expect = Buffer.from(helloSig2(key, role, channel, proof), "utf8");
  const actual = Buffer.from(proof.sig, "utf8");
  if (expect.length !== actual.length) return false;
  return crypto.timingSafeEqual(expect, actual);
}

/** 证明的指纹（用于「同一证明重复出现 → 幂等接受」的判定） */
export function proofId(proof) {
  if (!proof || typeof proof !== "object") return "";
  const raw = [proof.e, proof.ts, proof.pv, proof.sid, proof.sig].map((v) => String(v)).join("|");
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

/**
 * AAD（契约 §7）：
 *   兼容模式 = UTF8("dshrc|" + 发送方 role + "|" + seq)
 *   加固模式（双方 pv>=2）= UTF8("dshrc|" + 发送方 role + "|" + seq + "|" + sid)
 * sid 省略/空串 → 兼容模式（与 plugin/lib/protocol.mjs 的 aadOf 逐字节一致）。
 */
export function aadOf(role, seq, sid) {
  const base = "dshrc|" + role + "|" + seq;
  const hardened = typeof sid === "string" && sid !== "";
  return Buffer.from(hardened ? base + "|" + sid : base, "utf8");
}

/**
 * 加密一条业务消息为 frame.data。
 * 载荷布局（契约 §7 v1.0.1）：base64url( iv(12) || ciphertext || tag(16) )。
 * iv 12 字节随机；KAT 自测时可传固定 iv。
 * @param {string} [sid] 发送方连接实例 id（**加固模式**；省略 = 兼容模式旧 AAD）
 */
export function seal(key, role, seq, message, iv, sid) {
  const ivBuf = iv ?? crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(aadOf(role, seq, sid));
  const pt = Buffer.from(JSON.stringify(message), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([ivBuf, ct, cipher.getAuthTag()]).toString("base64url");
}

/**
 * 解密 frame.data（iv||ct||tag 布局）；失败抛错（调用方应丢弃该帧）。
 * @param {string} [sid] 发送方连接实例 id（**加固模式**；省略 = 兼容模式旧 AAD）
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
 * **会话纪元存储**（契约 §3.4.1）：每条新连接 +1，跨进程重启单调递增（持久化到文件）。
 *
 * 文件格式：{ "epoch": <本端纪元>, "peers": { "<role>": { "epoch": n, "sid": "…" } } }
 *
 * 判定「对端 e <= 已接受值」（与 plugin/lib/protocol.mjs 的 acceptPeerEpoch **同口径**）：
 *   - 还没接受过任何对端证明 → 直接钉扎（对端从 1 开始自增，不会撞）
 *   - e == 已接受值 且 **sid 相同** → **同一证明重复出现 → 幂等接受**（不更新锚点）
 *   - e <= 已接受值（sid 不同）→ **纪元回退 = 疑似重放 → 拒绝连接**
 *   - e > 已接受值 → 接受并钉扎（持久化）
 */
export class EpochStore {
  #file;
  #data;

  constructor(file = null) {
    this.#file = file || null;
    this.#data = { epoch: 0, peers: {} };
    this.#load();
  }

  #load() {
    if (!this.#file) return;
    try {
      const raw = readFileSync(this.#file, "utf8");
      const d = JSON.parse(raw);
      if (d && typeof d === "object") {
        if (Number.isFinite(d.epoch)) this.#data.epoch = d.epoch;
        if (d.peers && typeof d.peers === "object") this.#data.peers = d.peers;
      }
    } catch {
      /* 文件不存在 / 损坏 → 从 0 开始 */
    }
  }

  #save() {
    if (!this.#file) return;
    try {
      writeFileSync(this.#file, JSON.stringify(this.#data), "utf8");
    } catch {
      /* 落盘失败不致命（纪元退化到内存态） */
    }
  }

  /** 本端当前纪元（未分配新连接时） */
  get epoch() {
    return this.#data.epoch;
  }

  /** 分配一个新纪元（每条新连接 +1）并持久化 */
  next() {
    this.#data.epoch += 1;
    this.#save();
    return this.#data.epoch;
  }

  /** 已接受的对端最高纪元 */
  acceptedPeerEpoch(peerRole) {
    const rec = this.#data.peers[peerRole];
    return rec && Number.isFinite(rec.epoch) ? rec.epoch : 0;
  }

  /** 已钉扎的对端 sid（空串 = 还没接受过任何对端证明） */
  acceptedPeerSid(peerRole) {
    const rec = this.#data.peers[peerRole];
    return rec && typeof rec.sid === "string" ? rec.sid : "";
  }

  /**
   * 接受对端证明里的纪元（幂等语义见类注释）。
   * @returns {{ok:boolean, reason?:string, duplicate?:boolean}}
   */
  acceptPeer(peerRole, proof) {
    const e = proof?.e;
    const sid = proof?.sid;
    if (!Number.isInteger(e) || e < 0) return { ok: false, reason: "bad-epoch" };
    if (typeof sid !== "string" || sid === "") return { ok: false, reason: "bad-sid" };
    const lastEpoch = this.acceptedPeerEpoch(peerRole);
    const lastSid = this.acceptedPeerSid(peerRole);
    if (lastSid === "") {
      this.#data.peers[peerRole] = { epoch: e, sid };
      this.#save();
      return { ok: true, duplicate: false };
    }
    if (e === lastEpoch && sid === lastSid) {
      return { ok: true, duplicate: true }; // 同一证明重复出现 → 幂等接受
    }
    if (e <= lastEpoch) {
      return { ok: false, reason: "epoch-regression" }; // 纪元回退 = 疑似重放
    }
    this.#data.peers[peerRole] = { epoch: e, sid };
    this.#save();
    return { ok: true, duplicate: false };
  }
}


/** 业务消息工厂 */
export function msg(type, payload, id) {
  return {
    id: id ?? crypto.randomUUID(),
    type,
    ts: Date.now(),
    payload: payload ?? {},
  };
}

/** 请求-响应关联表 */
export class Correlator {
  #pending = new Map();
  request(send, type, payload, timeoutMs = 15000) {
    const m = msg(type, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(m.id);
        reject(new Error("request timeout: " + type));
      }, timeoutMs);
      this.#pending.set(m.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send(m);
    });
  }
  /** 收到一条解密后的消息；result 型路由回 pending，其他交给 onEvent。 */
  deliver(m, onEvent) {
    if (m.type === "result" && m.payload && typeof m.payload.id === "string") {
      const p = this.#pending.get(m.payload.id);
      if (p !== undefined) {
        this.#pending.delete(m.payload.id);
        if (m.payload.ok) p.resolve(m.payload.value);
        else p.reject(new Error(m.payload.error?.message ?? "remote error"));
        return;
      }
    }
    onEvent?.(m);
  }
}

/** 契约 §7 KAT（空 AAD 版本，逐字节核对） */
export function assertKat() {
  const key = deriveKey("dsh-remote-demo-secret-0123456789", "ABCDEFGH23456789");
  const keyHex = key.toString("hex");
  const expectKey = "6a76161fb789e8a48e1004cdcba483c2908bf4123180dae162dfb7e61e342a1d";
  if (keyHex !== expectKey) throw new Error("KAT key mismatch: " + keyHex);

  // 空 AAD 的 KAT 向量（契约 §7）：用 setAAD(Buffer.alloc(0)) 复现。
  const ivBuf = Buffer.from("000102030405060708090a0b", "hex");
  const pt = Buffer.from('{"id":"r1","type":"ping","ts":1700000000000,"payload":{}}', "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(Buffer.alloc(0));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const ctHex = ct.toString("hex");
  const tagHex = cipher.getAuthTag().toString("hex");
  const expectCt =
    "72b6fd46c5981533620ae9edc88cf0d607c89b5ad3da2d5ddd0548d6aef0c53e4b242be9c97ead9930a1374918a2f46dc861811055c1cbe1a3";
  const expectTag = "292260ad46868699ac0bda00a1336cb4";
  if (ctHex !== expectCt) throw new Error("KAT ct mismatch: " + ctHex);
  if (tagHex !== expectTag) throw new Error("KAT tag mismatch: " + tagHex);

  // AAD 绑定往返
  const data = seal(key, "host", 7, { hello: "world" });
  const back = open(key, "host", 7, data);
  if (back.hello !== "world") throw new Error("roundtrip failed");
  let crossRejected = false;
  try {
    open(key, "client", 7, data);
  } catch {
    crossRejected = true;
  }
  if (!crossRejected) throw new Error("AAD role binding not enforced");

  // ---- v1.1.3 追加断言（契约 §7 ① ② ③）---------------------------------
  // ② 换 seq 解密必须失败
  let seqRejected = false;
  try {
    open(key, "host", 8, data);
  } catch {
    seqRejected = true;
  }
  if (!seqRejected) throw new Error("AAD seq binding not enforced");

  // ③ 换 sid 解密必须失败（加固模式：AAD = "dshrc|host|7|<sid>"）
  const hard = seal(key, "host", 7, { hello: "world" }, undefined, "a1b2c3d4");
  const hardBack = open(key, "host", 7, hard, "a1b2c3d4");
  if (hardBack.hello !== "world") throw new Error("hardened roundtrip failed");
  let sidRejected = false;
  try {
    open(key, "host", 7, hard, "ffffffff");
  } catch {
    sidRejected = true;
  }
  if (!sidRejected) throw new Error("AAD sid binding not enforced");

  // 兼容模式与加固模式**互不兼容**（跨模式解密必须失败）
  let crossModeRejected = false;
  try {
    open(key, "host", 7, hard);
  } catch {
    crossModeRejected = true;
  }
  if (!crossModeRejected) throw new Error("compat/hardened AAD not separated");

  return true;
}
