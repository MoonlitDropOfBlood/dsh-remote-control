/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 关于页（对齐 HarmonyOS 版 AboutPage.ets）。
 *
 *  - App 名称 / 版本
 *  - 协议契约版本 / 协议版本（契约 §5.1 hello.proto）
 *  - 端到端加密说明（AES-256-GCM + HMAC，中继只见密文）
 *  - KAT 自检结果（契约 §7 硬验收：连接建立前执行，失败禁连）
 *  - 推送：**暂不支持**（见下方说明）
 *  - 本地日志（进程内环形缓冲；不含 secret / 配对 URI）
 */
package dsh.rc.pocket.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dsh.rc.core.Protocol
import dsh.rc.pocket.PocketApp
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 关于页。
 */
@Composable
fun AboutScreen(
    vm: PocketViewModel,
    onBack: () -> Unit,
) {
    val colors = PocketTheme.colors
    val kat by vm.kat.collectAsState()
    val logs by vm.logs.collectAsState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }

    Scaffold(
        containerColor = colors.bgBase,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
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
                    text = "关于",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.labelPrimary,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onBack) { Text("返回") }
            }

            // ---- 品牌头 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = PocketApp.APP_NAME,
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.labelPrimary,
                )
                Text(
                    text = "版本 " + vm.appVersion(),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
                Text(
                    text = "用 HarmonyOS / Android 手机遥控 DeepSeek Harness：看会话、答审批与提问、发任务。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(top = Sp.sp2),
                )
            }

            // ---- 契约信息 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "协议与契约",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                InfoRow("协议契约版本", Protocol.CONTRACT_VERSION)
                InfoRow("协议版本", Protocol.PROTO_VERSION.toString())
                InfoRow("HKDF salt", Protocol.HKDF_SALT)
                InfoRow("端到端加密", "AES-256-GCM（HKDF 派生 + HMAC 握手证明）")
                InfoRow("中继", "只转发密文（哑管道）")
            }

            // ---- KAT 自检 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "KAT 自检",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                Text(
                    text = kat.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (kat.ok) colors.stateSuccess else colors.stateError,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
                Text(
                    text = "契约 §7 的 key / iv / ct / tag / HMAC 测试向量逐字节比对；失败则不建立链路。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelTertiary,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
                TextButton(
                    onClick = { vm.runKatCheck() },
                    modifier = Modifier.padding(top = Sp.sp1),
                ) { Text("重新自检") }
            }

            // ---- 推送（本期不实现） ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "推送通知：暂不支持",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.stateWarn,
                )
                Text(
                    text = "HarmonyOS 版用华为 Push Kit；Android 端对应 FCM，需要 AGC / FCM 配置，" +
                        "本期不实现。插件侧 push.register 当前只上报 harmonyos 平台，Android 的 token 会被忽略。",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelSecondary,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
            }

            // ---- 日志 ----
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Sp.sp4, vertical = Sp.sp2)
                    .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                    .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                    .padding(Sp.sp4),
            ) {
                Text(
                    text = "本地日志（${logs.size} 条）",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                )
                if (logs.isEmpty()) {
                    Text(
                        text = "暂无日志",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelTertiary,
                        modifier = Modifier.padding(top = Sp.sp1),
                    )
                } else {
                    for (line in logs.take(60)) {
                        Text(
                            text = line,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = colors.labelSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
            }

            // ---- 许可 ----
            Text(
                text = "MIT License · dsh-remote-control",
                style = MaterialTheme.typography.labelSmall,
                color = colors.labelTertiary,
                modifier = Modifier.padding(
                    start = Sp.sp4,
                    end = Sp.sp4,
                    top = Sp.sp2,
                    bottom = Sp.sp6,
                ),
            )
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
