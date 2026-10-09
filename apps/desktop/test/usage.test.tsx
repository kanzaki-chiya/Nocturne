import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageStats } from "@nocturne/core/protocol";
import { UsagePage, formatUsageCost, formatUsageTokens } from "../src/UsagePage";
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
  models: [
    {
      ...totals,
      model: { provider: "p", model: "expensive" },
      turns: 10,
      cacheHitRate: 0.8,
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
      pricing: { input: 1, output: 2 },
      pricingSource: "upstream",
    },
    {
      ...totals,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
      model: { provider: "p", model: "unpriced" },
      turns: 0,
      cacheHitRate: 0,
    },
  ],
  tools: [{ name: "read", count: 30 }],
  skills: [{ name: "example", count: 4 }],
  unpricedModels: [{ provider: "p", model: "unpriced" }],
  skippedFiles: 1,
};
const servers: ReturnType<typeof fakeServer>[] = [];
afterEach(() => {
  cleanup();
  for (const s of servers.splice(0)) s.close();
});
async function mount(handler: unknown = stats) {
  const server = fakeServer(withInit({ "runtime.usageStats": handler }));
  servers.push(server);
  await server.initialize();
  const view = render(<UsagePage client={server.client} />);
  await screen.findByText("累计 tokens");
  return { server, ...view };
}

describe("desktop usage", () => {
  it("renders overview and requests the newly selected range without polling", async () => {
    const { server } = await mount();
    const overview = document.querySelector(".usage-overview");
    expect(overview?.textContent).toContain("12.0 万");
    expect(overview?.textContent).toContain("80.0%");
    expect(overview?.textContent).toContain("$10.00");
    expect(overview?.textContent).toContain("30 Turns · 子代理 4");
    expect(overview?.textContent).toContain("2.0分钟");
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
    fireEvent.click(screen.getByRole("button", { name: "按输入" }));
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("large-input");
    const unpriced = within(table)
      .getByRole("rowheader", { name: /unpriced/ })
      .closest("tr");
    expect(unpriced?.textContent?.match(/—/g)).toHaveLength(4);
    expect(screen.getByText(/在配置文件的模型条目里写 pricing/).tagName).toBe("P");
    expect(screen.queryByRole("link", { name: /pricing/ })).toBeNull();
  });
  it("renders 365 heatmap days, fades out-of-range dates, supports hover, pin and cost coloring", async () => {
    await mount();
    const grid = screen.getByLabelText("近一年每日用量");
    expect(within(grid).getAllByRole("button")).toHaveLength(365);
    expect(grid.querySelectorAll(".usage-outside")).toHaveLength(335);
    const cell = within(grid).getByRole("button", {
      name: `${today} · 12.0 万 tokens · 约 $10.00 · 30 Turn`,
    });
    expect(cell.title).toContain("约 $10.00");
    fireEvent.mouseEnter(cell);
    expect(screen.getByText(`${today} · 12.0 万 tokens · 约 $10.00 · 30 Turn`)).toBeTruthy();
    fireEvent.click(cell);
    fireEvent.mouseLeave(cell);
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(`${today} · 12.0 万 tokens · 约 $10.00 · 30 Turn`)).toBeTruthy();
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
    expect(formatUsageTokens(100_000_000)).toBe("1.00 亿");
    expect(formatUsageCost(123.45)).toBe("$123");
    expect(formatUsageCost(1.2)).toBe("$1.20");
  });
});
