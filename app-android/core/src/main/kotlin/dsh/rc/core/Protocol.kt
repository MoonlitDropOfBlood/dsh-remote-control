/*
 * Copyright (c) 2026 dukedsh.
 * DSH Pocket for Android —— 协议常量层（契约 v1.3.0）。
 *
 * 契约来源（只读）：仓库根 docs/PROTOCOL.md（dsh-remote-control，v1.3.0）——**唯一事实源**。
 * 本文件只描述「协议长什么样」，不做任何 IO 与加密运算。
 *
 * 与 HarmonyOS 版 app/entry/src/main/ets/model/protocol.ets **逐字对应**：
 * 常量名、KAT 字面量、字段语义都不得擅自改动。
 */
package dsh.rc.core

/** 协议常量（契约 §3 / §4 / §5 / §7）。 */
object Protocol {

    /** 协议版本（契约 §5.1 hello.proto）。 */
    const val PROTO_VERSION: Int = 1

    /** 协议契约文档版本（关于页展示用）。 */
    const val CONTRACT_VERSION: String = "v1.3.1"

    /** 角色：host = PC 端 DSH 插件；client = 本 App。 */
    const val ROLE_HOST: String = "host"
    const val ROLE_CLIENT: String = "client"

    // ---- §5.1 hello.features（v1.3.0） ----

    /**
     * 会话状态特性标记（契约 §5.1 v1.3.0 `hello.features`）。
     *
     * 声明它 = 本客户端支持 `pending.interactions` 快照、Todo / Goal、
     * 以及 `question.request{state:"continued"}` 的**状态更新**语义；
     * 未声明的旧客户端，插件仍按旧语义处理（不会重发 continued 状态）。
     */
    const val FEATURE_SESSION_STATE_V1: String = "session-state-v1"

    /** 本客户端声明的能力特性（业务 hello 带上）。 */
    val CLIENT_FEATURES: List<String> = listOf(FEATURE_SESSION_STATE_V1)

    // ---- §3 配对与密钥 ----

    /** HKDF 参数（契约 §3.3）。 */
    const val HKDF_SALT: String = "dsh-remote-control/v1"
    const val HKDF_INFO_PREFIX: String = "e2e|" // info = UTF8("e2e|" + channel)
    const val HKDF_KEY_LEN: Int = 32

    /** hello 签名原文前缀（契约 §3.4）：UTF8("hello|" + role + "|" + channel)。 */
    const val HELLO_SIG_PREFIX: String = "hello|"

    /**
     * v2 握手证明原文前缀（契约 §3.4.1）：
     * UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)。
     */
    const val HELLO_SIG2_PREFIX: String = "hello2|"

    /**
     * 传输层握手证明版本 pv（契约 §3.4.1）：v1.1.3 = 2；
     * v1.1.2 及以前不带该字段（视为 1）。本端恒为 2。
     */
    const val PROTO_HELLO_V2: Int = 2

    /** AAD 原文（契约 §7）：UTF8("dshrc|" + 发送方 role + "|" + seq)。 */
    const val AAD_PREFIX: String = "dshrc|"

    /** channel 格式（契约 §4）：RFC 4648 base32 字母表。 */
    val CHANNEL_REGEX: Regex = Regex("^[A-Z2-7]{16,64}$")

    // ---- §4 传输层 ----

    const val FRAME_HELLO: String = "hello"
    const val FRAME_WELCOME: String = "welcome"
    const val FRAME_PEER_JOINED: String = "peer-joined"
    const val FRAME_PEER_LEFT: String = "peer-left"
    const val FRAME_FRAME: String = "frame"
    const val FRAME_PING: String = "ping"
    const val FRAME_PONG: String = "pong"
    const val FRAME_ERROR: String = "error"

    /** 链路参数（契约 §4）。 */
    const val HELLO_TIMEOUT_MS: Long = 10_000L // 连接后 10s 内必须发 hello
    const val HEARTBEAT_INTERVAL_MS: Long = 30_000L // 30s 无帧即发 ping
    const val DEAD_TIMEOUT_MS: Long = 90_000L // 90s 无任何消息判死
    const val BACKOFF_BASE_MS: Long = 1_000L // 重连退避 1s 起
    const val BACKOFF_MAX_MS: Long = 60_000L // 上限 60s，带抖动

    /** 发送端实例 id（契约 §4 v1.0.2）：每条 WS 连接生成一次，8 位十六进制随机。 */
    const val SID_LEN: Int = 8
    val SID_REGEX: Regex = Regex("^[0-9a-f]{8}$", RegexOption.IGNORE_CASE)

    /** 去重键兜底桶：缺 sid 的帧按 "legacy":seq 处理（契约 §4 v1.0.2）。 */
    const val SID_LEGACY: String = "legacy"

    /** seen 分桶裁剪（契约 §4 v1.0.2）。 */
    const val SEEN_BUCKET_MAX: Int = 4096
    const val SEEN_MAX_SIDS: Int = 64

    /** 加密布局（契约 §7 v1.0.1）：base64url( iv(12) || ciphertext || tag(16) )。 */
    const val IV_LEN: Int = 12
    const val TAG_LEN: Int = 16

    // ---- §5.1 client → host 请求 ----

    const val MSG_HELLO: String = "hello"
    const val MSG_SESSION_LIST: String = "session.list"
    const val MSG_SESSION_HISTORY: String = "session.history"
    const val MSG_SESSION_SUBAGENTS: String = "session.subagents"
    const val MSG_SESSION_SUBAGENT_PROMPT: String = "session.subagentPrompt"
    const val MSG_SESSION_SUBAGENT_CANCEL: String = "session.subagentCancel"
    const val MSG_SESSION_CREATE: String = "session.create"
    const val MSG_SESSION_CAPABILITIES: String = "session.capabilities"
    const val MSG_SESSION_ARCHIVE: String = "session.archive"
    const val MSG_SESSION_UNARCHIVE: String = "session.unarchive"
    const val MSG_SESSION_SELECT_MODEL: String = "session.selectModel"
    const val MSG_SESSION_MODEL: String = "session.model"
    const val MSG_SESSION_SELECT_PERMISSION: String = "session.selectPermission"
    const val MSG_SESSION_PERMISSION: String = "session.permission"
    const val MSG_IMAGE_FETCH: String = "image.fetch"
    const val MSG_SESSION_QUEUE: String = "session.queue"
    const val MSG_UPLOAD_BEGIN: String = "attachment.upload.begin"
    const val MSG_UPLOAD_CHUNK: String = "attachment.upload.chunk"
    const val MSG_UPLOAD_COMMIT: String = "attachment.upload.commit"
    const val MSG_UPLOAD_ABORT: String = "attachment.upload.abort"
    const val MSG_SESSION_PROMPT: String = "session.prompt"
    const val MSG_SESSION_CANCEL: String = "session.cancel"
    const val MSG_SESSION_RENAME: String = "session.rename"

    /**
     * 待答交互快照（契约 §5.1 v1.3.0 / §5.12）：**只读恢复通道**，绝不阻塞瀑布。
     * 读取失败必须回空数组（fail-open）。
     */
    const val MSG_PENDING_INTERACTIONS: String = "pending.interactions"

    /** Todo 清单快照（契约 §5.1 v1.3.0 / §5.13）：手机**只读**。 */
    const val MSG_SESSION_TODOS: String = "session.todos"

    /** Goal 目标快照（契约 §5.1 v1.3.0 / §5.14）。 */
    const val MSG_SESSION_GOAL: String = "session.goal"

    /** Goal 人类操作（契约 §5.1 v1.3.0 / §5.14）：create/edit/pause/resume/complete/clear。 */
    const val MSG_SESSION_GOAL_ACTION: String = "session.goalAction"

    const val MSG_APPROVAL_ANSWER: String = "approval.answer"
    const val MSG_QUESTION_ANSWER: String = "question.answer"
    const val MSG_PUSH_REGISTER: String = "push.register"
    const val MSG_PING: String = "ping"

    // ---- §5 host → client ----

    const val MSG_RESULT: String = "result"
    const val MSG_EVENT: String = "event"

    // ---- §5.2 事件 topic ----

    const val TOPIC_SESSION_ADDED: String = "session.added"
    const val TOPIC_SESSION_REMOVED: String = "session.removed"
    const val TOPIC_SESSION_STATUS: String = "session.status"
    const val TOPIC_SESSION_ACTIVITY: String = "session.activity"
    const val TOPIC_SESSION_ARCHIVES: String = "session.archives"
    const val TOPIC_SESSION_QUEUE: String = "session.queue"
    const val TOPIC_SESSION_MODEL_CHANGED: String = "session.modelChanged"
    const val TOPIC_SESSION_PERMISSION_CHANGED: String = "session.permissionChanged"

    /** Todo 清单变化（契约 §5.2 v1.3.0 / §5.13）：**整表覆盖**，客户端不自行合并。 */
    const val TOPIC_SESSION_TODOS_CHANGED: String = "session.todosChanged"

    /** Goal 变化（契约 §5.2 v1.3.0 / §5.14）：clear 时 goal 为 null。 */
    const val TOPIC_SESSION_GOAL_CHANGED: String = "session.goalChanged"

    /** Goal 续跑激活态变化（契约 §5.2 v1.3.0）：进程内状态，无当前目标时不发。 */
    const val TOPIC_SESSION_GOAL_ACTIVATION_CHANGED: String = "session.goalActivationChanged"
    const val TOPIC_ASSISTANT_DELTA: String = "assistant.delta"
    const val TOPIC_ASSISTANT_REASONING_DELTA: String = "assistant.reasoningDelta"
    const val TOPIC_ASSISTANT_IMAGE: String = "assistant.image"
    const val TOPIC_TOOL_CALL: String = "tool.call"
    const val TOPIC_TOOL_RESULT: String = "tool.result"
    const val TOPIC_TURN_END: String = "turn.end"
    const val TOPIC_APPROVAL_REQUEST: String = "approval.request"
    const val TOPIC_APPROVAL_RESOLVED: String = "approval.resolved"
    const val TOPIC_QUESTION_REQUEST: String = "question.request"
    const val TOPIC_QUESTION_RESOLVED: String = "question.resolved"
    const val TOPIC_PUSH_STATE: String = "push.state"
    const val TOPIC_ERROR: String = "error"

    /** 投递行为（契约 §5.1 v1.1.2）：queue = 排队；steer = 插话。 */
    const val MODE_QUEUE: String = "queue"
    const val MODE_STEER: String = "steer"

    // ---- §5.12 待答交互（v1.3.0） ----

    /** 待答状态：open = 手机独占窗口内；continued = 窗口已结束但**仍可补答**。 */
    const val PENDING_STATE_OPEN: String = "open"
    const val PENDING_STATE_CONTINUED: String = "continued"

    /** 待答来源：plugin = 插件瀑布持有的待答项；host = 宿主 userQuestions 投影。 */
    const val PENDING_SOURCE_PLUGIN: String = "plugin"
    const val PENDING_SOURCE_HOST: String = "host"

    // ---- §5.13 Todo（v1.3.0） ----

    /** Todo 三态（契约 §5.13）。 */
    const val TODO_STATUS_PENDING: String = "pending"
    const val TODO_STATUS_IN_PROGRESS: String = "in_progress"
    const val TODO_STATUS_COMPLETED: String = "completed"

    // ---- §5.14 Goal（v1.3.0） ----

    /** Goal 阶段（契约 §5.14）。 */
    const val GOAL_PHASE_ACTIVE: String = "active"
    const val GOAL_PHASE_PAUSED: String = "paused"
    const val GOAL_PHASE_BLOCKED: String = "blocked"
    const val GOAL_PHASE_COMPLETE: String = "complete"

    /** Goal 续跑激活态（进程内状态，不持久；契约 §5.14）。 */
    const val GOAL_ACTIVATION_ARMED: String = "armed"
    const val GOAL_ACTIVATION_DISARMED: String = "disarmed"

    /**
     * Goal 人类操作（契约 §5.14）。
     *
     * 手机**只允许**这六个；`block` 属于模型 / 策略，手机不得触发。
     */
    const val GOAL_ACTION_CREATE: String = "create"
    const val GOAL_ACTION_EDIT: String = "edit"
    const val GOAL_ACTION_PAUSE: String = "pause"
    const val GOAL_ACTION_RESUME: String = "resume"
    const val GOAL_ACTION_COMPLETE: String = "complete"
    const val GOAL_ACTION_CLEAR: String = "clear"

    /** Goal 版本过期（Host CAS 失败；契约 §5.14）：客户端必须重拉 session.goal 后重试。 */
    const val ERR_GOAL_STALE_REVISION: String = "GOAL_STALE_REVISION"

    /** 校验 channel 格式（契约 §4）。KAT 字面量不参与运行时校验。 */
    fun isValidChannel(ch: String): Boolean = CHANNEL_REGEX.matches(ch)

    // ---- §7 KAT（已知答案测试）字面量 —— **逐字照抄契约，勿改动** ----

    const val KAT_SECRET: String = "dsh-remote-demo-secret-0123456789"
    const val KAT_CHANNEL: String = "ABCDEFGH23456789"
    const val KAT_KEY_HEX: String =
        "6a76161fb789e8a48e1004cdcba483c2908bf4123180dae162dfb7e61e342a1d"
    const val KAT_IV_HEX: String = "000102030405060708090a0b"
    const val KAT_PT: String = "{\"id\":\"r1\",\"type\":\"ping\",\"ts\":1700000000000,\"payload\":{}}"
    const val KAT_CT_HEX: String =
        "72b6fd46c5981533620ae9edc88cf0d607c89b5ad3da2d5ddd0548d6aef0c53e" +
            "4b242be9c97ead9930a1374918a2f46dc861811055c1cbe1a3"
    const val KAT_TAG_HEX: String = "292260ad46868699ac0bda00a1336cb4"

    /** HMAC-SHA256 自测向量（key = KAT key，data = UTF8("dshrc-hmac-kat")）。 */
    const val KAT_HMAC_DATA: String = "dshrc-hmac-kat"
    const val KAT_HMAC_HEX: String =
        "4cdd85bbaf49ae76476d430f34ba6096e04432a98c9c31b5838e16224b8db9ad"
}
