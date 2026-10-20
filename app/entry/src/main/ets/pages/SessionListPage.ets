/*
 * Copyright (c) 2026 dukedsh.
 * 五页面之②：会话列表页（NavDestination）。
 *  - 会话卡：标题 / 运行状态徽标 / 工作目录 / 最近活动时间（session.added/removed/status/activity 实时刷新）
 *  - Refresh 下拉刷新（session.list）；顶部链路状态徽标 + 待处理审批角标
 *  - 「新建会话」品牌主按钮 → session.create 后直达详情
 * 设计：侧栏感列表（卡片 12vp 圆角 + 1px border_l1），空态居中提示，底部固定操作区。
 */
import { promptAction } from '@kit.ArkUI';
import { dshrcLink } from '../model/link';
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
import { SessionDetailParam } from './SessionDetailPage';

/** 单张会话卡（列表项）。 */
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

@ComponentV2
export struct SessionListPage {
  @Local navPathStack: NavPathStack = new NavPathStack();
  @Local store: SessionStore = sessionStore;
  @Local refreshing: boolean = false;

  aboutToAppear(): void {
    this.store.refreshSessions();
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
        const p: SessionDetailParam = { sessionId: sid };
        this.navPathStack.pushPath({ name: 'SessionDetailPage', param: p });
      }
    }).catch((e: Error): void => {
      promptAction.showToast({ message: '新建会话失败：' + e.message, duration: 3000 });
    });
  }

  /** 打开会话详情。 */
  private openSession(sid: string): void {
    const p: SessionDetailParam = { sessionId: sid };
    this.navPathStack.pushPath({ name: 'SessionDetailPage', param: p });
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
        this.navPathStack.pop();
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
    .margin({ bottom: SP_3 })
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
      this.navPathStack.pushPathByName('ApprovalQueuePage', null);
    })
  }

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
      Text(this.store.linkState === 'online' ? '点下方「新建会话」开始遥控' :
        '在配对页填好中继地址与配对信息后点「连接」')
        .fontSize(FS_SMALL)
        .fontColor($r('app.color.label_tertiary'))
        .margin({ top: SP_1 })
    }
    .width('100%')
    .padding({ top: 60, bottom: 60 })
  }

  build() {
    NavDestination() {
      Column() {
        this.topBar()
        if (this.store.pendingCount() > 0) {
          this.pendingBanner()
        }
        Refresh({ refreshing: this.refreshing }) {
          List({ space: SP_2 }) {
            if (this.store.sessions.length === 0) {
              ListItem() {
                this.emptyState()
              }
            } else {
              Repeat(this.store.sessions)
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
    }
    .width('100%')
    .height('100%')
    .hideTitleBar(true)
    .backgroundColor($r('app.color.bg_base'))
    .onReady((ctx: NavDestinationContext): void => {
      this.navPathStack = ctx.pathStack;
    })
    .onShown((): void => {
      // 从详情/审批页返回时补一次列表刷新
      this.store.refreshSessions();
    })
  }
}
