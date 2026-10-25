// scripts/verify-crypto.mjs —— v1.1.3 加密层与抗重放门禁（dev-only，无外部依赖）。
//
// 契约 §3.3/§3.4.1（握手证明 v2 会话纪元）/§7（AAD 两模式 + KAT）。
//
// 覆盖四块：
//   1. **KAT**：契约 §7 的固定向量（key/iv/ct/tag，空 AAD）——**一字未改**，
//      两端实现逐字节一致才算过（改了 AAD 格式也不能动这些向量）。
//   2. **AAD 两模式**：兼容模式 `dshrc|role|seq` 与加固模式 `dshrc|role|seq|sid`
//      互不兼容；换 role / 换 seq / 换 sid 解密必须失败。
//   3. **握手证明 v2**：`hello2|role|channel|e|ts|pv|sid` 的 HMAC——改任一字段签名必变；
//      旧格式 `hello|role|channel` 保留（旧端互操作）。
//   4. **纪元单调性与模式判定**（纯函数）：重复证明幂等、纪元回退拒绝、同纪元换 sid 拒绝、
//      模式由「双方 pv≥2」决定。
//
// 另外做**接线层源码断言**（纪元持久化钩子、AAD 按模式带 sid、TLS 环境变量接线），
// 防止「纯函数对了但没接上」。
//
// 用法：node scripts/verify-crypto.mjs（在 plugin/ 目录下）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELLO_PROTO_VERSION,
  MODE_COMPAT,
  MODE_HARDENED,
  acceptPeerEpoch,
  aadOf,
  assertKat,
  deriveKey,
  helloSig,
  helloSig2,
  negotiateMode,
  open,
  seal,
} from "../lib/protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log("ok: " + name);
  } else {
    fail += 1;
    console.log("FAIL: " + name + (detail ? " — " + detail : ""));
  }
}

const key = deriveKey("dsh-remote-demo-secret-0123456789", "ABCDEFGH23456789");
const MSG = { id: "r1", type: "ping", ts: 1700000000000, payload: {} };

// ---------------------------------------------------------------------------
// 1. KAT（契约 §7 固定向量）
// ---------------------------------------------------------------------------
let katOk = true;
let katErr = "";
try {
  assertKat();
} catch (e) {
  katOk = false;
  katErr = String(e && e.message);
}
check("契约 §7 KAT 通过（key/iv/ct/tag + AAD 绑定）", katOk, katErr);

// ---------------------------------------------------------------------------
// 2. AAD 两模式（契约 §7）
// ---------------------------------------------------------------------------
check("兼容模式 AAD = dshrc|role|seq",
  aadOf("host", 7).toString("utf8") === "dshrc|host|7",
  aadOf("host", 7).toString("utf8"));
check("加固模式 AAD = dshrc|role|seq|sid",
  aadOf("host", 7, "a1b2c3d4").toString("utf8") === "dshrc|host|7|a1b2c3d4",
  aadOf("host", 7, "a1b2c3d4").toString("utf8"));

const compatCt = seal(key, "host", 7, MSG);
const hardenedCt = seal(key, "host", 7, MSG, undefined, "a1b2c3d4");
check("加固模式密文与兼容模式不同（sid 进 AAD）", compatCt !== hardenedCt);
check("兼容模式密文可用旧 AAD 解开", JSON.stringify(open(key, "host", 7, compatCt)) === JSON.stringify(MSG));
check("加固模式密文用加固 AAD 能解开",
  JSON.stringify(open(key, "host", 7, hardenedCt, "a1b2c3d4")) === JSON.stringify(MSG));

function decryptFails(role, seq, data, sid) {
  try {
    open(key, role, seq, data, sid);
    return false;
  } catch {
    return true;
  }
}
check("加固密文用兼容 AAD 解必须失败", decryptFails("host", 7, hardenedCt));
check("兼容密文用加固 AAD 解必须失败", decryptFails("host", 7, compatCt, "a1b2c3d4"));
check("换 role 解密必须失败", decryptFails("client", 7, hardenedCt, "a1b2c3d4"));
check("换 seq 解密必须失败", decryptFails("host", 8, hardenedCt, "a1b2c3d4"));
check("换 sid 解密必须失败（契约 §7 ③）", decryptFails("host", 7, hardenedCt, "deadbeef"));

// ---------------------------------------------------------------------------
// 3. 握手证明 v2（契约 §3.4.1）
// ---------------------------------------------------------------------------
const sigBase = helloSig2(key, "host", "ABCDEFGH23456789", 5, 1700000000000, 2, "a1b2c3d4");
check("helloSig2 确定性", sigBase === helloSig2(key, "host", "ABCDEFGH23456789", 5, 1700000000000, 2, "a1b2c3d4"));
check("helloSig2 绑纪元 e", sigBase !== helloSig2(key, "host", "ABCDEFGH23456789", 6, 1700000000000, 2, "a1b2c3d4"));
check("helloSig2 绑 ts", sigBase !== helloSig2(key, "host", "ABCDEFGH23456789", 5, 1700000000001, 2, "a1b2c3d4"));
check("helloSig2 绑 pv", sigBase !== helloSig2(key, "host", "ABCDEFGH23456789", 5, 1700000000000, 3, "a1b2c3d4"));
check("helloSig2 绑 sid", sigBase !== helloSig2(key, "host", "ABCDEFGH23456789", 5, 1700000000000, 2, "deadbeef"));
check("helloSig2 绑 role", sigBase !== helloSig2(key, "client", "ABCDEFGH23456789", 5, 1700000000000, 2, "a1b2c3d4"));
check("helloSig2 绑 channel", sigBase !== helloSig2(key, "host", "ABCDEFGH23456890", 5, 1700000000000, 2, "a1b2c3d4"));
check("旧格式 helloSig 仍可用（旧端互操作）",
  helloSig(key, "host", "ABCDEFGH23456789") === helloSig(key, "host", "ABCDEFGH23456789"));
check("旧格式与新格式不同", helloSig(key, "host", "ABCDEFGH23456789") !== sigBase);

// ---------------------------------------------------------------------------
// 4. 模式判定与纪元单调性（纯函数）
// ---------------------------------------------------------------------------
check("双方 pv>=2 → 加固模式", negotiateMode(2, 2) === MODE_HARDENED);
check("对端 pv=1 → 兼容模式", negotiateMode(2, 1) === MODE_COMPAT);
check("本端 pv=1 → 兼容模式", negotiateMode(1, 2) === MODE_COMPAT);
check("对端 pv 未知 → 兼容模式", negotiateMode(2, undefined) === MODE_COMPAT);
check("HELLO_PROTO_VERSION = 2", HELLO_PROTO_VERSION === 2, String(HELLO_PROTO_VERSION));

const first = acceptPeerEpoch({ peerEpoch: 0, peerSid: "" }, { e: 3, sid: "a1b2c3d4" });
check("首次接受对端证明", first.ok === true && first.duplicate === false && first.peerEpoch === 3, JSON.stringify(first));
const dup = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: 3, sid: "a1b2c3d4" });
check("同一证明重复 → 幂等接受", dup.ok === true && dup.duplicate === true, JSON.stringify(dup));
const back = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: 2, sid: "a1b2c3d4" });
check("纪元回退（e 更小）→ 拒绝", back.ok === false && back.reason === "epoch-regression", JSON.stringify(back));
const sameEpochNewSid = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: 3, sid: "deadbeef" });
check("同纪元换 sid（疑似重放）→ 拒绝", sameEpochNewSid.ok === false, JSON.stringify(sameEpochNewSid));
const newer = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: 4, sid: "deadbeef" });
check("纪元递增 → 接受并重新钉扎", newer.ok === true && newer.peerEpoch === 4 && newer.peerSid === "deadbeef", JSON.stringify(newer));
const badSid = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: 9, sid: "not-hex!" });
check("非法 sid → 拒绝", badSid.ok === false && badSid.reason === "bad-sid", JSON.stringify(badSid));
const badEpoch = acceptPeerEpoch({ peerEpoch: 3, peerSid: "a1b2c3d4" }, { e: "x", sid: "a1b2c3d4" });
check("非法纪元 → 拒绝", badEpoch.ok === false && badEpoch.reason === "bad-epoch", JSON.stringify(badEpoch));

// ---------------------------------------------------------------------------
// 5. 接线层源码断言（纯函数对了但没接上也要红）
// ---------------------------------------------------------------------------
const relayClientSrc = readFileSync(join(pluginDir, "lib", "relay-client.mjs"), "utf8");
check("接线层：relay-client 用了 helloSig2", relayClientSrc.includes("helloSig2("));
check("接线层：relay-client 按模式把 sid 进 AAD",
  relayClientSrc.includes("MODE_HARDENED ? this.#sid"), "加固模式没把本端 sid 放进 AAD");
check("接线层：relay-client 校验对端证明", relayClientSrc.includes("verifyHelloSig2("));
check("接线层：relay-client 做纪元单调性判定", relayClientSrc.includes("acceptPeerEpoch("));
check("接线层：relay-client 钉扎对端 sid", relayClientSrc.includes("#pinnedPeerSid"));

const configSrc = readFileSync(join(pluginDir, "lib", "config.mjs"), "utf8");
check("接线层：config 持久化纪元", configSrc.includes("export function bumpSelfEpoch"));
check("接线层：config 持久化对端纪元锚点", configSrc.includes("export function savePeerEpoch"));
check("接线层：config 有 TLS 证书路径字段", configSrc.includes("relayTlsCert") && configSrc.includes("relayTlsKey"));

const supervisorSrc = readFileSync(join(pluginDir, "lib", "relay-supervisor.mjs"), "utf8");
check("接线层：托管中继透传 TLS 环境变量",
  supervisorSrc.includes("RELAY_TLS_CERT") && supervisorSrc.includes("RELAY_TLS_KEY"));
check("接线层：托管中继透传 RELAY_TOKEN", supervisorSrc.includes("RELAY_TOKEN"));

const relayServerSrc = readFileSync(join(pluginDir, "..", "relay", "server.js"), "utf8");
check("接线层：中继认 TLS 环境变量且失败即退出",
  relayServerSrc.includes("RELAY_TLS_CERT") && relayServerSrc.includes("RELAY_TLS_KEY"));
check("接线层：中继逐字复制对端证明",
  relayServerSrc.includes("extractProof") && relayServerSrc.includes("peerProofOf"));

const pairingSrc = readFileSync(join(pluginDir, "lib", "pairing.mjs"), "utf8");
check("接线层：轮换配对信息时重置纪元锚点（逃生口）",
  pairingSrc.includes("fresh.epoch = defaultEpoch()"));

console.log("");
console.log("verify-crypto: " + pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
