import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatform, createRuntime, type RuntimeSession } from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import type { ModelRequest } from "../src/provider/types.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";
const cleanup = createProcessCleanup();

const roots: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await cleanup.cleanup();
  await removeTempDirs(roots.splice(0));
});
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}
const done: FakeScript = [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];
async function setup(
  extra: {
    enabled?: boolean;
    pause?: boolean;
    longTurn?: boolean;
    script?: string;
    consume?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-background-shell-"));
  roots.push(root);
  const file = path.join(root, "fixture.cjs");
  const pidFile = path.join(root, "fixture.pid.json");
  cleanup.watchPidFile(pidFile);
  writeFileSync(
    file,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));\n` +
      (extra.script ?? 'console.log("ready"); setInterval(()=>{},1000);'),
  );
  let calls = 0;
  const requests: ModelRequest[] = [];
  const opened: { current?: RuntimeSession } = {};
  const provider = new FakeProvider({
    handler: async (request) => {
      requests.push(request);
      if (calls++ === 0)
        return [
          {
            type: "tool_call",
            toolCallId: "shell",
            name: "shell",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${file}"`,
              background: true,
              name: "fixture",
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      if (extra.consume && calls === 2) {
        const task = must(opened.current?.shellTasks()[0]);
        await vi.waitFor(() => expect(readFileSync(task.logPath, "utf8")).toContain("ready"), {
          timeout: 5000,
        });
        return [
          {
            type: "tool_call",
            toolCallId: "read",
            name: "shell_output",
            input: { id: task.taskId },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return extra.longTurn && calls === 2
        ? [{ type: "wait", ms: 1500 }, ...done]
        : extra.pause && calls === 2
          ? [{ type: "finish", reason: "length" }]
          : done;
    },
  });
  const options = {
    platform: cleanup.platform(createPlatform()),
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    shell: { background: extra.enabled !== false },
    permissions: { autoApproveAsk: true },
  };
  const runtime = await createRuntime(options);
  const session = await runtime.createSession({ model: "fake/fake-1" });
  opened.current = session;
  sessions.push(session);
  return { runtime, session, requests, options, root };
}
const results = (session: Awaited<ReturnType<typeof setup>>["session"]) =>
  session
    .durableEvents()
    .filter((event) => event.type === "message.user" && event.payload.backgroundShell);

describe("ADR-0083 Runtime", () => {
  it("one tool.completed, idle wakeup, killed result only contains unread tail", async () => {
    const { session } = await setup({ consume: true });
    await session.submit({ text: "go" });
    const task = must(session.shellTasks()[0]);
    await vi.waitFor(() => expect(readFileSync(task.logPath, "utf8")).toContain("ready"), {
      timeout: 5000,
    });
    expect((await session.shellOutput(task.taskId, "start")).text).toContain("ready");
    await session.shellKill(task.taskId);
    await vi.waitFor(() => expect(results(session)).toHaveLength(1));
    const result = must(results(session)[0]);
    expect(result.type === "message.user" && result.payload.backgroundShell?.status).toBe("killed");
    expect(JSON.stringify(result.payload)).not.toContain("ready");
    expect(
      session
        .durableEvents()
        .filter((event) => event.type === "tool.completed" && event.payload.callId === task.callId),
    ).toHaveLength(1);
  }, 20000);
  it("safe point delivers inside running turn", async () => {
    const { session } = await setup({
      longTurn: true,
      script: 'console.log("tail"); setTimeout(()=>{},300);',
    });
    await session.submit({ text: "go" });
    const result = must(results(session)[0]);
    expect(result.type === "message.user" && result.payload.steer).toBe(true);
    expect(session.durableEvents().filter((event) => event.type === "turn.started")).toHaveLength(
      1,
    );
  });
  it("paused result is readonly and retractable, retraction prevents delivery", async () => {
    const { session } = await setup({ pause: true });
    await session.submit({ text: "go" });
    await session.shellKill(must(session.shellTasks()[0]).taskId);
    await vi.waitFor(() => expect(session.pendingInputs().items[0]?.mode).toBe("shell"));
    const item = must(session.pendingInputs().items[0]);
    expect(item.paused).toBe(true);
    await expect(session.updateInput(item.id, { input: { text: "edited" } })).rejects.toThrow();
    session.cancelInput(item.id);
    await session.submit({ text: "continue" });
    expect(results(session)).toHaveLength(0);
  }, 20000);
  it("Esc does not stop the process; close stops without delivery; resume reports paused interrupted", async () => {
    const { session, options, root } = await setup({ longTurn: true });
    const running = session.submit({ text: "go" });
    await vi.waitFor(() => expect(session.shellTasks()).toHaveLength(1));
    await vi.waitFor(
      () => expect(readFileSync(path.join(root, "fixture.pid.json"), "utf8")).toMatch(/\d+/),
      { timeout: 5000 },
    );
    const pid = JSON.parse(readFileSync(path.join(root, "fixture.pid.json"), "utf8")) as number;
    session.interrupt();
    await running;
    expect(session.shellTasks()[0]?.status).toBe("running");
    const id = session.id;
    await session.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(results(session)).toHaveLength(0);
    const restarted = await createRuntime(options);
    const resumed = await restarted.resumeSession(id);
    sessions.push(resumed);
    expect(resumed.pendingInputs().items[0]).toMatchObject({ mode: "shell", paused: true });
    expect(resumed.shellTasks()[0]?.status).toBe("interrupted");
    expect(resumed.pendingInputs().items[0]?.text).toContain('status="interrupted"');
  }, 20000);
  it("rewind before launch stops without delivery; fork inherits no tasks or interrupted pending input", async () => {
    const { session, runtime, root } = await setup();
    await session.submit({ text: "go" });
    await vi.waitFor(
      () => expect(readFileSync(path.join(root, "fixture.pid.json"), "utf8")).toMatch(/\d+/),
      { timeout: 5000 },
    );
    const pid = JSON.parse(readFileSync(path.join(root, "fixture.pid.json"), "utf8")) as number;
    const fork = await runtime.resumeSession(await runtime.forkSession(session.id));
    sessions.push(fork);
    expect(fork.shellTasks()).toHaveLength(0);
    expect(replaySessionView(fork.durableEvents()).backgroundShells).toHaveLength(0);
    expect(fork.pendingInputs().items).toHaveLength(0);
    const user = must(session.durableEvents().find((event) => event.type === "message.user"));
    await session.rewind(user.seq, "conversation");
    expect(session.shellTasks()).toHaveLength(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(results(session)).toHaveLength(0);
  });
  it("goal continues checking while a background command is still running", async () => {
    const { session, requests, root } = await setup();
    await session.submit({ text: "go", workMode: "goal" });
    await vi.waitFor(
      () => expect(readFileSync(path.join(root, "fixture.pid.json"), "utf8")).toMatch(/\d+/),
      { timeout: 5000 },
    );
    expect(session.shellTasks()[0]?.status).toBe("running");
    expect(session.state().goal?.rounds).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(2);
  });
  it("child and scheduled session schemas omit background and management tools", async () => {
    const { runtime } = await setup();
    for (const options of [
      { parent: { sessionId: "parent", callId: "task" } },
      {
        schedule: {
          taskId: "scheduled",
          scheduledAt: new Date().toISOString(),
          trigger: "manual" as const,
        },
      },
    ]) {
      const child = await runtime.createSession({ model: "fake/fake-1", ...options });
      sessions.push(child);
      const report = await child.describeContext();
      const shell = must(report.request.tools.find((tool) => tool.name === "shell"));
      expect(JSON.stringify(shell.inputSchema)).not.toContain('"background"');
      expect(JSON.stringify(shell.inputSchema)).not.toContain('"name"');
      expect(
        report.request.tools.some(
          (tool) => tool.name === "shell_output" || tool.name === "shell_kill",
        ),
      ).toBe(false);
    }
  });
  it("disabled host omits schema fields and output/kill tools", async () => {
    const { session, requests } = await setup({ enabled: false });
    await session.submit({ text: "go" });
    const tools = must(requests[0]).tools;
    expect(JSON.stringify(tools.find((tool) => tool.name === "shell"))).not.toMatch(
      /background|"name":\{/,
    );
    expect(tools.some((tool) => tool.name === "shell_output" || tool.name === "shell_kill")).toBe(
      false,
    );
  });
});
