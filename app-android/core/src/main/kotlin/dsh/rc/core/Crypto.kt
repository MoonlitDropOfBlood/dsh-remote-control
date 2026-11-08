/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 加密层：HKDF-SHA256 + AES-256-GCM + HMAC-SHA256。
 *
 * 契约：仓库根 docs/PROTOCOL.md §3 / §7（v1.2.0）。**唯一事实源**。
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/crypto.ets 逐字对齐：
 *   - key = HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"),
 *                      info=UTF8("e2e|" + channel), L=32)
 *   - frame.data = base64url( iv(12) || ciphertext || tag(16) )   ← 契约 §7 v1.0.1 布局
 *   - AAD = UTF8("dshrc|" + 发送方 role + "|" + seq)
 *     （v1.1.3 加固模式：双方 pv>=2 时再追加 "|" + 发送方 sid —— 契约 §7）
 *   - 握手证明 v2（契约 §3.4.1）：hello2|role|channel|e|ts|pv|sid 的 HMAC
 *   - KAT（契约 §7）：assertKat() 在连接建立前执行，逐字节核对 key/ct/tag/HMAC（空 AAD）。
 */
package dsh.rc.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** KAT 自检失败（连接建立前抛出 → 不建链）。 */
class KatFailure(message: String) : Exception(message)

/**
 * 加密工具。**全部为纯 JVM 实现**（JCA），无 Android 依赖 → 可在 `:core:test` 里跑。
 */
object Crypto {

    private val secureRandom: SecureRandom = SecureRandom()

    // ---- 基础编码 ----

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun fromUtf8(b: ByteArray): String = String(b, Charsets.UTF_8)

    /** base64url（RFC 4648 §5，无填充）编码。 */
    fun base64UrlEncode(b: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    /** base64url 解码（兼容有/无填充；非法字符抛 IllegalArgumentException）。 */
    fun base64UrlDecode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    /** 标准 base64（canonical，有填充）——附件分块用（契约 §5.11 分块载荷是标准 base64）。 */
    fun base64StdEncode(b: ByteArray): String = Base64.getEncoder().encodeToString(b)

    fun base64StdDecode(s: String): ByteArray = Base64.getDecoder().decode(s)

    /** 随机字节（CSPRNG）。 */
    fun randomBytes(len: Int): ByteArray = ByteArray(len).also { secureRandom.nextBytes(it) }

    /** bytes → 小写 hex。 */
    fun toHex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            if (v < 0x10) sb.append('0')
            sb.append(Integer.toHexString(v))
        }
        return sb.toString()
    }

    /** hex → bytes（非法字符抛错）。 */
    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "fromHex: odd length" }
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val v = hex.substring(i * 2, i * 2 + 2).toIntOrNull(16)
                ?: throw IllegalArgumentException("fromHex: bad hex at ${i * 2}")
            out[i] = v.toByte()
        }
        return out
    }

    // ---- HKDF / HMAC ----

    /**
     * E2E 密钥派生（契约 §3.3）：
     * HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"), info=UTF8("e2e|"+channel), L=32)
     */
    fun deriveKey(secret: String, channel: String): ByteArray =
        hkdf(
            ikm = utf8(secret),
            salt = utf8(Protocol.HKDF_SALT),
            info = utf8(Protocol.HKDF_INFO_PREFIX + channel),
            length = Protocol.HKDF_KEY_LEN
        )

    /** RFC 5869 HKDF-SHA256（extract + expand）。 */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length > 0 && length <= 255 * 32) { "hkdf: bad length" }
        val prk = hmacSha256(salt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var produced = 0
        var counter = 1
        while (produced < length) {
            val input = ByteArray(t.size + info.size + 1)
            System.arraycopy(t, 0, input, 0, t.size)
            System.arraycopy(info, 0, input, t.size, info.size)
            input[input.size - 1] = counter.toByte()
            t = hmacSha256(prk, input)
            val take = minOf(t.size, length - produced)
            System.arraycopy(t, 0, out, produced, take)
            produced += take
            counter++
        }
        return out
    }

    /** 以给定 key 的 HMAC-SHA256。 */
    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    /**
     * hello 帧 sig（契约 §3.4，v1 格式，**保留**：旧端互操作 + 单测）：
     * base64url(HMAC-SHA256(key, UTF8("hello|" + role + "|" + channel)))
     */
    fun helloSig(key: ByteArray, role: String, channel: String): String =
        base64UrlEncode(hmacSha256(key, utf8(Protocol.HELLO_SIG_PREFIX + role + "|" + channel)))

    /**
     * v2 握手证明 sig（契约 §3.4.1，v1.1.3 抗重放）：
     * base64url(HMAC-SHA256(key, UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts
     *                              + "|" + pv + "|" + sid)))
     * 数字一律用十进制字符串拼接（与契约逐字一致）。
     */
    fun helloSig2(
        key: ByteArray,
        role: String,
        channel: String,
        epoch: Long,
        ts: Long,
        pv: Int,
        sid: String
    ): String {
        val material = Protocol.HELLO_SIG2_PREFIX + role + "|" + channel + "|" +
            epoch.toString() + "|" + ts.toString() + "|" + pv.toString() + "|" + sid
        return base64UrlEncode(hmacSha256(key, utf8(material)))
    }

    /**
     * AAD（契约 §7）：
     *  - 兼容模式（任一方 pv<2）：UTF8("dshrc|" + 发送方 role + "|" + seq)
     *  - 加固模式（双方 pv>=2）：UTF8("dshrc|" + 发送方 role + "|" + seq + "|" + sid)
     *    sid = **发送方**自己的连接实例 id（= 该帧的 frame.sid）。
     * sid 为空 → 旧 AAD 格式（v1.1.2 行为）。
     */
    fun aadOf(role: String, seq: Long, sid: String?): ByteArray {
        var s = Protocol.AAD_PREFIX + role + "|" + seq.toString()
        if (!sid.isNullOrEmpty()) s = s + "|" + sid
        return utf8(s)
    }

    // ---- AES-256-GCM ----

    private fun aesKey(key: ByteArray): SecretKeySpec = SecretKeySpec(key, "AES")

    /**
     * AES-256-GCM 加密，返回 ct||tag（tag 恒为末 16 字节）。
     */
    fun gcmEncrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, aesKey(key), GCMParameterSpec(Protocol.TAG_LEN * 8, iv))
        if (aad.isNotEmpty()) cipher.updateAAD(aad)
        val out = cipher.doFinal(plaintext)
        if (out.size < Protocol.TAG_LEN) throw KatFailure("gcm encrypt: output shorter than authTag")
        return out
    }

    /**
     * AES-256-GCM 解密，入参 ct||tag（tag 为末 16 字节），返回明文。
     * 认证失败抛异常（调用方丢弃该帧）。
     */
    fun gcmDecrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, ctAndTag: ByteArray): ByteArray {
        if (ctAndTag.size < Protocol.TAG_LEN) throw KatFailure("gcm decrypt: ciphertext too short")
        val ct = ctAndTag.copyOfRange(0, ctAndTag.size - Protocol.TAG_LEN)
        val tag = ctAndTag.copyOfRange(ctAndTag.size - Protocol.TAG_LEN, ctAndTag.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, aesKey(key), GCMParameterSpec(Protocol.TAG_LEN * 8, iv))
        if (aad.isNotEmpty()) cipher.updateAAD(aad)
        // Java 的 GCM 校验 tag 与密文一体；把 tag 拼回去由 provider 校验。
        val withTag = ByteArray(ct.size + tag.size)
        System.arraycopy(ct, 0, withTag, 0, ct.size)
        System.arraycopy(tag, 0, withTag, ct.size, tag.size)
        return cipher.doFinal(withTag)
    }

    /**
     * 加密明文为 frame.data（契约 §7 v1.0.1）：base64url( iv(12) || ct || tag(16) )。
     * AAD = UTF8("dshrc|" + role + "|" + seq)（加固模式再追加 "|" + sid）。
     * iv 缺省时用 CSPRNG 随机 12 字节；KAT 传固定 iv。
     */
    fun seal(
        key: ByteArray,
        role: String,
        seq: Long,
        plaintext: String,
        iv: ByteArray? = null,
        sid: String? = null
    ): String {
        val ivBuf = iv ?: randomBytes(Protocol.IV_LEN)
        val aad = aadOf(role, seq, sid)
        val ctTag = gcmEncrypt(key, ivBuf, aad, utf8(plaintext))
        val out = ByteArray(ivBuf.size + ctTag.size)
        System.arraycopy(ivBuf, 0, out, 0, ivBuf.size)
        System.arraycopy(ctTag, 0, out, ivBuf.size, ctTag.size)
        return base64UrlEncode(out)
    }

    /**
     * 解密 frame.data（iv||ct||tag 布局）。role 为**发送方** role（对 client 收帧而言是 "host"），
     * seq 为该消息的 frame.seq。认证失败抛异常（调用方丢弃该帧）。
     */
    fun open(
        key: ByteArray,
        role: String,
        seq: Long,
        data: String,
        sid: String? = null
    ): String {
        val raw = base64UrlDecode(data)
        if (raw.size < Protocol.IV_LEN + Protocol.TAG_LEN) throw KatFailure("open: ciphertext too short")
        val ivBuf = raw.copyOfRange(0, Protocol.IV_LEN)
        val ctTag = raw.copyOfRange(Protocol.IV_LEN, raw.size)
        val aad = aadOf(role, seq, sid)
        return fromUtf8(gcmDecrypt(key, ivBuf, aad, ctTag))
    }

    // ---- KAT ----

    /**
     * KAT 自检（契约 §7，连接建立前执行）。全部通过返回 true；任何一步失败抛 KatFailure。
     * 核对项：
     *  1. deriveKey(KAT_SECRET, KAT_CHANNEL) 的 hex == KAT_KEY_HEX
     *  2. 固定 ivHex 加密 KAT_PT（空 AAD）得到的 ct||tag hex == KAT_CT_HEX || KAT_TAG_HEX
     *  3. 用 ct||tag + 固定 iv 解密还原 KAT_PT
     *  4. AAD 绑定（契约 §7 断言 ①②③）：换 role / 换 seq / 换 sid（加固模式）必须解密失败
     *  5. HMAC-SHA256 向量
     *  6. v2 握手证明自洽（确定性 + sid/纪元绑定）
     */
    fun assertKat(): Boolean {
        // 1. HKDF key（契约 §7 keyHex）
        val key = deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val keyHex = toHex(key)
        if (keyHex != Protocol.KAT_KEY_HEX) {
            throw KatFailure("KAT key mismatch: got $keyHex want ${Protocol.KAT_KEY_HEX}")
        }

        // 2. 固定 iv + 空 AAD 加密（契约 §7 ctHex / tagHex）
        val ivBuf = fromHex(Protocol.KAT_IV_HEX)
        val emptyAad = ByteArray(0)
        val ctTag = gcmEncrypt(key, ivBuf, emptyAad, utf8(Protocol.KAT_PT))
        val ctOnly = ctTag.copyOfRange(0, ctTag.size - Protocol.TAG_LEN)
        val tagOnly = ctTag.copyOfRange(ctTag.size - Protocol.TAG_LEN, ctTag.size)
        val ctHex = toHex(ctOnly)
        val tagHex = toHex(tagOnly)
        if (ctHex != Protocol.KAT_CT_HEX) {
            throw KatFailure("KAT ct mismatch: got $ctHex want ${Protocol.KAT_CT_HEX}")
        }
        if (tagHex != Protocol.KAT_TAG_HEX) {
            throw KatFailure("KAT tag mismatch: got $tagHex want ${Protocol.KAT_TAG_HEX}")
        }

        // 3. 固定 iv + 空 AAD 解密还原
        val roundtrip = fromUtf8(gcmDecrypt(key, ivBuf, emptyAad, ctTag))
        if (roundtrip != Protocol.KAT_PT) throw KatFailure("KAT decrypt mismatch: got $roundtrip")

        // 4. AAD 绑定往返 + 跨 role / 跨 seq 必须失败
        val sample = "{\"hello\":\"world\"}"
        val sealed = seal(key, Protocol.ROLE_HOST, 7, sample)
        val back = open(key, Protocol.ROLE_HOST, 7, sealed)
        if (back != sample) throw KatFailure("KAT aad roundtrip mismatch: got $back")
        if (runCatching { open(key, Protocol.ROLE_CLIENT, 7, sealed) }.isSuccess) {
            throw KatFailure("KAT aad role binding not enforced")
        }
        // 契约 §7 断言 ②：换 seq 解密必须失败
        if (runCatching { open(key, Protocol.ROLE_HOST, 8, sealed) }.isSuccess) {
            throw KatFailure("KAT aad seq binding not enforced")
        }

        // 4b. 加固模式 AAD 绑定 sid（契约 §7 v1.1.3 断言 ③：换 sid 解密必须失败）
        val katSid = "a1b2c3d4"
        val sealedBound = seal(key, Protocol.ROLE_HOST, 7, sample, null, katSid)
        val boundBack = open(key, Protocol.ROLE_HOST, 7, sealedBound, katSid)
        if (boundBack != sample) throw KatFailure("KAT aad sid roundtrip mismatch: got $boundBack")
        if (runCatching { open(key, Protocol.ROLE_HOST, 7, sealedBound, "ffffffff") }.isSuccess) {
            throw KatFailure("KAT aad sid binding not enforced")
        }
        // 加固模式与兼容模式的 AAD 不同 → 用旧 AAD 解加固密文也必须失败
        if (runCatching { open(key, Protocol.ROLE_HOST, 7, sealedBound) }.isSuccess) {
            throw KatFailure("KAT hardened/compat aad separation not enforced")
        }

        // 4c. v2 握手证明自洽（契约 §3.4.1）
        val sig2 = helloSig2(key, Protocol.ROLE_HOST, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, katSid)
        val sig2Again = helloSig2(key, Protocol.ROLE_HOST, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, katSid)
        if (sig2 != sig2Again) throw KatFailure("KAT helloSig2 not deterministic")
        val sig2OtherSid = helloSig2(key, Protocol.ROLE_HOST, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, "ffffffff")
        if (sig2OtherSid == sig2) throw KatFailure("KAT helloSig2 sid not bound")
        val sig2OtherEpoch = helloSig2(key, Protocol.ROLE_HOST, Protocol.KAT_CHANNEL, 6, 1700000000000L, 2, katSid)
        if (sig2OtherEpoch == sig2) throw KatFailure("KAT helloSig2 epoch not bound")

        // 5. HMAC-SHA256 向量
        val hmacHex = toHex(hmacSha256(key, utf8(Protocol.KAT_HMAC_DATA)))
        if (hmacHex != Protocol.KAT_HMAC_HEX) throw KatFailure("KAT hmac mismatch: got $hmacHex")

        return true
    }

    /** SHA-256（用于 UI 层校验/去重等，不参与协议）。 */
    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)
}
