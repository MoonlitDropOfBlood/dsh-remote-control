/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 单 Activity + Compose NavHost。
 *
 * 路由表（与 HarmonyOS 版 model/routes.ets 一一对应）：
 *   sessions        首页 = 会话列表
 *   session/{id}    会话详情（根会话）
 *   subagent/{id}/{parent}/{mode}  子代理详情（one-shot 只读）
 *   new_session     新建会话
 *   approvals       审批 / 提问队列
 *   connections     连接管理（多远程 + 扫码配对）
 *   scanner         扫码配对（CameraX + ZXing）
 *   about           关于
 *
 * 沉浸式：enableEdgeToEdge + 各页自行按安全区内缩（对齐 HarmonyOS v1.2.1 口径）。
 */
package dsh.rc.pocket

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dsh.rc.pocket.ui.AboutScreen
import dsh.rc.pocket.ui.ApprovalsScreen
import dsh.rc.pocket.ui.ConnectionsScreen
import dsh.rc.pocket.ui.NewSessionScreen
import dsh.rc.pocket.ui.SessionDetailScreen
import dsh.rc.pocket.ui.SessionsScreen
import dsh.rc.pocket.ui.qr.PairUri
import dsh.rc.pocket.ui.qr.PairUriResult
import dsh.rc.pocket.ui.qr.QrScannerScreen
import dsh.rc.pocket.ui.theme.DshPocketTheme
import dsh.rc.pocket.vm.PocketViewModel

/** 路由表。 */
object Routes {
    const val SESSIONS = "sessions"
    const val SESSION = "session/{sessionId}"
    const val SUBAGENT = "subagent/{sessionId}/{parentId}/{mode}"
    const val NEW_SESSION = "new_session"
    const val APPROVALS = "approvals"
    const val CONNECTIONS = "connections"
    const val SCANNER = "scanner"
    const val ABOUT = "about"

    /** 会话详情路由（sessionId 需 URL 编码）。 */
    fun session(sessionId: String): String = "session/" + Uri.encode(sessionId)

    /** 子代理详情路由。 */
    fun subagent(sessionId: String, parentId: String, mode: String): String =
        "subagent/" + Uri.encode(sessionId) + "/" + Uri.encode(parentId) + "/" + Uri.encode(mode)
}

/**
 * 主 Activity（单 Activity 架构）。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 沉浸式：系统栏透明，页面背景铺满（状态栏 / 导航条区域透出同一背景）
        enableEdgeToEdge()
        setContent {
            DshPocketTheme {
                PocketNavHost()
            }
        }
    }
}

/**
 * 全局导航图。
 */
@Composable
fun PocketNavHost() {
    val vm: PocketViewModel = viewModel()
    val nav = rememberNavController()
    // v1.3.1：回前台做一次权威对账（后台丢 turn.end 时靠它收编尾部残留；
    // 对齐 HarmonyOS 版 EntryAbility.onForeground）。
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.onAppForeground()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // 扫码解析结果（只用于回填配对表单，不自动连接）
    var scannedPair by remember { mutableStateOf<PairUriResult?>(null) }

    NavHost(
        navController = nav,
        startDestination = Routes.SESSIONS,
    ) {
        composable(Routes.SESSIONS) {
            SessionsScreen(
                vm = vm,
                onOpenSession = { nav.navigate(Routes.session(it)) },
                onOpenConnections = { nav.navigate(Routes.CONNECTIONS) },
                onOpenApprovals = { nav.navigate(Routes.APPROVALS) },
                onCreateSession = { nav.navigate(Routes.NEW_SESSION) },
            )
        }
        composable(
            route = Routes.SESSION,
            arguments = listOf(navArgument("sessionId") { type = NavType.StringType }),
        ) { entry ->
            val sessionId = entry.arguments?.getString("sessionId").orEmpty()
            SessionDetailScreen(
                vm = vm,
                sessionId = sessionId,
                parentSessionId = "",
                subagentMode = "",
                onBack = { nav.popBackStack() },
                onOpenSubagent = { childId, parentId, mode ->
                    nav.navigate(Routes.subagent(childId, parentId, mode))
                },
            )
        }
        composable(
            route = Routes.SUBAGENT,
            arguments = listOf(
                navArgument("sessionId") { type = NavType.StringType },
                navArgument("parentId") { type = NavType.StringType },
                navArgument("mode") { type = NavType.StringType },
            ),
        ) { entry ->
            val sessionId = entry.arguments?.getString("sessionId").orEmpty()
            val parentId = entry.arguments?.getString("parentId").orEmpty()
            val mode = entry.arguments?.getString("mode").orEmpty()
            SessionDetailScreen(
                vm = vm,
                sessionId = sessionId,
                parentSessionId = parentId,
                subagentMode = mode,
                onBack = { nav.popBackStack() },
                onOpenSubagent = { childId, parentId, childMode ->
                    nav.navigate(Routes.subagent(childId, parentId, childMode))
                },
            )
        }
        composable(Routes.NEW_SESSION) {
            NewSessionScreen(
                vm = vm,
                onBack = { nav.popBackStack() },
                onCreated = { sessionId ->
                    nav.popBackStack()
                    nav.navigate(Routes.session(sessionId))
                },
            )
        }
        composable(Routes.APPROVALS) {
            ApprovalsScreen(vm = vm, onBack = { nav.popBackStack() })
        }
        composable(Routes.CONNECTIONS) {
            ConnectionsScreen(
                vm = vm,
                initialPair = scannedPair,
                onPairConsumed = { scannedPair = null },
                onScan = { nav.navigate(Routes.SCANNER) },
                onAbout = { nav.navigate(Routes.ABOUT) },
                onBack = { nav.popBackStack() },
            )
        }
        composable(Routes.SCANNER) {
            QrScannerScreen(
                onScanned = { text ->
                    // 只解析，不执行：结果回到连接页回填表单
                    scannedPair = PairUri.parse(text)
                    nav.popBackStack()
                },
                onCancel = { nav.popBackStack() },
            )
        }
        composable(Routes.ABOUT) {
            AboutScreen(vm = vm, onBack = { nav.popBackStack() })
        }
    }
}
