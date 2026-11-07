import { afterEach, expect, it } from "vitest";
import { cleanupTmp, connect, MODEL } from "./harness.js";

afterEach(cleanupTmp);
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
        since: "bad" as never,
      }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await session.close();
  } finally {
    h.client.close();
    await h.served;
  }
});
