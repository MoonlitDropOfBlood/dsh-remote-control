/*
 * Copyright (c) 2026 dukedsh.
 * 新建会话页的选择态辅助逻辑（契约 §5.8：模式 / 权限 / 工作目录 / 模型 / 思考强度）。
 * 职责（纯函数，页面只负责渲染与调用）：
 *  - 目录 → 候选项视图模型（模式 / 权限 / 工作目录 / 模型 / 思考强度共用 Select 渲染）
 *  - 默认选中项解析：宿主给的 defaultPresetId / defaultPermissionId / defaultModelId 优先，否则第一项
 *  - 提交前校验：目录刷新后旧 id 不再提交（避免宿主回 unsupported）
 *  - 工作目录候选：主机默认目录 + 已有会话用过的 cwd（去重 + 最近使用顺序）
 *  - 模型提交值：按选中的 ModelOption 构造 ModelSelection（不从 id 反拆 provider/model）
 *  - 思考强度（v1.0.8）：efforts 是合法取值集合；「默认」档提交空串（不带 reasoningEffort）
 *  - 宿主拒绝所选模式/权限（错误文本含 unsupported）时的回退判定
 * 本层不碰链路与协议（session.create / session.prompt 由 link.ets 负责）。
 */
import {
  DshrcEffortOption,
  DshrcModeOption,
  DshrcModelOption,
  DshrcModelSelection,
  DshrcPermissionOption
} from './protocol';
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

/** 模型目录 → 候选项视图模型（名称 + provider，避免不同来源的同名模型分不清）。 */
export function modelItems(models: DshrcModelOption[]): DshrcChoiceItem[] {
  const out: DshrcChoiceItem[] = [];
  for (let i: number = 0; i < models.length; i++) {
    const m: DshrcModelOption = models[i];
    const base: string = m.name.length > 0 ? m.name : m.model;
    const label: string = m.provider.length > 0 ? base + ' · ' + m.provider : base;
    out.push({
      id: m.id,
      name: label,
      description: m.provider + '/' + m.model
    });
  }
  return out;
}

/** 模型默认选中 id：defaultModelId 命中目录则用它，否则第一项；空目录 → 空串。 */
export function resolveModelId(models: DshrcModelOption[], defaultId: string): string {
  if (models.length === 0) {
    return '';
  }
  for (let i: number = 0; i < models.length; i++) {
    if (models[i].id === defaultId) {
      return defaultId;
    }
  }
  return models[0].id;
}

/** 提交前校验模型 id：目录里没有该 id → 返回空串（不提交过期选项）。 */
export function validModelId(models: DshrcModelOption[], id: string): string {
  for (let i: number = 0; i < models.length; i++) {
    if (models[i].id === id) {
      return id;
    }
  }
  return '';
}

/**
 * 按选中的模型项构造提交用的 ModelSelection。
 *  注意：provider / model 一律取自目录项本身，**不从 id 反拆**
 *  （id 只是客户端的稳定标识，格式不保证是 provider + "/" + model）。
 *  思考强度（契约 §5.8 v1.0.8）：
 *  - effortId 非空且命中该模型的 efforts → 提交 reasoningEffort=effortId
 *  - effortId 为空串（「默认」档）→ **不设** reasoningEffort，交给宿主用默认强度
 *  没选中（或目录已刷新掉该项）→ undefined（不提交 model，宿主用默认模型）。
 */
export function modelSelectionOf(models: DshrcModelOption[], id: string, effortId: string):
  DshrcModelSelection | undefined {
  for (let i: number = 0; i < models.length; i++) {
    const m: DshrcModelOption = models[i];
    if (m.id === id) {
      const sel: DshrcModelSelection = {
        provider: m.provider,
        model: m.model
      };
      if (effortId.length > 0 && effortHit(m, effortId)) {
        sel.reasoningEffort = effortId;
      }
      return sel;
    }
  }
  return undefined;
}

/** 思考强度是否属于该模型的合法集合（契约 §5.8 v1.0.8：efforts 是唯一合法取值集合）。 */
function effortHit(model: DshrcModelOption, effortId: string): boolean {
  const efforts: DshrcEffortOption[] | undefined = model.efforts;
  if (efforts === undefined) {
    return false;
  }
  for (let i: number = 0; i < efforts.length; i++) {
    if (efforts[i].id === effortId) {
      return true;
    }
  }
  return false;
}

/**
 * 思考强度候选项（契约 §5.8 v1.0.8）：所选模型支持强度时 =
 *  「默认」(id=''，提交空串 → 宿主默认强度) + 该模型的 efforts 逐项；
 *  模型不存在或没有 efforts → 空数组（页面隐藏整行）。
 */
export function effortItems(models: DshrcModelOption[], modelId: string): DshrcChoiceItem[] {
  const out: DshrcChoiceItem[] = [];
  for (let i: number = 0; i < models.length; i++) {
    if (models[i].id !== modelId) {
      continue;
    }
    const efforts: DshrcEffortOption[] | undefined = models[i].efforts;
    if (efforts === undefined || efforts.length === 0) {
      return out;
    }
    out.push({
      id: '',
      name: '默认',
      description: '使用模型默认强度'
    });
    for (let j: number = 0; j < efforts.length; j++) {
      const raw: string | undefined = efforts[j].description;
      const desc: string = raw !== undefined ? raw : '';
      out.push({
        id: efforts[j].id,
        name: efforts[j].name,
        description: desc
      });
    }
    return out;
  }
  return out;
}

/**
 * 模型默认思考强度 id：m.reasoningEffort 命中该模型 efforts 则返回它，
 * 否则空串（=「默认」档，提交时不带 reasoningEffort）。
 */
export function resolveEffortId(models: DshrcModelOption[], modelId: string): string {
  for (let i: number = 0; i < models.length; i++) {
    if (models[i].id !== modelId) {
      continue;
    }
    const efforts: DshrcEffortOption[] | undefined = models[i].efforts;
    if (efforts === undefined || efforts.length === 0) {
      return '';
    }
    const def: string | undefined = models[i].reasoningEffort;
    if (def === undefined || def.length === 0) {
      return '';
    }
    for (let j: number = 0; j < efforts.length; j++) {
      if (efforts[j].id === def) {
        return def;
      }
    }
    return '';
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
  // 第一项：主机默认目录（id='' → 不传 cwd，插件解析为主机的 ~/.dsh/remote 并确保目录存在）
  out.push({
    id: '',
    name: '默认目录',
    description: '默认使用 ~/.dsh/remote'
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
