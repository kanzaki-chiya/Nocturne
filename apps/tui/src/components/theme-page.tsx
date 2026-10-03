import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { createSessionView, type PendingPermission, type ToolEntry } from "@nocturne/core/protocol";

import { glyphs, useTuiEnv } from "../env.js";
import { palettes, ThemeContext, useTheme, type ThemeId, type ThemePalette } from "../theme.js";
import { PageFooter, PageHeader } from "./page/page-shell.js";
import { PermissionDialog } from "./permission-dialog.js";
import { StatusBar } from "./status-bar.js";
import { TodoPanel } from "./todo-panel.js";
import { EntryRow } from "./transcript.js";

const TODOS = [
  { text: "读取项目", status: "completed" as const },
  { text: "实现主题", status: "in_progress" as const },
];
const PERMISSION: PendingPermission = {
  requestId: "theme-preview",
  callId: "theme-preview",
  toolName: "shell",
  subjects: [{ kind: "shell", target: "pnpm test" }],
  reason: "",
  options: ["allow_once", "deny"],
};
const TOOL: ToolEntry = {
  kind: "tool",
  key: "theme-tool",
  turnId: "theme-turn",
  callId: "theme-tool",
  name: "edit",
  seq: 2,
  status: "ok",
  input: { path: "src/theme.ts" },
  subjects: [],
  permission: undefined,
  resolution: undefined,
  liveOutput: "",
  result: {
    status: "ok",
    modelContent: "更新配色",
    output: { diff: "@@ -1,1 +1,1 @@\n-const accent = 'old'\n+const accent = 'iris'" },
    error: undefined,
    truncated: false,
    spillPath: undefined,
    durationMs: 5,
  },
};
const VIEW = createSessionView();
VIEW.config.model = { provider: "demo", model: "sample" };
VIEW.config.permissionPreset = "default";
VIEW.todos = TODOS;

/** 示例直接复用会话条目、工具差异、权限、状态栏和 Todo 的正式组件。 */
function Preview({
  palette,
  background,
  width,
}: {
  palette: ThemePalette;
  background: string;
  width: number;
}) {
  return (
    <ThemeContext.Provider value={palette}>
      <Box flexDirection="column" width={width} backgroundColor={background} paddingX={1}>
        <Text color={palette.secondary} bold>
          {background === "#0C0C0C" ? "Campbell · 深色底" : "One Half Light · 浅色底"}
        </Text>
        <EntryRow
          entry={{
            kind: "user",
            key: "theme-user",
            seq: 1,
            turnId: "theme-turn",
            content: [{ type: "text", text: "请检查配色" }],
          }}
          width={width - 2}
        />
        <EntryRow
          entry={{
            kind: "assistant",
            key: "theme-answer",
            seq: 2,
            turnId: "theme-turn",
            messageId: "theme-answer",
            text: "# 主题预览\n\n```ts\nconst color = 'iris'\n```\n- 列表项",
            reasoning: "",
            toolCalls: [],
            model: { provider: "demo", model: "sample" },
            usage: undefined,
            finishReason: "stop",
          }}
          width={width - 2}
        />
        <EntryRow entry={TOOL} width={width - 2} />
        <PermissionDialog
          pending={PERMISSION}
          active={false}
          onReply={() => {
            throw new Error("主题预览不可操作");
          }}
          width={width - 2}
        />
        <StatusBar view={VIEW} width={width - 2} context={{ used: 1200, limit: 10000 }} />
        <TodoPanel items={TODOS} width={width - 2} height={5} />
      </Box>
    </ThemeContext.Provider>
  );
}

export function ThemePage({
  width,
  height,
  active,
  onSave,
  onCancel,
}: {
  width: number;
  height: number;
  active: boolean;
  onSave: (id: ThemeId) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const current = useTheme();
  const env = useTuiEnv();
  const [selected, setSelected] = useState<ThemeId>(current.id);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [scroll, setScroll] = useState(0);
  const palette = palettes[selected];
  const sideBySide = width >= 90;
  const cardWidth = sideBySide ? Math.floor(width / 2) : width;
  useInput(
    (_input, key) => {
      if (saving) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSelected((id) => (id === "dark" ? "light" : "dark"));
        setError(undefined);
        setScroll(0);
        return;
      }
      if (key.pageDown) {
        setScroll((n) => Math.min(n + 6, sideBySide ? 24 : 48));
        return;
      }
      if (key.pageUp) {
        setScroll((n) => Math.max(0, n - 6));
        return;
      }
      if (key.return) {
        setSaving(true);
        void onSave(selected)
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          })
          .finally(() => {
            setSaving(false);
          });
      }
    },
    { isActive: active },
  );

  const notice =
    error !== undefined
      ? { text: `保存失败：${error}`, tone: "error" as const }
      : saving
        ? { text: "正在保存…", tone: "muted" as const }
        : undefined;
  // 页头 2 行 + 选项 2 行 + 页脚（分隔线、状态、提示）3 行
  const previewHeight = Math.max(0, height - 7);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <PageHeader
        title={["主题"]}
        subtitle="选择主题：上下移动即时预览，Enter 保存为默认主题"
        width={width}
      />
      {(["dark", "light"] as const).map((id) => (
        <Text
          key={id}
          color={selected === id ? current.selected : current.secondary}
          {...(selected === id ? { backgroundColor: current.selectionBg } : {})}
        >
          {selected === id ? glyphs(env).prompt : " "} {id}
          {id === current.id ? "  当前" : ""}
        </Text>
      ))}
      <Box flexDirection="column" height={previewHeight} overflow="hidden">
        <Box flexDirection={sideBySide ? "row" : "column"} marginTop={-scroll}>
          <Preview palette={palette} background="#0C0C0C" width={cardWidth} />
          <Preview palette={palette} background="#FAFAFA" width={cardWidth} />
        </Box>
      </Box>
      <PageFooter
        width={width}
        notice={notice}
        hints={[
          ["↑↓", "预览"],
          ["Enter", "保存"],
          ["PgUp/PgDn", "翻阅示例"],
          ["Esc", "取消"],
        ]}
      />
    </Box>
  );
}
