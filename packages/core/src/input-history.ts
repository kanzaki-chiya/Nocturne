import type { Platform } from "./platform/index.js";
import { fsErrorCode } from "./platform/fs.js";

interface HistoryRow {
  text: string;
  workspaceRoot: string;
  time: string;
}

const LIMIT = 1000;

export async function readInputHistory(
  platform: Platform,
  home: string,
  workspaceRoot: string,
): Promise<string[]> {
  const rows = await readRows(platform, home);
  return rows
    .filter((row) => platform.paths.equals(row.workspaceRoot, workspaceRoot))
    .map((row) => row.text);
}

export async function appendInputHistory(
  platform: Platform,
  home: string,
  workspaceRoot: string,
  text: string,
): Promise<void> {
  const rows = await readRows(platform, home);
  const previous = rows.findLast((row) => platform.paths.equals(row.workspaceRoot, workspaceRoot));
  if (previous?.text === text) return;

  const file = platform.paths.join(home, "history.jsonl");
  await platform.fs.mkdir(home, { mode: 0o700 });
  const row = { text, workspaceRoot, time: new Date().toISOString() };
  // 明文输入历史：新建即 0600，与满额截断重写（下方 writeFile）一致
  await platform.fs.appendFile(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  if (rows.length < LIMIT) return;

  // ponytail: 满额后每次重写 1000 条；历史量上限固定，若放宽上限再改增量压缩。
  const latest = [...rows, row].slice(-LIMIT);
  const temp = `${file}.${platform.pid()}.${Date.now()}.tmp`;
  try {
    await platform.fs.writeFile(temp, latest.map((row) => JSON.stringify(row)).join("\n") + "\n", {
      mode: 0o600,
    });
    await platform.fs.rename(temp, file);
  } finally {
    await platform.fs.unlink(temp).catch(() => undefined);
  }
}

async function readRows(platform: Platform, home: string): Promise<HistoryRow[]> {
  let content: string;
  try {
    content = await platform.fs.readTextFile(platform.paths.join(home, "history.jsonl"));
  } catch (e) {
    if (fsErrorCode(e) === "ENOENT") return [];
    throw e;
  }
  return content.split("\n").flatMap((line) => {
    if (line === "") return [];
    try {
      const row: unknown = JSON.parse(line);
      if (typeof row !== "object" || row === null) return [];
      const { text, workspaceRoot, time } = row as Partial<HistoryRow>;
      return typeof text === "string" &&
        typeof workspaceRoot === "string" &&
        typeof time === "string"
        ? [{ text, workspaceRoot, time }]
        : [];
    } catch {
      return [];
    }
  });
}
