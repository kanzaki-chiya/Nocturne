import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ToolEntry, TurnChangeDiff } from "@nocturne/core/protocol";
import { RpcError, type ContextSummary, type RpcSession } from "@nocturne/rpc/client";
import type { AttachmentImageSource } from "../attachment-images";
import { DiffBody } from "../Conversation";
import { ContextPanel, contextRows, number, percent, segmentWidths } from "../context-panel";
import type { CodeViewer } from "../code-viewer";
import { displayPath } from "../paths";
import { collectChanges } from "../side-panel";
import { SubagentDirectory } from "../subagent-directory";
import { elapsedText, runningBuiltin, runningMs, unsettledBuiltinTasks } from "../subagent-panel";
import { SubagentPane } from "../SubagentPane";
import { SubagentWatcher } from "../subagent-watch";
import { Button, Icon, IconButton } from "../ui";
import { useNow } from "../use-now";
import { useSessionRefresh } from "../use-session-refresh";
import { IconBack } from "./icons";
import { PhoneTasks } from "./PhoneTasks";
import type { PhoneContextSource } from "./SessionHeaderTools";
import type { PhoneSession } from "./sessions";
import "../side-panel.css";
import "./phone-side-panel.css";

export type PhonePanelPage =
  | { kind: "overview" | "context" | "changes" | "files" }
  | { kind: "subagent"; childSessionId: string }
  | { kind: "shell"; taskId: string };

interface Props {
  entry: PhoneSession;
  page: PhonePanelPage;
  connected: boolean;
  context: PhoneContextSource;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
  onNavigate: (page: PhonePanelPage) => void;
  onBack: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  loadDiff: (seq: number, path: string) => Promise<TurnChangeDiff>;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function PhoneChanges({ entry, loadDiff, onError }: Pick<Props, "entry" | "loadDiff" | "onError">) {
  const items = collectChanges(
    entry.turnChanges.values(),
    entry.view.entries.flatMap((item) => (item.kind === "user" ? [item.seq] : [])),
  );
  const [expanded, setExpanded] = useState<string>();
  const [diff, setDiff] = useState<TurnChangeDiff>();
  const selected = items.find((item) => item.key === expanded);
  useEffect(() => {
    setDiff(undefined);
    if (!selected || selected.unavailable) return;
    let active = true;
    void loadDiff(selected.seq, selected.path).then(
      (result) => {
        if (active) setDiff(result);
      },
      (cause: unknown) => {
        if (active) onError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [selected?.key, selected?.added, selected?.removed, selected?.unavailable, loadDiff, onError]);
  return (
    <div className="phone-panel-files">
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {items[index - 1]?.seq !== item.seq && (
            <div className="phone-panel-turn">第 {item.round} 轮</div>
          )}
          <button
            type="button"
            className="phone-panel-file"
            aria-expanded={expanded === item.key}
            onClick={() => {
              setExpanded(expanded === item.key ? undefined : item.key);
            }}
          >
            <span className="phone-panel-path">
              {displayPath(item.path, entry.workspace).replaceAll("\\", "/")}
            </span>
            <span className="diff-add">+{item.added}</span>
            <span className="diff-del">−{item.removed}</span>
          </button>
          {expanded === item.key && diff && (
            <div className="phone-panel-diff">
              <DiffBody diff={diff.diff} path={item.path} wrap />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function PhoneFiles({
  session,
  connected,
  onError,
}: {
  session: RpcSession;
  connected: boolean;
  onError: Props["onError"];
}) {
  const [files, setFiles] = useState<Awaited<ReturnType<RpcSession["fileIndex"]>>>([]);
  const [path, setPath] = useState<string>();
  const [content, setContent] = useState<Awaited<ReturnType<RpcSession["readFile"]>>>();
  const [bytes, setBytes] = useState<number>();
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!connected) return;
    let active = true;
    void session.fileIndex().then(
      (result) => {
        if (active) setFiles(result);
      },
      (cause: unknown) => {
        if (active) onError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [session, connected, onError]);
  useEffect(() => {
    setContent(undefined);
    setBytes(undefined);
    if (!path || !connected) return;
    let active = true;
    void session.readFile(path).then(
      (result) => {
        if (!active) return;
        setContent(result);
        setBytes(result.bytes);
      },
      (cause: unknown) => {
        if (!active) return;
        if (
          cause instanceof RpcError &&
          (cause.code === "file_too_large" || cause.code === "file_binary") &&
          cause.bytes !== undefined
        )
          setBytes(cause.bytes);
        else onError(errorText(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [session, path, connected, onError]);
  useEffect(() => {
    if (content?.kind !== "text" || !path || !parent.current) return;
    let active = true;
    let viewer: CodeViewer | undefined;
    const node = parent.current;
    void import("../code-viewer")
      .then(({ mountCodeViewer }) => mountCodeViewer(node, { text: content.text, path }))
      .then((result) => {
        if (active) viewer = result;
        else result.destroy();
      })
      .catch((cause: unknown) => {
        if (active) onError(errorText(cause));
      });
    return () => {
      active = false;
      viewer?.destroy();
    };
  }, [content, path, onError]);
  return (
    <div className="phone-panel-file-view">
      <div className="phone-panel-file-list">
        {files
          .filter((file) => file.kind === "file")
          .map((file) => (
            <button
              key={file.path}
              type="button"
              className="phone-panel-file"
              aria-pressed={file.path === path}
              onClick={() => {
                setPath(file.path);
              }}
            >
              <Icon name="file" size={16} />
              <span className="phone-panel-path">{file.path}</span>
            </button>
          ))}
      </div>
      {path && (
        <div className="phone-panel-reader">
          <div className="phone-panel-file-name">
            <span className="phone-panel-path">{path}</span>
            {bytes !== undefined && <span>{number.format(bytes)} B</span>}
          </div>
          <div className="phone-panel-code" ref={parent} />
        </div>
      )}
    </div>
  );
}

export function PhoneSidePanel({
  entry,
  page,
  connected,
  context,
  images,
  openUrl,
  onNavigate,
  onBack,
  onClose,
  onError,
  loadDiff,
}: Props) {
  const { session, view } = entry;
  const [summary, setSummary] = useState<ContextSummary>();
  const [directory] = useState(() => new SubagentDirectory());
  const [watcher] = useState(() => new SubagentWatcher());
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useSyncExternalStore(directory.subscribe, directory.getVersion);
  const runtime = connected ? entry.client.runtime : undefined;
  const now = useNow(visible && connected);
  const callbacks = useRef({ onError, onClose, loadDiff });
  callbacks.current = { onError, onClose, loadDiff };
  const [stableError] = useState(() => (message: string) => {
    callbacks.current.onError(message);
  });
  const [stableDiff] = useState(
    () => (seq: number, path: string) => callbacks.current.loadDiff(seq, path),
  );
  const refresh = useSessionRefresh(
    context.load,
    connected && context.replaying !== true,
    async (isCurrent) => {
      await context.load().then(
        (result) => {
          if (isCurrent()) setSummary(result);
        },
        (cause: unknown) => {
          if (isCurrent()) stableError(errorText(cause));
        },
      );
    },
  );
  useEffect(() => {
    void refresh();
  }, [refresh, context.key, context.replaying]);
  useEffect(() => {
    directory.setContext({
      runtime,
      sessionId: session.id,
      visible,
      settingsOpen: false,
      pollNeeded: unsettledBuiltinTasks(view) > 0,
    });
  });
  useEffect(
    () =>
      entry.client.onEvent((id, event) => {
        if (
          id === session.id &&
          (event.type === "tool.started" ||
            event.type === "tool.progress" ||
            event.type === "tool.completed")
        )
          directory.trigger();
      }),
    [entry.client, session.id, directory],
  );
  useEffect(() => {
    const changed = () => {
      setVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
    };
  }, []);
  useEffect(
    () => () => {
      directory.dispose();
      watcher.dispose();
    },
    [directory, watcher],
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") callbacks.current.onClose();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, []);

  const agents = runningBuiltin(directory.summaries);
  const shells = view.backgroundShells.filter(
    (task) => !task.endedAt || now - Date.parse(task.endedAt) < 300_000,
  );
  const selectedAgent =
    page.kind === "subagent"
      ? directory.summaries.find((item) => item.childSessionId === page.childSessionId)
      : undefined;
  const selectedShell =
    page.kind === "shell"
      ? view.backgroundShells.find((item) => item.taskId === page.taskId)
      : undefined;
  const rows = summary ? contextRows(summary.report) : [];
  const widths = summary ? segmentWidths(summary.report, rows) : new Map<string, number>();
  const time = selectedAgent
    ? elapsedText(selectedAgent.durationMs ?? runningMs(selectedAgent.startedAt, now) ?? 0)
    : selectedShell
      ? elapsedText(
          Math.max(
            0,
            Date.parse(selectedShell.endedAt ?? new Date(now).toISOString()) -
              Date.parse(selectedShell.startedAt),
          ),
        )
      : undefined;
  const title =
    page.kind === "context"
      ? "上下文"
      : page.kind === "changes"
        ? "变更"
        : page.kind === "files"
          ? "文件"
          : page.kind === "subagent"
            ? selectedAgent !== undefined && selectedAgent.profile.length > 0
              ? selectedAgent.profile
              : "子代理"
            : (selectedShell?.name ?? "后台任务");

  return (
    <div className="phone-panel-layer">
      <button
        type="button"
        className="phone-panel-scrim"
        aria-label="关闭侧边栏"
        onClick={onClose}
      />
      <aside id="phone-side-panel" className="phone-side-panel" aria-label="侧边栏">
        {page.kind === "overview" ? (
          <div className="phone-panel-overview">
            <section className="phone-panel-section">
              <h2>上下文</h2>
              <button
                type="button"
                className="phone-panel-context"
                aria-label="上下文"
                onClick={() => {
                  onNavigate({ kind: "context" });
                }}
              >
                <span className="phone-panel-context-main">
                  <span className="phone-panel-context-total">
                    <b>
                      {summary
                        ? `${percent(summary.report.estimatedTokens, summary.report.budgetTokens) ?? 0}%`
                        : "—"}
                    </b>
                    <span>
                      {summary &&
                        `${number.format(summary.report.estimatedTokens)} / ${number.format(summary.report.budgetTokens)} tokens`}
                    </span>
                  </span>
                  <span className="context-stack" aria-label="上下文组成">
                    {rows
                      .filter((row) => !row.group)
                      .map((row) => (
                        <i
                          key={row.key}
                          style={{ width: `${widths.get(row.key) ?? 0}%`, background: row.color }}
                        />
                      ))}
                  </span>
                </span>
                <Icon name="right_small" size={16} />
              </button>
            </section>
            {agents.length > 0 && (
              <section className="phone-panel-section">
                <h2>子代理</h2>
                {agents.map((item) => (
                  <button
                    type="button"
                    className="phone-panel-row"
                    key={item.childSessionId}
                    onClick={() => {
                      onNavigate({ kind: "subagent", childSessionId: item.childSessionId });
                    }}
                  >
                    <span className="phone-panel-glyph">
                      <Icon name="robot" size={16} />
                    </span>
                    <span className="phone-panel-item">
                      <span className="phone-panel-profile">
                        {[item.profile, item.model, item.effort].filter(Boolean).join(" · ")}
                      </span>
                      <span className="phone-panel-summary">{item.taskSummary}</span>
                    </span>
                    <span className="phone-panel-time">
                      {elapsedText(runningMs(item.startedAt, now) ?? 0)}
                    </span>
                  </button>
                ))}
              </section>
            )}
            {shells.length > 0 && (
              <section className="phone-panel-section">
                <h2>后台任务</h2>
                {shells.map((item) => (
                  <button
                    type="button"
                    className="phone-panel-row"
                    key={item.taskId}
                    title={item.command}
                    onClick={() => {
                      onNavigate({ kind: "shell", taskId: item.taskId });
                    }}
                  >
                    <span className="phone-panel-glyph">
                      <Icon name="terminal" size={16} />
                    </span>
                    <span className="phone-panel-item phone-panel-name">{item.name}</span>
                    <span className="phone-panel-time">
                      {elapsedText(
                        Math.max(
                          0,
                          Date.parse(item.endedAt ?? new Date(now).toISOString()) -
                            Date.parse(item.startedAt),
                        ),
                      )}
                    </span>
                  </button>
                ))}
              </section>
            )}
            <div className="phone-panel-entries">
              <button
                type="button"
                onClick={() => {
                  onNavigate({ kind: "changes" });
                }}
              >
                <Icon name="git_commit" size={18} />
                变更
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate({ kind: "files" });
                }}
              >
                <Icon name="folder" size={18} />
                文件
              </button>
              <button type="button" aria-disabled="true">
                <Icon name="terminal" size={18} />
                终端
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className="phone-panel-head">
              <IconButton aria-label="返回总览" onClick={onBack}>
                <IconBack />
              </IconButton>
              <span className="phone-panel-title" title={title}>
                {title}
              </span>
              {time && <span className="phone-panel-time">{time}</span>}
              {selectedAgent?.background && selectedAgent.state === "running" && (
                <Button
                  variant="ghost-danger"
                  disabled={!connected}
                  onClick={() => {
                    void entry.client.runtime
                      .cancelSubagent({
                        parentSessionId: session.id,
                        childSessionId: selectedAgent.childSessionId,
                      })
                      .then(
                        () => {
                          directory.trigger();
                        },
                        (cause: unknown) => {
                          stableError(errorText(cause));
                        },
                      );
                  }}
                >
                  取消
                </Button>
              )}
              {selectedShell?.status === "running" && (
                <Button
                  variant="ghost-danger"
                  disabled={!connected}
                  onClick={() => {
                    void session.shellKill(selectedShell.taskId).catch((cause: unknown) => {
                      stableError(errorText(cause));
                    });
                  }}
                >
                  停止
                </Button>
              )}
            </header>
            {page.kind === "context" && summary && (
              <div className="phone-panel-context-detail">
                <ContextPanel context={summary} />
              </div>
            )}
            {page.kind === "subagent" && (
              <SubagentPane
                compact
                tab={{
                  id: page.childSessionId,
                  kind: "subagent",
                  childSessionId: page.childSessionId,
                  parentCallId: selectedAgent?.callId ?? "",
                  profile: selectedAgent?.profile ?? "",
                  taskSummary: selectedAgent?.taskSummary ?? "",
                }}
                parentSessionId={session.id}
                visible={visible && connected}
                watcher={watcher}
                runtime={runtime}
                summary={selectedAgent}
                parentEntry={view.entries.find(
                  (item): item is ToolEntry =>
                    item.kind === "tool" && item.callId === selectedAgent?.callId,
                )}
                workspace={entry.workspace}
                images={images}
                openUrl={openUrl}
              />
            )}
            {page.kind === "shell" && selectedShell && (
              <PhoneTasks
                task={selectedShell}
                session={connected ? session : undefined}
                connected={visible && connected}
              />
            )}
            {page.kind === "changes" && (
              <PhoneChanges entry={entry} loadDiff={stableDiff} onError={stableError} />
            )}
            {page.kind === "files" && (
              <PhoneFiles session={session} connected={connected} onError={stableError} />
            )}
          </>
        )}
      </aside>
    </div>
  );
}
