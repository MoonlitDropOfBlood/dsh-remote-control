# AGENTS.md — plugin/（DSH 插件，Host 侧半边）

Cordis 功能插件：把 DSH 的会话/审批/事件桥接到中继，供手机 App 遥控。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构

```
index.js              Cordis 类插件入口：export default class RemoteControlService extends TypertRemoteService
                      （服务名 remoteControl；[Service.init] 启动宿主链路 + 标记四个 Remote 方法；
                        另保留函数式 apply(ctx, config) 供函数插件宿主使用，两条路共用 startRemoteHost）
client.js             Web 半边：window.__ModuleLoader__.load → 注册「设置 → DSH Pocket」分区
typert.host.js        TYPERT Host manifest（package/face/invocations + strict codec，每个 codec 带 create()）
lib/protocol.mjs      信封 + HKDF-SHA256 + AES-256-GCM + assertKat()（契约 §3/§7）
lib/config.mjs        %DSH_HOME%/remote-control/config.json 读写（首启生成 channel/secret、hidden 标记）
lib/relay-client.mjs  中继 WS 客户端（退避重连/心跳/sid:seq 去重/reload 热更换）
lib/relay-supervisor.mjs 中继进程托管（v1.1.1）：本机中继随插件启停；只停自己 spawn 的 child
lib/host-bridge.mjs   Host 桥接：sessionController + api-session/agent 事件 + 审批/提问瀑布
lib/images.mjs        会话消息里的图片（契约 §5.10）：image 块识别 + sharp 缩略图/大图
                      （imageBlocksOf / makeThumb / makeLarge / imageRefMeta）
lib/pairing.mjs       配对核心：URI（§3.5）/QR（SVG+ASCII）/rotatePairingIdentity/setPairingHidden
                      /isLoopbackRelayUrl+loopbackWarning（回环地址判定与警告文案）
lib/qr.mjs            内嵌 QR 编码器（移植 Nayuki qrcodegen，MIT；byte 模式 ECC-M v1-10）
lib/push.mjs          Push Kit REST（token 缓存 + messages:send，失败静默降级）
scripts/verify-*.mjs  dev 验证脚本（jsqr 独立解码 + 配对 API mock + 设置页结构自检）
scripts/sync-client-icon.mjs  把 icon.svg 同步成 client.js 里的导航图标 CSS mask data-uri
```

## 构建与验收

```bash
node --check index.js client.js typert.host.js lib/*.mjs scripts/*.mjs   # 语法
node -e "import('./lib/protocol.mjs').then(m=>m.assertKat())"           # KAT
node scripts/verify-qr.mjs && node scripts/verify-pairing.mjs           # QR/配对 API 回归（需 devDependencies）
node scripts/verify-steps.mjs                                          # v1.0.9 步骤/模式/权限/归档/模型/思考/强度 + 图片回归（无依赖，154 项）
node scripts/verify-images.mjs                                         # v1.0.9 图片专项：元数据映射/缩略图降级/image.fetch 缓存与报错/帧预算守卫（无依赖，88 项）
node scripts/verify-settings.mjs                                       # v1.1.x 设置页/manifest/combo/信封自检 + Host 真跑一遍（112 项）
node scripts/verify-relay-supervisor.mjs                               # v1.1.1 中继进程托管：决策/端口占用不抢/启停/看门狗/跨平台/bundle（无依赖，76 项）
node scripts/sync-client-icon.mjs                                      # 改了 icon.svg 后同步 client.js 的图标 data-uri
```

安装/重载（link 安装，磁盘即运行源码）：plugin_manager `install_bundle` → 本目录。
**改代码后必须重载插件才生效**——只改磁盘上的文件**不会**让运行中的 DSH 换代码
（实测：touch 插件源文件后运行中的实例毫无反应；watcher 不覆盖插件的 node_modules 路径）。

| 操作 | 加载新代码？ | 依据 |
|---|---|---|
| 只改文件（不重载） | ❌ | 实测无反应；cordis loader 是裸 `import(url)` → 命中 ESM 缓存 |
| `set_plugin` 关→开 | ✅ | plugin-manager 的 `setPlugin` → `reload()` → `hmr.reconcileProfile()` |
| `remove_bundle` + `install_bundle` | ✅ | 同上走 `reload()`；HMR 先 `evict()` 掉 ESM 缓存条目再重新 import |
| 重启 DSH 桌面端 | ✅ | 进程重启，缓存自然清空 |

> HMR 的 `evict()`：`Map.prototype.delete.call(internal.loadCache, url)` 把 ESM 缓存条目**整条**
> 删掉（Node 的 `LoadCache` 一个 URL 下有 ESM/CJS 两种 job，只删一种会残留），
> 下次 `import()` 才重新求值文件。**只改文件不重载 = 永远跑旧代码。**

> **改了 `plugin/icon.svg` 一定要跑 `node scripts/sync-client-icon.mjs`**：client.js 是静态
> 浏览器包（无打包器），拿不到包内文件，导航图标只能内联 data-uri。
> `verify-settings.mjs` 会检查内联值与 icon.svg 是否一致（过期即 FAIL）。

> **本地依赖联接（gitignored，新克隆后要重建）**：插件是 link 安装，Node 按**真实路径**
> 解析依赖，所以要在 `plugin/node_modules/` 里联接 DSH 部署目录里的包，否则
> `@deepseek-ai/cordis` / `@deepseek-ai/dsh-typert-protocol` / `zod` 解析不到：
>
> ```bash
> cd plugin/node_modules
> ln -sfn "<DSH>/node_modules/@deepseek-ai" @deepseek-ai
> ln -sfn "<DSH>/node_modules/zod" zod
> ```
>
> 联接必须指向**同一份** cordis/typert-protocol 实例（Service.init 符号、instanceof 判定
> 都依赖同一模块实例）。

## 关键约定

- **审批/提问瀑布（§5.5）fail-open**：`ctx.on("approval/request", …, {prepend:true})`，
  仅「手机在线且开关开」才拦截；**超时/出错/断线必须 `return next()` 放行桌面答案器**，
  绝不 fail-closed。这是安全底线，任何改动不得破坏。
- **KAT 失败禁连**：assertKat 失败只打日志、不启动 relay——绝不带病上线。
- peerDependencies/engines 用**双段版本范围**（如 `^0.1.5-rc.3 || ^0.2.0-rc.1 || ^0.2.1-rc.0`），
  否则插件被兼容性 gate 静默禁用。
- 二维码/URI 含 secret 明文：**绝不写日志**（日志只允许 lib/pairing.mjs 的 redactUri 形式）；
  Remote 返回体里也**没有 secret 明文**——只有二维码图像。
- relayUrl 是 loopback（127.0.0.1/localhost/::1）时设置页必须打醒目警告（手机连不上）；
  判定统一走 `lib/pairing.mjs` 的 `isLoopbackRelayUrl()`/`loopbackWarning()`，别再各写一套。

## Host API 速查（实测，契约附录 A）

- `sessionController.list({}, sig)` → `{items}`（title 走 projections）；
  `prompt` 需 `{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}`；
  `cancel` → `{accepted}`；`create` 无 title 参数（create 后 rename）。
- `sessionController.projections({sessionId}, sig)` → `values.subagentCatalog`
  = `[{id, createdAt, mode:'one-shot'|'continuable', label?}]`（父会话子代理目录投影，
  冷读无激活；v1.0.5 session.subagents 的数据源）。
- `ctx.get("subagents")`（typert 服务）两方法：
  `prompt({requestId, parentSessionId, childSessionId, mode:"continuable", delivery:"queue",
  content:[{type:"text",text}]})` → `{messageId}`（one-shot 会被宿主拒）；
  `interruptByParent(parent, child, "continuable")`（三位置参数）→ `{accepted:true}`。
- `approval/request` req：`{agent, toolName, callId?, reason?, signal?}` →
  `'allowed-once'|'rejected'|'cancelled'|'unavailable'`。
- assistant 文本增量来自 `agent/assistant-stream` 的 `frame.chunk.type==='text-delta'`，
  思考增量来自 `reasoning-delta`；两者分流、分别按 sessionId 合并 125ms 冲刷（≤8 条/秒）。
- **会话域没有归档概念**（归档属 Workspace 注册表 / dsh-archive-manager）：
  sessionController.list 原生不回归档标记；v1.0.7 起插件必须按
  `workspaceRegistry.archivedSessionIds` 为 wire 摘要另补 `archived`，不是本机状态。

## v1.0.6：工作步骤 / 模式 / 权限（2026-10-23）

- **会话事件总闸**：`ctx.on('session/event', (session, event) => …)` —— 宿主每写一条会话
  日志事件就触发（`event = { type, data, time, seq }`）。桥接靠它推 `tool.call` /
  `tool.result` / `system.message` 三个新事件（契约 §5.7）。
  事件 data 形状：`tool/call = { turn, step, callId, name, arguments }`、
  `tool/result = { turn, step, message:{ toolCallId, isError?, content:[blocks] }, error? }`。
- **模式目录**：`ctx.get('agentPresets').list()` → `[{id, name?, description?}]`，
  默认 id = `agentPresets.defaultId`；创建会话传 `sc.create({ cwd, agentPreset })`。
- **权限目录**：`ctx.get('permissionPresets').catalog()` → `{ options:[{id,name,description?}],
  defaultPreset }`（跳过 `custom`）；写入某会话用 `permissionPresets.set(session, name)`，
  session 从 `sc.resolveAgent(sessionId).agent.session` 取。
- **服务缺失要降级**：`ctx.get(name)` 对不存在服务会抛；能力目录取不到就回空数组
  （客户端隐藏选择区），**不得**因此让 session.create 失败。

## v1.0.7：真实归档 / 模型 / 思考（2026-10-24）

- **归档**：每次 session.list 现读 `workspaceRegistry.archivedSessionIds` 给 wire 摘要补 archived；
  archive/unarchive 调 Host 方法并回传真实结果。订阅 `domain/changed`（workspace、table=''、put）
  广播 `session.archives` 全集，桌面端已归档的历史会话首屏就会同步。
- **模型**：`sessionController.modelCatalog()` 拍平 provider groups；create 成功后、首条 prompt 前
  `selectModel`。selectModel 失败仍回 sessionId + modelError，**不得回 error 诱发重复 create**。
- **思考**：历史 assistant content 的 reasoning 块独立成 role=reasoning 消息并排在正文前；
  live reasoning-delta 走 `assistant.reasoningDelta`。contentText 仍忽略 reasoning，工具结果不得混入。
- 回归：`node scripts/verify-steps.mjs` 目前 91 项（含首屏归档、模型失败、reasoning 分流）。

## v1.0.8：思考强度目录 + 会话中切换模型（2026-10-24）

- **强度目录**：`modelCatalog()` 的模型项 `reasoning = {efforts:[{id,name,description?}], defaultEffort?}`；
  `modelCatalogToWire()` 把 `efforts` 拍平成 `ModelOption.efforts`（**合法 reasoningEffort 取值集合**），
  模型没有 reasoning 时**不产出**该字段（客户端隐藏强度选择区）。`reasoningEffort` 仍取 `defaultEffort`。
- **会话中切换**：`session.selectModel {sessionId, model}` → `sc.selectModel({sessionId, …})`；
  成功回宿主归一化后的 `{model}`，**宿主拒绝回原文 error（不假成功）**，selection 非法回 `bad-params`。
  校验用 `parseModelSelection()`（只认 provider/model，**不从 id 反拆**）。
- **当前模型查询**：`session.model {sessionId}` → `{model | null}`。数据源是 `model/selection`
  会话事件维护的**内存态**（`#modelSelections`）；插件重启后无记录 → `null`，**不得臆造**。
- **变更广播**：`session/event` 总闸里 `event.type==='model/selection'`（data =
  `{provider, model, reasoningEffort?}`）→ 更新内存态 + 广播 `session.modelChanged`
  `{sessionId, model}`（无 reasoningEffort 时省略该字段）。桌面端与手机端切换都会触发，天然归一。
- 回归：`node scripts/verify-steps.mjs` 目前 **113 项**（新增 efforts 映射、selectModel 成功/拒绝、
  model 查询 null→追踪、modelChanged 广播）。

## v1.0.9：会话消息里的图片（2026-10-25，契约 §5.10）

宿主会话消息的 content 块里图片是**附件引用**（不是内联 base64）：

```json
{ "type": "image", "attachment": { "attachmentId": "…", "mediaType": "image/png",
                                    "bytes": 123456, "width": 800, "height": 600 } }
```

中继单帧上限 **1MiB**（且帧里是 base64 密文，明文还要 ×4/3），所以走契约的两段式：
**缩略图内联 + 大图按需拉取**。

| 位置 | 做什么 |
|---|---|
| `lib/images.mjs` | 纯加工：`imageBlocksOf` / `imageRefMeta` / `makeThumb` / `makeLarge` / `clampMaxEdge` |
| `lib/host-bridge.mjs` | `mapHistoryMessages` 给 ChatMessage 追加 `images:ImageRef[]`；`attachThumbs(messages, ctx)` 补内联缩略图；`session/event` 总闸广播 `assistant.image`；`image.fetch` 请求处理 |

- **正文不再写 "[图片]" 占位符**（图片单独渲染）。`mapHistoryMessages` 改用新的
  `messageText()`；`contentText()` **保持原样**（那是 §5.7 工具结果 `resultText` 的口径，
  工具结果里的图片没有独立渲染通道，占位符仍有用）。
- **ImageRef** = `{imageId(=宿主 attachmentId), mediaType, width, height, bytes, thumb}`；
  宿主附件引用挂在**不可枚举的 symbol** 上（`imageRefMeta`/`attachmentRefOf`），
  插件内部能读字节，**绝不进 wire JSON**。
- **缩略图**：长边 ≤480、JPEG q75，base64 **必须 ≤96KB**；超限沿阶梯降质/降尺寸，
  仍超限 → **thumb 留空只发元数据**（客户端画占位框）。PNG/GIF 统一转 JPEG
  （GIF 只取首帧）。**整页历史有总预算**（`THUMB_PAGE_BUDGET` = 512KB），
  否则一页几十张图会顶爆中继帧。
- **大图**：`image.fetch {imageId, maxEdge?}` → `{imageId, mediaType, width, height, data}`；
  `maxEdge` 缺省 1600、上限 4096；等比缩放 + JPEG q85，base64 预算 600KB
  （契约说 ≤1MiB，但 1MiB 是**密文帧**上限，明文要留 4/3 余量）；压不进去回 `error`。
- **帧预算守卫（v1.0.9 补）**：中继的 1MiB 是 **ws 单帧**上限，超了 ws 直接**断链**
  （不是丢一帧）！故回包发出去前一律过 `fitReplyBudget(value)`：
  明文 JSON 预算 `REPLY_PLAIN_MAX_BYTES` = 640KB（帧 ≈ 明文 ×4/3 ≈ 853KB < 1MiB）；
  超了先**剥缩略图**（保留 imageId/尺寸元数据），再**丢整条 images[]**，
  连文字都装不下时回 `history-too-large` error——宁可这一页失败也不能把链路顶爆。
  `image.fetch` 回包同样过这道守卫（超了回 `image-too-large`）。
- **sharp 不在插件自己的 node_modules 里**（link 安装 + 依赖不打包）：用 `createRequire`
  从 **DSH 部署目录**（`<APPDATA>/DeepSeek Harness Desktop/dsh/node_modules/sharp`）动态解析；
  解析不到就**降级**（只发元数据、thumb 留空），**绝不抛异常崩掉插件**。
  `lib/images.mjs` 的 `setSharpResolver()` 是**单测注入点**（生产不调用）。
- **附件服务**：`ctx.get("attachments")`（本地后端 dsh-attachment-local）。
  读字节优先 `readImage(ref, signal)`（返回 `{ref, data}`，带完整性校验），
  不可用时回退 `readFileSync(imageHostPath(ref))`。
- **imageId → 附件引用缓存**在 HostBridge 内存里（历史消息 + 直播图片两处登记）；
  **插件重启后为空** → `image.fetch` 回 `image-not-found`（文案提示先加载会话历史），不崩。
- **日志绝不输出 data URI / base64**（可能含敏感图）：只打 imageId、字节数、尺寸。
- 回归：`node scripts/verify-steps.mjs` 目前 **154 项**（新增 image 块识别、ImageRef 形状、
  无 "[图片]" 占位符、缩略图超限降级/整页预算、image.fetch 校验与缓存、assistant.image 广播）
  + `node scripts/verify-images.mjs` **88 项**（图片专项：元数据映射、缩略图降级阶梯、
  image.fetch 缓存命中/重启后报错、日志无 base64、**帧预算守卫**：剥缩略图 → 丢 images[] →
  overflow 回 error、预算常量关系、多图历史回包不超明文预算）。

## v1.1.1：中继进程随插件托管（2026-10-25，跨平台）

中继是这套方案的**服务端**，不该靠人手 `node relay/server.js` 起。插件启动时把**本机**中继拉起来，
插件卸载 / DSH 退出时收掉。实现见 `lib/relay-supervisor.mjs`。

- **只托管本机中继**：`relayUrl` 指向 VPS/另一台机器 → **不 spawn**（那是别人的服务）。
  判定 `isLocalHostResolved()`：loopback + 本机所有网卡地址 + **DNS 解析后的本机地址**；
  解析失败按「非本机」处理（保守）。
- **端口已被占用就不抢**：TCP connect 探测 → 不 spawn、不杀，只如实报告
  「端口 N 已有服务监听」（状态 `external:true`，看门狗据此不干预）。
  探测**同时看 127.0.0.1 与目标 host**——只探 127.0.0.1 会漏判「只绑了 LAN IP 的外部服务」。
- **只停自己起的进程**：全程按 child handle，**绝不按进程名/端口批量杀**
  （曾因此误杀 DSH 后端，见全局记忆 process-cleanup-managed-jobs-only）。
- **跨平台停止语义（实测差异）**：
  - **POSIX（Linux/macOS）**：`child.kill('SIGTERM')` 会触发子进程 signal handler → 中继优雅关闭；
  - **Windows**：`child.kill('SIGTERM')` 直接 TerminateProcess（**硬杀，不走 handler**）→
    所以停止走 **stdin 管道下 `shutdown` 命令**（中继自己 `relay.stop()`），宽限 3s 后才 SIGKILL。
    POSIX 上两者都发（命令 + 信号），中继侧停止是**幂等**的。
- **跨平台启动**：spawn 用 `process.execPath`；宿主若是 **Electron**（macOS 的 DSH 常打包成 .app）
  必须注入 `ELECTRON_RUN_AS_NODE=1`，否则会再开一个应用实例。Windows 版 DSH 后端是独立
  node.exe（`process.versions.electron` 为空），不受影响。
- **父子绑定不留孤儿**：子进程带 `DSHRC_RELAY_PARENT_WATCHDOG=1`，监听 stdin ——EOF（父进程死了）
  即优雅退出；手工 `node server.js` 不带该变量，行为完全不变。
- **unref 时机（S5）**：子进程的 stdio 管道会吊住宿主事件循环 → 启动确认后 `unref()`；
  但**必须在启动确认之后** unref（否则父进程没有 ref 句柄时 await 永不落定），
  且 `stop()` 等待退出期间要临时 `ref()` 回来。
- **改端口要换进程（S1）**：`ensure()` 比较「子进程实际监听端口」与目标端口，不同则先停旧再起新。
- **并发 ensure 去重（S3）**：in-flight 锁（复用同一个 pending promise）；
  子进程 exit 回调按**归属**判断（`this.child === child`），否则败者的回调会把胜者句柄清掉 → 孤儿。
- **崩溃后要重拉（S2）**：子进程退出时状态保持 `managed:true / running:false`，
  看门狗读**实时**状态（`shouldRestartRelay()` 纯函数，有单测）→ 15s 内重拉。
- **卸载用 dispose 而非 stop（S4）**：`dispose()` 置位「永久停用」，
  在途 ensure 完成后不会再把中继拉起来（否则插件已卸载却留下没人管的中继）。
- **配置开关**：`config.json` 的 `autoStartRelay`（默认 true）；关掉 = 完全保持旧行为。
- **入口解析（bundle 安装也要能用）**：`resolveRelayEntry()` 按 `DSHRC_RELAY_ENTRY` →
  `<plugin>/../relay/server.js`（仓库布局，link 安装时是活源码）→
  `<plugin>/vendor/relay/server.js`（**打包进插件的中继副本**）→
  `<plugin>/node_modules/dsh-remote-control-relay/server.js` 顺序找。
  **bundle 安装时包里没有 relay/** → 靠 vendor 副本兜底：插件包 `files` 含 `vendor`，
  依赖里加了 `ws`（中继唯一的依赖），`scripts/vendor-relay.mjs` 从 `relay/server.js`
  生成副本（**shebang 必须留在第一行**，插在中间直接语法错），门禁校验副本与源文件同步。
  改完 `relay/server.js` **必须**跑 `node scripts/vendor-relay.mjs` 重新生成。
- **设置页可见**：`getPairing()` / `setRelayUrl()` 的 value 带 `relayProcess`
  `{managed, running, pid, port, detail, external}`，设置页「中继进程」一行显示「插件托管 · 运行中（pid N）」。
- 回归：`node scripts/verify-relay-supervisor.mjs` **76 项**（纯函数决策 / 远端不托管 /
  autoStart=false / 找不到入口 / 端口占用不抢 / **真 relay/server.js 的看门狗与 shutdown 通道** /
  手工启动行为不变 / 改端口换进程 / 并发 ensure 只 spawn 一次 / 崩溃后重拉 /
  dispose 后不拉起 / unref 时机 / 跨平台 env 与停止语义 / 看门狗判定纯函数 /
  **bundle 形态**：vendor 副本同步 + 包内含 vendor + 依赖 ws + bundle 布局能解析到入口）。

## v1.1.x：配对入口搬进设置面板（2026-10-24）

**`/remote-pairing` 命令已删除**，配对入口改成 DSH 设置面板里的「DSH Pocket」分区
（`docs/PROTOCOL.md` 的配对 URI 格式**没变**，只是入口换了地方）。

三层结构：

| 文件 | 角色 |
|---|---|
| `index.js` | **类插件** `export default class RemoteControlService extends TypertRemoteService`（服务名 `remoteControl`）。`[Service.init]()` 里启动宿主链路（`startRemoteHost`）并把四个方法标记成 Remote 导出。 |
| `typert.host.js` | **TYPERT Host manifest**：`package` 必须等于 package.json 的 name，`face:"host"`，四个 invocation（`getPairing` / `setRelayUrl` / `rotateSecret` / `setHidden`）。 |
| `client.js` | **Web 半边**：`window.__ModuleLoader__.load({id: <包名>, factory})` → `ctx.slots.inject("settings.section", …)` 注册 `{id:"remote-control", order:40, label:()=>"DSH Pocket"}`，并 `ctx.remote.$mount(CLIENT_REMOTE)` 挂自己的 Remote 命名空间。 |

设置页长这样（用户**不需要改任何文件**）：

- 头部：中继地址 + 连接状态点（已配置=绿点 / 未配置=红点）。
- 「配对信息」卡：**中继地址是可直接编辑的输入框**（monospace，placeholder
  `ws://192.168.x.x:8788`）+「保存」按钮（保存中禁用）；下面一行小字说明「留空即取消
  中继配置」；再下面是只读的「配对频道」。
- 「手机配对二维码」卡：二维码（内联 SVG）/ 隐藏态 / 空态文案
  「填写中继地址并保存后，这里会显示手机配对二维码。」+「轮换密钥」「隐藏/显示配对」。

Remote 方法（返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`）：

- `getPairing()` → `{relayUrl, channel, hidden, qrSvg, note}`——**返回体里没有 secret 明文**，
  secret 只在二维码图像里；`hidden=true` 时不返回二维码、只给一句说明；
  未配置中继地址时回 `{ok:false,error:{code:"pairing-unavailable"}}`（文案指向设置页）。
- `setRelayUrl(url)` → 设置页直改中继地址：校验（trim；空串=清除配置；非空必须
  `ws://`/`wss://` 开头且 `new URL()` 有 host；≤512 字符；非法回 `bad-params` + 中文原因）
  → `saveConfig` 落盘 → 内存同步 → **链路热切换**（有客户端走 `relay.reload()`，没有就现场
  新建客户端+桥接）→ 回新的配对信息（按新地址重生成二维码；`hidden=true` 时不带二维码）。
  回环地址（127.0.0.1/localhost/::1）的 `note` 带**醒目警告**（手机连不上），
  判定函数 `isLoopbackRelayUrl`/`loopbackWarning` 在 `lib/pairing.mjs`（判定唯一出处）。
- `rotateSecret()` → 换 channel+secret 并落盘、旧 secret 不保留、`relay.reload()` 热更换链路；
  成功后回新的配对信息。
- `setHidden(hidden)` → 落盘 `config.json` 的 `hidden` 字段；隐藏时删掉盘上 `pairing.svg`，
  恢复时重建。

实测坑（改动前先读）：

- **Remote 返回是双层信封（2026-10-24 二维码全空事故）**：typert 网关把宿主方法的返回**再包一层**
  ——浏览器端 `remote.xxx()` 拿到的 `res.value` 才是宿主 `{ok, value|error}`。客户端拆包必须
  **拆两层**（token-stats unwrapRemote 注释原话「双层信封解包」）。单层拆包的症状极有迷惑性：
  **宿主侧全部真实生效**（轮换/隐藏/保存都落盘），但页面拿到的 value 是内层信封对象 →
  relayUrl/channel/hidden/qrSvg 全 undefined → 渲染全空、从不报错。
  `verify-settings.mjs` 会把 unwrapRemote 源码提取出来真跑四种形态（双层成功/双层业务错误/
  单层兼容/垃圾输入），改拆包逻辑必须过这组用例。
- **combo 拼接（2026-10-24 生产事故）**：DSH web 服务器把**所有** web client bundle **裸拼接**进
  同一个 combo `<script>`（dsh-client-modules `buildComboScript`，无任何作用域包裹）。client.js
  顶层一旦有 `const/let/class/function` 声明，就会与其他 bundle 的同名声明相撞——我们与
  token-stats 的 `const CLIENT_BUNDLE_ID` 相撞，`Identifier has already been declared` 炸掉整个
  combo，**别的插件**（token-stats）`import failed`，卸载我们才恢复。**client.js 必须整体包在
  IIFE 里，顶层零声明**；`verify-settings.mjs` 的 combo 双向拼接编译检查 + IIFE 开头检查是常设
  门禁，新增顶层声明会直接 FAIL。复现脚本 `scripts/repro-web-boot.mjs`（真实 loader + 真实
  dsh-client-modules）。
- **DSH 装载器 `unwrapExports` = `exports.default ?? exports`**：`default` 优先于具名 `apply`，
  所以类插件一旦存在，具名 `apply` 在 DSH 挂载路径上是死代码——两条路径共用
  `startRemoteHost(ctx, rowConfig)`，并用 `HOST_STATES`（WeakMap）做**同 ctx 幂等**，
  不会起两条中继链路。
- **每个 strict codec 都必须有 `create()` 工厂**（typert-loader 的 `requireStrictCodec`
  和客户端 remote store 都会拒收没有工厂的 codec）——没有工厂 = manifest 整个不注册 =
  所有 Remote 调用静默失败。`verify-settings.mjs` 会用**真实的 validateTypertManifest** 校验。
- **client 包的 `id` 必须等于包名**：`__ModuleLoader__.load` 的 id 同时是 HMR 样式归属
  （`data-plugin`）的键；不一致时 `removeOwnedStyles(thatId)` 会把本包的样式剥掉。
- **`settings.section` 没有 icon 字段**：外壳给所有外部分区画通用齿轮。照抄 token-stats 的
  做法：给本包的导航行打 `data-dsh-remote-control-settings-nav` 标记，CSS 里
  `>svg:first-child{display:none}` + `::before` 用 currentColor mask 画自家图标。
- **本包 CSS 标签要自己 `setAttribute("data-plugin", 包名)`**：`apply()` 是异步的，追加
  <style> 时 client-modules 的 `claimStyles(ownerId)` 扫描已经过去，不认领会被别的包收养。
- 回归：`node scripts/verify-settings.mjs`（**112 项**，含双层信封解包用例 + combo 拼接安全 +
  Host 半边真跑一遍 + setRelayUrl 校验/落盘/清除/回环警告）+ `node scripts/verify-pairing.mjs`（47 项）。
