import type { MouseEvent, ReactNode } from "react";
import { ICON_SM, Icon } from "./Icon";

export interface SettingsListRowProps {
  name: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  status?: ReactNode;
  toggle?: ReactNode;
  mono?: boolean | undefined;
  descriptionMono?: boolean | undefined;
  disabled?: boolean | undefined;
  onOpen: () => void;
  onContextMenu?: ((event: MouseEvent<HTMLDivElement>) => void) | undefined;
  title?: string | undefined;
  className?: string | undefined;
}

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='switch'], .slist-toggle";

/** 设置列表页单行（`.slist-row`）：无外卡片，左侧文字为按钮，右侧状态与开关为兄弟节点 */
export function SettingsListRow({
  name,
  description,
  badge,
  status,
  toggle,
  mono = false,
  descriptionMono = false,
  disabled = false,
  onOpen,
  onContextMenu,
  title,
  className,
}: SettingsListRowProps) {
  const show = (node: ReactNode) =>
    node !== undefined && node !== null && node !== false && node !== "";
  const classes = ["slist-row", disabled ? "off" : "", className].filter(Boolean).join(" ");
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR) !== null) {
      return;
    }
    onOpen();
  };
  return (
    <div className={classes} title={title} onClick={handleRowClick} onContextMenu={onContextMenu}>
      <button type="button" className="slist-main" onClick={onOpen}>
        <span className="slist-top">
          <span className={mono ? "slist-name mono" : "slist-name"}>{name}</span>
          {badge}
        </span>
        {show(description) && (
          <span className={descriptionMono ? "slist-desc mono" : "slist-desc"}>{description}</span>
        )}
      </button>
      <div className="slist-right">
        {show(status) && <span className="slist-status">{status}</span>}
        {show(toggle) && <span className="slist-toggle">{toggle}</span>}
        <Icon name="right_small" size={ICON_SM} className="slist-chev" />
      </div>
    </div>
  );
}
