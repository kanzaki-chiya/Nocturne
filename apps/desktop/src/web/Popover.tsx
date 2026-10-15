import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 手机浮层：贴着触发按钮弹出，带指向按钮的小箭头。触发按钮在屏幕下半部时
 * 向上弹（输入框工具栏），在上半部时向下弹（标题栏菜单）。点浮层外或按 Esc
 * 关闭；内容超过可用高度时浮层内部滚动，不超出屏幕。
 */
export function Popover({
  anchor,
  label,
  onClose,
  children,
  wide = false,
}: {
  anchor: HTMLElement | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** 加宽（文件引用、diff 等长内容） */
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    left: number;
    arrow: number;
    up: boolean;
    edge: number;
    maxHeight: number;
  }>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const measure = () => {
      const node = box.current;
      if (anchor === null || node === null) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = document.documentElement.clientWidth;
      const boxWidth = Math.min(node.offsetWidth, width - 16);
      const center = rect.left + rect.width / 2;
      const left = Math.max(8, Math.min(center - boxWidth / 2, width - boxWidth - 8));
      const up = rect.top - top > height / 2;
      setPlace({
        left,
        arrow: Math.max(16, Math.min(center - left, boxWidth - 16)),
        up,
        // 向上弹：距布局视口底边；向下弹：距顶边
        edge: up ? window.innerHeight - rect.top + 10 : rect.bottom + 10,
        maxHeight: Math.max(120, up ? rect.top - top - 24 : top + height - rect.bottom - 24),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [anchor]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (box.current?.contains(target) || anchor?.contains(target)) return;
      closeRef.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      className={`phone-popover${wide ? " wide" : ""}${place?.up === false ? " down" : ""}`}
      style={
        place === undefined
          ? { visibility: "hidden", left: 8, bottom: 0 }
          : {
              left: place.left,
              ...(place.up ? { bottom: place.edge } : { top: place.edge }),
              maxHeight: place.maxHeight,
              ["--arrow" as string]: `${place.arrow}px`,
            }
      }
    >
      <div className="phone-popover-scroll">{children}</div>
    </div>
  );
}

/** 浮层里的一行选项：图标、名称、一行说明、当前项打勾 */
export function PopoverOption({
  icon,
  label,
  detail,
  checked = false,
  disabled,
  risk = false,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  checked?: boolean;
  /** 禁用原因 */
  disabled?: string | undefined;
  risk?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`phone-option${risk ? " risk" : ""}`}
      disabled={disabled !== undefined || onSelect === undefined}
      title={disabled}
      onClick={onSelect}
    >
      {icon !== undefined && <span className="phone-option-icon">{icon}</span>}
      <span className="phone-option-text">
        <b>{label}</b>
        {(detail !== undefined || disabled !== undefined) && (
          <small>{disabled !== undefined && detail === undefined ? disabled : detail}</small>
        )}
      </span>
      {checked && <span className="phone-option-check">✓</span>}
    </button>
  );
}
