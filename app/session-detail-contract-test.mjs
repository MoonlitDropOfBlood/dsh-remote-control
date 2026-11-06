// 详情页权限与 subagent 交互约束的接线回归：node session-detail-contract-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./entry/src/main/ets/pages/SessionDetailPage.ets', import.meta.url), 'utf8');
const store = readFileSync(new URL('./entry/src/main/ets/model/sessionstore.ets', import.meta.url), 'utf8');
const link = readFileSync(new URL('./entry/src/main/ets/model/link.ets', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('./entry/src/main/ets/model/protocol.ets', import.meta.url), 'utf8');
const timelineView = readFileSync(new URL('./entry/src/main/ets/pages/TimelineView.ets', import.meta.url), 'utf8');
const indexPage = readFileSync(new URL('./entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8');
const connectionsPage = readFileSync(new URL('./entry/src/main/ets/pages/ConnectionsPage.ets', import.meta.url), 'utf8');
const askCards = readFileSync(new URL('./entry/src/main/ets/pages/AskCards.ets', import.meta.url), 'utf8');
const approvalQueue = readFileSync(new URL('./entry/src/main/ets/pages/ApprovalQueuePage.ets', import.meta.url), 'utf8');

assert.match(protocol, /MSG_SESSION_PERMISSION: string = 'session\.permission'/);
assert.match(protocol, /MSG_SESSION_SELECT_PERMISSION: string = 'session\.selectPermission'/);
assert.match(protocol, /TOPIC_SESSION_PERMISSION_CHANGED: string = 'session\.permissionChanged'/);
assert.match(link, /sessionPermission\(sessionId: string\): Promise<string \| null>/);
assert.match(link, /sessionSelectPermission\(sessionId: string, permission: string\): Promise<string>/);
assert.match(store, /case TOPIC_SESSION_PERMISSION_CHANGED:/);
assert.match(store, /this\.loadSessionPermission\(this\.activeId\)/,
  '断线恢复必须补拉当前权限');

const loadCalls = page.match(/this\.store\.loadSessionPermission\(this\.sessionId\)/g) ?? [];
assert.ok(loadCalls.length >= 3, '打开、重现和参数兜底路径都要补拉权限');
assert.match(page, /private openModelSheet\(\): void \{\s+if \(this\.isSubagentView\(\)\)/);
assert.match(page, /private openPermissionSheet\(\): void \{\s+if \(this\.isSubagentView\(\)\)/);
assert.match(page, /private applySheetModel\(\): void \{\s+if \(this\.isSubagentView\(\)\)/);
assert.match(page, /private applySheetPermission\(\): void \{\s+if \(this\.isSubagentView\(\)\)/);
assert.match(page, /current === 'custom'[\s\S]*return '自定义权限'/);
assert.match(page, /selected === 'custom'/,
  '派生 custom 不得作为权限切换目标');

const metadataIndex = page.indexOf('// 模型 / 强度 / 权限：所有会话可见');
const oneShotIndex = page.indexOf("if (this.isSubagentView() && this.subagentMode() === 'one-shot') {", metadataIndex);
assert.ok(metadataIndex >= 0 && oneShotIndex > metadataIndex,
  '三项元信息必须位于 one-shot 输入分支之外');
const metadataBlock = page.slice(metadataIndex, oneShotIndex);
assert.match(metadataBlock, /this\.modelCapsule\(\)/);
assert.match(metadataBlock, /this\.permissionCapsule\(\)/);
const oneShotBlock = page.slice(oneShotIndex, page.indexOf('} else {', oneShotIndex));
assert.doesNotMatch(oneShotBlock, /TextInput|TextArea|this\.send\(\)/,
  '一次性 subagent 不得出现输入框或发送动作');
assert.match(page, /private send\(\): void \{[\s\S]*?this\.subagentMode\(\) === 'one-shot'[\s\S]*?return;/,
  '发送逻辑也要拒绝一次性 subagent，不能只靠隐藏 UI');

// 过程分组复用：Repeat 与自定义组件/@Builder 混用时必须传完整 RepeatItem。
// 只传 cell.item 会把节点留在旧分组，尤其会在中途插话后复用前一个 group。
assert.match(page, /\.template\('process',[\s\S]*?ProcessGroup\(\{\s+cell: cell,/,
  'process 模板必须把 RepeatItem<TimelineEntry> 整体传给 ProcessGroup');
assert.doesNotMatch(page, /this\.processGroup\(cell\.item\)|ProcessGroup\(\{ entry:/,
  '禁止退回只传 entry/cell.item 的旧写法');
assert.match(timelineView, /export struct ProcessGroup \{[\s\S]*?@Require @Param cell: RepeatItem<TimelineEntry>/);
assert.match(timelineView, /ListItemGroup\(\{ header: this\.groupHeader\(this\.cell\) \}\)/,
  '组头必须直接挂在 ListItemGroup.header，并显式接收完整 RepeatItem');
assert.match(timelineView, /ProcessGroupHeader\(\{ cell: cell,/,
  '组头与组体必须共享同一个 RepeatItem');
assert.match(timelineView, /Repeat\(this\.cell\.item\.members\)/);
assert.match(timelineView, /ProcessStepCard\(\{ cell: memberCell \}\)/);
assert.match(timelineView, /ProcessReasoningCard\(\{ cell: memberCell,/,
  '成员包装组件也必须接完整 RepeatItem<TimelineItem>');
assert.match(store, /@Trace closed: boolean = false/,
  '过程组必须有独立于条目类型的 DSH closed 状态');
assert.match(store, /if \(pendingGroup !== undefined\) \{\s+pendingGroup\.closed = true;/,
  'message 到达时必须立即关闭前一个过程组');
assert.match(timelineView, /if \(entry\.closed\) \{\s+return false;/,
  'closed 组不得因末项遗留 running 而继续显示运行态');

// 同一规则覆盖所有 Repeat → 自定义组件/@Builder 边界，不能只修过程分组。
assert.match(timelineView, /MessageImageItem\(\{ cell: cell,/);
assert.match(timelineView, /export struct TimelineMessage \{[\s\S]*?@Require @Param cell: RepeatItem<TimelineEntry>/);
assert.match(page, /TimelineMessage\(\{ cell: cell,/);
assert.match(page, /SubagentChip\(\{\s+cell: cell,/);
assert.match(page, /struct SubagentChip \{\s+@Require @Param cell: RepeatItem<SubagentRow>/);
assert.match(page, /this\.attachmentChip\(cell\)/);
assert.match(page, /attachmentChip\(cell: RepeatItem<DraftAttachment>\)/);
assert.match(page, /ApprovalRepeatCard\(\{ cell: cell,/);
assert.match(page, /QuestionRepeatCard\(\{ cell: cell,/);
assert.match(indexPage, /export struct SessionCard \{\s+@Require @Param cell: RepeatItem<SessionListItem>/);
assert.match(indexPage, /SessionCard\(\{\s+cell: cell,/);
assert.match(connectionsPage, /remoteRow\(cell: RepeatItem<RemoteProfile>\)/);
assert.match(connectionsPage, /this\.remoteRow\(cell\)/);
assert.match(askCards, /struct AskQuestionBlock \{\s+@Require @Param cell: RepeatItem<DshrcQuestion>/);
assert.match(askCards, /AskQuestionBlock\(\{\s+cell: cell,/);
assert.match(askCards, /export struct ApprovalRepeatCard \{[\s\S]*?@Require @Param cell: RepeatItem<ApprovalCard>/);
assert.match(askCards, /export struct QuestionRepeatCard \{[\s\S]*?@Require @Param cell: RepeatItem<QuestionCard>/);
assert.match(approvalQueue, /ApprovalRepeatCard\(\{\s+cell: cell,/);
assert.match(approvalQueue, /QuestionRepeatCard\(\{\s+cell: cell,/);

console.log('session-detail-contract-test: permission + subagent + RepeatItem wiring assertions passed');
