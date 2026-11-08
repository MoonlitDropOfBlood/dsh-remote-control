# DSH Pocket for Android

用 Android 手机远程控制 DeepSeek Harness (DSH)：会话遥控、审批/提问应答、任务通知。

这是仓库里 **HarmonyOS 版**（[`app/`](../app)，ArkTS/ArkUI）的 **Android 对等实现**——
两端实现**同一份线协议契约**（[`docs/PROTOCOL.md`](../docs/PROTOCOL.md) v1.2.0），不是其中一端的副本。

## 它能做什么

- **配对**：扫 PC 端 DSH「设置 → DSH Pocket」里的二维码，或手动填 `relayUrl / channel / secret`；支持**多个远程**（局域网 PC / VPS 随意切）。
- **会话列表**（首页）：标题、运行状态、最近活动；下拉刷新；左滑归档（**Host 真实归档**，不是本机假状态）。
- **会话详情**：统一时间线（对话 / 思考过程 / 工具调用 / 过程分组）、Markdown 渲染、图片缩略图与大图、
  模型与思考强度胶囊、权限胶囊、附件（图片/文件）分块上传、排队列表、subagent 目录。
- **审批与提问**：允许/拒绝、选项回答（**fail-open**：超时/断线一律放行桌面答案器，手机不是单点阻塞）。
- **新建会话**：首条任务 + 工作目录 + 模型与强度 + 模式 + 权限。

## 快速开始

```bash
# ① 准备工具链（JDK 用 Android Studio 自带的 JBR；SDK 用本机 Android SDK）
export JAVA_HOME="D:/Application/JetBrains/Toolbox/Android Studio 2/jbr"   # JDK 21
export ANDROID_HOME="C:/Users/wwhby/AppData/Local/Android/Sdk"

# ② 跑 core 单测（**不需要设备/模拟器**）：KAT + AAD 绑定 + 对 relay/mock-host 的跨实现联调
cd app-android && ./gradlew :core:test

# ③ 构建 APK
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Gradle 走仓库自带 wrapper（8.13）。⚠️ 官方源在国内很慢，用腾讯云镜像手动塞进 wrapper 缓存
（详见 [app-android/AGENTS.md](AGENTS.md) 的「工具链」一节）。

## 结构

| 模块 | 内容 |
|---|---|
| `:core` | **纯 JVM**（无 Android 依赖）：协议常量、HKDF/AES-256-GCM/HMAC、WS 链路（纪元握手/收发保序/去重/重连）、会话仓、附件分块、过程分组 |
| `:app` | Compose UI：会话列表 / 会话详情 / 新建会话 / 审批队列 / 连接管理 / 关于 + 扫码配对 + 附件选择 |

core 单独成纯 JVM 模块，是为了**在没有设备的情况下**跑协议验收：
契约 §7 的 KAT 向量（key/iv/ct/tag/HMAC）与「换 role / 换 seq / 换 sid 必须解密失败」都能一键验证，
`LinkIntegrationTest` 还会拉起仓库自带的 `relay/server.js` 与 `e2e/mock-host.mjs`
（**既有 JS 第三份实现**）做跨实现互通验证。

## 与 HarmonyOS 版的差异

| 项 | HarmonyOS | Android | 原因 |
|---|---|---|---|
| 加密 | `@kit.CryptoArchitectureKit` | JCA（core 内） | core 要纯 JVM 可测 |
| 网络 | `@kit.NetworkKit` | OkHttp | 同上 |
| 推送 | 华为 Push Kit | **不做** | 插件侧 `push.register` 的 platform 是 `harmonyos`；Android 端需 FCM + 插件改造，另议 |

## 相关文档

- 协议契约（唯一事实源）：[`docs/PROTOCOL.md`](../docs/PROTOCOL.md)
- 本模块的工程约定与坑：[`app-android/AGENTS.md`](AGENTS.md)
- core 的 Kotlin API 契约：[`app-android/CORE_API.md`](CORE_API.md)
- 仓库总览：[`AGENTS.md`](../AGENTS.md)
