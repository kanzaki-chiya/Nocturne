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

/**
 * 回答内文件引用的解析结果（U-09，方案 A）：前端把 codespan 文本的行号
 * 后缀剥离后，把路径批量发给会话按工作区解析。只读，不产生事件。
 */
export interface FileRefResolution {
  /** 前端发来的原文（已剥离行号的路径部分） */
  input: string;
  /** 解析出的绝对路径（越界时仍给出，供"资源管理器中显示"用） */
  absolutePath: string;
  /** 是否在工作区内 */
  withinWorkspace: boolean;
  /** 相对工作区根的路径（"复制相对路径"用）；越界时缺省 */
  relativePath?: string | undefined;
  /** 路径是否存在（文件或目录） */
  exists: boolean;
  isDirectory: boolean;
}

/**
 * 回答内行内代码的文件引用拆分（U-09）：`路径` 或 `路径:行[-行]`。
 * 行号后缀从尾部剥离（Windows 盘符冒号不受影响）；路径为空或含换行
 * 时返回 undefined，不是引用。
 */
export function splitCodeRef(
  text: string,
): { path: string; line?: number; endLine?: number } | undefined {
  if (text === "" || text.includes("\n") || text.includes("\r")) return undefined;
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const match = /:(\d+)(?:-(\d+))?$/.exec(trimmed);
  if (match === null) return { path: trimmed };
  const path = trimmed.slice(0, match.index).trimEnd();
  if (path === "") return undefined;
  const line = Number(match[1]);
  const endLine = match[2] !== undefined ? Number(match[2]) : undefined;
  if (endLine !== undefined && endLine < line) return { path: trimmed };
  return { path, line, ...(endLine !== undefined ? { endLine } : {}) };
}
