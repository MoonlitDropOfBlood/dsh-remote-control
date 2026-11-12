# dsh-remote-control：手机（HarmonyOS）远程控制 DSH —— 架构与协议契约

> 状态：v1 契约（2026-10-20 由 Lead 冻结；**v1.0.6 于 2026-10-23 增补：会话时间线（工具步骤）
> 与新建会话的「模式/权限」选择；v1.0.7 于 2026-10-24 增补：Workspace 真实归档同步
> 与新建会话的模型选择；v1.0.8 于 2026-10-24 增补：模型思考强度目录与会话中切换模型；
> v1.0.9 于 2026-10-25 增补：会话消息里的图片（§5.10，缩略图内联 + 大图按需拉取）；
> v1.1.0 于 2026-10-25 增补：§5.10.1 图片的第二来源——present 投递的文件（deliverables/presented）；
> **v1.1.1 于 2026-10-25 增补：§5.10.2 交付物图片进历史（不再「一闪而过」）、
> §5.2 新事件 `session.queue`（待执行消息/排队显示）**。
> **v1.1.2 于 2026-10-25 修订**：投递行为（排队/插话）**由宿主设置决定**——
> `session.prompt` **不再收客户端的 mode**（传了也忽略），插件读宿主「繁忙时的发送行为」
> （`ui-conversation.busyEnter`）；`session.capabilities` 增 `busyEnter`（只读）；
> 新增请求 `session.queue`（拉取队列快照，断线重连后补状态）。
> **v1.1.3 于 2026-10-26 增补：抗重放的「会话纪元」**——传输层 hello 增 `e`(纪元)/`ts`/`pv`/`sid`
> 且 HMAC 覆盖它们（`hello2|…` 串）；中继在 welcome/peer-joined 里**原样透传**对端证明；
> 接收方**持久化**对端最高纪元（纪元回退 = 拒绝连接）+ **钉扎**对端 sid（跨会话重放直接丢弃）；
> 双方 pv≥2 时业务帧 AAD 升级为 `dshrc|role|seq|sid`（v1.1.2 及以前是 `dshrc|role|seq`）。
> 另：中继支持原生 TLS（`RELAY_TLS_CERT`/`RELAY_TLS_KEY` → 直接提供 `wss://`）。
> **v1.1.4 于 2026-10-28 修订（手机端体验对齐 PC）**：
> ① `session.model` 的**数据源改为宿主的 `modelSelection` 持久投影**
> （`sessionController.projections` 的 `values.modelSelection`，视图 `{lastUsed, next}`，
> `next = pending ?? lastUsed`）——与 DSH 桌面端 composer 显示的是**同一份**
> （`selection = projected.next ?? catalog.default`）。旧实现只认 `model/selection`
> 直播事件的内存态 → 从没显式切换过模型的会话永远回 `null`，手机端就一直显示
> 目录默认模型（与 PC 对不上）。投影不可用时退回内存态；两者皆空才回 `null`。
> ② **移除 `system.message` 事件**（§5.2）——宿主 `system/message` / `developer/message`
> 是**系统提示词组装记录 / 工具注册表变更**，不是对话内容，DSH 桌面端聊天视图
> 从不展示；手机端曾把它们显示成大段「系统消息」，与 PC 轨迹不一致。
> ③ **`session.create` 的工作区归组**：手机端只传 `cwd`，插件先用
> `workspaceRegistry.resolveByPath(cwd)` 反查——该目录若已注册为工作区，改传
> `workspaceId`（宿主 `sc.create` 会用 workspace.path 作 cwd 并 `attachSession`，
> 会话自动挂到工作区下面，与 PC 端「在工作区里新建」一致）；未命中/异常保持传
> `cwd`（与 PC 在普通目录新建一样 = 未分组）。wire 协议不变（仍只收 `cwd`），
> 归组是插件内部行为，**失败绝不阻断创建**。
> **v1.1.6 于 2026-10-28 修订（直播保序 + 默认目录）**：
> ① `session.create` 的 `cwd` 缺省/空串不再落到 DSH 后端 `process.cwd()`——插件解析为
> Host 用户主目录下的 `~/.dsh/remote`，创建前递归建目录（失败回错，不静默回退）；
> 解析后的路径仍按 v1.1.4 ③ 的规则归组，**不自动注册工作区**；显式 `cwd` 行为不变。
> ② **直播事件保序（§5.2 末注）**：正文/思考增量共用一条按 session 保序的合并队列；
> `turn.end` 在全部待发增量之后发出；`tool.call` / `tool.result` / `assistant.image`
> 不越过未冲刷的文本/思考增量（客户端按到达顺序渲染，依赖该保证）。
> **v1.1.7 于 2026-10-30 修订（会话权限切换 + 收发保序闭环）**：
> ① 新增 `session.permission` / `session.selectPermission` 请求与
> `session.permissionChanged` 事件（§5.1/§5.2/§5.8）；当前权限与桌面端同读
> `permissions.currentValue` 持久投影，catalog 仍沿用 `session.capabilities.permissions`；
> ② §4 明确发送端按 seq 串行加密+发送、接收端按 WS 到达顺序串行解密+分发，
> 重连/停止后旧连接代次的异步回调不得再发送/分发，补齐直播保序的收发闭环。
> **v1.2.0 于 2026-11-06 增补：用户提示词的附件（§5.11）**——
> 手机端输入框支持图片/文件附件，与 DSH 桌面端 composer 同能力：
> ① 新增 `attachment.upload.begin/chunk/commit/abort` 四个请求，**分块上传**
> （明文块 256KiB，密文帧 ≈ 460KB < 中继 1MiB 上限），由插件落盘到宿主附件服务；
> ② `session.prompt` 新增可选 `uploads:[uploadId]`（保持正文 `text` 不变），
> 插件把已提交附件转成宿主 receipt 后随正文一起 `prompt`（附件可单独发送、无正文）；
> ③ `session.capabilities` 新增只读 `attachments` 目录（支持标记/上限/块大小），
> 旧插件无该字段 → 客户端隐藏附件入口；④ `ChatMessage` 新增可选 `files:FileRef[]`
> （用户消息里的文件），**正文不再为 file 块写 `[文件]` 占位符**（与 v1.0.9 图片同口径）。
> **中继/加密/帧格式不变**（附件走普通业务帧）；附件只对**根会话**开放（subagent 不支持）。
> **v1.3.0 于 2026-11-12 增补：排队权威对账 + 双端提问同步 + Todo + Goal**——
> ① `session.queue` 改读 Host `inbox` 持久投影，排队消息以 Host `itemId` 为准，`rpcId`
> 只作旧宿主回退；修复子代理注入消息（无 `rpcId`）消费后仍残留。
> ② `question.request` / `question.resolved` 不再是一次性内存事件：新增
> `pending.interactions` 快照与稳定 `callId`/`expiresAt`；启用 Host `userQuestions`
> timed 模式时，`open` 可答、超时变 `continued` 仍可补答，任意一端回答后另一端同步关闭。
> 插件只把 Host 投影作为权威，不伪造用户消息；`approvalTimeoutMs` 不得删除仍可回答的问题。
> ③ 新增 `session.todos` / `session.todosChanged`，手机只读展示 Host `todos` 投影。
> ④ 新增 `session.goal` / `session.goalAction` 与 `session.goalChanged` /
> `session.goalActivationChanged`，手机展示并可执行新建/编辑/暂停/恢复/完成/清除；
> 所有变更携带 `{id,revision}` 做 Host CAS，禁止手机覆盖桌面刚做的变更。
> 三个实现（DSH 插件 / 中继服务器 / HarmonyOS App）
> 都必须以本文档为准；任何协议改动必须先改本文档并通知 Lead。

## 1. 目标与范围（用户已确认）

- **会话遥控核心**：会话列表、新建/切换会话、发送提示词、流式查看回复、取消任务。
- **审批 / 提问应答**：agent 请求审批（bash、写文件等）或向用户提问时，手机上弹出并点允许/拒绝/回答。
- **推送通知**：需要审批 / 提问 / 任务完成时，通过华为 Push Kit 推送到手机（AGC 配置缺失时优雅降级）。
- **连接方式：公网可达**。手机在户外（非同一局域网）也能控制家/办公室 PC 上的 DSH。
- **交付**：完整 DevEco ArkTS 工程（用户自行编译装机）+ 可安装的 DSH 插件 + 可部署的中继服务器。

不在 v1 范围：文件浏览、终端遥控、屏幕镜像、多主机管理。

## 2. 总体架构

```
┌──────────────────────────┐         ┌─────────────────────────┐        ┌──────────────────────┐
│ DSH 插件 (Host, PC)      │  WSS    │ 中继服务器 (公网 VPS)    │  WSS   │ HarmonyOS App (手机) │
│ dsh-remote-control       │────────▶│ dsh-remote-control-relay │◀───────│ dsh-remote-control-  │
│ （WS 客户端，出站连接）   │  client │ （只转发密文帧，无业务）  │ client │ app                  │
└──────────────────────────┘         └─────────────────────────┘        └──────────────────────┘
        │  桥接 DSH Host 服务                                              ArkTS UI
        │  sessionController / agents / events
        │  approval/request、user-questions/request 瀑布
        └─ Push Kit REST ──────────────────────────────────────────────── ▲ 推送（旁路，唤醒用）
```

**关键决策：两端都以 WebSocket 客户端身份出站连接中继**，因此无需端口映射/内网穿透即可公网可达。
中继只转发 **AES-256-GCM 密文**（端到端加密），中继被攻破也读不到会话内容。
将来若要局域网直连，只需让插件/手机指向另一地址，协议不变。

## 3. 配对与密钥（Pairing）

1. DSH 插件首次启用时生成并持久化（插件自己的 config.json）：
   - `channel`：16 位随机串，**RFC 4648 base32 字母表（`^[A-Z2-7]{16,64}$`，与 §4 校验一致；不是 Crockford）**，
     中继路由用。示例（仅演示格式）：`KMNPQRTVWXY23456`。
   - `secret`：≥32 字符随机串（base64url 24 字节），E2E 密钥材料，**不发给中继**。
2. 用户在手机端「配对」页输入：`relayUrl`（如 `wss://relay.example.com/ws`）、`channel`、`secret`。
   （推荐**扫码配对**：见 §3.5；手动输入保留为兜底。）
3. **E2E 密钥派生**（两端必须一致，见 §7 测试向量）：

```
key = HKDF-SHA256(
  ikm  = UTF8(secret),
  salt = UTF8("dsh-remote-control/v1"),
  info = UTF8("e2e|" + channel),
  L    = 32)
```

4. 轻量握手证明（防滥用，中继可选校验）：`hello` 帧携带
   `sig = base64url(HMAC-SHA256(key, UTF8("hello|" + role + "|" + channel)))`，role ∈ {host, client}。

### 3.4.1 握手证明 v2：会话纪元（v1.1.3，抗重放）

v1.1.2 及以前的传输层 `sig`（`hello|role|channel`）**只被携带、不被对端校验**（中继无密钥），
于是「恶意/被攻陷的中继」可以把**旧会话录下的密文帧**重放进新会话（跨进程重启后去重表为空，
旧帧会被当成新帧执行）。v1.1.3 用**会话纪元**堵这个窗口。

**v2 证明串**（`hello` 帧的 `sig` 字段，取代 v1 的格式）：

```
sig = base64url(HMAC-SHA256(key, UTF8("hello2|" + role + "|" + channel + "|" + e + "|" + ts + "|" + pv + "|" + sid)))
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `e` | int | **会话纪元**：发送方自己的纪元号，**跨进程重启单调递增**（每开一条新连接 +1），**必须持久化** |
| `ts` | int | 发送时刻 Unix 毫秒（**仅诊断用**：不参与安全判定——不信任时钟） |
| `pv` | int | 协议版本：v1.1.3 = **2**；v1.1.2 及以前**不带**该字段（视为 pv=1） |
| `sid` | string | 发送方的连接实例 id（8 位十六进制，与 `frame.sid` 同值） |

**模式协商**（双方各自独立判断，必须一致）：

- **加固模式**：本端 `pv ≥ 2` **且** 对端 `pv ≥ 2`。
  - 业务帧 AAD = `UTF8("dshrc|" + role + "|" + seq + "|" + sid)`（见 §7）；
  - 接收方**钉扎**对端 `sid`（来自对端证明）：收到的业务帧 `frame.sid` 与钉扎值不符 → **丢弃**；
  - 接收方**持久化**「已接受的对端最高纪元」：对端 `e ≤ 已接受值` → **拒绝连接**（纪元回退 = 疑似重放）。
- **兼容模式**：任一方 `pv < 2`（旧端）。业务帧 AAD = `UTF8("dshrc|" + role + "|" + seq)`（v1.1.2 行为）。

对端的 `pv/e/ts/sid/sig` 由中继在 `welcome` / `peer-joined` 里**原样透传**（§4）——
中继没有密钥，**只能复制不能伪造**；接收方用本端 key 验签后即可信任。
**发送方必须在收到 welcome 之后才发业务帧**（否则还不知道对端 pv → AAD 选错）。
对端在线但**还没发过** hello 证明（旧端）时，按兼容模式处理。

> 残余风险（写在明面上）：纪元与「已接受纪元」必须**持久化**才跨重启有效；
> 若某一端在纪元持久化被清空（换机/清数据）后仍信任旧纪元，仍存在一次重放窗口。
> 该窗口的根治手段是 TLS（`wss://`，服务端身份认证 → 中继无法冒充对端），
> 见 §3.4.2。

### 3.4.2 中继的 TLS（v1.1.3）

中继可选原生 TLS：设置 `RELAY_TLS_CERT`（PEM 证书链）与 `RELAY_TLS_KEY`（PEM 私钥）后
中继以 **HTTPS/WSS** 提供服务（否则是明文 HTTP/WS）。配置后插件/手机端的
`relayUrl` 必须写成 `wss://<host>:<port>`（两端都支持 `ws://` 与 `wss://`）。
TLS 提供服务端身份认证与链路机密性——它把「恶意中继」这个位置直接消灭，
是抗重放最彻底的防线（应用层的纪元是纵深防御）。

### 3.5 配对二维码（v1.0.3）

PC 端（DSH 插件）把配对信息编码成一条 URI 并渲染为二维码显示；手机端扫码后自动填参连接。

```
dshrc://pair?r=<encodeURIComponent(relayUrl)>&c=<channel>&s=<secret>[&t=<encodeURIComponent(relayToken)>]
```

- `r`：中继地址（必须 URL 编码）；`c`：channel（`^[A-Z2-7]{16,64}$`，无需编码）；
  `s`：secret（base64url，URL 安全字符集，无需编码）；`t`：中继鉴权 token，可选。
- 手机端必须同时接受**完整 URI**（含 `dshrc://pair?` 前缀）与**裸 query 串**（`r=…&c=…&s=…`）两种扫描结果；
  解析失败/字段缺失时回落手动输入并提示，不得静默丢弃。
- **安全提示**：二维码含 secret 明文（与手动口述同级信任域），只在受信任的屏幕上展示；
  PC 端展示应提供「重新生成配对信息」（换 secret，旧二维码即失效）与隐藏能力；
  二维码内容（URI/图片）不得写入日志。

## 4. 传输层：中继帧协议（明文 JSON，WebSocket text 帧）

每个 WebSocket 文本帧是一条 JSON 消息。中继只理解以下消息；业务数据全部在 `frame.data` 密文里。

| 方向 | 消息 | 字段 | 说明 |
|---|---|---|---|
| peer→relay | `hello` | `t, role("host"\|"client"), ch, sig`, v1.1.3 增 `e, ts, pv, sid` | 连接后 10s 内必须发送，否则中继断开 |
| relay→peer | `welcome` | `t, peers:{host:bool,client:bool}`, v1.1.3 增 `peer:{role,e,ts,pv,sid,sig}` | hello 校验通过后回；`peer` = 对端在线时**原样复制**的对端 hello 证明 |
| relay→peer | `peer-joined` / `peer-left` | `t, role`, v1.1.3 增 `peer:{role,e,ts,pv,sid,sig}` | 对端上线/下线；`peer-joined` 带新上线方的证明 |
| peer→relay | `frame` | `t, sid, seq(number), data(base64 ciphertext)`, 可选 `urgent`(bool) | 转发给对端；`sid` 见下方 v1.0.2 |
| relay→peer | `frame` | `t, from("host"\|"client"), sid, seq, data` | 原样转发 |
| 双向 | `ping` / `pong` | `t` | 应用层心跳，30s 无帧即发；90s 无任何消息判死 |
| relay→peer | `error` | `t, code, message` | `bad-hello` / `rate-limited` / `channel-full` / `replaced`（同 role 新连接顶替旧连接时发给旧端） |

规则：
- `ch` 必须匹配 `^[A-Z2-7]{16,64}$`；同一 channel 同一 role 只允许一个活跃连接（新连接顶掉旧连接）。
- **离线缓存**：对端不在线时，中继缓存发往该端的 `frame`，上限 256 条 / 24h（FIFO 丢旧），重连后按 seq 顺序补发。
  `urgent` 标记的帧（审批/提问）优先补发。
- seq 为发送端单调递增序号（**每条连接从 1 开始**），用于去重与排序。
- **v1.1.7 发送保序**：同一连接的发送端必须只有一条顺序发送链，严格按 seq 递增顺序完成
  **加密并调用 WebSocket send**；后一 seq 的异步加密即使先完成，也不得越过前一 seq 先发送。
- **v1.1.7 接收保序**：接收端必须按 **WebSocket 实际到达顺序**串行完成每帧的
  **解密 + 业务分发**，前一帧分发完成后才处理下一帧；不得并行解密后按 Promise 完成先后分发，
  也不得用「按 seq 重排」替代 WS 到达顺序。`sid:seq` 仍按本节约束用于去重。
- **v1.1.7 连接代次失效**：重连或停止立即使旧连接代次失效；旧代次已经在途的加密、解密、
  定时器及其他异步回调，即使稍后完成，也不得再向 WebSocket 发送或向业务层分发。
  新连接使用新的发送/接收链，不继续执行旧代次队列。
- **v1.1.3：中继是哑管道**——它**不验证** `sig`（没有密钥），只**原样复制**对端 hello 证明到
  `welcome.peer` / `peer-joined.peer`。复制时**字段必须逐字透传**（不重排、不补默认值、
  不校验数值），否则对端验签失败。`peer-joined` 在该 role **真正新上线**时发；
  **顶替场景（v1.1.3 修订）也必须发**——加固模式下对端钉扎了对端的 sid/纪元，
  顶替换了新连接（sid 与纪元都变）→ 对端必须重新钉扎，否则新帧全被丢弃、链路死到重连为止。
  （v1.1.2 顶替不对端有影响：那时 sid 只用于去重分桶。）
  **v1.0.2 去重键修正**：`sid` 是发送端实例 id（每条 WebSocket 连接生成一次，8 位十六进制随机，随每帧携带）；
  接收端去重键为 `sid + ":" + seq`（不是裸 seq——否则新客户端的 seq=1 会被误判为旧客户端的重复帧）。
  `seen` 表按 sid 分桶，单 sid 超过 4096 项或总 sid 数超过 64 时淘汰最旧。缺 `sid` 的帧按 `"legacy":seq` 处理。
  relay→peer 转发的 `frame` 除上述字段外可保留 `urgent` 原值，接收端忽略即可。
- 中继自身鉴权：部署时配置 `RELAY_TOKEN`（可选）；配置后 `hello` 需带 `token` 字段。中继对 IP 限速
  （每 IP 每分钟 ≤60 个 hello），对滥用直接断开。

## 5. 业务层：E2E 明文消息 schema

密文解密后是一条 JSON：

```json
{ "id": "uuid-v4", "type": "session.list", "ts": 1760000000000, "payload": {} }
```

- `id`：请求-响应关联 id。响应统一用 `type:"result"`，`payload:{ id, ok:true, value }` 或
  `payload:{ id, ok:false, error:{ code, message } }`。
- `type:"event"`：服务器主动推送，`payload:{ topic, data }`，无 `id` 关联。

### 5.1 client → host 请求

| type | payload | 响应 value | 说明 |
|---|---|---|---|
| `hello` | `{proto:1, clientName, appVersion, pushToken?, features?, sig}` | `{hostName, dshVersion, pluginVersion}` | 连接/重连后首条；`sig` 见 §3.4。**v1.3.0** 可带可选 `features:string[]`；当前定义 `"session-state-v1"`（支持 pending.interactions、Todo、Goal 与 continued 状态重发）。旧插件忽略该字段；旧 App 不带该字段，插件按旧事件语义处理 |
| `session.list` | `{}` | `{sessions:[SessionSummary]}` | SessionSummary 见 §5.3；**v1.0.7** 每项可带 `archived`，由插件根据 Workspace 注册表拼装，不需要 `includeArchived` 参数 |
| `session.history` | `{sessionId, beforeSeq?:number, maxMessages?:number}` | `{messages:[ChatMessage], steps:[StepRecord], hasMore, oldestSeq}` | **v1.0.4** 向后翻页的历史消息；`beforeSeq` 缺省取最新一页。ChatMessage：`{id, role:"user"\|"assistant"\|"reasoning", text, ts, seq}`（`reasoning` 为 **v1.0.7** 新增；见 §5.3）。subagent 会话自动走 durable subagent 地址。**v1.0.6**：新增 `steps`（工具步骤，§5.7）——旧插件不返该字段时客户端只显示消息 |
| `session.subagents` | `{sessionId}` | `{subagents:[SubagentInfo]}` | **v1.0.5** 父会话的直接子代理目录（父会话 `subagentCatalog` 投影 + 运行态）。SubagentInfo 见 §5.6 |
| `session.subagentPrompt` | `{parentSessionId, childSessionId, text}` | `{accepted:bool}` | **v1.0.5** 向 **continuable** 子代理发消息（delivery:'queue'）；one-shot 子代理返回 `unsupported` 错误。回复走同一事件流（sessionId=child） |
| `session.subagentCancel` | `{parentSessionId, childSessionId}` | `{accepted:bool}` | **v1.0.5** 取消 continuable 子代理当前 turn（interruptByParent；accepted=信号已受理，非已停止） |
| `session.create` | `{title?, cwd?, agentPreset?, permission?, model?}` | `{sessionId, agentPreset?, model?, modelError?}` | cwd 缺省或为空串时，插件解析为 Host 用户主目录下的 `~/.dsh/remote` 并在创建前递归确保目录存在；不再使用 DSH 后端 `process.cwd()`。该路径随后仍按 §5.1 的工作区反查规则归组，未注册则允许未分组；目录创建失败回错，不静默回退。显式 cwd 行为不变。**v1.0.6**：`agentPreset` / `permission` = 模式与权限（§5.8）。**v1.0.7**：`model:{provider,model,reasoningEffort?}` = 模型选择；Host 在创建后、首条 prompt 前 `selectModel`。会话已创建但模型设置失败时仍回成功并带 `modelError`，客户端不得重复创建 |
| `session.capabilities` | `{}` | `{presets:[ModeOption], permissions:[PermissionOption], defaultPreset?, defaultPermission?, models:[ModelOption], defaultModelId?, archiveSupported:bool, busyEnter:'queue'\|'steer', attachments?:{...}, todos?:{supported:bool}, goal?:{read:bool, actions:GoalAction[]}, pendingInteractions?:{questions:bool, approvals:bool, hostContinued:bool}}` | **v1.3.0** 增补 `todos` / `goal` / `pendingInteractions`（字段缺省 = 旧宿主不支持；客户端隐藏对应入口，新请求报 `bad-type` 时静默降级，不得弹错误）。**v1.0.6** 模式与权限目录。**v1.0.7** 增加模型目录与真实归档能力标记（§5.8/§5.9）。**v1.0.8** `ModelOption.efforts` 暴露该模型可选思考强度（§5.8）；宿主未提供对应能力时 models 为空 / archiveSupported=false，客户端隐藏对应选择区，不得报错。**v1.1.2** 增补 `busyEnter`：宿主「繁忙时的发送行为」——**只读**（客户端不得提供切换），宿主读不到时按 'queue'。**v1.2.0** 增补 `attachments`（§5.11）：宿主不支持附件时**缺省该字段**（客户端隐藏附件入口） |
| `session.archive` | `{sessionId, stopActivity?:bool}` | `{sessionId, archived:true}` | **v1.0.7** 写入 Workspace 真实归档集合；`stopActivity=true` 时按 Host 语义停止运行活动，缺省为 false |
| `session.unarchive` | `{sessionId}` | `{sessionId, archived:false}` | **v1.0.7** 从 Workspace 归档集合恢复；幂等 |
| `session.selectModel` | `{sessionId, model:ModelSelection}` | `{model:ModelSelection}` | **v1.0.8** 对**已存在会话**切换模型/思考强度；插件调 `sessionController.selectModel({sessionId,…})`。Host 拒绝时回 `error`（原文带出），成功回归一化后的 selection，并视为一次 `model/selection`（同样触发 `session.modelChanged`） |
| `session.model` | `{sessionId}` | `{model:ModelSelection\|null}` | **v1.0.8** 查询会话当前模型/思考强度。**v1.1.4 改数据源**：优先读宿主 `modelSelection` **持久投影**（`sessionController.projections` 的 `values.modelSelection`，视图 `{lastUsed, next}`，`next = pending ?? lastUsed`）——与桌面端 composer 同源（`selection = projected.next ?? catalog.default`）；投影不可用才退回 `model/selection` 直播事件维护的内存态；两者皆空回 `null`（客户端回退展示目录默认，与 PC 的 `catalog.default` 回退一致），**不得臆造** |
| `session.selectPermission` | `{sessionId, permission:string}` | `{permission:string}` | **v1.1.7** 对已存在会话切换权限档位；Host 取 live Session 后调 `permissionPresets.set(session, permission)`，成功回读并返回有效当前值。宿主拒绝（未知 preset、Auto 准入、会话不可解析等）按原错误码/原文回 `error`，不得假成功。**App 只在根会话详情页提供此动作；Host 不额外禁止 subagent select** |
| `session.permission` | `{sessionId}` | `{permission:string\|null}` | **v1.1.7** 查询会话有效当前权限。优先读 `sessionController.projections` 的 `values.permissions.currentValue`（与桌面端同源；可能是派生态 `custom`），不可用时依次退回 live `permissionPresets.current(session)` 与直播内存态，皆无则回 `null`。subagent 查询为只读冷读，不得为查询激活 Agent |
| `session.prompt` | `{sessionId, text, uploads?:string[]}` | `{accepted:bool, mode:'queue'\|'steer'}` | 立即返回；实际回复走事件流。**v1.1.2 起投递行为由宿主设置决定**：客户端**不传** mode（传了也**忽略**）。插件读宿主「繁忙时的发送行为」（`ui-conversation.busyEnter`：排队发送/插话发送），agent 忙时按设置投递、空闲时总是 queue；宿主拒绝插话时插件**自动退回 queue**（消息不丢）。回包的 `mode` 是**实际**使用的投递行为。**v1.2.0**：`uploads` = 已 `attachment.upload.commit` 的 uploadId 列表（§5.11）；`text` 与 `uploads` 至少一项非空（附件可单独发送）；附件顺序与列表一致 |
| `attachment.upload.begin` | `{sessionId, kind:'image'\|'file', name?:string, mediaType?:string, bytes:number}` | `{uploadId, chunkBytes}` | **v1.2.0** 开启一次附件上传（§5.11）。`bytes` = 附件原始字节数；`kind:'image'` 时 `mediaType` 必须是 `image/png\|jpeg\|webp\|gif`，`kind:'file'` 时 `name` 必填。超上限回 `attachment-too-large` / `attachment-too-many` |
| `attachment.upload.chunk` | `{uploadId, index:number, data:string}` | `{received:number}` | **v1.2.0** 上传一个分块：`index` 从 0 连续递增，`data` = **标准 base64**（canonical）的明文块（≤`chunkBytes`，最后一块可短）；`received` = 截至目前累计字节数。乱序/重复/超长回 `attachment-chunk-mismatch` |
| `attachment.upload.commit` | `{uploadId}` | `{uploadId, attachment:UploadedAttachment}` | **v1.2.0** 提交：插件把累积字节写入宿主附件服务（图片归一化、文件逐字节存储）。成功后该 uploadId 只能用于一次 `session.prompt`。宿主校验失败原样回 `session/attachment-invalid`（reason 带宿主码） |
| `attachment.upload.abort` | `{uploadId}` | `{aborted:bool}` | **v1.2.0** 放弃上传并释放缓冲；幂等（未知/已提交/已过期 → `aborted:false`，不报错）。已 commit 的附件不可撤回（宿主附件不可删除） |
| `session.queue` | `{sessionId}` | `{sessionId, items:[{itemId, text, target:'next-turn'\|'next-step'}]}` | **v1.1.2** 拉取该会话**当前**待执行消息的全量快照。与 §5.2 的 `session.queue` 事件同形状：事件只在**变化时**推，客户端断线重连后必须拉一次才能补上断线期间变过的队列。**v1.3.0 权威口径**：插件必须优先读 Host `sessionController.projections` 的 `values.inbox`，从其中 `next-turn`/`next-step` 的消息重建；投影不可用才回退插件内存。出队以 Host 消息 `id`（wire 里的 `itemId`）为主键，`source.rpcId` 只作旧宿主回退——子代理初始注入可以没有 `rpcId`，不能因此永久残留 |
| `session.cancel` | `{sessionId}` | `{cancelled:bool}` | 取消当前运行的 turn |
| `session.rename` | `{sessionId, title}` | `{title}` | |
| `image.fetch` | `{imageId, maxEdge?:number}` | `{imageId, mediaType, width, height, data:"data:<mediaType>;base64,…"}` | **v1.0.9** 拉取图片大图（§5.10）：`maxEdge` 缺省 1600、上限 4096；插件等比缩放后回 data URI，单张 ≤ 1MiB（中继硬上限），失败回 `error`（不影响消息流） |
| `pending.interactions` | `{sessionId?}` | `{questions:[PendingQuestion], approvals:[PendingApproval]}` | **v1.3.0** 拉取待答快照，供回前台/重连恢复。指定 `sessionId` 时同时合并插件仍持有的待答项与该会话 Host `userQuestions` 投影的 `open/continued` 问题；未指定时只回插件仍持有的全局待答项（不做全量冷读）。**只读，绝不能阻塞瀑布**；读取失败回空数组，不影响 fail-open |
| `session.todos` | `{sessionId}` | `{sessionId, todos:[TodoItem]\|null, supported:bool}` | **v1.3.0** 读 Host `todos` 持久投影。`null` = 本回合尚无清单/已清空；`supported:false` = 宿主未提供该能力。手机只读 |
| `session.goal` | `{sessionId}` | `{sessionId, goal:GoalWire\|null, activation:'armed'\|'disarmed'\|null, supported:bool, actions:GoalAction[]}` | **v1.3.0** 读 Host `goal` 持久投影；`activation` 来自活 Agent 的服务读取或 activation 事件缓存，未知为 `null`。`null` = 当前无目标。`actions` 是宿主可执行的人类操作子集 |
| `session.goalAction` | `{sessionId, action:GoalAction, expected?:{id,revision}, objective?:string, maxGoalRounds?:number}` | `{sessionId, goal:GoalWire\|null}` | **v1.3.0** 执行人类操作。`create` 不需要 `expected`，`objective` 必填；`edit` 至少提供 `objective`/`maxGoalRounds`；`pause`/`resume`/`complete`/`clear` 必须带手机当前看到的 `expected`，由 Host 做 CAS。陈旧 revision 回 `GOAL_STALE_REVISION`，客户端必须重拉 `session.goal` 后重试，不得覆盖新状态。禁止手机触发 `block` |
| `approval.answer` | `{askId, decision:"approved"\|"rejected", note?}` | `{applied:bool}` | decision 只允许 approved/rejected |
| `question.answer` | `{askId, answers:{ [questionId]: value }, freeText?}` | `{applied:bool}` | answers 结构见 §5.4。**v1.3.0**：`askId` 命中插件待答项走原瀑布；否则若该问题在 Host 投影中为 `continued`，插件可调用 Host 官方 `userQuestions.answer()` 补答。不得伪造用户消息。`applied:false` 表示已失效或已由另一端处理，客户端随后重拉快照 |
| `push.register` | `{pushToken, platform:"harmonyos"}` | `{registered:bool}` | 手机拿到 Push Token 后上报 |
| `ping` | `{}` | `{pong:ts}` | 应用层探活（与传输层心跳独立） |

### 5.2 host → client 事件（`type:"event"`，payload.topic）

| topic | data | 触发源（Host API） |
|---|---|---|
| `session.added` | `{session:SessionSummary}` | 事件 `api-session/added` |
| `session.removed` | `{sessionId}` | 事件 `api-session/removed` |
| `session.status` | `{sessionId, running:bool}` | 事件 `api-session/status` / `agent/status` |
| `session.archives` | `{archivedSessionIds:string[]}` | **v1.0.7** Workspace `domain/changed` 后的归档全集快照；客户端据此覆盖各行 `archived`，不做增量猜测 |
| `session.modelChanged` | `{sessionId, model:ModelSelection}` | **v1.0.8** 会话模型/思考强度变化：源为 Host 会话事件 `model/selection`（桌面端切换、手机端 `session.selectModel` 都会触发）；客户端更新会话当前模型显示 |
| `session.permissionChanged` | `{sessionId, permission:string}` | **v1.1.7** 有效当前权限变化：源为 Host 会话事件 `permission/preset`、`sandbox/mode`、`approval/policy` 三类 knob；每条按 Host 顺序携带 `permissionPresets.current(session)` 有效值（含派生态 `custom`），与桌面端 `permissions.currentValue` 同口径。客户端更新当前权限显示；`custom` 仅可展示，不得变成选择目标 |
| `session.activity` | `{sessionId, updatedAt}` | 事件 `api-session/activity` |
| `session.queue` | `{sessionId, items:[{itemId, text, target:'next-turn'\|'next-step'}]}` | **v1.1.1** 该会话**待执行**的用户消息（排队中 / 已插入当前 turn 但尚未消费）。源为 Host 会话事件 `agent/inbox/spliced`（入队）与 `user/message`（被消费时出队）。客户端据此显示「排队中」列表——**只做展示，不做猜测**；items 为空数组 = 没有待执行消息。**v1.3.0**：以 Host 消息 `id` 出队；事件只用于实时更新，`session.queue` 拉取负责权威对账 |
| `session.todosChanged` | `{sessionId, todos:[TodoItem]\|null}` | **v1.3.0** Host 会话事件 `todo/write`（整表覆盖）或 `turn/start`（清单清为 `null`）。客户端整表替换，不自行合并 |
| `session.goalChanged` | `{sessionId, goal:GoalWire\|null, operation:'create'\|'edit'\|'pause'\|'resume'\|'complete'\|'block'\|'clear'\|'round'}` | **v1.3.0** Host 会话事件 `goal/change`。**v1.3.1**：轮次推进（`roundsStarted` 增加）也发一条 `operation:'round'`——Host 不为此发 `goal/change`（轮次由 goal-round-driver 写入 `user/message`），插件重读投影后补发。`clear` 为 `null`；其余给完整 `GoalWire`（不含 activation） |
| `session.goalActivationChanged` | `{sessionId, id, revision, activation:'armed'\|'disarmed'}` | **v1.3.0** Host 进程内事件 `goal/activation-changed`；无当前目标时不发 |
| `assistant.delta` | `{sessionId, text}` | 事件 `agent/assistant-stream`（文本增量；**按 sessionId 合并节流 ≤8 条/秒**）。**v1.1.6**：与思考增量共用保序队列（见本表末注） |
| `assistant.reasoningDelta` | `{sessionId, text}` | **v1.0.7** `agent/assistant-stream` 的 `reasoning-delta` 思考增量；与文本分流，客户端合并进「思考过程」块 |
| `assistant.image` | `{sessionId, image:ImageRef}` | **v1.0.9** 会话消息里的图片（§5.10）：源为 Host 会话事件的 `content` 块 `type:"image"`（附件引用）；**v1.1.0** 增补第二来源：present 投递的图片文件（§5.10.1，imageId 以 `d` 开头，`source:"deliverable"`） |
| `tool.call` | `{sessionId, callId, name, arguments, ts}` | **v1.0.6** Host 会话事件 `tool/call`（模型发起一次工具调用） |
| `tool.result` | `{sessionId, callId, status:"ok"\|"error", resultText, errorText?, ts}` | **v1.0.6** Host 会话事件 `tool/result`（工具调用结束；`resultText` 为结果文本，失败时 `errorText` 为原因） |
| ~~`system.message`~~ | ~~`{sessionId, kind:"system"\|"developer", text, ts}`~~ | **v1.1.4 移除**（v1.0.6 引入）。宿主 `system/message` / `developer/message` 是**系统提示词组装记录 / 工具注册表变更**，不是对话内容——DSH 桌面端聊天视图从不展示，手机端也不应展示（曾显示成大段「系统消息」，与 PC 轨迹不一致）。插件**不再桥接**该事件；客户端遇到旧插件发来的该 topic 直接忽略 |
| `turn.end` | `{sessionId, status:"idle"\|"error", error?}` | 事件 `agent/status`(idle) / `agent/error`。**v1.1.6**：保证在该 session 全部待发增量冲刷完之后发出 |
| `approval.request` | `{askId, sessionId, toolName, reason, argsPreview, timeoutMs, expiresAt?}` | 瀑布 `approval/request`。**v1.3.0** 增补绝对 `expiresAt`，供回前台恢复时按剩余时间显示；审批仍无 Host pending 投影，超时后只恢复插件仍持有的项 |
| `approval.resolved` | `{askId, decision, source:"phone"\|"timeout"\|"desktop"}` | 瀑布收束时回推（手机 UI 消除卡片用） |
| `question.request` | `{askId, sessionId, callId?, questions:[Question], timeoutMs?, expiresAt?, state:"open"\|"continued", answerable:bool, multiSelect?}` | 瀑布 `user-questions/request` 或 Host `userQuestions` 投影。**v1.3.0**：同一 `askId` 重发表示状态更新（客户端替换而非叠加）；`state:"continued"` 表示等待窗口已结束但仍可补答。`expiresAt` 是绝对 Unix 毫秒，恢复卡按剩余时间显示 |
| `question.resolved` | `{askId, source:"phone"\|"timeout"\|"desktop"}` | 问题真正结束（已回答/已取消/已失效）。**v1.3.0**：`timeout` 不再删除仍为 `continued` 的卡片；插件随后必须以 `question.request{state:"continued"}` 重发 |
| `push.state` | `{enabled, reason?}` | 推送通道状态变化 |
| `error` | `{message}` | 兜底 |

> **v1.1.6 直播保序**：`assistant.delta` 与 `assistant.reasoningDelta` 共用一条按 session
> 保序的合并队列——同一节流窗口只合并**相邻同类**块，跨类型顺序与宿主产生顺序一致；
> `agent/status`(idle) / `agent/error` / assistant 流结束先冲刷**全部**待发增量再发
> `turn.end`；`tool.call` / `tool.result` / `assistant.image` 发送前同样先冲刷该 session
> 的待发增量——即时事件不得越过未上屏的文本/思考（客户端按到达顺序渲染，依赖此保证）。

### 5.3 SessionSummary

```json
{ "sessionId": "…", "title": "…", "cwd": "…",
  "running": false, "updatedAt": 1760000000000,
  "origin": "subagent", "parentSessionId": "…", "blank": false }
```

**v1.0.4 补充字段**（Host `SessionSummary` 原生字段，插件必须透传）：
- `origin:"subagent"`：subagent 会话标记。
- `parentSessionId`：fork/spawn 血缘（subagent 会话=父会话 id）；根会话缺省。
- `blank:true`：尚无对话的空会话——**客户端应直接隐藏**（DSH 官方语义：
  clients hide blank Sessions from lists）。

**v1.0.5 曾移除 `archived`；v1.0.7 以明确的数据来源重新加入可选 `archived:bool`**：
Host `sessionController.list` 本身仍不回归档标记，插件必须用
`workspaceRegistry.archivedSessionIds` 为每个 wire SessionSummary 拼装该字段。
旧插件缺省 `archived` 时客户端按 false 处理；不得再把归档当成本机伪造状态。

**v1.0.7 思考过程**：assistant 历史事件的 `content` 中，`type:"reasoning"` 的块独立映射为
`ChatMessage{role:"reasoning", text}`，不混入普通 assistant 正文；同一事件的 reasoning
消息使用 `id = "<sessionId>:<seq>:reasoning"` 与相同 seq/ts，并排在普通 assistant 消息之前。
实时思考增量走 §5.2 `assistant.reasoningDelta`。没有 reasoning 内容时不产生空消息。

**v1.0.5 客户端列表显示规则**（替代 v1.0.4 的「子代理筛选页签」方案）：
- 列表只显示**根会话**（无 `parentSessionId` 且 `origin!=="subagent"`）且非 blank，
  updatedAt 降序；subagent 会话**不出现在列表**。
- subagent 的入口在**会话详情页内**：父会话详情页展示 `session.subagents` 返回的
  直接子代理目录（见 §5.6），点击进入子代理详情（历史只读/可续聊按 mode 区分）。

### 5.4 Question（ask_user_question 结构）

```json
{ "id": "q1", "question": "…", "multiSelect": false,
  "options": [ { "label": "…", "description": "…" } ] }
```

`question.answer.answers`：`{ "q1": "选项label" }` 或多选 `{ "q1": ["label1","label2"] }`。

### 5.5 审批/提问的瀑布语义（插件实现要求）

- 监听 `approval/request`（waterfall）：仅当 **手机端已连接**（或离线但配置了推送）且开关打开时拦截；
  否则必须 `next()` 原样放行。
- 拦截后：生成稳定 `askId`，向手机推 `approval.request` 并发送 Push 推送，等待 `approval.answer`；
  **超时（默认 120s，可配）或失败必须 `next()` 放行给桌面端答案器**，绝不 fail-closed 卡死任务。
  手机若在超时后才回答，回 `applied:false`。
- `user-questions/request` 同理，但 **v1.3.0** 起：Host 启用 `userQuestions` timed 模式时，
  超时只结束手机独占窗口，不删除仍 `continued` 的卡片；插件继续从 Host 投影提供快照，
  手机可经 `ctx.userQuestions.answer` 补答。插件不得把 `timeout` 当作问题过期，也不得
  自己伪造 `user/message`。
- 所有待答项在回前台/重连后必须能由快照恢复；恢复失败只影响展示，不影响瀑布计时与
  fail-open 放行。
- 参考实现范式：`D:/ai-projects/dsh/dsh-agent-approval/index.js` 中
  `ctx.on("approval/request", (req,next)=>…, {prepend:true})` 的写法（`req.agent` / `req.toolName` /
  `req.reason` / `req.callId` / `req.signal`，返回值为 ApprovalOutcome 字符串）。

### 5.6 SubagentInfo（v1.0.5）

`session.subagents` 响应行（来源：父会话 `subagentCatalog` 投影 + list 运行态组合）：

```json
{ "sessionId": "…", "label": "fix-login", "mode": "continuable",
  "running": false, "hasChildren": false, "createdAt": 1760000000000 }
```

- `mode:"one-shot"`：一次性子代理——**客户端必须隐藏输入条**（仅供查看历史；
  向其发消息会被宿主拒绝）。
- `mode:"continuable"`：可持续子代理——可发消息（`session.subagentPrompt`）与取消
  （`session.subagentCancel`）。
- `label`：创建时的名称（one-shot 可能缺省 → 客户端用 sessionId 前 8 位兜底）。
- `running`/`hasChildren`：运行态/是否有孙代（客户端可再下钻）。
- 事件流（`assistant.delta`/`turn.end`/`session.status` 等）以子代理 sessionId
  寻址，与普通会话一致——子代理详情页天然可复用流式渲染。

### 5.7 StepRecord — 会话时间线里的「工作步骤」（v1.0.6）

`session.history` 除 `messages` 外新增 `steps` 数组；直播期由 `tool.call` / `tool.result`
事件补齐。客户端把 `messages` 与 `steps` 合并成一条按 `seq` 升序的**时间线**渲染
（消息气泡 + 可展开的工作步骤卡），而不是只显示对话。

```json
{ "seq": 42, "callId": "call_abc", "name": "bash",
  "arguments": "{\"command\":\"ls -la\"}",
  "status": "ok",            // "ok" | "error"（直播期未收到结果时为 "running"）
  "resultText": "…输出…",     // 可空串
  "errorText": "",           // status="error" 时的原因
  "ts": 1760000000000,
  "turn": 3, "step": 2 }
```

字段规则：

- `seq`：Host 会话日志中该事件的持久序号（与 `ChatMessage.seq` 同一序列，**合并排序键**）；
  直播事件（`tool.call`/`tool.result`）无持久序号时客户端按到达顺序追加在末尾。
- `callId`：配对键——`tool/call` 与 `tool/result` 用它配对；客户端据此把
  「开始调用」升级为「已完成」。
- `name`：工具名（wire Tool name，如 `bash` / `read` / `write` / `grep`…）。
- `arguments`：模型产出的**原始参数字符串**（未解析，JSON 文本）。
- `resultText`：结果的纯文本摘要（内容块的 text 拼接；图片/文件类内容用占位符）。
- `turn` / `step`：Host 的轮次与步号（客户端可据此把同一轮内的步骤归为一个「工作步骤」组）。

**降级**：宿主/旧插件不提供步骤（无 `steps` 字段、无 `tool.*` 事件）时，客户端只渲染
`messages`，功能不受影响——**不得**因此报错或阻断会话。

### 5.8 新建会话的「模式 / 权限 / 模型 / 思考强度」（v1.0.6；模型 v1.0.7；强度与切换 v1.0.8；权限切换 v1.1.7）

手机端「新建会话」允许在创建前选择 Host 已有的**模式**（Agent preset）、**权限档位**
（permission preset）、**模型**与**思考强度**，与 DSH 桌面端语义一致：

- 模式 = Host 的 Agent preset（Standard / Creator / PTC / Minimal / 自定义…），决定会话运行的插件组合；
- 权限 = permission preset（`read-only` / `workspace-write` / `danger-full-access` / `auto`…）；
- 模型 = Host `sessionController.modelCatalog()` 中可路由的 provider + model；
- 思考强度 = 所选模型的 `reasoning.efforts`（无该字段的模型不支持，隐藏选择区）。

```json
// session.capabilities 的响应 value（节选）
{ "presets": [ { "id": "standard", "name": "Standard", "description": "标准模式" } ],
  "permissions": [ { "id": "workspace-write", "name": "工作区内修改", "description": "…" } ],
  "defaultPreset": "standard",
  "defaultPermission": "workspace-write",
  "models": [ { "id": "deepseek/deepseek-chat", "provider": "deepseek",
    "model": "deepseek-chat", "name": "DeepSeek Chat", "description": "",
    "reasoningEffort": "high",
    "efforts": [ { "id": "minimal", "name": "最少" }, { "id": "low", "name": "低" },
      { "id": "medium", "name": "中" }, { "id": "high", "name": "高" } ] } ],
  "defaultModelId": "deepseek/deepseek-chat",
  "archiveSupported": true }
```

- 模式/权限的 `id` 是提交给 `session.create` 的稳定标识；`name` / `description` 直接展示，不做本地化映射。
- `ModelOption.id` 仅供客户端选择/默认项匹配，格式建议 `provider + "/" + model`；提交必须使用
  `ModelSelection{provider, model, reasoningEffort?}`，不要从 id 反拆。`reasoningEffort` 取该模型的
  `reasoning.defaultEffort`（若有）；`defaultModelId` 由 catalog.default 对应的 provider/model 生成。
- **v1.0.8 efforts**：`efforts:[{id,name,description?}]` 来自宿主 `reasoning.efforts`，是提交
  `reasoningEffort` 的**唯一合法取值集合**；缺省（模型无 reasoning）时不传 `reasoningEffort`。
  客户端切模型时强度选择须重置为新模型的默认（`reasoningEffort`）或「默认」。
- 模式/权限/模型目录为空时，客户端隐藏对应选择区；default id 未命中时默认第一项。
- `session.create` 携带 `agentPreset` / `permission` 时按所选值创建；创建前被拒绝时回
  `unsupported-…`，客户端可回退为「不带选项创建」并提示。
- **模型选择时机**：Host create 不接受 model；插件必须在创建成功后、手机发送首条 prompt 前调用
  `sessionController.selectModel({sessionId, provider, model, reasoningEffort?})`。
  成功时响应 `model` 为 Host 归一化后的 selection；失败时响应仍包含 `sessionId` 并附 `modelError`，
  客户端提示「已用默认模型」并继续发送首条内容，**不得再次 create**。
- **权限选择的生效时机**：同样在新会话「首次发布」前写入；已存在会话不受后续默认值变更影响。
- **v1.0.8 会话中切换**：`session.selectModel` 对已存在会话调 `sessionController.selectModel`，
  下一次 prompt 组装即用新模型（与桌面端语义一致；运行中的 turn 不受影响）。客户端把入口放在
  会话详情页输入框旁（模型+强度一起选）；当前值用 `session.model` 读取、`session.modelChanged` 保持实时。
- **v1.1.7 会话中切换权限**：可选 catalog 继续复用 `session.capabilities.permissions`，不另建
  wire 目录；根会话详情页用 `session.permission` 读当前值、`session.selectPermission` 提交选择，
  并监听 `session.permissionChanged` 接收桌面端或其他端的变更。Host 以
  `values.permissions.currentValue` / `permissionPresets.current(session)` 的有效值为准，
  **不是只回显最近一次 `permission/preset`**——直接改 sandbox/approval 可能得到 `custom`。
- **v1.1.7 `custom` 与 subagent 边界**：`custom` 是宿主 knob 组合不匹配任何 preset 时的派生
  当前态，只允许出现在查询/事件/切换成功回读中，绝不出现在可选 catalog，也不得由客户端作为
  切换目标。subagent 的 `session.permission` 查询必须支持（只读、冷读、不激活）；App 不在
  subagent 详情页提供选择动作，Host 则不额外增加 subagent select 禁令。

### 5.9 Workspace 真实归档同步（v1.0.7）

归档的权威数据是 `workspaceRegistry.archivedSessionIds`，不是手机 Preferences：

- `session.list` 的每个 SessionSummary 由插件按该集合补 `archived`；因此**已归档会话也必须能随 list 传到 App**。
- 手机归档调用 `session.archive`，恢复调用 `session.unarchive`；插件分别调用
  `workspaceRegistry.archiveSession(sessionId, {stopActivity})` / `unarchiveSession(sessionId)`。
  运行中会话归档失败时把 Host 错误原文回给客户端，不得在本机假成功。
- 插件订阅 `ctx.on("domain/changed", …)`；`domain==="workspace"` 且 `table===""` / `operation==="put"`
  时读取最新 `archivedSessionIds`，向手机广播 `session.archives` **全集**。桌面端与手机端的归档变化因此一致。
- `archiveSupported=false` 表示宿主没有 Workspace 注册表或归档方法；客户端应隐藏/禁用归档动作并提示，不能退回本机归档。

### 5.10 会话消息里的图片（v1.0.9）

宿主会话消息的 `content` 块里图片是**附件引用**（不是内联 base64）：

```json
{ "type": "image", "attachment": { "attachmentId": "…", "mediaType": "image/png",
                                    "bytes": 123456, "width": 800, "height": 600 } }
```

中继单帧上限 **1MiB**（密文帧），原图直传必然超限，故采用**「缩略图内联 + 原图按需拉取」**两段式：

**ImageRef**（出现在 `ChatMessage.images[]` 与 `assistant.image` 事件 data 里）：

```json
{ "imageId": "…",            // 宿主 attachmentId（同会话内稳定）；交付物图片为 "d"+hash
  "mediaType": "image/png",  // image/png | image/jpeg | image/webp | image/gif
  "width": 800, "height": 600,
  "bytes": 123456,           // 原始字节数（宿主侧）
  "source": "deliverable",   // **v1.1.1 可选**：缺省 "attachment"；"deliverable" = present 投递的文件
  "thumb": "data:image/jpeg;base64,…" }  // 缩略图 data URI（长边 ≤ 480、JPEG q75）
```

- `ChatMessage` **v1.0.9** 新增可选字段 `images:ImageRef[]`——旧插件不返该字段时客户端当空数组处理。

**v1.3.1：唤醒消息（`trigger`）**——宿主**唤醒一回合**的消息不是用户手打的
（`data.source.kind !== "user"`）：目标轮次提示是 `kind:"goal"`，另有
`agent-message` / `team-message` / `subagent-settled` / `webhook` / `schedule` /
`tool-jobs` / `cordis-host-runner`。桌面端把它们渲染成**触发卡**（图标 + 一句话，例如
「继续执行目标」），**不显示注入的原始正文**。手机端同口径：

- `ChatMessage` 新增可选 `trigger: "goal"|"agent"|"team"|"subagent"|"webhook"|"schedule"|"job"|"plugin"`；
  带该字段的消息 `text` 为空串（原始注入正文被客户端隐藏），`role:"user"`、有 `seq`（照常参与排序）。
- 旧插件不返该字段 / 旧客户端不认该字段 → 保持旧行为（这类消息不显示）。
- 未知来源（不在上表）仍然**跳过**，不臆造消息。
- `assistant.image` 事件：图片随消息到达时推送 `{sessionId, image:ImageRef}`；
  客户端把它挂到**该会话当前正在流式的 assistant 消息**上（无流式消息时按到达序单独成一条图片消息）。
- 缩略图**必须**在事件/历史里内联（客户端才能立刻显示），但**必须**压缩到
  **≤ 96KB base64**；超限时插件降质重压，仍超限则**只发元数据、thumb 留空**（客户端显示占位框）。
- **大图浏览**：客户端点缩略图 → 发 `image.fetch`：

| type | payload | 响应 value |
|---|---|---|
| `image.fetch` | `{imageId, maxEdge?:number}` | `{imageId, mediaType, width, height, data:"data:<mediaType>;base64,…"}` |

  - `maxEdge` 缺省 1600（客户端放大时按需给更大值，上限 4096）。
  - 插件按 `maxEdge` 等比缩放并压到 JPEG q85 后回 data URI；**单张回包 ≤ 1MiB**（中继硬上限），
    超限时继续降质/降尺寸，仍超限回 `error`（客户端提示「原图过大，仅可看缩略图」）。
  - 插件可缓存已缩放版本（同 `imageId` + `maxEdge`），重复查看不再重复压缩。
  - `image.fetch` 失败**不得**影响会话其余功能（图片可选，不阻塞消息流）。
- 客户端渲染口径：缩略图按 `width/height` 等比显示（最大宽度撑满气泡、最大高度 ≤ 320vp），
  点击进大图浏览（全屏、支持双指缩放/拖动、关闭按钮）。

#### 5.10.1 图片的另一个来源：present 投递的文件（v1.1.0 增补）

宿主的 `present` 工具把交付物记成**会话事件** `deliverables/presented`
（`{turn, callId, files:[{path, name?, description?}]}`），**不是**图片附件块。
故插件除「`content` 块 `type:"image"`」外，还要桥接这一路，否则**桌面能看到的图
手机端永远看不到**（用户实测反馈）。

- 插件按**扩展名**识别图片（`.png/.jpg/.jpeg/.gif/.webp`；其余文件跳过），
  读字节、量尺寸、压缩略图后，按 §5.10 **同一套** `assistant.image` 事件 + `image.fetch`
  通道发给客户端——**wire 形状不变**，只是图片来源多了一种。
- `imageId` 命名空间与宿主附件 id 隔离：**`d` + sha1(path+turn) 前 16 位**
  （宿主 attachmentId 是随机 uuid，不会撞）。同一文件同一 turn 重复 present →
  同一 imageId → 客户端幂等，不重复挂。
- 非图片交付物（.md/.zip/…）**不**走这条通道（文件卡片是另一条通道，未定义）。
- 本条是**直播**桥接（事件流），历史消息里的交付物不补图。
- 交付物图片的 ImageRef 带 `source:"deliverable"`（v1.1.1）。

#### 5.10.2 交付物图片在历史里的位置（v1.1.1 增补）

直播时交付物图片若挂到「正在流式的 assistant 消息」上，**该消息在 turn 结束后的
历史刷新里会被宿主的持久副本替换**——而持久副本里没有交付物图片 →
图片「一闪而过然后消失」（用户实测反馈）。

v1.1.1 的口径：

- 交付物图片**必须**渲染成**独立的一条图片消息**（text 为空串），**不挂**到 assistant 气泡上。
- 插件在 `session.history` 的回包里，把本会话的交付物图片作为**独立的历史消息**
  一并返回（`text` 为空串、`images[]` 带内联缩略图）——于是任何一次历史刷新、
  重新打开会话、断线重连，交付物都还在（不再闪一下就没）。
- 交付物图片的 `imageId` 仍以 `d` 开头（与宿主附件 id 命名空间隔离），
  `image.fetch` 照样能取到原图。

### 5.11 用户提示词的附件（v1.2.0）

手机端输入框与 DSH 桌面端 composer 一样支持**图片**与**文件**附件：先分块上传到宿主并
落到宿主附件存储，再把 uploadId 随 `session.prompt` 一并提交。**附件不是 base64 塞进
`session.prompt`**——中继单帧 1MiB（密文帧），大图/大文件必须分块。

#### 5.11.1 能力目录（`session.capabilities.attachments`）

```json
{ "supported": true, "maxCount": 9, "maxItemBytes": 20971520,
  "maxMessageBytes": 41943040, "chunkBytes": 262144,
  "imageMediaTypes": ["image/png", "image/jpeg", "image/webp", "image/gif"] }
```

| 字段 | 含义 |
|---|---|
| `supported` | 宿主具备附件服务（`ctx.attachments` + `ctx.fileUploads`）且插件实现了 §5.11；false/缺省时客户端**隐藏附件入口**（旧插件没有该字段） |
| `maxCount` | 单条 `session.prompt` 的 `uploads` 数量上限（当前 9） |
| `maxItemBytes` | 单个附件原始字节上限（当前 20MiB） |
| `maxMessageBytes` | 单条消息附件总字节上限（当前 40MiB） |
| `chunkBytes` | `attachment.upload.chunk.data` 的**明文**最大字节数（当前 256KiB；客户端可更小） |
| `imageMediaTypes` | 宿主接受的图片媒体类型（客户端不得上传其他图片格式） |

**范围**：附件只对**根会话**开放。subagent（`kind='subagent'` 且带父会话血缘）详情页
不显示附件入口；对 subagent 会话 `begin` 回 `attachment-unsupported`。

#### 5.11.2 上传协议

```
client → host: attachment.upload.begin {sessionId, kind, name?, mediaType?, bytes}
host → client: {uploadId, chunkBytes}
client → host: attachment.upload.chunk {uploadId, index, data}       （index = 0,1,2…）
host → client: {received}
client → host: attachment.upload.commit {uploadId}
host → client: {uploadId, attachment: UploadedAttachment}
client → host: attachment.upload.abort {uploadId}                    （放弃时可选）
host → client: {aborted}
```

- `data` 必须是**标准 base64（canonical）**：`Buffer.from(data,'base64').toString('base64') === data`。
  手机端按明文块 → base64 → 业务信封 → AES-GCM → base64url 的既有链路发送，
  256KiB 明文 → 约 341KB base64 → 约 460KB 密文帧 < 1MiB。
- 分块必须**从 0 连续递增、每块只发一次**；`received` 为累计解码字节数。
  乱序/跳号/重复/超过 `begin.bytes` 一律 `attachment-chunk-mismatch`。
- `begin.bytes ≤ maxItemBytes`；同一 uploadId 只允许一条 chunk 流（客户端应串行）。
- **生命周期**：`begin` 后 **5 分钟**内未 `commit` → 记录过期（`attachment-upload-not-found`）；
  `commit` 成功后附件在**60 分钟**内可用于一次 prompt，之后过期（宿主已存对象保留）。
  插件同时最多保留 **4 个未提交** uploadId（防内存滥用，第 5 个回 `attachment-too-many`）。
- `commit` 前 `abort` 释放内存缓冲；`commit` 后不可撤回（宿主附件存储不可删除）。
- 分块/回包都走**普通业务帧**（加密、按 seq 串行发送，§4/§7 不变；中继无需改动）。
- 插件**不得**把附件字节、文件名、data URI 写日志（只允许 kind/字节数/uploadId 前缀）。

**UploadedAttachment**（`commit` 回包）：

```json
{ "kind": "image", "name": "IMG_0001.jpg", "mediaType": "image/jpeg",
  "bytes": 123456, "width": 2048, "height": 1536 }
{ "kind": "file",  "name": "report.pdf", "bytes": 12345 }
```

- 图片：宿主归一化后的元数据（`bytes/width/height` 是**归一化存储后**的值）；
  `name` 可缺省。宿主会校验字节与声明 `mediaType` 一致（不匹配回
  `session/attachment-invalid` + `reason:"IMAGE_TYPE_MISMATCH"`），并按部署限制
  （单图 50MiB / 6400 万像素 / 每消息 20 张）做准入。
- 文件：宿主逐字节存储，`name` 为宿主净化后的文件名，`bytes` 为原始长度。

#### 5.11.3 随提示词发送

`session.prompt {sessionId, text, uploads:[uploadId,…]}`：

- `uploads` 内附件按数组顺序拼成消息内容：`[text(若有非空正文), ...附件内容块]`。
  `text` 可为空串（**附件单独发送**合法，宿主 `hasPromptContent` 认附件）；
  `text` 与 `uploads` 同时为空 → `bad-params`。
- 插件把每个 uploadId 解为宿主 **file receipt**（`ctx.fileUploads` 的 staged receipt；
  图片/文件都用 receipt 通道，宿主在 prompt 准入时把 receipt 解成附件块），
  然后以 `mode` 与既有逻辑（§5.1）调用宿主 `sessionController.prompt`。
- 同一 uploadId **只能成功用于一次 prompt**：成功回包后插件标记已消费；
  重复使用 → `attachment-upload-not-found`；宿主拒绝 prompt（如模型不支持图片输入）
  时 receipt 未被消费，uploadId 仍可重试，宿主错误码/原因**原样**回给客户端。
- 失败语义：`session/attachment-invalid`（宿主附件校验失败，`reason` 带宿主码，
  如 `MODEL_DOES_NOT_SUPPORT_IMAGES` / `IMAGE_TOO_LARGE`）、
  `attachment-upload-not-found`、`attachment-upload-consumed`。
- 附件只对**已存在**会话生效；`session.create` 不接受附件（先建会话再发）。

#### 5.11.4 客户端渲染：用户消息里的附件（历史）

`ChatMessage` 新增可选 `files: FileRef[]`（旧插件不返该字段时按空数组处理）：

```json
{ "id": "…", "role": "user", "text": "", "ts": 1760000000000, "seq": 42,
  "images": [ ImageRef… ],
  "files": [ { "fileId": "sha256:…", "name": "report.pdf", "bytes": 12345 } ] }
```

- `images` / `files` 与正文并列：客户端把图片渲染成缩略图（点击 `image.fetch` 看大图），
  文件渲染成**文件卡片**（图标 + 文件名 + 大小；手机端 v1.2.0 **不提供下载**）。
- **v1.2.0 起正文不再为 `file` 块写 `[文件]` 占位符**——文件由 `files[]` 单独渲染
  （与 v1.0.9 图片口径一致）。旧客户端会少一行占位文本，属可接受降级。
- 手机端发送时**乐观上屏**（本地缩略图 + 文件名）；宿主消费该消息后由
  `session.history` 的权威副本替换（同一 `seq`），**不得**出现重复气泡。
- 图片附件与既有 §5.10 完全同通道：`imageId` = 宿主 attachmentId，缩略图内联、
  大图 `image.fetch` 按需拉取。`attachThumbs` 同样要给**用户消息**的图片补缩略图。
- 单条消息里图片+文件都有时，客户端按 `images` 在前、`files` 在后渲染。

#### 5.11.5 错误码

| code | 触发 |
|---|---|
| `attachment-unsupported` | 宿主无附件服务 / 目标是 subagent / 插件未实现 |
| `attachment-bad-params` | kind/mediaType/name/bytes/index 非法；`text` 与 `uploads` 同时为空 |
| `attachment-too-large` | `begin.bytes > maxItemBytes`；或 prompt 附件总字节超 `maxMessageBytes` |
| `attachment-too-many` | 单条 prompt 附件数 > `maxCount`；或未提交 uploadId 已达并发上限 |
| `attachment-upload-not-found` | 未知/过期/已消费/会话不匹配的 uploadId |
| `attachment-chunk-mismatch` | 分块乱序/跳号/重复/超长/非 canonical base64 |
| `attachment-upload-failed` | 宿主写入附件存储失败（未映射的存储错误） |

宿主入口的附件校验错误（`session/attachment-invalid`）**原样透传**（连带 `reason`），
客户端按宿主文案提示，不吞成通用错误。

### 5.12 待答交互与双端提问同步（v1.3.0）

```json
PendingQuestion = {
  "askId": "stable-identity",
  "sessionId": "session-…",
  "callId": "call-…",                 // 有 Host callId 时必填
  "questions": [Question],
  "state": "open" | "continued",
  "answerable": true,
  "source": "plugin" | "host",
  "expiresAt": 1760000000000,         // 可省略：indefinite/continued
  "timeoutMs": 120000,                // 兼容旧客户端，可省略
  "multiSelect": false                // 可省略
}

PendingApproval = {
  "askId": "stable-identity",
  "sessionId": "session-…",
  "toolName": "bash",
  "reason": "…",
  "argsPreview": "…",
  "answerable": true,
  "source": "plugin",
  "expiresAt": 1760000000000          // 可省略
}
```

**不变量：**

1. `pending.interactions` 是只读恢复通道。读取失败必须返回空数组，绝不能等待、阻塞或改动瀑布。
   客户端与插件**必须服从 DSH 当前配置**（legacy 或 timed）；不得为功能上线擅自修改 DSH
   预设、profile 或 `tool-ask-user` 的 mode/timeout。
2. 插件的 `approvalTimeoutMs` 只表示“手机独占等待窗口”，**不是问题寿命**。启用 Host
   `userQuestions` timed 模式后，窗口结束只把问题从 `open` 推进到 `continued`；Host
   仍可回答时手机卡片不得删除。
3. 手机与电脑使用同一个 Host `callId`；任意一端回答后，插件应发 `question.resolved`，
   另一端据此关闭。桌面端回答走 Host 原生水位，手机端 `continued` 回答必须调用
   `ctx.userQuestions.answer(agent, callId, answer)`，禁止注入伪造的 `user/message`。
4. 手机在后台/断线错过 `question.request` 时，回前台或重连必须拉一次
   `pending.interactions`；事件只负责变化，不承担恢复。
5. 已超时且 Host 不再可回答（legacy 模式无投影）的问题不得伪装成可答；快照可以省略它，
   客户端不得显示可编辑卡。
6. 旧客户端兼容：未在 `hello.features` 声明 `session-state-v1` 的客户端，插件仍按旧语义在
   timed 超时时发 `question.resolved`，且不得向它重发 `question.request{state:"continued"}`
   （旧 UI 会重复建卡）。新能力只对声明该特性的客户端启用。
7. 审批与提问共用同一快照通道。Host 没有审批投影，审批只恢复插件仍持有的未决项；
   超时后仍按 fail-open 交给桌面，不得伪造可答。

### 5.13 Todo（v1.3.0）

```json
TodoItem = { "content": "…", "status": "pending" | "in_progress" | "completed" }
```

- 数据源只有 Host `todos` 持久投影 / `todo/write` 会话事件；手机**只读**，不得写清单。
- 整表快照语义：`todo/write` 覆盖，`turn/start` 清为 `null`。
- `session.todos` 的 `supported:false` 与 `todos:null` 必须在**协议层**区分
  （`supported` 字段本身就是能力声明）；**渲染口径 v1.3.1 统一为「没数据就不显示」**：
  `todos:null` / 空数组与 `supported:false` 一样**整块不渲染**（不再画「暂无任务」空行）。

### 5.14 Goal（v1.3.0）

```json
GoalWire = {
  "id": "goal-…",
  "revision": 3,
  "objective": "…",
  "phase": "active" | "paused" | "blocked" | "complete",
  "blockedReason": { "code": "…", "message": "…" },  // 仅 blocked
  "maxGoalRounds": 12,
  "roundsStarted": 4,
  "createdAt": 1760000000000,
  "updatedAt": 1760000000000,
  "activation": "armed" | "disarmed"                 // 已知时
}
```

`GoalAction = "create" | "edit" | "pause" | "resume" | "complete" | "clear"`。

- 手机只能调用 Host 人类面 `ctx.goals`；禁止调用模型工具 `update_goal` / `create_goal`，
  也禁止伪造 `user/message`。
- 除 `create` 外，每个变更都携带客户端看到的 `{id,revision}`；Host 返回
  `GOAL_STALE_REVISION` 时客户端必须重拉，不能自动覆盖。
- `block` 不属于手机人类操作；模型/策略负责 blocked。
- 完成与清除必须在手机端二次确认。
- `activation` 是进程内状态，不持久；读不到就省略/`null`，不得显示“自动续跑中”。
- **轮次**（`roundsStarted`/`maxGoalRounds`）由 Agent 的自动续跑驱动，**手机端不编辑轮次**
  （`session.goalAction` 的 `maxGoalRounds` 只在 `edit` 时可选提交，客户端一般不提交）；
  轮次推进通过 `session.goalChanged{operation:"round"}` 推送（v1.3.1）。

## 6. Push Kit（华为推送）旁路

- 配置项（插件 config）：`push.enabled`、`push.appId`、`push.clientId`、`push.clientSecret`、
  `push.channelId`（通知渠道）、`push.topic`（可选）。未配置时整体禁用并在 `push.state` 事件说明。
- 发送（插件侧，纯 REST，无 SDK）：
  1. `POST https://oauth2.cloud.huawei.com/oauth2/v1/token`
     （`grant_type=client_credentials&client_id=…&client_secret=…`）→ `access_token`（缓存至过期前 60s）。
  2. `POST https://push-api.cloud.huawei.com/v1/{appId}/messages:send`，`Authorization: Bearer <token>`，
     消息体 `push_type: "notify"`，target 用 `push_token`（手机上报的 token）；
     `harmonyOS` 载荷携带标题/正文/`intent`（点击拉起 App 并直达对应会话，extra 字段：`sessionId`、`askId`、`kind`）。
- 触发点：`approval.request`、`question.request`、`turn.end`（可配是否推送完成）。
- 手机端 Push Kit 接入：见 hmos-push-kit skill；拿到 token 后走 `push.register` 上报，token 变化时重新上报。

## 7. 加密与测试向量（两端实现必须通过）

- 算法：AES-256-GCM，IV 12 字节/消息（CSPRNG 随机）。
  **载荷布局（v1.0.1 修正）**：`frame.data = base64url( iv(12) || ciphertext || tag(16) )`，
  即 IV 随消息一起走，整个 data 对中继不透明。
- AAD：**兼容模式**（v1.1.2 及以前，或任一方 pv<2）= `UTF8("dshrc|" + role + "|" + seq)`，
  role 为**发送方** role，seq 为该消息的 `frame.seq`。
  **加固模式**（v1.1.3，双方 pv≥2）= `UTF8("dshrc|" + role + "|" + seq + "|" + sid)`，
  `sid` 为**发送方**的连接实例 id（= 该帧的 `frame.sid`）。
  （AAD 绑定序号防重放/串帧；加固模式再绑定连接纪元，防跨会话重放。两端实现必须支持。）

已知答案测试（KAT）。注意：KAT 中的 channel 字面量仅为测试输入（不参与格式校验），
实现方**照抄字面量和期望值**即可；运行时生成的 channel 必须满足 §3/§4 的 `^[A-Z2-7]{16,64}$`：

```
secret  = "dsh-remote-demo-secret-0123456789"
channel = "ABCDEFGH23456789"
key     = HKDF-SHA256(ikm=UTF8(secret), salt=UTF8("dsh-remote-control/v1"),
                      info=UTF8("e2e|"+channel), L=32)
keyHex  = 6a76161fb789e8a48e1004cdcba483c2908bf4123180dae162dfb7e61e342a1d

ivHex   = 000102030405060708090a0b
pt      = {"id":"r1","type":"ping","ts":1700000000000,"payload":{}}
  (UTF-8 字节，无尾随换行)
ctHex   = 72b6fd46c5981533620ae9edc88cf0d607c89b5ad3da2d5ddd0548d6aef0c53e
          4b242be9c97ead9930a1374918a2f46dc861811055c1cbe1a3
tagHex  = 292260ad46868699ac0bda00a1336cb4
AAD     = ""   ← 注意：本 KAT 用空 AAD，便于对齐；AAD 绑定逻辑单独测试：
           encrypt(role="host", seq=7) 时 AAD = "dshrc|host|7" 的 UTF-8 字节
           （v1.1.3 加固模式再加 "|sid"，如 "dshrc|host|7|a1b2c3d4"）。
```

> **v1.1.3：§7 的固定向量（key/iv/ct/tag）不变**（用的仍是空 AAD）——
> 变的只是 AAD 的**格式**与新增的绑定维度，两端实现各自补这些断言：
> ① 换 role 解密必须失败；② 换 seq 解密必须失败；③ **换 sid 解密必须失败**（加固模式）；
> ④ 纪元回退（对端 e ≤ 已接受值）必须**拒绝连接**；⑤ 收到的帧 `frame.sid` 与钉扎值不符必须**丢弃**。

实现方自测：解密 ctHex+tagHex 必须还原 pt；用自己的 iv 加密 pt 必须得到相同 ctHex/tagHex。

## 8. 三个交付物与写入范围（互不重叠）

| 交付物 | 目录（写入范围） | 负责 | 要点 |
|---|---|---|---|
| DSH 插件 | `D:/ai-projects/dsh/dsh-remote-control/` | 子代理 A | 见 §8.1 |
| 中继服务器 | `D:/ai-projects/dsh/dsh-remote-control-relay/` | 子代理 B | 见 §8.2 |
| HarmonyOS App | `D:/ai-projects/dsh/dsh-remote-control-app/` | 子代理 C | 见 §8.3 |

本契约文件（`docs/plans/2026-10-20-dsh-remote-control-protocol.md`）由 Lead 独占维护，实现方只读。

### 8.1 DSH 插件（dsh-remote-control）

- **形态**：Host-only bundle（无需 Web UI client），`package.json` + `cordis.patch.yml` + `index.js` +
  `icon.svg` + `locale/en.json`（+ zh）。参考 `D:/ai-projects/dsh/dsh-agent-approval/`、`dsh-deveco/` 的工程结构。
- **兼容 gate**：`engines.dsh` 与 peerDependencies 的 `@deepseek-ai/dsh*` 用双段范围
  （如 `^0.1.5-rc.3 || ^0.2.0-rc.1 || ^0.2.1-rc.0`），否则插件会被静默禁用。
- **模块划分**（建议文件）：
  - `lib/protocol.mjs`：信封编解码 + HKDF/AES-256-GCM（Node `crypto`）+ KAT 自测函数。
  - `lib/relay-client.mjs`：全局 `WebSocket` 客户端，重连退避（1s→max 60s，抖动）、心跳、seq/去重、
    离线补发对接。
  - `lib/host-bridge.mjs`：Host 服务桥接——`sessionController`（list/create/prompt/cancel/rename，
    用 `ctx.get("sessionController")`）、事件订阅（`api-session/*`、`agent/assistant-stream`、
    `agent/status`、`agent/error`）、`approval/request` 与 `user-questions/request` 瀑布答案器（§5.5）。
  - `lib/push.mjs`：Push Kit REST 发送（§6），失败静默重试一次，绝不抛出打断主流程。
  - `lib/config.mjs`：自己的 config.json 读写（0.2.0 无 settingsScope；配置面后续可加 settings.section slot）。
- **安装**：用 `plugin_manager` `install_bundle` 装入当前 profile 并验证 `application: applied`。
- **验收**：node --check 通过；协议 KAT 自测通过；安装后插件行 active；`approve` 瀑布不拦截时 `next()`
  行为不回归（参考 dsh-agent-approval 的写法与回归测试思路）。

### 8.2 中继服务器（dsh-remote-control-relay）

- Node.js ≥20 + `ws`，单文件可跑（`node server.js`），支持 `RELAY_TOKEN`、`PORT`、`LOG_LEVEL` 环境变量。
- 实现 §4 全部帧语义：hello 校验（HMAC sig 可选验证 + 格式/限速）、单连接顶替、离线缓存 256 条/24h、
  心跳、按 role 转发。
- 交付：`server.js`（或 `src/`）、`package.json`、`README.md`（部署：systemd + Caddy 反代 WSS 的完整步骤）、
  `Dockerfile`、`test/`（用 node:test 跑：双客户端互通、离线补发、顶替、限速）。
- 验收：`npm test` 全绿；本机起服务，用 node ws 客户端模拟 host/client 走通 hello→frame→补发。

### 8.3 HarmonyOS App（dsh-remote-control-app）

- 完整 DevEco Studio 工程：`AppScope/` + `entry/`（module.json5、ets 页面、资源），compileSdkVersion
  与签名由用户在 DevEco 里配置；源码必须能通过 ArkTS 语法检查。
- **必须先加载 skill**：`hmos-arkui-develop-skill`（写任何 .ets 前）、`hmos-one-sdk-skill`（用 @kit.* 前）、
  `hmos-push-kit`（推送接入）。
- 页面：① 配对/设置（relayUrl、channel、secret、推送开关、连接状态）② 会话列表（标题/运行状态/最近活动，
  下拉刷新，`session.added/removed/status` 实时更新）③ 会话详情（消息气泡 + `assistant.delta` 流式追加、
  输入框、发送、取消按钮、turn 状态）④ 审批/提问卡片（弹窗或内嵌卡片：允许/拒绝/选项回答，倒计时）⑤ 关于。
- 网络：`@kit.NetworkKit` 的 `net.WebSocket`（WSS）；加密：`@kit.CryptoArchitectureKit`（HKDF + AES-GCM，
  与 §7 KAT 对齐）；推送：Push Kit 获取 token 并 `push.register` 上报，点击推送 intent 直达对应会话。
- 配对信息与密钥本地持久化（Preferences）；协议常量集中在一个 `protocol.ets`，字段名与本文档 §5 逐字一致。
- 验收：ArkTS 语法/构建尽量自查（如可用 devecocli/hmos-arkts-syntax-checker）；KAT 向量在注释或单测中对齐。

## 9. 端到端联调（Lead 负责）

1. 起中继（本地）→ 装插件 → 用 node 脚本模拟手机端走通：hello、session.list、session.prompt、delta 流、
   approval 问答、离线补发。
2. 手机真机（用户提供）：DevEco 编译装机，配对后真机验证公网链路。
3. Push Kit：用户在 AGC 开通推送并填 clientId/secret 后验证真机推送。

## 10. 风险与降级

- Push Kit 需要 AGC 合规配置（应用包名、签名、推送权益）→ 未配置时功能禁用，不影响主链路。
- 手机端 ArkTS 加密 API 与 Node 的 KAT 对齐是最常见的坑 → §7 测试向量是硬性验收项。
- `approval/request` 拦截必须保证超时 `next()`；手机永远不能成为任务的单点阻塞。

## 附录 A：Host API 事实（插件实现层，2026-10-20 联调实测）

- `sessionController.list({}, signal)` → `{items: SessionSummary[]}`；**items 里没有 title**，
  标题经 `sessionController.projections` 的 title 投影取（wire 层 `SessionSummary.title` 由插件拼装）。
- `sessionController.prompt` 需要 `{requestId: uuid, sessionId, mode: 'queue', content: [{type:'text', text}]}`；
  `cancel` 同步返回 `{accepted}`；`create` 无 title 参数（先 create 再 rename）。
- `approval/request` 的 `req`：`{agent, toolName, callId?, reason?, signal?}`，返回 `'allowed-once'|'rejected'|'cancelled'|'unavailable'`；
  `user-questions/request` 的回答形如 `{answers: [{id, selected, custom?}]}`。
- `agent/assistant-stream` 的 `frame.chunk.type === 'text-delta'` 是文本增量来源（按 sessionId 合并 125ms 冲刷）。
- **模块热更新**：profile 内 link 安装的插件，`set_plugin` disable/enable **不会**重载 ESM 模块源码
  （只重跑 apply，用的还是缓存类）；改代码后需 `remove_bundle` + `install_bundle` 才能生效——但对
  同 URL 的 ESM 缓存无效时需文件更名破缓存。2026-10-20 联调中最终经 remove+install 生效。
- 中继 v1.0.2 起必须**透传** `sid` 字段（活转发、离线缓存、补发三处都带上），否则接收端
  `sid:seq` 去重退化为裸 seq 误杀新连接（实测 bug：第二个客户端的 hello 被当重复帧丢弃）。

## 附录 B：Host API 事实（v1.0.6 工作步骤 / 模式 / 权限，2026-10-23 实测自 @deepseek-ai/dsh-* 类型定义）

- **会话事件总闸**：`ctx.on('session/event', (session, event) => …)` —— 宿主每写入一条
  会话日志事件都会触发；`event = { type, data, time, seq }`，`session.id` 为会话 id。
  事件类型（`@deepseek-ai/dsh-session` 的 `SessionEventMap`）：
  - `tool/call` → `data = { turn, step, callId, name, arguments }`（arguments 是**原始 JSON 字符串**）
  - `tool/result` → `data = { turn, step, message: { role:'tool', toolCallId, isError?, content:[ContentBlock] }, error?{name,code,reason?}, meta? }`
  - `system/message` → `data = { turn, step, message: SystemMessage }`
  - `developer/message` → `data = { turn, step, message: DeveloperMessage }`
  - `assistant/message` / `user/message` → 对话（既有 §5.2 口径）
  插件按 `event.type` 分派到 `tool.call` / `tool.result` 两个新事件即可；
  **`system/message` / `developer/message` 不再桥接**（v1.1.4：它们是提示词组装记录 /
  工具注册表变更，不是对话内容，PC 聊天视图从不展示）。
- **模型选择的权威来源（v1.1.4）**：`sessionController.projections({sessionId}, signal)`
  → `{ kind, asOfSeq, values }`，其中 `values.modelSelection` 是 **modelSelection 投影**的视图：
  `{ lastUsed: ModelSelection|null, next: ModelSelection|null }`，`next = pending ?? lastUsed`。
  - `pending` = 用户在会话里显式切换过、还没被请求消费的模型；
  - `lastUsed` = 上一个 `request/header` 实际使用的模型。
  DSH 桌面端 composer 显示的正是 `projected.next ?? catalog.default`
  （`dsh-client-ui-model-selection` 的 `syncInputs`）→ 手机端读同一份即可与 PC 对齐。
- **模式目录（Agent preset）**：`ctx.get('agentPresets')` → `AgentPresetRegistry`：
  - `list(): Promise<AgentPreset[]>`，`AgentPreset = { id, name?, description?, order?, broken? }`
  - `defaultId: string` —— 默认模式 id
  - 创建会话时 `sessionController.create({ cwd, agentPreset })` 接受 `agentPreset`（§5.1 SessionCreateRequest）。
- **权限目录（permission preset）**：`ctx.get('permissionPresets')` → `PermissionPresetService`：
  - `catalog(): PermissionCatalog` → `{ options: PresetOption[], defaultOptions: PresetOption[], defaultPreset: string }`，
    `PresetOption = { id, name, description? }`（`id` 即提交用的 key；`custom` 只是展示态，永不可选）。
    **⚠️ 宿主 0.2.1-rc.2 实测：catalog 的 option 字段名是 `value`（不是 `id`）**——
    插件两种字段名都要接受，**wire 侧统一输出 `id`**（本契约口径）。
  - `set(session, name): void` —— 把档位写入**某个已存在的会话**（有效 preset 变化时追加
    `permission/preset`，再通过权威 setter 写 `sandbox/mode` / `approval/policy`；净变化为零不追加）；
    需拿到 live Session 对象（`sessionController.resolveAgent(sessionId)` → 宿主 0.2.1-rc.2
    **直接返回 Agent**（失败时 throw），更早/更晚版本可能返回 `{agent}|{error}`，插件两种形状都要兜住）。
    桌面端当前会话选择通过 `/permission <preset>` 命令，最终也落到此 `set()` 路径。
  - **当前有效权限（v1.1.7 核对安装源码）**：`current(session): string` 与
    `sessionController.projections({sessionId}, signal)` → `values.permissions.currentValue`
    使用同一 derive；`permissions` 投影由 `permission/preset`、`sandbox/mode`、`approval/policy`
    三类事件折叠。返回配置 preset、`auto` 或派生态 `custom`；桌面端
    `dsh-client-ui-permission-presets` 正是读取 `session.projections.faceOf("permissions").getSnapshot()`。
    `projections` 支持冷读持久会话（含 subagent），查询不应为此调用 `resolveAgent` 激活。
  - 宿主未装载该插件时 `ctx.get('permissionPresets')` 为空 → 插件回空目录，客户端隐藏权限选择。
- **内容块**：`ContentBlock` 的 `type` ∈ `text` / `image` / `file` / `reasoning` / `tool-call` …；
  结果文本只取 `type==='text'` 的 `text` 拼接，image/file 用占位符（`[图片]` / `[文件]`）。

## 附录 C：Host API 事实（v1.0.7 归档 / 模型 / 思考，2026-10-24 实测自安装源码）

- **归档**：`ctx.workspaceRegistry.archivedSessionIds: readonly string[]`；
  `archiveSession(sessionId, {stopActivity?})` / `unarchiveSession(sessionId)` 均为 Promise 且幂等。
  归档运行中会话时 `stopActivity` 缺省=false 会被 `WorkspaceActiveSessionError` 拒绝。
  注册表写盘触发 `domain/changed`；Workspace Feed 同样以 `domain==="workspace" && table===""` 读取全集。
- **模型**：`sessionController.modelCatalog()`（无 request 参数）→
  `{default:{provider,model,reasoningEffort?}, groups:[{id,name,models:[{id,name,description?,reasoning?}]}], failures}`；
  `selectModel({sessionId,provider,model,reasoningEffort?})` → `{selected}`，并保存为后续默认。
  **v1.0.8**：模型项 `reasoning = {efforts:[{id,name,description?}], defaultEffort?}`（源码
  `dsh-api-session-controller/lib/types/catalog.js` buildModelCatalog）；efforts 即合法强度集合。
- **模型变化事件**：会话日志事件 `model/selection`（`agent.session.append("model/selection", selection)`，
  桌面/手机任何一端 selectModel 都会追加）；插件经 `ctx.on("session/event")` 观测并转
  `session.modelChanged`。事件 data = `{provider, model, reasoningEffort?}`。
- **思考**：`agent/assistant-stream` 的 `frame.chunk.type==="reasoning-delta"`，文本字段与 text-delta 相同；
  历史 assistant/message 的 content 里 `type:"reasoning"` 是独立 ReasoningBlock。
  普通 `contentText()` 仍忽略 reasoning；必须走独立映射，避免污染工具结果文本。

## 附录 D：Host API 事实（v1.2.0 提示词附件，2026-11-06 实测自 DSH 0.2.2-rc.1 安装源码）

- **附件存储**：`ctx.get("attachments")`（`AttachmentStore`，本地后端 `dsh-attachment-local`）。
  - `attachments.saveImages([{data: Uint8Array, mediaType, name?}])` → `Promise<ImageAttachmentRef[]>`
    （图片归一化 + 内容寻址存储；host 部署限制见 `attachments.imageLimits`）。
  - `attachments.admitEncodedFile({data:<canonical base64>, name?})` → `Promise<FileAttachmentRef>`
    （逐字节存储；`data` 非 canonical base64 回 `INVALID_FILE_BASE64`）。
  - `ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif"`；
    `ImageAttachmentRef = {attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}`；
    `FileAttachmentRef = {attachmentId, name, bytes}`。
- **上传 receipt**：`ctx.get("fileUploads")`（`dsh-client-file-upload` 的 Host 服务）。
  - `fileUploads.uploadStream({sessionId, data: AsyncIterable<Uint8Array>, name?, signal?})`
    → `{receiptId, file: FileAttachmentRef}`（内部 `attachments.saveFileStream`）。
  - `fileUploads.uploadImageStream({sessionId, data, mediaType, name?, signal?})`
    → `{receiptId, image: ImageAttachmentRef}`（内部 `attachments.saveImages`）。
  - 两方法内部 `resolveAgent(sessionId)`（冷会话会被激活）；**subagent 会被拒**
    （`subagent/attachment-invalid`，reason `SUBAGENT_FILE_UNSUPPORTED`）。
  - `fileUploads.resolve(agent, receiptId)` 取 staged 项；`bindPrompt` 在宿主 `prompt()` 内部自动调用。
  - 宿主服务缺失（自定义组合未装 `dsh-client-file-upload`）→ 插件 `attachments.supported=false`。
- **prompt 内容块**：`sessionController.prompt({requestId, sessionId, mode, content}, signal)` 的
  `content` 是 `PromptContentPart[]`：`{type:'text', text}` / `{type:'image', mediaType, data}` /
  `{type:'file', receiptId}`。**图片与文件都用 `{type:'file', receiptId}` 传 staged receipt**：
  宿主 `resolvePromptFileReceipts()` 把 file receipt 解回 staged 的 `{type:'image', attachment,
  encodedBytes}` 或 `{type:'file', attachment}`，再 `attachments.admitPromptContent()` 落成
  消息内容块。直接传 `{type:'file', attachment}`（无 receipt）会被拒（`FILE_NOT_STAGED`）。
- **消息内容块**：`ImageBlock = {type:'image', attachment: ImageAttachmentRef}`、
  `FileBlock = {type:'file', attachment: FileAttachmentRef}`；历史 `user/message` 的
  `content` 里两者都可能是持久化形态（插件 `mapHistoryMessages` 可直接读附件元数据）。
- **图片模态校验**：`prompt` 时若 content 含 image 且当前模型 `inputModalities` 不含 `"image"`，
  宿主回 `session/attachment-invalid`（`reason:"MODEL_DOES_NOT_SUPPORT_IMAGES"`）。
- **附件不可删除**：宿主附件存储没有删除 API，`abort` 只能丢弃插件内存缓冲。
