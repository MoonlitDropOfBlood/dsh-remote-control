/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 业务模型（契约 §5）。
 *
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/protocol.ets 的 Dshrc* 接口一一对应，
 * 字段语义逐字对齐契约（含各版本注记里的「旧插件缺省 → 安全缺省」规则）。
 *
 * v1.3.0 增补：§5.12 待答交互 / §5.13 Todo / §5.14 Goal。
 */
package dsh.rc.core

import kotlinx.serialization.json.JsonObject

// ---- 业务信封（契约 §5） ----

/** 业务消息信封：{ id, type, ts, payload }。 */
data class DshrcMsg(
    val id: String,
    val type: String,
    val ts: Long,
    val payload: JsonObject
) {
    /** 事件消息（type="event"）：payload.topic + payload.data。 */
    val topic: String get() = payload.str("topic")

    /** 事件载荷（仅 type="event" 时有意义）。 */
    val eventData: JsonObject get() = payload.obj("data")

    companion object {
        fun fromJson(o: JsonObject): DshrcMsg = DshrcMsg(
            id = o.str("id"),
            type = o.str("type"),
            ts = o.long("ts"),
            payload = o.obj("payload")
        )
    }
}

// ---- §5.3 SessionSummary ----

data class SessionSummary(
    val sessionId: String,
    val title: String,
    val cwd: String,
    val running: Boolean,
    val updatedAt: Long,
    /** "subagent" | ""；缺省按空处理。 */
    val origin: String = "",
    /** fork/spawn 血缘；根会话缺省。 */
    val parentSessionId: String? = null,
    /** 空会话（DSH 官方语义：客户端隐藏 blank 会话）。 */
    val blank: Boolean = false,
    /** Workspace 真实归档标记（插件按归档集合拼装；旧插件缺省按 false）。 */
    val archived: Boolean = false
) {
    /** 列表显示规则（契约 §5.3）：只显示根会话且非 blank。 */
    val isRootVisible: Boolean
        get() = parentSessionId.isNullOrEmpty() && origin != "subagent" && !blank

    companion object {
        fun fromJson(o: JsonObject): SessionSummary = SessionSummary(
            sessionId = o.str("sessionId"),
            title = o.str("title"),
            cwd = o.str("cwd"),
            running = o.bool("running"),
            updatedAt = o.long("updatedAt"),
            origin = o.str("origin"),
            parentSessionId = o.strOrNull("parentSessionId"),
            blank = o.bool("blank"),
            archived = o.bool("archived")
        )
    }
}

// ---- §5.10 图片 / §5.11 文件 ----

/**
 * 会话消息里的图片引用（契约 §5.10）。
 * thumb 是内联缩略图 data URI（可能为空串 → 客户端显示占位框）。
 */
data class ImageRef(
    val imageId: String,
    val mediaType: String,
    val width: Int,
    val height: Int,
    val bytes: Long,
    /** 缺省 = 'attachment'；'deliverable' = present 投递的交付物图片（独立成条）。 */
    val source: String = "attachment",
    val thumb: String = ""
) {
    val isDeliverable: Boolean get() = source == "deliverable"

    companion object {
        fun fromJson(o: JsonObject): ImageRef = ImageRef(
            imageId = o.str("imageId"),
            mediaType = o.str("mediaType"),
            width = o.int("width"),
            height = o.int("height"),
            bytes = o.long("bytes"),
            source = o.str("source", "attachment"),
            thumb = o.str("thumb")
        )
    }
}

/** 用户消息里的文件引用（契约 §5.11.4）：只渲染成文件卡片，手机端 v1.2.0 不提供下载。 */
data class FileRef(
    val fileId: String,
    val name: String,
    val bytes: Long
) {
    companion object {
        fun fromJson(o: JsonObject): FileRef = FileRef(
            fileId = o.str("fileId"),
            name = o.str("name"),
            bytes = o.long("bytes")
        )
    }
}

// ---- §5.1 session.history ----

/** 历史消息（契约 §5.1 ChatMessage）。role = user | assistant | reasoning。 */
data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val ts: Long,
    val seq: Long,
    /** 消息内图片（旧插件不返 → 空列表）。 */
    val images: List<ImageRef> = emptyList(),
    /** 消息内文件（旧插件不返 → 空列表）。 */
    val files: List<FileRef> = emptyList(),
    /**
     * v1.3.1（契约 §5.3）：**唤醒消息**的触发来源（宿主自动唤醒回合，不是用户手打）。
     * goal / agent / team / subagent / webhook / schedule / job / plugin。
     * 非空时 text 为空串（注入正文被隐藏），UI 渲染成触发卡（如「继续执行目标」）。
     */
    val trigger: String = ""
) {
    companion object {
        fun fromJson(o: JsonObject): ChatMessage = ChatMessage(
            id = o.str("id"),
            role = o.str("role"),
            text = o.str("text"),
            ts = o.long("ts"),
            seq = o.long("seq"),
            images = o.arrOrNull("images")?.mapNotNull { (it as? JsonObject)?.let(ImageRef::fromJson) }
                ?: emptyList(),
            files = o.arrOrNull("files")?.mapNotNull { (it as? JsonObject)?.let(FileRef::fromJson) }
                ?: emptyList(),
            trigger = o.str("trigger")
        )
    }
}

/** 工作步骤（契约 §5.7）：时间线里的工具调用。 */
data class StepRecord(
    val seq: Long,
    val callId: String,
    val name: String,
    val arguments: String,
    /** "ok" | "error" | "running" */
    val status: String,
    val resultText: String,
    val errorText: String,
    val ts: Long,
    val turn: Long,
    val step: Long
) {
    companion object {
        fun fromJson(o: JsonObject): StepRecord = StepRecord(
            seq = o.long("seq"),
            callId = o.str("callId"),
            name = o.str("name"),
            arguments = o.str("arguments"),
            status = o.str("status"),
            resultText = o.str("resultText"),
            errorText = o.str("errorText"),
            ts = o.long("ts"),
            turn = o.long("turn"),
            step = o.long("step")
        )
    }
}

/** session.history 响应（契约 §5.1 v1.0.4 + v1.0.6）。 */
data class HistoryPage(
    val messages: List<ChatMessage>,
    val steps: List<StepRecord>,
    val hasMore: Boolean,
    val oldestSeq: Long
) {
    companion object {
        fun fromJson(o: JsonObject): HistoryPage = HistoryPage(
            messages = o.arrOrNull("messages")?.mapNotNull { (it as? JsonObject)?.let(ChatMessage::fromJson) }
                ?: emptyList(),
            steps = o.arrOrNull("steps")?.mapNotNull { (it as? JsonObject)?.let(StepRecord::fromJson) }
                ?: emptyList(),
            hasMore = o.bool("hasMore"),
            oldestSeq = o.long("oldestSeq")
        )
    }
}

// ---- §5.8 模式 / 权限 / 模型 ----

data class ModeOption(val id: String, val name: String, val description: String) {
    companion object {
        fun fromJson(o: JsonObject) = ModeOption(o.str("id"), o.str("name"), o.str("description"))
    }
}

data class PermissionOption(val id: String, val name: String, val description: String) {
    companion object {
        fun fromJson(o: JsonObject) = PermissionOption(o.str("id"), o.str("name"), o.str("description"))
    }
}

/** 思考强度选项（契约 §5.8 v1.0.8）。 */
data class EffortOption(val id: String, val name: String, val description: String) {
    companion object {
        fun fromJson(o: JsonObject) = EffortOption(o.str("id"), o.str("name"), o.str("description"))
    }
}

/** 模型选项（契约 §5.8 v1.0.7 + v1.0.8）。 */
data class ModelOption(
    val id: String,
    val name: String,
    val description: String,
    val provider: String,
    val model: String,
    /** 该模型的 reasoning.defaultEffort（若有）。 */
    val reasoningEffort: String? = null,
    /** 该模型合法的思考强度集合；缺省 = 模型不支持思考强度。 */
    val efforts: List<EffortOption> = emptyList()
) {
    companion object {
        fun fromJson(o: JsonObject): ModelOption = ModelOption(
            id = o.str("id"),
            name = o.str("name"),
            description = o.str("description"),
            provider = o.str("provider"),
            model = o.str("model"),
            reasoningEffort = o.strOrNull("reasoningEffort"),
            efforts = o.arrOrNull("efforts")
                ?.mapNotNull { (it as? JsonObject)?.let(EffortOption::fromJson) } ?: emptyList()
        )
    }
}

/** 模型选择（契约 §5.8 v1.0.7）。 */
data class ModelSelection(
    val provider: String,
    val model: String,
    val reasoningEffort: String? = null
) {
    fun toJson(): JsonObject = jsonOf(
        "provider" to provider,
        "model" to model,
        "reasoningEffort" to reasoningEffort
    )

    /** 展示串：provider/model（契约 §5.8；目录里没有该模型时不回退默认）。 */
    fun display(): String = "$provider/$model"

    companion object {
        fun fromJson(o: JsonObject): ModelSelection = ModelSelection(
            provider = o.str("provider"),
            model = o.str("model"),
            reasoningEffort = o.strOrNull("reasoningEffort")
        )
    }
}

/** 附件能力目录（契约 §5.11.1）。旧插件**缺省该字段** → 客户端隐藏附件入口。 */
data class AttachmentCaps(
    val supported: Boolean,
    val maxCount: Int,
    val maxItemBytes: Long,
    val maxMessageBytes: Long,
    val chunkBytes: Int,
    val imageMediaTypes: List<String>
) {
    companion object {
        fun fromJson(o: JsonObject): AttachmentCaps = AttachmentCaps(
            supported = o.bool("supported"),
            maxCount = o.int("maxCount"),
            maxItemBytes = o.long("maxItemBytes"),
            maxMessageBytes = o.long("maxMessageBytes"),
            chunkBytes = o.int("chunkBytes"),
            imageMediaTypes = o.strList("imageMediaTypes")
        )
    }
}

/** Todo 能力标记（契约 §5.1 v1.3.0 capabilities.todos）。缺省 = 旧宿主不支持。 */
data class TodoCaps(val supported: Boolean) {
    companion object {
        fun fromJson(o: JsonObject) = TodoCaps(supported = o.bool("supported"))
    }
}

/** Goal 能力目录（契约 §5.1 v1.3.0 capabilities.goal）：read + 可执行的人类操作子集。 */
data class GoalCaps(
    val read: Boolean,
    val actions: List<String>
) {
    companion object {
        fun fromJson(o: JsonObject) = GoalCaps(
            read = o.bool("read"),
            actions = o.strList("actions")
        )
    }
}

/** 待答交互能力标记（契约 §5.1 v1.3.0 capabilities.pendingInteractions）。 */
data class PendingInteractionsCaps(
    val questions: Boolean,
    val approvals: Boolean,
    /** 宿主是否支持「窗口结束后继续补答」。 */
    val hostContinued: Boolean
) {
    companion object {
        fun fromJson(o: JsonObject) = PendingInteractionsCaps(
            questions = o.bool("questions"),
            approvals = o.bool("approvals"),
            hostContinued = o.bool("hostContinued")
        )
    }
}

/** session.capabilities 响应（契约 §5.8）。 */
data class Capabilities(
    val presets: List<ModeOption>,
    val permissions: List<PermissionOption>,
    val defaultPreset: String,
    val defaultPermission: String,
    val models: List<ModelOption>,
    val defaultModelId: String,
    val archiveSupported: Boolean,
    /** 宿主「繁忙时的发送行为」——**只读**（契约 §5.1 v1.1.2）。 */
    val busyEnter: String,
    /** 附件能力目录；**null = 宿主不支持**（隐藏附件入口，不得报错）。 */
    val attachments: AttachmentCaps? = null,
    /** Todo 能力；**null = 宿主不支持**（隐藏清单入口，不得报错）。 */
    val todos: TodoCaps? = null,
    /** Goal 能力；**null = 宿主不支持**（隐藏目标入口，不得报错）。 */
    val goal: GoalCaps? = null,
    /** 待答交互能力；**null = 宿主不支持**（旧插件只有一次性事件）。 */
    val pendingInteractions: PendingInteractionsCaps? = null
) {
    companion object {
        fun fromJson(o: JsonObject): Capabilities = Capabilities(
            presets = o.arrOrNull("presets")?.mapNotNull { (it as? JsonObject)?.let(ModeOption::fromJson) }
                ?: emptyList(),
            permissions = o.arrOrNull("permissions")
                ?.mapNotNull { (it as? JsonObject)?.let(PermissionOption::fromJson) } ?: emptyList(),
            defaultPreset = o.str("defaultPreset"),
            defaultPermission = o.str("defaultPermission"),
            models = o.arrOrNull("models")?.mapNotNull { (it as? JsonObject)?.let(ModelOption::fromJson) }
                ?: emptyList(),
            defaultModelId = o.str("defaultModelId"),
            archiveSupported = o.bool("archiveSupported"),
            busyEnter = if (o.str("busyEnter") == Protocol.MODE_STEER) Protocol.MODE_STEER else Protocol.MODE_QUEUE,
            attachments = o.objOrNull("attachments")?.let(AttachmentCaps::fromJson),
            todos = o.objOrNull("todos")?.let(TodoCaps::fromJson),
            goal = o.objOrNull("goal")?.let(GoalCaps::fromJson),
            pendingInteractions = o.objOrNull("pendingInteractions")?.let(PendingInteractionsCaps::fromJson)
        )
    }
}

// ---- §5.2 队列 / 子代理 / 审批 / 提问 ----

/** 待执行消息（契约 §5.2 session.queue）。客户端**只展示，不猜测**。 */
data class QueueItem(
    val itemId: String,
    val text: String,
    /** "next-turn"（排队中）| "next-step"（已插入当前 turn，未消费）。 */
    val target: String
) {
    companion object {
        fun fromJson(o: JsonObject) = QueueItem(o.str("itemId"), o.str("text"), o.str("target", "next-turn"))
    }
}

/** 子代理目录行（契约 §5.6）。mode = "one-shot" | "continuable"。 */
data class SubagentInfo(
    val sessionId: String,
    val label: String,
    val mode: String,
    val running: Boolean,
    val hasChildren: Boolean,
    val createdAt: Long
) {
    /** UI 兜底标签（label 为空 → 用 sessionId 前 8 位）。 */
    fun displayLabel(): String =
        if (label.isNotEmpty()) label else sessionId.take(8)

    val isOneShot: Boolean get() = mode == "one-shot"

    companion object {
        fun fromJson(o: JsonObject) = SubagentInfo(
            sessionId = o.str("sessionId"),
            label = o.str("label"),
            mode = o.str("mode"),
            running = o.bool("running"),
            hasChildren = o.bool("hasChildren"),
            createdAt = o.long("createdAt")
        )
    }
}

/** question.request 的选项（契约 §5.4）。 */
data class QuestionOption(val label: String, val description: String) {
    companion object {
        fun fromJson(o: JsonObject) = QuestionOption(o.str("label"), o.str("description"))
    }
}

/** question.request 的单个问题（契约 §5.4）。 */
data class Question(
    val id: String,
    val question: String,
    val multiSelect: Boolean,
    val options: List<QuestionOption>
) {
    companion object {
        fun fromJson(o: JsonObject): Question = Question(
            id = o.str("id"),
            question = o.str("question"),
            multiSelect = o.bool("multiSelect"),
            options = o.arrOrNull("options")?.mapNotNull { (it as? JsonObject)?.let(QuestionOption::fromJson) }
                ?: emptyList()
        )
    }
}

/** approval.request（契约 §5.2）。 */
data class ApprovalRequest(
    val askId: String,
    val sessionId: String,
    val toolName: String,
    val reason: String,
    val argsPreview: String,
    val timeoutMs: Long,
    /** v1.3.0（契约 §5.12）：false = 已失效，**不得**显示可编辑卡。 */
    val answerable: Boolean = true,
    /** v1.3.0（契约 §5.12）：绝对过期时间（Unix 毫秒）；null = 无限期 / 未给。 */
    val expiresAt: Long? = null,
    /** v1.3.0（契约 §5.12）：来源（plugin | host）。 */
    val source: String = Protocol.PENDING_SOURCE_PLUGIN
) {
    companion object {
        fun fromJson(o: JsonObject) = ApprovalRequest(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            toolName = o.str("toolName"),
            reason = o.str("reason"),
            argsPreview = o.str("argsPreview"),
            timeoutMs = o.long("timeoutMs"),
            answerable = o.bool("answerable", true),
            expiresAt = o.longOrNull("expiresAt"),
            source = o.str("source", Protocol.PENDING_SOURCE_PLUGIN)
        )
    }
}

/**
 * question.request（契约 §5.2）。
 *
 * v1.3.0（契约 §5.12）增补四个字段：
 *  - `state` = open（手机独占窗口内）| continued（窗口结束但**仍可补答**）；
 *  - `callId` = Host callId（手机与电脑共用同一个，两端回答后互相同步关闭）；
 *  - `expiresAt` = 绝对过期时间（Unix 毫秒；恢复卡按剩余时间显示）；
 *  - `answerable` = false 时不得显示可编辑卡。
 */
data class QuestionRequest(
    val askId: String,
    val sessionId: String,
    val questions: List<Question>,
    val timeoutMs: Long,
    val multiSelect: Boolean,
    /** v1.3.0：状态（open | continued）。 */
    val state: String = Protocol.PENDING_STATE_OPEN,
    /** v1.3.0：Host callId（可空 = 旧插件没给）。 */
    val callId: String = "",
    /** v1.3.0：绝对过期时间（Unix 毫秒；null = 无限期 / continued）。 */
    val expiresAt: Long? = null,
    /** v1.3.0：是否仍可应答。 */
    val answerable: Boolean = true,
    /** v1.3.0：来源（plugin | host）。 */
    val source: String = Protocol.PENDING_SOURCE_PLUGIN
) {
    /** v1.3.0：等待窗口已结束但仍可补答（契约 §5.12 不变量 2）。 */
    val isContinued: Boolean get() = state == Protocol.PENDING_STATE_CONTINUED

    companion object {
        fun fromJson(o: JsonObject) = QuestionRequest(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            questions = o.arrOrNull("questions")
                ?.mapNotNull { (it as? JsonObject)?.let(Question::fromJson) }
                ?: emptyList(),
            timeoutMs = o.long("timeoutMs"),
            multiSelect = o.bool("multiSelect"),
            state = o.str("state", Protocol.PENDING_STATE_OPEN),
            callId = o.str("callId"),
            expiresAt = o.longOrNull("expiresAt"),
            answerable = o.bool("answerable", true),
            source = o.str("source", Protocol.PENDING_SOURCE_PLUGIN)
        )
    }
}

// ---- §5.12 待答交互快照（v1.3.0） ----

/**
 * 待答问题快照项（契约 §5.12 PendingQuestion）。
 *
 * 快照是**只读恢复通道**：读取失败必须回空数组，绝不能等待、阻塞或改动瀑布。
 */
data class PendingQuestion(
    val askId: String,
    val sessionId: String,
    /** Host callId（手机与电脑共用同一个）；没有时为空串。 */
    val callId: String,
    val questions: List<Question>,
    /** "open" | "continued"。 */
    val state: String,
    /** false = 不得显示可编辑卡（契约 §5.12 不变量 5）。 */
    val answerable: Boolean,
    /** "plugin" | "host"。 */
    val source: String,
    /** 绝对过期时间（Unix 毫秒）；null = 无限期 / continued。 */
    val expiresAt: Long?,
    /** 兼容旧客户端；可缺省。 */
    val timeoutMs: Long,
    val multiSelect: Boolean
) {
    /** 转成卡片模型（UI 侧统一用 QuestionRequest 渲染）。 */
    fun toQuestionRequest(): QuestionRequest = QuestionRequest(
        askId = askId,
        sessionId = sessionId,
        questions = questions,
        timeoutMs = timeoutMs,
        multiSelect = multiSelect,
        state = state,
        callId = callId,
        expiresAt = expiresAt,
        answerable = answerable,
        source = source
    )

    companion object {
        fun fromJson(o: JsonObject) = PendingQuestion(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            callId = o.str("callId"),
            questions = o.arrOrNull("questions")
                ?.mapNotNull { (it as? JsonObject)?.let(Question::fromJson) }
                ?: emptyList(),
            state = o.str("state", Protocol.PENDING_STATE_OPEN),
            answerable = o.bool("answerable", true),
            source = o.str("source", Protocol.PENDING_SOURCE_PLUGIN),
            expiresAt = o.longOrNull("expiresAt"),
            timeoutMs = o.long("timeoutMs"),
            multiSelect = o.bool("multiSelect")
        )
    }
}

/** 待答审批快照项（契约 §5.12 PendingApproval）。 */
data class PendingApproval(
    val askId: String,
    val sessionId: String,
    val toolName: String,
    val reason: String,
    val argsPreview: String,
    /** false = 不得显示可编辑卡（超时后仍按 fail-open 交给桌面）。 */
    val answerable: Boolean,
    /** "plugin" | "host"。 */
    val source: String,
    /** 绝对过期时间（Unix 毫秒）；null = 无限期。 */
    val expiresAt: Long?
) {
    /** 转成卡片模型（UI 侧统一用 ApprovalRequest 渲染）。 */
    fun toApprovalRequest(timeoutMs: Long = 0L): ApprovalRequest = ApprovalRequest(
        askId = askId,
        sessionId = sessionId,
        toolName = toolName,
        reason = reason,
        argsPreview = argsPreview,
        timeoutMs = timeoutMs,
        answerable = answerable,
        expiresAt = expiresAt,
        source = source
    )

    companion object {
        fun fromJson(o: JsonObject) = PendingApproval(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            toolName = o.str("toolName"),
            reason = o.str("reason"),
            argsPreview = o.str("argsPreview"),
            answerable = o.bool("answerable", true),
            source = o.str("source", Protocol.PENDING_SOURCE_PLUGIN),
            expiresAt = o.longOrNull("expiresAt")
        )
    }
}

// ---- §5.13 Todo（v1.3.0） ----

/**
 * Todo 清单项（契约 §5.13）：`status` = pending | in_progress | completed。
 *
 * 数据源只有 Host `todos` 持久投影 / `todo/write` 会话事件；手机**只读**。
 */
data class TodoItem(
    val content: String,
    val status: String
) {
    val isPending: Boolean get() = status == Protocol.TODO_STATUS_PENDING
    val isInProgress: Boolean get() = status == Protocol.TODO_STATUS_IN_PROGRESS
    val isCompleted: Boolean get() = status == Protocol.TODO_STATUS_COMPLETED

    companion object {
        fun fromJson(o: JsonObject) = TodoItem(
            content = o.str("content"),
            status = o.str("status", Protocol.TODO_STATUS_PENDING)
        )
    }
}

/**
 * Todo 快照（契约 §5.13）。
 *
 * **`supported` 与 `todos == null` 必须区分**：
 *  - `supported == false` → 宿主未提供该能力 → **隐藏 UI**；
 *  - `supported == true && todos == null` → 本回合尚无清单 / 已清空 → 显示「暂无任务」。
 */
data class TodoState(
    val supported: Boolean,
    val todos: List<TodoItem>?
) {
    /** 是否有清单项（null 与空列表都算没有）。 */
    val hasTodos: Boolean get() = !todos.isNullOrEmpty()

    /** 已完成条数。 */
    val completedCount: Int get() = todos?.count { it.isCompleted } ?: 0

    /** 进行中条数。 */
    val inProgressCount: Int get() = todos?.count { it.isInProgress } ?: 0

    /** 待办条数。 */
    val pendingCount: Int get() = todos?.count { it.isPending } ?: 0

    companion object {
        fun fromJson(o: JsonObject) = TodoState(
            supported = o.bool("supported", true),
            todos = o.arrOrNull("todos")?.mapNotNull { (it as? JsonObject)?.let(TodoItem::fromJson) }
        )
    }
}

// ---- §5.14 Goal（v1.3.0） ----

/** Goal 被阻塞时的原因（契约 §5.14；仅 blocked 阶段有）。 */
data class GoalBlockedReason(
    val code: String,
    val message: String
) {
    companion object {
        fun fromJson(o: JsonObject) = GoalBlockedReason(o.str("code"), o.str("message"))
    }
}

/**
 * Goal 目标（契约 §5.14 GoalWire）。
 *
 * `id` + `revision` 是 Host CAS 的凭据：除 create 外的每个变更都要带上手机当前看到的
 * `{id, revision}`，陈旧 revision 回 `GOAL_STALE_REVISION`（客户端必须重拉，不得覆盖）。
 *
 * `activation` 是**进程内**状态、不持久；读不到就是 null（不得显示「自动续跑中」）。
 */
data class GoalWire(
    val id: String,
    val revision: Long,
    val objective: String,
    /** "active" | "paused" | "blocked" | "complete"。 */
    val phase: String,
    val blockedReason: GoalBlockedReason?,
    val maxGoalRounds: Int,
    val roundsStarted: Int,
    val createdAt: Long,
    val updatedAt: Long,
    /** "armed" | "disarmed" | null（未知）。 */
    val activation: String? = null
) {
    val isActive: Boolean get() = phase == Protocol.GOAL_PHASE_ACTIVE
    val isPaused: Boolean get() = phase == Protocol.GOAL_PHASE_PAUSED
    val isBlocked: Boolean get() = phase == Protocol.GOAL_PHASE_BLOCKED
    val isComplete: Boolean get() = phase == Protocol.GOAL_PHASE_COMPLETE

    /** 已武装（自动续跑中）；**读不到时必须为 false**（不得谎称「自动续跑中」）。 */
    val isArmed: Boolean get() = activation == Protocol.GOAL_ACTIVATION_ARMED

    companion object {
        fun fromJson(o: JsonObject) = GoalWire(
            id = o.str("id"),
            revision = o.long("revision"),
            objective = o.str("objective"),
            phase = o.str("phase", Protocol.GOAL_PHASE_ACTIVE),
            blockedReason = o.objOrNull("blockedReason")?.let(GoalBlockedReason::fromJson),
            maxGoalRounds = o.int("maxGoalRounds"),
            roundsStarted = o.int("roundsStarted"),
            createdAt = o.long("createdAt"),
            updatedAt = o.long("updatedAt"),
            activation = o.strOrNull("activation")?.takeIf { it.isNotEmpty() }
        )
    }
}

/**
 * Goal 续跑激活态（契约 §5.2 `session.goalActivationChanged` 的载荷）。
 *
 * 事件只在**进程内**触发，不持久；无当前目标时宿主不会发。
 */
data class GoalActivation(
    val id: String,
    val revision: Long,
    /** "armed" | "disarmed"。 */
    val activation: String
) {
    companion object {
        fun fromJson(o: JsonObject) = GoalActivation(
            id = o.str("id"),
            revision = o.long("revision"),
            activation = o.str("activation")
        )
    }
}

/**
 * Goal 人类操作（契约 §5.14 GoalAction）。
 *
 * 手机只能调用 Host 人类面 `ctx.goals`；**禁止** `block`（属于模型 / 策略）。
 * 除 [CREATE] 外每个操作都要带 `{id, revision}` 做 Host CAS。
 */
enum class GoalAction(val wire: String) {
    CREATE(Protocol.GOAL_ACTION_CREATE),
    EDIT(Protocol.GOAL_ACTION_EDIT),
    PAUSE(Protocol.GOAL_ACTION_PAUSE),
    RESUME(Protocol.GOAL_ACTION_RESUME),
    COMPLETE(Protocol.GOAL_ACTION_COMPLETE),
    CLEAR(Protocol.GOAL_ACTION_CLEAR);

    /** 是否必须带 expected{id, revision}（create 不带）。 */
    val requiresExpected: Boolean get() = this != CREATE

    companion object {
        /** wire 文本 → 操作；未知文本返回 null（旧宿主给的动作不认）。 */
        fun fromWire(wire: String): GoalAction? = entries.firstOrNull { it.wire == wire }
    }
}

// ---- §5.1 请求结果 ----

/** session.prompt 回包（契约 §5.1 v1.1.2）。 */
data class PromptResult(val accepted: Boolean, val mode: String) {
    companion object {
        fun fromJson(o: JsonObject) = PromptResult(
            accepted = o.bool("accepted"),
            mode = if (o.str("mode") == Protocol.MODE_STEER) Protocol.MODE_STEER else Protocol.MODE_QUEUE
        )
    }
}

/** session.create 回包（契约 §5.1 v1.0.7）：modelError 存在时**不得重复创建**。 */
data class CreateResult(
    val sessionId: String,
    val agentPreset: String,
    val model: ModelSelection? = null,
    val modelError: String? = null
) {
    companion object {
        fun fromJson(o: JsonObject) = CreateResult(
            sessionId = o.str("sessionId"),
            agentPreset = o.str("agentPreset"),
            model = o.objOrNull("model")?.let(ModelSelection::fromJson),
            modelError = o.strOrNull("modelError")?.takeIf { it.isNotEmpty() }
        )
    }
}

/** attachment.upload.begin 回包（契约 §5.1 v1.2.0）。 */
data class UploadBegin(val uploadId: String, val chunkBytes: Int) {
    companion object {
        fun fromJson(o: JsonObject) = UploadBegin(o.str("uploadId"), o.int("chunkBytes"))
    }
}

/** attachment.upload.commit 回包里的附件元数据（契约 §5.1 v1.2.0）。 */
data class UploadedAttachment(
    val kind: String,
    val name: String?,
    val mediaType: String?,
    val bytes: Long,
    val width: Int?,
    val height: Int?
) {
    companion object {
        fun fromJson(o: JsonObject) = UploadedAttachment(
            kind = o.str("kind"),
            name = o.strOrNull("name"),
            mediaType = o.strOrNull("mediaType"),
            bytes = o.long("bytes"),
            width = o.intOrNull("width"),
            height = o.intOrNull("height")
        )
    }
}

/** image.fetch 回包（契约 §5.10）：data URI + 尺寸。 */
data class FetchedImage(
    val imageId: String,
    val mediaType: String,
    val width: Int,
    val height: Int,
    val dataUri: String
) {
    companion object {
        fun fromJson(o: JsonObject) = FetchedImage(
            imageId = o.str("imageId"),
            mediaType = o.str("mediaType"),
            width = o.int("width"),
            height = o.int("height"),
            dataUri = o.str("data")
        )
    }
}
