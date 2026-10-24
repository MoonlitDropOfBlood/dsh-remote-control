# AGENTS.md — relay/（中继服务器）

WebSocket 哑管道：在 host 与 client 之间**只转发密文帧**，不理解任何业务。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md) §4；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构

```
server.js           单文件可跑（Node ≥20 + ws）；导出 createRelay/loadConfig 供测试注入
test/               node:test × 10（hello 校验/转发/离线缓存/顶替/限速/心跳/seq 透传）
scripts/smoke.mjs   端到端冒烟（npm run smoke）
README.md           部署文档（systemd + Caddy WSS 反代 + Docker）
Dockerfile          node:22-alpine，非 root
```

## 构建与验收

```bash
npm install && npm test        # 10/10 必须全绿
npm run smoke                  # 真实双端冒烟
PORT=8788 node server.js       # 本机起（联调常用 8788）
```

## 关键约定（改 server.js 前必读）

- **哑管道原则**：frame.data 只做 `typeof string` 校验，绝不解析/解码；
  seq 原样透传（含大数字）；sig 不校验（中继无密钥）。
- **sid 三处透传**：`sid`（发送端实例 id，契约 §4 v1.0.2）必须在**活转发、离线缓存、
  重连补发**三处都带上——只透传一处会让接收端 sid:seq 去重退化为裸 seq，
  误杀新连接 seq=1 的首帧（实测 bug）。
- **离线缓存**：256 条 / 24h，FIFO 丢旧；补发 urgent 优先、其余按 seq 升序。
- **同 channel 同 role 单活跃连接**：新顶旧（旧连接收 `error:replaced` + close 4001，
  对端不发 peer-joined/left，避免抖动）。
- 心跳：30s 无帧发 ping（应用层 + ws 协议层双发），90s 无消息判死；
  detach 必须幂等（不等异步 close 事件，保证重连看到干净状态）。
- 端口解析允许 `PORT=0`（内核随机端口，测试用）——`intFromEnv` 的 `>0` 判断曾把 0
  回落 8787 导致测试端口冲突（实测坑），portFromEnv 单独处理。
- 限速按 TCP 源地址（不读 header，防伪造）；反代同机部署会共享限速桶，README 有对策。
- **父进程看门狗（v1.1.1）**：以 `DSHRC_RELAY_PARENT_WATCHDOG=1` 启动时，中继会监听
  stdin 的 EOF——父进程（DSH 插件托管它）一旦退出，管道关闭 → 中继自己优雅 `stop()` 后退出，
  **不留孤儿进程**。手工 `node server.js` 不带该变量，行为完全不变。
  托管方见 `../plugin/lib/relay-supervisor.mjs`（只停自己 spawn 的那个 child handle，
  绝不按进程名/端口批量杀）。

## 部署

见 README.md：零公网部署跑在 PC 上即可（手机连 `ws://<PC-IP>:<port>`）；
公网部署用 systemd + Caddy 反代 WSS。RELAY_TOKEN 可选（配置后 hello 必须带 token）。
