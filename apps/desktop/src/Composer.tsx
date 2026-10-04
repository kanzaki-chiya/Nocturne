import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  completeCommands,
  type CommandCompletion,
  type CommandCompletionContext,
} from "./commands";
import "./composer.css";

export interface ComposerProps {
  running: boolean;
  disabled?: boolean;
  /** false 表示未接收；Promise 只等待接收输入，不等待整个 Turn。 */
  onSubmit: ((text: string) => void) | ((text: string) => boolean | Promise<boolean>);
  onInterrupt: () => void | Promise<void>;
  historyKey?: string | null;
  readInputHistory?: () => Promise<string[]>;
  /** 父层从当前会话引用记录，因而首次输入创建会话后也能写入历史。 */
  recordInputHistory?: (text: string) => Promise<void>;
  completionContext?: CommandCompletionContext;
  placeholder?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendHistory(history: readonly string[], text: string): string[] {
  return history.at(-1) === text ? [...history] : [...history.slice(-999), text];
}

export function Composer({
  running,
  disabled = false,
  onSubmit,
  onInterrupt,
  historyKey,
  readInputHistory,
  recordInputHistory,
  completionContext,
  placeholder = "输入消息，或输入 / 查看命令…",
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const interruptingRef = useRef(false);
  const draftRef = useRef("");
  const revision = useRef(0);
  const history = useRef<string[]>([]);
  const historySinceRead = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const historyDraft = useRef("");
  const mounted = useRef(true);
  const readHistoryRef = useRef(readInputHistory);
  readHistoryRef.current = readInputHistory;
  const id = useId();
  const listId = `${id}-commands`;
  const hintId = `${id}-hint`;
  const candidates = useMemo(
    () => completeCommands(draft, completionContext),
    [draft, completionContext],
  );
  const showingCandidates = focused && !composing && !dismissed && candidates.length > 0;
  const activeIndex = Math.min(selected, Math.max(0, candidates.length - 1));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    history.current = [];
    historySinceRead.current = [];
    historyIndex.current = null;
    const readHistory = readHistoryRef.current;
    if (readHistory !== undefined) {
      void readHistory()
        .then((rows) => {
          if (!active) return;
          history.current = historySinceRead.current.reduce(appendHistory, rows.slice(-1000));
        })
        .catch((reason: unknown) => {
          if (active) setError(`读取输入历史失败：${errorText(reason)}`);
        });
    }
    return () => {
      active = false;
    };
  }, [historyKey]);

  const updateDraft = (text: string, fromHistory = false) => {
    revision.current += 1;
    draftRef.current = text;
    setDraft(text);
    setSelected(0);
    setDismissed(false);
    setError(null);
    if (!fromHistory) historyIndex.current = null;
  };

  const interrupt = useCallback(async () => {
    if (!running || interruptingRef.current) return;
    interruptingRef.current = true;
    setInterrupting(true);
    setError(null);
    try {
      await onInterrupt();
    } catch (reason) {
      if (mounted.current) setError(`中断失败：${errorText(reason)}`);
    } finally {
      interruptingRef.current = false;
      if (mounted.current) setInterrupting(false);
    }
  }, [running, onInterrupt]);

  useEffect(() => {
    if (!running) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        composingRef.current
      )
        return;
      event.preventDefault();
      void interrupt();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [running, interrupt]);

  const submit = async () => {
    const text = draftRef.current;
    if (disabled || running || submittingRef.current || composingRef.current || text.trim() === "")
      return;
    const submittedRevision = revision.current;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await onSubmit(text);
      if (accepted === false) return;
      historyIndex.current = null;
      if (mounted.current && revision.current === submittedRevision) updateDraft("");
      if (recordInputHistory !== undefined) {
        try {
          await recordInputHistory(text);
        } catch (reason) {
          if (mounted.current) setError(`消息已接收，但保存输入历史失败：${errorText(reason)}`);
        }
      }
      history.current = appendHistory(history.current, text);
      historySinceRead.current = appendHistory(historySinceRead.current, text);
    } catch (reason) {
      if (mounted.current) setError(`发送失败：${errorText(reason)}`);
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const choose = (candidate: CommandCompletion) => {
    updateDraft(candidate.insert);
    setDismissed(!candidate.insert.endsWith(" "));
    textarea.current?.focus();
  };

  const navigateHistory = (
    direction: "up" | "down",
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const field = event.currentTarget;
    if (
      field.selectionStart !== field.selectionEnd ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const caret = field.selectionStart;
    if (direction === "up" && draft.slice(0, caret).includes("\n")) return;
    if (direction === "down" && draft.slice(caret).includes("\n")) return;
    if (history.current.length === 0) return;
    if (direction === "up") {
      if (historyIndex.current === null) {
        historyDraft.current = draftRef.current;
        historyIndex.current = history.current.length - 1;
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1);
      }
      event.preventDefault();
      updateDraft(history.current[historyIndex.current] ?? "", true);
    } else if (historyIndex.current !== null) {
      event.preventDefault();
      const next = historyIndex.current + 1;
      historyIndex.current = next < history.current.length ? next : null;
      updateDraft(
        historyIndex.current === null ? historyDraft.current : (history.current[next] ?? ""),
        true,
      );
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (event.key === "Escape") {
      if (running) {
        event.preventDefault();
        void interrupt();
      } else if (showingCandidates) {
        event.preventDefault();
        setDismissed(true);
      }
      return;
    }
    if (showingCandidates && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelected(
          (index) =>
            (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length,
        );
        return;
      }
      if (event.key === "Tab") {
        const candidate = candidates[activeIndex];
        if (candidate !== undefined) {
          event.preventDefault();
          choose(candidate);
        }
        return;
      }
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      void submit();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      navigateHistory(event.key === "ArrowUp" ? "up" : "down", event);
    }
  };

  useEffect(() => {
    if (showingCandidates) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [showingCandidates, activeIndex, listId]);

  return (
    <div className="composer">
      {showingCandidates && (
        <ul id={listId} className="composer-commands" role="listbox" aria-label="斜杠命令补全">
          {candidates.map((candidate, index) => (
            <li
              id={`${listId}-${index}`}
              key={candidate.insert}
              role="option"
              aria-selected={index === activeIndex}
              className={`composer-command${index === activeIndex ? " is-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                choose(candidate);
              }}
            >
              <span className="composer-command-name">{candidate.label}</span>
              <span className="composer-command-summary">{candidate.summary}</span>
              <span className={`composer-command-status ${candidate.status}`}>
                {candidate.statusText}
              </span>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={id} className="composer-label">
        消息输入
      </label>
      <div className="composer-field">
        <textarea
          id={id}
          ref={textarea}
          rows={3}
          value={draft}
          placeholder={placeholder}
          aria-describedby={hintId}
          aria-autocomplete="list"
          aria-controls={showingCandidates ? listId : undefined}
          aria-activedescendant={showingCandidates ? `${listId}-${activeIndex}` : undefined}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
          }}
          onChange={(event) => {
            updateDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            setComposing(false);
          }}
        />
        {running ? (
          <button
            type="button"
            className="composer-action interrupt"
            disabled={interrupting}
            onClick={() => {
              void interrupt();
            }}
            title="中断当前运行（Esc）"
          >
            {interrupting ? "正在中断…" : "中断"}
          </button>
        ) : (
          <button
            type="button"
            className="composer-action send"
            disabled={disabled || submitting || composing || draft.trim() === ""}
            onClick={() => {
              void submit();
            }}
            title="发送消息（Enter）"
          >
            {submitting ? "发送中…" : "发送"}
          </button>
        )}
      </div>
      <div id={hintId} className="composer-hint">
        <span>Enter 发送 · Shift+Enter 换行</span>
        <span>
          {showingCandidates ? "↑↓ 选择 · Tab 补全" : running ? "Esc 中断" : "↑↓ 输入历史 · / 命令"}
        </span>
      </div>
      {error !== null && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
