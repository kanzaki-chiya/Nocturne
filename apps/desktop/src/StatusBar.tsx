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

import { unavailableMcpServers, type UnavailableMcpServer } from "./mcp-status";
import { ContextPanel, number, percent } from "./context-panel";
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
import { ICON_SM, Icon } from "./ui";

export type StatusPanel = "context";

export interface StatusBarProps {
  remoteStatus?: RemoteStatus | undefined;
  remoteClient?: RpcClient | undefined;
  onManageRemote?: () => void;
  session: RpcSession;
  view: SessionView;
  branch?: ReactNode;
  /** 历史回放期间为 true：不按条目数刷新上下文，结束后刷新一次 */
  replaying?: boolean;
  controls?: SessionControls | undefined;
  panel?: StatusPanel | null;
  onPanelChange?: (panel: StatusPanel | null) => void;
  /** 主目录（上下文来源路径的 ~ 缩写） */
  home?: string | null;
  onManageProviders?: () => void;
  /** MCP 标记的点击：进入设置 › MCP */
  onManageMcp?: () => void;
  onManageGrants?: () => void;
}

export {
  ContextPanel,
  contextRows,
  contextSourceLabel,
  segmentWidths,
  type ContextRow,
} from "./context-panel";

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

const MCP_STATE_TEXT: Record<UnavailableMcpServer["state"], string> = {
  starting: "启动中",
  ready: "已连接",
  failed: "启动失败",
  crashed: "连接断开",
};

function compactTokens(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return number.format(n);
}

/**
 * MCP 状态标记：
 * - 有 failed / crashed 服务器时显示警告色「MCP 未连接 N」，悬停或聚焦列出原因；
 * - 全部就绪时显示「MCP N」；
 * - 点击进入设置 › MCP。
 */
function McpBadge({
  servers,
  readyCount,
  onOpen,
}: {
  servers: UnavailableMcpServer[];
  readyCount: number;
  onOpen: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  if (servers.length === 0) {
    if (readyCount <= 0) return null;
    return (
      <span className="status-mcp">
        <button
          type="button"
          className="status-pill status-mcp-ready"
          aria-label={`MCP ${readyCount}，打开 MCP 设置`}
          onClick={() => {
            onOpen?.();
          }}
        >
          <span className="dot ok" aria-hidden="true" />
          MCP <b>{readyCount}</b>
        </button>
      </span>
    );
  }
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
        MCP 未连接 <b>{servers.length}</b>
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
  const hasTip = speed.live || rows.length > 0;
  return (
    <span
      className={`status-speed${speed.estimated ? " status-speed-est" : ""}`}
      tabIndex={0}
      aria-label={
        speed.live
          ? `生成速度约 ${speed.label.replace(/^~/, "")}，估算中`
          : `上一步生成速度 ${speed.label}`
      }
      aria-describedby={open && hasTip ? tipId : undefined}
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
      <span>{speed.label}</span>
      {open && hasTip && (
        <span id={tipId} role="tooltip" className="status-popover status-speed-tip">
          {speed.live ? (
            <dl>
              <div>
                <dt>估算中</dt>
                <dd>已用 {formatSeconds(speed.elapsedMs ?? 0)}</dd>
              </div>
            </dl>
          ) : (
            <dl>
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </span>
      )}
    </span>
  );
}

export function StatusBar({
  session,
  view,
  branch,
  replaying = false,
  panel,
  onPanelChange,
  home,
  onManageMcp,
  remoteStatus,
  remoteClient,
  onManageRemote,
}: StatusBarProps) {
  const speed = useStepSpeed(session, view);
  const [localPanel, setLocalPanel] = useState<StatusPanel | null>(null);
  const activePanel = panel === undefined ? localPanel : panel;
  const [context, setContext] = useState<ContextSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<StatusPanel, HTMLButtonElement | null>>>({});
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
  const totalTokens = cacheUsage.inputTokens + cacheUsage.outputTokens;
  const cache =
    cacheUsage.cacheReadTokens === undefined || cacheUsage.inputTokens <= 0
      ? null
      : Math.round((cacheUsage.cacheReadTokens / cacheUsage.inputTokens) * 100);
  const busy = view.status !== "idle" && view.status !== "failed";
  const readyMcpCount = Object.values(view.mcpServers).filter((s) => s.state === "ready").length;

  const trigger = (name: StatusPanel, label: string, content: ReactNode) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[name] = node;
      }}
      className={`status-pill status-${name}${activePanel === name ? " status-pill-active" : ""}`}
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
    </button>
  );

  return (
    <div className="desktop-status status-bar" ref={root}>
      <div className="status-left status-group">
        <span className={`status-item status-turn${busy ? " status-turn-busy" : ""}`}>
          <span className={`dot${busy ? " warn" : " ok"}`} aria-hidden="true" />
          <span>{STATUS_TEXT[view.status]}</span>
          {view.currentTurn && (
            <span className="muted-value">第 {view.currentTurn.turnIndex} 轮</span>
          )}
        </span>
        {trigger(
          "context",
          "上下文用量",
          <>
            <span className="status-meter ctx-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }} />
            </span>
            <span>{used === null ? "—" : `${used}%`}</span>
          </>,
        )}
        <span
          className="status-item status-tokens"
          title={`累计输入 ${number.format(cacheUsage.inputTokens)} / 输出 ${number.format(cacheUsage.outputTokens)} tokens`}
        >
          {compactTokens(totalTokens)} tokens
        </span>
        <span className="status-item status-cache">
          缓存 <span>{cache === null ? "—" : `${cache}%`}</span>
        </span>
        <SpeedBadge speed={speed} />
      </div>
      <div className="status-right status-group">
        {branch}
        <McpBadge
          servers={unavailableMcpServers(view)}
          readyCount={readyMcpCount}
          onOpen={onManageMcp}
        />
        {onManageRemote && (
          <RemoteBadge status={remoteStatus} client={remoteClient} onOpen={onManageRemote} />
        )}
      </div>
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
              <Icon name="close" size={ICON_SM} />
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
