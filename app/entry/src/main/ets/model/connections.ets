/*
 * Copyright (c) 2026 dukedsh.
 * 多远程连接配置仓（v1.0.6）：一个手机可管理**多个**远程主机，任选其一连接。
 * 职责：
 *  - RemoteProfile（id/name/relayUrl/channel/secret/relayToken/lastUsedAt）持久化在
 *    Preferences `dshrc_prefs` 的 `remotes`（JSON 数组）+ `activeRemoteId`（当前项）
 *  - 首次启动若没有新数据 → 把旧的单条配对键（relayUrl/channel/secret/relayToken）
 *    迁移成一个名为「默认远程」的 profile（老用户零操作升级）
 *  - activate() = 切到该远程并连接：savePairing 同步旧键（兼容旧链路逻辑）
 *    → dshrcLink.stop() → dshrcLink.start(toLinkConfig(...))，并刷新 lastUsedAt
 *  - v1.1.3 会话纪元（契约 §3.4.1）：selfEpoch/peerEpoch/peerSid 存在档案里
 *    （每个远程独立）→ activate 时注入链路，链路每次变更回调写回并持久化
 *  - secret / relayToken 只存本地、绝不写日志（AGENTS.md 硬性约定）
 */
import { preferences } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { Context } from '@kit.AbilityKit';
import { logDshrc } from './logger';
import { LinkConfig, LinkEpochState, dshrcLink } from './link';
import { APP_NAME, APP_VERSION, PairingConfig, loadPairing, savePairing, toLinkConfig } from './store';

const TAG: string = 'dshrc-connections';
/** Preferences 名（与 model/store.ets 同一个存储空间）。 */
const PREF_NAME: string = 'dshrc_prefs';
/** 远程列表（JSON 数组字符串）。 */
const KEY_REMOTES: string = 'remotes';
/** 当前使用的远程 id。 */
const KEY_ACTIVE_REMOTE: string = 'activeRemoteId';
/** 迁移旧单条配对时的默认名称。 */
const DEFAULT_REMOTE_NAME: string = '默认远程';
/** v1.1.3：尚未接受过任何对端证明时的「已接受纪元」缺省值（-1 = 无）。 */
const EPOCH_PEER_NONE: number = -1;

/** 远程配置的持久化形态（JSON 往返用；字段可选 → 兼容早期/损坏数据）。 */
export interface RemoteProfileJson {
  id?: string;
  name?: string;
  relayUrl?: string;
  channel?: string;
  secret?: string;
  relayToken?: string;
  lastUsedAt?: number;
  // v1.1.3 会话纪元（契约 §3.4.1）：自己的纪元 / 已接受的对端纪元 / 已钉扎的对端 sid
  selfEpoch?: number;
  peerEpoch?: number;
  peerSid?: string;
}

/** 局部更新用的补丁（只带要改的字段）。 */
export interface RemoteProfilePatch {
  name?: string;
  relayUrl?: string;
  channel?: string;
  secret?: string;
  relayToken?: string;
}

/** 一个远程主机（PC）的连接档案。 */
@ObservedV2
export class RemoteProfile {
  @Trace id: string = '';
  @Trace name: string = '';
  @Trace relayUrl: string = '';
  @Trace channel: string = '';
  @Trace secret: string = '';
  @Trace relayToken: string = '';
  @Trace lastUsedAt: number = 0;
  /**
   * v1.1.3 会话纪元（契约 §3.4.1）：
   *  - selfEpoch   : 本端自己的纪元（每条新连接 +1，跨进程重启单调递增）
   *  - peerEpoch   : 已接受的对端最高纪元（-1 = 尚未接受过任何对端证明）
   *  - peerSid     : 已钉扎的对端 sid（加固模式下收到的 frame.sid 必须等于它）
   */
  @Trace selfEpoch: number = 0;
  @Trace peerEpoch: number = EPOCH_PEER_NONE;
  @Trace peerSid: string = '';

  /** 链路层/旧单条键共用的配对视图（顺带 trim）。 */
  toPairingConfig(): PairingConfig {
    const cfg: PairingConfig = {
      relayUrl: this.relayUrl.trim(),
      channel: this.channel.trim(),
      secret: this.secret.trim(),
      relayToken: this.relayToken.trim()
    };
    return cfg;
  }

  /** 列表显示名（无名时用 relayUrl 兜底）。 */
  displayName(): string {
    const n: string = this.name.trim();
    if (n.length > 0) {
      return n;
    }
    if (this.relayUrl.length > 0) {
      return this.relayUrl;
    }
    return '未命名远程';
  }
}

/** 生成远程 id（本地唯一即可，不作安全用途）。 */
function newRemoteProfileId(): string {
  const stamp: string = Date.now().toString(36);
  const rand: string = Math.floor(Math.random() * 1000000).toString(36);
  return 'r' + stamp + rand;
}

/**
 * 多远程连接状态仓（单例）。
 * @Trace 字段被页面读取即自动刷新；结构性变化（增删远程）整数组替换。
 */
@ObservedV2
export class ConnectionStore {
  /** 全部远程档案。 */
  @Trace profiles: RemoteProfile[] = [];
  /** 当前使用的远程 id（空串 = 未选择）。 */
  @Trace activeId: string = '';
  /** 是否已从 Preferences 载入过（UI 据此区分「未配置」与「空列表」）。 */
  @Trace loaded: boolean = false;

  /** 持久化用的 Context（load/activate 时记下；add/update/remove 复用）。 */
  private context: Context | null = null;

  /**
   * 读取远程列表；首次没有新数据时用旧的单条配对迁移一个「默认远程」。
   * 同步调用（Preferences 同步 API），页面 aboutToAppear 调一次即可。
   */
  load(context: Context): void {
    this.context = context;
    let raw: string = '';
    try {
      const pref: preferences.Preferences = preferences.getPreferencesSync(context, { name: PREF_NAME });
      raw = pref.getSync(KEY_REMOTES, '') as string;
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'error', 'load remotes failed: ' + err.message);
    }
    const parsed: RemoteProfile[] = this.parseProfiles(raw);
    if (parsed.length > 0) {
      this.profiles = parsed;
      this.restoreActive(context);
      this.loaded = true;
      return;
    }
    // 迁移旧的单条配对（老用户零操作升级成「默认远程」）
    const legacy: PairingConfig = loadPairing(context);
    if (legacy.relayUrl.length === 0 && legacy.channel.length === 0 && legacy.secret.length === 0) {
      this.profiles = [];
      this.activeId = '';
      this.loaded = true;
      return;
    }
    const migrated: RemoteProfile = new RemoteProfile();
    migrated.id = newRemoteProfileId();
    migrated.name = DEFAULT_REMOTE_NAME;
    migrated.relayUrl = legacy.relayUrl;
    migrated.channel = legacy.channel;
    migrated.secret = legacy.secret;
    migrated.relayToken = legacy.relayToken;
    migrated.lastUsedAt = Date.now();
    this.profiles = [migrated];
    this.activeId = migrated.id;
    this.persist();
    this.loaded = true;
    logDshrc(TAG, 'info', 'migrated legacy pairing into a remote profile');
  }

  /** 新增一个远程档案（id 为空时自动生成）。 */
  add(profile: RemoteProfile): void {
    const p: RemoteProfile = profile;
    if (p.id.length === 0) {
      p.id = newRemoteProfileId();
    }
    this.profiles = this.profiles.concat([p]);
    this.persist();
  }

  /** 局部更新某个远程档案。 */
  update(id: string, patch: RemoteProfilePatch): void {
    const p: RemoteProfile | undefined = this.profileOf(id);
    if (p === undefined) {
      return;
    }
    if (patch.name !== undefined) {
      p.name = patch.name;
    }
    if (patch.relayUrl !== undefined) {
      p.relayUrl = patch.relayUrl;
    }
    if (patch.channel !== undefined) {
      p.channel = patch.channel;
    }
    if (patch.secret !== undefined) {
      p.secret = patch.secret;
    }
    if (patch.relayToken !== undefined) {
      p.relayToken = patch.relayToken;
    }
    this.persist();
  }

  /** 删除某个远程档案（当前项被删时清空 activeId；链路由页面负责断开）。 */
  remove(id: string): void {
    const next: RemoteProfile[] = [];
    for (const p of this.profiles) {
      if (p.id !== id) {
        next.push(p);
      }
    }
    this.profiles = next;
    if (this.activeId === id) {
      this.activeId = '';
    }
    this.persist();
  }

  /**
   * 切到该远程并连接：保存 activeId + 同步旧单条配对键 → 断开旧链路 → 起新链路。
   * lastUsedAt 同步刷新（列表按最近使用排序时可参考）。
   * v1.1.3：纪元状态随档案注入链路（自己的纪元跨重启单调 + 已接受的对端纪元/钉扎 sid）。
   */
  activate(context: Context, id: string): void {
    const p: RemoteProfile | undefined = this.profileOf(id);
    if (p === undefined) {
      return;
    }
    this.context = context;
    this.activeId = p.id;
    p.lastUsedAt = Date.now();
    const cfg: PairingConfig = p.toPairingConfig();
    // 同步旧键（老逻辑/其它模块仍读 relayUrl/channel/secret/relayToken）
    savePairing(context, cfg);
    this.persist();
    dshrcLink.stop();
    const lc: LinkConfig = toLinkConfig(cfg, APP_NAME, APP_VERSION);
    // v1.1.3：纪元状态 + 变更回调（链路层「先持久化再使用」的落地点）
    lc.epoch = { self: p.selfEpoch, peer: p.peerEpoch, peerSid: p.peerSid };
    lc.onEpoch = (st: LinkEpochState): void => {
      this.applyEpoch(p.id, st);
    };
    dshrcLink.start(lc).catch((e: Error): void => {
      logDshrc(TAG, 'warn', 'link start failed: ' + e.message);
    });
  }

  /**
   * 落盘纪元状态（契约 §3.4.1）：链路层每条新连接把 self +1，或接受对端证明时
   * 更新 peer/peerSid —— 都通过这里写回档案并持久化（跨进程重启仍单调）。
   */
  applyEpoch(id: string, st: LinkEpochState): void {
    const p: RemoteProfile | undefined = this.profileOf(id);
    if (p === undefined) {
      return;
    }
    if (p.selfEpoch !== st.self || p.peerEpoch !== st.peer || p.peerSid !== st.peerSid) {
      p.selfEpoch = st.self;
      p.peerEpoch = st.peer;
      p.peerSid = st.peerSid;
      this.persist();
    }
  }

  /** 当前使用的远程档案（未选择返回 undefined）。 */
  activeProfile(): RemoteProfile | undefined {
    if (this.activeId.length === 0) {
      return undefined;
    }
    return this.profileOf(this.activeId);
  }

  /** 按 id 查档案。 */
  profileOf(id: string): RemoteProfile | undefined {
    for (const p of this.profiles) {
      if (p.id === id) {
        return p;
      }
    }
    return undefined;
  }

  /** 读回 activeRemoteId；失效（档案已删）时回落到第一个。 */
  private restoreActive(context: Context): void {
    let id: string = '';
    try {
      const pref: preferences.Preferences = preferences.getPreferencesSync(context, { name: PREF_NAME });
      id = pref.getSync(KEY_ACTIVE_REMOTE, '') as string;
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'error', 'load active remote failed: ' + err.message);
    }
    if (id.length > 0 && this.profileOf(id) !== undefined) {
      this.activeId = id;
      return;
    }
    this.activeId = this.profiles.length > 0 ? this.profiles[0].id : '';
  }

  /** 落盘（列表 + 当前项）。 */
  private persist(): void {
    const ctx: Context | null = this.context;
    if (ctx === null) {
      return;
    }
    try {
      const pref: preferences.Preferences = preferences.getPreferencesSync(ctx, { name: PREF_NAME });
      pref.putSync(KEY_REMOTES, this.serialize());
      pref.putSync(KEY_ACTIVE_REMOTE, this.activeId);
      pref.flushSync();
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'error', 'save remotes failed: ' + err.message);
    }
  }

  /** 档案数组 → JSON 字符串（显式拼装，避免依赖 V2 装饰器的序列化表现）。 */
  private serialize(): string {
    const arr: RemoteProfileJson[] = [];
    for (const p of this.profiles) {
      const item: RemoteProfileJson = {
        id: p.id,
        name: p.name,
        relayUrl: p.relayUrl,
        channel: p.channel,
        secret: p.secret,
        relayToken: p.relayToken,
        lastUsedAt: p.lastUsedAt,
        // v1.1.3 会话纪元
        selfEpoch: p.selfEpoch,
        peerEpoch: p.peerEpoch,
        peerSid: p.peerSid
      };
      arr.push(item);
    }
    return JSON.stringify(arr);
  }

  /** JSON 字符串 → 档案数组（脏数据整体丢弃，不抛异常）。 */
  private parseProfiles(text: string): RemoteProfile[] {
    const out: RemoteProfile[] = [];
    if (text.trim().length === 0) {
      return out;
    }
    try {
      const raw: RemoteProfileJson[] = JSON.parse(text) as RemoteProfileJson[];
      for (const item of raw) {
        const p: RemoteProfile = new RemoteProfile();
        p.id = item.id !== undefined ? item.id : '';
        p.name = item.name !== undefined ? item.name : '';
        p.relayUrl = item.relayUrl !== undefined ? item.relayUrl : '';
        p.channel = item.channel !== undefined ? item.channel : '';
        p.secret = item.secret !== undefined ? item.secret : '';
        p.relayToken = item.relayToken !== undefined ? item.relayToken : '';
        p.lastUsedAt = item.lastUsedAt !== undefined ? item.lastUsedAt : 0;
        // v1.1.3：老数据缺纪元字段 → 补默认值（自己的纪元 0 / 未接受过对端 -1 / 无钉扎 sid）
        p.selfEpoch = item.selfEpoch !== undefined ? item.selfEpoch : 0;
        p.peerEpoch = item.peerEpoch !== undefined ? item.peerEpoch : EPOCH_PEER_NONE;
        p.peerSid = item.peerSid !== undefined ? item.peerSid : '';
        if (p.id.length > 0) {
          out.push(p);
        }
      }
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      logDshrc(TAG, 'warn', 'parse remotes failed: ' + err.message);
    }
    return out;
  }
}

/** 全局单例（首页顶栏与连接管理页共享）。 */
export const connectionStore: ConnectionStore = new ConnectionStore();
