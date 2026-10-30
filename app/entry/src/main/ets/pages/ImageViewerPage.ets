/*
 * Copyright (c) 2026 dukedsh.
 * 图片大图浏览页（契约 §5.10 v1.0.9）。
 *  - 全屏深色底 + 图片居中；双指缩放（1x~4x）+ 单指拖动；顶部关闭按钮
 *  - 打开时先用内联缩略图垫底，异步 image.fetch(maxEdge=1600) 拉大图，拉到后替换
 *  - 大图拉取失败：提示「原图过大或拉取失败，仅可看缩略图」，缩略图仍可看
 */
import { HRouter } from 'hrouter';
import { sessionStore } from '../model/sessionstore';
import { ImageViewerParam, goBack } from '../model/routes';
import { FS_CAPTION, FS_SMALL, RADIUS_PILL, SP_2, SP_3, SP_4 } from '../model/theme';

/** 缩放上下限（契约：1x~4x）。 */
const SCALE_MIN: number = 1;
const SCALE_MAX: number = 4;
/** 大图请求长边（契约 §5.10：maxEdge 缺省 1600、上限 4096）。 */
const FULL_MAX_EDGE: number = 1600;
/** 拉取失败提示文案。 */
const FETCH_FAIL_TEXT: string = '原图过大或拉取失败，仅可看缩略图';

// hrouter 编译期扫描标记（注释形式：ArkTS 不允许 struct 上挂非框架装饰器）。
// @Route({ name: 'image_viewer' })
@ComponentV2
export struct ImageViewerPage {
  /** 图片 id（宿主 attachmentId）。 */
  @Local imageId: string = '';
  /** 路由带过来的缩略图 data URI（垫底用）。 */
  @Local thumb: string = '';
  /** 拉下来的大图 data URI（空 = 还没到 / 拉取失败）。 */
  @Local full: string = '';
  /** 大图是否在拉取中。 */
  @Local loading: boolean = false;
  /** 大图是否拉取失败（只提示，不清空缩略图）。 */
  @Local failed: boolean = false;
  /** 当前缩放倍数。 */
  @Local zoomScale: number = 1;
  /** 当前平移偏移（vp）。 */
  @Local dragX: number = 0;
  @Local dragY: number = 0;
  /** 手势起始基准：缩放起始倍数 / 拖动起始偏移。 */
  @Local pinchStart: number = 1;
  @Local panStartX: number = 0;
  @Local panStartY: number = 0;

  aboutToAppear(): void {
    this.readRouteParams();
    this.loadFull();
    // onAppear 兜底：aboutToAppear 时 wrapper onReady 尚未回填 contextMap 时补读一次参数。
    HRouter.registerLifecycle(this, {
      onAppear: (): void => {
        if (this.imageId.length === 0) {
          this.readRouteParams();
          this.loadFull();
        }
      }
    });
  }

  /** 从 hrouter 路由上下文读取参数（幂等）。 */
  private readRouteParams(): void {
    const params: ImageViewerParam | undefined = HRouter.getParams<ImageViewerParam>(this);
    if (params === undefined) {
      return;
    }
    if (params.imageId.length > 0) {
      this.imageId = params.imageId;
    }
    if (params.thumb.length > 0) {
      this.thumb = params.thumb;
    }
  }

  /**
   * 拉取大图（契约 §5.1 image.fetch / §5.10）。
   * store.fetchImage 内部已 catch 全部错误并回 null —— 这里只处理「有 / 无」两种结果。
   */
  private loadFull(): void {
    if (this.imageId.length === 0 || this.loading) {
      return;
    }
    this.loading = true;
    sessionStore.fetchImage(this.imageId, FULL_MAX_EDGE).then((data: string | null): void => {
      this.loading = false;
      if (data === null || data.length === 0) {
        this.failed = true;
        this.getUIContext().getPromptAction().showToast({ message: FETCH_FAIL_TEXT, duration: 2500 });
        return;
      }
      this.full = data;
      this.zoomScale = 1;
      this.dragX = 0;
      this.dragY = 0;
    });
  }

  /** 当前显示的图源：大图优先，其次缩略图，都没有则空串。 */
  private displaySrc(): string {
    if (this.full.length > 0) {
      return this.full;
    }
    return this.thumb;
  }

  /** 双指缩放：起始倍数 × 本次缩放比，夹在 1x~4x。 */
  private onPinchUpdate(event: GestureEvent): void {
    const next: number = this.pinchStart * event.scale;
    this.zoomScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
  }

  /** 单指拖动：起始偏移 + 本次位移。 */
  private onPanUpdate(event: GestureEvent): void {
    this.dragX = this.panStartX + event.offsetX;
    this.dragY = this.panStartY + event.offsetY;
  }

  /** 顶部条：关闭按钮 + 拉取中指示。 */
  @Builder
  topBar() {
    Row() {
      Button() {
        Text('✕')
          .fontSize(18)
          .fontColor($r('app.color.label_primary'))
      }
      .type(ButtonType.Normal)
      .width(36)
      .height(36)
      .backgroundColor($r('app.color.bg_layer_2'))
      .borderRadius(RADIUS_PILL)
      .onClick((): void => {
        goBack();
      })
      Blank()
      if (this.loading) {
        Row() {
          LoadingProgress()
            .width(16)
            .height(16)
            .color($r('app.color.label_tertiary'))
          Text('正在加载原图…')
            .fontSize(FS_CAPTION)
            .fontColor($r('app.color.label_tertiary'))
            .margin({ left: SP_2 })
        }
        .alignItems(VerticalAlign.Center)
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_3, bottom: SP_2 })
  }

  /** 图片区：居中显示 + 缩放/拖动手势。 */
  @Builder
  imageStage() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.displaySrc().length > 0) {
        Image(this.displaySrc())
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Contain)
          .scale({ x: this.zoomScale, y: this.zoomScale })
          .translate({ x: this.dragX, y: this.dragY })
      } else {
        Column() {
          SymbolGlyph($r('sys.symbol.picture'))
            .fontSize(28)
            .fontColor([$r('app.color.label_tertiary')])
            .width(32)
            .height(32)
          Text('图片不可用')
            .fontSize(FS_SMALL)
            .fontColor($r('app.color.label_tertiary'))
            .margin({ top: SP_2 })
        }
        .alignItems(HorizontalAlign.Center)
      }
    }
    .width('100%')
    .layoutWeight(1)
    // 单指拖动 + 双指缩放并行（Parallel）：缩放时也能继续平移
    .gesture(
      GestureGroup(GestureMode.Parallel,
        PanGesture({ fingers: 1, distance: 2 })
          .onActionStart((event: GestureEvent): void => {
            this.panStartX = this.dragX;
            this.panStartY = this.dragY;
          })
          .onActionUpdate((event: GestureEvent): void => {
            this.onPanUpdate(event);
          }),
        PinchGesture({ fingers: 2, distance: 1 })
          .onActionStart((event: GestureEvent): void => {
            this.pinchStart = this.zoomScale;
          })
          .onActionUpdate((event: GestureEvent): void => {
            this.onPinchUpdate(event);
          })
      )
    )
  }

  /** 底部提示行（操作说明 / 失败提示）。 */
  @Builder
  bottomBar() {
    Column() {
      if (this.failed) {
        Text(FETCH_FAIL_TEXT)
          .fontSize(FS_CAPTION)
          .fontColor($r('app.color.state_warn'))
          .margin({ bottom: SP_2 })
      }
      Text('双指缩放 · 单指拖动')
        .fontSize(FS_CAPTION)
        .fontColor($r('app.color.label_tertiary'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Center)
    .padding({ left: SP_4, right: SP_4, top: SP_2, bottom: SP_4 })
  }

  build() {
    // NavDestination 外壳由 hrouter-compiler 生成的 wrapper 提供。
    Column() {
      this.topBar()
      this.imageStage()
      this.bottomBar()
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.image_viewer_bg'))
  }
}
