// 详情页权限与 subagent 交互约束的接线回归：node session-detail-contract-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./entry/src/main/ets/pages/SessionDetailPage.ets', import.meta.url), 'utf8');
const store = readFileSync(new URL('./entry/src/main/ets/model/sessionstore.ets', import.meta.url), 'utf8');
const link = readFileSync(new URL('./entry/src/main/ets/model/link.ets', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('./entry/src/main/ets/model/protocol.ets', import.meta.url), 'utf8');

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

console.log('session-detail-contract-test: permission + subagent wiring assertions passed');
