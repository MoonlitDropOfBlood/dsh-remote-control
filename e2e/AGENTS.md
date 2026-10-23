# AGENTS.md — e2e/（协议参考实现与联调工具）

协议 v1 的**第三份独立实现**（JS/Node），与 plugin、app 交叉验证；
mock 两端用于无真机/无 DSH 的联调。契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)。

## 结构

```
protocol.mjs      信封 + HKDF/AES-GCM 参考实现 + assertKat()（契约 §7 KAT，含 AAD role/seq 绑定）
link.mjs          中继链路层（hello/welcome/frame/心跳/sid:seq 去重/重连退避/outbox 缓冲）
                  + LoopbackLink/createLoopbackPair：进程内直连回环（自测用，不经中继）
mock-host.mjs     模拟 DSH 端：假会话、流式回复、审批问答演示（给 App 无 DSH 联调）
                  + v1.0.6：session.capabilities / create 带选项 / history 带 steps / 工具事件
mock-phone.mjs    模拟手机端：命令行 REPL（list/new/prompt/cancel/answer）
auto-test.mjs     自动化联调（读本机插件配置做真实链路验证；E2E_PROMPT=1 跑 prompt 闭环）
                  + v1.0.6 新链路用例（回环 + mock host 恒跑；真实宿主探针尽力而为）
probe-raw.mjs     原始帧探针（看帧顶层字段，如 sid 是否透传）
```

## 用法

```bash
node -e "import('./protocol.mjs').then(m=>{m.assertKat();console.log('KAT OK')})"
node mock-host.mjs ws://127.0.0.1:8788 KMNPQRTVWXY23456 <secret>     # 终端 1
node mock-phone.mjs ws://127.0.0.1:8788 KMNPQRTVWXY23456 <secret>   # 终端 2
node auto-test.mjs ws://127.0.0.1:8788                               # 真实插件链路
```

## 关键约定

- 本目录代码是**验证工具**，不是产品代码：协议改动时三方（plugin/app/e2e）同步改，
  但 KAT 向量永远不变。
- channel 示例必须用合法 RFC4648 base32（`^[A-Z2-7]{16,64}$`，如 KMNPQRTVWXY23456）
  ——历史上示例串带 8/9 被中继 bad-hello 拒过。
- link.mjs 的 outbox（未 open 时缓冲发送）与 sid:seq 去重是踩坑后补的，别删：
  请求早于 WS open 会被静默丢弃；裸 seq 去重会误杀新连接的 seq=1。
- **LoopbackLink 的 seq 必须在 send 时刻定格**：连续多次 send 会把多帧排进微任务队列，
  投递时再读计数器会拿到更大的 seq → AAD 不匹配 → 整帧解密失败（已踩）。
- mock-host 是 App 的联调靶子：文本含 "approve" 触发审批问答演示。
- auto-test.mjs 的 relay 地址优先取插件配置里的 `relayUrl`（argv 可覆盖）——
  本机中继常跑在 8788，硬编码 8787 会连不上。
