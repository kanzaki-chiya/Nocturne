/**
 * 手机网页与安卓共用样式文件，但字体与字号设置只属于桌面端：手机入口不应用、
 * 手机界面不出现这些控件。
 */
import { webcrypto } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREFS_KEY } from "../src/prefs";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";

vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "offline";
    message = "电脑已离线";
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));

const src = path.resolve(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

const web = files(path.join(src, "web")).map((file) => ({
  file: path.relative(src, file),
  text: readFileSync(file, "utf8"),
}));

let root: Root | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("手机端不应用桌面外观设置", () => {
  it("web/ 里没有任何文件引用外观模块或外观页", () => {
    expect(web.length).toBeGreaterThan(0);
    for (const { file, text } of web) {
      expect(text, file).not.toMatch(/["']\.\.\/(appearance|AppearancePreview|SettingsPage)["']/);
    }
  });

  it("手机入口不读字体设置、不覆盖字号变量", () => {
    for (const { file, text } of web) {
      expect(text, file).not.toMatch(/uiFont|codeFont|fontSize\b/);
      expect(text, file).not.toMatch(/setProperty\(\s*["']--(fs-\d|sans|mono)["']/);
    }
  });

  it("桌面入口在渲染前应用；手机入口没有这一步", () => {
    expect(readFileSync(path.join(src, "main.tsx"), "utf8")).toContain("applyStoredAppearance");
    expect(readFileSync(path.join(src, "web", "main.tsx"), "utf8")).not.toContain("appearance");
  });

  it("渲染手机端并进入设置：即使本机存了桌面字体与字号，根元素不带覆盖、页面不出现字体控件", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ uiFont: "Segoe UI", codeFont: "Consolas", fontSize: 20 }),
    );
    const storage = memoryStorage();
    await storage.putHost({ hostId: "computer", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PhoneApp storage={storage} />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
    });
    expect(document.documentElement.style.getPropertyValue("--sans")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--mono")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--fs-2")).toBe("");
    expect(container.textContent).toContain("主题");
    expect(container.textContent).not.toMatch(/界面字体|代码字体|字号/);
    expect(container.querySelector("#appearance-font-size")).toBeNull();
  });

  it("手机端目标行按钮仍用 --row-h 触控尺寸，桌面去边框规则不改宽高", () => {
    const css = readFileSync(path.join(src, "goal-row.css"), "utf8");
    const phoneRule = css.slice(css.indexOf(".phone .goal-row .goal-action"));
    expect(phoneRule).toContain("width: var(--row-h)");
    expect(phoneRule).toContain("height: var(--row-h)");
    expect(phoneRule).toContain("min-height: var(--row-h)");
  });
});
