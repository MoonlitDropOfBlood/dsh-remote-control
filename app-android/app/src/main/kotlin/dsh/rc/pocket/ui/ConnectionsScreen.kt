/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 连接管理页（多远程 + 手动配对 + 扫码入口 + 链路状态）。
 *
 * 对齐 HarmonyOS 版 ConnectionsPage.ets：
 *  - 当前连接卡：链路状态灯 + 主机名 / DSH 版本 / 插件版本 + 连接 / 断开 + KAT 自检指示
 *  - 远程列表：名称 / relay 地址 / channel + 「使用中」徽标 + 编辑 / 删除；
 *    点行 = 切到该远程并连接（stop → start）
 *  - 新增 / 编辑远程：名称 / 中继地址 / channel / secret / relayToken + 扫码配对
 *    （CameraX + ZXing → PairUri 解析 → **只回填表单，不自动连接**）
 *  - 关于入口
 *
 * 安全：secret / relayToken 只进密码框，**绝不写日志**（契约 §3.5）。
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.EpochState
import dsh.rc.pocket.data.RemoteProfile
import dsh.rc.pocket.data.relayHostLabel
import dsh.rc.pocket.ui.qr.PairUriResult
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.ui.theme.linkBusy
import dsh.rc.pocket.ui.theme.linkStateColor
import dsh.rc.pocket.ui.theme.linkStateText
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 连接管理页。
 *
 * @param initialPair 扫码结果（解析后的；非 null → 回填表单）
 * @param onPairConsumed 消费扫码结果（回填后清一次）
 * @param onScan 打开扫码页
 * @param onAbout 打开关于页
 * @param onBack 返回
 */
@Composable
fun ConnectionsScreen(
    vm: PocketViewModel,
    initialPair: PairUriResult? = null,
    onPairConsumed: () -> Unit = {},
    onScan: () -> Unit = {},
    onAbout: () -> Unit = {},
    onBack: () -> Unit = {},
) {
    val colors = PocketTheme.colors
    val remotes by vm.remotes.collectAsState()
    val activeRemote by vm.activeRemote.collectAsState()
    val linkState by vm.linkState.collectAsState()
    val hostInfo by vm.hostInfo.collectAsState()
    val kat by vm.kat.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    var editingId by remember { mutableStateOf("") }
    var formName by remember { mutableStateOf("") }
    var formRelayUrl by remember { mutableStateOf("") }
    var formChannel by remember { mutableStateOf("") }
    var formSecret by remember { mutableStateOf("") }
    var formRelayToken by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }

    // 扫码结果 → 回填表单（**只解析、不自动连接**）
    LaunchedEffect(initialPair) {
        val pair = initialPair ?: return@LaunchedEffect
        if (pair.relayUrl.isNotEmpty()) formRelayUrl = pair.relayUrl
        if (pair.channel.isNotEmpty()) formChannel = pair.channel
        if (pair.secret.isNotEmpty()) formSecret = pair.secret
        if (pair.relayToken.isNotEmpty()) formRelayToken = pair.relayToken
        if (pair.ok) {
            formError = ""
        } else {
            formError = pair.reason
        }
        editingId = ""
        onPairConsumed()
    }

    fun resetForm() {
        editingId = ""
        formName = ""
        formRelayUrl = ""
        formChannel = ""
        formSecret = ""
        formRelayToken = ""
        formError = ""
    }

    fun editProfile(p: RemoteProfile) {
        editingId = p.id
        formName = p.name
        formRelayUrl = p.relayUrl
        formChannel = p.channel
        formSecret = p.secret
        formRelayToken = p.relayToken
        formError = ""
    }

    fun saveForm() {
        val invalid = RemoteProfile.validate(formRelayUrl, formChannel, formSecret)
        if (invalid.isNotEmpty()) {
            formError = invalid
            return
        }
        val existing = remotes.firstOrNull { it.id == editingId }
        val profile = RemoteProfile(
            id = existing?.id ?: RemoteProfile.newId(),
            name = formName.trim(),
            relayUrl = formRelayUrl.trim(),
            channel = formChannel.trim(),
            secret = formSecret.trim(),
            relayToken = formRelayToken.trim(),
            lastUsedAt = existing?.lastUsedAt ?: System.currentTimeMillis(),
            epoch = existing?.epoch ?: EpochState(0, -1, ""),
        )
        vm.saveRemote(profile)
        resetForm()
    }

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                // 沉浸式下软键盘不 resize 窗口 → 显式吃 IME inset，
                // 否则底部「添加远程」表单字段会被键盘盖住
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            // ---- 顶栏 ----
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2),
            ) {
                Text(
                    text = "连接",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.labelPrimary,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onBack) { Text("返回") }
            }

            // ---- 当前连接卡 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(9.dp)
                            .background(linkStateColor(linkState), CircleShape),
                    )
                    Text(
                        text = linkStateText(linkState),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.labelPrimary,
                        modifier = Modifier.padding(start = Sp.sp2),
                    )
                    Text(
                        text = if (kat.running) "KAT 自检中…" else if (kat.ok) "KAT 通过" else "KAT 失败",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (kat.ok) colors.stateSuccess else colors.stateWarn,
                        modifier = Modifier.padding(start = Sp.sp2),
                    )
                }
                InfoRow("当前远程", activeRemote?.displayName() ?: "未配置")
                InfoRow("主机名", hostInfo?.hostName ?: "—")
                InfoRow("DSH 版本", hostInfo?.dshVersion ?: "—")
                InfoRow("插件版本", hostInfo?.pluginVersion ?: "—")
                Row(
                    horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp3),
                ) {
                    Button(
                        onClick = {
                            val id = activeRemote?.id
                            if (id != null) vm.connect(id) else vm.notify("请先添加一个远程")
                        },
                        enabled = activeRemote != null && !linkBusy(linkState),
                        shape = RoundedCornerShape(Radius.ctrl),
                        modifier = Modifier.weight(1f),
                    ) { Text("连接") }
                    OutlinedButton(
                        onClick = { vm.disconnect() },
                        enabled = linkState.name != "IDLE",
                        shape = RoundedCornerShape(Radius.ctrl),
                        modifier = Modifier.weight(1f),
                    ) { Text("断开") }
                }
            }

            // ---- 远程列表 ----
            Text(
                text = "远程主机",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.labelPrimary,
                modifier = Modifier.padding(start = Sp.sp4, top = Sp.sp3, bottom = Sp.sp1),
            )
            if (remotes.isEmpty()) {
                Text(
                    text = "还没有配置远程主机；扫描 PC 端「设置 → DSH Pocket」的二维码，或手动填写。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(horizontal = Sp.sp4, vertical = Sp.sp2),
                )
            }
            for (p in remotes) {
                val isActive = p.id == activeRemote?.id
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Sp.sp4, vertical = Sp.sp1)
                        .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                        .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                        .clickable { vm.connect(p.id) }
                        .padding(horizontal = Sp.sp3, vertical = Sp.sp3),
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = p.displayName(),
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.labelPrimary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (isActive) {
                                Text(
                                    text = "使用中",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.brandLabel,
                                    modifier = Modifier
                                        .background(colors.brandTint, RoundedCornerShape(Radius.pill))
                                        .padding(horizontal = Sp.sp2, vertical = 1.dp)
                                        .padding(start = Sp.sp2),
                                )
                            }
                        }
                        Text(
                            text = relayHostLabel(p.relayUrl),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = "channel ${p.channel}",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.labelTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    TextButton(onClick = { editProfile(p) }) { Text("编辑") }
                    TextButton(onClick = { vm.deleteRemote(p.id) }) { Text("删除") }
                }
            }

            // ---- 新增 / 编辑表单 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(Sp.sp4)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = if (editingId.isEmpty()) "添加远程" else "编辑远程",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                OutlinedTextField(
                    value = formName,
                    onValueChange = { formName = it },
                    label = { Text("名称（可选）") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp3),
                )
                OutlinedTextField(
                    value = formRelayUrl,
                    onValueChange = { formRelayUrl = it },
                    label = { Text("中继地址（ws:// 或 wss://）") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp2),
                )
                OutlinedTextField(
                    value = formChannel,
                    onValueChange = { formChannel = it.uppercase() },
                    label = { Text("channel（A-Z / 2-7，16~64 位）") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp2),
                )
                OutlinedTextField(
                    value = formSecret,
                    onValueChange = { formSecret = it },
                    label = { Text("secret（至少 32 字符）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp2),
                )
                OutlinedTextField(
                    value = formRelayToken,
                    onValueChange = { formRelayToken = it },
                    label = { Text("relayToken（可选）") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp2),
                )
                if (formError.isNotEmpty()) {
                    Text(
                        text = formError,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.stateError,
                        modifier = Modifier.padding(top = Sp.sp2),
                    )
                }
                Row(
                    horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = Sp.sp3),
                ) {
                    Button(
                        onClick = { saveForm() },
                        shape = RoundedCornerShape(Radius.ctrl),
                        modifier = Modifier.weight(1f),
                    ) { Text("保存") }
                    OutlinedButton(
                        onClick = { onScan() },
                        shape = RoundedCornerShape(Radius.ctrl),
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(
                            imageVector = Icons.Default.QrCodeScanner,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Text("扫码配对", modifier = Modifier.padding(start = Sp.sp1))
                    }
                }
                if (editingId.isNotEmpty()) {
                    TextButton(
                        onClick = { resetForm() },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("取消编辑") }
                }
            }

            // ---- 推送说明（本期不实现） ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "推送通知",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                Text(
                    text = "暂不支持：HarmonyOS 版使用华为 Push Kit，Android 端对应 FCM，" +
                        "需要 AGC / FCM 配置后再开启；插件侧的 push.register 当前只上报 harmonyos 平台，" +
                        "Android 的 token 会被忽略。审批与提问请在 App 内查看。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
            }

            // ---- 关于入口 ----
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(Sp.sp4)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .clickable { onAbout() }
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "关于 DSH Pocket",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "›",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelTertiary,
                )
            }
        }
    }
}

/** 信息行（左标题右值）。 */
@Composable
private fun InfoRow(label: String, value: String) {
    val colors = PocketTheme.colors
    Row(
        verticalAlignment = Alignment.Top,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = Sp.sp2),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = colors.labelSecondary,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = colors.labelPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
