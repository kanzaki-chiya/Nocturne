import { expect, it, vi } from "vitest";

import type { RewindTarget } from "@nocturne/core/protocol";
import { forkDraftText, openForkedSession } from "../src/fork-session";

const target = (seq: number, text: string): RewindTarget => ({
  seq,
  firstLine: text,
  time: "2026-11-02T00:00:00Z",
  text,
  hasImages: false,
  files: [],
  untrackedCalls: 0,
});

it("forkAt 先取原消息再分叉，交出草稿后选中新会话", async () => {
  const forkSession = vi.fn(async () => "session-forked");
  const selectSession = vi.fn(async () => undefined);
  const onDraft = vi.fn();
  const id = await openForkedSession(
    {
      sessionId: "session-1",
      workspace: "C:\\ws",
      forkSession,
      rewindTargets: async () => [target(3, "别的"), target(7, "/plan 拆分模块")],
    },
    7,
    selectSession,
    onDraft,
  );
  expect(id).toBe("session-forked");
  expect(forkSession).toHaveBeenCalledWith("session-1", 7);
  expect(onDraft).toHaveBeenCalledWith("session-forked", "/plan 拆分模块");
  expect(selectSession).toHaveBeenCalledWith("session-forked", "C:\\ws");
  expect(onDraft.mock.invocationCallOrder[0]).toBeLessThan(
    selectSession.mock.invocationCallOrder[0] ?? 0,
  );
});

it("Runtime 消息（text 为空）或读不到回退目标时不交草稿，分叉照常", async () => {
  expect(await forkDraftText({ rewindTargets: async () => [target(2, "")] }, 2)).toBe("");
  expect(
    await forkDraftText(
      {
        rewindTargets: () => Promise.reject(new Error("断开")),
      },
      2,
    ),
  ).toBe("");
  const onDraft = vi.fn();
  await openForkedSession(
    {
      sessionId: "s",
      workspace: "w",
      forkSession: async () => "f",
      rewindTargets: async () => [target(2, "")],
    },
    2,
    async () => undefined,
    onDraft,
  );
  expect(onDraft).not.toHaveBeenCalled();
});
