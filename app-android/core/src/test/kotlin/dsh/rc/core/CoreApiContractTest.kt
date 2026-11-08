/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 公共面契约自检（CORE_API.md §2.1–§2.4）。
 *
 * 这个用例的价值在**编译期**：只要下面的显式类型标注还能编过，就说明
 * 仓库的公共面与契约一致（签名漂移会直接编译失败，而不是运行时才发现）。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CoreApiContractTest {

    @Test
    fun `会话仓公共面与 CORE_API 一致`() {
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        try {
            val store = SessionStore(DshrcLink(scope), scope)

            // 初始没有历史错误、也不在加载中（后续的离线重试会写入该会话的错误）。
            assertNull(store.historyError.value, "初始没有历史错误")
            assertFalse(store.historyLoading.value, "初始不在加载历史")
            assertEquals("", store.historyErrorFor("sess-1"), "别的会话读不到历史错误")

            // ---- 会话列表 ----
            val sessions: StateFlow<List<SessionSummary>> = store.sessions
            val archivedSessionIds: StateFlow<Set<String>> = store.archivedSessionIds
            val linkState: StateFlow<LinkState> = store.linkState
            val hostInfo: StateFlow<HostInfo?> = store.hostInfo
            val busyEnter: StateFlow<String> = store.busyEnter

            // ---- 当前会话 ----
            val activeSessionId: StateFlow<String?> = store.activeSessionId
            val timeline: StateFlow<List<TimelineItem>> = store.timeline
            val entries: StateFlow<List<TimelineEntry>> = store.entries
            val queueItems: StateFlow<List<QueueItem>> = store.queueItems
            val subagents: StateFlow<List<SubagentInfo>> = store.subagents
            val sessionModel: StateFlow<ModelSelection?> = store.sessionModel
            val sessionPermission: StateFlow<String?> = store.sessionPermission
            val capabilities: StateFlow<Capabilities?> = store.capabilities
            val attachmentCaps: StateFlow<AttachmentCaps?> = store.attachmentCaps

            // ---- 审批 / 提问 ----
            val approvals: StateFlow<List<ApprovalRequest>> = store.approvals
            val questions: StateFlow<List<QuestionRequest>> = store.questions

            // ---- 历史错误归属 + 加载状态（2026-11-08） ----
            val historyError: StateFlow<SessionHistoryError?> = store.historyError
            val historyLoading: StateFlow<Boolean> = store.historyLoading
            val historyErrorFor: (String) -> String = { sid -> store.historyErrorFor(sid) }
            val retryHistory: (String) -> Unit = { sid -> store.retryHistory(sid) }

            // ---- 操作（签名逐条对齐） ----
            val loadSessions: suspend () -> Unit = { store.loadSessions() }
            val openSession: suspend (String) -> Unit = { store.openSession(it) }
            val closeSession: suspend () -> Unit = { store.closeSession() }
            val sendPrompt: suspend (String, String, List<String>) -> Boolean =
                { sid, text, uploads -> store.sendPrompt(sid, text, uploads) }
            val cancelTurn: suspend (String) -> Boolean = { store.cancelTurn(it) }
            val createSession: suspend (String, String?, String?, String?, ModelSelection?) -> CreateResult =
                { t, preset, perm, cwd, model -> store.createSession(t, preset, perm, cwd, model) }
            val setArchived: suspend (String, Boolean) -> Boolean = { sid, a -> store.setArchived(sid, a) }
            val selectModel: suspend (String, ModelSelection) -> ModelSelection =
                { sid, m -> store.selectModel(sid, m) }
            val selectPermission: suspend (String, String) -> String =
                { sid, p -> store.selectPermission(sid, p) }
            val answerApproval: suspend (String, String, String) -> Boolean =
                { askId, decision, note -> store.answerApproval(askId, decision, note) }
            val answerQuestion: suspend (String, Map<String, String>, String) -> Boolean =
                { askId, answers, freeText -> store.answerQuestion(askId, answers, freeText) }
            val fetchImage: suspend (String, Int) -> FetchedImage = { id, edge -> store.fetchImage(id, edge) }
            val loadQueue: suspend (String) -> Unit = { store.loadQueue(it) }
            val subagentPrompt: suspend (String, String, String) -> Boolean =
                { p, c, t -> store.subagentPrompt(p, c, t) }
            val subagentCancel: suspend (String, String) -> Boolean =
                { p, c -> store.subagentCancel(p, c) }
            val onLinkOnline: suspend () -> Unit = { store.onLinkOnline() }
            val loadHistory: suspend (String, Long?, Int) -> HistoryPage =
                { sid, before, max -> store.loadHistory(sid, before, max) }

            // 默认参数也必须存在（调用方按契约写法编译得过）。
            // 链路没上线 → 运行时抛错属正常，这里只验证**签名**。
            runBlocking {
                runCatching { store.sendPrompt("s", "t") }
                runCatching { store.sendPrompt("s", "t", listOf("u")) }
                runCatching { store.answerApproval("a", "approved") }
                runCatching { store.answerQuestion("a", mapOf("k" to "v")) }
                runCatching { store.fetchImage("img") }
                runCatching { store.loadHistory("s") }
            }

            // 初始状态：空列表 / null（宿主还没连上）
            assertTrue(sessions.value.isEmpty())
            assertTrue(archivedSessionIds.value.isEmpty())
            assertEquals(LinkState.IDLE, linkState.value)
            assertNull(hostInfo.value)
            assertEquals(Protocol.MODE_QUEUE, busyEnter.value)
            assertNull(activeSessionId.value)
            assertTrue(timeline.value.isEmpty())
            assertTrue(entries.value.isEmpty())
            assertTrue(queueItems.value.isEmpty())
            assertTrue(subagents.value.isEmpty())
            assertNull(sessionModel.value)
            assertNull(sessionPermission.value)
            assertNull(capabilities.value)
            assertNull(attachmentCaps.value)
            assertTrue(approvals.value.isEmpty())
            assertTrue(questions.value.isEmpty())
            assertNotNull(retryHistory)

            // 引用一次，避免「未使用的局部变量」告警
            assertNotNull(loadSessions)
            assertNotNull(openSession)
            assertNotNull(closeSession)
            assertNotNull(sendPrompt)
            assertNotNull(cancelTurn)
            assertNotNull(createSession)
            assertNotNull(setArchived)
            assertNotNull(selectModel)
            assertNotNull(selectPermission)
            assertNotNull(answerApproval)
            assertNotNull(answerQuestion)
            assertNotNull(fetchImage)
            assertNotNull(loadQueue)
            assertNotNull(subagentPrompt)
            assertNotNull(subagentCancel)
            assertNotNull(onLinkOnline)
            assertNotNull(loadHistory)

            store.close()
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `附件规划公共面与 CORE_API 一致`() {
        val clamp: (Int) -> Int = { AttachmentPlan.clampChunkBytes(it) }
        val plan: (Long, Int) -> List<IntRange> = { t, c -> AttachmentPlan.planChunks(t, c) }
        val fileName: (String?) -> String = { AttachmentPlan.attachmentFileName(it) }
        val size: (Long) -> String = { AttachmentPlan.formatAttachmentSize(it) }
        val normalize: (AttachmentCaps?) -> AttachmentCaps? = { AttachmentPlan.normalizeAttachmentCaps(it) }
        val check: (List<DraftAttachment>, AttachmentCaps?) -> String? =
            { items, caps -> AttachmentPlan.checkAttachmentDraft(items, caps) }

        assertEquals(256 * 1024, AttachmentPlan.DEFAULT_CHUNK_BYTES)
        assertNotNull(clamp)
        assertNotNull(plan)
        assertNotNull(fileName)
        assertNotNull(size)
        assertNotNull(normalize)
        assertNotNull(check)
    }

    @Test
    fun `时间线条目与分组条目构造签名与 CORE_API 一致`() {
        val item: TimelineItem = TimelineMessage(
            key = "k",
            id = "k",
            role = "assistant",
            text = "t",
            ts = 1L,
            seq = 2L
        )
        assertEquals("k", item.key)
        val step: TimelineItem = TimelineStep(
            key = "s1",
            callId = "1",
            name = "bash",
            arguments = "{}",
            status = "ok",
            resultText = "",
            errorText = "",
            ts = 1L
        )
        assertEquals("s1", step.key)
        val reasoning: TimelineItem = TimelineReasoning(
            key = "r1",
            id = "r1",
            text = "t",
            ts = 1L
        )
        assertEquals("r1", reasoning.key)
        val entry = TimelineEntry(
            key = "p:s1",
            isProcess = true,
            head = step,
            members = listOf(step, reasoning),
            groupExpanded = false
        )
        entry.groupExpanded = true
        assertTrue(entry.groupExpanded, "groupExpanded 必须可写（UI 就地切换）")
        assertEquals(2, entry.members.size)
    }
}
