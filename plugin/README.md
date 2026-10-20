# plugin —— DSH 插件（Host 侧半边）

用 HarmonyOS 手机远程控制 DeepSeek Harness 的 DSH 插件：会话遥控、审批/提问应答、推送通知。

架构与安全模型见仓库根 [README](../README.md)；线协议见 [docs/PROTOCOL.md](../docs/PROTOCOL.md)（v1.0.2）。

## 安装

```bash
dsh plugin add <本目录>        # 或 DSH 的 plugin_manager install_bundle（target 指向本目录）
```

## 配对（一次性）

1. 插件首次启用会在 `%DSH_HOME%/remote-control/config.json`（默认 `~/.dsh`）生成配对信息：
   - `channel`：16 位 base32（`^[A-Z2-7]{16,64}$`）
   - `secret`：E2E 密钥材料（**不要**发给中继或任何第三方）
2. 在 `config.json` 里填写 `relayUrl`（如 `ws://192.168.3.2:8787` 或 `wss://relay.example.com/`），
   需要中继鉴权时填 `relayToken`（对应中继的 `RELAY_TOKEN`）。
3. 手机 App（[../app](../app/)）配对页输入同样的 `relayUrl / channel / secret`，连接即配对。

> 修改 `config.json` 后如插件未即时生效，用 plugin_manager 把本插件 disable→enable，
> 或 remove 后重新 install（link 安装指向本目录，磁盘即最新源码）。

## 配置项（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；false 时不连中继、不拦截任何请求 |
| `relayUrl` | `""` | 中继地址；空 = 空转待配对 |
| `relayToken` | `""` | 中继自身鉴权 token（可选） |
| `channel` / `secret` | 首启生成 | 配对信息 |
| `interceptApprovals` | `true` | 手机在线时代理审批请求 |
| `interceptQuestions` | `true` | 手机在线时代理用户提问 |
| `approvalTimeoutMs` | `120000` | 手机应答超时（钳制 10s–600s）；**超时一律放行给桌面答案器** |
| `push.*` | 关闭 | Push Kit（`appId` / `clientId` / `clientSecret` / `channelId` / `topic` / `notifyTurnEnd`） |

## 目录

```
index.js              Cordis 插件入口（KAT→配置→装配→清理）
lib/protocol.mjs      信封 + HKDF/AES-GCM + assertKat
lib/config.mjs        config.json 读写（首启生成 channel/secret）
lib/relay-client.mjs  中继客户端（重连退避/心跳/sid:seq 去重）
lib/host-bridge.mjs   Host 服务桥接（sessionController + 事件 + 审批/提问瀑布）
lib/push.mjs          Push Kit REST 发送
scripts/smoke-link.mjs  链路冒烟
```
