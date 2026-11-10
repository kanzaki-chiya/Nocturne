import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeProvider, type FakeScript, type RuntimeSession } from "@nocturne/core";
import { Hub } from "../src/server/hub.js";
import { cleanupTmp, connectMany, MODEL, textScript, until, VISION_MODELS } from "./harness.js";

afterEach(cleanupTmp);

function requireSession(session: RuntimeSession | undefined): RuntimeSession {
  if (session === undefined) throw new Error("missing core session");
  return session;
}

for (const kind of ["subagent", "shell"] as const) {
  for (const reconnect of [false, true]) {
    it(`${kind}: remote release preserves delivery and its follow-up turn (reconnect=${reconnect})`, async () => {
      let finishChild!: () => void;
      const childReady = new Promise<void>((resolve) => {
        finishChild = resolve;
      });
      let finishFollowup!: () => void;
      const followupReady = new Promise<void>((resolve) => {
        finishFollowup = resolve;
      });
      let dispatched = false;
      let following = false;
      let command = "";
      const provider = new FakeProvider({
        models: VISION_MODELS,
        handler: async (request): Promise<FakeScript> => {
          if (request.tools.some((tool) => tool.name === "finish")) {
            await childReady;
            return [
              {
                type: "tool_call",
                toolCallId: "finish",
                name: "finish",
                input: { result: "child result" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (!dispatched) {
            dispatched = true;
            return [
              {
                type: "tool_call",
                toolCallId: "launch",
                name: kind === "shell" ? "shell" : "task",
                input:
                  kind === "shell"
                    ? { command, background: true }
                    : { task: "read", preset: "explore", background: true },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (
            JSON.stringify(request.messages).includes(
              kind === "shell" ? "<shell-result" : "<subagent-result",
            )
          ) {
            following = true;
            await followupReady;
          }
          return textScript("done");
        },
      });
      const h = await connectMany({
        provider,
        subagent: { background: true },
        shell: { background: true },
      });
      const gate = path.join(h.ws, "release-gate");
      const script = path.join(h.ws, "background.cjs");
      writeFileSync(
        script,
        `const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log('shell result'); } }, 10);`,
      );
      command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`;
      try {
        const remote = await h.add();
        const { session } = await remote.client.runtime.createSession({ model: MODEL, cwd: h.ws });
        await session.setPermissionPreset("bypass");
        expect(await session.submit({ text: "start background work" })).toBe("done");
        const core = requireSession(h.coreSession(session.id));
        const close = vi.spyOn(core, "close");
        const lock = path.join(h.sessionsDir, `${session.id}.lock`);
        remote.client.close();
        await remote.served;
        expect(close).not.toHaveBeenCalled();
        expect(existsSync(lock)).toBe(true);
        const again = reconnect ? await h.add() : undefined;
        const reopened = again
          ? (await again.client.runtime.resumeSession(session.id)).session
          : undefined;
        if (reopened) expect(h.coreSession(session.id)).toBe(core);
        finishChild();
        writeFileSync(gate, "ready");
        await until(() => following, "background result starts next turn");
        expect(close).not.toHaveBeenCalled();
        expect(
          h
            .durable(session.id)
            .some(
              (event) =>
                event.type === "message.user" &&
                (kind === "shell"
                  ? event.payload.backgroundShell?.status === "exited"
                  : event.payload.subagent?.status === "ok"),
            ),
        ).toBe(true);
        if (reopened && again) {
          const received: string[] = [];
          await reopened.subscribe((event) => received.push(event.type));
          expect(received).toContain("message.user");
          again.client.close();
          await again.served;
          expect(close).not.toHaveBeenCalled();
        }
        finishFollowup();
        await until(() => !existsSync(lock), "unreferenced session closes after follow-up");
        expect(close).toHaveBeenCalledTimes(1);
        expect(
          h
            .durable(session.id)
            .filter((event) => event.type === "turn.completed")
            .map((event) => event.payload.reason),
        ).toEqual(["done", "done"]);
      } finally {
        finishChild();
        finishFollowup();
        writeFileSync(gate, "ready");
        h.client.close();
        await h.served;
      }
    }, 15000);
  }
}

it("remote release without background work closes immediately", async () => {
  const h = await connectMany();
  try {
    const remote = await h.add();
    const { session } = await remote.client.runtime.createSession({ model: MODEL, cwd: h.ws });
    const close = vi.spyOn(requireSession(h.coreSession(session.id)), "close");
    remote.client.close();
    await remote.served;
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    h.client.close();
    await h.served;
  }
});

for (const shutdown of [false, true]) {
  it(`${shutdown ? "hub shutdown" : "local disconnect"} still aborts and discards background subagents`, async () => {
    let dispatched = false;
    const provider = new FakeProvider({
      models: VISION_MODELS,
      handler: (request) => {
        if (request.tools.some((tool) => tool.name === "finish"))
          return [{ type: "wait", ms: 60000 }];
        if (dispatched) return textScript("done");
        dispatched = true;
        return [
          {
            type: "tool_call",
            toolCallId: "launch",
            name: "task",
            input: { task: "read", preset: "explore", background: true },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });
    const h = await connectMany({ provider, subagent: { background: true } });
    try {
      const { session } = await h.client.runtime.createSession({ model: MODEL });
      expect(await session.submit({ text: "go" })).toBe("done");
      await until(() => provider.waitState.waiting === 1);
      if (shutdown) {
        const hub = new Hub();
        hub.addSession(requireSession(h.coreSession(session.id)));
        await hub.shutdown();
      } else {
        h.client.close();
        await h.served;
      }
      expect(provider.waitState.aborts).toBe(1);
      expect(
        h
          .durable(session.id)
          .some((event) => event.type === "message.user" && event.payload.subagent),
      ).toBe(false);
    } finally {
      h.client.close();
      await h.served;
    }
  });
}
