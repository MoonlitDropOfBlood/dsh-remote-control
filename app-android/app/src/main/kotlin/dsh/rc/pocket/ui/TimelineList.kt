/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 统一时间线渲染（契约 §5.7）。
 *
 * 数据源：**只有** store.entries（core 分组后的时间线），UI 不自己拼。
 *  - 消息条目（isProcess=false）：用户右对齐品牌蓝气泡 / 助手左对齐浅面卡片
 *  - 过程分组（isProcess=true）：连续 reasoning + step 归一组，组头动态标题，默认折叠
 *  - 图片（§5.10）：缩略图内联 data URI；thumb 为空 → 灰色占位框；点击拉大图
 *  - 文件（§5.11.4）：文件卡（图标 + 名称 + 大小）；手机端 v1.2.0 **不提供下载**
 *
 * 折叠态存**数据侧**：core 的 store 持有（TimelineEntry.groupExpanded /
 * TimelineStep.expanded / TimelineReasoning.expanded），UI 只读 + 调 store 切换——
 * LazyColumn 会回收复用节点，组件内状态会丢 / 串台。
 */
package dsh.rc.pocket.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.AttachmentPlan
import dsh.rc.core.FileRef
import dsh.rc.core.ProcessActivity
import dsh.rc.core.activityOfTool
import dsh.rc.core.composeProcessTitle
import dsh.rc.core.processActivityLabel
import dsh.rc.core.processLiveDetail
import dsh.rc.core.reasoningPreview
import dsh.rc.core.ImageRef
import dsh.rc.core.TimelineEntry
import dsh.rc.core.TimelineItem
import dsh.rc.core.TimelineMessage
import dsh.rc.core.TimelineReasoning
import dsh.rc.core.TimelineStep
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.ui.theme.clockTime
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.flow.collect
import dsh.rc.pocket.vm.memberExpanded
import java.util.Base64

/**
 * 时间线列表。
 *
 * @param entries core 分组后的时间线（含折叠态字段）
 * @param running 会话是否在跑（决定过程组头的运行态）
 * @param onToggleGroup 切换分组折叠态（写回 core 的 store）
 * @param onToggleItem 切换单条折叠态（写回 core 的 store）
 * @param onImageClick 点击缩略图（拉大图）
 */
@Composable
fun TimelineList(
    entries: List<TimelineEntry>,
    running: Boolean,
    onToggleGroup: (String) -> Unit,
    onToggleItem: (String) -> Unit,
    onImageClick: (ImageRef) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
) {
    val listState = rememberLazyListState()
    // 跟随底部标志：只有**用户手势滚动**才改变（程序化贴底、历史重建导致的跳变都不算），
    // 对齐 ArkTS 的 followBottom。
    // 为什么不能靠「当前可见项是否在末尾」判定：turn.end 后的历史刷新会把直播项换成
    // durable 项（key 变了）→ LazyColumn 跳回顶部 → 判定成「不在底部」→ 又不贴底，
    // 用户就看不到自己刚发的消息。
    val followBottom = remember { mutableStateOf(true) }
    val programmaticScroll = remember { mutableStateOf(false) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress to listState.firstVisibleItemIndex }
            .collect { (inProgress, _) ->
                if (!inProgress || programmaticScroll.value) return@collect
                val info = listState.layoutInfo
                val last = info.visibleItemsInfo.lastOrNull()
                followBottom.value = last == null || last.index >= info.totalItemsCount - 1
            }
    }
    // 贴底跟随（对齐 ArkTS 的 followBottom / scrollToBottom）：
    //  - 内容变多（新消息、流式增量变长）时，用户原本在底部就跟着滚到底部；
    //  - 用户主动上滑翻历史则**不打扰**（保留原位置）。
    // 乐观气泡先于宿主回包上屏（见 core/Store.kt 发送顺序铁律）→ 不贴底就看不见自己刚发的消息。
    val lastEntry = entries.lastOrNull()
    val lastTextLen = (lastEntry?.head as? TimelineMessage)?.text?.length ?: 0
    LaunchedEffect(entries.size, lastEntry?.key, lastTextLen) {
        if (entries.isEmpty()) return@LaunchedEffect
        // 等列表完成首次布局：totalItemsCount 有效后 scrollToItem 才不会索引越界
        var guard = 0
        while (listState.layoutInfo.totalItemsCount < entries.size && guard < 3) {
            withFrameNanos { }
            guard++
        }
        if (!followBottom.value) return@LaunchedEffect
        // 定位到最后一条再滚到底：scrollToItem 的 scrollOffset 参数会与下标相加溢出
        // （index * averageSize + offset → 负数 → 被夹到顶部），别传 Int.MAX_VALUE。
        programmaticScroll.value = true
        try {
            listState.scrollToItem(entries.lastIndex)
            listState.scrollBy(1_000_000f)
        } finally {
            programmaticScroll.value = false
        }
    }
    LazyColumn(
        state = listState,
        modifier = modifier.fillMaxWidth(),
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(Sp.sp1),
    ) {
        items(entries, key = { it.key }) { entry ->
            if (entry.isProcess) {
                ProcessGroupCard(
                    entry = entry,
                    running = running,
                    expanded = entry.groupExpanded,
                    onToggle = { onToggleGroup(entry.key) },
                    onToggleItem = onToggleItem,
                )
            } else {
                val head = entry.head
                if (head is TimelineMessage) {
                    MessageBubble(item = head, onImageClick = onImageClick)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 消息气泡
// ---------------------------------------------------------------------------

/**
 * 对话气泡：用户右对齐品牌蓝气泡（brand_fill + label_on_brand）；
 * 助手左对齐浅面卡片。
 *
 * 纯附件消息（正文为空）**不画空气泡**（契约 §5.11.4）。
 */
/** v1.3.1：唤醒消息的触发卡文案（对齐桌面端 message.trigger.* 词条）。 */
private fun triggerLabel(trigger: String): String = when (trigger) {
    "goal" -> "继续执行目标"
    "agent" -> "收到任务消息"
    "team" -> "收到团队消息"
    "subagent" -> "子任务状态更新"
    "webhook" -> "收到外部事件"
    "schedule" -> "自动化任务"
    "job" -> "后台任务状态更新"
    "plugin" -> "插件状态更新"
    else -> "收到执行请求"
}

@Composable
private fun MessageBubble(
    item: TimelineMessage,
    onImageClick: (ImageRef) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    // v1.3.1（契约 §5.3）：唤醒消息（Goal 轮次提示等）→ 触发卡，不画普通气泡、
    // 也不显示注入的原始正文（与 HarmonyOS 版、桌面端同口径）。
    if (item.trigger.isNotEmpty()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = modifier
                .fillMaxWidth()
                .padding(vertical = Sp.sp1),
        ) {
            Icon(
                imageVector = Icons.Default.Info,
                contentDescription = null,
                tint = colors.labelTertiary,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = triggerLabel(item.trigger),
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(start = Sp.sp2)
                    .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.pill))
                    .padding(horizontal = Sp.sp2, vertical = 2.dp),
            )
        }
        return
    }
    val isUser = item.role == "user"
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = Sp.sp1),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        if (isUser) {
            if (item.text.isNotEmpty()) {
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelOnBrand,
                    modifier = Modifier
                        .widthIn(max = 320.dp)
                        .background(colors.brandFill, RoundedCornerShape(Radius.bubble))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                )
            }
            // 图片在前、文件在后（契约 §5.11.4）
            if (item.images.isNotEmpty() || item.files.isNotEmpty()) {
                Column(
                    modifier = Modifier.padding(top = Sp.sp2),
                    verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                    horizontalAlignment = Alignment.End,
                ) {
                    for (image in item.images) {
                        ImageThumb(image = image, onClick = { onImageClick(image) })
                    }
                    for (file in item.files) {
                        FileCard(file = file)
                    }
                }
            }
        } else if (item.text.isNotEmpty() || item.images.isNotEmpty() ||
            item.files.isNotEmpty() || item.errorText.isNotEmpty()
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.bubble))
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2),
            ) {
                if (item.text.isNotEmpty()) {
                    // 助手正文走 markdown（三方库；与 HarmonyOS 版 @luvi/lv-markdown-in 同源思路）
                    MarkdownText(
                        text = item.text,
                        color = colors.labelPrimary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                if (item.errorText.isNotEmpty()) {
                    Text(
                        text = item.errorText,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.stateError,
                        modifier = Modifier.padding(top = if (item.text.isEmpty()) 0.dp else Sp.sp2),
                    )
                }
                if (item.images.isNotEmpty()) {
                    Column(
                        modifier = Modifier.padding(top = Sp.sp2),
                        verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                    ) {
                        for (image in item.images) {
                            ImageThumb(image = image, onClick = { onImageClick(image) })
                        }
                    }
                }
                if (item.files.isNotEmpty()) {
                    Column(
                        modifier = Modifier.padding(top = Sp.sp2),
                        verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                    ) {
                        for (file in item.files) {
                            FileCard(file = file, onCard = true)
                        }
                    }
                }
            }
        }
        Text(
            text = clockTime(item.ts),
            style = MaterialTheme.typography.labelSmall,
            color = colors.labelTertiary,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
}

/**
 * 图片缩略图（契约 §5.10）。
 *
 * thumb 内联 data URI → 直接渲染；thumb 为空（插件降质后仍超限）→ 灰色占位框。
 */
@Composable
private fun ImageThumb(
    image: ImageRef,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    val ratio = if (image.width > 0 && image.height > 0) {
        image.width.toFloat() / image.height.toFloat()
    } else {
        1f
    }
    val width = 220.dp
    val height = (width.value / ratio).coerceIn(90f, 320f).dp
    val bitmap = remember(image.imageId, image.thumb) { decodeDataUri(image.thumb) }
    if (bitmap == null) {
        // 占位框：插件降质后仍超限（thumb 为空）
        Box(
            modifier = modifier
                .size(width = 160.dp, height = 120.dp)
                .background(colors.bgLayer2, RoundedCornerShape(Radius.ctrl))
                .clickable { onClick() },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "图片",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
            )
        }
    } else {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = modifier
                .size(width = width, height = height)
                .background(colors.bgLayer2, RoundedCornerShape(Radius.ctrl))
                .clickable { onClick() },
        )
    }
}

/**
 * 文件卡（契约 §5.11.4）：图标 + 文件名 + 大小；手机端**不提供下载**。
 */
@Composable
private fun FileCard(
    file: FileRef,
    onCard: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
        modifier = modifier
            .widthIn(min = 168.dp, max = 260.dp)
            .background(
                if (onCard) colors.bgLayer2 else colors.bgLayer1,
                RoundedCornerShape(Radius.card),
            )
            .padding(horizontal = Sp.sp2, vertical = Sp.sp2),
    ) {
        Box(
            modifier = Modifier
                .size(34.dp)
                .background(colors.brandTint, RoundedCornerShape(Radius.ctrl)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Default.Description,
                contentDescription = null,
                tint = colors.brandLabel,
            )
        }
        Column {
            Text(
                text = file.name.ifEmpty { "附件" },
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = colors.labelPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = AttachmentPlan.formatAttachmentSize(file.bytes),
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 过程分组（思考 + 工具调用）
// ---------------------------------------------------------------------------

/**
 * 过程分组卡片：组头（动态标题 + 折叠箭头）+ 成员列表。
 *
 * 组头标题（桌面端 DSH 同源口径）：
 *  - 运行中：实时活动标题（「正在运行命令」）+ 「 · 细节」（命令 / 路径摘要）
 *  - 已结束：按活动类型合成的完成态标题（「已读取文件并搜索代码」）
 */
@Composable
private fun ProcessGroupCard(
    entry: TimelineEntry,
    running: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    onToggleItem: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    val members = entry.members
    // closed = 后续 message 已到来（DSH ProcessGroup.closed）→ 该组进入完成态
    val live = running && !entry.closed && members.lastOrNull()?.isRunning() == true
    val title = processGroupTitle(members, live)

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggle() }
                .padding(horizontal = Sp.sp1, vertical = Sp.sp2),
        ) {
            if (live) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = colors.brandFill,
                )
            } else {
                Icon(
                    imageVector = Icons.Default.Lightbulb,
                    contentDescription = null,
                    tint = colors.labelSecondary,
                    modifier = Modifier.size(16.dp),
                )
            }
            Text(
                text = title,
                style = MaterialTheme.typography.bodySmall,
                color = if (live) colors.labelPrimary else colors.labelSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.Default.ExpandMore,
                contentDescription = if (expanded) "收起" else "展开",
                tint = colors.labelTertiary,
                modifier = Modifier.size(18.dp),
            )
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = Sp.sp4, end = Sp.sp2, bottom = Sp.sp2),
                verticalArrangement = Arrangement.spacedBy(Sp.sp2),
            ) {
                for (member in members) {
                    when (member) {
                        is TimelineReasoning -> ReasoningCard(
                            item = member,
                            running = live,
                            expanded = memberExpanded(member),
                            onToggle = { onToggleItem(member.key) },
                        )

                        is TimelineStep -> StepCard(item = member)
                        else -> Unit
                    }
                }
            }
        }
    }
}

/** 思考块（独立折叠；弱化配色，与回答气泡区分）。 */
@Composable
private fun ReasoningCard(
    item: TimelineReasoning,
    running: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onToggle() }
                .padding(vertical = Sp.sp1),
        ) {
            Icon(
                imageVector = Icons.Default.Lightbulb,
                contentDescription = null,
                tint = colors.labelTertiary,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = "思考过程",
                style = MaterialTheme.typography.bodySmall,
                color = colors.labelSecondary,
            )
            if (!expanded) {
                val preview = reasoningPreview(item.text, running)
                if (preview.isNotEmpty()) {
                    Text(
                        text = " · $preview",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.labelTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            Icon(
                imageVector = Icons.Default.ExpandMore,
                contentDescription = if (expanded) "收起" else "展开",
                tint = colors.labelTertiary,
                modifier = Modifier.size(18.dp),
            )
        }
        if (expanded) {
            // 思考过程独立渲染（弱化配色，对齐 HarmonyOS 版的独立 markdown 控制器）
            MarkdownText(
                text = item.text,
                dim = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Sp.sp1),
            )
        }
    }
}

/** 工具调用卡（工具名 + 参数 + 结果 / 错误）。 */
@Composable
private fun StepCard(
    item: TimelineStep,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
            .padding(Sp.sp3),
        verticalArrangement = Arrangement.spacedBy(Sp.sp1),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = item.name.ifEmpty { "工具" },
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = colors.labelPrimary,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = stepStatusText(item.status),
                style = MaterialTheme.typography.labelSmall,
                color = when (item.status) {
                    "error" -> colors.stateError
                    "running" -> colors.brandLabel
                    else -> colors.stateSuccess
                },
            )
        }
        if (item.arguments.isNotEmpty()) {
            Text(
                text = item.arguments,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = colors.labelSecondary,
                maxLines = 6,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (item.errorText.isNotEmpty()) {
            Text(
                text = item.errorText,
                style = MaterialTheme.typography.labelSmall,
                color = colors.stateError,
            )
        } else if (item.resultText.isNotEmpty()) {
            HorizontalDivider(color = colors.borderL1)
            Text(
                text = item.resultText,
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
                maxLines = 6,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 过程活动分类与文案（**全部走 core 的 ProcessActivity**，中文文案与桌面端逐字一致）
// ---------------------------------------------------------------------------

/** 工具状态 → 短文案。 */
fun stepStatusText(status: String): String = when (status) {
    "running" -> "运行中"
    "error" -> "失败"
    else -> "完成"
}

/** 条目是否还在跑（工具步骤 status == running；思考块按会话运行态判断）。 */
fun TimelineItem.isRunning(): Boolean = when (this) {
    is TimelineStep -> status == "running"
    // core 的 TimelineReasoning 有 streaming 标志（契约 §5.3）
    is TimelineReasoning -> streaming
    else -> false
}

/**
 * 过程分组标题（core 的 ProcessActivity 口径，与桌面端 DSH 逐字一致）。
 *
 *  - 运行中：实时活动标题（「正在运行命令」）+ 「 · 细节」（core 从参数 JSON 里取）
 *  - 已结束：[composeProcessTitle] 按活动类型计数排序取前三类合成（「已读取文件并搜索代码」）
 *
 * @param members 分组成员
 * @param live 是否运行中
 */
fun processGroupTitle(members: List<TimelineItem>, live: Boolean): String {
    if (members.isEmpty()) return processActivityLabel(ProcessActivity.thinking, live)
    if (live) {
        val last = members.last()
        val label = processActivityLabel(activityOfMember(last), true)
        val detail = when (last) {
            is TimelineStep -> processLiveDetail(last.arguments)
            is TimelineReasoning -> reasoningPreview(last.text, true)
            else -> ""
        }
        return if (detail.isEmpty()) label else "$label · $detail"
    }
    // 已结束：core 负责排序 + 合成（「等」后缀、共享「已」前缀都在 core 里）
    return composeProcessTitle(members.map { activityOfMember(it) })
}

/** 分组成员 → 活动种类（思考块 = thinking）。 */
private fun activityOfMember(item: TimelineItem): ProcessActivity = when (item) {
    is TimelineReasoning -> ProcessActivity.thinking
    is TimelineStep -> activityOfTool(item.name)
    else -> ProcessActivity.tools
}

// ---------------------------------------------------------------------------
// data URI 解码
// ---------------------------------------------------------------------------

/**
 * data URI（`data:<mime>;base64,<payload>`）→ Bitmap。
 *
 * 契约 §5.10：缩略图内联在 wire 里，手机端没有图片 URL 通路。
 */
fun decodeDataUri(dataUri: String): android.graphics.Bitmap? {
    if (dataUri.isEmpty()) return null
    val comma = dataUri.indexOf(',')
    if (comma < 0) return null
    val meta = dataUri.substring(0, comma)
    val payload = dataUri.substring(comma + 1)
    val bytes = try {
        if (meta.contains("base64")) {
            Base64.getDecoder().decode(payload)
        } else {
            payload.toByteArray()
        }
    } catch (e: IllegalArgumentException) {
        return null
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}
