import { describe, expect, it } from "vitest";
import { createSessionView, reduceSessionView, replaySessionView, type DurableEvent, type RuntimeEvent } from "../src/protocol/index.js";
const base = { sessionId: "s", turnId: "turn", time: "2026-11-07T00:00:00.000Z" };
const events: DurableEvent[] = [
  { ...base, seq: 1, type: "tool.started", payload: { callId: "call", name: "shell", input: { command: "node fixture", background: true, name: "fixture" }, subjects: [], permission: { action: "allow", source: "rule" } } },
  { ...base, seq: 2, type: "tool.completed", payload: { callId: "call", name: "shell", status: "ok", output: { taskId: "task", logPath: "/sessions/s.tasks/task.log", background: true }, modelContent: "started" } },
  { ...base, seq: 3, time: "2026-11-07T00:00:03.000Z", type: "message.user", payload: { messageId: "result", content: [{ type: "text", text: "tail" }], backgroundShell: { taskId: "task", callId: "call", status: "exited", exitCode: 0 } } },
];
describe("backgroundShells projection", () => {
  it("derives start and completion with end time and retains finished tasks on replay", () => {
    const view = replaySessionView(events);
    expect(view.backgroundShells).toEqual([{ taskId: "task", callId: "call", name: "fixture", command: "node fixture", logPath: "/sessions/s.tasks/task.log", startedAt: base.time, endedAt: events[2]!.time, status: "exited", exitCode: 0 }]);
  });
  it("ephemeral task status converges to durable result without creating entries", () => {
    const live = createSessionView();
    for (const event of events.slice(0, 2)) reduceSessionView(live, event);
    const task = { ...live.backgroundShells[0]!, status: "exited" as const, exitCode: 0, endedAt: events[2]!.time };
    reduceSessionView(live, { ...base, type: "shell.task_updated", runId: "run", eseq: 1, afterSeq: 2, payload: { task } } as RuntimeEvent);
    expect(live.entries).toHaveLength(1);
    reduceSessionView(live, events[2]!);
    expect(live.backgroundShells).toEqual(replaySessionView(events).backgroundShells);
  });
});
