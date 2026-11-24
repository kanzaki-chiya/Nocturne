// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INLINE_PAGE_THEMES } from "@nocturne/core/protocol";

interface JsdomInstance {
  window: Window & typeof globalThis & { close(): void };
}
type JsdomCtor = new (
  html: string,
  options?: {
    url?: string;
    runScripts?: "dangerously" | "outside-only";
    beforeParse?: (win: Window & typeof globalThis) => void;
  },
) => JsdomInstance;

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: JsdomCtor };

const SANDBOX_PATH = path.resolve(import.meta.dirname, "../public-web/sandbox.html");
const SANDBOX_HTML = readFileSync(SANDBOX_PATH, "utf8");

interface Harness {
  dom: JsdomInstance;
  window: Window & typeof globalThis;
  document: Document;
  posted: Record<string, unknown>[];
  sendFromParent(data: Record<string, unknown>): void;
  renderPage(html: string, id?: string, fullscreen?: boolean): void;
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function createSandboxHarness(): Harness {
  const posted: Record<string, unknown>[] = [];
  const fakeParent = {
    postMessage(msg: Record<string, unknown>) {
      posted.push(msg);
    },
  };
  const dom = new JSDOM(SANDBOX_HTML, {
    url: "https://sandbox.local/sandbox.html",
    runScripts: "dangerously",
    beforeParse(win) {
      Object.defineProperty(win, "parent", { value: fakeParent, configurable: true });
      Object.defineProperty(win, "requestAnimationFrame", {
        value: (cb: FrameRequestCallback) => {
          cb(0);
          return 1;
        },
        configurable: true,
      });
    },
  });
  const win = dom.window as unknown as Window & typeof globalThis;

  function sendFromParent(data: Record<string, unknown>) {
    const ev = new win.MessageEvent("message", {
      data,
      source: fakeParent as unknown as MessageEventSource,
    });
    win.dispatchEvent(ev);
  }

  function renderPage(html: string, id = "inst-1", fullscreen = true) {
    sendFromParent({
      type: "nocturne:inline-html:render",
      id,
      html,
      fullscreen,
    });
  }

  return { dom, window: win, document: win.document, posted, sendFromParent, renderPage };
}

describe("sandbox.html 评论层（ADR-0113）", () => {
  it("非评论模式下点击页面元素不拦截，原有事件照常触发", () => {
    const h = createSandboxHarness();
    h.renderPage(`<!doctype html><html><body><button id="btn">点我</button></body></html>`);
    const btn = must(h.document.getElementById("btn"), "#btn");
    const clicked = vi.fn();
    btn.addEventListener("click", clicked);

    btn.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(h.posted.some((m) => m.type === "nocturne:inline-html:comment-pick")).toBe(false);
    h.dom.window.close();
  });

  it("评论模式下拦截点击并返回 path（优先 id、其次 nth-of-type）、text（截断 200）与文档坐标", () => {
    const h = createSandboxHarness();
    const longText = "一二三四五六七八九十".repeat(25); // 250 字符
    h.renderPage(
      `<!doctype html><html><body>
        <div id="dg-c">
          <div class="sec"><p>首段</p></div>
          <div class="sec">
            <button id="action-btn">执行</button>
            <div class="card"><span>第一块</span></div>
            <div class="card"><span>${longText}</span></div>
          </div>
        </div>
      </body></html>`,
    );
    const btn = must(h.document.getElementById("action-btn"), "#action-btn");
    const btnClicked = vi.fn();
    btn.addEventListener("click", btnClicked);

    h.sendFromParent({ type: "nocturne:inline-html:comment-mode", id: "inst-1", enabled: true });

    // 1. 点击带 id 的按钮：原有 click 被拦截，path 用 #id
    btn.dispatchEvent(
      new h.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 85,
      }),
    );
    expect(btnClicked).not.toHaveBeenCalled();

    // 2. 点击无 id 的第二个 .card：path 用 nth-of-type，文字截断 200 字符
    const cards = h.document.querySelectorAll(".card");
    Object.defineProperty(h.window, "scrollX", { value: 10, configurable: true });
    Object.defineProperty(h.window, "scrollY", { value: 40, configurable: true });
    must(cards[1], "second card").dispatchEvent(
      new h.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 150,
      }),
    );

    const picks = h.posted.filter((m) => m.type === "nocturne:inline-html:comment-pick");
    expect(picks).toHaveLength(2);
    expect(picks[0]).toMatchObject({
      id: "inst-1",
      path: "body > #dg-c > div:nth-of-type(2) > #action-btn",
      text: "执行",
      x: 120,
      y: 85,
      hasVisibleText: true,
    });
    expect(picks[1]).toMatchObject({
      id: "inst-1",
      path: "body > #dg-c > div:nth-of-type(2) > div:nth-of-type(2)",
      x: 210,
      y: 190,
      hasVisibleText: true,
    });
    expect(String(picks[1]?.text)).toHaveLength(200);
    expect(h.document.querySelector(String(picks[1]?.path))).toBe(cards[1]);
    h.dom.window.close();
  });

  it("选中文字后点击时锚到选中原文", () => {
    const h = createSandboxHarness();
    h.renderPage(
      `<!doctype html><html><body><p id="para">这是一段包含关键术语的长说明文字</p></body></html>`,
    );
    h.sendFromParent({ type: "nocturne:inline-html:comment-mode", id: "inst-1", enabled: true });

    const para = must(h.document.getElementById("para"), "#para");
    const textNode = must(para.firstChild, "textNode");
    const range = h.document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);
    const sel = must(h.window.getSelection(), "selection");
    sel.removeAllRanges();
    sel.addRange(range);

    para.dispatchEvent(
      new h.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 60,
        clientY: 30,
      }),
    );

    const pick = h.posted.find((m) => m.type === "nocturne:inline-html:comment-pick");
    expect(pick).toMatchObject({
      path: "body > #para",
      text: "关键术语",
      hasVisibleText: true,
    });
    h.dom.window.close();
  });

  it("无可见文字的 canvas / img / svg 图形返回空文字和 hasVisibleText: false", () => {
    const h = createSandboxHarness();
    h.renderPage(
      `<!doctype html><html><body>
        <canvas id="cv" width="100" height="100"></canvas>
        <img id="pic" alt="不应作为可见文字" />
        <svg id="g"><rect id="r1" width="50" height="50"></rect><text id="t1">节点A</text></svg>
      </body></html>`,
    );
    h.sendFromParent({ type: "nocturne:inline-html:comment-mode", id: "inst-1", enabled: true });

    for (const id of ["cv", "pic", "r1", "t1"]) {
      must(h.document.getElementById(id), `#${id}`).dispatchEvent(
        new h.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: 25,
          clientY: 25,
        }),
      );
    }

    const picks = h.posted.filter((m) => m.type === "nocturne:inline-html:comment-pick");
    expect(picks).toHaveLength(4);
    expect(picks[0]).toMatchObject({ path: "body > #cv", text: "", hasVisibleText: false });
    expect(picks[1]).toMatchObject({ path: "body > #pic", text: "", hasVisibleText: false });
    expect(picks[2]).toMatchObject({
      path: "body > #g > #r1",
      text: "",
      hasVisibleText: false,
    });
    expect(picks[3]).toMatchObject({
      path: "body > #g > #t1",
      text: "节点A",
      hasVisibleText: true,
    });
    h.dom.window.close();
  });

  it("新版本圆点按路径、可见文字、原坐标依次定位", () => {
    const h = createSandboxHarness();
    h.renderPage('<p id="moved">改过的文字</p><p id="replacement">保留的原文</p>');
    for (const [id, left, top] of [
      ["moved", 30, 40],
      ["replacement", 130, 140],
    ] as const) {
      const target = must(h.document.getElementById(id), id);
      const rect = new h.window.DOMRect(left, top, 40, 20);
      vi.spyOn(target, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect);
    }
    h.sendFromParent({
      type: "nocturne:inline-html:comment-pins",
      id: "inst-1",
      pins: [
        { id: "c1", number: 1, path: "#moved", text: "保留的原文", x: 1, y: 2, relocate: true },
        { id: "c2", number: 2, path: "#old", text: "保留的原文", x: 3, y: 4, relocate: true },
        { id: "c3", number: 3, path: "[", text: "缺失的原文", x: 5, y: 6, relocate: true },
        { id: "c4", number: 4, path: "#moved", text: "保留的原文", x: 7, y: 8 },
      ],
    });
    expect(
      Array.from(h.document.querySelectorAll<HTMLElement>(".nct-comment-pin"), (pin) => [
        pin.style.left,
        pin.style.top,
      ]),
    ).toEqual([
      ["50px", "40px"],
      ["150px", "140px"],
      ["5px", "6px"],
      ["7px", "8px"],
    ]);
    h.dom.window.close();
  });

  it("两份沙箱空壳完全一致", () => {
    expect(
      readFileSync(path.resolve(import.meta.dirname, "../../relay/public/sandbox.html"), "utf8"),
    ).toBe(SANDBOX_HTML);
  });

  it("圆点绘制、可点选、不进入截图序列化 DOM", async () => {
    const h = createSandboxHarness();
    h.renderPage(`<!doctype html><html><body><div id="box">内容</div></body></html>`);
    const bodyClicked = vi.fn();
    h.document.body.addEventListener("click", bodyClicked);

    h.sendFromParent({
      type: "nocturne:inline-html:comment-pins",
      id: "inst-1",
      pins: [
        { id: "c1", number: 1, x: 50, y: 80 },
        { id: "c2", number: 2, x: 120, y: 160, active: true },
      ],
    });

    const pins = h.document.querySelectorAll(".nct-comment-pin");
    expect(pins).toHaveLength(2);
    expect(pins[0]?.textContent).toBe("1");
    expect(pins[1]?.getAttribute("data-active")).toBe("true");
    // 圆点挂在 html 下而不是 body 下，不干扰 body 内元素路径
    expect(h.document.body.querySelector(".nct-comment-pin")).toBeNull();

    // 点击圆点回传 pin-click 且不冒泡到底层页面
    must(pins[0], "first pin").dispatchEvent(
      new h.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(bodyClicked).not.toHaveBeenCalled();
    expect(h.posted).toContainEqual(
      expect.objectContaining({
        type: "nocturne:inline-html:comment-pin-click",
        id: "inst-1",
        pinId: "c1",
      }),
    );

    // 验证截图路径克隆出的序列化 SVG 不含评论圆点、样式或 data-nct-comment-mode
    let capturedSvg = "";
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(url: string) {
        if (url.startsWith("data:image/svg+xml;base64,")) {
          capturedSvg = Buffer.from(
            url.slice("data:image/svg+xml;base64,".length),
            "base64",
          ).toString("utf8");
        }
        queueMicrotask(() => this.onerror?.());
      }
    }
    Object.defineProperty(h.window, "Image", { value: FakeImage, configurable: true });
    h.sendFromParent({ type: "nocturne:inline-html:comment-mode", id: "inst-1", enabled: true });
    h.sendFromParent({
      type: "nocturne:inline-html:capture",
      id: "inst-1",
      requestId: "cap-1",
      region: { x: 10, y: 20, width: 240, height: 240 },
    });

    await vi.waitFor(() => {
      expect(capturedSvg).toContain("内容");
    });
    expect(capturedSvg).not.toContain("nct-comment-pin");
    expect(capturedSvg).not.toContain("__nct_comment_layer__");
    expect(capturedSvg).not.toContain("data-nct-comment-mode");
    expect(capturedSvg).toContain('viewBox="');
    h.dom.window.close();
  });
});

function dispatchTouch(
  win: Window & typeof globalThis,
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: readonly { clientX: number; clientY: number }[],
): Event {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", { value: points, configurable: true });
  target.dispatchEvent(ev);
  return ev;
}

describe("sandbox.html 全屏双指缩放", () => {
  it("全屏模式下双指外扩缩放页面并在缩回 1x 时清理样式与属性", () => {
    const h = createSandboxHarness();
    h.renderPage(
      `<!doctype html><html><body><div id="box">内容</div></body></html>`,
      "inst-z",
      true,
    );

    const start = dispatchTouch(h.window, h.document, "touchstart", [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ]);
    expect(start.defaultPrevented).toBe(true);

    // 间距由 100 扩到 200 -> 2x
    const move = dispatchTouch(h.window, h.document, "touchmove", [
      { clientX: 50, clientY: 200 },
      { clientX: 250, clientY: 200 },
    ]);
    expect(move.defaultPrevented).toBe(true);
    expect(h.document.body.style.transform).toBe("scale(2)");
    expect(h.document.body.style.transformOrigin).toBe("0 0");
    expect(h.document.documentElement.getAttribute("data-nct-zoomed")).toBe("true");

    // 上限夹紧到 4x
    dispatchTouch(h.window, h.document, "touchmove", [
      { clientX: 0, clientY: 200 },
      { clientX: 600, clientY: 200 },
    ]);
    expect(h.document.body.style.transform).toBe("scale(4)");

    // 缩回接近 1x 时自动归位并移除属性
    dispatchTouch(h.window, h.document, "touchmove", [
      { clientX: 100, clientY: 200 },
      { clientX: 201, clientY: 200 },
    ]);
    expect(h.document.body.style.transform).toBe("");
    expect(h.document.documentElement.hasAttribute("data-nct-zoomed")).toBe(false);

    dispatchTouch(h.window, h.document, "touchend", []);
    h.dom.window.close();
  });

  it("非全屏内嵌卡片忽略双指缩放", () => {
    const h = createSandboxHarness();
    h.renderPage(
      `<!doctype html><html><body><div id="box">卡片</div></body></html>`,
      "inst-inline",
      false,
    );

    const start = dispatchTouch(h.window, h.document, "touchstart", [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ]);
    dispatchTouch(h.window, h.document, "touchmove", [
      { clientX: 50, clientY: 200 },
      { clientX: 250, clientY: 200 },
    ]);
    expect(start.defaultPrevented).toBe(false);
    expect(h.document.body.style.transform).toBe("");
    expect(h.document.documentElement.hasAttribute("data-nct-zoomed")).toBe(false);
    h.dom.window.close();
  });

  it("进入评论模式时重置双指缩放", () => {
    const h = createSandboxHarness();
    h.renderPage(
      `<!doctype html><html><body><div id="box">内容</div></body></html>`,
      "inst-c",
      true,
    );

    dispatchTouch(h.window, h.document, "touchstart", [
      { clientX: 100, clientY: 200 },
      { clientX: 200, clientY: 200 },
    ]);
    dispatchTouch(h.window, h.document, "touchmove", [
      { clientX: 50, clientY: 200 },
      { clientX: 250, clientY: 200 },
    ]);
    expect(h.document.body.style.transform).toBe("scale(2)");

    h.sendFromParent({ type: "nocturne:inline-html:comment-mode", id: "inst-c", enabled: true });
    expect(h.document.body.style.transform).toBe("");
    expect(h.document.documentElement.hasAttribute("data-nct-zoomed")).toBe(false);
    h.dom.window.close();
  });
});

describe("sandbox.html 深浅色与旧页面兼容层（ADR-0088 修订）", () => {
  it("render 与 theme 消息设置/热更新 data-theme，忽略宿主自定义颜色且与 protocol 常量一致", () => {
    const h = createSandboxHarness();
    h.sendFromParent({
      type: "nocturne:inline-html:render",
      id: "inst-theme",
      html: '<!doctype html><html data-theme="light"><body><p>x</p></body></html>',
      colorScheme: "dark",
      fontSize: "15px",
      theme: { "--bg": "#ff0000" },
      fullscreen: false,
    });

    expect(h.document.documentElement.getAttribute("data-theme")).toBe("dark");
    const themeEl = must(h.document.getElementById("__nct_theme__"), "__nct_theme__");
    expect(themeEl.textContent).toContain(":where(:root) {");
    expect(themeEl.textContent).toContain("color-scheme: dark;");
    expect(themeEl.textContent).toContain("--nct-fs: 15px;");
    expect(themeEl.textContent).not.toContain("#ff0000");
    for (const [k, v] of Object.entries(INLINE_PAGE_THEMES.dark)) {
      expect(themeEl.textContent, `dark ${k}`).toContain(`${k}: ${v};`);
    }

    h.sendFromParent({
      type: "nocturne:inline-html:theme",
      colorScheme: "light",
      fontSize: "16px",
      theme: { "--bg": "#00ff00" },
    });

    expect(h.document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(themeEl.textContent).toContain("color-scheme: light;");
    expect(themeEl.textContent).toContain("--nct-fs: 16px;");
    expect(themeEl.textContent).not.toContain("#00ff00");
    for (const [k, v] of Object.entries(INLINE_PAGE_THEMES.light)) {
      expect(themeEl.textContent, `light ${k}`).toContain(`${k}: ${v};`);
    }
    h.dom.window.close();
  });
});
