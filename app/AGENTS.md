# AGENTS.md — app/（HarmonyOS 手机 App）

DSH Pocket（DSH 遥控器；ArkTS / ArkUI，DevEco 工程，bundleName=com.dukedsh.remotecontrol）。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构（devecocli create 脚手架，勿手搓骨架）

```
entry/src/main/ets/model/    protocol(KAT向量) / crypto(HKDF+AES-GCM+HMAC) / link(WS链路)
                             store(Preferences) / connections(多远程配置) / sessionstore(事件仓)
                             push / theme / pairqr / logger(@duke/logan-ext 双写日志)
                             events(eventpost 事件契约) / routes(hrouter 统一跳转)
entry/src/main/ets/pages/    Index(会话列表=**首页**) / ConnectionsPage(多远程连接管理)
                             NewSessionPage(新建会话: 目录/模型+强度/模式/权限) / SessionDetailPage(统一时间线)
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

## 会话列表与子代理显示规则（契约 §5.3/§5.6/§5.9）

- **列表数据源**：只显示根会话（无 parentSessionId 且 origin!=='subagent'）非 blank，
  updatedAt 降序。v1.0.7 起 wire SessionSummary.archived 由插件按 Workspace 注册表拼装。
- **Host 真实归档**：普通列表左滑「归档」调 session.archive，归档视图左滑「恢复」调
  session.unarchive；session.list 首屏即过滤已有归档，session.archives 全集事件实时覆盖。
  **禁止再写 Preferences archivedSessions / 本机假归档**；Host 拒绝时保留原行并提示错误。
- **subagent 不进列表**：入口在父会话详情页顶部的「子代理」目录区
  （`store.activeSubagents`，SubagentChip 横向滚动；running 圆点 + label + 一次性角标），
  点击进子代理详情（session.history 已支持 subagent 地址，流式事件按 child id 寻址天然工作）。
- **one-shot 子代理只读**：详情页输入条整条隐藏，替换为「一次性子代理 · 仅查看」说明行；
  continuable 正常输入（发送自动走 `session.subagentPrompt`，取消走 `session.subagentCancel`——
  详情页 send()/cancelTurn() 按 rowOf(sid).parentSessionId 分流，勿绕过）。

## v1.0.6：主页 / 多远程 / 时间线 / 模式权限（2026-10-23）

### 主页 = 会话列表（Index 是 Navigation 根页）
- `Index.ets` 不再是配对页，**就是会话列表主页**：顶栏右上角 = **连接信息**按钮
  （链路状态点 + 当前远程名）→ `openConnections()`；底部「新建会话」→ `openNewSession()`。
- 配对表单整体搬进 `ConnectionsPage.ets`（管理**多个**远程），`SessionListPage.ets` 已删除。

### 多远程连接（model/connections.ets）
- `RemoteProfile`（id/name/relayUrl/channel/secret/relayToken/lastUsedAt）持久化在
  Preferences `dshrc_prefs` 的 `remotes`（JSON 数组）+ `activeRemoteId`。
- 旧单条配对键（relayUrl/channel/secret/relayToken）首次启动时**迁移**成一个「默认远程」。
- 切换远程 = `dshrcLink.stop()` + `dshrcLink.start(toLinkConfig(...))`；链路断开时
  `sessionStore` 清空 timeline/hostName（避免展示上一台主机的时间线）。

### 统一时间线（契约 §5.7；reasoning 为 v1.0.7）
- `sessionstore.timeline: TimelineItem[]` 是详情页**唯一**数据源，取代旧的 `messages`：
  `kind='message'`（对话）/ `'step'`（工具调用）/ `'system'`（系统消息）/ `'reasoning'`（思考）。
- durable 项按 `seq` 升序在前，直播项（`seq=-1`）按到达顺序在末尾；
  历史页 `steps` 与直播 `tool.call`/`tool.result` 按 `callId` 配对去重。
- 工作步骤卡与组头的 chevron 都用 **18×16 固定尺寸 SymbolGlyph**，禁止文字箭头影响行高。
  reasoning 用独立 ReasoningCard（默认收起的弱化「思考过程」），不进 assistant 气泡/StepGroup。

### 新建会话的模式 / 权限 / 模型 / 思考强度（契约 §5.8 v1.0.7+v1.0.8）
- `session.capabilities` → presets / permissions / models（含 efforts 强度目录）及对应默认项；目录为空隐藏选择区。
- `sessionCreate(title, agentPreset?, permission?, cwd?, model?)` 返回 DshrcCreateResult；
  modelError 只提示并继续首条 prompt，**不得重复 create**。unsupported 回退仅去掉 preset/permission，
  保留 cwd/model。
- 新建页**不填标题**：首屏输入首条任务，工作目录/模型+强度（ModelFieldCard 一卡两行）/模式/权限都用
  Select；强度档位 = 所选模型 `efforts`（首项「默认」= 不提交 reasoningEffort），换模型重置为该模型
  默认档；目录候选 = 「默认目录」+ 现有会话 cwd 去重。create 成功但 prompt 失败也要进详情提示重试。

### 会话中切换模型 / 思考强度（契约 §5.8 v1.0.8）
- 入口在**详情页输入框旁的模型胶囊**（对齐各家 Harness 习惯；one-shot 只读会话随输入条一起隐藏），
  点开 bindSheet 选模型+强度，「应用」调 `store.applyModelSelection`（wire `session.selectModel`），
  Host 拒绝 toast 原文。
- 当前值：`store.sessionModel`（`session.model` 拉取 + `session.modelChanged` 事件实时覆盖；
  null = 插件无记录 → 回退显示目录默认）。下一次 prompt 组装即用新模型，运行中 turn 不受影响。

### 品牌（2026-10-24，v3 鲸鱼版）
- 应用名 **DSH Pocket**（AppScope app_name、EntryAbility_label、APP_NAME）；bundleName 不变。
- 图标 = DSH 插件家族风格：44×44 rx11 圆角方块 + `#4D6BFE→#00B8A9` 对角渐变 + 底部半透明波浪
  （家族签名）+ **官方 DSH 鲸鱼剪影**（源 `dsh-desktop/build/whale.svg`，整体染白，居中悬于波浪上方）。
- 源文件 `tools/icon/*.svg`；管线 = `node tools/icon/compose-whale.mjs`（从 whale 源合成
  foreground/full/plugin 图标 + 留档 whale-orig.svg）→ `node tools/icon/render-icons.mjs`（resvg 渲
  染 layered background/foreground 1024 + startIcon 288）。改图标只改脚本再重跑，勿手改 PNG；
  plugin/icon.svg 由 compose 脚本生成，勿手改。

### 会话消息里的图片（契约 §5.10 v1.0.9）
- 手机端**没有**浏览器的图片 URL 通路（`ctx.uiConversation.imageUrl` 是 Web 专属），
  图片一律走 wire：插件压缩好的**缩略图 data URI 内联**在 `ChatMessage.images[]` /
  `assistant.image` 事件里，**大图按需 `image.fetch`** 拉（`maxEdge` 缺省 1600、上限 4096）。
- 类型：`protocol.ets` 的 `DshrcImageRef{imageId, mediaType, width, height, bytes, thumb}`、
  `DshrcChatMessage.images?`；常量 `MSG_IMAGE_FETCH` / `TOPIC_ASSISTANT_IMAGE`。
- 渲染（`TimelineView.ets`）：缩略图按 width/height 等比（最大宽撑满气泡、最大高 ≤320vp）；
  `thumb` 为空（插件降质后仍超限）→ **灰色占位框**；点击进 `ImageViewerPage`
  （全屏大图 + 双指缩放/拖动/关闭）。**纯图片消息（正文为空）不画空气泡**。
- 直播 `assistant.image`：挂到**当前正在流式的 assistant 消息**；没有流式消息就单独成一条
  图片消息（`text` 为空串）。同一 imageId 重复到达幂等。
- `store.fetchImage(imageId, maxEdge?)` 带内存缓存（key = imageId@maxEdge）；
  失败**只提示**（契约：图片可选，不阻塞会话其余功能）。

### 交付物图片独立成条 + 排队显示（契约 §5.10.2 / §5.2 v1.1.1）
- **交付物（present 投递的文件）必须独立成条**：`ImageRef.source === 'deliverable'`
  → **不挂**到正在流式的 assistant 消息，直接新建独立图片消息。
  根因：流式消息在 turn 结束刷新历史时会被**宿主持久副本替换**（副本里没有交付物图）
  → 图「一闪而过然后消失」（用户实测）。插件侧同时把交付物图塞进 `session.history`
  的独立历史消息，于是刷新/重开/重连都还在。
- 历史去重：`mergeHistory` 里 `imagesCoveredByPage()`——直播的独立图片消息若在 durable
  历史里已有同 imageId，摘掉直播副本（只对**正文为空**的图片消息生效，不误删带正文的流式消息）。
- **排队**：`session.queue` 事件（插件从宿主 `agent/inbox/spliced` / `user/message` 追踪）
  → `store.queueItems(sid)`；`store.queueVersion`（`@Trace`）驱动页面刷新。
  列表**只展示宿主推来的内容，不做猜测**；空列表整块不渲染。
  事件只在**变化时**推 → 打开会话时还要 `store.loadQueue(sid)` **拉一次快照**
  （断线重连后光靠事件补不上：列表空着但桌面端明明排着一条）。
- **发送模式**：投递行为（排队/插话）**由 DSH 的设置决定**，手机端**只读不选**
  （用户明确要求：「插话还是排队不应该手机上设置，应该跟随 DSH 的设置」）。
  - 手机端**不发** `mode`；插件读宿主「繁忙时的发送行为」（`ui-conversation.busyEnter`，
    与桌面端 composer 同一处），agent 忙时按设置投递、空闲时总是 queue。
  - `session.capabilities` 回 `busyEnter`（只读）→ `store.busyEnter` → 详情页显示
    「繁忙时：排队发送（跟随 DSH 设置）」这类**只读**提示（原可切换的两段式胶囊已删除）。
  - 宿主拒绝插话时**插件自动退回 queue**（桌面端此时置灰 steer，手机不能把消息弄丢）。
- **排队列表只显示排队项**（v1.1.2 用户反馈）：`pendingQueue()` 过滤 `target==='next-step'`
  （已插入当前 turn 的不显示——它们已被当前任务持有，等消费即可），徽标统一「排队中」。
- **时间线 Repeat 是全量加载模式：key 相同 → 复用节点、不重跑 each**（官方语义）。
  所以 `mergeHistory` **绝不能给同 key 换新实例**（直播步骤 `'s'+callId` 与历史步骤同 key；
  重复拉页时消息同 id）——屏幕卡片绑旧实例，换实例后 @Trace 更新永远到不了 UI
  （症状：下拉刷新后步骤永远停在 running，列表不再更新）。修法：`oldById` 复用旧实例 +
  `transferTimelineFields()` 原地搬字段（身份稳定 + @Trace 原地更新），另加 `reusedIds`
  防同实例进两个数组。见全局记忆 arkui-repeat-refresh-not-updating。
- **思考块用独立的 markdown 控制器**（`mdCtrlReasoning`）：思考块刻意弱化
  （`FS_SMALL` + `label_secondary`），复用气泡的正文主题会让「思考」和「回答」分不开
  （用户反馈「思考中的文字颜色和之前版本不一致」）。`setupMarkdownTheme()` 拆成
  `applyMarkdownTheme(ctrl, dim)`，两套主题同源。
