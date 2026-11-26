import { marked, type Token, type Tokens, type TokensList } from "marked";

/**
 * 文件引用收集与渲染共用的解析选项（两处 token 流必须一致）。
 * `breaks` 让段落内的单个换行按聊天惯例显示为换行，而不是被
 * CommonMark 软换行折叠成空格；多出的 br token 由 markdownNodes 渲染。
 */
export const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

type LinkMap = TokensList["links"];

export interface MarkdownBlock {
  /** 在可见顶层块（忽略 space/def）中的稳定位置键，防止插入空行或链接定义导致后续块全部重挂 */
  key: string;
  /** 顶层 token 类型 */
  type: string;
  /** 决定该块渲染结果的规范化内容签名（去掉块尾纯分隔换行，防止下块到达时误触发重渲染） */
  sig: string;
  /** 本块实际引用的后置链接定义签名；不含匹配引用时恒为空串 */
  linksKey: string;
  /** 供 markdownNodes 渲染的 token */
  token: Token;
}

/** 判断 marked 产出的代码块围栏是否已闭合；缩进块和未闭合围栏在流式输出时不启动解析。 */
export function isClosedCodeFence(code: Tokens.Code): boolean {
  if (code.codeBlockStyle === "indented") return false;
  const open = /^ {0,3}(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*)$/.exec(code.raw);
  if (open?.[1] === undefined || open[2] === undefined) return false;
  const fence = open[1];
  const body = open[2].replace(/\r?\n$/, "");
  const lastNewline = body.lastIndexOf("\n");
  const lastLine = lastNewline < 0 ? body : body.slice(lastNewline + 1);
  return new RegExp(`^ {0,3}${fence}[~` + "`" + `]* *$`).test(lastLine);
}

function plainParagraphToken(raw: string): Tokens.Paragraph {
  const lines = raw.split(/\r?\n/);
  const tokens: Token[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line !== "") {
      tokens.push({ type: "text", raw: line, text: line } satisfies Tokens.Text);
    }
    if (i < lines.length - 1) {
      tokens.push({ type: "br", raw: "\n" } satisfies Tokens.Br);
    }
  }
  return {
    type: "paragraph",
    raw,
    text: raw,
    tokens,
  };
}

function isPendingTableDelimiter(token: Token): boolean {
  if (token.type !== "table") return false;
  const table = token as Tokens.Table;
  // 分隔行尚未以换行闭合且尚无数据行时，列数与对齐方式仍可能继续变化，流式期暂按普通文本可读呈现
  return table.rows.length === 0 && !/\r?\n$/.test(table.raw);
}

function isPendingSetextHeading(token: Token): boolean {
  if (token.type !== "heading") return false;
  // Setext 标题（不以 # 开头）在末行尚未换行前，可能是列表项（"- item"）或分隔线前缀
  return !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(token.raw) && !/\r?\n$/.test(token.raw);
}

function splitPendingSetextHeading(token: Tokens.Heading): Token[] {
  const raw = token.raw;
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline <= 0) return [token];
  const body = raw.slice(0, lastNewline);
  const underline = raw.slice(lastNewline + 1);
  const paragraph: Tokens.Paragraph = {
    type: "paragraph",
    raw: `${body}\n`,
    text: token.text,
    tokens: token.tokens,
  };
  return underline !== "" ? [paragraph, plainParagraphToken(underline)] : [paragraph];
}

function blockSignature(token: Token): string {
  switch (token.type) {
    case "paragraph":
      return (token as Tokens.Paragraph).text;
    case "code": {
      const code = token as Tokens.Code;
      return `${code.lang ?? ""}\0${isClosedCodeFence(code) ? "1" : "0"}\0${code.text}`;
    }
    default:
      return token.raw.replace(/(?:\r?\n)+$/, "");
  }
}

function linksKeyFor(raw: string, links: LinkMap, linkEntries: readonly string[]): string {
  if (linkEntries.length === 0 || !raw.includes("[")) return "";
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  const matched: string[] = [];
  for (const label of linkEntries) {
    if (!normalized.includes(label)) continue;
    const def = links[label];
    if (def === undefined) continue;
    matched.push(`${label}\0${def.href}\0${def.title ?? ""}`);
  }
  return matched.join("\u0001");
}

/**
 * 将 Markdown 拆分为带稳定键和内容签名的可见顶层块（ADR-0128）。
 * - `streaming === true`：抑制未结束表格分隔行与未结束 Setext 下划线引起的提前重排；
 *   上文已定型块的 `key`/`type`/`sig`/`linksKey` 保持不变，供外层 memo 跳过重渲染以保留 DOM 文本节点与选区。
 * - `streaming === false`：不做流式暂缓，输出与完整历史回放完全一致的 Markdown 语义。
 */
export function lexMarkdownBlocks(markdown: string, streaming: boolean): MarkdownBlock[] {
  const lexed = marked.lexer(markdown, MARKED_OPTIONS);
  const links: LinkMap = lexed.links;
  const linkLabels = Object.keys(links).sort();

  const visible: Token[] = [];
  for (const token of lexed) {
    if (token.type === "space" || token.type === "def") continue;
    visible.push(token);
  }

  if (streaming && visible.length > 0) {
    const lastIndex = visible.length - 1;
    const last = visible[lastIndex];
    if (last !== undefined) {
      if (isPendingTableDelimiter(last)) {
        visible[lastIndex] = plainParagraphToken(last.raw);
      } else if (isPendingSetextHeading(last)) {
        const replacement = splitPendingSetextHeading(last as Tokens.Heading);
        visible.splice(lastIndex, 1, ...replacement);
      }
    }
  }

  return visible.map((token, index) => ({
    key: `b:${String(index)}`,
    type: token.type,
    sig: blockSignature(token),
    linksKey: linksKeyFor(token.raw, links, linkLabels),
    token,
  }));
}
