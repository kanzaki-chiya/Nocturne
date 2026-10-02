import path from "node:path";
import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import type { RewindMode, RewindTarget } from "@nocturne/core/protocol";
import { boxSafe, truncateLine } from "../format.js";
import { relativeTime } from "../resume-label.js";
import { useTheme } from "../theme.js";
import { Buttons } from "./dialog/buttons.js";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";

const ACTIONS = [
  ["both", "对话和文件一起回退"],
  ["conversation", "只回退对话"],
  ["files", "只还原文件"],
  ["fork", "从这里分叉新会话"],
  ["cancel", "取消"],
] as const;
type Operation = RewindMode | "fork";

export function RewindPage({
  targets,
  cwd,
  width,
  height,
  onClose,
  onRewind,
  onFork,
  onMouseFrame,
}: {
  targets: readonly RewindTarget[];
  /** 会话工作目录：预览里工作区内的路径按相对路径显示 */
  cwd: string;
  width: number;
  height: number;
  onClose: () => void;
  onRewind: (target: RewindTarget, mode: RewindMode) => Promise<void>;
  onFork: (target: RewindTarget) => Promise<void>;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [state, setState] = useState({
    cursor: 0,
    stage: "list" as "list" | "actions" | "preview",
    focus: "cancel",
    offset: 0,
  });
  const current = useRef(state);
  const [operation, setOperation] = useState<Operation>("conversation");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const boxes = useRef(new Map<string, DOMElement>());
  const scrollBox = useRef<DOMElement>(null);
  const change = (next: typeof state) => {
    current.current = next;
    setState(next);
  };
  const target = targets[state.cursor];
  const restorable = target?.files.some((file) => file.action !== "untracked") === true;
  const disabled = (id: string) => !restorable && (id === "both" || id === "files");
  const small = width < 12 || height < 8;
  const listRows = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(state.cursor - listRows + 1, targets.length - listRows));
  const framed = width >= 28 && height >= 12;
  const dialogWidth = framed ? Math.min(80, width - 4) : width;
  const dialogHeight =
    state.stage === "actions" ? Math.min(height, restorable ? 11 : 12) : Math.min(height, 18);
  const inner = Math.max(1, dialogWidth - (framed ? 4 : 0));
  const previewRows = Math.max(1, dialogHeight - (framed ? 6 : 4) - (error ? 1 : 0));
  const lines =
    target === undefined
      ? []
      : operation === "fork"
        ? ["文件保持当前状态；需要文件也回到那一轮，", "可在原会话里对同一轮执行「只还原文件」。"]
        : [
            ...target.files.map(
              (file) =>
                `${file.action === "restore" ? "还原" : file.action === "delete" ? "删除" : `无法还原（${file.reason ?? "未追踪"}）`} ${displayPath(file.path, cwd)}${file.external ? " [已在外部修改]" : ""}`,
            ),
            ...(target.untrackedCalls > 0
              ? [
                  `这一轮之后有 ${target.untrackedCalls} 次 shell/MCP 调用，它们造成的改动不会被还原`,
                ]
              : []),
            ...(operation === "conversation" ? ["文件保持当前状态"] : []),
          ];
  const activate = (id: string): void => {
    if (working.current || disabled(id)) return;
    const s = current.current;
    if (s.stage === "list") {
      const cursor = Number(id);
      if (!targets[cursor]) return;
      change({
        ...s,
        cursor,
        stage: cursor === s.cursor ? "actions" : "list",
        focus: "cancel",
        offset: 0,
      });
    } else if (id === "cancel") {
      setError(undefined);
      change({
        ...s,
        stage: s.stage === "preview" ? "actions" : "list",
        focus: "cancel",
        offset: 0,
      });
    } else if (s.stage === "actions") {
      setOperation(id as Operation);
      change({ ...s, stage: "preview", focus: "cancel", offset: 0 });
    } else if (id === "confirm" && target) {
      working.current = true;
      setBusy(true);
      void (operation === "fork" ? onFork(target) : onRewind(target, operation))
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          working.current = false;
          setBusy(false);
        });
    }
  };
  const move = (amount: number): void => {
    const s = current.current;
    if (s.stage === "list")
      change({ ...s, cursor: Math.max(0, Math.min(targets.length - 1, s.cursor + amount)) });
    else if (s.stage === "preview")
      change({
        ...s,
        offset: Math.max(0, Math.min(Math.max(0, lines.length - previewRows), s.offset + amount)),
      });
  };
  useInput((input, key) => {
    if (working.current) return;
    const s = current.current;
    if (key.escape) {
      if (s.stage === "list") onClose();
      else activate("cancel");
      return;
    }
    if (small) return;
    if (key.pageUp || key.pageDown) {
      move((key.pageUp ? -1 : 1) * (s.stage === "list" ? listRows : previewRows));
      return;
    }
    if (s.stage === "list") {
      if (key.upArrow || key.downArrow) move(key.upArrow ? -1 : 1);
      else if (key.home || key.end) move(key.home ? -targets.length : targets.length);
      else if (key.return && targets[s.cursor]) activate(String(s.cursor));
    } else if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      const order: string[] =
        s.stage === "actions"
          ? ACTIONS.map(([id]) => id).filter((id) => !disabled(id))
          : ["cancel", "confirm"];
      const backwards = key.upArrow || key.leftArrow || (key.tab && key.shift);
      change({
        ...s,
        focus:
          order[(order.indexOf(s.focus) + (backwards ? -1 : 1) + order.length) % order.length] ??
          "cancel",
      });
    } else if (key.return || input === " ") activate(s.focus);
  });
  const onBox = (id: string, node: DOMElement | null): void => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };
  useEffect(() => {
    if (!onMouseFrame) return;
    onMouseFrame({
      layer: `rewind-${state.stage}`,
      boxes:
        small || busy
          ? []
          : [...boxes.current].flatMap(([id, node]) => {
              if (disabled(id)) return [];
              const rect = screenRect(node);
              return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
            }),
      click: activate,
      wheel: (event) => {
        if (working.current || current.current.stage === "actions" || !scrollBox.current) return;
        const rect = screenRect(scrollBox.current);
        if (
          event.x >= rect.col &&
          event.x < rect.col + rect.width &&
          event.y >= rect.row &&
          event.y < rect.row + rect.height
        )
          move(event.dir === "up" ? -3 : 3);
      },
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  if (state.stage === "list")
    return (
      <Box width={width} height={height} flexDirection="column" overflow="hidden">
        <Text bold color={theme.accent}>
          /rewind 轮次列表
        </Text>
        <Box ref={scrollBox} flexDirection="column" flexGrow={1} overflow="hidden">
          {small ? (
            <Text>终端太小，请放大 · Esc 返回</Text>
          ) : targets.length === 0 ? (
            <Text>当前没有可回退的轮次</Text>
          ) : (
            targets.slice(start, start + listRows).map((item, i) => (
              <Box
                key={item.seq}
                ref={(node) => {
                  onBox(String(start + i), node);
                }}
                width={width}
                flexShrink={0}
              >
                <Text
                  wrap="truncate"
                  {...(start + i === state.cursor ? { color: theme.accent } : {})}
                >
                  {start + i === state.cursor ? "› " : "  "}
                  {truncateLine(
                    boxSafe(item.firstLine),
                    Math.max(1, width - (item.untrackedCalls ? 46 : 34)),
                  )}{" "}
                  · {relativeTime(Date.parse(item.time))} · 改动 {item.files.length} 个文件
                  {item.untrackedCalls ? " · 含 shell" : ""}
                </Text>
              </Box>
            ))
          )}
        </Box>
        <Text color={theme.muted} wrap="truncate">
          ↑↓ 选择 · Enter 操作 · Esc 返回
        </Text>
      </Box>
    );
  return (
    <Box
      width={width}
      height={height}
      paddingLeft={Math.max(0, Math.floor((width - dialogWidth) / 2))}
      paddingTop={Math.max(0, Math.floor((height - dialogHeight) / 2))}
    >
      <DialogFrame
        title={
          state.stage === "actions"
            ? "回退到这一轮之前"
            : operation === "fork"
              ? "确认分叉新会话"
              : "确认回退"
        }
        width={dialogWidth}
        height={dialogHeight}
        framed={framed}
      >
        {small ? (
          <Text>终端太小，请放大 · Esc 返回</Text>
        ) : (
          <>
            <Text wrap="truncate">{boxSafe(target?.firstLine ?? "")}</Text>
            <Box ref={scrollBox} flexDirection="column" flexGrow={1} overflow="hidden">
              {state.stage === "actions" ? (
                <>
                  {ACTIONS.map(([id, label]) =>
                    disabled(id) ? (
                      <Text key={id} color={theme.muted}>
                        [ {label} ]（不可用）
                      </Text>
                    ) : (
                      <Buttons
                        key={id}
                        focused={state.focus}
                        readonly={busy}
                        width={inner}
                        items={[[id, label]]}
                        onBox={onBox}
                      />
                    ),
                  )}
                  {!restorable ? (
                    <Text color={theme.muted} wrap="truncate">
                      这一轮之后没有可还原的文件
                    </Text>
                  ) : null}
                </>
              ) : (
                lines.slice(state.offset, state.offset + previewRows).map((line, i) => (
                  <Text key={state.offset + i} wrap="truncate">
                    {boxSafe(line)}
                  </Text>
                ))
              )}
            </Box>
            {error ? (
              <Text color={theme.warning} wrap="truncate">
                ! {boxSafe(error)}
              </Text>
            ) : null}
            {state.stage === "preview" ? (
              <Buttons
                focused={state.focus}
                readonly={busy}
                width={inner}
                items={[
                  ["cancel", "取消"],
                  ["confirm", operation === "fork" ? "分叉" : "回退"],
                ]}
                onBox={onBox}
              />
            ) : null}
            <Text color={theme.muted} wrap="truncate">
              {busy ? "正在执行，请稍候" : "↑↓/Tab 移动 · PgUp/PgDn 翻页 · Enter 确认 · Esc 返回"}
            </Text>
          </>
        )}
      </DialogFrame>
    </Box>
  );
}

/** 工作区内的文件显示相对路径，避免长绝对路径把「已在外部修改」标记挤出行尾 */
export function displayPath(file: string, cwd: string): string {
  if (cwd === "") return file;
  const rel = path.relative(cwd, file);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}
