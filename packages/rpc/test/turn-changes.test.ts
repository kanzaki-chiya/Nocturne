import { afterEach, expect, it } from "vitest";
import { cleanupTmp, connect, MODEL, textScript } from "./harness.js";

afterEach(cleanupTmp);
it("turnChanges 与 turnChangeDiff RPC 往返，invalid_command 原样映射", async () => {
  const h = await connect({
    scripts: [
      [
        {
          type: "tool_call",
          toolCallId: "w",
          name: "write",
          input: { path: "a.txt", content: "one\n" },
        },
        { type: "finish", reason: "tool_calls" },
      ],
      textScript("done"),
    ],
  });
  try {
    const { session } = await h.client.runtime.createSession({
      model: MODEL,
      permissionPreset: "bypass",
    });
    await session.submit({ text: "write" });
    const [turn] = await session.turnChanges();
    expect(turn?.files[0]).toMatchObject({
      status: "added",
      added: 1,
      removed: 0,
      external: false,
    });
    if (!turn?.files[0]) throw new Error("no change");
    expect(await session.turnChangeDiff(turn.seq, turn.files[0].path)).toEqual({
      diff: "@@ -0,0 +1,1 @@\n+one",
    });
    await expect(session.turnChangeDiff(999, turn.files[0].path)).rejects.toMatchObject({
      code: "invalid_command",
      rpcCode: -32001,
    });
    for (const params of [
      {},
      { sessionId: 1 },
      { sessionId: session.id, seq: 0, path: "a" },
      { sessionId: session.id, seq: 1.5, path: "a" },
      { sessionId: session.id, seq: 2 },
      { sessionId: session.id, seq: 2, path: 3 },
      { sessionId: session.id, seq: 2, path: "" },
    ])
      await expect(h.client.call("session.turnChangeDiff", params as never)).rejects.toMatchObject({
        code: "invalid_params",
        rpcCode: -32602,
      });
    await expect(h.client.call("session.turnChanges", {} as never)).rejects.toMatchObject({
      code: "invalid_params",
    });
  } finally {
    h.client.close();
    await h.served;
  }
});
