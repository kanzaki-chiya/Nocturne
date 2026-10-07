import type { FileRef, UserEntry } from "@nocturne/core/protocol";

/** @ 补全索引条目（与 session.fileIndex() 返回结构相同）。 */
export interface FileIndexEntry {
  /** 相对工作区的路径，目录带 / 后缀。 */
  path: string;
  kind: "file" | "directory";
}

export interface FileRefCandidate {
  path: string;
  label: string;
  /** 替换 [start,end) 区间后插入的文本；文件带尾随空格，目录不带（继续补下一级）。 */
  insert: string;
  directory: boolean;
}

export interface FileCompletion {
  start: number;
  end: number;
  candidates: FileRefCandidate[];
}

/** 光标处 @ 引用词的词法范围；为空也可用于判断"光标在引用词内"。 */
export function fileRefToken(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | undefined {
  const match = /(?:^|\s)@("[^"]*"?|[^\s"]*)$/u.exec(text.slice(0, cursor));
  if (match === null) return undefined;
  const raw = match[1] ?? "";
  const start = cursor - raw.length - 1;
  const quoted = raw.startsWith('"');
  const query = (quoted ? raw.slice(1).replace(/"$/, "") : raw).replaceAll("\\", "/");
  const tail = text.slice(cursor);
  const end =
    cursor +
    (quoted
      ? raw.endsWith('"') && raw.length > 1
        ? 0
        : (/^[^"]*"?/u.exec(tail)?.[0].length ?? 0)
      : (/^\S*/u.exec(tail)?.[0].length ?? 0));
  return { start, end, query };
}

/**
 * @ 补全的排名与插入规则（与 Core completeFileRefs 一致）：
 * 文件名前缀 > 文件名包含 > 路径包含，同档短路径在前；
 * 含空白的路径加引号；文件插入带尾随空格，目录保持 popup 打开列出下一级。
 */
export function completeFileRefs(
  text: string,
  cursor: number,
  entries: readonly FileIndexEntry[],
): FileCompletion | undefined {
  const token = fileRefToken(text, cursor);
  if (token === undefined) return undefined;
  const q = token.query.toLowerCase();
  const slash = q.lastIndexOf("/");
  const parent = slash < 0 ? "" : q.slice(0, slash + 1);
  const needle = q.slice(slash + 1);
  const ranked = entries.flatMap((entry) => {
    const path = entry.path.toLowerCase();
    const bare = path.replace(/\/$/, "");
    if (
      parent !== "" &&
      (!path.startsWith(parent) ||
        bare === parent.slice(0, -1) ||
        bare.slice(parent.length).includes("/"))
    )
      return [];
    const name = bare.slice(bare.lastIndexOf("/") + 1);
    const rank = name.startsWith(needle)
      ? 0
      : name.includes(needle)
        ? 1
        : path.includes(q)
          ? 2
          : -1;
    if (rank < 0) return [];
    const quote = /\s/u.test(entry.path);
    const insert = `@${quote ? `"${entry.path}${entry.kind === "file" ? '"' : ""}` : entry.path}${entry.kind === "file" ? " " : ""}`;
    return [
      {
        path: entry.path,
        label: entry.path,
        insert,
        directory: entry.kind === "directory",
        rank,
      },
    ];
  });
  ranked.sort(
    (a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return {
    start: token.start,
    end: token.end,
    candidates: ranked.map(({ path, label, insert, directory }) => ({
      path,
      label,
      insert,
      directory,
    })),
  };
}

/**
 * Backspace/Delete 整删 @ 引用（U-05）：光标紧跟在一个完整引用后/前时，
 * 返回应整体删除的区间（含至多一个尾随分隔空格）；否则返回 undefined
 * 走默认单字符删除。
 *
 * 「完整」的判定与 fileRefToken 同一套词法：引用必须以行首或空白起、
 * 以 @ 开头；引号形式须有收尾引号；无引号形式必须被空白终止——否则
 * 它只是正在键入的补全词（如 @fo），照常逐字删除。
 */
export function fileRefDeleteRange(
  text: string,
  cursor: number,
  direction: "backward" | "forward",
): { start: number; end: number } | undefined {
  const isBoundary = (pos: number): boolean => pos === 0 || /\s/u.test(text[pos - 1] ?? "");
  /** at 处 @ 引用的结束位；不完整（未收尾引号 / 裸词未被空白终止）返回 undefined。 */
  const refEnd = (at: number): number | undefined => {
    const rest = text.slice(at + 1);
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      return close < 0 ? undefined : at + 1 + close + 1;
    }
    const token = /^[^\s"]+/u.exec(rest);
    if (token === null) return undefined;
    const end = at + 1 + token[0].length;
    return /\s/u.test(text[end] ?? "") ? end : undefined;
  };

  if (direction === "forward") {
    // 光标在引用前：@ 必须在行首或空白后
    if (text[cursor] !== "@" || !isBoundary(cursor)) return undefined;
    const end = refEnd(cursor);
    if (end === undefined) return undefined;
    return { start: cursor, end: text[end] === " " ? end + 1 : end };
  }

  // 光标在引用后：引用可结束在光标处（@a| x），或光标前一个分隔空格处（@a |x）
  for (const end of [cursor, cursor - 1]) {
    if (end <= 0) continue;
    if (end === cursor - 1 && text[end] !== " ") continue;
    const at = text.slice(0, end).lastIndexOf("@");
    if (at < 0 || !isBoundary(at)) continue;
    if (refEnd(at) === end) {
      return { start: at, end: text[end] === " " ? end + 1 : end };
    }
  }
  return undefined;
}

/** 用户消息原文：去掉末尾文件、技能和委派快照内容块。 */
export function userText(entry: UserEntry): string {
  const snapshots =
    (entry.fileRefs?.filter((ref) => ref.kind !== "image").length ?? 0) +
    (entry.skill ? 1 : 0) +
    (entry.delegate ? 1 : 0);
  const content = snapshots === 0 ? entry.content : entry.content.slice(0, -snapshots);
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** @ 引用气泡的悬停说明。 */
export function fileRefTitle(ref: FileRef): string {
  if (ref.kind === "directory") return "目录";
  if (ref.kind === "image") return "图片";
  const lines =
    ref.lines !== undefined && ref.totalLines !== undefined
      ? `已附带 ${ref.lines}/${ref.totalLines} 行`
      : "已附带文件";
  return ref.truncated ? `${lines} · 已截断` : lines;
}
