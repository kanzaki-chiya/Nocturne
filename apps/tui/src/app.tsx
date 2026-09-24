/**
 * TUI 根组件（tui.md §2）：回放区（<Static> 完结前缀）+ 活动区 +
 * 权限对话框 + 弹层 + 输入行 + 状态栏。
 * 键位路由：Ctrl+C 中断/退出，Ctrl+D 退出，Esc 由弹层组件自闭。
 * /resume：注入的 switchSession 回调执行切换；旧回放冻结进 Static，
 * 新会话重建 SessionView 重放（tui.md §4）。
 */
import { Box, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PermissionReply, Runtime, RuntimeSession, SessionSummary } from "@nocturne/core";
import type { SessionView, ViewEntry } from "@nocturne/core/protocol";

import {
  contextLines,
  errText,
  helpLines,
  runSlash,
  sessionNotes,
  type OverlayName,
} from "./commands.js";
import { Activity } from "./components/activity.js";
import { Composer } from "./components/composer.js";
import { ConfirmBox } from "./components/confirm-box.js";
import { Panel } from "./components/panel.js";
import { PermissionDialog } from "./components/permission-dialog.js";
import { PickList, type PickItem } from "./components/pick-list.js";
import { StatusBar } from "./components/status-bar.js";
import { Transcript, type TranscriptItem } from "./components/transcript.js";
import { TuiEnvContext, type TuiEnv } from "./env.js";
import { useSessionView } from "./session-view.js";
import type { SwitchSessionFn } from "./types.js";

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
  session: initialSession,
  runtime,
  env,
  switchSession,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  env: TuiEnv;
  switchSession?: SwitchSessionFn | undefined;
}): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout.columns || 80;

  // /resume 切换：session 变为新会话（useSessionView 自动重放新日志）
  const [session, setSession] = useState(initialSession);
  const view = useSessionView(session);
  const [input, setInput] = useState("");
  const [overlay, setOverlay] = useState<OverlayName | undefined>(undefined);
  const [clientLines, setClientLines] = useState<string[]>([]);
  const [exiting, setExiting] = useState(false);
  /** 已冻结进滚动区的回放（旧会话的完结前缀 + 切换分隔线） */
  const [frozen, setFrozen] = useState<TranscriptItem[]>([]);
  /** /resume 弹层的会话清单（打开弹层时拉取） */
  const [resumeList, setResumeList] = useState<readonly SessionSummary[] | undefined>(undefined);
  /** /resume 跨目录确认（foreign → 用户确认后带 allowForeign 重试） */
  const [foreign, setForeign] = useState<{ id: string; root: string } | undefined>(undefined);

  const busy = view.status !== "idle";
  const pending = view.pendingPermission;
  const { prefix, tail } = splitCompletedPrefix(view.entries);
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const transcriptItems = useMemo(() => [...frozen, ...prefix], [frozen, prefix]);

  const pushLine = useCallback((text: string) => {
    if (text === "") return;
    setClientLines((prev) => [...prev.slice(-19), ...text.split("\n")]);
  }, []);

  // 初始会话的打开提示（恢复修复摘要等）进提示区——与切换路径同口径；
  // --tui 下 main.ts 不再向 stderr 预打印，避免双份
  useEffect(() => {
    for (const n of sessionNotes(initialSession)) pushLine(`! ${n}`);
  }, [initialSession, pushLine]);

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

  /** 会话切换：冻结旧回放进 Static、换绑 session、新日志重放进 SessionView */
  const doSwitch = useCallback(
    async (id: string, allowForeign = false): Promise<void> => {
      if (switchSession === undefined) {
        pushLine("! 当前环境不支持会话切换");
        return;
      }
      const res = await switchSession(id, { allowForeign });
      if (res.kind === "ok") {
        const sep: TranscriptItem = {
          kind: "separator",
          key: `sw-${res.session.id}`,
          text: `已切换到会话 ${res.session.id}`,
        };
        // 切换只会发生在空闲时（busy 被拦截）：prefix 即旧会话全部条目
        setFrozen([...prefixRef.current, sep]);
        setSession(res.session);
        setOverlay(undefined);
        for (const n of sessionNotes(res.session)) pushLine(`! ${n}`);
        return;
      }
      if (res.kind === "foreign") {
        setForeign({ id, root: res.workspaceRoot });
        return;
      }
      pushLine(
        res.kind === "busy" ? "! 会话忙（Turn 进行中）；先 Ctrl+C 中断再切换" : `! ${res.message}`,
      );
    },
    [switchSession, pushLine],
  );

  useEffect(() => {
    if (overlay === "resume") {
      setResumeList(undefined);
      runtime
        .listSessions()
        .then((rows) => {
          setResumeList([...rows].sort((a, b) => b.mtimeMs - a.mtimeMs));
        })
        .catch((e: unknown) => {
          pushLine(`! ${errText(e)}`);
          setOverlay(undefined);
        });
    }
  }, [overlay, runtime, pushLine]);

  const dialogOpen = overlay !== undefined || foreign !== undefined;

  // 全局键：Ctrl+C / Ctrl+D（弹层内的 Esc/Enter 由各弹层组件处理）
  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (foreign !== undefined) {
        setForeign(undefined);
        return;
      }
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
      if (foreign !== undefined) {
        setForeign(undefined);
        return;
      }
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
            else if (r.kind === "switch") void doSwitch(r.id);
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
    [session, pushLine, requestExit, doSwitch],
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
        : dialogOpen
          ? "弹层打开中，Esc 关闭"
          : undefined;

  const resumeItems: PickItem<string>[] = (resumeList ?? []).map((s) => ({
    label: `${s.id}  ${s.createdAt}  ${s.model.provider}/${s.model.model}  ${s.workspaceRoot}`,
    hint: `${s.locked === true ? "locked " : ""}${s.id === session.id ? "当前" : ""}`.trim(),
    value: s.id,
  }));

  return (
    <TuiEnvContext.Provider value={env}>
      <Box flexDirection="column">
        <Transcript entries={transcriptItems} width={width} />
        <Activity view={view} pendingEntries={tail} clientLines={clientLines} width={width} />
        {pending !== undefined ? (
          <PermissionDialog
            pending={pending}
            active={!dialogOpen}
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
        {overlay === "resume" ? (
          <PickList
            title="切换到会话"
            items={resumeItems}
            active
            width={width}
            onPick={(id) => {
              setOverlay(undefined);
              void doSwitch(id);
            }}
            onCancel={() => {
              setOverlay(undefined);
            }}
          />
        ) : null}
        {foreign !== undefined ? (
          <ConfirmBox
            title={`会话绑定到 ${foreign.root}`}
            detail="与当前目录不同"
            active={overlay === undefined}
            width={width}
            onConfirm={() => {
              const f = foreign;
              setForeign(undefined);
              void doSwitch(f.id, true);
            }}
            onCancel={() => {
              setForeign(undefined);
              pushLine("! 已取消切换");
            }}
          />
        ) : null}
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          active={!dialogOpen && pending === undefined}
          disabledReason={composerDisabled}
        />
        <StatusBar view={view} sessionId={session.id} width={width} />
      </Box>
    </TuiEnvContext.Provider>
  );
}

export type { SessionView };
