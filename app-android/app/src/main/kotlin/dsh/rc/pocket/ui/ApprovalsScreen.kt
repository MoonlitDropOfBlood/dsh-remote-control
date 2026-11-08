/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 审批 / 提问队列（对齐 HarmonyOS 版 AskCards.ets + ApprovalQueuePage.ets）。
 *
 *  - 审批卡：工具名 / reason / argsPreview（等宽）+ 倒计时；允许 = 品牌填充，拒绝 = 描边红
 *  - 提问卡：单选 / 多选 / 自由文本；answers 按契约 §5.4 组装
 *  - *.resolved 到达即从队列消失（由 core 的 approvals / questions 流驱动）
 *
 * fail-open 口径：手机**永远不是**任务的单点阻塞——超时后由桌面答案器兜底（契约总则）。
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.ApprovalRequest
import dsh.rc.core.Question
import dsh.rc.core.QuestionRequest
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.ui.theme.countdownText
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 审批 / 提问队列页（跨会话）。
 */
@Composable
fun ApprovalsScreen(
    vm: PocketViewModel,
    onBack: () -> Unit,
) {
    val colors = PocketTheme.colors
    val approvals by vm.approvals.collectAsState()
    val questions by vm.questions.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }

    // 标题：core 的 titleOf（根会话 / 子代理都覆盖；未知回落到短 id）
    fun titleOf(sessionId: String): String = vm.titleOf(sessionId)

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2),
            ) {
                Text(
                    text = "审批 / 提问",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.labelPrimary,
                    modifier = Modifier.weight(1f),
                )
                val pending = approvals.size + questions.size
                if (pending > 0) {
                    Text(
                        text = "待处理 $pending",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.stateWarn,
                        modifier = Modifier
                            .background(colors.stateWarnTint, RoundedCornerShape(Radius.pill))
                            .padding(horizontal = Sp.sp2, vertical = 3.dp),
                    )
                }
            }
            if (approvals.isEmpty() && questions.isEmpty()) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    Text(
                        text = "没有待处理的审批 / 提问",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.labelSecondary,
                    )
                    Text(
                        text = "agent 请求审批或向你提问时，卡片会自动出现在这里",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelTertiary,
                        modifier = Modifier.padding(top = Sp.sp2),
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = Sp.sp4,
                        end = Sp.sp4,
                        top = Sp.sp2,
                        bottom = Sp.sp4,
                    ),
                    verticalArrangement = Arrangement.spacedBy(Sp.sp3),
                ) {
                    items(approvals, key = { "a-" + it.askId }) { approval ->
                        ApprovalCard(
                            vm = vm,
                            approval = approval,
                            sessionTitle = titleOf(approval.sessionId),
                        )
                    }
                    items(questions, key = { "q-" + it.askId }) { question ->
                        QuestionCard(
                            vm = vm,
                            question = question,
                            sessionTitle = titleOf(question.sessionId),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 审批卡：允许（品牌填充）/ 拒绝（描边红）。
 *
 * 倒计时按「卡片首次出现」起算（core 的 ApprovalRequest 只带 timeoutMs，不带收到时刻）。
 */
@Composable
fun ApprovalCard(
    vm: PocketViewModel,
    approval: ApprovalRequest,
    sessionTitle: String,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    val deadline = remember(approval.askId) {
        System.currentTimeMillis() + approval.timeoutMs.coerceAtLeast(0L)
    }
    val remaining = remember(approval.askId) { mutableStateOf(deadline - System.currentTimeMillis()) }
    LaunchedEffect(approval.askId) {
        while (true) {
            remaining.value = deadline - System.currentTimeMillis()
            if (remaining.value <= 0L) break
            kotlinx.coroutines.delay(1000)
        }
    }
    val total = approval.timeoutMs.coerceAtLeast(1L)
    val expired = remaining.value <= 0L

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
            .border(Hairline, colors.borderL2, RoundedCornerShape(Radius.card))
            .padding(Sp.sp4),
    ) {
        CountdownBar(title = "工具审批", remaining = remaining.value, totalMs = total)
        if (sessionTitle.isNotEmpty()) {
            Text(
                text = sessionTitle,
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = Sp.sp2),
            )
        }
        Text(
            text = approval.toolName.ifEmpty { "（未命名工具）" },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            color = colors.labelPrimary,
            modifier = Modifier.padding(top = Sp.sp3),
        )
        if (approval.reason.isNotEmpty()) {
            Text(
                text = approval.reason,
                style = MaterialTheme.typography.bodySmall,
                color = colors.labelSecondary,
                modifier = Modifier.padding(top = Sp.sp1),
            )
        }
        if (approval.argsPreview.isNotEmpty()) {
            Text(
                text = approval.argsPreview,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = colors.labelPrimary,
                maxLines = 6,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Sp.sp2)
                    .background(colors.bgLayer2, RoundedCornerShape(Radius.ctrl))
                    .padding(Sp.sp2),
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(Sp.sp3),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Sp.sp4),
        ) {
            Button(
                onClick = { vm.answerApproval(approval.askId, "approved") },
                enabled = !expired,
                shape = RoundedCornerShape(Radius.ctrl),
                modifier = Modifier.weight(1f),
            ) { Text("允许") }
            OutlinedButton(
                onClick = { vm.answerApproval(approval.askId, "rejected") },
                enabled = !expired,
                shape = RoundedCornerShape(Radius.ctrl),
                modifier = Modifier.weight(1f),
            ) { Text("拒绝") }
        }
    }
}

/**
 * 提问卡：单选 / 多选 / 自由文本，按契约 §5.4 组装 answers。
 */
@Composable
fun QuestionCard(
    vm: PocketViewModel,
    question: QuestionRequest,
    sessionTitle: String,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    val deadline = remember(question.askId) {
        System.currentTimeMillis() + question.timeoutMs.coerceAtLeast(0L)
    }
    val remaining = remember(question.askId) { mutableStateOf(deadline - System.currentTimeMillis()) }
    var freeText by remember(question.askId) { mutableStateOf("") }
    // question id → 选中的选项 label 集合
    val picks = remember(question.askId) { mutableStateMapOf<String, List<String>>() }

    LaunchedEffect(question.askId) {
        while (true) {
            remaining.value = deadline - System.currentTimeMillis()
            if (remaining.value <= 0L) break
            kotlinx.coroutines.delay(1000)
        }
    }
    val expired = remaining.value <= 0L

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
            .border(Hairline, colors.borderL2, RoundedCornerShape(Radius.card))
            .padding(Sp.sp4),
    ) {
        CountdownBar(title = "向你提问", remaining = remaining.value, totalMs = question.timeoutMs.coerceAtLeast(1L))
        if (sessionTitle.isNotEmpty()) {
            Text(
                text = sessionTitle,
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = Sp.sp2),
            )
        }
        for (q in question.questions) {
            QuestionBlock(
                question = q,
                multi = q.multiSelect || question.multiSelect,
                selected = picks[q.id].orEmpty(),
                onToggle = { label ->
                    val current = picks[q.id].orEmpty()
                    val multi = q.multiSelect || question.multiSelect
                    picks[q.id] = if (multi) {
                        if (current.contains(label)) current - label else current + label
                    } else {
                        listOf(label)
                    }
                },
            )
            HorizontalDivider(color = colors.borderL1)
        }
        Text(
            text = "自由文本回答（可选）",
            style = MaterialTheme.typography.labelSmall,
            color = colors.labelSecondary,
            modifier = Modifier.padding(top = Sp.sp3),
        )
        TextField(
            value = freeText,
            onValueChange = { freeText = it },
            placeholder = {
                Text(
                    text = "补充说明、澄清或直接作答…",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelTertiary,
                )
            },
            colors = TextFieldDefaults.colors(
                focusedContainerColor = colors.bgLayer2,
                unfocusedContainerColor = colors.bgLayer2,
                focusedIndicatorColor = colors.borderL2,
                unfocusedIndicatorColor = colors.borderL1,
                cursorColor = colors.brandFill,
                focusedTextColor = colors.labelPrimary,
                unfocusedTextColor = colors.labelPrimary,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Sp.sp1),
        )
        Button(
            onClick = {
                vm.answerQuestion(
                    question.askId,
                    buildAnswers(question, picks),
                    freeText.trim(),
                )
            },
            enabled = !expired,
            shape = RoundedCornerShape(Radius.ctrl),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Sp.sp3),
        ) { Text("提交回答") }
    }
}

/** 单个问题块（单选 / 多选）。 */
@Composable
private fun QuestionBlock(
    question: Question,
    multi: Boolean,
    selected: List<String>,
    onToggle: (String) -> Unit,
) {
    val colors = PocketTheme.colors
    Column(modifier = Modifier.padding(top = Sp.sp3)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = question.question,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = colors.labelPrimary,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (multi) "多选" else "单选",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
                modifier = Modifier
                    .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                    .padding(horizontal = Sp.sp2, vertical = 2.dp),
            )
        }
        for (option in question.options) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onToggle(option.label) }
                    .padding(vertical = Sp.sp1),
            ) {
                if (multi) {
                    Checkbox(
                        checked = selected.contains(option.label),
                        onCheckedChange = { onToggle(option.label) },
                    )
                } else {
                    RadioButton(
                        selected = selected.contains(option.label),
                        onClick = { onToggle(option.label) },
                    )
                }
                Column(modifier = Modifier.padding(start = Sp.sp2)) {
                    Text(
                        text = option.label,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.labelPrimary,
                    )
                    if (option.description.isNotEmpty()) {
                        Text(
                            text = option.description,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelSecondary,
                        )
                    }
                }
            }
        }
    }
}

/** 倒计时条（剩余时间 + 进度）。 */
@Composable
private fun CountdownBar(title: String, remaining: Long, totalMs: Long) {
    val colors = PocketTheme.colors
    val urgent = remaining in 1..20_000L
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = title,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                color = if (urgent) colors.stateError else colors.brandLabel,
                modifier = Modifier
                    .background(
                        if (urgent) colors.stateErrorTint else colors.brandTint,
                        RoundedCornerShape(Radius.pill),
                    )
                    .padding(horizontal = Sp.sp2, vertical = 3.dp),
            )
            Text(
                text = if (remaining > 0) countdownText(remaining) else "已超时",
                style = MaterialTheme.typography.labelSmall,
                color = if (remaining > 0) colors.labelSecondary else colors.stateError,
                modifier = Modifier.padding(start = Sp.sp2),
            )
        }
        androidx.compose.material3.LinearProgressIndicator(
            progress = { if (remaining > 0) remaining.toFloat() / totalMs.toFloat() else 0f },
            color = if (urgent) colors.stateError else colors.brandFill,
            trackColor = colors.bgLayer2,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Sp.sp2),
        )
    }
}

/**
 * 组装 answers（契约 §5.4）：
 *  - 单选 → `{"qid":"label"}`
 *  - 多选 → `{"qid":["a","b"]}`
 *
 * @param picks question id → 选中的 label 列表
 */
private fun buildAnswers(
    request: QuestionRequest,
    picks: Map<String, List<String>>,
): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (q in request.questions) {
        val chosen = picks[q.id].orEmpty()
        if (chosen.isEmpty()) continue
        val multi = q.multiSelect || request.multiSelect
        out[q.id] = if (chosen.size == 1 && !multi) {
            jsonString(chosen[0])
        } else {
            chosen.joinToString(",", prefix = "[", postfix = "]") { jsonString(it) }
        }
    }
    return out
}

/** JSON 字符串字面量转义。 */
private fun jsonString(s: String): String {
    val sb = StringBuilder("\"")
    for (ch in s) {
        when (ch) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> sb.append(ch)
        }
    }
    sb.append("\"")
    return sb.toString()
}
