/*
 * Copyright (c) 2026 dukedsh.
 * 「工作步骤」过程分组的活动分类与动态标题（v1.2.1，桌面端 DSH 对齐）。
 *
 * 桌面端 DSH 的「工作步骤」不是固定文案「工作步骤 · N」，而是按本轮实际发生的
 * 活动类型（读文件 / 搜索 / 执行命令 …）动态合成标题：
 *  - 分类表与标题合成算法**逐字对齐**桌面端 `@deepseek-ai/dsh-client-ui-chat`
 *    的 `process-activity` / `processTitle` 实现（见 plugin/node_modules 里的
 *    client.js：activity() 分类、message.stepProcess.* 文案、joinTwo/comma/more 合成）。
 *  - 思考块也属于过程分组的一种活动（thinking / 「已完成分析」）。
 *
 * 本文件是**纯 TypeScript**（不依赖 ArkTS / 平台 API），同时被
 *  - entry/src/main/ets/pages/TimelineView.ets（真机路径）
 *  - app/process-activity-contract-test.mjs（node 行为回归）
 * 引用。口径变了两侧一起变——不要把规则复制到别处。
 */

/** 过程活动种类（与桌面端 ProcessActivity 同名同义）。 */
export type ProcessActivityKind =
  | 'thinking'
  | 'read'
  | 'readImage'
  | 'search'
  | 'write'
  | 'edit'
  | 'commands'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagents'
  | 'plan'
  | 'questions'
  | 'tools';

/** 活动标题文案（桌面端 message.stepProcess.* 的简体中文词条）。 */
export interface ProcessActivityLabel {
  /** 进行中的标题：「正在读取文件」。 */
  live: string;
  /** 已完成后的标题：「已读取文件」。 */
  done: string;
}

const ACTIVITY_LABELS: Record<string, ProcessActivityLabel> = {
  thinking: { live: '正在分析请求', done: '已完成分析' },
  read: { live: '正在读取文件', done: '已读取文件' },
  readImage: { live: '正在读取图片', done: '已读取图片' },
  search: { live: '正在搜索代码', done: '已搜索代码' },
  write: { live: '正在写入文件', done: '已写入文件' },
  edit: { live: '正在编辑文件', done: '修改了文件' },
  commands: { live: '正在运行命令', done: '执行了命令' },
  code: { live: '正在运行代码', done: '运行了代码' },
  webSearch: { live: '正在搜索网页', done: '已搜索网页' },
  webFetch: { live: '正在访问网页', done: '已访问网页' },
  subagents: { live: '正在协调子智能体', done: '已协调子智能体' },
  plan: { live: '正在更新计划', done: '更新了计划' },
  questions: { live: '等待你的操作', done: '向用户提出了问题' },
  tools: { live: '正在调用工具', done: '已调用工具' }
};

/** 桌面端 joinTwo 的连接词：「{first}并{second}」。 */
const JOIN_TWO: string = '并';
/** 桌面端 comma：三个及以上活动之间用「，」。 */
const COMMA: string = '，';
/** 桌面端 sharedPrefix：「已」——两个活动都以此开头时只保留一次。 */
const SHARED_PREFIX: string = '已';
/** 桌面端 more：活动种类超过三个时标题尾部加「等」。 */
const MORE_SUFFIX: string = '等';
/** 桌面端 processTitle 只取前三类。 */
const TITLE_MAX_CATEGORIES: number = 3;

/** 工具名 → 活动种类（桌面端 activity() 的等价实现）。 */
export function activityOfTool(toolName: string): ProcessActivityKind {
  const name: string = toolName.trim().toLowerCase();
  if (name === 'read') {
    return 'read';
  }
  if (name === 'read_image') {
    return 'readImage';
  }
  if (name === 'grep' || name === 'glob' || name.endsWith('_inspect')) {
    return 'search';
  }
  if (name === 'write') {
    return 'write';
  }
  if (name === 'edit' || name === 'apply_patch') {
    return 'edit';
  }
  if (name === 'bash' || name === 'pwsh' || name === 'exec_command' || name === 'write_stdin' ||
    name.startsWith('terminal_')) {
    return 'commands';
  }
  if (name === 'run_code') {
    return 'code';
  }
  if (name === 'web_search') {
    return 'webSearch';
  }
  if (name === 'web_fetch') {
    return 'webFetch';
  }
  if (name === 'subagent' || name.startsWith('subagent_')) {
    return 'subagents';
  }
  if (name === 'todo_write' || name === 'create_goal' || name === 'update_goal' || name === 'get_goal') {
    return 'plan';
  }
  if (name === 'ask_user_question' || name === 'request_user_input') {
    return 'questions';
  }
  return 'tools';
}

/** 活动标题文案（live=true 取「正在…」，否则取「已完成…」）。 */
export function processActivityLabel(kind: ProcessActivityKind, live: boolean): string {
  const entry: ProcessActivityLabel | undefined = ACTIVITY_LABELS[kind];
  if (entry === undefined) {
    return live ? '正在调用工具' : '已调用工具';
  }
  return live ? entry.live : entry.done;
}

/** 活动计数（一种活动在本轮出现了多少次）。 */
export interface ProcessActivityCount {
  kind: ProcessActivityKind;
  count: number;
}

/**
 * 按出现次数给活动种类排序（多的在前；次数相同按首次出现顺序），
 * 与桌面端「Distinct-call category ranking」一致。
 */
export function rankProcessActivities(kinds: ProcessActivityKind[]): ProcessActivityCount[] {
  const order: ProcessActivityKind[] = [];
  const counts: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < kinds.length; i++) {
    const kind: ProcessActivityKind = kinds[i];
    if (!counts.has(kind)) {
      order.push(kind);
      counts.set(kind, 0);
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const out: ProcessActivityCount[] = [];
  for (let i = 0; i < order.length; i++) {
    out.push({ kind: order[i], count: counts.get(order[i]) ?? 0 });
  }
  out.sort((a: ProcessActivityCount, b: ProcessActivityCount): number => b.count - a.count);
  return out;
}

/**
 * 合成一个已结束分组的标题（桌面端 processTitle 的等价实现）：
 *  - 0 类 → 「已完成分析」
 *  - 1 类 → 「已读取文件」
 *  - 2 类 → 「已读取文件并搜索代码」（两段都带「已」时只保留一次）
 *  - 3 类 → 「已读取文件，搜索代码，执行了命令」
 *  - 4 类以上 → 同上 + 「等」
 */
export function composeProcessTitle(counts: ProcessActivityCount[]): string {
  const labels: string[] = [];
  const limit: number = Math.min(counts.length, TITLE_MAX_CATEGORIES);
  for (let i = 0; i < limit; i++) {
    labels.push(processActivityLabel(counts[i].kind, false));
  }
  const first: string | undefined = labels[0];
  if (first === undefined) {
    return processActivityLabel('thinking', false);
  }
  const second: string | undefined = labels[1];
  if (second === undefined) {
    return first;
  }
  if (labels.length === 2) {
    const shared: boolean = SHARED_PREFIX.length > 0 &&
      first.startsWith(SHARED_PREFIX) && second.startsWith(SHARED_PREFIX);
    const tail: string = shared ? second.substring(SHARED_PREFIX.length) : second;
    return first + JOIN_TWO + continuation(tail);
  }
  const parts: string[] = [first];
  for (let i = 1; i < labels.length; i++) {
    parts.push(continuation(labels[i]));
  }
  const title: string = parts.join(COMMA);
  return counts.length > TITLE_MAX_CATEGORIES ? title + MORE_SUFFIX : title;
}

/** 桌面端 continuation：首字母小写（中文无影响，英文有意义）。 */
function continuation(label: string): string {
  if (label.length === 0) {
    return label;
  }
  return label.charAt(0).toLowerCase() + label.substring(1);
}

/**
 * 桌面端 LIVE_TOOL_DETAIL_KEYS：从工具参数里挑「正在做什么」的一句话细节。
 * 顺序即优先级（第一个非空的就用它）。
 */
const LIVE_DETAIL_KEYS: string[] = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question',
  'questions', 'prompt', 'message', 'command', 'cmd', 'queries', 'query',
  'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status'
];

/** 运行中标题的细节最大字符数（桌面端 LIVE_TOOL_DETAIL_MAX_CHARS = 160；手机更短）。 */
export const LIVE_DETAIL_MAX_CHARS: number = 48;

/**
 * 从工具参数 JSON 里取一句「正在做什么」的细节（桌面端 runningDetail 的等价实现）。
 * 解析失败 / 没有命中字段 → 用压成一行的原始参数。返回空串表示没有细节。
 */
export function processLiveDetail(argsText: string, maxChars: number = LIVE_DETAIL_MAX_CHARS): string {
  const raw: string = argsText.trim();
  if (raw.length === 0) {
    return '';
  }
  let text: string = '';
  if (raw.charAt(0) === '{') {
    try {
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      for (let i: number = 0; i < LIVE_DETAIL_KEYS.length; i++) {
        const value: Object | undefined = parsed[LIVE_DETAIL_KEYS[i]];
        if (typeof value === 'string' && (value as string).trim().length > 0) {
          text = (value as string);
          break;
        }
      }
    } catch (e) {
      text = '';
    }
  }
  if (text.length === 0) {
    text = raw;
  }
  const oneLine: string = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return oneLine.substring(0, maxChars - 1) + '…';
}

/** 换行 / 回车（逐字符定义，避免在源码里写转义序列）。 */
const CHAR_CARRIAGE: string = String.fromCharCode(13);
const CHAR_NEWLINE: string = String.fromCharCode(10);

/** 思考块折叠时的一句话摘要长度上限（桌面端靠 CSS 省略号，手机直接截断）。 */
export const REASONING_PREVIEW_MAX_CHARS: number = 60;

/** 纯函数：文本第一行。 */
function firstLineOf(text: string): string {
  const nl: number = text.indexOf(CHAR_NEWLINE);
  return nl < 0 ? text : text.substring(0, nl);
}

/**
 * 桌面端 latestCompletedParagraphFirstLine：**最近一个「首行已写完」段落**的第一行。
 * 流式思考时用它做摘要——段落首行写完才前进，不会半句抖动。
 * 段落 = 空行分隔的连续非空行；段内首行「写完」的条件是段内还有下一行，
 * 或者该段被空行终结。
 */
export function latestParagraphFirstLine(text: string): string {
  if (text.length === 0) {
    return '';
  }
  const lines: string[] = text.split(CHAR_CARRIAGE).join('').split(CHAR_NEWLINE);
  let summary: string = '';
  let paragraph: string[] = [];
  const commit = (para: string[], terminated: boolean): void => {
    if (para.length === 0) {
      return;
    }
    if (para.length < 2 && !terminated) {
      return;
    }
    const candidate: string = para[0].trim();
    if (candidate.length > 0) {
      summary = candidate;
    }
  };
  for (let i: number = 0; i < lines.length; i++) {
    const line: string = lines[i];
    if (line.trim().length === 0) {
      commit(paragraph, true);
      paragraph = [];
    } else {
      paragraph.push(line);
    }
  }
  commit(paragraph, false);
  return summary;
}
/**
 * 思考块摘要（桌面端 ReasoningRow 的 collapsed summary）：
 *  - 仍在流式 → 最近一个已完成段落的头一行（动态前进）；
 *  - 已结束 → 第一行；
 *  - 去掉 markdown 的 `**` 强调标记；过长截断。
 */
export function reasoningPreview(text: string, running: boolean): string {
  const source: string = running ? latestParagraphFirstLine(text) : firstLineOf(text);
  const plain: string = source.split('**').join('').trim();
  if (plain.length <= REASONING_PREVIEW_MAX_CHARS) {
    return plain;
  }
  return plain.substring(0, REASONING_PREVIEW_MAX_CHARS - 1) + '…';
}
