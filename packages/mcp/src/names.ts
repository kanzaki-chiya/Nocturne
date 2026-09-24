/**
 * MCP 工具名 → 注册表合法名（mcp.md 第 4 节）。
 * 注册表接受 `^[a-z][a-z0-9_]*(?:__[a-z0-9_]+)*$`：
 * `mcp__<server>__<tool>` 的每段只允许 [a-z0-9_]，非法字符折叠为下划线。
 */

/** 段内字符归一化；结果为空时给占位符，保证非空段 */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return cleaned === "" ? "x" : cleaned;
}

/** 服务器/工具名 → 注册名；与同服务器既有名冲突时追加 _2/_3… */
export function mcpToolName(server: string, tool: string, taken: ReadonlySet<string>): string {
  const base = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
