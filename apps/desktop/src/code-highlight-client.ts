import type { CodeRequest } from "./code-lines";

interface CustomHighlight {
  add: (range: AbstractRange) => void;
  delete: (range: AbstractRange) => void;
}
interface CustomHighlightRegistry {
  set: (name: string, value: CustomHighlight) => void;
}

const activeRanges = new WeakMap<HTMLElement, Map<string, AbstractRange[]>>();
const registry = new Map<string, CustomHighlight>();

function highlightBucket(name: string): CustomHighlight | undefined {
  const existing = registry.get(name);
  if (existing !== undefined) return existing;
  const highlights = (CSS as unknown as { highlights?: CustomHighlightRegistry }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new () => CustomHighlight })
    .Highlight;
  if (highlights === undefined || HighlightCtor === undefined) return undefined;
  const created = new HighlightCtor();
  registry.set(name, created);
  highlights.set(name, created);
  return created;
}

function clearElementHighlights(root: HTMLElement): void {
  const owned = activeRanges.get(root);
  if (owned === undefined) return;
  for (const [name, ranges] of owned) {
    const bucket = registry.get(name);
    if (bucket !== undefined) for (const range of ranges) bucket.delete(range);
  }
  activeRanges.delete(root);
}

function paintWithCustomHighlights(
  root: HTMLElement,
  lines: { text: string; spans: { from: number; to: number; classes: string }[] }[],
  signal: AbortSignal,
  onFrame: (id: number) => void,
): boolean {
  if (lines.length < 200) return false;
  const textNode = root.firstChild;
  const highlights = (CSS as unknown as { highlights?: CustomHighlightRegistry }).highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new () => CustomHighlight })
    .Highlight;
  if (
    highlights === undefined ||
    HighlightCtor === undefined ||
    typeof StaticRange === "undefined" ||
    !(textNode instanceof Text)
  ) {
    return false;
  }
  const lineOffsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.text.length + 1;
  }
  const applyWindow = () => {
    if (signal.aborted) return;
    clearElementHighlights(root);
    const owned = new Map<string, AbstractRange[]>();
    activeRanges.set(root, owned);
    const start = Math.max(0, Math.floor(root.scrollTop / 18) - 40);
    const end = Math.min(lines.length, start + Math.ceil((root.clientHeight || 280) / 18) + 120);
    for (let i = start; i < end; i++) {
      const line = lines[i];
      const base = lineOffsets[i];
      if (line === undefined || base === undefined) continue;
      for (const span of line.spans) {
        const range = new StaticRange({
          startContainer: textNode,
          startOffset: base + span.from,
          endContainer: textNode,
          endOffset: base + span.to,
        });
        for (const cls of span.classes.split(/\s+/)) {
          if (cls === "") continue;
          let list = owned.get(cls);
          if (list === undefined) {
            list = [];
            owned.set(cls, list);
          }
          list.push(range);
          highlightBucket(cls)?.add(range);
        }
      }
    }
  };
  const onScroll = () => {
    onFrame(requestAnimationFrame(applyWindow));
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  signal.addEventListener(
    "abort",
    () => {
      root.removeEventListener("scroll", onScroll);
    },
    { once: true },
  );
  onFrame(requestAnimationFrame(applyWindow));
  return true;
}

/**
 * 异步分片解析并分帧着色。LanguageDescription.load() 的动态 import 留在单个模块图里，
 * 避免 Vite 为 Worker 再复制整套 110+ 个语言包。
 */
export function highlightCode(root: HTMLElement, request: CodeRequest, signal: AbortSignal): void {
  if (signal.aborted) return;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    clearElementHighlights(root);
  };
  signal.addEventListener("abort", stop, { once: true });
  void import("./code-parse")
    .then(({ parseCode }) => parseCode(request, signal))
    .then((lines) => {
      if (lines === undefined || signal.aborted) return;
      if (
        request.kind !== "diff" &&
        paintWithCustomHighlights(root, lines, signal, (id) => {
          frame = id;
        })
      ) {
        return;
      }
      const targets = new Map(
        [...root.querySelectorAll<HTMLElement>("code[data-code-line]")].map((el) => [
          Number(el.dataset.codeLine),
          el,
        ]),
      );
      const fragment = document.createDocumentFragment();
      let index = 0;
      let spanIndex = 0;
      let cursor = 0;
      let lineFragment = document.createDocumentFragment();
      const tick = () => {
        const until = performance.now() + 4;
        while (index < lines.length && !signal.aborted) {
          const line = lines[index];
          if (line === undefined) break;
          const span = line.spans[spanIndex];
          if (span !== undefined) {
            lineFragment.append(line.text.slice(cursor, span.from));
            const node = document.createElement("span");
            node.className = span.classes;
            node.textContent = line.text.slice(span.from, span.to);
            lineFragment.append(node);
            cursor = span.to;
            spanIndex++;
          } else {
            lineFragment.append(line.text.slice(cursor));
            if (request.kind === "diff") {
              const target = targets.get(index);
              if (line.text !== "") target?.replaceChildren(lineFragment);
            } else {
              fragment.append(lineFragment);
              if (index < lines.length - 1) fragment.append("\n");
            }
            index++;
            cursor = 0;
            spanIndex = 0;
            lineFragment = document.createDocumentFragment();
          }
          if (performance.now() >= until) {
            frame = requestAnimationFrame(tick);
            return;
          }
        }
        if (!signal.aborted && request.kind !== "diff") root.replaceChildren(fragment);
        signal.removeEventListener("abort", stop);
      };
      frame = requestAnimationFrame(tick);
    });
}
