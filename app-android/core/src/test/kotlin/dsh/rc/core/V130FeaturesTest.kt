/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— v1.3.0 契约增补的纯函数单测（不需要设备 / 模拟器）。
 *
 * 覆盖（契约 §5.12 待答交互 / §5.13 Todo / §5.14 Goal + §5.2 队列权威口径）：
 *  - 队列快照：整表替换 / 按 itemId 去重 / 空数组清空；
 *  - 待答交互：按 askId **幂等**合并（事件重发不叠加、快照清理已失效）；
 *  - Todo：`supported:false`（宿主不支持）与 `todos:null`（暂无清单）**必须区分**；
 *  - Goal：事件更新 / 激活态（只认当前目标）/ CAS 载荷 / 版本过期；
 *  - 子代理会话：Goal **只读**。
 */
package dsh.rc.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** v1.3.0（契约 §5.12 / §5.13 / §5.14）纯函数行为。 */
class V130FeaturesTest {

    // ---- 测试夹具 ----

    private fun queueItem(itemId: String, text: String = "排队消息", target: String = "next-turn") =
        QueueItem(itemId = itemId, text = text, target = target)

    private fun questionRequest(
        askId: String,
        sessionId: String = "sess-1",
        state: String = Protocol.PENDING_STATE_OPEN,
        answerable: Boolean = true,
        callId: String = "",
        expiresAt: Long? = null,
        timeoutMs: Long = 120_000L
    ) = QuestionRequest(
        askId = askId,
        sessionId = sessionId,
        questions = listOf(
            Question(id = "q1", question = "选哪个？", multiSelect = false, options = emptyList())
        ),
        timeoutMs = timeoutMs,
        multiSelect = false,
        state = state,
        callId = callId,
        expiresAt = expiresAt,
        answerable = answerable
    )

    private fun pendingQuestion(
        askId: String,
        sessionId: String = "sess-1",
        state: String = Protocol.PENDING_STATE_OPEN,
        answerable: Boolean = true,
        callId: String = "call-1",
        expiresAt: Long? = null
    ) = PendingQuestion(
        askId = askId,
        sessionId = sessionId,
        callId = callId,
        questions = listOf(
            Question(id = "q1", question = "选哪个？", multiSelect = false, options = emptyList())
        ),
        state = state,
        answerable = answerable,
        source = Protocol.PENDING_SOURCE_HOST,
        expiresAt = expiresAt,
        timeoutMs = 120_000L,
        multiSelect = false
    )

    private fun pendingApproval(
        askId: String,
        sessionId: String = "sess-1",
        answerable: Boolean = true,
        expiresAt: Long? = null
    ) = PendingApproval(
        askId = askId,
        sessionId = sessionId,
        toolName = "bash",
        reason = "要执行命令",
        argsPreview = "ls -la",
        answerable = answerable,
        source = Protocol.PENDING_SOURCE_PLUGIN,
        expiresAt = expiresAt
    )

    private fun goal(
        id: String = "goal-1",
        revision: Long = 3L,
        objective: String = "把测试跑通",
        phase: String = Protocol.GOAL_PHASE_ACTIVE,
        activation: String? = null,
        maxGoalRounds: Int = 12
    ) = GoalWire(
        id = id,
        revision = revision,
        objective = objective,
        phase = phase,
        blockedReason = null,
        maxGoalRounds = maxGoalRounds,
        roundsStarted = 4,
        createdAt = 1_700_000_000_000L,
        updatedAt = 1_700_000_001_000L,
        activation = activation
    )

    // =================================================================================
    // 1) 队列快照（契约 §5.2 v1.3.0：整表替换 + 按 itemId 去重）
    // =================================================================================

    @Test
    fun `队列空快照清空整表`() {
        val previous = listOf(queueItem("i1"), queueItem("i2"))
        val merged = mergeQueueSnapshot(previous, emptyList())
        assertTrue(merged.isEmpty(), "空数组 = 没有待执行消息 → 整表清空")
    }

    @Test
    fun `队列快照按 itemId 去重`() {
        val incoming = listOf(
            queueItem("i1", "第一条"),
            queueItem("i1", "第一条（重复）"),
            queueItem("i2", "第二条")
        )
        val merged = mergeQueueSnapshot(emptyList(), incoming)
        assertEquals(2, merged.size, "同一 itemId 只保留一条")
        assertEquals(listOf("i1", "i2"), merged.map { it.itemId })
        assertEquals("第一条", merged[0].text, "保留第一条")
    }

    @Test
    fun `队列快照整表替换而不是增量合并`() {
        val previous = listOf(queueItem("old"), queueItem("keep"))
        val merged = mergeQueueSnapshot(previous, listOf(queueItem("keep")))
        assertEquals(1, merged.size, "快照是全量 → 不在快照里的旧项必须消失")
        assertEquals("keep", merged[0].itemId)
    }

    @Test
    fun `队列快照忽略没有 itemId 的行`() {
        val merged = mergeQueueSnapshot(emptyList(), listOf(queueItem(""), queueItem("i1")))
        assertEquals(1, merged.size)
        assertEquals("i1", merged[0].itemId)
    }

    // =================================================================================
    // 2) 待答交互（契约 §5.12）
    // =================================================================================

    @Test
    fun `待答按 askId 幂等合并不叠加`() {
        val live = listOf(questionRequest("ask-1", state = Protocol.PENDING_STATE_OPEN))
        val snapshot = listOf(
            pendingQuestion("ask-1", state = Protocol.PENDING_STATE_CONTINUED, callId = "call-1")
        )
        val merged = mergePendingInteractions(
            liveQuestions = live,
            liveApprovals = emptyList(),
            snapshotQuestions = snapshot,
            snapshotApprovals = emptyList(),
            dropLiveMissing = true
        )
        assertEquals(1, merged.questions.size, "同一 askId → 替换而非叠加")
        assertEquals(
            Protocol.PENDING_STATE_CONTINUED,
            merged.questions[0].state,
            "快照的状态覆盖 live 的状态（open → continued）"
        )
        assertEquals("call-1", merged.questions[0].callId, "Host callId 透传")
    }

    @Test
    fun `待答快照清理已失效的 live 项`() {
        val live = listOf(questionRequest("ask-1"), questionRequest("ask-gone"))
        val merged = mergePendingInteractions(
            liveQuestions = live,
            liveApprovals = emptyList(),
            snapshotQuestions = listOf(pendingQuestion("ask-1")),
            snapshotApprovals = emptyList(),
            dropLiveMissing = true
        )
        assertEquals(1, merged.questions.size, "快照里没有的项 = 已失效 → 清理")
        assertEquals("ask-1", merged.questions[0].askId)
    }

    @Test
    fun `全局快照不清理 live 项`() {
        val live = listOf(questionRequest("ask-1"))
        val merged = mergePendingInteractions(
            liveQuestions = live,
            liveApprovals = emptyList(),
            snapshotQuestions = emptyList(),
            snapshotApprovals = emptyList(),
            dropLiveMissing = false
        )
        assertEquals(1, merged.questions.size, "全局快照只含插件仍持有的项 → 不能据此删 live")
    }

    @Test
    fun `快照请求之前到达的失效卡会被清理`() {
        val live = listOf(questionRequest("ask-gone"))
        val merged = mergePendingInteractions(
            liveQuestions = live,
            liveApprovals = emptyList(),
            snapshotQuestions = emptyList(),
            snapshotApprovals = emptyList(),
            dropLiveMissing = true,
            issuedSeq = 10L,
            liveBorn = mapOf("ask-gone" to 8L)
        )
        assertTrue(merged.questions.isEmpty(), "bornSeq <= issuedSeq 且不在快照 → 已失效")
    }

    @Test
    fun `快照请求途中新到的 live 卡不会被旧快照误删`() {
        val live = listOf(questionRequest("ask-race"))
        val merged = mergePendingInteractions(
            liveQuestions = live,
            liveApprovals = emptyList(),
            snapshotQuestions = emptyList(),
            snapshotApprovals = emptyList(),
            dropLiveMissing = true,
            issuedSeq = 10L,
            liveBorn = mapOf("ask-race" to 11L)
        )
        assertEquals(1, merged.questions.size, "请求发出之后才到 → 保留")
        assertEquals("ask-race", merged.questions[0].askId)
    }

    @Test
    fun `待答快照新增项会补进列表`() {
        val merged = mergePendingInteractions(
            liveQuestions = emptyList(),
            liveApprovals = emptyList(),
            snapshotQuestions = listOf(pendingQuestion("ask-new")),
            snapshotApprovals = listOf(pendingApproval("appr-new")),
            dropLiveMissing = true
        )
        assertEquals(1, merged.questions.size)
        assertEquals(1, merged.approvals.size)
        assertEquals("ask-new", merged.questions[0].askId)
        assertEquals("appr-new", merged.approvals[0].askId)
        assertEquals("bash", merged.approvals[0].toolName)
    }

    @Test
    fun `同一 askId 的事件重发是替换而不是第二张卡`() {
        val list = listOf(questionRequest("ask-1"), questionRequest("ask-2"))
        val replaced = replaceQuestionByAskId(list, questionRequest("ask-1", state = Protocol.PENDING_STATE_CONTINUED))
        assertEquals(2, replaced.size, "不得出现第二张同 askId 的卡")
        assertEquals(Protocol.PENDING_STATE_CONTINUED, replaced[0].state)
        assertEquals("ask-2", replaced[1].askId, "顺序保持")
    }

    @Test
    fun `新的 askId 追加到末尾`() {
        val list = listOf(questionRequest("ask-1"))
        val replaced = replaceQuestionByAskId(list, questionRequest("ask-2"))
        assertEquals(2, replaced.size)
        assertEquals("ask-2", replaced[1].askId)
    }

    @Test
    fun `失效的问题不可答`() {
        val merged = mergePendingInteractions(
            liveQuestions = emptyList(),
            liveApprovals = emptyList(),
            snapshotQuestions = listOf(pendingQuestion("ask-1", answerable = false)),
            snapshotApprovals = emptyList(),
            dropLiveMissing = true
        )
        assertFalse(merged.questions[0].answerable, "answerable=false → 不得显示可编辑卡")
    }

    // =================================================================================
    // 3) Todo（契约 §5.13）
    // =================================================================================

    @Test
    fun `Todo 不支持与暂无清单必须区分`() {
        val unsupported = TodoState.fromJson(jsonOf("supported" to false, "todos" to null))
        assertFalse(unsupported.supported, "宿主不支持")
        assertNull(unsupported.todos)
        assertEquals(TodoVisibility.HIDDEN, todoVisibility(unsupported), "不支持 → 隐藏 UI")

        val empty = TodoState.fromJson(jsonOf("supported" to true, "todos" to null))
        assertTrue(empty.supported, "宿主支持")
        assertNull(empty.todos, "本回合尚无清单 / 已清空")
        assertEquals(TodoVisibility.EMPTY, todoVisibility(empty), "支持但没有清单 → 显示「暂无任务」")
    }

    @Test
    fun `Todo 有清单时展示条目`() {
        val state = TodoState.fromJson(
            buildJsonObject {
                put("supported", true)
                put(
                    "todos",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("content", "写代码")
                                put("status", Protocol.TODO_STATUS_COMPLETED)
                            }
                        )
                        add(
                            buildJsonObject {
                                put("content", "跑测试")
                                put("status", Protocol.TODO_STATUS_IN_PROGRESS)
                            }
                        )
                        add(
                            buildJsonObject {
                                put("content", "写文档")
                                put("status", Protocol.TODO_STATUS_PENDING)
                            }
                        )
                    }
                )
            }
        )
        assertEquals(TodoVisibility.LIST, todoVisibility(state))
        assertEquals(3, state.todos?.size)
        assertEquals(1, state.completedCount, "三态计数：已完成")
        assertEquals(1, state.inProgressCount, "三态计数：进行中")
        assertEquals(1, state.pendingCount, "三态计数：待办")
        assertTrue(state.todos!![0].isCompleted)
        assertTrue(state.todos!![1].isInProgress)
        assertTrue(state.todos!![2].isPending)
    }

    @Test
    fun `Todo 缺失状态字段按待办处理`() {
        val state = TodoState.fromJson(
            buildJsonObject {
                put("supported", true)
                put("todos", buildJsonArray { add(buildJsonObject { put("content", "一件事") }) })
            }
        )
        assertEquals(1, state.todos?.size)
        assertTrue(state.todos!![0].isPending, "旧宿主缺 status → 按 pending 处理")
    }

    // =================================================================================
    // 4) Goal 事件与激活态（契约 §5.14）
    // =================================================================================

    @Test
    fun `Goal 变化事件整表覆盖`() {
        val current = goal()
        val changed = goalAfterChange(current, goal(revision = 4L, objective = "新目标"), null)
        assertNotNull(changed)
        assertEquals(4L, changed!!.revision, "事件带新的 revision")
        assertEquals("新目标", changed.objective)
    }

    @Test
    fun `Goal 清除事件把目标置空`() {
        val cleared = goalAfterChange(goal(), null, Protocol.GOAL_ACTIVATION_ARMED)
        assertNull(cleared, "clear → 没有目标")
    }

    @Test
    fun `Goal 事件补上已知的进程内激活态`() {
        val changed = goalAfterChange(goal(), goal(revision = 5L), Protocol.GOAL_ACTIVATION_ARMED)
        assertEquals(Protocol.GOAL_ACTIVATION_ARMED, changed?.activation, "事件本身不含 activation → 用已知值补")
    }

    @Test
    fun `Goal 激活态只认当前目标`() {
        val current = goal(id = "goal-1")
        val next = goalAfterActivation(current, GoalActivation("goal-1", 3L, Protocol.GOAL_ACTIVATION_ARMED))
        assertEquals(Protocol.GOAL_ACTIVATION_ARMED, next?.activation)
        assertTrue(next!!.isArmed)
    }

    @Test
    fun `Goal 激活态忽略旧目标的迟到事件`() {
        val current = goal(id = "goal-2")
        val next = goalAfterActivation(current, GoalActivation("goal-1", 3L, Protocol.GOAL_ACTIVATION_ARMED))
        assertEquals(current, next, "id 不匹配 → 忽略")
        assertNull(next?.activation)
    }

    @Test
    fun `Goal 没有当前目标时忽略激活态事件`() {
        assertNull(goalAfterActivation(null, GoalActivation("goal-1", 1L, Protocol.GOAL_ACTIVATION_ARMED)))
    }

    @Test
    fun `Goal 读不到激活态时不得谎称自动续跑中`() {
        val current = goal()
        assertNull(current.activation)
        assertFalse(current.isArmed, "activation 未知 → isArmed 必须为 false")
    }

    // =================================================================================
    // 5) Goal 人类操作载荷与 CAS（契约 §5.1 v1.3.0 / §5.14）
    // =================================================================================

    @Test
    fun `新建目标不带 expected`() {
        val payload = buildGoalActionPayload(
            sessionId = "sess-1",
            action = GoalAction.CREATE,
            current = null,
            objective = "  把测试跑通  ",
            maxGoalRounds = null
        )
        assertNotNull(payload)
        assertEquals("sess-1", payload!!.str("sessionId"))
        assertEquals(Protocol.GOAL_ACTION_CREATE, payload.str("action"))
        assertEquals("把测试跑通", payload.str("objective"), "空白裁掉")
        assertNull(payload.objOrNull("expected"), "create 不带 expected")
        assertEquals(12, payload.int("maxGoalRounds"), "未填轮数 → 用默认值")
    }

    @Test
    fun `新建目标缺少内容时拒绝`() {
        assertNull(
            buildGoalActionPayload("sess-1", GoalAction.CREATE, null, "  ", null),
            "objective 必填"
        )
    }

    @Test
    fun `除新建外的操作都带当前 id 与 revision`() {
        val current = goal(id = "goal-7", revision = 9L)
        for (action in listOf(
            GoalAction.PAUSE,
            GoalAction.RESUME,
            GoalAction.COMPLETE,
            GoalAction.CLEAR
        )) {
            val payload = buildGoalActionPayload("sess-1", action, current, null, null)
            assertNotNull(payload, "${action.wire} 必须能构造载荷")
            val expected = payload!!.objOrNull("expected")
            assertNotNull(expected, "${action.wire} 必须带 expected")
            assertEquals("goal-7", expected!!.str("id"))
            assertEquals(9L, expected.long("revision"))
            assertTrue(action.requiresExpected)
        }
    }

    @Test
    fun `编辑目标带 objective 与轮数`() {
        val current = goal()
        val payload = buildGoalActionPayload(
            sessionId = "sess-1",
            action = GoalAction.EDIT,
            current = current,
            objective = "新的目标",
            maxGoalRounds = 20
        )
        assertNotNull(payload)
        assertEquals("新的目标", payload!!.str("objective"))
        assertEquals(20, payload.int("maxGoalRounds"))
        assertNotNull(payload.objOrNull("expected"), "edit 也走 CAS")
    }

    @Test
    fun `编辑目标至少要给一项`() {
        val current = goal()
        assertNull(
            buildGoalActionPayload("sess-1", GoalAction.EDIT, current, null, null),
            "objective / maxGoalRounds 至少一项"
        )
        assertNotNull(buildGoalActionPayload("sess-1", GoalAction.EDIT, current, null, 5))
    }

    @Test
    fun `没有当前目标时拒绝非新建操作`() {
        assertNull(buildGoalActionPayload("sess-1", GoalAction.PAUSE, null, null, null))
    }

    @Test
    fun `版本过期错误可识别`() {
        assertTrue(isStaleGoalError("GOAL_STALE_REVISION: stale goal ref"))
        assertTrue(isStaleGoalError("goal_stale_revision"))
        assertFalse(isStaleGoalError("link not online"))
    }

    @Test
    fun `旧宿主不支持的请求要能识别以静默降级`() {
        assertTrue(isUnsupportedRequestError("bad-type: unknown request session.todos"))
        assertTrue(isUnsupportedRequestError("unsupported"))
        assertFalse(isUnsupportedRequestError("link not online"))
    }

    // =================================================================================
    // 6) 子代理只读（契约 §5.14 / §5.6）
    // =================================================================================

    @Test
    fun `子代理会话不允许操作目标`() {
        val subagent = SessionSummary(
            sessionId = "child-1",
            title = "子代理",
            cwd = "/tmp",
            running = false,
            updatedAt = 0L,
            origin = "subagent",
            parentSessionId = "root-1"
        )
        assertFalse(isGoalOperationAllowed(subagent), "子代理只读")
    }

    @Test
    fun `根会话允许操作目标`() {
        val root = SessionSummary(
            sessionId = "root-1",
            title = "根会话",
            cwd = "/tmp",
            running = false,
            updatedAt = 0L
        )
        assertTrue(isGoalOperationAllowed(root))
    }

    @Test
    fun `有父会话 id 的会话也按子代理处理`() {
        val child = SessionSummary(
            sessionId = "child-2",
            title = "子代理",
            cwd = "/tmp",
            running = false,
            updatedAt = 0L,
            parentSessionId = "root-1"
        )
        assertFalse(isGoalOperationAllowed(child))
    }

    // =================================================================================
    // 7) 契约常量（契约 §5.1 / §5.2 / §5.14）
    // =================================================================================

    @Test
    fun `契约版本与请求常量对齐 v1_3_1`() {
        // v1.3.1（契约 §5.3 / §5.14）只新增可选字段，旧客户端/旧插件保持旧行为。
        assertEquals("v1.3.1", Protocol.CONTRACT_VERSION)
        assertEquals("pending.interactions", Protocol.MSG_PENDING_INTERACTIONS)
        assertEquals("session.todos", Protocol.MSG_SESSION_TODOS)
        assertEquals("session.goal", Protocol.MSG_SESSION_GOAL)
        assertEquals("session.goalAction", Protocol.MSG_SESSION_GOAL_ACTION)
        assertEquals("session.todosChanged", Protocol.TOPIC_SESSION_TODOS_CHANGED)
        assertEquals("session.goalChanged", Protocol.TOPIC_SESSION_GOAL_CHANGED)
        assertEquals("session.goalActivationChanged", Protocol.TOPIC_SESSION_GOAL_ACTIVATION_CHANGED)
    }

    @Test
    fun `hello 声明会话状态特性`() {
        // 契约 §5.1 v1.3.0：声明 session-state-v1 → 插件对本客户端启用新语义。
        assertEquals("session-state-v1", Protocol.FEATURE_SESSION_STATE_V1)
        assertTrue(Protocol.CLIENT_FEATURES.contains(Protocol.FEATURE_SESSION_STATE_V1))
    }

    @Test
    fun `Goal 操作集合不含 block`() {
        val wires = GoalAction.entries.map { it.wire }
        assertEquals(
            listOf("create", "edit", "pause", "resume", "complete", "clear"),
            wires
        )
        assertNull(GoalAction.fromWire("block"), "block 不是手机的人类操作")
        assertEquals(GoalAction.EDIT, GoalAction.fromWire("edit"))
    }

    @Test
    fun `能力目录缺省即不支持`() {
        val caps = Capabilities.fromJson(jsonOf("presets" to JsonArray(emptyList())))
        assertNull(caps.todos, "旧宿主 → 缺省 todos")
        assertNull(caps.goal, "旧宿主 → 缺省 goal")
        assertNull(caps.pendingInteractions, "旧宿主 → 缺省 pendingInteractions")
    }

    @Test
    fun `能力目录能读出 v1_3_0 的三块`() {
        val caps = Capabilities.fromJson(
            buildJsonObject {
                put(
                    "todos",
                    buildJsonObject { put("supported", true) }
                )
                put(
                    "goal",
                    buildJsonObject {
                        put("read", true)
                        put("actions", buildJsonArray { add(JsonPrimitive("create")) })
                    }
                )
                put(
                    "pendingInteractions",
                    buildJsonObject {
                        put("questions", true)
                        put("approvals", true)
                        put("hostContinued", true)
                    }
                )
            }
        )
        assertTrue(caps.todos?.supported == true)
        assertTrue(caps.goal?.read == true)
        assertEquals(listOf("create"), caps.goal?.actions)
        assertTrue(caps.pendingInteractions?.hostContinued == true)
    }
}
