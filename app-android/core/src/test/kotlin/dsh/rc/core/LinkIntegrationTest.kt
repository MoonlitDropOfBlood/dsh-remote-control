/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 端到端联调（**跨实现**验证）。
 *
 * 被测对象：Kotlin 客户端（:core）。
 * 对端：**仓库里已有的两套 Node 实现**（不是我们自己写的靶子）：
 *   - relay/server.js      —— 契约 §4 中继（哑管道）
 *   - e2e/mock-host.mjs    —— 契约 §5 host 角色的**第三份独立实现**
 * 因此本用例验证的是「Android 版 Kotlin 实现 ↔ 既有 JS 实现」的**互通性**，
 * 而非自证自洽（这是本仓 KAT 之外的第二道硬验收）。
 *
 * 覆盖：
 *   1. hello（v2 纪元证明）→ welcome → 加固模式
 *   2. 业务 hello → hostName
 *   3. session.list → 会话摘要
 *   4. session.prompt → accepted + assistant.delta 直播增量
 *   5. approval.request 事件 → approval.answer 回执
 *
 * 运行前置：node（≥20）在 PATH 上；仓库根能找到 relay/server.js 与 e2e/mock-host.mjs。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList

class LinkIntegrationTest {

    private val events = CopyOnWriteArrayList<DshrcMsg>()
    private val states = CopyOnWriteArrayList<LinkState>()

    private val listener = object : LinkListener {
        override fun onState(state: LinkState) {
            states.add(state)
        }

        override fun onEvent(msg: DshrcMsg) {
            events.add(msg)
        }

        override fun onPeers(hostOnline: Boolean, clientOnline: Boolean) {}
        override fun onHello(info: HostInfo) {}
        override fun onLog(line: String) {}
    }

    @Test
    fun `kotlin client talks to relay and mock host`() = runBlocking {
        val repoRoot = findRepoRoot()
        val relay = repoRoot.resolve("relay/server.js")
        val mockHost = repoRoot.resolve("e2e/mock-host.mjs")
        assertTrue("找不到 relay/server.js（$repoRoot）", relay.exists())
        assertTrue("找不到 e2e/mock-host.mjs（$repoRoot）", mockHost.exists())

        val port = freePort()
        val relayUrl = "ws://127.0.0.1:$port"
        // 每轮用**随机 channel**：mock host 把「已接受的对端纪元」持久化到
        // /tmp/dshrc-e2e-epoch-host-<channel>.json（契约 §3.4.1「纪元必须持久化」）。
        // 固定 channel + 每次新 sid → 第二轮起 host 判「纪元回退」→ 直接拒绝握手。
        val channel = randomChannel()
        val secret = "android-integration-secret-0123456789"

        val relayProcess = startNode(relay, emptyList(), mapOf("PORT" to port.toString(), "LOG_LEVEL" to "error"))
        // 中继先起来，再拉 mock host（否则 host 首次连接会失败并进入退避）
        awaitPort(port, timeoutMs = 15_000)
        val hostProcess = startNode(mockHost, listOf(relayUrl, channel, secret), emptyMap())
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val link = DshrcLink(scope, listener = listener)

        try {
            link.start(
                LinkConfig(
                    relayUrl = relayUrl,
                    channel = channel,
                    secret = secret,
                    clientName = "android-test",
                    appVersion = "1.0.0",
                    epoch = EpochState(0, -1, "")
                )
            )

            withTimeout(30_000) {
                while (link.getState() != LinkState.ONLINE) delay(50)
            }
            assertEquals(LinkState.ONLINE, link.getState())

            // 等 host 上线（welcome 带对端证明，或 peer-joined 带证明）——
            // 在此之前 peer pv 未知，**不能**发业务帧（AAD 模式会选错）。
            awaitPeerOnline(link, timeoutMs = 20_000)
            delay(300)

            // 1) session.list
            val list = withTimeout(20_000) {
                link.request(Protocol.MSG_SESSION_LIST, buildJsonObject { })
            }
            val sessions = list.arrOrNull("sessions")
            assertNotNull("session.list 应返回 sessions", sessions)
            assertTrue("mock host 至少有一个会话", sessions!!.isNotEmpty())

            // 2) session.create（回 sessionId）
            val created = withTimeout(20_000) {
                link.request(
                    Protocol.MSG_SESSION_CREATE,
                    buildJsonObject { put("title", "android-it") }
                )
            }
            val sessionId = created.str("sessionId")
            assertTrue("session.create 应返回 sessionId", sessionId.isNotEmpty())

            // 3) session.prompt → accepted，并收到 assistant.delta 直播增量
            val prompted = withTimeout(20_000) {
                link.request(
                    Protocol.MSG_SESSION_PROMPT,
                    buildJsonObject {
                        put("sessionId", sessionId)
                        put("text", "hello android")
                    }
                )
            }
            assertTrue("session.prompt 应 accepted", prompted.bool("accepted"))

            var delta = ""
            withTimeout(20_000) {
                while (delta.isEmpty()) {
                    delta = events.firstOrNull { it.topic == Protocol.TOPIC_ASSISTANT_DELTA }
                        ?.eventData?.str("text").orEmpty()
                    if (delta.isEmpty()) delay(50)
                }
            }
            assertTrue("应收到 assistant.delta 增量", delta.isNotEmpty())

            // 4) 审批：mock host 文本含 "approve" 时触发审批瀑布
            val askSession = withTimeout(20_000) {
                link.request(
                    Protocol.MSG_SESSION_PROMPT,
                    buildJsonObject {
                        put("sessionId", sessionId)
                        put("text", "please approve this")
                    }
                )
            }
            assertTrue("第二次 prompt 应 accepted", askSession.bool("accepted"))

            var askId = ""
            withTimeout(20_000) {
                while (askId.isEmpty()) {
                    askId = events.firstOrNull { it.topic == Protocol.TOPIC_APPROVAL_REQUEST }
                        ?.eventData?.str("askId").orEmpty()
                    if (askId.isEmpty()) delay(50)
                }
            }
            assertTrue("应收到 approval.request", askId.isNotEmpty())

            val answered = withTimeout(20_000) {
                link.request(
                    Protocol.MSG_APPROVAL_ANSWER,
                    buildJsonObject {
                        put("askId", askId)
                        put("decision", "approved")
                    }
                )
            }
            assertTrue("approval.answer 应 applied", answered.bool("applied"))
        } finally {
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

    /**
     * 随机合法 channel（契约 §4：`^[A-Z2-7]{16,64}$`，RFC4648 base32，数字只能是 2–7）。
     */
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
        // 保留输出：失败时能看清是 relay 还是 mock host 的问题（写到临时目录，不进仓库）
        val log = File(System.getProperty("java.io.tmpdir"), "dshrc-it-${script.name}-${System.nanoTime()}.log")
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
