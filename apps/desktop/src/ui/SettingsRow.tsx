import type { ReactNode } from "react";

import { SourceMarker, type SourceMarkerProps } from "./SourceMarker";

export interface SettingsRowProps {
  label: ReactNode;
  /** 标签与控件关联（控件是原生输入框时） */
  labelFor?: string | undefined;
  /** 来源标记；不传或值等于默认时不显示 */
  marker?: SourceMarkerProps | undefined;
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

/** 设置行（`.srow`）：左侧标签（可带来源标记、徽标、说明），右侧控件 */
export function SettingsRow({
  label,
  labelFor,
  marker,
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
  return (
    <div className={classes}>
      <div className="lab">
        <div className="lab-line">
          {labelFor !== undefined ? (
            <label htmlFor={labelFor}>{label}</label>
          ) : (
            <span className="lab-text">{label}</span>
          )}
          {marker !== undefined && <SourceMarker {...marker} />}
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
      {show(children) && <div className="ctl">{children}</div>}
    </div>
  );
}
