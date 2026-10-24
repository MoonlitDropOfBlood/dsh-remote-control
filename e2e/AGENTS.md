# AGENTS.md — e2e/（协议参考实现与联调工具）

协议 v1 的**第三份独立实现**（JS/Node），与 plugin、app 交叉验证；
mock 两端用于无真机/无 DSH 的联调。契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)。

## 结构

```
protocol.mjs      信封 + HKDF/AES-GCM 参考实现 + assertKat()（契约 §7 KAT，含 AAD role/seq 绑定）
link.mjs          中继链路层（hello/welcome/frame/心跳/sid:seq 去重/重连退避/outbox 缓冲）
                  + LoopbackLink/createLoopbackPair：进程内直连回环（自测用，不经中继）
mock-host.mjs     模拟 DSH 端：假会话、流式回复、审批问答演示（给 App 无 DSH 联调）
                  + v1.0.7：模式/权限/模型目录、真实归档事件、steps 与 reasoning 历史/直播
                  + v1.0.8：模型 efforts 强度目录、session.selectModel / session.model、
                    模型变化广播 session.modelChanged
mock-phone.mjs    模拟手机端：命令行 REPL（list/new/prompt/cancel/answer）
auto-test.mjs     自动化联调（读本机插件配置做真实链路验证；E2E_PROMPT=1 跑 prompt 闭环）
                  + v1.0.6/1.0.7/1.0.8 新链路用例（回环 + mock host 恒跑；真实宿主探针尽力而为）
                  + E2E_LOOPBACK_ONLY=1：只跑回环用例（手机在线时用，不连真实中继）
probe-raw.mjs     原始帧探针（看帧顶层字段，如 sid 是否透传）
```

## 用法

```bash
node -e "import('./protocol.mjs').then(m=>{m.assertKat();console.log('KAT OK')})"
node mock-host.mjs ws://127.0.0.1:8788 KMNPQRTVWXY23456 <secret>     # 终端 1
node mock-phone.mjs ws://127.0.0.1:8788 KMNPQRTVWXY23456 <secret>   # 终端 2
node auto-test.mjs ws://127.0.0.1:8788                               # 真实插件链路（见下方警告）
E2E_LOOPBACK_ONLY=1 node auto-test.mjs                              # 只跑回环用例（手机在线也安全）
```

## ⚠️ 手机在线时不要跑 auto-test.mjs 的真实宿主链路

- 中继是「**同 channel 同 role 单活跃连接：新顶旧**」（契约 §4）。手机与
  `node auto-test.mjs` 用**同一个 channel + client 角色**时，两边会互相顶替：
  中继把旧的踢掉 → 旧的自动重连 → 又把新的踢掉 → **每秒互抢**，手机被反复断连。
- 因此：**真实手机在线时不要直接跑 `auto-test.mjs` 的真实宿主链路**（它默认读
  `~/.dsh/remote-control/config.json` 的真实 channel + relayUrl）。
  要跑真实链路，先让手机离线；或用**独立临时 channel/端口**另起一套
  （临时 relay + 临时 config.json + `DSH_HOME=<临时目录>`），别用真实 channel。
- **首选 `E2E_LOOPBACK_ONLY=1 node auto-test.mjs`**：它**不读真实 config、不建真实 RelayLink**，
  只跑进程内回环 + mock host（自带临时 channel/secret，不经中继、不占真实 channel）。
  手机在线时的例行回归一律用它。
- link.mjs 已做防护：收到中继 `replaced` / `bad-hello` 错误帧即**停心跳、停自动重连**
  （close 回调不复活），避免互抢成死循环；`close()` 幂等。

## 临时进程安全（2026-10-24 误杀 DSH 后固化）

- 临时 relay/mock 必须**分别**用 `bash(run_in_background=true)` 启动并记录 job id；
  命令内部禁止再写 `&` 让子进程脱离受管 job，停止只用对应 `job_kill`。
- **禁止** `taskkill /IM node.exe`、`Stop-Process -Name`、按端口批量反查 PID 后强杀。
  2026-10-24 plugin-host 曾用 `netstat :18803 → taskkill /F /PID` 未核验进程身份，
  误杀 DSH 后端；不得复现该清理方式。
- 发现遗留进程时先报告 Lead，核验可执行路径/父进程/命令行；不能确认归属就不动它。

## 关键约定

- 本目录代码是**验证工具**，不是产品代码：协议改动时三方（plugin/app/e2e）同步改，
  但 KAT 向量永远不变。
- channel 示例必须用合法 RFC4648 base32（`^[A-Z2-7]{16,64}$`，如 KMNPQRTVWXY23456）
  ——历史上示例串带 8/9 被中继 bad-hello 拒过。**注意数字只能是 2-7**（没有 0/1/8/9），
  临时 channel 也别写成 `TMP…TEST1` 这种含 1 的串。
- link.mjs 的 outbox（未 open 时缓冲发送）与 sid:seq 去重是踩坑后补的，别删：
  请求早于 WS open 会被静默丢弃；裸 seq 去重会误杀新连接的 seq=1。
- **LoopbackLink 的 seq 必须在 send 时刻定格**：连续多次 send 会把多帧排进微任务队列，
  投递时再读计数器会拿到更大的 seq → AAD 不匹配 → 整帧解密失败（已踩）。
- mock-host 是 App 的联调靶子：文本含 "approve" 触发审批问答演示。
- auto-test.mjs 的 relay 地址优先取插件配置里的 `relayUrl`（argv 可覆盖）——
  本机中继常跑在 8788，硬编码 8787 会连不上。
