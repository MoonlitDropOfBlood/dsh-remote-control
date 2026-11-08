/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 「工作步骤」过程分组的活动分类与动态标题。
 *
 * 移植自 app/entry/src/main/ets/model/process-activity.ts（**纯 TS**，ArkTS 版不依赖平台 API）。
 *
 * 与桌面端 DSH 的 `@deepseek-ai/dsh-client-ui-chat` **逐字对齐**（已核对安装源码）：
 *  - activity()：工具名 → 活动种类（14 类，未知工具兜底 tools）
 *  - message.stepProcess.* ：简体中文词条（正在… / 已…）
 *  - processTitle()：标题合成（joinTwo「并」/ comma「，」/ more「等」/ sharedPrefix「已」）
 *  - ReasoningRow 的思考摘要（latestCompletedParagraphFirstLine）
 *  - runningDetail 的运行中细节（从工具参数里挑一句「正在做什么」）
 *
 * 口径变了两侧一起变——**不要把这里的规则复制到别处**。
 */
package dsh.rc.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 过程活动种类（与桌面端 ProcessActivity 同名同义）。
 *
 * [liveLabel] = 进行中的标题（「正在读取文件」）；[doneLabel] = 完成后的标题（「已读取文件」）。
 */
enum class ProcessActivity(
    /** 进行中的标题。 */
    val liveLabel: String,
    /** 已完成后的标题。 */
    val doneLabel: String
) {
    thinking("正在分析请求", "已完成分析"),
    read("正在读取文件", "已读取文件"),
    readImage("正在读取图片", "已读取图片"),
    search("正在搜索代码", "已搜索代码"),
    write("正在写入文件", "已写入文件"),
    edit("正在编辑文件", "修改了文件"),
    commands("正在运行命令", "执行了命令"),
    code("正在运行代码", "运行了代码"),
    webSearch("正在搜索网页", "已搜索网页"),
    webFetch("正在访问网页", "已访问网页"),
    subagents("正在协调子智能体", "已协调子智能体"),
    plan("正在更新计划", "更新了计划"),
    questions("等待你的操作", "向用户提出了问题"),
    tools("正在调用工具", "已调用工具")
}

/** 活动计数（一种活动在本轮出现了多少次）。 */
data class ProcessActivityCount(
    val kind: ProcessActivity,
    val count: Int
)

/**
 * 「工作步骤」过程分组的活动分类与动态标题（**纯函数**，无状态、无平台依赖）。
 *
 * 桌面端 DSH 的「工作步骤」不是固定文案「工作步骤 · N」，而是按本轮实际发生的
 * 活动类型（读文件 / 搜索 / 执行命令 …）动态合成标题。手机端与之同源。
 */
object ProcessActivityText {

    /** 桌面端 joinTwo 的连接词：「{first}并{second}」。 */
    const val JOIN_TWO = "并"

    /** 桌面端 comma：三个及以上活动之间用「，」。 */
    const val COMMA = "，"

    /** 桌面端 sharedPrefix：「已」——两个活动都以此开头时只保留一次。 */
    const val SHARED_PREFIX = "已"

    /** 桌面端 more：活动种类超过三个时标题尾部加「等」。 */
    const val MORE_SUFFIX = "等"

    /** 桌面端 processTitle 只取前三类。 */
    const val TITLE_MAX_CATEGORIES = 3

    /** 运行中标题的细节最大字符数（桌面端 160；手机更短）。 */
    const val LIVE_DETAIL_MAX_CHARS = 48

    /** 思考块折叠时的一句话摘要长度上限（手机直接截断）。 */
    const val REASONING_PREVIEW_MAX_CHARS = 60

    /**
     * 桌面端 LIVE_TOOL_DETAIL_KEYS：从工具参数里挑「正在做什么」的一句话细节。
     * **顺序即优先级**（第一个非空的就用它）。
     */
    private val LIVE_DETAIL_KEYS: List<String> = listOf(
        "title", "description", "objective", "task", "task_name", "name", "question",
        "questions", "prompt", "message", "command", "cmd", "queries", "query",
        "pattern", "url", "uri", "file_path", "path", "target", "action", "status"
    )

    /** 换行 / 回车（逐字符定义，避免在源码里写转义序列）。 */
    private const val CHAR_CARRIAGE = '\r'
    private const val CHAR_NEWLINE = '\n'

    // ---- 分类 ----

    /** 工具名 → 活动种类（桌面端 activity() 的等价实现）。 */
    fun activityOfTool(toolName: String): ProcessActivity {
        val name = toolName.trim().lowercase()
        return when {
            name == "read" -> ProcessActivity.read
            name == "read_image" -> ProcessActivity.readImage
            name == "grep" || name == "glob" || name.endsWith("_inspect") -> ProcessActivity.search
            name == "write" -> ProcessActivity.write
            name == "edit" || name == "apply_patch" -> ProcessActivity.edit
            name == "bash" || name == "pwsh" || name == "exec_command" || name == "write_stdin" ||
                name.startsWith("terminal_") -> ProcessActivity.commands
            name == "run_code" -> ProcessActivity.code
            name == "web_search" -> ProcessActivity.webSearch
            name == "web_fetch" -> ProcessActivity.webFetch
            name == "subagent" || name.startsWith("subagent_") -> ProcessActivity.subagents
            name == "todo_write" || name == "create_goal" || name == "update_goal" ||
                name == "get_goal" -> ProcessActivity.plan
            name == "ask_user_question" || name == "request_user_input" -> ProcessActivity.questions
            else -> ProcessActivity.tools
        }
    }

    /** 活动标题文案（live=true 取「正在…」，否则取「已完成…」）。 */
    fun activityLabel(activity: ProcessActivity, live: Boolean = true): String =
        if (live) activity.liveLabel else activity.doneLabel

    /**
     * 按出现次数给活动种类排序（多的在前；次数相同按首次出现顺序），
     * 与桌面端「Distinct-call category ranking」一致。
     */
    fun rankProcessActivities(activities: List<ProcessActivity>): List<ProcessActivityCount> {
        val order = LinkedHashMap<ProcessActivity, Int>()
        for (a in activities) {
            order[a] = (order[a] ?: 0) + 1
        }
        return order.entries
            .map { ProcessActivityCount(it.key, it.value) }
            .sortedByDescending { it.count }
    }

    // ---- 标题合成 ----

    /**
     * 合成一个已结束分组的标题（桌面端 processTitle 的等价实现）：
     *  - 0 类 → 「已完成分析」
     *  - 1 类 → 「已读取文件」
     *  - 2 类 → 「已读取文件并搜索代码」（两段都带「已」时只保留一次）
     *  - 3 类 → 「已读取文件，已搜索代码，执行了命令」
     *  - 4 类以上 → 同上 + 「等」
     */
    fun composeProcessTitle(activities: List<ProcessActivity>): String {
        val counts = rankProcessActivities(activities)
        val labels = counts.take(TITLE_MAX_CATEGORIES).map { it.kind.doneLabel }
        val first = labels.firstOrNull() ?: return ProcessActivity.thinking.doneLabel
        val second = labels.getOrNull(1) ?: return first
        if (labels.size == 2) {
            val shared = SHARED_PREFIX.isNotEmpty() &&
                first.startsWith(SHARED_PREFIX) && second.startsWith(SHARED_PREFIX)
            val tail = if (shared) second.substring(SHARED_PREFIX.length) else second
            return first + JOIN_TWO + continuation(tail)
        }
        val parts = ArrayList<String>(labels.size)
        parts.add(first)
        for (i in 1 until labels.size) {
            parts.add(continuation(labels[i]))
        }
        val title = parts.joinToString(COMMA)
        return if (counts.size > TITLE_MAX_CATEGORIES) title + MORE_SUFFIX else title
    }

    /** 桌面端 continuation：首字母小写（中文无影响，英文有意义）。 */
    private fun continuation(label: String): String {
        if (label.isEmpty()) return label
        return label.substring(0, 1).lowercase() + label.substring(1)
    }

    // ---- 运行中细节 ----

    /**
     * 从工具参数 JSON 里取一句「正在做什么」的细节（桌面端 runningDetail 的等价实现）。
     * 解析失败 / 没有命中字段 → 用压成一行的原始参数。返回空串表示没有细节。
     */
    fun processLiveDetail(argsText: String, maxChars: Int = LIVE_DETAIL_MAX_CHARS): String {
        val raw = argsText.trim()
        if (raw.isEmpty()) return ""
        var text = ""
        if (raw.startsWith("{")) {
            text = liveDetailFromJson(raw)
        }
        if (text.isEmpty()) {
            text = raw
        }
        val oneLine = text.replace(Regex("\\s+"), " ").trim()
        if (oneLine.length <= maxChars) return oneLine
        return oneLine.substring(0, maxChars - 1) + "…"
    }

    /** 按 LIVE_DETAIL_KEYS 的优先级从参数 JSON 里取第一个非空字符串字段。 */
    private fun liveDetailFromJson(raw: String): String {
        val parsed = runCatching { DshrcJson.parseToJsonElement(raw) as? JsonObject }.getOrNull()
            ?: return ""
        for (key in LIVE_DETAIL_KEYS) {
            val el = parsed[key] ?: continue
            if (el !is JsonPrimitive || !el.isString) continue
            val value = el.content
            if (value.isNotBlank()) return value
        }
        return ""
    }

    // ---- 思考摘要 ----

    /** 纯函数：文本第一行。 */
    private fun firstLineOf(text: String): String {
        val nl = text.indexOf(CHAR_NEWLINE)
        return if (nl < 0) text else text.substring(0, nl)
    }

    /**
     * 桌面端 latestCompletedParagraphFirstLine：**最近一个「首行已写完」段落**的第一行。
     * 流式思考时用它做摘要——段落首行写完才前进，不会半句抖动。
     * 段落 = 空行分隔的连续非空行；段内首行「写完」的条件是段内还有下一行，
     * 或者该段被空行终结。
     */
    fun latestParagraphFirstLine(text: String): String {
        if (text.isEmpty()) return ""
        val lines = text.replace(CHAR_CARRIAGE.toString(), "").split(CHAR_NEWLINE)
        var summary = ""
        val paragraph = ArrayList<String>()
        for (line in lines) {
            if (line.isBlank()) {
                commitParagraph(paragraph, true)?.let { summary = it }
                paragraph.clear()
            } else {
                paragraph.add(line)
            }
        }
        commitParagraph(paragraph, false)?.let { summary = it }
        return summary
    }

    /** 段落是否「首行已写完」：段内还有下一行，或该段被空行终结。 */
    private fun commitParagraph(paragraph: List<String>, terminated: Boolean): String? {
        if (paragraph.isEmpty()) return null
        if (paragraph.size < 2 && !terminated) return null
        val candidate = paragraph[0].trim()
        return if (candidate.isNotEmpty()) candidate else null
    }

    /**
     * 思考块摘要（桌面端 ReasoningRow 的 collapsed summary）：
     *  - 仍在流式（running=true）→ 最近一个已完成段落的头一行（动态前进）；
     *  - 已结束 → 第一行；
     *  - 去掉 markdown 的 `**` 强调标记；过长截断。
     */
    fun reasoningPreview(text: String, running: Boolean = false): String {
        val source = if (running) latestParagraphFirstLine(text) else firstLineOf(text)
        val plain = source.replace("**", "").trim()
        if (plain.length <= REASONING_PREVIEW_MAX_CHARS) return plain
        return plain.substring(0, REASONING_PREVIEW_MAX_CHARS - 1) + "…"
    }
}

// =====================================================================================
// 顶层函数（UI 直接 import；与 ProcessActivityText 内的实现同一份）
// =====================================================================================

/** 工具名 → 活动种类（桌面端 activity() 的等价实现）。 */
fun activityOfTool(name: String): ProcessActivity = ProcessActivityText.activityOfTool(name)

/** 活动标题文案（live=true 取「正在…」，否则取「已完成…」）。 */
fun activityLabel(a: ProcessActivity, live: Boolean = true): String =
    ProcessActivityText.activityLabel(a, live)

/** 活动标题文案（旧别名，等价于 activityLabel）。 */
fun processActivityLabel(a: ProcessActivity, live: Boolean = true): String =
    ProcessActivityText.activityLabel(a, live)

/** 按出现次数给活动种类排序（多的在前）。 */
fun rankProcessActivities(activities: List<ProcessActivity>): List<ProcessActivityCount> =
    ProcessActivityText.rankProcessActivities(activities)

/** 合成一个已结束分组的标题（桌面端 processTitle 的等价实现）。 */
fun composeProcessTitle(activities: List<ProcessActivity>): String =
    ProcessActivityText.composeProcessTitle(activities)

/** 从工具参数 JSON 里取一句「正在做什么」的细节。 */
fun processLiveDetail(argsText: String, maxChars: Int = ProcessActivityText.LIVE_DETAIL_MAX_CHARS): String =
    ProcessActivityText.processLiveDetail(argsText, maxChars)

/** 从工作步骤里取一句「正在做什么」的细节（UI 直接传步骤对象）。 */
fun processLiveDetail(step: TimelineStep): String =
    ProcessActivityText.processLiveDetail(step.arguments)

/** 思考块折叠时的一句话摘要（running=true = 仍在流式）。 */
fun reasoningPreview(text: String, running: Boolean = false): String =
    ProcessActivityText.reasoningPreview(text, running)

/** 思考块最近一个「首行已写完」段落的第一行。 */
fun latestParagraphFirstLine(text: String): String = ProcessActivityText.latestParagraphFirstLine(text)
