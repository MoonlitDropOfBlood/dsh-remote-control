/**
 * dsh-remote-control-relay v1.1.3 用例（契约 §3.4.1 / §3.4.2 / §4）：
 *
 *  A1 哑管道透传对端 hello 证明
 *   1. welcome.peer = 对端 hello 证明的**逐字**复制（不重排/不补默认值/不改数值）
 *   2. peer-joined.peer = **新上线方**自己的证明（逐字）
 *   3. 中继**不校验 sig**：错的 sig 也能连上（设计如此：中继没有密钥）
 *   4. 旧端（不带 e/ts/pv/sid）→ peer 对象里**没有**这些字段（不补默认值）
 *   5. 顺序保证：对端先收到 peer-joined（带证明），再收到该对端的业务帧
 *   6. 顶替场景不发 peer-joined（对端视角无变化）
 *
 *  A2 原生 TLS（RELAY_TLS_CERT / RELAY_TLS_KEY）
 *   7. 都配置 → 提供 wss://（hello→welcome→frame 全通），明文 ws:// 连不上
 *   8. 没配置 → 行为不变（仍是明文 ws://）
 *   9. 证书读不到 / 证书非法 / 只配一个变量 → **启动即失败**（不静默降级明文）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, Peer } from './helpers.mjs';
import { loadConfig, loadTlsConfig, extractProof, peerProofOf } from '../server.js';

const CH = 'ABCDEFGH23452345';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 测试用自签证书（仅用于本机冒烟；CN=localhost，SAN 含 127.0.0.1/::1）
// 仓库 .gitignore 忽略 *.pem/*.key，所以直接内嵌在测试文件里。
// ---------------------------------------------------------------------------
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDfDCCAmSgAwIBAgIUGzTTPXK0cYBtfBJmQkStrul6eAgwDQYJKoZIhvcNAQEL
BQAwNjESMBAGA1UEAwwJbG9jYWxob3N0MSAwHgYDVQQKDBdkc2gtcmVtb3RlLWNv
bnRyb2wtdGVzdDAeFw0yNjEwMjUxNjIxMDZaFw00NjEwMjAxNjIxMDZaMDYxEjAQ
BgNVBAMMCWxvY2FsaG9zdDEgMB4GA1UECgwXZHNoLXJlbW90ZS1jb250cm9sLXRl
c3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC90TniVr9u735cGibC
IgNmWcGFKP1+tleyphK+CWm64EqmFJcNhrwiq05443wi2Y8TjkhZLKbbHknUTuPn
KTZJA4CGAYJ5r8U6lahuzPY53V02tQpC7Gk6s/FG/VL2TvmUuJHevkXob/gELCsQ
jVb7dDQZR1X7WmGRv3AuJEGyD6imfi0QyOhoNNWxUgQfVXK6Adp+WuHtE+u5FNq+
KU4tpBLxrIt7BC8mvooCmMr9g78ESaAdS0z18VS9gN92k6qwTjAsmb5vaGkZJsKR
7SQeSirgPlWq9WtJ/YokNE0BGWXxMDKmceAyhtjLab5xOHVJlyhLmIDL6xvJhhFC
JEnzAgMBAAGjgYEwfzAdBgNVHQ4EFgQU4/3z4W033yhuUxzx/4p4IxncuqgwHwYD
VR0jBBgwFoAU4/3z4W033yhuUxzx/4p4IxncuqgwDwYDVR0TAQH/BAUwAwEB/zAs
BgNVHREEJTAjgglsb2NhbGhvc3SHBH8AAAGHEAAAAAAAAAAAAAAAAAAAAAEwDQYJ
KoZIhvcNAQELBQADggEBAI6ZRffQ0vQxwmYH/T/iopvgoV6qFzB/1g5xY8dxEzLI
6dRSjKtgCPMWwlnQLVps5C7mnOHDNN8HSd81oNxr6JO7nRUyOsZLc6RMmle2Qnku
+l5z4v9NAkHuSEH1blwieiDZGHseSgTRmwcXFnEoEpH2NoYUY8ZzfWut2fcZcOZs
3bhGDKZpI+SpRH9OgO9xz/i6+t6q+jaGxK5LzPG5yVRUNa+z9SbpnKIkCXqp1cr4
B9DAfoXkiI8fjXFtoJPhv7BxPLn+PaZW6usx+OgsYt4HDTcY755OSKeyXoqEZBje
M316OvUYZPUvTNMa8gWVf85XmboOA7AYf7DWU+9Lbds=
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC90TniVr9u735c
GibCIgNmWcGFKP1+tleyphK+CWm64EqmFJcNhrwiq05443wi2Y8TjkhZLKbbHknU
TuPnKTZJA4CGAYJ5r8U6lahuzPY53V02tQpC7Gk6s/FG/VL2TvmUuJHevkXob/gE
LCsQjVb7dDQZR1X7WmGRv3AuJEGyD6imfi0QyOhoNNWxUgQfVXK6Adp+WuHtE+u5
FNq+KU4tpBLxrIt7BC8mvooCmMr9g78ESaAdS0z18VS9gN92k6qwTjAsmb5vaGkZ
JsKR7SQeSirgPlWq9WtJ/YokNE0BGWXxMDKmceAyhtjLab5xOHVJlyhLmIDL6xvJ
hhFCJEnzAgMBAAECggEAM3fJxC9VVNUnY/3LSJREa7ommN6WbYcvnEcfiduviXZL
h2DJ3GcOGDBu5KR6AlEPVHQd9d//liZOSnzhmso35/BFJxC9uhUI22u88d4tXV9C
aRUJpT/JAJvN7ju+BP9A+SxakRTyi6Xgj/ER9Dj+vsuxXLFVBQRqtEQ+PKSkE41n
xHlBgGKAJQ1m05V+rxIqW9hp8hNRuO1oFtbN6bWPgoNXZreza48bNx5zeRgVXC+X
BroErUcF8ZEyOtKr8GnPgnem5fq/Hew5ugpg1u4BSt1Ou8lZlQHEyL0pa/7+Lt4h
7ovcgvuC8Z771bpwAEnHO09/w390WO23ztQmgpoo0QKBgQDkf6jqf1Hm580gsRgM
MiB9tA7DdW3T3JcH1Vmlt3UW5kem8XWhYQM/jWwRgU5c5U4hc3lKJhxQGKpArWM8
NaFAD9hzHNZVc20vm6toO5YD3NgLpzm8bBeebWzbC4nLJuLb+hfdn1uH/Q+B1L0L
lPesB3XUHO0JSxtDBIv9UwwR7wKBgQDUqb4nFg95e9SXdCnqfeQ7f6v0ZSMNfA7P
t5s23OAqmaM3Nx2OsJl8zmZXx800NMchaFiKpSiLgc9da2jxYLsY8GXt9j2PS6D9
EPjZEKjHGM+2CnwB1IdHbE/h0ZRRpqJJW4nszOKvQ6SctWj+MeMm8PRdnlR0eOqT
AZlkbPA8PQKBgEybUDJuRTM4+9i+BuXv2FzMhTaapBunlSsXKFsayrLGubcKtPlJ
4SDpdRXZWEBk0HD+med2J3/jBRFyEBcbk9g6d8MAJAu6Cx0u/6SOdZkN7ZDam8zE
IJcI8LnvgF8PxnchveabisBo404P2OGNLAwM5EAdAotfFuC9IYHo2d8ZAoGAQcFa
cmt3zXBkg4//hen3MA6B9Mdw1zKMwd1buNMC3Sk0NlZsZTpluxl2u52j7YiEKehB
uFzo9HnmzFPx1vC56TQr0DBbSHtyA83DpBpqlWUulHMZdNdqHMN4z7Il0jlb5KLR
Os7/KIIZ2/qbxD1YpynJ5UiXhIv+vAW6kDq+7WECgYBGLwx/cexUYc/H+9H9Je53
e2BkwtT2coCJhnZA/ELIfbbSnYHauEUzPWqR+49iSJtj3fShKKQemiLpy95BekU8
FvKah9/3w84jtwvmSy+7bUKyW1GfHdVqTR34fBXdIniLsXjNzsNeLsK8m9E7zNxp
mypLEiEahzbqnGvHkXJTvw==
-----END PRIVATE KEY-----`;

/** 把证书/私钥写到临时目录，返回 {certPath, keyPath, dir} */
function writeTlsFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'dshrc-relay-tls-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, TEST_CERT, 'utf8');
  writeFileSync(keyPath, TEST_KEY, 'utf8');
  return { certPath, keyPath, dir };
}

// ---------------------------------------------------------------------------
// A1.1 / A1.2：welcome.peer 与 peer-joined.peer 逐字复制对端证明
// ---------------------------------------------------------------------------

test('A1 welcome.peer / peer-joined.peer 逐字复制对端 hello 证明', async () => {
  const srv = await startServer();
  try {
    const hostProof = { e: 7, ts: 1760000000123, pv: 2, sid: 'a1b2c3d4', sig: 'SEVMTy1zaWc' };
    const clientProof = { e: 11, ts: 1760000000456, pv: 2, sid: 'deadbeef', sig: 'Q0xJRU5UX1NJRw' };

    // host 先上线
    const host = await Peer.open(srv.url, { role: 'host', ch: CH, ...hostProof });
    const w1 = await host.waitForType('welcome');
    assert.deepEqual(w1.peers, { host: true, client: false });
    assert.equal(w1.peer, undefined, '对端不在线时 welcome 不带 peer 字段');

    // client 上线 → welcome.peer 必须是 host 的证明（逐字）
    const client = await Peer.open(srv.url, { role: 'client', ch: CH, ...clientProof });
    const w2 = await client.waitForType('welcome');
    assert.deepEqual(w2.peer, { role: 'host', ...hostProof }, 'welcome.peer 必须逐字等于对端证明');

    // host 收到 peer-joined：带的是**新上线方（client）自己**的证明
    const joined = await host.waitForType('peer-joined');
    assert.equal(joined.role, 'client');
    assert.deepEqual(joined.peer, { role: 'client', ...clientProof }, 'peer-joined.peer 必须是新上线方自己的证明');

    // 逐字一致：字段值类型/内容完全不变（不重排 → 键集合固定；不改数值）
    assert.deepEqual(Object.keys(w2.peer), ['role', 'e', 'ts', 'pv', 'sid', 'sig']);
    assert.equal(w2.peer.e, 7);
    assert.equal(w2.peer.ts, 1760000000123);
    assert.equal(w2.peer.pv, 2);
    assert.equal(w2.peer.sid, 'a1b2c3d4');
    assert.equal(w2.peer.sig, 'SEVMTy1zaWc');
  } finally {
    await srv.kill();
  }
});

test('A1 中继不校验 sig：错的 sig 也能连上，且证明照样被复制', async () => {
  const srv = await startServer();
  try {
    // 完全错误的 sig（契约：中继没有密钥，只复制不校验）
    const host = await Peer.open(srv.url, { role: 'host', ch: CH, e: 1, ts: 1, pv: 2, sid: 'aaaaaaaa', sig: 'not-a-real-signature' });
    const w = await host.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false }, '错 sig 也能 hello 成功（中继不校验）');

    const client = await Peer.open(srv.url, { role: 'client', ch: CH, e: 2, ts: 2, pv: 2, sid: 'bbbbbbbb', sig: 'also-wrong' });
    const w2 = await client.waitForType('welcome');
    assert.deepEqual(w2.peer, { role: 'host', e: 1, ts: 1, pv: 2, sid: 'aaaaaaaa', sig: 'not-a-real-signature' });

    const joined = await host.waitForType('peer-joined');
    assert.deepEqual(joined.peer, { role: 'client', e: 2, ts: 2, pv: 2, sid: 'bbbbbbbb', sig: 'also-wrong' });
  } finally {
    await srv.kill();
  }
});

test('A1 旧端 hello（无 e/ts/pv/sid）→ peer 对象不补默认值', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: CH, sig: 'legacy-sig' });
    await host.waitForType('welcome');
    const client = await Peer.open(srv.url, { role: 'client', ch: CH, sig: 'legacy-sig-2' });
    const w2 = await client.waitForType('welcome');
    assert.deepEqual(w2.peer, { role: 'host', sig: 'legacy-sig' }, '只复制 hello 里出现的字段');
    for (const k of ['e', 'ts', 'pv', 'sid']) {
      assert.equal(k in w2.peer, false, `peer 里不应凭空出现 ${k}`);
    }
    const joined = await host.waitForType('peer-joined');
    assert.deepEqual(joined.peer, { role: 'client', sig: 'legacy-sig-2' });
  } finally {
    await srv.kill();
  }
});

test('A1 顺序保证：对端先收到 peer-joined（带证明），再收到该对端的业务帧', async () => {
  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: CH, e: 3, ts: 100, pv: 2, sid: '11111111', sig: 'S1' });
    await host.waitForType('welcome');

    const client = await Peer.open(srv.url, { role: 'client', ch: CH, e: 4, ts: 200, pv: 2, sid: '22222222', sig: 'S2' });
    await client.waitForType('welcome');
    // client 立刻发业务帧：host 必须**先**拿到 peer-joined 再拿到 frame
    client.send({ t: 'frame', seq: 1, sid: '22222222', data: 'Zm9v' });

    const first = await host.waitFor((m) => m.t === 'peer-joined' || m.t === 'frame');
    assert.equal(first.t, 'peer-joined', 'peer-joined 必须先于业务帧到达');
    assert.deepEqual(first.peer, { role: 'client', e: 4, ts: 200, pv: 2, sid: '22222222', sig: 'S2' });

    const frame = await host.waitForType('frame');
    assert.equal(frame.seq, 1);
    assert.equal(frame.sid, '22222222');
  } finally {
    await srv.kill();
  }
});

test('A1 顶替场景也发 peer-joined（带新证明，对端要重新钉扎）', async () => {
  const srv = await startServer();
  try {
    const host1 = await Peer.open(srv.url, { role: 'host', ch: CH, e: 5, ts: 1, pv: 2, sid: 'aaaa1111', sig: 'S1' });
    await host1.waitForType('welcome');
    const client = await Peer.open(srv.url, { role: 'client', ch: CH, e: 6, ts: 2, pv: 2, sid: 'bbbb2222', sig: 'S2' });
    await client.waitForType('welcome');
    await host1.waitForType('peer-joined');

    // 第二个 host 顶掉第一个：对端（client）**必须**收到 peer-joined（带新证明）——
    // 加固模式下它钉着旧 sid/纪元，不重新钉扎就会把新帧全丢掉（链路死到重连）。
    const host2 = await Peer.open(srv.url, { role: 'host', ch: CH, e: 7, ts: 3, pv: 2, sid: 'cccc3333', sig: 'S3' });
    await host2.waitForType('welcome');
    await host1.waitClose();
    const joined = await client.waitForType('peer-joined');
    assert.equal(joined.role, 'host');
    assert.deepEqual(
      joined.peer,
      { role: 'host', e: 7, ts: 3, pv: 2, sid: 'cccc3333', sig: 'S3' },
      '顶替场景的 peer-joined.peer 必须是新顶替者的证明（逐字）',
    );
    // 顶替**不应**发 peer-left（对端没下线，只是换了身份）
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      client.msgs.filter((m) => m.t === 'peer-left').length,
      0,
      '顶替场景不应发 peer-left',
    );
  } finally {
    await srv.kill();
  }
});

test('A1 extractProof / peerProofOf 只取出现的字段且不重排', () => {
  assert.deepEqual(extractProof({ role: 'host', ch: 'X', sig: 's' }), { sig: 's' });
  assert.deepEqual(extractProof({ e: 1, ts: 2, pv: 2, sid: 'abc', sig: 's' }), {
    e: 1,
    ts: 2,
    pv: 2,
    sid: 'abc',
    sig: 's',
  });
  // 值原样保留（不做类型转换/校验）
  assert.deepEqual(extractProof({ e: '5', pv: '2' }), { e: '5', pv: '2' });
  assert.deepEqual(peerProofOf('host', { e: 1, sig: 's' }), { role: 'host', e: 1, sig: 's' });
  assert.deepEqual(peerProofOf('client', undefined), { role: 'client' });
});

// ---------------------------------------------------------------------------
// 回归：sid 三处透传（活转发 / 离线缓存 / 重连补发）不被 v1.1.3 改动破坏
// ---------------------------------------------------------------------------

test('回归：sid 三处透传（活转发 / 离线缓存 / 重连补发）', async () => {
  const srv = await startServer();
  try {
    // ① 活转发
    const host = await Peer.open(srv.url, { role: 'host', ch: CH });
    await host.waitForType('welcome');
    const client = await Peer.open(srv.url, { role: 'client', ch: CH });
    await client.waitForType('welcome');
    client.send({ t: 'frame', seq: 1, sid: 'aaaa1111', data: 'Zm9v' });
    const live = await host.waitForType('frame');
    assert.equal(live.sid, 'aaaa1111', '活转发必须带 sid');

    // ② 离线缓存：host 掉线 → client 发的帧进缓存
    host.ws.close();
    await sleep(250);
    client.send({ t: 'frame', seq: 2, sid: 'bbbb2222', data: 'YmFy' });
    await sleep(250);

    // ③ 重连补发：host 重新上线 → 收到补发帧，sid 必须还在
    const host2 = await Peer.open(srv.url, { role: 'host', ch: CH });
    await host2.waitForType('welcome');
    const resent = await host2.waitForType('frame');
    assert.equal(resent.seq, 2);
    assert.equal(resent.sid, 'bbbb2222', '重连补发必须带 sid');
  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// A2.8：TLS 未配置 → 行为不变（明文 ws://）
// ---------------------------------------------------------------------------

test('A2 未配置 TLS：loadConfig().tls === null，行为不变（明文 ws://）', async () => {
  assert.equal(loadTlsConfig({}), null);
  assert.equal(loadConfig({}).tls, null);

  const srv = await startServer();
  try {
    const host = await Peer.open(srv.url, { role: 'host', ch: CH });
    const w = await host.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false });
  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// A2.7：TLS 已配置 → 提供 wss://
// ---------------------------------------------------------------------------

test('A2 配置 RELAY_TLS_CERT/RELAY_TLS_KEY → 提供 wss://（明文 ws:// 连不上）', async () => {
  const { certPath, keyPath } = writeTlsFixtures();
  const srv = await startServer({ RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: keyPath });
  try {
    const wssUrl = `wss://127.0.0.1:${srv.port}`;
    const host = await Peer.open(wssUrl, { role: 'host', ch: CH }, { rejectUnauthorized: false });
    const w = await host.waitForType('welcome');
    assert.deepEqual(w.peers, { host: true, client: false });

    const client = await Peer.open(wssUrl, { role: 'client', ch: CH }, { rejectUnauthorized: false });
    await client.waitForType('welcome');

    // 业务帧照常转发
    client.send({ t: 'frame', seq: 1, sid: 'cccc4444', data: 'Zm9v' });
    const f = await host.waitForType('frame');
    assert.equal(f.seq, 1);
    assert.equal(f.data, 'Zm9v');
    assert.equal(f.sid, 'cccc4444');

    // 明文 ws:// 连不上（服务端只讲 TLS）
    await assert.rejects(
      () => Peer.open(`ws://127.0.0.1:${srv.port}`, { role: 'client', ch: CH }),
      () => true,
    );
  } finally {
    await srv.kill();
  }
});

// ---------------------------------------------------------------------------
// A2.9：证书读不到 / 非法 / 只配一个变量 → 启动即失败
// ---------------------------------------------------------------------------

test('A2 证书读不到 → 启动失败（清晰错误，不静默降级明文）', async () => {
  const { keyPath } = writeTlsFixtures();
  await assert.rejects(
    () => startServer({ RELAY_TLS_CERT: join(tmpdir(), 'dshrc-no-such-cert.pem'), RELAY_TLS_KEY: keyPath }),
    (err) => {
      assert.match(String(err.message), /exited early \(code 1\)/);
      assert.match(String(err.message), /RELAY_TLS_CERT/);
      assert.match(String(err.message), /failed to start/);
      return true;
    },
  );
});

test('A2 私钥读不到 → 启动失败（清晰错误）', async () => {
  const { certPath } = writeTlsFixtures();
  await assert.rejects(
    () => startServer({ RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: join(tmpdir(), 'dshrc-no-such-key.pem') }),
    (err) => {
      assert.match(String(err.message), /exited early \(code 1\)/);
      assert.match(String(err.message), /RELAY_TLS_KEY/);
      return true;
    },
  );
});

test('A2 证书/私钥非法 → 启动失败（绝不降级成明文 ws://）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshrc-relay-badtls-'));
  const certPath = join(dir, 'bad-cert.pem');
  const keyPath = join(dir, 'bad-key.pem');
  writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nnot a real cert\n-----END CERTIFICATE-----\n', 'utf8');
  writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----\n', 'utf8');
  await assert.rejects(
    () => startServer({ RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: keyPath }),
    (err) => {
      assert.match(String(err.message), /exited early \(code 1\)/);
      assert.match(String(err.message), /TLS/);
      return true;
    },
  );
});

test('A2 只配置一个 TLS 变量 → 启动失败（不静默按明文跑）', async () => {
  const { certPath } = writeTlsFixtures();
  await assert.rejects(
    () => startServer({ RELAY_TLS_CERT: certPath }),
    (err) => {
      assert.match(String(err.message), /exited early \(code 1\)/);
      assert.match(String(err.message), /RELAY_TLS_KEY/);
      return true;
    },
  );
  // loadConfig 直接抛错（单元级）
  assert.throws(() => loadTlsConfig({ RELAY_TLS_CERT: certPath }), /RELAY_TLS_KEY/);
  assert.throws(() => loadTlsConfig({ RELAY_TLS_KEY: certPath }), /RELAY_TLS_CERT/);
});
