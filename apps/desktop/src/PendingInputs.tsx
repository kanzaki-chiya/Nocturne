import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { PendingInputItem, PendingInputsSnapshot } from "@nocturne/core/protocol";

import "./pending-inputs.css";

export interface PendingInputsProps {
  snapshot: PendingInputsSnapshot;
  /** 编辑（只换文本）或切换插话/排队 */
  onUpdate: (id: string, patch: { mode?: "steer" | "queue"; text?: string }) => Promise<void>;
  /** 撤回 */
  onCancel: (id: string) => Promise<void>;
  /** 解除暂停：空闲时立即发出队首 */
  onResume: () => Promise<void>;
  disabled?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 待发列表（ADR-0070 §6）：输入框上方逐条显示还没发出的插话与排队输入。
 * 插话在运行中插队的消息里另有「插话」标签；这里只管发送前的编辑与撤回。
 */
export function PendingInputs({
  snapshot,
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
          <button
            type="button"
            className="pi-btn"
            disabled={disabled || busy}
            onClick={() => {
              void run(onResume);
            }}
          >
            继续发送
          </button>
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} className={`pi-row pi-${item.mode}`}>
          <div className="pi-main">
            <span className="pi-mode">
              {item.mode === "subagent" ? "子代理结果" : item.mode === "steer" ? "插话" : "排队"}
            </span>
            {editing === item.id ? (
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
              <span className="pi-text" title={item.mode === "subagent" ? "等待送达" : item.text}>
                {item.mode === "subagent"
                  ? "等待送达"
                  : item.text === ""
                    ? "（仅图片）"
                    : item.text}
              </span>
            )}
            {item.attachments > 0 && <span className="pi-atts">{item.attachments} 张图</span>}
            <span className="pi-acts">
              {editing === item.id ? (
                <>
                  <button
                    type="button"
                    className="pi-btn"
                    disabled={busy}
                    onClick={() => {
                      save(item);
                    }}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="pi-btn"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  {item.mode !== "subagent" && (
                    <>
                      <button
                        type="button"
                        className="pi-btn"
                        disabled={disabled || busy}
                        onClick={() => {
                          startEdit(item);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="pi-btn"
                        disabled={disabled || busy}
                        title={
                          item.mode === "steer"
                            ? "改为排队，Turn 结束后再发"
                            : "改为插话，当前步骤结束后送达"
                        }
                        onClick={() => {
                          void run(async () => {
                            await onUpdate(item.id, {
                              mode: item.mode === "steer" ? "queue" : "steer",
                            });
                          });
                        }}
                      >
                        {item.mode === "steer" ? "改排队" : "改插话"}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="pi-btn pi-x"
                    disabled={disabled || busy}
                    aria-label="撤回这条待发消息"
                    title="撤回"
                    onClick={() => {
                      void run(async () => {
                        await onCancel(item.id);
                      });
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </span>
          </div>
          {item.mode === "steer" && <div className="pi-note">将在当前步骤结束后送达</div>}
        </div>
      ))}
      {error !== null && (
        <div className="pi-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
