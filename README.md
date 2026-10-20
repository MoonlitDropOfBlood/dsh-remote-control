# dsh-remote-control

用 **HarmonyOS 手机**远程控制 **DeepSeek Harness (DSH)**：会话遥控、审批/提问应答、任务通知。

```
┌─ DSH 插件 (PC) ──────┐   WSS   ┌─ 中继 (自选部署) ──┐   WSS   ┌─ HarmonyOS App ─┐
│ 会话 / 审批桥接      │────────▶│   只转发密文      │◀────────│ 遥控器 UI       │
│ 端到端加密           │  出站   └──────────────────┘  出站   └─────────────────┘
└──────┬───────────────┘
       └── (可选) Push Kit 通知 ──────────────────────────────▶ 📱
```

- **两端都以 WebSocket 客户端出站连接中继**：中继放局域网 PC 或任一 VPS，手机在局域网或公网都能连；
  中继只转发 **AES-256-GCM 密文**，被攻破也读不到内容（协议见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）。
- **零公网部署模式**：中继直接跑在 PC 上，手机连 `ws://<PC-IP>:<端口>` 即可（同一 Wi-Fi）。
- **fail-open 安全设计**：手机永远不是任务的单点阻塞——超时/断线一律放行给桌面答案器。

## 功能

| 能力 | 说明 |
|---|---|
| 会话遥控 | 会话列表（实时状态）/ 新建 / 发送提示词 / 流式查看回复 / 取消任务 |
| 审批 · 提问应答 | agent 请求审批或用户提问时手机上直接允许 / 拒绝 / 回答（带倒计时） |
| 任务通知 | 华为 Push Kit 推送（可选；未配置时优雅降级） |

## 仓库结构

| 目录 | 内容 | 技术栈 |
|---|---|---|
| [plugin/](plugin/) | DSH 插件（Host 侧半边），安装进 DSH profile | Node.js / Cordis |
| [relay/](relay/) | 中继服务器（哑管道，只转发密文帧） | Node.js + ws |
| [app/](app/) | HarmonyOS 手机 App（DevEco 工程） | ArkTS / ArkUI |
| [e2e/](e2e/) | 协议参考实现 + mock 手机/DSH + 自动化联调 | Node.js |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 线协议契约 v1.0.2（三方共同合同） | — |

## 快速开始

```bash
# 1. 起中继（局域网：跑在 PC 上即可）
cd relay && npm install && node server.js          # 默认 0.0.0.0:8787

# 2. 安装 DSH 插件（link 安装）
dsh plugin add ./plugin                            # 或 DSH 的 plugin_manager install_bundle

# 3. 配对
#    插件首次启动生成 channel/secret → %DSH_HOME%/remote-control/config.json
#    把中继地址填进 config.json 的 relayUrl（如 ws://192.168.3.2:8787）
#    手机 App「配对」页输入同样的 relayUrl / channel / secret，连接即配对
```

App 侧构建与装机见 [app/README.md](app/README.md)；mock 联调（无真机/无 DSH）见 [e2e/README.md](e2e/README.md)。

## 安全模型

- 配对 secret 经 HKDF-SHA256 派生端到端密钥；每帧 AES-256-GCM（`iv||ct||tag`），AAD 绑定发送方 role 与 seq 防串帧。
- 中继只见密文；`channel` 是随机能力串；`hello` 用 HMAC 签名证明持有 secret。
- 启动即跑协议 KAT 自测（[docs/PROTOCOL.md](docs/PROTOCOL.md) §7），失败即禁用连接，绝不带病上线。
- 审批拦截 fail-open：超时（默认 120s）/出错/断线 → 放行桌面答案器。

## License

[MIT](LICENSE)
