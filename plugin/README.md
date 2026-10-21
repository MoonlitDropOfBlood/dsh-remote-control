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

## 扫码配对（§3.5，v1.0.3）

除手动输入外，可用会话命令 `/remote-pairing` 生成**配对二维码**（协议
[docs/PROTOCOL.md](../docs/PROTOCOL.md) §3.5）：手机 App 配对页「扫码」直接填入
`relayUrl / channel / secret`，免手抄。

| 命令 | 作用 |
|---|---|
| `/remote-pairing` | 显示配对二维码（ASCII，会话窗口直接扫）+ 配对 URI（可复制兜底）+ 使用说明；同时写 `%DSH_HOME%/remote-control/pairing.svg` 并尝试用系统默认程序打开 |
| `/remote-pairing rotate` | 重新生成 channel+secret → 落盘 → 中继链路立即以新配对信息重连；**旧二维码/旧口述即刻失效** |
| `/remote-pairing hide` | 删除本机 `pairing.svg` 文件（不在屏幕上留图） |

编码细节（可由手机端实现者对照）：URI 形如
`dshrc://pair?r=<encodeURIComponent(relayUrl)>&c=<channel>&s=<secret>[&t=<encodeURIComponent(relayToken)>]`，
二维码为 byte 模式、纠错级 M、版本自适应 1–10（内嵌零依赖编码器，`lib/qr.mjs`）。

> ⚠️ **安全提示（§3.5）**：二维码/URI 含 secret 明文（与口述同级信任域）——只在受信任
> 屏幕上展示；不需要时用 `rotate`（换 secret 作废旧码）或 `hide`（删图）清理；
> 插件日志对 URI 做脱敏（`s=***`/`t=***`），不落明文。

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
index.js              Cordis 插件入口（KAT→配置→/remote-pairing→装配→清理）
lib/protocol.mjs      信封 + HKDF/AES-GCM + assertKat
lib/config.mjs        config.json 读写（首启生成 channel/secret）
lib/relay-client.mjs  中继客户端（重连退避/心跳/sid:seq 去重/reload 热更换）
lib/host-bridge.mjs   Host 服务桥接（sessionController + 事件 + 审批/提问瀑布）
lib/pairing.mjs       配对 URI（§3.5）+ SVG 落盘/打开/隐藏 + /remote-pairing 命令
lib/qr.mjs            内嵌 QR 编码器（byte/ECC-M/版本 1–10，零运行时依赖）
lib/push.mjs          Push Kit REST 发送
scripts/smoke-link.mjs  链路冒烟
scripts/verify-qr.mjs   QR 正确性自检（jsqr 独立解码 + 矩阵级 RS 自检；devDependencies）
scripts/verify-pairing.mjs  /remote-pairing 命令逻辑自检（mock ctx；devDependencies）
```
