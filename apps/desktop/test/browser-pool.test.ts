/**
 * 面板浏览器的 webview 池（ADR-0060 第 5 节、desktop.md 5.10）：显示时才创建、隐藏、
 * 关闭时销毁、超出上限回收最久没显示的后台标签并在再显示时按最后的地址重建、
 * 网页事件转给面板（地址、标题、新窗口、快捷键）。
 */
import { describe, expect, it, vi } from "vitest";

import { BrowserPool, errorText, MAX_LIVE_BROWSERS } from "../src/browser-pool";
import type { BrowserBounds, BrowserHost, BrowserMessage } from "../src/host";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const box: BrowserBounds = { x: 10, y: 40, width: 400, height: 300 };

function fakeHost() {
  let next = 1;
  const pushes = new Map<number, (m: BrowserMessage) => void>();
  const log: string[] = [];
  const host: BrowserHost = {
    create: vi.fn(async (url: string, _bounds, onMessage) => {
      const id = next++;
      pushes.set(id, onMessage);
      log.push(`create ${id} ${url}`);
      return id;
    }),
    navigate: vi.fn(async (id: number, url: string) => {
      if (url.startsWith("javascript:")) {
        throw { code: "browser_unsupported", message: "不支持的地址" };
      }
      log.push(`navigate ${id} ${url}`);
    }),
    layout: vi.fn(async (id: number, bounds: BrowserBounds | null) => {
      log.push(`layout ${id} ${bounds === null ? "hide" : `${bounds.width}x${bounds.height}`}`);
    }),
    action: vi.fn(async (id: number, action: string) => {
      log.push(`action ${id} ${action}`);
    }),
    capture: vi.fn(async () => new Uint8Array([137, 80])),
    destroy: vi.fn(async (id: number) => {
      pushes.delete(id);
      log.push(`destroy ${id}`);
    }),
  };
  return { host, log, push: (id: number, m: BrowserMessage) => pushes.get(id)?.(m) };
}

function events() {
  return {
    onUrl: vi.fn(),
    onTitle: vi.fn(),
    onNewWindow: vi.fn(),
    onShortcut: vi.fn(),
  };
}

describe("浏览器池", () => {
  it("登记不建 webview；显示时按地址创建再放到位置；隐藏、销毁按顺序发给外壳", async () => {
    const { host, log } = fakeHost();
    const pool = new BrowserPool(host, events());
    pool.register("a", "https://example.com/");
    await flush();
    expect(host.create).not.toHaveBeenCalled();
    pool.show("a", box);
    pool.show("a", { ...box, width: 420 });
    await flush();
    pool.hide("a");
    pool.destroy("a");
    await flush();
    // 连续两次布局只发最后一次
    expect(log).toEqual([
      "create 1 https://example.com/",
      "layout 1 420x300",
      "layout 1 hide",
      "destroy 1",
    ]);
    expect(pool.status("a")).toBeUndefined();
  });

  it("hideShown：藏起显示中的网页，等外壳处理完才返回；外壳卡住时最多等到超时", async () => {
    const { host, log } = fakeHost();
    const pool = new BrowserPool(host, events());
    pool.register("a", "https://example.com/");
    pool.register("b", "https://example.org/");
    pool.show("a", box);
    await flush();
    await pool.hideShown();
    expect(log).toEqual(["create 1 https://example.com/", "layout 1 400x300", "layout 1 hide"]);
    // 没有显示中的网页：直接返回，不发命令
    await pool.hideShown();
    expect(log).toHaveLength(3);

    pool.show("a", box);
    await flush();
    let release: () => void = () => undefined;
    vi.mocked(host.layout).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const started = Date.now();
    await pool.hideShown(30);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
  });

  it("创建前或创建期间关掉：不建或建好后立刻销毁，不留孤儿 webview", async () => {
    const { host, log } = fakeHost();
    const pool = new BrowserPool(host, events());
    pool.register("a", "https://example.com/");
    pool.show("a", box);
    pool.destroy("a");
    await flush();
    expect(log).toEqual([]);
    let finish: (id: number) => void = () => undefined;
    (host.create as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<number>((resolve) => (finish = resolve)),
    );
    pool.register("b", "https://example.com/");
    pool.show("b", box);
    await flush();
    pool.destroy("b");
    finish(9);
    await flush();
    await flush();
    expect(log).toEqual(["destroy 9"]);
  });

  it("超出上限时回收最久没显示的后台标签；再显示时按最后的地址重建", async () => {
    const { host, log, push } = fakeHost();
    const ev = events();
    const pool = new BrowserPool(host, ev, 2);
    for (const id of ["a", "b"]) pool.register(id, `https://${id}.test/`);
    pool.show("a", box);
    await flush();
    push(1, { kind: "url", url: "https://a.test/page2" });
    pool.hide("a");
    pool.show("b", box);
    await flush();
    pool.hide("b");
    pool.register("c", "https://c.test/");
    pool.show("c", box);
    await flush();
    // a 最久没显示：被回收，只留地址
    expect(log).toContain("destroy 1");
    expect(pool.status("a")).toMatchObject({ live: false, url: "https://a.test/page2" });
    expect(pool.status("b")?.live).toBe(true);
    expect(pool.liveCount).toBe(2);
    pool.hide("c");
    pool.show("a", box);
    await flush();
    expect(log).toContain("create 4 https://a.test/page2");
    // 这次回收的是 b
    expect(log).toContain("destroy 2");
    expect(ev.onUrl).toHaveBeenCalledWith("a", "https://a.test/page2");
  });

  it("显示中的标签不被回收；默认上限是 MAX_LIVE_BROWSERS", async () => {
    const { host } = fakeHost();
    const pool = new BrowserPool(host, events());
    for (let i = 0; i <= MAX_LIVE_BROWSERS; i += 1) {
      pool.register(`t${i}`, "https://example.com/");
      pool.show(`t${i}`, box);
    }
    await flush();
    // 全部可见时没有可回收的，宁可超出也不销毁可见的
    expect(pool.liveCount).toBe(MAX_LIVE_BROWSERS + 1);
    expect(host.destroy).not.toHaveBeenCalled();
  });

  it("网页事件：地址、标题、新窗口、快捷键转给面板；回收后的旧 webview 迟到的消息丢掉", async () => {
    const { host, push } = fakeHost();
    const ev = events();
    const pool = new BrowserPool(host, ev, 1);
    pool.register("a", "https://example.com/");
    pool.show("a", box);
    await flush();
    push(1, { kind: "title", title: "Example" });
    push(1, { kind: "newWindow", url: "https://example.org/" });
    push(1, { kind: "shortcut", key: "t" });
    push(1, { kind: "history", back: true, forward: false });
    push(1, { kind: "loading", loading: false });
    push(1, {
      kind: "blocked",
      url: "ms-settings:",
      reason: "external",
      message: "已阻止打开外部程序（ms-settings:）",
    });
    expect(ev.onTitle).toHaveBeenCalledWith("a", "Example");
    expect(ev.onNewWindow).toHaveBeenCalledWith("a", "https://example.org/");
    expect(ev.onShortcut).toHaveBeenCalledWith("t");
    expect(pool.status("a")).toMatchObject({
      back: true,
      forward: false,
      loading: false,
      blocked: "已阻止打开外部程序（ms-settings:）",
    });
    // 下一次开始加载时清掉拦截提示
    push(1, { kind: "loading", loading: true });
    expect(pool.status("a")?.blocked).toBeUndefined();
    const stale = (host.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as (
      m: BrowserMessage,
    ) => void;
    pool.hide("a");
    pool.register("b", "https://b.test/");
    pool.show("b", box);
    await flush();
    stale({ kind: "url", url: "https://late.test/" });
    expect(ev.onUrl).not.toHaveBeenCalledWith("a", "https://late.test/");
  });

  it("地址栏导航：外壳拒绝时给出文案；没有 webview 时只记地址", async () => {
    const { host, log } = fakeHost();
    const ev = events();
    const pool = new BrowserPool(host, ev);
    pool.register("a", "https://example.com/");
    expect(await pool.navigate("a", "https://example.org/")).toBeUndefined();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(ev.onUrl).toHaveBeenCalledWith("a", "https://example.org/");
    pool.show("a", box);
    await flush();
    expect(log[0]).toBe("create 1 https://example.org/");
    expect(await pool.navigate("a", "javascript:alert(1)")).toBe("不支持的地址");
    expect(errorText({ code: "x", message: "m" })).toBe("m");
  });

  it("创建失败：显示说明，尺寸变化不自动重试，点「重试」才再建", async () => {
    const { host } = fakeHost();
    (host.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: "browser_failed",
      message: "主窗口不存在",
    });
    const pool = new BrowserPool(host, events());
    pool.register("a", "https://example.com/");
    pool.show("a", box);
    await flush();
    expect(pool.status("a")).toMatchObject({ live: false, error: "主窗口不存在" });
    pool.show("a", { ...box, width: 500 });
    await flush();
    expect(host.create).toHaveBeenCalledTimes(1);
    pool.retry("a", box);
    await flush();
    expect(host.create).toHaveBeenCalledTimes(2);
    expect(pool.status("a")?.live).toBe(true);
  });
});
