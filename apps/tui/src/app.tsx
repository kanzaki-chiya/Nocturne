/**
 * TUI 骨架（tui.md）：回放区 + 状态栏的最小形态。
 * 视图组件（Transcript/ToolRow/PermissionDialog/…）在后续提交落地；
 * 这里先验证 SessionView 接线与退出路径。
 */
import { useApp, useInput, Box, Text } from "ink";
import { useEffect, useReducer, useState } from "react";

import type { RuntimeSession } from "@nocturne/core";
import {
  createSessionView,
  reduceSessionView,
  replaySessionView,
  type SessionView,
} from "@nocturne/core/protocol";

/** 重放持久日志后订阅实时事件——所有客户端共享的同一会话视图（view.md §6） */
export function useSessionView(session: RuntimeSession): SessionView {
  const [view] = useState<SessionView>(() => {
    try {
      return replaySessionView(session.session.durableEvents());
    } catch {
      return createSessionView();
    }
  });
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(
    () =>
      session.subscribe((event) => {
        reduceSessionView(view, event);
        bump();
      }),
    [session, view],
  );
  return view;
}

export function App({ session }: { session: RuntimeSession }): React.JSX.Element {
  const { exit } = useApp();
  const view = useSessionView(session);
  const meta = view.meta;
  const model = view.config.model;
  useInput((input, key) => {
    // 骨架阶段还没有 Turn 提交路径，Ctrl+C/Ctrl+D 直接退出
    if (key.ctrl && (input === "c" || input === "d")) exit();
  });
  return (
    <Box flexDirection="column">
      <Text>
        Nocturne TUI — 会话 {session.id}
        {model !== undefined ? `（${model.provider}/${model.model}）` : ""}
      </Text>
      <Text dimColor>
        骨架：视图组件在后续提交落地。Ctrl+C / Ctrl+D 退出。
        {meta !== undefined ? ` cwd: ${meta.cwd}` : ""} revision: {view.revision}
      </Text>
    </Box>
  );
}
