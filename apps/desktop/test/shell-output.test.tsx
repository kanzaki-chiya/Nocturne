import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundShellTask } from "@nocturne/core/protocol";
import { ShellPane } from "../src/ShellPane";

const task: BackgroundShellTask = {
  taskId: "fixture",
  callId: "call",
  name: "fixture",
  command: "node fixture",
  outputChars: 3,
  logPath: "/log",
  status: "running",
  startedAt: new Date().toISOString(),
};
afterEach(cleanup);
it("output header stops only running tasks, marks nonzero exit and tolerates missing tasks", () => {
  const props = { taskId: task.taskId, name: task.name, command: task.command, visible: false };
  const view = render(<ShellPane {...props} task={task} />);
  expect(screen.getByRole("status").textContent).toBe("运行中");
  expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
  view.rerender(
    <ShellPane
      {...props}
      task={{ ...task, status: "exited", exitCode: 1, endedAt: new Date().toISOString() }}
    />,
  );
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("退出码 1");
  expect(screen.getByRole("status").classList.contains("err")).toBe(true);
  view.rerender(<ShellPane {...props} />);
  expect(screen.getByTestId("shell-output").textContent).toBe("");
});
it("output opens full, appends by offset and retains output on disconnect", async () => {
  const shellOutput = vi.fn(async (_taskId: string, offset?: number) => ({
    task,
    text: offset === undefined ? "one" : "two",
    start: offset ?? 0,
    end: offset === undefined ? 3 : 6,
    durationMs: 100,
  }));
  const session = { shellOutput, shellKill: vi.fn() };
  const props = {
    taskId: task.taskId,
    name: task.name,
    command: task.command,
    task,
    session,
    visible: true,
  };
  const view = render(<ShellPane {...props} />);
  await waitFor(() => expect(screen.getByTestId("shell-output").textContent).toBe("one"));
  expect(shellOutput).toHaveBeenNthCalledWith(1, task.taskId, undefined);
  view.rerender(<ShellPane {...props} task={{ ...task, outputChars: 6 }} />);
  await waitFor(() => expect(screen.getByTestId("shell-output").textContent).toBe("onetwo"));
  expect(shellOutput).toHaveBeenNthCalledWith(2, task.taskId, 3);
  shellOutput.mockRejectedValueOnce(new Error("offline"));
  view.rerender(<ShellPane {...props} task={{ ...task, outputChars: 9 }} />);
  await waitFor(() => expect(shellOutput).toHaveBeenCalledTimes(3));
  expect(screen.getByTestId("shell-output").textContent).toBe("onetwo");
});
it("output follows the bottom but leaves a reader's scroll position alone", async () => {
  let text = "one";
  const session = {
    shellOutput: vi.fn(async (_id: string, offset?: number) => ({
      task,
      text,
      start: offset ?? 0,
      end: (offset ?? 0) + text.length,
      durationMs: 0,
    })),
    shellKill: vi.fn(),
  };
  const props = {
    taskId: task.taskId,
    name: task.name,
    command: task.command,
    task,
    session,
    visible: true,
  };
  const view = render(<ShellPane {...props} />);
  const output = screen.getByTestId("shell-output");
  Object.defineProperties(output, {
    scrollHeight: { configurable: true, get: () => 600 },
    clientHeight: { configurable: true, get: () => 100 },
  });
  await waitFor(() => expect(output.textContent).toBe("one"));
  expect(output.scrollTop).toBe(600);
  output.scrollTop = 100;
  fireEvent.scroll(output);
  text = "two";
  view.rerender(<ShellPane {...props} task={{ ...task, outputChars: 6 }} />);
  await waitFor(() => expect(output.textContent).toBe("onetwo"));
  expect(output.scrollTop).toBe(100);
});
it("output ignores late responses after switching tasks and stops the current task", async () => {
  let resolve!: (value: {
    task: BackgroundShellTask;
    text: string;
    start: number;
    end: number;
    durationMs: number;
  }) => void;
  const session = {
    shellOutput: vi.fn(
      () =>
        new Promise<{
          task: BackgroundShellTask;
          text: string;
          start: number;
          end: number;
          durationMs: number;
        }>((r) => {
          resolve = r;
        }),
    ),
    shellKill: vi.fn(async () => undefined),
  };
  const props = {
    taskId: task.taskId,
    name: task.name,
    command: task.command,
    task,
    session,
    visible: true,
  };
  const view = render(<ShellPane {...props} />);
  const old = resolve;
  view.rerender(<ShellPane {...props} taskId="other" task={{ ...task, taskId: "other" }} />);
  await act(async () => {
    old({ task, text: "stale", start: 0, end: 5, durationMs: 0 });
  });
  expect(screen.getByTestId("shell-output").textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(session.shellKill).toHaveBeenCalledWith("other");
});
