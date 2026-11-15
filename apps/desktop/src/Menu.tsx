import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface SubmenuCoord {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
}

const SubmenuCoordContext = createContext<SubmenuCoord | null>(null);

export interface MenuProps {
  /** 触发元素；菜单靠它的上/下边缘弹出，关闭时焦点还给它 */
  anchor: HTMLElement | null;
  /** 与触发元素左缘或右缘对齐 */
  align?: "left" | "right";
  placement?: "auto" | "above" | "submenu";
  className?: string;
  label?: string;
  onClose: () => void;
  /** 可选自定义键盘处理；若已 preventDefault 则不再执行默认菜单方向键与 Esc */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

const MENU_WIDTH = 240;
const MENU_GAP = 6;
const MENU_MARGIN = 8;

/**
 * 统一的弹出菜单（mockup .menu）：role="menu"，选项为 role="menuitemradio" /
 * "menuitem" 的按钮；↑↓/Home/End 移动焦点，Enter 激活，Esc 或外部点击关闭
 * 并把焦点还给触发元素。定位用 fixed，量出菜单实际高度后优先向下弹
 * （下方至少能容 ~5 行时）；放不下才向上。空间不足的一侧给 max-height 内滚。
 */
export function Menu({
  anchor,
  align = "left",
  placement = "auto",
  className,
  label,
  onClose,
  onKeyDown,
  children,
}: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const [activeSubmenuId, setActiveSubmenuId] = useState<string | null>(null);
  const coord = useMemo<SubmenuCoord>(
    () => ({ activeId: activeSubmenuId, setActiveId: setActiveSubmenuId }),
    [activeSubmenuId],
  );

  useLayoutEffect(() => {
    const bounds = anchor?.getBoundingClientRect();
    const rawWidth = root.current?.offsetWidth ?? 0;
    const menuWidth = rawWidth > 0 ? rawWidth : MENU_WIDTH;
    const horizontal =
      align === "right"
        ? { right: `${Math.max(MENU_MARGIN, window.innerWidth - (bounds?.right ?? 0))}px` }
        : {
            left: `${Math.max(MENU_MARGIN, Math.min(bounds?.left ?? 0, window.innerWidth - menuWidth - MENU_MARGIN))}px`,
          };
    const height = root.current?.offsetHeight ?? 0;
    const below =
      bounds === undefined ? 0 : window.innerHeight - bounds.bottom - MENU_GAP - MENU_MARGIN;
    const above = bounds === undefined ? 0 : bounds.top - MENU_GAP - MENU_MARGIN;
    // 优先向下开（hero 居中时目录/＋/档位菜单要在 tray 下方）；下方连 ~5 行都放不下才向上
    const BELOW_MIN = 190;
    let vertical: CSSProperties;
    if (placement === "above") {
      vertical = {
        bottom: `${window.innerHeight - (bounds?.top ?? 0) + MENU_GAP}px`,
        ...(height > above ? { maxHeight: `${Math.max(96, above)}px` } : {}),
      };
    } else if (below >= Math.min(height, BELOW_MIN)) {
      vertical = {
        top: `${(bounds?.bottom ?? 0) + MENU_GAP}px`,
        ...(height > below ? { maxHeight: `${Math.max(96, below)}px` } : {}),
      };
    } else {
      vertical = {
        bottom: `${window.innerHeight - (bounds?.top ?? 0) + MENU_GAP}px`,
        ...(height > above ? { maxHeight: `${Math.max(96, above)}px` } : {}),
      };
    }
    if (placement === "submenu") {
      const width = rawWidth > 0 ? rawWidth : MENU_WIDTH;
      const rightX = (bounds?.right ?? 0) + 8;
      const left =
        rightX + width <= window.innerWidth - MENU_MARGIN
          ? rightX
          : Math.max(MENU_MARGIN, (bounds?.left ?? 0) - width - 8);
      const bottomOffset = Math.max(MENU_MARGIN, window.innerHeight - (bounds?.bottom ?? 0));
      setStyle({
        left: `${left}px`,
        bottom: `${bottomOffset}px`,
        maxHeight: `${Math.max(96, (bounds?.bottom ?? window.innerHeight) - MENU_MARGIN)}px`,
        visibility: "visible",
      });
    } else {
      setStyle({ ...horizontal, ...vertical, visibility: "visible" });
    }
    // state 要等重渲染才提交，此刻 DOM 仍是 visibility: hidden，focus() 会静默失败；
    // 先同步写 DOM 让菜单可见再聚焦（与随后提交的 style 一致）
    if (root.current !== null) root.current.style.visibility = "visible";
    const search = root.current?.querySelector<HTMLInputElement>("input.menu-search");
    if (search !== null && search !== undefined) {
      search.focus();
      return;
    }
    const items = root.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
    );
    const checked = root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, [anchor, align, placement]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target) === true || anchor?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [anchor, onClose]);

  const close = () => {
    onClose();
    anchor?.focus();
  };

  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
    event.stopPropagation();
    const items = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
      ) ?? [],
    ).filter((item) => item.closest('[role="menu"]') === root.current);
    if (items.length === 0) return;
    const search = Array.from(
      root.current?.querySelectorAll<HTMLInputElement>("input.menu-search") ?? [],
    ).find((input) => input.closest('[role="menu"]') === root.current);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowUp" && at === 0 && search !== undefined) {
      event.preventDefault();
      search.focus();
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      className={className ? `menu ${className}` : "menu"}
      role="menu"
      aria-label={label}
      ref={root}
      onKeyDown={keyboard}
      style={style}
    >
      <SubmenuCoordContext.Provider value={coord}>{children}</SubmenuCoordContext.Provider>
    </div>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <h6 className="menu-h">{children}</h6>;
}

export function MenuSeparator() {
  return <hr className="menu-sep" />;
}

/** ChoiceControl 的结构化形态（与 Composer.tsx 的 ChoiceControl 一致，避免循环依赖） */
export interface ChoiceMenuControl {
  value: string | undefined;
  heading?: string;
  groups: {
    label?: string;
    options: {
      value: string;
      label: string;
      detail?: ReactNode;
      tag?: string;
      risk?: boolean;
      title?: string;
      disabled?: string;
    }[];
  }[];
  note?: string;
  onSelect: (value: string) => void | Promise<void>;
}

/** 选项列表之后、分隔线下面的动作项（如模型菜单的「管理服务商…」） */
export interface MenuAction {
  label: string;
  onSelect: () => void;
}

const SEARCHABLE_MIN_OPTIONS = 8;

/**
 * 控件菜单：渲染 ChoiceControl 的分组选项（menuitemradio + ✓），
 * 输入框 chip 共用。选择先同步关菜单再触发 onSelect，
 * 异步失败经 onError 回传。可选 searchable 在选项数不少于 8 时显示搜索框。
 */
export function ChoiceMenu({
  anchor,
  align,
  label,
  control,
  action,
  footer,
  searchable = false,
  searchPlaceholder = "搜索模型",
  emptyText = "没有匹配的模型",
  onClose,
  onError,
}: {
  anchor: HTMLElement | null;
  align?: "left" | "right";
  label?: string;
  control: ChoiceMenuControl;
  action?: MenuAction | undefined;
  footer?: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  onClose: () => void;
  onError?: (reason: unknown) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const totalOptions = control.groups.reduce((sum, group) => sum + group.options.length, 0);
  const showSearch = searchable && totalOptions >= SEARCHABLE_MIN_OPTIONS;
  const [query, setQuery] = useState("");
  const q = showSearch ? query.trim().toLowerCase() : "";

  const orderGroup = (options: ChoiceMenuControl["groups"][number]["options"]) => [
    ...options.filter((option) => option.risk !== true),
    ...options.filter((option) => option.risk === true),
  ];

  const filteredGroups =
    q === ""
      ? control.groups
          .map((group) => ({ ...group, options: orderGroup(group.options) }))
          .filter((group) => group.options.length > 0)
      : control.groups
          .map((group) => ({
            ...group,
            options: orderGroup(
              group.options.filter((option) => {
                const detailText = typeof option.detail === "string" ? option.detail : "";
                const text =
                  `${option.label} ${option.value} ${option.tag ?? ""} ${detailText} ${option.title ?? ""}`.toLowerCase();
                return text.includes(q);
              }),
            ),
          }))
          .filter((group) => group.options.length > 0);

  const enabledOptions = filteredGroups.flatMap((group) =>
    group.options.filter((option) => option.disabled === undefined),
  );
  const defaultActiveIndex = () => {
    const allEnabled = control.groups.flatMap((group) =>
      group.options.filter((option) => option.disabled === undefined),
    );
    const idx = allEnabled.findIndex((option) => option.value === control.value);
    return idx >= 0 ? idx : 0;
  };
  const [active, setActive] = useState<number>(defaultActiveIndex);
  const safeActive =
    enabledOptions.length === 0 ? -1 : Math.min(Math.max(0, active), enabledOptions.length - 1);

  const selectValue = (value: string) => {
    onClose();
    anchor?.focus();
    void Promise.resolve(control.onSelect(value)).catch((reason: unknown) => {
      onError?.(reason);
    });
  };

  useEffect(() => {
    if (!showSearch || safeActive < 0) return;
    const activeEl = searchRef.current
      ?.closest('[role="menu"]')
      ?.querySelector<HTMLElement>(".menu-item.act");
    if (activeEl && "scrollIntoView" in activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [showSearch, safeActive, q]);

  const handleKeyDown = showSearch
    ? (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (query !== "") {
            setQuery("");
            setActive(defaultActiveIndex());
            searchRef.current?.focus();
            return;
          }
          onClose();
          anchor?.focus();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          if (enabledOptions.length > 0) {
            setActive((safeActive + 1) % enabledOptions.length);
          }
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          if (enabledOptions.length > 0) {
            setActive((safeActive - 1 + enabledOptions.length) % enabledOptions.length);
          }
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const chosen = enabledOptions[safeActive];
          if (chosen !== undefined) {
            selectValue(chosen.value);
          }
          return;
        }
      }
    : undefined;

  let enabledCursor = 0;

  return (
    <Menu
      anchor={anchor}
      {...(align !== undefined ? { align } : {})}
      {...(label !== undefined ? { label } : {})}
      onClose={onClose}
      {...(handleKeyDown !== undefined ? { onKeyDown: handleKeyDown } : {})}
    >
      {control.heading !== undefined && <MenuHeading>{control.heading}</MenuHeading>}
      {showSearch && (
        <input
          ref={searchRef}
          type="text"
          className="menu-search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      )}
      {filteredGroups.map((group, groupIndex) => {
        const firstRisk = group.options.findIndex((option) => option.risk === true);
        return (
          <Fragment key={group.label ?? groupIndex}>
            {groupIndex > 0 && <MenuSeparator />}
            {group.label !== undefined && <MenuHeading>{group.label}</MenuHeading>}
            {group.options.map((option, optionIndex) => {
              const enabledIdx = option.disabled === undefined ? enabledCursor++ : -1;
              return (
                <Fragment key={option.value}>
                  {optionIndex === firstRisk && optionIndex > 0 && <MenuSeparator />}
                  <MenuItem
                    checked={option.value === control.value}
                    active={showSearch && enabledIdx === safeActive}
                    {...(option.risk === true ? { danger: true } : {})}
                    {...(option.disabled !== undefined ? { disabled: option.disabled } : {})}
                    {...(option.title !== undefined ? { title: option.title } : {})}
                    label={option.label}
                    {...(option.detail !== undefined ? { detail: option.detail } : {})}
                    {...(option.tag !== undefined
                      ? { right: <span aria-hidden="true">{option.tag}</span> }
                      : {})}
                    {...(showSearch && enabledIdx >= 0
                      ? {
                          onHover: () => {
                            if (safeActive !== enabledIdx) setActive(enabledIdx);
                          },
                        }
                      : {})}
                    onSelect={() => {
                      selectValue(option.value);
                    }}
                  />
                </Fragment>
              );
            })}
          </Fragment>
        );
      })}
      {showSearch && filteredGroups.length === 0 && (
        <p className="menu-note menu-empty">{emptyText}</p>
      )}
      {control.note !== undefined && <p className="menu-note">{control.note}</p>}
      {footer}
      {action !== undefined && (
        <>
          <MenuSeparator />
          <MenuItem
            label={action.label}
            onSelect={() => {
              onClose();
              action.onSelect();
            }}
          />
        </>
      )}
    </Menu>
  );
}

export interface MenuSubmenuProps {
  label: string;
  icon?: ReactNode;
  right?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** 二级子菜单触发项：悬停与 → 展开，← 与 Esc 退回触发项，移出延迟收起避免斜向移动闪退。 */
export function MenuSubmenu({ label, icon, right, className, children }: MenuSubmenuProps) {
  const id = useId();
  const coord = useContext(SubmenuCoordContext);
  const [localOpen, setLocalOpen] = useState(false);
  const open = coord !== null ? coord.activeId === id : localOpen;
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => {
    clearTimeout(timer.current);
  };
  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
    };
  }, []);
  const setOpenState = (next: boolean) => {
    if (coord !== null) {
      if (next) coord.setActiveId(id);
      else if (coord.activeId === id) coord.setActiveId(null);
    } else {
      setLocalOpen(next);
    }
  };
  const close = () => {
    cancelClose();
    setOpenState(false);
  };
  return (
    <div
      className="menu-submenu-entry"
      onPointerEnter={cancelClose}
      onPointerLeave={() => {
        cancelClose();
        timer.current = setTimeout(() => {
          setOpenState(false);
        }, 220);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" && event.target === trigger.current) {
          event.preventDefault();
          event.stopPropagation();
          cancelClose();
          setOpenState(true);
        }
      }}
    >
      <MenuItem
        ref={trigger}
        label={label}
        icon={icon}
        right={right}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onHover={() => {
          cancelClose();
          if (!open) {
            trigger.current?.focus();
            setOpenState(true);
          }
        }}
        onSelect={() => {
          cancelClose();
          setOpenState(!open);
        }}
      />
      {open && (
        <Menu
          anchor={trigger.current}
          placement="submenu"
          className={className ? `composer-submenu ${className}` : "composer-submenu"}
          label={label}
          onClose={close}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              trigger.current?.focus();
              return;
            }
            if (event.key === "ArrowLeft") {
              if (
                event.target instanceof HTMLInputElement &&
                event.target.value !== "" &&
                (event.target.selectionStart ?? 0) > 0
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              close();
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </Menu>
      )}
    </div>
  );
}

export interface MenuItemProps {
  ref?: React.Ref<HTMLButtonElement>;
  "aria-haspopup"?: React.AriaAttributes["aria-haspopup"];
  "aria-expanded"?: boolean;
  checked?: boolean;
  active?: boolean;
  danger?: boolean;
  disabled?: string;
  title?: string;
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  onHover?: () => void;
  onSelect: () => void;
}

export function MenuItem({
  ref,
  "aria-haspopup": ariaHaspopup,
  "aria-expanded": ariaExpanded,
  checked,
  active,
  danger,
  disabled,
  title,
  icon,
  label,
  detail,
  right,
  onHover,
  onSelect,
}: MenuItemProps) {
  return (
    <button
      type="button"
      ref={ref}
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
      aria-checked={checked}
      className={`menu-item${active === true ? " act" : ""}${danger === true ? " danger" : ""}`}
      data-active={active === true ? "true" : undefined}
      disabled={disabled !== undefined}
      title={disabled ?? title}
      onClick={onSelect}
      onPointerMove={(event) => {
        if (disabled !== undefined) return;
        if (onHover !== undefined) {
          onHover();
          return;
        }
        // 悬停即焦点：和键盘移动的是同一个高亮
        if (document.activeElement !== event.currentTarget) {
          event.currentTarget.focus();
        }
      }}
    >
      <span className="menu-ck" aria-hidden="true">
        {checked === true ? "✓" : ""}
      </span>
      {icon}
      <span className="menu-label">
        {label}
        {detail !== undefined && detail !== null ? (
          <small title={typeof detail === "string" ? detail : undefined}>{detail}</small>
        ) : null}
      </span>
      {right !== undefined && right !== null ? <span className="menu-r">{right}</span> : null}
    </button>
  );
}
