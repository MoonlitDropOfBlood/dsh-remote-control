/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— core 纯函数单测（不需要设备 / 模拟器）。
 *
 * 覆盖三组口径（对齐 HarmonyOS 版的 node 回归脚本）：
 *  - 分组规则：app/entry/src/main/ets/model/sessionstore.ets 的 groupTimeline()
 *  - 附件分块边界：app/entry/src/main/ets/model/attachment-plan.ts
 *  - 过程标题合成：app/entry/src/main/ets/model/process-activity.ts
 * 外加直播/持久历史对账（timeline-reconcile.ts）与合并历史（mergeHistory）。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 会话仓的纯函数行为（分组 / 合并 / 对账）。 */
class StoreTest {

    // ---- 测试夹具 ----

    private fun message(
        id: String,
        role: String = "assistant",
        text: String = "",
        seq: Long = -1L,
        ts: Long = 1_700_000_000_000L,
        images: List<ImageRef> = emptyList(),
        files: List<FileRef> = emptyList(),
        streaming: Boolean = false,
        local: Boolean = false
    ) = TimelineMessage(
        key = id,
        id = id,
        role = role,
        text = text,
        ts = ts,
        seq = seq,
        images = images,
        files = files,
        streaming = streaming,
        local = local
    )

    private fun step(
        callId: String,
        name: String = "bash",
        status: String = "running",
        seq: Long = -1L,
        expanded: Boolean = false
    ) = TimelineStep(
        key = "s$callId",
        callId = callId,
        name = name,
        arguments = "{}",
        status = status,
        resultText = "",
        errorText = "",
        ts = 1_700_000_000_000L,
        seq = seq,
        expanded = expanded
    )

    private fun reasoning(id: String, text: String = "", seq: Long = -1L) =
        TimelineReasoning(key = id, id = id, text = text, ts = 1_700_000_000_000L, seq = seq)

    private fun chatMessage(
        id: String,
        role: String = "assistant",
        text: String = "",
        seq: Long = 1L,
        images: List<ImageRef> = emptyList(),
        files: List<FileRef> = emptyList()
    ) = ChatMessage(
        id = id,
        role = role,
        text = text,
        ts = 1_700_000_000_000L,
        seq = seq,
        images = images,
        files = files
    )

    private fun stepRecord(
        callId: String,
        name: String = "bash",
        status: String = "ok",
        seq: Long = 2L
    ) = StepRecord(
        seq = seq,
        callId = callId,
        name = name,
        arguments = "{}",
        status = status,
        resultText = "ok",
        errorText = "",
        ts = 1_700_000_000_000L,
        turn = 1,
        step = 1
    )

    // =================================================================================
    // 1) 分组规则（ArkTS groupTimeline）
    // =================================================================================

    @Test
    fun `连续的思考与步骤归为一组`() {
        val items = listOf(
            reasoning("r1", "想一下"),
            step("c1"),
            step("c2"),
            message("m1", role = "user", text = "你好")
        )
        val entries = groupTimeline(items)
        assertEquals(2, entries.size, "一个过程组 + 一条消息")
        val group = entries[0]
        assertTrue(group.isProcess, "首段是过程组")
        assertEquals(GROUP_KEY_PREFIX + "r1", group.key, "组 key = p:<首条目 key>")
        assertEquals(3, group.members.size, "组内 3 个成员")
        assertTrue(group.closed, "组后面跟了消息 → 立即关闭（DSH flush(true)）")
        assertFalse(entries[1].isProcess, "消息是单项")
        assertTrue(entries[1].members.isEmpty(), "消息没有成员")
        assertEquals("m1", entries[1].key, "消息条目 key = 自身 key")
    }

    @Test
    fun `消息打断分组`() {
        val items = listOf(
            step("c1"),
            message("m1", role = "user", text = "插话"),
            step("c2")
        )
        val entries = groupTimeline(items)
        assertEquals(3, entries.size, "步骤 / 消息 / 步骤 → 三段")
        assertTrue(entries[0].isProcess, "第一段是组")
        assertTrue(entries[0].closed, "后面跟了消息 → 旧组立即关闭（DSH flush(true)）")
        assertFalse(entries[1].isProcess, "中间是消息")
        assertTrue(entries[2].isProcess, "第三段是新组")
        assertFalse(entries[2].closed, "后面没有消息 → 未关闭")
        assertEquals(GROUP_KEY_PREFIX + "sc2", entries[2].key, "新组 key 用自己的首条目")
    }

    @Test
    fun `组 key 不含成员数`() {
        val before = groupTimeline(listOf(step("c1")))
        val after = groupTimeline(listOf(step("c1"), step("c2"), step("c3")))
        assertEquals(before[0].key, after[0].key, "新增成员不换 key")
        assertEquals(1, before[0].members.size)
        assertEquals(3, after[0].members.size)
    }

    @Test
    fun `分组默认折叠`() {
        val entries = groupTimeline(listOf(step("c1")))
        assertFalse(entries[0].groupExpanded, "默认折叠")
        val expanded = groupTimeline(listOf(step("c1")), setOf(entries[0].key))
        assertTrue(expanded[0].groupExpanded, "折叠态可由数据侧给入")
    }

    @Test
    fun `消息条目保留自身身份`() {
        val entries = groupTimeline(listOf(message("m1", role = "user", text = "hi")))
        assertEquals("m1", entries[0].key)
        assertEquals("m1", entries[0].head.key)
    }

    // =================================================================================
    // 2) 合并历史（ArkTS mergeHistory）
    // =================================================================================

    @Test
    fun `durable 按 seq 升序在前直播项在后`() {
        val old = listOf(message("live-a", text = "流式", streaming = true))
        val page = listOf(
            chatMessage("m2", role = "user", text = "第一条", seq = 1L),
            chatMessage("m1", role = "assistant", text = "第二条", seq = 2L)
        )
        val merged = mergeTimelineItems(old, page, emptyList(), false, false, false)
        assertEquals(3, merged.size)
        assertEquals("m2", merged[0].key, "durable 在前，按 seq 升序")
        assertEquals("m1", merged[1].key)
        assertEquals("live-a", merged[2].key, "直播项永远在最后")
    }

    @Test
    fun `同 key 复用旧实例并保留折叠态`() {
        val old = listOf(step("c1", status = "running", expanded = true))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = listOf(stepRecord("c1", status = "ok")),
            prepend = false,
            dropFinalized = false,
            finalizeStreaming = false
        )
        assertEquals(1, merged.size, "直播步骤被持久步骤覆盖 → 只剩一条")
        val s = merged[0] as TimelineStep
        assertEquals("sc1", s.key, "同 key（s+callId）")
        assertEquals("ok", s.status, "内容取持久副本")
        assertTrue(s.expanded, "折叠态取旧实例（UI 展开过的不能丢）")
    }

    @Test
    fun `直播文本副本被新增的 durable 覆盖`() {
        val old = listOf(message("live-a", text = "同样的正文", streaming = false))
        val page = listOf(chatMessage("m1", role = "assistant", text = "同样的正文", seq = 5L))
        val merged = mergeTimelineItems(old, page, emptyList(), false, false, false)
        assertEquals(1, merged.size, "同一句话不显示两遍")
        assertEquals("m1", merged[0].key)
    }

    @Test
    fun `直播步骤按 callId 去重`() {
        val old = listOf(step("c1"))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = listOf(stepRecord("c1")),
            prepend = false,
            dropFinalized = false,
            finalizeStreaming = false
        )
        assertEquals(1, merged.size, "同一调用不显示两遍")
    }

    @Test
    fun `向前翻页时旧页在最前`() {
        val old = listOf(message("m9", seq = 9L))
        val page = listOf(chatMessage("m1", seq = 1L))
        val merged = mergeTimelineItems(old, page, emptyList(), true, false, false)
        assertEquals("m1", merged[0].key, "prepend → 旧页插到最前")
        assertEquals("m9", merged[1].key)
    }

    @Test
    fun `宿主空闲时定稿残留的流式块`() {
        val old = listOf(message("live-a", text = "半句", streaming = true))
        val merged = mergeTimelineItems(old, emptyList(), emptyList(), false, false, true)
        assertFalse((merged[0] as TimelineMessage).streaming, "拉历史后一律定稿（turn.end 可能丢失）")
    }

    // =================================================================================
    // 3) 直播 / 持久历史对账（timeline-reconcile.ts）
    // =================================================================================

    @Test
    fun `附件 only 消息按数量一一消费`() {
        val durable = listOf(DurableAttachments("user", "", 1, 1))
        val live = listOf(
            LiveAttachments("local1", "user", "", 1, 1),
            LiveAttachments("local2", "user", "", 1, 1)
        )
        val covered = collectCoveredLiveAttachmentIds(durable, live)
        assertEquals(setOf("local1"), covered, "一条 durable 只消费一条 live（先到先配）")
    }

    @Test
    fun `带正文的 durable 不走附件计数去重`() {
        val durable = listOf(DurableAttachments("user", "hello", 1, 0))
        val live = listOf(LiveAttachments("x", "user", "", 1, 0))
        assertTrue(collectCoveredLiveAttachmentIds(durable, live).isEmpty())
    }

    @Test
    fun `附件数量不同不得误删`() {
        val durable = listOf(DurableAttachments("user", "", 1, 0))
        val live = listOf(LiveAttachments("x", "user", "", 2, 0))
        assertTrue(collectCoveredLiveAttachmentIds(durable, live).isEmpty())
    }

    @Test
    fun `assistant 交付物图片不走附件计数去重`() {
        val durable = listOf(DurableAttachments("assistant", "", 1, 0))
        val live = listOf(LiveAttachments("x", "assistant", "", 1, 0))
        assertTrue(collectCoveredLiveAttachmentIds(durable, live).isEmpty())
    }

    @Test
    fun `直播文本按 role 与文本精确配对`() {
        val durable = listOf(DurableText("assistant", "正文"))
        val live = listOf(LiveText("l1", "assistant", "正文", streaming = false))
        assertEquals(setOf("l1"), collectCoveredLiveTextIds(durable, live, false))
    }

    @Test
    fun `空闲时权威历史接管已完成的直播文本`() {
        val durable = listOf(DurableText("assistant", "别的正文"))
        val live = listOf(LiveText("l1", "assistant", "旧正文", streaming = false))
        assertEquals(
            setOf("l1"),
            collectCoveredLiveTextIds(durable, live, true),
            "dropFinalized → 已完成的 assistant 副本被接管"
        )
    }

    @Test
    fun `仍在流式的直播文本不被接管`() {
        val durable = listOf(DurableText("assistant", "别的正文"))
        val live = listOf(LiveText("l1", "assistant", "旧正文", streaming = true))
        assertTrue(collectCoveredLiveTextIds(durable, live, true).isEmpty())
    }

    // =================================================================================
    // 4) 附件分块边界（attachment-plan.ts）
    // =================================================================================

    @Test
    fun `空附件没有分块`() {
        assertTrue(AttachmentPlan.planChunks(0, 256 * 1024).isEmpty())
        assertEquals(0, AttachmentPlan.chunkCount(0, 256 * 1024))
    }

    @Test
    fun `单字节也得分一块`() {
        val chunks = AttachmentPlan.planChunks(1, 256 * 1024)
        assertEquals(1, chunks.size)
        assertEquals(0..0, chunks[0])
    }

    @Test
    fun `正好一块`() {
        val chunks = AttachmentPlan.planChunks(262144, 262144)
        assertEquals(1, chunks.size)
        assertEquals(0..262143, chunks[0])
    }

    @Test
    fun `最后一块可短且精确覆盖`() {
        val chunks = AttachmentPlan.planChunks(262145, 262144)
        assertEquals(2, chunks.size)
        assertEquals(0..262143, chunks[0])
        assertEquals(262144..262144, chunks[1], "闭区间：起点 262144、终点 262144")
        val total = chunks.sumOf { it.last - it.first + 1 }
        assertEquals(262145L, total.toLong(), "分块长度之和必须等于原字节数")
    }

    @Test
    fun `多分块逐段相接不重不漏`() {
        val size = 262144L * 3 + 7
        val chunks = AttachmentPlan.planChunks(size, 262144)
        assertEquals(4, chunks.size)
        assertEquals(AttachmentPlan.chunkCount(size, 262144), chunks.size)
        var expectStart = 0
        for (c in chunks) {
            assertEquals(expectStart, c.first, "块起点连续")
            expectStart = c.last + 1
        }
        assertEquals(size.toInt(), expectStart, "覆盖到最后一个字节")
    }

    @Test
    fun `块大小 clamp`() {
        assertEquals(AttachmentPlan.DEFAULT_CHUNK_BYTES, AttachmentPlan.clampChunkBytes(0))
        assertEquals(AttachmentPlan.DEFAULT_CHUNK_BYTES, AttachmentPlan.clampChunkBytes(-1))
        assertEquals(64 * 1024, AttachmentPlan.clampChunkBytes(64 * 1024))
        assertEquals(AttachmentPlan.MAX_CHUNK_BYTES, AttachmentPlan.clampChunkBytes(AttachmentPlan.MAX_CHUNK_BYTES))
        assertEquals(
            AttachmentPlan.MAX_CHUNK_BYTES,
            AttachmentPlan.clampChunkBytes(8 * 1024 * 1024),
            "客户端不得用超过 256KiB 的块（中继单帧 1MiB 硬约束）"
        )
        assertEquals(256 * 1024, AttachmentPlan.MAX_CHUNK_BYTES)
    }

    @Test
    fun `非法块大小退回缺省`() {
        val chunks = AttachmentPlan.planChunks(300, 0)
        assertEquals(1, chunks.size)
        assertEquals(0..299, chunks[0])
    }

    @Test
    fun `字节数格式化`() {
        assertEquals("0 B", AttachmentPlan.formatAttachmentSize(0))
        assertEquals("0 B", AttachmentPlan.formatAttachmentSize(-5))
        assertEquals("512 B", AttachmentPlan.formatAttachmentSize(512))
        assertEquals("1.0 KB", AttachmentPlan.formatAttachmentSize(1024))
        assertEquals("1.5 KB", AttachmentPlan.formatAttachmentSize(1536))
        assertEquals("12.1 KB", AttachmentPlan.formatAttachmentSize(12345))
        assertEquals("1.0 MB", AttachmentPlan.formatAttachmentSize(1048576))
        assertEquals("5.0 MB", AttachmentPlan.formatAttachmentSize(5 * 1024 * 1024))
        assertEquals("1.0 GB", AttachmentPlan.formatAttachmentSize(1024L * 1024 * 1024))
    }

    @Test
    fun `文件名净化`() {
        assertEquals("IMG_0001.jpg", AttachmentPlan.attachmentFileName("file://media/Photo/3/IMG_0001.jpg"))
        assertEquals(
            "report v2.pdf",
            AttachmentPlan.attachmentFileName("file://docs/storage/Users/currentUser/Documents/report%20v2.pdf"),
            "文件 URI 必须 percent-decode"
        )
        assertEquals("a.pdf", AttachmentPlan.attachmentFileName("file://docs/storage/x/a.pdf?x=1#frag"))
        assertEquals("attachment", AttachmentPlan.attachmentFileName(""))
        assertEquals("attachment", AttachmentPlan.attachmentFileName(null))
        assertEquals("attachment", AttachmentPlan.attachmentFileName("file://docs/storage/x/"))
        assertEquals(180, AttachmentPlan.attachmentFileName("file://docs/x/" + "a".repeat(300)).length)
    }

    @Test
    fun `能力目录缺省即不支持`() {
        assertNull(AttachmentPlan.normalizeAttachmentCaps(null), "缺省 attachments → null（隐藏入口）")
        val off = AttachmentPlan.normalizeAttachmentCaps(
            AttachmentCaps(false, 0, 0, 0, 0, emptyList())
        )
        assertNotNull(off)
        assertFalse(off!!.supported)
        assertEquals(AttachmentPlan.DEFAULT_MAX_COUNT, off.maxCount)
        assertEquals(AttachmentPlan.DEFAULT_MAX_ITEM_BYTES, off.maxItemBytes)
        assertEquals(AttachmentPlan.DEFAULT_MAX_MESSAGE_BYTES, off.maxMessageBytes)
        assertEquals(AttachmentPlan.DEFAULT_CHUNK_BYTES, off.chunkBytes)
        assertEquals(AttachmentPlan.DEFAULT_IMAGE_MEDIA_TYPES, off.imageMediaTypes)
    }

    @Test
    fun `能力目录超限要 clamp`() {
        val on = AttachmentPlan.normalizeAttachmentCaps(
            AttachmentCaps(true, 3, 1024, 2048, 4 * 1024 * 1024, listOf("image/jpeg"))
        )
        assertNotNull(on)
        assertTrue(on!!.supported)
        assertEquals(3, on.maxCount)
        assertEquals(1024L, on.maxItemBytes)
        assertEquals(2048L, on.maxMessageBytes)
        assertEquals(AttachmentPlan.MAX_CHUNK_BYTES, on.chunkBytes, "宿主 chunkBytes 超限也要夹到 256KiB")
        assertEquals(listOf("image/jpeg"), on.imageMediaTypes)
    }

    @Test
    fun `图片媒体类型比较不区分大小写`() {
        assertTrue(AttachmentPlan.isAcceptedImageType("image/jpeg", listOf("image/png", "image/JPEG")))
        assertFalse(AttachmentPlan.isAcceptedImageType("image/heic", listOf("image/jpeg", "image/png")))
        assertFalse(AttachmentPlan.isAcceptedImageType("", listOf("image/jpeg")))
    }

    @Test
    fun `草稿上限校验`() {
        val caps = AttachmentPlan.normalizeAttachmentCaps(
            AttachmentCaps(true, 9, 20L * 1024 * 1024, 40L * 1024 * 1024, 262144, emptyList())
        )
        assertNull(
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("a.png", "image/png", 1024, "l1")),
                caps
            ),
            "正常附件通过"
        )
        assertEquals(
            "当前主机不支持附件",
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("a.png", "image/png", 1024, "l1")),
                null
            )
        )
        assertEquals(
            "文件缺少文件名",
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("", "application/pdf", 10, "l1")),
                caps
            )
        )
        assertEquals(
            "不支持的图片格式：image/heic",
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("a.heic", "image/heic", 10, "l1")),
                caps
            ),
            "宿主不接受的图片格式必须拒绝（转码在 ingest 层做）"
        )
        assertEquals(
            "附件为空",
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("a", "application/pdf", 0, "l1")),
                caps
            )
        )
        assertEquals(
            "单个附件超过上限 20.0 MB",
            AttachmentPlan.checkAttachmentDraft(
                listOf(DraftAttachment("big.bin", "application/octet-stream", 20L * 1024 * 1024 + 1, "l1")),
                caps
            )
        )
        val many = (0 until 9).map { DraftAttachment("f$it", "application/pdf", 1, "l$it") }
        assertEquals(
            "每条消息最多 9 个附件",
            AttachmentPlan.checkAttachmentDraft(many + DraftAttachment("x", "application/pdf", 1, "lx"), caps)
        )
        val small = AttachmentPlan.normalizeAttachmentCaps(
            AttachmentCaps(true, 9, 1024, 1000, 262144, emptyList())
        )
        assertEquals(
            "附件总大小超过上限 1000 B",
            AttachmentPlan.checkAttachmentDraft(
                listOf(
                    DraftAttachment("a", "application/pdf", 600, "l1"),
                    DraftAttachment("b", "application/pdf", 600, "l2")
                ),
                small
            )
        )
    }

    @Test
    fun `草稿按图片与文件分派 wire kind`() {
        assertEquals(AttachmentKind.IMAGE, DraftAttachment("a.png", "image/png", 1, "l1").kind)
        assertEquals(AttachmentKind.FILE, DraftAttachment("a.pdf", "application/pdf", 1, "l1").kind)
        assertEquals("local:l1", DraftAttachment("a.png", "image/png", 1, "l1").localImageId)
    }
}

/** 过程分组的活动分类与动态标题（对齐桌面端 DSH）。 */
class ProcessActivityTest {

    @Test
    fun `工具名映射到活动种类`() {
        assertEquals(ProcessActivity.read, activityOfTool("read"))
        assertEquals(ProcessActivity.readImage, activityOfTool("read_image"))
        assertEquals(ProcessActivity.search, activityOfTool("grep"))
        assertEquals(ProcessActivity.search, activityOfTool("glob"))
        assertEquals(ProcessActivity.search, activityOfTool("memory_inspect"))
        assertEquals(ProcessActivity.write, activityOfTool("write"))
        assertEquals(ProcessActivity.edit, activityOfTool("edit"))
        assertEquals(ProcessActivity.edit, activityOfTool("apply_patch"))
        assertEquals(ProcessActivity.commands, activityOfTool("bash"))
        assertEquals(ProcessActivity.commands, activityOfTool("pwsh"))
        assertEquals(ProcessActivity.commands, activityOfTool("terminal_session"))
        assertEquals(ProcessActivity.code, activityOfTool("run_code"))
        assertEquals(ProcessActivity.webSearch, activityOfTool("web_search"))
        assertEquals(ProcessActivity.webFetch, activityOfTool("web_fetch"))
        assertEquals(ProcessActivity.subagents, activityOfTool("subagent"))
        assertEquals(ProcessActivity.subagents, activityOfTool("subagent_wait"))
        assertEquals(ProcessActivity.plan, activityOfTool("todo_write"))
        assertEquals(ProcessActivity.plan, activityOfTool("create_goal"))
        assertEquals(ProcessActivity.questions, activityOfTool("ask_user_question"))
        assertEquals(ProcessActivity.tools, activityOfTool("some_unknown_tool"))
    }

    @Test
    fun `活动文案逐字对齐桌面端`() {
        assertEquals("正在读取文件", activityLabel(ProcessActivity.read, true))
        assertEquals("已读取文件", activityLabel(ProcessActivity.read, false))
        assertEquals("正在分析请求", activityLabel(ProcessActivity.thinking, true))
        assertEquals("已完成分析", activityLabel(ProcessActivity.thinking, false))
        assertEquals("正在运行命令", activityLabel(ProcessActivity.commands, true))
        assertEquals("修改了文件", activityLabel(ProcessActivity.edit, false))
    }

    @Test
    fun `标题合成规则`() {
        assertEquals("已完成分析", composeProcessTitle(emptyList()), "0 类 → 已完成分析")
        assertEquals("已读取文件", composeProcessTitle(listOf(ProcessActivity.read)), "1 类")
        assertEquals(
            "已读取文件并搜索代码",
            composeProcessTitle(listOf(ProcessActivity.read, ProcessActivity.search)),
            "2 类（首段带「已」→ 第二段去掉「已」）"
        )
        assertEquals(
            "执行了命令并已完成分析",
            composeProcessTitle(listOf(ProcessActivity.commands, ProcessActivity.thinking)),
            "2 类（首段不带「已」→ 保留第二段「已」）"
        )
        assertEquals(
            "已读取文件，已搜索代码，执行了命令",
            composeProcessTitle(listOf(ProcessActivity.read, ProcessActivity.search, ProcessActivity.commands)),
            "3 类用「，」连接（不剥「已」）"
        )
        assertEquals(
            "已读取文件，已搜索代码，执行了命令等",
            composeProcessTitle(
                listOf(
                    ProcessActivity.read,
                    ProcessActivity.search,
                    ProcessActivity.commands,
                    ProcessActivity.edit
                )
            ),
            "4 类以上加「等」"
        )
    }

    @Test
    fun `活动按出现次数排序`() {
        val ranked = rankProcessActivities(
            listOf(ProcessActivity.commands, ProcessActivity.commands, ProcessActivity.read)
        )
        assertEquals(listOf("commands:2", "read:1"), ranked.map { "${it.kind}:${it.count}" })
    }

    @Test
    fun `思考摘要取最近写完段落的首行`() {
        assertEquals(
            "第二段第一行",
            latestParagraphFirstLine("第一段第一行\n第一段第二行\n\n第二段第一行\n第二段第二行")
        )
        assertEquals("", latestParagraphFirstLine("只有一行还没换行"), "首行没写完 → 空")
        assertEquals("第一行", latestParagraphFirstLine("第一行\n"), "结尾换行 → 首行算写完")
        assertEquals("加粗 的第一行", reasoningPreview("**加粗** 的第一行\n第二行"), "去掉 ** 标记")
    }

    @Test
    fun `流式思考摘要取最近段落`() {
        assertEquals(
            "第二段第一行",
            reasoningPreview("第一段第一行\n第一段第二行\n\n第二段第一行\n第二段第二行", true)
        )
    }

    @Test
    fun `运行中细节从工具参数里挑一句`() {
        assertEquals("npm test", processLiveDetail("{\"command\":\"npm test\"}"))
        assertEquals("读取配置", processLiveDetail("{\"description\":\"读取配置\",\"path\":\"/a/b\"}"))
        assertEquals("读取配置", processLiveDetail("{\"description\":\"读取配置\",\"file_path\":\"/a/b\"}"))
        assertEquals("/a/b/c.md", processLiveDetail("{\"file_path\":\"/a/b/c.md\"}"))
        assertEquals("不是 JSON 的一段话", processLiveDetail("不是 JSON 的一段话"), "非 JSON 兜底")
        assertTrue(
            processLiveDetail("{\"command\":\"" + "x".repeat(80) + "\"}", 20).endsWith("…"),
            "超长截断"
        )
    }

    @Test
    fun `运行中细节可直接传工作步骤`() {
        val s = TimelineStep(
            key = "sc1",
            callId = "c1",
            name = "bash",
            arguments = "{\"command\":\"ls -la\"}",
            status = "running",
            resultText = "",
            errorText = "",
            ts = 0L
        )
        assertEquals("ls -la", processLiveDetail(s))
    }
}

