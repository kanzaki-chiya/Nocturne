/**
 * 全屏模式接管 console 输出（tui.md §2 状态栏与提示）。Node 进程警告也经 console.error 写出。
 * Ink 的 patchConsole 把文字写在帧上方，备用屏里会压进输入行、打乱画面；
 * 这里改为转成对话区的本地提示行：只取首行、同文去重、每次运行至多 20 条。
 */
import { format } from "node:util";

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
const MAX_LINES = 20;
const MAX_CHARS = 300;

export interface ConsoleLines {
  /** 订阅提示行；订阅前到达的行先补发。返回退订函数 */
  subscribe(listener: (text: string) => void): () => void;
}

export function captureConsole(target: Console = console): {
  lines: ConsoleLines;
  restore(): void;
} {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 只保存原引用，restore 时原样放回
  const originals = METHODS.map((m) => [m, target[m]] as const);
  const pending: string[] = [];
  const seen = new Set<string>();
  let listener: ((text: string) => void) | undefined;
  const emit = (args: unknown[]): void => {
    const first = (format(...args).split("\n")[0] ?? "").trim();
    if (first === "" || seen.has(first) || seen.size >= MAX_LINES) return;
    seen.add(first);
    const text = first.length > MAX_CHARS ? `${first.slice(0, MAX_CHARS)}…` : first;
    if (listener !== undefined) listener(text);
    else pending.push(text);
  };
  for (const m of METHODS) {
    target[m] = (...args: unknown[]) => {
      emit(args);
    };
  }
  return {
    lines: {
      subscribe(next) {
        listener = next;
        for (const text of pending.splice(0)) next(text);
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    },
    restore() {
      for (const [m, fn] of originals) target[m] = fn;
    },
  };
}
