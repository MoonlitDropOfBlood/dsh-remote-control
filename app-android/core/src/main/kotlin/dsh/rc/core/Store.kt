/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 会话仓（契约 §5.1 / §5.2 / §5.7 / §5.10 / §5.11 / §5.12 / §5.13 / §5.14）。
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
    val errorText: String = "",
    /**
     * v1.3.1（契约 §5.3）：唤醒消息的触发来源（goal/agent/team/…）。
     * 非空 → 渲染触发卡（如「继续执行目标」），不画普通气泡。
     */
    val trigger: String = ""
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

    // ---- v1.3.0：待答交互 / Todo / Goal（契约 §5.12 / §5.13 / §5.14） ----

    private val _todos = MutableStateFlow<TodoState?>(null)

    /**
     * 当前会话的 Todo 快照（契约 §5.13）。
     *
     * `null` = 还没拉过 / 宿主不支持（隐藏 UI）；
     * `TodoState(supported=true, todos=null)` = 宿主支持但**本回合没有清单**（显示「暂无任务」）。
     */
    val todos: StateFlow<TodoState?> = _todos.asStateFlow()

    private val _goal = MutableStateFlow<GoalWire?>(null)

    /** 当前会话的 Goal（契约 §5.14；null = 当前没有目标）。 */
    val goal: StateFlow<GoalWire?> = _goal.asStateFlow()

    private val _goalActivation = MutableStateFlow<String?>(null)

    /**
     * 当前会话的 Goal 续跑激活态（armed | disarmed | null）。
     *
     * **null = 读不到**（进程内状态、不持久）→ 不得显示「自动续跑中」。
     */
    val goalActivation: StateFlow<String?> = _goalActivation.asStateFlow()

    private val _goalSupported = MutableStateFlow(false)

    /** 宿主是否支持 Goal（契约 §5.1 v1.3.0）：false = 隐藏目标入口。 */
    val goalSupported: StateFlow<Boolean> = _goalSupported.asStateFlow()

    private val _goalActions = MutableStateFlow<List<String>>(emptyList())

    /** 宿主允许的人类操作子集（契约 §5.1 v1.3.0 actions；空 = 不限制）。 */
    val goalActions: StateFlow<List<String>> = _goalActions.asStateFlow()

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

    // v1.3.0（契约 §5.12）：待答快照的**本地到达序号**。请求发出后才到的 live 卡
    // （bornSeq > issuedSeq）不得被那份旧快照误删——与 HarmonyOS 同口径。
    private var pendingSeq = 0L
    private val pendingBorn = HashMap<String, Long>()

    /** 回前台/重连对账窗口内隐藏尾部直播思考块（v1.3.1；只影响分组投影）。 */
    @Volatile
    private var hideLiveTail = false
    private var hideLiveTailSid: String? = null
    private var hideLiveTailJob: Job? = null

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

    /** 每会话 Todo 快照（契约 §5.13；null = 宿主不支持 / 还没拉过）。 */
    private val todoCache = LinkedHashMap<String, TodoState>()

    /** 每会话 Goal（契约 §5.14；缺失 = 当前没有目标）。 */
    private val goalCache = LinkedHashMap<String, GoalWire>()

    /** 每会话 Goal 续跑激活态（armed | disarmed）。 */
    private val activationCache = LinkedHashMap<String, String>()

    /** 每会话宿主是否支持 Goal。 */
    private val goalSupportedCache = LinkedHashMap<String, Boolean>()

    /** 每会话宿主允许的 Goal 人类操作子集。 */
    private val goalActionsCache = LinkedHashMap<String, List<String>>()

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
            LinkState.IDLE, LinkState.STOPPED -> {
                finishHideLiveTail(render = false) // 断链：隐藏窗口作废
                clearHostState()
            }
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
            todoCache.remove(k)
            goalCache.remove(k)
            activationCache.remove(k)
            goalSupportedCache.remove(k)
            goalActionsCache.remove(k)
        }
        val active = _activeSessionId.value
        if (active != null && !alive.contains(active)) {
            _activeSessionId.value = null
            publishTimeline(emptyList())
            _queueItems.value = emptyList()
            _subagents.value = emptyList()
            _sessionModel.value = null
            _sessionPermission.value = null
            _todos.value = null
            _goal.value = null
            _goalActivation.value = null
            _goalSupported.value = false
            _goalActions.value = emptyList()
        }
    }

    // =================================================================================
    // 当前会话
    // =================================================================================

    /**
     * 打开会话：切投影 + 拉权威数据（history + queue + subagents + model + permission
     * + todos + goal + 待答快照）。
     */
    suspend fun openSession(sessionId: String) {
        finishHideLiveTail(render = false) // 切会话：上一个会话的隐藏窗口作废
        synchronized(lock) {
            _activeSessionId.value = sessionId
            _sessionModel.value = modelCache[sessionId]
            _sessionPermission.value = permissionCache[sessionId]
            _subagents.value = subagentCache[sessionId] ?: emptyList()
            _queueItems.value = nextTurnItems(queueCache[sessionId])
            _todos.value = todoCache[sessionId]
            _goal.value = goalCache[sessionId]
            _goalActivation.value = goalCache[sessionId]?.activation
            _goalSupported.value = goalSupportedCache[sessionId] ?: false
            _goalActions.value = goalActionsCache[sessionId] ?: emptyList()
            val items = itemCache.getOrPut(sessionId) { ArrayList() }
            publishTimeline(items.toList())
        }
        if (sessionId.isEmpty()) return
        refreshHistory(sessionId, prepend = false)
        loadQueue(sessionId)
        loadSubagents(sessionId)
        loadSessionModel(sessionId)
        loadSessionPermission(sessionId)
        // v1.3.0：Todo / Goal 是**每会话**的权威投影，打开会话必须拉一次。
        loadSessionTodos(sessionId)
        loadSessionGoal(sessionId)
        // v1.3.0：待答快照（回前台 / 重连 / 开会话都靠它恢复卡片）。
        loadPendingInteractions(sessionId)
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
            _todos.value = null
            _goal.value = null
            _goalActivation.value = null
            _goalSupported.value = false
            _goalActions.value = emptyList()
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

    /**
     * 提交提问回答（契约 §5.1 question.answer；answers 见 §5.4）。
     *
     * v1.3.0：`applied:false` = 已失效或已由另一端处理 → **重拉一次快照**对齐真值
     * （契约 §5.12 不变量 4：事件只负责变化，恢复靠快照）。
     */
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
            // 已失效 / 另一端已处理 → 重拉快照（不阻塞本次调用）。
            val sid = synchronized(lock) { _questions.value.firstOrNull { it.askId == askId }?.sessionId }
            scope.launch { loadPendingInteractions(sid) }
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
     * 回前台（Activity ON_RESUME 调用，v1.3.1）。
     *
     * 后台冻结期间 `turn.end` 常常丢失，而套接字又常停在 ONLINE（不会触发重连），
     * 因此回前台必须主动做一次权威对账（`session.list` running 真值 → 最新历史）；
     * 对账窗口内同时隐藏尾部直播思考块，避免它先渲染成一个多余「工作步骤」组、
     * 随后才被清掉（用户看到的「出现又消失」）。
     */
    fun onAppForeground() {
        beginHideLiveTail()
        if (link.getState() != LinkState.ONLINE) return
        scope.launch { onLinkOnline() }
    }

    /** 时间线里是否有直播思考块（seq<0 的 reasoning，含仍在 streaming 的）。 */
    private fun hasLiveReasoning(sessionId: String): Boolean {
        val items = synchronized(lock) { itemCache[sessionId] } ?: return false
        return items.any { it is TimelineReasoning && it.seqOf() < 0 }
    }

    /** 开始隐藏尾部直播思考块（只影响分组投影，权威页落地/超时即恢复）。 */
    private fun beginHideLiveTail() {
        val sid = _activeSessionId.value ?: return
        if (!hasLiveReasoning(sid)) return
        synchronized(lock) {
            hideLiveTail = true
            hideLiveTailSid = sid
        }
        hideLiveTailJob?.cancel()
        hideLiveTailJob = scope.launch {
            delay(HIDE_LIVE_TAIL_MAX_MS)
            finishHideLiveTail(render = true)
        }
        notifyActive(sid)
    }

    /** 结束隐藏窗口；render=true 时主动重画活动会话（merge 后由调用方重画）。 */
    private fun finishHideLiveTail(render: Boolean) {
        val sid: String?
        val was: Boolean
        synchronized(lock) {
            was = hideLiveTail
            sid = hideLiveTailSid
            hideLiveTail = false
            hideLiveTailSid = null
            hideLiveTailJob?.cancel()
            hideLiveTailJob = null
        }
        if (render && was && sid != null) notifyActive(sid)
    }

    /**
     * 断线恢复 = **权威拉取**：对活动会话重拉 history + queue + subagents + model + permission
     * + todos + goal + 待答快照。
     * 中继的离线缓存只覆盖「手机掉线但中继活着」的短窗，不能当事实源。
     */
    suspend fun onLinkOnline() {
        if (link.getState() != LinkState.ONLINE) return
        loadSessions()
        loadCapabilities()
        // v1.3.0：先拉一次全局待答快照（插件仍持有的待答项）——回前台 / 重连后的卡片恢复入口。
        loadPendingInteractions()
        val sid = synchronized(lock) { _activeSessionId.value } ?: return
        refreshHistory(sid, prepend = false)
        loadQueue(sid)
        loadSessionModel(sid)
        loadSessionPermission(sid)
        loadSessionTodos(sid)
        loadSessionGoal(sid)
        // 会话级待答快照（含宿主 userQuestions 投影的 open / continued 问题）。
        loadPendingInteractions(sid)
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
    // v1.3.0：待答交互 / Todo / Goal（契约 §5.12 / §5.13 / §5.14）
    // =================================================================================

    /**
     * 拉取待答交互快照（契约 §5.1 v1.3.0 `pending.interactions` / §5.12）。
     *
     * 口径：
     *  - **只读恢复通道**：读失败按「回空数组」处理——不报错、不阻塞瀑布（fail-open）；
     *  - 指定 `sessionId` → 合并插件仍持有的待答项 + 该会话宿主 `userQuestions` 投影的
     *    `open` / `continued` 问题，并**清理已失效**的项；
     *  - 未指定 → 只合并插件仍持有的全局待答项（不做全量冷读，不清理）。
     */
    suspend fun loadPendingInteractions(sessionId: String? = null) {
        // 快照请求的基准序号必须在**发请求之前**取：请求在途时新到的 live 卡
        // bornSeq 会更大，合并时保留，不被旧快照误删。
        val issuedSeq = synchronized(lock) { pendingSeq }
        val value = try {
            link.requestPendingInteractions(sessionId)
        } catch (e: Exception) {
            // 读取失败回空数组：不影响 fail-open，也不写全局错误（契约 §5.12 不变量 1）
            return
        }
        val snapshotQuestions = value.arrOrNull("questions")
            ?.mapNotNull { (it as? JsonObject)?.let(PendingQuestion::fromJson) }
            ?: emptyList()
        val snapshotApprovals = value.arrOrNull("approvals")
            ?.mapNotNull { (it as? JsonObject)?.let(PendingApproval::fromJson) }
            ?: emptyList()
        synchronized(lock) {
            applyPendingSnapshot(sessionId, snapshotQuestions, snapshotApprovals, issuedSeq)
        }
    }

    /** 快照落地：按 askId 幂等合并 live 项与快照项（快照项为准）。 */
    private fun applyPendingSnapshot(
        sessionId: String?,
        snapshotQuestions: List<PendingQuestion>,
        snapshotApprovals: List<PendingApproval>,
        issuedSeq: Long
    ) {
        val scoped = !sessionId.isNullOrEmpty()
        val liveQuestions = _questions.value
        val liveApprovals = _approvals.value
        val scopedQuestions = if (scoped) liveQuestions.filter { it.sessionId == sessionId } else liveQuestions
        val scopedApprovals = if (scoped) liveApprovals.filter { it.sessionId == sessionId } else liveApprovals
        val merged = mergePendingInteractions(
            liveQuestions = scopedQuestions,
            liveApprovals = scopedApprovals,
            snapshotQuestions = snapshotQuestions,
            snapshotApprovals = snapshotApprovals,
            // 只有**会话级**快照才是该会话的权威全集 → 才清理已失效的 live 项。
            dropLiveMissing = scoped,
            issuedSeq = issuedSeq,
            liveBorn = pendingBorn
        )
        if (scoped) {
            _questions.value = liveQuestions.filter { it.sessionId != sessionId } + merged.questions
            _approvals.value = liveApprovals.filter { it.sessionId != sessionId } + merged.approvals
        } else {
            _questions.value = merged.questions
            _approvals.value = merged.approvals
        }
        // 快照新建的项也登记 bornSeq；已被清理的项顺手回收 born。
        val alive = LinkedHashSet<String>()
        for (q in _questions.value) alive.add(q.askId)
        for (a in _approvals.value) alive.add(a.askId)
        val staleBorn = pendingBorn.keys.filter { it !in alive }
        for (id in staleBorn) pendingBorn.remove(id)
        for (id in alive) {
            if (!pendingBorn.containsKey(id)) pendingBorn[id] = ++pendingSeq
        }
    }

    /** live 事件到达：新卡登记 bornSeq；同 askId 更新不再换号。 */
    private fun markPendingBorn(askId: String) {
        if (askId.isEmpty()) return
        if (!pendingBorn.containsKey(askId)) pendingBorn[askId] = ++pendingSeq
    }

    /**
     * 拉取会话 Todo 快照（契约 §5.1 v1.3.0 `session.todos` / §5.13）。手机**只读**。
     *
     * `supported:false` 与 `todos:null` 必须区分：前者隐藏 UI，后者显示「暂无任务」。
     */
    suspend fun loadSessionTodos(sessionId: String) {
        if (sessionId.isEmpty()) return
        val value = try {
            link.requestSessionTodos(sessionId)
        } catch (e: Exception) {
            // 旧宿主不认识该请求 → 静默降级为「不支持」（隐藏入口，不报错）。
            val message = e.message ?: ""
            if (isUnsupportedRequestError(message)) {
                synchronized(lock) { applyTodosSnapshot(sessionId, TodoState(supported = false, todos = null)) }
            }
            return
        }
        val state = TodoState.fromJson(value)
        synchronized(lock) { applyTodosSnapshot(sessionId, state) }
    }

    /** 拉取会话 Goal 快照（契约 §5.1 v1.3.0 `session.goal` / §5.14）。 */
    suspend fun loadSessionGoal(sessionId: String) {
        if (sessionId.isEmpty()) return
        val value = try {
            link.requestSessionGoal(sessionId)
        } catch (e: Exception) {
            val message = e.message ?: ""
            if (isUnsupportedRequestError(message)) {
                synchronized(lock) {
                    applyGoalSupported(sessionId, false, emptyList())
                    applyGoalSnapshot(sessionId, null)
                }
            }
            return
        }
        val supported = value.bool("supported", true)
        val actions = value.strList("actions")
        val goal = value.objOrNull("goal")?.let(GoalWire::fromJson)
        val activation = value.strOrNull("activation")?.takeIf { it.isNotEmpty() }
        synchronized(lock) {
            applyGoalSupported(sessionId, supported, actions)
            if (activation != null) activationCache[sessionId] = activation
            applyGoalSnapshot(sessionId, goal)
        }
    }

    /**
     * 执行 Goal 人类操作（契约 §5.1 v1.3.0 `session.goalAction` / §5.14）。
     *
     *  - `create` 不带 expected；其余**必须**带手机当前看到的 `{id, revision}` 做 Host CAS；
     *  - 宿主回 `GOAL_STALE_REVISION` → **重拉** `session.goal` 并把错误透出，
     *    **绝不**自动覆盖桌面端刚做的变更；
     *  - 子代理会话**只读**（不得调用模型工具 / 伪造用户消息）。
     */
    suspend fun goalAction(
        sessionId: String,
        action: GoalAction,
        objective: String? = null,
        maxGoalRounds: Int? = null
    ): Boolean {
        if (sessionId.isEmpty()) {
            setLastError("会话 id 为空")
            return false
        }
        if (!canOperateGoal(sessionId)) {
            setLastError("子代理会话只读，不能操作目标")
            return false
        }
        val current = synchronized(lock) { goalCache[sessionId] }
        val payload = buildGoalActionPayload(sessionId, action, current, objective, maxGoalRounds)
        if (payload == null) {
            setLastError(
                when (action) {
                    GoalAction.CREATE -> "请填写目标内容"
                    GoalAction.EDIT -> "请填写要修改的目标内容或轮数"
                    else -> "当前没有可操作的目标"
                }
            )
            return false
        }
        val value = try {
            link.requestSessionGoalAction(payload)
        } catch (e: Exception) {
            val message = e.message ?: "未知错误"
            if (isStaleGoalError(message)) {
                // 契约 §5.14：版本过期 → 必须重拉，客户端不得覆盖新状态。
                scope.launch { loadSessionGoal(sessionId) }
                setLastError("目标已被桌面端更新，已重新拉取，请重试")
            } else {
                setLastError("目标操作失败：" + message)
            }
            return false
        }
        val goal = value.objOrNull("goal")?.let(GoalWire::fromJson)
        synchronized(lock) { applyGoalSnapshot(sessionId, goal) }
        return true
    }

    /** 该会话是否允许操作 Goal（子代理只读；未知会话交给宿主裁决）。 */
    fun canOperateGoal(sessionId: String): Boolean =
        synchronized(lock) { isGoalOperationAllowed(allSessions[sessionId]) }

    /** Todo 快照落地（整表覆盖；null = 清空为「暂无任务」）。 */
    private fun applyTodosSnapshot(sessionId: String, state: TodoState) {
        todoCache[sessionId] = state
        if (sessionId == _activeSessionId.value) _todos.value = state
    }

    /** Goal 落地（null = 已清除）。 */
    private fun applyGoalSnapshot(sessionId: String, goal: GoalWire?) {
        val next = goalAfterChange(goalCache[sessionId], goal, activationCache[sessionId])
        if (next == null) {
            goalCache.remove(sessionId)
            activationCache.remove(sessionId)
        } else {
            goalCache[sessionId] = next
        }
        if (sessionId == _activeSessionId.value) {
            _goal.value = goalCache[sessionId]
            _goalActivation.value = goalCache[sessionId]?.activation
        }
    }

    /**
     * Goal 激活态落地（契约 §5.2 `session.goalActivationChanged`）。
     *
     * 只认**当前目标**的激活事件（id 不匹配 = 旧目标的迟到事件 → 忽略）。
     */
    private fun applyGoalActivation(sessionId: String, activation: GoalActivation) {
        val next = goalAfterActivation(goalCache[sessionId], activation) ?: return
        activationCache[sessionId] = next.activation.orEmpty()
        goalCache[sessionId] = next
        if (sessionId == _activeSessionId.value) {
            _goal.value = next
            _goalActivation.value = next.activation
        }
    }

    /** 宿主 Goal 能力落地（supported + 允许的操作子集）。 */
    private fun applyGoalSupported(sessionId: String, supported: Boolean, actions: List<String>) {
        goalSupportedCache[sessionId] = supported
        goalActionsCache[sessionId] = actions
        if (sessionId == _activeSessionId.value) {
            _goalSupported.value = supported
            _goalActions.value = actions
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
        if (sessionId == synchronized(lock) { hideLiveTailSid }) {
            finishHideLiveTail(render = false) // 权威页已落地，随后的 notifyActive 统一重画
        }
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
        // v1.3.1：隐藏窗口只过滤**分组投影**，原始时间线数据不动（权威页一到就能恢复）。
        val forGroups = if (hideLiveTail) items.filterNot { it is TimelineReasoning && it.seqOf() < 0 } else items
        _entries.value = buildEntries(forGroups)
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

            Protocol.TOPIC_SESSION_TODOS_CHANGED -> {
                // 契约 §5.13：整表覆盖（todo/write 覆盖；turn/start 清为 null）——客户端不自行合并。
                val sid = data.str("sessionId")
                if (sid.isNotEmpty()) {
                    val todos = data.arrOrNull("todos")
                        ?.mapNotNull { (it as? JsonObject)?.let(TodoItem::fromJson) }
                    applyTodosSnapshot(sid, TodoState(supported = true, todos = todos))
                }
            }

            Protocol.TOPIC_SESSION_GOAL_CHANGED -> {
                // 契约 §5.14：clear → goal 为 null；其余给完整 GoalWire（不含 activation）。
                val sid = data.str("sessionId")
                if (sid.isNotEmpty()) {
                    val goal = data.objOrNull("goal")?.let(GoalWire::fromJson)
                    applyGoalSnapshot(sid, goal)
                }
            }

            Protocol.TOPIC_SESSION_GOAL_ACTIVATION_CHANGED -> {
                val sid = data.str("sessionId")
                if (sid.isNotEmpty()) {
                    applyGoalActivation(sid, GoalActivation.fromJson(data))
                }
            }

            Protocol.TOPIC_ASSISTANT_DELTA -> {
                finishHideLiveTail(render = false) // 确有回合在生成：立即恢复
                appendDelta(data.str("sessionId"), data.str("text"))
            }

            Protocol.TOPIC_ASSISTANT_REASONING_DELTA -> {
                finishHideLiveTail(render = false) // 确有回合在生成：立即恢复
                appendReasoningDelta(data.str("sessionId"), data.str("text"))
            }

            Protocol.TOPIC_ASSISTANT_IMAGE -> {
                val image = data.objOrNull("image")?.let(ImageRef::fromJson)
                if (image != null) appendImage(data.str("sessionId"), image)
            }

            Protocol.TOPIC_TOOL_CALL -> {
                finishHideLiveTail(render = false) // 新的工具调用：结束隐藏窗口
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
                    markPendingBorn(askId)
                    val card = ApprovalRequest.fromJson(data)
                    _approvals.value = _approvals.value.filter { it.askId != askId } + card
                }
            }

            Protocol.TOPIC_APPROVAL_RESOLVED -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    pendingBorn.remove(askId)
                    _approvals.value = _approvals.value.filter { it.askId != askId }
                }
            }

            Protocol.TOPIC_QUESTION_REQUEST -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    markPendingBorn(askId)
                    val card = QuestionRequest.fromJson(data)
                    // v1.3.0：同一 askId 重发 = 状态更新 → **替换**而非叠加（幂等）。
                    _questions.value = replaceQuestionByAskId(_questions.value, card)
                }
            }

            Protocol.TOPIC_QUESTION_RESOLVED -> {
                val askId = data.str("askId")
                if (askId.isNotEmpty()) {
                    // v1.3.0：插件只在问题**真正结束**时发 resolved（timed 超时改发
                    // continued 状态更新，不发 resolved）。因此必须无条件移除；对
                    // continued 卡做“仍可答”保护会让桌面端回答后的旧卡永远删不掉。
                    pendingBorn.remove(askId)
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
     * session.queue 事件 / 请求落地：**整表替换**该会话的待执行消息（宿主给的是**全量快照**）。
     *
     * v1.3.0 权威口径：出队以 Host 消息 `id`（wire 里的 `itemId`）为主键 →
     * 快照按 `itemId` **去重**（同 id 只保留第一条），空数组 = 清空。
     *
     * @return 队列项被消费（消失）时需要补拉历史的会话 id。
     */
    private fun applyQueueSnapshot(sessionId: String, items: List<QueueItem>): String? {
        if (sessionId.isEmpty()) return null
        val deduped = mergeQueueSnapshot(emptyList(), items)
        val nextIds = deduped.mapTo(HashSet()) { it.itemId }
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
        queueCache[sessionId] = deduped
        if (sessionId == _activeSessionId.value) {
            _queueItems.value = nextTurnItems(deduped)
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
            _todos.value = null
            _goal.value = null
            _goalActivation.value = null
            _goalSupported.value = false
            _goalActions.value = emptyList()
            modelCache.clear()
            permissionCache.clear()
            queueCache.clear()
            subagentCache.clear()
            todoCache.clear()
            goalCache.clear()
            activationCache.clear()
            goalSupportedCache.clear()
            goalActionsCache.clear()
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

/** 回前台对账窗口隐藏尾部直播思考块的最长时间（ms）；权威页落地即提前恢复。 */
private const val HIDE_LIVE_TAIL_MAX_MS = 3_000L
private const val LOG_KEEP = 80

/** 历史错误文案前缀（归属到会话，不写全局 lastError）。 */
private const val HISTORY_ERROR_PREFIX = "加载历史失败："

/**
 * v1.3.0：新建目标时的默认最大轮数（契约 §5.14 maxGoalRounds；手机端不填就用这个）。
 */
private const val DEFAULT_MAX_GOAL_ROUNDS = 12

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
            files = msg.files,
            trigger = msg.trigger
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
                    trigger = fresh.trigger,
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
    // v1.3.1：宿主空闲时权威页就是最终投影——遗留的直播思考块（可能还停在 streaming、
    // dropFinalized 覆盖不到）同样必须退出；否则它会在最终消息之后拼出多出来的
    // 「工作步骤」过程组，要等下一次对账才消失。
    if (dropFinalized) {
        merged = merged.filterNot { it is TimelineReasoning && it.seqOf() < 0 }
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

// =====================================================================================
// v1.3.0 纯函数：队列快照 / 待答合并 / Goal 载荷（便于 JVM 单测，不依赖链路）
// =====================================================================================

/**
 * 队列快照合并（**纯函数**，契约 §5.2 v1.3.0 权威口径）。
 *
 *  - **整表替换**：`incoming` 是宿主给的**全量快照** → 旧表整体作废（空数组 = 清空）；
 *  - **按 itemId 去重**：出队以 Host 消息 `id`（wire 里的 `itemId`）为主键，
 *    同一 id 只保留第一条。
 *
 * @param previous 旧表（仅用于说明「整表替换」语义，不参与合并）。
 */
internal fun mergeQueueSnapshot(previous: List<QueueItem>, incoming: List<QueueItem>): List<QueueItem> {
    val seen = HashSet<String>()
    val out = ArrayList<QueueItem>(incoming.size)
    for (item in incoming) {
        if (item.itemId.isEmpty()) continue
        if (!seen.add(item.itemId)) continue
        out.add(item)
    }
    return out
}

/** 待答合并结果（契约 §5.12）。 */
internal data class PendingMergeResult(
    val questions: List<QuestionRequest>,
    val approvals: List<ApprovalRequest>
)

/**
 * 待答交互合并（**纯函数**，契约 §5.12）。
 *
 *  - **按 askId 幂等**：同一 askId 的快照项**替换** live 项（不叠加、不重复）；
 *  - 快照里没有的 live 项：`dropLiveMissing=true`（会话级权威快照）→ **清理已失效**；
 *    `false`（全局快照，只含插件仍持有的项）→ 保留。
 */
internal fun mergePendingInteractions(
    liveQuestions: List<QuestionRequest>,
    liveApprovals: List<ApprovalRequest>,
    snapshotQuestions: List<PendingQuestion>,
    snapshotApprovals: List<PendingApproval>,
    dropLiveMissing: Boolean,
    /** 快照请求发出前的本地到达序号；bornSeq > 它的 live 卡必须保留。 */
    issuedSeq: Long = Long.MAX_VALUE,
    /** askId -> 本地到达序号。 */
    liveBorn: Map<String, Long> = emptyMap()
): PendingMergeResult {
    val snapQ = LinkedHashMap<String, PendingQuestion>()
    for (q in snapshotQuestions) {
        if (q.askId.isEmpty()) continue
        snapQ[q.askId] = q // 同 askId 幂等：后者覆盖前者
    }
    val snapA = LinkedHashMap<String, PendingApproval>()
    for (a in snapshotApprovals) {
        if (a.askId.isEmpty()) continue
        snapA[a.askId] = a
    }

    val outQ = ArrayList<QuestionRequest>()
    val usedQ = HashSet<String>()
    for (live in liveQuestions) {
        val snap = snapQ[live.askId]
        if (snap != null) {
            outQ.add(snap.toQuestionRequest())
            usedQ.add(live.askId)
        } else if (!dropLiveMissing || (liveBorn[live.askId] ?: 0L) > issuedSeq) {
            outQ.add(live)
        }
    }
    for ((askId, snap) in snapQ) {
        if (!usedQ.contains(askId)) outQ.add(snap.toQuestionRequest())
    }

    val outA = ArrayList<ApprovalRequest>()
    val usedA = HashSet<String>()
    for (live in liveApprovals) {
        val snap = snapA[live.askId]
        if (snap != null) {
            outA.add(snap.toApprovalRequest(live.timeoutMs))
            usedA.add(live.askId)
        } else if (!dropLiveMissing || (liveBorn[live.askId] ?: 0L) > issuedSeq) {
            outA.add(live)
        }
    }
    for ((askId, snap) in snapA) {
        if (!usedA.contains(askId)) outA.add(snap.toApprovalRequest())
    }

    return PendingMergeResult(outQ, outA)
}

/**
 * 按 askId **幂等替换**一张提问卡（契约 §5.12）。
 *
 * 同一 askId 重发表示**状态更新**（例如 open → continued）→ 原地替换，不叠加第二张卡。
 */
internal fun replaceQuestionByAskId(
    list: List<QuestionRequest>,
    card: QuestionRequest
): List<QuestionRequest> {
    val out = ArrayList<QuestionRequest>(list.size + 1)
    var replaced = false
    for (item in list) {
        if (item.askId == card.askId) {
            if (!replaced) {
                out.add(card)
                replaced = true
            }
            continue
        }
        out.add(item)
    }
    if (!replaced) out.add(card)
    return out
}

/**
 * 组装 `session.goalAction` 载荷（**纯函数**，契约 §5.1 v1.3.0 / §5.14）。
 *
 *  - `create`：不带 `expected`，`objective` 必填；
 *  - 其余动作：**必须**带手机当前看到的 `expected{id, revision}`（Host CAS）；
 *  - `edit`：至少提供 `objective` / `maxGoalRounds` 之一。
 *
 * @return null = 参数不足（UI 侧应先拦一道）。
 */
internal fun buildGoalActionPayload(
    sessionId: String,
    action: GoalAction,
    current: GoalWire?,
    objective: String?,
    maxGoalRounds: Int?
): JsonObject? {
    val obj = objective?.trim().orEmpty()
    val rounds = maxGoalRounds?.takeIf { it > 0 }
    if (action == GoalAction.CREATE) {
        if (obj.isEmpty()) return null
        return buildJsonObject {
            put("sessionId", sessionId)
            put("action", action.wire)
            put("objective", obj)
            put("maxGoalRounds", rounds ?: DEFAULT_MAX_GOAL_ROUNDS)
        }
    }
    if (current == null || current.id.isEmpty()) return null
    val withFields = action == GoalAction.EDIT
    if (withFields && obj.isEmpty() && rounds == null) return null
    return buildJsonObject {
        put("sessionId", sessionId)
        put("action", action.wire)
        put(
            "expected",
            buildJsonObject {
                put("id", current.id)
                put("revision", current.revision)
            }
        )
        if (withFields) {
            if (obj.isNotEmpty()) put("objective", obj)
            if (rounds != null) put("maxGoalRounds", rounds)
        }
    }
}

/** 宿主是否回了「目标版本过期」（契约 §5.14 GOAL_STALE_REVISION）。 */
internal fun isStaleGoalError(message: String): Boolean =
    message.contains(Protocol.ERR_GOAL_STALE_REVISION, ignoreCase = true)

/** 请求是否被宿主判为「不认识这个类型」（旧宿主 → 静默降级，不报错）。 */
internal fun isUnsupportedRequestError(message: String): Boolean {
    val lower = message.lowercase()
    return lower.contains("bad-type") ||
        lower.contains("unsupported") ||
        lower.contains("not supported")
}

/**
 * 该会话是否允许**手机端**操作 Goal（契约 §5.14）。
 *
 * 子代理会话**只读**；根会话可操作。未知会话交给宿主裁决（返回 true）。
 */
internal fun isGoalOperationAllowed(summary: SessionSummary?): Boolean {
    if (summary == null) return true
    return summary.parentSessionId.isNullOrEmpty() && summary.origin != "subagent"
}

/** Todo 展示口径（契约 §5.13）。 */
enum class TodoVisibility {
    /** 宿主不支持 → 隐藏 UI。 */
    HIDDEN,

    /** 宿主支持但本回合没有清单 → 显示「暂无任务」。 */
    EMPTY,

    /** 有清单 → 展开显示条目。 */
    LIST
}

/**
 * Todo 展示口径判定（**纯函数**，契约 §5.13）。
 *
 * `supported:false`（宿主不支持）与 `todos:null`（宿主支持但没有清单）**必须区分**：
 * 前者隐藏 UI，后者显示「暂无任务」。
 */
fun todoVisibility(state: TodoState?): TodoVisibility = when {
    state == null || !state.supported -> TodoVisibility.HIDDEN
    state.todos.isNullOrEmpty() -> TodoVisibility.EMPTY
    else -> TodoVisibility.LIST
}

/**
 * Goal 变化后的新值（**纯函数**，契约 §5.14 `session.goalChanged`）。
 *
 * - `changed == null` → 目标被**清除**；
 * - 否则取事件里的 GoalWire，并补上已知的进程内激活态（事件本身不含 activation）。
 */
internal fun goalAfterChange(
    current: GoalWire?,
    changed: GoalWire?,
    knownActivation: String?
): GoalWire? {
    if (changed == null) return null
    val activation = changed.activation ?: knownActivation
    return if (activation == null) changed else changed.copy(activation = activation)
}

/**
 * Goal 激活态变化后的新值（**纯函数**，契约 §5.14 `session.goalActivationChanged`）。
 *
 * - 没有当前目标 → 忽略（返回 null）；
 * - 事件 id 与当前目标不一致 → 旧目标的迟到事件 → 忽略（返回原值）；
 * - 否则写入新的激活态。
 */
internal fun goalAfterActivation(current: GoalWire?, activation: GoalActivation): GoalWire? {
    if (current == null) return null
    if (current.id.isNotEmpty() && activation.id.isNotEmpty() && current.id != activation.id) return current
    return current.copy(activation = activation.activation)
}
