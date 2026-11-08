/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 配对二维码解析（契约 §3.5）。
 *
 * PC 端（DSH 插件）出码格式：
 *   dshrc://pair?r=<encodeURIComponent(relayUrl)>&c=<channel>&s=<secret>[&t=<encodeURIComponent(relayToken)>]
 *
 * 手机端必须**同时接受两种形态**（契约 §3.5 明文要求）：
 *   1) 完整 URI（含 dshrc://pair? 前缀）
 *   2) 裸 query（r=…&c=…&s=…）——用户复制 / 系统裁剪掉前缀的情形
 *
 * 失败 / 字段缺失 → 返回明确 reason，**回落手动输入**（不静默丢弃）；
 * 已解析出的字段照常返回，供 UI 回填输入框。
 *
 * 与 HarmonyOS 版 model/pairqr.ets 同语义（字段级校验复用 RemoteProfile.validate）。
 */
package dsh.rc.pocket.ui.qr

import dsh.rc.pocket.data.RemoteProfile
import java.net.URLDecoder

/**
 * 配对码解析结果。
 *
 * @param ok 是否解析成功（可直接保存并连接）
 * @param reason 失败原因（ok=false 时可直接展示）
 * @param relayUrl 中继地址
 * @param channel 配对频道
 * @param secret 配对密钥
 * @param relayToken 中继令牌（可选）
 */
data class PairUriResult(
    val ok: Boolean,
    val reason: String,
    val relayUrl: String,
    val channel: String,
    val secret: String,
    val relayToken: String,
)

/** 配对二维码解析器（纯逻辑，不碰相机、不碰网络）。 */
object PairUri {

    /** 完整 URI 前缀（比较不区分大小写）。 */
    private const val URI_PREFIX = "dshrc://pair?"

    /** 仅 `dshrc://pair` 没有 query 的情形。 */
    private const val URI_BARE = "dshrc://pair"

    /** 形如 `scheme://` 的前缀（用于区分「URI 形态」与「裸 query 形态」）。 */
    private val SCHEME_REGEX = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")

    /**
     * 解析扫码文本（契约 §3.5）。
     *
     * @param text 扫码得到的原始文本
     */
    fun parse(text: String): PairUriResult {
        val raw = text.trim()
        if (raw.isEmpty()) {
            return fail("扫码结果为空")
        }
        val lower = raw.lowercase()
        if (lower.startsWith(URI_BARE) && !lower.startsWith(URI_PREFIX)) {
            return fail("配对二维码缺少参数（应为 dshrc://pair?r=…&c=…&s=…）")
        }
        val query = extractQuery(raw) ?: return fail("不是 DSH 配对二维码（期望 dshrc://pair?… 或 r=…&c=…&s=…）")
        val map = parseQuery(query)

        val missing = ArrayList<String>(3)
        if (map["r"].isNullOrEmpty()) missing.add("r（中继地址）")
        if (map["c"].isNullOrEmpty()) missing.add("c（channel）")
        if (map["s"].isNullOrEmpty()) missing.add("s（secret）")

        val relayUrl = decodeParam(map["r"].orEmpty()).trim()
        val channel = decodeParam(map["c"].orEmpty()).trim()
        val secret = decodeParam(map["s"].orEmpty()).trim()
        val relayToken = decodeParam(map["t"].orEmpty()).trim()

        if (missing.isNotEmpty()) {
            return PairUriResult(
                ok = false,
                reason = "配对二维码缺少必填字段：" + missing.joinToString("、"),
                relayUrl = relayUrl,
                channel = channel,
                secret = secret,
                relayToken = relayToken,
            )
        }
        val invalid = RemoteProfile.validate(relayUrl, channel, secret)
        if (invalid.isNotEmpty()) {
            return PairUriResult(
                ok = false,
                reason = "配对二维码字段不合法：$invalid",
                relayUrl = relayUrl,
                channel = channel,
                secret = secret,
                relayToken = relayToken,
            )
        }
        return PairUriResult(
            ok = true,
            reason = "",
            relayUrl = relayUrl,
            channel = channel,
            secret = secret,
            relayToken = relayToken,
        )
    }

    /** 空结果（失败且没有任何字段可回填）。 */
    private fun fail(reason: String) = PairUriResult(
        ok = false,
        reason = reason,
        relayUrl = "",
        channel = "",
        secret = "",
        relayToken = "",
    )

    /**
     * 从扫描文本中取出 query 部分。
     *
     * 判定：以「scheme://」开头的才算 URI 形态（scheme 必须在字符串开头——
     * 不能用 contains("://")，裸 query 里的 relayUrl 本身就含 wss://）；
     * 是 URI 却不是 dshrc://pair?… 的返回 null（形态无法识别）。
     */
    private fun extractQuery(raw: String): String? {
        val lower = raw.lowercase()
        if (lower.startsWith(URI_PREFIX)) return raw.substring(URI_PREFIX.length)
        if (SCHEME_REGEX.containsMatchIn(raw)) return null
        return raw
    }

    /** 解析裸 query 串为 k=v 映射（以第一个 `=` 切分；重复 key 后者覆盖）。 */
    private fun parseQuery(query: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (pair in query.split("&")) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            if (eq < 0) {
                out[pair] = ""
            } else {
                out[pair.substring(0, eq)] = pair.substring(eq + 1)
            }
        }
        return out
    }

    /**
     * 解码单个 query 值。
     *
     * 契约要求 r/t 为 encodeURIComponent 编码，c/s 为免编码字符集；
     * 值本身未编码（解码抛错）时按原样返回，交给字段校验报错。
     * 注意：'+' 在 encodeURIComponent 里是字面量，先转义再交给 URLDecoder，
     * 否则会被当成空格。
     */
    private fun decodeParam(v: String): String = try {
        URLDecoder.decode(v.replace("+", "%2B"), "UTF-8")
    } catch (e: Exception) {
        v
    }
}
