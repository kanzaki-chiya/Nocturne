import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionView } from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";
import { createAttachmentImageSource } from "../src/attachment-images";
import { emptyOutgoing } from "../src/outgoing";
import { PhoneSessions } from "../src/web/sessions";
import { SessionScreen } from "../src/web/SessionScreen";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

it("手机会话点发送后立即清空并显示本地消息，拒收后放回草稿", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let release!: (error?: Error) => void;
  const submit = vi.fn(
    () =>
      new Promise<string>((resolve, reject) => {
        release = (error) => (error ? reject(error) : resolve("done"));
      }),
  );
  const session = new Proxy(
    { id: "s", submit },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        if (key === "then") return undefined;
        return () => Promise.resolve([]);
      },
    },
  ) as unknown as RpcSession;
  const runtime = new Proxy(
    {},
    {
      get: () => () => Promise.resolve([]),
    },
  );
  const client = {
    runtime,
    onEvent: () => () => undefined,
    onNotification: () => () => undefined,
  } as unknown as RpcClient;
  const sessions = new PhoneSessions(vi.fn());
  const entry = {
    session,
    client,
    workspace: "Z:/work",
    view: createSessionView(),
    warnings: [],
    dead: false,
    listeners: new Set<() => void>(),
    turnChanges: new Map(),
    changeDiffs: new Map(),
    pendingInputs: { items: [], paused: false },
    outgoing: emptyOutgoing(),
    busy: false,
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <SessionScreen
        entry={entry}
        connected
        images={createAttachmentImageSource()}
        openUrl={() => undefined}
        onError={() => undefined}
        onChanged={() => undefined}
        sessions={sessions}
        onForked={() => undefined}
        plain
      />,
    );
  });
  const field = document.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("没有输入框");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(field, "马上发出");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = document.querySelector('button[aria-label="发送"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error("没有发送按钮");
  await act(async () => {
    send.click();
  });
  expect(field.value).toBe("");
  expect(host.textContent).toContain("马上发出");
  expect(entry.outgoing.items).toHaveLength(1);
  await act(async () => {
    release(new Error("图片损坏"));
    await Promise.resolve();
  });
  expect(entry.outgoing.items).toHaveLength(0);
  expect(field.value).toBe("马上发出");
  expect(host.textContent).toContain("图片损坏");
});
