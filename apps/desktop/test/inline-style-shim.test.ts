/** 正式包 CSP 拦下运行时 `<style>` 时，把内容同步进可构造样式表（inline-style-shim.ts）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installInlineStyleShim } from "../src/inline-style-shim";

class FakeSheet {
  text = "";
  replaceSync(text: string) {
    this.text = text;
  }
}

/** jsdom 不执行 CSP：用 sheet 恒为 null 模拟被 style-src 拦下的 `<style>` */
function blockedStyle(text: string): HTMLStyleElement {
  const element = document.createElement("style");
  Object.defineProperty(element, "sheet", { get: () => null });
  element.textContent = text;
  return element;
}

const adopted = () =>
  (document as unknown as { adoptedStyleSheets: FakeSheet[] }).adoptedStyleSheets;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("installInlineStyleShim", () => {
  let uninstall: () => void = () => undefined;
  const page = new FakeSheet();

  beforeEach(() => {
    vi.stubGlobal("CSSStyleSheet", FakeSheet);
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      writable: true,
      value: [page],
    });
  });
  afterEach(() => {
    uninstall();
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "adoptedStyleSheets");
  });

  it("mirrors blocked style elements, follows text changes and removal", async () => {
    const early = blockedStyle(".cm { display: flex }");
    document.head.append(early);
    uninstall = installInlineStyleShim();
    expect(adopted().map((sheet) => sheet.text)).toEqual(["", ".cm { display: flex }"]);
    expect(adopted()[0]).toBe(page);

    // xterm 的写法：先挂空 <style>，再改 textContent
    const late = blockedStyle("");
    const screen = document.createElement("div");
    screen.append(late);
    document.body.append(screen);
    await flush();
    late.textContent = ".xterm-fg-3 { color: #7a5410 }";
    await flush();
    expect(adopted().map((sheet) => sheet.text)).toEqual([
      "",
      ".cm { display: flex }",
      ".xterm-fg-3 { color: #7a5410 }",
    ]);

    screen.remove();
    await flush();
    expect(adopted().map((sheet) => sheet.text)).toEqual(["", ".cm { display: flex }"]);

    uninstall();
    expect(adopted()).toEqual([page]);
  });

  it("leaves style elements the CSP allowed alone", async () => {
    uninstall = installInlineStyleShim();
    const allowed = document.createElement("style");
    allowed.textContent = "a { color: red }";
    document.head.append(allowed);
    await flush();
    expect(allowed.sheet).not.toBeNull();
    expect(adopted()).toEqual([page]);
  });

  it("routes setAttribute(style) through CSSOM and restores it on uninstall", () => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")?.value;
    uninstall = installInlineStyleShim();
    const span = document.createElement("span");
    const cssText = vi.spyOn(span.style, "cssText", "set");
    span.setAttribute("style", "color: rgb(122, 84, 16)");
    expect(cssText).toHaveBeenCalledWith("color: rgb(122, 84, 16)");
    expect(span.getAttribute("style")).toBe("color: rgb(122, 84, 16);");
    span.setAttribute("title", "x");
    expect(span.getAttribute("title")).toBe("x");
    uninstall();
    uninstall = () => undefined;
    expect(Object.getOwnPropertyDescriptor(Element.prototype, "setAttribute")?.value).toBe(native);
  });
});
