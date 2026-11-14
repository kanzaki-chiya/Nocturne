/**
 * 可暂停的超时计时器：用于工具执行与子代理启动器在等待用户权限确认期间
 * 暂停倒计时，离开等待后再以剩余时间恢复，支持嵌套等待引用计数。
 */
export interface PausableTimeout {
  readonly signal: AbortSignal;
  pause(): void;
  resume(): void;
  dispose(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createPausableTimeout(timeoutMs: number): PausableTimeout {
  const controller = new AbortController();
  let remainingMs = Math.max(0, timeoutMs);
  let pauseCount = 0;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = () => {
    timer = undefined;
    if (disposed || controller.signal.aborted) return;
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  };

  const arm = (ms: number) => {
    if (disposed || controller.signal.aborted) return;
    if (ms <= 0) {
      fire();
      return;
    }
    startedAt = Date.now();
    const slice = Math.min(ms, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || controller.signal.aborted || pauseCount > 0) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      remainingMs = Math.max(0, remainingMs - elapsed);
      if (remainingMs <= 0) fire();
      else arm(remainingMs);
    }, slice);
  };

  arm(remainingMs);

  return {
    signal: controller.signal,
    pause() {
      pauseCount += 1;
      if (disposed || controller.signal.aborted || pauseCount > 1) return;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const elapsed = Math.max(0, Date.now() - startedAt);
      remainingMs = Math.max(0, remainingMs - elapsed);
    },
    resume() {
      if (pauseCount === 0) return;
      pauseCount -= 1;
      if (pauseCount > 0 || disposed || controller.signal.aborted) return;
      arm(remainingMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
