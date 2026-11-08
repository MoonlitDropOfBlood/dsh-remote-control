/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 业务模型（契约 §5）。
 *
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/protocol.ets 的 Dshrc* 接口一一对应，
 * 字段语义逐字对齐契约（含各版本注记里的「旧插件缺省 → 安全缺省」规则）。
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
    val files: List<FileRef> = emptyList()
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
                ?: emptyList()
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
    val attachments: AttachmentCaps? = null
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
            attachments = o.objOrNull("attachments")?.let(AttachmentCaps::fromJson)
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
    val timeoutMs: Long
) {
    companion object {
        fun fromJson(o: JsonObject) = ApprovalRequest(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            toolName = o.str("toolName"),
            reason = o.str("reason"),
            argsPreview = o.str("argsPreview"),
            timeoutMs = o.long("timeoutMs")
        )
    }
}

/** question.request（契约 §5.2）。 */
data class QuestionRequest(
    val askId: String,
    val sessionId: String,
    val questions: List<Question>,
    val timeoutMs: Long,
    val multiSelect: Boolean
) {
    companion object {
        fun fromJson(o: JsonObject) = QuestionRequest(
            askId = o.str("askId"),
            sessionId = o.str("sessionId"),
            questions = o.arrOrNull("questions")?.mapNotNull { (it as? JsonObject)?.let(Question::fromJson) }
                ?: emptyList(),
            timeoutMs = o.long("timeoutMs"),
            multiSelect = o.bool("multiSelect")
        )
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
