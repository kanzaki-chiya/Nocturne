/**
 * 硬件光标（ADR-0020/0021）：IME 预编辑与候选窗跟着硬件光标，不跟着绘制位置。
 *
 * Ink 的 useCursor 只在调用它的组件重渲染时生效：父组件在子组件之后提交会覆盖
 * 浮层输入框的坐标，别的子组件单独刷新（转圈等）的那一帧光标会被藏到帧底。
 * 所以光标不交给 Ink：各输入框登记坐标（claims），包装后的 stdout 在 Ink 每次
 * 写完后保存 Ink 的光标位置（DECSC）、移到登记坐标并显示；下次 Ink 写之前先恢复
 *（DECRC），Ink 的相对移动不受影响。
 *
 * 坐标是"相对 Ink 写入终点"（ADR-0021）：非全屏（普通屏幕 + <Static>）时 Ink
 * 在输出末尾补一个换行，写完后光标停在活动区最后一行的下一行第 0 列。登记的
 * y 是"活动区目标行相对该终点的行差"（≤0），x 是列。补位序列是
 * `ESC[<|y|>A`（上移）+ `ESC[<x+1>G`（列定位，1 基）。目标即终点时只写列定位。
 * 整页界面（模型页/服务商页）在备用屏幕内沿用同一约定——页面对该次输出同样
 * 从活动区第 0 行算起。
 */
import stringWidth from "string-width";

export interface CursorPoint {
  x: number;
  /** 相对活动区最后一行下一行（Ink 写入终点）的行差，≤0 */
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
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** 相对 Ink 写入终点移动：dy≤0 上移 |dy| 行，x 是 0 基列（CUP 列号 = x+1）。 */
const moveRel = (p: CursorPoint): string => {
  const up = p.y < 0 ? `\x1b[${-p.y}A` : "";
  return `${up}\x1b[${p.x + 1}G`;
};

/**
 * 包装 Ink 的 stdout：其余属性与事件原样转发，只改写 write。
 * `?1049h`/`?1049l` 进出备用屏时 Ink 的"写入终点"语义不变（补位仍按
 * 同一约定）；进程退出（unmount 终帧）后不再干预。
 */
export function createCursorStream(stdout: NodeJS.WriteStream): {
  stream: NodeJS.WriteStream;
  claims: CursorClaims;
  stop(): void;
} {
  const entries = new Map<symbol, { point: CursorPoint; seq: number }>();
  let seq = 0;
  let target: CursorPoint | undefined;
  /** 光标已离开 Ink 的位置（已 SAVE）。 */
  let moved = false;
  let done = false;
  let changingScreen = false;
  const raw = (data: string): boolean => stdout.write(data);

  const place = (): string => {
    if (target === undefined) return "";
    // moved 时光标停在旧目标处：先 DECRC 回到 Ink 写入终点（保存位仍有效，
    // 不必再 DECSC），再从终点做相对移动——直接 moveRel 会从旧目标再动一次。
    const head = moved ? HIDE + RESTORE : SAVE;
    moved = true;
    return head + moveRel(target) + SHOW;
  };

  const retarget = (): void => {
    let best: { point: CursorPoint; seq: number } | undefined;
    for (const e of entries.values()) if (best === undefined || e.seq > best.seq) best = e;
    const next = best?.point;
    if (next?.x === target?.x && next?.y === target?.y) return;
    target = next;
    if (done || changingScreen) return;
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
    if (text.includes("\x1b[?1049h") || text.includes("\x1b[?1049l")) {
      const out = (moved ? HIDE + RESTORE : "") + text;
      moved = false;
      changingScreen = true;
      return (stdout.write as (...a: unknown[]) => boolean)(out, ...rest);
    }
    changingScreen = false;
    let out = moved ? HIDE + RESTORE + text : text;
    moved = false;
    out += place();
    return (stdout.write as (...a: unknown[]) => boolean)(out, ...rest);
  };

  const stream = new Proxy(stdout, {
    get(t, prop) {
      if (prop === "write") return write;
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
  return {
    stream,
    claims,
    stop() {
      done = true;
      if (moved) raw(HIDE + RESTORE);
      moved = false;
    },
  };
}

/** 粘贴/输入文本统一用 \n 换行（Windows Terminal 粘贴时换行是 \r） */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 单行输入框的可见窗口：换行显示为 mark，按显示宽度水平滚动，保证光标可见。
 * before 就是硬件光标前的可见文字，InputCursor 与 Composer 共用，二者不会错位。
 */
export function inputWindow(
  prompt: string,
  value: string,
  cursor: number,
  width: number,
  mark: string,
): { before: string; at: string | undefined; after: string } {
  const show = (s: string): string => s.replace(/\n/g, mark);
  const limit = Math.max(1, width - 2 - stringWidth(prompt));
  const lead = "...";
  let before = show(value.slice(0, cursor));
  // 光标自身占 1 列
  if (stringWidth(before) + 1 > limit) {
    const chars = Array.from(new Intl.Segmenter().segment(before), (g) => g.segment);
    let used = stringWidth(lead) + 1;
    let start = chars.length;
    while (start > 0) {
      const w = stringWidth(chars[start - 1] ?? "");
      if (used + w > limit) break;
      used += w;
      start--;
    }
    before = lead + chars.slice(start).join("");
  }
  const rawAt = value[cursor];
  const at = rawAt === undefined ? undefined : show(rawAt);
  const room = limit - stringWidth(before) - (at === undefined ? 1 : stringWidth(at));
  let after = "";
  let used = 0;
  for (const ch of show(value.slice(cursor + 1))) {
    const w = stringWidth(ch);
    if (used + w > room) break;
    after += ch;
    used += w;
  }
  return { before, at, after };
}

/** 多行输入的可见窗口与硬件光标共用此结果。 */
export function composerWindow(
  prompt: string,
  value: string,
  cursor: number,
  width: number,
  height: number,
): {
  rows: {
    prefix: string;
    before: string;
    at: string | undefined;
    after: string;
    focused: boolean;
  }[];
  cursorRow: number;
  cursorBefore: string;
} {
  const lines = value.split("\n");
  const lineIndex = value.slice(0, cursor).split("\n").length - 1;
  const column = cursor - (value.lastIndexOf("\n", cursor - 1) + 1);
  const count = Math.max(1, Math.min(height, lines.length));
  const start = Math.min(Math.max(0, lineIndex - count + 1), lines.length - count);
  const rows = lines.slice(start, start + count).map((line, index) => {
    const focused = start + index === lineIndex;
    const prefix = start + index === 0 ? prompt : " ".repeat(stringWidth(prompt));
    const view = inputWindow(prefix, line, focused ? column : 0, width, "");
    return { prefix, ...view, focused };
  });
  return {
    rows,
    cursorRow: lineIndex - start,
    cursorBefore: rows[lineIndex - start]?.before ?? "",
  };
}

/** 垂直移动保留显示列；越界由输入框改为翻历史。 */
export function verticalCursor(
  value: string,
  cursor: number,
  direction: -1 | 1,
): number | undefined {
  const lines = value.split("\n");
  const lineIndex = value.slice(0, cursor).split("\n").length - 1;
  const target = lineIndex + direction;
  if (target < 0 || target >= lines.length) return undefined;
  const currentStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const wanted = stringWidth(value.slice(currentStart, cursor));
  const line = lines[target] ?? "";
  let column = 0;
  for (const ch of line) {
    if (stringWidth(line.slice(0, column + ch.length)) > wanted) break;
    column += ch.length;
  }
  let offset = 0;
  for (let i = 0; i < target; i++) offset += (lines[i] ?? "").length + 1;
  return offset + column;
}
