/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— JSON 小工具（基于 kotlinx.serialization 的 JsonElement API）。
 *
 * 刻意**不使用** @Serializable 注解（不需要编译器插件，也就不需要 codegen）：
 * 协议字段按契约逐字手写映射，缺字段一律给「安全缺省」（旧插件兼容，见契约各版本注记）。
 */
package dsh.rc.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** 协议用的 JSON 解析器（宽松：忽略未知字段）。 */
val DshrcJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = false
    encodeDefaults = false
    explicitNulls = false
}

// ---- JsonObject 读取助手（全部「缺失即缺省」） ----

fun JsonObject.strOrNull(key: String): String? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return if (el is JsonPrimitive) el.content else null
}

fun JsonObject.str(key: String, fallback: String = ""): String = strOrNull(key) ?: fallback

fun JsonObject.boolOrNull(key: String): Boolean? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return if (el is JsonPrimitive) el.booleanOrNull else null
}

fun JsonObject.bool(key: String, fallback: Boolean = false): Boolean = boolOrNull(key) ?: fallback

fun JsonObject.longOrNull(key: String): Long? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return if (el is JsonPrimitive) el.longOrNull ?: el.doubleOrNull?.toLong() else null
}

fun JsonObject.intOrNull(key: String): Int? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return if (el is JsonPrimitive) el.longOrNull?.toInt() ?: el.doubleOrNull?.toInt() else null
}

fun JsonObject.long(key: String, fallback: Long = 0L): Long = longOrNull(key) ?: fallback

fun JsonObject.int(key: String, fallback: Int = 0): Int = longOrNull(key)?.toInt() ?: fallback

fun JsonObject.objOrNull(key: String): JsonObject? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return el as? JsonObject
}

fun JsonObject.obj(key: String): JsonObject = objOrNull(key) ?: JsonObject(emptyMap())

fun JsonObject.arrOrNull(key: String): JsonArray? {
    val el = this[key] ?: return null
    if (el is JsonNull) return null
    return el as? JsonArray
}

fun JsonObject.arr(key: String): JsonArray = arrOrNull(key) ?: JsonArray(emptyList())

fun JsonObject.strList(key: String): List<String> =
    arrOrNull(key)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()

/** 安全地把任意 JsonElement 转成字符串标量（非标量 → null）。 */
fun JsonElement.asTextOrNull(): String? =
    if (this is JsonPrimitive) content else null

/** JsonObject → Map（供 question.answer 的 answers 用）。 */
fun JsonObject.toStringMap(): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for ((k, v) in this) {
        val s = v.asTextOrNull() ?: continue
        out[k] = s
    }
    return out
}

/** 构造一个 JSON 对象（可变参数 pairs）。 */
fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject {
    val obj = buildJsonObject { }
    val mutable = obj.toMutableMap()
    for ((k, v) in pairs) {
        mutable[k] = when (v) {
            null -> JsonNull
            is String -> JsonPrimitive(v)
            is Boolean -> JsonPrimitive(v)
            is Int -> JsonPrimitive(v)
            is Long -> JsonPrimitive(v)
            is Double -> JsonPrimitive(v)
            is JsonElement -> v
            else -> JsonPrimitive(v.toString())
        }
    }
    return JsonObject(mutable)
}

/** 把 Map 转成 JSON 对象（值按标量处理）。 */
fun mapToJson(map: Map<String, String>): JsonObject = buildJsonObject {
    for ((k, v) in map) put(k, v)
}

/** 把列表转成 JSON 数组（值按标量处理）。 */
fun listToJson(list: List<String>): JsonArray = buildJsonArray {
    for (v in list) add(JsonPrimitive(v))
}

internal fun JsonObject.toMapJson(): Map<String, JsonElement> = this
