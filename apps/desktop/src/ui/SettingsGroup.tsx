import { useId, type ReactNode } from "react";

export interface SettingsGroupProps {
  /** 分组标题；不给时不渲染标题行 */
  title?: ReactNode;
  /** 计数，显示为「标题 · N」 */
  count?: number | string | undefined;
  /** 标题行右侧操作 */
  action?: ReactNode;
  /** true 时内容不包进卡片（表格、说明、空状态） */
  plain?: boolean;
  className?: string | undefined;
  children?: ReactNode;
}

/** 设置分组（`.group` / `.ghead` / `.card`） */
export function SettingsGroup({
  title,
  count,
  action,
  plain = false,
  className,
  children,
}: SettingsGroupProps) {
  const headingId = useId();
  const hasHead = title !== undefined;
  // 字符串标题直接给出完整名称，避免「· N」前的空格在名称计算里被吞掉
  const plainName =
    typeof title === "string" ? (count === undefined ? title : `${title} · ${count}`) : undefined;
  return (
    <section
      className={className === undefined ? "group" : `group ${className}`}
      aria-label={plainName}
      aria-labelledby={hasHead && plainName === undefined ? headingId : undefined}
    >
      {hasHead && (
        <div className="ghead">
          <h2 id={headingId}>
            {title}
            {count !== undefined && <span className="count"> · {count}</span>}
          </h2>
          {action}
        </div>
      )}
      {plain ? children : <div className="card">{children}</div>}
    </section>
  );
}
