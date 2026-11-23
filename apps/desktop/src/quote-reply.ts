import { normalizeQuoteText, type MessageQuote } from "@nocturne/core/protocol";

export const QUOTE_FLASH_HIGHLIGHT = "quote-flash";
export const QUOTE_FLASH_FADING_HIGHLIGHT = "quote-flash-fading";
export const QUOTE_FLASH_DURATION_MS = 1000;
export const QUOTE_FLASH_FADE_AT_MS = 450;

const BUTTON_HEIGHT = 28;
const BUTTON_GAP = 6;
const BUTTON_EDGE_PAD = 36;

export interface QuoteSelectionAnchor {
  quote: MessageQuote;
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * 向草稿引用列表追加一段引用（ADR-0116 §3）：
 * - 原文按协议规则保留换行、去掉首尾空白；空白文本不添加
 * - 按添加顺序排列；同一段原文重复引用时不重复添加
 */
export function addDraftQuote(
  quotes: readonly MessageQuote[],
  incoming: MessageQuote,
): MessageQuote[] {
  const text = normalizeQuoteText(incoming.text);
  if (text === "") return [...quotes];
  if (quotes.some((item) => item.text === text)) return [...quotes];
  const entry: MessageQuote =
    incoming.seq !== undefined && Number.isInteger(incoming.seq) && incoming.seq >= 1
      ? { text, seq: incoming.seq }
      : { text };
  return [...quotes, entry];
}

export function removeDraftQuote(quotes: readonly MessageQuote[], index: number): MessageQuote[] {
  if (index < 0 || index >= quotes.length) return [...quotes];
  return quotes.filter((_, i) => i !== index);
}

function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function quoteSourceOf(node: Node | null, container: HTMLElement): HTMLElement | null {
  const el = elementOf(node);
  if (el === null || !container.contains(el)) return null;
  const source = el.closest<HTMLElement>("[data-quote-source-seq]");
  if (source === null || !container.contains(source)) return null;
  return source;
}

function isInsideExcludedChrome(node: Node | null): boolean {
  const el = elementOf(node);
  return el?.closest(".conversation-code-language") != null;
}

function rectListOf(range: Range): DOMRect[] {
  const raw = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
  const visible = raw.filter((rect) => rect.width > 0 || rect.height > 0);
  if (visible.length > 0) return visible;
  const bounding = range.getBoundingClientRect();
  if (bounding.width > 0 || bounding.height > 0) return [bounding];
  return [];
}

/**
 * 从当前浏览器选区提取可引用片段与「回复」按钮位置（ADR-0116 §2）：
 * - 只在单条消息的正文容器（`[data-quote-source-seq]`）内非空选中时返回结果
 * - 跨消息、选区为空、或选区滚出视口时返回 null
 */
export function readQuoteSelection(
  selection: Selection | null,
  container: HTMLElement | null,
  scrollEl: HTMLElement | null,
): QuoteSelectionAnchor | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (container === null || scrollEl === null) return null;

  const range = selection.getRangeAt(0);
  const startSource = quoteSourceOf(range.startContainer, container);
  const endSource = quoteSourceOf(range.endContainer, container);
  if (startSource === null || endSource === null || startSource !== endSource) return null;

  if (isInsideExcludedChrome(range.startContainer) && isInsideExcludedChrome(range.endContainer)) {
    return null;
  }

  const text = normalizeQuoteText(selection.toString());
  if (text === "") return null;

  const rects = rectListOf(range);
  if (rects.length === 0) return null;

  const firstRect = rects[0];
  const lastRect = rects[rects.length - 1];
  if (firstRect === undefined || lastRect === undefined) return null;
  const bounding = range.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // 选区离开可视区时不显示按钮
  if (scrollRect.height > 0) {
    if (lastRect.bottom <= scrollRect.top || firstRect.top >= scrollRect.bottom) return null;
  }

  const centerX =
    bounding.width > 0 ? bounding.left + bounding.width / 2 : firstRect.left + firstRect.width / 2;
  const rawLeft = centerX - containerRect.left;
  const left =
    containerRect.width > BUTTON_EDGE_PAD * 2
      ? Math.min(containerRect.width - BUTTON_EDGE_PAD, Math.max(BUTTON_EDGE_PAD, rawLeft))
      : rawLeft;

  const spaceAbove = firstRect.top - scrollRect.top;
  const placement: "above" | "below" =
    spaceAbove >= BUTTON_HEIGHT + BUTTON_GAP + 4 ? "above" : "below";
  const top =
    placement === "above"
      ? firstRect.top - containerRect.top - BUTTON_HEIGHT - BUTTON_GAP
      : lastRect.bottom - containerRect.top + BUTTON_GAP;

  const rawSeq = Number(startSource.dataset.quoteSourceSeq);
  const seq = Number.isInteger(rawSeq) && rawSeq >= 1 ? rawSeq : undefined;

  return {
    quote: seq !== undefined ? { text, seq } : { text },
    left,
    top,
    placement,
  };
}

const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, div, article, section";

function closestBlock(node: Text, root: Element): Element {
  let cur: Element | null = node.parentElement;
  while (cur !== null && cur !== root) {
    if (cur.matches(BLOCK_SELECTOR)) return cur;
    cur = cur.parentElement;
  }
  return root;
}

interface CharPosition {
  node: Text;
  offset: number;
}

/**
 * 在消息正文容器内定位引用原文对应的 DOM Range。
 * 先按原文精确匹配（块间以 `\n` 分隔），未命中时按折叠空白再匹配一次。
 */
export function findQuoteRangesInElement(container: Element, quoteText: string): Range[] {
  const needle = normalizeQuoteText(quoteText);
  if (needle === "") return [];

  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let full = "";
  const positions: (CharPosition | null)[] = [];
  let prevBlock: Element | null = null;

  let current = walker.nextNode();
  while (current !== null) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (textNode.data.length > 0 && parent?.closest(".conversation-code-language") == null) {
      const block = closestBlock(textNode, container);
      if (prevBlock !== null && block !== prevBlock) {
        full += "\n";
        positions.push(null);
      }
      prevBlock = block;
      for (let i = 0; i < textNode.data.length; i += 1) {
        full += textNode.data.charAt(i);
        positions.push({ node: textNode, offset: i });
      }
    }
    current = walker.nextNode();
  }

  if (positions.length === 0) return [];

  const createRangeFromSpan = (startIdx: number, endIdxExclusive: number): Range[] => {
    let startPos: CharPosition | null = null;
    for (let i = startIdx; i < endIdxExclusive; i += 1) {
      if (positions[i] !== null) {
        startPos = positions[i] ?? null;
        break;
      }
    }
    let endPos: CharPosition | null = null;
    for (let i = endIdxExclusive - 1; i >= startIdx; i -= 1) {
      if (positions[i] !== null) {
        endPos = positions[i] ?? null;
        break;
      }
    }
    if (startPos === null || endPos === null) return [];
    const range = doc.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, Math.min(endPos.node.data.length, endPos.offset + 1));
    return [range];
  };

  // 1) 精确匹配
  const exactIdx = full.indexOf(needle);
  if (exactIdx >= 0) {
    return createRangeFromSpan(exactIdx, exactIdx + needle.length);
  }

  // 2) 空白归一化匹配（折叠连续空白为单空格，兼容跨段落/列表换行差异）
  let collapsed = "";
  const collapsedToFull: number[] = [];
  let inSpace = false;
  for (let i = 0; i < full.length; i += 1) {
    const ch = full.charAt(i);
    if (/\s/.test(ch)) {
      if (!inSpace && collapsed.length > 0) {
        collapsed += " ";
        collapsedToFull.push(i);
      }
      inSpace = true;
    } else {
      collapsed += ch;
      collapsedToFull.push(i);
      inSpace = false;
    }
  }
  const collapsedNeedle = needle.replace(/\s+/g, " ").trim();
  if (collapsedNeedle === "") return [];
  const fuzzyIdx = collapsed.indexOf(collapsedNeedle);
  if (fuzzyIdx < 0) return [];
  const fullStart = collapsedToFull[fuzzyIdx];
  const fullEnd = collapsedToFull[fuzzyIdx + collapsedNeedle.length - 1];
  if (fullStart === undefined || fullEnd === undefined) return [];
  return createRangeFromSpan(fullStart, fullEnd + 1);
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

type HighlightCtorLike = new (...ranges: AbstractRange[]) => unknown;

function getHighlightRuntime():
  { registry: HighlightRegistryLike; HighlightCtor: HighlightCtorLike } | undefined {
  const cssObj = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const ctor = (globalThis as { Highlight?: HighlightCtorLike }).Highlight;
  if (
    cssObj?.highlights === undefined ||
    typeof cssObj.highlights.set !== "function" ||
    typeof cssObj.highlights.delete !== "function" ||
    typeof ctor !== "function"
  ) {
    return undefined;
  }
  return { registry: cssObj.highlights, HighlightCtor: ctor };
}

export function clearQuoteFlashHighlight(): void {
  const runtime = getHighlightRuntime();
  if (runtime === undefined) return;
  runtime.registry.delete(QUOTE_FLASH_HIGHLIGHT);
  runtime.registry.delete(QUOTE_FLASH_FADING_HIGHLIGHT);
}

export function applyQuoteFlashHighlight(ranges: readonly Range[], fading = false): boolean {
  const runtime = getHighlightRuntime();
  if (runtime === undefined || ranges.length === 0) return false;
  clearQuoteFlashHighlight();
  const key = fading ? QUOTE_FLASH_FADING_HIGHLIGHT : QUOTE_FLASH_HIGHLIGHT;
  runtime.registry.set(key, new runtime.HighlightCtor(...ranges));
  return true;
}
