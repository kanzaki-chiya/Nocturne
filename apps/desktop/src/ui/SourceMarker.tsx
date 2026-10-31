export type SourceMarkerTone = "neutral" | "warn" | "accent";

export interface SourceMarkerProps {
  /** 标记文字（配置文件名、「已编辑」等）；为空时不渲染 */
  label?: string | undefined;
  /** warn：保存的值被更高层覆盖；accent：已编辑未保存 */
  tone?: SourceMarkerTone | undefined;
  /** 悬停说明；warn 时必须写明被哪一层覆盖 */
  title?: string | undefined;
}

/** 来源标记（`.marker`）：值等于默认时调用方不传 label，组件不渲染 */
export function SourceMarker({ label, tone = "neutral", title }: SourceMarkerProps) {
  if (label === undefined || label === "") return null;
  const classes = tone === "neutral" ? "marker" : `marker ${tone}`;
  return (
    <span className={classes} title={title}>
      {label}
    </span>
  );
}
