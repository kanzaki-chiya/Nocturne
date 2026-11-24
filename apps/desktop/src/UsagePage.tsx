import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type {
  DailyUsageStats,
  ModelUsageStats,
  PerformanceGranularity,
  UsageStats,
} from "@nocturne/core/protocol";
import {
  DailyBars,
  OTHER_COLOR,
  PerformanceChart,
  formatLatency,
  formatTokens,
  formatTokensPerSecond,
  modelPalette,
  usageModelKey,
} from "./UsageCharts";
import {
  Button,
  SegmentedControl,
  DataTable,
  EmptyState,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  PageHeader,
  SettingsGroup,
} from "./ui";
import "./usage.css";

type Range = "7" | "30" | "all";
export const formatUsageTokens = formatTokens;
export const formatUsageCost = (n: number): string =>
  `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Activity({ stats, range }: { stats: UsageStats; range: Range }) {
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const [hover, setHover] = useState<DailyUsageStats | undefined>();
  const [pinned, setPinned] = useState<DailyUsageStats | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [stats]);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const first = new Date(now);
  first.setDate(first.getDate() - 364);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (range === "all" ? 365 : Number(range)) + 1);
  const byDay = new Map(stats.daily.map((d) => [d.date, d]));
  const cells = Array.from({ length: 365 }, (_, i) => {
    const date = new Date(first);
    date.setDate(date.getDate() + i);
    return {
      day: byDay.get(dateKey(date)) ?? { date: dateKey(date), tokens: 0, cost: 0, turns: 0 },
      outside: range !== "all" && date < cutoff,
    };
  });
  const max = Math.max(1, ...cells.map((c) => c.day[mode]));
  const describe = (d: DailyUsageStats) =>
    `${d.date}，${formatUsageTokens(d.tokens)} tokens，约 ${formatUsageCost(d.cost)}，${d.turns} 轮`;
  const selected = hover ?? pinned;
  const columns = Math.ceil((first.getDay() + cells.length) / 7);
  const rawMonths = cells.flatMap(({ day }, i) =>
    i === 0 || day.date.slice(0, 7) !== cells[i - 1]?.day.date.slice(0, 7)
      ? [
          {
            label: `${Number(day.date.slice(5, 7))} 月`,
            column: Math.floor((first.getDay() + i) / 7) + 1,
          },
        ]
      : [],
  );
  // 与下一个月份标签间隔不到 3 列时不显示，避免首尾窄列标签挤在一起
  const months = rawMonths.filter((m, i) => {
    const next = rawMonths[i + 1];
    return next === undefined || next.column - m.column >= 3;
  });
  return (
    <SettingsGroup
      title="每日活跃"
      count="近一年"
      plain
      action={
        <>
          <SegmentedControl
            className="usage-toggle"
            aria-label="热力图着色"
            size="sm"
            value={mode}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "费用" },
            ]}
            onChange={setMode}
          />
        </>
      }
    >
      <div className="usage-heat-scroll" ref={scrollRef}>
        <div
          className="usage-months"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(9px, 1fr))` }}
        >
          {months.map((m, i) => (
            <span
              key={i}
              style={{
                gridColumn: m.column,
                justifySelf: i === months.length - 1 ? "end" : undefined,
              }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div className="usage-heat-wrap">
          <div className="usage-weekdays">
            <span>一</span>
            <span>三</span>
            <span>五</span>
          </div>
          <div className="usage-heat" aria-label="近一年每日用量">
            {Array.from({ length: first.getDay() }, (_, i) => (
              <span className="usage-heat-pad" key={`pad-${i}`} />
            ))}
            {cells.map(({ day, outside }) => {
              const level =
                day[mode] === 0 ? 0 : Math.min(4, 1 + Math.floor((day[mode] / max) * 3));
              return (
                <button
                  key={day.date}
                  className={`usage-cell usage-level-${level}${outside ? " usage-outside" : ""}`}
                  title={describe(day)}
                  aria-label={describe(day)}
                  aria-pressed={pinned?.date === day.date}
                  onMouseEnter={() => {
                    setHover(day);
                  }}
                  onMouseLeave={() => {
                    setHover(undefined);
                  }}
                  onFocus={() => {
                    setHover(day);
                  }}
                  onBlur={() => {
                    setHover(undefined);
                  }}
                  onClick={() => {
                    setPinned(pinned?.date === day.date ? undefined : day);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="usage-heat-footer">
        <span className="usage-day-detail" aria-live="polite">
          {selected ? describe(selected) : null}
        </span>
        <span className="usage-legend">
          少{" "}
          {[0, 1, 2, 3, 4].map((n) => (
            <i key={n} className={`usage-level-${n}`} />
          ))}{" "}
          多
        </span>
      </div>
    </SettingsGroup>
  );
}

function Ranking({
  title,
  entries,
}: {
  title: string;
  entries: { name: string; count: number }[];
}) {
  const max = Math.max(1, ...entries.map((e) => e.count));
  return (
    <SettingsGroup title={title} plain>
      {entries.length === 0 ? (
        <EmptyState inline>还没有使用记录</EmptyState>
      ) : (
        <ol className="usage-ranking">
          {entries.slice(0, 8).map((e) => (
            <li key={e.name}>
              <span title={e.name}>{e.name}</span>
              <div className="usage-bar">
                <i style={{ width: `${(e.count / max) * 100}%` }} />
              </div>
              <b>{e.count.toLocaleString("en-US")}</b>
            </li>
          ))}
        </ol>
      )}
    </SettingsGroup>
  );
}

const percentText = (v: number) => `${(v * 100).toFixed(1)}%`;

function ModelDetail({
  model: m,
  granularity,
}: {
  model: ModelUsageStats;
  granularity: PerformanceGranularity;
}) {
  const read = m.cacheReadTokens ?? 0;
  const write = m.cacheWriteTokens ?? 0;
  const latency = m.latency;
  return (
    <div className="usage-detail">
      <div className="usage-metrics">
        <div>
          <h5>效率</h5>
          <dl>
            <div>
              <dt>缓存命中率</dt>
              <dd>{percentText(m.cacheHitRate)}</dd>
            </div>
            <div>
              <dt>缓存节省</dt>
              <dd>{m.cacheSavings === undefined ? "—" : percentText(m.cacheSavings)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h5>延迟</h5>
          <dl>
            <div>
              <dt>平均耗时</dt>
              <dd>{formatLatency(latency?.avgDurationMs)}</dd>
            </div>
            <div>
              <dt>平均 TTFT</dt>
              <dd>{formatLatency(latency?.avgTtftMs)}</dd>
            </div>
            <div>
              <dt>Tokens/s</dt>
              <dd>{formatTokensPerSecond(latency?.tokensPerSecond)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h5>Tokens</h5>
          <dl>
            <div>
              <dt>未缓存输入</dt>
              <dd>{formatTokens(Math.max(0, m.inputTokens - read - write))}</dd>
            </div>
            <div>
              <dt>缓存读</dt>
              <dd>{formatTokens(read)}</dd>
            </div>
            <div>
              <dt>缓存写</dt>
              <dd>{formatTokens(write)}</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{formatTokens(m.outputTokens)}</dd>
            </div>
          </dl>
        </div>
      </div>
      <PerformanceChart points={m.performance} granularity={granularity} />
    </div>
  );
}

/** 测试与静态视觉检查复用实际页面，不启动后台。 */
export function UsageView({
  stats,
  range,
  loading,
  error,
  variant,
  onRange,
  onRefresh,
}: {
  stats: UsageStats | undefined;
  range: Range;
  loading: boolean;
  error: string | undefined;
  variant?: "phone" | undefined;
  onRange: (range: Range) => void;
  onRefresh: () => void;
}) {
  const phone = variant === "phone";
  const [sort, setSort] = useState<"cost" | "input">("cost");
  // 展开状态按模型键保存，切换范围时保留
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const palette = useMemo(() => modelPalette(stats?.models ?? []), [stats]);
  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const models = useMemo(
    () =>
      // 按费用：未计价排在已计价之后；同费用（含都未计价）按输入
      [...(stats?.models ?? [])].sort(
        (a, b) =>
          (sort === "cost"
            ? Number(!a.pricing) - Number(!b.pricing) || b.cost.total - a.cost.total
            : 0) || b.inputTokens - a.inputTokens,
      ),
    [stats, sort],
  );
  const total = stats?.totals;
  const cacheRate =
    (stats?.cacheHitRate ??
      (total?.inputTokens ? (total.cacheReadTokens ?? 0) / total.inputTokens : 0)) * 100;
  const composition = total
    ? [
        {
          name: "普通输入",
          tokens: Math.max(
            0,
            total.inputTokens - (total.cacheReadTokens ?? 0) - (total.cacheWriteTokens ?? 0),
          ),
          cost: total.cost.input,
          kind: "input",
        },
        {
          name: "缓存读取",
          tokens: total.cacheReadTokens ?? 0,
          cost: total.cost.cacheRead,
          kind: "read",
        },
        {
          name: "缓存写入",
          tokens: total.cacheWriteTokens ?? 0,
          cost: total.cost.cacheWrite,
          kind: "write",
        },
        { name: "输出", tokens: total.outputTokens, cost: total.cost.output, kind: "output" },
      ]
    : [];
  const tokenSum = (total?.inputTokens ?? 0) + (total?.outputTokens ?? 0);
  const rangeOptions = (["7", "30", "all"] as const).map((r) => ({
    value: r,
    label: r === "all" ? "全部" : `${r} 天`,
  }));
  const longestDuration = stats?.longestTurn
    ? (stats.longestTurn.durationMs / 60_000).toFixed(1)
    : "—";
  const longestUnit = stats?.longestTurn ? "分钟" : "";
  const longestDetail = stats?.longestTurn
    ? `${stats.longestTurn.date}，${stats.longestTurn.sessionTitle}`
    : "暂无已完成的轮";
  const sessionsText = stats ? stats.sessions.toLocaleString("en-US") : "0";
  const turnsText = stats
    ? `${stats.turns.toLocaleString("en-US")} 轮，子代理 ${stats.subagentTurns} 轮`
    : "";
  return (
    <section
      className={phone ? "page3 usage-page usage-phone" : "page3 usage-page"}
      aria-label="用量"
      aria-busy={loading}
    >
      <div className="spage">
        <div className="readable">
          {phone ? (
            <div className="usage-phone-range">
              <SegmentedControl
                className="usage-toggle"
                aria-label="统计范围"
                value={range}
                options={rangeOptions}
                onChange={onRange}
              />
              <IconButton
                className="usage-phone-refresh"
                aria-label="刷新"
                title={loading ? "读取中…" : "刷新"}
                disabled={loading}
                onClick={onRefresh}
              >
                <Icon name="refresh_2" size={ICON_MD} />
              </IconButton>
            </div>
          ) : (
            <PageHeader
              title="用量"
              actions={
                <>
                  {" "}
                  <SegmentedControl
                    className="usage-toggle"
                    aria-label="统计范围"
                    value={range}
                    options={rangeOptions}
                    onChange={onRange}
                  />
                  <Button disabled={loading} onClick={onRefresh}>
                    {loading ? "读取中…" : "刷新"}
                  </Button>
                </>
              }
            />
          )}
          <div className="usage-body sbody">
            {error && (
              <div className="usage-error" role="alert">
                读取用量失败：{error}{" "}
                <Button size="sm" onClick={onRefresh}>
                  重试
                </Button>
              </div>
            )}
            {!stats ? (
              <EmptyState>{loading ? "正在读取用量…" : "尚无统计数据"}</EmptyState>
            ) : (
              <>
                {phone ? (
                  <div className="usage-phone-overview">
                    <div className="usage-phone-hero">
                      <div>
                        <span>预估费用</span>
                        <strong>{formatUsageCost(stats.totals.cost.total)}</strong>
                      </div>
                      <div>
                        <span>累计 tokens</span>
                        <strong>{formatUsageTokens(tokenSum)}</strong>
                      </div>
                    </div>
                    <div className="usage-phone-kv">
                      <div>
                        <span>缓存命中率</span>
                        <div className="usage-phone-kv-val">
                          <strong>
                            {cacheRate.toFixed(1)}
                            <em>%</em>
                          </strong>
                        </div>
                      </div>
                      <div>
                        <span>会话 / 轮</span>
                        <div className="usage-phone-kv-val">
                          <strong>{sessionsText}</strong>
                          <small>{turnsText}</small>
                        </div>
                      </div>
                      <div>
                        <span>最长一轮</span>
                        <div className="usage-phone-kv-val">
                          <strong>
                            {longestDuration}
                            <em>{longestUnit}</em>
                          </strong>
                          <small title={stats.longestTurn?.sessionTitle}>{longestDetail}</small>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="usage-overview">
                    <div>
                      <span>累计 tokens</span>
                      <strong>{formatUsageTokens(tokenSum)}</strong>
                    </div>
                    <div>
                      <span>预估费用</span>
                      <strong>{formatUsageCost(stats.totals.cost.total)}</strong>
                    </div>
                    <div>
                      <span>缓存命中率</span>
                      <strong>
                        {cacheRate.toFixed(1)}
                        <em>%</em>
                      </strong>
                    </div>
                    <div>
                      <span>会话 / 轮</span>
                      <strong>{sessionsText}</strong>
                      <small>{turnsText}</small>
                    </div>
                    <div>
                      <span>最长一轮</span>
                      <strong>
                        {longestDuration}
                        <em>{longestUnit}</em>
                      </strong>
                      <small title={stats.longestTurn?.sessionTitle}>{longestDetail}</small>
                    </div>
                  </div>
                )}
                <Activity stats={stats} range={range} />
                <SettingsGroup title="Token 构成与费用" plain>
                  <div className="usage-composition-bar" aria-hidden="true">
                    {composition.map((c) => (
                      <i
                        key={c.kind}
                        className={`usage-kind-${c.kind}`}
                        style={{ width: `${tokenSum ? (c.tokens / tokenSum) * 100 : 0}%` }}
                      />
                    ))}
                  </div>
                  <div className="usage-composition">
                    {composition.map((c) => (
                      <div key={c.kind}>
                        <span>
                          <i className={`usage-kind-${c.kind}`} />
                          {c.name}
                        </span>
                        <b>{formatUsageTokens(c.tokens)}</b>
                        <small>约 {formatUsageCost(c.cost)}</small>
                      </div>
                    ))}
                  </div>
                </SettingsGroup>
                <div className="usage-rankings">
                  <Ranking title="常用工具" entries={stats.tools} />
                  <Ranking title="常用技能" entries={stats.skills} />
                </div>
                {range === "7" && <DailyBars daily={stats.daily} palette={palette} />}
                <SettingsGroup
                  title="按模型"
                  count={stats.models.length}
                  plain
                  action={
                    <SegmentedControl
                      aria-label="模型排序"
                      size="sm"
                      value={sort}
                      options={[
                        { value: "cost", label: "按费用" },
                        { value: "input", label: "按输入" },
                      ]}
                      onChange={setSort}
                    />
                  }
                >
                  {phone ? (
                    models.length > 0 && (
                      <div className="usage-phone-models">
                        {models.map((m) => {
                          const key = usageModelKey(m.model);
                          const color = palette.get(key) ?? OTHER_COLOR;
                          const isExpanded = expanded.has(key);
                          return (
                            <div key={key} className="usage-phone-model">
                              <button
                                type="button"
                                className="usage-phone-model-row"
                                aria-expanded={isExpanded}
                                onClick={() => {
                                  toggle(key);
                                }}
                              >
                                <i
                                  className="usage-swatch"
                                  data-color={color}
                                  style={{ background: color }}
                                  aria-hidden="true"
                                />
                                <span className="usage-phone-model-main">
                                  <span className="usage-phone-model-name" title={m.model.model}>
                                    {m.model.model}
                                  </span>
                                  <small>
                                    输入 {formatUsageTokens(m.inputTokens)} · 输出{" "}
                                    {formatUsageTokens(m.outputTokens)} · 缓存命中{" "}
                                    {(m.cacheHitRate * 100).toFixed(1)}%
                                  </small>
                                </span>
                                <span className="usage-phone-model-cost">
                                  {m.pricing ? formatUsageCost(m.cost.total) : "—"}
                                </span>
                                <Icon name="right_small" size={ICON_SM} className="usage-chev" />
                              </button>
                              {isExpanded && (
                                <ModelDetail model={m} granularity={stats.performanceGranularity} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : (
                    <DataTable
                      aria-label="按模型用量"
                      className="usage-table-scroll usage-data"
                      rows={models}
                      rowKey={(m) => usageModelKey(m.model)}
                      rowHeaderKey="model"
                      rowClassName={() => "usage-model-row"}
                      rowProps={(m) => ({
                        tabIndex: 0,
                        "aria-expanded": expanded.has(usageModelKey(m.model)),
                        onClick: () => {
                          toggle(usageModelKey(m.model));
                        },
                        onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                          if (
                            event.target !== event.currentTarget ||
                            (event.key !== "Enter" && event.key !== " ")
                          )
                            return;
                          event.preventDefault();
                          toggle(usageModelKey(m.model));
                        },
                      })}
                      renderDetail={(m) =>
                        expanded.has(usageModelKey(m.model)) ? (
                          <ModelDetail model={m} granularity={stats.performanceGranularity} />
                        ) : null
                      }
                      columns={[
                        {
                          key: "model",
                          header: "模型 / 服务商",
                          render: (m) => {
                            const key = usageModelKey(m.model);
                            return (
                              <div className="usage-row-name">
                                <Icon name="right_small" size={ICON_SM} className="usage-chev" />
                                <i
                                  className="usage-swatch"
                                  data-color={palette.get(key) ?? OTHER_COLOR}
                                  style={{ background: palette.get(key) ?? OTHER_COLOR }}
                                  aria-hidden="true"
                                />
                                <div>
                                  <span>{m.model.model}</span>
                                  <small>{m.model.provider}</small>
                                </div>
                              </div>
                            );
                          },
                        },
                        {
                          key: "in",
                          header: "输入",
                          numeric: true,
                          render: (m) => formatUsageTokens(m.inputTokens),
                        },
                        {
                          key: "out",
                          header: "输出",
                          numeric: true,
                          render: (m) => formatUsageTokens(m.outputTokens),
                        },
                        {
                          key: "cache",
                          header: "缓存命中",
                          numeric: true,
                          render: (m) => (m.cacheHitRate * 100).toFixed(1) + "%",
                        },
                        {
                          key: "cost",
                          header: "预估费用",
                          numeric: true,
                          render: (m) => (m.pricing ? formatUsageCost(m.cost.total) : "—"),
                        },
                        {
                          key: "tps",
                          header: "Tokens/s",
                          numeric: true,
                          className: (m) =>
                            m.latency?.tokensPerSecond === undefined ? "dim" : undefined,
                          render: (m) => formatTokensPerSecond(m.latency?.tokensPerSecond),
                        },
                        {
                          key: "ttft",
                          header: "TTFT",
                          numeric: true,
                          className: (m) =>
                            m.latency?.avgTtftMs === undefined ? "dim" : undefined,
                          render: (m) => formatLatency(m.latency?.avgTtftMs),
                        },
                      ]}
                    />
                  )}
                  {!models.length && <EmptyState inline>这个时间范围内还没有模型用量</EmptyState>}
                  <p className="usage-table-note">按声明价格估算，以服务商账单为准。</p>
                  {stats.unpricedModels.length > 0 && (
                    <p className="usage-notice">
                      {stats.unpricedModels.map((m) => `${m.provider}/${m.model}`).join("、")}{" "}
                      未声明价格
                    </p>
                  )}
                </SettingsGroup>
                {stats.skippedFiles > 0 && (
                  <footer className="usage-footer">
                    已跳过 {stats.skippedFiles} 个损坏或无法读取的日志。
                  </footer>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function UsagePage({
  client,
  version = 0,
  variant,
}: {
  client: RpcClient | null | undefined;
  version?: number;
  variant?: "phone" | undefined;
}) {
  const [range, setRange] = useState<Range>("30");
  const [stats, setStats] = useState<UsageStats>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const request = client
      ? client.runtime.usageStats(range === "all" ? {} : { days: Number(range) })
      : Promise.reject(new Error("后台尚未连接"));
    void request
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, range, refresh, version]);
  return (
    <UsageView
      stats={stats}
      range={range}
      loading={loading}
      error={error}
      variant={variant}
      onRange={setRange}
      onRefresh={() => {
        setRefresh((n) => n + 1);
      }}
    />
  );
}
