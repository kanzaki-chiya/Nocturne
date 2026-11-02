import { useEffect, useRef, useState } from "react";

import {
  isRuntimeWorkMode,
  userEntryText,
  workModeDisplayText,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { ContextSummary } from "@nocturne/rpc/client";

import { ContextPanel, percent } from "../context-panel";
import { useSessionRefresh } from "../use-session-refresh";
import { ContextRing, IconMore } from "./icons";
import { Popover, PopoverOption } from "./Popover";

export interface PhoneContextSource {
  load: () => Promise<ContextSummary>;
  /** 历史回放期间为 true：不按条目数刷新，结束后刷新一次 */
  replaying?: boolean;
  /** 变化时重新读取（持久条目数与状态） */
  key: string;
}

type Open = "context" | "menu" | "mcp" | "history";

/** 当前会话发过的消息（旧到新）：带执行方式命令名，不含 Runtime 写入的消息 */
export function sessionInputHistory(entries: readonly ViewEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "user" || isRuntimeWorkMode(entry.workMode)) return [];
    const text = workModeDisplayText(userEntryText(entry), entry.workMode);
    return text === "" ? [] : [text];
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 会话页顶栏右侧：上下文圆环与会话菜单（重命名、压缩上下文、MCP 状态、输入历史、Shell）。
 * 圆环的读取规则与桌面状态栏相同：回放期间不查，结束后查一次，实时变化 single-flight 合并。
 */
export function SessionHeaderTools({
  context,
  connected,
  running,
  shell,
  home,
  onRename,
  onCompact,
  loadMcp,
  inputHistory,
  onPickHistory,
}: {
  context: PhoneContextSource;
  connected: boolean;
  /** 有进行中的 Turn：压缩上下文要等本轮结束 */
  running: boolean;
  /** probing：还在探测可用 Shell，这一行置灰；load 在打开菜单时触发探测 */
  shell: { label: string; probing?: boolean; load?: () => void };
  home?: string | null;
  onRename: () => void;
  onCompact: () => void;
  loadMcp: () => Promise<string>;
  /** 当前会话发过的消息，旧到新 */
  inputHistory: () => string[];
  onPickHistory: (text: string) => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [summary, setSummary] = useState<ContextSummary>();
  const [contextError, setContextError] = useState<string>();
  const [mcp, setMcp] = useState<string>();
  const [history, setHistory] = useState<string[]>();
  const ring = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const { load, key, replaying } = context;
  const refreshContext = useSessionRefresh(load, replaying !== true, async (isCurrent) => {
    await load().then(
      (result) => {
        if (!isCurrent()) return;
        setSummary(result);
        setContextError(undefined);
      },
      (reason: unknown) => {
        if (isCurrent()) setContextError(errorText(reason));
      },
    );
  });
  useEffect(() => {
    void refreshContext();
  }, [key, refreshContext, replaying, open === "context"]);

  const close = () => {
    setOpen(null);
  };
  const toggle = (kind: "context" | "menu") => {
    setOpen((current) => (current === kind ? null : kind));
  };
  const showMcp = () => {
    setOpen("mcp");
    setMcp(undefined);
    void loadMcp().then(
      (text) => {
        if (mounted.current) setMcp(text);
      },
      (reason: unknown) => {
        if (mounted.current) setMcp(errorText(reason));
      },
    );
  };
  const showHistory = () => {
    setOpen("history");
    setHistory([...new Set(inputHistory().reverse())]);
  };

  const used =
    summary === undefined
      ? null
      : percent(summary.report.estimatedTokens, summary.report.budgetTokens);
  const offline = connected ? undefined : "电脑尚未连接";
  const menuOpen = open === "menu" || open === "mcp" || open === "history";

  return (
    <>
      <button
        ref={ring}
        type="button"
        className={`phone-icon-button${open === "context" ? " on" : ""}`}
        aria-label={`上下文用量${used === null ? "" : ` ${used}%`}`}
        aria-haspopup="dialog"
        aria-expanded={open === "context"}
        onClick={() => {
          toggle("context");
        }}
      >
        <ContextRing percent={used} />
      </button>
      <button
        ref={more}
        type="button"
        className={`phone-icon-button${menuOpen ? " on" : ""}`}
        aria-label="会话菜单"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onClick={() => {
          if (!menuOpen && shell.probing === true) shell.load?.();
          setOpen(menuOpen ? null : "menu");
        }}
      >
        <IconMore />
      </button>
      {open === "context" && (
        <Popover anchor={ring.current} label="上下文用量" onClose={close} wide>
          {summary !== undefined ? (
            <div className="phone-context">
              <ContextPanel context={summary} home={home} />
            </div>
          ) : (
            <p className="phone-popover-note" role={contextError ? "alert" : "status"}>
              {contextError ?? "正在读取…"}
            </p>
          )}
        </Popover>
      )}
      {open === "menu" && (
        <Popover anchor={more.current} label="会话菜单" onClose={close}>
          <PopoverOption
            label="重命名"
            disabled={offline}
            onSelect={() => {
              close();
              onRename();
            }}
          />
          <PopoverOption
            label="压缩上下文"
            disabled={offline ?? (running ? "本轮结束后可压缩" : undefined)}
            onSelect={() => {
              close();
              onCompact();
            }}
          />
          <PopoverOption label="MCP 状态" disabled={offline} onSelect={showMcp} />
          <PopoverOption label="输入历史" disabled={offline} onSelect={showHistory} />
          {/* 只读：显示当前 Shell，探测中置灰 */}
          <button
            type="button"
            role="menuitem"
            className={`phone-option${shell.probing ? "" : " readout"}`}
            disabled
          >
            <span className="phone-option-text">
              <b>
                Shell<span className="muted-value">{shell.label}</span>
              </b>
            </span>
          </button>
        </Popover>
      )}
      {open === "mcp" && (
        <Popover anchor={more.current} label="MCP 状态" onClose={close} wide>
          <div className="phone-popover-h">MCP 状态</div>
          {mcp === undefined ? (
            <p className="phone-popover-note" role="status">
              正在读取…
            </p>
          ) : (
            <pre className="phone-output">{mcp}</pre>
          )}
        </Popover>
      )}
      {open === "history" && (
        <Popover anchor={more.current} label="输入历史" onClose={close} wide>
          <div className="phone-popover-h">输入历史</div>
          {history === undefined || history.length === 0 ? (
            <p className="phone-popover-note">还没有输入历史</p>
          ) : (
            history.map((row) => (
              <button
                type="button"
                key={row}
                className="phone-history-row"
                onClick={() => {
                  close();
                  onPickHistory(row);
                }}
              >
                <span>{row}</span>
              </button>
            ))
          )}
        </Popover>
      )}
    </>
  );
}
