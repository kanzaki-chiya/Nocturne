import type { FileSystem, PathOps } from "../platform/index.js";
import { walkFiles } from "./builtin/walk.js";

export interface FileIndexEntry {
  /** 相对工作区的路径，目录带 / 后缀。 */
  path: string;
  kind: "file" | "directory";
}

export async function buildFileIndex(
  fs: FileSystem,
  paths: PathOps,
  root: string,
): Promise<FileIndexEntry[]> {
  const entries: FileIndexEntry[] = [];
  for await (const entry of walkFiles(fs, paths, root, {
    includeDirectories: true,
    maxEntries: 20_000,
    statFiles: false,
  })) {
    const kind = entry.type === "directory" ? "directory" : "file";
    entries.push({ path: entry.rel + (kind === "directory" ? "/" : ""), kind });
  }
  return entries;
}

export interface FileCompletion {
  start: number;
  end: number;
  candidates: { path: string; label: string; insert: string }[];
}

/** 光标处的引用词；空候选也保留词范围，供异步索引提示使用。 */
export function completeFileRefs(
  text: string,
  cursor: number,
  entries: readonly FileIndexEntry[],
): FileCompletion | undefined {
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
  const q = query.toLowerCase();
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
    return [{ path: entry.path, label: entry.path, insert, rank }];
  });
  ranked.sort(
    (a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return {
    start,
    end,
    candidates: ranked.map(({ path, label, insert }) => ({ path, label, insert })),
  };
}
