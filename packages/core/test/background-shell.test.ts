import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type RuntimeSession } from "../src/index.js";
import type { ModelRequest } from "../src/provider/types.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const roots: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await removeTempDirs(roots.splice(0));
});
const done: FakeScript = [{ type: "text_delta", text: "done" }, { type: "finish", reason: "stop" }];
async function setup(extra: { enabled?: boolean; pause?: boolean; longTurn?: boolean; script?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-background-shell-"));
  roots.push(root);
  const file = path.join(root, "fixture.cjs");
  writeFileSync(file, extra.script ?? 'console.log("ready"); setInterval(()=>{},1000);');
  let calls = 0;
  const requests: ModelRequest[] = [];
  const provider = new FakeProvider({ handler: (request) => {
    requests.push(request);
    if (calls++ === 0) return [{ type: "tool_call", toolCallId: "shell", name: "shell", input: { command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${file}"`, background: true, name: "fixture" } }, { type: "finish", reason: "tool_calls" }];
    return extra.longTurn && calls === 2 ? [{ type: "wait", ms: 1500 }, ...done] : extra.pause && calls === 2 ? [{ type: "finish", reason: "length" }] : done;
  }});
  const options = { cwd: root, sessionsDir: path.join(root, "sessions"), providers: [provider], shell: { background: extra.enabled !== false }, permissions: { autoApproveAsk: true } };
  const runtime = await createRuntime(options);
  const session = await runtime.createSession({ model: "fake/fake-1" });
  sessions.push(session);
  return { runtime, session, requests, options };
}
const results = (session: Awaited<ReturnType<typeof setup>>["session"]) => session.durableEvents().filter((event) => event.type === "message.user" && event.payload.backgroundShell);

describe("ADR-0083 Runtime", () => {
  it("one tool.completed, idle wakeup, killed result only contains unread tail", async () => {
    const { session } = await setup();
    await session.submit({ text: "go" });
    const task = session.shellTasks()[0]!;
    await vi.waitFor(() => expect(readFileSync(task.logPath, "utf8")).toContain("ready"), { timeout: 5000 });
    expect((await session.shellOutput(task.taskId)).text).toContain("ready");
    await session.shellKill(task.taskId);
    await vi.waitFor(() => expect(results(session)).toHaveLength(1));
    const result = results(session)[0]!;
    expect(result.type === "message.user" && result.payload.backgroundShell?.status).toBe("killed");
    expect(JSON.stringify(result.payload)).not.toContain("ready");
    expect(session.durableEvents().filter((event) => event.type === "tool.completed" && event.payload.callId === task.callId)).toHaveLength(1);
  }, 20000);
  it("safe point delivers inside running turn", async () => {
    const { session } = await setup({ longTurn: true, script: 'console.log("tail"); setTimeout(()=>{},300);' });
    await session.submit({ text: "go" });
    const result = results(session)[0]!;
    expect(result.type === "message.user" && result.payload.steer).toBe(true);
    expect(session.durableEvents().filter((event) => event.type === "turn.started")).toHaveLength(1);
  });
  it("paused result is readonly and retractable, retraction prevents delivery", async () => {
    const { session } = await setup({ pause: true });
    await session.submit({ text: "go" });
    await session.shellKill(session.shellTasks()[0]!.taskId);
    await vi.waitFor(() => expect(session.pendingInputs().items[0]?.mode).toBe("shell"));
    const item = session.pendingInputs().items[0]!;
    expect(item.paused).toBe(true);
    await expect(session.updateInput(item.id, { input: { text: "edited" } })).rejects.toThrow();
    session.cancelInput(item.id);
    await session.submit({ text: "continue" });
    expect(results(session)).toHaveLength(0);
  }, 20000);
  it("Esc does not stop the process; close stops without delivery; resume reports paused interrupted", async () => {
    const { session, options } = await setup({ longTurn: true });
    const running = session.submit({ text: "go" });
    await vi.waitFor(() => expect(session.shellTasks()).toHaveLength(1));
    session.interrupt();
    await running;
    expect(session.shellTasks()[0]?.status).toBe("running");
    const id = session.id;
    await session.close();
    expect(results(session)).toHaveLength(0);
    const restarted = await createRuntime(options);
    const resumed = await restarted.resumeSession(id);
    sessions.push(resumed);
    expect(resumed.pendingInputs().items[0]).toMatchObject({ mode: "shell", paused: true });
    expect(resumed.pendingInputs().items[0]?.text).toContain('status="interrupted"');
  }, 20000);
  it("disabled host omits schema fields and output/kill tools", async () => {
    const { session, requests } = await setup({ enabled: false });
    await session.submit({ text: "go" });
    const tools = requests[0]!.tools;
    expect(JSON.stringify(tools.find((tool) => tool.name === "shell"))).not.toMatch(/background|"name":\{/);
    expect(tools.some((tool) => tool.name === "shell_output" || tool.name === "shell_kill")).toBe(false);
  });
});
