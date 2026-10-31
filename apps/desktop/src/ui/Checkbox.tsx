import type { ReactNode } from "react";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  title?: string | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
  children?: ReactNode;
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  id,
  title,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
  children,
}: CheckboxProps) {
  const classes = ["check", className].filter(Boolean).join(" ");
  return (
    <label className={classes} title={title}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        onChange={(event) => {
          if (disabled) return;
          onChange(event.target.checked);
        }}
      />
      {children}
    </label>
  );
}
