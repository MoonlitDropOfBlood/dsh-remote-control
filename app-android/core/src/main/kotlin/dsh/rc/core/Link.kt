/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 链路层：WebSocket 客户端 → 中继（契约 §4 / §3.4.1）。
 *
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/link.ets **逐条对应**（语义 1:1）：
 *  - 连接前先跑 assertKat()（契约 §7 KAT 逐字节自检），失败则不建链
 *  - 连接 / 断线重连（指数退避 1s→60s + 抖动）
 *  - 收到 welcome 前发 hello（v1.1.3：sig = base64url(HMAC-SHA256(key,
 *    "hello2|client|"+channel+"|"+e+"|"+ts+"|"+pv+"|"+sid))，并带 e/ts/pv/sid）
 *  - 30s 无帧发 ping；90s 无任何消息判死并重连
 *  - sid/seq（契约 §4 v1.0.2）：每条 WS 连接（含重连）生成一次 8 位十六进制 sid，
 *    seq 每条连接从 1 开始；接收去重键为 sid+":"+seq（缺 sid 按 "legacy"），
 *    seen 按 sid 分桶（单桶 >4096 裁剪最旧，总桶 >64 淘汰最旧）
 *  - 业务消息收发加解密（AES-256-GCM，iv||ct||tag）
 *  - 请求-响应关联（result{id,ok,value|error}）
 *
 * v1.1.3 会话纪元（契约 §3.4.1，抗重放）：
 *  - 传输层 hello 带 e(纪元)/ts/pv(=2)/sid，证明串覆盖它们（hello2|…）
 *  - 对端证明来自 welcome.peer / peer-joined.peer（中继原样透传）→ 验签 → 判模式 →
 *    钉扎对端 sid → 纪元回退即拒绝连接
 *  - 模式：双方 pv>=2 = 加固（AAD = "dshrc|role|seq|sid"，sid = 发送方自己）；
 *    任一方 pv<2 = 兼容（AAD = "dshrc|role|seq"）
 *  - 业务帧必须在**知道对端 pv 之后**才发（否则双方 AAD 选得不一样）
 *
 * 与 ArkTS 版的实现差异（**语义等价**）：
 *  - JCA 的 AES-GCM / HKDF / HMAC 是**同步**的 → 发送保序（契约 §4 v1.1.7「严格按 seq
 *    递增顺序完成加密并调用 WebSocket send」）由 `sendLock` 临界区保证；
 *    接收保序由 OkHttp 单读线程上的同步解密+分发保证。
 *  - 事件分发在 WS 读线程上**同步**调用 Listener.onEvent（顺序 = WS 到达顺序）。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

/** 链路状态（UI 直接展示）。 */
enum class LinkState {
    IDLE, DERIVING, CONNECTING, HANDSHAKING, ONLINE, RECONNECTING, STOPPED, ERROR
}

/**
 * 会话纪元状态（契约 §3.4.1）：
 *  - self   : 本端自己的纪元（每条新连接 +1，**先持久化再使用**）
 *  - peer   : 已接受的对端最高纪元（-1 = 尚未接受过任何对端证明）
 *  - peerSid: 已钉扎的对端 sid（加固模式下必须与收到的 frame.sid 一致）
 */
data class EpochState(val self: Long, val peer: Long, val peerSid: String)

/** 链路配置（由配对页写入）。 */
data class LinkConfig(
    val relayUrl: String,
    val channel: String,
    val secret: String,
    val relayToken: String = "",
    val clientName: String,
    val appVersion: String,
    /** 纪元状态（由持久化层注入；缺省 = 进程内自增）。 */
    val epoch: EpochState = EpochState(0, -1, ""),
    /** 纪元状态变更回调（**先持久化再使用**的要求由调用方兑现）。 */
    val onEpoch: ((EpochState) -> Unit)? = null
)

/** 主机信息（业务 hello 响应，契约 §5.1）。 */
data class HostInfo(val hostName: String, val dshVersion: String, val pluginVersion: String)

/** 链路事件回调。 */
interface LinkListener {
    fun onState(state: LinkState) {}
    fun onEvent(msg: DshrcMsg) {}
    fun onPeers(hostOnline: Boolean, clientOnline: Boolean) {}
    fun onHello(info: HostInfo) {}
    fun onLog(line: String) {}
}

/** 链路错误（终局/瞬时）。 */
class LinkException(message: String) : Exception(message)

/**
 * DSH 中继链路。状态迁移：
 * idle/deriving → connecting(ws connect) → handshaking(hello/welcome) → online
 * 任意在线态断开 → reconnecting（指数退避）→ connecting …
 * stop() → stopped；配置非法或 hello 被拒 → error。
 */
class DshrcLink(
    private val scope: CoroutineScope,
    private val httpClient: OkHttpClient = defaultHttpClient(),
    listener: LinkListener = object : LinkListener {}
) {

    companion object {
        private const val DEFAULT_REQ_TIMEOUT_MS = 15_000L
        private const val HOST_HELLO_TIMEOUT_MS = 15_000L

        /** v1.3.0：待答交互快照（只读、绝不阻塞瀑布 → 超时给得比其他请求短）。 */
        private const val PENDING_INTERACTIONS_TIMEOUT_MS = 10_000L

        /** v1.3.0：Todo / Goal 快照超时。 */
        private const val TODOS_TIMEOUT_MS = 15_000L
        private const val GOAL_TIMEOUT_MS = 15_000L

        /** v1.3.0：Goal 人类操作超时（宿主 CAS + 落盘）。 */
        private const val GOAL_ACTION_TIMEOUT_MS = 20_000L

        /** 加固模式下连续 sid 不匹配达到该次数 → 重连自愈（契约 §3.4.1 钉扎语义）。 */
        private const val SID_MISMATCH_RECONNECT_THRESHOLD = 3

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // 长连接：不读超时
            .writeTimeout(20, TimeUnit.SECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS) // 心跳由应用层做（契约 §4）
            .build()
    }

    /**
     * 监听者集合（**多监听者**）：会话仓（SessionStore）与 UI（状态/日志）都要收到事件，
     * 单监听者模型会互相顶掉。
     */
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<LinkListener>()

    init {
        listeners.add(listener)
    }

    /** 注册监听者（会话仓自注册用）。 */
    fun addListener(l: LinkListener) {
        listeners.addIfAbsent(l)
    }

    /** 注销监听者。 */
    fun removeListener(l: LinkListener) {
        listeners.remove(l)
    }

    // ---- 运行时状态 ----

    private var ws: WebSocket? = null
    private var key: ByteArray? = null
    private var cfg: LinkConfig? = null
    @Volatile private var shouldRun = false
    @Volatile private var state = LinkState.IDLE

    /** 本条连接的发送序号（契约 §4 v1.0.2：每条连接从 1 开始）。 */
    private var sendSeq = 0L
    /** 本条连接的发送端实例 id（8 位十六进制）。 */
    private var sid = ""

    /** 接收去重桶（契约 §4 v1.0.2）。 */
    private val seen = LinkedHashMap<String, SeenBucket>()

    private var reconnectAttempts = 0
    private var hostOnline = false
    private var clientOnline = false

    private val pending = ConcurrentHashMap<String, PendingRequest>()

    @Volatile private var lastRecvTs = 0L
    @Volatile private var lastSendTs = 0L

    private var heartbeatJob: Job? = null
    private var helloJob: Job? = null
    private var reconnectJob: Job? = null

    private var katChecked = false

    // ---- v1.1.3 会话纪元（契约 §3.4.1） ----
    private var epoch = EpochState(0, -1, "")
    /** 对端握手证明版本 pv（0 = 未知）。 */
    private var peerPv = 0
    /** 是否已知对端 pv（未知时**不能**发业务帧：否则 AAD 模式会选错）。 */
    @Volatile private var peerPvKnown = false
    /** 当前模式：true = 加固（AAD 绑定 sid）。 */
    @Volatile private var hardened = false
    /** 本连接是否已发过业务 hello。 */
    private var businessHelloSent = false
    /** 加固模式下连续 sid 不匹配的帧数。 */
    private var sidMismatchCount = 0

    /** 异步帧世代：停止/断线/新连接后，旧连接的回调一律失效（契约 §4 v1.1.7）。 */
    @Volatile private var connectionGeneration = 0L

    /** 发送保序锁（契约 §4 v1.1.7：严格按 seq 递增顺序加密并发送）。 */
    private val sendLock = Any()

    private class SeenBucket {
        val seqs = LinkedHashSet<Long>()
        val order = ArrayDeque<Long>()
        var last = 0L
    }

    private class PendingRequest(val deferred: kotlinx.coroutines.CompletableDeferred<JsonObject>)

    // ---- 生命周期 ----

    /** 当前链路状态。 */
    fun getState(): LinkState = state

    /** 对端在线状态。 */
    fun isHostOnline(): Boolean = hostOnline

    /** 启动链路：先做 KAT 级密钥派生，再连接。重复调用以最新配置重启。 */
    fun start(cfg: LinkConfig) {
        stopInternal("restart")
        this.cfg = cfg
        this.shouldRun = true
        this.sendSeq = 0
        this.sid = ""
        this.reconnectAttempts = 0
        this.hostOnline = false
        this.clientOnline = false
        this.epoch = cfg.epoch
        this.peerPv = 0
        this.peerPvKnown = false
        this.hardened = false
        this.businessHelloSent = false
        this.sidMismatchCount = 0
        setState(LinkState.DERIVING)
        scope.launch {
            try {
                // 契约 §7：KAT 必须在连接建立前执行；成功后缓存，进程内只跑一次。
                if (!katChecked) {
                    Crypto.assertKat()
                    katChecked = true
                    log("KAT passed (HKDF / AES-256-GCM 与契约 §7 逐字节一致)")
                }
                key = Crypto.deriveKey(cfg.secret, cfg.channel)
            } catch (e: Exception) {
                setState(LinkState.ERROR)
                log("derive key failed: ${e.message}")
                return@launch
            }
            connectOnce()
        }
    }

    /** 停止链路（用户主动断开）。 */
    fun stop() {
        shouldRun = false
        stopInternal("stopped")
        setState(LinkState.STOPPED)
    }

    /**
     * 回前台立即重连：App 在后台时系统可能冻结定时器/挂起套接字，
     * 退避重连最长要等 60s；回前台时跳过剩余退避立即试一次。
     */
    fun kickReconnect() {
        if (!shouldRun || state != LinkState.RECONNECTING) return
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempts = 0
        log("foreground kick: reconnect now")
        connectOnce()
    }

    private fun invalidateAsyncFrames() {
        connectionGeneration++
    }

    private fun stopInternal(reason: String) {
        invalidateAsyncFrames()
        heartbeatJob?.cancel(); heartbeatJob = null
        helloJob?.cancel(); helloJob = null
        reconnectJob?.cancel(); reconnectJob = null
        rejectAll("link closed: $reason")
        val wsRef = ws
        ws = null
        if (wsRef != null) {
            try {
                wsRef.close(1000, reason)
            } catch (e: Exception) {
                log("close exception: ${e.message}")
            }
        }
    }

    // ---- 连接 ----

    /** 一次连接尝试（每次都新建 WebSocket 实例）。 */
    private fun connectOnce() {
        val cfg = this.cfg ?: return
        if (!shouldRun) return
        invalidateAsyncFrames()
        // 契约 §4 v1.0.2：每条 WS 连接（含重连）生成新 sid，seq 从 1 重新开始
        this.sid = newSid()
        this.sendSeq = 0
        // 每条新连接重新判定模式（对端 pv 只能从本连接 welcome/peer-joined 的证明得知）
        this.peerPv = 0
        this.peerPvKnown = false
        this.hardened = false
        this.businessHelloSent = false
        this.sidMismatchCount = 0
        // 契约 §3.4.1：每条新连接纪元 +1，**先持久化再使用**。
        this.epoch = epoch.copy(self = epoch.self + 1)
        persistEpoch()
        setState(if (reconnectAttempts > 0) LinkState.RECONNECTING else LinkState.CONNECTING)

        val generation = connectionGeneration
        val request = Request.Builder().url(cfg.relayUrl).build()
        val socket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation != connectionGeneration) return
                onWsOpen(cfg, generation)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != connectionGeneration) return
                onWsMessage(text, generation)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (generation != connectionGeneration) return
                log("closing: code=$code reason=$reason")
                onWsDown(generation, "closing")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (generation != connectionGeneration) return
                log("closed: code=$code reason=$reason")
                onWsDown(generation, "closed")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation != connectionGeneration) return
                log("error: ${t.message}")
                onWsDown(generation, "error")
            }
        })
        this.ws = socket
    }

    /** WS 已建立：发送中继 hello（契约 §4 + v1.1.3 §3.4.1 纪元证明 v2）。 */
    private fun onWsOpen(cfg: LinkConfig, generation: Long) {
        setState(LinkState.HANDSHAKING)
        lastRecvTs = System.currentTimeMillis()
        lastSendTs = System.currentTimeMillis()
        val key = this.key ?: return
        val epochVal = epoch.self
        val ts = System.currentTimeMillis()
        val pv = Protocol.PROTO_HELLO_V2
        val sidVal = sid
        val sig = Crypto.helloSig2(key, Protocol.ROLE_CLIENT, cfg.channel, epochVal, ts, pv, sidVal)
        val hello = buildJsonObject {
            put("t", Protocol.FRAME_HELLO)
            put("role", Protocol.ROLE_CLIENT)
            put("ch", cfg.channel)
            put("sig", sig)
            put("e", epochVal)
            put("ts", ts)
            put("pv", pv)
            put("sid", sidVal)
            if (cfg.relayToken.isNotEmpty()) put("token", cfg.relayToken)
        }
        sendRelayJson(hello.toString())
        // 10s 内必须收到 welcome，否则判死重连
        helloJob?.cancel()
        helloJob = scope.launch {
            delay(Protocol.HELLO_TIMEOUT_MS)
            if (generation == connectionGeneration && state == LinkState.HANDSHAKING) {
                log("welcome timeout, dropping connection")
                forceReconnect(generation, "welcome-timeout")
            }
        }
    }

    /** 连接下行消息（明文 JSON 中继帧）。 */
    private fun onWsMessage(text: String, generation: Long) {
        lastRecvTs = System.currentTimeMillis()
        val frame = runCatching { DshrcJson.parseToJsonElement(text) as? JsonObject }
            .getOrNull()
        if (frame == null) {
            log("bad relay json, dropped")
            return
        }
        when (frame.str("t")) {
            Protocol.FRAME_WELCOME -> {
                helloJob?.cancel(); helloJob = null
                reconnectAttempts = 0
                handleWelcome(frame, generation)
            }

            Protocol.FRAME_PEER_JOINED -> {
                if (frame.str("role") == Protocol.ROLE_HOST) {
                    hostOnline = true
                    emitPeers()
                    handlePeerJoined(frame, generation)
                }
            }

            Protocol.FRAME_PEER_LEFT -> {
                if (frame.str("role") == Protocol.ROLE_HOST) {
                    hostOnline = false
                    emitPeers()
                    log("host left")
                }
            }

            Protocol.FRAME_FRAME -> onRelayFrame(frame, generation)

            Protocol.FRAME_PING -> sendRelayJson("""{"t":"${Protocol.FRAME_PONG}"}""")

            Protocol.FRAME_PONG -> Unit // lastRecvTs 已更新

            Protocol.FRAME_ERROR -> {
                val code = frame.str("code", "?")
                log("relay error: $code ${frame.str("message")}")
                // 终局错误（契约 §4）：bad-hello / channel-full / replaced —— 重连没有意义
                // （replaced 会「重连→再被顶替」死循环），必须停掉自动重连并落到 error。
                if (code == "bad-hello" || code == "channel-full" || code == "replaced") {
                    shouldRun = false
                    heartbeatJob?.cancel(); heartbeatJob = null
                    helloJob?.cancel(); helloJob = null
                    reconnectJob?.cancel(); reconnectJob = null
                    setState(LinkState.ERROR)
                    hostOnline = false
                    clientOnline = false
                    emitPeers()
                    stopInternal("relay-$code")
                    log("relay terminal error: $code, auto reconnect stopped")
                }
            }

            else -> log("unknown relay frame: ${frame.str("t")}")
        }
    }

    // ---- v1.1.3 会话纪元（契约 §3.4.1） ----

    /**
     * welcome 处理：
     *  - 取对端 hello 证明（`welcome.peer`）→ 验签 → 纪元单调性 → 钉扎 sid；
     *  - 判定模式（双方 pv>=2 = 加固）；**知道对端 pv 之前不发业务帧**；
     *  - 对端在线但没带证明 → 旧端（pv 视为 1）→ 兼容模式。
     */
    private fun handleWelcome(frame: JsonObject, generation: Long) {
        val peers = frame.objOrNull("peers")
        if (peers != null) {
            hostOnline = peers.bool("host")
            clientOnline = peers.bool("client")
        } else {
            log("welcome without peers field (legacy relay), compat mode")
        }
        val proof = frame.objOrNull("peer")
        if (proof != null) {
            if (!acceptPeerProof(proof, generation)) return
        } else if (peers == null || peers.bool("host")) {
            // 对端在线却没带证明 → 旧端（pv 缺省视为 1）→ 兼容模式。
            peerPv = 1
            peerPvKnown = true
            applyMode()
        }
        // 对端离线（peers.host=false）且没有证明 → 对端 pv 未知：**不发业务帧**。
        setState(LinkState.ONLINE)
        startHeartbeat(generation)
        log("online, peers={host=$hostOnline,client=$clientOnline}")
        emitPeers()
        maybeSendBusinessHello(generation)
    }

    /** peer-joined 处理：host 上线时中继带上它的 hello 证明。 */
    private fun handlePeerJoined(frame: JsonObject, generation: Long) {
        val proof = frame.objOrNull("peer")
        if (proof != null) {
            if (!acceptPeerProof(proof, generation)) return
            log("host joined (proof accepted, epoch=${epoch.peer})")
        } else {
            peerPv = 1
            peerPvKnown = true
            applyMode()
            log("host joined (legacy peer, no proof)")
        }
        maybeSendBusinessHello(generation)
    }

    /**
     * 接受对端 hello 证明（契约 §3.4.1）：
     *  1. pv>=2 → 用本端 key 验 v2 证明串；验不过 → **拒绝连接**。
     *  2. 纪元单调性：同一 (e,sid) 重复出现 → 幂等接受；e <= 已接受纪元 → **拒绝连接**。
     *  3. 通过 → 钉扎对端 sid + 持久化「已接受的对端纪元」。
     */
    private fun acceptPeerProof(proof: JsonObject, generation: Long): Boolean {
        val key = this.key ?: return false
        val cfg = this.cfg ?: return false
        val role = proof.str("role").ifEmpty { Protocol.ROLE_HOST }
        val pv = proof.longOrNull("pv")?.toInt() ?: 1
        val epochVal = proof.longOrNull("e") ?: 0
        val ts = proof.longOrNull("ts") ?: 0
        val sidVal = proof.str("sid")
        val sig = proof.str("sig")
        // 1) 验签（只有 pv>=2 才有 v2 证明）
        if (pv >= Protocol.PROTO_HELLO_V2) {
            if (epochVal < 0) {
                rejectPeerProof("proof has bad epoch")
                return false
            }
            if (!Protocol.SID_REGEX.matches(sidVal)) {
                rejectPeerProof("proof has bad sid")
                return false
            }
            if (sig.isEmpty()) {
                rejectPeerProof("proof incomplete (pv>=2 but no sig)")
                return false
            }
            val expect = runCatching {
                Crypto.helloSig2(key, role, cfg.channel, epochVal, ts, pv, sidVal)
            }.getOrElse {
                if (generation != connectionGeneration) return false
                rejectPeerProof("proof verify error")
                return false
            }
            if (generation != connectionGeneration) return false
            if (expect != sig) {
                rejectPeerProof("proof signature mismatch (pv=$pv)")
                return false
            }
        }
        // 2) 纪元单调性（抗回滚）
        val lastEpoch = epoch.peer
        val lastSid = epoch.peerSid
        if (lastEpoch >= 0) {
            if (epochVal == lastEpoch && sidVal == lastSid) {
                // 同一份证明重复出现（welcome + peer-joined）→ 幂等接受。
                peerPv = pv
                peerPvKnown = true
                applyMode()
                return true
            }
            if (epochVal <= lastEpoch) {
                rejectPeerProof("peer epoch rollback (e=$epochVal <= accepted $lastEpoch)")
                return false
            }
        }
        // 3) 接受：钉扎 sid + 持久化已接受纪元
        epoch = epoch.copy(peer = epochVal, peerSid = sidVal)
        persistEpoch()
        peerPv = pv
        peerPvKnown = true
        applyMode()
        return true
    }

    /** 拒绝连接（验签失败 / 纪元回退）：终局错误，停止自动重连。 */
    private fun rejectPeerProof(reason: String) {
        log("peer proof rejected: $reason")
        shouldRun = false
        heartbeatJob?.cancel(); heartbeatJob = null
        helloJob?.cancel(); helloJob = null
        reconnectJob?.cancel(); reconnectJob = null
        setState(LinkState.ERROR)
        hostOnline = false
        clientOnline = false
        emitPeers()
        stopInternal("peer-proof-rejected")
    }

    /** 模式判定（契约 §3.4.1）：本端 pv>=2 且对端 pv>=2 = 加固，否则兼容。 */
    private fun applyMode() {
        val before = hardened
        hardened = peerPvKnown && peerPv >= Protocol.PROTO_HELLO_V2
        if (hardened != before) {
            log("mode: ${if (hardened) "hardened (aad bound to sid)" else "compat (legacy aad)"}")
        }
    }

    /** 持久化纪元状态（先持久化再使用——契约 §3.4.1）。 */
    private fun persistEpoch() {
        val cb = cfg?.onEpoch ?: return
        cb(epoch)
    }

    /** 业务 hello 只在**知道对端 pv 之后**发（否则 AAD 模式会与对端选得不一样）。 */
    private fun maybeSendBusinessHello(generation: Long) {
        if (!peerPvKnown || businessHelloSent) return
        businessHelloSent = true
        sendBusinessHello(generation)
    }

    /** 密文帧：按 sid+":"+seq 去重 → 解密 → 有序业务分发；旧世代回调失效。 */
    private fun onRelayFrame(frame: JsonObject, generation: Long) {
        val key = this.key ?: return
        val sidVal = frame.strOrNull("sid") ?: Protocol.SID_LEGACY
        val seq = frame.longOrNull("seq") ?: 0L
        val data = frame.strOrNull("data") ?: ""
        if (seq <= 0 || data.isEmpty()) return
        // 加固模式：帧的 sid 必须等于**已钉扎的对端 sid**，否则丢弃（契约 §3.4.1）。
        if (hardened) {
            val pinned = epoch.peerSid
            if (pinned.isEmpty() || sidVal != pinned) {
                sidMismatchCount++
                log("frame sid not pinned, dropped (mismatch=$sidMismatchCount)")
                if (sidMismatchCount >= SID_MISMATCH_RECONNECT_THRESHOLD) {
                    sidMismatchCount = 0
                    log("too many sid mismatches, reconnecting to re-pin peer")
                    forceReconnect(generation, "sid-mismatch")
                }
                return
            }
            sidMismatchCount = 0
        }
        if (isDuplicate(sidVal, seq)) {
            log("dup frame $sidVal:$seq dropped")
            return
        }
        val plaintext = try {
            if (hardened) Crypto.open(key, Protocol.ROLE_HOST, seq, data, sidVal)
            else Crypto.open(key, Protocol.ROLE_HOST, seq, data)
        } catch (e: Exception) {
            // 认证失败（AAD/密钥不匹配）：丢弃该帧，但不阻塞后续帧。
            log("decrypt failed seq=$seq err=${e.message}")
            return
        }
        if (generation != connectionGeneration) return
        dispatchPlain(plaintext)
    }

    /** 解密后的业务消息：JSON 解析 → 请求-响应关联 / 事件分发。 */
    private fun dispatchPlain(plaintext: String) {
        val obj = runCatching { DshrcJson.parseToJsonElement(plaintext) as? JsonObject }.getOrNull()
        if (obj == null) {
            log("bad business json, dropped")
            return
        }
        val msg = DshrcMsg.fromJson(obj)
        if (deliverResult(msg)) return
        for (l in listeners) l.onEvent(msg)
    }

    /**
     * 接收去重（契约 §4 v1.0.2）：去重键为 sid + ":" + seq（缺 sid 走 "legacy" 桶）。
     * seen 按 sid 分桶：单桶超过 SEEN_BUCKET_MAX 项裁剪最旧；总桶数超限淘汰最久未活动的桶。
     */
    private fun isDuplicate(sidVal: String, seq: Long): Boolean {
        synchronized(seen) {
            var bucket = seen[sidVal]
            if (bucket == null) {
                bucket = SeenBucket()
                seen[sidVal] = bucket
            }
            if (bucket.seqs.contains(seq)) return true
            bucket.seqs.add(seq)
            bucket.order.addLast(seq)
            bucket.last = System.currentTimeMillis()
            while (bucket.order.size > Protocol.SEEN_BUCKET_MAX) {
                val old = bucket.order.removeFirst()
                bucket.seqs.remove(old)
            }
            while (seen.size > Protocol.SEEN_MAX_SIDS) {
                var oldestSid = ""
                var oldestTs = Long.MAX_VALUE
                for ((s, b) in seen) {
                    if (b.last < oldestTs) {
                        oldestTs = b.last
                        oldestSid = s
                    }
                }
                if (oldestSid.isEmpty()) break
                seen.remove(oldestSid)
            }
            return false
        }
    }

    /**
     * 连接下行（断开/出错）：退避重连。
     *  - 终局态（stopped / error / shouldRun=false）**一律不置 reconnecting**。
     */
    private fun onWsDown(generation: Long, reason: String) {
        invalidateAsyncFrames()
        heartbeatJob?.cancel(); heartbeatJob = null
        helloJob?.cancel(); helloJob = null
        reconnectJob?.cancel(); reconnectJob = null
        ws = null
        rejectAll("connection lost: $reason")
        hostOnline = false
        clientOnline = false
        emitPeers()
        if (state == LinkState.STOPPED) return
        if (!shouldRun || cfg == null) {
            if (state != LinkState.ERROR) setState(LinkState.STOPPED)
            return
        }
        reconnectAttempts++
        val cap = min(Protocol.BACKOFF_MAX_MS, Protocol.BACKOFF_BASE_MS * (1L shl (reconnectAttempts - 1).coerceAtMost(30)))
        val jitter = 0.8 + Random.nextDouble() * 0.4
        val delayMs = (cap * jitter).toLong()
        setState(LinkState.RECONNECTING)
        log("reconnect in ${delayMs}ms (attempt $reconnectAttempts)")
        reconnectJob = scope.launch {
            delay(delayMs)
            if (shouldRun) connectOnce()
        }
    }

    /** 主动掐断当前连接并进入重连流程（hello 超时等内部判死用）。 */
    private fun forceReconnect(generation: Long, reason: String) {
        val wsRef = ws
        ws = null
        if (wsRef != null) {
            try {
                wsRef.close(1000, reason)
            } catch (e: Exception) {
                log("force close exception: ${e.message}")
            }
        }
        onWsDown(generation, reason)
    }

    /** 心跳：30s 无帧发 ping；90s 无任何消息判死。 */
    private fun startHeartbeat(generation: Long) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive && generation == connectionGeneration) {
                delay(5_000)
                if (generation != connectionGeneration) return@launch
                if (state != LinkState.ONLINE) continue
                val now = System.currentTimeMillis()
                if (now - lastRecvTs > Protocol.DEAD_TIMEOUT_MS) {
                    log("dead: no message for ${now - lastRecvTs}ms")
                    forceReconnect(generation, "dead")
                    return@launch
                }
                if (now - lastSendTs > Protocol.HEARTBEAT_INTERVAL_MS) {
                    sendRelayJson("""{"t":"${Protocol.FRAME_PING}"}""")
                }
            }
        }
    }

    /**
     * 业务层 hello（契约 §5.1）：payload.sig 用 v1 证明串（旧插件互操作）；
     * v2 证明只用于**传输层** hello 帧。
     *
     * v1.3.0：带 `features: ["session-state-v1"]` → 插件对本客户端启用
     * `pending.interactions` 快照 / Todo / Goal 与 `question.request{state:"continued"}`
     * 的状态更新语义（契约 §5.12 不变量 6）。
     */
    private fun sendBusinessHello(generation: Long) {
        val key = this.key ?: return
        val cfg = this.cfg ?: return
        val sig = Crypto.helloSig(key, Protocol.ROLE_CLIENT, cfg.channel)
        val payload = buildJsonObject {
            put("proto", Protocol.PROTO_VERSION)
            put("clientName", cfg.clientName)
            put("appVersion", cfg.appVersion)
            put("features", JsonArray(Protocol.CLIENT_FEATURES.map { JsonPrimitive(it) }))
            put("sig", sig)
        }
        scope.launch {
            try {
                val v = requestInternal(Protocol.MSG_HELLO, payload, HOST_HELLO_TIMEOUT_MS, generation)
                val info = HostInfo(
                    hostName = v.str("hostName"),
                    dshVersion = v.str("dshVersion"),
                    pluginVersion = v.str("pluginVersion")
                )
                log("host hello: ${info.hostName} ${info.dshVersion}")
                for (l in listeners) l.onHello(info)
            } catch (e: Exception) {
                // host 离线属正常（中继已缓存该帧），只记录
                log("business hello pending/failed: ${e.message}")
            }
        }
    }

    /**
     * 发送一条业务请求并等待 result（resolve 的是 result.value）。
     */
    suspend fun request(
        type: String,
        payload: JsonObject,
        timeoutMs: Long = DEFAULT_REQ_TIMEOUT_MS
    ): JsonObject = requestInternal(type, payload, timeoutMs, connectionGeneration)

    // ---- v1.3.0 契约请求（§5.12 待答交互 / §5.13 Todo / §5.14 Goal） ----

    /**
     * 拉取待答交互快照（契约 §5.1 v1.3.0 `pending.interactions` / §5.12）。
     *
     * **只读恢复通道**：读失败由调用方按「回空数组」处理，绝不能阻塞瀑布（fail-open）。
     * `sessionId` 缺省 = 只回插件仍持有的全局待答项（不做全量冷读）。
     */
    suspend fun requestPendingInteractions(sessionId: String? = null): JsonObject {
        val payload = if (sessionId.isNullOrEmpty()) jsonOf() else jsonOf("sessionId" to sessionId)
        return request(Protocol.MSG_PENDING_INTERACTIONS, payload, PENDING_INTERACTIONS_TIMEOUT_MS)
    }

    /** 拉取会话 Todo 快照（契约 §5.1 v1.3.0 `session.todos` / §5.13）。手机只读。 */
    suspend fun requestSessionTodos(sessionId: String): JsonObject =
        request(Protocol.MSG_SESSION_TODOS, jsonOf("sessionId" to sessionId), TODOS_TIMEOUT_MS)

    /** 拉取会话 Goal 快照（契约 §5.1 v1.3.0 `session.goal` / §5.14）。 */
    suspend fun requestSessionGoal(sessionId: String): JsonObject =
        request(Protocol.MSG_SESSION_GOAL, jsonOf("sessionId" to sessionId), GOAL_TIMEOUT_MS)

    /**
     * 执行 Goal 人类操作（契约 §5.1 v1.3.0 `session.goalAction` / §5.14）。
     *
     * 载荷由 [buildGoalActionPayload] 组装（create 不带 expected，其余必带 `{id,revision}`）。
     */
    suspend fun requestSessionGoalAction(payload: JsonObject): JsonObject =
        request(Protocol.MSG_SESSION_GOAL_ACTION, payload, GOAL_ACTION_TIMEOUT_MS)

    private suspend fun requestInternal(
        type: String,
        payload: JsonObject,
        timeoutMs: Long,
        generation: Long
    ): JsonObject {
        if (state != LinkState.ONLINE) throw LinkException("link not online")
        // 契约 §3.4.1：还不知道对端 pv → 不知道该用哪种 AAD → 不能发业务帧。
        if (!peerPvKnown) throw LinkException("peer mode unknown (host proof not received)")
        val id = UUID.randomUUID().toString()
        val deferred = kotlinx.coroutines.CompletableDeferred<JsonObject>()
        pending[id] = PendingRequest(deferred)
        val msg = DshrcMsg(
            id = id,
            type = type,
            ts = System.currentTimeMillis(),
            payload = payload
        )
        try {
            sealAndSend(msg, generation)
            log("request sent: $type")
        } catch (e: Exception) {
            pending.remove(id)
            log("request failed: $type (${e.message})")
            throw e
        }
        return try {
            withTimeoutCompat(timeoutMs) {
                deferred.await()
            }
        } catch (e: Exception) {
            pending.remove(id)
            log("request timeout/error: $type (${e.message})")
            throw e
        }
    }

    /** result{id,ok,value|error} → 回填 pending。 */
    private fun deliverResult(msg: DshrcMsg): Boolean {
        if (msg.type != Protocol.MSG_RESULT) return false
        val reqId = msg.payload.str("id")
        val p = pending.remove(reqId) ?: return false
        if (msg.payload.bool("ok")) {
            p.deferred.complete(msg.payload.obj("value"))
        } else {
            val err = msg.payload.objOrNull("error")
            val text = if (err != null) "${err.str("code")}: ${err.str("message")}" else "remote error"
            p.deferred.completeExceptionally(LinkException(text))
        }
        return true
    }

    /** 断线时清空所有 pending（全部 reject）。 */
    private fun rejectAll(reason: String) {
        val snapshot = pending.values.toList()
        pending.clear()
        for (p in snapshot) {
            p.deferred.completeExceptionally(LinkException(reason))
        }
    }

    /**
     * 加密并发送一条业务消息（契约 §4 v1.0.2：sid 随帧携带，seq 每条连接从 1 递增）。
     * AAD：兼容模式 = "dshrc|client|seq"；加固模式 = "dshrc|client|seq|" + 本端 sid。
     *
     * 发送保序（契约 §4 v1.1.7）：`sendLock` 临界区内完成 **seq 分配 → 加密 → ws.send**，
     * 保证严格按 seq 递增顺序发送（后一 seq 不得越过前一 seq）。
     */
    private fun sealAndSend(msg: DshrcMsg, generation: Long) {
        val key = this.key ?: throw LinkException("link not ready")
        val wsRef = ws ?: throw LinkException("link not ready")
        if (sid.isEmpty()) throw LinkException("link not ready")
        if (!peerPvKnown) throw LinkException("peer mode unknown")
        synchronized(sendLock) {
            if (generation != connectionGeneration) throw LinkException("stale connection generation")
            sendSeq += 1
            val seq = sendSeq
            val sidVal = sid
            val hardenedNow = hardened
            val plaintext = msg.toJson().toString()
            val data = if (hardenedNow) {
                Crypto.seal(key, Protocol.ROLE_CLIENT, seq, plaintext, null, sidVal)
            } else {
                Crypto.seal(key, Protocol.ROLE_CLIENT, seq, plaintext)
            }
            if (generation != connectionGeneration || ws !== wsRef) throw LinkException("stale connection generation")
            val frame = buildJsonObject {
                put("t", Protocol.FRAME_FRAME)
                put("sid", sidVal)
                put("seq", seq)
                put("data", data)
            }
            wsRef.send(frame.toString())
        }
    }

    /** 发送明文中继帧（hello/ping/pong/frame）。 */
    private fun sendRelayJson(text: String) {
        val wsRef = ws ?: return
        lastSendTs = System.currentTimeMillis()
        try {
            wsRef.send(text)
        } catch (e: Exception) {
            log("send failed: ${e.message}")
            onWsDown(connectionGeneration, "send-failed")
        }
    }

    private fun setState(s: LinkState) {
        state = s
        for (l in listeners) l.onState(s)
    }

    private fun emitPeers() {
        for (l in listeners) l.onPeers(hostOnline, clientOnline)
    }

    internal fun log(line: String) {
        for (l in listeners) l.onLog(line)
    }

    private fun newSid(): String {
        val sb = StringBuilder(Protocol.SID_LEN)
        val rnd = Random(System.nanoTime())
        for (i in 0 until Protocol.SID_LEN) {
            sb.append("0123456789abcdef"[rnd.nextInt(16)])
        }
        return sb.toString()
    }
}

/** DshrcMsg → JsonObject（信封 { id, type, ts, payload }）。 */
internal fun DshrcMsg.toJson(): JsonObject = buildJsonObject {
    put("id", id)
    put("type", type)
    put("ts", ts)
    put("payload", payload)
}

/** 带超时的挂起等待。 */
private suspend fun <T> withTimeoutCompat(timeoutMs: Long, block: suspend () -> T): T =
    kotlinx.coroutines.withTimeout(timeoutMs) { block() }
