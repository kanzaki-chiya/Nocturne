/** 引用回复（ADR-0116）：用户选中的消息原文片段与来源持久事件序号。 */
export interface MessageQuote {
  text: string;
  /** 来源消息的持久事件序号（用户消息为其 message.user，助手回答为其 message.assistant） */
  seq?: number | undefined;
}

/** 规范化单段引用原文：统一换行为 LF 并去掉首尾空白。 */
export function normalizeQuoteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * 组装放在 `message.user.content` 最前面给模型看的引用文本块（ADR-0116 §4）：
 * 每段引用逐行加 `> ` 前缀，段与段之间空一行，块末空一行。
 */
export function formatQuotesBlock(quotes: readonly MessageQuote[]): string {
  const sections = quotes.map((quote) =>
    quote.text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  );
  return `${sections.join("\n\n")}\n\n`;
}
