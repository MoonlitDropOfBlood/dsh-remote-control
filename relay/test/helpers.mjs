/**
 * 测试辅助：起一个真实中继子进程（PORT=0 随机端口，从启动行解析），
 * 以及一个带消息缓冲/等待语义的 ws 客户端 Peer。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 启动 server.js 子进程，返回 { port, url, kill, output } */
export async function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', LOG_LEVEL: 'error', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr.on('data', (d) => (out += d.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout; output:\n${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/relay listening port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}); output:\n${out}`));
    });
  });
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    ipv6Url: `ws://[::1]:${port}`,
    child,
    output: () => out,
    /** 等子进程输出里出现某个模式（stdout 分块到达，断言前需要等一拍） */
    async waitForOutput(re, { timeout = 3000 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (re.test(out)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timeout waiting for output ${re}; output:\n${out}`);
    },
    async kill() {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((r) => {
          const t = setTimeout(r, 2000);
          t.unref?.();
        }),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** 带消息缓冲的 ws 客户端 */
export class Peer {
  constructor(ws) {
    this.ws = ws;
    this.msgs = [];
    this.waiters = [];
    this.closed = false;
    this.closeInfo = null;
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.msgs.push(m);
      this._drain();
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      this.closeInfo = { code, reason: reason ? reason.toString() : '' };
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`closed (code ${this.closeInfo.code}) while waiting for ${w.desc}; seen=${this._seen()}`));
      }
    });
    ws.on('error', () => {}); // 测试里连接被服务端关闭属预期，避免 unhandled error
  }

  _seen() {
    return this.msgs.map((m) => `${m.t}${m.code ? `:${m.code}` : ''}`).join(',');
  }

  _drain() {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const idx = this.msgs.findIndex(w.pred);
      if (idx >= 0) {
        const [m] = this.msgs.splice(idx, 1);
        this.waiters.splice(i, 1);
        i--;
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }

  /** 打开连接；若给 hello 则立即发送（自动带 sig 占位） */
  static async open(url, hello, opts) {
    const ws = new WebSocket(url, opts);
    const peer = new Peer(ws);
    await once(ws, 'open');
    if (hello) ws.send(JSON.stringify({ t: 'hello', sig: 'test-sig', ...hello }));
    return peer;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** 等待一条满足条件的消息（先查已缓冲的） */
  waitFor(pred, { timeout = 3000, desc = 'message' } = {}) {
    const idx = this.msgs.findIndex(pred);
    if (idx >= 0) {
      const [m] = this.msgs.splice(idx, 1);
      return Promise.resolve(m);
    }
    if (this.closed) return Promise.reject(new Error(`closed (code ${this.closeInfo?.code}) before ${desc}; seen=${this._seen()}`));
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, desc };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${desc}; seen=${this._seen()}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  waitForType(t, opts = {}) {
    return this.waitFor((m) => m.t === t, { desc: `t=${t}`, ...opts });
  }

  async waitClose({ timeout = 3000 } = {}) {
    if (this.closed) return this.closeInfo;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      await once(this.ws, 'close', { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    return this.closeInfo;
  }
}
