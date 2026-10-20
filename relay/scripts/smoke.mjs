#!/usr/bin/env node
/**
 * Smoke 脚本：本机起一个中继，用两个 ws 客户端模拟 host + client，走一遍
 * hello → welcome → frame 互转 → 断线 → 离线缓存 → 重连补发 的完整链路。
 * 每步打印实际收发的消息；任一步失败以非 0 退出。
 * 用法：npm run smoke（或 node scripts/smoke.mjs）
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CH = 'SMOKETESTCHANNEL2'; // 匹配 ^[A-Z2-7]{16,64}$
const log = (...a) => console.log('·', ...a);
const fail = (msg) => {
  console.error('✗ SMOKE FAIL:', msg);
  process.exit(1);
};

function peer(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const p = { ws, msgs: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      p.msgs.push(m);
      log(`<- ${hello.role} 收到:`, JSON.stringify(m));
    });
    ws.on('error', reject);
    ws.on('open', () => {
      log(`-> ${hello.role} 发送 hello:`, JSON.stringify({ ...hello, ch: CH }));
      ws.send(JSON.stringify({ t: 'hello', sig: '(省略)', ...hello }));
      resolve(p);
    });
  });
}
const waitFor = (p, pred, ms = 3000) =>
  new Promise((resolve, reject) => {
    const take = () => {
      const i = p.msgs.findIndex(pred);
      return i < 0 ? null : p.msgs.splice(i, 1)[0];
    };
    const hit = take();
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error(`timeout; seen=${p.msgs.map((m) => m.t)}`)), ms);
    p.ws.on('message', function onMsg() {
      const m = take();
      if (m) {
        clearTimeout(timer);
        p.ws.off('message', onMsg);
        resolve(m);
      }
    });
  });

// 1. 起中继（PORT=0 随机端口）
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', LOG_LEVEL: 'info' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const port = await new Promise((resolve, reject) => {
  let out = '';
  srv.stdout.on('data', (d) => {
    out += d.toString();
    process.stdout.write(d);
    const m = out.match(/relay listening port=(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  srv.once('exit', (c) => reject(new Error(`server exited ${c}`)));
  setTimeout(() => reject(new Error('start timeout')), 5000);
});
const url = `ws://127.0.0.1:${port}`;
log(`中继已启动: ${url} (pid ${srv.pid})\n`);

try {
  // 2. host 上线
  log('--- 1) host hello ---');
  const host = await peer(url, { role: 'host', ch: CH });
  const w1 = await waitFor(host, (m) => m.t === 'welcome');
  log('welcome.peers =', JSON.stringify(w1.peers));

  // 3. client 上线（host 收到 peer-joined）
  log('\n--- 2) client hello ---');
  const client = await peer(url, { role: 'client', ch: CH });
  const w2 = await waitFor(client, (m) => m.t === 'welcome');
  log('welcome.peers =', JSON.stringify(w2.peers));
  await waitFor(host, (m) => m.t === 'peer-joined' && m.role === 'client');

  // 4. 双向 frame 互转（data 为密文，中继原样转发）
  log('\n--- 3) frame 互转 ---');
  const c1 = Buffer.from('ciphertext-from-client-1').toString('base64');
  client.ws.send(JSON.stringify({ t: 'frame', seq: 1, data: c1 }));
  const f1 = await waitFor(host, (m) => m.t === 'frame' && m.seq === 1);
  if (f1.from !== 'client' || f1.data !== c1) fail('client→host frame 不一致');
  log('client→host frame 一致 ✓ (from/seq/data 均原样)');

  const h1 = Buffer.from('ciphertext-from-host-1').toString('base64');
  host.ws.send(JSON.stringify({ t: 'frame', seq: 1, data: h1 }));
  const f2 = await waitFor(client, (m) => m.t === 'frame' && m.seq === 1);
  if (f2.from !== 'host' || f2.data !== h1) fail('host→client frame 不一致');
  log('host→client frame 一致 ✓');

  // 5. client 断线（host 收到 peer-left）
  log('\n--- 4) client 断线 ---');
  client.ws.close();
  await waitFor(host, (m) => m.t === 'peer-left' && m.role === 'client');
  log('host 收到 peer-left ✓');

  // 6. client 离线期间 host 发 3 帧（中间一帧 urgent）
  log('\n--- 5) client 离线，host 发 3 帧（seq2 普通 / seq3 urgent / seq4 普通）---');
  for (const [seq, urgent] of [[2, false], [3, true], [4, false]]) {
    const data = Buffer.from(`offline-${seq}`).toString('base64');
    host.ws.send(JSON.stringify({ t: 'frame', seq, data, urgent }));
    log(`-> host 发送 frame seq=${seq}${urgent ? ' (urgent)' : ''} → 应缓存`);
  }
  await new Promise((r) => setTimeout(r, 300));

  // 7. client 重连 → 补发（urgent 先到，其余按 seq 升序）
  log('\n--- 6) client 重连 → 离线补发 ---');
  const client2 = await peer(url, { role: 'client', ch: CH });
  await waitFor(client2, (m) => m.t === 'welcome');
  const replayed = [];
  for (let i = 0; i < 3; i++) {
    const f = await waitFor(client2, (m) => m.t === 'frame', 3000);
    replayed.push(f);
    log(`<- 补发 frame seq=${f.seq}${f.urgent ? ' (urgent)' : ''}`);
  }
  const order = replayed.map((f) => f.seq).join(',');
  if (order !== '3,2,4') fail(`补发顺序错误: 期望 3,2,4（urgent 优先）实际 ${order}`);
  if (!replayed.every((f) => f.from === 'host')) fail('补发帧 from 字段错误');
  log('补发顺序 3,2,4 ✓（urgent 优先，其余按 seq 升序），from=host ✓');

  console.log('\n✓ SMOKE PASS: hello → welcome → frame 互转 → 断线 → 缓存 → 重连补发 全链路通过');
} catch (err) {
  fail(String(err && err.message));
} finally {
  srv.kill('SIGTERM');
  await Promise.race([once(srv, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
  log('中继进程已停止');
}
