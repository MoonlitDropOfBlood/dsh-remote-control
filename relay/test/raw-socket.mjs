/**
 * 极简原始 WebSocket 客户端：只完成 HTTP 升级握手并发送 masked 文本帧，
 * 之后对服务端的一切（ws ping / app ping）都保持完全静默——用于测试「心跳超时判死」。
 */
import net from 'node:net';
import crypto from 'node:crypto';

export class RawSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {}); // 服务端 terminate 造成的 RST 属预期
  }

  static connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, host, () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.once('error', reject);
      const raw = new RawSocket(socket);
      const poll = setInterval(() => {
        if (raw.buf.includes('101')) {
          clearInterval(poll);
          socket.removeListener('error', reject);
          resolve(raw);
        }
      }, 5);
      socket.once('close', () => {
        clearInterval(poll);
        reject(new Error(`closed during handshake; buf=${raw.buf.toString()}`));
      });
      setTimeout(() => {
        if (!raw.buf.includes('101')) {
          clearInterval(poll);
          socket.removeListener('error', reject);
          reject(new Error(`handshake timeout; buf=${raw.buf.toString()}`));
        }
      }, 3000).unref?.();
    });
  }

  /** 发送一个 masked 文本帧（仅支持 <126 字节 payload，测试足够） */
  sendJson(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    if (payload.length >= 126) throw new Error('payload too long for this test helper');
    const mask = crypto.randomBytes(4);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x81; // FIN + text
    frame[1] = 0x80 | payload.length; // mask bit set
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
    this.socket.write(frame);
  }

  /** 轮询累积的字节流直到出现某子串（无需完整解析 ws 帧） */
  async readUntil(substr, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.buf.includes(substr)) return true;
      if (this.closed) return this.buf.includes(substr);
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.buf.includes(substr);
  }

  /** 等待服务端主动断开（FIN/RST） */
  async waitClosed({ timeout = 4000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.closed) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}
