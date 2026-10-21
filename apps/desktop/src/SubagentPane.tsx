/**
 * 子代理标签的内容（ADR-0060 第 6 节与修订（五））：一个直接内置子会话的只读视图。
 * 事件来自 subagent.subscribe，折叠成独立的 SessionView，用主对话同一套渲染（思考、工具、输出），
 * 但不挂权限/提问应答、不给输入框和任何写入口；finish 的 input.result 才是最终结果。
 * 只在标签显示时观察，切走即退订（保留视图，回看按 seq 补读）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SubagentSummary, ToolEntry } from "@nocturne/core/protocol";
import type { RpcRuntime } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { Conversation, Markdown, type ReadOnlySessionRef } from "./Conversation";
import type { SubagentTab } from "./side-panel";
import { elapsedText, finalResult, runningMs, subagentStatus } from "./subagent-panel";
import type { SubagentWatcher } from "./subagent-watch";

/** 子代理视图要用到的 runtime 能力（RpcClient.runtime 的子集） */
export type SubagentRuntime = Pick<RpcRuntime, "observeSubagent" | "readSubagentAttachment">;

export interface SubagentPaneProps {
  tab: SubagentTab;
  /** 标签所属的父会话 */
  parentSessionId: string;
  /** 标签正在显示：当前会话、面板展开、当前标签、不在设置页 */
  visible: boolean;
  watcher: SubagentWatcher;
  /** 后台还没连上时 undefined */
  runtime: SubagentRuntime | undefined;
  /** 目录里的最新摘要（比订阅响应新）；还没查到时 undefined */
  summary: SubagentSummary | undefined;
  /** 父视图里这次 task 调用（持久结算与耗时的来源） */
  parentEntry: ToolEntry | undefined;
  /** 父会话工作区：工具行里的路径相对化 */
  workspace: string;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
}

/** 每秒刷新的本地时钟：运行中的秒数靠它，不靠查询 */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

function errorText(code: string | undefined, message: string): string {
  switch (code) {
    case "session_not_found":
      return "找不到这个子代理的日志，可能已被删除";
    case "subagent_parent_mismatch":
      return "这个子会话不属于当前会话，无法查看";
    default:
      return message;
  }
}

export function SubagentPane({
  tab,
  parentSessionId,
  visible,
  watcher,
  runtime,
  summary: directorySummary,
  parentEntry,
  workspace,
  images,
  openUrl,
}: SubagentPaneProps) {
  const child = tab.childSessionId;
  useSyncExternalStore(watcher.subscribe, watcher.getVersion);
  // 只观察显示中的标签：切走、关面板、进设置、关标签时退订，视图和 seq 保留
  useEffect(() => {
    if (!visible || runtime === undefined) return;
    watcher.start(runtime, parentSessionId, child);
    return () => {
      watcher.stop(parentSessionId, child);
    };
  }, [visible, runtime, watcher, parentSessionId, child]);

  const watch = watcher.state(parentSessionId, child);
  const view = watch?.view;
  const summary = watch?.end?.summary ?? directorySummary ?? watch?.summary;
  const status = subagentStatus({ summary, parent: parentEntry, childView: view });
  const now = useNow(status.animated && visible);

  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  // 图片只经只读 RPC 读取：不为复用图片组件而 resume 子会话
  const session = useMemo<ReadOnlySessionRef>(
    () => ({
      id: child,
      readOnly: true,
      readAttachment: (file) => {
        const current = runtimeRef.current;
        if (current === undefined) return Promise.reject(new Error("后台未连接"));
        return current.readSubagentAttachment({
          parentSessionId,
          childSessionId: child,
          file,
        });
      },
    }),
    [parentSessionId, child],
  );
  const subscribeEvents = useCallback(
    (listener: Parameters<SubagentWatcher["events"]>[2]) =>
      watcher.events(parentSessionId, child, listener),
    [watcher, parentSessionId, child],
  );

  const frozen = status.phase !== "unknown" && !status.animated && status.phase !== "submitted";
  const result = view === undefined ? undefined : finalResult(view);
  const denied =
    view?.entries.some((entry) => entry.kind === "tool" && entry.status === "denied") === true;
  const elapsed =
    status.animated && summary !== undefined ? runningMs(summary.startedAt, now) : undefined;
  const timeLabel =
    status.durationMs !== undefined
      ? `用时 ${status.durationApproximate === true ? "约 " : ""}${elapsedText(status.durationMs) || "不足 1 秒"}`
      : elapsed !== undefined
        ? `已运行 ${elapsedText(elapsed)}`
        : undefined;
  const hasContent =
    view !== undefined &&
    (view.entries.length > 0 || view.live.assistants.length > 0 || view.live.tools.length > 0);
  const failed = watch?.phase === "error";
  const retry = (
    <button
      type="button"
      className="btn"
      disabled={runtime === undefined}
      onClick={() => {
        if (runtime !== undefined) watcher.retry(runtime, parentSessionId, child);
      }}
    >
      重试
    </button>
  );
  const placeholder = hasContent ? undefined : failed ? (
    <div className="sp-empty sp-sub-error" role="alert">
      <p>无法读取子代理：{errorText(watch.error?.code, watch.error?.message ?? "")}</p>
      <div className="sp-file-actions">{retry}</div>
    </div>
  ) : runtime === undefined ? (
    <div className="sp-empty" role="status">
      后台未连接，连上后自动读取
    </div>
  ) : watch?.phase === "closed" ? (
    <div className="sp-empty" role="status">
      这个子代理没有可显示的内容
    </div>
  ) : (
    <div className="sp-empty" role="status">
      正在读取子代理过程…
    </div>
  );

  // 没在显示的标签不渲染对话内容：观察已退订，视图保留在 watcher 里，回看时再画
  if (!visible) return null;
  return (
    <div className="sp-sub">
      <header className="sp-sub-head">
        <span className="subagent-badge">{tab.profile}</span>
        <span className="sp-sub-summary" title={tab.taskSummary}>
          {tab.taskSummary}
        </span>
        <span className={`sp-sub-status ${status.phase}`} role="status">
          {status.animated && <span className="tool-spin" aria-hidden="true" />}
          {status.label}
        </span>
        {timeLabel !== undefined && <span className="sp-sub-time">{timeLabel}</span>}
        <span className="sp-badge">只读</span>
      </header>
      {status.error !== undefined && (
        <p className="sp-sub-note err" role="note">
          {status.error}
        </p>
      )}
      {denied && (
        <p className="sp-sub-note" role="note">
          子代理无法请求确认；需由主代理在主对话处理。
        </p>
      )}
      {failed && hasContent && (
        <p className="sp-sub-note err" role="alert">
          读取中断：{errorText(watch.error?.code, watch.error?.message ?? "")} {retry}
        </p>
      )}
      {watch?.end?.tailIgnored === true && (
        <p className="sp-sub-note" role="note">
          日志末尾不完整，已忽略最后一行。
        </p>
      )}
      {result !== undefined && (
        <details className="sp-sub-result thin-scroll" open>
          <summary>最终结果</summary>
          {result.kind === "text" ? (
            <Markdown text={result.text} openUrl={openUrl} />
          ) : (
            <pre className="thin-scroll">{result.text}</pre>
          )}
        </details>
      )}
      <div className="sp-sub-body">
        {placeholder ??
          (view !== undefined && (
            <Conversation
              key={child}
              session={session}
              view={view}
              readOnly={{ frozen }}
              openUrl={openUrl}
              cwd={workspace}
              subscribeEvents={subscribeEvents}
              images={images}
              busy={false}
            />
          ))}
      </div>
    </div>
  );
}
