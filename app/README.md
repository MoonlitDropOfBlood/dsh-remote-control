# dsh-remote-control-app（HarmonyOS App · 阶段 R2）

手机端远程控制 DSH 的 HarmonyOS 应用工程。本目录是 GitHub 单仓 `dsh-remote-control` 的 `app/`
子目录，由 **devecocli v1.3.6 `create` 脚手架生成**，契约以仓库根 `../docs/PROTOCOL.md`（**v1.0.2**）为准。

- bundleName：`com.dukedsh.remotecontrol`
- 应用显示名：`dsh-remote-control`（AppScope 字符串资源 `app_name`）
- API level / SDK：**26**（`targetSdkVersion` / `compatibleSdkVersion` = `26.0.0`，runtimeOS=HarmonyOS）
- 设备形态：phone

> 阶段划分：
> - **R1（已完成）**：工程脚手架 + 构建绿灯 + 模型层（protocol / crypto / link / store）。
> - **R2（已完成）**：五页面 UI（① 配对/设置 ② 会话列表 ③ 会话详情 ④ 审批/提问卡片+队列 ⑤ 关于）
>   + `sessionstore.ets`（@ObservedV2 状态仓，合并契约 §5.2 全部事件）
>   + Push Kit 接入（`push.ets`：getToken / tokenUpdate / `push.register` 上报 / 通知 intent 直达）。
>   - 状态管理**全部 V2 装饰器**（@ObservedV2/@Trace/@Local/@Param/@Event/@Monitor/@ComponentV2），
>     全树 grep `@State|@Prop|@Link|@ObjectLink|@Observed[^V]|@Provide|@Consume|@Watch|@StorageLink` **0 命中**。

---

## 1. 环境与准备

| 项 | 本机实测值 |
|---|---|
| devecocli | `devecocli --version` → **1.3.6**（全局命令） |
| DevEco Studio SDK | `D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/ets` |
| Node.js | linter-cli 运行需要 |
| 登录 | `devecocli auth status` → 未登录。**签名生成 / run 到真机需要 `devecocli auth login`** |

```bash
devecocli --version           # 1.3.6
devecocli auth status         # 签名/装机前先登录
```

## 2. 从零重建工程（devecocli create）

```bash
devecocli create \
  --project-path "D:/ai-projects/dsh/dsh-remote-control/app" \
  --app-name dsh_remote_control \
  --bundle-name com.dukedsh.remotecontrol \
  --device-types phone
```

实测输出摘要：

```
Initializing project...
Project path: D:\ai-projects\dsh\dsh-remote-control\app
App name: dsh_remote_control
Bundle name: com.dukedsh.remotecontrol
Device types: phone
API level: 26
Project created successfully.
Template integrity check passed.
```

**两个坑（务必看）：**

1. `--app-name` **只接受字母/数字/下划线**（`dsh-remote-control` 会被拒：
   `Application name must start with a letter (a-z, A-Z) and contain only letters, digits, and underscores`）。
   所以脚手架参数用 `dsh_remote_control`，最终**显示名**在
   `AppScope/resources/base/element/string.json` 的 `app_name` 里改成 `dsh-remote-control`。
2. `devecocli build` / `check` 必须在**工程根目录**（含顶层 `build-profile.json5`）执行，
   否则报 `Not in a valid project directory (project-level build-profile.json5 not found)`。

生成的文件树（去掉 build 产物；★ 为 R2 新增）：

```
app/
├── AppScope/
│   ├── app.json5                       # bundleName=com.dukedsh.remotecontrol
│   └── resources/base/element/string.json   # app_name = dsh-remote-control
├── build-profile.json5                 # SDK 26.0.0
├── code-linter.json5                   # DevEco Code Linter 配置（含 @security/* 规则）
├── hvigor/hvigor-config.json5
├── hvigorfile.ts
├── oh-package.json5                    # modelVersion 26.0.0
├── local.properties
└── entry/
    ├── build-profile.json5
    ├── hvigorfile.ts
    ├── oh-package.json5                # @ohos/hypium / @ohos/hamock
    ├── obfuscation-rules.txt
    └── src/main/
        ├── module.json5                # + requestPermissions: ohos.permission.INTERNET
        ├── ets/
        │   ├── entryability/EntryAbility.ets      # ★ Push token + 通知 intent 解析 + 通知授权
        │   ├── entrybackupability/EntryBackupAbility.ets
        │   ├── pages/                             # ★ 五页面 UI（全部 @ComponentV2）
        │   │   ├── Index.ets             # ① 配对/设置页（Navigation 根 + 路由映射）
        │   │   ├── SessionListPage.ets   # ② 会话列表（Refresh 下拉 + Repeat 会话卡）
        │   │   ├── SessionDetailPage.ets # ③ 会话详情（气泡流 + 输入条 + 取消；含 SessionDetailParam）
        │   │   ├── AskCards.ets          # ④ 审批卡 / 提问卡组件（倒计时 + 允许/拒绝 + 问答）
        │   │   ├── ApprovalQueuePage.ets # ④ 审批/提问队列页（NavDestination）
        │   │   ├── AboutPage.ets         # ⑤ 关于（版本 / 协议 / E2E 说明 / MIT）
        │   │   └── FieldInput.ets        # 通用“标签+输入框”字段
        │   └── model/                    # R1 模型层（未改协议/加密逻辑）+ R2 状态层
        │       ├── protocol.ets          # 常量/消息类型/KAT 向量（契约 v1.0.2，逐字未改）
        │       ├── crypto.ets            # HKDF-SHA256 + AES-256-GCM + assertKat()
        │       ├── link.ets              # WS 链路层（hello/welcome/心跳/重连/sid:seq 去重/Correlator）
        │       ├── store.ets             # Preferences 配对持久化
        │       ├── theme.ets             # ★ 设计 token：间距/圆角/字号 + 状态语义映射 + 时间格式化
        │       ├── sessionstore.ets      # ★ @ObservedV2 状态仓：§5.2 全事件 + 消息缓存 + 审批问答
        │       └── push.ets              # ★ Push Kit：getToken/tokenUpdate/intent 解析（§6 降级）
        └── resources/
            ├── base/element/color.json   # ★ 设计 token 色板（亮色）
            └── dark/element/color.json   # ★ 同名 token 暗色（跟随系统自动切换）
```

## 3. 校验与构建（实际命令 + 实测结果）

### 3.1 `devecocli check`

`devecocli check` **没有裸命令**，必须带子命令：`compat` / `lint` / `arkts`。

```bash
cd D:/ai-projects/dsh/dsh-remote-control/app

# ArkTS 静态检查（工程级，全部 .ets）
devecocli check arkts --project .
#   → No errors found in 7 file(s).      ← 0 error
#     （24 条 warning：cryptoFramework "may throw" 提示、webSocket 需要 INTERNET 权限的提示）

# 逐文件也行
devecocli check arkts entry/src/main/ets/model/protocol.ets … --project .
#   → No errors found in 6 file(s).
```

`devecocli check lint`（DevEco Code Linter）在本机 1.3.6 上**恒报 `Files checked: 0`**
（换目录 / 绝对路径 / 显式 `--config-path` 均复现），即该子命令当前扫不到文件，
不作为验收依据；真正的 lint 用下面 3.2 的 linter-cli（0 ERROR）。

### 3.2 linter-cli（真实 SDK）

```bash
node "C:/Users/wwhby/.dsh/skills/hmos-arkts-knowledge-retriever/linter-cli/bin/linter-cli.js" \
  --input "D:/ai-projects/dsh/dsh-remote-control/app/entry/src/main/ets/<file>.ets" \
  --sdk-path "D:/Application/Huawei/DevEco Studio/sdk/default/openharmony/ets" \
  --sdk-path "D:/Application/Huawei/DevEco Studio/sdk/default/hms/ets"
```

> **坑（R2 实测）**：`--sdk-path` **可重复传**，且必须补传 `hms/ets` ——
> `@kit.PushKit` 是 HMS Kit，只存在于 `sdk/default/hms/ets/kits`；只传 openharmony/ets 时
> `push.ets` 会报 `Cannot find module '@kit.PushKit'`（非代码问题）。传两个路径后 16/16 文件全部 0 ERROR。

R2 全量逐文件实测（**16/16 `Lint Check: OK`，0 ERROR**）：

| 文件 | 结果 |
|---|---|
| model/protocol.ets · crypto.ets · link.ets · store.ets（R1） | `Lint Check: OK` ×4 |
| model/theme.ets · sessionstore.ets · push.ets（R2） | `Lint Check: OK` ×3 |
| pages/Index.ets · SessionListPage.ets · SessionDetailPage.ets · AskCards.ets · ApprovalQueuePage.ets · AboutPage.ets · FieldInput.ets（R2） | `Lint Check: OK` ×7 |
| entryability/EntryAbility.ets · entrybackupability/EntryBackupAbility.ets | `Lint Check: OK` ×2 |

剩余均为 advisory WARNING：`Function may throw exceptions`（cryptoFramework 同步接口）、
`API supported since SDK 12 / compatible SDK 10`（linter-cli 单文件模式默认推断，工程实际 26.0.0）、
`need to apply for permissions: ohos.permission.INTERNET`（已在 `module.json5` 声明）、
`'showToast'/'getContext' has been deprecated`（API 26 提示，仍可用）。

### 3.3 `devecocli build`

```bash
cd D:/ai-projects/dsh/dsh-remote-control/app
devecocli build
```

实测：

```
[ohpm install] … install completed in 0s 298ms
[hvigor build] … BUILD SUCCESSFUL in 3 s 983 ms
33 tasks in total: 33 executed, 0 up-to-date
WARN: Will skip sign 'hos_hap'. No signingConfigs profile is configured in current project.
Build completed successfully
Build artifacts: app\entry\build\default\outputs\default\entry-default-unsigned.hap
```

带模型层后复跑：`BUILD SUCCESSFUL in 1 s 816 ms`（27 executed / 6 up-to-date）。

**R2 五页面 UI + sessionstore + Push 后复跑（最终态）**：

```
> hvigor  Finished :entry:default@CompileArkTS...
> hvigor  Finished :entry:default@SignHap...
> hvigor  BUILD SUCCESSFUL in 7 s 456 ms     ← 33 tasks（20 executed / 13 up-to-date）
Build completed successfully
Build artifacts:
  …\entry\build\default\outputs\default\entry-default-signed.hap
  …\entry\build\default\outputs\default\entry-default-unsigned.hap
```

> 本机当前已能产出 signed HAP（签名已配置）；若在未配置签名的机器上跑，出现
> `Will skip sign 'hos_hap'. No signingConfigs profile is configured` 并只产出 unsigned HAP 属预期（见 §4）。

### 3.4 签名与运行（需要登录）

```bash
devecocli auth login                                    # 华为开发者账号登录
devecocli signature generate --type debug               # 自动生成签名材料并写入 build-profile.json5
devecocli device list                                   # 列出连接的真机/模拟器
devecocli build --build-mode debug
devecocli run --module entry --device <serial>          # 构建 + 安装 + 启动
```

`devecocli signature generate` / `devecocli run` 需要 `auth login` 与已连接设备；本任务未登录，
故只做到 `build`（unsigned HAP）为止。

## 4. 用 DevEco Studio 打开

1. DevEco Studio → **File → Open** → 选择 **`D:/ai-projects/dsh/dsh-remote-control/app`** 目录
   （**选 app/ 这一层，不是仓库根**：工程根以顶层 `build-profile.json5` / `hvigorfile.ts` 为准）。
2. 等待 **hvigor sync + ohpm install** 完成（首次会拉 `@ohos/hypium`、`@ohos/hamock`）。
3. 签名：**File → Project Structure → Signing Configs →automatically generate signature**
   （或命令行 `devecocli auth login && devecocli signature generate --type debug`）。
   签名配置写入 `build-profile.json5` 的 `signingConfigs` 后，`devecocli build` 产出 signed HAP。
4. 运行：选择真机/模拟器，点 Run；或 `devecocli run --module entry --device <serial>`。
5. SDK 版本：确认 Project Structure 中 SDK 为 API 26（与 `oh-package.json5` 的 `modelVersion: 26.0.0`
   一致）；不要手工降级，`devecocli create` 按本机 SDK 自动选的 26。

## 5. 模型层要点（契约 v1.0.2 对齐）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `protocol.ets` | 常量 / 消息类型 / KAT 字面量 | §4/§5/§7 常量集中于此；`DshrcMsg`/`DshrcPayload`/`DshrcRelayFrame` 字段名与契约逐字一致；KAT 字面量照抄 §7 |
| `crypto.ets` | HKDF + AES-256-GCM | `deriveKey` = HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"), info=UTF8("e2e|"+channel), 32)；`seal/open` = `base64url(iv12‖ct‖tag16)`，AAD=`UTF8("dshrc|"+发送方role+"|"+seq)`；`helloSig` 走 `HMAC|SHA256` `convertKey`→`Mac.init(SymKey)`；`randomBytes` 取 `generateRandomSync().data`；`assertKat()` 逐字节核对 key/ct/tag + AAD 跨 role 必须失败 |
| `link.ets` | WS 链路层 | `@kit.NetworkKit` 的 `webSocket.createWebSocket()`（不是 `net.*`）；hello 10s 超时；退避 1s→60s + 0.8~1.2 抖动；30s 心跳 / 90s 判死；**每条连接新 sid(8 hex) + seq 从 1**；去重键 `sid:seq` 分桶（单桶 4096 / 总桶 64 淘汰最旧）；`Correlator` 请求-响应关联；§5.1 请求封装全集 |
| `store.ets` | Preferences 持久化 | `relayUrl/channel/secret/relayToken`；`secret` 只存本地；`validatePairing()` 按 §4 校验 channel `^[A-Z2-7]{16,64}$` |
| `theme.ets` ★ | 设计 token（数值层） | 间距 4/8/12/16/20/24、圆角 8/12/14/pill、字号阶梯；`linkStateColor/Text/busy` 状态语义；`relTime/clockTime/countdownText` 时间格式化。**颜色 token 在 resources 色板**（base + dark 同名），代码只用 `$r('app.color.*')` |
| `sessionstore.ets` ★ | @ObservedV2 状态仓 | 合并 §5.2 **全部 12 个 topic**（`session.added` 取 `data.session` 嵌套、`error` 取 `data.message` —— 上一版踩过的坑）；`assistant.delta` 流式并入当前气泡 / `turn.end` 定稿；审批/提问卡片数组 + `*.resolved` 消除；`push.register` 在链路 online 后自动上报；`session.list` 拉取返回 Promise 供下拉刷新收尾；推送开关走 Preferences（`pushEnabled`） |
| `push.ets` ★ | Push Kit 封装 | `pushService.getToken()` → `sessionStore.setPushToken`；`pushService.on('tokenUpdate', ability, …)` 变化重取；`parsePushIntent` 解析通知点击 extra（`sessionId/askId/kind`，兼容顶层与 `parameters/extra/dshrc` 包裹两形态）；任何失败只写 hilog **优雅降级（§10）** |

**KAT 在连接前执行**：`DshrcLink.start()` → `await assertKat()`（`link.ets:240`）通过后才
`deriveKey` 并建链，失败则状态置 `error` 不建链。

KAT 字面量与 `docs/PROTOCOL.md` §7 程序化比对：`keyHex / ivHex / ctHex / tagHex` **全部 MATCH**。

## 6. 五页面 UI 设计要点（token / 布局结构）

**全局设计语言**（参考 DeepSeek Harness 本体）：
- **亮/暗双主题跟随系统**：同名 token 写两份 `resources/base|dark/element/color.json`，
  运行时零状态管理、自动切换；代码里**没有任何硬编码色值**（半透明一律用预合成 alpha token：
  `brand_tint/state_*_tint/fill_hover/fill_pressed/scrim`）。
- **对比色语义**：`border_contrast`（≈亮黑/暗白）只用于描边/文字/焦点环；
  **填充底一律 `brand_fill`（亮 `#4D6BFE` / 暗 `#6480FF`）配 `label_on_brand` 白字**。
- 质感：圆角卡片 8–12vp、1px 细描边（`border_l1` 弱 / `border_l2` 强）、间距 4/8/12/16/20/24 阶梯、
  无重投影（全项目零 shadow）。

| 页面 | 文件 | 布局结构与 token 使用 |
|---|---|---|
| ① 配对/设置 | `pages/Index.ets`（Navigation 根） | Scroll>Column 单列卡片流：品牌头（`brand_fill` 圆角方标）→ 状态卡（`linkStateColor` 状态灯 + LoadingProgress + 主机在线胶囊 `state_success_tint` + KAT 指示 + 可展开链路日志）→ 配对卡（`FieldInput`×4，`bg_layer_2` 输入面）→ 连接/断开（主按钮 `brand_fill`、断开描边 `state_error`）→ 推送开关卡（Toggle `selectedColor=brand_fill`，token/上报状态行）→ 进入列表/待处理角标（`state_warn_tint`）→ 版本脚注；`hideTitleBar` 后自绘页头 |
| ② 会话列表 | `pages/SessionListPage.ets` | 自绘顶栏（返回 + 状态灯徽标）→ 待处理审批横幅（`state_warn_tint`）→ **`Refresh{List{Repeat}}` 下拉刷新** → 会话卡（标题 ellipsis + 运行徽标 `brand_tint`/空闲 `bg_layer_2` + cwd + `relTime` + `›`）→ 底部固定 `brand_fill`「新建会话」；空态居中提示按在线与否换文案 |
| ③ 会话详情 | `pages/SessionDetailPage.ets` | 自绘顶栏（标题 + 主机状态 + 运行胶囊）→ `Scroll{Column{Repeat(messages)}}` 气泡流：**用户右对齐 `brand_fill` 白字**，**assistant 左对齐 `bg_layer_1` 卡片**，围栏代码段切分为正文/等宽段、代码段 `fontFamily('monospace') + bg_layer_2`，流式时尾部 `▍` 光标，下方时间戳；`@Monitor('store.messages')` 新气泡/流式增长自动贴底滚动 → 本会话审批/提问卡片内嵌区（≤46% 高）→ 输入条（TextArea + `取消`描边红 + 发送 `brand_fill`，离线/空文禁用） |
| ④ 审批/提问 | `pages/AskCards.ets` + `pages/ApprovalQueuePage.ets` | 卡片：`AskCountdownBar`（品牌胶囊标题 + `countdownText` 剩余时间 + Linear Progress 按剩余变色 `brand_fill`/`state_error`）→ 工具名等宽字体 + reason + `argsPreview` 等宽代码块（`bg_layer_2`）→ **允许（`brand_fill` 白字）/ 拒绝（描边 `state_error`）**，超时禁用；提问卡：单选 `Radio` / 多选 `Checkbox`（选中态 @ObservedV2）+ 自由文本 TextArea + 提交，answers 按 §5.4 组装 JSON；队列页 Repeat 全部待答卡并显示会话胶囊 |
| ⑤ 关于 | `pages/AboutPage.ets` | 品牌头 → 版本与协议卡（App `v1.0.0` / 契约 `v1.0.2` / HKDF salt / KAT 实时自检结果）→ 端到端加密三段说明卡 → MIT License + 仓库链接卡，全部 `bg_layer_1 + border_l1` 卡片节奏 |

导航：`Index` 内 **单个 `@Builder pageMap`** 做 name→page 映射（链式 `.navDestination()` 会互相覆盖的坑）；
页面在 `NavDestination().onReady` 取 `ctx.pathStack` / `ctx.pathInfo.param`（`SessionDetailParam {sessionId}`，
先声明 interface 再传，避免 10605038）；全部 `hideTitleBar(true)` 自绘顶栏。

## 7. AGC Push 配置步骤（手机端 + 插件端）

手机端代码已接好（token 获取 / 变化重取 / `push.register` 上报 / 通知点击直达），**未配置 AGC 时按契约 §10
优雅降级**（`getToken` 失败仅写 hilog，主链路不受影响）。要收到真机推送按序配置：

1. **登录 [AppGallery Connect](https://developer.huawei.com/consumer/cn/service/josp/agc/)** → 项目 → 应用
   （bundleName `com.dukedsh.remotecontrol`，显示名 dsh-remote-control）。
2. **开通推送服务**：「增长 → 推送服务 → 立即开通」（未开通时 `getToken()` 报 **1000900010**）。
3. **配置签名**：AGC「证书、APP ID 与 Profile」上传调试/发布证书指纹，生成**含推送权限的 Profile**；
   DevEco `File → Project Structure → Signing Configs → automatically generate signature`
   （或 `devecocli auth login && devecocli signature generate --type debug`）。
   签名不匹配报 **1000900011** → 重新生成 Profile 并重新安装。
4. **（可选）申请通知消息自分类权益**（IM 等）：默认“资讯营销类”每设备每日 2–5 条限制。
5. **插件侧配置**（DSH 插件 config，见仓库根 `docs/PROTOCOL.md` §6）：
   `push.enabled` / `push.appId` / `push.clientId` / `push.clientSecret` / `push.channelId`（通知渠道）。
   插件用 client_credentials 换 token 后调 `…/v1/{appId}/messages:send`，target 用手机上报的
   `push_token`（即本 App `push.register` 上报的值），`intent` extra 携带 `sessionId/askId/kind`。
6. **验证**：真机安装启动 → 配对页「推送通知」开关打开 → 日志出现
   `push token acquired` 且状态行变 `… 已上报主机` → 手机锁屏，PC 端触发一次审批 →
   通知点击应直达审批队列 / 会话详情（`EntryAbility.onCreate/onNewWant` 解析 intent）。
   主机侧未开通时状态行显示 `主机侧未开通推送`（`push.state` 事件），属预期降级。

## 8. 阶段遗留清单

- [x] 五页面 UI：① 配对/设置 ② 会话列表 ③ 会话详情（`assistant.delta` 流式追加、发送/取消）④ 审批/提问卡片 + 队列页 ⑤ 关于
- [x] `sessionstore.ets`：@ObservedV2 状态仓（§5.2 全事件合并 + 消息缓存 + 审批问答 + push.register 上报）
- [x] Push Kit：`push.ets` 取 token → `push.register` 上报 → 点击 intent 直达会话（AGC 未配置时 §10 优雅降级）
- [x] 状态管理 V2 全覆盖：全树 V1 装饰器 grep 0 命中
- [ ] 签名与真机联调：`devecocli auth login` + `signature generate` + `run`（需要用户华为账号/真机）
- [ ] AGC 推送真机验证：按 §7 配置后联调（需要用户 AGC 项目与 clientId/secret）
- [ ] `devecocli check lint` 恒 `Files checked: 0`（1.3.6 疑似未挂载 linter 引擎）→ lint 以 linter-cli 为准，或升级 `devecocli update` 后复测
