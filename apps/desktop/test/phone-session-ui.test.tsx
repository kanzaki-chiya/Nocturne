import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryTransportPair,
  createRpcClient,
  RpcError,
  type RpcSession,
} from "@nocturne/rpc/client";
import type { RuntimeEvent, PendingPermission } from "@nocturne/core/protocol";
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
let root: Root | undefined;
/** 只实现用例关心的方法；其余会话方法一律失败，界面应当静默降级 */
const fakeSession = (methods: Record<string, unknown>): RpcSession =>
  new Proxy(methods, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key in target) return target[key];
      return () => Promise.reject(new Error(`未实现 ${key}`));
    },
  }) as unknown as RpcSession;
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("会话徽标、只提交 text、中断、另一端结算关闭面板、重复回复静默关闭", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  let receive: ((e: RuntimeEvent) => void) | undefined;
  const submit = vi.fn(() => Promise.resolve("done"));
  const interrupt = vi.fn();
  const respondPermission = vi.fn(() => Promise.resolve());
  const session = fakeSession({
    id: "s",
    submit,
    interrupt,
    respondPermission,
    subscribe: (fn: typeof receive) => {
      receive = fn;
      return Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() });
    },
  });
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
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({ session, opened: {} } as Awaited<
    ReturnType<typeof client.runtime.resumeSession>
  >);
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
  // 首页是项目列表，进入项目后才是会话列表
  const project = container.querySelector<HTMLButtonElement>(".phone-row");
  expect(project?.textContent).toContain("work");
  await act(() => project?.click());
  const row = container.querySelector<HTMLButtonElement>(".phone-row.session");
  expect(row?.textContent).toContain("测试会话");
  await act(() => row?.click());
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("缺少文字输入");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      "只发文字",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = (label: string) => {
    const b = [...container.querySelectorAll("button")].find(
      (e) => e.textContent === label || e.getAttribute("aria-label") === label,
    );
    if (!b) throw new Error(`缺少 ${label}`);
    b.click();
  };
  await act(async () => {
    click("发送");
    await Promise.resolve();
  });
  expect(submit).toHaveBeenCalledWith({ text: "只发文字" });
  let seq = 0;
  const emit = async (event: RuntimeEvent) => {
    await act(() => receive?.(event));
  };
  const envelope = () => ({
    sessionId: "s",
    seq: ++seq,
    time: new Date().toISOString(),
    turnId: "t",
  });
  await emit({ ...envelope(), type: "turn.started", payload: { turnIndex: 1 } });
  await act(() => click("中断"));
  expect(interrupt).toHaveBeenCalledOnce();
  const permission: PendingPermission = {
    toolName: "write",
    requestId: "p",
    callId: "c",
    subjects: [
      { kind: "edit", target: "test.ts", resolved: "Z:/work/test.ts", where: "workspace" },
    ],
    reason: "确认修改",
    options: ["allow_once", "allow_session", "allow_project", "deny"],
  };
  await emit({ ...envelope(), type: "permission.requested", payload: permission });
  expect(container.querySelector(".phone-sheet")).not.toBeNull();
  expect(container.textContent).not.toContain("本项目允许");
  await emit({
    ...envelope(),
    type: "permission.resolved",
    payload: {
      requestId: "p",
      callId: "c",
      action: "allow",
      source: "user",
      remember: "session",
    },
  });
  expect(container.querySelector(".phone-sheet")).toBeNull();
  await emit({
    ...envelope(),
    type: "permission.requested",
    payload: { ...permission, requestId: "p2" },
  });
  respondPermission.mockRejectedValueOnce(new RpcError("unknown_request", "另一端已回复"));
  await act(async () => {
    click("本会话允许");
    await Promise.resolve();
  });
  expect(container.querySelector(".phone-sheet")).toBeNull();
  expect(container.textContent).not.toContain("另一端已回复");
  client.close();
});

it("从推送点进来连上后直接进入会话", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  history.replaceState(null, "", "/?attention");
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  const session = fakeSession({
    id: "s",
    subscribe: () => Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() }),
  });
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
    {
      id: "s",
      createdAt: new Date().toISOString(),
      model: { provider: "fake", model: "fake-1" },
      cwd: "Z:/work",
      workspaceRoot: "Z:/work",
      mtimeMs: 1,
      firstText: "测试会话",
    },
  ]);
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({ session, opened: {} } as Awaited<
    ReturnType<typeof client.runtime.resumeSession>
  >);
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
  await vi.waitFor(() => {
    expect(container.querySelector("textarea")).not.toBeNull();
  });
  expect(location.search).toBe("");
  // 返回时回到该会话所在的项目页
  await act(async () => {
    history.back();
    await new Promise((done) => setTimeout(done, 20));
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-row.session")?.textContent).toContain("测试会话");
  });
  client.close();
});
