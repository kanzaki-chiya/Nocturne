import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** 一句话说明当前为空 */
  children?: ReactNode;
  /** 主操作（可选） */
  action?: ReactNode;
  /** inline：行内空状态（`.inline-empty`，表格、分组里）；默认整页（`.empty`） */
  inline?: boolean | undefined;
}

/** 空状态：整页一种（左对齐、文字 + 可选操作），行内一种 */
export function EmptyState({ children, action, inline = false }: EmptyStateProps) {
  if (inline) {
    return (
      <div className="inline-empty">
        {children}
        {action}
      </div>
    );
  }
  return (
    <div className="empty">
      {children !== undefined && children !== null && children !== false && children !== "" && (
        <div>{children}</div>
      )}
      {action}
    </div>
  );
}
