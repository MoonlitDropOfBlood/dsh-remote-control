/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 2026-11-08 两处 core 行为变更的回归用例。
 *
 *  1) 幽灵 process group 收编（对齐 ArkTS git 5f87848 + timeline-reconcile.ts
 *     的 collectCoveredLiveStepIds）；
 *  2) 历史错误归属详情页（对齐 ArkTS git 2d8cfaf 的 sessionstore.ets：
 *     historyErrorSessionId / historyErrorMessage / historyErrorFor / 重新加载）。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** 幽灵 process group：空闲权威对账必须收编全部残留直播步骤。 */
class LiveStepReconcileTest {

    private fun liveStep(callId: String, key: String = "s$callId", seq: Long = -1L) = TimelineStep(
        key = key,
        callId = callId,
        name = "bash",
        arguments = "{}",
        status = "running",
        resultText = "",
        errorText = "",
        ts = 1_700_000_000_000L,
        seq = seq
    )

    private fun durableStep(callId: String, seq: Long = 2L) = StepRecord(
        seq = seq,
        callId = callId,
        name = "bash",
        arguments = "{}",
        status = "ok",
        resultText = "ok",
        errorText = "",
        ts = 1_700_000_000_000L,
        turn = 1,
        step = 1
    )

    // ---- 纯函数：collectCoveredLiveStepIds（与 ArkTS 同名函数同口径） ----

    @Test
    fun `运行中只按 callId 去重`() {
        val durable = listOf(DurableStep("known"))
        val live = listOf(LiveStep("s-known", "known"), LiveStep("s-orphan", "orphan"))
        val covered = collectCoveredLiveStepIds(durable, live, false)
        assertEquals(setOf("s-known"), covered, "运行中不得误删尚未进历史的直播步骤")
    }

    @Test
    fun `空闲权威对账接管全部直播步骤`() {
        val durable = listOf(DurableStep("known"))
        val live = listOf(LiveStep("s-known", "known"), LiveStep("s-orphan", "orphan"))
        val covered = collectCoveredLiveStepIds(durable, live, true)
        assertEquals(setOf("s-known", "s-orphan"), covered, "空闲最新页必须清掉未进本页的残留步骤")
    }

    @Test
    fun `空闲权威对账即使本页没有步骤也接管全部`() {
        val live = listOf(LiveStep("s-known", "known"), LiveStep("s-orphan", "orphan"))
        assertEquals(
            setOf("s-known", "s-orphan"),
            collectCoveredLiveStepIds(emptyList(), live, true),
            "本页没有任何步骤时，空闲权威对账也要接管全部直播步骤"
        )
    }

    @Test
    fun `运行中且本页为空时一条都不清`() {
        val live = listOf(LiveStep("s-orphan", "orphan"))
        assertTrue(collectCoveredLiveStepIds(emptyList(), live, false).isEmpty())
    }

    // ---- 接线：mergeTimelineItems 的行为 ----

    @Test
    fun `运行中保留尚未进历史的直播步骤`() {
        val old = listOf(liveStep("orphan"))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = emptyList(),
            prepend = false,
            dropFinalized = false, // 宿主仍在跑 → 不是权威空闲页
            finalizeStreaming = false
        )
        assertEquals(1, merged.size, "运行中不得清掉直播步骤")
        assertEquals("sorphan", merged[0].key, "直播步骤 key = s + callId")
    }

    @Test
    fun `空闲权威页清掉 orphan 直播步骤`() {
        val old = listOf(liveStep("orphan"))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = emptyList(),
            prepend = false,
            dropFinalized = true, // 宿主已空闲 + 最新页 → 权威投影
            finalizeStreaming = true
        )
        assertTrue(merged.isEmpty(), "空闲权威页必须收编全部残留直播步骤（幽灵 process group 的根因）")
    }

    @Test
    fun `空闲权威页保留已进本页的持久步骤`() {
        val old = listOf(liveStep("known"))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = listOf(durableStep("known")),
            prepend = false,
            dropFinalized = true,
            finalizeStreaming = true
        )
        assertEquals(1, merged.size, "直播副本退出后应留下持久步骤")
        assertEquals("sknown", merged[0].key, "持久步骤 key = s + callId")
        assertEquals("ok", (merged[0] as TimelineStep).status)
    }

    @Test
    fun `向前翻页不清直播步骤`() {
        val old = listOf(liveStep("orphan"))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = emptyList(),
            prepend = true, // 向前翻页 → 不是最新页
            dropFinalized = true,
            finalizeStreaming = false
        )
        assertEquals(1, merged.size, "向前翻页仍是 callId 去重口径")
    }

    @Test
    fun `durable 步骤不受直播清理影响`() {
        val old = listOf(liveStep("known", seq = 7L))
        val merged = mergeTimelineItems(
            oldItems = old,
            messages = emptyList(),
            steps = listOf(durableStep("known", seq = 8L)),
            prepend = false,
            dropFinalized = true,
            finalizeStreaming = true
        )
        assertEquals(1, merged.size, "durable 步骤照常保留（本页覆盖区间外）")
        assertEquals(8L, merged[0].seqOf(), "durable 步骤取本页的 seq")
    }
}

/** 权威对账的触发规则（turn.end / session.status 兜底）。 */
class AuthoritativeRefreshTriggerTest {

    @Test
    fun `turn_end 触发权威对账`() {
        assertTrue(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.TURN_END,
                wasRunning = true,
                runningNow = false,
                linkOnline = true
            ),
            "turn.end 是回合硬边界 → 必须对账"
        )
    }

    @Test
    fun `turn_end 在离线时不触发`() {
        assertFalse(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.TURN_END,
                wasRunning = true,
                runningNow = false,
                linkOnline = false
            ),
            "离线没有权威页可对"
        )
    }

    @Test
    fun `空会话 id 不触发`() {
        assertFalse(
            needsAuthoritativeRefresh(
                sessionId = "",
                trigger = AuthoritativeRefreshTrigger.TURN_END,
                wasRunning = true,
                runningNow = false,
                linkOnline = true
            )
        )
    }

    @Test
    fun `session_status 只在 running 变 false 时触发`() {
        // turn.end 丢失的兜底：true → false
        assertTrue(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.SESSION_IDLE,
                wasRunning = true,
                runningNow = false,
                linkOnline = true
            )
        )
        // 仍然是 running → 不触发
        assertFalse(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.SESSION_IDLE,
                wasRunning = true,
                runningNow = true,
                linkOnline = true
            )
        )
        // 本来就空闲 → 不触发（没有回合收尾）
        assertFalse(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.SESSION_IDLE,
                wasRunning = false,
                runningNow = false,
                linkOnline = true
            )
        )
    }

    @Test
    fun `session_status 离线时不触发`() {
        assertFalse(
            needsAuthoritativeRefresh(
                sessionId = "s1",
                trigger = AuthoritativeRefreshTrigger.SESSION_IDLE,
                wasRunning = true,
                runningNow = false,
                linkOnline = false
            )
        )
    }
}

/** 历史错误归属：只在该会话详情页展示，不写全局 lastError。 */
class HistoryErrorOwnershipTest {

    /** 用 Unconfined 调度器：retryHistory 内的协程会同步跑完，断言无需等待。 */
    private fun newStore(scope: CoroutineScope) = SessionStore(DshrcLink(scope), scope)

    @Test
    fun `离线加载失败归属该会话且不写全局错误`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        try {
            val store = newStore(scope)
            store.retryHistory("sess-1")

            val err = store.historyError.value
            assertNotNull(err, "离线重试必须写该会话的历史错误")
            assertEquals("sess-1", err!!.sessionId)
            assertEquals("加载历史失败：未连接主机", err.message)
            assertEquals("加载历史失败：未连接主机", store.historyErrorFor("sess-1"))
            assertEquals("", store.lastError.value, "历史错误不得写全局 lastError（首页会抢走）")
            assertEquals("", store.historyErrorFor("sess-2"), "别的会话读不到这条错误")
            store.close()
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `公开的 loadHistory 失败同样归属会话`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        try {
            val store = newStore(scope)
            var thrown: StoreException? = null
            try {
                runBlocking { store.loadHistory("sess-9") }
            } catch (e: StoreException) {
                thrown = e
            }
            assertNotNull(thrown, "离线时 loadHistory 必须抛错")
            assertEquals("加载历史失败：未连接主机", thrown!!.message)
            assertEquals("加载历史失败：未连接主机", store.historyErrorFor("sess-9"))
            assertEquals("", store.lastError.value, "历史错误不得写全局 lastError")
            store.close()
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `链路断开清空历史错误`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        try {
            val store = newStore(scope)
            store.retryHistory("sess-1")
            assertNotNull(store.historyError.value)

            // 先制造一次状态变化，再断开 → clearHostState 清掉历史错误（避免跨主机串错）。
            store.onState(LinkState.ERROR)
            store.onState(LinkState.STOPPED)
            assertNull(store.historyError.value, "链路断开必须清空历史错误")
            assertEquals("", store.historyErrorFor("sess-1"))
            store.close()
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `错误归属只认自己的会话`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        try {
            val store = newStore(scope)
            store.retryHistory("sess-a")
            assertEquals("加载历史失败：未连接主机", store.historyErrorFor("sess-a"))
            assertEquals("", store.historyErrorFor("sess-b"))
            assertFalse(store.historyError.value == null, "错误状态存在")
            store.close()
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `历史加载状态可观察`() {
        val scope = CoroutineScope(Dispatchers.Unconfined + SupervisorJob())
        try {
            val store = newStore(scope)
            assertFalse(store.historyLoading.value, "初始不在加载中")
            // 离线重试 → 根本没发请求（早退），加载状态不应挂住
            store.retryHistory("sess-1")
            assertFalse(store.historyLoading.value, "离线早退不应停在「加载中」")
            assertEquals("加载历史失败：未连接主机", store.historyErrorFor("sess-1"))
            store.close()
        } finally {
            scope.cancel()
        }
    }
}
