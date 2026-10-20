// e2e/probe-raw.mjs — 原始帧探针：以 client 角色连中继，打印转发帧的顶层字段。
// 用途：确认对端（DSH 插件）发送的 frame 是否携带 v1.0.2 的 sid。
// 用法: node probe-raw.mjs <relayUrl> <channel> <secret> [seconds]
import { deriveKey, helloSig } from "./protocol.mjs";

const [relayUrl, channel, secret] = process.argv.slice(2);
const seconds = Number(process.argv[5] ?? 8);
const key = deriveKey(secret, channel);
const ws = new WebSocket(relayUrl);
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ t: "hello", role: "client", ch: channel, sig: helloSig(key, "client", channel) }));
  ws.send(JSON.stringify({ t: "ping" }));
});
ws.addEventListener("message", (ev) => {
  let f;
  try {
    f = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (f.t === "frame") console.log("frame keys=%s sid=%s seq=%s", Object.keys(f).join(","), f.sid ?? "<none>", f.seq);
  else console.log("relay msg:", f.t, JSON.stringify(f).slice(0, 120));
});
setTimeout(() => {
  ws.close();
  process.exit(0);
}, seconds * 1000);
