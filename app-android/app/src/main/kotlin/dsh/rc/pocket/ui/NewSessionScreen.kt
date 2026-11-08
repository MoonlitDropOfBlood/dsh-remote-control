/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 新建会话页（对齐 HarmonyOS 版 NewSessionPage.ets）。
 *
 *  - 首条任务：多行输入（**不填标题**，由 DSH 自动生成）
 *  - 工作目录：默认目录（Host `~/.dsh/remote`）+ 已有会话用过的 cwd（去重）
 *  - 模型 + 思考强度：同一张卡里的两行（模型无 efforts → 强度行隐藏）
 *  - 模式（Host Agent preset）/ 权限：目录为空 → 整块隐藏（宿主不支持不报错）
 *  - 创建：session.create('', preset, permission, cwd, model) → session.prompt(sid, 首条任务)
 *    - 宿主拒绝模式 / 权限（错误含 unsupported）→ 回退「只去掉 preset/permission，
 *      保留 cwd 与模型」再创建一次（在 ViewModel 里做）
 *    - create 成功但模型设置失败 → 提示后继续 prompt，**不得重复创建**
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import dsh.rc.core.ModelSelection
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 新建会话页。
 *
 * @param onBack 返回
 * @param onCreated 创建成功（带新会话 id）
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

    var prompt by remember { mutableStateOf("") }
    var cwd by remember { mutableStateOf("") }
    var presetId by remember { mutableStateOf("") }
    var permissionId by remember { mutableStateOf("") }
    var model by remember { mutableStateOf<ModelSelection?>(null) }
    var effort by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var showEffortPicker by remember { mutableStateOf(false) }
    var showPresetPicker by remember { mutableStateOf(false) }
    var showPermissionPicker by remember { mutableStateOf(false) }
    var showDirPicker by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }
    // 创建成功 → 跳详情页（并清一次事件）
    LaunchedEffect(createdId) {
        val id = createdId ?: return@LaunchedEffect
        vm.consumeCreatedSession()
        onCreated(id)
    }

    // 目录候选：默认目录 + 已有会话 cwd（去重，保持会话列表顺序 = 最近使用在前）
    val dirs = remember(sessions) {
        val out = ArrayList<Pair<String, String>>()
        out.add("" to "默认目录（~/.dsh/remote）")
        val seen = HashSet<String>()
        for (s in sessions) {
            val c = s.cwd
            if (c.isNotEmpty() && seen.add(c)) out.add(c to c)
        }
        out
    }
    val models = capabilities?.models.orEmpty()
    val presets = capabilities?.presets.orEmpty()
    val permissions = capabilities?.permissions.orEmpty()
    val selectedModel = models.firstOrNull {
        it.provider == model?.provider && it.model == model?.model
    }
    val efforts = selectedModel?.efforts.orEmpty()

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                // 沉浸式下软键盘不 resize 窗口 → 显式吃 IME inset，
                // 否则「首条任务」输入框会被键盘盖住（可滚动内容才能浮到键盘上方）
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            // ---- 顶栏 ----
            Text(
                text = "新建会话",
                style = MaterialTheme.typography.titleMedium,
                color = colors.labelPrimary,
                modifier = Modifier.padding(horizontal = Sp.sp4, vertical = Sp.sp3),
            )

            // ---- 首条任务 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "首条任务",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                Text(
                    text = "标题由 DSH 自动生成；这里只写你要它做的事。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
                TextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    placeholder = {
                        Text(
                            text = "例如：把最近改动的三个文件读一遍并总结",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.labelTertiary,
                        )
                    },
                    minLines = 4,
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
                        .padding(top = Sp.sp2),
                )
            }

            // ---- 工作目录 ----
            PickerCard(
                label = "工作目录",
                hint = "留空 = 主机默认目录（~/.dsh/remote）",
                value = dirs.firstOrNull { it.first == cwd }?.second ?: "默认目录（~/.dsh/remote）",
                onClick = { showDirPicker = true },
                enabled = true,
            )

            // ---- 模型 + 思考强度（同一张卡两行） ----
            if (models.isNotEmpty()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Sp.sp4, vertical = Sp.sp3)
                        .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                        .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card)),
                ) {
                    PickerRow(
                        label = "模型",
                        value = model?.display() ?: "默认",
                        onClick = { showModelPicker = true },
                    )
                    if (efforts.isNotEmpty()) {
                        HorizontalDivider(color = colors.borderL1)
                        PickerRow(
                            label = "思考强度",
                            value = efforts.firstOrNull { it.id == effort }?.name ?: "默认",
                            onClick = { showEffortPicker = true },
                        )
                    }
                }
            }

            // ---- 模式 / 权限（目录为空 → 整块隐藏） ----
            if (presets.isNotEmpty()) {
                PickerCard(
                    label = "模式",
                    hint = "Host Agent 预设",
                    value = presets.firstOrNull { it.id == presetId }?.name ?: "默认",
                    onClick = { showPresetPicker = true },
                    enabled = true,
                )
            }
            if (permissions.isNotEmpty()) {
                PickerCard(
                    label = "权限",
                    hint = "权限预设",
                    value = permissions.firstOrNull { it.id == permissionId }?.name ?: "默认",
                    onClick = { showPermissionPicker = true },
                    enabled = true,
                )
            }

            // ---- 创建 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(Sp.sp4)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card)),
            ) {
                Button(
                    onClick = {
                        vm.createSession(
                            prompt = prompt.trim(),
                            agentPreset = presetId.ifEmpty { null },
                            permission = permissionId.ifEmpty { null },
                            cwd = cwd.ifEmpty { null },
                            model = model,
                        )
                    },
                    enabled = prompt.isNotBlank(),
                    shape = RoundedCornerShape(Radius.ctrl),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("创建并发送") }
                TextButton(
                    onClick = onBack,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("取消") }
            }
        }
    }

    // ---- 选择弹窗 ----
    if (showModelPicker) {
        ModelPickerDialog(
            models = models,
            current = model,
            onDismiss = { showModelPicker = false },
            onApply = {
                model = it
                effort = ""
                showModelPicker = false
            },
        )
    }
    if (showEffortPicker && efforts.isNotEmpty()) {
        SimplePickerDialog(
            title = "思考强度",
            options = listOf("" to "默认") + efforts.map { it.id to it.name },
            selected = effort,
            onDismiss = { showEffortPicker = false },
            onPick = {
                effort = it
                showEffortPicker = false
            },
        )
    }
    if (showPresetPicker) {
        SimplePickerDialog(
            title = "模式",
            options = listOf("" to "默认") + presets.map { it.id to it.name },
            selected = presetId,
            onDismiss = { showPresetPicker = false },
            onPick = {
                presetId = it
                showPresetPicker = false
            },
        )
    }
    if (showPermissionPicker) {
        SimplePickerDialog(
            title = "权限",
            options = listOf("" to "默认") + permissions.map { it.id to it.name },
            selected = permissionId,
            onDismiss = { showPermissionPicker = false },
            onPick = {
                permissionId = it
                showPermissionPicker = false
            },
        )
    }
    // 工作目录选择（复用 SimplePickerDialog）
    if (showDirPicker) {
        SimplePickerDialog(
            title = "工作目录",
            options = dirs,
            selected = cwd,
            onDismiss = { showDirPicker = false },
            onPick = {
                cwd = it
                showDirPicker = false
            },
        )
    }
}

/** 目录选择行（点击打开弹窗）。 */
@Composable
private fun PickerCard(
    label: String,
    hint: String,
    value: String,
    onClick: () -> Unit,
    enabled: Boolean,
) {
    val colors = PocketTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Sp.sp4, vertical = Sp.sp3)
            .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
            .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
            .clickable(enabled = enabled) { onClick() }
            .padding(Sp.sp4),
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyMedium, color = colors.labelPrimary)
        Text(
            text = hint,
            style = MaterialTheme.typography.labelSmall,
            color = colors.labelSecondary,
            modifier = Modifier.padding(top = Sp.sp1),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = colors.brandLabel,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = Sp.sp2),
        )
    }
}

/** 选择行（卡内的一行）。 */
@Composable
private fun PickerRow(label: String, value: String, onClick: () -> Unit) {
    val colors = PocketTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(horizontal = Sp.sp4, vertical = Sp.sp3),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.labelPrimary,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = colors.brandLabel,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 通用单选弹窗（id ↔ 展示名）。 */
@Composable
private fun SimplePickerDialog(
    title: String,
    options: List<Pair<String, String>>,
    selected: String,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                for (option in options) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(option.first) }
                            .padding(vertical = Sp.sp1),
                    ) {
                        RadioButton(
                            selected = selected == option.first,
                            onClick = { onPick(option.first) },
                        )
                        Text(
                            text = option.second,
                            style = MaterialTheme.typography.bodySmall,
                            color = PocketTheme.colors.labelPrimary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭") }
        },
    )
}
