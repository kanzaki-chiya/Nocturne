import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export interface MenuProps {
  /** 触发元素；菜单靠它的上/下边缘弹出，关闭时焦点还给它 */
  anchor: HTMLElement | null;
  /** 与触发元素左缘或右缘对齐 */
  align?: "left" | "right";
  label?: string;
  onClose: () => void;
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
export function Menu({ anchor, align = "left", label, onClose, children }: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const bounds = anchor?.getBoundingClientRect();
    const horizontal =
      align === "right"
        ? { right: `${Math.max(MENU_MARGIN, window.innerWidth - (bounds?.right ?? 0))}px` }
        : {
            left: `${Math.max(MENU_MARGIN, Math.min(bounds?.left ?? 0, window.innerWidth - MENU_WIDTH - MENU_MARGIN))}px`,
          };
    const height = root.current?.offsetHeight ?? 0;
    const below =
      bounds === undefined ? 0 : window.innerHeight - bounds.bottom - MENU_GAP - MENU_MARGIN;
    const above = bounds === undefined ? 0 : bounds.top - MENU_GAP - MENU_MARGIN;
    // 优先向下开（hero 居中时目录/＋/档位菜单要在 tray 下方）；下方连 ~5 行都放不下才向上
    const BELOW_MIN = 190;
    let vertical: CSSProperties;
    if (below >= Math.min(height, BELOW_MIN)) {
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
    setStyle({ ...horizontal, ...vertical, visibility: "visible" });
    const items = root.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
    );
    const checked = root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, [anchor, align]);

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
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
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
      className="menu"
      role="menu"
      aria-label={label}
      ref={root}
      onKeyDown={keyboard}
      style={style}
    >
      {children}
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
    options: { value: string; label: string; detail?: ReactNode; disabled?: string }[];
  }[];
  note?: string;
  onSelect: (value: string) => void | Promise<void>;
}

/**
 * 控件菜单：渲染 ChoiceControl 的分组选项（menuitemradio + ✓），
 * 输入框 chip 与底部状态栏共用。选择先同步关菜单再触发 onSelect，
 * 异步失败经 onError 回传。
 */
export function ChoiceMenu({
  anchor,
  align,
  label,
  control,
  onClose,
  onError,
}: {
  anchor: HTMLElement | null;
  align?: "left" | "right";
  label?: string;
  control: ChoiceMenuControl;
  onClose: () => void;
  onError?: (reason: unknown) => void;
}) {
  return (
    <Menu
      anchor={anchor}
      {...(align !== undefined ? { align } : {})}
      {...(label !== undefined ? { label } : {})}
      onClose={onClose}
    >
      {control.heading !== undefined && <MenuHeading>{control.heading}</MenuHeading>}
      {control.groups.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <MenuSeparator />}
          {group.label !== undefined && <MenuHeading>{group.label}</MenuHeading>}
          {group.options.map((option) => (
            <MenuItem
              key={option.value}
              checked={option.value === control.value}
              {...(option.disabled !== undefined ? { disabled: option.disabled } : {})}
              label={option.label}
              {...(option.detail !== undefined ? { detail: option.detail } : {})}
              onSelect={() => {
                onClose();
                void Promise.resolve(control.onSelect(option.value)).catch((reason: unknown) => {
                  onError?.(reason);
                });
              }}
            />
          ))}
        </Fragment>
      ))}
      {control.note !== undefined && <p className="menu-note">{control.note}</p>}
    </Menu>
  );
}

export interface MenuItemProps {
  checked?: boolean;
  disabled?: string;
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  onSelect: () => void;
}

export function MenuItem({
  checked,
  disabled,
  icon,
  label,
  detail,
  right,
  onSelect,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="menu-item"
      disabled={disabled !== undefined}
      title={disabled}
      onClick={onSelect}
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
