export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  id?: string | undefined;
  title?: string | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
}

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  title,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: SwitchProps) {
  const classes = ["switch", className].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className={classes}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
    />
  );
}
