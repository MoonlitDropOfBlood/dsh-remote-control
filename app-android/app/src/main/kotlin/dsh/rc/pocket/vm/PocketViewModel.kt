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
import dsh.rc.core.jsonOf
import dsh.rc.core.int
import dsh.rc.core.str
import dsh.rc.pocket.PocketApp
import dsh.rc.pocket.data.RemoteProfile
import dsh.rc.pocket.data.RemoteRepo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
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

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = localId.hashCode()
}

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

    /** 本地日志（关于页）。 */
    val logs = app.logs

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

    /**
     * 新建会话 + 发送首条任务（契约 §5.1 session.create）。
     *
     * 口径与 HarmonyOS 版一致：
     *  - 标题一律传空串（DSH 自动生成）
     *  - 宿主拒绝模式 / 权限（错误含 unsupported）→ 回退「只去掉 preset/permission，
     *    保留 cwd 与模型」再创建一次
     *  - create 成功但模型设置失败（modelError）→ 提示后**继续 prompt**，不得重复创建
     *  - create 成功但 prompt 失败 → 照样进详情页提示重试
     */
    fun createSession(
        prompt: String,
        agentPreset: String?,
        permission: String?,
        cwd: String?,
        model: ModelSelection?,
    ) {
        viewModelScope.launch {
            try {
                val res: CreateResult = store.createSession("", agentPreset, permission, cwd, model)
                finishCreate(res, prompt)
            } catch (e: Exception) {
                val msg = e.message ?: "未知错误"
                if (isUnsupportedError(msg)) {
                    // 回退：宿主不认识所选模式/权限 → 只去掉 preset/permission
                    try {
                        val res = store.createSession("", null, null, cwd, model)
                        notify("主机不支持所选模式/权限，已用默认创建")
                        finishCreate(res, prompt)
                    } catch (e2: Exception) {
                        notify("创建失败：${e2.message}")
                    }
                } else {
                    notify("创建失败：$msg")
                }
            }
        }
    }

    /** 创建成功后的收尾（模型告警 → 发首条 → 跳详情）。 */
    private suspend fun finishCreate(res: CreateResult, prompt: String) {
        if (res.sessionId.isEmpty()) {
            notify("主机未返回会话 id")
            return
        }
        if (res.modelError != null) {
            notify("会话已创建，模型设置失败，将使用默认模型")
        }
        if (prompt.isNotBlank()) {
            val ok = store.sendPrompt(res.sessionId, prompt)
            if (!ok) notify("会话已创建，首条消息发送失败，请重试")
        }
        _createdSessionId.value = res.sessionId
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
        if (items.isEmpty()) return
        val caps = attachmentCaps.value
        var current = drafts.value
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
        if (current.size != drafts.value.size) {
            _drafts.value = current
        }
    }

    /** 移除一个草稿附件（只释放本地字节；宿主已 commit 的附件不可撤回）。 */
    fun removeDraft(localId: String) {
        _drafts.value = drafts.value.filterNot { it.localId == localId }
        _uploadProgress.value = _uploadProgress.value - localId
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
                ids.add(uploadAttachment(sessionId, item))
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
    private suspend fun uploadAttachment(sessionId: String, item: PendingAttachment): String {
        // 已 commit 的 uploadId 直接复用（prompt 失败重试**不重复上传**；契约 §5.11.3）
        val existing = item.draft.uploadId.orEmpty()
        if (existing.isNotEmpty()) return existing
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
        _drafts.value = _drafts.value.map {
            if (it.localId == item.localId) it.withUploadId(uploadId) else it
        }
        _uploadProgress.value = _uploadProgress.value + (item.localId to 100)
        return uploadId
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
