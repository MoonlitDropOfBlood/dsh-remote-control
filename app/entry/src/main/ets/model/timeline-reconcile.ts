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

/** 带附件计数的消息（契约 §5.11.4 v1.2.0：附件-only 消息的正文为空串）。 */
export interface DshrcDurableAttachments {
  role: string;
  text: string;
  imageCount: number;
  fileCount: number;
}

/** 带附件计数的直播/乐观消息。 */
export interface DshrcLiveAttachments extends DshrcDurableAttachments {
  itemId: string;
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

/** 工作步骤对账所需的最小 durable / live 形状。 */
export interface DshrcDurableStep {
  callId: string;
}

export interface DshrcLiveStep {
  itemId: string;
  callId: string;
}

/**
 * 找出已由权威历史接管、应从时间线移除的直播步骤。
 *
 * - 普通合并仍按 callId 去重，运行中的直播步骤不会因暂时没进历史而消失。
 * - authoritativeIdle=true 仅用于「非 prepend 最新页 + Host 已空闲」：本页已经
 *   是最终权威投影，所有 seq=-1 的步骤都必须退出；否则没进入本页的直播步骤
 *   会被统一追加到最终消息之后，形成一个重启 App 才消失的幽灵 process group。
 */
export function collectCoveredLiveStepIds(durable: DshrcDurableStep[], live: DshrcLiveStep[],
  authoritativeIdle: boolean): Set<string> {
  const covered: Set<string> = new Set<string>();
  if (authoritativeIdle) {
    for (let i: number = 0; i < live.length; i++) {
      covered.add(live[i].itemId);
    }
    return covered;
  }
  const durableIds: Set<string> = new Set<string>();
  for (let d: number = 0; d < durable.length; d++) {
    durableIds.add(durable[d].callId);
  }
  for (let i: number = 0; i < live.length; i++) {
    if (durableIds.has(live[i].callId)) {
      covered.add(live[i].itemId);
    }
  }
  return covered;
}

/** 尾部过程项判定的最小形状（只取对账用到的字段）。 */
export interface DshrcTrailingProcessItem {
  seq: number;
  kind: string; // 'step' | 'reasoning' | 'message'
  streaming: boolean;
  /** step 的 status：'running' | 'ok' | 'error'。 */
  status: string;
}

/**
 * 时间线尾部是否只剩**已定稿**的直播过程项（seq=-1 的思考/步骤，且不在生成中）。
 *
 * 用途：回前台/重连的权威对账之后，中继离线缓存可能补发迟到事件，在最终消息
 * 之后重新拼出过程项；若宿主已空闲，就该再对账一次交给持久历史（否则尾部会
 * 多出一段「工作步骤」分组，重启 App 才消失）。
 *
 * 安全边界：只要尾部还有 streaming 思考、status='running' 的步骤，或任意直播
 * **消息**（可能是用户刚发出的新回合），一律返回 false —— 这时对账会把新回合
 * 正在生成的内容清掉（session.status running:true 可能还没到达）。
 */
export function hasTrailingSettledLiveProcess(items: DshrcTrailingProcessItem[]): boolean {
  for (let i: number = items.length - 1; i >= 0; i--) {
    const it: DshrcTrailingProcessItem = items[i];
    if (it.seq >= 0) {
      return false; // 最后一条是 durable 消息/步骤：尾部没有直播过程项
    }
    if (it.kind === 'message') {
      return false; // 直播消息 = 可能刚开始的新回合，不能动
    }
    if (it.kind === 'reasoning') {
      return !it.streaming;
    }
    if (it.kind === 'step') {
      return it.status !== 'running';
    }
  }
  return false;
}

/**
 * 找出可被持久历史覆盖的**附件-only 乐观消息**（契约 §5.11.4 v1.2.0）。
 *
 * 为什么需要单独一条规则：附件-only 消息的 `text` 是空串，而
 * `collectCoveredLiveTextIds` 只处理非空文本，空文本的直播副本永远配不上
 * 权威历史 → 时间线上同一条消息显示两遍（本地缩略图一份 + 宿主持久副本一份）。
 *
 * 规则（与契约 §5.11.4 乐观上屏口径一致）：
 *  - 只处理 role='user'、正文为空白、附件数 > 0 的 durable 消息；
 *  - 与 live 一一对应消费：role 相同、正文同样为空白、imageCount 与
 *    fileCount **完全相等**（附件顺序/内容可能被宿主归一化，不用 imageId 硬配）；
 *  - durable 按顺序消费往后的 live（先到先配），被消费的 live 不得再被别的 durable 认领。
 * 不用 imageId 配对的原因：乐观图片是 `local:` 前缀，宿主持久副本是 attachmentId，
 * 两套命名空间天然对不上；数量+角色+空正文足够判定「同一条」，且不会误删带正文的消息。
 */
export function collectCoveredLiveAttachmentIds(durable: DshrcDurableAttachments[],
  live: DshrcLiveAttachments[]): Set<string> {
  const covered: Set<string> = new Set<string>();
  const used: Set<string> = new Set<string>();
  for (let d: number = 0; d < durable.length; d++) {
    const message: DshrcDurableAttachments = durable[d];
    if (message.role !== 'user' || message.text.trim().length > 0) {
      continue;
    }
    if (message.imageCount + message.fileCount <= 0) {
      continue;
    }
    for (let i: number = 0; i < live.length; i++) {
      const item: DshrcLiveAttachments = live[i];
      if (used.has(item.itemId)) {
        continue;
      }
      if (item.role !== 'user' || item.text.trim().length > 0) {
        continue;
      }
      if (item.imageCount !== message.imageCount || item.fileCount !== message.fileCount) {
        continue;
      }
      used.add(item.itemId);
      covered.add(item.itemId);
      break;
    }
  }
  return covered;
}
