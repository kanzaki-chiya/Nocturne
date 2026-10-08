/**
 * 自绘下拉（替代原生 select；desktop-v4.html A 屏）：设置页的下拉与状态栏的权限、
 * 思考档位菜单共用。焦点始终留在触发器上（role="combobox"），选项用
 * aria-activedescendant 指示：Tab 聚焦；Enter/空格/↓ 打开；↑↓ 移动；Enter 选择；
 * Esc 关闭并保持焦点在触发器；点外部关闭。危险项排在分隔线之后，用警告色。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import "./dropdown.css";

export interface DropdownOption {
  value: string;
  /** 选项名（预设名、档位名等，原文） */
  label: string;
  /** 右侧的中文名 */
  tag?: string;
  /** 名字下面的一行说明；触发器上当前值后面的灰字也取它 */
  description?: string;
  /** 危险项：排在分隔线之后，警告色 */
  risk?: boolean;
  /** 不可选的原因（悬停显示） */
  disabled?: string;
}

export interface DropdownProps {
  /** 无障碍名称（触发器与列表共用） */
  label: string;
  value: string | undefined;
  options: readonly DropdownOption[];
  onChange: (value: string) => void;
  /** field：设置页的输入框式触发器；pill：状态栏胶囊，内容由 children 给出 */
  variant?: "field" | "pill";
  children?: ReactNode;
  /** pill 触发器的类名（沿用状态栏样式） */
  triggerClassName?: string;
  /** 打开时的类名（pill 用来高亮） */
  openClassName?: string;
  /** 列表顶部标题 */
  heading?: string;
  /** 列表底部说明 */
  note?: string;
  /** 整个控件禁用的原因 */
  disabled?: string | undefined;
  /** 当前值不在选项里时触发器上的文字 */
  placeholder?: string;
  /** 触发器 title */
  title?: string;
  /** 大量配置项可搜索；不改变已有下拉的交互 */
  searchable?: boolean;
}

const MENU_GAP = 6;
const MENU_MARGIN = 8;
const MENU_MIN_WIDTH = 300;
/** 可搜索的长列表（几百项）不铺满窗口，靠搜索与滚动定位 */
const SEARCH_MAX_HEIGHT = 420;

export function Dropdown({
  label,
  value,
  options,
  onChange,
  variant = "field",
  children,
  triggerClassName,
  openClassName,
  heading,
  note,
  disabled,
  placeholder = "—",
  title,
  searchable = false,
}: DropdownProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [query, setQuery] = useState("");

  // 普通项在前，危险项在分隔线之后；键盘顺序与显示顺序一致
  const filtered = options.filter((o) =>
    `${o.label} ${o.value} ${o.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const ordered = [...filtered.filter((o) => o.risk !== true), ...filtered.filter((o) => o.risk)];
  const firstRisk = ordered.findIndex((o) => o.risk === true);
  const current = options.find((o) => o.value === value);
  const enabled = (i: number) => ordered[i] !== undefined && ordered[i].disabled === undefined;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) trigger.current?.focus();
  }, []);

  const openList = () => {
    if (disabled !== undefined) return;
    setQuery("");
    const initial = [...options.filter((o) => o.risk !== true), ...options.filter((o) => o.risk)];
    const at = initial.findIndex((o) => o.value === value);
    setActive(at >= 0 ? at : initial.findIndex((o) => o.disabled === undefined));
    setOpen(true);
  };

  const choose = (i: number) => {
    const option = ordered[i];
    if (option === undefined || option.disabled !== undefined) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  const step = (from: number, delta: 1 | -1): number => {
    const n = ordered.length;
    for (let k = 1; k <= n; k += 1) {
      const i = (((from + delta * k) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return from;
  };

  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openList();
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        // 只关下拉：不让外层对话框或设置区再处理这次 Esc
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setActive((i) =>
          step(
            i < 0 ? (event.key === "ArrowDown" ? -1 : 0) : i,
            event.key === "ArrowDown" ? 1 : -1,
          ),
        );
        return;
      case "Home":
        event.preventDefault();
        setActive(step(-1, 1));
        return;
      case "End":
        event.preventDefault();
        setActive(step(ordered.length, -1));
        return;
      case " ":
        if (searchable && event.currentTarget instanceof HTMLInputElement) return;
        event.preventDefault();
        choose(active);
        return;
      case "Enter":
        event.preventDefault();
        choose(active);
        return;
    }
  };

  // 定位：fixed，优先向下；下方放不下且上方更宽裕时向上（状态栏在底部）
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const place = (event?: Event) => {
      if (event?.type === "scroll") {
        const target = event.target;
        if (target instanceof Node && list.current?.contains(target)) return;
        if (target instanceof Element && !target.contains(trigger.current)) return;
      }
      const bounds = trigger.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      const height = list.current?.offsetHeight ?? 0;
      const width = Math.max(bounds.width, MENU_MIN_WIDTH);
      const left = Math.max(
        MENU_MARGIN,
        Math.min(bounds.left, window.innerWidth - width - MENU_MARGIN),
      );
      const below = window.innerHeight - bounds.bottom - MENU_GAP - MENU_MARGIN;
      const above = bounds.top - MENU_GAP - MENU_MARGIN;
      const down = below >= height || below >= above;
      const room = searchable
        ? Math.min(down ? below : above, SEARCH_MAX_HEIGHT)
        : down
          ? below
          : above;
      setStyle({
        left: `${left}px`,
        width: `${width}px`,
        ...(down
          ? { top: `${bounds.bottom + MENU_GAP}px` }
          : { bottom: `${window.innerHeight - bounds.top + MENU_GAP}px` }),
        ...(searchable || height > room ? { maxHeight: `${Math.max(120, room)}px` } : {}),
        visibility: "visible",
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, searchable]);

  // 当前项滚到可见
  useEffect(() => {
    if (!open || active < 0) return;
    const el = document.getElementById(`${id}-opt-${active}`);
    // jsdom 没有 scrollIntoView
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  // 点外部关闭（焦点不抢回触发器）
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target) === true || list.current?.contains(target) === true) {
        return;
      }
      close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, close]);

  const listId = `${id}-list`;
  const pill = variant === "pill";
  return (
    <span className={`ddw${pill ? " ddw-pill" : ""}`}>
      <button
        type="button"
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
        disabled={disabled !== undefined}
        title={title ?? disabled}
        className={
          pill
            ? `${triggerClassName ?? ""}${open && openClassName !== undefined ? ` ${openClassName}` : ""}`
            : `dd${open ? " open" : ""}`
        }
        onClick={() => {
          if (open) close(true);
          else openList();
        }}
        onKeyDown={keyboard}
      >
        {pill ? (
          children
        ) : (
          <>
            <span className="dd-v">{current?.label ?? placeholder}</span>
            {current?.description !== undefined && (
              <span className="dd-d">{current.description}</span>
            )}
            <span className={`dd-a fold-arrow${open ? " down" : ""}`} aria-hidden="true">
              ▶
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="ddm" ref={list} style={style}>
          {heading !== undefined && <div className="ddm-h">{heading}</div>}
          {searchable && (
            <input
              className="dd-search"
              aria-controls={listId}
              aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
              aria-label={`搜索${label}`}
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={keyboard}
            />
          )}
          <div id={listId} role="listbox" aria-label={label}>
            {ordered.map((o, i) => (
              <Fragment key={o.value}>
                <div
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled !== undefined || undefined}
                  title={o.disabled}
                  className={`ddo${o.value === value ? " on" : ""}${i === active ? " act" : ""}${o.risk === true ? " risk" : ""}${i === firstRisk && i > 0 ? " sep" : ""}`}
                  onPointerMove={() => {
                    if (o.disabled === undefined && active !== i) setActive(i);
                  }}
                  onMouseDown={(e) => {
                    // 不让触发器失焦：选择后焦点仍在触发器上
                    e.preventDefault();
                  }}
                  onClick={() => {
                    choose(i);
                  }}
                >
                  <span className="ck" aria-hidden="true">
                    {o.value === value ? "✓" : ""}
                  </span>
                  <b>{o.label}</b>
                  {o.tag !== undefined && <span className="tg">{o.tag}</span>}
                  {o.description !== undefined && <span className="ds">{o.description}</span>}
                </div>
              </Fragment>
            ))}
            {ordered.length === 0 && <p className="ddm-n">没有匹配的选项</p>}
          </div>
          {note !== undefined && <p className="ddm-n">{note}</p>}
        </div>
      )}
    </span>
  );
}
