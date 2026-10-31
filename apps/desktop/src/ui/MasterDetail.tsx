import type { ReactNode, Ref } from "react";

export interface MasterDetailProps {
  /** 左栏无障碍名称 */
  listLabel: string;
  /** 左栏内容：ListGroup / ListItem，底部操作放 listFoot */
  list: ReactNode;
  listFoot?: ReactNode;
  /** 详情区内容（最宽 --w-readable） */
  children?: ReactNode;
  /** 详情区滚动容器 */
  detailRef?: Ref<HTMLDivElement> | undefined;
  className?: string | undefined;
}

/** 主从布局（`.md` / `.md-list` / `.md-detail`）：左栏 --w-list，详情区内容最宽 --w-readable */
export function MasterDetail({
  listLabel,
  list,
  listFoot,
  children,
  detailRef,
  className,
}: MasterDetailProps) {
  return (
    <div className={className === undefined ? "md" : `md ${className}`}>
      <nav className="md-list" aria-label={listLabel}>
        {list}
        {listFoot !== undefined && <div className="foot">{listFoot}</div>}
      </nav>
      <div className="md-detail" ref={detailRef}>
        <div className="inner">{children}</div>
      </div>
    </div>
  );
}

export interface ListGroupProps {
  /** 分组标题；不给时不渲染标题（空分组由调用方整组不渲染） */
  title?: ReactNode;
  count?: number | string | undefined;
  children?: ReactNode;
}

/** 左栏分组（`.nav-group` / `.nav-head`），标题可带计数「标题 · N」 */
export function ListGroup({ title, count, children }: ListGroupProps) {
  return (
    <div
      className="nav-group"
      role="group"
      aria-label={typeof title === "string" ? title : undefined}
    >
      {title !== undefined && (
        <div className="nav-head">
          {title}
          {count !== undefined && ` · ${count}`}
        </div>
      )}
      {children}
    </div>
  );
}

export interface ListItemProps {
  label: ReactNode;
  selected?: boolean | undefined;
  /** 前置圆点状态：ok / warn / err / run / hollow / ""（灰） */
  dot?: "ok" | "warn" | "err" | "run" | "hollow" | "" | undefined;
  /** 等宽名字（服务商 id、档位名等） */
  mono?: boolean | undefined;
  /** 名字后面的徽标 */
  badge?: ReactNode;
  /** 右侧灰字 */
  meta?: ReactNode;
  /** 停用：名字变淡 */
  off?: boolean | undefined;
  title?: string | undefined;
  "aria-label"?: string | undefined;
  onClick?: (() => void) | undefined;
}

/** 左栏条目（`.nav-item`）：一种写法——圆点 + 名字 + 徽标 + 右侧灰字 */
export function ListItem({
  label,
  selected = false,
  dot,
  mono = false,
  badge,
  meta,
  off = false,
  title,
  "aria-label": ariaLabel,
  onClick,
}: ListItemProps) {
  return (
    <button
      type="button"
      className={`nav-item${selected ? " on" : ""}${off ? " off" : ""}`}
      aria-current={selected ? "true" : undefined}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
    >
      {dot !== undefined && (
        <span className={dot === "" ? "dot" : `dot ${dot}`} aria-hidden="true" />
      )}
      <span className={`trunc${mono ? " mono" : ""}`}>{label}</span>
      {badge}
      {meta !== undefined && meta !== null && meta !== "" && <span className="meta">{meta}</span>}
    </button>
  );
}

export interface DetailHeaderProps {
  title: ReactNode;
  mono?: boolean | undefined;
  /** 标题后的徽标、路径等 */
  extra?: ReactNode;
  /** 右侧操作 */
  actions?: ReactNode;
}

/** 详情区标题行（`.dhead`） */
export function DetailHeader({ title, mono = false, extra, actions }: DetailHeaderProps) {
  return (
    <div className="dhead">
      <h2 className={mono ? "mono" : undefined}>{title}</h2>
      {extra}
      {actions !== undefined && actions !== null && actions !== false && (
        <div className="actions">{actions}</div>
      )}
    </div>
  );
}
