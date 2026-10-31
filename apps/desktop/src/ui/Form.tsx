import type { SubmitEventHandler, ReactNode } from "react";

export interface FormProps {
  /** 给了 onSubmit 时渲染 `<form>`，否则 `<div>` */
  onSubmit?: SubmitEventHandler<HTMLFormElement> | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

/** 表单容器（`.form`）：宽 --w-form，字段纵向排列 */
export function Form({ onSubmit, "aria-label": ariaLabel, className, children }: FormProps) {
  const classes = className === undefined ? "form" : `form ${className}`;
  if (onSubmit !== undefined) {
    return (
      <form className={classes} aria-label={ariaLabel} onSubmit={onSubmit} noValidate>
        {children}
      </form>
    );
  }
  return (
    <div
      className={classes}
      role={ariaLabel !== undefined ? "group" : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export interface FieldProps {
  /** 字段标签 */
  label: ReactNode;
  /** 关联的输入框 id；不给时标签用 `.flabel`（分段控件、下拉等自带名称的控件） */
  htmlFor?: string | undefined;
  /** 标签行右侧的附加内容（来源标记等） */
  aside?: ReactNode;
  /** 控件下面的说明 */
  desc?: ReactNode;
  /** 控件下面的错误 */
  error?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
}

/** 表单字段（`.field`）：标签在上，控件，说明或错误在下 */
export function Field({ label, htmlFor, aside, desc, error, className, children }: FieldProps) {
  const show = (node: ReactNode) => node !== undefined && node !== null && node !== false;
  const head =
    htmlFor !== undefined ? (
      <label htmlFor={htmlFor}>{label}</label>
    ) : (
      <span className="flabel">{label}</span>
    );
  return (
    <div className={className === undefined ? "field" : `field ${className}`}>
      {show(aside) ? (
        <div className="field-head">
          {head}
          {aside}
        </div>
      ) : (
        head
      )}
      {children}
      {show(desc) && <div className="desc">{desc}</div>}
      {show(error) && (
        <div className="desc err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export interface FormFooterProps {
  /** 左侧状态（测试结果、禁用原因） */
  reason?: ReactNode;
  /** 按钮：顺序照效果图——取消、测试连接、保存（主操作最右） */
  children?: ReactNode;
}

/** 表单底部（`.form-foot`）：状态在左，按钮靠右 */
export function FormFooter({ reason, children }: FormFooterProps) {
  return (
    <div className="form-foot">
      <span className="reason">{reason}</span>
      {children}
    </div>
  );
}
