/**
 * 中继**双栈监听**测试（IPv4 + IPv6）：
 *  1. 同一端口同时接受 IPv4 与 IPv6 连接（监听地址为 '::'，Node 默认 ipv6Only=false）
 *  2. IPv6 loopback（ws://[::1]:port）端到端：hello → welcome → frame 转发
 *  3. IPv6 ↔ IPv4 跨协议族转发（host 走 IPv6、client 走 IPv4）
 *  4. IPv4 回归：ws://127.0.0.1 仍然可连可转（旧行为不变）
 *
 * 环境限制说明：若本机 OS 不支持 IPv6 loopback（::1 不可用），
 * 前两/三个用例会 **skip**（并在输出里说明原因），而不是假装通过；
 * 若 OS 支持 IPv6 但中继没绑上 '::'（回落到 IPv4-only），用例**必须失败**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer, Peer } from './helpers.mjs';
import { createRelay } from '../server.js';

const CH = 'ABCDEFGH23452345';

/** 本机是否支持 IPv6 loopback（能否在 ::1 上 listen） */
async function ipv6LoopbackAvailable() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    srv.once('error', (err) => done({ ok: false, code: err.code }));
    srv.listen(0, '::1', () => {
      const addr = srv.address();
      srv.close(() => done({ ok: true, port: addr.port }));
    });
  });
}

test('双栈监听：同一端口同时接受 IPv4 与 IPv6 连接', async (t) => {
  const cap = await ipv6LoopbackAvailable();
  if (!cap.ok) {
    t.skip(`本机不支持 IPv6 loopback（${cap.code}），跳过双栈实测`);
    return;
  }

  // LOG_LEVEL=info 以便断言启动日志里的 dualStack 标记
  const srv = await startServer({ LOG_LEVEL: 'info' });
  try {
    // 启动日志：机器可读行保持 `relay listening port=NNN`，另带 dualStack 标记
    assert.match(srv.output(), /relay listening port=\d+/);
    await srv.waitForOutput(/"dualStack":true/);
    assert.match(srv.output(), /"dualStack":true/, '应以双栈（host=::）启动');

    const v4 = await Peer.open(`ws://127.0.0.1:${srv.port}`, { role: 'host', ch: CH });
    const w4 = await v4.waitForType('welcome');
    assert.deepEqual(w4.peers, { host: true, client: false });

    const v6 = await Peer.open(`ws://[::1]:${srv.port}`, { role: 'client', ch: CH });
    const w6 = await v6.waitForType('welcome');
    assert.deepEqual(w6.peers, { host: true, client: true });

    // 已在线的 IPv4 host 收到 IPv6 client 的 peer-joined
    const joined = await v4.waitForType('peer-joined');
    assert.equal(joined.role, 'client');
  } finally {
    await srv.kill();
  }
});

test('IPv6 loopback 端到端：ws://[::1]:port 可 hello → welcome → frame 转发', async (t) => {
  const cap = await ipv6LoopbackAvailable();
  if (!cap.ok) {
    t.skip(`本机不支持 IPv6 loopback（${cap.code}），跳过 IPv6 实测`);
    return;
  }

  const srv = await startServer();
  try {
    const url6 = `ws://[::1]:${srv.port}`;
    const host = await Peer.open(url6, { role: 'host', ch: CH });
    const w = await host.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false });

    const client = await Peer.open(url6, { role: 'client', ch: CH });
    await client.waitForType('welcome');
    await host.waitForType('peer-joined');

    // 双向 frame 转发（IPv6 → IPv6）
    client.send({ t: 'frame', seq: 1, data: 'aXY2' });
    const f1 = await host.waitForType('frame');
    assert.equal(f1.from, 'client');
    assert.equal(f1.seq, 1);
    assert.equal(f1.data, 'aXY2');

    host.send({ t: 'frame', seq: 2, data: 'eHl6', urgent: true });
    const f2 = await client.waitForType('frame');
    assert.equal(f2.from, 'host');
    assert.equal(f2.seq, 2);
    assert.equal(f2.data, 'eHl6');
    assert.equal(f2.urgent, true);

    // 应用层心跳
    client.send({ t: 'ping' });
    const pong = await client.waitForType('pong');
    assert.equal(pong.t, 'pong');
  } finally {
    await srv.kill();
  }
});

test('跨协议族转发：host 走 IPv6、client 走 IPv4（同一端口）', async (t) => {
  const cap = await ipv6LoopbackAvailable();
  if (!cap.ok) {
    t.skip(`本机不支持 IPv6 loopback（${cap.code}），跳过跨族转发实测`);
    return;
  }

  const srv = await startServer();
  try {
    const host = await Peer.open(`ws://[::1]:${srv.port}`, { role: 'host', ch: CH });
    await host.waitForType('welcome');
    const client = await Peer.open(`ws://127.0.0.1:${srv.port}`, { role: 'client', ch: CH });
    await client.waitForType('welcome');

    client.send({ t: 'frame', seq: 42, data: 'Y3Jvcw==' });
    const f1 = await host.waitForType('frame');
    assert.equal(f1.from, 'client');
    assert.equal(f1.seq, 42);
    assert.equal(f1.data, 'Y3Jvcw==');

    host.send({ t: 'frame', seq: 43, data: 'Y3Jvcw==' });
    const f2 = await client.waitForType('frame');
    assert.equal(f2.from, 'host');
    assert.equal(f2.seq, 43);
  } finally {
    await srv.kill();
  }
});

test('IPv4 回归：ws://127.0.0.1 仍可连接并转发（旧行为不变）', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(`ws://127.0.0.1:${srv.port}`, { role: 'host', ch: CH });
    await host.waitForType('welcome');
    const client = await Peer.open(`ws://127.0.0.1:${srv.port}`, { role: 'client', ch: CH });
    await client.waitForType('welcome');

    client.send({ t: 'frame', seq: 7, data: 'Zm9v' });
    const f = await host.waitForType('frame');
    assert.equal(f.seq, 7);
    assert.equal(f.data, 'Zm9v');
  } finally {
    await srv.kill();
  }
});

test('对照：仅 IPv4 监听（listenHosts=["0.0.0.0"]）时 IPv6 连不上 —— 证明 IPv6 可连确实来自 "::" 绑定', async (t) => {
  const cap = await ipv6LoopbackAvailable();
  if (!cap.ok) {
    t.skip(`本机不支持 IPv6 loopback（${cap.code}），跳过对照用例`);
    return;
  }
  // 进程内起中继（无子进程，端口 0 由内核分配）
  const relay = createRelay({ port: 0, logLevel: 'silent', listenHosts: ['0.0.0.0'] });
  const port = await relay.start();
  try {
    assert.equal(relay.listenHost, '0.0.0.0');

    const v4 = await Peer.open(`ws://127.0.0.1:${port}`, { role: 'host', ch: CH });
    await v4.waitForType('welcome');

    // IPv6 loopback 必须连不上（否则说明它其实也绑了 '::'）
    await assert.rejects(
      () => Peer.open(`ws://[::1]:${port}`, { role: 'client', ch: CH }),
      (err) => {
        assert.match(String(err && err.code), /ECONNREFUSED|EADDRNOTAVAIL|EAFNOSUPPORT|ECONNRESET/);
        return true;
      },
    );
  } finally {
    await relay.stop();
  }
});

test('回落路径：首选监听地址不可用（EADDRNOTAVAIL）→ 自动回落到 IPv4 并正常服务', async () => {
  // 192.0.2.1 是 TEST-NET-1，本机没有该地址 → listen 报 EADDRNOTAVAIL
  const relay = createRelay({ port: 0, logLevel: 'silent', listenHosts: ['192.0.2.1', '0.0.0.0'] });
  const port = await relay.start();
  try {
    assert.equal(relay.listenHost, '0.0.0.0', '首选地址不可用时应回落到 0.0.0.0');
    const host = await Peer.open(`ws://127.0.0.1:${port}`, { role: 'host', ch: CH });
    await host.waitForType('welcome');
  } finally {
    await relay.stop();
  }
});
