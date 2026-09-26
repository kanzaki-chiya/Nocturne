/**
 * 旧版大欢迎框。全屏壳改用 welcome.ts 的紧凑行（ADR-0020），本组件不再挂到主界面。
 * 启动欢迎框（tui.md §2，ADR-0019 第 5 条）：主屏 <Static> 区只画一次。
 * 左栏：像素 Logo + 欢迎回来 + 当前模型与服务商 + 会话 id；
 * 右栏三块：操作提示 / MCP 服务器状态（失败标红附原因）/ 最近会话 ≤3。
 * <80 列降级单栏；<40 列由调用方整体跳过。
 */
import { Box, Text } from "ink";

import type { McpServerStatus, SessionSummary } from "@nocturne/core";

import { useTuiEnv } from "../env.js";
import { boxSafe, truncateLine } from "../format.js";
import { theme } from "../theme.js";
import { PixelLogo } from "./pixel-logo.js";

const HINTS: readonly string[] = [
  "/ 命令（/help 列出全部）",
  "Shift+Tab 切换思考档位",
  "Ctrl+C 中断 / 退出",
];

function mcpLine(s: McpServerStatus): { text: string; failed: boolean } {
  const failed = s.state === "failed" || s.state === "crashed";
  const tools = s.state === "ready" ? ` • ${s.toolCount} 个工具` : "";
  const reason = s.error !== undefined ? ` • ${s.error}` : "";
  return { text: `${s.name} • ${s.state}${tools}${reason}`, failed };
}

function sessionTime(iso: string): string {
  // "2026-09-25T13:45:12.345Z" → "09-25 13:45"
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m === null ? iso.slice(0, 16) : `${m[1]}-${m[2]} ${m[3]}:${m[4]}`;
}

function RightBlocks({
  mcp,
  recents,
  width,
}: {
  mcp: readonly McpServerStatus[];
  recents: readonly SessionSummary[];
  width: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={theme.accent}>
        操作提示
      </Text>
      {HINTS.map((h) => (
        <Text key={h} wrap="truncate" color={theme.muted}>
          {truncateLine(`  ${h}`, Math.max(1, width - 1))}
        </Text>
      ))}
      <Text bold color={theme.accent}>
        MCP 服务器
      </Text>
      {mcp.length === 0 ? (
        <Text wrap="truncate" color={theme.muted}>
          {"  （未配置）"}
        </Text>
      ) : (
        mcp.map((s) => {
          const l = mcpLine(s);
          return (
            <Text key={s.name} wrap="truncate" color={l.failed ? theme.error : theme.muted}>
              {truncateLine(`  ${boxSafe(l.text)}`, Math.max(1, width - 1))}
            </Text>
          );
        })
      )}
      <Text bold color={theme.accent}>
        最近会话
      </Text>
      {recents.length === 0 ? (
        <Text wrap="truncate" color={theme.muted}>
          {"  （无）"}
        </Text>
      ) : (
        recents.slice(0, 3).map((s) => (
          <Text key={s.id} wrap="truncate" color={theme.muted}>
            {truncateLine(
              `  ${s.id.slice(0, 13)}  ${sessionTime(s.createdAt)}  ${boxSafe(s.firstText ?? "")}`,
              Math.max(1, width - 1),
            )}
          </Text>
        ))
      )}
    </Box>
  );
}

export function WelcomeBox({
  model,
  sessionId,
  mcp,
  recents,
  width,
}: {
  /** "provider/model" 全形文本（当前会话模型） */
  model: string;
  sessionId: string;
  mcp: readonly McpServerStatus[];
  recents: readonly SessionSummary[];
  width: number;
}): React.JSX.Element | null {
  const env = useTuiEnv();
  if (width < 40) return null;
  const twoCol = width >= 80;
  const leftW = twoCol ? Math.min(50, Math.max(30, Math.floor(width * 0.55))) : width - 2;
  const rightW = Math.max(20, width - leftW - 4);

  const left = (
    <Box flexDirection="column" width={leftW}>
      <PixelLogo />
      <Text color={theme.accentAlt} bold>
        欢迎回来
      </Text>
      <Text wrap="truncate">{truncateLine(`模型：${model}`, leftW - 1)}</Text>
      <Text wrap="truncate" color={theme.muted}>
        {truncateLine(`会话：${sessionId}`, leftW - 1)}
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      {twoCol ? (
        <Box flexDirection="row">
          {left}
          <Box width={2} />
          <RightBlocks mcp={mcp} recents={recents} width={rightW} />
        </Box>
      ) : (
        <Box flexDirection="column">
          {left}
          <RightBlocks mcp={mcp} recents={recents} width={leftW} />
        </Box>
      )}
      <Text color={theme.muted} wrap="truncate">
        {(env.ascii ? "-" : "─").repeat(Math.min(width, 78))}
      </Text>
    </Box>
  );
}
