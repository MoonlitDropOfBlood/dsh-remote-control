// v1.3.0（契约 §5.12 / §5.13 / §5.14 + 队列整表替换）行为与接线回归：
//   node v13-contract-test.mjs
// 纯规则部分直接 import interaction-plan.ts（与 ArkTS 同一份实现），
// 接线部分用源码断言（仓库既有 *.mjs 契约测试的既有风格）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  goalActionNeedsExpected,
  goalRefOf,
  planPendingMerge,
  replaceQueueTable,
  replaceTodoTable,
  todoCounts
} from './entry/src/main/ets/model/interaction-plan.ts';

const protocol = readFileSync(new URL('./entry/src/main/ets/model/protocol.ets', import.meta.url), 'utf8');
const link = readFileSync(new URL('./entry/src/main/ets/model/link.ets', import.meta.url), 'utf8');
const store = readFileSync(new URL('./entry/src/main/ets/model/sessionstore.ets', import.meta.url), 'utf8');
const page = readFileSync(new URL('./entry/src/main/ets/pages/SessionDetailPage.ets', import.meta.url), 'utf8');
const panels = readFileSync(new URL('./entry/src/main/ets/pages/GoalTodoPanels.ets', import.meta.url), 'utf8');
const askCards = readFileSync(new URL('./entry/src/main/ets/pages/AskCards.ets', import.meta.url), 'utf8');
const events = readFileSync(new URL('./entry/src/main/ets/model/events.ets', import.meta.url), 'utf8');
const queuePage = readFileSync(new URL('./entry/src/main/ets/pages/ApprovalQueuePage.ets', import.meta.url), 'utf8');
const indexPage = readFileSync(new URL('./entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');

// ---------------------------------------------------------------- 纯规则

// ① 队列：权威整表替换 —— 空数组必须覆盖旧缓存（队列被清空不留旧项）。
{
  const current = [
    { itemId: 'm1', text: '第一条', target: 'next-turn' },
    { itemId: 'm2', text: '第二条', target: 'next-turn' }
  ];
  const cleared = replaceQueueTable(current, []);
  assert.deepEqual(cleared.items, [], '空快照必须清空旧队列缓存');
  assert.equal(cleared.removed, true, '清空旧队列属于「有条目消失」→ 需要补拉权威历史');

  const replaced = replaceQueueTable(current, [
    { itemId: 'm1', text: '第一条（改）', target: 'next-turn' },
    { itemId: 'm3', text: '第三条', target: 'next-turn' }
  ]);
  assert.deepEqual(replaced.items.map((i) => i.itemId), ['m1', 'm3'], '整表替换按 itemId 对齐');
  assert.equal(replaced.removed, true, 'm2 消失 = 被宿主消费或取消');

  const same = replaceQueueTable(current, [
    { itemId: 'm1', text: '第一条', target: 'next-turn' },
    { itemId: 'm2', text: '第二条', target: 'next-turn' }
  ]);
  assert.equal(same.removed, false, '内容未变不得触发历史补拉');

  const dup = replaceQueueTable([], [
    { itemId: 'x', text: 'a', target: 'next-turn' },
    { itemId: 'x', text: 'b', target: 'next-turn' }
  ]);
  assert.equal(dup.items.length, 1, '同一 itemId 只保留一条');
}

// ② 待答交互：askId 幂等 + 快照合并（不丢 live 项 / 清掉已失效项）。
{
  const live = [
    { askId: 'a1', sessionId: 's1', source: 'plugin', bornSeq: 1 },
    { askId: 'a2', sessionId: 's1', source: 'host', bornSeq: 2 }
  ];
  // 快照里只有 a1 → a2 已失效（在请求发出前就存在）→ 移除
  const plan1 = planPendingMerge(live, ['a1'], 's1', 2);
  assert.deepEqual(plan1.upsert, ['a1'], '快照项按 askId upsert');
  assert.deepEqual(plan1.remove, ['a2'], '范围内、快照没有、且请求前就存在的卡片 → 清理');

  // 快照发出之后才到的 live 卡片不得被旧快照删掉
  const plan2 = planPendingMerge(live, ['a1'], 's1', 1);
  assert.deepEqual(plan2.remove, [], '请求发出之后才到的 live 卡片必须保留');

  // 范围外（别的会话）不因快照缺失而被删
  const plan3 = planPendingMerge(live, ['a1'], 's2', 2);
  assert.deepEqual(plan3.remove, [], '范围外的卡片不得被本次快照清理');

  // 全局范围（scopeSessionId 空）只 upsert，不删除
  const plan4 = planPendingMerge(live, ['a1'], '', 2);
  assert.deepEqual(plan4.remove, [], '全局快照不得删除任何卡片');
  assert.deepEqual(plan4.upsert, ['a1'], '全局快照仍然 upsert');

  // 幂等：同一 askId 在快照里出现多次只 upsert 一次
  const plan5 = planPendingMerge([], ['a1', 'a1', 'a2'], 's1', 0);
  assert.deepEqual(plan5.upsert, ['a1', 'a2'], '同 askId 不得重复 upsert');
}

// ③ Todo：null（无清单）vs 空表 vs 有条目；三态计数。
{
  const counts = todoCounts([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
    { content: 'd', status: 'completed' }
  ]);
  assert.deepEqual(
    { p: counts.pending, i: counts.in_progress, c: counts.completed, t: counts.total },
    { p: 1, i: 1, c: 2, t: 4 },
    '三态计数必须区分 pending / in_progress / completed');
  assert.equal(todoCounts(null).total, 0, 'null（无清单）计数全 0 —— 与「不支持」严格区分');
  assert.equal(todoCounts([]).total, 0, '空表计数全 0');

  const replaced = replaceTodoTable(
    [{ content: 'old', status: 'pending' }],
    [{ content: 'new', status: 'completed' }]);
  assert.deepEqual(replaced, [{ content: 'new', status: 'completed' }], 'todo/write 整表覆盖');
  assert.equal(replaceTodoTable([{ content: 'old', status: 'pending' }], null), null,
    'turn/start 清为 null');
  assert.deepEqual(replaceTodoTable([{ content: 'old', status: 'pending' }], []), [],
    '空表也必须覆盖旧缓存');
}

// ④ Goal：CAS 引用与动作约束。
{
  assert.equal(goalActionNeedsExpected('create'), false, 'create 不带 expected');
  for (const action of ['edit', 'pause', 'resume', 'complete', 'clear']) {
    assert.equal(goalActionNeedsExpected(action), true, `${action} 必须带 expected {id,revision}`);
  }
  assert.equal(goalActionNeedsExpected('block'), true,
    'block 不属于手机人类操作（类型层就没有该动作，调用侧拿不到它）');

  const ref = goalRefOf({ id: 'goal-1', revision: 3, objective: 'x', phase: 'active' });
  assert.deepEqual(ref, { id: 'goal-1', revision: 3 }, 'CAS 引用 = 当前 {id,revision}');
  assert.equal(goalRefOf(null), null, '没有目标时不得编造 CAS 引用');
}

// ---------------------------------------------------------------- 协议层接线

assert.match(protocol, /export const CONTRACT_VERSION: string = 'v1\.3\.1'/);
assert.match(protocol, /MSG_PENDING_INTERACTIONS: string = 'pending\.interactions'/);
assert.match(protocol, /MSG_SESSION_TODOS: string = 'session\.todos'/);
assert.match(protocol, /MSG_SESSION_GOAL: string = 'session\.goal'/);
assert.match(protocol, /MSG_SESSION_GOAL_ACTION: string = 'session\.goalAction'/);
assert.match(protocol, /TOPIC_SESSION_TODOS_CHANGED: string = 'session\.todosChanged'/);
assert.match(protocol, /TOPIC_SESSION_GOAL_CHANGED: string = 'session\.goalChanged'/);
assert.match(protocol, /TOPIC_SESSION_GOAL_ACTIVATION_CHANGED: string = 'session\.goalActivationChanged'/);
assert.match(protocol, /export interface DshrcTodoItem \{/);
assert.match(protocol, /export interface DshrcGoalWire \{/);
assert.match(protocol, /export interface DshrcPendingQuestion \{/);
assert.match(protocol, /export interface DshrcPendingApproval \{/);
assert.match(protocol, /export type DshrcGoalAction = 'create' \| 'edit' \| 'pause' \| 'resume' \| 'complete' \| 'clear'/);
assert.doesNotMatch(protocol, /export type DshrcGoalAction =[^;]*'block'/,
  '手机可执行动作里不得出现 block');
assert.match(protocol, /todos\?: DshrcTodosCaps;/);
assert.match(protocol, /goal\?: DshrcGoalCaps;/);
assert.match(protocol, /pendingInteractions\?: DshrcPendingInteractionsCaps;/);
// v1.3.0（契约 §5.1 hello.features）：客户端必须声明 session-state-v1。
assert.match(protocol, /export const FEATURE_SESSION_STATE_V1: string = 'session-state-v1';/);
assert.match(protocol, /export const CLIENT_FEATURES: string\[\] = \[FEATURE_SESSION_STATE_V1\];/);
assert.match(protocol, /features\?: string\[\];/);
assert.match(link, /features: CLIENT_FEATURES\.slice\(\),/,
  '业务 hello 必须声明 features（session-state-v1）');

// ---------------------------------------------------------------- Link 层接线

assert.match(link, /pendingInteractions\(sessionId\?: string\): Promise<DshrcPendingInteractions>/);
assert.match(link, /todos\(sessionId: string\): Promise<DshrcTodosSnapshot>/);
assert.match(link, /goal\(sessionId: string\): Promise<DshrcGoalSnapshot>/);
assert.match(link, /goalAction\(sessionId: string, action: DshrcGoalAction, expected\?: DshrcGoalRef/);
assert.match(link, /const p: DshrcPayload = \{ sessionId: sessionId, action: action \};/);
assert.match(link, /if \(expected !== undefined\) \{\s+p\.expected = expected;/,
  '非 create 动作必须把 expected {id,revision} 放进请求');
assert.match(link, /if \(objective !== undefined && objective\.length > 0\) \{\s+p\.objective = objective;/);
assert.match(link, /if \(maxGoalRounds !== undefined && maxGoalRounds > 0\) \{\s+p\.maxGoalRounds = maxGoalRounds;/);

// ---------------------------------------------------------------- Store 接线

// 队列：整表替换 + 空数组覆盖旧缓存。
assert.match(store, /private applyQueueSnapshot\(sid: string, raw: DshrcQueueItem\[\] \| undefined\): void/);
assert.match(store, /const result: QueueTableResult = replaceQueueTable\(current, incoming\);/,
  '队列必须走「权威整表替换」纯规则');
assert.match(store, /this\.queueCache\.set\(sid, items\);/,
  '整表结果必须写回缓存（空数组即清空旧缓存）');

// 待答交互：askId 幂等（原地更新，不叠加）。
assert.match(store, /private upsertQuestion\(/);
assert.match(store, /private upsertApproval\(/);
assert.match(store, /if \(card\.askId !== askId\) \{\s+continue;\s+\}/,
  '同一 askId 必须命中既有卡片（幂等替换），不得叠加新卡');
assert.doesNotMatch(store, /this\.questions = this\.questions\.concat\(\[qcard\]\)/,
  '提问卡不得再无条件追加（旧的一次性内存事件写法）');
assert.doesNotMatch(store, /this\.approvals = this\.approvals\.concat\(\[card\]\)/,
  '审批卡不得再无条件追加');

// 待答快照：合并 + 失效清理。
assert.match(store, /private applyPendingInteractions\(snap: DshrcPendingInteractions, scope: string,\s+issuedSeq: number\): void/);
assert.match(store, /const plan: PendingMergePlan = planPendingMerge\(metas, snapshotAskIds, scope, issuedSeq\);/);
assert.match(store, /this\.dropQuestion\(plan\.remove\[n\]\);/);
assert.match(store, /this\.dropApproval\(plan\.remove\[n\]\);/);

// 对账入口：回前台 / 重连 / 打开会话 / 相关 live 事件都要拉待答快照。
assert.match(store, /onAppForeground\(\): void \{[\s\S]*?this\.loadPendingInteractions\(this\.activeId\);/,
  '回前台必须拉待答交互快照');
assert.match(store, /private reconcileActiveSession\(\): void \{[\s\S]*?this\.loadPendingInteractions\(sid\);/,
  '断线恢复对账必须拉待答交互快照');
assert.match(store, /openSession\(sid: string\): void \{[\s\S]*?this\.loadPendingInteractions\(sid\);/,
  '打开会话必须拉待答交互快照');
assert.match(store, /case TOPIC_QUESTION_REQUEST:[\s\S]*?this\.loadPendingInteractions\(/,
  '提问 live 事件后必须对账拉快照');
assert.match(store, /case TOPIC_APPROVAL_RESOLVED:[\s\S]*?this\.loadPendingInteractions\(/,
  '审批解决后必须对账拉快照');

// 桌面端回答 → 手机卡片消失（双端同步的**手机半边**，2026-11-12 补）：
// 顺序不能反——先取会话归属，drop 之后 pendingMeta 已被清掉。
assert.match(store,
  /case TOPIC_QUESTION_RESOLVED:[\s\S]*?const resolvedSid4: string = this\.pendingSessionOf\(askId4\);[\s\S]*?this\.dropQuestion\(askId4\);[\s\S]*?postQuestionResolved\(askId4\);[\s\S]*?this\.loadPendingInteractions\(resolvedSid4\);/,
  'question.resolved 必须：先取会话 → 删卡 → 广播 → 重拉快照');
assert.match(store,
  /case TOPIC_APPROVAL_RESOLVED:[\s\S]*?const resolvedSid: string = this\.pendingSessionOf\(askId2\);[\s\S]*?this\.dropApproval\(askId2\);[\s\S]*?postApprovalResolved\(askId2\);[\s\S]*?this\.loadPendingInteractions\(resolvedSid\);/,
  'approval.resolved 必须：先取会话 → 删卡 → 广播 → 重拉快照');
assert.match(store,
  /private dropQuestion\(askId: string\): void \{[\s\S]*?this\.pendingMeta\.delete\(askId\);[\s\S]*?postSessionStateChanged\(sid\);/,
  '删提问卡后必须广播状态变化，页面才会收起卡片（v1.3.1 渲染依赖）');
assert.match(store,
  /private dropApproval\(askId: string\): void \{[\s\S]*?postSessionStateChanged\(sid\);/,
  '删审批卡后必须广播状态变化');
assert.match(store, /this\.pendingLoading = true;/,
  '快照请求在途标记（不排队、不阻塞）');

// fail-open：读取失败不得报错阻塞。
assert.match(store, /'pending\.interactions unavailable: ' \+ e\.message/);

// submitQuestion：applied=false 不得断言「桌面已处理」，必须重拉快照。
assert.doesNotMatch(store, /提问已超时，桌面端已处理/,
  'applied=false 不得武断说桌面端已处理');
assert.match(store, /if \(applied\) \{\s+this\.markQuestionAnswered\(askId\);\s+return true;\s+\}/,
  '只有 applied=true 才本地隐藏卡片');
assert.match(store, /this\.lastError = '回答未生效（可能已被另一端回答或已失效），正在重新核对最新状态';/);
assert.match(store, /this\.loadPendingInteractions\(sid\.length > 0 \? sid : this\.activeId\);/,
  'applied=false 后必须重拉快照');
{
  // 提问卡的提交提示不得断言「桌面端已处理」（审批卡保持原口径，不在本次范围）。
  const submitIdx = askCards.indexOf('private submit(): void {');
  assert.ok(submitIdx >= 0, '提问卡必须有 submit 方法');
  const submitBlock = askCards.slice(submitIdx, askCards.indexOf('build() {', submitIdx));
  assert.doesNotMatch(submitBlock, /桌面端已处理/,
    '提问回答 applied=false 不得断言「桌面端已处理」');
  assert.match(submitBlock, /回答未生效，正在重新核对最新状态/);
}

// QuestionCard 状态机字段。
assert.match(store, /export class QuestionCard \{[\s\S]*?@Trace state: string = 'open';/);
assert.match(store, /export class QuestionCard \{[\s\S]*?@Trace callId: string = '';/);
assert.match(store, /export class QuestionCard \{[\s\S]*?@Trace expiresAt: number = 0;/);
assert.match(store, /export class QuestionCard \{[\s\S]*?@Trace answerable: boolean = true;/);
assert.match(askCards, /private canSubmit\(\): boolean \{[\s\S]*?this\.card\.state === 'continued'/,
  'continued（宿主仍可答）的问题必须仍可提交');
assert.match(askCards, /this\.card\.answerable && this\.remaining > 0 && !this\.card\.answered/,
  '宿主已不可答时不得显示可编辑按钮');

// Todo：null vs unsupported 严格区分。
assert.match(store, /todosFor\(sid: string\): DshrcTodoItem\[\] \| null \{/);
assert.match(store, /todosSupportedFor\(sid: string\): boolean \{/);
assert.match(store, /private applyTodoSnapshot\(sid: string, todos\?: DshrcTodoItem\[\] \| null, supported\?: boolean\): void/);
assert.match(store, /this\.todoSupportedCache\.set\(sid, supported\);/);
assert.match(store, /case TOPIC_SESSION_TODOS_CHANGED:[\s\S]*?this\.applyTodoSnapshot\(sidT2, data\.todos\);/,
  'todosChanged 必须整表落地');
assert.match(store, /loadTodos\(sid: string\): Promise<void> \{[\s\S]*?this\.link\.todos\(sid\)/);
assert.match(store, /this\.loadTodos\(sid\);/,
  '打开会话 / 对账都要拉 Todo');

// Goal：事件、CAS、stale 重拉。
assert.match(store, /case TOPIC_SESSION_GOAL_CHANGED:[\s\S]*?this\.goalCache\.set\(sidG, data\.goal !== undefined \? data\.goal : null\);/);
assert.match(store, /case TOPIC_SESSION_GOAL_ACTIVATION_CHANGED:[\s\S]*?this\.goalActivationCache\.set\(sidGA, activation\);/);
assert.match(store, /private applyGoalAction\(sid: string, action: DshrcGoalAction/);
assert.match(store, /if \(goalActionNeedsExpected\(action\)\) \{[\s\S]*?const ref: GoalRefShape \| null = goalRefOf\(this\.goalFor\(sid\)\);/,
  '非 create 动作必须带当前 {id,revision}');
assert.match(store, /if \(e\.message\.indexOf\('GOAL_STALE_REVISION'\) >= 0\) \{[\s\S]*?this\.loadGoal\(sid\);/,
  'GOAL_STALE_REVISION 必须重拉 session.goal');
assert.match(store, /throw new Error\('目标已被另一端更新，已重新加载最新状态，请确认后再操作'\);/);
assert.match(store, /loadGoal\(sid: string\): Promise<void> \{[\s\S]*?this\.link\.goal\(sid\)/);
assert.doesNotMatch(store, /'block'/, 'store 不得提供 block 动作');

// ---------------------------------------------------------------- UI 接线

// 渲染顺序：Goal 单行条 → Todo 折叠卡 → 排队消息 → 附件 → 输入框。
{
  const goalIdx = page.indexOf('GoalBar({');
  const todoIdx = page.indexOf('TodoCard({');
  const queueIdx = page.indexOf('this.pendingQueueBar()');
  const attachIdx = page.indexOf('this.attachmentChips()');
  const inputIdx = page.indexOf('TextArea({ text: this.draft');
  assert.ok(goalIdx >= 0 && todoIdx > goalIdx, 'Goal 条必须在 Todo 卡之前');
  assert.ok(queueIdx > todoIdx, 'Todo 卡必须在排队消息之前');
  assert.ok(attachIdx > queueIdx, '排队消息必须在附件之前');
  assert.ok(inputIdx > attachIdx, '附件必须在输入框之前');
}

// Goal 调用路径。
// v1.3.1：手机 UI 与桌面 GoalBar 对齐——只给「恢复/暂停、编辑、删除」三个图标按钮，
// **不再提供「完成」按钮**（完成由 Agent 侧产生；协议仍保留 complete）。
for (const call of ['createGoal', 'editGoal', 'pauseGoal', 'resumeGoal', 'clearGoal']) {
  assert.match(page, new RegExp(`this\\.store\\.${call}\\(`), `详情页必须能调用 ${call}`);
}
assert.doesNotMatch(page, /private onCompleteGoal\(\): void {/,
  '手机端不得再提供「完成」按钮（桌面 GoalBar 只有 恢复/暂停、编辑、删除）');
assert.match(page, /private onClearGoal\(\): void \{[\s\S]*?promptAction\.showDialog\(/,
  '清除目标必须二次确认');
assert.match(page, /private goalCanOperate\(\): boolean \{\s+return !this\.isSubagentView\(\);/,
  '子代理不得出现目标操作');
assert.match(page, /private goalActionList\(\): DshrcGoalAction\[\] \{[\s\S]*?'create', 'edit', 'pause', 'resume', 'complete', 'clear'/,
  '手机可执行动作集合里不得含 block');
assert.doesNotMatch(page, /'block'/);

// Todo 只读：详情页不得写清单。
assert.doesNotMatch(page, /store\.writeTodos|todo\/write/,
  '手机只读 Todo，不得提供写入路径');
assert.match(page, /private todoEmpty\(\): boolean \{/);
assert.match(page, /private todoRows\(\): TodoRowView\[\] \{/);

const timeline = readFileSync(new URL('./entry/src/main/ets/pages/TimelineView.ets', import.meta.url), 'utf8');

// v1.3.1：GoalBar 布局 = 状态 → 轮次 → 文案 → 三个图标按钮（与桌面 GoalBar 同款）。
assert.match(panels, /Text\(this\.phaseLabel\)[\s\S]*?if \(this\.roundsText\.length > 0\)[\s\S]*?Text\(this\.objective\)[\s\S]*?sys\.symbol\.pause[\s\S]*?sys\.symbol\.square_and_pencil[\s\S]*?sys\.symbol\.trash/,
  'Goal 行必须是「状态→轮次→文案→恢复/暂停、编辑、删除」三个图标按钮');
assert.doesNotMatch(panels, /Button\('完成'\)/, 'Goal 行不得再有文字按钮「完成」');
assert.doesNotMatch(panels, /Button\('暂停'\)|Button\('编辑'\)|Button\('清除'\)/,
  'Goal 操作必须是图标按钮，不再用文字按钮');
// 轮次由 Agent 控制：编辑弹窗不得出现轮次输入。
assert.doesNotMatch(panels, /最大轮次/, '编辑弹窗不得提供轮次输入（轮次由 Agent 控制）');
assert.doesNotMatch(panels, /draftRounds/, '编辑弹窗不得保留轮次草稿状态');
assert.match(panels, /this\.onCreate\(objective, 0\);/, '新建目标不得提交 maxGoalRounds');
assert.match(panels, /this\.onEdit\(objective, 0\);/, '编辑目标不得提交 maxGoalRounds');
// 任务清单没数据 → 整行隐藏（用户要求）。
assert.match(page, /private todoVisible\(\): boolean \{[\s\S]*?this\.todoSupportedSnap && this\.todoRowsSnap\.length > 0;/,
  '任务清单没数据必须整行隐藏');
// 唤醒消息触发卡（契约 §5.3 v1.3.1）。
assert.match(timeline, /private triggerLabel\(\): string \{[\s\S]*?'继续执行目标'/,
  '唤醒消息必须渲染触发卡文案（继续执行目标）');
assert.match(timeline, /if \(this\.item\.trigger\.length > 0\) \{/, '带 trigger 的消息走触发卡分支，不画普通气泡');
assert.match(store, /mi\.trigger = msg\.trigger !== undefined \? msg\.trigger : '';/, '历史消息必须映射 trigger');
assert.match(store, /dst\.trigger = src\.trigger;/, '复用旧实例时必须搬运 trigger（Repeat 复用语义）');
assert.match(store, /@Trace trigger: string = '';/);

// 组件拆分：V2 组件、只用基本类型参数。
assert.match(panels, /@ComponentV2\s+export struct GoalBar \{/);
assert.match(panels, /@ComponentV2\s+export struct TodoCard \{/);
assert.doesNotMatch(panels, /@State|@Prop|@Link|@ObjectLink|@Provide|@Consume|@Watch/,
  '新组件一律 V2 装饰器');
assert.match(panels, /Repeat\(this\.rows\)/);
assert.match(panels, /\.key\(\(row: TodoRowView\): string => row\.key\)/);
assert.doesNotMatch(panels, /'block'/, '面板不得提供 block 操作');

// ---------------------------------------------------------------- V1 装饰器扫描（必须 0 命中）
{
  const files = [
    './entry/src/main/ets/model/protocol.ets',
    './entry/src/main/ets/model/link.ets',
    './entry/src/main/ets/model/sessionstore.ets',
    './entry/src/main/ets/model/interaction-plan.ts',
    './entry/src/main/ets/pages/SessionDetailPage.ets',
    './entry/src/main/ets/pages/GoalTodoPanels.ets',
    './entry/src/main/ets/pages/AskCards.ets'
  ];
  const banned = /@(State|Prop|Link|ObjectLink|Provide|Consume|Watch|StorageLink)\b|@Observed(?!V2)/;
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const hits = src.match(new RegExp(banned, 'g')) ?? [];
    assert.deepEqual(hits, [], `${f} 出现 V1 状态装饰器`);
  }
}

// ---------------------------------------------------------------- v1.3.1：状态快照刷新（渲染依赖）
//
// 真机实测（模拟器 127.0.0.1:5555，mock host --demo）：
//   页面在 build 里经 **helper 方法** 读 store 的 @Trace 版本号（queueVersion /
//   todosVersion / goalVersion）**不会**建立渲染依赖 —— 症状是
//   ① 排队消息被宿主消费后仍残留在输入框上方；
//   ② 回前台后最后一条提问不弹出提问卡；
//   ③ 目标操作（暂停/完成/清除）后目标条不刷新。
// 修法：store 在这些数据变化时广播 EVT_SESSION_STATE_CHANGED，页面收到后把数据
// 搬进**自己的 @Local 快照**（页面自身状态变化一定触发重渲染）。
assert.match(events, /export const EVT_SESSION_STATE_CHANGED: string = 'dshrc\/session\/state';/);
assert.match(events, /export function postSessionStateChanged\(sessionId: string\): void/);
assert.match(store, /import \{[\s\S]*?postSessionStateChanged[\s\S]*?\} from '\.\/events';/,
  'store 必须广播会话状态变化');
assert.match(store, /this\.queueCache\.set\(sid, items\);[\s\S]{0,200}?postSessionStateChanged\(sid\);/,
  '排队表落地后必须广播');
assert.match(store, /this\.todosVersion = this\.todosVersion \+ 1;[\s\S]{0,200}?postSessionStateChanged\(sid\);/,
  'Todo 落地后必须广播');
assert.match(store, /this\.goalVersion = this\.goalVersion \+ 1;[\s\S]{0,200}?postSessionStateChanged\(sid\);/,
  'Goal 落地后必须广播');
assert.match(store, /this\.pendingVersion = this\.pendingVersion \+ 1;[\s\S]{0,200}?postSessionStateChanged\(/,
  '待答交互落地后必须广播');

assert.match(page, /EventPost\.getDefault\(\)\.onFromComponent\(EVT_SESSION_STATE_CHANGED, this/,
  '详情页必须订阅会话状态变化');
assert.match(page, /private syncSessionState\(\): void/);
assert.match(page, /@Local goalSnap: DshrcGoalWire \| null = null;/);
assert.match(page, /@Local goalActionsSnap: DshrcGoalAction\[\] = \[\];/);
assert.match(page, /@Local todoRowsSnap: TodoRowView\[\] = \[\];/);
assert.match(page, /@Local todoSupportedSnap: boolean = true;/);
assert.match(page, /@Local queueSnap: DshrcQueueItem\[\] = \[\];/);
assert.match(page, /@Local pendingQuestionsSnap: QuestionCard\[\] = \[\];/);
assert.match(page, /@Local pendingApprovalsSnap: ApprovalCard\[\] = \[\];/);
assert.doesNotMatch(page, /this\.store\.goalFor\(this\.sessionId\)/,
  '详情页渲染路径不得直接读 store 的 Map（不建立渲染依赖）');
assert.doesNotMatch(page, /this\.store\.queueVersion/,
  '详情页不得再靠 queueVersion 建立渲染依赖');
assert.doesNotMatch(page, /this\.store\.todosVersion/);
assert.doesNotMatch(page, /this\.store\.goalVersion/);
assert.match(page, /this\.goalSnap = this\.store\.goalFor\(sid\);/,
  '快照必须由 store 数据搬入');

assert.match(queuePage, /EventPost\.getDefault\(\)\.onFromComponent\(EVT_SESSION_STATE_CHANGED, this/,
  '审批队列页必须订阅会话状态变化');
assert.match(queuePage, /@Local approvalsSnap: ApprovalCard\[\] = \[\];/);
assert.match(queuePage, /@Local questionsSnap: QuestionCard\[\] = \[\];/);
assert.doesNotMatch(queuePage, /Repeat\(this\.store\.pendingApprovals\(\)\)/,
  '审批队列页不得直接渲染 store 的 helper 结果');
assert.doesNotMatch(queuePage, /Repeat\(this\.store\.pendingQuestions\(\)\)/);

assert.match(indexPage, /@Local pendingCountSnap: number = 0;/);
assert.match(indexPage, /EventPost\.getDefault\(\)\.onFromComponent\(EVT_SESSION_STATE_CHANGED, this/,
  '首页横幅的待处理数量必须订阅会话状态变化');
assert.doesNotMatch(indexPage, /Text\('⏳ 有 ' \+ this\.store\.pendingCount\(\)/,
  '首页横幅不得在渲染路径里直接读 pendingCount()');
assert.match(indexPage, /this\.pendingCountSnap = this\.store\.pendingCount\(\);/,
  '首页必须把待处理数量搬进 @Local 快照');

console.log('v13-contract-test: queue replace + askId idempotency + pending merge + ' +
  'todo null/unsupported + goal CAS + UI wiring + session-state snapshot assertions passed');
