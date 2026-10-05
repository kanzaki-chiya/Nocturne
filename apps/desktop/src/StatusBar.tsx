import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type SessionView } from "@nocturne/core/protocol";
import type { ContextSummary, RpcSession } from "@nocturne/rpc/client";

import { Dropdown } from "./Dropdown";
import { abbreviateHome } from "./paths";
import { ChoiceMenu } from "./Menu";
import type { SessionControls } from "./session-controls";
import "./status-bar.css";

export type StatusPanel = "context";

export interface StatusBarProps {
  session: RpcSession;
  view: SessionView;
  controls: SessionControls;
  panel?: StatusPanel | null;
  onPanelChange?: (panel: StatusPanel | null) => void;
  /** 主目录（上下文来源路径的 ~ 缩写） */
  home?: string | null;
  /** 模型菜单底部「管理服务商…」：进入设置 › 服务商 */
  onManageProviders?: () => void;
}

type Report = ContextSummary["report"];
type Section = Report["sections"][number];

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

/** 上下文报告里的英文来源文本 → 中文；路径按主目录缩写。 */
export function contextSourceLabel(source: string, home?: string | null): string {
  if (source === "nocturne base prompt") return "内置提示词";
  if (source === "custom base prompt") return "自定义提示词";
  const tools = /^(\d+) tools$/.exec(source);
  if (tools !== null) return `${tools[1]} 个工具`;
  const items = /^(\d+) items$/.exec(source);
  if (items !== null) return `${items[1]} 项`;
  const entries = /^(\d+) entries$/.exec(source);
  if (entries !== null) return `${entries[1]} 条`;
  return abbreviateHome(source, home);
}

function percent(used: number, budget: number): number | null {
  return budget > 0 ? Math.round((used / budget) * 100) : null;
}

export function ContextPanel({
  context,
  home,
}: {
  context: ContextSummary;
  home?: string | null | undefined;
}) {
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
        {rows.map((row) => {
          const source =
            row.source === undefined ? undefined : contextSourceLabel(row.source, home);
          return (
            <div
              key={row.key}
              className={row.nested ? "context-nested" : row.group ? "context-group" : undefined}
            >
              <dt>
                {!row.group && <i style={{ background: row.color }} aria-hidden="true" />}
                {row.label}
                {source !== undefined && source !== "" && <small title={source}>{source}</small>}
                {row.truncated && <small>已截断</small>}
              </dt>
              <dd title={row.chars === undefined ? undefined : `${number.format(row.chars)} chars`}>
                {number.format(row.tokens)}
              </dd>
            </div>
          );
        })}
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

type StatusMenu = "model" | "shell";

export function StatusBar({
  session,
  view,
  controls,
  panel,
  onPanelChange,
  home,
  onManageProviders,
}: StatusBarProps) {
  const [localPanel, setLocalPanel] = useState<StatusPanel | null>(null);
  const activePanel = panel === undefined ? localPanel : panel;
  const [openMenu, setOpenMenu] = useState<StatusMenu | null>(null);
  const [context, setContext] = useState<ContextSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<StatusPanel | StatusMenu, HTMLButtonElement | null>>>({});
  const dialogId = useId();

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
      const summary = await session.describeContext();
      if (id !== request.current) return;
      setContext(summary);
    } catch (failure) {
      if (id === request.current) setError(message(failure));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [session]);

  // 持久条目与状态变化时刷新；流式 delta 不重复构建上下文。
  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh, view.entries.length, view.status]);
  useEffect(() => {
    setLocalPanel(null);
    setOpenMenu(null);
  }, [session]);
  useEffect(() => {
    if (activePanel === null) return;
    const focused = dialog.current?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]:not(:disabled), button:not(:disabled)',
    );
    (focused ?? dialog.current)?.focus();
    void refresh();
  }, [activePanel, refresh]);
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

  const toggleMenu = (kind: StatusMenu) => {
    if (openMenu === kind) {
      setOpenMenu(null);
      return;
    }
    setError(null);
    if (kind === "shell") controls.loadShells();
    setOpenMenu(kind);
  };
  const closeMenu = (kind: StatusMenu) => {
    setOpenMenu(null);
    triggers.current[kind]?.focus();
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

  const usage = context?.report;
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
      className={`status-pill${activePanel === name ? " status-pill-active" : ""}`}
      aria-label={label}
      aria-expanded={activePanel === name}
      aria-controls={activePanel === name ? dialogId : undefined}
      aria-haspopup="dialog"
      onClick={() => {
        setOpenMenu(null);
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

  const pill = (
    kind: StatusMenu,
    label: string,
    control: { disabled?: string },
    content: ReactNode,
  ) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[kind] = node;
      }}
      className={`status-pill status-${kind}${openMenu === kind ? " status-pill-active" : ""}`}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={openMenu === kind}
      disabled={control.disabled !== undefined}
      title={
        kind === "model"
          ? `${model === undefined ? "模型 —" : `${model.provider} · ${model.model}`}${control.disabled === undefined ? "" : ` · ${control.disabled}`}`
          : control.disabled
      }
      onClick={() => {
        toggleMenu(kind);
      }}
    >
      {content}
      <span className="status-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );

  /** 权限与思考档位：与设置页同一个自绘下拉（Dropdown），选项说明来自 choice-info.ts */
  const choiceDropdown = (
    label: string,
    control: SessionControls["controls"]["effort"],
    content: ReactNode,
    preset = false,
  ) => (
    <Dropdown
      variant="pill"
      label={label}
      value={control.value}
      options={control.groups.flatMap((group) => group.options)}
      triggerClassName={`status-pill${preset ? " status-preset" : ""}`}
      openClassName="status-pill-active"
      {...(control.heading !== undefined ? { heading: control.heading } : {})}
      {...(control.note !== undefined ? { note: control.note } : {})}
      {...(control.disabled !== undefined ? { disabled: control.disabled } : {})}
      onChange={(value) => {
        setOpenMenu(null);
        setError(null);
        void Promise.resolve(control.onSelect(value)).catch((reason: unknown) => {
          setError(message(reason));
        });
      }}
    >
      {content}
      <span className="status-caret" aria-hidden="true">
        ▾
      </span>
    </Dropdown>
  );

  const shell = controls.shell;
  const model = view.config.model;
  const menuControl = (kind: StatusMenu) => {
    const control = kind === "model" ? controls.controls.model : controls.shellControl;
    return (
      <ChoiceMenu
        anchor={triggers.current[kind] ?? null}
        label={control.heading ?? control.label}
        control={control}
        action={
          kind === "model" && onManageProviders !== undefined
            ? { label: "管理服务商…", onSelect: onManageProviders }
            : undefined
        }
        onClose={() => {
          closeMenu(kind);
        }}
        onError={(reason: unknown) => {
          setError(message(reason));
        }}
      />
    );
  };

  return (
    <div className="desktop-status" ref={root}>
      <div className="status-controls">
        {pill(
          "model",
          "切换模型",
          controls.controls.model,
          <>
            <span className="status-dot" aria-hidden="true" />
            <b>
              {model === undefined ? (
                "模型 —"
              ) : (
                <>
                  <span className="status-prov">{model.provider} · </span>
                  {model.model}
                </>
              )}
            </b>
          </>,
        )}
        {choiceDropdown(
          "切换思考档位",
          controls.controls.effort,
          <>
            思考 <b>{controls.controls.effort.label}</b>
          </>,
        )}
        {choiceDropdown(
          "切换权限预设",
          controls.controls.preset,
          <>
            权限 <b>{controls.controls.preset.label}</b>
          </>,
          true,
        )}
        {pill(
          "shell",
          "切换 Shell",
          controls.shellControl,
          <>
            Shell <b>{shell?.effective?.kind ?? shell?.selected ?? "—"}</b>
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
        <span className="status-cache" title="会话累计缓存读取 token / 输入 token">
          缓存 <span className="mono">{cache === null ? "—" : `${cache}%`}</span>
        </span>
        <span className={`status-turn${busy ? " status-turn-busy" : ""}`}>
          ● {STATUS_TEXT[view.status]}
          {view.currentTurn ? ` · Turn ${view.currentTurn.turnIndex}` : ""}
        </span>
      </div>
      {openMenu !== null && menuControl(openMenu)}
      {activePanel !== null && (
        <div
          id={dialogId}
          role="dialog"
          aria-label={PANEL_TITLES[activePanel]}
          tabIndex={-1}
          ref={dialog}
          onKeyDown={keyboard}
          className="status-popover status-context-popover"
          aria-busy={loading}
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
          {context !== null && <ContextPanel context={context} home={home} />}
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
