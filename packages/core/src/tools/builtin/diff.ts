/**
 * 行级 diff（tools.md 第 6 节）：公共前后缀作上下文，中段为 -/+ 行。
 * 供 write/edit 的 output.diff 与 CLI 渲染使用；纯函数，无 I/O。
 */

/** 切分行：去掉末尾空元素（文本以换行结尾时 split 产生的尾巴） */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

const CONTEXT_LINES = 3;

/**
 * 生成 unified 风格的 diff 文本：
 *   @@ path @@
 *    上文（至多 3 行公共前缀尾部）
 *   -删除行
 *   +新增行
 *    下文（至多 3 行公共后缀头部）
 * 无变化时返回空字符串。
 */
export function diffLines(oldText: string, newText: string, path: string): string {
  if (oldText === newText) return "";
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // 公共前缀
  let p = 0;
  const limit = Math.min(oldLines.length, newLines.length);
  while (p < limit && oldLines[p] === newLines[p]) p++;
  // 公共后缀（不与前缀重叠）
  let s = 0;
  while (s < limit - p && oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]) {
    s++;
  }

  const removed = oldLines.slice(p, oldLines.length - s);
  const added = newLines.slice(p, newLines.length - s);
  const head = oldLines.slice(Math.max(0, p - CONTEXT_LINES), p);
  const tail = oldLines.slice(oldLines.length - s, oldLines.length - s + CONTEXT_LINES);

  const out: string[] = [`@@ ${path} @@`];
  for (const l of head) out.push(` ${l}`);
  for (const l of removed) out.push(`-${l}`);
  for (const l of added) out.push(`+${l}`);
  for (const l of tail) out.push(` ${l}`);
  return out.join("\n");
}
