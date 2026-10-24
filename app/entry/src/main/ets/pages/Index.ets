/*
 * Copyright (c) 2026 dukedsh.
 * 首页：会话列表（Navigation 根页，v1.0.6）。
 *  - 顶栏：左标题（会话 / 已归档）+ 归档视图入口；**右上角 = 连接信息按钮**
 *    （链路状态点 + 状态文案 + 当前远程名）→ model/routes.openConnections()
 *  - 待审批横幅：pendingCount() > 0 时显示 → openApprovalQueue()
 *  - 会话列表：Refresh + List + 会话卡（标题 / 运行徽标 / 工作目录 / 相对时间 / ›）
 *    → openSessionDetail(sid)；显示规则不变（只显示根会话、非 blank，updatedAt 降序）
 *  - **手机本地归档（v1.0.6）**：左滑 = 归档 / 恢复；归档后从普通列表隐藏，
 *    顶栏可切到「已归档」视图。仅存本机 Preferences，不删/不归档 DSH 主机会话，
 *    不改 host/wire 协议。
 *  - 底部固定操作区：「新建会话」品牌主按钮 → openNewSession()（已归档视图隐藏）
 *  - 推送点击直达（契约 §6 intent）：takePendingNav / EVT_PENDING_NAV 消费逻辑保留
 * 设计：卡片 bg_layer_1 + 1px border_l1 + 12vp 圆角；主按钮 brand_fill 配 label_on_brand。
 */
import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { EventPost } from 'eventpost';
import { HRouter } from 'hrouter';
import { EVT_PENDING_NAV } from '../model/events';
import { ConnectionStore, RemoteProfile, connectionStore } from '../model/connections';
import { dshrcLink, LinkState } from '../model/link';
import { openApprovalQueue, openConnections, openNewSession, openSessionDetail } from '../model/routes';
import { PendingNav, SessionListItem, SessionRefreshResult, SessionStore, sessionStore } from '../model/sessionstore';
import {
  FS_BODY,
  FS_CAPTION,
  FS_SMALL,
  FS_SUBTITLE,
  HAIRLINE,
  RADIUS_CARD,
  RADIUS_CTRL,
  RADIUS_PILL,
  SP_1,
  SP_2,
  SP_3,
  SP_4,
  linkStateColor,
  linkStateText,
  relTime
} from '../model/theme';

/**
 * 侧滑操作参数（@Builder 单对象传参：状态按引用传递；类型必须显式声明）。
 */
interface SessionSwipeParam {
  /** 目标会话 id。 */
  sessionId: string;
  /** 该会话当前是否处于「已归档」状态（决定按钮文案与动作）。 */
  archived: boolean;
}

/**
 * 单张会话卡（列表项；只显示根会话——subagent 入口在父会话详情页，契约 §5.3 v1.0.5）。
 *
 * v1.0.6（修「刷新后数据没有变化」）：入参改成**简单原始字段**的 @Param
 * （官方 Repeat 迁移示例5 的写法：`ChildComponent({ data: repeatItem.item.message })`
 * ——向子组件传被观察的原始字段，而不是整个同引用对象）：
 *  - 父组件 build 直接读取数据项的字段并建立依赖；
 *  - 子组件只消费原始类型，不依赖「跨组件观察同一个可变对象」这一不稳定路径。
 * 数据源仍是 store.listItems() 产出的**不可变投影**（每次重建都是新实例），
 * 保证 Repeat 能识别到「数据确实变了」。
 */
@ComponentV2
export struct SessionCard {
  @Require @Param sessionId: string = '';
  @Require @Param title: string = '';
  @Require @Param cwd: string = '';
  @Require @Param running: boolean = false;
  @Require @Param updatedAt: number = 0;
  @Event onOpen: (sessionId: string) => void;

  build() {
    Column() {
      Row() {
        Text(this.title.length > 0 ? this.title : this.sessionId)
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.running) {
          Row() {
            Circle({ width: 6, height: 6 }).fill($r('app.color.brand_fill'))
            Text('运行中')
              .fontSize(FS_CAPTION)
              .fontColor($r('app.color.brand_label'))
              .margin({ left: 4 })
          }
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .margin({ left: SP_2 })
          .borderRadius(RADIUS_PILL)
          .backgroundColor($r('app.color.brand_tint'))
          .alignItems(VerticalAlign.Center)
        } else {
          Text('空闲')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .margin({ left: SP_2 })
            .borderRadius(RADIUS_PILL)
            .backgroundColor($r('app.color.bg_layer_2'))
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.cwd.length > 0) {
        Text(this.cwd)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: SP_1 })
      }

      Row() {
        Text(relTime(this.updatedAt))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_tertiary'))
          .layoutWeight(1)
        Text('›')
          .fontSize(FS_SUBTITLE)
          .fontColor($r('app.color.label_tertiary'))
      }
      .width('100%')
      .margin({ top: SP_2 })
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: SP_4, right: SP_4, top: SP_3, bottom: SP_3 })
    .backgroundColor($r('app.color.bg_layer_1'))
    .borderRadius(RADIUS_CARD)
    .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
    .onClick((): void => {
      this.onOpen(this.sessionId);
    })
  }
}

@Entry
@ComponentV2
struct Index {
  @Local navPathStack: NavPathStack = new NavPathStack();
  @Local store: SessionStore = sessionStore;
  @Local conn: ConnectionStore = connectionStore;
  @Local refreshing: boolean = false;
  /** 是否处于「已归档」视图（v1.0.7：Host 权威归档，契约 §5.9）。 */
  @Local showArchived: boolean = false;
  /** 列表投影缓存键（listVersion + 视图；变了才重建投影）。 */
  private projKey: string = '';
  /** 列表投影缓存（不可变 items；数据没变时复用同一数组 → Repeat 不做无谓 diff）。 */
  private projItems: SessionListItem[] = [];

  aboutToAppear(): void {
    // hrouter：把本 Navigation 的栈注册为默认栈；页面跳转统一走 model/routes.ets。
    HRouter.registerNavPathStack('default', this.navPathStack);
    const ctx: common.Context = getContext(this) as common.Context;
    this.conn.load(ctx);
    this.store.refreshSessions();
    this.autoConnect(ctx);
    // 推送点击直达（EntryAbility onNewWant / onCreate 写入后回调这里）
    this.store.onPendingNav = (): void => {
      this.consumePending();
    };
    // 事件总线订阅（eventpost onFromComponent：组件销毁自动反注册，无需手动 off）。
    // 与上面的直接回调并行——consumePending 幂等（takePendingNav 消费后即清空）。
    // sticky=true：EntryAbility.onCreate 的写入早于本页挂载，补收最近一次。
    EventPost.getDefault().onFromComponent(EVT_PENDING_NAV, this, (): void => {
      this.consumePending();
    }, true);
    // 返回本页时刷新（hrouter 生命周期；根页未挂 NavDestination 时注册静默跳过，
    // 实际兜底是下面 onVisibleAreaChange 的「重新可见」判定）。
    HRouter.registerLifecycle(this, {
      onShown: (): void => {
        this.refreshList();
      }
    });
  }

  aboutToDisappear(): void {
    this.store.onPendingNav = null;
  }

  /** 消费推送点击目标：有 askId 直达审批队列，否则直达会话详情（契约 §6）。 */
  private consumePending(): void {
    const p: PendingNav = this.store.takePendingNav();
    if (p.askId.length > 0) {
      openApprovalQueue();
      return;
    }
    if (p.sessionId.length > 0) {
      openSessionDetail(p.sessionId);
    }
  }

  /** 刷新会话列表（未连接时 store 内部直接跳过）。 */
  private refreshList(): void {
    this.store.refreshSessions();
  }

  /**
   * 启动时自动连上「当前远程」：配好远程后冷启动即可用，不必每次手动点连接。
   * 链路已在跑（连接中/已连接/重连中）时不打断。
   */
  private autoConnect(ctx: common.Context): void {
    const active: RemoteProfile | undefined = this.conn.activeProfile();
    if (active === undefined) {
      return;
    }
    const st: LinkState = dshrcLink.getState();
    if (st !== 'idle' && st !== 'stopped') {
      return;
    }
    this.conn.activate(ctx, active.id);
  }

  /**
   * 列表数据源（不可变投影 + 缓存）。
   *
   * v1.0.6 修复「刷新后数据没有变化」：
   *  - 数据源是 store.listItems() 产出的**新实例**（纯原始字段）——Repeat 以
   *    item 引用判断「数据是否变化」，复用可变实例会被判定为「没变」；
   *  - 按 (listVersion, 视图) 缓存：数据没变就不重建
   *    （数组身份稳定 → Repeat 不做无谓 diff），数据一变就整体重建
   *    （排序 / blank / subagent 过滤 / 归档过滤随之重算）。
   *
   * v1.0.7：归档过滤依据 = 当次 session.list 带回的 **archived 字段**（Host 权威），
   * 所以启动/重连后的首屏就能把主机上已归档的会话分到「已归档」视图，
   * 不依赖 domain/changed 事件，也不依赖本机任何持久化状态。
   */
  private listItems(): SessionListItem[] {
    const key: string = this.store.listVersion.toString() + ':' + (this.showArchived ? '1' : '0');
    if (key !== this.projKey) {
      this.projKey = key;
      this.projItems = this.buildItems();
    }
    return this.projItems;
  }

  /**
   * 按当前视图构建列表项（普通视图 = 未归档；已归档视图 = 已归档）。
   * 依据是 **Host 权威**的 item.archived（契约 §5.9 v1.0.7），本机不再存假归档状态。
   * 顺序沿用 store.listItems() 的 updatedAt 降序（过滤不改变相对顺序）。
   */
  private buildItems(): SessionListItem[] {
    const all: SessionListItem[] = this.store.listItems();
    const out: SessionListItem[] = [];
    for (const item of all) {
      if (item.archived !== this.showArchived) {
        continue;
      }
      out.push(item);
    }
    return out;
  }

  /** 切换「会话 / 已归档」视图。 */
  private toggleArchiveView(): void {
    this.showArchived = !this.showArchived;
  }

  /**
   * 侧滑动作：普通列表 = 归档；已归档列表 = 恢复。
   * 走 **Host 真实归档**（session.archive / session.unarchive，契约 §5.9）：
   * 主机确认后才更新列表；失败按主机错误原文提示，**不做本机假成功**。
   */
  private onSwipeArchive(sessionId: string, archived: boolean): void {
    if (!this.store.archiveSupported) {
      promptAction.showToast({ message: '主机不支持归档', duration: 2500 });
      return;
    }
    this.store.setSessionArchived(sessionId, !archived).then((): void => {
      promptAction.showToast({ message: archived ? '已恢复到会话列表' : '已归档', duration: 1800 });
    }).catch((e: Error): void => {
      const msg: string = e.message.length > 0 ? e.message : '主机拒绝';
      promptAction.showToast({ message: (archived ? '恢复失败：' : '归档失败：') + msg, duration: 3000 });
    });
  }

  /** 下拉刷新：拉 session.list，完成后收起刷新态；失败明确提示（不假装已刷新）。 */
  private doRefresh(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在右上角「连接」里选择远程', duration: 2500 });
      this.refreshing = false;
      return;
    }
    this.refreshing = true;
    this.store.refreshSessions().then((res: SessionRefreshResult): void => {
      this.refreshing = false;
      if (!res.ok) {
        const msg: string = res.skipped ? '未连接主机，未刷新' : ('刷新失败：' + res.error);
        promptAction.showToast({ message: msg, duration: 3000 });
      }
    });
  }

  /** 新建会话 → 新建会话页（选模式 + 权限）。 */
  private onCreateSession(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在右上角「连接」里选择远程', duration: 2500 });
      return;
    }
    openNewSession();
  }

  /** 打开会话详情。 */
  private openSession(sid: string): void {
    openSessionDetail(sid);
  }

  /** 当前远程名（未配置时兜底「未配置」）。 */
  private remoteName(): string {
    const p: RemoteProfile | undefined = this.conn.activeProfile();
    if (p === undefined) {
      return '未配置';
    }
    const n: string = p.name.trim();
    return n.length > 0 ? n : '未配置';
  }

  /**
   * 顶栏连接目标显示名（v1.0.7）：
   *  - 在线且拿到真实 hostName → 显示主机名（最准，指向实际那台机器）；
   *  - 离线 → 显示自定义远程名；「默认远程」没有区分度 → 退到 relay 主机名/地址。
   * 长文本由 maxWidth + ellipsis 兜底，不挤掉状态点。
   */
  private connectionTarget(): string {
    const online: boolean = this.store.linkState === 'online';
    const hostName: string = this.store.hostName.trim();
    if (online && hostName.length > 0) {
      return hostName;
    }
    const p: RemoteProfile | undefined = this.conn.activeProfile();
    if (p === undefined) {
      return '未配置';
    }
    const name: string = p.name.trim();
    // connections.ets 迁移旧配对时用的默认名（该常量未导出，这里按字面量比对）
    if (name.length > 0 && name !== '默认远程') {
      return name;
    }
    const relay: string = this.relayHostLabel(p.relayUrl);
    if (relay.length > 0) {
      return relay;
    }
    return name.length > 0 ? name : '未配置';
  }

  /** relay 地址 → 主机名:端口（去掉 ws:// / wss:// 前缀）。 */
  private relayHostLabel(relayUrl: string): string {
    let s: string = relayUrl.trim();
    if (s.startsWith('ws://')) {
      s = s.substring(5);
    } else if (s.startsWith('wss://')) {
      s = s.substring(6);
    }
    const slash: number = s.indexOf('/');
    if (slash >= 0) {
      s = s.substring(0, slash);
    }
    return s;
  }

  /** 顶栏：左标题（会话 / 已归档）+ 归档视图入口 + 右上角连接信息胶囊。 */
  @Builder
  topBar() {
    Row() {
      Text(this.showArchived ? '已归档' : '会话')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
      if (this.store.archiveSupported || this.showArchived) {
        Text(this.showArchived ? '返回' : '已归档')
          .fontSize(FS_SMALL)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.brand_label'))
          .margin({ left: SP_2 })
          .padding({ top: 4, bottom: 4, left: 4, right: 4 })
          .onClick((): void => {
            this.toggleArchiveView();
          })
      }
      Blank()
      Row() {
        Circle({ width: 7, height: 7 }).fill(linkStateColor(this.store.linkState))
        Text(linkStateText(this.store.linkState))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .margin({ left: 5 })
        Text(this.connectionTarget())
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_primary'))
          .margin({ left: 6 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .constraintSize({ maxWidth: 120 })
      }
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .borderRadius(RADIUS_PILL)
      .backgroundColor($r('app.color.bg_layer_2'))
      .alignItems(VerticalAlign.Center)
      .onClick((): void => {
        openConnections();
      })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  /** 待审批 / 提问横幅。 */
  @Builder
  pendingBanner() {
    Row() {
      Text('⏳ 有 ' + this.store.pendingCount().toString() + ' 个审批 / 提问待处理')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.state_warn'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text('去处理 ›')
        .fontSize(FS_SMALL)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.brand_label'))
    }
    .width('100%')
    .padding({ left: SP_3, right: SP_3, top: SP_2 + 2, bottom: SP_2 + 2 })
    .backgroundColor($r('app.color.state_warn_tint'))
    .borderRadius(RADIUS_CTRL)
    .margin({ bottom: SP_3 })
    .onClick((): void => {
      openApprovalQueue();
    })
  }

  /** 错误横幅：刷新失败 / 链路错误必须看得见（不假装已刷新）。 */
  @Builder
  errorBanner() {
    Row() {
      Text('! ' + this.store.lastError)
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.state_error'))
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ left: SP_3, right: SP_3, top: SP_2 + 2, bottom: SP_2 + 2 })
    .backgroundColor($r('app.color.state_error_tint'))
    .borderRadius(RADIUS_CTRL)
    .margin({ bottom: SP_3 })
  }

  /** 空态（在线 / 离线两套文案；已归档视图单独一套）。 */
  @Builder
  emptyState() {
    Column() {
      Text('○')
        .fontSize(40)
        .fontColor($r('app.color.label_tertiary'))
      Text(this.showArchived ? (this.store.archiveSupported ? '暂无已归档会话' : '当前主机不支持归档同步') :
        (this.store.linkState === 'online' ? '暂无会话' : '未连接，暂无会话数据'))
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_secondary'))
        .margin({ top: SP_2 })
      Text(this.showArchived ? (this.store.archiveSupported ?
        '在会话列表左滑可归档会话，已归档的会话会出现在这里' : '请升级主机插件后重试') :
        (this.store.linkState === 'online' ?
          '点下方「新建会话」开始遥控' : '在右上角「连接」里选好远程并连接'))
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 60, bottom: 60 })
  }

  /**
   * 左滑操作按钮（官方写法：`ListItem(){...}.swipeAction({end:{builder:()=>{…}}})`）。
   *  普通列表 = 「归档」；已归档列表 = 「恢复」。
   *  v1.0.7：轻量圆角动作（68vp 宽）——图标（系统 SymbolGlyph）+ caption 文案，
   *  背景走 brand_tint / bg_layer_2，文字走 brand_label / label_secondary，零硬编码色值。
   */
  @Builder
  sessionSwipeAction(param: SessionSwipeParam) {
    Column() {
      // API 20+ 的 SymbolGlyph：构造参数是单个符号资源，fontColor 收**颜色数组**（多层符号）
      SymbolGlyph(param.archived ? $r('sys.symbol.arrow_counterclockwise') : $r('sys.symbol.archivebox'))
        .fontSize(18)
        .fontColor([$r('app.color.brand_label')])
      Text(param.archived ? '恢复' : '归档')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.brand_label'))
        .margin({ top: SP_1 })
    }
    .width(68)
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .borderRadius(RADIUS_CTRL)
    .backgroundColor(param.archived ? $r('app.color.bg_layer_2') : $r('app.color.brand_tint'))
    .onClick((): void => {
      this.onSwipeArchive(param.sessionId, param.archived);
    })
  }

  build() {
    Navigation(this.navPathStack) {
      Column() {
        this.topBar()
        if (this.store.lastError.length > 0) {
          this.errorBanner()
        }
        if (this.store.pendingCount() > 0) {
          this.pendingBanner()
        }
        Refresh({ refreshing: this.refreshing }) {
          List({ space: SP_2 }) {
            if (this.listItems().length === 0) {
              ListItem() {
                this.emptyState()
              }
            } else {
              // v1.0.6：懒加载模式（virtualScroll）——官方文档：全量加载模式下
              // 「页面刷新取决于键值变化，key 相同即使数据改变也不刷新」，且 >30 条
              // 全量加载耗时长（真实宿主有 100+ 会话）。懒加载模式下「键值变化或
              // 数据变化均会触发页面刷新」。
              Repeat(this.listItems())
                .each((cell: RepeatItem<SessionListItem>): void => {
                  ListItem() {
                    // 传**原始字段**给卡片（官方 Repeat 迁移示例5 的写法）：
                    // 父 build 直接读取数据项字段建立依赖，子组件只消费原始类型。
                    SessionCard({
                      sessionId: cell.item.sessionId,
                      title: cell.item.title,
                      cwd: cell.item.cwd,
                      running: cell.item.running,
                      updatedAt: cell.item.updatedAt,
                      onOpen: (sid: string): void => {
                        this.openSession(sid);
                      }
                    })
                  }
                  // 左滑：普通列表 = Host 归档；已归档列表 = Host 恢复（契约 §5.9）
                  .swipeAction({
                    end: {
                      builder: (): void => {
                        this.sessionSwipeAction({
                          sessionId: cell.item.sessionId,
                          archived: this.showArchived
                        });
                      }
                    }
                  })
                })
                .key((item: SessionListItem): string => item.sessionId)
                .virtualScroll({ totalCount: this.listItems().length })
            }
          }
          .width('100%')
          .height('100%')
          .scrollBar(BarState.Off)
          .padding({ left: SP_4, right: SP_4, bottom: SP_2 })
        }
        .width('100%')
        .layoutWeight(1)
        .backgroundColor($r('app.color.bg_base'))
        .onRefreshing((): void => {
          this.doRefresh();
        })

        // 底部固定操作区：已归档视图不显示「新建会话」（归档视图只做恢复）
        if (!this.showArchived) {
          Column() {
            Button('新建会话')
              .width('100%')
              .height(46)
              .fontSize(FS_BODY)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.label_on_brand'))
              .backgroundColor($r('app.color.brand_fill'))
              .borderRadius(RADIUS_CTRL)
              .onClick((): void => {
                this.onCreateSession();
              })
          }
          .width('100%')
          .padding({ left: SP_4, right: SP_4, top: SP_3, bottom: SP_4 })
          .backgroundColor($r('app.color.bg_layer_1'))
          .border({ width: HAIRLINE, color: $r('app.color.border_l1') })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.bg_base'))
      // 根页被 NavDestination 盖住 → 可见比例跌到 0；返回时回到 1 → 刷新列表。
      .onVisibleAreaChange([0.0, 1.0], (isExpanding: boolean, currentRatio: number): void => {
        if (isExpanding && currentRatio > 0.9) {
          this.refreshList();
          this.consumePending();
        }
      })
    }
    .width('100%')
    .height('100%')
    .mode(NavigationMode.Stack)
    .hideTitleBar(true)
    .hideToolBar(true)
    .backgroundColor($r('app.color.bg_base'))
  }
}
