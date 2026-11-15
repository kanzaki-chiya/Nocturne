import { useId } from "react";

/** 扫描线新月外轮廓路径（1024 画布：外圆圆心 (512,512) r300，内圆 (626,430) r252） */
const MOON_PATH = "M499.1 212.3A300 300 0 1 0 792.1 619.5A252 252 0 0 1 499.1 212.3Z";

/** 13 条扫描线横条的 [y, height]（1024 画布内） */
const MOON_STRIPES: readonly (readonly [number, number])[] = [
  [210, 40.1],
  [264.2, 37.9],
  [317.4, 35.8],
  [369.6, 33.6],
  [420.8, 31.4],
  [471.1, 29.3],
  [520.4, 27.1],
  [568.8, 24.9],
  [616.2, 22.7],
  [662.6, 20.6],
  [708, 18.4],
  [752.5, 16.2],
  [796, 54],
];

export interface MoonMarkProps {
  size: number;
}

/** 扫描线新月品牌标志；颜色读取 --a-accent 与 --a-accentAlt，随深浅主题自动切换。 */
export function MoonMark({ size }: MoonMarkProps) {
  const uid = useId();
  const gradId = `${uid}-g`;
  const clipId = `${uid}-m`;
  return (
    <svg width={size} height={size} viewBox="143 143 738 738" aria-hidden="true">
      <defs>
        <linearGradient
          id={gradId}
          gradientUnits="userSpaceOnUse"
          x1="276"
          y1="232"
          x2="786"
          y2="802"
        >
          <stop offset=".1" stopColor="var(--a-accent)" />
          <stop offset=".9" stopColor="var(--a-accentAlt)" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={MOON_PATH} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {MOON_STRIPES.map(([y, height]) => (
          <rect key={y} x={0} y={y} width={1024} height={height} fill={`url(#${gradId})`} />
        ))}
      </g>
    </svg>
  );
}
