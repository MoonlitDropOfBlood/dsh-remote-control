/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页的选择态辅助逻辑（契约 §5.8 v1.0.6：模式 / 权限）。
 * 职责（纯函数，页面只负责渲染与调用）：
 *  - 目录 → 候选项视图模型（模式 / 权限两套目录结构一致，页面共用一套单选组渲染）
 *  - 默认选中项解析：宿主给的 defaultPresetId / defaultPermissionId 优先，
 *    目录里没有该项则取第一项；目录为空 → 空串（页面整块隐藏）
 *  - 宿主拒绝所选模式/权限（错误文本含 unsupported）时的回退判定
 * 本层不碰链路与协议（session.create 由 link.ets 负责）。
 */
import { DshrcModeOption, DshrcPermissionOption } from './protocol';

/** 模式 / 权限候选项的统一视图模型（id 为宿主侧标识，name/description 为宿主展示文案）。 */
export interface DshrcChoiceItem {
  id: string;
  name: string;
  description: string;
}

/** 模式目录 → 候选项视图模型。 */
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

/** 模式默认选中 id：defaultPresetId 命中目录则用它，否则取第一项；空目录 → 空串。 */
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

/** 权限默认选中 id：defaultPermissionId 命中目录则用它，否则取第一项；空目录 → 空串。 */
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

/** 错误文本是否表示「主机不支持所选模式/权限」（宿主 result.error 形如 "unsupported: ..."）。 */
export function isUnsupportedError(message: string): boolean {
  const lower: string = message.toLowerCase();
  return lower.includes('unsupported') || lower.includes('not supported');
}
