import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { PanelHarness, panelFixture } from "./phone-panel-fixtures";

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
  const fixture = panelFixture({ shells: [task] });
  const { session } = fixture;
  render(<PanelHarness fixture={fixture} />);
  const row = screen.getByRole("button", { name: new RegExp(task.name) });
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByTestId("shell-output").textContent).toBe("output"));
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(session.shellKill).toHaveBeenCalledWith(task.taskId);
  expect(screen.getByTitle(task.command).textContent).toBe(task.command);
});
it("phone overview hides with no tasks", () => {
  render(<PanelHarness fixture={panelFixture()} />);
  expect(screen.queryByRole("heading", { name: "后台任务" })).toBeNull();
  expect(screen.queryByRole("button", { name: "后台任务" })).toBeNull();
});
