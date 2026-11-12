import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  unwrapSwarmPostText,
  workModeDisplayText,
  type PendingInputItem,
  type PendingInputsSnapshot,
} from "@nocturne/core/protocol";
import { Button, ICON_MD, ICON_SM, Icon, IconButton } from "./ui";

import "./pending-inputs.css";

export interface PendingInputsProps {
  snapshot: PendingInputsSnapshot;
  running?: boolean | undefined;
  /** 编辑（只换文本）或切换插话/排队 */
  onUpdate: (id: string, patch: { mode?: "steer" | "queue"; text?: string }) => Promise<void>;
  /** 取消 */
  onCancel: (id: string) => Promise<void>;
  /** 解除暂停：空闲时立即发出队首 */
  onResume: () => Promise<void>;
  disabled?: boolean;
}

function IconLead() {
  return <Icon name="corner_down_right" size={ICON_SM} />;
}

function IconSendNow() {
  return <Icon name="arrow_up" size={ICON_MD} />;
}

function IconEdit() {
  return <Icon name="edit_2" size={ICON_MD} />;
}

function IconCheck() {
  return <Icon name="check" size={ICON_MD} />;
}

function IconCancel() {
  return <Icon name="close" size={ICON_MD} />;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 待发列表（ADR-0070 §6）：输入框上方逐条显示还没发出的待发消息。
 */
export function PendingInputs({
  snapshot,
  running = true,
  onUpdate,
  onCancel,
  onResume,
  disabled = false,
}: PendingInputsProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const items = snapshot.items;

  useEffect(() => {
    if (editing !== null && !items.some((item) => item.id === editing)) setEditing(null);
  }, [editing, items]);

  useEffect(() => {
    if (editing !== null) input.current?.focus();
  }, [editing]);

  if (items.length === 0) return null;

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (item: PendingInputItem) => {
    setEditing(item.id);
    setText(item.text);
    setError(null);
  };

  const save = (item: PendingInputItem) => {
    const next = text;
    setEditing(null);
    if (next === item.text) return;
    void run(async () => {
      await onUpdate(item.id, { text: next });
    });
  };

  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, item: PendingInputItem) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 旧 IME 用 keyCode 229 标记组合中
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save(item);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
    }
  };

  return (
    <div className="pending-inputs" role="group" aria-label="待发消息">
      {snapshot.paused && (
        <div className="pi-paused" role="status">
          <span>已暂停</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={() => {
              void run(onResume);
            }}
          >
            继续发送
          </Button>
        </div>
      )}
      {items.map((item) => {
        const isEditing = editing === item.id;
        const isSubagent = item.mode === "subagent";
        const isShell = item.mode === "shell";
        const unwrappedSwarm = unwrapSwarmPostText(item.text);
        const isSwarmPost = unwrappedSwarm !== item.text;
        const rowText = isShell
          ? `后台任务 · ${item.shellName ?? ""} · 等待送达`
          : isSubagent
            ? "子代理结果"
            : isSwarmPost
              ? unwrappedSwarm
              : item.workMode !== undefined
                ? workModeDisplayText(item.text, { name: item.workMode })
                : item.text === ""
                  ? "（仅图片）"
                  : item.text;
        return (
          <div key={item.id} className={`pi-row pi-${item.mode}`}>
            <span className="pi-lead" aria-hidden="true">
              <IconLead />
            </span>
            {isEditing ? (
              <input
                ref={input}
                className="pi-edit"
                value={text}
                aria-label="编辑待发消息"
                onChange={(event) => {
                  setText(event.target.value);
                }}
                onKeyDown={(event) => {
                  onEditKeyDown(event, item);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
              />
            ) : (
              <span className="pi-text" title={rowText}>
                {rowText}
              </span>
            )}
            {item.attachments > 0 && <span className="pi-atts">{item.attachments} 张图</span>}
            <span className="pi-acts">
              {isEditing ? (
                <>
                  <IconButton
                    disabled={busy}
                    title="保存"
                    aria-label="保存"
                    onClick={() => {
                      save(item);
                    }}
                  >
                    <IconCheck />
                  </IconButton>
                  <IconButton
                    className="del"
                    disabled={busy}
                    title="取消"
                    aria-label="取消"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    <IconCancel />
                  </IconButton>
                </>
              ) : (
                <>
                  {running &&
                    item.mode === "queue" &&
                    item.workMode === undefined &&
                    !isSwarmPost && (
                      <IconButton
                        className="send"
                        disabled={disabled || busy}
                        title="立即发送"
                        aria-label="立即发送"
                        onClick={() => {
                          void run(async () => {
                            await onUpdate(item.id, { mode: "steer" });
                          });
                        }}
                      >
                        <IconSendNow />
                      </IconButton>
                    )}
                  {!isSubagent && !isShell && !isSwarmPost && (
                    <IconButton
                      disabled={disabled || busy}
                      title="编辑"
                      aria-label="编辑"
                      onClick={() => {
                        startEdit(item);
                      }}
                    >
                      <IconEdit />
                    </IconButton>
                  )}
                  {!isSwarmPost && (
                    <IconButton
                      className="del"
                      disabled={disabled || busy}
                      title="取消"
                      aria-label="取消"
                      onClick={() => {
                        void run(async () => {
                          await onCancel(item.id);
                        });
                      }}
                    >
                      <IconCancel />
                    </IconButton>
                  )}
                </>
              )}
            </span>
          </div>
        );
      })}
      {error !== null && (
        <div className="pi-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
