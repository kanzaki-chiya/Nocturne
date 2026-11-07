import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { SessionOverview } from "../src/PanelChrome";
import { parseStoredTabs, restoreTabs, storedTabs } from "../src/side-panel";

const running: BackgroundShellTask = {
  taskId: "run",
  callId: "call",
  name: "running fixture",
  command: "node fixture",
  logPath: "/log",
  outputChars: 0,
  status: "running",
  startedAt: "2026-11-08T00:00:00Z",
};
const done: BackgroundShellTask = {
  ...running,
  taskId: "done",
  name: "ended fixture",
  status: "exited",
  endedAt: "2026-11-08T00:00:05Z",
  exitCode: 0,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function overview(tasks: BackgroundShellTask[], open = vi.fn(), kill = vi.fn()) {
  return (
    <SessionOverview
      project="test"
      workspace="Z:/test"
      totals={{ added: 0, removed: 0, files: 0 }}
      rightOffset={0}
      onOpenChanges={vi.fn()}
      shells={{ tasks, onOpen: open, onStop: kill }}
    />
  );
}
it("shell tabs validate, deduplicate and restore descriptors even without a live task", () => {
  const tab = {
    id: "tab",
    kind: "shell" as const,
    taskId: "missing",
    name: "fixture",
    command: "node fixture",
  };
  const parsed = parseStoredTabs([
    tab,
    { ...tab, id: "duplicate" },
    { ...tab, id: "bad", taskId: 1 },
  ]);
  expect(parsed).toEqual([tab]);
  expect(storedTabs(restoreTabs(parsed, tab.id, () => "new").tabs)).toEqual([tab]);
});
it("shell overview hides an empty group", () => {
  render(overview([]));
  expect(screen.queryByRole("group", { name: "后台任务" })).toBeNull();
});
it("shell overview sorts running first, opens output and stops from a sibling button", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:00:10Z"));
  const open = vi.fn();
  const kill = vi.fn();
  render(overview([done, running], open, kill));
  const group = screen.getByRole("group", { name: "后台任务" });
  expect(group.querySelector("button")?.textContent).toContain("running fixture");
  fireEvent.click(screen.getByRole("button", { name: /running fixture/ }));
  expect(open).toHaveBeenCalledWith(running);
  const stop = screen.getByRole("button", { name: "停止" });
  fireEvent.focus(screen.getByRole("button", { name: /running fixture/ }));
  fireEvent.mouseOver(group.querySelector(".ovpop-shell-row") as HTMLElement);
  fireEvent.click(stop);
  expect(kill).toHaveBeenCalledWith(running);
  expect(stop.parentElement?.querySelector("button button")).toBeNull();
  expect(group.querySelector(".done")?.textContent).toContain("5 秒");
});
it("shell overview shares a clock for ticking and expiry at five minutes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:05:04Z"));
  render(overview([done, running]));
  expect(screen.getByText("ended fixture")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.queryByText("ended fixture")).toBeNull();
  expect(screen.getByText("5 分 5 秒")).toBeTruthy();
});
