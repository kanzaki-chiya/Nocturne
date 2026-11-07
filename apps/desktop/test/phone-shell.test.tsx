import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { PhoneTasks } from "../src/web/PhoneTasks";

const task: BackgroundShellTask = {
  taskId: "task",
  callId: "call",
  name: "fixture-long-name-".repeat(12),
  command: "node " + "long-command".repeat(40),
  logPath: "/log",
  outputChars: 6,
  status: "running",
  startedAt: new Date().toISOString(),
};
afterEach(cleanup);
it("phone overview opens a read-only output page and stops the selected task", async () => {
  const session = {
    shellOutput: vi.fn(async () => ({ task, text: "output", start: 0, end: 6, durationMs: 0 })),
    shellKill: vi.fn(async () => undefined),
  };
  render(
    <div className="phone">
      <PhoneTasks tasks={[task]} session={session} connected />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "后台任务" }));
  const row = screen.getByRole("button", { name: new RegExp(task.name) });
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByTestId("shell-output").textContent).toBe("output"));
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(session.shellKill).toHaveBeenCalledWith(task.taskId);
  expect(screen.getByTitle(task.command).textContent).toBe(task.command);
});
it("phone overview hides with no tasks", () => {
  render(<PhoneTasks tasks={[]} connected={false} />);
  expect(screen.queryByRole("button", { name: "后台任务" })).toBeNull();
});
