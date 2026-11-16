import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { sessionUsageSoFar, type SessionView } from "@nocturne/core/protocol";
import type { ContextSummary, RpcSession } from "@nocturne/rpc/client";
import { ContextPanel, number, percent } from "./context-panel";
import { useSessionRefresh } from "./use-session-refresh";
import { ContextRing } from "./web/icons";
import { IconButton } from "./ui";
import "./context-usage.css";

export type StatusPanel = "context";

export interface ContextUsageProps {
  session: RpcSession;
  view: SessionView;
  replaying?: boolean;
  panel?: StatusPanel | null;
  onPanelChange?: (panel: StatusPanel | null) => void;
  home?: string | null;
}

export function ContextUsage({
  session,
  view,
  replaying = false,
  panel,
  onPanelChange,
  home,
}: ContextUsageProps) {
  const [localPanel, setLocalPanel] = useState<StatusPanel | null>(null);
  const open = (panel === undefined ? localPanel : panel) === "context";
  const [context, setContext] = useState<ContextSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | undefined>(undefined);
  const id = useId();

  const updatePosition = useCallback(() => {
    const trig = trigger.current;
    if (!trig) return;
    const trigRect = trig.getBoundingClientRect();
    if (trigRect.width === 0 && trigRect.height === 0) {
      setPopoverStyle(undefined);
      return;
    }
    const VIEWPORT_GAP = 8;
    const POPOVER_GAP = 8;
    const right = Math.max(VIEWPORT_GAP, window.innerWidth - trigRect.right);
    const bottom = Math.max(VIEWPORT_GAP, window.innerHeight - trigRect.top + POPOVER_GAP);
    const maxWidth = Math.max(160, Math.floor(window.innerWidth - right - VIEWPORT_GAP));
    const maxHeight = Math.max(
      120,
      Math.min(560, Math.floor(trigRect.top - POPOVER_GAP - VIEWPORT_GAP)),
    );
    setPopoverStyle({
      position: "fixed",
      left: "auto",
      top: "auto",
      right: `${Math.round(right)}px`,
      bottom: `${Math.round(bottom)}px`,
      maxWidth: `${maxWidth}px`,
      maxHeight: `${maxHeight}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(undefined);
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updatePosition);
      const trig = trigger.current;
      if (trig) observer.observe(trig);
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [open, updatePosition]);
  const change = useCallback(
    (next: StatusPanel | null) => {
      if (panel === undefined) setLocalPanel(next);
      onPanelChange?.(next);
    },
    [panel, onPanelChange],
  );
  const close = useCallback(() => {
    change(null);
    trigger.current?.focus();
  }, [change]);
  const refresh = useSessionRefresh(session, !replaying, async (isCurrent) => {
    setLoading(true);
    setError(null);
    try {
      const summary = await session.describeContext();
      if (isCurrent()) setContext(summary);
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  });
  useEffect(() => {
    void refresh();
  }, [refresh, replaying, view.entries.length, view.status]);
  useEffect(() => {
    setContext(null);
    setLocalPanel(null);
  }, [session]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    void refresh();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, refresh, close]);
  const used = context
    ? percent(context.report.estimatedTokens, context.report.budgetTokens)
    : null;
  const usage = sessionUsageSoFar(view);
  const cache =
    usage.cacheReadTokens === undefined || usage.inputTokens <= 0
      ? null
      : Math.round((usage.cacheReadTokens / usage.inputTokens) * 100);
  return (
    <div className="context-usage" ref={root}>
      <IconButton
        ref={trigger}
        className={open ? "on" : undefined}
        aria-label={`上下文用量 ${used ?? 0}%`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close();
          else change("context");
        }}
      >
        <ContextRing percent={used} />
      </IconButton>
      {open && (
        <div
          id={id}
          ref={dialog}
          role="dialog"
          aria-label="上下文用量"
          tabIndex={-1}
          aria-busy={loading}
          className="context-usage-popover"
          style={popoverStyle}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          {error && (
            <span role="alert" className="status-error" aria-label={error}>
              ⚠
            </span>
          )}
          {context && <ContextPanel context={context} home={home} />}
          <div className="context-usage-footer">
            <span>累计 {number.format(usage.inputTokens + usage.outputTokens)} tokens</span>
            <span>缓存 {cache === null ? "—" : `${cache}%`}</span>
          </div>
        </div>
      )}
    </div>
  );
}
