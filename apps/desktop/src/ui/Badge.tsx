import type { ReactNode } from "react";

export type BadgeVariant = "neutral" | "accent" | "warn" | "err" | "ok";

export interface BadgeProps {
  variant?: BadgeVariant | undefined;
  title?: string | undefined;
  "aria-label"?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function Badge({
  variant = "neutral",
  title,
  "aria-label": ariaLabel,
  className,
  children,
}: BadgeProps) {
  const classes = ["badge", variant === "neutral" ? "" : variant, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} title={title} aria-label={ariaLabel}>
      {children}
    </span>
  );
}
