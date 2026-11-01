import { useId, type ReactNode } from "react";

export interface SettingsRowProps {
  label: ReactNode;
  /** 标签与控件关联（控件是原生输入框时） */
  labelFor?: string | undefined;
  /** 保存值被更高层覆盖时，值以警告色显示，悬停说明覆盖层 */
  overrideTitle?: string | undefined;
  /** 标签旁的徽标 */
  badge?: ReactNode;
  /** 标签下面的说明 */
  desc?: ReactNode;
  /** 标签下面的错误（红字，role=alert） */
  error?: ReactNode;
  /** 标签下面的警告（警告色） */
  warning?: ReactNode;
  /** 整行变淡（依赖的总开关关闭等），禁用态仍由控件自身表达 */
  dimmed?: boolean | undefined;
  className?: string | undefined;
  /** 右侧控件 */
  children?: ReactNode;
}

/** 设置行（`.srow`）：左侧标签（可带徽标、说明），右侧控件；整行是以标签命名的 group */
export function SettingsRow({
  label,
  labelFor,
  overrideTitle,
  badge,
  desc,
  error,
  warning,
  dimmed = false,
  className,
  children,
}: SettingsRowProps) {
  const classes = [
    "srow",
    dimmed ? "dimmed" : "",
    error !== undefined && error !== null && error !== false ? "bad" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const show = (node: ReactNode) => node !== undefined && node !== null && node !== false;
  const labelId = useId();
  return (
    <div className={classes} role="group" aria-labelledby={labelId}>
      <div className="lab">
        <div className="lab-line">
          {labelFor !== undefined ? (
            <label id={labelId} htmlFor={labelFor}>
              {label}
            </label>
          ) : (
            <span id={labelId} className="lab-text">
              {label}
            </span>
          )}
          {badge}
        </div>
        {show(desc) && <div className="desc">{desc}</div>}
        {show(warning) && <div className="desc warn">{warning}</div>}
        {show(error) && (
          <div className="desc err" role="alert">
            {error}
          </div>
        )}
      </div>
      {show(children) && (
        <div className={`ctl${overrideTitle ? " overridden" : ""}`} title={overrideTitle}>
          {children}
        </div>
      )}
    </div>
  );
}
