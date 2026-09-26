/**
 * 快捷键识别。Alt+M 在 Windows Terminal 上是一条 `\x1bm`（Ink 标成 meta）。
 * conhost 可能把 Alt 拆成 Esc 再跟一个字母：不识别为切换，但吞掉该字母，
 * 避免写进输入框或触发其他操作。
 */
export interface KeyFlags {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  escape: boolean;
  tab: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  upArrow: boolean;
  downArrow: boolean;
}

const SWALLOW_MS = 80;

export function isAltM(input: string, key: KeyFlags): boolean {
  return key.meta && !key.ctrl && (input === "m" || input === "M");
}

/** 记录一次单独的 Esc，供下一次字母事件吞掉。 */
export function noteBareEscape(now: number): number {
  return now + SWALLOW_MS;
}

/**
 * 拆开的 Esc+字母：在窗口内到达的单个字母应被吞掉。
 * 返回是否吞掉；吞掉后调用方应清掉截止时间。
 */
export function shouldSwallowAfterEscape(
  input: string,
  key: KeyFlags,
  swallowUntil: number,
  now: number,
): boolean {
  if (now > swallowUntil) return false;
  if (key.meta || key.ctrl || key.escape) return false;
  return input.length === 1 && /[a-zA-Z]/.test(input);
}
