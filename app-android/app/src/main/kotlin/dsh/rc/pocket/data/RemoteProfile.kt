/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 多远程档案（一条档案 = 一台可遥控的 PC）。
 *
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/connections.ets 的 RemoteProfile **同字段**：
 *   id / name / relayUrl / channel / secret / relayToken / lastUsedAt
 *   + v1.1.3 会话纪元（契约 §3.4.1）：自己的纪元 / 已接受的对端最高纪元 / 已钉扎的对端 sid
 *     （Android 侧合并成 core 的 EpochState，三元组一一对应）
 *
 * 安全口径：secret / relayToken **只存本机**，绝不写日志、绝不上报中继。
 */
package dsh.rc.pocket.data

import dsh.rc.core.EpochState
import dsh.rc.core.long
import dsh.rc.core.str
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * 一个远程主机的连接档案。
 *
 * @param id 本地唯一标识（非安全用途）
 * @param name 自定义名称（空串 → 用 relayUrl 兜底）
 * @param relayUrl 中继地址（ws:// 或 wss://）
 * @param channel 配对频道（契约 §4：`^[A-Z2-7]{16,64}$`）
 * @param secret 配对密钥（≥32 字符，只存本机）
 * @param relayToken 中继鉴权 token（可选，只存本机）
 * @param lastUsedAt 最近使用时间（毫秒）
 * @param epoch 会话纪元（契约 §3.4.1，抗重放）
 */
data class RemoteProfile(
    val id: String,
    val name: String,
    val relayUrl: String,
    val channel: String,
    val secret: String,
    val relayToken: String,
    val lastUsedAt: Long,
    val epoch: EpochState = EpochState(0, -1, ""),
) {
    /** 列表显示名（无名时用 relayUrl 兜底）。 */
    fun displayName(): String {
        val n = name.trim()
        if (n.isNotEmpty()) return n
        if (relayUrl.isNotEmpty()) return relayUrl
        return "未命名远程"
    }

    /** 持久化形态（JSON；字段缺失按安全缺省）。 */
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("name", name)
        put("relayUrl", relayUrl)
        put("channel", channel)
        put("secret", secret)
        put("relayToken", relayToken)
        put("lastUsedAt", lastUsedAt)
        put("selfEpoch", epoch.self)
        put("peerEpoch", epoch.peer)
        put("peerSid", epoch.peerSid)
    }

    companion object {
        /** 生成远程 id（本地唯一即可，不作安全用途）。 */
        fun newId(): String = "r" + UUID.randomUUID().toString().replace("-", "").take(12)

        /** JSON → 档案；缺 id 的脏数据丢弃（返回 null）。 */
        fun fromJson(o: JsonObject): RemoteProfile? {
            val id = o.str("id")
            if (id.isEmpty()) return null
            return RemoteProfile(
                id = id,
                name = o.str("name"),
                relayUrl = o.str("relayUrl"),
                channel = o.str("channel"),
                secret = o.str("secret"),
                relayToken = o.str("relayToken"),
                lastUsedAt = o.long("lastUsedAt"),
                // 老数据缺纪元字段 → 补默认值（自己的纪元 0 / 未接受过对端 -1 / 无钉扎 sid）
                epoch = EpochState(
                    self = o.long("selfEpoch"),
                    peer = o.long("peerEpoch", -1L),
                    peerSid = o.str("peerSid"),
                ),
            )
        }

        /** 校验配对四字段，返回可展示的错误文案；通过则返回空串。 */
        fun validate(
            relayUrl: String,
            channel: String,
            secret: String,
        ): String {
            if (relayUrl.isEmpty()) return "请填写中继地址（wss://…）"
            if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
                return "中继地址必须以 ws:// 或 wss:// 开头"
            }
            if (channel.isEmpty()) return "请填写配对频道（channel）"
            if (!CHANNEL_REGEX.matches(channel)) {
                return "channel 须为 16~64 位大写字母 A-Z / 数字 2-7"
            }
            if (secret.length < 32) return "secret 至少 32 个字符"
            return ""
        }

        /** channel 格式（契约 §4：RFC 4648 base32 字母表）。 */
        private val CHANNEL_REGEX = Regex("^[A-Z2-7]{16,64}$")
    }
}

/** relay 地址 → 主机名:端口（去掉 ws:// / wss:// 前缀与路径）。 */
fun relayHostLabel(relayUrl: String): String {
    var s = relayUrl.trim()
    if (s.startsWith("ws://")) {
        s = s.substring(5)
    } else if (s.startsWith("wss://")) {
        s = s.substring(6)
    }
    val slash = s.indexOf('/')
    if (slash >= 0) s = s.substring(0, slash)
    return s
}
