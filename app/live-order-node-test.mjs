// 直播链路保序与历史对账的纯行为回归：node live-order-node-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DshrcOrderedQueue } from './entry/src/main/ets/model/ordered-queue.ts';
import {
  collectCoveredLiveStepIds,
  collectCoveredLiveTextIds
} from './entry/src/main/ets/model/timeline-reconcile.ts';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const queue = new DshrcOrderedQueue();
  const starts = [];
  const finishes = [];
  queue.enqueue(async () => {
    starts.push(101);
    await delay(25);
    finishes.push(101);
  });
  queue.enqueue(async () => {
    starts.push(102);
    finishes.push(102);
    throw new Error('intentional task failure');
  });
  queue.enqueue(async () => {
    starts.push(103);
    finishes.push(103);
  });
  await delay(45);
  assert.deepEqual(starts, [101, 102, 103], '任务必须按入队顺序启动');
  assert.deepEqual(finishes, [101, 102, 103], '失败任务不得阻塞后续帧');
}

{
  const durable = [
    { role: 'reasoning', text: 'R1R2' },
    { role: 'assistant', text: 'T1T2' },
  ];
  const live = [
    { itemId: 'r1', role: 'reasoning', text: 'R1', streaming: false },
    { itemId: 'a1', role: 'assistant', text: 'T1', streaming: false },
    { itemId: 'r2', role: 'reasoning', text: 'R2', streaming: false },
    { itemId: 'a2', role: 'assistant', text: 'T2', streaming: false },
  ];
  assert.deepEqual([...collectCoveredLiveTextIds(durable, live, false)].sort(),
    ['a1', 'a2', 'r1', 'r2'], '聚合 durable 必须覆盖交错的 live 片段');
}

{
  const durable = [{ role: 'assistant', text: 'A' }];
  const live = [
    { itemId: 'old', role: 'assistant', text: 'A', streaming: false },
    { itemId: 'new', role: 'assistant', text: 'A', streaming: false },
  ];
  assert.deepEqual([...collectCoveredLiveTextIds(durable, live, false)], ['old'],
    '同文本仍须一对一消费，不能误删后来消息');
}

{
  const durable = [{ role: 'assistant', text: 'ABC' }];
  const live = [
    { itemId: 'a1', role: 'assistant', text: 'AB', streaming: false },
    { itemId: 'a2', role: 'assistant', text: 'AB', streaming: false },
  ];
  assert.equal(collectCoveredLiveTextIds(durable, live, false).size, 0,
    '拼接不相等时不得误删直播内容');
}

{
  const durable = [{ role: 'assistant', text: 'AB' }];
  const live = [
    { itemId: 'previous-turn', role: 'assistant', text: 'A', streaming: false },
    { itemId: 'new-user', role: 'user', text: 'next', streaming: false },
    { itemId: 'current-turn', role: 'assistant', text: 'B', streaming: false },
  ];
  assert.equal(collectCoveredLiveTextIds(durable, live, false).size, 0,
    '聚合匹配不得越过未消费的用户消息跨 turn 误删');
}

{
  const live = [
    { itemId: 'done-a', role: 'assistant', text: 'A', streaming: false },
    { itemId: 'done-r', role: 'reasoning', text: 'R', streaming: false },
    { itemId: 'streaming', role: 'assistant', text: 'B', streaming: true },
    { itemId: 'user', role: 'user', text: 'U', streaming: false },
    { itemId: 'image', role: 'assistant', text: '', streaming: false },
  ];
  assert.deepEqual([...collectCoveredLiveTextIds([], live, true)].sort(),
    ['done-a', 'done-r'], '空闲最新页只清理完成的助手/思考文本副本');
  assert.equal(collectCoveredLiveTextIds([], live, false).size, 0,
    '运行中没有新增 durable 时不得清理 live');
}

{
  const durable = [{ callId: 'known' }];
  const live = [
    { itemId: 's-known', callId: 'known' },
    { itemId: 's-orphan', callId: 'orphan' },
  ];
  assert.deepEqual([...collectCoveredLiveStepIds(durable, live, false)], ['s-known'],
    '运行中只按 callId 去重，不能误删尚未进历史的直播步骤');
  assert.deepEqual([...collectCoveredLiveStepIds(durable, live, true)].sort(),
    ['s-known', 's-orphan'],
    '空闲最新页必须清掉未进本页的残留步骤，禁止在最终消息后拼出幽灵 group');
  assert.deepEqual([...collectCoveredLiveStepIds([], live, true)].sort(),
    ['s-known', 's-orphan'], '即使本页没有任何步骤，空闲权威对账也要接管全部 live 步骤');
}

// 纯函数之外再做接线断言，防止以后留下测试通过但生产路径未接队列/对账的假回归。
const linkSource = readFileSync(new URL('./entry/src/main/ets/model/link.ets', import.meta.url), 'utf8');
assert.match(linkSource, /this\.inboundQueue\.enqueue/);
assert.match(linkSource, /this\.outboundQueue\.enqueue/);
assert.match(linkSource, /generation !== this\.connectionGeneration/);
const storeSource = readFileSync(new URL('./entry/src/main/ets/model/sessionstore.ets', import.meta.url), 'utf8');
assert.match(storeSource, /collectCoveredLiveTextIds\(durable, live, dropFinalized\)/);
assert.match(storeSource, /const authoritativeIdle: boolean = !prepend && !this\.runningOf\(sid\)/);
assert.match(storeSource, /this\.coveredLiveIds\(items, messages, authoritativeIdle\)/);
assert.match(storeSource, /collectCoveredLiveStepIds\(steps, liveSteps, authoritativeIdle\)/);
assert.match(storeSource, /it\.isStep\(\) && coveredSteps\.has\(it\.id\)/);
assert.match(storeSource, /case TOPIC_TURN_END:[\s\S]*?row5\.running = false;[\s\S]*?this\.finalizeTurn\(sid5, errText\);[\s\S]*?this\.loadHistory\(sid5, false\)/);
assert.match(storeSource, /case TOPIC_SESSION_STATUS:[\s\S]*?wasRunning && !running[\s\S]*?this\.loadHistory\(sid2, false\)/);

console.log('live-order-node-test: 7 behavior groups + completion/step reconcile wiring assertions passed');
