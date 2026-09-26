/**
 * 硬件光标（ADR-0020）：IME 预编辑与候选窗跟着硬件光标，不跟着绘制位置。
 *
 * Ink 的 useCursor 只在调用它的组件重渲染时生效：父组件在子组件之后提交会覆盖
 * 浮层输入框的坐标，别的子组件单独刷新（转圈等）的那一帧光标会被藏到帧底。
 * 所以光标不交给 Ink：各输入框登记坐标（claims），包装后的 stdout 在 Ink 每次写完后
 * 保存 Ink 的光标位置（DECSC）、移到登记坐标并显示；下次 Ink 写之前先恢复（DECRC），
 * Ink 的相对移动不受影响。帧从备用屏幕第 0 行开始（帧高 rows - 1），可用绝对坐标。
 */
import stringWidth from "string-width";

export interface CursorPoint {
  x: number;
  y: number;
}

/** 按显示宽度计算光标列，中文占 2 列；超出可视宽度时停在最后一个可见字符之后。 */
export function cursorColumn(prompt: string, textBefore: string, width: number): number {
  if (width <= 1) return 0;
  const limit = Math.max(0, width - 2);
  let used = 0;
  let out = "";
  const raw = `${prompt}${textBefore}`;
  for (const ch of raw) {
    const w = stringWidth(ch);
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return Math.min(limit, stringWidth(out));
}

/** 输入框登记表：同一时刻最多一个输入框有焦点；并存时后登记的优先。 */
export interface CursorClaims {
  set(id: symbol, point: CursorPoint | undefined): void;
  delete(id: symbol): void;
}

export const noopCursorClaims: CursorClaims = {
  set() {
    // 无 runTui 注入（测试）时不定位
  },
  delete() {
    // 同上
  },
};

const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const SHOW = "\x1b[?25h";
const HIDE = "\x1b[?25l";
const EXIT_ALT = "\x1b[?1049l";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

const moveTo = (p: CursorPoint): string => `\x1b[${p.y + 1};${p.x + 1}H`;

/**
 * 包装 Ink 的 stdout：其余属性与事件原样转发，只改写 write。
 * 退出备用屏幕（`?1049l`）后停止干预，主屏上的输出保持原样。
 */
export function createCursorStream(stdout: NodeJS.WriteStream): {
  stream: NodeJS.WriteStream;
  claims: CursorClaims;
} {
  const entries = new Map<symbol, { point: CursorPoint; seq: number }>();
  let seq = 0;
  let target: CursorPoint | undefined;
  /** 光标已离开 Ink 的位置（已 SAVE）。 */
  let moved = false;
  let done = false;
  const raw = (data: string): boolean => stdout.write(data);

  const place = (): string => {
    if (target === undefined) return "";
    const head = moved ? HIDE : SAVE;
    moved = true;
    return head + moveTo(target) + SHOW;
  };

  const retarget = (): void => {
    let best: { point: CursorPoint; seq: number } | undefined;
    for (const e of entries.values()) if (best === undefined || e.seq > best.seq) best = e;
    const next = best?.point;
    if (next?.x === target?.x && next?.y === target?.y) return;
    target = next;
    if (done) return;
    if (target === undefined) {
      if (moved) raw(HIDE + RESTORE);
      moved = false;
    } else {
      raw(place());
    }
  };

  const claims: CursorClaims = {
    set(id, point) {
      if (point === undefined) {
        if (!entries.delete(id)) return;
      } else {
        const prev = entries.get(id);
        if (prev?.point.x === point.x && prev.point.y === point.y) return;
        entries.set(id, { point, seq: prev?.seq ?? ++seq });
      }
      retarget();
    },
    delete(id) {
      if (entries.delete(id)) retarget();
    },
  };

  const write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : undefined;
    // 同步输出的起止标记不移动光标，原样放行
    if (done || text === undefined || text === SYNC_BEGIN || text === SYNC_END) {
      return (stdout.write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }
    let out = moved ? HIDE + RESTORE + text : text;
    moved = false;
    if (text.includes(EXIT_ALT)) done = true;
    else out += place();
    return (stdout.write as (...a: unknown[]) => boolean)(out, ...rest);
  };

  const stream = new Proxy(stdout, {
    get(t, prop) {
      if (prop === "write") return write;
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
  return { stream, claims };
}
