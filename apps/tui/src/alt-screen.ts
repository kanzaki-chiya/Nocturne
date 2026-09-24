/**
 * 终端备用屏幕进出原语（ADR-0017「可行性验证」的实测序列）：
 * 只有模型选择页使用；其余界面不进备用屏。
 *
 * 打开：suspendTerminal → 调用方提交全屏页 React 状态（挂起期间不输出）
 *   → 写 ?1049h + 2J + H → resume()（Ink 把页面帧全量重绘进备用屏）。
 * 关闭：suspendTerminal → 仍在备用屏内 resume() → 写 ?1049l 回主屏
 *   → 调用方再提交页面关闭状态（Ink 走 clearTerminal 全量重绘主屏）。
 *   ?1049l 必须在 resume() 之后：conhost 上先退备用屏再 resume 会
 *   在 stdin.setRawMode 报 EPIPE。
 * 兜底：inAlt 期间进程 exit 钩子与组件卸载清理都补发 ?1049l。
 */
import { useApp, useStdout } from "ink";
import { useCallback, useEffect, useRef } from "react";

export const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H";
export const EXIT_ALT = "\x1b[?1049l";

/** 等 React 提交到 Ink（挂起期间 waitUntilRenderFlush 不等 commit） */
async function waitCommit(committed: { current: boolean }, target: boolean): Promise<void> {
  for (let i = 0; i < 500 && committed.current !== target; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

export interface AltScreen {
  /** 页面打开中（含非 TTY 退化路径） */
  readonly inAlt: boolean;
  /**
   * 进入备用屏。`show` 回调在挂起期间提交全屏页状态并等待 commit。
   * 已在备用屏时为空操作。
   */
  enter(show: () => Promise<void> | void): Promise<void>;
  /**
   * 退出备用屏。`hide` 回调在回到主屏后提交页面关闭状态。
   * 不在备用屏时为空操作。
   */
  leave(hide: () => Promise<void> | void): Promise<void>;
}

export function useAltScreen(): AltScreen {
  const { stdout } = useStdout();
  const { suspendTerminal } = useApp();
  /** 真在备用屏内（仅 TTY 路径）；兜底 ?1049l 用 */
  const inAltRef = useRef(false);
  /** 页面打开中（含非 TTY 退化路径）；leave 的进入条件 */
  const openRef = useRef(false);
  const busyRef = useRef(false);

  // 兜底：组件卸载与进程退出都不把终端留在备用屏
  useEffect(() => {
    const onExit = (): void => {
      if (inAltRef.current) {
        try {
          stdout.write(EXIT_ALT);
        } catch {
          /* 退出路径忽略 */
        }
        inAltRef.current = false;
      }
    };
    process.on("exit", onExit);
    return () => {
      process.off("exit", onExit);
      onExit();
    };
  }, [stdout]);

  const enter = useCallback(
    async (show: () => Promise<void> | void): Promise<void> => {
      if (openRef.current || busyRef.current) return;
      // 非 TTY（测试/管道）：备用屏序列无意义，退化为直接提交页面状态
      if (!stdout.isTTY) {
        openRef.current = true;
        await show();
        return;
      }
      busyRef.current = true;
      try {
        const s = await suspendTerminal();
        // 挂起期间提交全屏页状态；写入被抑制，commit 后切屏再恢复全量重绘
        await show();
        stdout.write(ENTER_ALT);
        inAltRef.current = true;
        openRef.current = true;
        await s.resume();
      } finally {
        busyRef.current = false;
      }
    },
    [stdout, suspendTerminal],
  );

  const leave = useCallback(
    async (hide: () => Promise<void> | void): Promise<void> => {
      if (!openRef.current || busyRef.current) return;
      if (!stdout.isTTY) {
        openRef.current = false;
        await hide();
        return;
      }
      busyRef.current = true;
      try {
        const s = await suspendTerminal();
        // conhost：先在备用屏内恢复输入，再切回主屏，最后提交关闭状态
        await s.resume();
        stdout.write(EXIT_ALT);
        inAltRef.current = false;
        openRef.current = false;
        await hide();
      } finally {
        busyRef.current = false;
      }
    },
    [stdout, suspendTerminal],
  );

  return {
    get inAlt() {
      return openRef.current;
    },
    enter,
    leave,
  };
}

export { waitCommit };
