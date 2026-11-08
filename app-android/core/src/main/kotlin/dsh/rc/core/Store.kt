/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 会话仓（契约 §5.1 / §5.2 / §5.7 / §5.10 / §5.11）。
 *
 * 移植自 HarmonyOS 版（**语义 1:1**，不改口径）：
 *  - app/entry/src/main/ets/model/sessionstore.ets（会话/审批/提问状态仓）
 *  - app/entry/src/main/ets/model/timeline-reconcile.ts（直播副本与持久历史的对账）
 *  - app/entry/src/main/ets/model/attachment-plan.ts（附件上限与分块规划 → AttachmentPlan.kt）
 *
 * CORE_API.md §2.3 的 10 条行为口径逐条落实：
 *  1) 列表只显示根会话（无 parentSessionId 且 origin != "subagent"）且非 blank，updatedAt 降序；
 *  2) `session.archives` 是归档**全集**快照 → 覆盖各行 archived，不做增量猜测；
 *  3) durable 在前（seq 升序）、直播项（seq = -1）在后（到达顺序）；
 *     历史 steps 与直播 tool.call/tool.result 按 callId 配对去重；
 *  4) 合并历史时**同 key 复用旧实例**（内容更新、展开态保留）——UI 侧用 key 保持条目身份；
 *  5) 交付物图片（source == "deliverable"）**独立成条**，不挂到正在流式的 assistant 消息；
 *  6) 附件-only（正文空）消息合法，不画空气泡；乐观上屏**在 prompt accepted 之后**；
 *  7) 断线恢复 = 权威拉取（history + queue + subagents + model + permission）；
 *  8) 排队列表**只显示 target == "next-turn"**；
 *  9) 手机端**不发** mode；`session.capabilities.busyEnter` 只读展示；
 * 10) `session.create` 回 modelError 时**不得重复创建**（sessionId 照常使用）。
 *
 * 线程模型：链路回调在 WS 读线程上到达，UI 调用在主线程 → 所有内存态改动都走 `lock` 临界区，
 * 对外只暴露不可变快照的 StateFlow。
 */
package dsh.rc.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// =====================================================================================
// 时间线条目（契约 §5.7）
// =====================================================================================

/**
 * 时间线项：一条消息、一个工作步骤或一个思考块。
 *
 * `key` 是**稳定键**：历史消息用宿主消息 id；直播项用 "live-<序号>-<role>"。
 * UI 侧（Compose）必须用 `key` 做列表 item 的 identity —— 合并历史时**同 key 不换条目**。
 */
sealed interface TimelineItem {
    val key: String
}

/** 对话气泡（role = user | assistant；契约 §5.1 ChatMessage / §5.10 图片 / §5.11.4 文件）。 */
data class TimelineMessage(
    override val key: String,
    val id: String,
    /** "user" | "assistant" */
    val role: String,
    val text: String,
    val ts: Long,
    /** 持久序号；直播项 = -1。 */
    val seq: Long,
    /** 消息内图片（契约 §5.10；旧插件不返 → 空列表）。 */
    val images: List<ImageRef> = emptyList(),
    /** 消息内文件（契约 §5.11.4；旧插件不返 → 空列表）。 */
    val files: List<FileRef> = emptyList(),
    /** 是否仍在流式。 */
    val streaming: Boolean = false,
    /** 乐观上屏（本机发出、宿主还没回执）。 */
    val local: Boolean = false,
    /** 本轮错误文案（turn.end status=error；HarmonyOS 版 TimelineItem.errorText）。 */
    val errorText: String = ""
) : TimelineItem {
    /** 纯附件消息（正文为空但有图片/文件）——**不画空气泡**（契约 §5.11.4）。 */
    val isAttachmentOnly: Boolean
        get() = text.isBlank() && (images.isNotEmpty() || files.isNotEmpty())

    /** 交付物图片（契约 §5.10.2）——必须独立成条。 */
    val hasDeliverable: Boolean
        get() = images.any { it.isDeliverable }
}

/** 工作步骤（工具调用；契约 §5.7 StepRecord）。 */
data class TimelineStep(
    override val key: String,
    val callId: String,
    val name: String,
    val arguments: String,
    /** "running" | "ok" | "error" */
    val status: String,
    val resultText: String,
    val errorText: String,
    val ts: Long,
    val seq: Long = -1,
    /** 折叠态（数据侧保存，UI 就地切换）。 */
    var expanded: Boolean = false
) : TimelineItem {
    val isRunning: Boolean get() = status == "running"
}

/** 思考过程块（契约 §5.3 v1.0.7：role="reasoning" 的独立块）。 */
data class TimelineReasoning(
    override val key: String,
    val id: String,
    val text: String,
    val ts: Long,
    val seq: Long = -1,
    /** 折叠态（数据侧保存，UI 就地切换）。 */
    var expanded: Boolean = false,
    /** 是否仍在流式（UI 用它判断「思考块正在流式」）。 */
    val streaming: Boolean = false
) : TimelineItem

/**
 * 时间线分组条目：过程分组 = 连续 reasoning/step；消息打断分组。
 *
 * key 规则：过程组 = "p:" + 组内首条目 key（**不含成员数** → 新增成员不换 key）；
 * 消息条目 = 自身 key。
 *
 * `groupExpanded` 是 **var**：UI 就地切换折叠态（ArkTS 版把折叠态放数据侧，Kotlin 版同理）。
 * 仓库在重建分组时会**承接**上一轮的折叠值（见 SessionStore.buildEntries）。
 */
data class TimelineEntry(
    val key: String,
    /** 是否过程分组（思考 + 工作步骤）。这是条目类型，生命周期内不翻转。 */
    val isProcess: Boolean,
    /** 单项渲染时 = 该条目；分组渲染时 = 组内首个条目。 */
    val head: TimelineItem,
    /** 分组内的条目（思考块 / 工作步骤，按时间顺序）；非分组为空列表。 */
    val members: List<TimelineItem>,
    /** 分组折叠态（默认 false；UI 就地切换）。 */
    var groupExpanded: Boolean,
    /**
     * DSH ProcessGroup.closed：遇到后续 message 时旧组立即关闭并显示完成态。
     * （HarmonyOS 版 TimelineEntry.closed；CORE_API.md 未列，为对齐语义而保留。）
     */
    val closed: Boolean = false
)

/** 仓库层异常（宿主拒绝 / 链路失败 / 返回值缺失）。 */
class StoreException(message: String) : Exception(message)

/**
 * 历史错误归属具体会话（只在该会话详情页展示）；不写全局 lastError。
 *
 * 背景：`session.history` 失败过去写进首页的全局错误条 → 错误横幅跑到首页，
 * 甚至被当成别的会话出错。错误属于**发起这次加载的会话**，详情页自己展示 + 「重新加载」。
 */
data class SessionHistoryError(val sessionId: String, val message: String)

// =====================================================================================
// 会话仓
// =====================================================================================

/**
 * 会话仓：把链路事件与请求合并成 UI 可直接渲染的快照。
 *
 * 用法：`val store = SessionStore.create(scope)`（UI 用 `store.linkRef.start(cfg)` 建链）。
 *
 * 仓库**自己**注册到链路（`link.addListener(this)`）——app 层不需要转发事件；
 * 销毁时调 `store.close()`（内部 `link.removeListener(this)`）。
 */
class SessionStore(
    private val link: DshrcLink,
    private val scope: CoroutineScope
) : LinkListener {

    companion object {
        /** 接线工厂：创建链路 + 仓库（仓库自注册到链路）。 */
        fun create(scope: CoroutineScope): SessionStore {
            val link = DshrcLink(scope, DshrcLink.defaultHttpClient())
            return SessionStore(link, scope)
        }
    }

    // ---- 对外状态（全部是不可变快照） ----

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())

    /** 会话列表：只含根会话且非 blank（按 updatedAt 降序）（契约 §5.3）。 */
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val _archivedSessionIds = MutableStateFlow<Set<String>>(emptySet())

    /** Workspace 归档集合全集（契约 §5.2 `session.archives` 事件 / §5.9）。 */
    val archivedSessionIds: StateFlow<Set<String>> = _archivedSessionIds.asStateFlow()

    private val _linkState = MutableStateFlow(LinkState.IDLE)

    /** 链路状态（UI 直接展示）。 */
    val linkState: StateFlow<LinkState> = _linkState.asStateFlow()

    private val _hostInfo = MutableStateFlow<HostInfo?>(null)

    /** 主机信息（业务 hello 响应；连接信息页展示）。 */
    val hostInfo: StateFlow<HostInfo?> = _hostInfo.asStateFlow()

    private val _busyEnter = MutableStateFlow(Protocol.MODE_QUEUE)

    /** 宿主「繁忙时的发送行为」（契约 §5.1 v1.1.2）——**只读**。 */
    val busyEnter: StateFlow<String> = _busyEnter.asStateFlow()

    private val _lastPromptMode = MutableStateFlow("")

    /**
     * 最近一次 `session.prompt` 的**实际投递模式**（由宿主决定，不是手机端选的）：
     * [Protocol.MODE_QUEUE] / [Protocol.MODE_STEER]；空串 = 还没发过。
     * 繁忙时本地不插气泡（口径 #6），UI 靠它提示「已排队发送 / 已插话发送」。
     */
    val lastPromptMode: StateFlow<String> = _lastPromptMode.asStateFlow()

    private val _activeSessionId = MutableStateFlow<String?>(null)

    /** 当前会话 id（null = 未打开）。 */
    val activeSessionId: StateFlow<String?> = _activeSessionId.asStateFlow()

    private val _timeline = MutableStateFlow<List<TimelineItem>>(emptyList())

    /** 详情页唯一数据源（契约 §5.7）。 */
    val timeline: StateFlow<List<TimelineItem>> = _timeline.asStateFlow()

    private val _entries = MutableStateFlow<List<TimelineEntry>>(emptyList())

    /** 分组后的时间线（过程分组 = 连续 reasoning/step）。 */
    val entries: StateFlow<List<TimelineEntry>> = _entries.asStateFlow()

    private val _queueItems = MutableStateFlow<List<QueueItem>>(emptyList())

    /** 待执行消息：**只显示 target == "next-turn"**（契约 §5.2 v1.1.2）。 */
    val queueItems: StateFlow<List<QueueItem>> = _queueItems.asStateFlow()

    private val _subagents = MutableStateFlow<List<SubagentInfo>>(emptyList())

    /** 当前会话的直接子代理目录（契约 §5.6）。 */
    val subagents: StateFlow<List<SubagentInfo>> = _subagents.asStateFlow()

    private val _sessionModel = MutableStateFlow<ModelSelection?>(null)

    /** 当前会话的模型 / 思考强度（null = 插件无记录 → 回退目录默认）。 */
    val sessionModel: StateFlow<ModelSelection?> = _sessionModel.asStateFlow()

    private val _sessionPermission = MutableStateFlow<String?>(null)

    /** 当前会话权限；"custom" 是宿主派生态，只展示。 */
    val sessionPermission: StateFlow<String?> = _sessionPermission.asStateFlow()

    private val _capabilities = MutableStateFlow<Capabilities?>(null)

    /** 新建会话能力目录（null = 宿主不支持 → 隐藏选择区）。 */
    val capabilities: StateFlow<Capabilities?> = _capabilities.asStateFlow()

    private val _attachmentCaps = MutableStateFlow<AttachmentCaps?>(null)

    /** 附件能力目录（null = 宿主不支持 → 隐藏附件入口）。 */
    val attachmentCaps: StateFlow<AttachmentCaps?> = _attachmentCaps.asStateFlow()

    private val _approvals = MutableStateFlow<List<ApprovalRequest>>(emptyList())

    /** 待审批卡片（契约 §5.2 / §5.5）。 */
    val approvals: StateFlow<List<ApprovalRequest>> = _approvals.asStateFlow()

    private val _questions = MutableStateFlow<List<QuestionRequest>>(emptyList())

    /** 待回答卡片（契约 §5.2 / §5.4）。 */
    val questions: StateFlow<List<QuestionRequest>> = _questions.asStateFlow()

    private val _lastError = MutableStateFlow("")

    /** 最近一次错误文案（UI 提示用；成功路径自动清空）。 */
    val lastError: StateFlow<String> = _lastError.asStateFlow()

    private val _historyError = MutableStateFlow<SessionHistoryError?>(null)

    /**
     * 历史错误归属具体会话（只在该会话详情页展示）；不写全局 lastError。
     *
     * null = 当前没有历史加载错误（链路断开 / 加载成功都会清空）。
     */
    val historyError: StateFlow<SessionHistoryError?> = _historyError.asStateFlow()

    private val _logLines = MutableStateFlow<List<String>>(emptyList())

    /** 链路日志（最近若干条，About 页展示）。 */
    val logLines: StateFlow<List<String>> = _logLines.asStateFlow()

    // ---- 内部状态 ----

    /** 链路实例（UI 用它 start(cfg) / stop()）。 */
    val linkRef: DshrcLink get() = link

    private val lock = Any()

    /** 全部会话（含 subagent / blank，按 sessionId 索引）。 */
    private val allSessions = LinkedHashMap<String, SessionSummary>()

    /** 归档集合全集（宿主权威）。 */
    private val archivedIds = LinkedHashSet<String>()

    /** 每会话时间线条目（直播项在末尾，durable 在前）。 */
    private val itemCache = LinkedHashMap<String, MutableList<TimelineItem>>()

    /** 每会话历史翻页元数据。 */
    private val histMeta = LinkedHashMap<String, HistMeta>()

    /** 每会话当前模型（源：session.model 请求 / session.modelChanged 事件）。 */
    private val modelCache = LinkedHashMap<String, ModelSelection>()

    /** 每会话当前权限。 */
    private val permissionCache = LinkedHashMap<String, String>()

    /** 每会话待执行消息（源：session.queue 事件 / session.queue 请求）。 */
    private val queueCache = LinkedHashMap<String, List<QueueItem>>()

    /** 每父会话的子代理目录。 */
    private val subagentCache = LinkedHashMap<String, List<SubagentInfo>>()

    /** 大图内存缓存（key = imageId + '@' + maxEdge）。 */
    private val imageCache = LinkedHashMap<String, FetchedImage>()

    /** 步骤 / 思考块的展开态（key = 条目 key）。 */
    private val expandedItems = LinkedHashSet<String>()

    /** 过程分组的展开态（key = 分组 key）。 */
    private val expandedGroups = LinkedHashSet<String>()

    /** 上一轮的过程分组条目（承接 UI 的就地折叠切换）。 */
    private val entryCache = LinkedHashMap<String, TimelineEntry>()

    /** 直播项序号（单调递增 → 同 role 多条也不撞键）。 */
    private var liveSeq = 0L

    /** 历史请求在途标记（并发刷新合并到同一次）。 */
    private var historyLoadingFlag = false

    private val _historyLoading = MutableStateFlow(false)

    /** 历史正在加载（详情页据此禁用「重新加载」按钮）。 */
    val historyLoading: StateFlow<Boolean> = _historyLoading.asStateFlow()

    /** 历史请求在途时被合并的尾随刷新：sid → 是否向前翻页。 */
    private val pendingHistory = LinkedHashMap<String, Boolean>()

    /** 上一次处理过的链路状态（去重，避免链路回调与轮询重复触发）。 */
    private var lastLinkState: LinkState = LinkState.IDLE

    /** 链路状态轮询任务（close() 时取消）。 */
    private var pollJob: Job? = null

    /** 历史翻页元数据。 */
    private class HistMeta {
        var loaded: Boolean = false
        var hasMore: Boolean = false
        var oldestSeq: Long = 0L
    }

    init {
        // 仓库自己注册到链路 —— app 层不需要转发事件。
        link.addListener(this)
        // 兜底：链路状态轮询（即便宿主实现漏发状态变化，linkState 与断线恢复也照常工作）。
        pollJob = scope.launch {
            while (isActive) {
                onState(link.getState())
                delay(LINK_POLL_INTERVAL_MS)
            }
        }
    }

    /** 释放：注销链路监听 + 停轮询（UI 销毁时调用）。 */
    fun close() {
        link.removeListener(this)
        pollJob?.cancel()
        pollJob = null
    }

    // =================================================================================
    // 链路回调（LinkListener）
    // =================================================================================

    /** 链路状态变化。 */
    override fun onState(state: LinkState) {
        val changed = synchronized(lock) {
            if (state == lastLinkState) return
            lastLinkState = state
            _linkState.value = state
            true
        }
        if (!changed) return
        when (state) {
            LinkState.ONLINE -> scope.launch { onLinkOnline() }
            LinkState.IDLE, LinkState.STOPPED -> clearHostState()
            LinkState.ERROR -> setLastError("连接错误（详见链路日志）")
            else -> Unit
        }
    }

    /** 业务事件（契约 §5.2 全部 topic）。 */
    override fun onEvent(msg: DshrcMsg) {
        if (msg.type != Protocol.MSG_EVENT) return
        val topic = msg.topic
        val data = msg.eventData
        var reloadHistorySid: String? = null
        synchronized(lock) {
            reloadHistorySid = handleEventLocked(topic, data)
        }
        // 队列项被消费 → 补拉一次权威历史（必须在锁外发起请求）。
        reloadHistorySid?.let { sid -> scope.launch { refreshHistory(sid, prepend = false) } }
    }

    /** 业务 hello 回包（主机信息）。 */
    override fun onHello(info: HostInfo) {
        synchronized(lock) { _hostInfo.value = info }
    }

    /** 链路日志行。 */
    override fun onLog(line: String) {
        synchronized(lock) {
            val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                .format(java.util.Date())
            val head = listOf("[$stamp] $line")
            _logLines.value = head + _logLines.value.take(LOG_KEEP - 1)
        }
    }

    /** 对端在线状态（链路状态 ONLINE 已表达，保留回调位）。 */
    override fun onPeers(hostOnline: Boolean, clientOnline: Boolean) {
        // 中继只转发密文；对端在线状态由 LinkState.ONLINE 表达。
    }

    // =================================================================================
    // 会话列表
    // =================================================================================

    /** 拉取会话列表（连接成功 / 下拉刷新）。失败静默（列表保持原样）。 */
    suspend fun loadSessions() {
        val value = try {
            link.request(Protocol.MSG_SESSION_LIST, jsonOf())
        } catch (e: Exception) {
            setLastError("刷新会话列表失败：" + (e.message ?: ""))
            return
        }
        val list = value.arrOrNull("sessions")
            ?.mapNotNull { (it as? JsonObject)?.let(SessionSummary::fromJson) }
            ?: emptyList()
        synchronized(lock) {
            applySessionList(list)
            _lastError.value = ""
        }
    }

    /** session.list 结果整体替换 + 归档集合合并 + 缓存清理。 */
    private fun applySessionList(list: List<SessionSummary>) {
        allSessions.clear()
        for (s in list) {
            allSessions[s.sessionId] = s
            // wire 自带 archived 时并入归档集合（session.archives 事件才是全集权威）。
            if (s.archived) archivedIds.add(s.sessionId)
        }
        pruneCache()
        refreshSessionsFlow()
    }

    /** 归档集合变化（契约 §5.2 `session.archives`：**全集**快照 → 覆盖，不做增量猜测）。 */
    private fun applyArchivedSet(ids: List<String>) {
        archivedIds.clear()
        archivedIds.addAll(ids)
        refreshSessionsFlow()
    }

    /** 会话列表投影：只显示根会话且非 blank，updatedAt 降序。 */
    private fun refreshSessionsFlow() {
        val out = allSessions.values
            .filter { it.isRootVisible }
            .sortedByDescending { it.updatedAt }
            .map { it.copy(archived = archivedIds.contains(it.sessionId)) }
        _sessions.value = out
        _archivedSessionIds.value = LinkedHashSet(archivedIds)
    }

    /** 某会话摘要（列表里查）。 */
    fun sessionOf(sessionId: String): SessionSummary? = synchronized(lock) { allSessions[sessionId] }

    /** 某会话是否运行中。 */
    fun runningOf(sessionId: String): Boolean = synchronized(lock) {
        allSessions[sessionId]?.running == true
    }

    /** 会话标题（详情页标题栏兜底）。 */
    fun titleOf(sessionId: String): String {
        val row = synchronized(lock) { allSessions[sessionId] }
        if (row != null && row.title.isNotEmpty()) return row.title
        return if (sessionId.length > 8) sessionId.substring(0, 8) + "…" else sessionId
    }

    /** 会话被移除后清缓存；活动会话被删则退回空。 */
    private fun pruneCache() {
        val alive = allSessions.keys.toSet()
        val stale = itemCache.keys.filter { !alive.contains(it) }
        for (k in stale) {
            itemCache.remove(k)
            histMeta.remove(k)
            queueCache.remove(k)
            permissionCache.remove(k)
            subagentCache.remove(k)
        }
        val active = _activeSessionId.value
        if (active != null && !alive.contains(active)) {
            _activeSessionId.value = null
            publishTimeline(emptyList())
            _queueItems.value = emptyList()
            _subagents.value = emptyList()
            _sessionModel.value = null
            _sessionPermission.value = null
        }
    }

    // =================================================================================
    // 当前会话
    // =================================================================================

    /**
     * 打开会话：切投影 + 拉权威数据（history + queue + subagents + model + permission）。
     */
    suspend fun openSession(sessionId: String) {
        synchronized(lock) {
            _activeSessionId.value = sessionId
            _sessionModel.value = modelCache[sessionId]
            _sessionPermission.value = permissionCache[sessionId]
            _subagents.value = subagentCache[sessionId] ?: emptyList()
            _queueItems.value = nextTurnItems(queueCache[sessionId])
            val items = itemCache.getOrPut(sessionId) { ArrayList() }
            publishTimeline(items.toList())
        }
        if (sessionId.isEmpty()) return
        refreshHistory(sessionId, prepend = false)
        loadQueue(sessionId)
        loadSubagents(sessionId)
        loadSessionModel(sessionId)
        loadSessionPermission(sessionId)
    }

    /** 关闭会话（清空投影，保留缓存以便快速切回）。 */
    suspend fun closeSession() {
        synchronized(lock) {
            _activeSessionId.value = null
            publishTimeline(emptyList())
            _queueItems.value = emptyList()
            _subagents.value = emptyList()
            _sessionModel.value = null
            _sessionPermission.value = null
        }
    }

    // =================================================================================
    // 审批 / 提问
    // =================================================================================

    /** 提交审批决定（契约 §5.1 approval.answer；applied=false 表示已超时由桌面端处理）。 */
    suspend fun answerApproval(askId: String, decision: String, note: String = ""): Boolean {
        val payload = buildJsonObject {
            put("askId", askId)
            put("decision", decision)
            if (note.isNotEmpty()) put("note", note)
        }
        val value = try {
            link.request(Protocol.MSG_APPROVAL_ANSWER, payload)
        } catch (e: Exception) {
            setLastError("提交审批失败：" + (e.message ?: ""))
            return false
        }
        val applied = value.bool("applied")
        if (applied) {
            synchronized(lock) { _approvals.value = _approvals.value.filter { it.askId != askId } }
        } else {
            setLastError("审批已超时，桌面端已处理")
        }
        return applied
    }

    /** 提交提问回答（契约 §5.1 question.answer；answers 见 §5.4）。 */
    suspend fun answerQuestion(
        askId: String,
        answers: Map<String, String>,
        freeText: String = ""
    ): Boolean {
        val payload = buildJsonObject {
            put("askId", askId)
            put("answers", mapToJson(answers))
            if (freeText.isNotEmpty()) put("freeText", freeText)
        }
        val value = try {
            link.request(Protocol.MSG_QUESTION_ANSWER, payload)
        } catch (e: Exception) {
            setLastError("提交回答失败：" + (e.message ?: ""))
            return false
        }
        val applied = value.bool("applied")
        if (applied) {
            synchronized(lock) { _questions.value = _questions.value.filter { it.askId != askId } }
        } else {
            setLastError("提问已超时，桌面端已处理")
        }
        return applied
    }

    // =================================================================================
    // 会话操作
    // =================================================================================

    /**
     * 发送提示词（契约 §5.1 session.prompt）。
     *
     * - **不发 mode**：投递行为由宿主设置决定，手机端只跟随（口径 #9）；
     * - `uploads` = 已 `attachment.upload.commit` 的 uploadId 列表（契约 §5.11.3）。
     *
     * 上屏策略（口径 #6，与 HarmonyOS 版同款）：**本地乐观气泡在发请求之前落位**。
     *
     * 宿主回 `accepted` 之前可能已经把本轮的 `assistant.delta` 推到手机（插件端
     * `#rSessionPrompt` 先 await 宿主 prompt、之后才回包），若等 `accepted` 回来再补气泡，
     * 气泡会落在流式回复的**中间**——同一条回复被切成两个气泡（用户气泡夹在两半中间）。
     * 先落位则气泡必然排在本轮所有宿主增量之前，顺序恒定。
     *
     * - **空闲**（发请求前的忙闲快照为 false）：乐观气泡先落位；
     * - **繁忙**：**不**插主时间线——宿主可能正在输出当前 turn，插进去会把同一条流式回复
     *   切成两个气泡；排队消息由宿主 `session.queue` 展示，被消费后由权威历史展示；
     * - 宿主拒收 / 请求失败 → **回滚**刚落位的气泡（口径 #6：宿主不收就不留重复气泡）。
     */
    suspend fun sendPrompt(
        sessionId: String,
        text: String,
        uploads: List<String> = emptyList(),
        images: List<ImageRef> = emptyList(),
        files: List<FileRef> = emptyList()
    ): Boolean {
        // 只记会话坐标与长度，**不记提示词原文**（用户内容不进日志）
        link.log("sendPrompt: sessionId=$sessionId len=${text.length} uploads=${uploads.size}")
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("text", text)
            if (uploads.isNotEmpty()) {
                put("uploads", JsonArray(uploads.map { JsonPrimitive(it) }))
            }
        }
        // 忙闲快照必须取在**发请求之前**：请求往返期间宿主可能已经开始下一轮。
        val busy = runningOf(sessionId)
        // 乐观气泡：正文为空且没有本地附件时不画空气泡（附件-only 消息由宿主副本补齐）。
        val showBubble = text.isNotBlank() || images.isNotEmpty() || files.isNotEmpty()
        // 空闲 → 先落位（顺序铁律）；繁忙 → 不插主时间线（见 KDoc）。
        val localKey = if (!busy && showBubble) {
            synchronized(lock) { pushLocalUser(sessionId, text, images, files) }
        } else {
            null
        }
        val value = try {
            link.request(Protocol.MSG_SESSION_PROMPT, payload)
        } catch (e: Exception) {
            rollbackLocalUser(sessionId, localKey)
            setLastError("发送失败：" + (e.message ?: ""))
            return false
        }
        val result = PromptResult.fromJson(value)
        if (!result.accepted) {
            rollbackLocalUser(sessionId, localKey)
            setLastError("宿主未接受这条消息")
            return false
        }
        _lastPromptMode.value = result.mode
        return true
    }

    /** 取消当前运行的 turn（契约 §5.1 session.cancel）。 */
    suspend fun cancelTurn(sessionId: String): Boolean {
        val value = try {
            link.request(Protocol.MSG_SESSION_CANCEL, jsonOf("sessionId" to sessionId))
        } catch (e: Exception) {
            setLastError("取消失败：" + (e.message ?: ""))
            return false
        }
        return value.bool("cancelled")
    }

    /**
     * 新建会话（契约 §5.1 session.create）。
     *
     * 返回的 `modelError` 表示**会话已创建但模型设置失败**——调用方提示「已用默认模型」
     * 并继续发首条内容，**不得重复创建**（口径 #10）。
     */
    suspend fun createSession(
        title: String,
        agentPreset: String?,
        permission: String?,
        cwd: String?,
        model: ModelSelection?
    ): CreateResult {
        val payload = buildJsonObject {
            if (title.isNotEmpty()) put("title", title)
            if (!agentPreset.isNullOrEmpty()) put("agentPreset", agentPreset)
            if (!permission.isNullOrEmpty()) put("permission", permission)
            if (!cwd.isNullOrEmpty()) put("cwd", cwd)
            if (model != null) put("model", model.toJson())
        }
        val value = try {
            link.request(Protocol.MSG_SESSION_CREATE, payload)
        } catch (e: Exception) {
            throw StoreException("新建会话失败：" + (e.message ?: ""))
        }
        return CreateResult.fromJson(value)
    }

    /**
     * 归档 / 恢复会话（契约 §5.9 Workspace **真实**归档）。
     * 宿主拒绝 → 返回 false（**不得本机假成功**）。
     */
    suspend fun setArchived(sessionId: String, archived: Boolean): Boolean {
        if (sessionId.isEmpty()) return false
        val type = if (archived) Protocol.MSG_SESSION_ARCHIVE else Protocol.MSG_SESSION_UNARCHIVE
        val payload = if (archived) {
            jsonOf("sessionId" to sessionId, "stopActivity" to false)
        } else {
            jsonOf("sessionId" to sessionId)
        }
        val value = try {
            link.request(type, payload)
        } catch (e: Exception) {
            setLastError("归档操作失败：" + (e.message ?: ""))
            return false
        }
        val ok = value.bool("archived") == archived
        if (ok) {
            synchronized(lock) {
                if (archived) archivedIds.add(sessionId) else archivedIds.remove(sessionId)
                refreshSessionsFlow()
            }
        }
        return ok
    }

    /** 会话中切换模型 / 思考强度（契约 §5.1 v1.0.8 session.selectModel）。 */
    suspend fun selectModel(sessionId: String, model: ModelSelection): ModelSelection {
        val payload = jsonOf("sessionId" to sessionId, "model" to model.toJson())
        val value = try {
            link.request(Protocol.MSG_SESSION_SELECT_MODEL, payload)
        } catch (e: Exception) {
            throw StoreException("切换模型失败：" + (e.message ?: ""))
        }
        val applied = value.objOrNull("model")?.let(ModelSelection::fromJson)
            ?: throw StoreException("主机未返回模型结果")
        synchronized(lock) {
            modelCache[sessionId] = applied
            if (sessionId == _activeSessionId.value) _sessionModel.value = applied
        }
        return applied
    }

    /** 根会话切换权限（契约 §5.1 v1.1.7 session.selectPermission）。 */
    suspend fun selectPermission(sessionId: String, permission: String): String {
        if (sessionId.isEmpty() || permission.isEmpty()) return ""
        val payload = jsonOf("sessionId" to sessionId, "permission" to permission)
        val value = try {
            link.request(Protocol.MSG_SESSION_SELECT_PERMISSION, payload)
        } catch (e: Exception) {
            throw StoreException("切换权限失败：" + (e.message ?: ""))
        }
        val applied = value.str("permission")
        if (applied.isEmpty()) throw StoreException("主机未返回权限结果")
        synchronized(lock) {
            permissionCache[sessionId] = applied
            if (sessionId == _activeSessionId.value) _sessionPermission.value = applied
        }
        return applied
    }

    /** 拉取图片大图（契约 §5.1 image.fetch / §5.10）。失败抛 StoreException（图片可选，不阻塞会话）。 */
    suspend fun fetchImage(imageId: String, maxEdge: Int = IMAGE_FETCH_DEFAULT_MAX_EDGE): FetchedImage {
        if (imageId.isEmpty()) throw StoreException("imageId 为空")
        var edge = if (maxEdge <= 0) IMAGE_FETCH_DEFAULT_MAX_EDGE else maxEdge
        if (edge > IMAGE_FETCH_MAX_EDGE) edge = IMAGE_FETCH_MAX_EDGE
        val key = imageId + "@" + edge
        synchronized(lock) { imageCache[key] }?.let { return it }
        val value = try {
            link.request(
                Protocol.MSG_IMAGE_FETCH,
                jsonOf("imageId" to imageId, "maxEdge" to edge),
                IMAGE_FETCH_TIMEOUT_MS
            )
        } catch (e: Exception) {
            throw StoreException("拉取大图失败：" + (e.message ?: ""))
        }
        val image = FetchedImage.fromJson(value)
        if (image.dataUri.isEmpty()) throw StoreException("大图数据为空")
        synchronized(lock) { putImageCache(key, image) }
        return image
    }

    /** 拉取该会话的待执行消息快照（契约 §5.2 v1.1.2）。 */
    suspend fun loadQueue(sessionId: String) {
        if (sessionId.isEmpty()) return
        val value = try {
            link.request(Protocol.MSG_SESSION_QUEUE, jsonOf("sessionId" to sessionId), QUEUE_TIMEOUT_MS)
        } catch (e: Exception) {
            // 旧插件无此请求 → 队列显示为空（不报错，不阻塞会话）
            return
        }
        val items = value.arrOrNull("items")
            ?.mapNotNull { (it as? JsonObject)?.let(QueueItem::fromJson) }
            ?: emptyList()
        synchronized(lock) { applyQueueSnapshot(sessionId, items) }
    }

    /** 向 continuable 子代理发消息（契约 §5.1 v1.0.5 session.subagentPrompt）。 */
    suspend fun subagentPrompt(parentSessionId: String, childSessionId: String, text: String): Boolean {
        val payload = jsonOf(
            "parentSessionId" to parentSessionId,
            "childSessionId" to childSessionId,
            "text" to text
        )
        val value = try {
            link.request(Protocol.MSG_SESSION_SUBAGENT_PROMPT, payload)
        } catch (e: Exception) {
            setLastError("发给子代理失败：" + (e.message ?: ""))
            return false
        }
        return value.bool("accepted")
    }

    /** 取消 continuable 子代理当前 turn（契约 §5.1 v1.0.5 session.subagentCancel）。 */
    suspend fun subagentCancel(parentSessionId: String, childSessionId: String): Boolean {
        val payload = jsonOf("parentSessionId" to parentSessionId, "childSessionId" to childSessionId)
        val value = try {
            link.request(Protocol.MSG_SESSION_SUBAGENT_CANCEL, payload)
        } catch (e: Exception) {
            setLastError("取消子代理失败：" + (e.message ?: ""))
            return false
        }
        return value.bool("accepted")
    }

    // =================================================================================
    // 折叠态（数据侧保存，UI 不放组件本地状态）
    // =================================================================================

    /** 展开 / 收起某个步骤或思考块（UI 就地改 `expanded` 也行；此方法是兜底入口）。 */
    fun setItemExpanded(key: String, expanded: Boolean) {
        synchronized(lock) {
            if (expanded) expandedItems.add(key) else expandedItems.remove(key)
            val sid = _activeSessionId.value ?: return
            val items = itemCache[sid] ?: return
            val updated = applyExpandedFlags(items)
            items.clear()
            items.addAll(updated)
            publishTimeline(updated)
        }
    }

    /** 展开 / 收起某个过程分组（UI 就地改 `entry.groupExpanded` 也行；此方法是兜底入口）。 */
    fun setGroupExpanded(key: String, expanded: Boolean) {
        synchronized(lock) {
            if (expanded) expandedGroups.add(key) else expandedGroups.remove(key)
            entryCache[key]?.groupExpanded = expanded
            val sid = _activeSessionId.value ?: return
            val items = itemCache[sid] ?: return
            publishTimeline(items)
        }
    }

    private fun applyExpandedFlags(items: List<TimelineItem>): List<TimelineItem> = items.map { it ->
        when (it) {
            is TimelineStep -> it.copy(expanded = expandedItems.contains(it.key))
            is TimelineReasoning -> it.copy(expanded = expandedItems.contains(it.key))
            else -> it
        }
    }

    // =================================================================================
    // 断线恢复（口径 #7：宿主会话日志是唯一事实源）
    // =================================================================================

    /**
     * 断线恢复 = **权威拉取**：对活动会话重拉 history + queue + subagents + model + permission。
     * 中继的离线缓存只覆盖「手机掉线但中继活着」的短窗，不能当事实源。
     */
    suspend fun onLinkOnline() {
        if (link.getState() != LinkState.ONLINE) return
        loadSessions()
        loadCapabilities()
        val sid = synchronized(lock) { _activeSessionId.value } ?: return
        refreshHistory(sid, prepend = false)
        loadQueue(sid)
        loadSessionModel(sid)
        loadSessionPermission(sid)
        val row = synchronized(lock) { allSessions[sid] }
        if (row == null || row.parentSessionId.isNullOrEmpty()) {
            loadSubagents(sid)
        }
    }

    // =================================================================================
    // 能力目录 / 模型 / 权限 / 子代理
    // =================================================================================

    /** 拉取「模式 / 权限 / 模型」目录与真实归档能力标记（契约 §5.8）。失败静默。 */
    suspend fun loadCapabilities() {
        val value = try {
            link.request(Protocol.MSG_SESSION_CAPABILITIES, jsonOf(), CAPS_TIMEOUT_MS)
        } catch (e: Exception) {
            // 旧插件无此请求 → 目录为空（客户端隐藏选择区，不报错）
            synchronized(lock) {
                _capabilities.value = null
                _attachmentCaps.value = null
                _busyEnter.value = Protocol.MODE_QUEUE
            }
            return
        }
        val caps = Capabilities.fromJson(value)
        synchronized(lock) {
            _capabilities.value = caps
            _attachmentCaps.value = caps.attachments
            _busyEnter.value = caps.busyEnter
        }
    }

    /** 查询会话当前模型（契约 §5.1 v1.0.8）。插件无记录 → null（UI 回退目录默认）。 */
    suspend fun loadSessionModel(sessionId: String) {
        if (sessionId.isEmpty()) return
        val value = try {
            link.request(Protocol.MSG_SESSION_MODEL, jsonOf("sessionId" to sessionId))
        } catch (e: Exception) {
            return
        }
        val selection = value.objOrNull("model")?.let(ModelSelection::fromJson)
        synchronized(lock) {
            if (selection == null) modelCache.remove(sessionId) else modelCache[sessionId] = selection
            if (sessionId == _activeSessionId.value) _sessionModel.value = selection
        }
    }

    /** 查询会话当前权限（契约 §5.1 v1.1.7）。custom 为派生态，原样返回供只读展示。 */
    suspend fun loadSessionPermission(sessionId: String) {
        if (sessionId.isEmpty()) return
        val value = try {
            link.request(Protocol.MSG_SESSION_PERMISSION, jsonOf("sessionId" to sessionId))
        } catch (e: Exception) {
            return
        }
        val permission = value.strOrNull("permission")
        synchronized(lock) {
            if (permission == null) permissionCache.remove(sessionId)
            else permissionCache[sessionId] = permission
            if (sessionId == _activeSessionId.value) _sessionPermission.value = permission
        }
    }

    /** 父会话的直接子代理目录（契约 §5.1 v1.0.5）。失败静默。 */
    suspend fun loadSubagents(parentSessionId: String) {
        if (parentSessionId.isEmpty()) return
        val value = try {
            link.request(
                Protocol.MSG_SESSION_SUBAGENTS,
                jsonOf("sessionId" to parentSessionId),
                SUBAGENTS_TIMEOUT_MS
            )
        } catch (e: Exception) {
            return
        }
        val list = value.arrOrNull("subagents")
            ?.mapNotNull { (it as? JsonObject)?.let(SubagentInfo::fromJson) }
            ?: emptyList()
        synchronized(lock) {
            subagentCache[parentSessionId] = list
            if (parentSessionId == _activeSessionId.value) _subagents.value = list
        }
    }

    // =================================================================================
    // 历史（契约 §5.1 session.history）
    // =================================================================================

    /**
     * 详情页只读**自己**会话的历史错误（空串 = 没有错误，或错误属于别的会话）。
     *
     * 错误归属会话，避免首页错误条抢走详情页的错误（HarmonyOS 2026-11-08 口径）。
     */
    fun historyErrorFor(sessionId: String): String = synchronized(lock) {
        val err = _historyError.value
        if (err != null && err.sessionId == sessionId) err.message else ""
    }

    /** 重新拉该会话最新一页历史（详情页「重新加载」按钮）。 */
    fun retryHistory(sessionId: String) {
        if (sessionId.isEmpty()) return
        scope.launch { refreshHistory(sessionId, prepend = false) }
    }

    /** 写 / 清该会话的历史错误（**不碰全局 lastError**）。 */
    private fun setHistoryError(sessionId: String, message: String) {
        if (sessionId.isEmpty()) return
        synchronized(lock) {
            val cur = _historyError.value
            if (message.isEmpty()) {
                if (cur != null && cur.sessionId == sessionId) _historyError.value = null
                return
            }
            if (cur != null && cur.sessionId == sessionId && cur.message == message) return
            _historyError.value = SessionHistoryError(sessionId, message)
        }
    }

    /**
     * 拉一页历史（契约 §5.1 v1.0.4）。
     *  - `beforeSeq` 缺省取最新一页；向前翻页回传上一页的 `oldestSeq`；
     *  - `maxMessages` 单页条数上限（缺省 50）。
     *
     * 返回该页，并把页内容并入会话缓存（`beforeSeq != null` → 前插；否则接在旧 durable 之后）。
     */
    suspend fun loadHistory(
        sessionId: String,
        beforeSeq: Long? = null,
        maxMessages: Int = 50
    ): HistoryPage {
        if (sessionId.isEmpty()) throw StoreException("sessionId 为空")
        if (link.getState() != LinkState.ONLINE) {
            // 离线属于**该会话**的历史错误（详情页展示），不写全局 lastError。
            setHistoryError(sessionId, "${HISTORY_ERROR_PREFIX}未连接主机")
            throw StoreException("${HISTORY_ERROR_PREFIX}未连接主机")
        }
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            if (beforeSeq != null && beforeSeq > 0) put("beforeSeq", beforeSeq)
            if (maxMessages > 0) put("maxMessages", maxMessages)
        }
        // 开始加载 → 先清掉该会话的旧错误（避免旧错误盖住新的加载过程）。
        setHistoryError(sessionId, "")
        val value = try {
            link.request(Protocol.MSG_SESSION_HISTORY, payload, HISTORY_TIMEOUT_MS)
        } catch (e: Exception) {
            val reason = e.message?.takeIf { it.isNotEmpty() } ?: "未知错误"
            setHistoryError(sessionId, historyErrorText(reason))
            throw StoreException(historyErrorText(reason))
        }
        val page = HistoryPage.fromJson(value)
        synchronized(lock) {
            val meta = histMeta.getOrPut(sessionId) { HistMeta() }
            meta.hasMore = page.hasMore
            if (page.oldestSeq > 0) meta.oldestSeq = page.oldestSeq
            meta.loaded = true
            mergeHistory(sessionId, page.messages, page.steps, prepend = beforeSeq != null)
        }
        setHistoryError(sessionId, "")
        return page
    }

    /**
     * 内部历史刷新（带在途合并：并发刷新合并到同一次，最新页优先）。
     * prepend=false：详情页打开 / 断线恢复时拉最新一页；
     * prepend=true：向前翻页（beforeSeq 回传上一页的 oldestSeq）。
     */
    private suspend fun refreshHistory(sessionId: String, prepend: Boolean) {
        if (sessionId.isEmpty()) return
        if (link.getState() != LinkState.ONLINE) {
            // 离线：归属到该会话（详情页展示「未连接主机」），不写全局 lastError。
            setHistoryError(sessionId, "${HISTORY_ERROR_PREFIX}未连接主机")
            return
        }
        val start = synchronized(lock) {
            if (historyLoadingFlag) {
                // 不丢刷新意图：当前页可能是在 queue 项被消费前发出的。
                val prev = pendingHistory[sessionId]
                pendingHistory[sessionId] = if (prev == null) prepend else (prev && prepend)
                false
            } else {
                val meta = histMeta.getOrPut(sessionId) { HistMeta() }
                if (prepend && !meta.hasMore) return
                historyLoadingFlag = true
                _historyLoading.value = true
                true
            }
        }
        if (!start) return
        try {
            val before = if (prepend) {
                synchronized(lock) { histMeta[sessionId]?.oldestSeq ?: 0L }
            } else {
                0L
            }
            loadHistory(sessionId, if (before > 0) before else null)
        } catch (e: Exception) {
            // 历史错误归属该会话（详情页展示 + 「重新加载」）；**不写全局 lastError**。
            val reason = e.message?.takeIf { it.isNotEmpty() } ?: "未知错误"
            setHistoryError(sessionId, historyErrorText(reason))
        } finally {
            synchronized(lock) {
                historyLoadingFlag = false
                _historyLoading.value = false
            }
            runNextHistory()
        }
    }

    /** 串行执行一个在途期间合并下来的尾随历史刷新。 */
    private fun runNextHistory() {
        val next = synchronized(lock) {
            val key = pendingHistory.keys.firstOrNull() ?: return
            key to (pendingHistory.remove(key) ?: false)
        }
        scope.launch { refreshHistory(next.first, next.second) }
    }

    /**
     * 历史页并入缓存（契约 §5.7）：
     *  1) durable 项按页覆盖区间判重 → 统一按 seq 升序重排；
     *  2) 直播项按「本页新增的 durable」一一对账（文本 / 附件 / 图片 / callId）；
     *  3) 组装：prepend=旧页在最前；否则历史接在旧 durable 之后；直播项永远在最后。
     */
    private fun mergeHistory(
        sessionId: String,
        messages: List<ChatMessage>,
        steps: List<StepRecord>,
        prepend: Boolean
    ) {
        val items = cacheOf(sessionId)
        val running = runningOf(sessionId)
        val merged = mergeTimelineItems(
            oldItems = items,
            messages = messages,
            steps = steps,
            prepend = prepend,
            dropFinalized = !running,
            finalizeStreaming = !running,
            expandedKeys = expandedItems
        )
        items.clear()
        items.addAll(merged)
        notifyActive(sessionId)
    }

    /** 每会话条目列表（不存在则建空表）。 */
    private fun cacheOf(sessionId: String): MutableList<TimelineItem> =
        itemCache.getOrPut(sessionId) { ArrayList() }

    /** 结构性变化后整数组替换（数组快照与 cache 共享条目实例）。 */
    private fun notifyActive(sessionId: String) {
        if (sessionId != _activeSessionId.value) return
        val items = itemCache[sessionId] ?: return
        publishTimeline(items.toList())
    }

    /** 时间线整体替换 + 同步过程分组投影（分组必须在**数据侧**算好）。 */
    private fun publishTimeline(items: List<TimelineItem>) {
        _timeline.value = items
        _entries.value = buildEntries(items)
    }

    /**
     * 重建过程分组，并**承接**上一轮的折叠态：
     *  - UI 直接改了 `entry.groupExpanded`（就地切换）→ 这里读回并写进集合；
     *  - 集合里的值 → 新分组的初始折叠态。
     */
    private fun buildEntries(items: List<TimelineItem>): List<TimelineEntry> {
        for (e in entryCache.values) {
            if (e.groupExpanded) expandedGroups.add(e.key) else expandedGroups.remove(e.key)
        }
        val out = groupTimeline(items, expandedGroups)
        entryCache.clear()
        for (e in out) entryCache[e.key] = e
        return out
    }

    // =================================================================================
    // 直播事件写入
    // =================================================================================

    /** 直播项序号（单调递增 → 同 role 多条也不撞键）。 */
    private fun nextLiveKey(role: String): String {
        liveSeq += 1
        return "live-$liveSeq-$role"
    }

    /**
     * 本地乐观追加一条用户消息。
     *
     * @return 该气泡的 key（供失败回滚用）；未落位时返回空串。
     */
    private fun pushLocalUser(
        sessionId: String,
        text: String,
        images: List<ImageRef> = emptyList(),
        files: List<FileRef> = emptyList()
    ): String {
        if (sessionId.isEmpty()) return ""
        val items = cacheOf(sessionId)
        val key = nextLiveKey("user")
        items.add(
            TimelineMessage(
                key = key,
                id = key,
                role = "user",
                text = text,
                ts = System.currentTimeMillis(),
                seq = -1L,
                images = images,
                files = files,
                local = true
            )
        )
        notifyActive(sessionId)
        return key
    }

    /**
     * 回滚一条乐观用户气泡（宿主拒收 / 请求失败）。
     *
     * 只回滚**本地乐观副本**（local=true）：宿主权威副本（历史里的 user/message）不受影响。
     * 已经被权威历史覆盖（key 不在缓存里）时什么都不做——历史是事实，不能删。
     */
    private fun rollbackLocalUser(sessionId: String, key: String?) {
        if (sessionId.isEmpty() || key.isNullOrEmpty()) return
        synchronized(lock) {
            val items = cacheOf(sessionId)
            val idx = items.indexOfFirst { it is TimelineMessage && it.local && it.key == key }
            if (idx < 0) return
            items.removeAt(idx)
            notifyActive(sessionId)
        }
    }

    /** assistant.delta：首段开新气泡，后续并入当前流式气泡（契约 §5.2）。 */
    private fun appendDelta(sessionId: String, text: String) {
        if (sessionId.isEmpty()) return
        val items = cacheOf(sessionId)
        val last = items.lastOrNull()
        if (last is TimelineMessage && last.role == "assistant" && last.streaming) {
            items[items.size - 1] = last.copy(text = last.text + text, ts = System.currentTimeMillis())
        } else {
            val key = nextLiveKey("assistant")
            items.add(
                TimelineMessage(
                    key = key,
                    id = key,
                    role = "assistant",
                    text = text,
                    ts = System.currentTimeMillis(),
                    seq = -1L,
                    streaming = true
                )
            )
        }
        notifyActive(sessionId)
    }

    /** assistant.reasoningDelta：思考增量（独立「思考过程」块，不并入 assistant 正文）。 */
    private fun appendReasoningDelta(sessionId: String, text: String) {
        if (sessionId.isEmpty()) return
        val items = cacheOf(sessionId)
        val last = items.lastOrNull()
        if (last is TimelineReasoning && last.streaming) {
            items[items.size - 1] = last.copy(text = last.text + text, ts = System.currentTimeMillis())
        } else {
            val key = nextLiveKey("reasoning")
            items.add(
                TimelineReasoning(
                    key = key,
                    id = key,
                    text = text,
                    ts = System.currentTimeMillis(),
                    seq = -1L,
                    streaming = true
                )
            )
        }
        notifyActive(sessionId)
    }

    /**
     * turn.end（契约 §5.2）：**定稿本轮所有流式块**（assistant 文本块与 reasoning 思考块），
     * 不能只处理最后一个——本轮可能先思考、后正文，两块都在流式。
     */
    private fun finalizeTurn(sessionId: String, errText: String) {
        if (sessionId.isEmpty()) return
        val items = cacheOf(sessionId)
        var finalized = false
        val now = System.currentTimeMillis()
        for (i in items.indices) {
            val it = items[i]
            when (it) {
                is TimelineMessage -> if (it.streaming) {
                    items[i] = it.copy(
                        streaming = false,
                        ts = now,
                        errorText = if (errText.isNotEmpty() && it.role == "assistant") errText else it.errorText
                    )
                    finalized = true
                }

                is TimelineReasoning -> if (it.streaming) {
                    items[i] = it.copy(streaming = false, ts = now)
                    finalized = true
                }

                else -> Unit
            }
        }
        if (!finalized && errText.isNotEmpty()) {
            val key = nextLiveKey("assistant")
            items.add(
                TimelineMessage(
                    key = key,
                    id = key,
                    role = "assistant",
                    text = "",
                    ts = now,
                    seq = -1L,
                    errorText = errText
                )
            )
        }
        notifyActive(sessionId)
    }

    /**
     * tool.call / tool.result：登记或更新一条工作步骤。
     * 同 callId 已存在则原地更新（running → ok/error），不新增行。
     */
    private fun upsertStep(
        sessionId: String,
        callId: String,
        name: String,
        argsText: String,
        status: String,
        resultText: String,
        errorText: String,
        ts: Long
    ) {
        if (sessionId.isEmpty() || callId.isEmpty()) return
        val items = cacheOf(sessionId)
        for (i in items.indices) {
            val it = items[i]
            if (it is TimelineStep && it.callId == callId) {
                items[i] = it.copy(
                    name = if (name.isNotEmpty()) name else it.name,
                    arguments = if (argsText.isNotEmpty()) argsText else it.arguments,
                    status = status,
                    resultText = if (resultText.isNotEmpty()) resultText else it.resultText,
                    errorText = if (errorText.isNotEmpty()) errorText else it.errorText,
                    ts = ts,
                    expanded = expandedItems.contains(it.key) || it.expanded
                )
                notifyActive(sessionId)
                return
            }
        }
        val key = "s" + callId
        items.add(
            TimelineStep(
                key = key,
                callId = callId,
                name = name,
                arguments = argsText,
                status = status,
                resultText = resultText,
                errorText = errorText,
                ts = ts,
                seq = -1L,
                expanded = expandedItems.contains(key)
            )
        )
        notifyActive(sessionId)
    }

    /**
     * assistant.image 事件（契约 §5.10 v1.0.9 + §5.10.2 v1.1.1）：
     *  - **附件图片**：挂到该会话当前正在流式的 assistant 消息上；没有则**单独成一条**；
     *  - **交付物图片**（source="deliverable"）：**必须单独成一条**，不挂到流式消息上
     *    （挂上去会在 turn 结束的历史刷新里被宿主副本替换 → 图片一闪而过）。
     * 同一 imageId 重复到达时幂等。
     */
    private fun appendImage(sessionId: String, image: ImageRef) {
        if (sessionId.isEmpty() || image.imageId.isEmpty()) return
        val items = cacheOf(sessionId)
        val isDeliverable = image.isDeliverable
        if (!isDeliverable) {
            for (i in items.indices.reversed()) {
                val it = items[i]
                if (it is TimelineMessage && it.role == "assistant" && it.streaming) {
                    if (it.images.none { img -> img.imageId == image.imageId }) {
                        items[i] = it.copy(images = it.images + image)
                    }
                    notifyActive(sessionId)
                    return
                }
            }
        } else {
            // 幂等：同一交付物图片重复到达 → 不再单独成一条
            if (items.any { it is TimelineMessage && it.images.any { img -> img.imageId == image.imageId } }) {
                return
            }
        }
        val key = nextLiveKey("assistant")
        items.add(
            TimelineMessage(
                key = key,
                id = key,
                role = "assistant",
                text = "",
                ts = System.currentTimeMillis(),
                seq = -1L,
                images = listOf(image)
            )
        )
        notifyActive(sessionId)
    }

    // =================================================================================
    // 事件分发（契约 §5.2）
    // =================================================================================

    /**
     * 处理一条事件（**调用方必须持有 lock**）。
     *
     * @return 需要补拉权威历史的会话 id：
     *   - 队列项被消费（`session.queue` 快照变短）；
     *   - `turn.end` 回合收尾（空闲权威对账）；
     *   - `session.status` 的 running:true→false（turn.end 丢失兜底）。
     *   调用方在**锁外**发起请求。
     */
    private fun handleEventLocked(topic: String, data: JsonObject): String? {
        when (topic) {
            Protocol.TOPIC_SESSION_ADDED -> {
                // 契约 §5.2：session.added 的 data = {session: SessionSummary}（嵌套一层）
                val added = data.objOrNull("session")?.let(SessionSummary::fromJson)
                if (added != null && added.sessionId.isNotEmpty()) {
                    allSessions[added.sessionId] = added
                    if (added.archived) archivedIds.add(added.sessionId)
                    refreshSessionsFlow()
                }
            }

            Protocol.TOPIC_SESSION_REMOVED -> {
                val sid = data.str("sessionId")
                if (sid.isNotEmpty()) {
                    allSessions.remove(sid)
                    archivedIds.remove(sid)
                    refreshSessionsFlow()
                    pruneCache()
                }
            }

            Protocol.TOPIC_SESSION_STATUS -> {
                val sid = data.str("sessionId")
                val row = allSessions[sid] ?: return null
                val wasRunning = row.running
                val running = data.bool("running")
                allSessions[sid] = row.copy(running = running)
                refreshSessionsFlow()
                // turn.end 丢失时 running:true→false 是完成兜底 → 补一次空闲权威对账。
                if (needsAuthoritativeRefresh(
                        sessionId = sid,
                        trigger = AuthoritativeRefreshTrigger.SESSION_IDLE,
                        wasRunning = wasRunning,
                        runningNow = running,
                        linkOnline = link.getState() == LinkState.ONLINE
                    )
                ) {
                    return sid
                }
            }

            Protocol.TOPIC_SESSION_ACTIVITY -> {
                val sid = data.str("sessionId")
                val row = allSessions[sid] ?: return null
                if (data.longOrNull("updatedAt") != null) {
                    allSessions[sid] = row.copy(updatedAt = data.long("updatedAt"))
                    refreshSessionsFlow()
                }
            }

            Protocol.TOPIC_SESSION_ARCHIVES -> {
                // 归档集合**全集**快照 → 覆盖各行 archived（口径 #2）
                applyArchivedSet(data.strList("archivedSessionIds"))
            }

            Protocol.TOPIC_SESSION_MODEL_CHANGED -> {
                val sid = data.str("sessionId")
                val selection = data.objOrNull("model")?.let(ModelSelection::fromJson)
                if (sid.isNotEmpty() && selection != null) {
                    modelCache[sid] = selection
                    if (sid == _activeSessionId.value) _sessionModel.value = selection
                }
            }

            Protocol.TOPIC_SESSION_PERMISSION_CHANGED -> {
                val sid = data.str("sessionId")
                val permission = data.str("permission")
                if (sid.isNotEmpty() && permission.isNotEmpty()) {
                    permissionCache[sid] = permission
                    if (sid == _activeSessionId.value) _sessionPermission.value = permission
                }
            }

            Protocol.TOPIC_SESSION_QUEUE -> {
                val sid = data.str("sessionId")
                val items = data.arrOrNull("items")
                    ?.mapNotNull { (it as? JsonObject)?.let(QueueItem::fromJson) }
                    ?: emptyList()
                return applyQueueSnapshot(sid, items)
            }

            Protocol.TOPIC_ASSISTANT_DELTA -> {
                appendDelta(data.str("sessionId"), data.str("text"))
            }

            Protocol.TOPIC_ASSISTANT_REASONING_DELTA -> {
                appendReasoningDelta(data.str("sessionId"), data.str("text"))
            }

            Protocol.TOPIC_ASSISTANT_IMAGE -> {
                val image = data.objOrNull("image")?.let(ImageRef::fromJson)
                if (image != null) appendImage(data.str("sessionId"), image)
            }

            Protocol.TOPIC_TOOL_CALL -> {
                upsertStep(
                    sessionId = data.str("sessionId"),
                    callId = data.str("callId"),
                    name = data.str("name"),
                    argsText = data.str("arguments"),
                    status = "running",
                    resultText = "",
                    errorText = "",
                    ts = data.long("ts", System.currentTimeMillis())
                )
            }

            Protocol.TOPIC_TOOL_RESULT -> {
                val status = if (data.str("status") == "error") "error" else "ok"
                upsertStep(
                    sessionId = data.str("sessionId"),
                    callId = data.str("callId"),
                    name = "",
                    argsText = "",
                    status = status,
                    resultText = data.str("resultText"),
                    errorText = data.str("errorText"),
                    ts = data.long("ts", System.currentTimeMillis())
                )
            }

            Protocol.TOPIC_TURN_END -> {
                val sid = data.str("sessionId")
                val row = allSessions[sid]
                if (row != null) {
                    allSessions[sid] = row.copy(running = false)
                    refreshSessionsFlow()
                }
                val errText = if (data.str("status") == "error") {
                    data.str("error").ifEmpty { "回复出错" }
                } else {
                    ""
                }
                finalizeTurn(sid, errText)
                // turn.end 是回合硬边界：会话已归空闲 → 用最新权威页对账，
                // 清掉直播残留（幽灵 process group 的根因）。
                // 若此前有在途历史，refreshHistory 会记录尾随刷新，旧快照不会吃掉这次收尾。
                if (needsAuthoritativeRefresh(
                        sessionId = sid,
                        trigger = AuthoritativeRefreshTrigger.TURN_END,
                        wasRunning = true,
                        runningNow = false,
                        linkOnline = link.getState() == LinkState.ONLINE
                    )
                ) {
                    return sid
                }
            }

            Protocol.TOPIC_APPROVAL_REQUEST -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    val card = ApprovalRequest(
                        askId = askId,
                        sessionId = data.str("sessionId"),
                        toolName = data.str("toolName"),
                        reason = data.str("reason"),
                        argsPreview = data.str("argsPreview"),
                        timeoutMs = data.long("timeoutMs")
                    )
                    _approvals.value = _approvals.value.filter { it.askId != askId } + card
                }
            }

            Protocol.TOPIC_APPROVAL_RESOLVED -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    _approvals.value = _approvals.value.filter { it.askId != askId }
                }
            }

            Protocol.TOPIC_QUESTION_REQUEST -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    val card = QuestionRequest(
                        askId = askId,
                        sessionId = data.str("sessionId"),
                        questions = data.arrOrNull("questions")
                            ?.mapNotNull { (it as? JsonObject)?.let(Question::fromJson) }
                            ?: emptyList(),
                        timeoutMs = data.long("timeoutMs"),
                        multiSelect = data.bool("multiSelect")
                    )
                    _questions.value = _questions.value.filter { it.askId != askId } + card
                }
            }

            Protocol.TOPIC_QUESTION_RESOLVED -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    _questions.value = _questions.value.filter { it.askId != askId }
                }
            }

            Protocol.TOPIC_ERROR -> {
                _lastError.value = data.str("message").ifEmpty { "host 报错" }
            }

            else -> Unit
        }
        return null
    }

    /**
     * session.queue 事件 / 请求落地：整体覆盖该会话的待执行消息（宿主给的是**全量快照**）。
     * @return 队列项被消费（消失）时需要补拉历史的会话 id。
     */
    private fun applyQueueSnapshot(sessionId: String, items: List<QueueItem>): String? {
        if (sessionId.isEmpty()) return null
        val nextIds = items.mapTo(HashSet()) { it.itemId }
        var removed = false
        val previous = queueCache[sessionId]
        if (previous != null) {
            for (p in previous) {
                if (!nextIds.contains(p.itemId)) {
                    removed = true
                    break
                }
            }
        }
        queueCache[sessionId] = items
        if (sessionId == _activeSessionId.value) {
            _queueItems.value = nextTurnItems(items)
        }
        // queue 项消失有两种原因：被宿主消费（须补权威用户消息）或被取消（多拉一次无害）。
        return if (removed && link.getState() == LinkState.ONLINE) sessionId else null
    }

    /** 队列只显示 target == "next-turn"（口径 #8：next-step 已被当前 turn 持有）。 */
    private fun nextTurnItems(items: List<QueueItem>?): List<QueueItem> =
        items?.filter { it.target == "next-turn" } ?: emptyList()

    /** 大图内存缓存写入（超出上限按插入序淘汰最旧）。 */
    private fun putImageCache(key: String, image: FetchedImage) {
        imageCache[key] = image
        while (imageCache.size > IMAGE_CACHE_MAX) {
            val oldest = imageCache.keys.firstOrNull() ?: break
            imageCache.remove(oldest)
        }
    }

    /** 断开 / 切远程：清掉上一台主机的投影，避免展示别家的会话。 */
    private fun clearHostState() {
        synchronized(lock) {
            pendingHistory.clear()
            _historyError.value = null
            _activeSessionId.value = null
            publishTimeline(emptyList())
            _hostInfo.value = null
            _capabilities.value = null
            _attachmentCaps.value = null
            _busyEnter.value = Protocol.MODE_QUEUE
            _sessionModel.value = null
            _sessionPermission.value = null
            _queueItems.value = emptyList()
            _subagents.value = emptyList()
            modelCache.clear()
            permissionCache.clear()
            queueCache.clear()
            subagentCache.clear()
        }
    }

    private fun setLastError(message: String) {
        synchronized(lock) { _lastError.value = message }
    }
}

// =====================================================================================
// 文件级常量（超时 / 限流）
// =====================================================================================

private const val HISTORY_TIMEOUT_MS = 20_000L
private const val QUEUE_TIMEOUT_MS = 15_000L
private const val CAPS_TIMEOUT_MS = 15_000L
private const val SUBAGENTS_TIMEOUT_MS = 20_000L
private const val IMAGE_FETCH_TIMEOUT_MS = 20_000L
private const val LINK_POLL_INTERVAL_MS = 250L
private const val IMAGE_FETCH_DEFAULT_MAX_EDGE = 1600
private const val IMAGE_FETCH_MAX_EDGE = 4096
private const val IMAGE_CACHE_MAX = 24
private const val LOG_KEEP = 80

/** 历史错误文案前缀（归属到会话，不写全局 lastError）。 */
private const val HISTORY_ERROR_PREFIX = "加载历史失败："

/** 历史错误文案（已带前缀的不重复加）。 */
private fun historyErrorText(reason: String): String =
    if (reason.startsWith(HISTORY_ERROR_PREFIX)) reason else HISTORY_ERROR_PREFIX + reason

// =====================================================================================
// 纯函数：分组 / 合并 / 对账（便于 JVM 单测，不依赖链路）
// =====================================================================================

/** 过程分组 key 前缀（组内首条目 key 之前加它）。 */
internal const val GROUP_KEY_PREFIX = "p:"

/** 时间线条目的持久序号（直播项 = -1）。 */
internal fun TimelineItem.seqOf(): Long = when (this) {
    is TimelineMessage -> seq
    is TimelineStep -> seq
    is TimelineReasoning -> seq
}

/** 时间线条目是否仍在流式。 */
internal fun TimelineItem.streamingFlag(): Boolean = when (this) {
    is TimelineMessage -> streaming
    is TimelineReasoning -> streaming
    is TimelineStep -> false
}

/** 时间线条目的正文（步骤没有正文 → 空串）。 */
internal fun TimelineItem.textOf(): String = when (this) {
    is TimelineMessage -> text
    is TimelineReasoning -> text
    is TimelineStep -> ""
}

/** 时间线条目的角色（步骤没有角色 → 空串）。 */
internal fun TimelineItem.roleOf(): String = when (this) {
    is TimelineMessage -> role
    is TimelineReasoning -> "reasoning"
    is TimelineStep -> ""
}

/**
 * 把连续的**思考块 + 工作步骤**归为一个过程分组；对话消息按单项渲染。
 * 分组边界 = 一条消息（DSH：分组在两次独立回复之间）。
 *
 * key 规则：过程组 = "p:" + 首条目 key（**不含成员数** → 新增成员不换 key）。
 */
internal fun groupTimeline(
    items: List<TimelineItem>,
    expandedGroups: Set<String> = emptySet()
): List<TimelineEntry> {
    val isProcess = ArrayList<Boolean>()
    val keys = ArrayList<String>()
    val heads = ArrayList<TimelineItem>()
    val membersList = ArrayList<List<TimelineItem>>()
    var i = 0
    while (i < items.size) {
        val it = items[i]
        if (it is TimelineStep || it is TimelineReasoning) {
            val members = ArrayList<TimelineItem>()
            while (i < items.size && (items[i] is TimelineStep || items[i] is TimelineReasoning)) {
                members.add(items[i])
                i += 1
            }
            val head = members[0]
            isProcess.add(true)
            keys.add(GROUP_KEY_PREFIX + head.key)
            heads.add(head)
            membersList.add(members)
        } else {
            isProcess.add(false)
            keys.add(it.key)
            heads.add(it)
            membersList.add(emptyList())
            i += 1
        }
    }
    val out = ArrayList<TimelineEntry>(isProcess.size)
    for (idx in isProcess.indices) {
        // DSH flush(true)：message 是过程组的硬边界 → 旧组立即 closed。
        val closed = isProcess[idx] && idx + 1 < isProcess.size && !isProcess[idx + 1]
        out.add(
            TimelineEntry(
                key = keys[idx],
                isProcess = isProcess[idx],
                head = heads[idx],
                members = membersList[idx],
                groupExpanded = keys[idx] in expandedGroups,
                closed = closed
            )
        )
    }
    return out
}

/**
 * 历史页并入旧条目列表（**纯函数**，口径与 HarmonyOS 版 mergeHistory 一致）。
 *
 *  1) durable 项按页覆盖区间判重——与本页 [pageMin,pageMax] 重叠的旧副本摘除，
 *     统一按 seq 升序重排；
 *  2) 直播项：本页中**相对旧缓存新增**的 durable 消息与它同 role+text 时视为同一句话，
 *     丢弃直播副本；直播步骤若本页已含同 callId 的持久步骤，同样丢弃；
 *  3) 组装：prepend=旧页在最前；否则历史接在旧 durable 之后；直播项永远在最后。
 *
 * 4) **同 key 复用旧实例**：内容取本页，折叠态（expanded）取旧实例——
 *    这样刷新后卡片不会退回折叠态。
 */
internal fun mergeTimelineItems(
    oldItems: List<TimelineItem>,
    messages: List<ChatMessage>,
    steps: List<StepRecord>,
    prepend: Boolean,
    dropFinalized: Boolean,
    finalizeStreaming: Boolean,
    expandedKeys: Set<String> = emptySet()
): List<TimelineItem> {
    var pageMin = Long.MAX_VALUE
    var pageMax = -1L
    for (m in messages) {
        if (m.seq < pageMin) pageMin = m.seq
        if (m.seq > pageMax) pageMax = m.seq
    }
    for (s in steps) {
        if (s.seq >= 0) {
            if (s.seq < pageMin) pageMin = s.seq
            if (s.seq > pageMax) pageMax = s.seq
        }
    }

    val durable = ArrayList<TimelineItem>()
    val live = ArrayList<TimelineItem>()
    var coveredLive: Set<String> = emptySet()
    var coveredAttachments: Set<String> = emptySet()
    var coveredSteps: Set<String> = emptySet()
    // 「非 prepend 最新页 + 宿主已空闲」= 本页已是最终权威投影。
    val authoritativeIdle = !prepend && dropFinalized
    if (!prepend) {
        coveredLive = coveredLiveIds(oldItems, messages, authoritativeIdle)
        coveredAttachments = coveredLiveAttachmentIds(oldItems, messages)
        // 空闲后的最新页接管**全部**残留直播步骤（含没进本页的 orphan），
        // 否则它们会被挪到最终消息之后拼成幽灵 process group；运行中 / 向前翻页仍只按 callId 去重。
        coveredSteps = coveredLiveStepIds(oldItems, steps, authoritativeIdle)
    }

    for (it in oldItems) {
        val seq = it.seqOf()
        if (seq >= 0) {
            if (seq >= pageMin && seq <= pageMax) continue // 与本页覆盖区间重叠：旧副本摘除
            durable.add(it)
            continue
        }
        if (!prepend) {
            if ((it is TimelineMessage || it is TimelineReasoning) && it.textOf().isNotEmpty() &&
                coveredLive.contains(it.key)
            ) {
                continue // 直播副本已被**新增**的 durable 历史覆盖
            }
            if (it is TimelineMessage && it.text.isBlank() &&
                (it.images.isNotEmpty() || it.files.isNotEmpty()) &&
                coveredAttachments.contains(it.key)
            ) {
                continue // 附件-only 乐观消息已被本页 durable 副本覆盖
            }
            if (it is TimelineMessage && it.text.isEmpty() && it.images.isNotEmpty() &&
                imagesCoveredByPage(messages, it)
            ) {
                continue // 直播的独立图片消息（交付物）已被本页 durable 副本覆盖
            }
            if (it is TimelineStep && coveredSteps.contains(it.key)) {
                continue // 直播步骤已被本页持久步骤覆盖；空闲最新页会清掉所有残留直播步骤
            }
        }
        live.add(it)
    }
    durable.sortBy { it.seqOf() }

    // 同 key 复用旧实例（旧实例的内容被新页覆盖，但折叠态保留）。
    val oldByKey = LinkedHashMap<String, TimelineItem>()
    for (it in oldItems) {
        if (!oldByKey.containsKey(it.key)) oldByKey[it.key] = it
    }

    val pageItems = ArrayList<TimelineItem>()
    for (msg in messages) {
        val fresh = TimelineMessage(
            key = msg.id,
            id = msg.id,
            role = msg.role,
            text = msg.text,
            ts = msg.ts,
            seq = msg.seq,
            images = msg.images,
            files = msg.files
        )
        val prior = oldByKey[msg.id]
        pageItems.add(
            if (prior is TimelineMessage) {
                prior.copy(
                    role = fresh.role,
                    text = fresh.text,
                    ts = fresh.ts,
                    seq = fresh.seq,
                    images = fresh.images,
                    files = fresh.files,
                    streaming = false
                )
            } else {
                fresh
            }
        )
    }
    for (st in steps) {
        val key = "s" + st.callId
        val fresh = TimelineStep(
            key = key,
            callId = st.callId,
            name = st.name,
            arguments = st.arguments,
            status = st.status,
            resultText = st.resultText,
            errorText = st.errorText,
            ts = st.ts,
            seq = st.seq,
            expanded = expandedKeys.contains(key)
        )
        val prior = oldByKey[key]
        pageItems.add(
            if (prior is TimelineStep) {
                prior.copy(
                    name = fresh.name,
                    arguments = fresh.arguments,
                    status = fresh.status,
                    resultText = fresh.resultText,
                    errorText = fresh.errorText,
                    ts = fresh.ts,
                    seq = fresh.seq,
                    expanded = expandedItemsOf(prior, expandedKeys)
                )
            } else {
                fresh
            }
        )
    }
    pageItems.sortBy { it.seqOf() }

    // 防重保险：被页项复用的旧实例不得同时留在 durable/live。
    val reusedKeys = pageItems.mapTo(HashSet()) { it.key }
    val durableKept = durable.filter { !reusedKeys.contains(it.key) }
    val liveKept = live.filter { !reusedKeys.contains(it.key) }

    val body = if (prepend) pageItems + durableKept else durableKept + pageItems
    var merged = body + liveKept

    // 自愈：turn.end 事件若在断线窗口丢失，流式光标会残留在已结束的消息上。
    if (finalizeStreaming) {
        merged = merged.map { it ->
            when (it) {
                is TimelineMessage -> if (it.streaming) it.copy(streaming = false) else it
                is TimelineReasoning -> if (it.streaming) it.copy(streaming = false) else it
                else -> it
            }
        }
    }
    return merged
}

/** 折叠态优先取旧实例（UI 就地切换过的状态不能丢），否则取仓库集合。 */
private fun expandedItemsOf(prior: TimelineStep, expandedKeys: Set<String>): Boolean =
    prior.expanded || expandedKeys.contains(prior.key)

/** 带附件计数的 durable 消息（契约 §5.11.4：附件-only 消息的正文为空串）。 */
internal data class DurableAttachments(
    val role: String,
    val text: String,
    val imageCount: Int,
    val fileCount: Int
)

/** 带附件计数的直播 / 乐观消息。 */
internal data class LiveAttachments(
    val itemId: String,
    val role: String,
    val text: String,
    val imageCount: Int,
    val fileCount: Int
)

/** durable 文本（role + text）。 */
internal data class DurableText(val role: String, val text: String)

/** 直播文本（含条目 id 与流式标记）。 */
internal data class LiveText(
    val itemId: String,
    val role: String,
    val text: String,
    val streaming: Boolean
)

/**
 * 找出可被持久历史覆盖的直播文本（移植 timeline-reconcile.ts）。
 *
 * - 新增 durable 按顺序一对一消费 live；同 role 的多个相邻片段可聚合匹配；
 * - dropFinalized=true 仅用于「非 prepend 的最新页 + 宿主已空闲」：此时权威历史
 *   接管所有已完成的 assistant/reasoning 文本。
 */
internal fun collectCoveredLiveTextIds(
    durable: List<DurableText>,
    live: List<LiveText>,
    dropFinalized: Boolean
): Set<String> {
    val covered = LinkedHashSet<String>()
    if (dropFinalized) {
        for (item in live) {
            if (!item.streaming && (item.role == "assistant" || item.role == "reasoning") &&
                item.text.isNotEmpty()
            ) {
                covered.add(item.itemId)
            }
        }
    }
    for (message in durable) {
        if (message.text.isBlank()) continue
        var exact: LiveText? = null
        for (item in live) {
            if (!covered.contains(item.itemId) && item.role == message.role && item.text == message.text) {
                exact = item
                break
            }
        }
        if (exact != null) {
            covered.add(exact.itemId)
            continue
        }
        val fragments = ArrayList<String>()
        var combined = ""
        for (item in live) {
            if (combined.length >= message.text.length) break
            if (covered.contains(item.itemId)) continue
            if (message.role != "user" && item.role == "user") {
                break // 未消费的用户消息是 turn 边界，不能把两轮同 role 文本拼成一轮
            }
            if (item.role != message.role || item.text.isEmpty()) continue
            fragments.add(item.itemId)
            combined += item.text
        }
        if (combined == message.text) {
            for (f in fragments) covered.add(f)
        }
    }
    return covered
}

/**
 * 找出可被持久历史覆盖的**附件-only 乐观消息**（契约 §5.11.4）。
 *
 * 规则：只处理 role='user'、正文为空白、附件数 > 0 的 durable 消息；
 * 与 live 一一对应消费（role 相同、正文同样为空白、imageCount 与 fileCount 完全相等）。
 */
internal fun collectCoveredLiveAttachmentIds(
    durable: List<DurableAttachments>,
    live: List<LiveAttachments>
): Set<String> {
    val covered = LinkedHashSet<String>()
    val used = HashSet<String>()
    for (message in durable) {
        if (message.role != "user" || message.text.isNotBlank()) continue
        if (message.imageCount + message.fileCount <= 0) continue
        for (item in live) {
            if (used.contains(item.itemId)) continue
            if (item.role != "user" || item.text.isNotBlank()) continue
            if (item.imageCount != message.imageCount || item.fileCount != message.fileCount) continue
            used.add(item.itemId)
            covered.add(item.itemId)
            break
        }
    }
    return covered
}

/**
 * 本页里「相对旧缓存**新增**」的 durable 消息候选（= 有资格覆盖直播副本的那些）。
 *
 * 为什么不能只看 role+text：旧历史里有一条同文本消息时，它会命中任何同文本的
 * 直播 / 乐观消息 → **新发的那条被误删**。故候选必须同时满足：
 *  1) id 不在旧缓存的 durable id 集合里；
 *  2) seq 比旧缓存里最大的 durable seq 更新。
 */
internal fun newDurableCandidates(
    oldItems: List<TimelineItem>,
    page: List<ChatMessage>
): List<ChatMessage> {
    val knownIds = HashSet<String>()
    var knownMaxSeq = -1L
    for (it in oldItems) {
        val seq = it.seqOf()
        if (seq >= 0) {
            knownIds.add(it.key)
            if (seq > knownMaxSeq) knownMaxSeq = seq
        }
    }
    return page.filter { !knownIds.contains(it.id) && it.seq > knownMaxSeq }
}

/** 计算被持久历史覆盖的直播文本 id。 */
internal fun coveredLiveIds(
    oldItems: List<TimelineItem>,
    page: List<ChatMessage>,
    dropFinalized: Boolean
): Set<String> {
    val ordered = newDurableCandidates(oldItems, page).sortedBy { it.seq }
    val durable = ordered.map { DurableText(it.role, it.text) }
    val live = oldItems.mapNotNull { it ->
        if (it.seqOf() < 0 && (it is TimelineMessage || it is TimelineReasoning) && it.textOf().isNotEmpty()) {
            LiveText(it.key, it.roleOf(), it.textOf(), it.streamingFlag())
        } else {
            null
        }
    }
    return collectCoveredLiveTextIds(durable, live, dropFinalized)
}

/** 计算被持久历史覆盖的**附件-only 乐观消息** id（契约 §5.11.4）。 */
internal fun coveredLiveAttachmentIds(
    oldItems: List<TimelineItem>,
    page: List<ChatMessage>
): Set<String> {
    val ordered = newDurableCandidates(oldItems, page).sortedBy { it.seq }
    val durable = ordered.map {
        DurableAttachments(it.role, it.text, it.images.size, it.files.size)
    }
    val live = oldItems.mapNotNull { it ->
        if (it is TimelineMessage && it.seqOf() < 0 && it.role == "user" &&
            (it.images.isNotEmpty() || it.files.isNotEmpty())
        ) {
            LiveAttachments(it.key, it.role, it.text, it.images.size, it.files.size)
        } else {
            null
        }
    }
    return collectCoveredLiveAttachmentIds(durable, live)
}

/** 直播图片消息是否已被本页 durable 历史覆盖（**所有**图片都能在历史里找到才算覆盖）。 */
internal fun imagesCoveredByPage(messages: List<ChatMessage>, item: TimelineMessage): Boolean {
    for (img in item.images) {
        var found = false
        for (m in messages) {
            if (m.images.any { it.imageId == img.imageId }) {
                found = true
                break
            }
        }
        if (!found) return false
    }
    return true
}

/** 直播步骤是否已被本页持久步骤覆盖（同 callId）。 */
internal fun stepCoveredByPage(steps: List<StepRecord>, item: TimelineStep): Boolean {
    for (s in steps) {
        if (s.callId == item.callId) return true
    }
    return false
}

/** 权威对账的触发来源（回合收尾 / turn.end 丢失兜底）。 */
internal enum class AuthoritativeRefreshTrigger {
    /** turn.end：回合硬边界，会话已归空闲。 */
    TURN_END,

    /** session.status：running:true→false（turn.end 丢失时的对账兜底）。 */
    SESSION_IDLE
}

/**
 * 是否需要触发一次权威历史对账（**纯函数**，便于单测）。
 *
 * - 会话 id 为空 / 链路不在线 → 不触发（离线没有权威页可对）；
 * - `turn.end` → 触发（回合收尾，直播残留必须收编）；
 * - `session.status` → 只有 running:true→false 才触发（turn.end 丢失兜底）。
 */
internal fun needsAuthoritativeRefresh(
    sessionId: String,
    trigger: AuthoritativeRefreshTrigger,
    wasRunning: Boolean,
    runningNow: Boolean,
    linkOnline: Boolean
): Boolean {
    if (sessionId.isEmpty() || !linkOnline) return false
    return when (trigger) {
        AuthoritativeRefreshTrigger.TURN_END -> true
        AuthoritativeRefreshTrigger.SESSION_IDLE -> wasRunning && !runningNow
    }
}

/** 工作步骤对账所需的最小 durable 形状。 */
internal data class DurableStep(val callId: String)
/** 直播步骤（条目 id + callId）。 */
internal data class LiveStep(val itemId: String, val callId: String)

/**
 * 找出已由权威历史接管、应从时间线移除的直播步骤（移植 timeline-reconcile.ts）。
 *
 * - 普通合并仍按 callId 去重：运行中的直播步骤不会因暂时没进历史而消失；
 * - authoritativeIdle=true 仅用于「非 prepend 最新页 + 宿主已空闲」：本页已经是最终权威投影，
 *   **所有** seq=-1 的步骤都必须退出（含没进入本页的 orphan step）——
 *   否则这些残留会被统一挪到最终消息之后，拼出一个「重启 App 才消失」的幽灵 process group。
 */
internal fun collectCoveredLiveStepIds(
    durable: List<DurableStep>,
    live: List<LiveStep>,
    authoritativeIdle: Boolean
): Set<String> {
    val covered = LinkedHashSet<String>()
    if (authoritativeIdle) {
        for (item in live) covered.add(item.itemId)
        return covered
    }
    val durableIds = HashSet<String>()
    for (d in durable) durableIds.add(d.callId)
    for (item in live) {
        if (durableIds.contains(item.callId)) covered.add(item.itemId)
    }
    return covered
}

/** 计算应退出的直播步骤 id（seq < 0 的步骤才参与）。 */
internal fun coveredLiveStepIds(
    oldItems: List<TimelineItem>,
    steps: List<StepRecord>,
    authoritativeIdle: Boolean
): Set<String> {
    val live = oldItems.mapNotNull { it ->
        if (it is TimelineStep && it.seqOf() < 0) LiveStep(it.key, it.callId) else null
    }
    if (live.isEmpty()) return emptySet()
    return collectCoveredLiveStepIds(steps.map { DurableStep(it.callId) }, live, authoritativeIdle)
}
