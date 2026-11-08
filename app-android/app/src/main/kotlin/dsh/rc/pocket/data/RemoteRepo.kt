/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 多远程档案持久化（DataStore Preferences）。
 *
 * 与 HarmonyOS 版 model/connections.ets 的 ConnectionStore **同语义**：
 *  - 持久化：Preferences `dshrc_prefs` 的 `remotes`（JSON 数组）+ `activeRemoteId`（当前项）
 *  - 旧单条配对键（relayUrl/channel/secret/relayToken）首次启动时**迁移**成一个
 *    名为「默认远程」的档案（老用户零操作升级）
 *  - 切换远程 = link.stop() + link.start(...)，纪元随档案注入并写回
 *
 * 落盘口径：secret / relayToken 只存本机（备份规则已排除，见 res/xml/backup_rules.xml）。
 */
package dsh.rc.pocket.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dsh.rc.core.DshrcJson
import dsh.rc.core.EpochState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray

/** DataStore 实例（进程内单例；名字与 HarmonyOS 版 Preferences 一致）。 */
private val Context.dshrcDataStore: DataStore<Preferences> by preferencesDataStore(name = "dshrc_prefs")

/**
 * 多远程档案仓。
 *
 * @param context 应用上下文（只用于取 DataStore）
 */
class RemoteRepo(private val context: Context) {

    private val store = context.dshrcDataStore

    /** 全部远程档案（按写入顺序）。 */
    val profiles: Flow<List<RemoteProfile>> = store.data.map { prefs -> parseProfiles(prefs[KEY_REMOTES]) }

    /** 当前使用的远程 id（空串 = 未选择）。 */
    val activeId: Flow<String> = store.data.map { prefs -> prefs[KEY_ACTIVE_REMOTE] ?: "" }

    /** 当前使用的远程档案（未选择 → null）。 */
    val activeProfile: Flow<RemoteProfile?> = store.data.map { prefs ->
        val id = prefs[KEY_ACTIVE_REMOTE] ?: ""
        parseProfiles(prefs[KEY_REMOTES]).firstOrNull { it.id == id }
    }

    /**
     * 读取远程列表；首次没有新数据时用旧的单条配对迁移一个「默认远程」。
     *
     * @return 迁移后的档案列表
     */
    suspend fun load(): List<RemoteProfile> {
        val prefs = store.data.first()
        val parsed = parseProfiles(prefs[KEY_REMOTES])
        if (parsed.isNotEmpty()) return parsed
        // 迁移旧的单条配对（老用户零操作升级成「默认远程」）
        val legacyRelay = prefs[KEY_LEGACY_RELAY_URL] ?: ""
        val legacyChannel = prefs[KEY_LEGACY_CHANNEL] ?: ""
        val legacySecret = prefs[KEY_LEGACY_SECRET] ?: ""
        val legacyToken = prefs[KEY_LEGACY_RELAY_TOKEN] ?: ""
        if (legacyRelay.isEmpty() && legacyChannel.isEmpty() && legacySecret.isEmpty()) {
            return emptyList()
        }
        val migrated = RemoteProfile(
            id = RemoteProfile.newId(),
            name = DEFAULT_REMOTE_NAME,
            relayUrl = legacyRelay,
            channel = legacyChannel,
            secret = legacySecret,
            relayToken = legacyToken,
            lastUsedAt = System.currentTimeMillis(),
        )
        store.edit { prefs ->
            prefs[KEY_REMOTES] = serialize(listOf(migrated))
            prefs[KEY_ACTIVE_REMOTE] = migrated.id
        }
        return listOf(migrated)
    }

    /** 按 id 查档案。 */
    suspend fun profileOf(id: String): RemoteProfile? = load().firstOrNull { it.id == id }

    /** 新增或更新档案（id 为空时自动生成）。 */
    suspend fun upsert(profile: RemoteProfile) {
        val current = load().toMutableList()
        val idx = current.indexOfFirst { it.id == profile.id }
        if (idx >= 0) {
            current[idx] = profile
        } else {
            current.add(profile)
        }
        store.edit { prefs -> prefs[KEY_REMOTES] = serialize(current) }
    }

    /** 删除档案（当前项被删时清空 activeRemoteId）。 */
    suspend fun remove(id: String) {
        val current = load().filterNot { it.id == id }
        store.edit { prefs ->
            prefs[KEY_REMOTES] = serialize(current)
            if (prefs[KEY_ACTIVE_REMOTE] == id) prefs[KEY_ACTIVE_REMOTE] = ""
        }
    }

    /** 设置当前使用的远程。 */
    suspend fun setActive(id: String) {
        store.edit { prefs -> prefs[KEY_ACTIVE_REMOTE] = id }
    }

    /** 刷新最近使用时间。 */
    suspend fun touch(id: String) {
        val current = load().toMutableList()
        val idx = current.indexOfFirst { it.id == id }
        if (idx < 0) return
        current[idx] = current[idx].copy(lastUsedAt = System.currentTimeMillis())
        store.edit { prefs -> prefs[KEY_REMOTES] = serialize(current) }
    }

    /**
     * 落盘纪元状态（契约 §3.4.1「先持久化再使用」）：
     * 链路每条新连接把 self +1，或接受对端证明时更新 peer/peerSid —— 都通过这里写回档案。
     */
    suspend fun applyEpoch(id: String, epoch: EpochState) {
        val current = load().toMutableList()
        val idx = current.indexOfFirst { it.id == id }
        if (idx < 0) return
        if (current[idx].epoch == epoch) return
        current[idx] = current[idx].copy(epoch = epoch)
        store.edit { prefs -> prefs[KEY_REMOTES] = serialize(current) }
    }

    /**
     * 同步旧的单条配对键（老逻辑 / 其它模块仍读 relayUrl/channel/secret/relayToken）。
     * 与 HarmonyOS 版 savePairing 同口径。
     */
    suspend fun syncLegacy(profile: RemoteProfile) {
        store.edit { prefs ->
            prefs[KEY_LEGACY_RELAY_URL] = profile.relayUrl.trim()
            prefs[KEY_LEGACY_CHANNEL] = profile.channel.trim()
            prefs[KEY_LEGACY_SECRET] = profile.secret.trim()
            prefs[KEY_LEGACY_RELAY_TOKEN] = profile.relayToken.trim()
        }
    }

    // ---- 序列化 ----

    /** 档案数组 → JSON 字符串（显式拼装，不依赖序列化插件）。 */
    private fun serialize(list: List<RemoteProfile>): String {
        val arr = buildJsonArray {
            for (p in list) add(p.toJson())
        }
        return arr.toString()
    }

    /** JSON 字符串 → 档案数组（脏数据整体丢弃，不抛异常）。 */
    private fun parseProfiles(text: String?): List<RemoteProfile> {
        if (text.isNullOrBlank()) return emptyList()
        return runCatching {
            val arr = DshrcJson.parseToJsonElement(text) as? JsonArray ?: return emptyList()
            val out = ArrayList<RemoteProfile>(arr.size)
            for (el in arr) {
                val obj = el as? JsonObject ?: continue
                RemoteProfile.fromJson(obj)?.let { out.add(it) }
            }
            out
        }.getOrDefault(emptyList())
    }

    companion object {
        /** 迁移旧单条配对时的默认名称。 */
        const val DEFAULT_REMOTE_NAME: String = "默认远程"

        private val KEY_REMOTES = stringPreferencesKey("remotes")
        private val KEY_ACTIVE_REMOTE = stringPreferencesKey("activeRemoteId")

        // 旧单条配对键（迁移来源；之后与当前档案保持同步）
        private val KEY_LEGACY_RELAY_URL = stringPreferencesKey("relayUrl")
        private val KEY_LEGACY_CHANNEL = stringPreferencesKey("channel")
        private val KEY_LEGACY_SECRET = stringPreferencesKey("secret")
        private val KEY_LEGACY_RELAY_TOKEN = stringPreferencesKey("relayToken")
    }
}
