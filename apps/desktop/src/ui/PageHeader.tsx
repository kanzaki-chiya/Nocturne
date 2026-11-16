import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  /** 子页面包屑父级：父名按钮 › 当前页标题 */
  crumb?: { parent: string; onBack: () => void } | undefined;
  /** 标题后面的行内附加内容（如技能页的 token 进度、只读徽标） */
  extra?: ReactNode;
  /** 页级操作，靠右 */
  actions?: ReactNode;
  className?: string | undefined;
}

/** 设置页页头（`.phead`）：只放标题（或面包屑）与页级操作，不放副标题 */
export function PageHeader({ title, crumb, extra, actions, className }: PageHeaderProps) {
  return (
    <header className={className === undefined ? "phead" : `phead ${className}`}>
      <h1>
        {crumb !== undefined ? (
          <>
            <button type="button" className="crumb" onClick={crumb.onBack}>
              {crumb.parent}
            </button>
            <span className="sep" aria-hidden="true">
              ›
            </span>
            <span className="cur">{title}</span>
          </>
        ) : (
          title
        )}
        {extra}
      </h1>
      {actions}
    </header>
  );
}
