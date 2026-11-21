import { userEntryText, type UserEntry, type ViewEntry } from "@nocturne/core/protocol";

export interface ConversationFindMatch {
  /** 命中条目的持久事件 seq */
  seq: number;
  /** 命中条目在 view.entries 中的下标 */
  entryIndex: number;
  kind: "user" | "assistant";
}

export const FIND_DEBOUNCE_MS = 150;
export const SELECTION_PREFILL_MAX_CHARS = 100;
export const HIGHLIGHT_ALL = "conv-find";
export const HIGHLIGHT_CURRENT = "conv-find-current";

/**
 * 判断一条 UserEntry 是否为用户消息正文（参与会话内搜索）。
 * 排除子代理结果、后台任务结果、合奏帖子送达与组曲汇报，保留普通用户消息与插话（steer）。
 */
export function isSearchableUserEntry(entry: UserEntry): boolean {
  return (
    entry.subagent === undefined &&
    entry.backgroundShell === undefined &&
    entry.ensemble === undefined &&
    entry.suiteReport === undefined
  );
}

/**
 * 从全量 view.entries 计算会话内搜索命中列表（子串、不区分大小写）。
 * 只搜用户消息正文与助手回复正文，跳过思考、工具输入输出与通知。
 * 导航单位为条目：含有一处或多处命中的每条消息算一处。
 */
export function findConversationMatches(
  entries: readonly ViewEntry[],
  query: string,
): ConversationFindMatch[] {
  if (query.trim() === "") return [];
  const needle = query.toLowerCase();
  const matches: ConversationFindMatch[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.kind === "user") {
      if (!isSearchableUserEntry(entry)) continue;
      if (userEntryText(entry).toLowerCase().includes(needle)) {
        matches.push({ seq: entry.seq, entryIndex: i, kind: "user" });
      }
    } else if (entry.kind === "assistant") {
      if (entry.text !== "" && entry.text.toLowerCase().includes(needle)) {
        matches.push({ seq: entry.seq, entryIndex: i, kind: "assistant" });
      }
    }
  }
  return matches;
}

/**
 * 计算首次落点下标：取视口顶部及以下最近的一处；若都在视口上方则取最后一处。
 */
export function pickInitialMatchIndex(
  matches: readonly ConversationFindMatch[],
  viewportFirstEntryIndex: number,
): number {
  if (matches.length === 0) return -1;
  const idx = matches.findIndex((match) => match.entryIndex >= viewportFirstEntryIndex);
  return idx >= 0 ? idx : matches.length - 1;
}

/** 上一处（-1）/ 下一处（+1），到头循环。 */
export function stepMatchIndex(currentIndex: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= total) {
    return direction === 1 ? 0 : total - 1;
  }
  return (currentIndex + direction + total) % total;
}

/**
 * 若对话区内有单行、非空且不超过 100 字的选中文字，返回该文字用于预填搜索框。
 */
export function extractSelectionPrefill(scrollEl: HTMLElement | null): string | undefined {
  if (scrollEl === null || typeof window === "undefined") return undefined;
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed) return undefined;
  const { anchorNode, focusNode } = selection;
  if (anchorNode === null || focusNode === null) return undefined;
  if (!scrollEl.contains(anchorNode) || !scrollEl.contains(focusNode)) return undefined;
  const raw = selection.toString();
  if (raw.trim() === "" || raw.includes("\n") || raw.includes("\r")) return undefined;
  if (Array.from(raw).length > SELECTION_PREFILL_MAX_CHARS) return undefined;
  return raw;
}

function isExcludedShortcutContext(element: Element | null): boolean {
  if (element === null) return false;
  return (
    element.closest(".xterm") !== null ||
    element.closest(".side-panel") !== null ||
    element.closest(".sp-rail") !== null ||
    element.closest('[role="dialog"]') !== null ||
    element.closest('[role="alertdialog"]') !== null
  );
}

/**
 * 判断主窗口对话区/输入框级快捷键（Ctrl+F、Alt+↑/↓）当前是否可由主对话接管。
 * 焦点在终端（.xterm）、右侧面板、设置页（主区 inert）、弹窗内时不接管。
 */
export function canHandleConversationShortcut(
  rootEl: HTMLElement | null,
  event: KeyboardEvent,
): boolean {
  if (rootEl === null) return false;
  if (rootEl.closest("[inert]") !== null) return false;
  const target = event.target instanceof Element ? event.target : null;
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  if (isExcludedShortcutContext(target) || isExcludedShortcutContext(active)) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return false;

  const mainPane = rootEl.closest(".mainpane");
  const focusEl = active ?? target;
  if (focusEl === null || focusEl === document.body || focusEl === document.documentElement) {
    return true;
  }
  if (rootEl.contains(focusEl)) return true;
  const composer = (mainPane ?? document).querySelector(".composer");
  if (composer?.contains(focusEl) === true) return true;
  return false;
}

const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, div, article, section";

function closestBlock(node: Text, root: Element): Element | null {
  let cur: Element | null = node.parentElement;
  while (cur !== null && cur !== root) {
    if (cur.matches(BLOCK_SELECTOR)) return cur;
    cur = cur.parentElement;
  }
  return root;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * 在一个正文容器（.u-text 或 .conversation-markdown）的文本节点上为所有不重叠子串命中创建 Range。
 * 跳过代码块语言栏/复制按钮（.conversation-code-language），跨块级元素不拼接匹配。
 */
export function collectElementMatchRanges(container: Element, needle: string): Range[] {
  if (needle === "") return [];
  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const segments: TextSegment[] = [];
  let full = "";
  let prevBlock: Element | null = null;

  let current = walker.nextNode();
  while (current !== null) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    if (textNode.data.length > 0 && parent?.closest(".conversation-code-language") == null) {
      const block = closestBlock(textNode, container);
      if (prevBlock !== null && block !== prevBlock) {
        full += "\0";
      }
      prevBlock = block;
      const lower = textNode.data.toLowerCase();
      const start = full.length;
      full += lower;
      segments.push({ node: textNode, start, end: full.length });
    }
    current = walker.nextNode();
  }

  if (segments.length === 0) return [];

  const ranges: Range[] = [];
  let segHint = 0;
  const findSegment = (pos: number, fromIndex: number): number => {
    let idx = fromIndex;
    while (idx < segments.length) {
      const seg = segments[idx];
      if (seg !== undefined && pos < seg.end) return idx;
      idx += 1;
    }
    return -1;
  };

  let from = 0;
  while (from <= full.length - needle.length) {
    const matchStart = full.indexOf(needle, from);
    if (matchStart < 0) break;
    const matchEnd = matchStart + needle.length;
    const startIdx = findSegment(matchStart, segHint);
    if (startIdx < 0) break;
    segHint = startIdx;
    const endIdx = findSegment(matchEnd - 1, startIdx);
    const startSeg = segments[startIdx];
    const endSeg = endIdx >= 0 ? segments[endIdx] : undefined;
    if (
      startSeg !== undefined &&
      endSeg !== undefined &&
      matchStart >= startSeg.start &&
      matchEnd <= endSeg.end
    ) {
      const range = doc.createRange();
      const startOffset = Math.min(startSeg.node.data.length, matchStart - startSeg.start);
      const endOffset = Math.min(endSeg.node.data.length, matchEnd - endSeg.start);
      range.setStart(startSeg.node, startOffset);
      range.setEnd(endSeg.node, endOffset);
      ranges.push(range);
    }
    from = matchEnd;
  }
  return ranges;
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

export function clearConversationHighlights(): void {
  const runtime = getHighlightRuntime();
  if (runtime === undefined) return;
  runtime.registry.delete(HIGHLIGHT_ALL);
  runtime.registry.delete(HIGHLIGHT_CURRENT);
}

export interface HighlightApplyResult {
  /** 当前命中条目是否已挂载在 DOM 中 */
  currentMounted: boolean;
  /** 当前命中条目在渲染后的正文文本节点中是否至少命中一处 */
  currentHasDomMatch: boolean;
}

/**
 * 为已渲染的对话正文节点计算并更新 CSS Custom Highlight（conv-find 与 conv-find-current）。
 * 缺少 CSS.highlights 时安全跳过注册，但仍返回 currentMounted / currentHasDomMatch 供整条背景兜底使用。
 */
export function applyConversationHighlights(
  container: HTMLElement | null,
  query: string,
  currentSeq: number | undefined,
): HighlightApplyResult {
  if (container === null || query.trim() === "") {
    clearConversationHighlights();
    return { currentMounted: false, currentHasDomMatch: false };
  }
  const needle = query.toLowerCase();
  const currentRanges: Range[] = [];
  const otherRanges: Range[] = [];
  let currentMounted = false;

  const articles = container.querySelectorAll<HTMLElement>("article.u, article.a");
  for (const article of articles) {
    const seqAttr = article.getAttribute("data-session-seq");
    const seq = seqAttr !== null ? Number(seqAttr) : undefined;
    const isCurrent = currentSeq !== undefined && seq === currentSeq;
    if (isCurrent) currentMounted = true;

    const bodySelector = article.classList.contains("u")
      ? ".u-text"
      : ":scope > .conversation-markdown";
    const bodyEl = article.querySelector(bodySelector);
    if (bodyEl === null) continue;
    const ranges = collectElementMatchRanges(bodyEl, needle);
    if (isCurrent) {
      for (const range of ranges) currentRanges.push(range);
    } else {
      for (const range of ranges) otherRanges.push(range);
    }
  }

  const runtime = getHighlightRuntime();
  if (runtime !== undefined) {
    if (otherRanges.length > 0) {
      runtime.registry.set(HIGHLIGHT_ALL, new runtime.HighlightCtor(...otherRanges));
    } else {
      runtime.registry.delete(HIGHLIGHT_ALL);
    }
    if (currentRanges.length > 0) {
      runtime.registry.set(HIGHLIGHT_CURRENT, new runtime.HighlightCtor(...currentRanges));
    } else {
      runtime.registry.delete(HIGHLIGHT_CURRENT);
    }
  }

  return { currentMounted, currentHasDomMatch: currentRanges.length > 0 };
}
