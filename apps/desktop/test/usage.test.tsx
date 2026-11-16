import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageStats } from "@nocturne/core/protocol";
import { UsagePage, UsageView, formatUsageCost, formatUsageTokens } from "../src/UsagePage";
import { fakeServer, RpcFail, withInit } from "./fake-server";

const cost = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 };
const totals = {
  inputTokens: 100_000,
  outputTokens: 20_000,
  cacheReadTokens: 80_000,
  cacheWriteTokens: 1000,
  cost,
};
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const stats: UsageStats = {
  totals,
  sessions: 8,
  turns: 30,
  subagentTurns: 4,
  longestTurn: { durationMs: 120_000, date: today, sessionTitle: "最长会话" },
  daily: [{ date: today, tokens: 120_000, cost: 10, turns: 30 }],
  performanceGranularity: "day",
  models: [
    {
      ...totals,
      model: { provider: "p", model: "expensive" },
      turns: 10,
      cacheHitRate: 0.8,
      requests: 1,
      performance: [],
      pricing: { input: 2, output: 8, cacheRead: 0.25 },
      pricingSource: "models.dev",
    },
    {
      ...totals,
      inputTokens: 900_000,
      cost: { ...cost, total: 5 },
      model: { provider: "p", model: "large-input" },
      turns: 20,
      cacheHitRate: 0.5,
      requests: 1,
      performance: [],
      pricing: { input: 1, output: 2 },
      pricingSource: "upstream",
    },
    {
      ...totals,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
      model: { provider: "p", model: "unpriced" },
      turns: 0,
      cacheHitRate: 0,
      requests: 1,
      performance: [],
    },
    {
      ...totals,
      inputTokens: 1_000,
      cost: { ...cost, total: 0 },
      model: { provider: "ocx", model: "xai/grok-4.7" },
      turns: 1,
      cacheHitRate: 0,
      requests: 1,
      performance: [],
      pricing: { input: 2, output: 6 },
      pricingSource: "vendor",
    },
  ],
  tools: [{ name: "read", count: 30 }],
  skills: [{ name: "example", count: 4 }],
  unpricedModels: [{ provider: "p", model: "unpriced" }],
  skippedFiles: 1,
};
const servers: ReturnType<typeof fakeServer>[] = [];
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const s of servers.splice(0)) s.close();
});
async function mount(handler: unknown = stats, variant?: "phone") {
  const server = fakeServer(withInit({ "runtime.usageStats": handler }));
  servers.push(server);
  await server.initialize();
  const view = render(<UsagePage client={server.client} variant={variant} />);
  await screen.findByText("累计 tokens");
  return { server, ...view };
}

describe("desktop usage", () => {
  it("renders overview and requests the newly selected range without polling", async () => {
    const { server } = await mount();
    const overview = document.querySelector(".usage-overview");
    expect(overview?.textContent).toContain("12 万");
    expect(document.querySelector(".usage-composition")?.textContent).not.toContain(".0 万");
    expect(screen.getByRole("table").textContent).not.toContain(".0 万");
    expect(overview?.textContent).toContain("80.0%");
    expect(overview?.textContent).toContain("$10.00");
    expect(overview?.textContent).toContain("30 轮，子代理 4 轮");
    expect(overview?.textContent).toContain("2.0分钟");
    expect(overview?.textContent).not.toContain("输入 + 输出 tokens");
    expect(overview?.textContent).not.toContain("未计价模型不计入");
    expect(overview?.textContent).not.toContain("读取 / 输入 tokens");
    fireEvent.click(screen.getByRole("button", { name: "7 天" }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "runtime.usageStats").at(-1)?.params).toEqual({
        days: 7,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "runtime.usageStats").at(-1)?.params).toEqual(
        {},
      ),
    );
    expect(
      server.calls.filter((c) => c.method === "runtime.usageStats").map((c) => c.params),
    ).toEqual([{ days: 30 }, { days: 7 }, {}]);
  });
  it("sorts models by cost/input and shows undeclared prices as dashes with config-only guidance", async () => {
    await mount();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("expensive");
    // 未计价排在已计价（含 $0）之后，即使输入更多
    expect(within(table).getAllByRole("row").at(-1)?.textContent).toContain("unpriced");
    fireEvent.click(screen.getByRole("button", { name: "按输入" }));
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("large-input");
    const unpriced = within(table)
      .getByRole("rowheader", { name: /unpriced/ })
      .closest("tr");
    // 费用 + 无计时的 Tokens/s、TTFT
    expect(unpriced?.textContent?.match(/—/g)).toHaveLength(3);
    const vendor = within(table).getByRole("rowheader", { name: /grok-4\.7/ });
    // 模型名下只有服务商，不写价格来源
    expect(vendor.textContent).not.toContain("厂商价");
    expect(vendor.textContent).not.toContain("models.dev");
    expect(vendor.querySelector(".usage-price-source")).toBeNull();
    expect(document.querySelector(".usage-table-note")?.textContent).toBe(
      "按声明价格估算，以服务商账单为准。",
    );
    expect(document.querySelector(".usage-day-detail")?.textContent).toBe("");
    expect(screen.getByText("p/unpriced 未声明价格").tagName).toBe("P");
    expect(screen.queryByText(/在配置文件的模型条目里写 pricing/)).toBeNull();
    expect(screen.queryByRole("link", { name: /pricing/ })).toBeNull();
  });
  it("renders 365 heatmap days, fades out-of-range dates, supports hover, pin and cost coloring", async () => {
    await mount();
    const grid = screen.getByLabelText("近一年每日用量");
    expect(within(grid).getAllByRole("button")).toHaveLength(365);
    expect(within(grid).getAllByRole("button").at(-1)?.getAttribute("aria-label")).toContain(today);
    expect(grid.lastElementChild?.getAttribute("aria-label")).toContain(today);
    expect(document.querySelector(".usage-months")?.lastElementChild?.textContent).toBe(
      `${now.getMonth() + 1} 月`,
    );
    expect(grid.querySelectorAll(".usage-outside")).toHaveLength(335);
    const cell = within(grid).getByRole("button", {
      name: `${today}，12 万 tokens，约 $10.00，30 轮`,
    });
    expect(cell.title).toContain("约 $10.00");
    fireEvent.mouseEnter(cell);
    expect(screen.getByText(`${today}，12 万 tokens，约 $10.00，30 轮`)).toBeTruthy();
    fireEvent.click(cell);
    fireEvent.mouseLeave(cell);
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(`${today}，12 万 tokens，约 $10.00，30 轮`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "费用" }));
    expect(cell.className).toContain("usage-level-4");
  });
  it("keeps previous content during loading/errors and retries", async () => {
    let reply: ((value: UsageStats | RpcFail) => void) | undefined;
    let count = 0;
    const { server } = await mount(() =>
      ++count === 1
        ? stats
        : new Promise((resolve) => {
            reply = resolve;
          }),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(screen.getByLabelText("用量").getAttribute("aria-busy")).toBe("true"),
    );
    expect(screen.getByText("累计 tokens")).toBeTruthy();
    if (!reply) throw new Error("missing deferred response");
    reply(new RpcFail(-32000, "读取失败"));
    await screen.findByRole("alert");
    expect(screen.getByText("累计 tokens")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.method === "runtime.usageStats")).toHaveLength(3),
    );
    if (!reply) throw new Error("missing retry response");
    reply(stats);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("does not overwrite the new range with late previous-range responses", async () => {
    let reply: ((value: UsageStats) => void) | undefined;
    let count = 0;
    await mount(() =>
      ++count === 2
        ? new Promise<UsageStats>((resolve) => {
            reply = resolve;
          })
        : stats,
    );
    fireEvent.click(screen.getByRole("button", { name: "7 天" }));
    await waitFor(() => expect(reply).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() =>
      expect(screen.getByLabelText("用量").getAttribute("aria-busy")).toBe("false"),
    );
    if (!reply) throw new Error("missing previous-range response");
    const resolve = reply;
    await act(async () => {
      resolve({ ...stats, sessions: 999 });
    });
    await waitFor(() =>
      expect(document.querySelector(".usage-overview")?.textContent).not.toContain("999"),
    );
  });
  it("formats Chinese token units and estimated dollar amounts", () => {
    expect(formatUsageTokens(100_000_000)).toBe("1 亿");
    expect(formatUsageTokens(8_800_000)).toBe("880 万");
    expect(formatUsageTokens(115_000)).toBe("11.5 万");
    expect(formatUsageTokens(115_000_000)).toBe("1.15 亿");
    expect(formatUsageCost(123.45)).toBe("$123");
    expect(formatUsageCost(1.2)).toBe("$1.20");
  });
  it("still renders DataTable in desktop variant", () => {
    render(
      <UsageView
        stats={stats}
        range="30"
        loading={false}
        error={undefined}
        onRange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByRole("table", { name: "按模型用量" })).toBeTruthy();
  });
  it("hides first heatmap month label when it spans fewer than 3 columns", () => {
    // 2026-11-20 往前 364 天是 2025-11-21，11 月只占第 1–2 列，与 12 月间隔不足 3 列
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 20, 12));
    const rendered = render(
      <UsageView
        stats={stats}
        range="30"
        loading={false}
        error={undefined}
        onRange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    const labelsShort = [...document.querySelectorAll(".usage-months span")].map(
      (e) => e.textContent,
    );
    expect(labelsShort[0]).toBe("12 月");
    expect(labelsShort.at(-1)).toBe("11 月");
    expect(labelsShort).toHaveLength(12);

    // 2026-11-10 往前 364 天是 2025-11-11（周二），11 月占第 1–3 列，与 12 月间隔恰好 3 列
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    rendered.rerender(
      <UsageView
        stats={{ ...stats }}
        range="30"
        loading={false}
        error={undefined}
        onRange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    const labelsFull = [...document.querySelectorAll(".usage-months span")].map(
      (e) => e.textContent,
    );
    expect(labelsFull[0]).toBe("11 月");
    expect(labelsFull).toHaveLength(13);
  });
  it("scrolls heatmap container to scrollWidth on mount and stats update", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("usage-heat-scroll") ? 720 : 0;
      },
    });
    try {
      const rendered = render(
        <UsageView
          stats={stats}
          range="30"
          loading={false}
          error={undefined}
          onRange={() => undefined}
          onRefresh={() => undefined}
        />,
      );
      const scrollEl = document.querySelector<HTMLElement>(".usage-heat-scroll");
      expect(scrollEl?.scrollLeft).toBe(720);
      if (!scrollEl) throw new Error("missing heatmap scroll container");
      scrollEl.scrollLeft = 0;
      rendered.rerender(
        <UsageView
          stats={{ ...stats, sessions: 9 }}
          range="30"
          loading={false}
          error={undefined}
          onRange={() => undefined}
          onRefresh={() => undefined}
        />,
      );
      expect(scrollEl.scrollLeft).toBe(720);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });
});

describe("phone usage", () => {
  it("renders button list instead of DataTable and expands ModelDetail on click", () => {
    render(
      <UsageView
        stats={stats}
        range="30"
        loading={false}
        error={undefined}
        variant="phone"
        onRange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".usage-detail")).toBeNull();
    const modelBtn = screen.getByRole("button", { name: /expensive/ });
    expect(modelBtn.getAttribute("aria-expanded")).toBe("false");
    expect(modelBtn.textContent).toContain("输入 10 万 · 输出 2 万 · 缓存命中 80.0%");
    expect(modelBtn.querySelector(".usage-phone-model-name")?.getAttribute("title")).toBe(
      "expensive",
    );
    fireEvent.click(modelBtn);
    expect(modelBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".usage-detail")).not.toBeNull();
    fireEvent.click(modelBtn);
    expect(modelBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".usage-detail")).toBeNull();
  });
  it("uses 刷新 as refresh button aria-label and disables it while loading", async () => {
    let reply: ((value: UsageStats) => void) | undefined;
    let count = 0;
    await mount(
      () =>
        ++count === 1
          ? stats
          : new Promise<UsageStats>((resolve) => {
              reply = resolve;
            }),
      "phone",
    );
    const refreshBtn = screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement;
    expect(refreshBtn.title).toBe("刷新");
    expect(refreshBtn.disabled).toBe(false);
    fireEvent.click(refreshBtn);
    await waitFor(() => expect(refreshBtn.disabled).toBe(true));
    expect(refreshBtn.title).toBe("读取中…");
    if (!reply) throw new Error("missing deferred response");
    const resolve = reply;
    await act(async () => {
      resolve(stats);
    });
    await waitFor(() => expect(refreshBtn.disabled).toBe(false));
    expect(refreshBtn.title).toBe("刷新");
  });
});
