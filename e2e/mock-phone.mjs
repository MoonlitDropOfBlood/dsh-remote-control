// e2e/mock-phone.mjs — 模拟手机端（client 角色）的命令行 REPL：
// 用于在没有真机的情况下测试中继与（模拟或真实的）DSH 插件端。
// 用法: node mock-phone.mjs <relayUrl> <channel> <secret>
// 命令: list | new [title] | prompt <sessionId> <text> | cancel <sessionId>
//       answer <askId> <approved|rejected> | quit
import readline from "node:readline";
import { RelayLink, msg } from "./link.mjs";

const [relayUrl, channel, secret] = process.argv.slice(2);
if (!relayUrl || !channel || !secret) {
  console.error("usage: node mock-phone.mjs <relayUrl> <channel> <secret>");
  process.exit(1);
}

const link = new RelayLink({
  relayUrl,
  channel,
  secret,
  role: "client",
  onStatus: (s) => console.log("[phone] status:", s),
  onPeer: (joined, role) => console.log("[phone] peer", role, joined ? "joined" : "left"),
  onMessage: (m) => {
    if (m.type === "event") {
      const d = m.payload?.data ?? {};
      if (m.payload?.topic === "assistant.delta") process.stdout.write(d.text ?? "");
      else console.log("\n[phone] event:", m.payload?.topic, JSON.stringify(d).slice(0, 200));
    } else {
      console.log("\n[phone] <-", m.type, JSON.stringify(m.payload ?? {}).slice(0, 200));
    }
  },
});

// 连接建立后先握手
setTimeout(() => {
  link
    .request("hello", { proto: 1, clientName: "mock-phone", appVersion: "1.0.0" })
    .then((v) => console.log("\n[phone] hello.ok:", JSON.stringify(v)))
    .catch((e) => console.log("\n[phone] hello failed:", e.message));
}, 500);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "phone> " });
rl.prompt();
rl.on("line", async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case "list":
        console.log(JSON.stringify(await link.request("session.list", {}), null, 2));
        break;
      case "new":
        console.log(JSON.stringify(await link.request("session.create", { title: rest.join(" ") || undefined })));
        break;
      case "prompt": {
        const sessionId = rest.shift();
        console.log(JSON.stringify(await link.request("session.prompt", { sessionId, text: rest.join(" ") })));
        break;
      }
      case "cancel":
        console.log(JSON.stringify(await link.request("session.cancel", { sessionId: rest[0] })));
        break;
      case "answer": {
        const [askId, decision] = rest;
        console.log(JSON.stringify(await link.request("approval.answer", { askId, decision }, 5000)));
        break;
      }
      case "quit":
        link.close();
        process.exit(0);
      default:
        if (cmd) console.log("commands: list | new | prompt | cancel | answer | quit");
    }
  } catch (e) {
    console.log("error:", e.message);
  }
  rl.prompt();
});
