/*
 * Copyright (c) 2026 dukedsh.
 * 小型串行任务队列：业务帧的解密/分发与加密/发送共用。
 * 纯 TypeScript，便于 Node 行为回归与 ArkTS 复用。
 */
export class DshrcOrderedQueue {
  private tail: Promise<void> = Promise.resolve();

  /** 按入队顺序启动任务；前一个任务 settle 后才启动下一个，单任务失败不阻塞后续。 */
  enqueue(task: () => Promise<void>): void {
    const run: Promise<void> = this.tail.then(task);
    this.tail = run.catch((): void => {
      // 调用方在任务内部记录具体错误；这里只保证队列可继续消费。
    });
  }
}
