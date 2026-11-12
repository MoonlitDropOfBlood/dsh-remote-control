/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— Goal 单行条 + Todo 折叠卡（契约 §5.13 / §5.14，v1.3.0）。
 *
 * 口径：
 *  - **Goal**：手机可执行人类面操作（新建 / 编辑 / 暂停 / 恢复 / 完成 / 清除），
 *    但**不得**触发 `block`（属于模型 / 策略）；除 create 外都带 `{id,revision}` 做 Host CAS；
 *    完成 / 清除必须二次确认；子代理会话**只读**。
 *  - **Todo**：手机**只读**；`supported=false`（宿主不支持）→ 隐藏；
 *    `todos=null`（宿主支持但本回合没有清单）→ 显示「暂无任务」。
 *  - 续跑激活态读不到（null）→ **不显示**「自动续跑中」（契约 §5.14 明令）。
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.GoalAction
import dsh.rc.core.GoalWire
import dsh.rc.core.Protocol
import dsh.rc.core.TodoItem
import dsh.rc.core.TodoState
import dsh.rc.core.TodoVisibility
import dsh.rc.core.todoVisibility
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketColors
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp

/**
 * Goal 单行条（契约 §5.14）。
 *
 * - **无数据隐藏**：既没有目标、宿主也不支持 Goal → 整条不渲染；
 * - 有目标 → 单行显示「目标 + objective + 阶段 + 续跑激活态 + 操作」；
 * - **子代理只读**：不显示任何操作按钮（手机不得替子代理改目标）；
 * - 宿主给了 `actions` 子集 → 只显示被允许的操作；没给 = 不限制。
 */
@Composable
internal fun GoalBar(
    goal: GoalWire?,
    activation: String?,
    supported: Boolean,
    readOnly: Boolean,
    allowedActions: List<String>,
    onCreate: () -> Unit,
    onEdit: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onClear: () -> Unit,
) {
    val colors = PocketTheme.colors
    if (goal == null && !supported) return
    fun allowed(action: GoalAction): Boolean =
        allowedActions.isEmpty() || allowedActions.contains(action.wire)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Sp.sp3, vertical = Sp.sp2)
            .background(colors.bgLayer1, RoundedCornerShape(Radius.ctrl))
            .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.ctrl))
            .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
    ) {
        // 与桌面 GoalBar 同款顺序：状态 → 轮次 → 文案（目标内容）→ 三个小图标按钮
        // （恢复/暂停、编辑、删除）。手机窄，状态用短词（不带「的目标」）。
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "目标",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
            )
            if (goal != null) {
                Text(
                    text = goalStatusShort(goal, activation),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelPrimary,
                    modifier = Modifier.padding(start = Sp.sp2),
                )
                if (goal.maxGoalRounds > 0) {
                    Text(
                        text = "${goal.roundsStarted}/${goal.maxGoalRounds}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelTertiary,
                        modifier = Modifier.padding(start = Sp.sp1),
                    )
                }
                Text(
                    text = goal.objective.ifEmpty { "（未填写目标内容）" },
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = Sp.sp2, end = Sp.sp1),
                )
            } else {
                Text(
                    text = "未设置",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelTertiary,
                    modifier = Modifier
                        .weight(1f)
                        .padding(start = Sp.sp2),
                )
            }
            if (readOnly) {
                Text(
                    text = "只读",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelTertiary,
                )
            } else if (goal == null) {
                if (allowed(GoalAction.CREATE)) {
                    GoalActionButton(text = "新建目标", onClick = onCreate)
                }
            } else {
                val completed = goal.phase == Protocol.GOAL_PHASE_COMPLETE
                val resumeVisible = !completed &&
                    (goal.isPaused || goal.phase == Protocol.GOAL_PHASE_BLOCKED || !goal.isArmed)
                val pauseVisible = !completed &&
                    goal.phase == Protocol.GOAL_PHASE_ACTIVE && goal.isArmed
                if (pauseVisible && allowed(GoalAction.PAUSE)) {
                    GoalIconButton(Icons.Default.Pause, "暂停目标", onPause)
                } else if (resumeVisible && allowed(GoalAction.RESUME)) {
                    GoalIconButton(Icons.Default.PlayArrow, "恢复目标", onResume)
                }
                if (!completed && allowed(GoalAction.EDIT)) {
                    GoalIconButton(Icons.Default.Edit, "编辑目标", onEdit)
                }
                if (allowed(GoalAction.CLEAR)) {
                    GoalIconButton(Icons.Default.Delete, "删除目标", onClear)
                }
            }
        }
        val blockedReason = goal?.blockedReason
        if (goal != null && goal.phase == Protocol.GOAL_PHASE_BLOCKED && blockedReason != null) {
            Text(
                text = "受阻：" + (blockedReason.message.ifEmpty { blockedReason.code }),
                style = MaterialTheme.typography.labelSmall,
                color = colors.stateError,
                modifier = Modifier.padding(top = Sp.sp1),
            )
        }
    }
}

/** 目标状态短文案（桌面 GoalBar 的 activeLabel 口径，但手机窄 → 不带「的目标」）。 */
private fun goalStatusShort(goal: GoalWire, activation: String?): String {
    if (goal.phase == Protocol.GOAL_PHASE_ACTIVE) {
        val act = activation ?: goal.activation
        return if (act == Protocol.GOAL_ACTIVATION_DISARMED) "已暂停" else "进行中"
    }
    return goalPhaseText(goal.phase)
}

/** Goal 条上的小图标按钮（28dp 圆形，对齐桌面 GoalBar 的 iconBtn）。 */
@Composable
private fun GoalIconButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    val colors = PocketTheme.colors
    IconButton(onClick = onClick, modifier = Modifier.size(28.dp)) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = colors.labelTertiary,
            modifier = Modifier.size(16.dp),
        )
    }
}

/** Goal 条上的小操作按钮（文字按钮，不抢输入区的注意力）。 */
@Composable
private fun GoalActionButton(text: String, onClick: () -> Unit) {
    val colors = PocketTheme.colors
    TextButton(
        onClick = onClick,
        contentPadding = PaddingValues(horizontal = Sp.sp2, vertical = 0.dp),
        modifier = Modifier.height(28.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = colors.labelSecondary,
        )
    }
}

/** Goal 阶段文案（契约 §5.14 phase）。 */
private fun goalPhaseText(phase: String): String = when (phase) {
    Protocol.GOAL_PHASE_ACTIVE -> "进行中"
    Protocol.GOAL_PHASE_PAUSED -> "已暂停"
    Protocol.GOAL_PHASE_BLOCKED -> "已阻塞"
    Protocol.GOAL_PHASE_COMPLETE -> "已完成"
    else -> phase
}

/** Goal 阶段配色。 */
private fun goalPhaseColor(phase: String, colors: PocketColors): Color = when (phase) {
    Protocol.GOAL_PHASE_ACTIVE -> colors.brandLabel
    Protocol.GOAL_PHASE_PAUSED -> colors.stateWarn
    Protocol.GOAL_PHASE_BLOCKED -> colors.stateError
    Protocol.GOAL_PHASE_COMPLETE -> colors.stateSuccess
    else -> colors.labelTertiary
}

/**
 * Todo 折叠卡（契约 §5.13）：手机**只读**。
 *
 * - `supported == false` → 宿主不支持 → **隐藏**；
 * - `supported == true && todos == null` → 宿主支持但本回合没有清单 → 显示「暂无任务」。
 */
@Composable
internal fun TodoCard(state: TodoState?, modifier: Modifier = Modifier) {
    val colors = PocketTheme.colors
    // v1.3.1（用户要求）：任务清单**没数据就整行隐藏**——只在有条目（LIST）时渲染，
    // 宿主不支持 / 本回合没有清单都不画（不再常驻「暂无任务」空行）。
    if (todoVisibility(state) != TodoVisibility.LIST) return
    val current = state ?: return
    var expanded by remember(current) { mutableStateOf(false) }
    val todos = current.todos.orEmpty()
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Sp.sp3, vertical = Sp.sp2)
            .background(colors.bgLayer1, RoundedCornerShape(Radius.ctrl))
            .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.ctrl)),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
        ) {
            Text(
                text = "任务清单",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
            )
            Text(
                text = if (todos.isEmpty()) "0 项" else "已完成 ${current.completedCount}/${todos.size}",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
                modifier = Modifier.padding(start = Sp.sp2),
            )
            if (current.inProgressCount > 0) {
                Text(
                    text = "进行中 ${current.inProgressCount}",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.brandLabel,
                    modifier = Modifier.padding(start = Sp.sp2),
                )
            }
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = if (expanded) "收起" else "展开",
                tint = colors.labelTertiary,
                modifier = Modifier
                    .rotate(if (expanded) 180f else 0f)
                    .padding(start = 2.dp)
                    .size(16.dp),
            )
        }
        if (expanded) {
            HorizontalDivider(color = colors.borderL1)
            if (todos.isEmpty()) {
                Text(
                    text = "暂无任务",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelTertiary,
                    modifier = Modifier.padding(horizontal = Sp.sp3, vertical = Sp.sp2),
                )
            } else {
                for (item in todos) {
                    TodoRow(item)
                    HorizontalDivider(color = colors.borderL1)
                }
            }
        }
    }
}

/** Todo 单行（三态 + 内容；**只读**）。 */
@Composable
private fun TodoRow(item: TodoItem) {
    val colors = PocketTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
    ) {
        Text(
            text = todoStatusText(item.status),
            style = MaterialTheme.typography.labelSmall,
            color = todoStatusColor(item.status, colors),
            modifier = Modifier
                .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                .padding(horizontal = Sp.sp2, vertical = 1.dp),
        )
        Text(
            text = item.content,
            style = MaterialTheme.typography.bodySmall,
            color = if (item.isCompleted) colors.labelTertiary else colors.labelPrimary,
            modifier = Modifier.padding(start = Sp.sp2),
        )
    }
}

/** Todo 状态文案（契约 §5.13 status）。 */
private fun todoStatusText(status: String): String = when (status) {
    Protocol.TODO_STATUS_PENDING -> "待办"
    Protocol.TODO_STATUS_IN_PROGRESS -> "进行中"
    Protocol.TODO_STATUS_COMPLETED -> "已完成"
    else -> status
}

/** Todo 状态配色。 */
private fun todoStatusColor(status: String, colors: PocketColors): Color = when (status) {
    Protocol.TODO_STATUS_IN_PROGRESS -> colors.brandLabel
    Protocol.TODO_STATUS_COMPLETED -> colors.stateSuccess
    else -> colors.labelSecondary
}

/**
 * Goal 新建 / 编辑弹窗（契约 §5.14）。
 *
 * `objective` 必填；`maxGoalRounds` 可选（不填则由 core 用默认值）。
 */
@Composable
internal fun GoalEditorDialog(
    mode: GoalAction,
    current: GoalWire?,
    onDismiss: () -> Unit,
    onConfirm: (objective: String, maxGoalRounds: Int?) -> Unit,
) {
    val colors = PocketTheme.colors
    var objective by remember(mode) {
        mutableStateOf(if (mode == GoalAction.EDIT) current?.objective.orEmpty() else "")
    }
    // 轮次（maxGoalRounds）由 Agent 控制，手机端不编辑 → 恒传 null（不提交该字段）。
    val canSubmit = objective.isNotBlank()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (mode == GoalAction.CREATE) "新建目标" else "编辑目标") },
        text = {
            Column {
                Text(
                    text = "目标内容",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelSecondary,
                )
                TextField(
                    value = objective,
                    onValueChange = { objective = it },
                    maxLines = 3,
                    placeholder = {
                        Text(
                            text = "要达成什么？",
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
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(objective.trim(), null) },
                enabled = canSubmit,
            ) { Text("保存") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
