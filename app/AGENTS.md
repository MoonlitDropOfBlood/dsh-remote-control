# AGENTS.md — app/（HarmonyOS 手机 App）

DSH 遥控器（ArkTS / ArkUI，DevEco 工程，bundleName=com.dukedsh.remotecontrol）。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构（devecocli create 脚手架，勿手搓骨架）

```
entry/src/main/ets/model/    protocol(KAT向量) / crypto(HKDF+AES-GCM+HMAC) / link(WS链路)
                             store(Preferences) / sessionstore(事件仓) / push / theme / pairqr
entry/src/main/ets/pages/    Index(配对) / SessionListPage / SessionDetailPage
                             AskCards + ApprovalQueuePage(审批提问) / AboutPage / FieldInput
```

## 构建与验收（三件套，缺一不可）

```bash
devecocli build                                    # cwd=app/，必须 BUILD SUCCESSFUL
# linter-cli（双 --sdk-path：@kit.PushKit/@kit.ScanKit 在 hms 树！）
node <linter-cli>/bin/linter-cli.js --input <file>.ets \
  --sdk-path ".../sdk/default/openharmony/ets" --sdk-path ".../sdk/default/hms/ets"
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

## 三方库（用户指定）

- `eventpost`：事件总线（组件 lifecycle 自动取消订阅）——link→store→UI 解耦用。
- `hrouter`：路由框架（编译期扫描装饰器生成路由表）——替代手写 NavPathStack 跳转。
- `@duke/logan-ext`：文件日志——排障用（真机崩溃日志只有 hilog 不够）。
集成后本文件更新对应模块说明。
