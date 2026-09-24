/**
 * TUI 根组件（tui.md §2）：回放区（<Static> 完结前缀）+ 活动区 +
 * 权限对话框 + 弹层 + 输入行 + 状态栏。
 * 键位路由：Ctrl+C 中断/退出，Ctrl+D 退出，Esc 由弹层组件自闭。
 */
import { Box, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PermissionReply, Runtime, RuntimeSession } from "@nocturne/core";
import type { SessionView, ViewEntry } from "@nocturne/core/protocol";

import { contextLines, errText, helpLines, runSlash, type OverlayName } from "./commands.js";
import { Activity } from "./components/activity.js";
import { Composer } from "./components/composer.js";
import { Panel } from "./components/panel.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { StatusBar } from "./components/status-bar.js";
import { Transcript } from "./components/transcript.js";
import { TuiEnvContext, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";

/** 完结前缀切分：第一个未完结工具条目及其后条目留给活动区（tui.md §4） */
export function splitCompletedPrefix(entries: readonly ViewEntry[]): {
  prefix: ViewEntry[];
  tail: ViewEntry[];
} {
  const cut = entries.findIndex(
    (e) => e.kind === "tool" && (e.status === "awaiting_permission" || e.status === "running"),
  );
  if (cut < 0) return { prefix: [...entries], tail: [] };
  return { prefix: entries.slice(0, cut), tail: entries.slice(cut) };
}

export function App({
  session,
  runtime,
  env,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  env: TuiEnv;
}): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;

  const view = useSessionView(session);
  const [input, setInput] = useState("");
  const [overlay, setOverlay] = useState<OverlayName | undefined>(undefined);
  const [clientLines, setClientLines] = useState<string[]>([]);
  const [exiting, setExiting] = useState(false);

  const busy = view.status !== "idle";
  const pending = view.pendingPermission;
  const { prefix, tail } = splitCompletedPrefix(view.entries);

  const pushLine = useCallback((text: string) => {
    if (text === "") return;
    setClientLines((prev) => [...prev.slice(-19), ...text.split("\n")]);
  }, []);

  /** 退出：进行中先中断，等 Turn 收敛后再退（与 REPL close 路径同语义） */
  const requestExit = useCallback(() => {
    if (busy || pending !== undefined) {
      session.interrupt();
      setExiting(true);
      return;
    }
    exit();
  }, [busy, pending, session, exit]);

  useEffect(() => {
    if (exiting && !busy && pending === undefined) exit();
  }, [exiting, busy, pending, exit]);

  const replyPermission = useCallback(
    (reply: PermissionReply) => {
      if (pending === undefined) return;
      session.respondPermission(pending.requestId, reply).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [pending, session, pushLine],
  );

  // 全局键：Ctrl+C / Ctrl+D（弹层内的 Esc/Enter 由各弹层组件处理）
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (overlay !== undefined) {
        setOverlay(undefined);
        return;
      }
      if (pending !== undefined || busy) {
        // 权限待决/运行中：中断（权限请求结算为 cancelled）
        session.interrupt();
        return;
      }
      exit();
      return;
    }
    if (key.ctrl && ch === "d") {
      if (overlay !== undefined) {
        setOverlay(undefined);
        return;
      }
      requestExit();
    }
  });

  const onSubmit = useCallback(
    (line: string) => {
      setInput("");
      const text = line.trim();
      if (text === "") return;
      if (text.startsWith("/")) {
        void runSlash(text, session)
          .then((r) => {
            if (r.kind === "exit") requestExit();
            else if (r.kind === "overlay") setOverlay(r.name);
            else if (r.kind === "message") pushLine(r.text);
          })
          .catch((e: unknown) => {
            pushLine(`! ${errText(e)}`);
          });
        return;
      }
      session.submit({ text }).catch((e: unknown) => {
        pushLine(`! ${errText(e)}`);
      });
    },
    [session, pushLine, requestExit],
  );

  const modelItems: PickItem<string>[] = useMemo(
    () =>
      runtime.listModels().map((m) => {
        const ref = `${m.ref.provider}/${m.ref.model}`;
        const cur = view.config.model;
        return {
          label: ref + (m.displayName !== undefined ? ` — ${m.displayName}` : ""),
          hint: cur?.provider === m.ref.provider && cur.model === m.ref.model ? "当前" : "",
          value: ref,
        };
      }),
    [runtime, view.config.model],
  );

  const composerDisabled =
    pending !== undefined
      ? "等待权限确认（a/s/p/d/x）"
      : busy
        ? "会话忙，Ctrl+C 可中断"
        : overlay !== undefined
          ? "弹层打开中，Esc 关闭"
          : undefined;

  return (
    <TuiEnvContext.Provider value={env}>
      <Box flexDirection="column">
        <Transcript entries={prefix} width={width} />
        <Activity view={view} pendingEntries={tail} clientLines={clientLines} width={width} />
        {pending !== undefined ? (
          <PermissionDialog
            pending={pending}
            active={overlay === undefined}
            onReply={replyPermission}
            width={width}
          />
        ) : null}
        {overlay === "model" ? (
          <PickList
            title="选择模型"
            items={modelItems}
            active
            width={width}
            onPick={(ref) => {
              setOverlay(undefined);
              session.setModel(ref).catch((e: unknown) => {
                pushLine(`! ${errText(e)}`);
              });
            }}
            onCancel={() => {
              setOverlay(undefined);
            }}
          />
        ) : null}
        {overlay === "context" ? (
          <Panel
            title="/context"
            lines={contextLines(session)}
            active
            onClose={() => {
              setOverlay(undefined);
            }}
            width={width}
          />
        ) : null}
        {overlay === "help" ? (
          <Panel
            title="/help"
            lines={helpLines()}
            active
            onClose={() => {
              setOverlay(undefined);
            }}
            width={width}
          />
        ) : null}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          active={overlay === undefined && pending === undefined}
          disabledReason={composerDisabled}
        />
        <StatusBar view={view} sessionId={session.id} width={width} />
      </Box>
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
