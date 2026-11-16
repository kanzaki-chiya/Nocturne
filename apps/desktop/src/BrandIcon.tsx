import { useId, useMemo } from "react";

import { resolveIconKey, type BrandIconResult } from "./brand-icons";
import { ICON_LG, ICON_MD, ICON_SM, Icon } from "./ui";

export type BrandIconSize = "sm" | "md" | "lg";

const ICON_PX: Record<BrandIconSize, number> = {
  sm: ICON_SM,
  md: ICON_MD,
  lg: ICON_LG,
};

/** 避免同页多个内联 SVG（含隐藏页槽）共享渐变 id 导致 url(#...) 失效。 */
function scopeSvgIds(svg: string, uid: string): string {
  if (!svg.includes("id=")) return svg;
  const suffix = uid.replace(/[^a-zA-Z0-9_-]/g, "");
  return svg
    .replace(/\bid="([^"]+)"/g, (_match, id: string) => `id="${id}-${suffix}"`)
    .replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${id}-${suffix})`);
}

export interface BrandIconProps {
  icon?: BrandIconResult | undefined;
  iconKey?: string | undefined;
  size?: BrandIconSize | undefined;
  className?: string | undefined;
}

/** 内联渲染随附品牌 SVG（或通用回退图标），尺寸由 CSS token 控制，不加 title 或文字。 */
export function BrandIcon({ icon, iconKey, size = "md", className }: BrandIconProps) {
  const uid = useId();
  const resolved = icon ?? (iconKey !== undefined ? resolveIconKey(iconKey) : undefined);
  const scopedSvg = useMemo(
    () => (resolved?.kind === "brand" ? scopeSvgIds(resolved.svg, uid) : ""),
    [resolved, uid],
  );
  if (resolved === undefined) return null;

  const sizeClass = `brand-icon-${size}`;
  if (resolved.kind === "fallback") {
    return (
      <span
        className={["brand-icon", "is-fallback", sizeClass, className].filter(Boolean).join(" ")}
        aria-hidden="true"
      >
        <Icon name={resolved.name} size={ICON_PX[size]} />
      </span>
    );
  }

  return (
    <span
      className={["brand-icon", sizeClass, className].filter(Boolean).join(" ")}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: scopedSvg }}
    />
  );
}
