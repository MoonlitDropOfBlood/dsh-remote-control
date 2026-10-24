# AGENTS.md — dsh-remote-control 仓库总览

用 HarmonyOS 手机远程控制 DeepSeek Harness (DSH)：会话遥控、审批/提问应答、任务通知。
四个子部分各有独立 AGENTS.md，改哪部分先读哪部分的。

## 架构（一图）

```
┌─ plugin/ (DSH 插件, PC) ─┐  WSS   ┌─ relay/ (中继) ──┐  WSS   ┌─ app/ (HarmonyOS) ─┐
│ 会话/审批桥接 + E2E 加密 │───────▶│  只转发密文     │◀───────│ 遥控器 UI          │
└──────────┬──────────────┘  出站   └─────────────────┘  出站   └────────────────────┘
           └── (可选) Push Kit ──────────────────────────────────────▶ 📱
```

- 两端都是 WS **客户端**（出站连接中继）→ 中继放局域网 PC（零公网部署）或 VPS 均可。
- 全部业务数据 AES-256-GCM 端到端加密，中继只见密文（哑管道）。
- **fail-open 原则**：手机永远不是任务的单点阻塞——审批超时/断线一律放行桌面答案器。

## 目录与职责

| 目录 | 语言 | 职责 | 验收命令 |
|---|---|---|---|
| [plugin/](plugin/AGENTS.md) | Node.js | DSH 插件：sessionController 桥接、事件桥接、审批瀑布、QR 配对、Push | `node --check` × N；plugin_manager install |
| [relay/](relay/AGENTS.md) | Node.js | 中继服务器：hello 校验、转发、离线缓存、限速、心跳 | `npm test`（10 用例） |
| [app/](app/AGENTS.md) | ArkTS | HarmonyOS 手机 App（DevEco 工程） | `devecocli build` + linter-cli 0 ERROR |
| [e2e/](e2e/AGENTS.md) | Node.js | 协议参考实现 + mock 两端 + 自动化联调 | `node auto-test.mjs` |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | — | **线协议契约 v1.0.9（唯一事实源，三方共同合同）** | 改协议必须先改它 |

## 快速开始

```bash
cd relay && npm install && node server.js            # 中继（默认 8787；联调常用 8788）
# DSH 插件：plugin_manager install_bundle → plugin/ （link 安装）
# 配对：DSH「设置 → DSH Pocket」分区展示二维码 → 手机 App 扫码（v1.1.x 起；旧的 /remote-pairing 命令已删除）
```

## 全局约定

1. **协议以 docs/PROTOCOL.md 为准**（v1.0.9：在 v1.0.8 模型思考强度目录与会话中切换模型之上，
   增补会话消息里的图片——§5.10「缩略图内联 + 大图按需拉取」）。改任何一端的 wire 行为必须先改契约，三方同步。
2. **KAT 是硬验收**：契约 §7 测试向量（key/iv/ct/tag/hmac）在 plugin 与 app 各有一份自测，
   连接建立前执行，失败禁连。加密链路每一环（HKDF/AES/HMAC）都必须进 KAT。
3. **git 提交**：`git -c user.name="dsh-remote-control" -c user.email="dev@localhost" commit`，
   提交信息英文祈使句，说清行为变化。
4. **零公网部署是默认模式**：relay 跑在 PC 上，手机连 `ws://<PC-IP>:<port>`。
   设置页「DSH Pocket」分区对 loopback 地址（127.0.0.1）会打警告。
5. 真机问题一律 `devecocli log --device <serial> --crash` 抓堆栈再修，不许猜。
6. **进程安全**：临时服务分别用受管 background job 启动并按 job_id 停止，命令内不得再用 `&`
   脱离作业；禁止按进程名或端口批量强杀（曾因此误杀 DSH 后端）。详见 e2e/AGENTS.md。

## 已固化的大坑（详见各部分 AGENTS.md 与全局记忆）

- HarmonyOS 真机：`createMac` 只认摘要名；`updateSync` 可返回 null；WS 回调成功时 err=undefined。
- DSH 插件：link 安装改代码后 set_plugin toggle 不重载模块（需 remove+install）；
  命令注册必须 `ctx.inject(["commands"], …)`；peerDependencies 双段版本范围。
- 中继：`sid` 字段必须三处透传（转发/缓存/补发），否则去重退化误杀新连接首帧。
