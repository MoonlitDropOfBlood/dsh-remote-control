# dsh-remote-control

用 **HarmonyOS 手机**远程控制 **DeepSeek Harness** 的 DSH 插件（Host 侧半边）。

- 会话遥控：会话列表 / 新建 / 发送提示词 / 流式查看回复 / 取消任务
- 审批 · 提问应答：agent 请求审批或用户提问时，手机上直接允许 / 拒绝 / 回答
- 推送通知：需要审批 / 提问 / 任务完成时经华为 Push Kit 推送到手机（可选）

架构：插件与手机都以 WebSocket **客户端**出站连接一台公网中继（`dsh-remote-control-relay`），
无需端口映射即可公网可达；全部业务数据用 **AES-256-GCM 端到端加密**，中继只见密文。

协议契约（v1.0.2）：[`docs/plans/2026-10-20-dsh-remote-control-protocol.md`](../docs/plans/2026-10-20-dsh-remote-control-protocol.md)。

## 安装

```bash
dsh plugin add D:/ai-projects/dsh/dsh-remote-control        # 或 plugin_manager install_bundle
```

## 配对（一次性）

1. 插件首次启用会在 `%DSH_HOME%/remote-control/config.json`（默认 `~/.dsh`）生成配对信息：
   - `channel`：16 位 base32（`^[A-Z2-7]{16,64}$`）
   - `secret`：E2E 密钥材料（**不要**发给中继或任何第三方）
2. 在 `config.json` 里填写 `relayUrl`（如 `wss://relay.example.com/`），
   需要中继鉴权时填 `relayToken`（对应中继的 `RELAY_TOKEN`）。
3. 手机 App（`dsh-remote-control-app`）配对页输入同样的 `relayUrl / channel / secret`，连接即配对。

> 修改 `config.json` 后如插件未即时生效，用 plugin_manager 把本插件 disable→enable，
> 或 `remove_bundle` + `install_bundle` 重装（link 安装指向本目录，磁盘即最新源码）。

## 配置项（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时不连中继、不拦截任何请求 |
| `relayUrl` | `""` | 中继地址；空 = 空转待配对 |
| `relayToken` | `""` | 中继自身鉴权 token（可选） |
| `channel` / `secret` | 首启生成 | 配对信息（§3） |
| `interceptApprovals` | `true` | 手机在线时代理审批请求 |
| `interceptQuestions` | `true` | 手机在线时代理用户提问 |
| `approvalTimeoutMs` | `120000` | 手机应答超时（钳制 10s–600s）；**超时一律放行给桌面答案器，绝不阻塞任务** |
| `push.*` | 关闭 | Push Kit（`appId` / `clientId` / `clientSecret` / `channelId` / `topic` / `notifyTurnEnd`） |

## 安全模型

- 配对 secret 经 HKDF-SHA256 派生 E2E 密钥；每帧 AES-256-GCM（`iv||ct||tag`），AAD 绑定发送方 role 与 seq。
- 中继只转发密文；`channel` 是随机能力串，`hello` 用 HMAC 签名证明持有 secret。
- 审批拦截 fail-open：手机永远不是任务的单点阻塞（超时/出错/断线 → `next()` 放行桌面答案器）。
- 启动时执行协议 KAT 自测（契约 §7），失败即禁用连接，绝不带病上线。

## 目录

```
index.js            Cordis 插件入口（KAT→配置→装配→清理）
lib/protocol.mjs    信封 + HKDF/AES-GCM + assertKat
lib/config.mjs      config.json 读写（首启生成 channel/secret）
lib/relay-client.mjs 中继客户端（重连退避/心跳/sid:seq 去重）
lib/host-bridge.mjs Host 服务桥接（sessionController + 事件 + 审批/提问瀑布）
lib/push.mjs        Push Kit REST 发送
scripts/smoke-link.mjs  链路冒烟
```

## 配套

- 中继服务器：[`dsh-remote-control-relay`](../dsh-remote-control-relay/README.md)（部署到任意 VPS）
- 手机 App：[`dsh-remote-control-app`](../dsh-remote-control-app/README.md)（HarmonyOS ArkTS DevEco 工程）
- 联调脚本：[`dsh-remote-control-e2e`](../dsh-remote-control-e2e/README.md)（模拟手机 / 模拟 DSH）
