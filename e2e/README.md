# dsh-remote-control-e2e —— 协议参考实现与联调脚本（Lead 维护）

协议契约：[`../docs/plans/2026-10-20-dsh-remote-control-protocol.md`](../docs/plans/2026-10-20-dsh-remote-control-protocol.md)

本目录是协议 v1 的**第三份独立实现**（JS/Node），与 DSH 插件（`dsh-remote-control/lib/protocol.mjs`）、
HarmonyOS App（`dsh-remote-control-app/.../protocol.ets`）交叉验证。

| 文件 | 用途 |
|---|---|
| `protocol.mjs` | 信封 + HKDF/AES-256-GCM 参考实现，含契约 §7 KAT 自测（`assertKat()`） |
| `link.mjs` | 中继链路层（§4）：hello/welcome/frame/心跳/seq/去重/重连退避 |
| `mock-host.mjs` | **模拟 DSH 插件端**（host 角色）：假会话、流式回复、审批问答演示 |
| `mock-phone.mjs` | **模拟手机端**（client 角色）：命令行 REPL |

## 用法

```bash
# 1. 起中继（见 dsh-remote-control-relay/README.md）
node ../dsh-remote-control-relay/server.js          # ws://127.0.0.1:8787

# 2. 模拟 DSH 端（channel 必须满足 ^[A-Z2-7]{16,64}$）
node mock-host.mjs ws://127.0.0.1:8787 KMNPQRTVWXY23456 demo-secret-0123456789abcdef

# 3. 模拟手机端（另开终端）
node mock-phone.mjs ws://127.0.0.1:8787 KMNPQRTVWXY23456 demo-secret-0123456789abcdef
phone> list
phone> prompt s-demo-1 approve this task      # 含 "approve" 会触发审批问答演示
phone> answer ask-1 approved
```

HarmonyOS App 也可用 `mock-host.mjs` 做无 DSH 联调：配对页填同一 relayUrl/channel/secret 即可。

## KAT 自测

```bash
node -e "import('./protocol.mjs').then(m=>{m.assertKat();console.log('KAT OK')})"
```
