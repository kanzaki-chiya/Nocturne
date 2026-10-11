import { useId, useState } from "react";
import type {
  DailyUsageStats,
  ModelRef,
  ModelUsageStats,
  PerformanceGranularity,
  PerformancePoint,
} from "@nocturne/core/protocol";

/** 分类色：本范围按 tokens 前 5 名依次取色，其余为中性色（柱状图里合成「其他」） */
export const CATEGORY_COLORS = [
  "var(--a-cat1)",
  "var(--a-cat2)",
  "var(--a-cat3)",
  "var(--a-cat4)",
  "var(--a-cat5)",
] as const;
export const OTHER_COLOR = "var(--a-muted)";
export const usageModelKey = (m: ModelRef): string => `${m.provider}/${m.model}`;
const modelTokens = (m: ModelUsageStats) => m.inputTokens + m.outputTokens;

/** 按 tokens 排序取色，与表格的排序切换无关；并列时按模型键稳定排序 */
export function modelPalette(models: readonly ModelUsageStats[]): Map<string, string> {
  return new Map(
    [...models]
      .sort(
        (a, b) =>
          modelTokens(b) - modelTokens(a) ||
          usageModelKey(a.model).localeCompare(usageModelKey(b.model)),
      )
      .slice(0, CATEGORY_COLORS.length)
      .map((m, i) => [usageModelKey(m.model), CATEGORY_COLORS[i] ?? OTHER_COLOR]),
  );
}

export const formatTokens = (n: number): string =>
  n >= 100_000_000
    ? `${Number((n / 100_000_000).toFixed(2))} 亿`
    : n >= 10_000
      ? `${Number((n / 10_000).toFixed(1))} 万`
      : Math.round(n).toLocaleString("en-US");
const pad = (n: number) => String(n).padStart(2, "0");
const shortDate = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
const longDate = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const formatDateTime = (d: Date) =>
  `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 「7 天」的每日按模型堆叠柱：最后一根是本地今天 */
export function DailyBars({
  daily,
  palette,
  today = new Date(),
}: {
  daily: readonly DailyUsageStats[];
  palette: ReadonlyMap<string, string>;
  today?: Date;
}) {
  const [active, setActive] = useState<number | undefined>();
  const tipId = useId();
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + i);
    const day = byDate.get(isoDate(date));
    const models = day?.models ?? [];
    const colored = [...palette.keys()].flatMap((key) => {
      const m = models.find((x) => usageModelKey(x.model) === key);
      return m === undefined
        ? []
        : [{ key, tokens: m.tokens, color: palette.get(key) ?? OTHER_COLOR }];
    });
    const other = models
      .filter((m) => !palette.has(usageModelKey(m.model)))
      .reduce((n, m) => n + m.tokens, 0);
    return {
      date,
      total: day?.tokens ?? 0,
      requests: day?.requests ?? 0,
      models,
      segments:
        other > 0 ? [...colored, { key: "other", tokens: other, color: OTHER_COLOR }] : colored,
    };
  });
  const max = Math.max(1, ...days.map((d) => d.total));
  const sum = days.reduce((n, d) => n + d.total, 0);
  const activeDays = days.filter((d) => d.total > 0).length;
  const present = new Set(days.flatMap((d) => d.models.map((m) => usageModelKey(m.model))));
  const legend = [...palette].filter(([key]) => present.has(key));
  const hasOther = [...present].some((key) => !palette.has(key));
  const names = new Map(
    days.flatMap((d) => d.models.map((m) => [usageModelKey(m.model), m.model.model] as const)),
  );
  return (
    <section className="usage-section usage-daily" aria-label="每日用量">
      <div className="usage-daily-top">
        <h4>每日用量</h4>
        <span className="usage-daily-sum">
          {formatTokens(sum)} tokens · 活跃 {activeDays} 天
        </span>
      </div>
      {(legend.length > 0 || hasOther) && (
        <div className="usage-daily-legend">
          {legend.map(([key, color]) => (
            <span key={key}>
              <i style={{ background: color }} />
              {names.get(key) ?? key}
            </span>
          ))}
          {hasOther && (
            <span>
              <i style={{ background: OTHER_COLOR }} />
              其他
            </span>
          )}
        </div>
      )}
      <div className="usage-daily-cols">
        {days.map((d, i) => {
          const on = active === i;
          const rows = [...d.models].sort((a, b) => b.tokens - a.tokens);
          return (
            <div
              key={isoDate(d.date)}
              className={`usage-daily-col${on ? " usage-daily-on" : ""}`}
              tabIndex={0}
              aria-label={`${longDate(d.date)}，${formatTokens(d.total)} tokens`}
              aria-describedby={on ? tipId : undefined}
              onMouseEnter={() => {
                setActive(i);
              }}
              onMouseLeave={() => {
                setActive(undefined);
              }}
              onFocus={() => {
                setActive(i);
              }}
              onBlur={() => {
                setActive(undefined);
              }}
            >
              <div className="usage-daily-track">
                <div className="usage-daily-stack" style={{ height: `${(d.total / max) * 100}%` }}>
                  {d.segments.map((s) => (
                    <i
                      key={s.key}
                      data-model={s.key}
                      style={{ background: s.color, flexGrow: s.tokens }}
                    />
                  ))}
                </div>
              </div>
              <div className="usage-daily-val">{formatTokens(d.total)}</div>
              <div className="usage-daily-label">{shortDate(d.date)}</div>
              {on && (
                <div id={tipId} role="tooltip" className="usage-tip usage-daily-tip">
                  <b>{longDate(d.date)}</b>
                  <div className="usage-tip-sub">
                    {d.requests.toLocaleString("en-US")} 次请求 · {formatTokens(d.total)} tokens
                  </div>
                  {rows.length === 0 ? (
                    <div className="usage-tip-sub">这一天没有用量</div>
                  ) : (
                    <dl>
                      {rows.map((m) => {
                        const key = usageModelKey(m.model);
                        return (
                          <div key={key}>
                            <dt>
                              <i style={{ background: palette.get(key) ?? OTHER_COLOR }} />
                              {m.model.model}
                            </dt>
                            <dd>{formatTokens(m.tokens)}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const tps = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(1));
const seconds = (ms: number | undefined) =>
  ms === undefined ? "—" : `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)}s`;

/** 近期速度：最近 24 个有 Tokens/s 的桶 */
export function Sparkline({ points }: { points: readonly PerformancePoint[] }) {
  const values = points.flatMap((p) =>
    p.tokensPerSecond === undefined ? [] : [p.tokensPerSecond],
  );
  const series = values.slice(-24);
  const w = 84;
  const h = 22;
  if (series.length === 0) return null;
  const max = Math.max(...series) * 1.1 || 1;
  const xy = series.map(
    (v, i) =>
      [
        series.length === 1 ? w / 2 : 2 + (i * (w - 4)) / (series.length - 1),
        h - 2 - (v / max) * (h - 4),
      ] as const,
  );
  const last = xy[xy.length - 1];
  return (
    <svg className="usage-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {xy.length > 1 && <polyline points={xy.map((p) => p.join(",")).join(" ")} />}
      {last && <circle cx={last[0]} cy={last[1]} r={2.2} />}
    </svg>
  );
}

export const CHART_TITLES: Record<PerformanceGranularity, string> = {
  hour: "每个活跃小时的性能",
  day: "每个活跃日的性能",
  week: "每周的性能",
};

export function bucketLabel(start: Date, granularity: PerformanceGranularity): string {
  return granularity === "hour" ? `${shortDate(start)} ${start.getHours()}时` : shortDate(start);
}
export function bucketFullTime(start: Date, granularity: PerformanceGranularity): string {
  if (granularity === "hour") return `${isoDate(start)} ${pad(start.getHours())}:00 这一小时`;
  if (granularity === "day") return isoDate(start);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return `${isoDate(start)} 至 ${isoDate(end)}`;
}
const niceMax = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);
const trimZero = (s: string) => s.replace(/\.0$/, "");

/** 双轴折线：左轴 Tokens/s（强调色实线 + 淡填充），右轴 TTFT（中性色虚线，秒） */
export function PerformanceChart({
  points,
  granularity,
}: {
  points: readonly PerformancePoint[];
  granularity: PerformanceGranularity;
}) {
  const [active, setActive] = useState<number | undefined>();
  const title = CHART_TITLES[granularity];
  const W = 640;
  const H = 230;
  const L = 40;
  const R = 40;
  const T = 10;
  const B = 30;
  const pw = W - L - R;
  const ph = H - T - B;
  const n = points.length;
  // 步长取 20 与 2，四等分刻度落在整数与 0.5 秒上
  const yMax = niceMax(Math.max(0, ...points.map((p) => p.tokensPerSecond ?? 0)) * 1.1, 20);
  const tMax = niceMax((Math.max(0, ...points.map((p) => p.avgTtftMs ?? 0)) / 1000) * 1.15, 2);
  const x = (i: number) => (n === 1 ? L + pw / 2 : L + 12 + (i * (pw - 24)) / (n - 1));
  const y1 = (v: number) => T + ph - (v / yMax) * ph;
  const y2 = (ms: number) => T + ph - (ms / 1000 / tMax) * ph;
  const tpsPts = points.flatMap((p, i) =>
    p.tokensPerSecond === undefined ? [] : [[x(i), y1(p.tokensPerSecond)] as const],
  );
  const ttftPts = points.flatMap((p, i) =>
    p.avgTtftMs === undefined ? [] : [[x(i), y2(p.avgTtftMs)] as const],
  );
  const line = (pts: readonly (readonly [number, number])[]) =>
    pts.map((p) => p.join(",")).join(" ");
  const dense = n > 40;
  const every = Math.max(1, Math.ceil(n / 6));
  const colW = n <= 1 ? pw : (pw - 24) / (n - 1);
  const hovered = active === undefined ? undefined : points[active];
  return (
    <div className="usage-chart-card">
      <div className="usage-chart-top">
        <h5>{title}</h5>
        <div className="usage-chart-legend">
          <span>
            <i />
            Tokens/s
          </span>
          <span>
            <i className="dash" />
            TTFT
          </span>
        </div>
      </div>
      {n === 0 ? (
        <div className="usage-chart-empty">这个范围内没有带计时的请求（旧版本记录不含计时）</div>
      ) : (
        <div className="usage-chart">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
            {[0, 1, 2, 3, 4].map((i) => {
              const y = T + ph - (i / 4) * ph;
              return (
                <g key={i}>
                  <line className="grid" x1={L} x2={W - R} y1={y} y2={y} />
                  <text x={L - 8} y={y + 3} textAnchor="end">
                    {Math.round((yMax * i) / 4)}
                  </text>
                  <text x={W - R + 8} y={y + 3} textAnchor="start">
                    {trimZero(((tMax * i) / 4).toFixed(1))}s
                  </text>
                </g>
              );
            })}
            {points.map((p, i) =>
              i % every === 0 ? (
                <text
                  key={p.start}
                  className="usage-chart-xlabel"
                  x={x(i)}
                  y={H - 8}
                  textAnchor="middle"
                >
                  {bucketLabel(new Date(p.start), granularity)}
                </text>
              ) : null,
            )}
            {tpsPts.length > 1 && (
              <polygon
                className="tps-area"
                points={`${tpsPts[0]?.[0]},${T + ph} ${line(tpsPts)} ${tpsPts[tpsPts.length - 1]?.[0]},${T + ph}`}
              />
            )}
            {ttftPts.length > 1 && <polyline className="ttft" points={line(ttftPts)} />}
            {tpsPts.length > 1 && <polyline className="tps" points={line(tpsPts)} />}
            {!dense &&
              points.map((p, i) => (
                <g key={p.start} className="usage-chart-points">
                  {p.avgTtftMs !== undefined && (
                    <circle className="pt2" cx={x(i)} cy={y2(p.avgTtftMs)} r={n === 1 ? 4 : 2.5} />
                  )}
                  {p.tokensPerSecond !== undefined && (
                    <circle
                      className="pt"
                      cx={x(i)}
                      cy={y1(p.tokensPerSecond)}
                      r={n === 1 ? 4.5 : 3}
                    />
                  )}
                </g>
              ))}
            {hovered !== undefined && active !== undefined && (
              <g className="usage-chart-hover">
                <line className="cursor" x1={x(active)} x2={x(active)} y1={T} y2={T + ph} />
                {hovered.avgTtftMs !== undefined && (
                  <circle className="pt2" cx={x(active)} cy={y2(hovered.avgTtftMs)} r={3} />
                )}
                {hovered.tokensPerSecond !== undefined && (
                  <circle className="pt" cx={x(active)} cy={y1(hovered.tokensPerSecond)} r={3.5} />
                )}
              </g>
            )}
            {points.map((p, i) => {
              const full = bucketFullTime(new Date(p.start), granularity);
              return (
                <rect
                  key={p.start}
                  className="hit"
                  x={x(i) - colW / 2}
                  y={T}
                  width={colW}
                  height={ph}
                  tabIndex={0}
                  aria-label={`${full}，Tokens/s ${tps(p.tokensPerSecond)}，TTFT ${seconds(p.avgTtftMs)}，${p.samples} 次请求`}
                  onMouseEnter={() => {
                    setActive(i);
                  }}
                  onMouseLeave={() => {
                    setActive(undefined);
                  }}
                  onFocus={() => {
                    setActive(i);
                  }}
                  onBlur={() => {
                    setActive(undefined);
                  }}
                />
              );
            })}
          </svg>
          {hovered !== undefined && active !== undefined && (
            <div
              role="tooltip"
              className="usage-tip usage-chart-tip"
              style={{
                left: `${(x(active) / W) * 100}%`,
                transform:
                  x(active) > W / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
              }}
            >
              <b>{bucketFullTime(new Date(hovered.start), granularity)}</b>
              <div>
                Tokens/s <span className="mono">{tps(hovered.tokensPerSecond)}</span>
              </div>
              <div>
                TTFT <span className="mono">{seconds(hovered.avgTtftMs)}</span>
              </div>
              <div className="usage-tip-sub">{hovered.samples.toLocaleString("en-US")} 次请求</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { seconds as formatLatency, tps as formatTokensPerSecond };
