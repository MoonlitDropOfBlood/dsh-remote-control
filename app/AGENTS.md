# AGENTS.md — app/（HarmonyOS 手机 App）

DSH Pocket（DSH 遥控器；ArkTS / ArkUI，DevEco 工程，bundleName=com.dukedsh.remotecontrol）。
协议契约见 [../docs/PROTOCOL.md](../docs/PROTOCOL.md)；全局约定见 [../AGENTS.md](../AGENTS.md)。

## 结构（devecocli create 脚手架，勿手搓骨架）

```
entry/src/main/ets/model/    protocol(KAT向量) / crypto(HKDF+AES-GCM+HMAC) / link(WS链路)
                             store(Preferences) / connections(多远程配置) / sessionstore(事件仓)
                             attachments(输入框附件：选择/转码/分块上传) / attachment-plan(纯 TS 上限与分块)
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
- **所有 subagent 的模型/强度/权限只读**：三项信息放在输入分支之外，one-shot 也必须可见；
  continuable 只保留消息输入，不得打开模型或权限选择面板。`custom` 权限只显示，不是可选预设。

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
- **v1.1.7 收发闭环**：`link.ets` 对全部业务帧串行完成解密+分发、加密+发送；
  停止/断线/重连使旧代次回调失效。历史合并支持 durable 聚合文本覆盖同 turn 的多个 live 片段，
  空闲最新页清理已完成的助手/思考直播副本；不得靠忽略 `turn.end` 后事件来掩盖乱序。
- 工作步骤卡与组头的 chevron 都用 **18×16 固定尺寸 SymbolGlyph**，禁止文字箭头影响行高。
  reasoning 用独立 ReasoningCard（默认收起的弱化「思考过程」），不进 assistant 气泡/StepGroup。

### 新建会话的模式 / 权限 / 模型 / 思考强度（契约 §5.8 v1.0.7+v1.0.8）
- `session.capabilities` → presets / permissions / models（含 efforts 强度目录）及对应默认项；目录为空隐藏选择区。
- `sessionCreate(title, agentPreset?, permission?, cwd?, model?)` 返回 DshrcCreateResult；
  modelError 只提示并继续首条 prompt，**不得重复 create**。unsupported 回退仅去掉 preset/permission，
  保留 cwd/model。
- 新建页**不填标题**：首屏输入首条任务，工作目录/模型+强度（ModelFieldCard 一卡两行）/模式/权限都用
  Select；强度档位 = 所选模型 `efforts`（首项「默认」= 不提交 reasoningEffort），换模型重置为该模型
  默认档；目录候选 = 「默认目录」（Host `~/.dsh/remote`，空 cwd 由插件解析并建目录）
  + 现有会话 cwd 去重。create 成功但 prompt 失败也要进详情提示重试。

### 会话中切换模型 / 思考强度 / 权限（契约 §5.8 v1.0.8 + v1.1.7）
- 入口在**详情页输入区上方的模型与权限胶囊**。根会话点开 bindSheet 选模型+强度或权限，
  分别调 `store.applyModelSelection` / `store.applyPermissionSelection`，Host 拒绝 toast 原文。
- 当前模型：`store.sessionModel`（`session.model` 拉取 + `session.modelChanged` 事件实时覆盖；
  null = 插件无记录 → 回退显示目录默认）。下一次 prompt 组装即用新模型，运行中 turn 不受影响。
- 当前权限：`store.sessionPermission`（`session.permission` 拉取 + `session.permissionChanged`
  事件实时覆盖；断线恢复也补拉）。`custom` 是 Host 派生当前态，只显示、不能作为选择目标。
- **subagent 三项都只读**，one-shot 也不隐藏这三项；continuable 只保留消息输入。

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
- **断线恢复 = 权威拉取，不依赖中继缓存**（v1.1.2）：中继离线缓存（256 条/24h，重连补发
  + sid:seq 去重）只覆盖「手机掉线但中继活着」的短窗——中继跑在插件下，DSH 重启/插件重载
  会把它一起带走、缓存清零。宿主会话日志才是唯一事实源：`onLinkState('online')` 时对
  **活动会话**重拉 `loadHistory`（错过的消息/步骤/图片/交付物全补齐）+ `loadQueue` +
  根会话 `loadSubagents`。审批/提问缺失由 fail-open 兜底（桌面答案器/超时），**手机永远
  不是单点**。
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
- **v1.1.3 抗重放：会话纪元（契约 §3.4.1）**——手机端是 **client 角色**：
  - 传输层 hello 带 `e`(纪元)/`ts`/`pv=2`/`sid`，`sig` 换成 v2 证明串
    `hello2|role|channel|e|ts|pv|sid`（旧的 `hello|role|channel` 保留给旧插件互操作）。
  - **对端证明从 `welcome.peer` / `peer-joined.peer` 拿**（中继原样透传，插件的证明）→
    验签 → 判定模式（双方 pv≥2 = 加固）→ **钉扎插件的 sid** → 收帧时 sid 不符即丢。
  - **纪元持久化**：自己的纪元跨重启单调递增（存在远程配置里）；「已接受的对端最高纪元」
    也持久化——对端纪元回退（≤ 已接受值）= **拒绝连接**（同一份证明重复出现则幂等接受）。
  - **AAD 两模式**：兼容 `dshrc|role|seq`；加固 `dshrc|role|seq|sid`（sid = 发送方自己）。
  - **业务 hello 必须在 welcome 之后发**（否则还不知道对端 pv → AAD 选错）。
  - 自己的 sid 本来就有（`newSid()`），只是过去没进 AAD。

## v1.1.4：会话内模型对齐 PC + 时间线改 List（2026-10-28，契约 v1.1.4）

用户实测反馈驱动的四处改动：

### ① 会话内模型/思考强度：数据源与 PC 同源

- 插件侧 `session.model` 改读宿主 `modelSelection` 持久投影（见 plugin/AGENTS.md v1.1.4 ①）。
  App 侧**不用改取数口径**（仍 `session.model` + `session.modelChanged` 事件），
  但**断线恢复必须补拉**：App 从后台切回时若 WS 正在重连，
  `aboutToAppear` 那次 `session.model` 会落在断链窗口里静默失败
  （`loadSessionModel` 开头 `getState()!=='online'` 直接 return，**不报错、不重试**）
  → 链路恢复后模型永远停在 null → **所有会话显示目录默认模型**。
  故 `onLinkState('online')` 的断线恢复分支**补一次 `loadSessionModel(activeId)`**
  （与 history/queue/subagents 一起补）。
- `loadSessionModel` 的静默 early-return 现在**打日志**（`session.model skipped: link <state>`），
  避免再出现「静默失败、无法定位」。
- 目录里没有该模型时**不回退默认**：`modelCapsuleText()` 显示 `provider/model` 截断串。

### ② 时间线：`Scroll` → `List`（懒加载 + 可定位 + 直显底部）

- 用户反馈「会话列表是 scroll？不是 list?这个有性能问题吧，而且也不能定位」→
  详情页时间线由 `Scroll` 改 `List` + `Repeat`（**V2 状态管理，列表必须 Repeat 不用 ForEach**）。
- **直显底部**（用户反馈「进入会话会有滑动到底的动画」）：`List` 用
  `initialIndex`（落在最后一条）+ `.stackFromEnd(true)`（内容不满一屏时底部对齐）
  → 首帧即底部，**无滚动动画**（`Scroll` 的 `scrollEdge(Edge.Bottom)` 会播动画，故弃用）。
- **懒加载 + 节点复用**：`Repeat` 用 `.templateId()` + 三个 `.template(...)`
  （message / reasoning / group，各 `cachedCount:4`）+ `.virtualScroll()`，
  `List` 侧 `.cachedCount(4)` + `.maintainVisibleContentPosition(true)`。
  - ⚠️ **`Repeat` 的 `.template()` 不能包 `@ReusableV2` 组件**
    （构建报错「The template attribute of the Repeat component cannot contain any
    custom component decorated with '@ReusableV2'」）→ `TimelineView.ets` 的
    `MessageBubble`/`ReasoningCard`/`StepGroup` **一律不加 `@ReusableV2`**，
    复用由 Repeat 的模板池负责。
  - ⚠️ **`Repeat` 必须有 item builder**：只写 `.template()` 不写 `.each()` 会崩
    （真机实测 `__Repeat item builder function unspecified. Usage error`）。
    按官方 FAQ（`faqs-arkui-606`）用 `.each()` 作兜底 builder，顺序为
    `.each()` → `.key()` → `.virtualScroll()` → `.templateId()` → `.template()`。
  - **复用下的状态**：折叠/展开状态放**数据侧**（`TimelineItem.expanded`，`@Trace`），
    不放组件的 `@Local`——节点被回收复用后 `@Local` 会丢。
- **悬浮回底按钮**（用户要求「需要动画」）：`Stack{alignContent: BottomEnd}` 包
  `Refresh`+`List`，右下角 `Button`（`sys.symbol.chevron_down`），
  点击 `scroller.scrollTo({yOffset: maxOffset, animation:{duration:280, curve: EaseOut}})`；
  显隐用 `transition(OPACITY.combine(scale(0.7)))`。
  - ⚠️ **「是否在底部」不能用 `contentSize()/currentOffset()` 算**：List 用
    `initialIndex` + 懒加载时，未布局部分是**估算值**（官方文档明说会误差）→
    算出来的「距底部距离」误判成仍在底部 → **按钮永不出现**。
    改用 `List.onScrollIndex` 维护「最后一条可见项索引」判定。
- `SystemNote`（系统消息）组件与渲染分支**删除**（插件已不再桥接 system.message）。

### ③ 代码块复制（用户反馈「报没有设置」）

- markdown 库的代码块/表格/文本选中复制回调（`setCodeCopyListener` /
  `setTableCopyClickListener` / `setTextSelectionCopyListener`）原先**没有接线**
  → 点复制报「没有设置」。现统一走 `copyToClipboard(text)`：
  `pasteboard.getSystemPasteboard()` → `createData(MIMETYPE_TEXT_PLAIN, text)` → `setData`。
  - ⚠️ 类型是 **`pasteboard.SystemPasteboard`**（没有 `pasteboard.Pasteboard` 导出）。

### ④ 会话详情页取参与生命周期

- `HRouter.registerLifecycle` 的 `onShown` **会再次触发** → 回到会话时要补拉
  历史与模型；`onAppear` 兜底重读参数（真机时序差异）。


## v1.2.0：输入框附件（2026-11-06，契约 §5.11）

与 DSH 桌面端 composer 同能力：图片（png/jpeg/webp/gif）与任意文件。wire 走
`attachment.upload.begin/chunk/commit/abort` + `session.prompt.uploads[]`（契约 §5.11），
**不是**把 base64 塞进 prompt（中继单帧 1MiB）。只对**根会话**开放；subagent / one-shot /
宿主没有 `capabilities.attachments` 时**不显示附件入口**。

### 文件分工

| 文件 | 职责 |
|---|---|
| `model/attachment-plan.ts` | **纯 TS**（node 回归共用）：`planChunks` / `clampChunkBytes`（≤256KiB）/ `attachmentFileName` / `formatAttachmentSize` / `normalizeAttachmentCaps` / `checkAttachmentDraft`（数量/单项/合计上限） |
| `model/attachments.ets` | `DraftAttachment`（@ObservedV2/@Trace，字节放模块级 Map 不进状态树）；`PhotoViewPicker`/`DocumentViewPicker`；OOM 防线（先 stat 后读，单项 maxItemBytes + 256MiB 硬顶，固定 1MiB 临时块）；图片直传判定（宿主类型 + ≤8MiB + ≤6400 万像素 + 宽高 ≤65535）否则转码（透明→webp、否则 jpeg、长边 2048、q85，ORIENTATION 6/3/8→rotate）；缩略图 240 JPEG q70 data URI；`uploadDraftAttachment` 串行 begin→chunk→commit |
| `model/protocol.ets` | `CONTRACT_VERSION='v1.2.0'`；4 个 `MSG_UPLOAD_*`；`DshrcAttachmentCaps/DshrcUploadBegin/DshrcUploadedAttachment/DshrcFileRef`；capabilities.attachments?；ChatMessage.files?；`payload.data` 是「事件对象 / 分块 base64 字符串」联合类型 |
| `model/link.ets` | 4 个上传请求（20s/30s/150s/15s）+ `sessionPromptResult(sid,text,uploads?)`（旧调用兼容） |
| `model/sessionstore.ets` | `@Trace attachmentCaps`（断线/切远程清空）、`attachmentLimits()/attachmentsSupported()`、`TimelineItem.files`、`mergeHistory` 映射 files、`pushLocalUser` 附件参数、附件-only 乐观消息去重 |
| `model/timeline-reconcile.ts` | `collectCoveredLiveAttachmentIds`：role=user + 正文空 + imageCount/fileCount 完全一致，一条 durable 只消费一条 live（assistant 交付物仍按 imageId 走 `imagesCoveredByPage`） |
| `pages/SessionDetailPage.ets` | 「+」bindMenu（图片/文件）、附件 chips（图片 56vp 缩略图 / 文件卡 + xmark）、上传进度、send 串行上传后再带 uploads 发 prompt；失败保留草稿与已 commit 的 uploadId（重试不重复上传）；只有 prompt accepted 才清空 |
| `pages/TimelineView.ets` | `MessageFiles` 文件卡（doc 符号+名称+大小）、图片在前文件在后、纯附件不画空气泡、`local:` 乐观图片不响应点大图（`image.fetch` 必失败） |

### 行为口径 / 坑

- **乐观上屏在 prompt accepted 之后**（不是上传前）：附件场景 prompt 失败要保留草稿重试，
  先上屏会留下重复气泡；附件-only（text 空）也合法，`MessageBubble` 不画空气泡。
- **uploadId 复用**：commit 成功即写回 `DraftAttachment.uploadId`；prompt 失败后重试
  直接复用（插件 receipt 未消费可重试）。宿主 `accepted:false` 同理。
- **分块必须先上传成功再发 prompt**：`session.prompt.uploads` 只能带已完成 commit 的 id；
  同一 uploadId 只能被一条 prompt 成功消费（插件回 `attachment-upload-consumed`）。
- **上传期间禁用发送与附件菜单**；删除 chip 只释放本地字节（宿主已 commit 的附件不可撤回）。
- **`user/message` 历史里的图片**（PC 端发的）与手机发的都走 `images[]`；文件走 `files[]`；
  旧插件不返 `files` 时按空数组。
- **真机待验证**：picker URI 直接 `fs.openSync`、`ImageSource` EXIF 方向是否已被解码器应用
  （代码注释里标了「双重旋转」开关）、HEIC→JPEG / 透明 PNG→WebP 转码。
  无真机时只能 build+linter 级验证。
- 附件字节/文件名**不进日志**（`logDshrc` 只打 kind/chunks/uploadId 前缀）。
- 回归：`node attachment-contract-test.mjs`（纯函数 + 接线 grep）；
  `node live-order-node-test.mjs` / `node session-detail-contract-test.mjs` 不得回归。

## v1.2.1：沉浸式 + 详情页顶栏/输入区改版（2026-11-06，真机 + 模拟器实测）

用户反馈「底部/顶部不好看」后的 UI 改版，**协议不变**（v1.2.0 契约照旧）。

### 沉浸式（组件级，不用窗口级全屏）

- **不要用 `window.setWindowLayoutFullScreen(true)`**：真机/模拟器实测，它和软键盘避让
  冲突——键盘收起后页面停在「键盘高度」，下半屏露黑（`setKeyboardAvoidMode` 两种模式都复现）。
  改成**组件级**：每个页面根容器加
  `.expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])`，
  只扩绘制区域、不重排子节点 → 背景铺到状态栏/导航条，内容仍由系统安全区避让。
  配合 `EntryAbility.applyImmersiveBars()` 把系统栏底色设为透明（`SYSTEM_BAR_TRANSPARENT`，
  平台 API 只吃字符串色值，故在 theme.ets 里落成具名常量）。
- 页面根容器必须是「贴住安全区上下边界」的容器（各页最外层 Column），且不能设固定宽高。
- **软键盘避让模式统一 `KeyboardAvoidMode.RESIZE`**（`Index.aboutToAppear` 里设置）：
  标题栏保持可见、消息区压缩、输入卡贴在键盘上方。OFFSET 会把整页顶出屏幕（顶栏消失）。
- `setKeyboardAvoidMode` 只需在首个页面设置一次（UIContext 级全局）。

### 详情页顶栏（`SessionDetailPage.topBar`）

- 返回键用 `sys.symbol.chevron_left`（文字 `‹` 在不同字体下基线会飘）；
  标题 + 状态行（主机在线/离线）+ 右侧状态胶囊（运行中/空闲），底部 1px `border_l1` 分隔线。
- 顶栏背景 `bg_base`，由页面根容器 `expandSafeArea` 铺到状态栏区域（沉浸式）。

### 详情页输入区（composer）

- 结构：模型胶囊 + 权限胶囊（一行）→ 可选「繁忙时插话/排队发送」右对齐小字（仅运行中）
  → 附件 chips → 输入卡（`RADIUS_COMPOSER` 白色圆角面板：`+` 附件、`TextArea`、
  运行中圆形停止按钮、圆形纸飞机发送按钮）。
- **两个 ArkUI 布局坑（真机实测）**：
  1. `Row().width('100%')` 再配 `margin` **不会内缩**（宽度先按父级 100% 算，margin 被吃掉）
     → 卡片两侧贴边。内缩必须加在**外层容器**的 `padding` 上（composer 外面包了一层
     `Column().padding({left: SP_3, right: SP_3})`）。
  2. `Scroll` 会把**比视口窄**的子节点默认**居中**（子代理行整行飘到中间）
     → 给 Scroll 的子 `Row` 加 `.constraintSize({ minWidth: '100%' })`，内容更宽时照常滚动。
- 「繁忙时插话发送」这类提示**不要塞进胶囊行**（模型/权限胶囊已占满，文字会被挤出屏幕）；
  放在输入卡上方的独立右对齐行。
- 发送按钮禁用态自己配色（`bg_layer_2` + `label_tertiary`），圆形图标按钮没有文字提示。
- 输入框 placeholder 用「输入提示词…」（手机键盘没有 Enter 发送语义，别再写 Enter）。

### 构建配置

- `compatibleSdkVersion` **保持 `"26.0.0"`**（发版口径）。只有在**模拟器**上跑时才临时降到
  `"6.0.0(20)"`——模拟器镜像最高 API 20，装不上 API 26 的包；降到 20 后真机（API 26）与
  模拟器都能跑，构建无 API 越界报错。改法：`app/build-profile.json5` 的
  `compatibleSdkVersion`（语法：API≥26 用 `"26.0.0"` 字符串，API 10~25 用 `"6.0.0(20)"`
  这种带系统版本号的字符串）。**发版前必须改回 26.0.0**，别把临时降级带进发布包。

## v1.2.2：「工作步骤」改成 DSH 式过程分组（2026-11-06，真机实测）

用户对照桌面端 DSH 提的三点：思考要进工作步骤、标题要动态、聚合用 ListItemGroup。

### 数据模型（`model/process-activity.ts` 纯 TS + `pages/TimelineView.ets`）

- **过程分组 = 思考块 + 工具调用**（桌面端同一个 process group）：`groupTimeline()` 把连续
  的 `reasoning` / `step` 归一组，遇到消息就断开（DSH：分组在两次独立回复之间）。
- `model/process-activity.ts`（纯 TS，node 直接 import .ts）**逐字对齐**桌面端
  `@deepseek-ai/dsh-client-ui-chat`：
  - `activityOfTool()` = 桌面端 `activity()`（read/read_image/grep|glob|*_inspect/write/
    edit|apply_patch/bash|pwsh|exec_command|write_stdin|terminal_*/run_code/web_search/
    web_fetch/subagent*/todo_write|goal/ask_user_question → 14 类，兜底 tools）；
  - 文案 = `message.stepProcess.*` 的简体中文词条（正在…/已…）；
  - `composeProcessTitle()` = 桌面端 `processTitle()`：取前三类，2 类用「并」且两边都以
    「已」开头时**只保留一个「已」**；3 类起用「，」连接（**不**剥「已」）；>3 类加「等」；
  - `reasoningPreview()` = 桌面端 `latestCompletedParagraphFirstLine()`（流式时取**最近一个
    首行已写完的段落**，去 `**`）+ `processLiveDetail()`（参数里挑 command/path/description…）。
- 标题：**运行中**=「正在运行命令 · {命令摘要}」/「正在分析请求 · {思考首行}」，组件内自己读
  store 现算；**结束后**=合成标题（「已读取文件并搜索代码」）。组头左侧是**活动图标**
  （`sys.symbol.*`，运行中换成 `LoadingProgress` 转圈）。

### 聚合结构（ListItemGroup + ListItem）

```
List {
  Repeat(entries)
    → template('message') = ListItem { TimelineMessage(cell) }
    → template('process') = ProcessGroup(cell) {
        ListItemGroup({ header: groupHeader(cell) }) {
          Repeat(cell.item.members)
            → template('reasoning') = ListItem { ProcessReasoningCard(memberCell) }
            → template('step')      = ListItem { ProcessStepCard(memberCell) }
        }
      }
}
```

- **组头直接放 `ListItemGroup({ header: ... })`**，成员各自独立 `ListItem`；不要在
  `.each()` 里写 `if`，类型分派只走 `.templateId()` / `.template()`。
- **Repeat 与自定义组件或 @Builder 混用时必须传完整 `RepeatItem`**，不能只传
  `cell.item` / `cell.index`。外层 process 传 `RepeatItem<TimelineEntry>`，组头 Builder 也显式
  接收同一对象；内层成员包装传 `RepeatItem<TimelineItem>`。同样规则覆盖 TimelineMessage、
  MessageImageItem、SessionCard、SubagentChip、ApprovalRepeatCard、QuestionRepeatCard、
  AskQuestionBlock、remoteRow 与 attachmentChip。原生 Text/Checkbox 等直接读 cell.item 不受此限。
- `TimelineEntry` 是 **@ObservedV2 类**（@Trace key/isProcess/head/members/groupExpanded），
  `groupTimeline()` 按稳定 key 复用实例并原地更新 members；**key 不含成员数**，新增成员不换 key。
- 插话是追加一个 `isProcess=false` 的消息项，再把后续过程放进新组；**旧过程组的类型仍保持
  `isProcess=true`**，否则 Message 模板会把 reasoning/step 的 head 误当消息。与 DSH 对齐的
  状态迁移是旧组 **`closed=true`**（`ProcessGroup.closed` / `flush(true)`）：message 到达即关闭，
  组头立刻从运行态切到合成完成态，即使末项还遗留 running；类型与关闭态不能混用一个字段。
- 分组**默认折叠**；折叠态存 `TimelineEntry.groupExpanded`，与条目自己的 `expanded` 分开。
  折叠用 `.visibility(...)`，子项保持挂载。真机验收须覆盖第一次插话、组头 running→finished、
  展开成员及滚动复用，不能只看 build 成功。

### 回归

- `node process-activity-contract-test.mjs`（分类/文案/标题合成/思考摘要/运行细节）
- 既有 `attachment-contract-test` / `session-detail-contract-test` / `live-order-node-test` 不得回归。

## 2026-11-08：新建会话首发附件（协议不变）

- `NewSessionPage` 与详情页一样提供「图片 / 文件」选择、上限校验、附件 chips 与逐项上传进度；
  正文可空，**附件-only 也能创建并发送**。
- 线协议仍是 v1.2.0，**不给 `session.create` 增加附件字段**：先 `session.create` 拿到新 sessionId，
  再按 §5.11 串行 `attachment.upload.*`，最后 `session.prompt.uploads[]`。
- 只有 prompt accepted 才清空并释放本地附件。create 成功但上传/prompt 失败时，
  `SessionStore.stashFirstPromptDraft` 把正文、附件与已 commit 的 uploadId 一次性移交详情页；
  `SessionDetailPage.restoreFirstPromptDraft` 恢复后重试，**不得重复 create 或重复上传**。
  新建页移交时只清空本页引用、不释放字节；详情页接手发送成功/删除/退出时的原有释放生命周期。
- 回归：`node attachment-contract-test.mjs` 新增新建页顺序、附件-only、失败移交与禁止重复 create 的接线断言。

## 2026-11-08：历史错误归属详情页（协议不变）

- `session.history` 失败**不得再写首页全局 `lastError`**：SessionStore 用
  `historyErrorSessionId/historyErrorMessage` 记录会话归属，详情页通过 `historyErrorFor(sessionId)`
  读取自己的完整错误原因，并提供「重新加载」；首页不再截断或抢走这类错误。
- 开始/成功加载会清除该会话旧错误，断开或切换远程时清空，避免跨主机串错。
- 回归：`node session-detail-contract-test.mjs` 包含历史错误归属、详情卡与重试接线断言。

## 2026-11-08：回合完成后的幽灵 process group（协议不变）

- 症状：最终助手消息后偶尔多出一个分组，重启 App 后消失。根因是历史/直播竞态把
  `seq=-1` 的迟到 reasoning 或 orphan step 留在尾部；`groupTimeline` 只是把这些真实残留归组，
  **不是 Repeat 凭空多画节点**，不要靠改 key/禁复用掩盖。
- `turn.end` 先把该会话视为空闲，再触发最新页 `loadHistory`；在途请求由 pendingHistory
  自动追加尾随刷新。`session.status` 的 `running:true→false` 另作 turn.end 丢失时的对账兜底。
- `collectCoveredLiveStepIds`：运行中/向前翻页仍按 callId 去重；**非 prepend 最新页 + Host 空闲**
  接管全部 live steps，包括没进入本页的 orphan，防止它们统一挪到最终消息后形成幽灵组。
- 回归：`node live-order-node-test.mjs` 覆盖 orphan step 的运行中保留、空闲清理及两条完成触发路径。

## 2026-11-10：回前台/重连后的尾巴幽灵工作步骤（协议不变）

- 症状（用户实测，2026-11-08 那次修复后仍复现）：回合完成后把 App 切到后台、再切回前台，
  **最终助手消息之后仍多出一个「工作步骤」分组**；重启 App 才消失。
- 根因（两个缺口叠加）：
  1. 后台冻结窗口里 `turn.end` 常丢，`row.running` 停在 true；而 WS 又常停在 `online`
     （`kickReconnect` 只对 `reconnecting` 生效）→ 回前台既没有重连、也没有权威对账。
  2. 即便重连，旧代码在 `onLinkState('online')` 里**并行**发 `session.list` 与
     `session.history`：历史先回包时用残留的 `running=true` 判 authoritativeIdle=false，
     mergeHistory 对非空闲页只按 callId 去重 → 已结束回合的残留 live 步骤/思考留在尾部；
     列表随后把 running 改回 false，但**没有任何再次对账** → 幽灵挂到重启。
- 修复（`model/sessionstore.ets` + `entryability/EntryAbility.ets`）：
  - 新增 `onAppForeground()`（`EntryAbility.onForeground` 调用）与唯一对账入口
    `reconcileActiveSession()`：**先 `session.list`（running 真值）→ 再历史/队列/模型/权限/子代理**；
    重连与回前台共用同一入口，禁止再各写一份口径。
  - `loadHistory(sid, prepend, listWaited)`：最新页请求遇 `pendingRefresh` 在途时**先等列表落地**
    再发历史，保证 authoritativeIdle 读的是新鲜真值（详情页首次进入/回落路径同样受益）。
  - 追加一次 1.2s 的「迟到补发」扫描（`scheduleSettleReconcile`）：宿主空闲、且尾部只剩
    **已定稿**的直播过程项时再拉一页权威历史；流式思考 / status=running 步骤 / 直播消息
    一律不动（可能是回前台后刚开始的新回合）。判定抽到纯 TS
    `timeline-reconcile.hasTrailingSettledLiveProcess`（node 回归共用）。
  - 硬约束：`session.list` 与 `session.history` **不得再并行**（历史最新页不得在列表在途时抢跑）。
- 回归：`node live-order-node-test.mjs` 新增尾部幽灵判定 8 例（已定稿思考/步骤要被接管；
  流式思考、running 步骤、直播消息不得被清）+ 回前台对账/等待列表的接线断言。
