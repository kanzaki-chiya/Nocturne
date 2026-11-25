import type { MouseEvent, ReactNode } from "react";
import { ICON_SM, Icon } from "./Icon";

export interface SettingsListRowProps {
  name: ReactNode;
  leading?: ReactNode;
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
  /** 行容器上的 data-* 属性（如 `data-mem-key`），供焦点恢复等按身份定位 */
  rowData?: Record<`data-${string}`, string> | undefined;
}

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='switch'], .slist-toggle";

/** 设置列表页单行（`.slist-row`）：无外卡片，左侧文字为按钮，右侧状态与开关为兄弟节点 */
export function SettingsListRow({
  name,
  leading,
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
  rowData,
}: SettingsListRowProps) {
  const show = (node: ReactNode) =>
    node !== undefined && node !== null && node !== false && node !== "";
  const classes = ["slist-row", disabled ? "off" : "", className].filter(Boolean).join(" ");
  const hasLeading = show(leading);
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR) !== null) {
      return;
    }
    onOpen();
  };
  const content = (
    <>
      <span className="slist-top">
        <span className={mono ? "slist-name mono" : "slist-name"}>{name}</span>
        {badge}
      </span>
      {show(description) && (
        <span className={descriptionMono ? "slist-desc mono" : "slist-desc"}>{description}</span>
      )}
    </>
  );
  return (
    <div
      className={classes}
      title={title}
      onClick={handleRowClick}
      onContextMenu={onContextMenu}
      {...rowData}
    >
      <button
        type="button"
        className={hasLeading ? "slist-main has-leading" : "slist-main"}
        onClick={onOpen}
      >
        {hasLeading ? (
          <>
            <span className="slist-leading">{leading}</span>
            <span className="slist-text">{content}</span>
          </>
        ) : (
          content
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
