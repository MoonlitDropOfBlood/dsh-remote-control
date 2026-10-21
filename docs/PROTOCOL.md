# dsh-remote-control：手机（HarmonyOS）远程控制 DSH —— 架构与协议契约

> 状态：v1 契约（2026-10-20，由 Lead 冻结）。三个实现（DSH 插件 / 中继服务器 / HarmonyOS App）
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
| peer→relay | `hello` | `t, role("host"\|"client"), ch, sig` | 连接后 10s 内必须发送，否则中继断开 |
| relay→peer | `welcome` | `t, peers:{host:bool,client:bool}` | hello 校验通过后回 |
| relay→peer | `peer-joined` / `peer-left` | `t, role` | 对端上线/下线 |
| peer→relay | `frame` | `t, sid, seq(number), data(base64 ciphertext)`, 可选 `urgent`(bool) | 转发给对端；`sid` 见下方 v1.0.2 |
| relay→peer | `frame` | `t, from("host"\|"client"), sid, seq, data` | 原样转发 |
| 双向 | `ping` / `pong` | `t` | 应用层心跳，30s 无帧即发；90s 无任何消息判死 |
| relay→peer | `error` | `t, code, message` | `bad-hello` / `rate-limited` / `channel-full` / `replaced`（同 role 新连接顶替旧连接时发给旧端） |

规则：
- `ch` 必须匹配 `^[A-Z2-7]{16,64}$`；同一 channel 同一 role 只允许一个活跃连接（新连接顶掉旧连接）。
- **离线缓存**：对端不在线时，中继缓存发往该端的 `frame`，上限 256 条 / 24h（FIFO 丢旧），重连后按 seq 顺序补发。
  `urgent` 标记的帧（审批/提问）优先补发。
- seq 为发送端单调递增序号（**每条连接从 1 开始**），用于去重与排序；接收端容忍乱序（按 seq 缓冲或直接上交应用层均可）。
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
| `session.list` | `{includeArchived?:bool}` | `{sessions:[SessionSummary]}` | SessionSummary 见 §5.3 |
| `session.create` | `{title?, cwd?}` | `{sessionId}` | cwd 缺省用主机默认工作目录 |
| `session.prompt` | `{sessionId, text}` | `{accepted:bool}` | 立即返回；实际回复走事件流 |
| `session.cancel` | `{sessionId}` | `{cancelled:bool}` | 取消当前运行的 turn |
| `session.rename` | `{sessionId, title}` | `{title}` | |
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
| `session.activity` | `{sessionId, updatedAt}` | 事件 `api-session/activity` |
| `assistant.delta` | `{sessionId, text}` | 事件 `agent/assistant-stream`（文本增量；**按 sessionId 合并节流 ≤8 条/秒**） |
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
  "running": false, "updatedAt": 1760000000000, "archived": false }
```

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
- AAD：`UTF8("dshrc|" + role + "|" + seq)`，role 为**发送方** role，seq 为该消息的 `frame.seq`。
  （AAD 绑定序号防重放/串帧；两端实现必须支持。）

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
           encrypt(role="host", seq=7) 时 AAD = "dshrc|host|7" 的 UTF-8 字节。
```

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
