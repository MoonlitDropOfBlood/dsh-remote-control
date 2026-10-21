/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 事件总线契约（eventpost）。
 * 职责：link → store → UI 解耦的事件名与载荷形状集中定义，调用方不再散写字符串。
 * 约定：
 *  - 链路级事件（state/peers/bus-frame）由 link.ets 广播；语义级事件（审批/提问到达与解决、
 *    推送点击导航）由 sessionstore.ets 广播。
 *  - 现有直接回调接口（link.onState / onEvent / onPeers / onLog、store.onPendingNav）
 *    继续保留（兼容既有行为，实时更新不走事件总线也不受影响）；事件总线是并行广播通道。
 *  - 页面订阅一律用 onFromComponent（组件销毁自动反注册，防泄漏——V2 组件用法见库 README）；
 *    非组件长生命周期持有者（单例 store）用 on/off。
 *  - 粘性语义：EVT_LINK_STATE / EVT_PENDING_NAV 用 postStick（晚挂载的订阅者补收最近一次），
 *    其余一律 postNormal（帧级事件不做补发，靠 store 的 @Trace 快照兜底）。
 */
import { EventPost } from 'eventpost';
import { DshrcMsg } from './protocol';

/** 链路状态变化（载荷：LinkState 字符串，见 link.ets）。 */
export const EVT_LINK_STATE: string = 'dshrc/link/state';
/** 对端（host）在线状态变化（载荷：boolean —— host 是否在线）。 */
export const EVT_LINK_PEERS: string = 'dshrc/link/peers';
/** 一条解密后的业务事件帧到达（载荷：DshrcMsg；result 已被 Correlator 吃掉，不会出现在这里）。 */
export const EVT_BUS_MSG: string = 'dshrc/bus/msg';
/** 新的审批请求到达（载荷：sessionId, askId, toolName）。 */
export const EVT_APPROVAL_ARRIVED: string = 'dshrc/approval/arrived';
/** 审批被解决（载荷：askId）。 */
export const EVT_APPROVAL_RESOLVED: string = 'dshrc/approval/resolved';
/** 新的提问到达（载荷：sessionId, askId）。 */
export const EVT_QUESTION_ARRIVED: string = 'dshrc/question/arrived';
/** 提问被解决（载荷：askId）。 */
export const EVT_QUESTION_RESOLVED: string = 'dshrc/question/resolved';
/** 推送点击待导航目标（载荷：sessionId, askId；粘性——Index 晚挂载时补收）。 */
export const EVT_PENDING_NAV: string = 'dshrc/nav/pending';

/** 广播链路状态变化（link.ets setState 内调用；粘性补收最近一次）。 */
export function postLinkState(state: string): void {
  EventPost.getDefault().postStick(EVT_LINK_STATE, state);
}

/** 广播 host 在线状态（link.ets peers 变化处调用）。 */
export function postLinkPeers(hostOnline: boolean): void {
  EventPost.getDefault().postNormal(EVT_LINK_PEERS, hostOnline);
}

/** 广播一条解密后的业务事件帧（link.ets 分发给 onEvent 之后调用）。 */
export function postBusMsg(m: DshrcMsg): void {
  EventPost.getDefault().postNormal(EVT_BUS_MSG, m);
}

/** 广播审批到达（sessionstore 合并出卡片后调用）。 */
export function postApprovalArrived(sessionId: string, askId: string, toolName: string): void {
  EventPost.getDefault().postNormal(EVT_APPROVAL_ARRIVED, sessionId, askId, toolName);
}

/** 广播审批解决（sessionstore 收到 approval.resolved 后调用）。 */
export function postApprovalResolved(askId: string): void {
  EventPost.getDefault().postNormal(EVT_APPROVAL_RESOLVED, askId);
}

/** 广播提问到达（sessionstore 合并出卡片后调用）。 */
export function postQuestionArrived(sessionId: string, askId: string): void {
  EventPost.getDefault().postNormal(EVT_QUESTION_ARRIVED, sessionId, askId);
}

/** 广播提问解决（sessionstore 收到 question.resolved 后调用）。 */
export function postQuestionResolved(askId: string): void {
  EventPost.getDefault().postNormal(EVT_QUESTION_RESOLVED, askId);
}

/**
 * 广播推送点击待导航目标（sessionstore.setPendingNav 内调用；粘性——
 * EntryAbility.onCreate 写入早于 Index 挂载，Index 用 sticky 订阅补收）。
 */
export function postPendingNav(sessionId: string, askId: string): void {
  EventPost.getDefault().postStick(EVT_PENDING_NAV, sessionId, askId);
}
