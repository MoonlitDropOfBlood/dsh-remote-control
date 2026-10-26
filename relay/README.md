# @duke-dsh-plugins/dsh-remote-control-relay

dsh-remote-control 的**公网 WebSocket 中继服务器**（哑管道）。
实现协议契约 §4「传输层：中继帧协议」的全部语义，负责把两个出站 WebSocket 客户端
（PC 上的 DSH 插件 `host`、手机上的 HarmonyOS App `client`）按 channel 配对并互相转发帧。

> 中继**不理解也不解析** `frame.data` —— 那是端到端 AES-256-GCM 密文（契约 §5–§7）。
> 中继被攻破也读不到会话内容。协议契约：`docs/plans/2026-10-20-dsh-remote-control-protocol.md`。

## 协议速览（契约 §4）

每个 WebSocket **文本帧**是一条 JSON 消息：

| 方向 | 消息 | 字段 |
|---|---|---|
| peer→relay | `hello` | `{t, role:"host"\|"client", ch, sig, token?}` —— 连接后 10s 内必须发送 |
| relay→peer | `welcome` | `{t, peers:{host:bool, client:bool}}` |
| relay→peer | `peer-joined` / `peer-left` | `{t, role}` |
| peer→relay | `frame` | `{t, seq(number), data(base64 密文), urgent?}` |
| relay→peer | `frame` | `{t, from, seq, data}`（原样转发，seq/data 不变） |
| 双向 | `ping` / `pong` | `{t}` 应用层心跳（30s 无帧即发；90s 无任何消息判死） |
| relay→peer | `error` | `{t, code, message}` |

规则：

- `ch` 必须匹配 `^[A-Z2-7]{16,64}$`；同一 channel 同一 role 只允许一个活跃连接（**新连接顶掉旧连接**，旧连接收到
  `error{code:"replaced"}` 后以 4001 关闭）。
- 对端不在线时缓存发往该端的 `frame`：**256 条 / 24h，FIFO 丢旧**；重连后补发，`urgent` 帧优先，其余按 `seq` 升序。
- `sig` 是端到端 HMAC 握手证明（契约 §3.4）；中继没有密钥材料，**只透传不校验**。
- `error.code` 取值：契约定义的 `bad-hello` / `rate-limited` / `channel-full`，外加顶替场景的 `replaced`
  （契约顶替语义要求「旧连接发 error 后关闭」，`replaced` 是其具象化；`channel-full` v1 不产生——
  单 host+client 模型下顶替语义取代了它，保留以兼容客户端）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `RELAY_TOKEN` | （空=不校验） | 配置后 `hello` 必须带匹配 `token` 字段，否则 `error bad-hello` 并断开 |
| `RELAY_TLS_CERT` | （空=明文） | PEM 证书链**文件路径**；与 `RELAY_TLS_KEY` 同时设置才生效 → 提供 `wss://` |
| `RELAY_TLS_KEY` | （空=明文） | PEM 私钥**文件路径**；只配一个 / 读不到 / 证书非法 → **启动即失败**（不降级明文） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `RELAY_HELLO_TIMEOUT_MS` | `10000` | 连接后多久内必须 hello，超时断开 |
| `RELAY_PING_INTERVAL_MS` | `30000` | 无消息多久发一次心跳（应用层 ping + ws 协议 ping） |
| `RELAY_DEAD_TIMEOUT_MS` | `90000` | 多久无任何消息（含 ws pong）判死并清理 |
| `RELAY_HELLO_RATE_LIMIT` | `60` | 每 IP 每窗口允许的 hello 数（超限 → `error rate-limited` + 断开） |
| `RELAY_HELLO_RATE_WINDOW_MS` | `60000` | 限速窗口 |
| `RELAY_CACHE_LIMIT` | `256` | 离线缓存条数上限（契约值，一般不用改） |
| `RELAY_CACHE_TTL_MS` | `86400000` | 离线缓存 TTL（24h，契约值） |
| `RELAY_MAX_PAYLOAD` | `1048576` | 单 WebSocket 帧最大字节（1 MiB） |

## 本地运行

要求 Node.js ≥ 20。

```bash
npm install
npm start          # 双栈监听：ws://<IPv4>:8787 与 ws://[<IPv6>]:8787 都可用
PORT=9000 RELAY_TOKEN=$(openssl rand -hex 16) npm start

npm test           # node:test 全量测试（16 项）
npm run smoke      # 本机端到端 smoke：hello→frame 互转→断线→离线补发
```

## 监听地址：IPv4 / IPv6 双栈

中继默认绑定 **`::`（IPv6 通配地址，Node 默认 `ipv6Only=false`）** —— 一次绑定同时接收
IPv6 与 IPv4（IPv4 以 `::ffff:a.b.c.d` 映射形式进来）：

| 客户端 | 连接地址示例 |
|---|---|
| IPv4（同机/局域网） | `ws://127.0.0.1:8787` / `ws://192.168.1.2:8787` |
| IPv6（同机 loopback） | `ws://[::1]:8787` |
| IPv6（本机公网地址，手机直连） | `ws://[2001:db8::1234]:8787`（文档示例，使用时替换为实际地址） |

要点：

- **IPv6 字面量必须带方括号**：`ws://[<IPv6>]:<port>`，否则 URL 解析会失败。
- 若本机系统**禁用了 IPv6**（`EAFNOSUPPORT` / `EADDRNOTAVAIL` / `EINVAL`），
  中继会**自动回落到 `0.0.0.0`**（仅 IPv4，行为与旧版一致）并在日志里打一条
  `ipv6 listen unavailable, falling back to ipv4-only` 警告；端口占用等其它错误照旧直接失败。
- 端口占用（`EADDRINUSE`）**不会**触发回落 —— 仍按原行为报错退出。
- 监听候选顺序可在代码层覆盖（测试用）：`createRelay({ listenHosts: ['0.0.0.0'] })`；
  不通过环境变量暴露，避免误改线上行为。
- 双栈下 IPv4 客户端的对端地址会显示为 `::ffff:127.0.0.1`，中继会**归一为 `127.0.0.1`**
  再用于 hello 限速分桶与日志 —— 与旧版（IPv4-only 监听）行为一致，不会绕过限速。
- 手机直连公网 IPv6 还需要**放行主机防火墙**（Windows Defender 防火墙入站规则），
  以及运营商/路由器允许入站 IPv6；中继只管监听，不管网络可达性。

验证连通（需要先 `npm i -D ws` 的项目里或用 curl 检查端口）：

```bash
curl -i http://127.0.0.1:8787/   # 期望 426 Upgrade Required（HTTP 探测会拿到 WS 升级要求）
```

IPv6 连通自检（Node ≥ 20）：

```bash
node -e "const WebSocket=require('ws');const w=new WebSocket('ws://[::1]:8787');w.on('open',()=>{console.log('IPv6 OK');w.close()});w.on('error',e=>console.log('IPv6 FAIL',e.code))"
```

## 生产部署（VPS，systemd + Caddy 反代 WSS）

以 Ubuntu 22.04、域名 `relay.example.com` 为例。

### 1. 安装 Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # ≥ v20
```

### 2. 部署代码

```bash
sudo useradd --system --home /opt/relay --shell /usr/sbin/nologin relay
sudo mkdir -p /opt/relay
sudo cp -r dsh-remote-control-relay/. /opt/relay/
cd /opt/relay && sudo npm install --omit=dev
sudo chown -R relay:relay /opt/relay
```

### 3. 生成中继 token（强烈建议）

```bash
sudo -u relay openssl rand -hex 16
# 记下输出，填进下一步的 Environment=RELAY_TOKEN=…
```

### 4. systemd unit（`/etc/systemd/system/dsh-relay.service`）

```ini
[Unit]
Description=dsh-remote-control relay (WebSocket dumb pipe)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
Group=relay
WorkingDirectory=/opt/relay
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

Environment=PORT=8787
Environment=RELAY_TOKEN=CHANGE_ME_hex16
Environment=LOG_LEVEL=info

# 加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
ReadWritePaths=

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay
sudo systemctl status dsh-relay
journalctl -u dsh-relay -f        # 看日志
```

### 5. Caddy 反代 WSS（`/etc/caddy/Caddyfile`）

Caddy 自动签发/续期 TLS 证书，无需手动管理。

```
relay.example.com {
    reverse_proxy localhost:8787 {
        flush_interval -1          # 关键：WS 流式转发，禁用缓冲
    }
}
```

```bash
sudo apt install -y caddy
sudo systemctl reload caddy
```

客户端连接地址即 `wss://relay.example.com/`（路径无关，任何 path 都反代到中继）。

> 中继按 **TCP 源地址** 做 hello 限速（不读取任何请求 header，避免伪造）。注意：Caddy 与中继同机
> `reverse_proxy localhost:8787` 时，所有客户端在中继眼里都是 `127.0.0.1`，共享同一个限速桶
> （默认 60 hello/分钟，双端正常使用足够，多人共用一个中继会互相挤占）。两种处理：
>
> 1. **同机反代**：把 `RELAY_HELLO_RATE_LIMIT` 调大（如 `600`），滥用防护交给 Caddy 层（见下）；
> 2. 想按真实客户端 IP 限速，就让中继直接暴露在防火墙后自行限速（不经反代），TLS 用其他方式终止。

> Caddy 社区版没有内置按 IP 限速指令，可选方案：
>
> - 装 [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit) 插件（需自行编译 caddy），配置
>   `rate_limit` + `respond @overloaded 429`；
> - 或用 fail2ban / nftables 对 443 层的异常连接做封禁；
> - 或在前面再放一层 Nginx（`limit_req_zone` + `limit_conn`）。

### 6. TLS 说明

- **WSS（推荐）**：Caddy 自动 ACME 签发 Let's Encrypt 证书并续期，客户端用 `wss://`。
- 若不用 Caddy：Nginx `ssl_certificate`/`ssl_certificate_key` + `proxy_set_header Upgrade $http_upgrade`
  同样可行；或让 Node 直接持有证书——把 `server.js` 的 `WebSocketServer` 换成
  `new WebSocketServer({ server: httpsServer })`（需要自备 `https.createServer({key, cert})`，v1 未内置）。
- 只在可信网络/内网使用时可退化为明文 `ws://`，此时 **必须** 配置 `RELAY_TOKEN`。

### 7. Docker

```bash
docker build -t dsh-relay .
docker run -d --name dsh-relay -p 8787:8787 -e RELAY_TOKEN=$(openssl rand -hex 16) dsh-relay
```

镜像基于 `node:22-alpine`，以非 root 用户 `node` 运行，`PORT` 仍可用环境变量覆盖（容器内建议保持 8787 并映射端口）。

> **IPv6 提示**：中继进程内部是双栈监听，但 Docker 的 `-p 8787:8787` 只在宿主机的
> IPv4 上发布（除非 daemon 侧开启 IPv6 端口发布）。需要让手机直连宿主 IPv6 时，
> 可改用 `--network host`（Linux）或在 daemon 侧启用 IPv6 发布。

## 安全注意事项

- **中继只见密文**：`frame.data` 是端到端 AES-256-GCM 密文，中继不持有密钥、不解析内容；
  但中继仍能看到**元数据**：channel、role、帧序号、帧大小与时间节奏。
- **仍存在流量/滥用风险**：任何人都可以连上中继、向任意 channel 灌流量（虽然没有配对 secret
  就无法解密，对方也收不到有意义的内容）。因此：
  - **强烈建议设置 `RELAY_TOKEN`**——所有客户端 `hello` 携带同一 token，挡住未授权使用；
  - **务必开防火墙**（如 `ufw allow 443/tcp && ufw enable`），只暴露 Caddy 的 443；
  - 限速按 IP（默认 60 hello/分钟）只是第一道闸，反代层再加请求速率限制更稳；
  - channel 是 16+ 位 Crockford base32 随机串（约 80 bit 熵），被枚举命中的概率可忽略；
  - 不要在日志里打印 `frame.data`（本实现只在 `debug` 级别打印帧序号，从不打印 data）。
- **中继被攻破的最坏后果**：拒绝服务（不转发/篡改帧序导致断流）、观察元数据；
  读不到会话内容——这正是端到端加密的意义。插件/手机端仍应把 `sig`（HMAC 握手证明）实现好，
  将来可平滑升级为中继侧强制校验。

## 目录结构

```
dsh-remote-control-relay/
├── package.json          # name: @duke-dsh-plugins/dsh-remote-control-relay, dep: ws
├── server.js             # 中继实现（单文件可跑：node server.js）
├── Dockerfile            # node:22-alpine，非 root 运行
├── README.md
├── scripts/
│   └── smoke.mjs         # 本机端到端 smoke（npm run smoke）
└── test/
    ├── helpers.mjs       # 起真实子进程 + 带消息缓冲的 ws Peer
    ├── raw-socket.mjs    # 原始 TCP WS 客户端（永不 pong，用于心跳判死测试）
    ├── relay.test.mjs    # 10 项 node:test 测试
    └── ipv6.test.mjs     # 6 项双栈测试（IPv4/IPv6 同端口共存、IPv6 loopback、跨族转发、回落）
```

## npm 安装（v1.1.3 起）

```bash
npm install -g @duke-dsh-plugins/dsh-remote-control-relay
dsh-remote-control-relay            # = node server.js（PORT 默认 8787）
# 或作为依赖引入：require/import 后自起 createRelay()（见 server.js 导出）
```

环境变量与部署方式见上文（`RELAY_TOKEN` / `RELAY_TLS_CERT` / `RELAY_TLS_KEY`）。
