/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页的选择态辅助逻辑（契约 §5.8 v1.0.6：模式 / 权限 / 工作目录）。
 * 职责（纯函数，页面只负责渲染与调用）：
 *  - 目录 → 候选项视图模型（模式 / 权限 / 工作目录共用一套 Select 下拉渲染）
 *  - 默认选中项解析：宿主给的 defaultPresetId / defaultPermissionId 优先，否则第一项
 *  - 提交前校验：目录刷新后旧 id 不再提交（避免宿主回 unsupported）
 *  - 工作目录候选：主机默认目录 + 已有会话用过的 cwd（去重 + 最近使用顺序）
 *  - 宿主拒绝所选模式/权限（错误文本含 unsupported）时的回退判定
 * 本层不碰链路与协议（session.create / session.prompt 由 link.ets 负责）。
 */
import { DshrcModeOption, DshrcPermissionOption } from './protocol';
import { SessionListItem } from './sessionstore';

/** 候选项的统一视图模型：id = 提交给主机的值，name = 下拉里显示的文案。 */
export interface DshrcChoiceItem {
  id: string;
  name: string;
  description: string;
}

/** 模式目录 → 候选项视图模型（name/description 用宿主给的文案，不做本地化映射）。 */
export function presetItems(presets: DshrcModeOption[]): DshrcChoiceItem[] {
  const out: DshrcChoiceItem[] = [];
  for (let i: number = 0; i < presets.length; i++) {
    out.push({
      id: presets[i].id,
      name: presets[i].name,
      description: presets[i].description
    });
  }
  return out;
}

/** 权限目录 → 候选项视图模型。 */
export function permissionItems(permissions: DshrcPermissionOption[]): DshrcChoiceItem[] {
  const out: DshrcChoiceItem[] = [];
  for (let i: number = 0; i < permissions.length; i++) {
    out.push({
      id: permissions[i].id,
      name: permissions[i].name,
      description: permissions[i].description
    });
  }
  return out;
}

/** 模式默认选中 id：defaultPresetId 命中目录则用它，否则第一项；空目录 → 空串。 */
export function resolvePresetId(presets: DshrcModeOption[], defaultId: string): string {
  if (presets.length === 0) {
    return '';
  }
  for (let i: number = 0; i < presets.length; i++) {
    if (presets[i].id === defaultId) {
      return defaultId;
    }
  }
  return presets[0].id;
}

/** 权限默认选中 id：同上。 */
export function resolvePermissionId(permissions: DshrcPermissionOption[], defaultId: string): string {
  if (permissions.length === 0) {
    return '';
  }
  for (let i: number = 0; i < permissions.length; i++) {
    if (permissions[i].id === defaultId) {
      return defaultId;
    }
  }
  return permissions[0].id;
}

/** 提交前校验模式 id：目录里没有该 id → 返回空串（不提交过期选项）。 */
export function validPresetId(presets: DshrcModeOption[], id: string): string {
  for (let i: number = 0; i < presets.length; i++) {
    if (presets[i].id === id) {
      return id;
    }
  }
  return '';
}

/** 提交前校验权限 id：目录里没有该 id → 返回空串（不提交过期选项）。 */
export function validPermissionId(permissions: DshrcPermissionOption[], id: string): string {
  for (let i: number = 0; i < permissions.length; i++) {
    if (permissions[i].id === id) {
      return id;
    }
  }
  return '';
}

/**
 * 工作目录候选：主机默认目录（id=''）+ 已有会话用过的 cwd。
 *  - rows 由 store.listItems() 给（按 updatedAt 降序 = 最近使用在前），逐项去重保持该顺序
 *  - selectedCwd 非空且不在列表里时补一项（当前已选值不丢）
 */
export function directoryItems(rows: SessionListItem[], selectedCwd: string): DshrcChoiceItem[] {
  const out: DshrcChoiceItem[] = [];
  // 第一项：主机默认目录（id='' → 不传 cwd，host 用自己的默认工作目录）
  out.push({
    id: '',
    name: '默认目录',
    description: '使用主机当前工作目录'
  });
  const seen: string[] = [];
  for (let i: number = 0; i < rows.length; i++) {
    const cwd: string = rows[i].cwd;
    if (cwd.length === 0 || seen.includes(cwd)) {
      continue;
    }
    seen.push(cwd);
    out.push({
      id: cwd,
      name: cwd,
      description: '已有会话用过'
    });
  }
  if (selectedCwd.length > 0 && !seen.includes(selectedCwd)) {
    out.push({
      id: selectedCwd,
      name: selectedCwd,
      description: '当前选择'
    });
  }
  return out;
}

/** 错误文本是否表示「主机不支持所选模式/权限」（宿主 result.error 形如 "unsupported: ..."）。 */
export function isUnsupportedError(message: string): boolean {
  const lower: string = message.toLowerCase();
  return lower.includes('unsupported') || lower.includes('not supported');
}
