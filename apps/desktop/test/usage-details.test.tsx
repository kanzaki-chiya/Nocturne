import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelUsageStats, PerformancePoint, UsageStats } from "@nocturne/core/protocol";
import { UsageView, priceLine } from "../src/UsagePage";
import {
  CATEGORY_COLORS,
  DailyBars,
  OTHER_COLOR,
  PerformanceChart,
  modelPalette,
  niceAxis,
} from "../src/UsageCharts";

afterEach(cleanup);

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("缺少元素");
  return value;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n: number) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);
};
const cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
const ref = (model: string) => ({ provider: "p", model });

function model(name: string, input: number, extra: Partial<ModelUsageStats> = {}): ModelUsageStats {
  return {
    model: ref(name),
    inputTokens: input,
    outputTokens: 0,
    cost,
    turns: 1,
    cacheHitRate: 0,
    requests: 1,
    performance: [],
    ...extra,
  };
}
const point = (start: Date, tokensPerSecond?: number, avgTtftMs?: number): PerformancePoint => ({
  start: start.toISOString(),
  samples: 3,
  ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  ...(avgTtftMs === undefined ? {} : { avgTtftMs }),
});

const timed = model("timed", 900_000, {
  pricing: { input: 2, output: 8, cacheRead: 0.2 },
  outputTokens: 40_000,
  cacheReadTokens: 600_000,
  cacheWriteTokens: 10_000,
  cacheHitRate: 0.66,
  cacheSavings: 0.42,
  requests: 12,
  firstUsedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  latency: {
    samples: 12,
    avgDurationMs: 3000,
    avgTtftMs: 12_400,
    tokensPerSecond: 61.25,
    speedSamples: 10,
  },
  performance: [
    point(new Date(2026, 9, 9, 14), 55, 900),
    point(new Date(2026, 9, 10, 9), 60, 1100),
  ],
});
const legacy = model("legacy", 800_000);
const stats: UsageStats = {
  totals: { inputTokens: 1_700_000, outputTokens: 40_000, cost },
  sessions: 1,
  turns: 3,
  subagentTurns: 0,
  daily: [
    {
      date: iso(daysAgo(1)),
      tokens: 300_000,
      cost: 0,
      turns: 2,
      requests: 5,
      models: [
        { model: ref("legacy"), tokens: 100_000, requests: 2 },
        { model: ref("timed"), tokens: 200_000, requests: 3 },
      ],
    },
  ],
  performanceGranularity: "hour",
  models: [timed, legacy],
  tools: [],
  skills: [],
  unpricedModels: [],
  skippedFiles: 0,
};

function view(range: "7" | "30" | "all", s: UsageStats = stats) {
  return (
    <UsageView
      stats={s}
      range={range}
      loading={false}
      error={undefined}
      onRange={() => undefined}
      onRefresh={() => undefined}
    />
  );
}
const row = (name: RegExp) => {
  const tr = screen.getByRole("rowheader", { name }).closest("tr");
  if (tr === null) throw new Error("缺少模型行");
  return tr;
};

describe("每日用量柱状图", () => {
  it("只在 7 天范围显示", () => {
    const rendered = render(view("30"));
    expect(screen.queryByRole("region", { name: "每日用量" })).toBeNull();
    rendered.rerender(view("all"));
    expect(screen.queryByRole("region", { name: "每日用量" })).toBeNull();
    rendered.rerender(view("7"));
    const region = screen.getByRole("region", { name: "每日用量" });
    expect(region.querySelector(".usage-daily-sum")?.textContent).toBe("30 万 tokens · 活跃 1 天");
  });

  it("7 根柱，日期 M/D 不带星期；空日只有轨道，值为 0", () => {
    render(view("7"));
    const cols = document.querySelectorAll(".usage-daily-col");
    expect(cols).toHaveLength(7);
    const labels = [...document.querySelectorAll(".usage-daily-label")].map((e) => e.textContent);
    expect(labels).toEqual(
      [6, 5, 4, 3, 2, 1, 0].map((n) => `${daysAgo(n).getMonth() + 1}/${daysAgo(n).getDate()}`),
    );
    expect(labels.join("")).not.toMatch(/周|星期/);
    const empty = cols[0];
    expect(empty?.querySelector(".usage-daily-val")?.textContent).toBe("0");
    expect(empty?.querySelector(".usage-daily-track")).not.toBeNull();
    expect(empty?.querySelectorAll(".usage-daily-stack i")).toHaveLength(0);
    expect(cols[5]?.querySelector(".usage-daily-val")?.textContent).toBe("30 万");
  });

  it("提示显示长日期、请求数与按 tokens 排序的模型；空日写明没有用量", () => {
    render(view("7"));
    const cols = document.querySelectorAll<HTMLElement>(".usage-daily-col");
    const d = daysAgo(1);
    fireEvent.mouseEnter(must(cols[5]));
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector("b")?.textContent).toBe(
      `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    );
    expect(tip.textContent).toContain("5 次请求 · 30 万 tokens");
    expect([...tip.querySelectorAll("dt")].map((e) => e.textContent)).toEqual(["timed", "legacy"]);
    fireEvent.mouseLeave(must(cols[5]));
    fireEvent.focus(must(cols[0]));
    expect(screen.getByRole("tooltip").textContent).toContain("这一天没有用量");
  });

  it("前 5 个模型按 tokens 取分类色，其余归为灰色「其他」", () => {
    const models = [1, 2, 3, 4, 5, 6, 7].map((i) => model(`m${i}`, i * 1000));
    const palette = modelPalette(models);
    expect([...palette]).toEqual(
      ["m7", "m6", "m5", "m4", "m3"].map((m, i) => [`p/${m}`, CATEGORY_COLORS[i]]),
    );
    render(
      <DailyBars
        palette={palette}
        daily={[
          {
            date: iso(new Date()),
            tokens: 13_000,
            cost: 0,
            turns: 1,
            requests: 2,
            models: [
              { model: ref("m7"), tokens: 7000, requests: 1 },
              { model: ref("m1"), tokens: 1000, requests: 1 },
              { model: ref("m2"), tokens: 5000, requests: 1 },
            ],
          },
        ]}
      />,
    );
    const stack = [...document.querySelectorAll<HTMLElement>(".usage-daily-stack i")];
    expect(stack.map((e) => e.dataset.model)).toEqual(["p/m7", "other"]);
    expect(stack[1]?.style.background).toBe(OTHER_COLOR);
    expect(stack[1]?.style.flexGrow).toBe("6000");
    expect(document.querySelector(".usage-daily-legend")?.textContent).toBe("m7其他");
  });

  it("模型表名称前有对应色块", () => {
    render(view("30"));
    expect(row(/timed/).querySelector<HTMLElement>(".usage-swatch")?.dataset.color).toBe(
      CATEGORY_COLORS[0],
    );
    expect(row(/legacy/).querySelector<HTMLElement>(".usage-swatch")?.dataset.color).toBe(
      CATEGORY_COLORS[1],
    );
  });
});

describe("模型行展开", () => {
  it("点击与键盘展开收起，可同时展开多行，切换范围保留", () => {
    const rendered = render(view("30"));
    const a = row(/timed/);
    const b = row(/legacy/);
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".usage-detail")).toBeNull();
    fireEvent.click(a);
    expect(a.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(b, { key: "Enter" });
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll(".usage-detail")).toHaveLength(2);
    fireEvent.keyDown(b, { key: " " });
    expect(b.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(a, { key: "x" });
    expect(a.getAttribute("aria-expanded")).toBe("true");
    rendered.rerender(view("7"));
    expect(row(/timed/).getAttribute("aria-expanded")).toBe("true");
    expect(row(/legacy/).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row(/timed/));
    expect(document.querySelector(".usage-detail")).toBeNull();
  });

  it("新列：有计时显示 Tokens/s、TTFT 与速度线，旧日志显示「—」", () => {
    render(view("30"));
    const headers = [...document.querySelectorAll(".usage-table thead th")].map(
      (e) => e.textContent,
    );
    expect(headers).toEqual([
      "模型 / 服务商",
      "Turns",
      "输入",
      "输出",
      "缓存命中",
      "预估费用",
      "Tokens/s",
      "TTFT",
      "近期速度",
      "输入单价",
      "输出单价",
    ]);
    expect(row(/timed/).children).toHaveLength(11);
    expect([...row(/timed/).querySelectorAll("td")].slice(-2).map((e) => e.textContent)).toEqual([
      "$2",
      "$8",
    ]);
    const cells = (tr: HTMLElement) => [...tr.querySelectorAll("td")].slice(5, 8);
    const [tps, ttft, spark] = cells(row(/timed/));
    expect(tps?.textContent).toBe("61.3");
    expect(ttft?.textContent).toBe("12s");
    expect(spark?.querySelector("svg.usage-spark polyline")).not.toBeNull();
    expect(spark?.querySelectorAll("circle")).toHaveLength(1);
    const [tps2, ttft2, spark2] = cells(row(/legacy/));
    expect(tps2?.textContent).toBe("—");
    expect(tps2?.className).toBe("dim");
    expect(ttft2?.textContent).toBe("—");
    expect(spark2?.querySelector("svg")).toBeNull();
  });

  it("展开区显示效率、延迟、Tokens 明细与首次 / 最近使用", () => {
    render(view("30"));
    fireEvent.click(row(/timed/));
    const detail = document.querySelector<HTMLElement>(".usage-detail");
    if (detail === null) throw new Error("缺少展开区");
    const values = Object.fromEntries(
      [...detail.querySelectorAll(".usage-metrics dl > div")].map((e) => [
        e.querySelector("dt")?.textContent,
        e.querySelector("dd")?.textContent,
      ]),
    );
    expect(values).toEqual({
      缓存命中率: "66.0%",
      缓存节省: "42.0%",
      平均耗时: "3.0s",
      "平均 TTFT": "12s",
      "Tokens/s": "61.3",
      未缓存输入: "29 万",
      缓存读: "60 万",
      缓存写: "1 万",
      输出: "4 万",
    });
    expect(detail.querySelector(".usage-basis")?.textContent).toBe("基于 12 次请求");
    expect(detail.querySelector(".usage-prices")?.textContent).toBe(
      "单价 输入 $2 · 缓存读 $0.2 / 写 — · 输出 $8（USD / 每百万 token）",
    );
    expect(detail.closest("td")?.colSpan).toBe(11);
    const seen = detail.querySelector(".usage-seen");
    expect(seen?.textContent).toBe("首次使用 3 天前 · 最近使用 2 小时前");
    expect(seen?.querySelector("span")?.getAttribute("title")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    expect(within(detail).getByRole("img", { name: "每个活跃小时的性能" })).toBeTruthy();

    fireEvent.click(row(/legacy/));
    const other = document.querySelectorAll<HTMLElement>(".usage-detail")[1];
    expect(other?.querySelector(".usage-basis")?.textContent).toBe("没有带计时的请求");
    expect(other?.querySelector(".usage-chart-empty")?.textContent).toBe(
      "这个范围内没有带计时的请求（旧版本记录不含计时）",
    );
  });
});

/** jsdom 没有布局：模拟图区像素宽度 */
function withChartWidth(width: number, run: () => void) {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList.contains("usage-chart")
      ? ({ width, height: 220 } as DOMRect)
      : rect.call(this);
  };
  try {
    run();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
  }
}

describe("性能图", () => {
  it("刻度取 1 / 2 / 2.5 / 5 × 10ⁿ 步长，留余量，Tokens/s 为整数", () => {
    expect(niceAxis(304, "count")).toEqual({ step: 100, max: 400 });
    expect(niceAxis(6.1, "seconds")).toEqual({ step: 2, max: 8 });
    expect(niceAxis(300, "count")).toEqual({ step: 100, max: 400 });
    expect(niceAxis(80, "count")).toEqual({ step: 25, max: 100 });
    expect(niceAxis(30, "count")).toEqual({ step: 10, max: 40 });
    expect(niceAxis(7, "count")).toEqual({ step: 2, max: 8 });
    expect(niceAxis(0.4, "count")).toEqual({ step: 1, max: 4 });
    expect(niceAxis(1.6, "seconds")).toEqual({ step: 0.5, max: 2 });
    expect(niceAxis(0.3, "seconds")).toEqual({ step: 0.1, max: 0.4 });
    expect(niceAxis(0, "seconds")).toEqual({ step: 0.5, max: 2 });
    for (const v of [1, 3, 13, 57, 99, 340, 1234])
      expect(Number.isInteger(niceAxis(v, "count").step)).toBe(true);
  });

  it("坐标轴标签：左轴整数，右轴秒且不带多余小数", () => {
    const { rerender } = render(
      <PerformanceChart points={[point(new Date(2026, 9, 11, 9), 304, 6100)]} granularity="hour" />,
    );
    const labels = () =>
      [...document.querySelectorAll(".usage-chart svg > g > text")].map((e) => e.textContent);
    expect(labels()).toEqual(["0", "0s", "100", "2s", "200", "4s", "300", "6s", "400", "8s"]);
    expect(document.querySelectorAll(".usage-chart-xlabel")).toHaveLength(1);
    expect(document.querySelector(".usage-chart-xlabel")?.textContent).toBe("10/11 9时");
    const svg = document.querySelector<SVGSVGElement>(".usage-chart svg");
    const width = Number(svg?.getAttribute("width"));
    // 单点放在横向正中
    expect(Number(document.querySelector(".usage-chart-points .pt")?.getAttribute("cx"))).toBe(
      44 + (width - 88) / 2,
    );
    rerender(
      <PerformanceChart points={[point(new Date(2026, 9, 11, 9), 40, 1600)]} granularity="hour" />,
    );
    expect(labels()).toEqual(["0", "0s", "20", "0.5s", "40", "1s", "60", "1.5s", "80", "2s"]);
  });

  it("viewBox 宽度等于图区像素宽度", () => {
    withChartWidth(1260, () => {
      render(
        <PerformanceChart points={[point(new Date(2026, 9, 9), 50, 900)]} granularity="day" />,
      );
      const svg = document.querySelector(".usage-chart svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 1260 220");
      expect(svg?.getAttribute("width")).toBe("1260");
      expect(svg?.getAttribute("height")).toBe("220");
    });
  });

  const hours = (n: number) =>
    Array.from({ length: n }, (_, i) => point(new Date(2026, 9, 9, i), 40 + i, 800 + i * 10));

  it("0 个点显示空状态", () => {
    render(<PerformanceChart points={[]} granularity="day" />);
    expect(document.querySelector(".usage-chart-empty")?.textContent).toBe(
      "这个范围内没有带计时的请求（旧版本记录不含计时）",
    );
    expect(document.querySelector("svg")).toBeNull();
  });

  it("1 个点只画点不画线", () => {
    render(<PerformanceChart points={[point(new Date(2026, 9, 9), 50, 900)]} granularity="day" />);
    expect(document.querySelector("polyline")).toBeNull();
    expect(document.querySelector("polygon")).toBeNull();
    expect(document.querySelectorAll(".usage-chart-points circle")).toHaveLength(2);
  });

  it("图区窄时 x 轴标签按每个至少 96px 减少", () => {
    withChartWidth(444, () => {
      render(<PerformanceChart points={hours(12)} granularity="hour" />);
      expect(document.querySelectorAll(".usage-chart-xlabel")).toHaveLength(3);
    });
  });

  it("多个点画两条线与点；超过 40 个点不画点；x 轴约 6 个标签", () => {
    withChartWidth(1260, () => {
      const rendered = render(<PerformanceChart points={hours(12)} granularity="hour" />);
      expect(document.querySelector("polyline.tps")).not.toBeNull();
      expect(document.querySelector("polyline.ttft")).not.toBeNull();
      expect(document.querySelectorAll(".usage-chart-points circle.pt")).toHaveLength(12);
      expect(document.querySelectorAll(".usage-chart-xlabel")).toHaveLength(6);
      rendered.rerender(<PerformanceChart points={hours(41)} granularity="hour" />);
      expect(document.querySelectorAll(".usage-chart-points")).toHaveLength(0);
      expect(document.querySelector("polyline.tps")).not.toBeNull();
      const labels = document.querySelectorAll(".usage-chart-xlabel").length;
      expect(labels).toBeGreaterThanOrEqual(5);
      expect(labels).toBeLessThanOrEqual(7);
      rendered.rerender(<PerformanceChart points={hours(40)} granularity="hour" />);
      expect(document.querySelectorAll(".usage-chart-points")).toHaveLength(40);
    });
  });

  it("三种粒度的标题、x 轴标签与提示时间", () => {
    const start = new Date(2026, 9, 9, 14);
    const rendered = render(
      <PerformanceChart points={[point(start, 50, 900)]} granularity="hour" />,
    );
    const check = (title: string, label: string, full: string) => {
      expect(document.querySelector(".usage-chart-top h5")?.textContent).toBe(title);
      expect(document.querySelector(".usage-chart-xlabel")?.textContent).toBe(label);
      fireEvent.mouseEnter(must(document.querySelector(".hit")));
      expect(screen.getByRole("tooltip").querySelector("b")?.textContent).toBe(full);
      fireEvent.mouseLeave(must(document.querySelector(".hit")));
    };
    check("每个活跃小时的性能", "10/9 14时", "2026-10-09 14:00 这一小时");
    rendered.rerender(
      <PerformanceChart points={[point(new Date(2026, 9, 9), 50, 900)]} granularity="day" />,
    );
    check("每个活跃日的性能", "10/9", "2026-10-09");
    rendered.rerender(
      <PerformanceChart points={[point(new Date(2026, 8, 14), 50, 900)]} granularity="week" />,
    );
    check("每周的性能", "9/14", "2026-09-14 至 2026-09-20");
  });

  it("提示显示该桶的 Tokens/s、TTFT 与请求数；键盘聚焦同样弹出", () => {
    render(<PerformanceChart points={hours(3)} granularity="hour" />);
    const hits = document.querySelectorAll<SVGRectElement>(".hit");
    fireEvent.focus(must(hits[1]));
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Tokens/s 41.0");
    expect(tip.textContent).toContain("TTFT 0.8s");
    expect(tip.textContent).toContain("3 次请求");
    expect(document.querySelector(".usage-chart-hover line.cursor")).not.toBeNull();
    fireEvent.blur(must(hits[1]));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("展开区单价行", () => {
  it("缺失显示「—」，分档模型显示基础档并注明分档", () => {
    expect(priceLine(undefined)).toBe(
      "单价 输入 — · 缓存读 — / 写 — · 输出 —（USD / 每百万 token）",
    );
    expect(
      priceLine({
        input: 1.25,
        output: 10,
        cacheRead: 0.125,
        cacheWrite: 1.5,
        tiers: [{ aboveInputTokens: 200_000, input: 2.5, output: 15 }],
      }),
    ).toBe("单价 输入 $1.25 · 缓存读 $0.125 / 写 $1.5 · 输出 $10（USD / 每百万 token） · 分档");
  });
});
