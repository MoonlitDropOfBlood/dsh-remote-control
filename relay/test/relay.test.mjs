/**
 * dsh-remote-control-relay 测试（node:test + ws），覆盖契约 §4 全部语义：
 *  1. hello 校验（ch 格式 / role / token）与坏 hello 断开
 *  2. 双客户端（host + client）互通转发（含 seq / from / urgent 语义）
 *  3. 对端离线缓存：FIFO 256 条上限 + 重连补发（urgent 优先、按 seq 排序）
 *  4. 同 channel 同 role 新连接顶掉旧连接
 *  5. 每 IP hello 限速
 *  6. 心跳：30s 无帧发 ping（短参数验证）+ 超时判死清理
 *  7. seq 原样透传（中继不解析 frame.data 密文）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Peer } from './helpers.mjs';
import { RawSocket } from './raw-socket.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. hello 校验与坏 hello 断开
// ---------------------------------------------------------------------------

test('hello 校验通过返回 welcome，peers 状态与 peer-joined 通知正确', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345' });
    const w1 = await host.waitForType('welcome');
    assert.deepEqual(w1.peers, { host: true, client: false });

    const client = await Peer.open(srv.url, { role: 'client', ch: 'ABCDEFGH23452345' });
    const w2 = await client.waitForType('welcome');
    assert.deepEqual(w2.peers, { host: true, client: true });

    // 已在线的 host 收到 peer-joined
    const joined = await host.waitForType('peer-joined');
    assert.equal(joined.role, 'client');

  } finally {
    await srv.kill();
  }
});

test('坏 hello（ch 格式非法 / role 非法 / 首帧非 JSON）→ error bad-hello 并断开', async () => {
  const srv = await startServer();
  try {
    // ch 不匹配 ^[A-Z2-7]{16,64}$（小写 + 太短）
    const p1 = await Peer.open(srv.url, { role: 'host', ch: 'abcdefgh12345678' });
    const e1 = await p1.waitFor((m) => m.t === 'error');
    assert.equal(e1.code, 'bad-hello');
    await p1.waitClose();

    // ch 太短
    const p2 = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEF' });
    const e2 = await p2.waitFor((m) => m.t === 'error');
    assert.equal(e2.code, 'bad-hello');
    await p2.waitClose();

    // role 非法
    const p3 = await Peer.open(srv.url, { role: 'banana', ch: 'ABCDEFGH23452345' });
    const e3 = await p3.waitFor((m) => m.t === 'error');
    assert.equal(e3.code, 'bad-hello');
    await p3.waitClose();

    // 首帧不是 hello（发 frame）
    const p4 = await Peer.open(srv.url);
    p4.send({ t: 'frame', seq: 1, data: 'AAAA' });
    const e4 = await p4.waitFor((m) => m.t === 'error');
    assert.equal(e4.code, 'bad-hello');
    await p4.waitClose();

    // 首帧不是 JSON
    const p5 = await Peer.open(srv.url);
    p5.ws.send('not json at all');
    const e5 = await p5.waitFor((m) => m.t === 'error');
    assert.equal(e5.code, 'bad-hello');
    await p5.waitClose();
  } finally {
    await srv.kill();
  }
});

test('10s（测试用短参数）内不发 hello → 中继断开', async () => {
  const srv = await startServer({ RELAY_HELLO_TIMEOUT_MS: '300' });
  try {
    const p = await Peer.open(srv.url); // 不发 hello
    const info = await p.waitClose({ timeout: 3000 });
    assert.ok(info, 'should be closed');
    assert.equal(p.msgs.filter((m) => m.t === 'welcome').length, 0);
  } finally {
    await srv.kill();
  }
});

test('RELAY_TOKEN 配置后：缺 token → bad-hello；token 正确 → welcome', async () => {
  const srv = await startServer({ RELAY_TOKEN: 'sekrit-token' });
  try {
    const p1 = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345' }); // 无 token
    const e1 = await p1.waitFor((m) => m.t === 'error');
    assert.equal(e1.code, 'bad-hello');
    await p1.waitClose();

    const p2 = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345', token: 'wrong' });
    const e2 = await p2.waitFor((m) => m.t === 'error');
    assert.equal(e2.code, 'bad-hello');
    await p2.waitClose();

    const p3 = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345', token: 'sekrit-token' });
    const w = await p3.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false });
  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// 2 + 7. 双客户端互通转发 / seq 原样透传
// ---------------------------------------------------------------------------

test('host↔client 互通转发：frame 带 from，seq / data 原样透传', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345' });
    await host.waitForType('welcome');
    const client = await Peer.open(srv.url, { role: 'client', ch: 'ABCDEFGH23452345' });
    await client.waitForType('welcome');

    // client → host
    client.send({ t: 'frame', seq: 1, data: 'q1v2w3==' });
    const f1 = await host.waitForType('frame');
    assert.equal(f1.from, 'client');
    assert.equal(f1.seq, 1);
    assert.equal(f1.data, 'q1v2w3==');

    // host → client（urgent 标记透传；大 seq 原样）
    const bigData = Buffer.from('x'.repeat(300)).toString('base64');
    host.send({ t: 'frame', seq: 987654321, data: bigData, urgent: true });
    const f2 = await client.waitForType('frame');
    assert.equal(f2.from, 'host');
    assert.equal(f2.seq, 987654321);
    assert.equal(f2.data, bigData);
    assert.equal(f2.urgent, true);

    // 中继不解析密文：随便一段「乱码」base64 必须逐字节一致地过去
    const cipher = 'AAAA7777////++++';
    client.send({ t: 'frame', seq: 2, data: cipher });
    const f3 = await host.waitForType('frame');
    assert.equal(f3.data, cipher);
    assert.equal(f3.seq, 2);

    // ping/pong 应用层心跳
    client.send({ t: 'ping' });
    const pong = await client.waitForType('pong');
    assert.equal(pong.t, 'pong');

  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// 3. 离线缓存：FIFO 256 条上限 + 重连补发（urgent 优先）
// ---------------------------------------------------------------------------

test('对端不在线缓存：FIFO 256 条上限，重连按 seq 补发且 urgent 优先', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345' });
    await host.waitForType('welcome');
    // client 不在线，host 连发 300 帧；每 50 帧一个 urgent
    for (let seq = 1; seq <= 300; seq++) {
      host.send({ t: 'frame', seq, data: Buffer.from(`payload-${seq}`).toString('base64'), urgent: seq % 50 === 0 });
    }
    await sleep(300); // 让服务端处理完

    // client 重连 → 应收到 256 帧（FIFO 保留 seq 45..300），urgent（50..300 共 6 条）优先，其余按 seq 升序
    const client = await Peer.open(srv.url, { role: 'client', ch: 'ABCDEFGH23452345' });
    await client.waitForType('welcome');

    const got = [];
    const t0 = Date.now();
    while (got.length < 256 && Date.now() - t0 < 5000) {
      const f = await client.waitForType('frame', { timeout: 3000 });
      got.push(f);
    }

    const expected = [...Array(256)].map((_, i) => i + 45); // 45..300
    const expectedUrgent = [50, 100, 150, 200, 250, 300];
    const expectedRest = expected.filter((s) => !expectedUrgent.includes(s));
    assert.deepEqual(
      got.map((f) => f.seq),
      [...expectedUrgent, ...expectedRest],
      'urgent 优先补发，其余按 seq 升序；总数 256（FIFO 丢弃最旧的 seq 1..44）',
    );
    for (const f of got) {
      assert.equal(f.from, 'host');
      if (expectedUrgent.includes(f.seq)) assert.equal(f.urgent, true);
    }

    // 重连后在线转发恢复：host 再发一帧直接到达
    host.send({ t: 'frame', seq: 999, data: 'Zm9v' });
    const live = await client.waitForType('frame');
    assert.equal(live.seq, 999);

  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// 4. 同 role 新连接顶掉旧连接
// ---------------------------------------------------------------------------

test('同 channel 同 role 新连接顶掉旧连接（旧收 error replaced 后断开）', async () => {
  const srv = await startServer();
  try {
    const CH = 'ABCDEFGH23452345';
    const host1 = await Peer.open(srv.url, { role: 'host', ch: CH });
    await host1.waitForType('welcome');

    const client = await Peer.open(srv.url, { role: 'client', ch: CH });
    await client.waitForType('welcome');
    await host1.waitForType('peer-joined');

    // 第二个 host 顶掉第一个
    const host2 = await Peer.open(srv.url, { role: 'host', ch: CH });
    const w2 = await host2.waitForType('welcome');
    assert.deepEqual(w2.peers, { host: true, client: true });

    const err = await host1.waitFor((m) => m.t === 'error');
    assert.equal(err.code, 'replaced');
    const closed = await host1.waitClose();
    assert.equal(closed.code, 4001);

    // 对端视角：host 角色始终在线（不应收到 peer-left / peer-joined 抖动）
    await sleep(200);
    assert.equal(client.msgs.filter((m) => m.t === 'peer-left' || m.t === 'peer-joined').length, 0);

    // 转发走新连接
    client.send({ t: 'frame', seq: 7, data: 'Zm9v' });
    const f = await host2.waitForType('frame');
    assert.equal(f.seq, 7);
    assert.equal(f.from, 'client');

  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// 5. 每 IP hello 限速
// ---------------------------------------------------------------------------

test('每 IP 每分钟 hello 限速：超限 → error rate-limited 并断开', async () => {
  const srv = await startServer({ RELAY_HELLO_RATE_LIMIT: '3' });
  try {
    const CH = 'ABCDEFGH23452345';
    const ok = [];
    for (let i = 0; i < 3; i++) {
      const p = await Peer.open(srv.url, { role: 'host', ch: CH }); // 第 2、3 个会顶掉前一个
      await p.waitForType('welcome');
      ok.push(p);
    }
    const p4 = await Peer.open(srv.url, { role: 'host', ch: CH });
    const e = await p4.waitFor((m) => m.t === 'error');
    assert.equal(e.code, 'rate-limited');
    await p4.waitClose();
  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// 6. 心跳：ping 下发 + 超时判死
// ---------------------------------------------------------------------------

test('无消息时中继按间隔发应用层 ping + ws 协议 ping，回 pong 后保持连接', async () => {
  const srv = await startServer({ RELAY_PING_INTERVAL_MS: '150', RELAY_DEAD_TIMEOUT_MS: '10000' });
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: 'ABCDEFGH23452345' });
    await host.waitForType('welcome');

    let wsPings = 0;
    host.ws.on('ping', () => wsPings++);

    const ping1 = await host.waitForType('ping', { timeout: 2000 });
    assert.equal(ping1.t, 'ping');
    host.send({ t: 'pong' }); // 应用层 pong
    const ping2 = await host.waitForType('ping', { timeout: 2000 });
    assert.equal(ping2.t, 'ping');
    assert.ok(wsPings >= 1, 'should also send ws protocol-level ping');
    assert.equal(host.closed, false, '连接保持存活');

  } finally {
    await srv.kill();
  }
});

test('心跳超时判死：静默 peer 被服务端断开并清理出连接表', async () => {
  // 90s 判死用短参数验证同一逻辑；raw socket 对 ws/app 层 ping 完全不响应
  const srv = await startServer({ RELAY_PING_INTERVAL_MS: '100', RELAY_DEAD_TIMEOUT_MS: '400' });
  try {
    const CH = 'ABCDEFGH23452345';
    const raw = await RawSocket.connect(srv.port);
    raw.sendJson({ t: 'hello', role: 'client', ch: CH, sig: 'x' });
    assert.ok(await raw.readUntil('welcome', { timeout: 2000 }), 'hello 成功收到 welcome');

    // 完全静默 → 服务端应在 deadTimeout 后判死断开
    assert.ok(await raw.waitClosed({ timeout: 4000 }), 'server should terminate the silent peer');

    // 清理验证：以对侧 role 进同一 channel，welcome 应显示 client 已不在连接表
    // （welcome.peers 含自身，故用 host 视角看 client 槽位）
    const p = await Peer.open(srv.url, { role: 'host', ch: CH });
    const w = await p.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false }, '判死后连接表已清理');
    raw.destroy();
  } finally {
    await srv.kill();
  }
});
