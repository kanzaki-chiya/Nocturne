import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArchivePage } from "../src/ArchivePage";
import type { SessionSummary } from "../src/session-tree";

const NOW = new Date("2026-10-04T12:00:00").getTime();
const PLAIN = "C:\\Users\\A\\.nocturne\\workspace";

afterEach(cleanup);

function archived(
  id: string,
  cwd: string,
  minutesAgo: number,
  title: string,
  extra?: Partial<SessionSummary>,
): SessionSummary {
  return {
    id,
    createdAt: "2026-10-01T00:00:00Z",
    cwd,
    workspaceRoot: cwd,
    model: { provider: "p", model: "m" },
    mtimeMs: NOW - minutesAgo * 60_000,
    firstText: title,
    archivedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    ...extra,
  };
}

function page(sessions: SessionSummary[]) {
  const onOpen = vi.fn();
  const onRestore = vi.fn();
  const view = render(
    <ArchivePage
      sessions={sessions}
      plainWorkspaces={[PLAIN]}
      now={NOW}
      onOpen={onOpen}
      onRestore={onRestore}
    />,
  );
  return { ...view, onOpen, onRestore };
}

describe("ArchivePage", () => {
  it("按侧栏归属与名称分组，组和行都按归档时间倒序，包含已隐藏项目", () => {
    const sessions = [
      archived("repo-old", "Z:\\repo", 24 * 60, "仓库旧会话"),
      archived("hidden", "Z:\\hidden", 60, "隐藏项目会话"),
      archived("chat", PLAIN, 30, "闲聊归档"),
      archived("sched", "Z:\\sched-repo", 180, "定时归档", {
        schedule: {
          taskId: "task-1",
          scheduledAt: "2026-10-04T09:00:00Z",
          trigger: "schedule",
        },
      }),
      archived("repo-new", "Z:\\repo", 120, "仓库新会话"),
    ];
    const { container } = page(sessions);
    const headings = [...container.querySelectorAll(".ghead h2")].map((node) => node.textContent);
    expect(headings).toEqual(["对话", "hidden", "repo", "定时任务"]);
    const rows = [...container.querySelectorAll(".archive-row .archive-open")].map(
      (node) => node.textContent,
    );
    expect(rows).toEqual(["闲聊归档", "隐藏项目会话", "仓库新会话", "仓库旧会话", "定时归档"]);
    expect(screen.getByText("闲聊归档").getAttribute("title")).toBe("闲聊归档");
  });

  it("标题即时不分大小写过滤，组内无命中不渲染组，无命中文案唯一", () => {
    const sessions = [
      archived("a", "Z:\\repo", 10, "Alpha 任务"),
      archived("b", "Z:\\repo", 20, "beta 任务"),
      archived("c", "Z:\\other", 30, "Gamma 任务"),
    ];
    const { container } = page(sessions);
    const input = screen.getByRole("textbox", { name: "搜索" }) as HTMLInputElement;
    expect(input.getAttribute("placeholder")).toBeNull();
    fireEvent.change(input, { target: { value: "ALPHA" } });
    expect(container.querySelectorAll(".ghead h2")).toHaveLength(1);
    expect(screen.getByText("Alpha 任务")).toBeTruthy();
    expect(screen.queryByText("beta 任务")).toBeNull();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(container.querySelectorAll(".archive-row")).toHaveLength(0);
    expect(screen.getByText("没有匹配的会话")).toBeTruthy();
    expect(screen.queryByText("没有已归档的会话")).toBeNull();
  });

  it("没有归档会话时只有空文案，不渲染搜索框", () => {
    page([]);
    expect(screen.getByText("没有已归档的会话")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("点标题打开，点恢复回调对应会话", () => {
    const { onOpen, onRestore } = page([archived("a", "Z:\\repo", 10, "归档标题")]);
    fireEvent.click(screen.getByRole("button", { name: "归档标题" }));
    expect(onOpen).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(onRestore).toHaveBeenCalledWith("a");
  });
});
