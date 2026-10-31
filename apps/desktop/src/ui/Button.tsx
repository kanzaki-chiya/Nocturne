import type {
  AriaAttributes,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
  Ref,
} from "react";

export type ButtonVariant =
  "default" | "primary" | "ghost" | "danger" | "ghost-danger" | "danger-solid";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  type?: "button" | "submit" | "reset" | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  id?: string | undefined;
  title?: string | undefined;
  className?: string | undefined;
  onClick?: MouseEventHandler<HTMLButtonElement> | undefined;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement> | undefined;
  "aria-label"?: string | undefined;
  "aria-expanded"?: boolean | undefined;
  "aria-haspopup"?: AriaAttributes["aria-haspopup"];
  "aria-controls"?: string | undefined;
  "aria-pressed"?: boolean | undefined;
  "aria-current"?: AriaAttributes["aria-current"];
  "aria-describedby"?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: "",
  primary: "btn-primary",
  ghost: "btn-ghost",
  danger: "btn-danger",
  "ghost-danger": "btn-ghost btn-danger",
  "danger-solid": "btn-danger-solid",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

export function Button({
  variant = "default",
  size = "md",
  type = "button",
  disabled,
  autoFocus,
  id,
  title,
  className,
  onClick,
  onKeyDown,
  "aria-label": ariaLabel,
  "aria-expanded": ariaExpanded,
  "aria-haspopup": ariaHaspopup,
  "aria-controls": ariaControls,
  "aria-pressed": ariaPressed,
  "aria-current": ariaCurrent,
  "aria-describedby": ariaDescribedby,
  ref,
  children,
}: ButtonProps) {
  const classes = ["btn", VARIANT_CLASS[variant], SIZE_CLASS[size], className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type={type}
      id={id}
      className={classes}
      disabled={disabled}
      autoFocus={autoFocus}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      aria-controls={ariaControls}
      aria-pressed={ariaPressed}
      aria-current={ariaCurrent}
      aria-describedby={ariaDescribedby}
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </button>
  );
}
