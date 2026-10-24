/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 统一路由出口（hrouter）。
 *  - 页面在 pages/ 各文件以 // @Route({ name: ... }) 注释标记，hvigor 编译期插件
 *    hrouter-compiler 扫描生成 router_map.json + NavDestination wrapper（勿手改 _generated）。
 *  - 运行时 HRouter.init（EntryAbility.onWindowStageCreate）+ registerNavPathStack（Index）。
 *  - 对外跳转一律走本模块；页面内部不再直接持有 NavPathStack。
 *  - 返回行为不变：HRouter.pop() 弹的仍是同一棵 NavDestination 栈。
 */
import { HRouter } from 'hrouter';
import { DshrcImageRef } from './protocol';

/** 会话详情页路由名。 */
export const ROUTE_SESSION_DETAIL: string = 'session_detail';
/** 连接管理页路由名（v1.0.6：多远程管理）。 */
export const ROUTE_CONNECTIONS: string = 'connections';
/** 新建会话页路由名（v1.0.6：选模式 + 权限）。 */
export const ROUTE_NEW_SESSION: string = 'new_session';
/** 审批/提问队列页路由名。 */
export const ROUTE_APPROVAL_QUEUE: string = 'approval_queue';
/** 关于页路由名。 */
export const ROUTE_ABOUT: string = 'about';
/** 图片大图浏览页路由名（v1.0.9：契约 §5.10）。 */
export const ROUTE_IMAGE_VIEWER: string = 'image_viewer';

/** 会话详情路由参数（原 SessionDetailPage 内接口迁到此处，避免 routes ↔ pages 循环引用）。 */
export interface SessionDetailParam {
  sessionId: string;
}

/** 大图浏览页路由参数（契约 §5.10 v1.0.9：imageId + 缩略图垫底 + 原图尺寸）。 */
export interface ImageViewerParam {
  imageId: string;
  thumb: string;
  mediaType: string;
  width: number;
  height: number;
}

/** 会话详情页（带 sessionId 参数；页面内用 HRouter.getParams 读取）。 */
export function openSessionDetail(sessionId: string): void {
  if (sessionId.length === 0) {
    return;
  }
  const param: SessionDetailParam = { sessionId: sessionId };
  HRouter.build().withParam(param).push(ROUTE_SESSION_DETAIL);
}

/** 连接管理页（管理多个远程连接；v1.0.6）。 */
export function openConnections(): void {
  HRouter.build().push(ROUTE_CONNECTIONS);
}

/** 新建会话页（选模式 + 权限；v1.0.6）。创建成功后自行跳详情。 */
export function openNewSession(): void {
  HRouter.build().push(ROUTE_NEW_SESSION);
}

/** 审批/提问队列页。 */
export function openApprovalQueue(): void {
  HRouter.build().push(ROUTE_APPROVAL_QUEUE);
}

/** 关于页。 */
export function openAbout(): void {
  HRouter.build().push(ROUTE_ABOUT);
}

/**
 * 图片大图浏览页（契约 §5.10 v1.0.9）。
 * 缩略图随参数带过去先垫底，大图由页面异步调 image.fetch 拉取。
 */
export function openImageViewer(image: DshrcImageRef): void {
  if (image.imageId.length === 0) {
    return;
  }
  const param: ImageViewerParam = {
    imageId: image.imageId,
    thumb: image.thumb,
    mediaType: image.mediaType,
    width: image.width,
    height: image.height
  };
  HRouter.build().withParam(param).push(ROUTE_IMAGE_VIEWER);
}

/** 返回上一页（等价原 navPathStack.pop()）。 */
export function goBack(): void {
  HRouter.build().pop();
}
