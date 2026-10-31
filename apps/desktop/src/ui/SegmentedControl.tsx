import type { ReactNode } from "react";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean | undefined;
  title?: string | undefined;
}

export interface SegmentedControlProps<T extends string = string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md" | undefined;
  disabled?: boolean | undefined;
  role?: "group" | "tablist" | "radiogroup" | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  disabled,
  role = "group",
  "aria-label": ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const classes = ["seg", size === "sm" ? "sm" : "", className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={role} aria-label={ariaLabel}>
      {options.map((opt) => {
        const selected = opt.value === value;
        const itemDisabled = Boolean(disabled) || Boolean(opt.disabled);
        const roleAttrs =
          role === "tablist"
            ? { role: "tab" as const, "aria-selected": selected }
            : role === "radiogroup"
              ? { role: "radio" as const, "aria-checked": selected }
              : { "aria-pressed": selected };
        return (
          <button
            key={opt.value}
            type="button"
            {...roleAttrs}
            disabled={itemDisabled}
            title={opt.title}
            onClick={() => {
              if (itemDisabled) return;
              onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
