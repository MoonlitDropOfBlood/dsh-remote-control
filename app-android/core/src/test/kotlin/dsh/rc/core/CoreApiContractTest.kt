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

            // ---- v1.3.0：待答交互 / Todo / Goal（契约 §5.12 / §5.13 / §5.14） ----
            val todos: StateFlow<TodoState?> = store.todos
            val goal: StateFlow<GoalWire?> = store.goal
            val goalActivation: StateFlow<String?> = store.goalActivation
            val goalSupported: StateFlow<Boolean> = store.goalSupported
            val goalActions: StateFlow<List<String>> = store.goalActions

            val loadPendingInteractions: suspend (String?) -> Unit = { store.loadPendingInteractions(it) }
            val loadSessionTodos: suspend (String) -> Unit = { store.loadSessionTodos(it) }
            val loadSessionGoal: suspend (String) -> Unit = { store.loadSessionGoal(it) }
            val goalAction: suspend (String, GoalAction, String?, Int?) -> Boolean =
                { sid, action, objective, rounds -> store.goalAction(sid, action, objective, rounds) }
            val canOperateGoal: (String) -> Boolean = { store.canOperateGoal(it) }

            // 默认参数也必须存在（调用方按契约写法编译得过）。
            runBlocking {
                runCatching { store.loadPendingInteractions() }
                runCatching { store.loadPendingInteractions("s") }
                runCatching { store.goalAction("s", GoalAction.CREATE, "目标", 12) }
                runCatching { store.goalAction("s", GoalAction.PAUSE) }
            }

            assertNull(todos.value)
            assertNull(goal.value)
            assertNull(goalActivation.value)
            assertFalse(goalSupported.value)
            assertTrue(goalActions.value.isEmpty())
            assertNotNull(loadPendingInteractions)
            assertNotNull(loadSessionTodos)
            assertNotNull(loadSessionGoal)
            assertNotNull(goalAction)
            assertNotNull(canOperateGoal)

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

    /**
     * v1.3.1（契约 §5.3）：唤醒消息带 `trigger`，正文为空（隐藏注入的原始 prompt）。
     * 旧插件不返该字段 → 空串 = 普通消息（行为不变）。
     */
    @Test
    fun `唤醒消息 trigger 解析与默认值`() {
        val waking = ChatMessage(
            id = "m1",
            role = "user",
            text = "",
            ts = 1L,
            seq = 2L,
            trigger = "goal"
        )
        assertEquals("goal", waking.trigger)
        assertTrue(waking.text.isEmpty(), "唤醒消息不保留注入正文")
        val plain = ChatMessage(id = "m2", role = "user", text = "hi", ts = 1L, seq = 3L)
        assertEquals("", plain.trigger, "缺字段 → 空串（普通消息）")
        val msg = TimelineMessage(
            key = "m1",
            id = "m1",
            role = "user",
            text = "",
            ts = 1L,
            seq = 2L,
            trigger = "goal"
        )
        assertEquals("goal", msg.trigger)
    }

    /**
     * v1.3.1：任务清单没有数据就**整行隐藏**（用户要求，两端同口径）。
     *
     * 纯函数语义不变（`HIDDEN` 宿主不支持 / `EMPTY` 无清单 / `LIST` 有条目），
     * UI 口径改成「只有 LIST 才渲染」——`EMPTY` 不再画「暂无任务」空行。
     */
    @Test
    fun `Todo 无数据时 UI 不可见`() {
        assertEquals(TodoVisibility.HIDDEN, todoVisibility(null))
        assertEquals(
            TodoVisibility.HIDDEN,
            todoVisibility(TodoState(supported = false, todos = null)),
        )
        assertEquals(
            TodoVisibility.EMPTY,
            todoVisibility(TodoState(supported = true, todos = emptyList())),
        )
        assertEquals(
            TodoVisibility.EMPTY,
            todoVisibility(TodoState(supported = true, todos = null)),
        )
        assertEquals(
            TodoVisibility.LIST,
            todoVisibility(TodoState(supported = true, todos = listOf(TodoItem("干活", "pending"))))
        )
    }
}
