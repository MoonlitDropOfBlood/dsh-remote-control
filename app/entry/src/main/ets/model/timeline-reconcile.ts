/*
 * Copyright (c) 2026 dukedsh.
 * 直播文本与宿主持久历史的对账规则（纯 TypeScript，便于行为回归）。
 */
export interface DshrcDurableText {
  role: string;
  text: string;
}

export interface DshrcLiveText extends DshrcDurableText {
  itemId: string;
  streaming: boolean;
}

/**
 * 找出可被持久历史覆盖的直播文本。
 *
 * - 新增 durable 按顺序一对一消费 live；同 role 的多个相邻片段可聚合匹配，
 *   因为 Host 历史会把一个 assistant/message 的同类 content block 拼成一条。
 * - dropFinalized=true 仅用于「非 prepend 的最新页 + Host 已空闲」：此时权威历史
 *   接管所有已完成的 assistant/reasoning 文本，包括此前因快照竞态没配上的副本。
 *   仍 streaming 的块、user 乐观消息和空文本图片消息一律保留。
 */
export function collectCoveredLiveTextIds(durable: DshrcDurableText[], live: DshrcLiveText[],
  dropFinalized: boolean): Set<string> {
  const covered: Set<string> = new Set<string>();
  if (dropFinalized) {
    for (let i: number = 0; i < live.length; i++) {
      const item: DshrcLiveText = live[i];
      if (!item.streaming && (item.role === 'assistant' || item.role === 'reasoning') && item.text.length > 0) {
        covered.add(item.itemId);
      }
    }
  }
  for (let d: number = 0; d < durable.length; d++) {
    const message: DshrcDurableText = durable[d];
    if (message.text.trim().length === 0) {
      continue;
    }
    let exact: number = -1;
    for (let i: number = 0; i < live.length; i++) {
      const item: DshrcLiveText = live[i];
      if (!covered.has(item.itemId) && item.role === message.role && item.text === message.text) {
        exact = i;
        break;
      }
    }
    if (exact >= 0) {
      covered.add(live[exact].itemId);
      continue;
    }
    const fragments: string[] = [];
    let combined: string = '';
    for (let i: number = 0; i < live.length && combined.length < message.text.length; i++) {
      const item: DshrcLiveText = live[i];
      if (covered.has(item.itemId)) {
        continue;
      }
      if (message.role !== 'user' && item.role === 'user') {
        break; // 未消费的用户消息是 turn 边界，不能把两轮同 role 文本拼成一轮。
      }
      if (item.role !== message.role || item.text.length === 0) {
        continue;
      }
      fragments.push(item.itemId);
      combined += item.text;
    }
    if (combined === message.text) {
      for (let i: number = 0; i < fragments.length; i++) {
        covered.add(fragments[i]);
      }
    }
  }
  return covered;
}
