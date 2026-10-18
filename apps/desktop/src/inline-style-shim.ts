/**
 * 正式包的 CSP 是 `style-src 'self'`（tauri.conf.json），运行时插入的 `<style>` 会被拦掉：
 * CodeMirror（style-mod 在 document 上用 `<style>`）和 xterm（主题色、字符尺寸、滚动条）
 * 都靠它，被拦后文件查看器的行号栏和正文叠成一列、终端没有 ANSI 颜色也不是等宽网格。
 * 开发模式的 devCsp 允许内联样式，所以只在打包后出现。
 *
 * 这里把被拦下的 `<style>`（`sheet === null`）的内容同步进可构造样式表：adoptedStyleSheets
 * 走 CSSOM，不受 style-src 限制，也不用放宽 CSP。没被拦的 `<style>` 不碰，开发模式下不会重复。
 * 可构造样式表排在文档样式之后；两个库的选择器都带自己的类前缀，覆盖它们的应用样式本来就更具体。
 *
 * `style` 属性同理（style-src-attr）：xterm 的 DOM 渲染器用 `setAttribute("style", …)` 给单元格
 * 上真彩色 / 256 色和按最小对比度调过的颜色，被拦后 Claude Code 之类的彩色输出全变成默认色。
 * 改走 `style.cssText`（CSSOM，不受限制，序列化回属性的结果相同）。
 */
export function installInlineStyleShim(doc: Document = document): () => void {
  if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in doc)) {
    return () => undefined;
  }
  const mirrored = new Map<HTMLStyleElement, { sheet: CSSStyleSheet; text: string }>();
  let mine: CSSStyleSheet[] = [];
  const adopt = (next: CSSStyleSheet[]) => {
    doc.adoptedStyleSheets = [
      ...doc.adoptedStyleSheets.filter((sheet) => !mine.includes(sheet)),
      ...next,
    ];
    mine = next;
  };
  const sync = (candidates: Iterable<HTMLStyleElement>) => {
    let changed = false;
    for (const element of mirrored.keys()) {
      if (!element.isConnected) {
        mirrored.delete(element);
        changed = true;
      }
    }
    for (const element of candidates) {
      if (!element.isConnected) continue;
      const text = element.textContent;
      const entry = mirrored.get(element);
      if (entry !== undefined) {
        if (entry.text !== text) {
          entry.sheet.replaceSync(text);
          entry.text = text;
        }
      } else if (element.sheet === null) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        mirrored.set(element, { sheet, text });
        changed = true;
      }
    }
    if (changed) adopt([...mirrored.values()].map((entry) => entry.sheet));
  };
  const styleOf = (node: Node | null): HTMLStyleElement | undefined => {
    if (node === null) return undefined;
    if (node instanceof HTMLStyleElement) return node;
    return node.parentNode instanceof HTMLStyleElement ? node.parentNode : undefined;
  };
  const observer = new MutationObserver((records) => {
    const candidates = new Set<HTMLStyleElement>();
    let removed = false;
    for (const record of records) {
      const target = styleOf(record.target);
      if (target !== undefined) candidates.add(target);
      for (const node of record.addedNodes) {
        if (node instanceof HTMLStyleElement) candidates.add(node);
        else if (node instanceof Element) {
          for (const style of node.querySelectorAll("style")) candidates.add(style);
        }
      }
      if (record.removedNodes.length > 0) removed = true;
    }
    if (candidates.size > 0 || (removed && mirrored.size > 0)) sync(candidates);
  });
  observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
  sync(doc.querySelectorAll("style"));
  const restoreAttribute = routeStyleAttribute();
  return () => {
    observer.disconnect();
    restoreAttribute();
    adopt([]);
    mirrored.clear();
  };
}

function routeStyleAttribute(): () => void {
  const proto = Element.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "setAttribute");
  if (original === undefined || typeof original.value !== "function") return () => undefined;
  const setAttribute = original.value as Element["setAttribute"];
  Object.defineProperty(proto, "setAttribute", {
    ...original,
    value: function (this: Element, name: string, value: string) {
      if (
        name.toLowerCase() === "style" &&
        (this instanceof HTMLElement || this instanceof SVGElement)
      ) {
        this.style.cssText = value;
        return;
      }
      setAttribute.call(this, name, value);
    },
  });
  return () => {
    Object.defineProperty(proto, "setAttribute", original);
  };
}
