import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionView, type SessionView } from "@nocturne/core/protocol";
import type { RpcSession, RpcRuntime } from "@nocturne/rpc/client";
import { useSessionControls } from "../src/session-controls";

afterEach(cleanup);

it("控件回放结束只刷新一组，实时请求在飞时只补拉一组，旧会话不写新界面", async () => {
  // 回放期间 state/effort/shell/models/recents 都不发；实时变化只补一组。
  const waiting: ((value: unknown) => void)[] = [];
  const state = vi.fn(() => new Promise((resolve) => waiting.push(resolve)));
  const effort = vi.fn(async () => ({ available: [], current: "off", effective: "off" }));
  const shell = vi.fn(async () => ({}));
  const session = { state, reasoningEffortInfo: effort, shellInfo: shell } as unknown as RpcSession;
  const models = vi.fn(async () => []),
    recents = vi.fn(async () => []);
  const runtime = { listModels: models, listRecentModels: recents } as unknown as RpcRuntime;
  const view = createSessionView();
  const hook = renderHook(
    ({ replaying, s }) => useSessionControls(s, runtime, view, undefined, 0, undefined, replaying),
    { initialProps: { replaying: true, s: session } },
  );
  for (let i = 0; i < 4; i++) {
    view.entries.push({} as SessionView["entries"][number]);
    hook.rerender({ replaying: true, s: session });
  }
  expect(state).not.toHaveBeenCalled();
  expect(models).not.toHaveBeenCalled();
  hook.rerender({ replaying: false, s: session });
  expect(state).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 4; i++) {
    view.entries.push({} as SessionView["entries"][number]);
    hook.rerender({ replaying: false, s: session });
  }
  expect(state).toHaveBeenCalledTimes(1);
  await act(async () => waiting.shift()?.({ config: { model: { provider: "p", model: "old" } } }));
  expect(state).toHaveBeenCalledTimes(2);
  expect(models).toHaveBeenCalledTimes(2);
  expect(effort).toHaveBeenCalledTimes(2);
  expect(shell).toHaveBeenCalledTimes(2);
  expect(recents).toHaveBeenCalledTimes(2);
  const next = {
    ...session,
    state: vi.fn(async () => ({ config: { model: { provider: "p", model: "new" } } })),
  } as unknown as RpcSession;
  await act(async () => hook.rerender({ replaying: false, s: next }));
  await act(async () => waiting.shift()?.({ config: { model: { provider: "p", model: "old" } } }));
  expect(hook.result.current.controls.model?.value).toBe("p/new");
});
