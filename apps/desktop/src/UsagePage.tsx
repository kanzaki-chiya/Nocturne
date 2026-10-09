import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "@nocturne/rpc/client";
import type { DailyUsageStats, ModelPricing, UsageStats } from "@nocturne/core/protocol";
import "./usage.css";

type Range = "7" | "30" | "all";
export const formatUsageTokens = (n: number): string =>
  n >= 100_000_000
    ? `${Number((n / 100_000_000).toFixed(2))} 亿`
    : n >= 10_000
      ? `${Number((n / 10_000).toFixed(1))} 万`
      : n.toLocaleString("en-US");
export const formatUsageCost = (n: number): string =>
  `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const prices = (p: ModelPricing | undefined) =>
  p === undefined
    ? ["—", "—", "—"]
    : [
        p.input === undefined ? "—" : `$${p.input}`,
        `${p.cacheRead === undefined ? "—" : `$${p.cacheRead}`} / ${p.cacheWrite === undefined ? "—" : `$${p.cacheWrite}`}`,
        p.output === undefined ? "—" : `$${p.output}`,
      ];
const SOURCE = { config: "配置", upstream: "上游", "models.dev": "models.dev" };

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
    `${d.date} · ${formatUsageTokens(d.tokens)} tokens · 约 ${formatUsageCost(d.cost)} · ${d.turns} Turn`;
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
    <section className="usage-section" aria-label="每日活跃">
      <div className="usage-section-head">
        <h4>
          每日活跃 <span>近一年</span>
        </h4>
        <div className="usage-toggle" aria-label="热力图着色">
          <button
            aria-pressed={mode === "tokens"}
            onClick={() => {
              setMode("tokens");
            }}
          >
            Tokens
          </button>
          <button
            aria-pressed={mode === "cost"}
            onClick={() => {
              setMode("cost");
            }}
          >
            费用
          </button>
        </div>
      </div>
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
          {selected ? describe(selected) : "悬停查看每日用量，点击固定日期"}
        </span>
        <span className="usage-legend">
          少{" "}
          {[0, 1, 2, 3, 4].map((n) => (
            <i key={n} className={`usage-level-${n}`} />
          ))}{" "}
          多
        </span>
      </div>
    </section>
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
    <section className="usage-section" aria-label={title}>
      <h4>{title}</h4>
      {entries.length === 0 ? (
        <p className="usage-empty">还没有使用记录</p>
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
    </section>
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
  const models = useMemo(
    () =>
      [...(stats?.models ?? [])].sort((a, b) =>
        sort === "cost" ? b.cost.total - a.cost.total : b.inputTokens - a.inputTokens,
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
      <header className="ph3">
        <div className="grow">
          <h3>用量</h3>
          <span className="sub">本机全部会话 · 含子代理</span>
        </div>
        <div className="usage-toggle" aria-label="统计范围">
          {(["7", "30", "all"] as const).map((r) => (
            <button
              key={r}
              aria-pressed={range === r}
              onClick={() => {
                onRange(r);
              }}
            >
              {r === "all" ? "全部" : `${r} 天`}
            </button>
          ))}
        </div>
        <button className="btn" disabled={loading} onClick={onRefresh}>
          {loading ? "读取中…" : "刷新"}
        </button>
      </header>
      <div className="usage-body">
        {error && (
          <div className="usage-error" role="alert">
            读取用量失败：{error}{" "}
            <button className="btn" onClick={onRefresh}>
              重试
            </button>
          </div>
        )}
        {!stats ? (
          <p className="usage-empty">{loading ? "正在读取用量…" : "尚无统计数据"}</p>
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
                <span>会话 / Turn</span>
                <strong>{stats.sessions.toLocaleString("en-US")}</strong>
                <small>
                  {stats.turns.toLocaleString("en-US")} Turns · 子代理 {stats.subagentTurns}
                </small>
              </div>
              <div>
                <span>最长 Turn</span>
                <strong>
                  {stats.longestTurn ? (stats.longestTurn.durationMs / 60_000).toFixed(1) : "—"}
                  <em>{stats.longestTurn ? "分钟" : ""}</em>
                </strong>
                <small title={stats.longestTurn?.sessionTitle}>
                  {stats.longestTurn
                    ? `${stats.longestTurn.date} · ${stats.longestTurn.sessionTitle}`
                    : "暂无已完成 Turn"}
                </small>
              </div>
            </div>
            <Activity stats={stats} range={range} />
            <section className="usage-section" aria-label="Token 构成与费用">
              <div className="usage-section-head">
                <h4>Token 构成与费用</h4>
                <span>输入含缓存读取与写入</span>
              </div>
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
            </section>
            <div className="usage-rankings">
              <Ranking title="常用工具" entries={stats.tools} />
              <Ranking title="常用技能" entries={stats.skills} />
            </div>
            <section className="usage-section" aria-label="按模型">
              <div className="usage-section-head">
                <h4>
                  按模型 <span>{stats.models.length} 个模型</span>
                </h4>
                <div className="usage-toggle" aria-label="模型排序">
                  <button
                    aria-pressed={sort === "cost"}
                    onClick={() => {
                      setSort("cost");
                    }}
                  >
                    按费用
                  </button>
                  <button
                    aria-pressed={sort === "input"}
                    onClick={() => {
                      setSort("input");
                    }}
                  >
                    按输入
                  </button>
                </div>
              </div>
              <div className="usage-table-scroll">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>模型 / 服务商</th>
                      <th>Turns</th>
                      <th>输入</th>
                      <th>输出</th>
                      <th>缓存命中</th>
                      <th>预估费用</th>
                      <th>输入单价</th>
                      <th>缓存读 / 写</th>
                      <th>输出单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => {
                      const p = prices(m.pricing);
                      return (
                        <tr key={`${m.model.provider}/${m.model.model}`}>
                          <th scope="row">
                            <span>{m.model.model}</span>
                            <small>{m.model.provider}</small>
                            {m.pricingSource && (
                              <small className="usage-price-source">
                                {SOURCE[m.pricingSource]}
                                {m.pricing?.tiers?.length ? " · 分档" : ""}
                              </small>
                            )}
                          </th>
                          <td>{m.turns}</td>
                          <td>{formatUsageTokens(m.inputTokens)}</td>
                          <td>{formatUsageTokens(m.outputTokens)}</td>
                          <td>{(m.cacheHitRate * 100).toFixed(1)}%</td>
                          <td>{m.pricing ? formatUsageCost(m.cost.total) : "—"}</td>
                          {p.map((v, i) => (
                            <td key={i}>{v}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!models.length && <p className="usage-empty">这个时间范围内还没有模型用量</p>}
              <p className="usage-table-note">
                单价为 USD / 每百万 token；缓存列为读取 / 写入，缺失缓存价按输入价估算。
              </p>
              {stats.unpricedModels.length > 0 && (
                <p className="usage-notice">
                  {stats.unpricedModels.map((m) => `${m.provider}/${m.model}`).join("、")}{" "}
                  未声明价格。在配置文件的模型条目里写 pricing。
                </p>
              )}
            </section>
            <footer className="usage-footer">
              费用按模型声明的价格估算，只作参考，以服务商账单为准；订阅制服务商不按此计费。
              {stats.skippedFiles > 0 && (
                <span> 已跳过 {stats.skippedFiles} 个损坏或无法读取的日志。</span>
              )}
            </footer>
          </>
        )}
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
