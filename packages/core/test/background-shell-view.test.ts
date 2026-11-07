import { describe, expect, it } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  replaySessionView,
  type DurableEvent,
  type RuntimeEvent,
} from "../src/protocol/index.js";
const base = { sessionId: "s", turnId: "turn", time: "2026-11-07T00:00:00.000Z" };
const end = "2026-11-07T00:00:03.000Z";
const result: DurableEvent = {
  ...base,
  seq: 3,
  time: end,
  type: "message.user",
  payload: {
    messageId: "result",
    content: [{ type: "text", text: "tail" }],
    backgroundShell: { taskId: "task", callId: "call", status: "exited", exitCode: 0 },
  },
};
const events: DurableEvent[] = [
  {
    ...base,
    seq: 1,
    type: "tool.started",
    payload: {
      callId: "call",
      name: "shell",
      input: { command: "node fixture", background: true, name: "fixture" },
      subjects: [],
      permission: { action: "allow", source: "rule" },
    },
  },
  {
    ...base,
    seq: 2,
    type: "tool.completed",
    payload: {
      callId: "call",
      name: "shell",
      status: "ok",
      output: { taskId: "task", logPath: "/sessions/s.tasks/task.log", background: true },
      modelContent: "started",
    },
  },
  result,
];
describe("backgroundShells projection", () => {
  it("derives start and completion with end time and retains finished tasks on replay", () => {
    const view = replaySessionView(events);
    expect(view.backgroundShells).toEqual([
      {
        taskId: "task",
        callId: "call",
        name: "fixture",
        command: "node fixture",
        logPath: "/sessions/s.tasks/task.log",
        startedAt: base.time,
        endedAt: end,
        status: "exited",
        exitCode: 0,
      },
    ]);
  });
  it("ephemeral task status converges to durable result without creating entries", () => {
    const live = createSessionView();
    for (const event of events.slice(0, 2)) reduceSessionView(live, event);
    const first = live.backgroundShells[0];
    if (!first) throw new Error("missing task");
    const task = { ...first, status: "exited" as const, exitCode: 0, endedAt: end };
    reduceSessionView(live, {
      ...base,
      type: "shell.task_updated",
      runId: "run",
      eseq: 1,
      afterSeq: 2,
      payload: { task },
    } as RuntimeEvent);
    expect(live.entries).toHaveLength(1);
    reduceSessionView(live, result);
    expect(live.backgroundShells).toEqual(replaySessionView(events).backgroundShells);
  });
});
