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
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { panelContext } from "./phone-panel-fixtures";

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

it("手机 Swarm 全屏页与成员会话页：入口进入、返回导航、私信与权限确认、退出只 close 不 interrupt、结束后只读", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({
    hostId: "host",
    hostPub: "pub",
    name: "电脑 1",
    pairedAt: 1,
    origin: "https://relay.example",
  });
  await storage.identity();

  let coordReceive: ((e: RuntimeEvent) => void) | undefined;
  let memberReceive: ((e: RuntimeEvent) => void) | undefined;
  let androidBack: (() => void) | undefined;

  const postToSwarm = vi.fn(async () => ({ number: 2, recipients: ["coordinator"] }));
  const endSwarm = vi.fn(async () => ({ unmerged: [] }));
  const coordClose = vi.fn(async () => undefined);
  const coordSession = fakeSession({
    id: "coord",
    describeContext: async () => panelContext,
    describeSkills: async () => ({ skills: [] }),
    describeExternalAgents: async () => ({ agents: [] }),
    shellInfo: async () => ({}),
    visionInfo: async () => ({ imageInput: false, available: true, model: "fake-1" }),
    pendingInputs: async () => ({ items: [], paused: false }),
    turnChanges: async () => [],
    postToSwarm,
    endSwarm,
    close: coordClose,
    subscribe: async (fn: typeof coordReceive) => {
      coordReceive = fn;
      fn?.({
        type: "message.user",
        sessionId: "coord",
        seq: 1,
        turnId: "t1",
        time: "2026-11-12T13:30:00.000Z",
        payload: {
          messageId: "m1",
          content: [{ type: "text", text: "/swarm 加输入校验" }],
        },
      } as RuntimeEvent);
      fn?.({
        type: "swarm.created",
        sessionId: "coord",
        seq: 2,
        time: "2026-11-12T13:30:01.000Z",
        payload: { title: "API 输入校验" },
      } as RuntimeEvent);
      fn?.({
        type: "swarm.member_added",
        sessionId: "coord",
        seq: 3,
        time: "2026-11-12T13:30:02.000Z",
        payload: {
          name: "orders",
          childSessionId: "child-orders",
          charter: {
            owns: "src/routes/orders.ts",
            handsOff: "其他路由",
            doneWhen: "orders 测试全过",
          },
          model: { provider: "fake", model: "fake-1" },
          preset: "general",
          isolated: false,
        },
      } as RuntimeEvent);
      fn?.({
        type: "swarm.posted",
        sessionId: "coord",
        seq: 4,
        time: "2026-11-12T13:31:00.000Z",
        payload: {
          number: 1,
          from: "coordinator",
          fromKind: "coordinator",
          text: "@orders 开始实现",
          mentions: ["orders"],
          recipients: ["orders"],
        },
      } as RuntimeEvent);
      return { lastSeq: 4, unsubscribe: vi.fn(async () => undefined) };
    },
  });

  const memberSubmit = vi.fn(async () => "done");
  const memberInterrupt = vi.fn();
  const memberRespondPermission = vi.fn(async () => undefined);
  const memberClose = vi.fn(async () => undefined);
  const memberSession = fakeSession({
    id: "child-orders",
    describeContext: async () => panelContext,
    describeSkills: async () => ({ skills: [] }),
    describeExternalAgents: async () => ({ agents: [] }),
    shellInfo: async () => ({}),
    visionInfo: async () => ({ imageInput: false, available: true, model: "fake-1" }),
    pendingInputs: async () => ({ items: [], paused: false }),
    turnChanges: async () => [],
    submit: memberSubmit,
    interrupt: memberInterrupt,
    respondPermission: memberRespondPermission,
    recordInputHistory: async () => undefined,
    close: memberClose,
    subscribe: async (fn: typeof memberReceive) => {
      memberReceive = fn;
      fn?.({
        type: "permission.requested",
        sessionId: "child-orders",
        seq: 1,
        turnId: "t-orders-1",
        time: "2026-11-12T13:32:00.000Z",
        payload: {
          requestId: "perm-1",
          callId: "c1",
          reason: "执行测试",
          subjects: [{ kind: "shell", target: "pnpm test" }],
          options: ["allow_once", "deny"],
        },
      } as RuntimeEvent);
      return { lastSeq: 0, unsubscribe: vi.fn(async () => undefined) };
    },
  });

  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
    {
      id: "coord",
      createdAt: "2026-11-12T13:30:00.000Z",
      model: { provider: "fake", model: "fake-1" },
      cwd: "Z:/work",
      workspaceRoot: "Z:/work",
      mtimeMs: 1,
      locked: false,
      firstText: "API 输入校验",
    },
  ]);
  vi.spyOn(client.runtime, "resumeSession").mockImplementation(async (id) => {
    if (id === "coord") {
      return {
        session: coordSession,
        opened: {
          sessionId: "coord",
          meta: { cwd: "Z:/work", workspaceRoot: "Z:/work" },
          warnings: [],
        } as unknown as SessionOpened,
      };
    }
    throw new Error(`unexpected resumeSession: ${id}`);
  });
  vi.spyOn(client, "call").mockImplementation(async (method, params) => {
    if (method === "session.open") {
      const { sessionId } = params as { sessionId: string };
      expect(sessionId).toBe("child-orders");
      return {
        sessionId: "child-orders",
        meta: { cwd: "Z:/work", workspaceRoot: "Z:/work" },
        warnings: [],
      } as never;
    }
    throw new Error(`unexpected call: ${method}`);
  });
  vi.spyOn(client, "session").mockImplementation((id) => {
    if (id === "child-orders") return memberSession;
    return coordSession;
  });

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <PhoneApp
        storage={storage}
        platform={{
          relay: "link",
          onAndroidBack: (handler) => {
            androidBack = handler;
            return () => {
              androidBack = undefined;
            };
          },
        }}
      />,
    );
  });
  await act(async () => {
    await shared.connect?.(client, undefined);
  });

  // 进项目页 → 打开协调者会话
  await act(async () => {
    const projectBtn = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((b) =>
      b.textContent?.includes("work"),
    );
    projectBtn?.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".phone-row")?.click();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".swarmrow")).not.toBeNull();
  });
  expect(container.querySelector(".swarmrow")?.textContent).toContain("API 输入校验");
  expect(container.querySelector(".swarmrow")?.textContent).toContain("1 · 1");

  // 点入口行推入全屏 Swarm 页
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".swarmrow")?.click();
  });
  expect(container.querySelector(".phone-header h1")?.textContent).toBe("API 输入校验");
  expect(container.querySelector(".swarm-pane")).not.toBeNull();

  // 切到成员页，点 orders 进入成员会话页
  const memberTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent === "成员",
  );
  await act(async () => {
    memberTab?.click();
  });
  const memberBtn = [...container.querySelectorAll<HTMLButtonElement>(".swarm-mem-main")].find(
    (b) => b.querySelector(".swarm-mem-name")?.firstChild?.textContent === "orders",
  );
  expect(memberBtn).toBeDefined();
  await act(async () => {
    memberBtn?.click();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-header h1")?.textContent).toBe("@orders");
    expect(container.querySelector('[aria-label="权限面板"]')).not.toBeNull();
  });

  // 确认成员权限
  const allowBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "允许一次",
  );
  await act(async () => {
    allowBtn?.click();
  });
  expect(memberRespondPermission).toHaveBeenCalledOnce();

  // 安卓返回键退回 Swarm 页，只调 session.close，不调 interrupt
  await act(async () => {
    androidBack?.();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-header h1")?.textContent).toBe("API 输入校验");
  });
  await vi.waitFor(() => {
    expect(memberClose).toHaveBeenCalledOnce();
  });
  expect(memberInterrupt).not.toHaveBeenCalled();

  // Swarm 结束后再进入成员页：只读展示，没有输入框
  await act(async () => {
    coordReceive?.({
      type: "swarm.ended",
      sessionId: "coord",
      seq: 5,
      time: "2026-11-12T13:40:00.000Z",
      payload: { reason: "user" },
    } as RuntimeEvent);
  });
  const memberTabAgain = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (b) => b.textContent === "成员",
  );
  await act(async () => {
    memberTabAgain?.click();
  });
  const memberBtnAgain = [...container.querySelectorAll<HTMLButtonElement>(".swarm-mem-main")].find(
    (b) => b.querySelector(".swarm-mem-name")?.firstChild?.textContent === "orders",
  );
  await act(async () => {
    memberBtnAgain?.click();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-header h1")?.textContent).toBe("@orders");
  });
  expect(container.querySelector(".phone-composer")).toBeNull();

  // 连续两次返回：Swarm 成员页 → Swarm 页 → 协调者会话页
  await act(async () => {
    androidBack?.();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".swarm-pane")).not.toBeNull();
  });
  await act(async () => {
    androidBack?.();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".swarmrow")).not.toBeNull();
  });

  client.close();
});
