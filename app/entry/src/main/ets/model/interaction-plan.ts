/*
 * Copyright (c) 2026 dukedsh.
 * v1.3.0 契约的纯规则（纯 TypeScript，便于 Node 行为回归，ArkTS 复用同一份实现）：
 *  - §5.12 待答交互：快照合并（幂等 upsert + 失效清理）
 *  - §5.13 Todo：整表替换 + 三态计数（null 与 unsupported 严格区分）
 *  - §5.14 Goal：CAS 引用 + 动作约束（除 create 外都要带 {id,revision}）
 *  - §5.2 v1.3.0 队列：按 itemId 的权威整表替换（空数组也覆盖旧缓存）
 *
 * 这里只做**纯计算**，不做 IO、不碰状态树；状态更新在 sessionstore.ets。
 */

/** 待答卡片（提问 / 审批共用）的最小元信息。 */
export interface PendingCardMeta {
  /** 稳定身份（契约 §5.12：同一 askId 重发表示状态更新，客户端替换而非叠加）。 */
  askId: string;
  sessionId: string;
  /** 'plugin'（插件瀑布持有）| 'host'（Host userQuestions 投影）。 */
  source: string;
  /**
   * 本地收到该卡片时的序号。用途：快照请求发出之后才到达的 live 卡片
   * （bornSeq > issuedSeq）**不得**被那份旧快照删掉。
   */
  bornSeq: number;
}

/** 待答快照的合并计划。 */
export interface PendingMergePlan {
  /** 快照里出现的 askId：按 askId 幂等 upsert（替换而非叠加）。 */
  upsert: string[];
  /** 已失效：本地有、快照没有、属于快照范围、且在快照请求发出之前就已存在。 */
  remove: string[];
}

/**
 * 规划待答快照的合并（契约 §5.12）。
 *
 * 规则：
 *  1. 快照里的每一项按 askId **幂等 upsert**——同 askId 替换既有卡片，不叠加；
 *  2. 范围内（scopeSessionId 非空且卡片属于该会话）、**在请求发出之前就已存在**
 *     （bornSeq <= issuedSeq）却**不在快照里**的卡片 → 移除（已失效）；
 *  3. 请求发出之后才到达的 live 卡片（bornSeq > issuedSeq）→ **保留**
 *     （旧快照不能误删刚到的卡片）；
 *  4. scopeSessionId 为空（全局范围）→ 只 upsert，不删除（快照不含其他会话的宿主投影）。
 */
export function planPendingMerge(live: PendingCardMeta[], snapshotAskIds: string[],
  scopeSessionId: string, issuedSeq: number): PendingMergePlan {
  const upsert: string[] = [];
  const snapshotSet: Set<string> = new Set<string>();
  for (let i: number = 0; i < snapshotAskIds.length; i++) {
    const id: string = snapshotAskIds[i];
    if (id.length === 0 || snapshotSet.has(id)) {
      continue;
    }
    snapshotSet.add(id);
    upsert.push(id);
  }
  const remove: string[] = [];
  if (scopeSessionId.length > 0) {
    for (let j: number = 0; j < live.length; j++) {
      const meta: PendingCardMeta = live[j];
      if (meta.sessionId !== scopeSessionId) {
        continue; // 范围外：快照没有它不代表它失效
      }
      if (snapshotSet.has(meta.askId)) {
        continue; // 快照里有 → 走 upsert
      }
      if (meta.bornSeq > issuedSeq) {
        continue; // 快照发出之后才到 → 保留，不能被旧快照误删
      }
      remove.push(meta.askId);
    }
  }
  return { upsert: upsert, remove: remove };
}

/** Todo 条目最小形状（与 wire TodoItem 一致）。 */
export interface TodoItemShape {
  content: string;
  status: string;
}

/** Todo 三态计数（契约 §5.13：pending / in_progress / completed）。 */
export interface TodoCounts {
  pending: number;
  in_progress: number;
  completed: number;
  total: number;
}

/**
 * Todo 三态计数。
 * `null` = 本回合尚无清单 / 已清空（与「宿主不支持」严格区分，见 supported 标记）。
 */
export function todoCounts(todos: TodoItemShape[] | null): TodoCounts {
  const counts: TodoCounts = { pending: 0, in_progress: 0, completed: 0, total: 0 };
  if (todos === null) {
    return counts;
  }
  for (let i: number = 0; i < todos.length; i++) {
    const status: string = todos[i].status;
    counts.total = counts.total + 1;
    if (status === 'completed') {
      counts.completed = counts.completed + 1;
    } else if (status === 'in_progress') {
      counts.in_progress = counts.in_progress + 1;
    } else {
      counts.pending = counts.pending + 1;
    }
  }
  return counts;
}

/**
 * Todo 整表替换（契约 §5.13：`todo/write` 覆盖、`turn/start` 清为 null）。
 * incoming 为 null → 清空；incoming 为数组 → **整表覆盖**（空数组也覆盖旧缓存）。
 */
export function replaceTodoTable(current: TodoItemShape[] | null,
  incoming: TodoItemShape[] | null): TodoItemShape[] | null {
  if (incoming === null) {
    return null;
  }
  const out: TodoItemShape[] = [];
  for (let i: number = 0; i < incoming.length; i++) {
    const src: TodoItemShape = incoming[i];
    const item: TodoItemShape = { content: src.content, status: src.status };
    out.push(item);
  }
  return out;
}

/** 目标 CAS 引用（契约 §5.14 的 {id,revision}）。 */
export interface GoalRefShape {
  id: string;
  revision: number;
}

/** 目标最小形状。 */
export interface GoalShape {
  id: string;
  revision: number;
  objective: string;
  phase: string;
}

/**
 * 除 `create` 外的每个目标变更都必须带 expected {id,revision}（契约 §5.14）。
 * 手机**不得**触发 `block`（契约明令：blocked 由模型/策略负责）。
 */
export function goalActionNeedsExpected(action: string): boolean {
  return action !== 'create';
}

/** 取当前目标的 CAS 引用；没有目标或 id 不完整 → null（调用方必须拒绝执行）。 */
export function goalRefOf(goal: GoalShape | null): GoalRefShape | null {
  if (goal === null) {
    return null;
  }
  if (goal.id.length === 0) {
    return null;
  }
  const ref: GoalRefShape = { id: goal.id, revision: goal.revision };
  return ref;
}

/** 队列条目最小形状（契约 §5.2 session.queue）。 */
export interface QueueItemShape {
  itemId: string;
  text: string;
  target: string;
}

/** 队列整表替换的结果。 */
export interface QueueTableResult {
  /** 替换后的整表（权威）。 */
  items: QueueItemShape[];
  /** 是否有条目从旧表里消失（被宿主消费 / 取消）——需要补拉权威历史。 */
  removed: boolean;
}

/**
 * 队列的**权威整表替换**（契约 §5.2 v1.3.0）。
 *
 * - 出队以 Host 消息 id（wire `itemId`）为主键；
 * - **空数组必须覆盖旧缓存**（队列被清空时不能留着旧项）；
 * - `removed` = 旧表里有、新表里没有 → 宿主消费或取消了 → 触发一次权威历史补拉。
 */
export function replaceQueueTable(current: QueueItemShape[], incoming: QueueItemShape[]): QueueTableResult {
  const out: QueueItemShape[] = [];
  const seen: Set<string> = new Set<string>();
  for (let i: number = 0; i < incoming.length; i++) {
    const src: QueueItemShape = incoming[i];
    const id: string = src.itemId.length > 0 ? src.itemId : ('q' + i.toString());
    if (seen.has(id)) {
      continue; // 同一 itemId 只保留一条
    }
    seen.add(id);
    const item: QueueItemShape = { itemId: id, text: src.text, target: src.target };
    out.push(item);
  }
  const nextIds: Set<string> = new Set<string>();
  for (let j: number = 0; j < out.length; j++) {
    nextIds.add(out[j].itemId);
  }
  let removed: boolean = false;
  for (let k: number = 0; k < current.length; k++) {
    if (!nextIds.has(current[k].itemId)) {
      removed = true;
      break;
    }
  }
  return { items: out, removed: removed };
}

/** 目标阶段的中文标签（UI 用；node 回归共用）。 */
export function goalPhaseLabel(phase: string): string {
  if (phase === 'active') {
    return '进行中';
  }
  if (phase === 'paused') {
    return '已暂停';
  }
  if (phase === 'blocked') {
    return '受阻';
  }
  if (phase === 'complete') {
    return '已完成';
  }
  return phase;
}

/** Todo 三态的中文标签（UI 用；node 回归共用）。 */
export function todoStatusLabel(status: string): string {
  if (status === 'completed') {
    return '已完成';
  }
  if (status === 'in_progress') {
    return '进行中';
  }
  return '待办';
}
