import { useLayoutEffect, useRef, useState } from "react";
import type { PageCommentThread } from "@nocturne/core/protocol";
import { clampCommentPopoverPosition } from "./page-comments";
import { ICON_SM, Icon, IconButton, MoonMark } from "./ui";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function PageCommentThreadPopover({
  thread,
  pending,
  x,
  y,
  onClose,
  onResolve,
  onReply,
}: {
  thread: PageCommentThread;
  pending: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onResolve?: (() => Promise<void>) | undefined;
  onReply?: ((note: string) => Promise<void>) | undefined;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string>();
  const messages = [
    { by: "user", text: thread.note, version: thread.version, time: thread.time, seq: thread.seq },
    ...thread.replies,
  ];

  useLayoutEffect(() => {
    const root = rootRef.current;
    const container = root?.parentElement;
    if (!root || !container) return;
    const reposition = () => {
      const position = clampCommentPopoverPosition(
        x,
        y,
        container.clientWidth,
        container.clientHeight,
        root.offsetWidth,
        root.offsetHeight,
      );
      root.style.left = `${position.left}px`;
      root.style.top = `${position.top}px`;
    };
    reposition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reposition);
    observer.observe(root);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [x, y]);

  useLayoutEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  async function send() {
    if (!onReply || pending || sending || !note.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      await onReply(note.trim());
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function resolve() {
    if (!onResolve || resolving) return;
    setResolving(true);
    setError(undefined);
    try {
      await onResolve();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResolving(false);
    }
  }

  return (
    <div
      className="page-comment-popover page-comment-thread"
      role="dialog"
      aria-label="评论"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {onResolve && (
        <IconButton
          className="page-comment-thread-resolve"
          aria-label="解决"
          title="解决"
          disabled={resolving}
          onClick={() => void resolve()}
        >
          <Icon name="check" size={ICON_SM} />
        </IconButton>
      )}
      <div className="page-comment-thread-messages">
        {messages.map((message, index) => (
          <div className="page-comment-thread-message" key={`${message.seq}:${index}`}>
            <span className={`page-comment-thread-avatar is-${message.by}`} aria-hidden="true">
              {message.by === "user" ? "我" : <MoonMark size={14} />}
            </span>
            <div className="page-comment-thread-content">
              <div className="page-comment-thread-meta">
                <strong>{message.by === "user" ? "你" : "Nocturne"}</strong>
                <span className="page-comment-thread-version">v{message.version}</span>
                <time dateTime={message.time}>{timeFormat.format(new Date(message.time))}</time>
              </div>
              <div className="page-comment-thread-text">{message.text}</div>
            </div>
          </div>
        ))}
      </div>
      {onReply !== undefined ? (
        pending || sending ? (
          <div className="page-comment-thread-wait" aria-busy="true" />
        ) : (
          <form
            className="page-comment-thread-reply"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              rows={1}
              className="page-comment-popover-input"
              aria-label="回复"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <IconButton
              className="page-comment-thread-send"
              aria-label="发送"
              title="发送"
              disabled={note.trim() === ""}
              onClick={() => void send()}
            >
              <Icon name="arrow_up" size={ICON_SM} />
            </IconButton>
          </form>
        )
      ) : null}
      {error && <output className="sr-only">{error}</output>}
    </div>
  );
}
