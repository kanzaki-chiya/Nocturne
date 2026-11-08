import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createPlatform, createRuntime, FakeProvider, type RuntimeSession } from "../src/index.js";
import type { FakeScript } from "../src/provider/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const cleanup = createProcessCleanup();
const roots: string[] = [];
const sessions: RuntimeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await cleanup.cleanup();
  await removeTempDirs(roots.splice(0));
});

it("withdraws ten-second result during foreground work; done has no pending input, including after reload", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nct-shell-retraction-"));
  roots.push(root);
  const command = (name: string, script: string) => {
    const file = path.join(root, `${name}.cjs`);
    writeFileSync(file, script);
    return `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${file}"`;
  };
  const ten = command("ten", "setTimeout(()=>console.log('done'),10000);");
  const infinite = command("infinite", "setInterval(()=>console.log('x'),500);");
  const foreground = command("foreground", "setTimeout(()=>{},30000);");
  let step = 0;
  const call = (name: string, input: unknown): FakeScript => [
    { type: "tool_call", toolCallId: `call-${step}`, name, input },
    { type: "finish", reason: "tool_calls" },
  ];
  const options = {
    platform: cleanup.platform(createPlatform()),
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    shell: { background: true },
    permissions: { autoApproveAsk: true },
    providers: [
      new FakeProvider({
        handler: async () => {
          step++;
          if (step === 1) return call("shell", { command: ten, name: "十秒", background: true });
          if (step === 2)
            return call("shell", { command: infinite, name: "无限", background: true });
          if (step === 3) return call("shell", { command: foreground, timeoutMs: 60000 });
          const task = session.shellTasks().find((task) => task.name === "无限");
          if (!task) throw new Error("missing infinite task");
          if (step === 4) return call("shell_output", { id: task.taskId });
          if (step === 5) return call("shell_kill", { id: task.taskId });
          return [
            { type: "text_delta", text: "done" },
            { type: "finish", reason: "stop" },
          ];
        },
      }),
    ],
  };
  const runtime = await createRuntime(options);
  const session = await runtime.createSession({ model: "fake/fake-1" });
  sessions.push(session);
  const running = session.submit({ text: "go" });
  await vi.waitFor(() => expect(session.pendingInputs().items).toHaveLength(1), { timeout: 20000 });
  const withdrawn = session.pendingInputs().items[0];
  const tenTask = session.shellTasks().find((task) => task.name === "十秒");
  if (!withdrawn || !tenTask) throw new Error("missing ten-second result");
  expect(withdrawn.text).toContain(tenTask.taskId);
  console.log("before withdrawal", JSON.stringify(session.pendingInputs()));
  await session.cancelInput(withdrawn.id);
  expect(session.pendingInputs()).toEqual({ items: [], paused: false });
  expect(await running).toBe("done");
  console.log("after done", JSON.stringify(session.pendingInputs()));
  expect(session.pendingInputs()).toEqual({ items: [], paused: false });
  const delivered = session
    .durableEvents()
    .filter((event) => event.type === "message.user" && event.payload.backgroundShell);
  console.log("delivered", JSON.stringify(delivered.map((event) => event.payload)));
  expect(
    delivered.some(
      (event) =>
        event.type === "message.user" && event.payload.backgroundShell?.taskId === tenTask.taskId,
    ),
  ).toBe(false);
  const id = session.id;
  await session.close();
  const resumed = await (await createRuntime(options)).resumeSession(id);
  sessions.push(resumed);
  console.log("after reload", JSON.stringify(resumed.pendingInputs()));
  expect(resumed.pendingInputs()).toEqual({ items: [], paused: false });
}, 60000);
