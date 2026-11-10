import { useEffect, useRef, useState } from "react";

import {
  isRuntimeWorkMode,
  userEntryText,
  workModeDisplayText,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { ContextSummary } from "@nocturne/rpc/client";

import { IconMore } from "./icons";
import { Popover, PopoverOption } from "./Popover";

export interface PhoneContextSource {
  load: () => Promise<ContextSummary>;
  /** 历史回放期间为 true：不按条目数刷新，结束后刷新一次 */
  replaying?: boolean;
  /** 变化时重新读取（持久条目数与状态） */
  key: string;
}

type Open = "menu" | "mcp" | "history";

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
 * 会话菜单（重命名、压缩上下文、MCP 状态、输入历史、Shell）。
 */
export function SessionHeaderTools({
  connected,
  running,
  shell,
  onRename,
  onCompact,
  loadMcp,
  inputHistory,
  onPickHistory,
}: {
  connected: boolean;
  /** 有进行中的 Turn：压缩上下文要等本轮结束 */
  running: boolean;
  /** probing：还在探测可用 Shell，这一行置灰；load 在打开菜单时触发探测 */
  shell: { label: string; probing?: boolean; load?: () => void };
  onRename: () => void;
  onCompact: () => void;
  loadMcp: () => Promise<string>;
  /** 当前会话发过的消息，旧到新 */
  inputHistory: () => string[];
  onPickHistory: (text: string) => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [mcp, setMcp] = useState<string>();
  const [history, setHistory] = useState<string[]>();
  const more = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const close = () => {
    setOpen(null);
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

  const offline = connected ? undefined : "电脑尚未连接";
  const menuOpen = open === "menu" || open === "mcp" || open === "history";

  return (
    <>
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
