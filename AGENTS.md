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
| [relay/](relay/AGENTS.md) | Node.js | 中继服务器：hello 校验、转发、离线缓存、限速、心跳 | `npm test`（16 用例） |
| [app/](app/AGENTS.md) | ArkTS | HarmonyOS 手机 App（DevEco 工程） | `devecocli build` + linter-cli 0 ERROR |
| [e2e/](e2e/AGENTS.md) | Node.js | 协议参考实现 + mock 两端 + 自动化联调 | `node auto-test.mjs` |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | — | **线协议契约 v1.1.4（唯一事实源，三方共同合同）** | 改协议必须先改它 |

## 快速开始

```bash
cd relay && npm install && node server.js            # 中继（默认 8787；联调常用 8788）
# DSH 插件：plugin_manager install_bundle → plugin/ （link 安装）
# 配对：DSH「设置 → DSH Pocket」分区展示二维码 → 手机 App 扫码（v1.1.x 起；旧的 /remote-pairing 命令已删除）
```

## 发布（npm / 插件市场 / GitHub Release，2026-10-26 起全自动）

- **两个 npm 包**（同属 `@duke-dsh-plugins` 作用域，**版本必须同 bump**）：
  `@duke-dsh-plugins/dsh-remote-control`（插件，含 vendor 中继副本与**市场索引副本**）+
  `@duke-dsh-plugins/dsh-remote-control-relay`（中继，独立部署用）。
  ⚠️ **没有第三个「市场索引包」**：v1.1.4 起市场索引**并入插件包**自托管
  （`plugin/market/index.json`，发布时由 `market/sync-into-plugin.mjs` 拷入，
  该目录 gitignored）。release workflow 也**只 publish 这两个包**。
- **发版 = 打标签**：同时 bump `relay/package.json` 与 `plugin/package.json` 的版本 +
  **`CHANGELOG.md` 补一段 `## [版本]`**（缺失时 release workflow 直接失败）→
  `git tag v<版本> && git push origin main --tags`。`.github/workflows/release.yml` 接管：
  门禁 → npm 发布（已发布自动跳过，重推标签安全）→ changelog 段落成为 Release 正文 →
  `market/generate-index.mjs` 重生成插件市场索引 → 官方校验器验证 → 提交回 main →
  GitHub Release（正文 + 自动 notes + 两个包的 tgz + 索引文件）。
  - ⚠️ **推标签前先推 main**：标签必须指向 **main 上的提交**（否则 workflow 会从
    一条不在 main 上的历史发布，并把「索引提交回 main」推成非快进 → Release 标红，
    **但 npm 已经发出去了**）。2026-10-28 的 v1.1.5 因此红过一次。
- **前置 secret（一次性）**：仓库 Settings → Secrets → Actions 配 `NPM_TOKEN`
  （npmjs.com Access Tokens，Automation 类型）。
- **插件市场索引**：`market/index.json`（format 1）→ 随**插件包**发布 →
  用户在 DSH「设置 → 插件市场」加
  `https://unpkg.com/@duke-dsh-plugins/dsh-remote-control@latest/market/index.json`
  （见 `market/README.md`）。**为什么走 unpkg 而不是 GitHub raw**：实测国内网络下
  `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 连接被重置，只有 unpkg 通。
  索引只列插件包；中继包不是 bundle，不进索引。
  另有一条社区目录通道：提 PR 到 awesome-dsh-plugin（`market/awesome-dsh-plugin-entry.yml`），
  合并后随上游每日 CI 进官方 `dsh-plugin-catalog` 包。
- **npm 令牌要按包授权**：granular token 必须同时含**这两个**包，否则发布会被要求
  浏览器认证（ENEAUTH/401）。
- CI（`.github/workflows/ci.yml`）：relay 测试+smoke；plugin 全部 verify 门禁
  （verify-settings 的 peers 从 npm 临时装）；市场索引格式校验。

## 全局约定

1. **协议以 docs/PROTOCOL.md 为准**（**v1.1.4**：v1.0.9 会话消息里的图片（§5.10「缩略图内联 +
   大图按需拉取」）→ v1.1.0 present 投递的文件也上手机（§5.10.1）→ v1.1.2 交付物图片进历史
   （§5.10.2）+ 排队事件 session.queue（§5.1/§5.2）→ **v1.1.3 抗重放的会话纪元**
   （§3.4.1 hello 证明 v2 + AAD 绑定 sid + 纪元单调性；§3.4.2 中继原生 TLS）
   → **v1.1.4 手机端体验对齐 PC**：`session.model` 改读宿主 `modelSelection` 持久投影
   （与 PC composer 同源）+ 移除 `system.message` 桥接 + `session.create` 工作区归组）。
   改任何一端的 wire 行为必须先改契约，三方同步。
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
