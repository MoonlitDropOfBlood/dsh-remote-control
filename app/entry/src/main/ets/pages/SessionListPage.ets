/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之②：会话列表页（NavDestination）。
 *  - 会话卡：标题 / 运行状态徽标 / 工作目录 / 最近活动时间（session.added/removed/status/activity 实时刷新）
 *  - Refresh 下拉刷新（session.list）；顶部链路状态徽标 + 待处理审批角标
 *  - 「新建会话」品牌主按钮 → session.create 后直达详情
 * 设计：侧栏感列表（卡片 12vp 圆角 + 1px border_l1），空态居中提示，底部固定操作区。
 */
import { promptAction } from '@kit.ArkUI';
import { HRouter } from 'hrouter';
import { dshrcLink } from '../model/link';
import { goBack, openApprovalQueue, openSessionDetail } from '../model/routes';
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
import { SessionRow, SessionStore, sessionStore } from '../model/sessionstore';

/** 单张会话卡（列表项）。 */
@ComponentV2
export struct SessionCard {
  @Require @Param row: SessionRow;
  /** 父会话标题（subagent 卡副标题；由列表页用 titleOf(parentSessionId) 算好传入）。 */
  @Require @Param parentTitle: string = '';
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
        if (this.row.isSubagent()) {
          Text('子代理')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_secondary'))
            .padding({ left: 8, right: 8, top: 3, bottom: 3 })
            .margin({ left: SP_2 })
            .borderRadius(RADIUS_PILL)
            .backgroundColor($r('app.color.bg_layer_2'))
        }
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

      if (this.row.parentSessionId.length > 0 && this.parentTitle.length > 0) {
        // subagent 卡副标题：父会话标题（契约 §5.3 parentSessionId 血缘）
        Text('父会话：' + this.parentTitle)
          .fontSize(FS_SMALL)
          .fontColor($r('app.color.label_secondary'))
          .width('100%')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: SP_1 })
      }

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

/** 筛选胶囊（未归档 / 已归档 / 全部）。 */
@ComponentV2
export struct FilterChip {
  @Require @Param label: string = '';
  @Require @Param count: number = 0;
  @Require @Param active: boolean = false;
  @Event onTap: () => void;

  build() {
    Text(this.label + ' · ' + this.count.toString())
      .fontSize(FS_SMALL)
      .fontWeight(this.active ? FontWeight.Medium : FontWeight.Normal)
      .fontColor(this.active ? $r('app.color.label_on_brand') : $r('app.color.label_secondary'))
      .padding({ left: SP_3, right: SP_3, top: SP_1 + 2, bottom: SP_1 + 2 })
      .borderRadius(RADIUS_PILL)
      .backgroundColor(this.active ? $r('app.color.brand_fill') : $r('app.color.bg_layer_2'))
      .onClick((): void => {
        this.onTap();
      })
  }
}

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// 页面本体保持普通组件，NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
// @Route({ name: 'session_list' })
@ComponentV2
export struct SessionListPage {
  @Local store: SessionStore = sessionStore;
  @Local refreshing: boolean = false;
  /** 列表筛选：active=未归档（默认）/ archived=已归档 / sub=子代理 / all=全部。
   *  显示规则（契约 §5.3 v1.0.4）：blank 一律隐藏；subagent 只进「子代理」与「全部」，
   *  不与根会话混排刷屏。 */
  @Local listFilter: string = 'active';

  aboutToAppear(): void {
    this.store.refreshSessions();
    // 返回本页时补一次刷新（替代原 NavDestination.onShown；页面卸载时 HRouter 自动清理回调）。
    HRouter.registerLifecycle(this, {
      onShown: (): void => {
        this.store.refreshSessions();
      }
    });
  }

  /** 当前筛选下的会话行（store.sessions 的 @Trace 读取会被 V2 追踪，列表随事件实时刷新）。 */
  private filteredSessions(): SessionRow[] {
    const out: SessionRow[] = [];
    for (const row of this.store.sessions) {
      if (row.blank) {
        continue; // blank===true：任何筛选下都隐藏（DSH 官方语义）
      }
      const sub: boolean = row.isSubagent();
      if (this.listFilter === 'all') {
        out.push(row); // 「全部」：一切非 blank（含子代理）
      } else if (this.listFilter === 'sub') {
        if (sub) {
          out.push(row);
        }
      } else if (!sub) {
        // 「未归档 / 已归档」：根会话专属，子代理不混排
        const wantArchived: boolean = this.listFilter === 'archived';
        if (row.archived === wantArchived) {
          out.push(row);
        }
      }
    }
    return out;
  }

  /** 各筛选胶囊计数（与 filteredSessions 同一套规则）。 */
  private countSub(): number {
    let n: number = 0;
    for (const row of this.store.sessions) {
      if (!row.blank && row.isSubagent()) {
        n++;
      }
    }
    return n;
  }

  private countVisible(): number {
    let n: number = 0;
    for (const row of this.store.sessions) {
      if (!row.blank) {
        n++;
      }
    }
    return n;
  }

  private countRoot(archived: boolean): number {
    let n: number = 0;
    for (const row of this.store.sessions) {
      if (!row.blank && !row.isSubagent() && row.archived === archived) {
        n++;
      }
    }
    return n;
  }

  /** subagent 卡的父会话标题（titleOf 兜底短 id）。 */
  private parentTitleOf(row: SessionRow): string {
    if (row.parentSessionId.length === 0) {
      return '';
    }
    return this.store.titleOf(row.parentSessionId);
  }

  /** 下拉刷新：拉 session.list，完成后收起刷新态。 */
  private doRefresh(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在配对页连接中继', duration: 2500 });
      this.refreshing = false;
      return;
    }
    this.refreshing = true;
    this.store.refreshSessions().then((): void => {
      this.refreshing = false;
    });
  }

  /** 新建会话 → 直达详情。 */
  private onCreateSession(): void {
    if (this.store.linkState !== 'online') {
      promptAction.showToast({ message: '未连接，请先在配对页连接中继', duration: 2500 });
      return;
    }
    dshrcLink.sessionCreate('').then((sid: string): void => {
      if (sid.length > 0) {
        openSessionDetail(sid);
      }
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '新建会话失败：' + e.message, duration: 3000 });
    });
  }

  /** 打开会话详情。 */
  private openSession(sid: string): void {
    openSessionDetail(sid);
  }

  @Builder
  topBar() {
    Row() {
      Button() {
        Text('‹')
          .fontSize(26)
          .fontColor($r('app.color.label_primary'))
      }
      .type(ButtonType.Normal)
      .width(36)
      .height(36)
      .backgroundColor($r('app.color.bg_layer_2'))
      .borderRadius(RADIUS_CTRL)
      .onClick((): void => {
        goBack();
      })
      Text('会话')
        .fontSize(FS_SUBTITLE)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.label_primary'))
        .margin({ left: SP_3 })
        .layoutWeight(1)
      Row() {
        Circle({ width: 7, height: 7 }).fill(linkStateColor(this.store.linkState))
        Text(linkStateText(this.store.linkState))
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.label_secondary'))
          .margin({ left: 5 })
      }
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .borderRadius(RADIUS_PILL)
      .backgroundColor($r('app.color.bg_layer_2'))
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_3 })
  }

  @Builder
  filterRow() {
    // 四个胶囊横向可滚（窄屏放不下时滑动，不裁切）
    Scroll() {
      Row({ space: SP_2 }) {
        FilterChip({
          label: '未归档',
          count: this.countRoot(false),
          active: this.listFilter === 'active',
          onTap: (): void => {
            this.listFilter = 'active';
          }
        })
        FilterChip({
          label: '已归档',
          count: this.countRoot(true),
          active: this.listFilter === 'archived',
          onTap: (): void => {
            this.listFilter = 'archived';
          }
        })
        FilterChip({
          label: '子代理',
          count: this.countSub(),
          active: this.listFilter === 'sub',
          onTap: (): void => {
            this.listFilter = 'sub';
          }
        })
        FilterChip({
          label: '全部',
          count: this.countVisible(),
          active: this.listFilter === 'all',
          onTap: (): void => {
            this.listFilter = 'all';
          }
        })
      }
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .padding({ left: SP_4, right: SP_4, bottom: SP_2 })
  }

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

  @Builder
  emptyState() {
    Column() {
      Text('○')
        .fontSize(40)
        .fontColor($r('app.color.label_tertiary'))
      Text(this.store.linkState === 'online' ?
        (this.store.sessions.length === 0 ? '暂无会话' : '当前筛选下暂无会话') :
        '未连接，暂无会话数据')
        .fontSize(FS_BODY)
        .fontColor($r('app.color.label_secondary'))
        .margin({ top: SP_2 })
      Text(this.store.linkState === 'online' ?
        (this.store.sessions.length === 0 ? '点下方「新建会话」开始遥控' : '试试切换上方筛选，或下拉刷新') :
        '在配对页填好中继地址与配对信息后点「连接」')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 60, bottom: 60 })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供（hideTitleBar/onReady 在那边）。
    Column() {
      this.topBar()
      this.filterRow()
      if (this.store.pendingCount() > 0) {
        this.pendingBanner()
      }
      Refresh({ refreshing: this.refreshing }) {
        List({ space: SP_2 }) {
          if (this.filteredSessions().length === 0) {
            ListItem() {
              this.emptyState()
            }
          } else {
            Repeat(this.filteredSessions())
              .each((cell: RepeatItem<SessionRow>): void => {
                ListItem() {
                  SessionCard({
                    row: cell.item,
                    parentTitle: this.parentTitleOf(cell.item),
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
  }
}
