# AGENTS.md — app-android/（Android 手机 App，DSH Pocket for Android）

HarmonyOS 版的 **Android 对等实现**（Kotlin + Jetpack Compose）。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)（**唯一事实源**，v1.2.0）；
全局约定见 [../AGENTS.md](../AGENTS.md)；core 的 Kotlin API 契约见 [CORE_API.md](CORE_API.md)。

HarmonyOS 版是 `app/`（ArkTS/ArkUI）；**两端实现同一份契约**，不是其中一端的副本。
改任何 wire 行为 → 先改 `docs/PROTOCOL.md`，再同步 plugin / relay / app / app-android / e2e。

## 结构

```
core/                    纯 JVM（**无 Android 依赖**）——协议 / 加密 / 链路 / 会话仓
  Protocol.kt            协议常量 + KAT 字面量（§3/§4/§5/§7）
  Crypto.kt              HKDF-SHA256 + AES-256-GCM + HMAC-SHA256 + assertKat()
  Models.kt              业务数据类（§5.3/§5.4/§5.8/§5.10/§5.11）
  Json.kt                kotlinx JsonElement 助手（安全缺省）
  Link.kt                WebSocket 链路：hello v2 纪元证明 / 钉扎 sid / 收发保序 / 去重 / 重连
  Store.kt               会话仓：会话列表 / 统一时间线 / 队列 / 审批提问 / 子代理
  AttachmentPlan.kt      附件分块规划（纯函数）
  ProcessActivity.kt     工具分类 + 过程标题合成（对齐桌面端 DSH）
app/                     Android application（Compose UI）
  ui/                    会话列表（首页）/ 会话详情 / 新建会话 / 审批队列 / 连接管理 / 关于
  ui/qr/                 CameraX + ZXing 扫码配对（只解析，不执行）
  ui/attach/             SAF 选图片/文件 → 附件上传
  data/                  多远程档案（DataStore Preferences）
  vm/                    ViewModel（持有 link + store，暴露 StateFlow）
```

## 构建与验收（三件套）

```bash
# ① core 单测（**不需要设备/模拟器**）：KAT + AAD 绑定 + 纪元 + 分块 + 端到端联调
cd app-android && ./gradlew :core:test
# ② 整包构建
cd app-android && ./gradlew :app:assembleDebug
# ③ 安装到设备
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> `:core:test` 里的 `LinkIntegrationTest` 会**拉起仓库自带的 Node 实现**
> （`relay/server.js` + `e2e/mock-host.mjs`）做跨实现互通验证——
> 被测的是「Kotlin ↔ 既有 JS」，不是自证自洽。需 `node`（≥20）在 PATH 上。

## 工具链（本机实测路径）

- **JDK**：用 Android Studio 自带的 JBR（带 javac）：
  `D:\Application\JetBrains\Toolbox\Android Studio 2\jbr`（JDK 21）
  → `export JAVA_HOME="D:/Application/JetBrains/Toolbox/Android Studio 2/jbr"`
- **Android SDK**：`C:\Users\wwhby\AppData\Local\Android\Sdk`（platforms 27–36、build-tools 36.0.0）
  → `export ANDROID_HOME="C:/Users/wwhby/AppData/Local/Android/Sdk"`
- **Gradle**：走仓库自带 wrapper（`gradle/wrapper/gradle-wrapper.properties` → gradle-8.13-bin.zip）。
  ⚠️ **官方源在国内很慢**（实测 < 100KB/s），用腾讯云镜像手动塞进 wrapper 缓存：
  ```bash
  curl -L -o gradle-8.13-bin.zip https://mirrors.cloud.tencent.com/gradle/gradle-8.13-bin.zip
  # 放到 ~/.gradle/wrapper/dists/gradle-8.13-bin/<md5-base36>/ 下（目录名 = URL 的 MD5 的 36 进制）
  ```

## 硬性约定

- **KAT 是开机自检**：`Crypto.assertKat()` 在建链前执行，失败**不建链**；
  `Protocol.KAT_*` 字面量与契约 §7 逐字一致，**绝不许改**。
- **协议与加密只写一份**：core 里的 `Protocol` / `Crypto` / `Link` 是唯一实现，
  UI 层不得自己拼 JSON、不得自己算 HMAC/AAD。
- **纯 core**：`:core` 不得 import 任何 `android.*`（否则失去「无设备跑单测」的能力）。
- 状态用 `StateFlow`；UI 用 `collectAsState`（Compose）。
- 注释用中文并标注契约条款；每个文件头写 `Copyright (c) 2026 dukedsh.`。

## 与 HarmonyOS 版的差异（有意为之）

| 项 | HarmonyOS（app/） | Android（app-android/） | 原因 |
|---|---|---|---|
| 加密 API | `@kit.CryptoArchitectureKit` | JCA（HKDF/AES-GCM/HMAC 手写 HKDF） | core 要纯 JVM 可测 |
| 网络 | `@kit.NetworkKit` `net.WebSocket` | OkHttp WebSocket | 同上 |
| 推送 | 华为 Push Kit（§6） | **不做**（本期） | 插件侧 `push.register` 的 platform 是 `harmonyos`；Android 端需 FCM + 插件改造，另议 |
| 事件总线 | `eventpost` + `hrouter` | kotlinx Flow + Navigation Compose | Compose 惯用法 |
| 日志 | `@duke/logan-ext` 双写 | Logcat（后续可接同族库） | 依赖 Android 侧 SDK |

**发送保序 / 接收保序**（契约 §4 v1.1.7）在 Kotlin 侧的实现方式与 ArkTS 不同但**语义等价**：
JCA 加密是同步的 → 发送侧用 `sendLock` 临界区完成「seq 分配 → 加密 → ws.send」；
接收侧在 OkHttp 单读线程上同步解密+分发 → 天然按 WS 到达顺序。

## 常见坑

- **Kotlin 块注释可嵌套**（与 Java 不同！）——注释正文里写 `image/*` 或 `SP_*/FS_*`
  会**再开一层 / 提前闭合**外层注释 → 报 `Unclosed comment` 或把注释后的代码当源码解析。
  本仓已因此踩坑 **3 次**（core/AttachmentPlan.kt、app/ui/theme/Theme.kt、app/vm/PocketViewModel.kt）。
  提交前跑一次扫描：
  ```bash
  python tools/scan-kotlin-comments.py .   # 0 issues 才算干净
  ```
- **channel 必须是 RFC4648 base32**（`^[A-Z2-7]{16,64}$`）：数字**只能是 2–7**，
  写 `TMP…TEST1` 这种含 1/8/9 的会被中继 `bad-hello` 拒。
- **业务帧必须在知道对端 pv 之后才发**：对端证明来自 `welcome.peer` / `peer-joined.peer`，
  未知 pv 时 AAD 模式可能与对端选得不一样 → 双方都解不开。
- **纪元必须持久化**（`EpochState` 存远程档案）：清数据后仍信任旧纪元 = 一次重放窗口。
- **联调用例要用随机 channel**：`e2e/mock-host.mjs` 把「已接受的对端纪元」持久化到
  `/tmp/dshrc-e2e-epoch-host-<channel>.json`（契约 §3.4.1）。固定 channel + 每次新 sid
  → 第二轮起 host 判「纪元回退」直接拒绝握手 → 用例必挂。`LinkIntegrationTest` 已改随机 channel。
- **中继是「同 channel 同 role 单活跃连接：新顶旧」**：真机在线时**不要**跑
  `e2e/auto-test.mjs` 的真实宿主链路（会互抢）；用 `E2E_LOOPBACK_ONLY=1`。
- **三方库按 Compose 1.8 编译 → 运行期 `NoSuchMethodError`**（编译期发现不了，一渲染就崩）：
  `com.mikepenz:multiplatform-markdown-renderer` **0.34.0 / 0.35.0** 的 `TextWrapper`
  用了 Compose 1.8 才有的 `BasicText(..., ColorProducer, TextAutoSize)` 重载，
  而本项目 compose BOM 2024.12.01 = **Compose 1.7.6** → 渲染助手气泡即崩：
  `NoSuchMethodError: No static method BasicText-...(Landroidx/compose/foundation/text/TextAutoSize;...)V`
  → **markdown 版本必须 ≤ 0.33.0**（0.31/0.32/0.33 的 AAR 里没有 `TextAutoSize`）。
  判兼容版本的方法：解包 `multiplatform-markdown-renderer-android-<ver>.aar` 的
  `classes.jar`，`grep -c TextAutoSize` —— 有就是 Compose 1.8-only。
  升级 compose BOM 到 1.8+ 之前**不要**动这个版本号。
- **沉浸式（`enableEdgeToEdge`）下软键盘不再 resize 窗口**：manifest 里的
  `windowSoftInputMode="adjustResize"` 在 edge-to-edge 下**失效**，窗口尺寸不变
  → 输入栏被键盘整条盖住 → **发送键点不到**（看起来像「发送没反应」）。
  必须在含输入框的底部容器上加 `.imePadding()`（`SessionDetailScreen` 输入区），
  可滚动表单页加在滚动容器上（`NewSessionScreen` / `ConnectionsScreen`）。
- **`adb input text` 不更新 Compose 的 `TextField` state**：软键盘 IME 路径注入的文本
  会出现在 `uiautomator dump` 的 `EditText` 里，但 Compose 的 `draft` 仍是空
  → `canSend` 恒 false → 点发送是**静默 no-op**。验证发送链路要么用
  `adb shell input keyevent <KEYCODE>`（逐字符真实按键，能进 Compose state），
  要么走宿主侧主动推送（`MOCK_PUSH_DEMO=1`）。
- **调试日志双写 Logcat**：`adb logcat -s DSHPocket` 能看到链路与 App 侧事件
  （`PocketApp.appendLog` 同时写 Logcat）。排查「点了没反应」先看这个 tag。
- **ArkTS 微任务 vs Kotlin 派发恢复 → 两端时间线顺序会不同**：ArkTS 的 `Promise.then` 是
  **微任务**（必早于下一帧 WS 消息），Kotlin 的 `deferred.await()` 恢复是**派发**的
  → 读线程会先把下一帧（`assistant.delta`）处理掉，再轮到协程恢复。
  若客户端「等 prompt accepted 再上屏」，用户气泡就落在流式回复**中间**，
  同一条回复被切成两个气泡（ArkTS 不犯这个 → 两端行为不一致）。
  宿主侧还会放大这个窗口：插件端 `#rSessionPrompt` 先 await 宿主 prompt、**之后**才回包
  → `assistant.delta` 可能**先于** prompt 回包到达。
  → 口径：**乐观气泡在发请求之前落位**（`Store.sendPrompt`），宿主拒收 / 请求失败再回滚；
  繁忙时（发请求**之前**快照 `running=true`）不插主时间线（插进去会切开当前回复）。
  回归用例：`core/src/test/kotlin/dsh/rc/core/TimelineOrderTest.kt`
  （mock host 用 `MOCK_PROMPT_RESULT_LAST=1` 把 accepted 回包挪到流式回复之后，复现真实顺序）。
- **时间线必须贴底跟随（`TimelineList`）**：乐观气泡先于宿主回包上屏 → 不贴底用户就
  **看不见自己刚发的消息**（长会话里尤其明显，看着像「发送没反应」）。三个坑：
  1. `scrollToItem(lastIndex, Int.MAX_VALUE)` 的 offset 会与下标相加溢出
     （`index * averageSize + offset` → 负数 → 被夹到**顶部**）→ 只能用
     `scrollToItem(lastIndex)` 再 `scrollBy(大值)` 滚到底。
  2. 首次出现要直接贴底（对齐 ArkTS 的 `initialIndex` + `stackFromEnd`），
     否则进会话停在最早一条。
  3. 跟随标志**只能由用户手势滚动改变**（`followBottom`）：`turn.end` 后的历史刷新把
     直播项换成 durable 项（key 变了）→ LazyColumn 跳回顶部 → 靠「可见项是否在末尾」
     判定会误判成「用户不在底部」→ 又不贴底 → 刚发的消息被顶出视口。
- **幽灵 process group 的根因在「对账」，不在「分组」**（对齐 ArkTS 2026-11-08 修复）：
  分组只是把**真实残留**的 reasoning/step 归组，不是凭空多画节点。最终助手消息之后偶尔
  多出一个分组、重启 App 才消失 → 是历史/直播竞态把 `seq=-1` 的迟到 reasoning 或
  orphan step 留在尾部。修法（core/Store.kt）：
  - `mergeHistory` 在「**非 prepend 的最新页 + 宿主已空闲**」时，这页已是最终权威投影 →
    **所有 `seq<0` 的直播步骤都要退出**（含没进本页的 orphan step）；宿主还忙时只按
    `callId` 去重，运行中的直播步骤不消失。
  - `turn.end` 置空闲后**立刻**用最新权威页对账一次；`session.status` 的
    `running:true→false` 是 `turn.end` 丢失时的兜底，同样补一次对账。
  - ⚠️ 对账请求**不能在锁内发起**：`handleEventLocked` 返回要刷新的 sessionId，
    由 `onEvent` 在锁外 `scope.launch { refreshHistory(...) }`。
  - 回归用例：`core/src/test/kotlin/dsh/rc/core/LiveStepReconcileTest.kt`。
- **历史错误归属会话，不写全局 `lastError`**（对齐 ArkTS 2026-11-08）：
  `session.history` 失败**不得**写全局错误（首页会抢走、还会串到别的会话）。
  错误记在会话自己身上（`store.historyError` / `historyErrorFor(sid)`），只在它的
  详情页展示并给「重新加载」（`retryHistory(sid)`）；离线时给「加载历史失败：未连接主机」。
  链路 stop/idle → 清空，避免跨主机串错。
- **新建会话是「首条任务合成器」**（对齐 ArkTS 2026-11-08，线协议不变）：
  新建页填**首条任务** + 附件 → **create → 串行上传 → 带 `uploads` 发 prompt**
  （契约 §5.11）。create 成功即**不得重复 create**（`modelError` 只提示「已用默认模型」
  并继续）；上传/prompt 失败 → 把正文 + 附件（含已 commit 的 `uploadId`）**移交详情页**，
  表单不留在原地诱导重复创建。
  - 上传**必须串行**：同一 `uploadId` 只允许一条 chunk 流（并行 = 违反契约）。
  - 附件草稿**新建页与详情页各有一份**（ArkTS 是页面级字段）：共用一张表会把
    A 会话暂存的附件串到 B 会话（文件发到错的会话）。

