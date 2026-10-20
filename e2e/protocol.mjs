// e2e/protocol.mjs — dsh-remote-control 协议 v1 的独立参考实现（Lead 维护的第三份实现，
// 用于与 DSH 插件、HarmonyOS App 交叉验证）。契约：docs/plans/2026-10-20-dsh-remote-control-protocol.md
import crypto from "node:crypto";

export const PROTO_VERSION = 1;
export const ROLE_HOST = "host";
export const ROLE_CLIENT = "client";

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

/** hello 帧 sig（契约 §3.4） */
export function helloSig(key, role, channel) {
  return crypto
    .createHmac("sha256", key)
    .update("hello|" + role + "|" + channel, "utf8")
    .digest("base64url");
}

/** AAD（契约 §7）：UTF8("dshrc|" + 发送方 role + "|" + seq) */
function aadOf(role, seq) {
  return Buffer.from("dshrc|" + role + "|" + seq, "utf8");
}

/**
 * 加密一条业务消息为 frame.data。
 * 载荷布局（契约 §7 v1.0.1）：base64url( iv(12) || ciphertext || tag(16) )。
 * iv 12 字节随机；KAT 自测时可传固定 iv。
 */
export function seal(key, role, seq, message, iv) {
  const ivBuf = iv ?? crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBuf);
  cipher.setAAD(aadOf(role, seq));
  const pt = Buffer.from(JSON.stringify(message), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([ivBuf, ct, cipher.getAuthTag()]).toString("base64url");
}

/** 解密 frame.data（iv||ct||tag 布局）；失败抛错（调用方应丢弃该帧）。 */
export function open(key, role, seq, dataB64) {
  const raw = Buffer.from(dataB64, "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aadOf(role, seq));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
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
  return true;
}
