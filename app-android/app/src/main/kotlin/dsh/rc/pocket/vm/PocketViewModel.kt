/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 统一 ViewModel：持有 link / store / RemoteRepo，暴露 StateFlow。
 *
 * 分层口径：
 *  - **core 是唯一事实源**：会话列表、时间线、审批队列、模型 / 权限、附件能力
 *    全部直接透出 core 的 StateFlow，UI 不自己再存一份。
 *  - 本文件只负责「跨页面的动作编排 + 纯 UI 状态」：
 *    折叠态（过程分组 / 条目）、草稿附件、上传进度、一次性提示、KAT 自检结果。
 *
 * 契约条款：
 *  - §3.4.1 会话纪元「先持久化再使用」：链路的纪元回调里**同步**落盘再返回。
 *  - §3.5   配对信息只存本机（RemoteRepo），不进日志。
 *  - §5.11  附件分块上传（begin → chunk* → commit），**不把 base64 塞进 prompt**。
 *  - §5.13  Todo 只读展示（整表快照，手机不写清单）。
 *  - §5.14  Goal 展示 + 人类操作（create/edit/pause/resume/complete/clear，带 CAS）。
 *  - §5     断线恢复由 SessionStore.onLinkOnline() 负责，UI 不自己重复拉。
 */
package dsh.rc.pocket.vm

import android.app.Application
import android.graphics.Bitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dsh.rc.core.AttachmentPlan
import dsh.rc.core.Capabilities
import dsh.rc.core.CreateResult
import dsh.rc.core.Crypto
import dsh.rc.core.DraftAttachment
import dsh.rc.core.DshrcLink
import dsh.rc.core.EpochState
import dsh.rc.core.FetchedImage
import dsh.rc.core.GoalAction
import dsh.rc.core.GoalWire
import dsh.rc.core.HostInfo
import dsh.rc.core.LinkConfig
import dsh.rc.core.LinkState
import dsh.rc.core.ModelSelection
import dsh.rc.core.Protocol
import dsh.rc.core.QueueItem
import dsh.rc.core.SessionStore
import dsh.rc.core.SessionSummary
import dsh.rc.core.SubagentInfo
import dsh.rc.core.TimelineEntry
import dsh.rc.core.TimelineItem
import dsh.rc.core.TimelineReasoning
import dsh.rc.core.TimelineStep
import dsh.rc.core.TodoState
import dsh.rc.core.jsonOf
import dsh.rc.core.int
import dsh.rc.core.str
import dsh.rc.pocket.PocketApp
import dsh.rc.pocket.data.RemoteProfile
import dsh.rc.pocket.data.RemoteRepo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.Base64
import java.util.UUID

/**
 * 本地待发送附件（输入框里已选、尚未提交的文件 / 图片）。
 *
 * core 的 [DraftAttachment] 只承载**元数据**（kind / name / mediaType / bytes /
 * uploadId），**不含字节**——core 的注释明确要求「字节由 UI 层自行管理」；
 * 本类在它之上补上本机字节与已解码缩略图，两者都只在内存里，不进 wire、不落盘。
 *
 * 上传成功后把 uploadId 写回 [draft]（契约 §5.11.3：prompt 失败重试**复用**，
 * 不重复上传）。
 */
class PendingAttachment(
    /** core 的元数据载体（校验 / 上传 / uploadId 复用都走它）。 */
    val draft: DraftAttachment,
    /** 本机字节（分块上传的来源）。 */
    val payload: ByteArray,
    /** 本地缩略图（图片专用；空 → 灰色占位框）。 */
    val thumb: Bitmap?,
) {
    /** 本地唯一 id（列表 key；来自 core 的 DraftAttachment.localId）。 */
    val localId: String get() = draft.localId

    /** 文件名。 */
    val name: String get() = draft.fileName

    /** 媒体类型（image/… 或 application/…）。 */
    val mediaType: String get() = draft.mimeType

    /** 原始字节数。 */
    val bytes: Long get() = draft.bytes

    /** 是否图片（图片有缩略图、只允许宿主认可的媒体类型）。 */
    val isImage: Boolean get() = draft.isImage

    /** 回填 uploadId（commit 成功后调用）。 */
    fun withUploadId(uploadId: String): PendingAttachment =
        PendingAttachment(draft.copy(uploadId = uploadId), payload, thumb)

    /** 宿主已丢弃该 upload（回执失效）→ 清掉 uploadId，重试时重新上传。 */
    fun withoutUploadId(): PendingAttachment =
        PendingAttachment(draft.copy(uploadId = null), payload, thumb)

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = localId.hashCode()
}

/**
 * 新建会话「首条任务」的发送阶段（新建会话页的按钮文案 + 禁用态）。
 *
 * 契约 §5.11 的顺序：先 create → 再上传 → 最后 prompt，三段各自可见。
 */
enum class FirstSendPhase {
    /** 空闲（可发起首发）。 */
    IDLE,

    /** 正在 session.create。 */
    CREATING,

    /** 正在串行上传附件。 */
    UPLOADING,

    /** 正在 session.prompt。 */
    SENDING,
}

/** 首发阶段状态（供新建会话页渲染按钮文案）。 */
data class FirstSendState(
    val phase: FirstSendPhase = FirstSendPhase.IDLE,
    /** 当前上传项（1 起；UPLOADING 阶段有意义）。 */
    val uploadIndex: Int = 0,
    /** 待上传总数。 */
    val uploadTotal: Int = 0,
)

/**
 * 草稿附件表的归属。
 *
 * 上传成功后的 uploadId 回填**必须写回来源那张表**——否则新建页的附件拿不到
 * uploadId → prompt 失败重试会**重复上传**。
 */
private enum class DraftOwner {
    /** 详情页 composer。 */
    DETAIL,

    /** 新建会话页。 */
    NEW_SESSION,
}

/**
 * 首建会话首发失败时跨页面移交的草稿（create 已成功 → 绝不能重复 create）。
 *
 * 附件连同**已 commit 的 uploadId** 一起带过去 → 详情页重试不重复上传（契约 §5.11.3）。
 */
data class FirstPromptDraft(
    val sessionId: String,
    val text: String,
    val attachments: List<PendingAttachment>,
)

/** KAT 自检结果（关于页展示；契约 §7 硬验收）。 */
data class KatResult(
    /** 仍在跑。 */
    val running: Boolean = true,
    /** 是否通过。 */
    val ok: Boolean = false,
    /** 展示文案。 */
    val text: String = "KAT 自检中…",
)

/**
 * 全局 ViewModel（整个 App 共用一个实例，由 Activity 的 ViewModelStore 持有）。
 */
class PocketViewModel(application: Application) : AndroidViewModel(application) {

    private val app: PocketApp = PocketApp.from(application)

    /** 中继链路（core）。 */
    val link: DshrcLink = app.link

    /** 会话仓（core）。 */
    val store: SessionStore = app.store

    /** 多远程档案仓。 */
    private val repo: RemoteRepo = app.remoteRepo

    // ---- core 状态直出（UI 单一事实源） ----

    /** 会话列表（core 已按「根会话 + 非 blank + updatedAt 降序」过滤）。 */
    val sessions: StateFlow<List<SessionSummary>> = store.sessions

    /** 已归档会话 id 集合（Host 权威归档，契约 §5.9）。 */
    val archivedSessionIds: StateFlow<Set<String>> = store.archivedSessionIds

    /** 链路状态。 */
    val linkState: StateFlow<LinkState> = store.linkState

    /** 主机信息（业务 hello 回包；null = 还没握上手）。 */
    val hostInfo: StateFlow<HostInfo?> = store.hostInfo

    /** 繁忙时的发送行为（**只读**，跟随 DSH 设置；契约 §5.1 v1.1.2）。 */
    val busyEnter: StateFlow<String> = store.busyEnter

    /** 当前会话 id。 */
    val activeSessionId: StateFlow<String?> = store.activeSessionId

    /** 分组后的时间线（详情页唯一数据源）。 */
    val entries: StateFlow<List<TimelineEntry>> = store.entries

    /** 待执行消息（只含 target == "next-turn"）。 */
    val queueItems: StateFlow<List<QueueItem>> = store.queueItems

    /** 子代理目录。 */
    val subagents: StateFlow<List<SubagentInfo>> = store.subagents

    /** 当前会话的模型选择。 */
    val sessionModel: StateFlow<ModelSelection?> = store.sessionModel

    /** 当前会话的权限（"custom" 仅展示）。 */
    val sessionPermission: StateFlow<String?> = store.sessionPermission

    /** 能力目录（模式 / 权限 / 模型 / 归档 / 附件）。 */
    val capabilities: StateFlow<Capabilities?> = store.capabilities

    /** 附件能力目录（null = 宿主不支持 → 隐藏附件入口）。 */
    val attachmentCaps = store.attachmentCaps

    /** 待答审批。 */
    val approvals = store.approvals

    /** 待答提问。 */
    val questions = store.questions

    // ---- v1.3.0：Todo / Goal（契约 §5.13 / §5.14） ----

    /**
     * 当前会话的 Todo 快照（契约 §5.13）。
     *
     * `null` = 宿主不支持 / 还没拉过（隐藏清单入口）；
     * `TodoState(supported=true, todos=null)` = 宿主支持但本回合没有清单（显示「暂无任务」）。
     */
    val todos: StateFlow<TodoState?> = store.todos

    /** 当前会话的 Goal（契约 §5.14；null = 当前没有目标）。 */
    val goal: StateFlow<GoalWire?> = store.goal

    /** Goal 续跑激活态（armed | disarmed | null = 读不到 → 不得显示「自动续跑中」）。 */
    val goalActivation: StateFlow<String?> = store.goalActivation

    /** 宿主是否支持 Goal（false = 隐藏目标入口）。 */
    val goalSupported: StateFlow<Boolean> = store.goalSupported

    /** 宿主允许的 Goal 人类操作子集（空 = 不限制）。 */
    val goalActions: StateFlow<List<String>> = store.goalActions

    /** 本地日志（关于页）。 */
    val logs = app.logs

    /**
     * 某会话自己的历史错误流（空串 = 无）。
     *
     * 错误**按会话归属**（对齐鸿蒙 `historyErrorFor(sid)`）：详情页只显示自己会话的错误，
     * 断链清空活动会话投影时也**不会**把已经报出来的错误一起抹掉。
     */
    fun historyErrorFor(sessionId: String): Flow<String> =
        store.historyError.map { err -> if (err != null && err.sessionId == sessionId) err.message else "" }

    /** 历史正在加载（详情页据此禁用「重新加载」按钮）。 */
    val historyLoading: StateFlow<Boolean> = store.historyLoading

    // ---- 多远程 ----

    /** 全部远程档案。 */
    val remotes: StateFlow<List<RemoteProfile>> = repo.profiles
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** 当前远程 id。 */
    val activeRemoteId: StateFlow<String> = repo.activeId
        .stateIn(viewModelScope, SharingStarted.Eagerly, "")

    /** 当前远程档案。 */
    val activeRemote: StateFlow<RemoteProfile?> = repo.activeProfile
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    // ---- 纯 UI 状态（数据侧，不放组件局部状态） ----

    // 折叠态**由 core 持有**（store.setGroupExpanded / store.setItemExpanded）：
    // TimelineEntry.groupExpanded 与 TimelineStep/TimelineReasoning.expanded 即真值，
    // UI 直接读，不在 app 侧再存一份（列表节点会被回收复用，本地状态会丢 / 串台）。

    /** 输入框草稿附件。 */
    private val _drafts = MutableStateFlow<List<PendingAttachment>>(emptyList())

    /** 输入框草稿附件。 */
    val drafts: StateFlow<List<PendingAttachment>> = _drafts.asStateFlow()

    /**
     * 新建会话页的草稿附件（**与详情页的 `_drafts` 相互独立**）。
     *
     * 两页各持一份（对齐 HarmonyOS：ArkTS 是两个页面级字段，字节放模块级 Map）
     * → 详情页暂存的附件**绝不会**出现在新建页（反之亦然）→ 不会跨会话串附件。
     */
    private val _newSessionDrafts = MutableStateFlow<List<PendingAttachment>>(emptyList())

    /** 新建会话页的草稿附件。 */
    val newSessionDrafts: StateFlow<List<PendingAttachment>> = _newSessionDrafts.asStateFlow()

    /** 上传进度（localId → 百分比）。 */
    private val _uploadProgress = MutableStateFlow<Map<String, Int>>(emptyMap())

    /** 上传进度。 */
    val uploadProgress: StateFlow<Map<String, Int>> = _uploadProgress.asStateFlow()

    /** 是否正在上传附件（上传期间禁用发送与附件菜单）。 */
    private val _uploading = MutableStateFlow(false)

    /** 是否正在上传附件。 */
    val uploading: StateFlow<Boolean> = _uploading.asStateFlow()

    /** 一次性提示（Snackbar）。 */
    private val _messages = Channel<String>(Channel.BUFFERED)

    /** 一次性提示（Snackbar）。 */
    val messages = _messages.receiveAsFlow()

    /** KAT 自检结果。 */
    private val _kat = MutableStateFlow(KatResult())

    /** KAT 自检结果。 */
    val kat: StateFlow<KatResult> = _kat.asStateFlow()

    /** 创建成功后要跳转的会话 id。 */
    private val _createdSessionId = MutableStateFlow<String?>(null)

    /** 创建成功后要跳转的会话 id。 */
    val createdSessionId: StateFlow<String?> = _createdSessionId.asStateFlow()

    /** 首发阶段（新建会话页按钮文案 + 禁用态）。 */
    private val _firstSend = MutableStateFlow(FirstSendState())

    /** 首发阶段。 */
    val firstSend: StateFlow<FirstSendState> = _firstSend.asStateFlow()

    /** 待移交的首发草稿（只保存一份；一次性消费）。 */
    private val _firstPromptDraft = MutableStateFlow<FirstPromptDraft?>(null)

    init {
        viewModelScope.launch {
            // 触发旧单条配对键迁移（首次启动）
            repo.load()
            val active = repo.activeProfile.first()
            if (active != null) {
                // 冷启动自动连上「当前远程」（链路已在跑时不打断）
                val st = link.getState()
                if (st == LinkState.IDLE || st == LinkState.STOPPED) {
                    connect(active.id)
                }
            } else {
                store.loadSessions()
            }
        }
        runKatCheck()
    }

    // ------------------------------------------------------------------
    // 链路 / 远程
    // ------------------------------------------------------------------

    /** 连接指定远程（切换远程 = stop + start）。 */
    fun connect(remoteId: String) {
        viewModelScope.launch {
            val p = repo.profileOf(remoteId) ?: return@launch
            repo.setActive(p.id)
            repo.touch(p.id)
            repo.syncLegacy(p)
            link.stop()
            link.start(
                LinkConfig(
                    relayUrl = p.relayUrl.trim(),
                    channel = p.channel.trim(),
                    secret = p.secret.trim(),
                    relayToken = p.relayToken.trim(),
                    clientName = PocketApp.CLIENT_NAME,
                    appVersion = appVersion(),
                    epoch = p.epoch,
                    onEpoch = { st -> persistEpoch(p.id, st) },
                )
            )
            app.appendLog("connecting: ${p.relayUrl}")
        }
    }

    /** 断开链路。 */
    fun disconnect() {
        link.stop()
        app.appendLog("link stopped by user")
    }

    /** 链路是否处于「已连上或正在连」。 */
    fun linkActive(): Boolean = when (linkState.value) {
        LinkState.ONLINE, LinkState.DERIVING, LinkState.CONNECTING,
        LinkState.HANDSHAKING, LinkState.RECONNECTING -> true

        else -> false
    }

    /**
     * 落盘会话纪元（契约 §3.4.1「先持久化再使用」）。
     *
     * 链路在**使用**纪元前会回调这里，所以这里必须等写盘完成再返回——
     * 用 runBlocking 在链路自己的后台线程上同步等待（绝不在主线程调用）。
     */
    private fun persistEpoch(id: String, epoch: EpochState) {
        runCatching {
            runBlocking { repo.applyEpoch(id, epoch) }
        }.onFailure {
            app.appendLog("epoch persist failed: ${it.message}")
        }
    }

    /** 保存（新增或更新）远程档案。 */
    fun saveRemote(profile: RemoteProfile) {
        viewModelScope.launch {
            repo.upsert(profile)
            app.appendLog("remote saved: ${profile.displayName()}")
        }
    }

    /** 删除远程档案（被删的是当前项时先断链）。 */
    fun deleteRemote(id: String) {
        viewModelScope.launch {
            if (activeRemoteId.value == id) {
                link.stop()
            }
            repo.remove(id)
            app.appendLog("remote removed: $id")
        }
    }

    // ------------------------------------------------------------------
    // 会话
    // ------------------------------------------------------------------

    /** 下拉刷新：拉会话列表。 */
    fun refreshSessions() {
        viewModelScope.launch {
            store.loadSessions()
        }
    }

    /** 打开会话（拉 history + queue + subagents + model + permission）。 */
    fun openSession(sessionId: String) {
        viewModelScope.launch {
            store.openSession(sessionId)
        }
    }

    /**
     * 回前台（v1.3.1）：store 内部先拉 `session.list`（running 真值）再拉最新历史，
     * 并对账窗口内隐藏尾部残留思考块；对齐 HarmonyOS 版 onAppForeground。
     */
    fun onAppForeground() {
        store.onAppForeground()
    }

    /** 关闭当前会话。 */
    fun closeSession() {
        viewModelScope.launch { store.closeSession() }
    }

    /** 重新拉排队消息（契约 §5.2：事件只在变化时推，打开时还要拉一次快照）。 */
    fun loadQueue(sessionId: String) {
        viewModelScope.launch { store.loadQueue(sessionId) }
    }

    /** 归档 / 恢复（Host 真实归档，契约 §5.9）。 */
    fun setArchived(sessionId: String, archived: Boolean) {
        viewModelScope.launch {
            val ok = store.setArchived(sessionId, archived)
            notify(if (ok) (if (archived) "已归档" else "已恢复到会话列表") else "主机拒绝该操作")
        }
    }

    /** 发送提示词（根会话走 session.prompt；subagent 走 session.subagentPrompt）。 */
    fun send(sessionId: String, text: String, parentSessionId: String = "") {
        // 只记会话坐标与长度，**不记提示词原文**（用户内容不进日志）
        app.appendLog("send: sessionId=$sessionId parent=$parentSessionId len=${text.length}")
        viewModelScope.launch {
            val draftsNow = drafts.value
            if (draftsNow.isNotEmpty()) {
                uploadAndSend(sessionId, text, draftsNow, parentSessionId)
                return@launch
            }
            if (text.isBlank() && draftsNow.isEmpty()) return@launch
            // 忙闲快照取在发请求之前（与 core 同口径）：繁忙时本地不插气泡 → 必须提示投递去向。
            val busy = parentSessionId.isEmpty() && store.runningOf(sessionId)
            val ok = if (parentSessionId.isNotEmpty()) {
                store.subagentPrompt(parentSessionId, sessionId, text)
            } else {
                store.sendPrompt(sessionId, text)
            }
            if (!ok) {
                notify("主机未接受该提示词")
            } else if (busy) {
                notify(busyPromptToast())
            }
        }
    }

    /** 繁忙时的投递去向提示（宿主决定 queue / steer，手机端只跟随；契约 §5.1 v1.1.2）。 */
    private fun busyPromptToast(): String =
        if (store.lastPromptMode.value == Protocol.MODE_STEER) "已插话发送" else "已排队发送"

    /** 取消当前 turn（subagent 走 session.subagentCancel）。 */
    fun cancelTurn(sessionId: String, parentSessionId: String = "") {
        viewModelScope.launch {
            val ok = if (parentSessionId.isNotEmpty()) {
                store.subagentCancel(parentSessionId, sessionId)
            } else {
                store.cancelTurn(sessionId)
            }
            notify(if (ok) "已请求取消" else "主机未接受取消请求")
        }
    }

    /** 切换模型 + 思考强度（契约 §5.8）。 */
    fun selectModel(sessionId: String, model: ModelSelection) {
        viewModelScope.launch {
            try {
                store.selectModel(sessionId, model)
                notify("已切换模型")
            } catch (e: Exception) {
                notify("切换模型失败：${e.message}")
            }
        }
    }

    /** 切换权限（契约 §5.8；"custom" 是派生态，不能作为选择目标）。 */
    fun selectPermission(sessionId: String, permission: String) {
        viewModelScope.launch {
            try {
                store.selectPermission(sessionId, permission)
                notify("已切换权限")
            } catch (e: Exception) {
                notify("切换权限失败：${e.message}")
            }
        }
    }

    /** 回答审批（契约 §5.1 approval.answer）。 */
    fun answerApproval(askId: String, decision: String, note: String = "") {
        viewModelScope.launch {
            try {
                val applied = store.answerApproval(askId, decision, note)
                notify(
                    when {
                        !applied -> "已超时，桌面端已处理"
                        decision == "approved" -> "已允许"
                        else -> "已拒绝"
                    }
                )
            } catch (e: Exception) {
                notify("提交失败：${e.message}")
            }
        }
    }

    /** 回答提问（契约 §5.1 question.answer）。 */
    fun answerQuestion(askId: String, answers: Map<String, String>, freeText: String = "") {
        viewModelScope.launch {
            try {
                val applied = store.answerQuestion(askId, answers, freeText)
                notify(if (applied) "已提交回答" else "已超时，桌面端已处理")
            } catch (e: Exception) {
                notify("提交失败：${e.message}")
            }
        }
    }

    /** 拉大图（契约 §5.10：缩略图内联，大图按需 image.fetch）。 */
    suspend fun fetchImage(imageId: String, maxEdge: Int = 1600): FetchedImage? = try {
        store.fetchImage(imageId, maxEdge)
    } catch (e: Exception) {
        notify("图片拉取失败：${e.message}")
        null
    }

    // ------------------------------------------------------------------
    // Todo / Goal（契约 §5.13 / §5.14，v1.3.0）
    // ------------------------------------------------------------------

    /** 重新拉该会话的 Todo 快照（手机**只读**）。 */
    fun loadTodos(sessionId: String) {
        viewModelScope.launch { store.loadSessionTodos(sessionId) }
    }

    /** 重新拉该会话的 Goal 快照。 */
    fun loadGoal(sessionId: String) {
        viewModelScope.launch { store.loadSessionGoal(sessionId) }
    }

    /**
     * Goal 人类操作（契约 §5.14）：新建 / 编辑 / 暂停 / 恢复 / 完成 / 清除。
     *
     * - 除 create 外，core 会自动带上手机当前看到的 `{id, revision}` 做 Host CAS；
     * - 宿主回 `GOAL_STALE_REVISION` → core 重拉 `session.goal` 并把错误透出（**不自动覆盖**）；
     * - 子代理会话只读（core 直接拒绝）。
     */
    fun goalAction(
        sessionId: String,
        action: GoalAction,
        objective: String? = null,
        maxGoalRounds: Int? = null,
    ) {
        viewModelScope.launch {
            val ok = store.goalAction(sessionId, action, objective, maxGoalRounds)
            if (ok) {
                notify(goalActionToast(action))
            } else {
                notify(store.lastError.value.ifEmpty { "目标操作失败" })
            }
        }
    }

    /** 该会话是否允许操作 Goal（子代理只读）。 */
    fun canOperateGoal(sessionId: String): Boolean = store.canOperateGoal(sessionId)

    /** Goal 操作成功提示文案。 */
    private fun goalActionToast(action: GoalAction): String = when (action) {
        GoalAction.CREATE -> "目标已创建"
        GoalAction.EDIT -> "目标已更新"
        GoalAction.PAUSE -> "目标已暂停"
        GoalAction.RESUME -> "目标已恢复"
        GoalAction.COMPLETE -> "目标已完成"
        GoalAction.CLEAR -> "目标已清除"
    }

    /**
     * 新建会话 + 发送首条任务（**首发合成器**，契约 §5.1 / §5.11）。
     *
     * 顺序**不可颠倒**：
     *  1. session.create → 拿 sessionId（标题一律空串，DSH 自动生成）
     *  2. attachment.upload.* 串行上传（同一 uploadId 只能有一条 chunk 流）
     *  3. session.prompt 带 uploads
     *
     * 失败口径（与 HarmonyOS 版一致）：
     *  - 宿主拒绝模式 / 权限（错误含 unsupported）→ 回退「只去掉 preset/permission，
     *    保留 cwd 与模型」再创建一次
     *  - create 成功但模型设置失败（CreateResult.modelError）→ 提示「已用默认模型」
     *    并**继续**首发，**绝不重复 create**
     *  - create 成功但上传 / prompt 失败 → **stash 草稿**并跳详情页（表单不留在原地
     *    诱导重复 create）
     *  - create **失败** → 只复位状态并 toast「创建失败：…」，**附件与正文保留**
     *    （对齐 ArkTS：用户改参数重试时不必重选附件）
     */
    fun createSessionWithFirstPrompt(
        text: String,
        agentPreset: String?,
        permission: String?,
        cwd: String?,
        model: ModelSelection?,
    ) {
        if (_firstSend.value.phase != FirstSendPhase.IDLE) return
        val prompt = text.trim()
        // 附件**只取新建页那张表**（详情页的草稿与本流程无关 → 不会跨会话串附件）
        val items = _newSessionDrafts.value.toList()
        if (prompt.isEmpty() && items.isEmpty()) {
            notify("请填写任务内容或选择附件")
            return
        }
        if (linkState.value != LinkState.ONLINE) {
            notify("未连接，请先在连接管理页连接主机")
            return
        }
        if (items.isNotEmpty() && attachmentCaps.value?.supported != true) {
            notify("当前主机不支持附件，请移除附件后再创建")
            return
        }
        _firstSend.value = FirstSendState(phase = FirstSendPhase.CREATING)
        viewModelScope.launch {
            // ① create
            val res: CreateResult = try {
                createWithFallback(agentPreset, permission, cwd, model)
            } catch (e: Exception) {
                _firstSend.value = FirstSendState()
                // create 失败 → **保留**附件与正文（对齐 ArkTS：只复位状态并 toast，
                // 用户改参数重试时不必重选附件）
                notify("创建失败：${e.message ?: "未知错误"}")
                return@launch
            }
            val sid = res.sessionId
            if (sid.isEmpty()) {
                _firstSend.value = FirstSendState()
                // 同属 create 失败 → 保留附件与正文
                notify("主机未返回会话 id")
                return@launch
            }
            if (res.modelError != null) {
                // 会话已建成，不能因模型设置失败而重复 create
                notify("会话已创建，模型设置失败，已用默认模型")
            }

            // ② 串行上传附件（契约 §5.11.2）
            var uploaded = items
            if (items.isNotEmpty()) {
                _firstSend.value = FirstSendState(
                    phase = FirstSendPhase.UPLOADING,
                    uploadIndex = 0,
                    uploadTotal = items.size,
                )
                try {
                    uploaded = uploadAllAttachments(sid, items)
                } catch (e: Exception) {
                    val message = e.message ?: "未知错误"
                    // 已上传成功的项在草稿列表里已带上 uploadId → 从那里取回，
                    // 保证详情页重试**不重复上传**；宿主说回执失效时清掉 uploadId
                    val carried = carriedDrafts(items)
                    val stashable = if (isUploadExpired(message)) {
                        carried.map { it.withoutUploadId() }
                    } else {
                        carried
                    }
                    failFirstPrompt(sid, prompt, stashable, message)
                    return@launch
                }
            }

            // ③ 带 uploads 发首条消息
            _firstSend.value = FirstSendState(phase = FirstSendPhase.SENDING)
            val ok = try {
                store.sendPrompt(sid, prompt, uploaded.mapNotNull { it.draft.uploadId })
            } catch (e: Exception) {
                val message = e.message ?: "未知错误"
                // 宿主说回执失效 → 清掉 uploadId，重试必须重新上传
                val carried = if (isUploadExpired(message)) {
                    uploaded.map { it.withoutUploadId() }
                } else {
                    uploaded
                }
                failFirstPrompt(sid, prompt, carried, message)
                return@launch
            }
            if (!ok) {
                failFirstPrompt(sid, prompt, uploaded, "宿主未接受首条消息")
                return@launch
            }

            // 成功：清掉**新建页**的草稿与进度，跳详情页
            clearNewSessionDrafts()
            _firstSend.value = FirstSendState()
            _createdSessionId.value = sid
        }
    }

    /**
     * session.create + unsupported 回退。
     *
     * 宿主不认识所选模式 / 权限时，只去掉 preset / permission，**保留 cwd 与模型**
     * （与 HarmonyOS 版 createSession 同口径）。
     */
    private suspend fun createWithFallback(
        agentPreset: String?,
        permission: String?,
        cwd: String?,
        model: ModelSelection?,
    ): CreateResult = try {
        store.createSession("", agentPreset, permission, cwd, model)
    } catch (e: Exception) {
        val msg = e.message ?: "未知错误"
        if (!isUnsupportedError(msg)) throw e
        notify("主机不支持所选模式/权限，已用默认创建")
        store.createSession("", null, null, cwd, model)
    }

    /**
     * 会话已建成但首发失败：草稿一次性移交详情页。
     *
     * 本页**清空但不释放**移交出去的附件字节（详情页接手发送成功 / 删除 / 退出时再释放）。
     */
    private fun failFirstPrompt(
        sessionId: String,
        text: String,
        items: List<PendingAttachment>,
        message: String,
    ) {
        stashFirstPromptDraft(sessionId, text, items)
        _firstSend.value = FirstSendState()
        notify("会话已创建，首条消息发送失败：$message。请在详情页重试")
        // 跳详情页（不留在原地诱导重复 create）
        _createdSessionId.value = sessionId
    }

    /**
     * 取回「本次首发用到的附件」的当前副本（带上已 commit 的 uploadId）。
     *
     * 上传成功时 uploadId 已回填到草稿列表 → 这里按 localId 取回即可拿到它们。
     */
    private fun carriedDrafts(items: List<PendingAttachment>): List<PendingAttachment> {
        val ids = items.map { it.localId }.toSet()
        // 从新建页那张表取（uploadId 已回填在那里）
        val fromDrafts = _newSessionDrafts.value.filter { ids.contains(it.localId) }
        if (fromDrafts.size == items.size) return fromDrafts
        // 草稿列表里缺项（理论上不会）→ 用原列表补齐，保留已知的 uploadId
        return items.map { item ->
            fromDrafts.firstOrNull { it.localId == item.localId } ?: item
        }
    }

    /** 消费「创建成功」事件（页面跳走后清一次）。 */
    fun consumeCreatedSession() {
        _createdSessionId.value = null
    }

    // ------------------------------------------------------------------
    // 附件（契约 §5.11）
    // ------------------------------------------------------------------

    /**
     * 加入草稿附件。
     *
     * 上限校验**统一走 core**（契约 §5.11.1）：[AttachmentPlan.checkAttachmentDraft]
     * 对「已选 + 新选」的完整集合给出唯一错误文案；逐个试加——能加的加，
     * 加不进的提示原因（附件类型 / 单项字节 / 数量 / 总字节）。
     */
    fun addDrafts(items: List<PendingAttachment>) {
        addDraftsTo(_drafts, items)
    }

    /**
     * 加入草稿附件（**新建会话页**；与详情页的 [addDrafts] 互不影响）。
     *
     * 上限校验同样统一走 core（契约 §5.11.1）。
     */
    fun addNewSessionDrafts(items: List<PendingAttachment>) {
        addDraftsTo(_newSessionDrafts, items)
    }

    /** 逐个试加草稿附件（超限时提示 core 给出的原因）。 */
    private fun addDraftsTo(
        table: MutableStateFlow<List<PendingAttachment>>,
        items: List<PendingAttachment>,
    ) {
        if (items.isEmpty()) return
        val caps = attachmentCaps.value
        var current = table.value
        for (item in items) {
            val candidate = current + item
            val error = AttachmentPlan.checkAttachmentDraft(
                candidate.map { it.draft },
                caps,
            )
            if (error != null) {
                notify(error)
                continue
            }
            current = candidate
        }
        if (current.size != table.value.size) {
            table.value = current
        }
    }

    /**
     * 保存新建会话的首发失败草稿（契约 §5.11：先建会话，再上传，再 prompt）。
     *
     * 只保存**一份**待移交草稿；附件连同**已 commit 的 uploadId** 一起带过去
     * → 详情页重试**不重复上传**（契约 §5.11.3）。
     *
     * 附件从活动草稿列表**移走**（本页不再显示它们；详情页 take + restoreDrafts 接手）。
     */
    fun stashFirstPromptDraft(sessionId: String, text: String, attachments: List<PendingAttachment>) {
        val ids = attachments.map { it.localId }.toSet()
        // 从**新建页**那张表移走（首发时附件在新建页的草稿表里）
        _newSessionDrafts.value = _newSessionDrafts.value.filterNot { ids.contains(it.localId) }
        _uploadProgress.value = _uploadProgress.value - ids
        _firstPromptDraft.value = FirstPromptDraft(sessionId, text, attachments)
    }

    /**
     * 详情页按 sessionId 取走首发草稿；**一次性消费**（避免返回页面时重复覆盖用户的新输入）。
     *
     * 草稿归属别的会话时返回 null。
     */
    fun takeFirstPromptDraft(sessionId: String): FirstPromptDraft? {
        val draft = _firstPromptDraft.value ?: return null
        if (draft.sessionId != sessionId) return null
        _firstPromptDraft.value = null
        return draft
    }

    /** 把移交过来的附件放回草稿列表（详情页接手首发草稿；不触发上传）。 */
    fun restoreDrafts(attachments: List<PendingAttachment>) {
        if (attachments.isEmpty()) return
        val known = _drafts.value.map { it.localId }.toSet()
        _drafts.value = _drafts.value + attachments.filterNot { known.contains(it.localId) }
    }

    /** 重新拉该会话最新一页历史（core 内部起协程）。 */
    fun retryHistory(sessionId: String) {
        store.retryHistory(sessionId)
    }

    /** 移除一个草稿附件（只释放本地字节；宿主已 commit 的附件不可撤回）。 */
    fun removeDraft(localId: String) {
        _drafts.value = drafts.value.filterNot { it.localId == localId }
        _uploadProgress.value = _uploadProgress.value - localId
    }

    /** 移除一个草稿附件（**新建会话页**）。 */
    fun removeNewSessionDraft(localId: String) {
        _newSessionDrafts.value = _newSessionDrafts.value.filterNot { it.localId == localId }
        _uploadProgress.value = _uploadProgress.value - localId
    }

    /**
     * 清空新建会话页的草稿。
     *
     * 时机：**首发成功** / **离开新建页**（对齐 HarmonyOS 的 aboutToDisappear
     * 释放附件字节）——create 失败**不清**（对齐 ArkTS：附件与正文保留，用户改参数
     * 重试时不必重选）——**绝不**碰详情页那张表。
     */
    fun clearNewSessionDrafts() {
        if (_newSessionDrafts.value.isEmpty()) return
        val ids = _newSessionDrafts.value.map { it.localId }.toSet()
        _newSessionDrafts.value = emptyList()
        _uploadProgress.value = _uploadProgress.value - ids
    }

    /** 上传附件并发送（契约 §5.11.2/§5.11.3）。 */
    private suspend fun uploadAndSend(
        sessionId: String,
        text: String,
        items: List<PendingAttachment>,
        parentSessionId: String,
    ) {
        _uploading.value = true
        try {
            val ids = ArrayList<String>(items.size)
            for (item in items) {
                ids.add(
                    uploadAttachment(sessionId, item, DraftOwner.DETAIL).draft.uploadId.orEmpty(),
                )
            }
            // 忙闲快照取在发请求之前（与 core 同口径）：繁忙时本地不插气泡 → 必须提示投递去向。
            val busy = parentSessionId.isEmpty() && store.runningOf(sessionId)
            val ok = if (parentSessionId.isNotEmpty()) {
                // subagent 不支持附件（契约 §5.11.1）：退化为纯文本
                store.subagentPrompt(parentSessionId, sessionId, text)
            } else {
                store.sendPrompt(sessionId, text, ids)
            }
            if (ok) {
                _drafts.value = emptyList()
                _uploadProgress.value = emptyMap()
                if (busy) notify(busyPromptToast())
            } else {
                notify("主机未接受该提示词（附件已保留，可重试）")
            }
        } catch (e: Exception) {
            notify("发送失败：${e.message}")
        } finally {
            _uploading.value = false
        }
    }

    /**
     * 单个附件的分块上传：begin → chunk* → commit（串行）。
     *
     * 复用：commit 成功后的 uploadId 记在 [uploadIds]，prompt 失败重试时**不重复上传**。
     */
    private suspend fun uploadAttachment(
        sessionId: String,
        item: PendingAttachment,
        owner: DraftOwner,
    ): PendingAttachment {
        // 已 commit 的 uploadId 直接复用（prompt 失败重试**不重复上传**；契约 §5.11.3）
        val existing = item.draft.uploadId.orEmpty()
        if (existing.isNotEmpty()) return item
        val table = draftTable(owner)
        val caps = attachmentCaps.value
        val hostChunk = caps?.chunkBytes ?: AttachmentPlan.DEFAULT_CHUNK_BYTES
        val chunkBytes = AttachmentPlan.clampChunkBytes(hostChunk)
        val begin = link.request(
            Protocol.MSG_UPLOAD_BEGIN,
            jsonOf(
                "sessionId" to sessionId,
                "kind" to item.draft.kind,
                "name" to AttachmentPlan.attachmentFileName(item.draft.fileName),
                "mediaType" to item.draft.mimeType,
                "bytes" to item.draft.bytes,
            ),
            UPLOAD_BEGIN_TIMEOUT_MS,
        )
        val uploadId = begin.str("uploadId")
        if (uploadId.isEmpty()) throw IllegalStateException("主机未返回 uploadId")
        val effectiveChunk = AttachmentPlan.clampChunkBytes(begin.int("chunkBytes", chunkBytes))
        val plan = AttachmentPlan.planChunks(item.payload.size.toLong(), effectiveChunk)
        var sent = 0
        for ((index, range) in plan.withIndex()) {
            val slice = item.payload.copyOfRange(range.first, range.last + 1)
            // 标准 base64（canonical，带填充，无换行）——契约 §5.11.2 硬要求
            val data = Base64.getEncoder().encodeToString(slice)
            link.request(
                Protocol.MSG_UPLOAD_CHUNK,
                jsonOf("uploadId" to uploadId, "index" to index, "data" to data),
                UPLOAD_CHUNK_TIMEOUT_MS,
            )
            sent += slice.size
            val pct = if (item.payload.isEmpty()) 100 else (sent * 100 / item.payload.size).toInt()
            _uploadProgress.value = _uploadProgress.value + (item.localId to pct)
        }
        link.request(
            Protocol.MSG_UPLOAD_COMMIT,
            jsonOf("uploadId" to uploadId),
            UPLOAD_COMMIT_TIMEOUT_MS,
        )
        // 回填 uploadId → prompt 失败重试时复用，不重复上传（契约 §5.11.3）
        // **写回来源那张表**（新建页 / 详情页各写各的 → uploadId 不会串台）
        val committed = item.withUploadId(uploadId)
        table.value = table.value.map {
            if (it.localId == item.localId) committed else it
        }
        _uploadProgress.value = _uploadProgress.value + (item.localId to 100)
        return committed
    }

    /**
     * 串行上传全部附件（契约 §5.11.2：同一 uploadId 只能有一条 chunk 流，**绝不并行**）。
     *
     * @return 每项都带上已 commit 的 uploadId 的副本（首发失败时随草稿移交，重试不重传）
     */
    private suspend fun uploadAllAttachments(
        sessionId: String,
        items: List<PendingAttachment>,
    ): List<PendingAttachment> {
        val out = ArrayList<PendingAttachment>(items.size)
        for ((index, item) in items.withIndex()) {
            _firstSend.value = FirstSendState(
                phase = FirstSendPhase.UPLOADING,
                uploadIndex = index + 1,
                uploadTotal = items.size,
            )
            out.add(uploadAttachment(sessionId, item, DraftOwner.NEW_SESSION))
        }
        return out
    }

    /** 归属的草稿表（uploadId 回填的目标）。 */
    private fun draftTable(owner: DraftOwner): MutableStateFlow<List<PendingAttachment>> =
        when (owner) {
            DraftOwner.DETAIL -> _drafts
            DraftOwner.NEW_SESSION -> _newSessionDrafts
        }

    // ------------------------------------------------------------------
    // 折叠态 / 提示 / KAT
    // ------------------------------------------------------------------

    /**
     * 切换过程分组的折叠态。
     *
     * 真值在 core（[TimelineEntry.groupExpanded]），这里只把「新的目标态」交给
     * store.setGroupExpanded——**不复制状态**（契约 §5.7：折叠态存数据侧）。
     */
    fun toggleGroup(key: String) {
        val current = entries.value.firstOrNull { it.key == key }?.groupExpanded ?: false
        store.setGroupExpanded(key, !current)
    }

    /** 切换单条时间线条目（思考块 / 步骤卡）的折叠态。 */
    fun toggleItem(key: String) {
        store.setItemExpanded(key, !isItemExpanded(key))
    }

    /** 单条时间线条目的折叠态（从 core 分组后的时间线里读）。 */
    private fun isItemExpanded(key: String): Boolean {
        for (entry in entries.value) {
            if (entry.key == key) {
                if (entry.isProcess) {
                    for (m in entry.members) if (m.key == key) return memberExpanded(m)
                } else {
                    return memberExpanded(entry.head)
                }
            }
        }
        return false
    }

    /** 会话标题（core 的 titleOf：根会话 / 子代理都能给出；未知则回落到短 id）。 */
    fun titleOf(sessionId: String): String = store.titleOf(sessionId)

    /** 某会话是否运行中（core 的 runningOf）。 */
    fun runningOf(sessionId: String): Boolean = store.runningOf(sessionId)

    /** 抛出一次性提示。 */
    fun notify(message: String) {
        _messages.trySend(message)
    }

    /** KAT 自检（契约 §7：连接建立前执行，失败禁连）。 */
    fun runKatCheck() {
        _kat.value = KatResult(running = true, ok = false, text = "KAT 自检中…")
        viewModelScope.launch(Dispatchers.Default) {
            val result = runCatching { Crypto.assertKat() }
            _kat.value = if (result.getOrDefault(false)) {
                KatResult(false, true, "KAT 通过 ✓（HKDF / AES-256-GCM / HMAC 与契约逐字节一致）")
            } else {
                KatResult(false, false, "KAT 失败：${result.exceptionOrNull()?.message ?: "未知原因"}")
            }
        }
    }

    /** App 版本号（关于页展示）。 */
    fun appVersion(): String = runCatching {
        val info = getApplication<Application>().packageManager
            .getPackageInfo(getApplication<Application>().packageName, 0)
        info.versionName ?: "1.0.0"
    }.getOrDefault("1.0.0")

    /** 当前远程的显示名（未配置 → 「未配置」）。 */
    fun activeRemoteName(): String {
        val p = activeRemote.value ?: return "未配置"
        val n = p.name.trim()
        return if (n.isNotEmpty()) n else "未配置"
    }

    companion object {
        /** 附件能力缺省值（宿主没给能力目录时的本地兜底，仅用于 UI 提示）。 */
        const val DEFAULT_MAX_COUNT = AttachmentPlan.DEFAULT_MAX_COUNT
        const val DEFAULT_MAX_ITEM_BYTES = AttachmentPlan.DEFAULT_MAX_ITEM_BYTES
        const val DEFAULT_MAX_MESSAGE_BYTES = AttachmentPlan.DEFAULT_MAX_MESSAGE_BYTES

        private const val UPLOAD_BEGIN_TIMEOUT_MS = 20_000L
        private const val UPLOAD_CHUNK_TIMEOUT_MS = 30_000L
        private const val UPLOAD_COMMIT_TIMEOUT_MS = 150_000L
    }
}

/** 错误文本是否表示「主机不支持所选模式/权限」（与 HarmonyOS 版 isUnsupportedError 同口径）。 */
internal fun isUnsupportedError(message: String): Boolean {
    val lower = message.lowercase()
    return lower.contains("unsupported") || lower.contains("not supported")
}

/** 附件回执是否已失效（宿主已丢弃该 uploadId → 重试必须重新上传）。 */
internal fun isUploadExpired(message: String): Boolean =
    message.contains("attachment-upload-expired") ||
        message.contains("attachment-upload-not-found")

/**
 * 单条时间线条目的折叠态（core 在 TimelineStep.expanded / TimelineReasoning.expanded 上给出）。
 */
internal fun memberExpanded(item: TimelineItem): Boolean = when (item) {
    is TimelineStep -> item.expanded
    is TimelineReasoning -> item.expanded
    else -> false
}

/** 生成草稿附件的本地 id。 */
internal fun newLocalId(): String = "d" + UUID.randomUUID().toString().replace("-", "").take(12)
