import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { sessionUsageSoFar, type SessionView } from "@nocturne/core/protocol";
import type { ContextSummary, RpcSession, RpcClient, RemoteStatus } from "@nocturne/rpc/client";
import { RemoteBadge } from "./RemotePage";

import { Dropdown } from "./Dropdown";
import { unavailableMcpServers, type UnavailableMcpServer } from "./mcp-status";
import { ContextPanel, number, percent } from "./context-panel";
import { ChoiceMenu } from "./Menu";
import type { SessionControls } from "./session-controls";
import { useSessionRefresh } from "./use-session-refresh";
import {
  describeStepSpeed,
  formatSeconds,
  trackStepSpeed,
  type SpeedDisplay,
  type StepSpeed,
} from "./speed";
import "./status-bar.css";

export type StatusPanel = "context";

export interface StatusBarProps {
  remoteStatus?: RemoteStatus | undefined;
  remoteClient?: RpcClient | undefined;
  onManageRemote?: () => void;
  session: RpcSession;
  view: SessionView;
  /** 历史回放期间为 true：不按条目数刷新上下文，结束后刷新一次 */
  replaying?: boolean;
  controls: SessionControls;
  panel?: StatusPanel | null;
  onPanelChange?: (panel: StatusPanel | null) => void;
  /** 主目录（上下文来源路径的 ~ 缩写） */
  home?: string | null;
  /** 模型菜单底部「管理服务商…」：进入设置 › 服务商 */
  onManageProviders?: () => void;
  /** MCP 未连接标记的点击：进入设置 › MCP */
  onManageMcp?: () => void;
}

export { ContextPanel, contextRows, contextSourceLabel, type ContextRow } from "./context-panel";

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
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type StatusMenu = "model" | "shell";

const MCP_STATE_TEXT: Record<UnavailableMcpServer["state"], string> = {
  starting: "启动中",
  ready: "已连接",
  failed: "启动失败",
  crashed: "连接断开",
};

/** MCP 未连接标记：只在有 failed / crashed 服务器时出现；悬停或聚焦列出原因，点击进入设置 › MCP */
function McpBadge({
  servers,
  onOpen,
}: {
  servers: UnavailableMcpServer[];
  onOpen: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  if (servers.length === 0) return null;
  return (
    <span
      className="status-mcp"
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="status-pill status-mcp-trigger"
        aria-label={`MCP 未连接 ${servers.length}，打开 MCP 设置`}
        aria-describedby={open ? tipId : undefined}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          // 开着的提示才消费 Esc，否则留给会话概览
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onClick={() => {
          setOpen(false);
          onOpen?.();
        }}
      >
        <span className="status-mcp-dot" aria-hidden="true" />
        MCP 未连接 <b className="mono">{servers.length}</b>
      </button>
      {open && (
        <div id={tipId} role="tooltip" className="status-popover status-mcp-tip">
          {servers.map((server) => (
            <div key={server.name} className="status-mcp-row">
              <b>{server.name}</b>
              <span className="status-mcp-state">{MCP_STATE_TEXT[server.state]}</span>
              {server.error !== undefined && (
                <span className="status-mcp-error">{server.error}</span>
              )}
            </div>
          ))}
          <span className="status-note">点击打开 设置 › MCP</span>
        </div>
      )}
    </span>
  );
}

/**
 * 速度状态随会话重置；打开会话时已在流式的消息不追踪（没有它的首个增量时刻）。
 * view 是原地更新的可变对象，状态在渲染时按视图推进，流式期间每秒重渲一次。
 */
function useStepSpeed(session: RpcSession, view: SessionView): SpeedDisplay | undefined {
  const ref = useRef<
    { session: RpcSession; ignore: Set<string>; state?: StepSpeed | undefined } | undefined
  >(undefined);
  if (ref.current?.session !== session)
    ref.current = {
      session,
      ignore: new Set(view.live.assistants.map((a) => a.messageId)),
    };
  const current = ref.current;
  const now = Date.now();
  current.state = trackStepSpeed(current.state, view, now, current.ignore);
  const live = current.state !== undefined && current.state.ended === undefined;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      tick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [live, session]);
  return describeStepSpeed(current.state, now);
}

const tokens = (n: number) => `${number.format(n)} tokens`;

/** 速度段：悬停或聚焦弹出这一步的明细，弹出方式与 MCP 未连接标记一致 */
function SpeedBadge({ speed }: { speed: SpeedDisplay | undefined }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  if (speed === undefined) return null;
  const d = speed.detail;
  const rows: [string, string][] =
    d === undefined
      ? []
      : [
          ...(d.outputTokens !== undefined
            ? [["输出", tokens(d.outputTokens)] as [string, string]]
            : []),
          ...(d.reasoningTokens !== undefined
            ? [["其中推理", tokens(d.reasoningTokens)] as [string, string]]
            : []),
          ...(d.ttftMs !== undefined
            ? [["TTFT", formatSeconds(d.ttftMs)] as [string, string]]
            : []),
          ...(d.generationMs !== undefined
            ? [["生成用时", formatSeconds(d.generationMs)] as [string, string]]
            : []),
          ...(d.durationMs !== undefined
            ? [["请求总耗时", formatSeconds(d.durationMs)] as [string, string]]
            : []),
        ];
  return (
    <span
      className={`status-speed${speed.estimated ? " status-speed-est" : ""}`}
      tabIndex={0}
      aria-label={
        speed.live
          ? `生成速度约 ${speed.label.replace(/^~/, "")}，估算中`
          : `上一步生成速度 ${speed.label}`
      }
      aria-describedby={open ? tipId : undefined}
      onMouseEnter={() => {
        setOpen(true);
      }}
      onMouseLeave={() => {
        setOpen(false);
      }}
      onFocus={() => {
        setOpen(true);
      }}
      onBlur={() => {
        setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
        }
      }}
    >
      {speed.live && <span className="status-speed-live" aria-hidden="true" />}
      <span className="mono">{speed.label}</span>
      {open && (
        <span id={tipId} role="tooltip" className="status-popover status-speed-tip">
          {speed.live ? (
            <dl>
              <div>
                <dt>估算中</dt>
                <dd>已用 {formatSeconds(speed.elapsedMs ?? 0)}</dd>
              </div>
            </dl>
          ) : (
            <>
              {rows.length > 0 && (
                <dl>
                  {rows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <span className="status-note">上一步 · 速度 = 输出 ÷ 生成用时</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function StatusBar({
  session,
  view,
  replaying = false,
  controls,
  panel,
  onPanelChange,
  home,
  onManageProviders,
  onManageMcp,
  remoteStatus,
  remoteClient,
  onManageRemote,
}: StatusBarProps) {
  const speed = useStepSpeed(session, view);
  const [localPanel, setLocalPanel] = useState<StatusPanel | null>(null);
  const activePanel = panel === undefined ? localPanel : panel;
  const [openMenu, setOpenMenu] = useState<StatusMenu | null>(null);
  const [context, setContext] = useState<ContextSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const refresh = useSessionRefresh(session, !replaying, async (isCurrent) => {
    setLoading(true);
    setError(null);
    try {
      const summary = await session.describeContext();
      if (!isCurrent()) return;
      setContext(summary);
    } catch (failure) {
      if (isCurrent()) setError(message(failure));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  });

  // 持久条目与状态变化时刷新；流式 delta 不重复构建上下文。
  useEffect(() => {
    void refresh();
  }, [refresh, replaying, view.entries.length, view.status]);
  useEffect(() => {
    setContext(null);
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
  // 含进行中 Turn 已完成的步骤，每步结束即更新（view.md §8）
  const cacheUsage = sessionUsageSoFar(view);
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
        {onManageRemote && (
          <RemoteBadge status={remoteStatus} client={remoteClient} onOpen={onManageRemote} />
        )}
        <McpBadge servers={unavailableMcpServers(view)} onOpen={onManageMcp} />
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
        <SpeedBadge speed={speed} />
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
            <b>
              {PANEL_TITLES[activePanel]}
              {context !== null && error !== null && (
                <span
                  className="status-error"
                  role="alert"
                  aria-label={`刷新失败：${error}`}
                  title={`刷新失败：${error}`}
                >
                  {" "}
                  ⚠
                </span>
              )}
            </b>
            <button type="button" aria-label="关闭面板" onClick={closePanel}>
              ×
            </button>
          </div>
          {loading && context === null && (
            <p className="status-note" role="status">
              正在读取…
            </p>
          )}
          {error !== null && context === null && (
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
