import { expect, it, vi } from "vitest";

import { openForkedSession } from "../src/fork-session";

it("forkAt 用 targetSeq 分叉，然后选中新会话并刷新", async () => {
  const forkSession = vi.fn(async () => "session-forked");
  const selectSession = vi.fn(async () => undefined);
  const id = await openForkedSession(
    {
      sessionId: "session-1",
      workspace: "C:\\ws",
      forkSession,
    },
    7,
    selectSession,
  );
  expect(id).toBe("session-forked");
  expect(forkSession).toHaveBeenCalledWith("session-1", 7);
  expect(selectSession).toHaveBeenCalledWith("session-forked", "C:\\ws");
  expect(forkSession.mock.invocationCallOrder[0]).toBeLessThan(
    selectSession.mock.invocationCallOrder[0] ?? 0,
  );
});
