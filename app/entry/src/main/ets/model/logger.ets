/*
 * Copyright (c) 2026 dukedsh.
 * dsh-remote-control-app 统一日志（@duke/logan-ext → Logan native 核心，AES 加密落盘）。
 *  - 双写策略：logDshrc() 同时写 hilog（实时调试）与 Logan 文件（真机排障：崩溃后 hilog
 *    已丢，文件日志仍在）——这是引入本库的首要动机（app/AGENTS.md 三方库一节）。
 *  - 初始化：EntryAbility.onCreate 调 initLogger(context)，仅主线程；重复调用幂等。
 *  - 配置按 README 默认：单文件 10MB、保留 7 天、落盘加密（内置 16 字节 key/iv，
 *    仅用于防明文落盘，不是业务密钥；E2E 密钥仍由配对 secret 经 HKDF 派生，互不相干）。
 *  - 日志安全：secret / 配对 URI 等敏感内容绝不写入（调用点保持现状脱敏，本层不做内容加工）。
 *  - exportLogs()：Logan.flush() 后枚举日志文件（路径 + 大小），供 About 页展示 / 后续分享。
 */
import { Logan, getDefaultConfig, LogLevel } from '@duke/logan-ext';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

const LOG_DOMAIN: number = 0x0000;
/** Logan 日志子目录（挂在 filesDir 下，避免散落在 filesDir 根目录）。 */
const LOGAN_SUBDIR: string = '/logan';
/** 落盘加密 key/iv（各 16 字节；README 默认加密开启——只防明文泄露，不承担保密职责）。 */
const LOGAN_KEY_16: string = 'dshrc-logan-key1'; // 16 chars
const LOGAN_IV_16: string = 'dshrc-logan-iv1'; // 16 chars

/** 统一日志级别（字符串字面量，调用方零依赖）。 */
export type DshrcLogLevel = 'debug' | 'info' | 'warn' | 'error';

let inited: boolean = false;
let logDir: string = '';

/** 级别 → Logan LogLevel 数值（DEBUG=0 … ERROR=3）。 */
function toLoganLevel(level: DshrcLogLevel): number {
  if (level === 'debug') {
    return LogLevel.DEBUG;
  }
  if (level === 'info') {
    return LogLevel.INFO;
  }
  if (level === 'warn') {
    return LogLevel.WARN;
  }
  return LogLevel.ERROR;
}

/** 级别 → hilog 输出（与既有 hilog 调用的公开格式保持一致：%{public}s）。 */
function writeHilog(level: DshrcLogLevel, tag: string, line: string): void {
  if (level === 'debug') {
    hilog.debug(LOG_DOMAIN, tag, '%{public}s', line);
  } else if (level === 'info') {
    hilog.info(LOG_DOMAIN, tag, '%{public}s', line);
  } else if (level === 'warn') {
    hilog.warn(LOG_DOMAIN, tag, '%{public}s', line);
  } else {
    hilog.error(LOG_DOMAIN, tag, '%{public}s', line);
  }
}

/**
 * 初始化 Logan（EntryAbility.onCreate 调用一次；幂等）。
 * 失败只降级为「纯 hilog」，绝不抛出打断主链路（契约 §10 优雅降级）。
 */
export function initLogger(context: common.Context): void {
  if (inited) {
    return;
  }
  try {
    const dir: string = context.filesDir + LOGAN_SUBDIR;
    // 预建目录：native makedir 一般会自建，但先建一层避免真机路径差异导致 init 静默失败。
    try {
      if (!fileIo.accessSync(dir)) {
        fileIo.mkdirSync(dir);
      }
    } catch (e) {
      // 目录已存在或其他非致命情况，继续交给 Logan 自身兜底。
    }
    const enc: util.TextEncoder = new util.TextEncoder();
    const config = getDefaultConfig(context.cacheDir, dir,
      enc.encodeInto(LOGAN_KEY_16), enc.encodeInto(LOGAN_IV_16));
    Logan.setDebug(false);
    Logan.init(config);
    logDir = dir;
    inited = true;
    logDshrc('dshrc-logger', 'info', 'file logger ready, dir=' + dir);
  } catch (e) {
    const msg: string = e instanceof Error ? e.message : 'unknown';
    // 初始化失败只留 hilog；后续 logDshrc 仍可用（纯 hilog 模式）。
    hilog.error(LOG_DOMAIN, 'dshrc-logger', 'initLogger failed: %{public}s', msg);
  }
}

/**
 * 统一日志入口：双写 hilog + Logan 文件。
 * @param tag   日志标识（沿用各模块既有 TAG，如 'dshrc-link'）
 * @param level 'debug' | 'info' | 'warn' | 'error'
 * @param msg   主消息（调用点负责脱敏：secret / 配对 URI 等绝不入日志）
 * @param extra 可选补充（同样须已脱敏）
 */
export function logDshrc(tag: string, level: DshrcLogLevel, msg: string, extra?: string): void {
  const line: string = extra !== undefined && extra.length > 0 ? msg + ' | ' + extra : msg;
  writeHilog(level, tag, line);
  if (inited) {
    try {
      Logan.log(toLoganLevel(level), tag, line);
    } catch (e) {
      // 文件写入失败不影响 hilog 与主链路（native 侧异常吞掉即可）。
    }
  }
}

/** 强制把缓冲日志刷入文件（进后台 / 导出前调用）。 */
export function flushLogs(): void {
  if (inited) {
    try {
      Logan.flush();
    } catch (e) {
      // 忽略：flush 失败最多丢最后几条缓冲日志。
    }
  }
}

/** 一个 Logan 日志文件的元信息（文件名为日期时间戳，内容为 AES 密文，须用配对工具解密查看）。 */
export interface DshrcLogFile {
  name: string;
  path: string;
  size: number;
}

/**
 * 枚举已落盘的日志文件（先 flush 保证缓冲不丢）。
 * 文件位于 context.filesDir + '/logan/'，返回空数组表示未初始化或暂无文件。
 */
export async function exportLogs(): Promise<DshrcLogFile[]> {
  if (!inited) {
    return [];
  }
  try {
    Logan.flush();
    const info: Map<string, number> = await Logan.getAllFilesInfo();
    const out: DshrcLogFile[] = [];
    info.forEach((size: number, name: string): void => {
      out.push({ name: name, path: logDir + '/' + name, size: size });
    });
    return out;
  } catch (e) {
    return [];
  }
}

/** 日志目录（诊断展示用；未初始化时为空串）。 */
export function logDirPath(): string {
  return logDir;
}
