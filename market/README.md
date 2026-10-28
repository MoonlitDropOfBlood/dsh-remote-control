# DSH Pocket 插件市场索引

DSH 插件市场（Discover）读的是**用户配置的索引 URL**——本目录就是我们的索引
（format 1，由 [`@deepseek-ai/dsh-plugin-market-index`](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-market-index) 校验），
由 `generate-index.mjs` 生成，**发布 workflow 自动更新**。

## 安装（DSH 用户）

DSH「设置 → 插件市场」（或 Discover 页）添加索引 URL：

```
https://unpkg.com/@duke-dsh-plugins/dsh-remote-control@latest/market/index.json
```

之后在市场里搜「DSH Pocket」安装即可（安装目标 = npm 包
`@duke-dsh-plugins/dsh-remote-control@<版本>`）。

> **为什么走 unpkg 而不是 GitHub raw**：本机实测（2026-10-27，国内网络）——
> `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 的连接被重置（不可达），
> `unpkg.com` 正常（HTTP 200）。索引是 npm 包，走 npm 生态的 CDN 才稳。
> 若你的网络能直连 GitHub，也可以用
> `https://raw.githubusercontent.com/MoonlitDropOfBlood/dsh-remote-control/main/market/index.json`。

## 维护

- **生成**：`node market/generate-index.mjs`（版本列表来自 npm registry，
  发布时间取 registry `time` 字段；离线回退 git tag 时间）。
- **更新时机**：推 `v*` 标签后，`release.yml` 发布 npm 包 → 重生成本索引 →
  校验 → **把索引拷进插件包**（`market/sync-into-plugin.mjs` → `plugin/market/index.json`，
  该目录 gitignored，发布时随包带上）→ 索引提交回 main → 附进 GitHub Release。
  **平时不用手改**。
- ⚠️ **不再有独立的「市场索引包」**：v1.1.4 起索引并入插件包自托管
  （所以 npm 上查不到 `@duke-dsh-plugins/dsh-remote-control-market`），
  release workflow 也只 publish 插件与中继**两个**包。
  手动发版时只需 bump `relay/` 与 `plugin/` 的版本。
- 索引里只列**插件包**；中继是服务器包（不是 DSH bundle），只出现在描述链接里
  （`@duke-dsh-plugins/dsh-remote-control-relay`）。
- `0.0.0-stage` 之类的 npm 暂存伪版本会被过滤（见生成器里的 SEMVER_RE）。
