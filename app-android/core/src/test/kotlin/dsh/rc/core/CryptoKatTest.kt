/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 加密层 KAT 单测（契约 §7）。
 *
 * 这是**硬验收项**：契约 §7 的测试向量必须逐字节一致（key / iv / ct / tag / HMAC）。
 * 另外补契约 §7 明确要求的断言 ①②③：换 role / 换 seq / 换 sid 必须解密失败。
 */
package dsh.rc.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CryptoKatTest {

    @Test
    fun `kat self check passes`() {
        assertTrue(Crypto.assertKat())
    }

    @Test
    fun `hkdf key matches contract vector`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        assertEquals(Protocol.KAT_KEY_HEX, Crypto.toHex(key))
    }

    @Test
    fun `aes gcm ciphertext matches contract vector`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val iv = Crypto.fromHex(Protocol.KAT_IV_HEX)
        val ctTag = Crypto.gcmEncrypt(key, iv, ByteArray(0), Crypto.utf8(Protocol.KAT_PT))
        val ct = Crypto.toHex(ctTag.copyOfRange(0, ctTag.size - Protocol.TAG_LEN))
        val tag = Crypto.toHex(ctTag.copyOfRange(ctTag.size - Protocol.TAG_LEN, ctTag.size))
        assertEquals(Protocol.KAT_CT_HEX, ct)
        assertEquals(Protocol.KAT_TAG_HEX, tag)
    }

    @Test
    fun `aes gcm decrypt restores plaintext`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val iv = Crypto.fromHex(Protocol.KAT_IV_HEX)
        val ctTag = Crypto.fromHex(Protocol.KAT_CT_HEX + Protocol.KAT_TAG_HEX)
        val pt = Crypto.fromUtf8(Crypto.gcmDecrypt(key, iv, ByteArray(0), ctTag))
        assertEquals(Protocol.KAT_PT, pt)
    }

    @Test
    fun `hmac sha256 matches contract vector`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val mac = Crypto.hmacSha256(key, Crypto.utf8(Protocol.KAT_HMAC_DATA))
        assertEquals(Protocol.KAT_HMAC_HEX, Crypto.toHex(mac))
    }

    @Test
    fun `seal open roundtrip with aad bound to role and seq`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val sealed = Crypto.seal(key, Protocol.ROLE_CLIENT, 42, """{"id":"x"}""")
        assertEquals("""{"id":"x"}""", Crypto.open(key, Protocol.ROLE_CLIENT, 42, sealed))
    }

    @Test
    fun `aad binding rejects wrong role`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val sealed = Crypto.seal(key, Protocol.ROLE_HOST, 7, "payload")
        var rejected = false
        try {
            Crypto.open(key, Protocol.ROLE_CLIENT, 7, sealed)
        } catch (e: Exception) {
            rejected = true
        }
        assertTrue("换 role 必须解密失败", rejected)
    }

    @Test
    fun `aad binding rejects wrong seq`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val sealed = Crypto.seal(key, Protocol.ROLE_HOST, 7, "payload")
        var rejected = false
        try {
            Crypto.open(key, Protocol.ROLE_HOST, 8, sealed)
        } catch (e: Exception) {
            rejected = true
        }
        assertTrue("换 seq 必须解密失败", rejected)
    }

    @Test
    fun `hardened aad binds sid`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val sealed = Crypto.seal(key, Protocol.ROLE_HOST, 7, "payload", null, "a1b2c3d4")
        assertEquals("payload", Crypto.open(key, Protocol.ROLE_HOST, 7, sealed, "a1b2c3d4"))
        var rejected = false
        try {
            Crypto.open(key, Protocol.ROLE_HOST, 7, sealed, "ffffffff")
        } catch (e: Exception) {
            rejected = true
        }
        assertTrue("换 sid 必须解密失败", rejected)
        // 加固密文不能用兼容 AAD 解开
        rejected = false
        try {
            Crypto.open(key, Protocol.ROLE_HOST, 7, sealed)
        } catch (e: Exception) {
            rejected = true
        }
        assertTrue("加固/兼容 AAD 必须隔离", rejected)
    }

    @Test
    fun `hello proof v2 binds epoch and sid`() {
        val key = Crypto.deriveKey(Protocol.KAT_SECRET, Protocol.KAT_CHANNEL)
        val a = Crypto.helloSig2(key, Protocol.ROLE_CLIENT, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, "a1b2c3d4")
        val b = Crypto.helloSig2(key, Protocol.ROLE_CLIENT, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, "a1b2c3d4")
        assertEquals(a, b)
        assertNotEquals(
            a,
            Crypto.helloSig2(key, Protocol.ROLE_CLIENT, Protocol.KAT_CHANNEL, 8, 1700000000000L, 2, "a1b2c3d4")
        )
        assertNotEquals(
            a,
            Crypto.helloSig2(key, Protocol.ROLE_CLIENT, Protocol.KAT_CHANNEL, 7, 1700000000000L, 2, "ffffffff")
        )
    }

    @Test
    fun `base64url roundtrip`() {
        val data = Crypto.utf8("hello world 你好")
        val enc = Crypto.base64UrlEncode(data)
        assertTrue("base64url 不含 padding", !enc.contains("="))
        assertTrue("base64url 字符集合法", enc.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        assertTrue(Crypto.utf8("hello world 你好").contentEquals(Crypto.base64UrlDecode(enc)))
    }

    @Test
    fun `channel validation follows contract`() {
        assertTrue(Protocol.isValidChannel("KMNPQRTVWXY23456"))
        assertTrue(!Protocol.isValidChannel("TMPTEST123456789")) // 含 1/8/9 → 非法
        assertTrue(!Protocol.isValidChannel("short"))
    }
}
