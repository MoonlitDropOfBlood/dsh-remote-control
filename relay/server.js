#!/usr/bin/env node
/**
 * dsh-remote-control-relay —— 公网 WebSocket 中继服务器（哑管道）
 *
 * 严格实现协议契约 §4「传输层：中继帧协议」：
 *   docs/plans/2026-10-20-dsh-remote-control-protocol.md
 *
 * 中继只理解 hello / welcome / peer-joined / peer-left / frame / ping / pong / error；
 * frame.data 是端到端密文（base64），中继不解析、不理解、原样转发。
 *
 * 环境变量：
 *   PORT                    监听端口（默认 8787）
 *   RELAY_TOKEN             可选；配置后 hello 必须带匹配 token
 *   LOG_LEVEL               debug | info | warn | error | silent（默认 info）
 *   RELAY_HELLO_TIMEOUT_MS  hello 超时（默认 10000）
 *   RELAY_PING_INTERVAL_MS  无消息多久发一次心跳（默认 30000）
 *   RELAY_DEAD_TIMEOUT_MS   多久无任何消息判死（默认 90000）
 *   RELAY_HELLO_RATE_LIMIT  每 IP 每窗口最多 hello 数（默认 60）
 *   RELAY_HELLO_RATE_WINDOW_MS  限速窗口（默认 60000）
 *   RELAY_CACHE_LIMIT       离线缓存条数上限（默认 256，契约值）
 *   RELAY_CACHE_TTL_MS      离线缓存 TTL（默认 86400000 = 24h，契约值）
 *   RELAY_MAX_PAYLOAD       单帧最大字节（默认 1048576 = 1MiB）
 */

import { WebSocketServer, WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量（契约 §4）
// ---------------------------------------------------------------------------

/** ch 必须匹配 ^[A-Z2-7]{16,64}$ */
export const CHANNEL_RE = /^[A-Z2-7]{16,64}$/;
export const ROLES = /** @type {const} */ (['host', 'client']);

const DEFAULTS = {
  port: 8787,
  token: null,
  logLevel: 'info',
  helloTimeoutMs: 10_000, // 连接后 10s 内必须 hello，否则断开
  pingIntervalMs: 30_000, // 30s 无帧发 ping
  deadTimeoutMs: 90_000, // 90s 无任何消息判死
  helloRateLimit: 60, // 每 IP 每分钟 ≤60 个 hello
  helloRateWindowMs: 60_000,
  cacheLimit: 256, // 离线缓存 256 条
  cacheTtlMs: 24 * 3600 * 1000, // 24h
  maxPayload: 1024 * 1024, // 1MiB（密文帧一般很小；防御性上限）
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function makeLogger(levelName) {
  const level = LEVELS[String(levelName).toLowerCase()] ?? LEVELS.info;
  const fmt = (tag, args) => {
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`${ts} ${tag} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  };
  return {
    level,
    debug: (...a) => level <= LEVELS.debug && fmt('DEBUG', a),
    info: (...a) => level <= LEVELS.info && fmt('INFO ', a),
    warn: (...a) => level <= LEVELS.warn && fmt('WARN ', a),
    error: (...a) => level <= LEVELS.error && fmt('ERROR', a),
  };
}

function intFromEnv(env, name, def) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** PORT 专用解析：允许 0（内核分配临时端口，测试用） */
function portFromEnv(env) {
  const v = env.PORT;
  if (v === undefined || v === '') return DEFAULTS.port;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS.port;
}

/** 从环境变量读配置（测试可直接传对象覆盖） */
export function loadConfig(env = process.env) {
  return {
    port: portFromEnv(env),
    token: env.RELAY_TOKEN || DEFAULTS.token,
    logLevel: env.LOG_LEVEL || DEFAULTS.logLevel,
    helloTimeoutMs: intFromEnv(env, 'RELAY_HELLO_TIMEOUT_MS', DEFAULTS.helloTimeoutMs),
    pingIntervalMs: intFromEnv(env, 'RELAY_PING_INTERVAL_MS', DEFAULTS.pingIntervalMs),
    deadTimeoutMs: intFromEnv(env, 'RELAY_DEAD_TIMEOUT_MS', DEFAULTS.deadTimeoutMs),
    helloRateLimit: intFromEnv(env, 'RELAY_HELLO_RATE_LIMIT', DEFAULTS.helloRateLimit),
    helloRateWindowMs: intFromEnv(env, 'RELAY_HELLO_RATE_WINDOW_MS', DEFAULTS.helloRateWindowMs),
    cacheLimit: intFromEnv(env, 'RELAY_CACHE_LIMIT', DEFAULTS.cacheLimit),
    cacheTtlMs: intFromEnv(env, 'RELAY_CACHE_TTL_MS', DEFAULTS.cacheTtlMs),
    maxPayload: intFromEnv(env, 'RELAY_MAX_PAYLOAD', DEFAULTS.maxPayload),
  };
}

const otherRole = (role) => (role === 'host' ? 'client' : 'host');

// ---------------------------------------------------------------------------
// 中继核心
// ---------------------------------------------------------------------------

/**
 * 创建中继（不监听端口，由 start() 启动）。测试可注入 config 覆盖默认值。
 *
 * 连接表结构：
 *   channels: Map<ch, Channel>
 *   Channel  = { conns: { host: Conn|null, client: Conn|null },
 *                cache: { host: CachedFrame[], client: CachedFrame[] },
 *                cleanupTimer }
 *   Conn     = { ws, ip, role, ch, helloDone, lastRecvAt, lastSentAt, helloTimer }
 *   CachedFrame = { seq, data, urgent, at }
 */
export function createRelay(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const log = makeLogger(cfg.logLevel);

  /** @type {Map<string, any>} */
  const channels = new Map();
  /** @type {Set<any>} */
  const conns = new Set();
  /** ip -> { start, count } */
  const rateBuckets = new Map();

  // ---- 限速：每 IP 每窗口 ≤ helloRateLimit 个 hello -------------------------
  function takeHelloSlot(ip) {
    const now = Date.now();
    let b = rateBuckets.get(ip);
    if (!b || now - b.start >= cfg.helloRateWindowMs) {
      b = { start: now, count: 0 };
      rateBuckets.set(ip, b);
    }
    b.count += 1;
    return b.count <= cfg.helloRateLimit;
  }

  // ---- 发送 -----------------------------------------------------------------
  function sendJson(conn, obj) {
    if (conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(obj));
      conn.lastSentAt = Date.now();
      return true;
    } catch (err) {
      log.warn('send failed', { err: String(err && err.message) });
      return false;
    }
  }

  function sendErrorClose(conn, code, message, closeCode = 1008) {
    sendJson(conn, { t: 'error', code, message });
    try {
      conn.ws.close(closeCode, `${code}: ${message}`);
    } catch {
      /* ignore */
    }
  }

  // ---- 通道 -----------------------------------------------------------------
  function getChannel(ch) {
    let c = channels.get(ch);
    if (!c) {
      c = { conns: { host: null, client: null }, cache: { host: [], client: [] }, cleanupTimer: null };
      channels.set(ch, c);
    }
    if (c.cleanupTimer) {
      clearTimeout(c.cleanupTimer);
      c.cleanupTimer = null;
    }
    return c;
  }

  /** 把发往 targetRole 的帧转发或缓存 */
  function deliverFrame(channel, targetRole, out) {
    const target = channel.conns[targetRole];
    if (target && target.ws.readyState === WebSocket.OPEN) {
      sendJson(target, out);
      return true;
    }
    // 对端不在线 → 离线缓存：256 条 / 24h，FIFO 丢旧
    const q = channel.cache[targetRole];
    q.push({ sid: out.sid, seq: out.seq, data: out.data, urgent: out.urgent === true, at: Date.now() });
    while (q.length > cfg.cacheLimit) q.shift(); // FIFO 丢最旧
    while (q.length && Date.now() - q[0].at > cfg.cacheTtlMs) q.shift(); // 过期清理（队首最旧）
    log.debug('cached frame', { targetRole, seq: out.seq, queued: q.length });
    return false;
  }

  /** 对端重连后补发缓存：urgent 优先，其余按 seq 升序 */
  function flushCache(channel, targetRole, targetConn) {
    const q = channel.cache[targetRole];
    if (!q.length) return 0;
    channel.cache[targetRole] = [];
    const now = Date.now();
    const live = q.filter((f) => now - f.at <= cfg.cacheTtlMs);
    live.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || a.seq - b.seq);
    const from = otherRole(targetRole);
    for (const f of live) {
      const out = { t: 'frame', from, seq: f.seq, data: f.data };
      if (typeof f.sid === 'string' && f.sid !== '') out.sid = f.sid;
      if (f.urgent) out.urgent = true;
      sendJson(targetConn, out);
    }
    if (live.length) log.info('flushed offline cache', { role: targetRole, count: live.length });
    return live.length;
  }

  // ---- hello ----------------------------------------------------------------
  function handleHello(conn, msg) {
    const ip = conn.ip;
    if (!takeHelloSlot(ip)) {
      log.warn('hello rate limited', { ip });
      sendErrorClose(conn, 'rate-limited', `too many hello from ${ip}`, 1008);
      return;
    }
    const role = msg && msg.role;
    const ch = msg && msg.ch;
    if (role !== 'host' && role !== 'client') {
      log.warn('bad hello: role', { ip, role });
      sendErrorClose(conn, 'bad-hello', 'role must be "host" or "client"');
      return;
    }
    if (typeof ch !== 'string' || !CHANNEL_RE.test(ch)) {
      log.warn('bad hello: ch', { ip, ch });
      sendErrorClose(conn, 'bad-hello', 'ch must match ^[A-Z2-7]{16,64}$');
      return;
    }
    if (cfg.token !== null && (!msg || msg.token !== cfg.token)) {
      log.warn('bad hello: token', { ip, ch });
      sendErrorClose(conn, 'bad-hello', 'invalid or missing token');
      return;
    }
    // 注：sig 字段是端到端 HMAC 握手证明（契约 §3.4），中继无密钥材料，只透传不校验。

    clearTimeout(conn.helloTimer);
    conn.helloDone = true;
    conn.role = role;
    conn.ch = ch;

    const channel = getChannel(ch);
    // 同 channel 同 role 单活跃连接：新顶旧
    const old = channel.conns[role];
    channel.conns[role] = conn;
    if (old && old !== conn && old.ws.readyState === WebSocket.OPEN) {
      log.info('replacing existing connection', { ch, role, oldIp: old.ip, newIp: conn.ip });
      sendJson(old, { t: 'error', code: 'replaced', message: `a new ${role} connection took over this channel` });
      try {
        old.ws.close(4001, 'replaced by a newer connection');
      } catch {
        /* ignore */
      }
      old.role = null;
      old.ch = null; // 防止它的 close 清理逻辑误删新连接 / 误发 peer-left（detachFromChannel 幂等跳过）
    }

    sendJson(conn, {
      t: 'welcome',
      peers: { host: channel.conns.host !== null, client: channel.conns.client !== null },
    });

    // 仅在该 role 真正「新上线」时通知对端；顶替场景对端视角无变化，不发 peer-joined
    if (!old) {
      const peerConn = channel.conns[otherRole(role)];
      if (peerConn) sendJson(peerConn, { t: 'peer-joined', role });
    }

    flushCache(channel, role, conn);
    log.info('hello ok', { ch, role, ip: conn.ip, peers: { host: channel.conns.host !== null, client: channel.conns.client !== null } });
  }

  // ---- 帧分发 ---------------------------------------------------------------
  function handleMessage(conn, raw, isBinary) {
    conn.lastRecvAt = Date.now();
    if (isBinary) return; // 协议只用文本帧；二进制帧忽略（哑管道不做猜测）

    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      if (!conn.helloDone) {
        log.warn('first message not JSON', { ip: conn.ip });
        sendErrorClose(conn, 'bad-hello', 'first message must be a hello JSON object');
      } else {
        log.debug('ignoring non-JSON message', { ip: conn.ip });
      }
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      if (!conn.helloDone) {
        log.warn('first message malformed', { ip: conn.ip });
        sendErrorClose(conn, 'bad-hello', 'first message must be a hello JSON object');
      }
      return;
    }

    if (!conn.helloDone) {
      if (msg.t === 'hello') handleHello(conn, msg);
      else {
        log.warn('first message not hello', { ip: conn.ip, t: msg.t });
        sendErrorClose(conn, 'bad-hello', 'first message must be hello');
      }
      return;
    }

    switch (msg.t) {
      case 'hello':
        // 已经 hello 过 → 忽略（哑管道，不升级为错误）
        return;
      case 'frame': {
        const { seq, data, urgent, sid } = msg;
        // 只做传输层形状校验；不解析 base64 内容（端到端密文）
        if (typeof seq !== 'number' || !Number.isFinite(seq) || typeof data !== 'string') {
          log.debug('ignoring malformed frame', { ip: conn.ip, seq: typeof seq });
          return;
        }
        const channel = channels.get(conn.ch);
        if (!channel) return;
        const out = { t: 'frame', from: conn.role, seq, data };
        // v1.0.2：sid（发送端实例 id）不透明透传，接收端做 sid:seq 去重
        if (typeof sid === 'string' && sid !== '') out.sid = sid;
        if (urgent === true) out.urgent = true;
        deliverFrame(channel, otherRole(conn.role), out);
        return;
      }
      case 'ping':
        sendJson(conn, { t: 'pong' });
        return;
      case 'pong':
        return; // 仅作为活性证据（lastRecvAt 已更新）
      default:
        log.debug('ignoring unknown message type', { ip: conn.ip, t: msg.t });
        return;
    }
  }

  // ---- 连接生命周期 ---------------------------------------------------------
  /** 从通道连接表摘除（幂等）；对端在线则通知 peer-left；空通道挂 TTL 清理 */
  function detachFromChannel(conn, closeCode, closeReason) {
    if (!conn.ch) return;
    const ch = conn.ch;
    const role = conn.role;
    conn.ch = null;
    conn.role = null;
    const channel = channels.get(ch);
    if (!channel) return;
    if (channel.conns[role] !== conn) return; // 已被新连接顶掉
    channel.conns[role] = null;
    const peerConn = channel.conns[otherRole(role)];
    if (peerConn) sendJson(peerConn, { t: 'peer-left', role });
    log.info('peer left', { ch, role, ip: conn.ip, code: closeCode, reason: closeReason });
    if (!channel.conns.host && !channel.conns.client) {
      // 双方都下线：保留缓存至 TTL，到期后删除整个通道
      channel.cleanupTimer = setTimeout(() => {
        const c = channels.get(ch);
        if (c && !c.conns.host && !c.conns.client) channels.delete(ch);
      }, cfg.cacheTtlMs);
      channel.cleanupTimer.unref?.();
    }
  }

  function onConnection(ws, req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const conn = {
      ws,
      ip,
      role: null,
      ch: null,
      helloDone: false,
      lastRecvAt: Date.now(),
      lastSentAt: Date.now(),
      helloTimer: null,
    };
    conns.add(conn);
    log.info('connection open', { ip, conns: conns.size });

    conn.helloTimer = setTimeout(() => {
      if (!conn.helloDone) {
        log.warn('hello timeout', { ip });
        try {
          conn.ws.close(4008, 'hello timeout');
        } catch {
          /* ignore */
        }
      }
    }, cfg.helloTimeoutMs);
    conn.helloTimer.unref?.();

    ws.on('message', (data, isBinary) => handleMessage(conn, data, isBinary));
    ws.on('pong', () => {
      conn.lastRecvAt = Date.now(); // ws 协议层 pong 也是活性证据
    });
    ws.on('ping', () => {
      conn.lastRecvAt = Date.now();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.pong();
        } catch {
          /* ignore */
        }
      }
    });
    ws.on('error', (err) => log.debug('socket error', { ip, err: String(err && err.message) }));
    ws.on('close', (code, reasonBuf) => {
      clearTimeout(conn.helloTimer);
      conns.delete(conn);
      detachFromChannel(conn, code, reasonBuf?.toString());
    });
  }

  // ---- 心跳巡检 -------------------------------------------------------------
  const sweepEveryMs = Math.max(50, Math.min(cfg.pingIntervalMs, cfg.deadTimeoutMs) / 2);
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const conn of [...conns]) {
      if (now - conn.lastRecvAt > cfg.deadTimeoutMs) {
        log.warn('peer dead (no message within timeout)', { ip: conn.ip, role: conn.role, ch: conn.ch, deadTimeoutMs: cfg.deadTimeoutMs });
        // 立即从连接表摘除（不等异步 close 事件），保证快速重连看到干净状态
        clearTimeout(conn.helloTimer);
        detachFromChannel(conn, 4002, 'heartbeat timeout');
        conns.delete(conn);
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (now - conn.lastSentAt >= cfg.pingIntervalMs) {
        sendJson(conn, { t: 'ping' }); // 应用层心跳
        try {
          conn.ws.ping(); // ws 协议层 ping 同步发，穿透中间设备
          conn.lastSentAt = now;
        } catch {
          /* ignore */
        }
      }
    }
    // 限速桶回收，防 Map 泄漏
    for (const [ip, b] of rateBuckets) {
      if (now - b.start >= cfg.helloRateWindowMs * 2) rateBuckets.delete(ip);
    }
  }, sweepEveryMs);
  sweepTimer.unref?.();

  // ---- 启停 -----------------------------------------------------------------
  let wss = null;
  function start() {
    wss = new WebSocketServer({ port: cfg.port, host: '0.0.0.0', maxPayload: cfg.maxPayload });
    wss.on('connection', onConnection);
    wss.on('error', (err) => log.error('server error', { err: String(err && err.message) }));
    return new Promise((resolve, reject) => {
      wss.once('listening', () => {
        const addr = wss.address();
        // 机器可读启动行（测试脚本依赖此行解析实际端口）
        console.log(`relay listening port=${addr.port}`);
        log.info('relay started', { port: addr.port, tokenRequired: cfg.token !== null });
        resolve(addr.port);
      });
      wss.once('error', reject);
    });
  }

  function stop() {
    clearInterval(sweepTimer);
    for (const conn of [...conns]) {
      clearTimeout(conn.helloTimer);
      try {
        conn.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    conns.clear();
    channels.clear();
    rateBuckets.clear();
    return new Promise((resolve) => {
      if (!wss) return resolve();
      wss.close(() => resolve());
    });
  }

  return { cfg, log, channels, conns, rateBuckets, start, stop };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const relay = createRelay();
  relay
    .start()
    .then((port) => {
      relay.log.info(`dsh-remote-control-relay listening on ws://0.0.0.0:${port} (pid ${process.pid})`);
    })
    .catch((err) => {
      relay.log.error('failed to start', { err: String(err && err.message) });
      process.exit(1);
    });
  // 停止是**幂等**的：POSIX 上父进程可能同时发 SIGTERM 与 stdin 的 shutdown 命令，
  // 两条路径都会走到这里 → 只执行一次真正的 stop()。
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    relay.log.info(`received ${sig}, shutting down`);
    relay.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 父进程看门狗（仅当插件以 DSHRC_RELAY_PARENT_WATCHDOG=1 托管本进程时启用）：
  // 父进程用 stdio 的 stdin 管道 spawn 本进程，父进程一旦退出管道即 EOF →
  // 这里收到 'end' 就优雅关停，避免 DSH 崩溃/被杀后留下孤儿中继。
  // 手工 `node server.js` 启动时该变量不存在，行为完全不变。
  //
  // 另支持父进程经 stdin 下 `shutdown` 命令做**优雅停止**：
  // Windows 上 child.kill('SIGTERM') 是硬杀（不走 signal handler），
  // 所以插件优先走这条命令通道，让中继自己 close 掉 ws 连接（手机端看到正常 close 而非 RST）。
  if (process.env.DSHRC_RELAY_PARENT_WATCHDOG === '1' && process.stdin) {
    let buf = '';
    process.stdin.on('data', (chunk) => {
      buf += String(chunk);
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === 'shutdown') {
          shutdown('shutdown command');
          return;
        }
        idx = buf.indexOf('\n');
      }
    });
    process.stdin.on('end', () => {
      shutdown('parent process gone');
    });
    // 不让 stdin 保持活跃引用拖住事件循环退出
    process.stdin.resume();
  }
}
