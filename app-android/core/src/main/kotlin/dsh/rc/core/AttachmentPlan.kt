/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 用户提示词附件的规划 / 校验（契约 §5.11，v1.2.0）。
 *
 * 移植自 app/entry/src/main/ets/model/attachment-plan.ts（**纯 TS**，node 回归共用）：
 * 分块计划、块大小 clamp、文件名净化、字节数格式化、上限校验。
 * 行为口径一旦变了，两侧一起变——**不要把这里的规则复制到别处**。
 *
 * 上传流程（契约 §5.11.2，串行）：
 *   attachment.upload.begin → attachment.upload.chunk×N → attachment.upload.commit
 *   （attachment.upload.abort = 放弃，幂等）
 * 分块 data 必须是**标准 base64（canonical，有填充）**，index 从 0 连续递增。
 */
package dsh.rc.core

import java.util.Locale

/** 附件种类（wire 取值，契约 §5.11）。 */
object AttachmentKind {
    const val IMAGE: String = "image"
    const val FILE: String = "file"
}

/**
 * 待上传的附件草稿（UI 层的附件 chip 数据源）。
 *
 * 字节本身**不**进这个对象（Android 侧由 SAF 读入内存 / 临时文件，UI 层自行管理）；
 * 本类只承载「校验 + 乐观上屏 + 上传编排」需要的字段。
 *
 * 字段与 UI 层约定一致：`fileName / mimeType / bytes / localId / uploadId?`。
 */
data class DraftAttachment(
    /** 文件名（kind=file 时必填）。 */
    val fileName: String,
    /** 媒体类型（image 开头的图片类型，或 application/pdf 之类的普通文件；图片必须在宿主目录内）。 */
    val mimeType: String,
    /** 原始字节数。 */
    val bytes: Long,
    /** 本机唯一 id（乐观上屏的 `local:<localId>` 命名空间）。 */
    val localId: String,
    /** commit 成功后写回的 uploadId（prompt 失败重试**复用**，不重复上传）。 */
    val uploadId: String? = null
) {
    /** wire kind（契约 §5.11.2）：图片走 image，其余走 file。 */
    val kind: String
        get() = if (mimeType.startsWith("image/")) AttachmentKind.IMAGE else AttachmentKind.FILE

    val isImage: Boolean get() = kind == AttachmentKind.IMAGE

    /** 乐观上屏用的图片 id（`local:` 命名空间，宿主 attachmentId 与之天然对不上）。 */
    val localImageId: String get() = "local:" + localId

    /** 乐观上屏用的文件 id。 */
    val localFileId: String get() = "local:" + localId
}

/**
 * 附件能力目录的规范化与上限校验（**纯函数**，无状态）。
 *
 * 契约 §5.11.1：`session.capabilities.attachments` 缺省 = 宿主不支持 → 客户端隐藏附件入口。
 */
object AttachmentPlan {

    /** 契约 §5.11.1 的缺省上限（宿主不回字段时按这些保守值处理）。 */
    const val DEFAULT_MAX_COUNT: Int = 9
    const val DEFAULT_MAX_ITEM_BYTES: Long = 20L * 1024 * 1024
    const val DEFAULT_MAX_MESSAGE_BYTES: Long = 40L * 1024 * 1024
    const val DEFAULT_CHUNK_BYTES: Int = 256 * 1024

    /**
     * 单块明文硬上限（256KiB）。
     * 256KiB 明文 → 约 341KB 标准 base64 → 约 460KB AES-GCM 密文帧，远低于中继 1MiB。
     * 客户端只能比 `caps.chunkBytes` **更小**，绝不能更大（否则可能撑爆中继单帧）。
     */
    const val MAX_CHUNK_BYTES: Int = 256 * 1024

    /** 宿主默认接受的图片媒体类型（契约 §5.11.1 imageMediaTypes）。 */
    val DEFAULT_IMAGE_MEDIA_TYPES: List<String> =
        listOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /** 宿主文件名上限（§5.11.2 插件侧同名约束），超长先截断避免超长 toast。 */
    const val MAX_FILE_NAME_CHARS: Int = 180

    /**
     * 单块明文大小 clamp：
     *  - 非正数 → 缺省 256KiB；
     *  - 宿主给的更小值尊重之（客户端可更小）；
     *  - 超过 256KiB 一律夹到 256KiB（中继单帧 1MiB 硬约束）。
     */
    fun clampChunkBytes(hostChunkBytes: Int): Int {
        if (hostChunkBytes <= 0) return DEFAULT_CHUNK_BYTES
        return if (hostChunkBytes > MAX_CHUNK_BYTES) MAX_CHUNK_BYTES else hostChunkBytes
    }

    /** 分块数（bytes=0 → 0）。 */
    fun chunkCount(totalBytes: Long, chunkBytes: Int): Int {
        if (totalBytes <= 0) return 0
        val size = clampChunkBytes(chunkBytes).toLong()
        var remain = totalBytes
        var n = 0
        while (remain > 0) {
            remain -= if (remain > size) size else remain
            n += 1
        }
        return n
    }

    /**
     * 分块计划：返回每块的**明文字节偏移区间**（闭区间）。
     * 例：planChunks(262145, 262144) = [0..262143, 262144..262144]。
     *
     * 前 n-1 块 = chunkBytes，最后一块可能更短；各块首尾相接、不重不漏。
     */
    fun planChunks(totalBytes: Long, chunkBytes: Int): List<IntRange> {
        if (totalBytes <= 0) return emptyList()
        val size = clampChunkBytes(chunkBytes).toLong()
        val out = ArrayList<IntRange>()
        var offset = 0L
        while (offset < totalBytes) {
            val end = if (offset + size < totalBytes) offset + size else totalBytes
            out.add(offset.toInt()..(end - 1L).toInt())
            offset = end
        }
        return out
    }

    /**
     * 文件名净化：去掉 query/fragment，取最后一段并 percent-decode；空 → 「attachment」。
     * （宿主文件名上限 180 字符，超长先截断。）
     */
    fun attachmentFileName(name: String?): String {
        val fallback = "attachment"
        if (name.isNullOrEmpty()) return fallback
        var path = name
        val q = path.indexOf('?')
        if (q >= 0) path = path.substring(0, q)
        val h = path.indexOf('#')
        if (h >= 0) path = path.substring(0, h)
        val slash = path.lastIndexOf('/')
        var base = if (slash >= 0) path.substring(slash + 1) else path
        base = percentDecode(base)
        if (base.isEmpty()) return fallback
        return if (base.length > MAX_FILE_NAME_CHARS) base.substring(0, MAX_FILE_NAME_CHARS) else base
    }

    /** 字节数 → 展示文本（B / KB / MB / GB，一位小数）。 */
    fun formatAttachmentSize(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        if (bytes < 1024) return "$bytes B"
        if (bytes < 1024L * 1024) return oneDecimal(bytes / 1024.0) + " KB"
        if (bytes < 1024L * 1024 * 1024) return oneDecimal(bytes / (1024.0 * 1024.0)) + " MB"
        return oneDecimal(bytes / (1024.0 * 1024.0 * 1024.0)) + " GB"
    }

    /**
     * 规范化 `session.capabilities.attachments`：
     *  - **null → null**（宿主不支持 / 尚未拉到 → 隐藏附件入口，不报错）；
     *  - 缺字段按契约当前实现常量兜底；`chunkBytes` 一律 clamp 到 ≤256KiB；
     *  - `imageMediaTypes` 全空时回契约缺省目录。
     */
    fun normalizeAttachmentCaps(caps: AttachmentCaps?): AttachmentCaps? {
        if (caps == null) return null
        val types = caps.imageMediaTypes.filter { it.isNotEmpty() }
        return AttachmentCaps(
            supported = caps.supported,
            maxCount = positiveInt(caps.maxCount, DEFAULT_MAX_COUNT),
            maxItemBytes = positiveLong(caps.maxItemBytes, DEFAULT_MAX_ITEM_BYTES),
            maxMessageBytes = positiveLong(caps.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES),
            chunkBytes = clampChunkBytes(caps.chunkBytes),
            imageMediaTypes = if (types.isNotEmpty()) types else DEFAULT_IMAGE_MEDIA_TYPES
        )
    }

    /** 宿主是否支持附件（缺省 / false → 隐藏附件入口）。 */
    fun attachmentSupported(caps: AttachmentCaps?): Boolean = caps?.supported == true

    /** 图片媒体类型是否在宿主接受列表里（大小写不敏感）。 */
    fun isAcceptedImageType(mediaType: String, accepted: List<String>): Boolean {
        if (mediaType.isEmpty()) return false
        val want = mediaType.lowercase()
        for (t in accepted) {
            if (t.lowercase() == want) return true
        }
        return false
    }

    /**
     * 把「已选附件」按契约 §5.11.1 上限校验一遍。
     * 校验顺序（先报最直观的原因）：宿主能力 → 参数 → 单项字节 → 数量 → 总字节。
     *
     * @return 错误文案（可直接给 toast）；null = 通过。
     */
    fun checkAttachmentDraft(items: List<DraftAttachment>, caps: AttachmentCaps?): String? {
        val normalized = normalizeAttachmentCaps(caps)
        if (normalized == null || !normalized.supported) return "当前主机不支持附件"
        // 1) 参数
        for (item in items) {
            if (item.kind != AttachmentKind.IMAGE && item.kind != AttachmentKind.FILE) {
                return "附件类型不正确"
            }
            if (item.bytes <= 0) return "附件为空"
            if (item.kind == AttachmentKind.FILE && item.fileName.isBlank()) return "文件缺少文件名"
            if (item.kind == AttachmentKind.IMAGE &&
                !isAcceptedImageType(item.mimeType, normalized.imageMediaTypes)
            ) {
                return "不支持的图片格式：" + item.mimeType
            }
        }
        // 2) 单项字节
        for (item in items) {
            if (item.bytes > normalized.maxItemBytes) {
                return "单个附件超过上限 " + formatAttachmentSize(normalized.maxItemBytes)
            }
        }
        // 3) 数量
        if (items.size > normalized.maxCount) {
            return "每条消息最多 " + normalized.maxCount + " 个附件"
        }
        // 4) 合计字节
        var total = 0L
        for (item in items) {
            if (item.bytes > 0) total += item.bytes
        }
        if (total > normalized.maxMessageBytes) {
            return "附件总大小超过上限 " + formatAttachmentSize(normalized.maxMessageBytes)
        }
        return null
    }

    // ---- 内部工具 ----

    private fun positiveInt(value: Int, fallback: Int): Int = if (value <= 0) fallback else value

    private fun positiveLong(value: Long, fallback: Long): Long = if (value <= 0) fallback else value

    private fun oneDecimal(value: Double): String = String.format(Locale.US, "%.1f", value)

    /**
     * percent-decode（等价 decodeURIComponent）。
     * 非法百分号编码 → 保留原串（宿主会再净化文件名）。
     */
    private fun percentDecode(s: String): String {
        if (!s.contains('%')) return s
        val bytes = ArrayList<Byte>()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length) {
                val v = s.substring(i + 1, i + 3).toIntOrNull(16)
                if (v == null || v < 0 || v > 255) return s // 非法编码 → 原样返回
                bytes.add(v.toByte())
                i += 3
                continue
            }
            bytes.addAll(c.toString().toByteArray(Charsets.UTF_8).toList())
            i += 1
        }
        return String(bytes.toByteArray(), Charsets.UTF_8)
    }
}
