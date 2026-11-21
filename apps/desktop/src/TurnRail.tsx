import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  computeTurnTickLayout,
  MIN_TURNS_FOR_RAIL,
  RAIL_CLOSE_DELAY_MS,
  type TurnRailItem,
} from "./turn-rail";

export interface TurnRailProps {
  turns: readonly TurnRailItem[];
  currentIndex: number;
  containerHeight: number;
  onJump: (seq: number, index: number) => void;
}

export function TurnRail({ turns, currentIndex, containerHeight, onJump }: TurnRailProps) {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, []);

  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const closeNow = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined;
      setOpen(false);
    }, RAIL_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  // 展开列表时滚到当前轮
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = activeRowRef.current;
    if (list === null || row === null) return;
    const targetTop = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    list.scrollTop = Math.max(0, targetTop);
  }, [open]);

  const layout = useMemo(
    () => computeTurnTickLayout(turns.length, containerHeight),
    [turns.length, containerHeight],
  );

  if (turns.length < MIN_TURNS_FOR_RAIL) return null;

  const onBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    scheduleClose();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeNow();
    }
  };

  return (
    <nav
      className={`turn-rail${open ? " open" : ""}`}
      aria-label="轮次"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="turn-ticks" tabIndex={0}>
        <div className="turn-ticks-track" style={{ height: `${String(layout.trackHeight)}px` }}>
          {turns.map((turn, index) => (
            <span
              key={turn.seq}
              className={`turn-tick${index === currentIndex ? " on" : ""}`}
              style={{ top: `${String(layout.tops[index] ?? 0)}px` }}
            />
          ))}
        </div>
      </div>
      {open ? (
        <div className="turn-list" ref={listRef}>
          {turns.map((turn, index) => {
            const active = index === currentIndex;
            return (
              <button
                key={turn.seq}
                type="button"
                className={`turn-row${active ? " on" : ""}`}
                aria-current={active ? "true" : undefined}
                ref={active ? activeRowRef : undefined}
                onClick={() => {
                  onJump(turn.seq, index);
                }}
              >
                {turn.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}
