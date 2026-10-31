import type { AriaAttributes, MouseEventHandler, ReactNode, Ref } from "react";

export type IconButtonSize = "sm" | "md";

export interface IconButtonProps {
  "aria-label": string;
  size?: IconButtonSize | undefined;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  className?: string | undefined;
  "aria-pressed"?: boolean | undefined;
  "aria-expanded"?: boolean | undefined;
  "aria-haspopup"?: AriaAttributes["aria-haspopup"];
  "aria-controls"?: string | undefined;
  onClick?: MouseEventHandler<HTMLButtonElement> | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
  children: ReactNode;
}

export function IconButton({
  "aria-label": ariaLabel,
  size = "md",
  active,
  disabled,
  title,
  className,
  "aria-pressed": ariaPressed,
  "aria-expanded": ariaExpanded,
  "aria-haspopup": ariaHaspopup,
  "aria-controls": ariaControls,
  onClick,
  ref,
  children,
}: IconButtonProps) {
  const classes = ["ib", size === "sm" ? "sm" : "", active ? "on" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      aria-controls={ariaControls}
      onClick={(event) => {
        if (disabled) return;
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
