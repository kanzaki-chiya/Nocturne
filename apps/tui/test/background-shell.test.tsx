import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeSession } from "@nocturne/core";
import {
  createSessionView,
  type BackgroundShellTask,
  type ToolEntry,
  type UserEntry,
} from "@nocturne/core/protocol";
import { Tasks } from "../src/components/tasks.js";
import { StatusBar } from "../src/components/status-bar.js";
import { PendingInputsPanel } from "../src/components/pending-inputs.js";
import { TuiEnvContext } from "../src/env.js";
import { layoutEntry } from "../src/lines.js";
import { runSlash } from "../src/commands.js";

const task: BackgroundShellTask = {
  taskId: "task",
  callId: "call",
  name: "fixture",
  command: "node fixture",
  logPath: "/log",
  startedAt: "2026-11-07T00:00:00Z",
  status: "running",
};
const tool = {
  kind: "tool",
  key: "t:call",
  callId: "call",
  name: "shell",
  status: "ok",
  input: { background: true, command: task.command },
  liveOutput: "",
  result: { output: { taskId: task.taskId, background: true }, modelContent: "started" },
} as unknown as ToolEntry;
const result = {
  kind: "user",
  key: "u:result",
  backgroundShell: { taskId: "task", callId: "call", status: "exited", exitCode: 7 },
  content: [
    {
      type: "text",
      text: '<shell-result id="task" status="exited" exit="7">\ntail output\n</shell-result>',
    },
  ],
} as UserEntry;
const text = (entry: ToolEntry | UserEntry, tasks = [task], expanded = false) =>
  layoutEntry(entry, 140, false, undefined, undefined, false, expanded, undefined, {
    entries: [tool, result],
    backgroundShells: tasks,
    reasoningExpanded: new Map([["shell:u:result", expanded]]),
  })
    .map((line) => line.text)
    .join("\n");

describe("TUI background shell", () => {
  it("tool row shows 后台 then exit code", () => {
    expect(text(tool)).toContain("后台");
    expect(text(tool, [{ ...task, status: "exited", exitCode: 7 }])).toContain("7");
  });
  it("result card has command status exit duration and expands tail without shell-result", () => {
    const done = [
      { ...task, status: "exited" as const, exitCode: 7, endedAt: "2026-11-07T00:00:03Z" },
    ];
    const collapsed = text(result, done);
    expect(collapsed).toContain("node fixture");
    expect(collapsed).toContain("7");
    expect(collapsed).toContain("3.0s");
    expect(collapsed).not.toContain("tail output");
    expect(text(result, done, true)).toContain("tail output");
    expect(text(result, done, true)).not.toContain("shell-result");
  });
  it("status bar counts running commands", () => {
    const view = createSessionView();
    view.backgroundShells = [task];
    const ui = render(<StatusBar view={view} width={140} context={{ used: 0 }} />);
    expect(ui.lastFrame()).toContain("后台任务 1");
    ui.unmount();
  });
  it("pending result only offers retraction and hides payload", () => {
    const ui = render(
      <PendingInputsPanel
        items={[
          {
            id: "p",
            mode: "shell",
            text: "<shell-result>",
            attachments: 0,
            paused: true,
            createdAt: "now",
          },
        ]}
        paused
        selected={0}
        width={100}
        height={4}
      />,
    );
    expect(ui.lastFrame()).toContain("后台任务 · 等待送达");
    expect(ui.lastFrame()).not.toContain("shell-result");
    expect(ui.lastFrame()).not.toContain("Alt+E");
    ui.unmount();
  });
  it("/tasks lists, opens tail, stops selected task and hides tasks older than five minutes", async () => {
    expect(await runSlash("/tasks", {} as never)).toEqual({ kind: "overlay", name: "tasks" });
    const shellKill = vi.fn(async () => undefined);
    const session = {
      shellTasks: () => [
        task,
        {
          ...task,
          taskId: "old",
          name: "expired",
          status: "exited",
          endedAt: "2000-01-01T00:00:00Z",
        },
      ],
      shellOutput: async () => ({ text: "live tail" }),
      shellKill,
    } as unknown as RuntimeSession;
    const ui = render(
      <TuiEnvContext.Provider value={{ ascii: false, animated: false }}>
        <Tasks session={session} width={100} onClose={() => undefined} />
      </TuiEnvContext.Provider>,
    );
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("fixture"));
      expect(ui.lastFrame()).not.toContain("expired");
      await new Promise((resolve) => setTimeout(resolve, 100));
      ui.stdin.write("\r");
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("live tail"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      ui.stdin.write("\r");
      await vi.waitFor(() => expect(shellKill).toHaveBeenCalledWith("task"));
    } finally {
      ui.unmount();
    }
  });
});
