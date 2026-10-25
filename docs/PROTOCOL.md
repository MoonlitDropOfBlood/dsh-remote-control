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
- seq 为发送端单调递增序号（**每条连接从 1 开始**），用于去重与排序；接收端容忍乱序（按 seq 缓冲或直接上交应用层均可）。
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
| `hello` | `{proto:1, clientName, appVersion, pushToken?, sig}` | `{hostName, dshVersion, pluginVersion}` | 连接/重连后首条；`sig` 见 §3.4 |
| `session.list` | `{}` | `{sessions:[SessionSummary]}` | SessionSummary 见 §5.3；**v1.0.7** 每项可带 `archived`，由插件根据 Workspace 注册表拼装，不需要 `includeArchived` 参数 |
| `session.history` | `{sessionId, beforeSeq?:number, maxMessages?:number}` | `{messages:[ChatMessage], steps:[StepRecord], hasMore, oldestSeq}` | **v1.0.4** 向后翻页的历史消息；`beforeSeq` 缺省取最新一页。ChatMessage：`{id, role:"user"\|"assistant"\|"reasoning", text, ts, seq}`（`reasoning` 为 **v1.0.7** 新增；见 §5.3）。subagent 会话自动走 durable subagent 地址。**v1.0.6**：新增 `steps`（工具步骤，§5.7）——旧插件不返该字段时客户端只显示消息 |
| `session.subagents` | `{sessionId}` | `{subagents:[SubagentInfo]}` | **v1.0.5** 父会话的直接子代理目录（父会话 `subagentCatalog` 投影 + 运行态）。SubagentInfo 见 §5.6 |
| `session.subagentPrompt` | `{parentSessionId, childSessionId, text}` | `{accepted:bool}` | **v1.0.5** 向 **continuable** 子代理发消息（delivery:'queue'）；one-shot 子代理返回 `unsupported` 错误。回复走同一事件流（sessionId=child） |
| `session.subagentCancel` | `{parentSessionId, childSessionId}` | `{accepted:bool}` | **v1.0.5** 取消 continuable 子代理当前 turn（interruptByParent；accepted=信号已受理，非已停止） |
| `session.create` | `{title?, cwd?, agentPreset?, permission?, model?}` | `{sessionId, agentPreset?, model?, modelError?}` | cwd 缺省用主机默认工作目录。**v1.0.6**：`agentPreset` / `permission` = 模式与权限（§5.8）。**v1.0.7**：`model:{provider,model,reasoningEffort?}` = 模型选择；Host 在创建后、首条 prompt 前 `selectModel`。会话已创建但模型设置失败时仍回成功并带 `modelError`，客户端不得重复创建 |
| `session.capabilities` | `{}` | `{presets:[ModeOption], permissions:[PermissionOption], defaultPreset?, defaultPermission?, models:[ModelOption], defaultModelId?, archiveSupported:bool, busyEnter:'queue'\|'steer'}` | **v1.0.6** 模式与权限目录。**v1.0.7** 增加模型目录与真实归档能力标记（§5.8/§5.9）。**v1.0.8** `ModelOption.efforts` 暴露该模型可选思考强度（§5.8）；宿主未提供对应能力时 models 为空 / archiveSupported=false，客户端隐藏对应选择区，不得报错。**v1.1.2** 增补 `busyEnter`：宿主「繁忙时的发送行为」——**只读**（客户端不得提供切换），宿主读不到时按 'queue' |
| `session.archive` | `{sessionId, stopActivity?:bool}` | `{sessionId, archived:true}` | **v1.0.7** 写入 Workspace 真实归档集合；`stopActivity=true` 时按 Host 语义停止运行活动，缺省为 false |
| `session.unarchive` | `{sessionId}` | `{sessionId, archived:false}` | **v1.0.7** 从 Workspace 归档集合恢复；幂等 |
| `session.selectModel` | `{sessionId, model:ModelSelection}` | `{model:ModelSelection}` | **v1.0.8** 对**已存在会话**切换模型/思考强度；插件调 `sessionController.selectModel({sessionId,…})`。Host 拒绝时回 `error`（原文带出），成功回归一化后的 selection，并视为一次 `model/selection`（同样触发 `session.modelChanged`） |
| `session.model` | `{sessionId}` | `{model:ModelSelection\|null}` | **v1.0.8** 查询会话当前模型/思考强度。插件从 `model/selection` 会话事件维护内存态；插件重启后无记录时回 `null`（客户端回退展示目录默认），**不得臆造** |
| `session.prompt` | `{sessionId, text}` | `{accepted:bool, mode:'queue'\|'steer'}` | 立即返回；实际回复走事件流。**v1.1.2 起投递行为由宿主设置决定**：客户端**不传** mode（传了也**忽略**）。插件读宿主「繁忙时的发送行为」（`ui-conversation.busyEnter`：排队发送/插话发送），agent 忙时按设置投递、空闲时总是 queue；宿主拒绝插话时插件**自动退回 queue**（消息不丢）。回包的 `mode` 是**实际**使用的投递行为 |
| `session.queue` | `{sessionId}` | `{sessionId, items:[{itemId, text, target:'next-turn'\|'next-step'}]}` | **v1.1.2** 拉取该会话**当前**待执行消息的全量快照。与 §5.2 的 `session.queue` 事件同形状：事件只在**变化时**推，客户端断线重连后必须拉一次才能补上断线期间变过的队列 |
| `session.cancel` | `{sessionId}` | `{cancelled:bool}` | 取消当前运行的 turn |
| `session.rename` | `{sessionId, title}` | `{title}` | |
| `image.fetch` | `{imageId, maxEdge?:number}` | `{imageId, mediaType, width, height, data:"data:<mediaType>;base64,…"}` | **v1.0.9** 拉取图片大图（§5.10）：`maxEdge` 缺省 1600、上限 4096；插件等比缩放后回 data URI，单张 ≤ 1MiB（中继硬上限），失败回 `error`（不影响消息流） |
| `approval.answer` | `{askId, decision:"approved"\|"rejected", note?}` | `{applied:bool}` | decision 只允许 approved/rejected |
| `question.answer` | `{askId, answers:{ [questionId]: value }, freeText?}` | `{applied:bool}` | answers 结构见 §5.4 |
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
| `session.activity` | `{sessionId, updatedAt}` | 事件 `api-session/activity` |
| `session.queue` | `{sessionId, items:[{itemId, text, target:'next-turn'\|'next-step'}]}` | **v1.1.1** 该会话**待执行**的用户消息（排队中 / 已插入当前 turn 但尚未消费）。源为 Host 会话事件 `agent/inbox/spliced`（入队）与 `user/message`（被消费时出队）。客户端据此显示「排队中」列表——**只做展示，不做猜测**；items 为空数组 = 没有待执行消息 |
| `assistant.delta` | `{sessionId, text}` | 事件 `agent/assistant-stream`（文本增量；**按 sessionId 合并节流 ≤8 条/秒**） |
| `assistant.reasoningDelta` | `{sessionId, text}` | **v1.0.7** `agent/assistant-stream` 的 `reasoning-delta` 思考增量；与文本分流，客户端合并进「思考过程」块 |
| `assistant.image` | `{sessionId, image:ImageRef}` | **v1.0.9** 会话消息里的图片（§5.10）：源为 Host 会话事件的 `content` 块 `type:"image"`（附件引用）；**v1.1.0** 增补第二来源：present 投递的图片文件（§5.10.1，imageId 以 `d` 开头，`source:"deliverable"`） |
| `tool.call` | `{sessionId, callId, name, arguments, ts}` | **v1.0.6** Host 会话事件 `tool/call`（模型发起一次工具调用） |
| `tool.result` | `{sessionId, callId, status:"ok"\|"error", resultText, errorText?, ts}` | **v1.0.6** Host 会话事件 `tool/result`（工具调用结束；`resultText` 为结果文本，失败时 `errorText` 为原因） |
| `system.message` | `{sessionId, kind:"system"\|"developer", text, ts}` | **v1.0.6** Host 会话事件 `system/message` / `developer/message`（系统提示注入等非对话内容） |
| `turn.end` | `{sessionId, status:"idle"\|"error", error?}` | 事件 `agent/status`(idle) / `agent/error` |
| `approval.request` | `{askId, sessionId, toolName, reason, argsPreview, timeoutMs}` | 瀑布 `approval/request` |
| `approval.resolved` | `{askId, decision, source:"phone"\|"timeout"\|"desktop"}` | 瀑布收束时回推（手机 UI 消除卡片用） |
| `question.request` | `{askId, sessionId, questions:[Question], timeoutMs, multiSelect?}` | 瀑布 `user-questions/request` |
| `question.resolved` | `{askId, source:"phone"\|"timeout"\|"desktop"}` | 同上 |
| `push.state` | `{enabled, reason?}` | 推送通道状态变化 |
| `error` | `{message}` | 兜底 |

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
- 拦截后：生成 `askId`，向手机推 `approval.request` 并发送 Push 推送，等待 `approval.answer`；
  **超时（默认 120s，可配）或失败必须 `next()` 放行给桌面端答案器**，绝不 fail-closed 卡死任务。
  手机若在超时后才回答，回 `applied:false`。
- `user-questions/request` 同理，等待 `question.answer`；超时 `next()`。
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

### 5.8 新建会话的「模式 / 权限 / 模型 / 思考强度」（v1.0.6；模型 v1.0.7；强度与切换 v1.0.8）

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
  插件按 `event.type` 分派到 `tool.call` / `tool.result` / `system.message` 三个新事件即可。
- **模式目录（Agent preset）**：`ctx.get('agentPresets')` → `AgentPresetRegistry`：
  - `list(): Promise<AgentPreset[]>`，`AgentPreset = { id, name?, description?, order?, broken? }`
  - `defaultId: string` —— 默认模式 id
  - 创建会话时 `sessionController.create({ cwd, agentPreset })` 接受 `agentPreset`（§5.1 SessionCreateRequest）。
- **权限目录（permission preset）**：`ctx.get('permissionPresets')` → `PermissionPresetService`：
  - `catalog(): PermissionCatalog` → `{ options: PresetOption[], defaultOptions: PresetOption[], defaultPreset: string }`，
    `PresetOption = { id, name, description? }`（`id` 即提交用的 key；`custom` 只是展示态，永不可选）。
    **⚠️ 宿主 0.2.1-rc.2 实测：catalog 的 option 字段名是 `value`（不是 `id`）**——
    插件两种字段名都要接受，**wire 侧统一输出 `id`**（本契约口径）。
  - `set(session, name): void` —— 把档位写入**某个已存在的会话**（追加 `permission/preset` 与
    沙箱/审批 knob 事件）；需拿到 live Session 对象（`sessionController.resolveAgent(sessionId)`
    → 宿主 0.2.1-rc.2 **直接返回 Agent**（失败时 throw），更早/更晚版本可能返回 `{agent}|{error}`，
    插件两种形状都要兜住）。
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
