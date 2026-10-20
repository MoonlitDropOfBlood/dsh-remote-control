declare interface ArkTsLintCliConsole {
  log(...args: Object[]): void;
  info(...args: Object[]): void;
  warn(...args: Object[]): void;
  error(...args: Object[]): void;
  debug(...args: Object[]): void;
}
declare const console: ArkTsLintCliConsole;
declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle?: number): void;
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearInterval(handle?: number): void;