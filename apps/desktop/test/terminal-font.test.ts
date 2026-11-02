/**
 * 终端字体跟随设置 › 外观：初始取计算后的 --fs-2 与 --mono；设置变化（根元素行内样式）时
 * 立即更新已打开的终端并重算行列。xterm 与 fit 插件换成记录调用的假对象。
 */
import { afterEach, expect, it, vi } from "vitest";

const fits = vi.fn();
const terminals: { options: Record<string, unknown> }[] = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "6" };
    modes = { mouseTrackingMode: "none" };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminals.push(this);
    }
    loadAddon = vi.fn();
    open = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData() {
      return { dispose: vi.fn() };
    }
    onResize() {
      return { dispose: vi.fn() };
    }
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fits();
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    activate = vi.fn();
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList;
}

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("style");
  terminals.length = 0;
  fits.mockClear();
});

it("初始字号与字体取计算后的 --fs-2 / --mono，设置变化后立即更新并重算行列", async () => {
  const { mountTerminal } = await import("../src/terminal-view");
  root.style.setProperty("--fs-2", "13px");
  root.style.setProperty("--mono", '"JetBrains Mono", monospace');
  const parent = document.createElement("div");
  Object.defineProperty(parent, "clientWidth", { value: 600 });
  Object.defineProperty(parent, "clientHeight", { value: 300 });
  document.body.appendChild(parent);
  const mounted = mountTerminal(parent, {
    onData: () => undefined,
    onResize: () => undefined,
    onCopy: () => undefined,
  });
  const term = terminals[0];
  expect(term?.options.fontSize).toBe(13);
  expect(term?.options.fontFamily).toBe('"JetBrains Mono", monospace');

  fits.mockClear();
  // 设置页把字号调到 20、代码字体换成 Fira Code（appearance.ts 写的就是这几个变量）
  root.style.setProperty("--fs-2", "19px");
  root.style.setProperty("--mono", '"Fira Code", "JetBrains Mono", monospace');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(term?.options.fontSize).toBe(19);
  expect(term?.options.fontFamily).toBe('"Fira Code", "JetBrains Mono", monospace');
  expect(fits).toHaveBeenCalled();

  // 和字体无关的行内样式变化不重排
  fits.mockClear();
  root.style.setProperty("--unrelated", "1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fits).not.toHaveBeenCalled();
  mounted.dispose();
  parent.remove();
});
