/** 用户亲自输入的 @ 引用。范围包含 @ 与引号，end 不包含末尾字符。 */
export interface ParsedFileRef {
  path: string;
  start: number;
  end: number;
}

export function parseFileRefs(text: string): ParsedFileRef[] {
  const refs: ParsedFileRef[] = [];
  const pattern = /(^|\s)@(?:"([^"\r\n]+)"|([^\s"]+))/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1]?.length ?? 0);
    refs.push({ path: match[2] ?? match[3] ?? "", start, end: match.index + match[0].length });
  }
  return refs;
}
