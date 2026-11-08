# app-android/core Kotlin API 契约（**两端共同遵守**）

> 本文是 `app-android/core` 模块对外 API 的**契约**。写 core 的人与写 UI 的人**都以此为准**，
> 不要各自另立名字。契约语义源自 `docs/PROTOCOL.md` v1.2.0（唯一事实源）与
> HarmonyOS 版 `app/entry/src/main/ets/model/*`（已验证实现）。

包名：`dsh.rc.core`；模块 `:core`（**纯 JVM，无 Android 依赖**）。

---

## 1. 已有（Lead 已写，勿改）

| 文件 | 内容 |
|---|---|
| `Protocol.kt` | 全部协议常量 + KAT 字面量（`object Protocol`） |
| `Crypto.kt` | `object Crypto`：`deriveKey` / `hmacSha256` / `hkdf` / `helloSig` / `helloSig2` / `aadOf` / `seal` / `open` / `assertKat` / base64url / hex |
| `Models.kt` | 业务数据类（`SessionSummary` / `ChatMessage` / `StepRecord` / `HistoryPage` / `Capabilities` / `ModelSelection` / `ModelOption` / `ImageRef` / `FileRef` / `QueueItem` / `SubagentInfo` / `Question` / `ApprovalRequest` / `QuestionRequest` / `PromptResult` / `CreateResult` / `UploadBegin` / `UploadedAttachment` / `FetchedImage` / `AttachmentCaps` / `DshrcMsg`） |
| `Json.kt` | `DshrcJson`（kotlinx Json）+ `JsonObject` 读取助手（`str` / `bool` / `long` / `int` / `obj` / `arr` / `strList` / `jsonOf` / `mapToJson`） |
| `Link.kt` | `class DshrcLink(scope, httpClient, listener)`：链路 + 握手 + 纪元 + 收发 |

`DshrcLink` 对外 API：

```kotlin
enum class LinkState { IDLE, DERIVING, CONNECTING, HANDSHAKING, ONLINE, RECONNECTING, STOPPED, ERROR }
data class EpochState(val self: Long, val peer: Long, val peerSid: String)
data class LinkConfig(
    val relayUrl: String, val channel: String, val secret: String,
    val relayToken: String = "", val clientName: String, val appVersion: String,
    val epoch: EpochState = EpochState(0, -1, ""),
    val onEpoch: ((EpochState) -> Unit)? = null
)
data class HostInfo(val hostName: String, val dshVersion: String, val pluginVersion: String)
interface LinkListener {
    fun onState(state: LinkState) {}
    fun onEvent(msg: DshrcMsg) {}
    fun onPeers(hostOnline: Boolean, clientOnline: Boolean) {}
    fun onHello(info: HostInfo) {}
    fun onLog(line: String) {}
}
class DshrcLink(scope: CoroutineScope, httpClient: OkHttpClient = defaultHttpClient(), listener: LinkListener = ...) {
    fun getState(): LinkState
    fun isHostOnline(): Boolean
    fun start(cfg: LinkConfig)
    fun stop()
    fun kickReconnect()
    suspend fun request(type: String, payload: JsonObject, timeoutMs: Long = 15_000): JsonObject
}
```

---

## 2. 待实现：会话仓（`SessionStore`）

文件：`core/src/main/kotlin/dsh/rc/core/Store.kt`。
**移植来源**：`app/entry/src/main/ets/model/sessionstore.ets`（2252 行）+ `attachment-plan.ts` +
`process-activity.ts` + `timeline-reconcile.ts`。

### 2.1 时间线条目（sealed）

```kotlin
sealed interface TimelineItem { val key: String }

data class TimelineMessage(
    override val key: String,          // 稳定键：历史消息用 id；直播消息用 "live-<turn>-<role>"
    val id: String,
    val role: String,                  // "user" | "assistant" | "reasoning"
    val text: String,
    val ts: Long,
    val seq: Long,                     // 持久序号；直播项 = -1
    val images: List<ImageRef> = emptyList(),
    val files: List<FileRef> = emptyList(),
    val streaming: Boolean = false,    // 是否仍在流式
    val local: Boolean = false         // 乐观上屏（本机发出、宿主还没回执）
) : TimelineItem

data class TimelineStep(
    override val key: String,          // "s<callId>"
    val callId: String,
    val name: String,
    val arguments: String,
    val status: String,                // "running" | "ok" | "error"
    val resultText: String,
    val errorText: String,
    val ts: Long,
    val seq: Long = -1,
    val expanded: Boolean = false
) : TimelineItem

data class TimelineReasoning(
    override val key: String,
    val id: String,
    val text: String,
    val ts: Long,
    val seq: Long = -1,
    val expanded: Boolean = false
) : TimelineItem
```

### 2.2 过程分组（对齐桌面端 DSH）

```kotlin
/** 时间线分组条目：过程分组 = 连续 reasoning/step；消息打断分组。 */
class TimelineEntry(
    val key: String,
    val isProcess: Boolean,
    val head: TimelineItem,
    val members: List<TimelineItem>,
    val groupExpanded: Boolean
)
```

分组规则（HarmonyOS `groupTimeline()`，**必须一致**）：
- 连续 `reasoning` / `step` 归一组，遇到 message 断开；
- key 不含成员数（新增成员不换 key）；默认折叠。

### 2.3 会话仓

```kotlin
class SessionStore(
    private val link: DshrcLink,
    private val scope: CoroutineScope
) {
    // ---- 会话列表 ----
    val sessions: StateFlow<List<SessionSummary>>          // 只含根会话且非 blank（按 updatedAt 降序）
    val archivedSessionIds: StateFlow<Set<String>>
    val linkState: StateFlow<LinkState>
    val hostInfo: StateFlow<HostInfo?>
    val busyEnter: StateFlow<String>                       // "queue" | "steer"（只读）

    // ---- 当前会话 ----
    val activeSessionId: StateFlow<String?>
    val lastPromptMode: StateFlow<String>                     // 最近一次 prompt 的**实际**投递模式（queue/steer，空 = 未发过）
    val timeline: StateFlow<List<TimelineItem>>             // 详情页唯一数据源
    val entries: StateFlow<List<TimelineEntry>>             // 分组后的时间线
    val queueItems: StateFlow<List<QueueItem>>              // 只显示 target=="next-turn"
    val subagents: StateFlow<List<SubagentInfo>>
    val sessionModel: StateFlow<ModelSelection?>            // null = 插件无记录 → 回退目录默认
    val sessionPermission: StateFlow<String?>               // "custom" 仅展示
    val capabilities: StateFlow<Capabilities?>
    val attachmentCaps: StateFlow<AttachmentCaps?>          // null = 宿主不支持 → 隐藏附件入口

    // ---- 审批 / 提问 ----
    val approvals: StateFlow<List<ApprovalRequest>>
    val questions: StateFlow<List<QuestionRequest>>

    // ---- 历史错误（归属具体会话，不写全局 lastError） ----
    val historyError: StateFlow<SessionHistoryError?>      // sessionId + 文案；null = 无
    fun historyErrorFor(sessionId: String): String          // 非本会话的错误返回 ""
    fun retryHistory(sessionId: String)                    // 重新拉该会话最新一页历史

    // ---- 操作 ----
    suspend fun loadSessions()
    suspend fun openSession(sessionId: String)              // 拉 history + queue + subagents + model + permission
    suspend fun closeSession()
    /**
     * 发送提示词。
     * 上屏口径：空闲 → 乐观气泡**在发请求之前**落位；繁忙 → 不插主时间线；
     * 宿主拒收 / 请求失败 → 回滚气泡（口径 #6、#11）。
     */
    suspend fun sendPrompt(sessionId: String, text: String, uploads: List<String> = emptyList()): Boolean
    suspend fun cancelTurn(sessionId: String): Boolean
    suspend fun createSession(title: String, agentPreset: String?, permission: String?, cwd: String?, model: ModelSelection?): CreateResult
    suspend fun setArchived(sessionId: String, archived: Boolean): Boolean
    suspend fun selectModel(sessionId: String, model: ModelSelection): ModelSelection
    suspend fun selectPermission(sessionId: String, permission: String): String
    suspend fun answerApproval(askId: String, decision: String, note: String = ""): Boolean
    suspend fun answerQuestion(askId: String, answers: Map<String, String>, freeText: String = ""): Boolean
    suspend fun fetchImage(imageId: String, maxEdge: Int = 1600): FetchedImage
    suspend fun loadQueue(sessionId: String)
    suspend fun subagentPrompt(parentSessionId: String, childSessionId: String, text: String): Boolean
    suspend fun subagentCancel(parentSessionId: String, childSessionId: String): Boolean

    /** 断线恢复（契约 §5：宿主会话日志是唯一事实源）。 */
    suspend fun onLinkOnline()
}
```

**必须遵守的行为口径**（来自 HarmonyOS 版实测结论，逐条照搬）：

1. 列表只显示**根会话**（无 parentSessionId 且 origin != "subagent"）且非 blank，updatedAt 降序。
2. `session.archives` 事件是**归档全集快照**，据此覆盖各行 `archived`，不做增量猜测。
3. 时间线 **durable 在前（seq 升序）、直播项（seq = -1）在后（到达顺序）**；
   历史 `steps` 与直播 `tool.call`/`tool.result` 按 `callId` 配对去重。
4. `mergeHistory` **绝不能给同 key 换新实例**（旧实例复用 + 原地搬字段）——
   否则列表刷新后卡片绑旧实例、再也不更新。
5. 交付物图片（`ImageRef.source == "deliverable"`）**独立成条**，不挂到正在流式的 assistant 消息；
   历史去重用 `imagesCoveredByPage()`（只对「正文为空」的图片消息生效）。
6. 附件-only（正文空）消息合法，不画空气泡；**乐观气泡在发请求之前落位**（顺序铁律，见 #11），
   宿主拒收 / 请求失败 → **回滚**该气泡（宿主不收就不留重复气泡）。
7. 断线恢复 = 权威拉取：`onLinkOnline()` 对活动会话重拉 history + queue + subagents + model + permission。
8. 排队列表**只显示 `target == "next-turn"`**（`next-step` 已被当前 turn 持有）。
9. 发送模式由宿主决定：手机端**不发** `mode`；`session.capabilities.busyEnter` 只读展示。
10. `session.create` 返回 `modelError` 时**不得重复创建**（sessionId 照常使用）。
11. **发送顺序铁律**：宿主回 `accepted` 之前可能已经把本轮的 `assistant.delta` 推到手机
    （插件端 `#rSessionPrompt` 先 await 宿主 prompt、**之后**才回包）→ 客户端**必须**在发请求
    **之前**把乐观气泡落位。否则气泡会落在流式回复**中间**，把一条回复切成两个气泡。
    ArkTS 的 `Promise.then` 是**微任务**（必早于下一帧）所以不犯；Kotlin 的 `await` 恢复是
    **派发**的 → 会犯（Android 2026-11-08 P0；回归用例 `TimelineOrderTest`，用 mock host 的
    `MOCK_PROMPT_RESULT_LAST=1` 复现插件端真实顺序）。
    繁忙时（发请求**之前**快照 `running=true`）**不插**主时间线——宿主可能正在输出当前 turn，
    插进去会切开当前回复；排队消息由宿主 `session.queue` 展示，被消费后由权威历史展示。
12. **幽灵 process group 的根因在「对账」，不在「分组」**：分组只是把真实残留的 reasoning/step 归组，
    不是凭空多画节点。最终助手消息之后偶尔多出一个分组、重启 App 才消失 → 是历史/直播竞态把
    `seq=-1` 的迟到 reasoning 或 orphan step 留在尾部。修法（对齐 ArkTS 2026-11-08）：
    - `mergeHistory` 在「**非 prepend 的最新页 + 宿主已空闲**」时，这页已是最终权威投影 →
      **所有 `seq<0` 的直播步骤都必须退出**（含没进本页的 orphan step）；
      宿主还忙时只按 `callId` 去重，运行中的直播步骤不消失。
    - `turn.end` 把会话置空闲后**立刻**用最新权威页对账一次；
      `session.status` 的 `running:true→false` 是 `turn.end` 丢失时的兜底，同样补一次对账。
13. **历史错误归属会话**：`session.history` 失败**不得**写全局 `lastError`（首页会抢走、
    还会串到别的会话）。错误记在会话自己身上（`historyError`），只在它的详情页展示并给「重新加载」。
    离线时也要给出「加载历史失败：未连接主机」，不要静默。
14. **新建会话首发**：线协议顺序是 **create → 串行上传附件 → 带 `uploads` 发 prompt**（契约 §5.11）。
    create 成功即**不得重复 create**（模型设置失败只提示「已用默认模型」并继续）；
    上传/prompt 失败时把正文 + 附件（含已 commit 的 `uploadId`）**移交详情页**重试，
    表单不留在原地诱导重复创建。

### 2.4 附件分块（`AttachmentPlan.kt`）

移植 `app/entry/src/main/ets/model/attachment-plan.ts`（纯 TS，node 回归共用）：

```kotlin
object AttachmentPlan {
    const val DEFAULT_CHUNK_BYTES = 256 * 1024
    fun clampChunkBytes(hostChunkBytes: Int): Int          // ≤256KiB，且 ≥1
    fun planChunks(totalBytes: Long, chunkBytes: Int): List<IntRange>  // 每块的字节偏移区间
    fun attachmentFileName(name: String?): String
    fun formatAttachmentSize(bytes: Long): String
    fun normalizeAttachmentCaps(caps: AttachmentCaps?): AttachmentCaps?
    fun checkAttachmentDraft(items: List<DraftAttachment>, caps: AttachmentCaps?): String?  // 返回错误文案，null = 通过
}
```

上传流程（`begin → chunk* → commit`，串行）：
- `attachment.upload.begin` → `{uploadId, chunkBytes}`
- 每个分块 **标准 base64（canonical，有填充）**，index 从 0 连续递增
- `attachment.upload.commit` → 附件元数据；commit 成功即写回 `uploadId`（prompt 失败重试**复用**，不重复上传）
- `attachment.upload.abort` → 放弃（幂等）

---

## 3. UI 模块（`:app`）依赖的 core 公共面

- `DshrcLink` / `LinkState` / `LinkConfig` / `EpochState` / `HostInfo` / `LinkListener`
- `SessionStore`（上面 2.3 的全部成员）
- `Models.kt` 的全部数据类
- `Crypto.assertKat()`（About 页展示自检结果）
- `Protocol.CONTRACT_VERSION` / `Protocol.PROTO_VERSION`
