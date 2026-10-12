/**
 * stdin 预处理与包装（ADR-0021 第 1 条、ADR-0056 §3）：全屏模式开启
 * `?1000h`（按下/松开）+ `?1002h`（按住拖动）+ `?1006h`（SGR 编码），
 * 全屏与 `--inline` 都开启 `?1004h`（焦点报告）。终端把这些序列混在
 * stdin 按键流里回送——鼠标 `ESC [ < b ; x ; y M`（按下/拖动/滚轮）与
 * `ESC [ < b ; x ; y m`（松开），焦点 `ESC [ I`（聚焦）与 `ESC [ O`（失焦）。
 * 这些字节必须在进入 Ink 之前摘除——漏过去会被当成按键写进输入框。
 *
 * 序列可能跨数据块截断（`ESC[<0;` | `35;2M`）。解析器把可能是 SGR 鼠标
 * 或焦点回送前缀的尾巴缓存起来等下一块拼接；只含 ESC / ESC[ 的歧义尾巴
 * 按短定时器放行（Esc 键本身也是单独的 ESC，不能无限挂起）。
 */
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

/** 焦点报告（ADR-0056 §3）：终端聚焦时回送 CSI I、失焦回送 CSI O。 */
export const FOCUS_ENABLE = "\x1b[?1004h";
export const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

/** 坐标为 SGR 原始值：1 基（x=列、y=行）。button：0 左、1 中、2 右。 */
export type MouseEvent =
  | { type: "press"; button: number; x: number; y: number }
  | { type: "release"; button: number; x: number; y: number }
  | { type: "drag"; button: number; x: number; y: number }
  | { type: "wheel"; dir: "up" | "down"; x: number; y: number };

const SGR_PREFIX = "\x1b[<";
const SGR_FULL = /^\x1b\[<([0-9]+);([0-9]+);([0-9]+)([Mm])/;
/** 一条 SGR 鼠标序列的严格前缀（到末尾为止只能是前缀字符：数字与分号） */
const SGR_PARTIAL = /^\x1b\[<[0-9;]*$/;

const AMBIGUOUS_FLUSH_MS = 25;
const CSI_FLUSH_MS = 250;

function decodeButton(b: number, release: boolean): MouseEvent | undefined {
  if (b & 64) {
    // 64/65 滚轮上下；66/67 横向滚轮本版不处理
    if ((b & 3) > 1) return undefined;
    return { type: "wheel", dir: b & 1 ? "down" : "up", x: 0, y: 0 };
  }
  if (release) return { type: "release", button: b & 3, x: 0, y: 0 };
  if (b & 32) {
    if ((b & 3) === 3) return undefined; // 无按键移动（1003），未开启
    return { type: "drag", button: b & 3, x: 0, y: 0 };
  }
  if ((b & 3) === 3) return undefined;
  return { type: "press", button: b & 3, x: 0, y: 0 };
}

export interface MouseParserHandlers {
  onEvent: (ev: MouseEvent) => void;
  /** 焦点回送 CSI I / CSI O：true 聚焦、false 失焦 */
  onFocus: (focused: boolean) => void;
  /** 歧义尾巴（裸 ESC / ESC[）到时限仍拼不成序列 → 当普通输入放行 */
  onFlushText: (text: string) => void;
}

/**
 * SGR 鼠标与焦点回送摘除器。feed 返回应交给 Ink 的按键字节（已去掉这些
 * 序列）；未决尾巴保留在内部。歧义尾巴超时经 onFlushText 放行。
 */
export function createMouseParser(handlers: MouseParserHandlers): {
  feed: (text: string) => string;
  flushPending: () => string;
  dispose: () => void;
} {
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
  };

  const flushPending = (): string => {
    clearTimer();
    const out = pending;
    pending = "";
    return out;
  };

  const feed = (chunk: string): string => {
    const buf = pending + chunk;
    pending = "";
    clearTimer();
    let out = "";
    let i = 0;
    while (i < buf.length) {
      const esc = buf.indexOf("\x1b", i);
      if (esc < 0) {
        out += buf.slice(i);
        break;
      }
      out += buf.slice(i, esc);
      const rest = buf.slice(esc);
      if (rest === "\x1b" || rest === "\x1b[") {
        // 尾巴是 "\x1b" 或 "\x1b["：可能是鼠标/焦点/其他 CSI 序列被截断，
        // 也可能是单独的 Esc 键——挂起但设短时限放行
        pending = rest;
        flushTimer = setTimeout(
          () => {
            flushTimer = undefined;
            const text = flushPending();
            if (text !== "") handlers.onFlushText(text);
          },
          rest === "\x1b[" ? CSI_FLUSH_MS : AMBIGUOUS_FLUSH_MS,
        );
        return out;
      }
      // 焦点回送（CSI I / CSI O）长度与鼠标前缀相同，且同样可能被截断；
      // 必须在「非鼠标转义原样放行」之前摘除，否则 ESC 会漏成按键
      if (rest.startsWith(FOCUS_IN)) {
        handlers.onFocus(true);
        i = esc + FOCUS_IN.length;
        continue;
      }
      if (rest.startsWith(FOCUS_OUT)) {
        handlers.onFocus(false);
        i = esc + FOCUS_OUT.length;
        continue;
      }
      if (!rest.startsWith(SGR_PREFIX)) {
        // 非鼠标转义（方向键、粘贴括号等）：ESC 原样放行，后续字符正常扫描
        out += "\x1b";
        i = esc + 1;
        continue;
      }
      const m = SGR_FULL.exec(rest);
      if (m !== null) {
        const b = Number(m[1]);
        const ev = decodeButton(b, m[4] === "m");
        if (ev !== undefined) {
          ev.x = Number(m[2]);
          ev.y = Number(m[3]);
          handlers.onEvent(ev);
        }
        i = esc + m[0].length;
        continue;
      }
      if (SGR_PARTIAL.test(rest)) {
        // 序列在数据块边界被截断：`\x1b[<` 只会是鼠标上报，无限期等续块
        pending = rest;
        return out;
      }
      // `\x1b[<` 后紧跟非法字节：不是鼠标序列，原样放行
      out += "\x1b";
      i = esc + 1;
    }
    return out;
  };

  return {
    feed,
    flushPending,
    dispose: clearTimer,
  };
}

export interface MouseSource {
  subscribe: (fn: (ev: MouseEvent) => void) => () => void;
}

/** 终端焦点态（ADR-0056 §3）：来自 CSI I / CSI O 回送。 */
export interface FocusSource {
  /** 终端当前是否聚焦；从未收到过回送时 false（按「没在看」处理）。 */
  focused: () => boolean;
}

/**
 * 包装真实 stdin：我们自己以 flowing 模式读真实流，摘掉鼠标序列与焦点
 * 回送后把按键字节推进 PassThrough 交给 Ink。Ink 需要的 TTY 接口（isTTY、
 * setRawMode、ref/unref）经代理转发回真实流；read(0)（Windows 控制台读
 * 请求兜底）也转发真实流，无参 read() 落到 PassThrough。
 */
export function wrapMouseStdin(real: NodeJS.ReadStream): {
  stdin: NodeJS.ReadStream;
  mouse: MouseSource;
  focus: FocusSource;
  dispose: () => void;
} {
  const inner = new PassThrough();
  const listeners = new Set<(ev: MouseEvent) => void>();
  let focused = false;
  const dec = new StringDecoder("utf8");
  real.setEncoding("utf8");

  const parser = createMouseParser({
    onEvent: (ev) => {
      for (const fn of listeners) fn(ev);
    },
    onFocus: (value) => {
      focused = value;
    },
    onFlushText: (text) => {
      inner.write(text);
    },
  });

  const onData = (chunk: string | Uint8Array): void => {
    const text = typeof chunk === "string" ? chunk : dec.write(chunk);
    const clean = parser.feed(text);
    if (clean !== "") inner.write(clean);
  };
  const onEnd = (): void => {
    inner.end();
  };
  real.on("data", onData);
  real.on("end", onEnd);

  const forward = new Set<PropertyKey>([
    "isTTY",
    "setRawMode",
    "ref",
    "unref",
    "fd",
    "isRaw",
    "bytesRead",
    "_handle",
  ]);
  const fake = new Proxy(inner, {
    get(t, prop) {
      if (forward.has(prop)) {
        const value: unknown = Reflect.get(real, prop, real);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            (value as (...a: unknown[]) => unknown).apply(real, args);
            return fake;
          };
        }
        return value;
      }
      if (prop === "read") {
        return (size?: number): unknown =>
          size === 0 ? (real.read(0) as unknown) : (t.read(size) as unknown);
      }
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });

  return {
    stdin: fake as unknown as NodeJS.ReadStream,
    mouse: {
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    focus: {
      focused: () => focused,
    },
    dispose() {
      real.off("data", onData);
      real.off("end", onEnd);
      parser.dispose();
      inner.destroy();
    },
  };
}
