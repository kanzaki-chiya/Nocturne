import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import { ICON_MD, ICON_SM, Icon, IconButton } from "./ui";

export interface ConversationFindBarProps {
  query: string;
  currentIndex: number;
  total: number;
  focusNonce: number;
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  onQueryChange: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function ConversationFindBar({
  query,
  currentIndex,
  total,
  focusNonce,
  inputRef,
  onQueryChange,
  onPrev,
  onNext,
  onClose,
}: ConversationFindBarProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const fieldRef = inputRef ?? localRef;
  const composingRef = useRef(false);

  useEffect(() => {
    const input = fieldRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [focusNonce, fieldRef]);

  const countText = total > 0 ? `${String(Math.max(0, currentIndex + 1))}/${String(total)}` : "0/0";

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.key === "Process") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (event.shiftKey) onPrev();
      else onNext();
    }
  };

  return (
    <div className="conv-find" role="search" onKeyDown={onKeyDown}>
      <span className="conv-find-ic" aria-hidden="true">
        <Icon name="search" size={ICON_SM} />
      </span>
      <input
        ref={fieldRef}
        type="text"
        className="input conv-find-input"
        aria-label="搜索会话"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
      />
      <span className="conv-find-count">{countText}</span>
      <IconButton size="sm" aria-label="上一处" disabled={total === 0} onClick={onPrev}>
        <Icon name="down_small" size={ICON_MD} className="conv-find-up" />
      </IconButton>
      <IconButton size="sm" aria-label="下一处" disabled={total === 0} onClick={onNext}>
        <Icon name="down_small" size={ICON_MD} />
      </IconButton>
      <IconButton size="sm" aria-label="关闭" onClick={onClose}>
        <Icon name="close" size={ICON_SM} />
      </IconButton>
    </div>
  );
}
