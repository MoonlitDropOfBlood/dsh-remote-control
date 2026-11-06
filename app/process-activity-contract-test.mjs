/*
 * 「工作步骤」过程分组的活动分类 / 动态标题回归（v1.2.1，对齐桌面端 DSH）。
 *
 * 覆盖 app/entry/src/main/ets/model/process-activity.ts 的纯函数行为：
 *  - 工具名 → 活动种类（对齐 client-ui-chat 的 activity()）
 *  - 活动 → 中文文案（正在… / 已完成…）
 *  - composeProcessTitle：0/1/2/3/4 类活动的合成规则（对齐 processTitle）
 *  - reasoningPreview：流式取「最近写完的段落首行」、去掉 ** 标记
 *  - processLiveDetail：从工具参数里挑一句「正在做什么」
 *
 * 运行：node app/process-activity-contract-test.mjs
 * （node 24 自带 TS type-stripping，直接 import .ts，无需编译）
 */
import {
  activityOfTool,
  composeProcessTitle,
  latestParagraphFirstLine,
  processActivityLabel,
  processLiveDetail,
  rankProcessActivities,
  reasoningPreview
} from './entry/src/main/ets/model/process-activity.ts';

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`  ✗ ${label}\n      实际 ${a}\n      期望 ${e}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

console.log('== 工具名 → 活动种类（对齐 DSH activity()）==');
eq(activityOfTool('read'), 'read', 'read');
eq(activityOfTool('read_image'), 'readImage', 'read_image');
eq(activityOfTool('grep'), 'search', 'grep');
eq(activityOfTool('glob'), 'search', 'glob');
eq(activityOfTool('memory_inspect'), 'search', '*_inspect');
eq(activityOfTool('write'), 'write', 'write');
eq(activityOfTool('edit'), 'edit', 'edit');
eq(activityOfTool('apply_patch'), 'edit', 'apply_patch');
eq(activityOfTool('bash'), 'commands', 'bash');
eq(activityOfTool('pwsh'), 'commands', 'pwsh');
eq(activityOfTool('terminal_session'), 'commands', 'terminal_*');
eq(activityOfTool('run_code'), 'code', 'run_code');
eq(activityOfTool('web_search'), 'webSearch', 'web_search');
eq(activityOfTool('web_fetch'), 'webFetch', 'web_fetch');
eq(activityOfTool('subagent'), 'subagents', 'subagent');
eq(activityOfTool('subagent_wait'), 'subagents', 'subagent_*');
eq(activityOfTool('todo_write'), 'plan', 'todo_write');
eq(activityOfTool('create_goal'), 'plan', 'create_goal');
eq(activityOfTool('ask_user_question'), 'questions', 'ask_user_question');
eq(activityOfTool('some_unknown_tool'), 'tools', '未知工具兜底');

console.log('== 文案（正在… / 已完成…）==');
eq(processActivityLabel('read', true), '正在读取文件', 'read live');
eq(processActivityLabel('read', false), '已读取文件', 'read done');
eq(processActivityLabel('thinking', true), '正在分析请求', 'thinking live');
eq(processActivityLabel('thinking', false), '已完成分析', 'thinking done');
eq(processActivityLabel('commands', true), '正在运行命令', 'commands live');
eq(processActivityLabel('edit', false), '修改了文件', 'edit done');

console.log('== 标题合成（对齐 processTitle）==');
eq(composeProcessTitle(rankProcessActivities([])), '已完成分析', '0 类 → 已完成分析');
eq(composeProcessTitle(rankProcessActivities(['read'])), '已读取文件', '1 类');
eq(composeProcessTitle(rankProcessActivities(['read', 'search'])), '已读取文件并搜索代码',
  '2 类（首段带「已」→ 第二段去掉「已」）');
eq(composeProcessTitle(rankProcessActivities(['commands', 'thinking'])), '执行了命令并已完成分析',
  '2 类（首段不带「已」→ 保留第二段「已」）');
// 3 类及以上：**只有 2 类那条会剥掉「已」前缀**（continuation 只做首字母小写），与桌面端一致
eq(composeProcessTitle(rankProcessActivities(['read', 'search', 'commands'])),
  '已读取文件，已搜索代码，执行了命令', '3 类用「，」连接（不剥「已」）');
eq(composeProcessTitle(rankProcessActivities(['read', 'search', 'commands', 'edit'])),
  '已读取文件，已搜索代码，执行了命令等', '4 类以上加「等」');
// 排序：次数多的在前
eq(rankProcessActivities(['commands', 'commands', 'read']).map((c) => `${c.kind}:${c.count}`),
  ['commands:2', 'read:1'], '按出现次数降序');

console.log('== 思考摘要（对齐 latestCompletedParagraphFirstLine）==');
eq(latestParagraphFirstLine('第一段第一行\n第一段第二行\n\n第二段第一行\n第二段第二行'), '第二段第一行',
  '取最近写完段落的头一行');
eq(latestParagraphFirstLine('只有一行还没换行'), '', '首行没写完 → 空');
eq(latestParagraphFirstLine('第一行\n'), '第一行', '结尾换行 → 首行算写完');
eq(reasoningPreview('**加粗** 的第一行\n第二行', false), '加粗 的第一行', '去掉 ** 标记');

console.log('== 运行中细节（对齐 runningDetail）==');
eq(processLiveDetail('{"command":"npm test"}'), 'npm test', 'command 字段');
eq(processLiveDetail('{"description":"读取配置","path":"/a/b"}'), '读取配置', 'description 优先');
eq(processLiveDetail('{"description":"读取配置","file_path":"/a/b"}'), '读取配置', 'description 高于 path');
eq(processLiveDetail('{"file_path":"/a/b/c.md"}'), '/a/b/c.md', 'file_path');
eq(processLiveDetail('不是 JSON 的一段话'), '不是 JSON 的一段话', '非 JSON 兜底');
eq(processLiveDetail('{"command":"' + 'x'.repeat(80) + '"}', 20).endsWith('…'), true, '超长截断');

console.log('');
if (failures > 0) {
  console.error(`process-activity-contract-test: ${failures} 个断言失败`);
  process.exit(1);
}
console.log('process-activity-contract-test: 全部通过');
