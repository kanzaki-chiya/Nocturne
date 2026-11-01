import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type {
  DailyUsageStats,
  ModelPricing,
  ModelUsageStats,
  PerformanceGranularity,
  UsageStats,
} from "@nocturne/core/protocol";
import {
  DailyBars,
  OTHER_COLOR,
  PerformanceChart,
  Sparkline,
  formatDateTime,
  formatLatency,
  formatTokens,
  formatTokensPerSecond,
  modelPalette,
  usageModelKey,
} from "./UsageCharts";
import { Button, SegmentedControl, DataTable, EmptyState, PageHeader, SettingsGroup } from "./ui";
import "./usage.css";

type Range = "7" | "30" | "all";
export const formatUsageTokens = formatTokens;
export const formatUsageCost = (n: number): string =>
  `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const price = (v: number | undefined) => (v === undefined ? "—" : `$${v}`);
/** 表格里的输入 / 输出单价；缓存单价在展开区（priceLine） */
const prices = (p: ModelPricing | undefined) => [price(p?.input), price(p?.output)];
/** 展开区的完整单价行；分档模型显示基础档 */
export const priceLine = (p: ModelPricing | undefined): string =>
  `单价 输入 ${price(p?.input)}，缓存读 ${price(p?.cacheRead)} / 写 ${price(p?.cacheWrite)}，输出 ${price(p?.output)}（USD / 每百万 token）${p?.tiers?.length ? "，分档" : ""}`;

function Activity({ stats, range }: { stats: UsageStats; range: Range }) {
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const [hover, setHover] = useState<DailyUsageStats | undefined>();
  const [pinned, setPinned] = useState<DailyUsageStats | undefined>();
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
  const months = cells.flatMap(({ day }, i) =>
    i === 0 || day.date.slice(0, 7) !== cells[i - 1]?.day.date.slice(0, 7)
      ? [
          {
            label: `${Number(day.date.slice(5, 7))} 月`,
            column: Math.floor((first.getDay() + i) / 7) + 1,
          },
        ]
      : [],
  );
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
      <div className="usage-heat-scroll">
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

/** 首次 / 最近使用的相对时间 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const hours = (now - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return "不到 1 小时前";
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
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
          <p className="usage-basis">
            {latency === undefined
              ? "没有带计时的请求"
              : `基于 ${latency.samples.toLocaleString("en-US")} 次请求`}
          </p>
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
          <p className="usage-basis usage-prices">{priceLine(m.pricing)}</p>
        </div>
        {m.firstUsedAt !== undefined && m.lastUsedAt !== undefined && (
          <div className="usage-seen">
            首次使用{" "}
            <span title={formatDateTime(new Date(m.firstUsedAt))}>
              {relativeTime(m.firstUsedAt)}
            </span>
            ，最近使用{" "}
            <span title={formatDateTime(new Date(m.lastUsedAt))}>{relativeTime(m.lastUsedAt)}</span>
          </div>
        )}
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
  onRange,
  onRefresh,
}: {
  stats: UsageStats | undefined;
  range: Range;
  loading: boolean;
  error: string | undefined;
  onRange: (range: Range) => void;
  onRefresh: () => void;
}) {
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
  const cacheRate = total?.inputTokens
    ? ((total.cacheReadTokens ?? 0) / total.inputTokens) * 100
    : 0;
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
  return (
    <section className="page3 usage-page" aria-label="用量" aria-busy={loading}>
      <div className="spage">
        <PageHeader
          title="用量"
          actions={
            <>
              {" "}
              <SegmentedControl
                className="usage-toggle"
                aria-label="统计范围"
                value={range}
                options={(["7", "30", "all"] as const).map((r) => ({
                  value: r,
                  label: r === "all" ? "全部" : `${r} 天`,
                }))}
                onChange={onRange}
              />
              <Button disabled={loading} onClick={onRefresh}>
                {loading ? "读取中…" : "刷新"}
              </Button>
            </>
          }
        />
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
              <div className="usage-overview">
                <div>
                  <span>累计 tokens</span>
                  <strong>{formatUsageTokens(tokenSum)}</strong>
                  <small>输入 + 输出 tokens</small>
                </div>
                <div>
                  <span>预估费用</span>
                  <strong>{formatUsageCost(stats.totals.cost.total)}</strong>
                  <small>未计价模型不计入</small>
                </div>
                <div>
                  <span>缓存命中率</span>
                  <strong>
                    {cacheRate.toFixed(1)}
                    <em>%</em>
                  </strong>
                  <small>读取 / 输入 tokens</small>
                </div>
                <div>
                  <span>会话 / 轮</span>
                  <strong>{stats.sessions.toLocaleString("en-US")}</strong>
                  <small>
                    {stats.turns.toLocaleString("en-US")} 轮，子代理 {stats.subagentTurns} 轮
                  </small>
                </div>
                <div>
                  <span>最长一轮</span>
                  <strong>
                    {stats.longestTurn ? (stats.longestTurn.durationMs / 60_000).toFixed(1) : "—"}
                    <em>{stats.longestTurn ? "分钟" : ""}</em>
                  </strong>
                  <small title={stats.longestTurn?.sessionTitle}>
                    {stats.longestTurn
                      ? `${stats.longestTurn.date}，${stats.longestTurn.sessionTitle}`
                      : "暂无已完成的轮"}
                  </small>
                </div>
              </div>
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
                            <svg
                              className="usage-chev"
                              width="8"
                              height="10"
                              viewBox="0 0 8 10"
                              aria-hidden="true"
                            >
                              <path d="M1.5 1 L6 5 L1.5 9" />
                            </svg>
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
                    { key: "turns", header: "轮", numeric: true, render: (m) => m.turns },
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
                      className: (m) => (m.latency?.avgTtftMs === undefined ? "dim" : undefined),
                      render: (m) => formatLatency(m.latency?.avgTtftMs),
                    },
                    {
                      key: "spark",
                      header: "近期速度",
                      colClassName: "usage-col-spark",
                      render: (m) => <Sparkline points={m.performance} />,
                    },
                    {
                      key: "pi",
                      header: "输入单价",
                      numeric: true,
                      colClassName: "usage-col-price",
                      render: (m) => prices(m.pricing)[0],
                    },
                    {
                      key: "po",
                      header: "输出单价",
                      numeric: true,
                      colClassName: "usage-col-price",
                      render: (m) => prices(m.pricing)[1],
                    },
                  ]}
                />
                {!models.length && <EmptyState inline>这个时间范围内还没有模型用量</EmptyState>}
                <p className="usage-table-note">按声明价格估算，以服务商账单为准。</p>
                {stats.unpricedModels.length > 0 && (
                  <p className="usage-notice">
                    {stats.unpricedModels.map((m) => `${m.provider}/${m.model}`).join("、")}{" "}
                    未声明价格。在配置文件的模型条目里写 pricing。
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
    </section>
  );
}

export function UsagePage({ client }: { client: RpcClient | null | undefined }) {
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
  }, [client, range, refresh]);
  return (
    <UsageView
      stats={stats}
      range={range}
      loading={loading}
      error={error}
      onRange={setRange}
      onRefresh={() => {
        setRefresh((n) => n + 1);
      }}
    />
  );
}
