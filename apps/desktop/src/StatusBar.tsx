import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { PERMISSION_PRESET_NAMES, type SessionView } from "@nocturne/core/protocol";
import type {
  ContextSummary,
  RpcResult,
  RpcRuntime,
  RpcSession,
  SessionStateSummary,
} from "@nocturne/rpc/client";

import "./status-bar.css";

export type StatusPanel = "context" | "model" | "effort" | "preset" | "shell";

export interface StatusBarProps {
  session: RpcSession;
  runtime: RpcRuntime;
  view: SessionView;
  panel?: StatusPanel | null;
  onPanelChange?: (panel: StatusPanel | null) => void;
  onChanged?: () => void | Promise<void>;
}

type Report = ContextSummary["report"];
type Section = Report["sections"][number];
interface Snapshot {
  session: RpcSession;
  state: SessionStateSummary;
  context: ContextSummary;
  effort: RpcResult<"session.reasoningEffortInfo">;
  shell: RpcResult<"session.shellInfo">;
  models: RpcResult<"runtime.listModels">;
}

export interface ContextRow {
  key: string;
  label: string;
  tokens: number;
  chars?: number;
  color: string;
  source?: string;
  nested?: boolean;
  group?: boolean;
  truncated?: boolean | undefined;
}

const SECTIONS: Record<Section["name"], { label: string; color: string }> = {
  system: { label: "系统提示", color: "var(--a-faint)" },
  tools: { label: "工具定义", color: "var(--a-accentAlt)" },
  instructions: { label: "项目说明", color: "var(--a-secondary)" },
  environment: { label: "环境", color: "var(--a-muted)" },
  todos: { label: "任务清单", color: "var(--a-muted)" },
  history: { label: "对话历史", color: "var(--a-accent)" },
};
const HISTORY = [
  { key: "user", label: "用户消息", color: "var(--a-success)" },
  { key: "assistant", label: "助手回答", color: "var(--a-warning)" },
  { key: "tool", label: "工具调用与结果", color: "var(--a-accent)" },
  { key: "summary", label: "压缩摘要", color: "var(--a-selStrong)" },
] as const;
const PANEL_TITLES: Record<StatusPanel, string> = {
  context: "上下文用量",
  model: "选择模型",
  effort: "选择思考档位",
  preset: "选择权限预设",
  shell: "选择 Shell",
};
const STATUS_TEXT: Record<SessionView["status"], string> = {
  idle: "空闲",
  thinking: "思考中",
  running_tool: "执行工具",
  waiting_permission: "等待确认",
  waiting_user: "等待回答",
  retrying: "重试中",
  compacting: "压缩中",
  describing_images: "描述图片中",
  failed: "失败",
};
const number = new Intl.NumberFormat("zh-CN");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** history 总量仅作分组标题；堆叠条使用四项明细，不能重复计入总量。 */
export function contextRows(report: Report): ContextRow[] {
  const rows: ContextRow[] = [];
  for (const section of report.sections) {
    const group = section.name === "history" && section.breakdown !== undefined;
    rows.push({
      key: section.name,
      ...SECTIONS[section.name],
      tokens: section.estimatedTokens,
      chars: section.chars,
      source: section.source,
      group,
      truncated: section.truncated,
    });
    if (section.name === "history" && section.breakdown !== undefined) {
      for (const item of HISTORY) {
        const size = section.breakdown[item.key];
        rows.push({
          ...item,
          key: `history-${item.key}`,
          tokens: size.estimatedTokens,
          chars: size.chars,
          nested: true,
        });
      }
    }
  }
  if (report.images !== undefined) {
    rows.push({
      key: "images",
      label: "图片",
      color: "var(--a-error)",
      tokens: report.images.estimatedTokens,
      source: `${report.images.count} 张`,
    });
  }
  return rows;
}

function percent(used: number, budget: number): number | null {
  return budget > 0 ? Math.round((used / budget) * 100) : null;
}

export function ContextPanel({ context }: { context: ContextSummary }) {
  const { report } = context;
  const rows = contextRows(report);
  const used = percent(report.estimatedTokens, report.budgetTokens);
  return (
    <>
      <div className="context-total">
        <b>上下文</b>
        <span>
          {number.format(report.estimatedTokens)} / {number.format(report.budgetTokens)} tokens
          {used === null ? " · 无可用预算" : ` · ${used}%`}
        </span>
      </div>
      <div className="context-stack" aria-label="上下文组成">
        {rows
          .filter((row) => !row.group)
          .map((row) => (
            <i
              key={row.key}
              data-segment={row.key}
              title={`${row.label}：${number.format(row.tokens)} tokens`}
              style={{
                width: `${report.estimatedTokens > 0 ? (row.tokens / report.estimatedTokens) * 100 : 0}%`,
                background: row.color,
              }}
            />
          ))}
      </div>
      <dl className="context-details">
        {rows.map((row) => (
          <div
            key={row.key}
            className={row.nested ? "context-nested" : row.group ? "context-group" : undefined}
          >
            <dt>
              {!row.group && <i style={{ background: row.color }} aria-hidden="true" />}
              {row.label}
              {row.source && <small title={row.source}>{row.source}</small>}
              {row.truncated && <small>已截断</small>}
            </dt>
            <dd title={row.chars === undefined ? undefined : `${number.format(row.chars)} chars`}>
              {number.format(row.tokens)}
            </dd>
          </div>
        ))}
      </dl>
      {context.overBudget && <p className="status-warning">已超出输入预算</p>}
      {report.modelDefaults?.contextWindow && (
        <p className="status-note">模型未声明上下文长度，预算使用默认值。</p>
      )}
      {report.modelDefaults?.maxOutputTokens && (
        <p className="status-note">模型未声明输出上限，预算使用默认值。</p>
      )}
      <div className="context-footer">
        可以输入 <code>/compact</code> 压缩
      </div>
    </>
  );
}

export function StatusBar({
  session,
  runtime,
  view,
  panel,
  onPanelChange,
  onChanged,
}: StatusBarProps) {
  const [localPanel, setLocalPanel] = useState<StatusPanel | null>(null);
  const activePanel = panel === undefined ? localPanel : panel;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [shells, setShells] = useState<RpcResult<"session.listShells"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const mutation = useRef(false);
  const currentSession = useRef(session);
  currentSession.current = session;
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<StatusPanel, HTMLButtonElement | null>>>({});
  const dialogId = useId();
  const data = snapshot?.session === session ? snapshot : null;

  const changePanel = useCallback(
    (next: StatusPanel | null) => {
      if (panel === undefined) setLocalPanel(next);
      onPanelChange?.(next);
    },
    [panel, onPanelChange],
  );
  const closePanel = useCallback(() => {
    const trigger = activePanel === null ? undefined : triggers.current[activePanel];
    changePanel(null);
    trigger?.focus();
  }, [activePanel, changePanel]);

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const [state, context, effort, shell, models] = await Promise.all([
        session.state(),
        session.describeContext(),
        session.reasoningEffortInfo(),
        session.shellInfo(),
        runtime.listModels(),
      ]);
      if (id !== request.current) return false;
      setSnapshot({ session, state, context, effort, shell, models });
      return true;
    } catch (failure) {
      if (id === request.current) setError(message(failure));
      return false;
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [session, runtime]);

  // 持久条目、状态与配置变化时刷新；流式 delta 不重复构建上下文。
  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [
    refresh,
    view.entries.length,
    view.status,
    view.config.model?.provider,
    view.config.model?.model,
    view.config.reasoningEffort,
    view.config.permissionPreset,
  ]);
  useEffect(() => {
    setLocalPanel(null);
    setShells(null);
    setChanging(false);
    mutation.current = false;
  }, [session]);
  useEffect(() => {
    if (activePanel === null) return;
    const focused = dialog.current?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]:not(:disabled), button:not(:disabled)',
    );
    (focused ?? dialog.current)?.focus();
    if (activePanel === "context" || activePanel === "model") void refresh();
    if (activePanel !== "shell") return;
    let cancelled = false;
    setShells(null);
    void session.listShells().then(
      (detected) => {
        if (!cancelled) setShells(detected);
      },
      (failure: unknown) => {
        if (!cancelled) setError(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activePanel, session, refresh]);
  useEffect(() => {
    if (activePanel === null) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) changePanel(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [activePanel, changePanel]);

  const choose = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setChanging(true);
    setError(null);
    try {
      await action();
      if (currentSession.current !== session) return;
      if (!(await refresh())) return;
      await onChanged?.();
      if (currentSession.current === session) closePanel();
    } catch (failure) {
      if (currentSession.current === session) setError(message(failure));
    } finally {
      if (currentSession.current === session) {
        mutation.current = false;
        setChanging(false);
      }
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>(".status-option:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (at + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  };
  const model = data?.state.config.model ?? view.config.model;
  const preset = data?.state.config.permissionPreset ?? view.config.permissionPreset;
  const usage = data?.context.report;
  const used = usage === undefined ? null : percent(usage.estimatedTokens, usage.budgetTokens);
  const cacheUsage = view.usage;
  const cache =
    cacheUsage.cacheReadTokens === undefined || cacheUsage.inputTokens <= 0
      ? null
      : Math.round((cacheUsage.cacheReadTokens / cacheUsage.inputTokens) * 100);
  const busy = view.status !== "idle" && view.status !== "failed";
  const trigger = (name: StatusPanel, label: string, content: ReactNode) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[name] = node;
      }}
      className={`status-pill${activePanel === name ? " status-pill-active" : ""}${name === "preset" ? " status-preset" : ""}`}
      aria-label={label}
      aria-expanded={activePanel === name}
      aria-controls={activePanel === name ? dialogId : undefined}
      aria-haspopup="dialog"
      onClick={() => {
        if (activePanel === name) closePanel();
        else changePanel(name);
      }}
    >
      {content}
      <span className="status-caret" aria-hidden="true">
        {activePanel === name ? "▴" : "▾"}
      </span>
    </button>
  );
  const option = (
    key: string,
    label: string,
    selected: boolean,
    action: () => Promise<void>,
    disabled = false,
    detail?: string,
  ) => (
    <button
      type="button"
      className="status-option"
      key={key}
      aria-pressed={selected}
      disabled={disabled || changing || data === null}
      onClick={() => {
        void choose(action);
      }}
    >
      <span>
        {label}
        {detail && <small>{detail}</small>}
      </span>
      <span aria-hidden="true">{selected ? "✓" : ""}</span>
    </button>
  );

  return (
    <div className="desktop-status" ref={root}>
      <div className="status-controls">
        {trigger(
          "model",
          "切换模型",
          <>
            <span className="status-dot" aria-hidden="true" />
            <b>{model ? `${model.provider} · ${model.model}` : "模型 —"}</b>
          </>,
        )}
        {trigger(
          "effort",
          "切换思考档位",
          <>
            思考 <b>{data?.effort.current ?? view.config.reasoningEffort ?? "—"}</b>
          </>,
        )}
        {trigger(
          "preset",
          "切换权限预设",
          <>
            权限 <b>{preset ?? "—"}</b>
          </>,
        )}
        {trigger(
          "shell",
          "切换 Shell",
          <>
            Shell <b>{data?.shell.effective?.kind ?? data?.shell.selected ?? "—"}</b>
          </>,
        )}
      </div>
      <div className="status-right">
        {trigger(
          "context",
          "上下文用量",
          <>
            上下文{" "}
            <span className="status-meter" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }} />
            </span>
            <span className="mono">
              {usage === undefined
                ? "—"
                : `${used === null ? "—" : `${used}%`} / ${number.format(usage.budgetTokens)}`}
            </span>
          </>,
        )}
        <span title="会话累计缓存读取 token / 输入 token">
          缓存 <span className="mono">{cache === null ? "—" : `${cache}%`}</span>
        </span>
        <span className={`status-turn${busy ? " status-turn-busy" : ""}`}>
          ● {STATUS_TEXT[view.status]}
          {view.currentTurn ? ` · Turn ${view.currentTurn.turnIndex}` : ""}
        </span>
      </div>
      {activePanel !== null && (
        <div
          id={dialogId}
          role="dialog"
          aria-label={PANEL_TITLES[activePanel]}
          tabIndex={-1}
          ref={dialog}
          onKeyDown={keyboard}
          className={`status-popover${activePanel === "context" ? " status-context-popover" : ""}`}
          aria-busy={loading || changing}
        >
          <div className="status-popover-heading">
            <b>{PANEL_TITLES[activePanel]}</b>
            <button type="button" aria-label="关闭面板" onClick={closePanel}>
              ×
            </button>
          </div>
          {loading && (
            <p className="status-note" role="status">
              正在读取…
            </p>
          )}
          {error !== null && (
            <p className="status-error" role="alert">
              {error}
            </p>
          )}
          {activePanel === "context" && data && <ContextPanel context={data.context} />}
          <div className="status-options">
            {activePanel === "model" &&
              data?.models.map((item) =>
                option(
                  `${item.ref.provider}/${item.ref.model}`,
                  `${item.ref.provider} · ${item.ref.model}`,
                  model?.provider === item.ref.provider && model.model === item.ref.model,
                  () => session.setModel(item.ref),
                  busy || item.unavailable !== undefined,
                  item.unavailable?.reason ?? item.displayName,
                ),
              )}
            {activePanel === "model" && data?.models.length === 0 && (
              <p className="status-note">没有已配置的模型</p>
            )}
            {activePanel === "effort" && data && (
              <>
                {data.effort.available.length === 0 ? (
                  <p className="status-note">该模型未声明可用思考档位</p>
                ) : (
                  ["off", ...data.effort.available].map((level) =>
                    option(level, level, data.effort.current === level, () =>
                      session.setReasoningEffort(level),
                    ),
                  )
                )}
                {data.effort.current !== data.effort.effective && (
                  <p className="status-note">
                    本 Turn 使用 {data.effort.effective}；{data.effort.current} 将在下一 Turn 生效。
                  </p>
                )}
              </>
            )}
            {activePanel === "preset" &&
              PERMISSION_PRESET_NAMES.map((name) =>
                option(name, name, preset === name, () => session.setPermissionPreset(name), busy),
              )}
            {activePanel === "shell" && (
              <>
                {option(
                  "auto",
                  "auto",
                  data?.shell.selected === "auto",
                  () => session.setShell("auto"),
                  busy,
                  "自动选择",
                )}
                {shells?.map((item) =>
                  option(
                    item.kind,
                    `${item.kind} · ${item.name}`,
                    data?.shell.selected === item.kind,
                    () => session.setShell(item.kind),
                    busy || !item.available,
                    item.available ? item.executable : "未安装",
                  ),
                )}
                {shells === null && <p className="status-note">正在探测 Shell…</p>}
                {data?.shell.overriddenBy && (
                  <p className="status-note">
                    选择被 {data.shell.overriddenBy} 覆盖，当前实际使用{" "}
                    {data.shell.effective?.kind ?? "—"}。
                  </p>
                )}
                {data?.shell.error && <p className="status-error">{data.shell.error}</p>}
              </>
            )}
          </div>
          {busy && activePanel !== "context" && activePanel !== "effort" && (
            <p className="status-note">当前 Turn 结束后可切换</p>
          )}
        </div>
      )}
      {error !== null && activePanel === null && (
        <span className="status-read-error" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
