/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 首页 = 会话列表（对齐 HarmonyOS 版 Index.ets）。
 *
 *  - 顶栏：左标题（会话 / 已归档）+ 归档视图切换；右上角 = **连接信息胶囊**
 *    （链路状态点 + 状态文案 + 当前远程名）→ 连接管理页
 *  - 待处理横幅：审批 / 提问数量 > 0 时显示 → 审批队列页
 *  - 会话列表：下拉刷新 + 会话卡（标题 / 运行徽标 / 工作目录 / 相对时间）
 *  - **左滑归档**（契约 §5.9）：Host 真实归档（session.archive / session.unarchive），
 *    不做本机假归档
 *  - 底部固定操作区：「新建会话」品牌主按钮
 *
 * 显示规则（契约 §5.3）：只显示根会话（无 parentSessionId 且 origin != "subagent"）
 * 且非 blank，按 updatedAt 降序。
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import dsh.rc.core.LinkState
import dsh.rc.core.SessionSummary
import dsh.rc.pocket.ui.theme.Hairline
import dsh.rc.pocket.ui.theme.PocketTheme
import dsh.rc.pocket.ui.theme.Radius
import dsh.rc.pocket.ui.theme.Sp
import dsh.rc.pocket.ui.theme.linkStateColor
import dsh.rc.pocket.ui.theme.linkStateText
import dsh.rc.pocket.ui.theme.relTime
import dsh.rc.pocket.vm.PocketViewModel

/**
 * 会话列表页（首页）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    vm: PocketViewModel,
    onOpenSession: (String) -> Unit,
    onOpenConnections: () -> Unit,
    onOpenApprovals: () -> Unit,
    onCreateSession: () -> Unit,
) {
    val colors = PocketTheme.colors
    val sessions by vm.sessions.collectAsState()
    val archivedIds by vm.archivedSessionIds.collectAsState()
    val linkState by vm.linkState.collectAsState()
    val approvals by vm.approvals.collectAsState()
    val questions by vm.questions.collectAsState()
    val activeRemote by vm.activeRemote.collectAsState()

    var showArchived by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        vm.messages.collect { snackbar.showSnackbar(it) }
    }

    val pending = approvals.size + questions.size
    val visible = remember(sessions, archivedIds, showArchived) {
        sessions
            .filter { s -> s.isRootVisible }
            .filter { s ->
                val archived = s.archived || archivedIds.contains(s.sessionId)
                archived == showArchived
            }
            .sortedByDescending { it.updatedAt }
    }

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
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = Sp.sp4, end = Sp.sp4, top = Sp.sp2, bottom = Sp.sp3),
            ) {
                Text(
                    text = if (showArchived) "已归档" else "会话",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.labelPrimary,
                )
                if (showArchived) {
                    Text(
                        text = "返回",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.brandLabel,
                        modifier = Modifier
                            .clickable { showArchived = false }
                            .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
                    )
                }
                Box(modifier = Modifier.weight(1f))
                // 连接信息胶囊 → 连接管理页
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                        .clickable { onOpenConnections() }
                        .padding(horizontal = Sp.sp2, vertical = Sp.sp1),
                ) {
                    Box(
                        modifier = Modifier
                            .size(7.dp)
                            .background(linkStateColor(linkState), CircleShape),
                    )
                    Text(
                        text = linkStateText(linkState),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelSecondary,
                        modifier = Modifier.padding(start = 5.dp),
                    )
                    Text(
                        text = activeRemote?.displayName() ?: "未配置",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .padding(start = Sp.sp2)
                            .widthIn(max = 120.dp),
                    )
                }
            }

            // ---- 待处理横幅 ----
            if (pending > 0) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = Sp.sp4, end = Sp.sp4, bottom = Sp.sp3)
                        .background(colors.stateWarnTint, RoundedCornerShape(Radius.ctrl))
                        .clickable { onOpenApprovals() }
                        .padding(horizontal = Sp.sp3, vertical = Sp.sp2),
                ) {
                    Text(
                        text = "有 $pending 个审批 / 提问待处理",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.stateWarn,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "去处理 ›",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.brandLabel,
                    )
                }
            }

            // ---- 会话列表 ----
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    vm.refreshSessions()
                    refreshing = false
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                if (visible.isEmpty()) {
                    EmptyState(
                        showArchived = showArchived,
                        online = linkState == LinkState.ONLINE,
                    )
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(
                            start = Sp.sp4,
                            end = Sp.sp4,
                            bottom = Sp.sp2,
                        ),
                        verticalArrangement = Arrangement.spacedBy(Sp.sp2),
                    ) {
                        items(visible, key = { it.sessionId }) { session ->
                            SessionCard(
                                session = session,
                                archived = showArchived,
                                onOpen = { onOpenSession(session.sessionId) },
                                onArchive = { vm.setArchived(session.sessionId, !showArchived) },
                            )
                        }
                    }
                }
            }

            // ---- 底部：新建会话（归档视图只做恢复，不显示） ----
            if (!showArchived) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.bgLayer1)
                        .border(Hairline, colors.borderL1)
                        .padding(Sp.sp4),
                ) {
                    Button(
                        onClick = onCreateSession,
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(Radius.ctrl),
                    ) {
                        Text("新建会话")
                    }
                }
            }
        }
    }
}

/** 会话卡：标题 / 运行徽标 / 工作目录 / 相对时间 + 左滑归档。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionCard(
    session: SessionSummary,
    archived: Boolean,
    onOpen: () -> Unit,
    onArchive: () -> Unit,
) {
    val colors = PocketTheme.colors
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                onArchive()
            }
            // 归档是异步的（Host 权威），这里立刻复位，不留下「已划走」的残影
            false
        },
    )
    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        enableDismissFromEndToStart = true,
        backgroundContent = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Sp.sp2),
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        if (archived) colors.bgLayer2 else colors.brandTint,
                        RoundedCornerShape(Radius.card),
                    )
                    .padding(horizontal = Sp.sp4),
            ) {
                Icon(
                    imageVector = if (archived) Icons.Default.Unarchive else Icons.Default.Archive,
                    contentDescription = null,
                    tint = if (archived) colors.labelSecondary else colors.brandLabel,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    text = if (archived) "恢复" else "归档",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (archived) colors.labelSecondary else colors.brandLabel,
                )
            }
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.bgLayer1, RoundedCornerShape(Radius.card))
                .border(Hairline, colors.borderL1, RoundedCornerShape(Radius.card))
                .clickable { onOpen() }
                .padding(horizontal = Sp.sp4, vertical = Sp.sp3),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = session.title.ifEmpty { session.sessionId },
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.labelPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (session.running) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .background(colors.brandTint, RoundedCornerShape(Radius.pill))
                            .padding(horizontal = Sp.sp2, vertical = 3.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .background(colors.brandFill, CircleShape),
                        )
                        Text(
                            text = "运行中",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.brandLabel,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                } else {
                    Text(
                        text = "空闲",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.labelSecondary,
                        modifier = Modifier
                            .background(colors.bgLayer2, RoundedCornerShape(Radius.pill))
                            .padding(horizontal = Sp.sp2, vertical = 3.dp),
                    )
                }
            }
            if (session.cwd.isNotEmpty()) {
                Text(
                    text = session.cwd,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.labelSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = Sp.sp1),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = relTime(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.labelTertiary,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = Icons.Default.ChevronRight,
                    contentDescription = null,
                    tint = colors.labelTertiary,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** 空态（在线 / 离线 / 归档视图三套文案）。 */
@Composable
private fun EmptyState(showArchived: Boolean, online: Boolean) {
    val colors = PocketTheme.colors
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxSize()
            .padding(Sp.sp6),
    ) {
        Text(
            text = if (showArchived) "暂无已归档会话" else if (online) "暂无会话" else "未连接，暂无会话数据",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.labelSecondary,
        )
        Text(
            text = if (showArchived) {
                "在会话列表左滑可归档会话"
            } else if (online) {
                "点下方「新建会话」开始遥控"
            } else {
                "在右上角「连接」里选好远程并连接"
            },
            style = MaterialTheme.typography.bodySmall,
            color = colors.labelTertiary,
            modifier = Modifier.padding(top = Sp.sp1),
        )
    }
}
