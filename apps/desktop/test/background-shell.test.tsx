import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionView,
  type BackgroundShellTask,
  type ToolEntry,
  type UserEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Conversation } from "../src/Conversation";
import { PendingInputs } from "../src/PendingInputs";
import { createAttachmentImageSource } from "../src/attachment-images";

const task: BackgroundShellTask = {
  taskId: "job-1",
  callId: "call-1",
  name: "check",
  command: "node -e 'process.exit(1)'",
  logPath: "Z:/test/job-1.log",
  outputChars: 0,
  status: "exited",
  startedAt: "2026-11-07T10:00:00.000Z",
  endedAt: "2026-11-07T10:01:05.000Z",
  exitCode: 1,
};
const tool: ToolEntry = {
  kind: "tool",
  key: "t-1",
  seq: 1,
  turnId: "turn-1",
  callId: task.callId,
  name: "shell",
  status: "ok",
  input: { command: task.command, name: task.name, background: true },
  subjects: [],
  permission: undefined,
  resolution: undefined,
  liveOutput: "",
  result: {
    status: "ok",
    output: { taskId: task.taskId, logPath: task.logPath, background: true },
    modelContent: "Background command started",
    error: undefined,
    truncated: false,
    spillPath: undefined,
    durationMs: 5,
  },
};
const result: UserEntry = {
  kind: "user",
  key: "u-2",
  seq: 2,
  turnId: "turn-1",
  content: [
    {
      type: "text",
      text: '<shell-result id="job-1" status="exited" exit="1">\nfailed check\n</shell-result>',
    },
  ],
  backgroundShell: { taskId: task.taskId, callId: task.callId, status: "exited", exitCode: 1 },
};

function conversation(entries = [tool, result] as (ToolEntry | UserEntry)[], tasks = [task]) {
  const view = createSessionView();
  view.entries = entries;
  view.backgroundShells = tasks;
  return (
    <Conversation
      view={view}
      session={{ id: "parent-1" } as RpcSession}
      cwd="Z:/test"
      openUrl={vi.fn()}
      images={createAttachmentImageSource()}
      busy={false}
      subscribeEvents={() => () => undefined}
      onResubmit={vi.fn(async () => undefined)}
    />
  );
}

afterEach(cleanup);

it.each(["desktop", "phone"])(
  "%s shell result card folds and hides the result envelope",
  (client) => {
    const { container } = render(
      <div className={client === "phone" ? "phone" : ""}>{conversation()}</div>,
    );
    const card = screen.getByLabelText("后台任务");
    expect(card.tagName).toBe("DETAILS");
    expect(card.querySelector("summary")?.textContent).toContain("check");
    expect(card.querySelector("summary")?.textContent).toContain("退出码 1");
    expect(card.querySelector("summary")?.textContent).toContain("1 分 5 秒");
    expect(card.hasAttribute("open")).toBe(false);
    fireEvent.click(card.querySelector("summary") as HTMLElement);
    expect(card.hasAttribute("open")).toBe(true);
    expect(card.textContent).toContain("failed check");
    fireEvent.click(card.querySelector("summary") as HTMLElement);
    expect(card.hasAttribute("open")).toBe(false);
    expect(container.textContent).not.toContain("<shell-result");
    expect(container.querySelector(".u-bubble")).toBeNull();
  },
);

it("expanded background launch reads and appends live output instead of launch metadata", async () => {
  const view = createSessionView();
  view.entries = [tool];
  view.backgroundShells = [{ ...task, outputChars: 3 }];
  const shellOutput = vi.fn(async (_id: string, offset?: number) => ({
    task,
    text: offset === undefined ? "one" : "two",
    start: offset ?? 0,
    end: offset === undefined ? 3 : 6,
    durationMs: 0,
  }));
  const live = { id: "parent-1", shellOutput } as unknown as RpcSession;
  const props = {
    session: live,
    view,
    cwd: "Z:/test",
    images: createAttachmentImageSource(),
    busy: false,
    openUrl: vi.fn(),
    subscribeEvents: () => () => undefined,
    onResubmit: vi.fn(async () => undefined),
  };
  const rendered = render(<Conversation {...props} />);
  const line = screen.getByLabelText("工具 shell").querySelector("summary");
  if (!line) throw new Error("missing tool line");
  fireEvent.click(line);
  await waitFor(() => expect(screen.getByTestId("shell-tool-output").textContent).toBe("one"));
  view.backgroundShells = [{ ...task, outputChars: 6 }];
  view.revision++;
  rendered.rerender(<Conversation {...props} />);
  await waitFor(() => expect(screen.getByTestId("shell-tool-output").textContent).toBe("onetwo"));
  expect(shellOutput).toHaveBeenNthCalledWith(2, task.taskId, 3);
});

it("shell tool shows background then exit code before result delivery", () => {
  const ui = render(
    conversation(
      [tool],
      [
        {
          taskId: task.taskId,
          callId: task.callId,
          name: task.name,
          command: task.command,
          logPath: task.logPath,
          outputChars: 0,
          startedAt: task.startedAt,
          status: "running",
        },
      ],
    ),
  );
  expect(ui.container.querySelector(".tool-res")?.textContent).toBe("后台");
  ui.rerender(conversation([tool]));
  expect(ui.container.querySelector(".tool-res")?.textContent).toBe("退出码 1");
});

it("shell card falls back to launch command and delivered exit code without task snapshot", () => {
  const { container } = render(conversation([tool, result], []));
  const summary = screen.getByLabelText("后台任务").querySelector("summary");
  expect(summary?.textContent).toContain("check");
  expect(summary?.textContent).toContain("退出码 1");
  expect(container.querySelector(".tool-res")?.textContent).toBe("退出码 1");
});

it.each(["check", "node fixture"])(
  "shell pending input names %s and only offers withdrawal",
  async (shellName) => {
    const cancel = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const { container } = render(
      <PendingInputs
        snapshot={{
          paused: false,
          items: [
            {
              id: "pending-1",
              mode: "shell",
              shellName,
              text: "<shell-result>hidden</shell-result>",
              attachments: 0,
              createdAt: task.endedAt ?? "",
              paused: false,
            },
          ],
        }}
        onUpdate={update}
        onCancel={cancel}
        onResume={vi.fn(async () => undefined)}
      />,
    );
    expect(container.querySelector(".pi-text")?.textContent).toBe(
      `后台任务 · ${shellName} · 等待送达`,
    );
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
    expect(container.textContent).not.toContain("shell-result");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("pending-1"));
    expect(update).not.toHaveBeenCalled();
  },
);
