import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "@nocturne/rpc/client";
import type { ScheduleListResult, ScheduleTaskOverview } from "@nocturne/core/protocol";

import { SchedulePage, type SchedulePageApi } from "../src/SchedulePage";

const task = (patch?: Partial<ScheduleTaskOverview>): ScheduleTaskOverview => ({
  id: "daily",
  name: "每日提交汇总",
  prompt: "汇总 main 分支过去 24 小时的提交。",
  workspace: "Z:\\nocturne",
  model: "deepseek/flash",
  reasoningEffort: "medium",
  permissionPreset: "smart",
  schedule: { type: "weekdays", time: "09:00" },
  enabled: true,
  maxDurationMinutes: 60,
  createdAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: "2026-10-27T01:00:00.000Z",
  running: false,
  lastRun: {
    id: "h1",
    taskId: "daily",
    scheduledAt: "2026-10-25T01:00:00.000Z",
    trigger: "catchup",
    result: "done",
    startedAt: "2026-10-25T01:03:00.000Z",
    endedAt: "2026-10-25T01:05:00.000Z",
    durationMs: 120_000,
  },
  stats: { last7Days: { runs: 4, skipped: 2 }, averageDurationMs: 160_000 },
  ...patch,
});

const paused = task({
  id: "deps",
  name: "依赖更新检查",
  enabled: false,
  schedule: { type: "weekly", day: "mon", time: "10:00" },
  nextRunAt: undefined,
  lastRun: undefined,
  stats: { last7Days: { runs: 0, skipped: 0 } },
});

function list(): ScheduleListResult {
  return {
    tasks: [task(), paused],
    scheduler: { running: true },
    warnings: [],
  };
}

function api(overrides?: Partial<SchedulePageApi>): SchedulePageApi {
  return {
    listSchedules: vi.fn(async () => list()),
    saveSchedule: vi.fn(async (input) => task({ name: input.name, prompt: input.prompt })),
    deleteSchedule: vi.fn(async () => undefined),
    runSchedule: vi.fn(async () => ({ started: true as const, sessionId: "s1" })),
    scheduleHistory: vi.fn(async () => [
      {
        id: "h1",
        taskId: "daily",
        scheduledAt: "2026-10-24T01:00:00.000Z",
        trigger: "catchup" as const,
        result: "done" as const,
        sessionId: "s1",
        durationMs: 161_000,
        startedAt: "2026-10-25T01:03:00.000Z",
      },
      {
        id: "h2",
        taskId: "daily",
        scheduledAt: "2026-10-23T01:00:00.000Z",
        trigger: "schedule" as const,
        result: "skipped" as const,
        reason: "missed" as const,
      },
    ]),
    listModels: vi.fn(async () => [
      { ref: { provider: "deepseek", model: "flash" }, displayName: "flash" },
    ]),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("定时任务页", () => {
  it("启用与已暂停分组，选中后看到计划、统计和无人值守说明", async () => {
    render(
      <SchedulePage
        api={api()}
        workspaces={[
          { path: null, label: "普通对话" },
          { path: "Z:\\nocturne", label: "nocturne" },
        ]}
        onOpenSession={vi.fn()}
      />,
    );
    expect(await screen.findByDisplayValue("每日提交汇总")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "启用" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "已暂停" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /依赖更新检查/ }).textContent).toContain("已暂停");
    const page = screen.getByRole("region", { name: "定时任务" });
    expect(within(page).getByLabelText("指令")).toHaveProperty(
      "value",
      "汇总 main 分支过去 24 小时的提交。",
    );
    expect(page.textContent).toContain("工作日 09:00");
    expect(page.textContent).toContain("运行 4 次 · 跳过 2 次");
    expect(page.textContent).toContain("无人值守");
    expect(screen.getByRole("switch", { name: "启用" }).getAttribute("aria-checked")).toBe("true");
  });

  it("保存把表单交给 saveSchedule；删除要再点一次", async () => {
    const client = api();
    render(
      <SchedulePage
        api={client}
        workspaces={[{ path: null, label: "普通对话" }]}
        onOpenSession={vi.fn()}
      />,
    );
    const name = await screen.findByDisplayValue("每日提交汇总");
    fireEvent.change(name, { target: { value: "早报" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await vi.waitFor(() => {
      expect(client.saveSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ id: "daily", name: "早报", enabled: true }),
      );
      expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
    });
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    expect(client.deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(client.deleteSchedule).toHaveBeenCalledWith({ id: "daily" });
  });

  it("字段错误标在对应输入上", async () => {
    const client = api({
      saveSchedule: vi.fn(async () => {
        throw new RpcError("invalid_field", "名称不能为空", -32602, "ScheduleError", "name");
      }),
    });
    render(<SchedulePage api={client} workspaces={[]} onOpenSession={vi.fn()} />);
    const name = await screen.findByDisplayValue("每日提交汇总");
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "名称不能为空");
    expect(name.className).toContain("err");
  });

  it("历史可打开会话；立即运行把新会话交给外面；表头与数据列共用同一套 5 列定义", async () => {
    const open = vi.fn();
    const client = api();
    render(
      <SchedulePage
        api={client}
        workspaces={[{ path: null, label: "普通对话" }]}
        onOpenSession={open}
      />,
    );
    await screen.findByDisplayValue("每日提交汇总");
    fireEvent.click(screen.getByRole("tab", { name: "历史" }));
    expect(await screen.findByText("错过，只补最近一次")).toBeTruthy();
    const table = screen.getByRole("table", { name: "运行历史" });
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const headRow = rows[0];
    if (headRow === undefined) throw new Error("缺少表头行");
    expect(headRow.classList.contains("sched-hist-head")).toBe(true);
    expect(headRow.classList.contains("head")).toBe(false);
    const headers = within(headRow).getAllByRole("columnheader");
    expect(headers.map((el) => el.textContent)).toEqual([
      "计划时间",
      "触发",
      "结果",
      "用时",
      "会话",
    ]);
    for (const row of rows) {
      expect(row.children).toHaveLength(headers.length);
    }
    fireEvent.click(screen.getByRole("button", { name: "打开会话 →" }));
    expect(open).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("tab", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "▶ 立即运行" }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(client.runSchedule).toHaveBeenCalledWith({ id: "daily" });
  });

  it("历史指向已删除会话时留在定时任务页并提示「这次运行的会话已删除」", async () => {
    const open = vi.fn(async () => false);
    const client = api();
    render(
      <SchedulePage
        api={client}
        workspaces={[{ path: null, label: "普通对话" }]}
        onOpenSession={open}
      />,
    );
    await screen.findByDisplayValue("每日提交汇总");
    fireEvent.click(screen.getByRole("tab", { name: "历史" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开会话 →" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "这次运行的会话已删除");
    expect(screen.getByRole("region", { name: "定时任务" })).toBeTruthy();
  });

  it("手机只读：新建、编辑、删除、启停禁用并提示，立即运行仍可用", async () => {
    const client = api();
    render(
      <SchedulePage
        api={client}
        workspaces={[{ path: null, label: "普通对话" }]}
        readOnly
        onOpenSession={vi.fn()}
      />,
    );
    await screen.findByDisplayValue("每日提交汇总");
    expect(screen.getByRole("note").textContent).toContain("请在电脑上操作");
    const create = screen.getByRole("button", { name: "＋ 新建任务" });
    expect(create).toHaveProperty("disabled", true);
    expect(create.getAttribute("title")).toBe("请在电脑上操作");
    expect(screen.getByRole("switch")).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch").getAttribute("title")).toBe("请在电脑上操作");
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "删除任务" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("指令")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "▶ 立即运行" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "▶ 立即运行" }));
    await vi.waitFor(() => expect(client.runSchedule).toHaveBeenCalledWith({ id: "daily" }));
  });

  it("调度器没开时说明原因", async () => {
    render(
      <SchedulePage
        api={api({
          listSchedules: vi.fn(async () => ({
            tasks: [],
            scheduler: { running: false, reason: "disabled" as const },
            warnings: [],
          })),
        })}
        workspaces={[]}
        onOpenSession={vi.fn()}
      />,
    );
    expect(await screen.findByText(/定时任务只在桌面端打开时运行/)).toBeTruthy();
  });
});
