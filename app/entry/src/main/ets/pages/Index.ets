/*
 * Copyright (c) 2026 dukedsh.
 * 首页：会话列表（Navigation 根页，v1.0.6）。
 *  - 顶栏：左标题「会话」；**右上角 = 连接信息按钮**（链路状态点 + 状态文案 + 当前远程名）
 *    → model/routes.openConnections()（连接管理页里可管理多个远程）
 *  - 待审批横幅：pendingCount() > 0 时显示 → openApprovalQueue()
 *  - 会话列表：Refresh + List + 会话卡（标题 / 运行徽标 / 工作目录 / 相对时间 / ›）
 *    → openSessionDetail(sid)；显示规则不变（只显示根会话、非 blank，updatedAt 降序）
 *  - 底部固定操作区：「新建会话」品牌主按钮 → openNewSession()
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
import { PendingNav, SessionRow, SessionStore, sessionStore } from '../model/sessionstore';
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

/** 单张会话卡（列表项；只显示根会话——subagent 入口在父会话详情页，契约 §5.3 v1.0.5）。 */
@ComponentV2
export struct SessionCard {
  @Require @Param row: SessionRow;
  @Event onOpen: (sessionId: string) => void;

  build() {
    Column() {
      Row() {
        Text(this.row.title.length > 0 ? this.row.title : this.row.sessionId)
          .fontSize(FS_BODY)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.label_primary'))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.row.running) {
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

      if (this.row.cwd.length > 0) {
        Text(this.row.cwd)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: SP_1 })
      }

      Row() {
        Text(relTime(this.row.updatedAt))
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
      this.onOpen(this.row.sessionId);
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

  /** 下拉刷新：拉 session.list，完成后收起刷新态。 */
  private doRefresh(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在右上角「连接」里选择远程', duration: 2500 });
      this.refreshing = false;
      return;
    }
    this.refreshing = true;
    this.store.refreshSessions().then((): void => {
      this.refreshing = false;
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

  /** 列表行（store.sessions 的 @Trace 读取会被 V2 追踪，列表随事件实时刷新）。
   *  显示规则（契约 §5.3 v1.0.5）：只显示根会话（非 subagent）且非 blank；
   *  subagent 的入口在父会话详情页的子代理目录区；updatedAt 降序。 */
  private visibleSessions(): SessionRow[] {
    const out: SessionRow[] = [];
    for (const row of this.store.sessions) {
      if (row.blank || row.isSubagent()) {
        continue;
      }
      out.push(row);
    }
    out.sort((a: SessionRow, b: SessionRow): number => b.updatedAt - a.updatedAt);
    return out;
  }

  /** 顶栏：左标题 + 右上角连接信息胶囊（状态点 + 状态 + 当前远程名）。 */
  @Builder
  topBar() {
    Row() {
      Text('会话')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .layoutWeight(1)
      Row() {
        Circle({ width: 7, height: 7 }).fill(linkStateColor(this.store.linkState))
        Text(linkStateText(this.store.linkState))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .margin({ left: 5 })
        Text(this.remoteName())
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_primary'))
          .margin({ left: 6 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .constraintSize({ maxWidth: 96 })
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

  /** 空态（在线 / 离线两套文案）。 */
  @Builder
  emptyState() {
    Column() {
      Text('○')
        .fontSize(40)
        .fontColor($r('app.color.label_tertiary'))
      Text(this.store.linkState === 'online' ? '暂无会话' : '未连接，暂无会话数据')
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_secondary'))
        .margin({ top: SP_2 })
      Text(this.store.linkState === 'online' ?
        '点下方「新建会话」开始遥控' : '在右上角「连接」里选好远程并连接')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 60, bottom: 60 })
  }

  build() {
    Navigation(this.navPathStack) {
      Column() {
        this.topBar()
        if (this.store.pendingCount() > 0) {
          this.pendingBanner()
        }
        Refresh({ refreshing: this.refreshing }) {
          List({ space: SP_2 }) {
            if (this.visibleSessions().length === 0) {
              ListItem() {
                this.emptyState()
              }
            } else {
              Repeat(this.visibleSessions())
                .each((cell: RepeatItem<SessionRow>): void => {
                  ListItem() {
                    SessionCard({
                      row: cell.item,
                      onOpen: (sid: string): void => {
                        this.openSession(sid);
                      }
                    })
                  }
                })
                .key((row: SessionRow): string => row.sessionId)
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
