/**
 * 粘贴占位（tui.md §2）：多行或超长粘贴在输入框里收成 `[Paste #n, +k lines]`，
 * 提交时展开成原文。原文只存在本次运行的内存里，占位号在会话内递增。
 */

/** 单行粘贴超过这个长度也收成占位 */
const LONG_PASTE_CHARS = 800;

const TOKEN_RE = /\[Paste #(\d+), [^\]]*\]/g;
const TOKEN_TAIL_RE = /\[Paste #\d+, [^\]]*\]$/;

export interface PasteStore {
  /** 需要收起时登记原文并返回占位；短文本返回 undefined，按原文插入 */
  add(text: string): string | undefined;
  /** 把行内已登记的占位换回原文；未登记的占位原样保留 */
  expand(line: string): string;
  /** 切换会话时重置编号，保留当前草稿里的占位 */
  reset(draft: string): void;
}

export function createPasteStore(): PasteStore {
  const texts = new Map<number, string>();
  let next = 1;
  return {
    add(text) {
      const breaks = text.split("\n").length - 1;
      if (breaks === 0 && text.length <= LONG_PASTE_CHARS) return undefined;
      while (texts.has(next)) next++;
      const id = next++;
      texts.set(id, text);
      return breaks > 0
        ? `[Paste #${id}, +${breaks} lines]`
        : `[Paste #${id}, ${text.length} chars]`;
    },
    expand(line) {
      return line.replace(TOKEN_RE, (token, id: string) => texts.get(Number(id)) ?? token);
    },
    reset(draft) {
      const keep = new Set([...draft.matchAll(TOKEN_RE)].map((match) => Number(match[1])));
      for (const id of texts.keys()) if (!keep.has(id)) texts.delete(id);
      next = 1;
    },
  };
}

/** 光标紧跟在一个完整占位之后时，退格整块删除：返回占位长度，否则 0 */
export function pasteTokenBefore(textBeforeCursor: string): number {
  return TOKEN_TAIL_RE.exec(textBeforeCursor)?.[0].length ?? 0;
}

export function pasteTokenAt(textAfterCursor: string): number {
  return /^\[Paste #\d+, [^\]]*\]/.exec(textAfterCursor)?.[0].length ?? 0;
}
