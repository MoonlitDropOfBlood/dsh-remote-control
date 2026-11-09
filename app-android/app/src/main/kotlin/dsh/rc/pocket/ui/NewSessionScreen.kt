/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 新建会话页（逐条对齐 HarmonyOS 版 NewSessionPage.ets）。
 *
 * 结构（与 ArkTS 一一对应）：
 *  - 顶栏 topBar()：圆角方块底色的返回按钮 + 「新建会话」标题
 *  - 第一张卡 taskCard()：「任务内容」+ 描述 + 多行输入 + 圆形「+」附件入口 + 附件 chips
 *  - 工作目录 / 模式 / 权限：SelectFieldCard（下拉选择卡）
 *  - 模型 + 思考强度：ModelFieldCard（一张卡两段，中间一条 Divider）
 *  - 固定底栏：满宽「创建并发送」
 *
 * 契约条款：
 *  - §5.1  标题一律空串（DSH 自动生成）
 *  - §5.8  模型 / 思考强度：所选模型没有 efforts → 强度整段不渲染
 *  - §5.11 首发顺序（先 create → 再串行上传 → 最后带 uploads 发 prompt）在 VM 里做
 */
package dsh.rc.pocket.ui

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dsh.rc.core.ModelOption
import dsh.rc.core.ModelSelection
import dsh.rc.pocket.ui.attach.AttachmentChips
import dsh.rc.pocket.ui.attach.rememberAttachmentPicker
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.vm.FirstSendPhase
import dsh.rc.pocket.vm.FirstSendState
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 新建会话页。
 *
 * @param onBack 返回（顶栏「‹」按钮）
 * @param onCreated 创建成功（带新会话 id；首发失败也会跳详情页 → 见 VM 的 stash）
 */
@Composable
fun NewSessionScreen(
    vm: PocketViewModel,
    onBack: () -> Unit,
    onCreated: (String) -> Unit,
) {
    val colors = PocketTheme.colors
    val capabilities by vm.capabilities.collectAsState()
    val sessions by vm.sessions.collectAsState()
    val createdId by vm.createdSessionId.collectAsState()
    // 新建页**自己的**草稿表（与详情页的 vm.drafts 相互独立 → 不会跨会话串附件）
    val drafts by vm.newSessionDrafts.collectAsState()
    val uploadProgress by vm.uploadProgress.collectAsState()
    val firstSend by vm.firstSend.collectAsState()
    val attachmentCaps by vm.attachmentCaps.collectAsState()

    var prompt by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    var presetId by remember { mutableStateOf("") }
    var permissionId by remember { mutableStateOf("") }
    var modelId by remember { mutableStateOf("") }
    var effortId by remember { mutableStateOf("") }
    var showAttachMenu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    // 首发三段（create / 上传 / prompt）任一段进行中 → 禁用发送与附件入口
    val busy = firstSend.phase != FirstSendPhase.IDLE
    val attachmentVisible = attachmentCaps?.supported == true

    val models = capabilities?.models.orEmpty()
    val presets = capabilities?.presets.orEmpty()
    val permissions = capabilities?.permissions.orEmpty()
    val selectedModel = models.firstOrNull { it.id == modelId }
    val efforts = selectedModel?.efforts.orEmpty()

    // 目录刷新后原选中项可能已消失 → 回落「未选」（宿主用默认模型）
    LaunchedEffect(models) {
        if (modelId.isNotEmpty() && models.none { it.id == modelId }) {
            modelId = ""
            effortId = ""
        }
    }

    // 目录候选：默认目录 + 已有会话 cwd（去重，保持会话列表顺序 = 最近使用在前）
    val dirOptions = remember(sessions) {
        val out = ArrayList<Pair<String, String>>()
        out.add("" to "默认目录")
        val seen = HashSet<String>()
        for (s in sessions) {
            val c = s.cwd
            if (c.isNotEmpty() && seen.add(c)) out.add(c to c)
        }
        out
    }
    // 模型选项显示名（ArkTS modelItems：name · provider）
    val modelOptions = remember(models) { models.map { it.id to modelLabel(it) } }
    // 思考强度候选（首项「默认」= 不提交 reasoningEffort）
    val effortOptions = remember(efforts) {
        listOf("" to "默认") + efforts.map { it.id to it.name }
    }
    // 提交用的模型选择（provider / model 取自目录项本身，不从 id 反拆）
    val modelSelection: ModelSelection? = selectedModel?.let { m ->
        ModelSelection(
            provider = m.provider,
            model = m.model,
            reasoningEffort = effortId.takeIf { e -> e.isNotEmpty() && efforts.any { it.id == e } },
        )
    }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }
    // 创建成功 → 跳详情页（并清一次事件）
    LaunchedEffect(createdId) {
        val id = createdId ?: return@LaunchedEffect
        vm.consumeCreatedSession()
        onCreated(id)
    }

    // 离开新建页 → 清空本页草稿（对齐 HarmonyOS 的 aboutToDisappear 释放附件字节）。
    // 监听的是**导航条目**的生命周期：真正「离开页面」才清；旋转（配置变更）保留。
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY) {
                val activity = context as? Activity
                if (activity?.isChangingConfigurations != true) {
                    vm.clearNewSessionDrafts()
                }
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // 附件选择器（与详情页**同一套**，不写第二份选择器）
    val picker = rememberAttachmentPicker(
        maxItemBytes = attachmentCaps?.maxItemBytes
            ?: PocketViewModel.DEFAULT_MAX_ITEM_BYTES,
    ) { picked -> vm.addNewSessionDrafts(picked) }

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            // 固定底栏（ArkTS build() 末尾）
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgLayer1)
                    // 导航条与键盘取**并集**（同侧取最大值）→ 键盘打开时不会叠加两倍内边距
                    .windowInsetsPadding(
                        WindowInsets.navigationBars.union(WindowInsets.ime),
                    ),
            ) {
                HorizontalDivider(color = colors.borderL1)
                Button(
                    onClick = {
                        vm.createSessionWithFirstPrompt(
                            text = prompt.trim(),
                            agentPreset = presetId.ifEmpty { null },
                            permission = permissionId.ifEmpty { null },
                            cwd = cwd.ifEmpty { null },
                            model = modelSelection,
                        )
                    },
                    // 正文可空（附件-only 也合法）；创建 / 上传期间禁用
                    enabled = !busy && (prompt.isNotBlank() || drafts.isNotEmpty()),
                    shape = RoundedCornerShape(Radius.ctrl),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.brandFill,
                        contentColor = colors.labelOnBrand,
                        disabledContainerColor = colors.bgLayer2,
                        disabledContentColor = colors.labelTertiary,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Sp.sp4, vertical = Sp.sp3)
                        .height(46.dp),
                ) {
                    Text(
                        text = "创建并发送",
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontWeight = FontWeight.Medium,
                        ),
                    )
                }
                // 首发阶段提示（ArkTS creatingLabel：上传中显示 i/n，其余显示「正在创建并发送…」）
                if (busy) {
                    Text(
                        text = firstSendLabel(firstSend),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelSecondary,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Sp.sp4)
                            .padding(bottom = Sp.sp4),
                    )
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                // 沉浸式下软键盘不 resize 窗口 → 显式吃 IME inset，
                // 否则「任务内容」输入框会被键盘盖住
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            // ---- 顶栏（ArkTS topBar） ----
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp3),
            ) {
                // 返回：圆角方块底色（与详情页同一套圆角底样式）
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(Radius.ctrl))
                        .background(colors.bgLayer2)
                        .clickable(enabled = !busy) {
                            vm.clearNewSessionDrafts()
                            onBack()
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.ChevronLeft,
                        contentDescription = "返回",
                        tint = colors.labelPrimary,
                    )
                }
                Text(
                    text = "新建会话",
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.Bold,
                    ),
                    color = colors.labelPrimary,
                    modifier = Modifier.padding(start = Sp.sp3),
                )
            }

            // ---- 卡片区（ArkTS Scroll 里的 Column，间距 SP_3） ----
            Column(
                verticalArrangement = Arrangement.spacedBy(Sp.sp3),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4)
                    .padding(top = Sp.sp2, bottom = Sp.sp4),
            ) {
                // ---- 任务内容卡（ArkTS taskCard） ----
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                        .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                        .padding(Sp.sp4),
                ) {
                    Text(
                        text = "任务内容",
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontWeight = FontWeight.Medium,
                        ),
                        color = colors.labelPrimary,
                    )
                    Text(
                        text = "会话标题由 DSH 自动生成，这里写下这次要完成的事",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelSecondary,
                        modifier = Modifier.padding(top = Sp.sp1),
                    )
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        placeholder = {
                            Text(
                                text = "描述这次要完成的任务，创建后立即发送…",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.labelTertiary,
                            )
                        },
                        // 鸿蒙 TextArea 高 150vp（减上下内边距 ≈134vp）≈ 6 行
                        minLines = 6,
                        enabled = !busy,
                        shape = RoundedCornerShape(Radius.ctrl),
                        textStyle = MaterialTheme.typography.bodyMedium.copy(
                            color = colors.labelPrimary,
                        ),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedContainerColor = colors.bgLayer2,
                            unfocusedContainerColor = colors.bgLayer2,
                            focusedBorderColor = colors.borderL1,
                            unfocusedBorderColor = colors.borderL1,
                            focusedTextColor = colors.labelPrimary,
                            unfocusedTextColor = colors.labelPrimary,
                            cursorColor = colors.brandFill,
                            focusedPlaceholderColor = colors.labelTertiary,
                            unfocusedPlaceholderColor = colors.labelTertiary,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = Sp.sp2),
                    )
                    // 附件入口：圆形「+」+ 说明文字（ArkTS taskCard 的 Row）
                    if (attachmentVisible) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = Sp.sp2),
                        ) {
                            Box {
                                Box(
                                    modifier = Modifier
                                        .size(34.dp)
                                        .clip(CircleShape)
                                        .background(colors.bgLayer2)
                                        .clickable(enabled = !busy) { showAttachMenu = true },
                                    contentAlignment = Alignment.Center,
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
                                            Icon(
                                                Icons.AutoMirrored.Filled.InsertDriveFile,
                                                contentDescription = null,
                                            )
                                        },
                                        onClick = {
                                            showAttachMenu = false
                                            picker.pickFile()
                                        },
                                    )
                                }
                            }
                            Text(
                                text = "添加图片或文件（可只发附件）",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.labelSecondary,
                                modifier = Modifier.padding(start = Sp.sp2),
                            )
                        }
                        // 已选附件 chips（缩略图 / 名称 / 大小 / 删除 + 逐项上传进度）
                        AttachmentChips(
                            drafts = drafts,
                            progress = uploadProgress,
                            enabled = !busy,
                            onRemove = vm::removeNewSessionDraft,
                            modifier = Modifier.padding(top = Sp.sp2),
                        )
                    }
                    // 空内容提示（ArkTS：正文为空且没有附件时才显示）
                    if (prompt.trim().isEmpty() && drafts.isEmpty()) {
                        Text(
                            text = "请填写任务内容或选择附件",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelTertiary,
                            modifier = Modifier.padding(top = Sp.sp2),
                        )
                    }
                }

                // ---- 工作目录（ArkTS SelectFieldCard） ----
                SelectFieldCard(
                    label = "工作目录",
                    hint = "会话在主机上的工作位置，默认使用 ~/.dsh/remote",
                    options = dirOptions,
                    selectedId = cwd,
                    onSelect = { cwd = it },
                )

                // ---- 模型 + 思考强度（ArkTS ModelFieldCard；目录为空 → 整块隐藏） ----
                if (models.isNotEmpty()) {
                    ModelFieldCard(
                        modelOptions = modelOptions,
                        selectedModelId = modelId,
                        onSelectModel = { picked ->
                            if (picked != modelId) {
                                modelId = picked
                                // 换模型 → 强度重置为新模型的默认档（契约 §5.8）
                                effortId = defaultEffortId(models.firstOrNull { it.id == picked })
                            }
                        },
                        effortOptions = effortOptions,
                        selectedEffortId = effortId,
                        onSelectEffort = { effortId = it },
                    )
                }

                // ---- 模式（目录为空 → 整块隐藏） ----
                if (presets.isNotEmpty()) {
                    SelectFieldCard(
                        label = "模式",
                        hint = "决定这个会话运行哪套工具组合",
                        options = presets.map { it.id to it.name },
                        selectedId = presetId,
                        onSelect = { presetId = it },
                    )
                }

                // ---- 权限（目录为空 → 整块隐藏） ----
                if (permissions.isNotEmpty()) {
                    SelectFieldCard(
                        label = "权限",
                        hint = "权限决定主机上可执行的操作范围",
                        options = permissions.map { it.id to it.name },
                        selectedId = permissionId,
                        onSelect = { permissionId = it },
                    )
                }
            }
        }
    }
}

/** 首发阶段提示文案（ArkTS creatingLabel）。 */
private fun firstSendLabel(state: FirstSendState): String =
    when (state.phase) {
        FirstSendPhase.UPLOADING -> "正在上传附件 ${state.uploadIndex}/${state.uploadTotal}…"
        FirstSendPhase.SENDING -> "正在发送首条消息…"
        else -> "正在创建并发送…"
    }

/** 模型选项显示名（ArkTS modelItems：name · provider，name 空则退回 model）。 */
private fun modelLabel(m: ModelOption): String {
    val base = if (m.name.isNotEmpty()) m.name else m.model
    return if (m.provider.isNotEmpty()) "$base · ${m.provider}" else base
}

/** 该模型的默认思考强度（不在合法集合里 → 空串 = 「默认」档）。 */
private fun defaultEffortId(model: ModelOption?): String {
    val m = model ?: return ""
    val def = m.reasoningEffort ?: return ""
    return if (m.efforts.any { it.id == def }) def else ""
}

/**
 * 下拉配置卡（ArkTS SelectFieldCard）：标题 + 描述 + 一个下拉选择。
 *
 * @param options 选项（id ↔ 显示名）
 * @param selectedId 当前选中项 id（空串 = 第一项 / 未选）
 */
@Composable
private fun SelectFieldCard(
    label: String,
    hint: String,
    options: List<Pair<String, String>>,
    selectedId: String,
    onSelect: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(PocketTheme.colors.bgLayer1, RoundedCornerShape(Radius.card))
            .border(
                Hairline,
                PocketTheme.colors.borderL1,
                RoundedCornerShape(Radius.card),
            )
            .padding(Sp.sp4),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
            color = PocketTheme.colors.labelPrimary,
        )
        Text(
            text = hint,
            style = MaterialTheme.typography.labelSmall,
            color = PocketTheme.colors.labelSecondary,
            modifier = Modifier.padding(top = Sp.sp1),
        )
        SelectPill(
            options = options,
            selectedId = selectedId,
            onSelect = onSelect,
            modifier = Modifier.padding(top = Sp.sp2),
        )
    }
}

/**
 * 模型卡（ArkTS ModelFieldCard）：模型下拉 + 分隔线 + 思考强度下拉。
 *
 * 契约 §5.8：所选模型没有 efforts → 强度整段不渲染。
 */
@Composable
private fun ModelFieldCard(
    modelOptions: List<Pair<String, String>>,
    selectedModelId: String,
    onSelectModel: (String) -> Unit,
    effortOptions: List<Pair<String, String>>,
    selectedEffortId: String,
    onSelectEffort: (String) -> Unit,
) {
    val colors = PocketTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
            .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
            .padding(Sp.sp4),
    ) {
        Text(
            text = "模型",
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
            color = colors.labelPrimary,
        )
        Text(
            text = "决定这个会话使用的模型与思考强度",
            style = MaterialTheme.typography.labelSmall,
            color = colors.labelSecondary,
            modifier = Modifier.padding(top = Sp.sp1),
        )
        SelectPill(
            options = modelOptions,
            selectedId = selectedModelId,
            onSelect = onSelectModel,
            modifier = Modifier.padding(top = Sp.sp2),
        )
        if (effortOptions.size > 1) {
            HorizontalDivider(
                color = colors.borderL1,
                modifier = Modifier.padding(vertical = Sp.sp3),
            )
            Text(
                text = "思考强度",
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                color = colors.labelPrimary,
            )
            Text(
                text = "决定模型的思考强度，默认档交给宿主",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelSecondary,
                modifier = Modifier.padding(top = Sp.sp1),
            )
            SelectPill(
                options = effortOptions,
                selectedId = selectedEffortId,
                onSelect = onSelectEffort,
                modifier = Modifier.padding(top = Sp.sp2),
            )
        }
    }
}

/**
 * 下拉选择控件（对齐 ArkTS 的 Select：左侧当前值 + 右侧 ▼，点击弹菜单）。
 *
 * 选中项在菜单里用品牌色标出（ArkTS selectedOptionFontColor）。
 */
@Composable
private fun SelectPill(
    options: List<Pair<String, String>>,
    selectedId: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = PocketTheme.colors
    var expanded by remember { mutableStateOf(false) }
    // 找不到就取第一项（与 ArkTS selectedIndex 一致）
    val current = options.firstOrNull { it.first == selectedId } ?: options.firstOrNull()
    Box(modifier = modifier) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Radius.ctrl))
                .background(colors.bgLayer2)
                .clickable { expanded = true }
                .padding(horizontal = Sp.sp4, vertical = Sp.sp3),
        ) {
            Text(
                text = current?.second ?: "",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.labelPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(modifier = Modifier.width(Sp.sp2))
            Icon(
                imageVector = Icons.Default.ArrowDropDown,
                contentDescription = null,
                tint = colors.labelPrimary,
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
            // 鸿蒙 Select 的菜单底色 = bg_layer_1（卡片同色）
            containerColor = colors.bgLayer1,
        ) {
            for ((id, label) in options) {
                DropdownMenuItem(
                    text = {
                        Text(
                            text = label,
                            color = if (id == current?.first) {
                                colors.brandLabel
                            } else {
                                colors.labelPrimary
                            },
                        )
                    },
                    onClick = {
                        expanded = false
                        onSelect(id)
                    },
                )
            }
        }
    }
}
