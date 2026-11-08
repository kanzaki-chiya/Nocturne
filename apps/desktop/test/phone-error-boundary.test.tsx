import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { PhonePush } from "../src/web/push";

const shared = vi.hoisted(() => ({
  connect: undefined as ((client: unknown, relay: unknown) => Promise<void>) | undefined,
}));
vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "online";
    message = "";
    constructor(options: { connected: typeof shared.connect }) {
      shared.connect = options.connected;
    }
    start = vi.fn();
    stop = vi.fn();
    visibility = vi.fn();
  },
}));
vi.mock("../src/web/SessionScreen", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  SessionScreen: () => {
    throw new Error("渲染炸了");
  },
}));

let root: Root | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("会话页渲染抛错时保留顶栏，显示错误，返回后恢复", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  const session = new Proxy(
    {
      id: "s",
      subscribe: () => Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() }),
    } as Record<string, unknown>,
    {
      get: (target, key) => {
        if (typeof key === "symbol" || key === "then") return undefined;
        if (key in target) return target[key];
        return () => Promise.reject(new Error(`未实现 ${key}`));
      },
    },
  ) as unknown as RpcSession;
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
    {
      id: "s",
      createdAt: new Date().toISOString(),
      model: { provider: "fake", model: "fake-1" },
      cwd: "Z:/work",
      workspaceRoot: "Z:/work",
      mtimeMs: 1,
      locked: true,
      firstText: "测试会话",
    },
  ]);
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<typeof client.runtime.resumeSession>>);
  const push = new PhonePush({
    registration: () => Promise.reject(new Error("unsupported")),
    permission: () => "default",
    requestPermission: vi.fn(),
    info: vi.fn(),
    changed: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} push={push} />);
  });
  await act(async () => {
    await shared.connect?.(client, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
  });
  await act(() =>
    [...container.querySelectorAll<HTMLButtonElement>(".phone-row")]
      .find((row) => row.textContent?.includes("work"))
      ?.click(),
  );
  await act(() => container.querySelector<HTMLButtonElement>(".phone-row.session")?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("渲染炸了");
  const back = container.querySelector<HTMLButtonElement>('[aria-label="返回"]');
  expect(back).not.toBeNull();
  await act(async () => {
    back?.click();
    await new Promise((done) => setTimeout(done, 50));
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector(".phone-row.session")?.textContent).toContain("测试会话");
});
