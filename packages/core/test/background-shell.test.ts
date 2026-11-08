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
    kill?: boolean;
    timeoutMs?: number;
    name?: string;
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
              name: extra.name ?? "fixture",
              ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
            },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      if ((extra.consume || extra.kill) && calls === 2) {
        const task = must(opened.current?.shellTasks()[0]);
        await vi.waitFor(() => expect(readFileSync(task.logPath, "utf8")).toContain("ready"), {
          timeout: 5000,
        });
        return [
          {
            type: "tool_call",
            toolCallId: "read",
            name: extra.kill ? "shell_kill" : "shell_output",
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
  it("model stop returns killed unread tail, consumes cursor and survives recovery without pending input", async () => {
    const { session, options } = await setup({ kill: true });
    await session.submit({ text: "go" });
    const task = must(session.shellTasks()[0]);
    await vi.waitFor(() => expect(readFileSync(task.logPath, "utf8")).toContain("ready"), {
      timeout: 5000,
    });
    expect(results(session)).toHaveLength(0);
    expect(session.pendingInputs().items).toHaveLength(0);
    const result = must(
      session
        .durableEvents()
        .find((event) => event.type === "tool.completed" && event.payload.name === "shell_kill"),
    );
    expect(result.type === "tool.completed" && result.payload.modelContent).toContain(
      'status="killed"',
    );
    expect(JSON.stringify(result.payload)).toContain("ready");
    const report = await session.describeContext();
    expect(JSON.stringify(report.request)).not.toContain("Stopped by the user");
    const id = session.id;
    await session.close();
    const resumed = await (await createRuntime(options)).resumeSession(id);
    sessions.push(resumed);
    expect(resumed.pendingInputs().items).toHaveLength(0);
    expect(replaySessionView(resumed.durableEvents()).backgroundShells[0]?.status).toBe("killed");
    expect(
      session
        .durableEvents()
        .filter((event) => event.type === "tool.completed" && event.payload.callId === task.callId),
    ).toHaveLength(1);
  }, 20000);
  it.each(["named", ""])(
    "natural result pending name uses name or command first line (%s)",
    async (name) => {
      const { session, options } = await setup({
        pause: true,
        name,
        script: 'console.log("tail"); setTimeout(()=>{},1000);',
      });
      await session.submit({ text: "go" });
      const task = must(session.shellTasks()[0]);
      await vi.waitFor(() => expect(session.pendingInputs().items).toHaveLength(1), {
        timeout: 5000,
      });
      expect(session.pendingInputs().items[0]?.shellName).toBe(
        name || task.command.split(/\r?\n/)[0],
      );
      const id = session.id;
      await session.close();
      const resumed = await (await createRuntime(options)).resumeSession(id);
      sessions.push(resumed);
      expect(resumed.pendingInputs().items[0]?.shellName).toBe(
        name || task.command.split(/\r?\n/)[0],
      );
    },
  );
  it("timeout still delivers a result and wakes the idle model", async () => {
    const { session, requests } = await setup({ timeoutMs: 1500 });
    await session.submit({ text: "go" });
    await vi.waitFor(() => expect(results(session)).toHaveLength(1), { timeout: 10000 });
    const result = must(results(session)[0]);
    expect(result.type === "message.user" && result.payload.backgroundShell?.status).toBe(
      "timeout",
    );
    expect(requests.length).toBeGreaterThan(2);
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
  it.each([false, true])(
    "user stop stays silent; note persists once with a stable message prefix across turns and recovery (paused=%s)",
    async (pause) => {
      const { session, options, requests } = await setup({ pause });
      await session.submit({ text: "go" });
      const task = must(session.shellTasks()[0]);
      const count = requests.length;
      await session.shellKill(task.taskId);
      expect(results(session)).toHaveLength(0);
      expect(session.pendingInputs().items).toHaveLength(0);
      expect(requests).toHaveLength(count);
      expect(replaySessionView(session.durableEvents()).backgroundShells[0]?.status).toBe("killed");
      const id = session.id;
      await session.close();
      const resumed = await (await createRuntime(options)).resumeSession(id);
      sessions.push(resumed);
      expect(resumed.pendingInputs().items).toHaveLength(0);
      expect(resumed.shellTasks()[0]?.status).toBe("killed");
      await resumed.submit({ text: "next" });
      const note = `[Background command] Stopped by the user: fixture (taskId: ${task.taskId}).`;
      const first = must(requests.at(-1)).messages;
      expect(JSON.stringify(first).split(note).length - 1).toBe(1);
      await resumed.submit({ text: "next again" });
      const second = must(requests.at(-1)).messages;
      expect(JSON.stringify(second).split(note).length - 1).toBe(1);
      expect(second.slice(0, first.length)).toEqual(first);
      expect(JSON.stringify(replaySessionView(resumed.durableEvents()).entries)).not.toContain(
        note,
      );
      await resumed.close();
      const again = await (await createRuntime(options)).resumeSession(id);
      sessions.push(again);
      await again.submit({ text: "again" });
      const recovered = must(requests.at(-1)).messages;
      expect(JSON.stringify(recovered).split(note).length - 1).toBe(1);
      expect(recovered.slice(0, second.length)).toEqual(second);
      expect(JSON.stringify(replaySessionView(again.durableEvents()).entries)).not.toContain(note);
    },
    20000,
  );
  it("user stop during a turn appends one persistent hidden note at the next queued-input turn", async () => {
    const { session, requests, options } = await setup({ longTurn: true });
    const running = session.submit({ text: "go" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const task = must(session.shellTasks()[0]);
    await session.shellKill(task.taskId);
    await running;
    const note = `[Background command] Stopped by the user: fixture (taskId: ${task.taskId}).`;
    expect(JSON.stringify(requests)).not.toContain(note);
    expect(results(session)).toHaveLength(0);
    expect(session.pendingInputs()).toEqual({ items: [], paused: false });
    await session.enqueueInput("queue", { text: "queued" });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const first = must(requests.at(-1)).messages;
    expect(JSON.stringify(first).split(note).length - 1).toBe(1);
    await session.submit({ text: "again" });
    const second = must(requests.at(-1)).messages;
    expect(JSON.stringify(second).split(note).length - 1).toBe(1);
    expect(second.slice(0, first.length)).toEqual(first);
    const id = session.id;
    await session.close();
    const resumed = await (await createRuntime(options)).resumeSession(id);
    sessions.push(resumed);
    await resumed.submit({ text: "recovered" });
    const recovered = must(requests.at(-1)).messages;
    expect(JSON.stringify(recovered).split(note).length - 1).toBe(1);
    expect(recovered.slice(0, second.length)).toEqual(second);
    expect(JSON.stringify(replaySessionView(resumed.durableEvents()).entries)).not.toContain(note);
  }, 20000);
  it("paused result is readonly and retractable, retraction prevents delivery", async () => {
    const { session } = await setup({
      pause: true,
      script: 'console.log("tail"); setTimeout(()=>{},1000);',
    });
    await session.submit({ text: "go" });
    await vi.waitFor(() => expect(session.pendingInputs().items[0]?.mode).toBe("shell"), {
      timeout: 5000,
    });
    const item = must(session.pendingInputs().items[0]);
    expect(item.paused).toBe(true);
    await expect(session.updateInput(item.id, { input: { text: "edited" } })).rejects.toThrow();
    await session.cancelInput(item.id);
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
