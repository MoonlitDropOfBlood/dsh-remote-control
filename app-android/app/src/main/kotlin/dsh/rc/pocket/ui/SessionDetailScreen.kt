/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 会话详情页（统一时间线 + 输入区）。
 *
 * 对齐 HarmonyOS 版 SessionDetailPage.ets：
 *  - 顶栏：返回 / 标题 / 主机在线状态 / 运行中胶囊（带「插话 / 排队」只读提示）
 *  - 子代理目录入口（根会话有子代理时才显示；契约 §5.6）
 *  - 时间线：store.entries（core 分组结果）—— 过程分组折叠 / 消息气泡 / 图片 / 文件卡
 *  - 本会话的审批 / 提问卡片（输入区上方；answered 后消失）
 *  - 输入区：模型胶囊 + 权限胶囊 → 附件 chips → 输入卡（附件 / 输入 / 停止 / 发送）
 *
 * 口径：
 *  - 发送模式**只读**（跟随 DSH 设置，契约 §5.1 v1.1.2）：手机端不发 mode
 *  - subagent 的模型 / 权限**只读**；one-shot 子代理整条输入区替换为说明行
 *  - 附件走 core 的分块上传（不在这里塞 base64）
 *  - v1.3.0：输入区上方依次是 **Goal 单行条 → Todo 折叠卡 → 排队消息**
 *    （契约 §5.13 / §5.14；无数据隐藏；Todo 只读；子代理的 Goal 只读）
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dsh.rc.core.Capabilities
import dsh.rc.core.LinkState
import dsh.rc.core.GoalAction
import dsh.rc.core.GoalWire
import dsh.rc.core.ImageRef
import dsh.rc.core.ModelOption
import dsh.rc.core.ModelSelection
import dsh.rc.core.PermissionOption
import dsh.rc.core.Protocol
import dsh.rc.core.TodoItem
import dsh.rc.core.TodoState
import dsh.rc.pocket.ui.attach.AttachmentChips
import dsh.rc.pocket.ui.attach.rememberAttachmentPicker
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 会话详情页。
 *
 * @param sessionId 会话 id
 * @param parentSessionId 父会话 id（子代理详情页传；空 = 根会话）
 * @param subagentMode 子代理模式（"one-shot" / "continuable"；空 = 根会话）
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(
    vm: PocketViewModel,
    sessionId: String,
    parentSessionId: String = "",
    subagentMode: String = "",
    onBack: () -> Unit,
    onOpenSubagent: (sessionId: String, parentId: String, mode: String) -> Unit = { _, _, _ -> },
) {
    val colors = PocketTheme.colors
    val entries by vm.entries.collectAsState()
    val subagents by vm.subagents.collectAsState()
    val linkState by vm.linkState.collectAsState()
    val hostInfo by vm.hostInfo.collectAsState()
    val busyEnter by vm.busyEnter.collectAsState()
    val sessionModel by vm.sessionModel.collectAsState()
    val sessionPermission by vm.sessionPermission.collectAsState()
    val capabilities by vm.capabilities.collectAsState()
    val attachmentCaps by vm.attachmentCaps.collectAsState()
    val approvals by vm.approvals.collectAsState()
    val questions by vm.questions.collectAsState()
    val queueItems by vm.queueItems.collectAsState()
    // v1.3.0：Todo / Goal（契约 §5.13 / §5.14）
    val todos by vm.todos.collectAsState()
    val goal by vm.goal.collectAsState()
    val goalActivation by vm.goalActivation.collectAsState()
    val goalSupported by vm.goalSupported.collectAsState()
    val goalActions by vm.goalActions.collectAsState()
    val drafts by vm.drafts.collectAsState()
    val uploadProgress by vm.uploadProgress.collectAsState()
    val uploading by vm.uploading.collectAsState()
    // 历史错误**按会话归属**（对齐鸿蒙 historyErrorFor）：断链清活动会话也不抹掉已报出的错误
    val historyError by remember(sessionId) { vm.historyErrorFor(sessionId) }
        .collectAsState(initial = "")
    val historyLoading by vm.historyLoading.collectAsState()

    var draft by remember { mutableStateOf("") }
    var showAttachMenu by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var showPermissionPicker by remember { mutableStateOf(false) }
    var viewerImage by remember { mutableStateOf<ImageRef?>(null) }
    // v1.3.0：Goal 编辑弹窗 + 完成 / 清除二次确认
    var goalEditorMode by remember { mutableStateOf<GoalAction?>(null) }
    var goalConfirm by remember { mutableStateOf<GoalAction?>(null) }
    val snackbar = remember { SnackbarHostState() }

    val isSubagent = parentSessionId.isNotEmpty()
    val isOneShot = subagentMode == "one-shot"
    val readOnly = isSubagent

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(sessionId) {
        vm.openSession(sessionId)
        // 新建会话首发失败移交过来的草稿（契约 §5.11：create 已成功 → 绝不重复 create）。
        // 一次性消费；附件的 uploadId 随草稿带过来，重试只复用不重传。
        vm.takeFirstPromptDraft(sessionId)?.let { handed ->
            draft = handed.text
            if (handed.attachments.isNotEmpty()) vm.restoreDrafts(handed.attachments)
        }
    }
    DisposableEffect(sessionId) {
        onDispose { vm.closeSession() }
    }

    // 运行态 / 标题：core 的 runningOf / titleOf（根会话与子代理都覆盖）
    val running = vm.runningOf(sessionId)
    val title = vm.titleOf(sessionId)
    val sessionApprovals = approvals.filter { it.sessionId == sessionId }
    val sessionQuestions = questions.filter { it.sessionId == sessionId }
    val attachmentSupported = attachmentCaps?.supported == true
    val attachmentVisible = attachmentSupported && !isSubagent

    val picker = rememberAttachmentPicker(
        maxItemBytes = attachmentCaps?.maxItemBytes
            ?: PocketViewModel.DEFAULT_MAX_ITEM_BYTES,
    ) { picked -> vm.addDrafts(picked) }

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // ---- 顶栏 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgBase)
                    .border(Hairline, colors.borderL1),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Sp.sp4, vertical = Sp.sp2),
                ) {
                    // 返回键：浅灰圆底 + chevron 矢量图标（对齐鸿蒙 sys.symbol.chevron_left；
                    // 文字 ‹ 在不同字体下基线会飘 → 不用字符）。
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .background(colors.bgLayer2, CircleShape)
                            .clickable { onBack() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Filled.ChevronLeft,
                            contentDescription = "返回",
                            tint = colors.labelPrimary,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.labelPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = if (hostInfo != null) {
                                "主机在线 · 会话已就绪"
                            } else {
                                "主机离线 · 事件将在重连后补发"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (hostInfo != null) colors.stateSuccess else colors.labelTertiary,
                            maxLines = 1,
                        )
                    }
                    if (running) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .background(colors.brandTint, RoundedCornerShape(Radius.pill))
                                .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .background(colors.brandFill, CircleShape),
                            )
                            Text(
                                text = if (busyEnter == "steer") "运行中 · 插话" else "运行中 · 排队",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.brandLabel,
                                modifier = Modifier.padding(start = 5.dp),
                            )
                        }
                    } else {
                        Text(
                            text = "空闲",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelSecondary,
                            modifier = Modifier
                                .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                                .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
                        )
                    }
                }
            }

            // ---- 历史错误（归属本会话，不抢首页的全局错误） ----
            if (historyError.isNotEmpty()) {
                Column(
                    verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.stateErrorTint)
                        .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
                ) {
                    Text(
                        text = historyError,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.stateError,
                    )
                    Row(
                        horizontalArrangement = Arrangement.End,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        // 白色实心圆角按钮「重新加载」（红字）；加载中禁用
                        Button(
                            onClick = { vm.retryHistory(sessionId) },
                            enabled = !historyLoading,
                            shape = RoundedCornerShape(Radius.ctrl),
                            contentPadding = PaddingValues(horizontal = Sp.sp3, vertical = Sp.sp1),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = colors.bgLayer1,
                                contentColor = colors.stateError,
                                disabledContainerColor = colors.bgLayer1,
                                disabledContentColor = colors.labelTertiary,
                            ),
                            modifier = Modifier.height(32.dp),
                        ) {
                            Text(
                                text = "重新加载",
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
            }

            // ---- 子代理目录（契约 §5.6） ----
            if (subagents.isNotEmpty()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = Sp.sp4, end = Sp.sp4, top = Sp.sp1, bottom = Sp.sp1),
                ) {
                    // 「子代理」前缀标签（对齐鸿蒙 subagentBar）
                    Text(
                        text = "子代理",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelSecondary,
                        modifier = Modifier.padding(end = Sp.sp2),
                    )
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                        modifier = Modifier.weight(1f),
                    ) {
                    items(subagents, key = { it.sessionId }) { sub ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                                .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.pill))
                                .clickable { onOpenSubagent(sub.sessionId, sessionId, sub.mode) }
                                .padding(horizontal = Sp.sp3, vertical = Sp.sp1 + 2.dp),
                        ) {
                            // 运行态圆点：运行中用品牌色，否则灰（对齐鸿蒙 SubagentChip）
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .background(
                                        if (sub.running) colors.brandFill else colors.labelTertiary,
                                        CircleShape,
                                    ),
                            )
                            Text(
                                text = sub.displayLabel(),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.labelPrimary,
                                modifier = Modifier.padding(start = 5.dp),
                            )
                            // 一次性子代理角标（对齐鸿蒙 SubagentChip 的「一次性」标签）
                            if (sub.mode == "one-shot") {
                                Text(
                                    text = "一次性",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.labelSecondary,
                                    modifier = Modifier
                                        .padding(start = Sp.sp1)
                                        .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                                        .padding(horizontal = 6.dp, vertical = 1.dp),
                                )
                            }
                        }
                    }
                    }
                }
            }

            // ---- 时间线 ----
            Box(modifier = Modifier.weight(1f)) {
                if (entries.isEmpty()) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        Text(
                            text = "还没有消息",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.labelSecondary,
                        )
                        Text(
                            text = "在下方输入提示词，回复会以流式气泡呈现",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.labelTertiary,
                            modifier = Modifier.padding(top = Sp.sp1),
                        )
                    }
                } else {
                    TimelineList(
                        entries = entries,
                        running = running,
                        onToggleGroup = vm::toggleGroup,
                        onToggleItem = vm::toggleItem,
                        onImageClick = { viewerImage = it },
                        contentPadding = PaddingValues(
                            start = Sp.sp4,
                            end = Sp.sp4,
                            top = Sp.sp2,
                            bottom = Sp.sp3,
                        ),
                    )
                }
            }

            // ---- 本会话的审批 / 提问（输入区上方） ----
            if (sessionApprovals.isNotEmpty() || sessionQuestions.isNotEmpty()) {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(220.dp)
                        .padding(horizontal = Sp.sp3),
                    verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                ) {
                    items(sessionApprovals, key = { "a-" + it.askId }) { approval ->
                        ApprovalCard(vm = vm, approval = approval, sessionTitle = "")
                    }
                    items(sessionQuestions, key = { "q-" + it.askId }) { question ->
                        QuestionCard(vm = vm, question = question, sessionTitle = "")
                    }
                }
            }

            // ---- Goal 单行条（契约 §5.14；无数据隐藏；子代理只读） ----
            GoalBar(
                goal = goal,
                activation = goalActivation,
                supported = goalSupported,
                readOnly = readOnly,
                allowedActions = goalActions,
                onCreate = { goalEditorMode = GoalAction.CREATE },
                onEdit = { goalEditorMode = GoalAction.EDIT },
                onPause = { vm.goalAction(sessionId, GoalAction.PAUSE) },
                onResume = { vm.goalAction(sessionId, GoalAction.RESUME) },
                onClear = { goalConfirm = GoalAction.CLEAR },
            )

            // ---- Todo 折叠卡（契约 §5.13；只读；宿主不支持时隐藏） ----
            TodoCard(state = todos)

            // ---- 排队消息（宿主推来的，只展示不猜测；契约 §5.2） ----
            if (queueItems.isNotEmpty()) {
                Column(modifier = Modifier.padding(horizontal = Sp.sp3)) {
                    Text(
                        text = "排队消息",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelTertiary,
                    )
                    for (item in queueItems) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 2.dp)
                                .background(colors.bgLayer2, RoundedCornerShape(Radius.ctrl))
                                .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
                        ) {
                            Text(
                                text = item.text.ifEmpty { "（空消息）" },
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.labelSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = "排队中",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.stateWarn,
                                modifier = Modifier
                                    .background(colors.stateWarnTint, RoundedCornerShape(Radius.pill))
                                    .padding(horizontal = Sp.sp2, vertical = 1.dp),
                            )
                        }
                    }
                }
            }

            // ---- 模型 / 权限胶囊（subagent 只读） ----
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
            ) {
                Capsule(
                    text = modelCapsuleText(capabilities, sessionModel),
                    sub = modelEffortText(capabilities, sessionModel),
                    trailingText = if (readOnly) "只读" else "",
                    showChevron = !readOnly,
                    onClick = { if (!readOnly) showModelPicker = true },
                )
                Capsule(
                    text = permissionCapsuleText(capabilities, sessionPermission),
                    sub = "",
                    trailingText = if (readOnly) "只读" else "权限",
                    showChevron = !readOnly,
                    onClick = { if (!readOnly) showPermissionPicker = true },
                )
            }

            // ---- 输入区 ----
            if (isOneShot) {
                Row(
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgLayer1)
                        .border(Hairline, colors.borderL1)
                        .padding(Sp.sp4),
                ) {
                    Text(
                        text = "一次性子代理 · 仅查看",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.labelSecondary,
                    )
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgBase)
                        .border(Hairline, colors.borderL1)
                        // 沉浸式（enableEdgeToEdge）下窗口不再因软键盘 resize，
                        // 必须显式吃掉 IME inset，否则输入栏会被键盘整条盖住（发送键点不到）。
                        .imePadding(),
                ) {
                    AttachmentChips(
                        drafts = drafts,
                        progress = uploadProgress,
                        enabled = !uploading,
                        onRemove = vm::removeDraft,
                    )
                    if (uploading) {
                        Text(
                            text = "正在上传附件…",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelSecondary,
                            modifier = Modifier.padding(horizontal = Sp.sp3, vertical = Sp.sp1),
                        )
                    }
                    // composer 卡片：一张白色圆角面板里放「附件 / 输入 / 停止 / 发送」
                    //（对齐鸿蒙 SessionDetailPage.ets：卡片就是容器，输入框不再自带描边 → 避免框中框）
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Sp.sp3)
                            .padding(top = Sp.sp1, bottom = Sp.sp3),
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(colors.bgLayer1, RoundedCornerShape(Radius.composer))
                                .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.composer))
                                .padding(Sp.sp2),
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (attachmentVisible) {
                                    Box {
                                        // 灰色圆形「+」入口（鸿蒙：Circle 按钮 + bg_layer_2）
                                        Box(
                                            modifier = Modifier
                                                .size(36.dp)
                                                .background(colors.bgLayer2, CircleShape)
                                                .clickable(enabled = !uploading) { showAttachMenu = true },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                imageVector = Icons.Default.Add,
                                                contentDescription = "添加附件",
                                                tint = colors.labelSecondary,
                                                modifier = Modifier.size(20.dp),
                                            )
                                        }
                                        DropdownMenu(
                                            expanded = showAttachMenu,
                                            onDismissRequest = { showAttachMenu = false },
                                        ) {
                                            DropdownMenuItem(
                                                text = { Text("图片") },
                                                leadingIcon = {
                                                    Icon(Icons.Default.Image, contentDescription = null)
                                                },
                                                onClick = {
                                                    showAttachMenu = false
                                                    picker.pickImage()
                                                },
                                            )
                                            DropdownMenuItem(
                                                text = { Text("文件") },
                                                leadingIcon = {
                                                    Icon(Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null)
                                                },
                                                onClick = {
                                                    showAttachMenu = false
                                                    picker.pickFile()
                                                },
                                            )
                                        }
                                    }
                                }
                                TextField(
                                    value = draft,
                                    onValueChange = { draft = it },
                                    placeholder = {
                                        Text(
                                            text = "输入提示词…",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = colors.labelTertiary,
                                        )
                                    },
                                    colors = TextFieldDefaults.colors(
                                        // 卡片已经是容器 → 输入框自身透明、无下划线（避免框中框）
                                        focusedContainerColor = colors.bgLayer1,
                                        unfocusedContainerColor = colors.bgLayer1,
                                        disabledContainerColor = colors.bgLayer1,
                                        focusedIndicatorColor = Color.Transparent,
                                        unfocusedIndicatorColor = Color.Transparent,
                                        disabledIndicatorColor = Color.Transparent,
                                        cursorColor = colors.brandFill,
                                        focusedTextColor = colors.labelPrimary,
                                        unfocusedTextColor = colors.labelPrimary,
                                    ),
                                    modifier = Modifier
                                        .weight(1f)
                                        .padding(horizontal = Sp.sp2),
                                )
                                // 发送 / 停止聚合成同一个按钮（与 DSH composer 一致）
                                //  - 输入区有内容（文字或附件）→ 永远显示「发送」（运行中也发，走插话/排队）
                                //  - 输入区为空且 agent 运行中 → 显示「停止」（取消当前 turn）
                                //  - 输入区为空且空闲 → 发送置灰（禁用态：灰底 + 灰图标）
                                if (running && draft.isBlank() && drafts.isEmpty()) {
                                    Box(
                                        modifier = Modifier
                                            .size(40.dp)
                                            .background(colors.stateErrorTint, CircleShape)
                                            .clickable { vm.cancelTurn(sessionId, parentSessionId) },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(
                                            imageVector = Icons.Default.Stop,
                                            contentDescription = "停止",
                                            tint = colors.stateError,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                } else {
                                    val canSend = !uploading &&
                                        (draft.isNotBlank() || drafts.isNotEmpty()) &&
                                        linkState == LinkState.ONLINE
                                    Box(
                                        modifier = Modifier
                                            .size(40.dp)
                                            .background(
                                                if (canSend) colors.brandFill else colors.bgLayer2,
                                                CircleShape,
                                            )
                                            .clickable(enabled = canSend) {
                                                vm.send(sessionId, draft.trim(), parentSessionId)
                                                draft = ""
                                            },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(
                                            imageVector = Icons.AutoMirrored.Filled.Send,
                                            contentDescription = "发送",
                                            tint = if (canSend) colors.labelOnBrand else colors.labelTertiary,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- 模型 / 权限选择 ----
    if (showModelPicker) {
        ModelPickerDialog(
            models = capabilities?.models.orEmpty(),
            current = sessionModel,
            onDismiss = { showModelPicker = false },
            onApply = { selection ->
                vm.selectModel(sessionId, selection)
                showModelPicker = false
            },
        )
    }
    if (showPermissionPicker) {
        PermissionPickerDialog(
            options = capabilities?.permissions.orEmpty(),
            current = sessionPermission,
            onDismiss = { showPermissionPicker = false },
            onApply = { permission ->
                vm.selectPermission(sessionId, permission)
                showPermissionPicker = false
            },
        )
    }

    // ---- 大图查看（契约 §5.10：image.fetch 按需拉取） ----
    viewerImage?.let { image ->
        ImageViewerDialog(
            vm = vm,
            image = image,
            onDismiss = { viewerImage = null },
        )
    }

    // ---- Goal 新建 / 编辑（契约 §5.14：objective + maxGoalRounds） ----
    goalEditorMode?.let { mode ->
        GoalEditorDialog(
            mode = mode,
            current = goal,
            onDismiss = { goalEditorMode = null },
            onConfirm = { objective, maxRounds ->
                goalEditorMode = null
                vm.goalAction(sessionId, mode, objective, maxRounds)
            },
        )
    }

    // ---- Goal 完成 / 清除：二次确认（契约 §5.14） ----
    goalConfirm?.let { mode ->
        AlertDialog(
            onDismissRequest = { goalConfirm = null },
            title = { Text(if (mode == GoalAction.COMPLETE) "完成目标？" else "清除目标？") },
            text = {
                Text(
                    text = if (mode == GoalAction.COMPLETE) {
                        "标记当前目标为已完成？桌面端会同步看到这次变更。"
                    } else {
                        "清除当前目标？这个动作不可撤销。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = PocketTheme.colors.labelSecondary,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        goalConfirm = null
                        vm.goalAction(sessionId, mode)
                    },
                ) { Text("确认") }
            },
            dismissButton = {
                TextButton(onClick = { goalConfirm = null }) { Text("取消") }
            },
        )
    }
}

/**
 * 输入区上方的胶囊（模型 / 权限）。
 *
 * 结构对齐鸿蒙 SessionDetailPage.ets：
 *  - 主文案（模型显示名 / 权限名）；
 *  - 第二段小字 = 思考强度**显示名**（没有则不显示）；
 *  - 第三段小字 = 「只读」（subagent）或「权限」（根会话）；
 *  - 右侧下拉箭头（**只有根会话**有 → 可点开切换；subagent 只读无箭头）。
 */
@Composable
private fun Capsule(
    text: String,
    sub: String,
    trailingText: String,
    showChevron: Boolean,
    onClick: () -> Unit,
) {
    val colors = PocketTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
            .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.pill))
            .clickable { onClick() }
            .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = colors.labelSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (sub.isNotEmpty()) {
            Text(
                text = sub,
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
                modifier = Modifier.padding(start = Sp.sp1),
            )
        }
        if (trailingText.isNotEmpty()) {
            Text(
                text = trailingText,
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
                modifier = Modifier.padding(start = Sp.sp1),
            )
        }
        if (showChevron) {
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                tint = colors.labelTertiary,
                modifier = Modifier
                    .padding(start = 2.dp)
                    .size(16.dp),
            )
        }
    }
}

/**
 * 模型胶囊文案（目录里的**显示名**；目录里没有该模型才退回 provider/model 截断）。
 *
 * 对齐鸿蒙 modelCapsuleText()：与 PC composer 同口径——用户看到的是模型目录里的
 * 友好名（如「DeepSeek Chat」），不是「deepseek/deepseek-chat」这种裸 id。
 */
private fun modelCapsuleText(capabilities: Capabilities?, model: ModelSelection?): String {
    val models = capabilities?.models.orEmpty()
    if (model != null) {
        val hit = models.firstOrNull { it.provider == model.provider && it.model == model.model }
        if (hit != null) return hit.name.ifEmpty { hit.model }
        // 目录里没有该模型（宿主目录变了）→ provider/model 截断显示
        val ref = "${model.provider}/${model.model}"
        return if (ref.length > 24) ref.substring(0, 24) + "…" else ref
    }
    val def = models.firstOrNull { it.id == capabilities?.defaultModelId } ?: models.firstOrNull()
    return def?.let { it.name.ifEmpty { it.model } } ?: "模型"
}

/**
 * 思考强度的**显示名**（对齐鸿蒙 modelEffortText()，与 PC 同口径）。
 *
 *  - 强度 id = 会话显式选择 > 所选模型的默认强度；
 *  - 显示名 = 该模型 efforts 里对应 id 的 name（目录里没有就原样显示 id）；
 *  - 没有强度 → 空串（胶囊里不显示这一段）。
 */
private fun modelEffortText(capabilities: Capabilities?, model: ModelSelection?): String {
    val models = capabilities?.models.orEmpty()
    val option: ModelOption? = if (model != null) {
        models.firstOrNull { it.provider == model.provider && it.model == model.model }
    } else {
        models.firstOrNull { it.id == capabilities?.defaultModelId } ?: models.firstOrNull()
    }
    var effortId = model?.reasoningEffort.orEmpty()
    if (effortId.isEmpty() && option != null) effortId = option.reasoningEffort.orEmpty()
    if (effortId.isEmpty()) return ""
    val efforts = option?.efforts.orEmpty()
    return efforts.firstOrNull { it.id == effortId }?.name ?: effortId
}

/** 权限胶囊文案（"custom" 是派生态，只展示）。 */
private fun permissionCapsuleText(capabilities: Capabilities?, permission: String?): String {
    if (permission == "custom") return "自定义权限"
    if (!permission.isNullOrEmpty()) {
        val hit = capabilities?.permissions.orEmpty().firstOrNull { it.id == permission }
        return hit?.name ?: permission
    }
    val def = capabilities?.permissions
        ?.firstOrNull { it.id == capabilities.defaultPermission }
        ?: capabilities?.permissions?.firstOrNull()
    return def?.name ?: "默认权限"
}

/**
 * 模型 + 思考强度选择（契约 §5.8）。
 *
 * 思考强度候选取自所选模型的 efforts；「默认」档提交空串（不带 reasoningEffort）。
 *
 * 详情页与新建会话页共用（公开可见）。
 */
@Composable
fun ModelPickerDialog(
    models: List<ModelOption>,
    current: ModelSelection?,
    onDismiss: () -> Unit,
    onApply: (ModelSelection) -> Unit,
) {
    var pickedModel by remember { mutableStateOf(current) }
    var pickedEffort by remember { mutableStateOf(current?.reasoningEffort ?: "") }
    var pickingEffort by remember { mutableStateOf(false) }

    val selected = models.firstOrNull { it.provider == pickedModel?.provider && it.model == pickedModel?.model }
    val efforts = selected?.efforts.orEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("模型与思考强度") },
        text = {
            if (pickingEffort && efforts.isNotEmpty()) {
                Column {
                    Text(
                        text = "思考强度",
                        style = MaterialTheme.typography.bodySmall,
                        color = PocketTheme.colors.labelSecondary,
                    )
                    RadioRow(
                        label = "默认",
                        checked = pickedEffort.isEmpty(),
                        onClick = { pickedEffort = "" },
                    )
                    for (effort in efforts) {
                        RadioRow(
                            label = effort.name,
                            checked = pickedEffort == effort.id,
                            onClick = { pickedEffort = effort.id },
                        )
                    }
                }
            } else {
                Column {
                    for (model in models) {
                        RadioRow(
                            label = model.name.ifEmpty { model.model } + " · " + model.provider,
                            checked = pickedModel?.provider == model.provider &&
                                pickedModel?.model == model.model,
                            onClick = {
                                pickedModel = ModelSelection(model.provider, model.model)
                                pickedEffort = model.reasoningEffort ?: ""
                                pickingEffort = model.efforts.isNotEmpty()
                            },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val model = pickedModel
                    if (model != null) {
                        onApply(
                            ModelSelection(
                                provider = model.provider,
                                model = model.model,
                                reasoningEffort = pickedEffort.ifEmpty { null },
                            ),
                        )
                    } else {
                        onDismiss()
                    }
                },
                enabled = pickedModel != null,
            ) { Text("应用") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

/** 权限选择（契约 §5.8；"custom" 不在候选项里——它是宿主派生态）。 */
@Composable
private fun PermissionPickerDialog(
    options: List<PermissionOption>,
    current: String?,
    onDismiss: () -> Unit,
    onApply: (String) -> Unit,
) {
    var picked by remember { mutableStateOf(current ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("切换权限") },
        text = {
            Column {
                if (current == "custom") {
                    Text(
                        text = "当前是自定义权限；应用预设后将替换这组自定义设置。",
                        style = MaterialTheme.typography.labelSmall,
                        color = PocketTheme.colors.labelSecondary,
                    )
                }
                for (option in options) {
                    RadioRow(
                        label = option.name,
                        checked = picked == option.id,
                        onClick = { picked = option.id },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onApply(picked) },
                enabled = picked.isNotEmpty(),
            ) { Text("应用") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}

/** 单选行。 */
@Composable
private fun RadioRow(label: String, checked: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(vertical = Sp.sp1),
    ) {
        RadioButton(selected = checked, onClick = onClick)
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = PocketTheme.colors.labelPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 大图查看（缩略图 → image.fetch 拉大图；失败只提示，不阻塞会话）。 */
@Composable
private fun ImageViewerDialog(
    vm: PocketViewModel,
    image: ImageRef,
    onDismiss: () -> Unit,
) {    val colors = PocketTheme.colors
    var dataUri by remember(image.imageId) { mutableStateOf(image.thumb) }
    LaunchedEffect(image.imageId) {
        val fetched = vm.fetchImage(image.imageId)
        if (fetched != null) {
            dataUri = fetched.dataUri
        }
    }
    Dialog(onDismissRequest = onDismiss) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.imageViewerBg, RoundedCornerShape(Radius.card))
                .padding(Sp.sp4),
        ) {
            val bitmap = remember(dataUri) { decodeDataUri(dataUri) }
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = null,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Text(
                    text = "图片加载中…",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelSecondary,
                )
            }
            Button(onClick = onDismiss, modifier = Modifier.padding(top = Sp.sp3)) {
                Text("关闭")
            }
        }
    }
}
