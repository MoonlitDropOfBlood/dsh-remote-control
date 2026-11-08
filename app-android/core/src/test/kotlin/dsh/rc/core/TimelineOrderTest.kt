/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 时间线顺序回归（**跨实现**联调）。
 *
 * 复现的 bug：用户气泡被插进**同一条流式回复的中间** → 一条回复被切成两个气泡
 * （截图里是「已收到：**sm」/ 用户「smone」/ 「one**。…」三段）。
 *
 * 根因（Kotlin 独有，ArkTS 不会犯）：
 *  - ArkTS 的 `Promise.then` 是**微任务**，必早于下一帧 WS 消息 → 本地气泡先落位；
 *  - Kotlin 的 `deferred.await()` 恢复是**派发**的 → 读线程会先把下一帧
 *    （`assistant.delta`）处理掉，再轮到协程恢复 → 若客户端「等 accepted 再上屏」，
 *    用户气泡就落在增量之后，把一条回复切成两半。
 * 宿主侧也会这样：插件端 `#rSessionPrompt` 先 await 宿主 prompt、**之后**才回
 * accepted → `assistant.delta` 可能**先于** prompt 回包到达。
 *
 * 用例：mock host 用 `MOCK_PROMPT_RESULT_LAST=1` 把 accepted 回包挪到流式回复**之后**
 * （= 插件端的真实顺序），然后断言：
 *   1. 用户气泡排在 assistant 回复**之前**；
 *   2. assistant 回复只有**一个**气泡（没被切成两半）。
 *
 * 被测对象是「Kotlin 客户端 ↔ 仓库里既有的 JS 实现」（relay + mock-host），
 * 不是自证自洽。运行前置：node（≥20）在 PATH 上。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.ServerSocket

class TimelineOrderTest {

    /** mock host 预置的示例会话（e2e/mock-host.mjs 的 sessions map）。 */
    private val demoSession = "s-demo-1"

    private val promptText = "hello android"

    @Test
    fun `local user bubble stays above the streaming assistant reply`() = runBlocking {
        val repoRoot = findRepoRoot()
        val relay = repoRoot.resolve("relay/server.js")
        val mockHost = repoRoot.resolve("e2e/mock-host.mjs")
        assertTrue("找不到 relay/server.js（$repoRoot）", relay.exists())
        assertTrue("找不到 e2e/mock-host.mjs（$repoRoot）", mockHost.exists())

        val port = freePort()
        val relayUrl = "ws://127.0.0.1:$port"
        // 每轮用**随机 channel**：mock host 把「已接受的对端纪元」持久化到
        // /tmp/dshrc-e2e-epoch-host-<channel>.json（契约 §3.4.1），
        // 固定 channel + 每次新 sid → 第二轮起 host 判「纪元回退」直接拒绝握手。
        val channel = randomChannel()
        val secret = "android-order-secret-0123456789"

        val relayProcess = startNode(relay, emptyList(), mapOf("PORT" to port.toString(), "LOG_LEVEL" to "error"))
        // 中继先起来，再拉 mock host（否则 host 首次连接会失败并进入退避）
        awaitPort(port, timeoutMs = 15_000)
        // MOCK_PROMPT_RESULT_LAST=1：accepted 回包排在流式回复**之后**（复现插件端真实顺序）
        val hostProcess = startNode(
            mockHost,
            listOf(relayUrl, channel, secret),
            mapOf("MOCK_PROMPT_RESULT_LAST" to "1")
        )
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val link = DshrcLink(scope)
        val store = SessionStore(link, scope)

        try {
            link.start(
                LinkConfig(
                    relayUrl = relayUrl,
                    channel = channel,
                    secret = secret,
                    clientName = "android-order-test",
                    appVersion = "1.0.0",
                    epoch = EpochState(0, -1, "")
                )
            )
            withTimeout(30_000) {
                while (link.getState() != LinkState.ONLINE) delay(50)
            }
            // 等 host 上线：peer pv 未知时不能发业务帧
            awaitPeerOnline(link, timeoutMs = 20_000)
            delay(300)

            store.loadSessions()
            store.openSession(demoSession)
            // 等首屏请求（历史/队列/子代理/模型/权限）落地，避免与后续直播事件竞态
            delay(800)

            // 发送提示词：空闲 → 乐观气泡必须在**发请求之前**落位（口径 #6）
            val accepted = withTimeout(30_000) { store.sendPrompt(demoSession, promptText) }
            assertTrue("session.prompt 应被宿主接受", accepted)

            // 等本轮回复定稿（turn.end 会把流式块定稿）
            var timeline: List<TimelineItem> = emptyList()
            withTimeout(30_000) {
                while (true) {
                    val items = store.timeline.value
                    val reply = items.filterIsInstance<TimelineMessage>()
                        .firstOrNull { it.role == "assistant" && !it.streaming && it.text.isNotEmpty() }
                    if (reply != null) {
                        timeline = items
                        break
                    }
                    delay(50)
                }
            }

            val messages = timeline.filterIsInstance<TimelineMessage>()
            val users = messages.filter { it.role == "user" && it.text == promptText }
            val assistants = messages.filter { it.role == "assistant" }
            assertEquals("应只有一条本地用户气泡", 1, users.size)
            // 用户气泡夹在流中间 → 一条回复会被切成两个 assistant 气泡
            assertEquals("assistant 回复应只有**一个**气泡（不能被用户气泡切成两半）", 1, assistants.size)

            val userIndex = timeline.indexOf(users[0])
            val assistantIndex = timeline.indexOf(assistants[0])
            assertTrue(
                "用户气泡必须排在 assistant 回复之前（user=$userIndex assistant=$assistantIndex）",
                userIndex < assistantIndex
            )
            assertTrue(
                "assistant 气泡应包含整条回复（说明没有在流中间被切开）",
                assistants[0].text.contains("代码块走同一套渲染")
            )
        } finally {
            store.close()
            link.stop()
            scope.cancel()
            hostProcess.destroyForcibly()
            relayProcess.destroyForcibly()
        }
    }

    // ---- 辅助 ----

    private fun findRepoRoot(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "docs/PROTOCOL.md").exists() && File(dir, "relay/server.js").exists()) {
                return dir
            }
            dir = dir.parentFile
        }
        throw IllegalStateException("找不到仓库根（从 ${System.getProperty("user.dir")} 向上找不到 docs/PROTOCOL.md）")
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    /** 随机合法 channel（契约 §4：`^[A-Z2-7]{16,64}$`，数字只能是 2–7）。 */
    private fun randomChannel(): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val rnd = java.util.Random()
        val sb = StringBuilder(16)
        for (i in 0 until 16) sb.append(alphabet[rnd.nextInt(alphabet.length)])
        return sb.toString()
    }

    private fun startNode(script: File, args: List<String>, env: Map<String, String>): Process {
        val pb = ProcessBuilder(listOf("node", script.absolutePath) + args)
        pb.redirectErrorStream(true)
        val log = File(System.getProperty("java.io.tmpdir"), "dshrc-order-${script.name}-${System.nanoTime()}.log")
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log))
        env.forEach { (k, v) -> pb.environment()[k] = v }
        return pb.start()
    }

    private suspend fun awaitPort(port: Int, timeoutMs: Long) {
        withTimeout(timeoutMs) {
            while (true) {
                val ok = runCatching {
                    java.net.Socket("127.0.0.1", port).close()
                    true
                }.getOrDefault(false)
                if (ok) return@withTimeout
                delay(100)
            }
        }
    }

    private suspend fun awaitPeerOnline(link: DshrcLink, timeoutMs: Long) {
        withTimeout(timeoutMs) {
            while (!link.isHostOnline()) delay(100)
        }
    }
}
