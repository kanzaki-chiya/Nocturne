import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeProvider, type ModelRequest } from "@nocturne/core";
import { replaySessionView } from "@nocturne/core/protocol";
import { cleanupTmp, connect, MODEL, textScript, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);
it("shell observer RPC preserves offset zero and reads the full tail after completion and delivery", async () => {
  let command = "";
  let calls = 0;
  const h = await connect({
    shell: { background: true },
    provider: new FakeProvider({
      models: VISION_MODELS,
      handler: async () =>
        calls++ === 0
          ? [
              {
                type: "tool_call",
                toolCallId: "launch",
                name: "shell",
                input: { command, background: true },
              },
              { type: "finish", reason: "tool_calls" },
            ]
          : textScript("done"),
    }),
  });
  const file = path.join(h.ws, "fixture.cjs");
  const pidFile = path.join(h.ws, "pid.json");
  writeFileSync(
    file,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid)); process.stdout.write("a".repeat(210000)+"中文END");`,
  );
  command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${file}"`;
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.setPermissionPreset("bypass");
    await session.submit({ text: "go" });
    await session.submit({ text: "go again" });
    await vi.waitFor(
      async () =>
        expect(
          (await session.shellTasks()).some(
            (task) => task.outputChars === 210005 && task.status === "exited",
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    const task = (await session.shellTasks()).find((item) => item.outputChars === 210005);
    if (!task) throw new Error("missing task");
    const first = await session.shellOutput(task.taskId);
    expect(first).toMatchObject({ start: 10005, end: 210005 });
    expect(first.text).toBe("a".repeat(199995) + "中文END");
    expect(await session.shellOutput(task.taskId, 0)).toEqual(first);
    expect(await session.shellOutput(task.taskId, first.end)).toMatchObject({
      start: 210005,
      end: 210005,
      text: "",
    });
    const pid = JSON.parse(readFileSync(pidFile, "utf8")) as number;
    expect(() => process.kill(pid, 0)).toThrow();
    await session.close();
  } finally {
    h.client.close();
    await h.served;
  }
});
it("RPC shell.kill stays silent and preserves one hidden user-stop note across turns and recovery", async () => {
  let command = "";
  let calls = 0;
  const contexts: ModelRequest["messages"][] = [];
  const h = await connect({
    shell: { background: true },
    provider: new FakeProvider({
      models: VISION_MODELS,
      handler: async (request) => {
        contexts.push(structuredClone(request.messages));
        return calls++ === 0
          ? [
              {
                type: "tool_call",
                toolCallId: "launch",
                name: "shell",
                input: { command, background: true, name: "infinite" },
              },
              { type: "finish", reason: "tool_calls" },
            ]
          : textScript("done");
      },
    }),
  });
  const file = path.join(h.ws, "stop-fixture.cjs");
  const pidFile = path.join(h.ws, "stop-pid.json");
  writeFileSync(
    file,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid)); console.log("ready"); setInterval(()=>{},500);`,
  );
  command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${file}"`;
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    await session.setPermissionPreset("bypass");
    await session.submit({ text: "go" });
    const task = (await session.shellTasks())[0];
    if (!task) throw new Error("missing task");
    await vi.waitFor(
      async () => expect((await session.shellOutput(task.taskId)).text).toContain("ready"),
      { timeout: 5000 },
    );
    const count = contexts.length;
    await session.shellKill(task.taskId);
    expect(await session.pendingInputs()).toEqual({ items: [], paused: false });
    expect(contexts).toHaveLength(count);
    const pid = JSON.parse(readFileSync(pidFile, "utf8")) as number;
    expect(() => process.kill(pid, 0)).toThrow();
    await session.submit({ text: "next" });
    const note = `[Background command] Stopped by the user: infinite (taskId: ${task.taskId}).`;
    const first = contexts.at(-1) ?? [];
    expect(JSON.stringify(first).split(note).length - 1).toBe(1);
    await session.submit({ text: "again" });
    const second = contexts.at(-1) ?? [];
    expect(JSON.stringify(second).split(note).length - 1).toBe(1);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(JSON.stringify(replaySessionView(h.durable(session.id)).entries)).not.toContain(note);
    const id = session.id;
    await session.close();
    const { session: resumed } = await h.client.runtime.resumeSession(id);
    await resumed.submit({ text: "recovered" });
    const recovered = contexts.at(-1) ?? [];
    expect(JSON.stringify(recovered).split(note).length - 1).toBe(1);
    expect(recovered.slice(0, second.length)).toEqual(second);
    expect(JSON.stringify(replaySessionView(h.durable(id)).entries)).not.toContain(note);
    await resumed.close();
  } finally {
    h.client.close();
    await h.served;
  }
}, 20000);
it("shell RPC tasks/output/kill map to the current session and validate arguments", async () => {
  const h = await connect();
  try {
    const { session } = await h.client.runtime.createSession({ model: MODEL });
    expect(await h.client.call("shell.tasks", { sessionId: session.id })).toEqual([]);
    await expect(
      h.client.call("shell.output", { sessionId: session.id, taskId: "other" }),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      h.client.call("shell.kill", { sessionId: session.id, taskId: "other" }),
    ).rejects.toMatchObject({ code: "invalid_command" });
    await expect(
      h.client.call("shell.output", { sessionId: session.id, taskId: 1 as never }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("shell.output", {
        sessionId: session.id,
        taskId: "other",
        offset: -1,
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    for (const offset of [-1, 0.5, "0", null]) {
      await expect(
        h.client.call("shell.output", {
          sessionId: session.id,
          taskId: "other",
          offset: offset as never,
        }),
      ).rejects.toMatchObject({ rpcCode: -32602 });
    }
    await expect(
      h.client.call("shell.output", {
        sessionId: session.id,
        taskId: "other",
        since: "start",
      } as never),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await session.close();
  } finally {
    h.client.close();
    await h.served;
  }
});
