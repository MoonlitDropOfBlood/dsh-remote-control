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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dsh.rc.core.Capabilities
import dsh.rc.core.LinkState
import dsh.rc.core.ImageRef
import dsh.rc.core.ModelOption
import dsh.rc.core.ModelSelection
import dsh.rc.core.PermissionOption
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
    val drafts by vm.drafts.collectAsState()
    val uploadProgress by vm.uploadProgress.collectAsState()
    val uploading by vm.uploading.collectAsState()

    var draft by remember { mutableStateOf("") }
    var showAttachMenu by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var showPermissionPicker by remember { mutableStateOf(false) }
    var viewerImage by remember { mutableStateOf<ImageRef?>(null) }
    val snackbar = remember { SnackbarHostState() }

    val isSubagent = parentSessionId.isNotEmpty()
    val isOneShot = subagentMode == "one-shot"
    val readOnly = isSubagent

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(sessionId) {
        vm.openSession(sessionId)
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
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "返回",
                            tint = colors.labelPrimary,
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

            // ---- 子代理目录（契约 §5.6） ----
            if (subagents.isNotEmpty()) {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Sp.sp4, vertical = Sp.sp1),
                ) {
                    items(subagents, key = { it.sessionId }) { sub ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                                .clickable { onOpenSubagent(sub.sessionId, sessionId, sub.mode) }
                                .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
                        ) {
                            if (sub.running) {
                                Box(
                                    modifier = Modifier
                                        .size(6.dp)
                                        .background(colors.brandFill, CircleShape),
                                )
                            }
                            Text(
                                text = sub.displayLabel(),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.labelSecondary,
                                modifier = Modifier.padding(start = 4.dp),
                            )
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
                    sub = sessionModel?.reasoningEffort.orEmpty(),
                    readOnly = readOnly,
                    onClick = { if (!readOnly) showModelPicker = true },
                )
                Capsule(
                    text = permissionCapsuleText(capabilities, sessionPermission),
                    sub = if (readOnly) "只读" else "权限",
                    readOnly = readOnly,
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
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(Sp.sp3),
                    ) {
                        if (attachmentVisible) {
                            Box {
                                IconButton(
                                    onClick = { showAttachMenu = true },
                                    enabled = !uploading,
                                ) {
                                    Icon(
                                        imageVector = Icons.Default.Add,
                                        contentDescription = "添加附件",
                                        tint = colors.labelSecondary,
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
                                focusedContainerColor = colors.bgLayer1,
                                unfocusedContainerColor = colors.bgLayer1,
                                focusedIndicatorColor = colors.borderL2,
                                unfocusedIndicatorColor = colors.borderL1,
                                cursorColor = colors.brandFill,
                                focusedTextColor = colors.labelPrimary,
                                unfocusedTextColor = colors.labelPrimary,
                            ),
                            modifier = Modifier.weight(1f),
                        )
                        // 发送 / 停止聚合成同一个按钮（与 DSH composer 一致）
                        if (running && draft.isBlank() && drafts.isEmpty()) {
                            IconButton(
                                onClick = { vm.cancelTurn(sessionId, parentSessionId) },
                                modifier = Modifier
                                    .size(40.dp)
                                    .background(colors.stateErrorTint, CircleShape),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Stop,
                                    contentDescription = "停止",
                                    tint = colors.stateError,
                                )
                            }
                        } else {
                            val canSend = !uploading &&
                                (draft.isNotBlank() || drafts.isNotEmpty()) &&
                                linkState == LinkState.ONLINE
                            IconButton(
                                onClick = {
                                    vm.send(sessionId, draft.trim(), parentSessionId)
                                    draft = ""
                                },
                                enabled = canSend,
                                modifier = Modifier
                                    .size(40.dp)
                                    .background(
                                        if (canSend) colors.brandFill else colors.bgLayer2,
                                        CircleShape,
                                    ),
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.Send,
                                    contentDescription = "发送",
                                    tint = if (canSend) colors.labelOnBrand else colors.labelTertiary,
                                )
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
}

/** 输入区上方的胶囊（模型 / 权限）。 */
@Composable
private fun Capsule(
    text: String,
    sub: String,
    readOnly: Boolean,
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
    }
}

/** 模型胶囊文案（当前模型；null → 目录默认；目录里没有该模型时**不回退默认**）。 */
private fun modelCapsuleText(capabilities: Capabilities?, model: ModelSelection?): String {
    if (model != null) return model.display()
    val models = capabilities?.models.orEmpty()
    val def = models.firstOrNull { it.id == capabilities?.defaultModelId } ?: models.firstOrNull()
    return def?.let { "${it.provider}/${it.model}" } ?: "默认模型"
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
) {
    val colors = PocketTheme.colors
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
