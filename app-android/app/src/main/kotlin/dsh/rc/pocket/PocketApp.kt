/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— Application：进程内单例（链路 / 会话仓 / 多远程仓）。
 *
 * 生命周期与职责（对齐 HarmonyOS 版 model/{link,connections,sessionstore}.ets 的全局单例）：
 *  - appScope   : 进程级协程作用域（链路与仓库的后台任务都挂这里）
 *  - link       : DshrcLink（契约 §4 传输层）—— **唯一**的链路实现入口
 *  - store      : SessionStore（契约 §5 业务层）—— 会话 / 时间线 / 审批的唯一事实源
 *  - remoteRepo : RemoteRepo（DataStore 多远程档案，含旧单条配对键迁移）
 *
 * 关于「事件接线」：SessionStore 与链路的绑定由 core 内部完成（core 是链路的唯一持有者）；
 * 本文件**不重复分发**业务事件，也不自己拉历史——断线恢复由 SessionStore.onLinkOnline()
 * 负责（契约 §5，宿主会话日志是唯一事实源）。
 */
package dsh.rc.pocket

import android.app.Application
import android.content.Context
import dsh.rc.core.DshrcLink
import dsh.rc.core.LinkListener
import dsh.rc.core.SessionStore
import dsh.rc.pocket.data.RemoteRepo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * DSH Pocket 应用（进程单例）。
 */
class PocketApp : Application() {

    /** 进程级协程作用域。 */
    lateinit var appScope: CoroutineScope
        private set

    /** 中继链路（契约 §4）。 */
    lateinit var link: DshrcLink
        private set

    /** 会话仓（契约 §5）。 */
    lateinit var store: SessionStore
        private set

    /** 多远程档案仓（DataStore）。 */
    lateinit var remoteRepo: RemoteRepo
        private set

    /** 本地日志环形缓冲（关于页展示；不含 secret / 配对 URI）。 */
    private val _logs = MutableStateFlow<List<String>>(emptyList())

    /** 本地日志（最近的若干条，最新在前）。 */
    val logs: StateFlow<List<String>> = _logs.asStateFlow()

    override fun onCreate() {
        super.onCreate()
        appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        remoteRepo = RemoteRepo(this)
        // core 的接线工厂：创建链路 + 会话仓（仓库自注册为链路监听者）
        store = SessionStore.create(appScope)
        link = store.linkRef
        // 链路是**多监听者**模型（core Link.kt）：SessionStore 自己注册业务监听者，
        // app 侧只额外挂一个「日志桥」，两者互不顶掉。
        link.addListener(LogBridge())
        appendLog("app started")
    }

    /** 追加一条日志（**禁止**写入 secret / 配对 URI）。 */
    fun appendLog(line: String) {
        val stamped = "${System.currentTimeMillis()} $line"
        _logs.value = (listOf(stamped) + _logs.value).take(MAX_LOG_LINES)
        // 同时写 Logcat：便于 `adb logcat -s DSHPocket` 观察完整链路（含 App 侧事件）
        android.util.Log.i(LOG_TAG, line)
    }

    /**
     * 链路日志桥：**只收日志**，不做业务分发（业务事件由 core 的 SessionStore 消费）。
     *
     * core 的 DshrcLink 是**多监听者**模型（`addListener` / `removeListener`），
     * 这里挂的是**额外**的一个监听者，不会顶掉 SessionStore 自己的监听。
     */
    private inner class LogBridge : LinkListener {
        override fun onLog(line: String) {
            appendLog(line)
        }

        override fun onState(state: dsh.rc.core.LinkState) {
            appendLog("link state = ${state.name}")
        }
    }

    companion object {
        /** 应用名（hello.clientName 与关于页展示）。 */
        const val APP_NAME: String = "DSH Pocket"

        /** 客户端标识（协议 hello 的 clientName）。 */
        const val CLIENT_NAME: String = "DSH Pocket for Android"

        /** 日志缓冲上限。 */
        private const val MAX_LOG_LINES = 300

        /** Logcat tag（`adb logcat -s DSHPocket`）。 */
        const val LOG_TAG: String = "DSHPocket"

        /** 取进程单例。 */
        fun from(context: Context): PocketApp = context.applicationContext as PocketApp
    }
}
