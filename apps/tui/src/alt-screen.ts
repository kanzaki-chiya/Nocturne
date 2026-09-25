/**
 * 终端备用屏幕进出原语（ADR-0017「可行性验证」的实测序列）：
 * 只有模型选择页使用；其余界面不进备用屏。
 *
 * 打开：suspendTerminal → 调用方提交全屏页 React 状态（挂起期间不输出）
 *   → 写 ?1049h + 2J + H → resume()（Ink 把页面帧全量重绘进备用屏）。
 * 关闭：suspendTerminal → 仍在备用屏内 resume() → 写 ?1049l 回主屏
 *   → 调用方提交页面关闭状态，等 React commit 且 Ink 把主界面帧
 *   flush 到主屏后才算关完。
 *   ?1049l 必须在 resume() 之后：conhost 上先退备用屏再 resume 会
 *   在 stdin.setRawMode 报 EPIPE。关闭后必须等到主界面帧真正落进
 *   主屏：调用方若随即 exit()，unmount 的终帧会把尚未卸载的页面帧
 *   画进主屏 scrollback（Ctrl+C 退出路径实测）。
 *
 * Windows 控制台 stdin 保护（实测第 2~4 个开关周期后 stdin 永久饿死）：
 * Ink pauseInput 会 unref() + setRawMode(false)，撤销控制台挂起的读请求，
 * resumeInput 的 ref()/setRawMode(true) 不能可靠重发。本应用挂起只用于
 * 备用屏切换、没有子进程接管终端，因此：
 *   - runTui 在应用生命周期内吞掉 stdin.unref()，退出时补一次真 unref；
 *   - 本文件的挂起窗口内吞掉 setRawMode(false)，让控制台保持 raw；
 *   周期退化为纯 listener detach/attach；resume 后再 read(0) 补发一次
 *   读请求兜底。
 * 兜底：inAlt 期间进程 exit 钩子与组件卸载清理都补发 ?1049l。
 */
import { useApp, useStdin, useStdout } from "ink";
import { useCallback, useEffect, useRef } from "react";

export const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H";
export const EXIT_ALT = "\x1b[?1049l";

/** 等 React 提交到 Ink（挂起期间 waitUntilRenderFlush 不等 commit） */
async function waitCommit(committed: { current: boolean }, target: boolean): Promise<void> {
  for (let i = 0; i < 500 && committed.current !== target; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * 挂起窗口内吞掉 stdin.setRawMode(false)（保留 true 调用）：Windows 控制台上
 * raw↔cooked 反复切换会撤销挂起的读请求导致 stdin 饿死。返回恢复函数。
 */
function swallowCookedDuringSuspend(stdin: NodeJS.ReadStream): () => void {
  const orig = stdin.setRawMode.bind(stdin);
  stdin.setRawMode = ((mode: boolean) => (mode ? orig(mode) : true)) as typeof stdin.setRawMode;
  return () => {
    stdin.setRawMode = orig;
  };
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
   * 退出备用屏。`hide` 回调在回到主屏后提交页面关闭状态；leave 等它
   * 完成后再等 Ink 把主界面帧 flush 进主屏才返回——调用方随即
   * exit() 也不会把页面帧画进主屏。
   * 不在备用屏时为空操作。
   */
  leave(hide: () => Promise<void> | void): Promise<void>;
}

export function useAltScreen(): AltScreen {
  const { stdout } = useStdout();
  const { stdin } = useStdin();
  const { suspendTerminal, waitUntilRenderFlush } = useApp();
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
      const restoreSetRawMode = swallowCookedDuringSuspend(stdin);
      try {
        const s = await suspendTerminal();
        // 挂起期间提交全屏页状态；写入被抑制，commit 后切屏再恢复全量重绘
        await show();
        stdout.write(ENTER_ALT);
        inAltRef.current = true;
        openRef.current = true;
        await s.resume();
        // Windows 控制台 stdin：resume 后补发一次读请求兜底
        stdin.read(0);
      } finally {
        restoreSetRawMode();
        busyRef.current = false;
      }
    },
    [stdout, stdin, suspendTerminal],
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
      const restoreSetRawMode = swallowCookedDuringSuspend(stdin);
      try {
        const s = await suspendTerminal();
        // conhost：先在备用屏内恢复输入，再切回主屏（?1049l 必须晚于
        // resume，否则 resume 的 stdin.setRawMode 报 EPIPE）
        await s.resume();
        stdin.read(0);
        stdout.write(EXIT_ALT);
        inAltRef.current = false;
        openRef.current = false;
        // 回到主屏后提交页面关闭状态，并等 Ink 把主界面帧真正 flush 进
        // 主屏——调用方随即 exit() 也不会把页面帧画进 scrollback
        await hide();
        await waitUntilRenderFlush();
      } finally {
        restoreSetRawMode();
        busyRef.current = false;
      }
    },
    [stdout, stdin, suspendTerminal, waitUntilRenderFlush],
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
