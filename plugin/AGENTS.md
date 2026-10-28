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
node scripts/verify-images.mjs                                         # 图片专项 + 交付物桥接 + 排队(session.queue)/宿主投递设置(busyEnter)：元数据映射/缩略图降级/image.fetch/帧预算守卫/交付物进历史/排队追踪（无依赖，153 项）
node scripts/verify-settings.mjs                                       # v1.1.x 设置页/manifest/combo/信封自检 + Host 真跑一遍（112 项）
node scripts/verify-relay-supervisor.mjs                               # v1.1.1 中继进程托管：决策/端口占用不抢/启停/看门狗/跨平台/bundle（无依赖，162 项）
node scripts/verify-crypto.mjs                                          # v1.1.3 加密层/抗重放：KAT+AAD 两模式+sid 绑定+证明 v2+纪元单调性+接线层（无依赖，45 项）
node scripts/sync-client-icon.mjs                                      # 改了 icon.svg 后同步 client.js 的图标 data-uri
```

安装/重载（link 安装，磁盘即运行源码）：plugin_manager `install_bundle` → 本目录。
**改代码后必须重载插件才生效**——只改磁盘上的文件**不会**让运行中的 DSH 换代码
（实测：touch 插件源文件后运行中的实例毫无反应；watcher 不覆盖插件的 node_modules 路径）。

| 操作 | 加载新代码？ | 依据 |
|---|---|---|
| 只改文件（不重载） | ❌ | 实测无反应；cordis loader 是裸 `import(url)` → 命中 ESM 缓存 |
| `set_plugin` 关→开（**link 安装**） | ❌ **不换模块！** | 2026-10-28 实测踩坑：toggle 走 `setPluginEnabled` → `reload()`，但 **link 安装的包模块已在 ctx 里**，reload 不 evict 它的 ESM 条目 → **跑的还是旧代码**（改了 3 小时排查：症状是插件行为完全没变） |
| `set_plugin` 关→开（**bundle 安装**） | ✅ | bundle 走 HMR reconcile，会 evict + 重新 import |
| `remove_bundle` + `install_bundle` | ✅ | **link 安装的可靠重载路径**：重新 pnpm link + 全新 import，模块必然是新的 |
| 重启 DSH 桌面端 | ✅ | 进程重启，缓存自然清空 |

> HMR 的 `evict()`：`Map.prototype.delete.call(internal.loadCache, url)` 把 ESM 缓存条目**整条**
> 删掉（Node 的 `LoadCache` 一个 URL 下有 ESM/CJS 两种 job，只删一种会残留），
> 下次 `import()` 才重新求值文件。**只改文件不重载 = 永远跑旧代码。**

> **link 安装（开发态）改完代码想生效：`remove_bundle` + `install_bundle`（spec 指向
> 本仓库 plugin/ 目录）**，别用设置页的开关。验证是否真的换了代码，最快的办法是让新代码
> 产生一个**可观测副作用**（如写一行日志），再看它出没出现——别靠「我明明改了文件」判断。
> 也可以用网关 RPC 自己调（不需要 UI）：
> `POST /api/pluginManager/removeBundle` + `/api/pluginManager/installBundle`
> （`args: {name}` / `{spec}`，需要 `/connect?token=…` 换来的会话 cookie）。

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
  + `node scripts/verify-images.mjs` **100 项**（图片专项：元数据映射、缩略图降级阶梯、
  image.fetch 缓存命中/重启后报错、日志无 base64、**帧预算守卫**：剥缩略图 → 丢 images[] →
  overflow 回 error、预算常量关系、多图历史回包不超明文预算、
  **present 投递的文件桥接**（扩展名认类型 / 读尺寸 / 事件→assistant.image /
  image.fetch 取大图 / 非图片跳过 / 日志不泄路径 / 事件闸源码断言））。

## v1.1.0：present 投递的图片也上手机（2026-10-25，契约 §5.10.1）

**用户实测反馈**：「桌面看得到图，手机消息里没有」。根因不在 App——**宿主根本没把
present 出来的图当图片记**：

- `present` 工具（`dsh-tool-present`）投递文件时，宿主追加的是会话事件
  `deliverables/presented` = `{turn, callId, files:[{path, name?, description?}]}`，
  **只有路径**——不是 `content` 块里的 `type:"image"` 附件引用。
- 而插件的图片桥（`imageBlocksOf`）只认附件块 → 这类图**永远进不了 wire**。
  宿主另一条路（`image/offload` 事件）才是真附件块，那条路插件本来就支持。

修法（`lib/host-bridge.mjs` 的会话事件总闸 + `lib/images.mjs`）：

- 事件闸新增 `deliverables/presented` 分支 → `#emitDeliveredImages()`：
  按**扩展名**认图片（`mediaTypeOfPath`：png/jpg/jpeg/gif/webp，其余跳过）→
  读字节（上限 20MB）→ `imageMetaOf()` 量尺寸 → `makeThumb()` 压略图 →
  按 §5.10 **同一套** `assistant.image` 事件发出去（wire 形状不变）。
- `imageId` 命名空间隔离：`d` + sha1(path+turn) 前 16 位（宿主 attachmentId 是随机 uuid，
  不会撞）；同一文件同一 turn 重复 present → 同 id → 客户端幂等。
- `image.fetch` 多一条来源：`#deliveredImages` 命中就直接读盘出大图（不走附件服务）。
- **日志绝不写文件路径**（可能含敏感目录名），只打 imageId/尺寸/字节数。
- 范围：**直播**桥接（事件流）；历史消息里的交付物见 v1.1.2（§5.10.2）。
- 回归：`node scripts/verify-images.mjs` **151 项**（v1.1.0 新增 12 项 + v1.1.2 新增 39 项）。

## v1.1.2：排队（session.queue）+ 交付物图片进历史（2026-10-25，契约 §5.10.2 / §5.1）

两个用户实测反馈驱动：

1. **交付物一闪而过然后消失**——直播时图片挂到「正在流式的 assistant 消息」上，
   turn 结束刷新历史时那条消息被**宿主持久副本替换**（副本里没有交付物图）→ 图没了。
2. **agent 工作时手机上发消息的表现与桌面不一致，且不显示排队**。

### 交付物图片进历史（§5.10.2）

- 插件内存态 `#deliveredEntries`（sessionId → 交付图条目：seq/ts/imageId/媒体类型/尺寸/路径）
  + `#deliveredThumbs`（imageId → 已压好的缩略图，缓存上限 64 条）。
  `seq` 用**宿主事件的 seq**（排序稳定、不与消息 seq 撞），`ts` 用事件时间。
- `session.history` 的两条回包路径（正常页 / 空会话页）都追加这些交付物图：
  **独立**的 ChatMessage（`id:'d'+imageId`、`role:'assistant'`、`text:''`、
  `images:[{…,source:'deliverable',thumb}]`）。缩略图真的内联（读盘 → `makeThumb`），
  读不到就 thumb 留空只发元数据；整页缩略图受 `THUMB_PAGE_BUDGET` 约束（超了只丢缩略图，
  **消息本身保留**）。**没有绕过**既有的 `fitReplyBudget` 帧预算守卫。
- 交付物来源的 ImageRef 带 `source:'deliverable'`（附件来源**不带**该字段），
  客户端据此把它渲染成**独立图片消息**而不是挂到 assistant 气泡上。

### 排队与 steer（§5.1 / §5.2）

- **投递行为由宿主设置决定**（v1.1.2 修订，用户明确要求：「插话还是排队不应该手机上设置，
  应该跟随 DSH 的设置」）：
  - `session.prompt` **不再收客户端的 mode**（客户端传了也**忽略**，不报错、不改变行为）。
  - 插件读宿主「繁忙时的发送行为」= `ctx.get("settings").describe()` 里
    `ui-conversation` 命名空间的 `busyEnter` 字段（`user` 段优先，回落 `value` 段；
    'queue' | 'steer'，缺省 'queue'）——**与 DSH 桌面端 composer 读的是同一处**。
  - agent **忙** → 用设置值；agent **空闲** → 总是 queue（没有「繁忙」可言）。
    忙闲由 `api-session/status` 维护的 `#runningSessions` 判断。
  - 宿主拒绝插话（`session/steer-unavailable`）→ **自动退回 queue 重发**（消息不丢；
    桌面端此时是把 steer 动作置灰，手机不能把消息弄丢）。
  - 其余宿主错误**原样**回客户端（不吞）。
  - **每次都现读**设置（不缓存）：用户刚在 DSH 设置里改过，下一条手机消息就该跟随。
  - `session.capabilities` 回 `busyEnter`（**只读**，供客户端展示当前行为）。
- 待执行消息追踪：会话事件总闸新增两个分支——
  `agent/inbox/spliced`（`data.target` ∈ {`next-step`,`next-turn`}，
  `data.inserted` 里每条取 id / `source.rpcId` / text 块文本；**无文本的跳过**）
  → 入队；`user/message`（`data.source.kind==='user'` 且 rpcId 命中）→ 出队。
  宿主取消排队（`outcome==='canceled'`）时按目标从队首摘除。
- 每次增删后广播 `session.queue {sessionId, items:[{itemId,text,target}]}`
  （**全量快照**，空数组也发；`rpcId` 只在插件内部用于匹配，**不进 wire**）。
  每个 session 一份列表，互不串台；单会话条数上限 200。
- **新增请求 `session.queue`**（v1.1.2）：拉该会话当前待执行消息的全量快照。
  事件只在**变化时**推 → 客户端断线重连后光靠事件补不上（用户会看到「列表空的，
  桌面端明明排着一条」），故打开会话时拉一次（与事件同形状）。
- 回归：`node scripts/verify-images.mjs` **153 项**（含：宿主设置 steer/queue 的解析、
  空闲恒 queue、客户端 mode 被忽略、steer 被拒自动退回 queue、capabilities 带 busyEnter、
  `session.queue` 拉取请求、队列入队出队广播、交付物图进历史、接线层源码断言）。

## v1.1.1：中继进程随插件托管（2026-10-25，跨平台）

中继是这套方案的**服务端**，不该靠人手 `node relay/server.js` 起。插件启动时把**本机**中继拉起来，
插件卸载 / DSH 退出时收掉。实现见 `lib/relay-supervisor.mjs`。

- **只托管本机中继**：`relayUrl` 指向 VPS/另一台机器 → **不 spawn**（那是别人的服务）。
  判定 `isLocalHostResolved()`：loopback + 本机所有网卡地址 + **DNS 解析后的本机地址**；
  解析失败按「非本机」处理（保守）。
- **端口已被占用就不抢**：TCP connect 探测 → 不 spawn、不杀，只如实报告
  「端口 N 已有服务监听」（状态 `external:true` / `reason:'external'`）。
  探测**同时看 127.0.0.1 与目标 host**——只探 127.0.0.1 会漏判「只绑了 LAN IP 的外部服务」。
- **看门狗每轮都要重探端口（别信 external 标记）**：`external` **不是终态**——
  占用者随时可能消失（插件热重载就是这种竞态：新实例启动看到端口被占 → 判 external，
  随后旧实例被卸载把中继杀了）。故 `shouldRestartRelay()` 对 `reason:'external'` **返回 true**，
  让 ensure() 再探一次：空了 → 插件接管；还占着 → 继续报 external。
  状态另带 `reason`（not-configured / disabled / remote / no-entry / external / managed），
  看门狗据此决定要不要探——远端/未配置不探（省掉无谓的 DNS 查询）。
- **N1：看门狗必须认 `managed`/`reason`（别只判 running）**：丢了 `managed` 判定时，
  **「用户把插件关掉」反而会把中继拉起来**（审计实测：enabled=false 后 34s 起了 0.0.0.0 的中继）。
  故 ① `shouldRestartRelay()` 对 reason ∈ {not-configured, disabled, remote, no-entry} 一律 false；
  ② `autoStart` 必须折进 `cfg.enabled`（`enabled===true && autoStartRelay!==false`）；
  ③ 看门狗 tick 先判 `cfg.enabled !== true` 就直接返回。
- **N2：卸载必须清 `HOST_STATES`（否则二次加载托管永久失效）**：`dispose()` 是**单向闩锁**，
  而 cordis 的 `Fiber.restart()`（= DSH `set_plugin` 关→开）**复用同一个 ctx** →
  二次 `startRemoteHost(ctx)` 会拿到「已 dispose 的旧 state」→ 中继再也不起、连看门狗都没了。
  故卸载时 `HOST_STATES.delete(ctx)`，且 `startRemoteHost` 遇到 `supervisor.disposed===true`
  的旧 state 要丢弃重建。
- **世代号守卫（第三轮审计 #1）：stop 与在途 ensure 的竞态**——设置页清空中继地址走 `stop()`，
  若在途的 ensure 正在探测端口，回来后照常 spawn → 刚清空的地址下中继又被拉起（没人管的孤儿）。
  故 `stop()` 自增 `this.epoch`；`#ensureInner` 在内部 stop 之后取 `baseEpoch`，
  spawn 前发现 `this.epoch !== baseEpoch` 就放弃启动（「托管在启动前被停止，已取消本次启动」）。
- **僵尸替换（第三轮审计 #2）：活着 ≠ 在服务**——真中继的 wss `'error'` 只记日志不退出，
  进程可能「活着但端口没人听」。`this.childReady` 记录「曾确认过监听」；
  快路径探测发现 `!listening && childReady` → 判定僵尸 → stop 后重新 spawn。
  从未确认过监听（还在启动等待期）→ 不替换，只如实报 `running:false`。
- **ensure() 完全串行（第三轮审计 #3）**：`while (this.pending) await it` 之后**每次都亲自跑一遍**
  `#ensureInner`——不把「别人那一次」的结果当返回值（目标可能不同、等待期间世界可能已变）。
  已托管且一致时内层是廉价的（一次端口探测），串行化无性能问题。
- **确认监听之前不报 running（第三轮审计 #4）**：spawn 到确认之间最长 8s，
  期间状态报「正在启动中继进程（pid X，端口 Y）…」而不是「运行中」。
- **输出缓冲每个子进程一份（第三轮审计 #6）**：`start()` 里的 `output` 是局部变量
  （闭包绑定当前 child）；共用实例字段会让新进程的崩溃日志夹带旧进程的输出。
- **DNS lookup 可注入（N10 门禁用例的前提）**：`setDnsLookup(fn)` 是单测注入点
  （生产不调用），配套 2s 超时。
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
  `<plugin>/node_modules/@duke-dsh-plugins/dsh-remote-control-relay/server.js`（scoped 包，v1.1.3 起中继发布为 npm 包）顺序找。
  **bundle 安装时包里没有 relay/** → 靠 vendor 副本兜底：插件包 `files` 含 `vendor`，
  依赖里加了 `ws`（中继唯一的依赖），`scripts/vendor-relay.mjs` 从 `relay/server.js`
  生成副本（**shebang 必须留在第一行**，插在中间直接语法错），门禁校验副本与源文件同步。
  改完 `relay/server.js` **必须**跑 `node scripts/vendor-relay.mjs` 重新生成。
- **设置页可见**：`getPairing()` / `setRelayUrl()` 的 value 带 `relayProcess`
  `{managed, running, pid, port, detail, external}`，设置页「中继进程」一行显示「插件托管 · 运行中（pid N）」。
- 回归：`node scripts/verify-relay-supervisor.mjs` **162 项**（纯函数决策 / 远端不托管 /
  autoStart=false / 找不到入口 / 端口占用不抢 / **真 relay/server.js 的看门狗与 shutdown 通道** /
  手工启动行为不变 / 改端口换进程 / 崩溃后重拉 / dispose 后不拉起 / unref 时机 /
  跨平台 env 与停止语义 / 看门狗判定纯函数 /
  **bundle 形态**：vendor 副本同步 + 包内含 vendor + 依赖 ws + bundle 布局能解析到入口 /
  **回归 N1–N8**（禁用插件不拉中继 / dispose 后重载可恢复 / 崩溃输出进日志 / IPv6 探测 /
  从未确认监听不谎报也不误换 / 外部占用者消失后接管）/
  **第三轮回归**（stop×ensure 竞态不留孤儿 / 僵尸进程被替换 / N8 三路并发 /
  ready 后崩溃的日志 / 启动期失败的日志 / N7 spawn 失败清句柄 / N10 DNS 超时 /
  isChildAlive 认 signalCode / superseded 不刷 warn）/
  **接线层覆盖**（`shouldTickWatchdog` 纯函数 + index.js 源码级断言：dispose 与
  HOST_STATES.delete 相邻、tick 首条语句即判定、external/reason 透传）/
  **结构断言**（unref 只出现在确认后 / stop 里临时 ref / 「未确认监听」日志在早退前 /
  世代号守卫夹在探测与 start 之间））。

> **这个门禁必须用变异测试自检，且结论以实测为准**：
> 第二轮审计发现 6 处「改坏实现，71 项照样全绿」；第三轮审计 35 个变异只杀死 18（存活率 49%），
> 其中「13 个变异点全部杀死」的自述被实测打脸（3 处实际存活，另发现 bundle 用例被共享
> TEMP 残留打红的假失败）。现补强后对存活点复验：14 个目标变异 + 2 个真版本变异
> **全部被门禁杀死**（2 个「存活」经查是变异写法无效——没真的移动代码/删错处）。
> 新增关键实现点时，请顺手写一条「改坏它就会红」的用例（或自己跑一遍变异）——
> **项数多 ≠ 门禁强，变异存活率才是里子；「全部杀死」要说得出变异脚本在哪**。

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

## v1.1.3：抗重放的会话纪元 + 中继令牌/TLS（2026-10-26，契约 §3.4.1 / §3.4.2）

- **握手证明 v2**：传输层 hello 带 `e`(纪元)/`ts`/`pv=2`/`sid`，`sig` = 
  `base64url(HMAC-SHA256(key, UTF8("hello2|"+role+"|"+channel+"|"+e+"|"+ts+"|"+pv+"|"+sid)))`
  （旧的 `hello|role|channel` 保留）。**中继是哑管道**：它在 `welcome.peer` /
  `peer-joined.peer` 里**逐字复制**对端证明（无密钥，不校验）。
- **纪元（epoch）**：自己每条新连接 +1 且**先落盘再使用**；接收方持久化「已接受的对端最高
  纪元 + 钉扎的 sid」——对端 `e <= 已接受值` → **拒绝连接**（回退 = 疑似重放）；
  同一份证明重复（welcome 与 peer-joined 都带）→ 幂等接受不更新。
- **sid 钉扎**：加固模式下收到的帧 `frame.sid` 与钉扎值不符 → **丢弃**（跨会话重放）。
- **AAD 两模式**：兼容 `dshrc|role|seq`；加固 `dshrc|role|seq|sid`（发送方自己的 sid）。
  模式由「双方 pv≥2」决定，**必须一致** → 发送方**收到 welcome 之后**才发业务帧。
- **中继令牌（`RELAY_TOKEN`）进设置页**：契约 §3.5 的 `t=` 参数早就通了，缺的是**入口**——
  新增 `setRelayToken(token)` Remote 方法 + 设置页输入框。令牌会出现在 transport hello 里
  （明文可读）→ **设置页不回显明文**，只回 `relayTokenSet`（是否已设置）；留空保存 = 清除。
  改令牌必须**重连链路**（transport hello 变了）。
- **中继 TLS**：中继认 `RELAY_TLS_CERT` / `RELAY_TLS_KEY`（PEM 文件路径）→ 提供 `wss://`；
  配了一半/文件读不到 → **启动即失败**（绝不静默降级成明文）。TLS 是抗重放最彻底的防线
  （服务端身份认证 → 中继无法冒充对端），纪元是纵深防御。

## v1.1.4：手机端体验对齐 PC（2026-10-28，契约 v1.1.4）

用户实测反馈驱动的三处修复（**都是 Host 侧取数口径**，wire 形状除移除 `system.message` 外不变）：

### ① `session.model` 改读宿主的 `modelSelection` 持久投影

- **旧口径（v1.0.8，错的）**：只认 `model/selection` 事件维护的**内存态** `#modelSelections`
  → 插件重启后内存是空的 → 从没切换过模型的会话永远回 `null`
  → 手机端回退显示**目录默认模型** → 「手机上一直是显示的默认模型」。
- **新口径**：读 `sc.projections({sessionId}, signal)` → `values.modelSelection` = wire 视图
  `{lastUsed, next}`（`next = pending ?? lastUsed`），取 `next ?? lastUsed`。
  这与 **DSH 桌面端 composer 读的是同一份**
  （`session.projections.faceOf("modelSelection").getSnapshot()` → `next ?? lastUsed`）。
- 投影读不到/抛错 → 退回内存态（保留旧行为兜底），两者皆空才回 `null`（**不得臆造**）。
- 宿主投影定义在 `dsh-api-session-controller` 的 `modelSelectionProjection`：
  state `{lastUsed, pending}` → wire view `{lastUsed, next}`。

### ② 移除 `system.message` 桥接

- 宿主 `system/message` / `developer/message` 是**系统提示词组装记录 / 工具注册表变更**，
  **DSH 桌面端聊天视图从不展示**；手机端曾把它们渲染成大段「系统消息」，
  与 PC 插件会话的轨迹不一致。
- 改动：`host-bridge.mjs` 删掉 `mapSystemMessageEvent()` 与 `session/event` 总闸里的
  `system/message`/`developer/message` 分支；`app/model/protocol.ets` 删 `TOPIC_SYSTEM_MESSAGE`
  与 payload 的 `kind?`；`app/model/sessionstore.ets` 删对应 case 与 `appendSystem()`。

### ③ `session.create` 的工作区归组

- **旧口径**：手机端只传 `cwd` → 宿主 `sc.create` **不会** attach 到任何工作区
  → PC 端显示「未分组」。PC 在工作区里新建走的是
  `createInWorkspace → createNamed({workspaceId})`（`dsh-client-ui-workspace`）。
- **新口径**：插件在 create 前用 `workspaceRegistry.resolveByPath(cwd)` 反查——
  该目录若已注册为工作区 → 改传 `workspaceId`（宿主用 workspace.path 作 cwd 并
  `attachSession`，会话自动归组）；未命中（普通目录）→ 保持传 `cwd`
  （与 PC 在任意目录新建一样 = 未分组）。
- `resolveByPath` **不创建**工作区、不改注册表；目录不存在会 reject → 兜底回 `cwd`。
  任何异常都**不得**让 `session.create` 失败（归组是增强，不是必需）。
- wire 形状不变（客户端仍只传 `cwd`），归组是插件内部行为。
- **默认目录**：`cwd` 缺省/空串不再交给宿主回退到 `process.cwd()`；插件先解析为
  Host 用户主目录下的 `~/.dsh/remote` 并 recursive mkdir，再对解析后的路径走上述
  `resolveByPath` 归组。目录创建失败直接回错，不静默回退；不自动注册工作区。
- **注意**：宿主**没有**「把已有会话挂进工作区」的 API（`insertSessionBefore` 只能重排已有成员），
  按 cwd 自动归账只在注册表**首次初始化**跑一次 → **历史未分组会话无法自动归组**。

### 回归

`node scripts/verify-steps.mjs` **165 项**（新增场景 8b 投影路径 5 项 + 场景 2b 归组 4 项 + 2 项）。
