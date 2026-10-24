# AGENTS.md — plugin/（DSH 插件，Host 侧半边）

Cordis 功能插件：把 DSH 的会话/审批/事件桥接到中继，供手机 App 遥控。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构

```
index.js              Cordis 入口 apply(ctx, config)：KAT→配置→命令注册→装配→ctx.effect 清理
lib/protocol.mjs      信封 + HKDF-SHA256 + AES-256-GCM + assertKat()（契约 §3/§7）
lib/config.mjs        %DSH_HOME%/remote-control/config.json 读写（首启生成 channel/secret）
lib/relay-client.mjs  中继 WS 客户端（退避重连/心跳/sid:seq 去重/reload 热更换）
lib/host-bridge.mjs   Host 桥接：sessionController + api-session/agent 事件 + 审批/提问瀑布
lib/pairing.mjs       /remote-pairing 命令：QR（SVG+ASCII）/rotate/hide（契约 §3.5）
lib/qr.mjs            内嵌 QR 编码器（移植 Nayuki qrcodegen，MIT；byte 模式 ECC-M v1-10）
lib/push.mjs          Push Kit REST（token 缓存 + messages:send，失败静默降级）
scripts/verify-*.mjs  dev 验证脚本（jsqr 独立解码 + 命令全路径 mock）
```

## 构建与验收

```bash
node --check index.js lib/*.mjs scripts/*.mjs          # 语法
node -e "import('./lib/protocol.mjs').then(m=>m.assertKat())"   # KAT
node scripts/verify-qr.mjs && node scripts/verify-pairing.mjs   # QR/命令回归（需 devDependencies）
node scripts/verify-steps.mjs                                # v1.0.8 步骤/模式/权限/归档/模型/思考/强度回归（无依赖，113 项）
```

安装/重载（link 安装，磁盘即运行源码）：plugin_manager `install_bundle` → 本目录。
**改代码后必须 remove_bundle + install_bundle 才生效**——set_plugin toggle 只重跑 apply，
ESM 模块缓存不会重载源码（实测踩坑）。

## 关键约定

- **审批/提问瀑布（§5.5）fail-open**：`ctx.on("approval/request", …, {prepend:true})`，
  仅「手机在线且开关开」才拦截；**超时/出错/断线必须 `return next()` 放行桌面答案器**，
  绝不 fail-closed。这是安全底线，任何改动不得破坏。
- **命令注册用 `ctx.inject(["commands"], scope => …)`**：直接 ctx.commands 在服务未就绪时
  抛错被 try/catch 吞掉，命令静默消失（实测踩坑）。注册在所有早退路径之前。
- **KAT 失败禁连**：assertKat 失败只打日志、不启动 relay——绝不带病上线。
- peerDependencies/engines 用**双段版本范围**（如 `^0.1.5-rc.3 || ^0.2.0-rc.1 || ^0.2.1-rc.0`），
  否则插件被兼容性 gate 静默禁用。
- 二维码/URI 含 secret 明文：**绝不写日志**（日志只允许 lib/pairing.mjs 的 redactUri 形式）。
- relayUrl 是 loopback（127.0.0.1/localhost）时 /remote-pairing 必须打醒目警告（手机连不上）。

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
