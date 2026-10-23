# AGENTS.md — app/（HarmonyOS 手机 App）

DSH 遥控器（ArkTS / ArkUI，DevEco 工程，bundleName=com.dukedsh.remotecontrol）。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构（devecocli create 脚手架，勿手搓骨架）

```
entry/src/main/ets/model/    protocol(KAT向量) / crypto(HKDF+AES-GCM+HMAC) / link(WS链路)
                             store(Preferences) / sessionstore(事件仓) / push / theme / pairqr
                             logger(@duke/logan-ext 双写日志) / events(eventpost 事件契约)
                             routes(hrouter 统一跳转)
entry/src/main/ets/pages/    Index(配对) / SessionListPage / SessionDetailPage
                             AskCards + ApprovalQueuePage(审批提问) / AboutPage / FieldInput
entry/src/main/ets/_generated/hrouter/   hrouter-compiler 生成的 NavDestination wrapper
                             （构建产物勿手改勿入 git；路由表=resources/base/profile/router_map.json）
```

## 构建与验收（三件套，缺一不可）

```bash
devecocli build                                    # cwd=app/，必须 BUILD SUCCESSFUL
# linter-cli（双 --sdk-path：@kit.PushKit/@kit.ScanKit 在 hms 树！
#             --package-manager-type ohpm：解析 oh_modules 里的三方库）
node <linter-cli>/bin/linter-cli.js --input <file>.ets \
  --sdk-path ".../sdk/default/openharmony/ets" --sdk-path ".../sdk/default/hms/ets" \
  --package-manager-type ohpm
# V2 禁用词扫描必须 0 命中：
grep -rnE "@State|@Prop|@Link|@ObjectLink|@Observed[^V]|@Provide|@Consume|@Watch|@StorageLink" entry/src/main/ets/
```

真机部署：`devecocli run --device <serial>`（**保留配对数据**）；
首次/清数据用 `--uninstall`。真机排障：`devecocli log --device <serial> --crash` 抓堆栈。

## 硬性约定

- **状态管理一律 V2**（用户硬性要求）：@ComponentV2/@ObservedV2/@Trace/@Local/@Param/
  @Event/@Monitor/@Once/@Computed；**严禁 V1**（@State/@Prop/@Link/@Watch…）；
  列表用 Repeat 不用 ForEach。
- **UI 风格参照 DSH**：token 集中在 resources/base|dark/element/color.json（同名双色板
  跟随系统）+ theme.ets（间距/圆角/字号）。品牌填充 `brand_fill`（亮 #4D6BFE/暗 #6480FF）
  配白字；对比色只做描边/文字（DSH 语义坑：brand-primary 是对比色，做填充会白底白字）。
  代码零硬编码色值。
- **KAT 是开机自检**（crypto.assertKat，含 HMAC 向量），失败不建链；protocol.ets 的
  KAT 字面量与契约 §7 逐字一致，**绝不许改**。
- 不改 model/ 的协议/加密逻辑（protocol/crypto/link 的 wire 行为以契约为准）。

## 真机坑位（模拟器/linter 全都测不出，2026-10 实测）

1. `createMac('SHA256')`——**只认摘要名**；传 `'HMAC|SHA256'` 真机 HCF 报 401
   （该串只用于 createSymKeyGenerator）。
2. `cipher.updateSync()` 小数据**返回 null**（输出缓冲到 doFinal）；GCM 正确语义是
   update+doFinal 输出**拼接**才是 ct||tag（tag 恒为末 16 字节）。两侧判空再拼接。
3. `ws.on('open'/'close')` 成功时 **err 参数是 undefined**——直接读 err.code 崩
   （`Cannot read property code of undefined`）。
4. linter-cli 的 `--sdk-path` 可重复传；单文件模式 compatibleSdk 推断为 10，
   `canIUse()` 会被误报——用等价 try/catch 守卫。
5. `--app-name`（devecocli create）禁连字符；build 必须在工程根执行。

## 三方库（用户指定，R4 已集成——ohpm install + 构建/真机均验证通过）

- `@duke/logan-ext@2.0.1`：文件日志。`model/logger.ets` 封装——`initLogger()`（EntryAbility.onCreate
  幂等初始化，失败降级纯 hilog）+ `logDshrc(tag, level, msg, extra?)` **双写**（hilog + Logan
  加密落盘 `files/logan/`）+ `exportLogs()`（About 页展示）。新日志一律走 logDshrc，
  不再裸写 hilog。secret / 配对 URI 不入日志（脱敏不许回退）。
- `eventpost@2.2.1`：事件总线。事件常量/载荷集中定义在 `model/events.ets`；link.ets 保留直接
  回调（onState/onEvent/onPeers/onLog）同时并行广播；sessionstore 广播审批/提问/推送导航事件。
  页面订阅必须用 `onFromComponent`（组件销毁自动反注册，禁裸 `on()` 不 `off()`）；
  帧级事件 `postNormal`，需补收的用 `postStick`。
- `hrouter@2.0.0`（+ hvigor 插件 `hrouter-compiler@2.0.0`，npm）：编译期路由。页面用**注释形式**
  `// @Route({ name: '...' })` 标记（禁真装饰器——ArkTS 不允许）；页面是普通组件
  （NavDestination 外壳由生成的 wrapper 提供，勿手写 NavDestination）；跳转一律走
  `model/routes.ets`，禁页面直接 pushPath；详情页取参用 `HRouter.getParams`（onAppear 兜底重读）；
  生命周期用 `HRouter.registerLifecycle`。`hvigorfile.ts` 里的 `hrouterCompat` 垫片
  （hvigor 26 无 getRootProject）与手补的空 `service_map.json` 都是**必需**的，勿删。
- `@luvi/lv-markdown-in@3.4.7`（用户指定）：**agent 消息的 markdown 渲染**。用法——
  详情页 `SessionDetailPage.setupMarkdownTheme()` 建一个 `MarkdownController`（DSH 配色，
  全部 `$r('app.color.*')` 深浅色自动适配），下传给 `MessageBubble` 的
  `@Require @Param mdController`，助手气泡内 `Markdown({ text: this.item.text, controller })`。
  **禁自写 markdown 解析**（曾经的 InlineChunk/chunksOf 手写实现已删除）。
  签名坑：`setTitleSize` 收 **6 元组**（h1..h6）不收单值；`setTableNormalTextColor` /
  `setTableInterleaveTextColor` **返回 void**（不能链式，单独调）。
