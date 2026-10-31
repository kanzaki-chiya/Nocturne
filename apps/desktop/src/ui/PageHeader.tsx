import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  /** 标题后面的行内附加内容（如技能页的 token 进度） */
  extra?: ReactNode;
  /** 页级操作，靠右 */
  actions?: ReactNode;
  className?: string | undefined;
}

/** 设置页页头（`.phead`）：只放标题与页级操作，不放副标题 */
export function PageHeader({ title, extra, actions, className }: PageHeaderProps) {
  return (
    <header className={className === undefined ? "phead" : `phead ${className}`}>
      <h1>
        {title}
        {extra}
      </h1>
      {actions}
    </header>
  );
}
