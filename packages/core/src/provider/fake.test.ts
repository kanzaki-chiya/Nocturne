import { expect, it } from "vitest";
import { FakeProvider } from "./fake.js";
import type { ModelRequest } from "./types.js";

it("waitState 是只读快照，记录等待和收到的中断，不改变 wait 行为", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider = new FakeProvider({
    handler: () => {
      started();
      return [{ type: "wait" }];
    },
  });
  const controller = new AbortController();
  const stream = provider
    .stream({ model: "fake-1", messages: [] } as unknown as ModelRequest, controller.signal)
    [Symbol.asyncIterator]();
  const pending = stream.next();
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await entered;
  await Promise.resolve();
  const snapshot = provider.waitState;
  expect(snapshot).toEqual({ waiting: 1, aborts: 0 });
  controller.abort();
  await rejection;
  expect(provider.waitState).toEqual({ waiting: 0, aborts: 1 });
  expect(snapshot).toEqual({ waiting: 1, aborts: 0 });
});
