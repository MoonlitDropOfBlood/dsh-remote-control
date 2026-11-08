/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 输入框附件（SAF 选择 → 缩略图 → core 分块上传）。
 *
 * 契约 §5.11：
 *  - 图片 / 文件都走 SAF（PickVisualMedia / OpenDocument），不申请存储权限
 *  - 附件**分块上传**到宿主（begin → chunk* → commit），**不把 base64 塞进 prompt**
 *  - 上传在 core 侧发起（见 PocketViewModel.uploadAttachment），本文件只负责「选 + 读 + 展示」
 *
 * 内存安全：先 stat 再读；单项超过宿主上限直接拒（不读进内存）。
 */
package dsh.rc.pocket.ui.attach

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.AttachmentPlan
import dsh.rc.core.DraftAttachment
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.vm.PendingAttachment
import dsh.rc.pocket.vm.newLocalId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 附件选择器句柄。
 *
 * @param pickImage 选图片（系统照片选择器）
 * @param pickFile 选任意文件（SAF OpenDocument）
 */
class AttachmentPicker(
    val pickImage: () -> Unit,
    val pickFile: () -> Unit,
)

/**
 * 记住一个 SAF 附件选择器。
 *
 * 读取字节与解码缩略图都在 IO 线程做，主线程不卡。
 *
 * @param maxItemBytes 单项字节上限（宿主能力目录；超限直接拒，不读进内存）
 * @param onPicked 选好的附件（可能为空列表）
 */
@Composable
fun rememberAttachmentPicker(
    maxItemBytes: Long,
    onPicked: (List<PendingAttachment>) -> Unit,
): AttachmentPicker {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    fun handle(uri: Uri?) {
        if (uri == null) return
        scope.launch {
            val item = withContext(Dispatchers.IO) { readAttachment(context, uri, maxItemBytes) }
            if (item != null) {
                onPicked(listOf(item))
            }
        }
    }

    val imageLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> handle(uri) }
    val fileLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> handle(uri) }

    return remember(imageLauncher, fileLauncher) {
        AttachmentPicker(
            pickImage = {
                imageLauncher.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
            pickFile = {
                fileLauncher.launch(arrayOf("*/*"))
            },
        )
    }
}

/**
 * 读一个 SAF 文档 → 草稿附件。
 *
 * @return null 表示超限 / 读取失败（调用方应提示）
 */
private fun readAttachment(context: Context, uri: Uri, maxItemBytes: Long): PendingAttachment? {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri) ?: "application/octet-stream"
    val isImage = mimeType.startsWith("image/")
    val declaredSize = querySize(resolver, uri)
    if (declaredSize != null && declaredSize > maxItemBytes) {
        return null
    }
    val bytes = runCatching {
        resolver.openInputStream(uri)?.use { input ->
            // 上限 +1 字节：多读一个字节即判定超限，避免把超大文件读进内存
            val buffer = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(chunk)
                if (n <= 0) break
                total += n
                if (total > maxItemBytes) return null
                buffer.write(chunk, 0, n)
            }
            buffer.toByteArray()
        }
    }.getOrNull() ?: return null
    if (bytes.isEmpty()) return null
    val name = queryName(resolver, uri) ?: "附件"
    val thumb = if (isImage) decodeThumbnail(context, uri) else null
    // core 的 DraftAttachment 只带元数据（字节 / 缩略图留在 Android 侧，见 PendingAttachment）
    val draft = DraftAttachment(
        fileName = name,
        mimeType = mimeType,
        bytes = bytes.size.toLong(),
        localId = newLocalId(),
    )
    return PendingAttachment(
        draft = draft,
        payload = bytes,
        thumb = thumb,
    )
}

/** SAF 文档的显示名。 */
private fun queryName(resolver: android.content.ContentResolver, uri: Uri): String? = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && cursor.moveToFirst()) cursor.getString(idx) else null
    }
}.getOrNull()

/** SAF 文档的字节数（拿不到 → null，不阻塞选择）。 */
private fun querySize(resolver: android.content.ContentResolver, uri: Uri): Long? = runCatching {
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (idx >= 0 && cursor.moveToFirst()) {
            val size = cursor.getLong(idx)
            if (size >= 0) size else null
        } else {
            null
        }
    }
}.getOrNull()

/** 解码缩略图（长边 ≤ 240dp 级别，避免大图占内存）。 */
private fun decodeThumbnail(context: Context, uri: Uri, maxEdge: Int = 480): Bitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, bounds)
    }
    val opts = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxEdge)
    }
    context.contentResolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, opts)
    }
}.getOrNull()

/** 计算 inSampleSize（缩到不超过 maxEdge）。 */
private fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1
    var w = width
    var h = height
    while (w / 2 >= maxEdge && h / 2 >= maxEdge) {
        w /= 2
        h /= 2
        sample *= 2
    }
    return sample
}

/**
 * 附件 chips 行（输入框上方；图片缩略图 + 文件卡，均带删除按钮）。
 *
 * @param drafts 草稿附件
 * @param progress 上传进度（localId → 百分比）
 * @param enabled 是否可操作（上传中禁用删除）
 * @param onRemove 删除回调（localId）
 */
@Composable
fun AttachmentChips(
    drafts: List<PendingAttachment>,
    progress: Map<String, Int>,
    enabled: Boolean,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (drafts.isEmpty()) return
    val colors = PocketTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
        verticalArrangement = Arrangement.spacedBy(Sp.sp2),
    ) {
        for (item in drafts) {
            val pct = progress[item.localId]
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                modifier = Modifier
                    .background(colors.bgLayer2, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp2),
            ) {
                if (item.isImage && item.thumb != null) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .background(colors.bgLayer1, RoundedCornerShape(Radius.ctrl)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            bitmap = item.thumb!!.asImageBitmap(),
                            contentDescription = item.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.size(48.dp),
                        )
                    }
                } else {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .background(colors.bgLayer1, RoundedCornerShape(Radius.ctrl)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Default.Description,
                            contentDescription = null,
                            tint = colors.labelSecondary,
                        )
                    }
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = item.name,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.labelPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = pct?.let { "上传中 $it%" } ?: AttachmentPlan.formatAttachmentSize(item.bytes),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelTertiary,
                    )
                }
                IconButton(
                    onClick = { onRemove(item.localId) },
                    enabled = enabled,
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "移除附件",
                        tint = colors.labelSecondary,
                    )
                }
            }
        }
    }
}
