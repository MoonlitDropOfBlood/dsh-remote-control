// market/sync-into-plugin.mjs —— 把市场索引拷进插件包（发布时的生成物）。
//
// 为什么这样绕：插件市场索引要能被**国内网络**取到。实测（2026-10-27）本机
//   raw.githubusercontent.com  连接被重置（不可达）
//   cdn.jsdelivr.net          连接被重置（不可达）
//   unpkg.com                 HTTP 200 ✓（npm 生态的 CDN）
// 所以索引不能放 GitHub raw，只能挂在 **npm 包**里，让 unpkg 代理。
// 既然插件包本来就要发，就让它自己带一份 index.json：
//   https://unpkg.com/@duke-dsh-plugins/dsh-remote-control@latest/market/index.json
// （市场索引包会是第三个 npm 包 —— 用户只需要两个，故并入插件包。）
//
// 用法：
//   node market/sync-into-plugin.mjs           # 生成 plugin/market/index.json
//   node market/sync-into-plugin.mjs --check   # 校验已拷入的副本与源文件一致（CI 用）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "index.json");
const DST_DIR = join(here, "..", "plugin", "market");
const DST = join(DST_DIR, "index.json");

const src = readFileSync(SRC, "utf8");

if (process.argv.includes("--check")) {
  let disk;
  try {
    disk = readFileSync(DST, "utf8");
  } catch {
    console.error("plugin/market/index.json 不存在——跑 node market/sync-into-plugin.mjs 生成");
    process.exit(1);
  }
  if (disk !== src) {
    console.error("plugin/market/index.json 与 market/index.json 不一致——重新同步");
    process.exit(1);
  }
  console.log("plugin/market/index.json 与源一致 ✓");
} else {
  mkdirSync(DST_DIR, { recursive: true });
  writeFileSync(DST, src);
  console.log(`plugin/market/index.json 已同步（${src.length} 字节）`);
}
