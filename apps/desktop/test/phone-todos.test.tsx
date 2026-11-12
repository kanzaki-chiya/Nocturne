import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryTransportPair,
  createRpcClient,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import type { GoalConfig, RuntimeEvent, TodoItem } from "@nocturne/core/protocol";
import { PhoneApp } from "../src/web/App";
import { memoryStorage } from "../src/web/storage";
import { TodoPanel } from "../src/TodoList";
import { PREFS_KEY, type PrefsStore } from "../src/prefs";

const TODOS_KEY = "nocturne.phone.todosCollapsed";
const shared = vi.hoisted(() => ({
  connect: undefined as ((client: unknown, relay: unknown) => Promise<void>) | undefined,
}));
vi.mock("../src/web/connection", () => ({
  PhoneConnection: class {
    state = "online";
    message = "";
    sessionsDir = "Z:/work/sessions";
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

const items: TodoItem[] = [
  { text: "梳理电脑端任务清单面板", status: "completed" },
  { text: "手机会话页接入共享面板", status: "in_progress" },
  { text: "补上展开收起动效", status: "pending" },
  { text: "验证软键盘布局", status: "pending" },
  ...Array.from({ length: 4 }, (_, index) => ({
    text: `剩余事项 ${index + 1}`,
    status: "pending" as const,
  })),
];

/** 真实 PhoneApp + 会话页，清单经持久事件进入共享 SessionView.todos */
async function mountPhone() {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  history.replaceState(null, "", "/");
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  let receive: ((event: RuntimeEvent) => void) | undefined;
  const session = fakeSession({
    id: "s",
    subscribe: (fn: typeof receive) => {
      receive = fn;
      return Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() });
    },
    pendingInputs: async () => ({ items: [], paused: false }),
    describeSkills: async () => ({ skills: [] }),
    describeExternalAgents: async () => ({ agents: [] }),
    listGrants: async () => [],
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
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: { warnings: [] as string[] } as SessionOpened,
  } as Awaited<ReturnType<typeof client.runtime.resumeSession>>);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PhoneApp storage={storage} />);
  });
  await act(async () => {
    await shared.connect?.(client, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
  });
  let seq = 0;
  const emit = async (type: RuntimeEvent["type"], payload: unknown) => {
    await act(() =>
      receive?.({
        sessionId: "s",
        seq: ++seq,
        time: new Date().toISOString(),
        turnId: "t",
        type,
        payload,
      } as RuntimeEvent),
    );
  };
  const openSession = async () => {
    const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
      row.textContent?.includes("work"),
    );
    await act(() => project?.click());
    await act(() => container.querySelector<HTMLButtonElement>(".phone-row.session")?.click());
  };
  const todos = async (list: readonly TodoItem[]) => {
    await emit("tool.completed", {
      callId: "todo",
      name: "todo_write",
      status: "ok",
      modelContent: "",
      output: { items: list },
    });
  };
  return { container, client, emit, openSession, todos };
}

afterEach(async () => {
  await act(() => root?.unmount());
  root = undefined;
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("手机会话页有清单时渲染面板且默认收起，点开关条展开再收起", async () => {
  const { container, openSession, todos } = await mountPhone();
  // 项目页是新会话草稿，不显示清单
  expect(container.querySelector(".todo-panel")).toBeNull();
  await openSession();
  expect(container.querySelector(".todo-panel")).toBeNull();
  await todos(items);
  const panel = container.querySelector(".todo-panel");
  expect(panel).not.toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>(".todo-panel-toggle");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("region", { name: "当前任务清单" })).toBeTruthy();
  expect(toggle?.textContent).toContain("1/8");
  expect(toggle?.textContent).toContain("正在：手机会话页接入共享面板");
  expect(panel?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax")).toBe("8");
  const body = panel?.querySelector<HTMLElement>(".todo-panel-body");
  expect(body?.getAttribute("data-expanded")).toBe("false");
  expect(body?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("list", { name: "任务清单列表" })).toBeNull();
  await act(() => toggle?.click());
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(body?.getAttribute("data-expanded")).toBe("true");
  expect(screen.getByRole("list", { name: "任务清单列表" })).toBeTruthy();
  expect(localStorage.getItem(TODOS_KEY)).toBe("false");
  await act(() => toggle?.click());
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list", { name: "任务清单列表" })).toBeNull();
  expect(localStorage.getItem(TODOS_KEY)).toBe("true");
  expect(localStorage.getItem(PREFS_KEY)).toBeNull();
});

it("草稿与空清单不渲染；全部完成后下一条用户消息按共享视图归档", async () => {
  const { container, openSession, todos, emit } = await mountPhone();
  await openSession();
  await todos([]);
  expect(container.querySelector(".todo-panel")).toBeNull();
  await todos(items.map((item) => ({ ...item, status: "completed" as const })));
  expect(container.querySelector(".todo-panel")).not.toBeNull();
  await emit("message.user", {
    messageId: "m",
    content: [{ type: "text", text: "继续" }],
  });
  expect(container.querySelector(".todo-panel")).toBeNull();
});

it("有目标行时目标在上、清单在下，点进度条收起目标全文并显示清单", async () => {
  const { container, openSession, todos, emit } = await mountPhone();
  await openSession();
  const goal: GoalConfig = { objective: "把任务清单接到手机会话页", status: "active" };
  await emit("session.config_changed", { goal });
  await todos(items);
  const panel = container.querySelector(".todo-panel");
  expect(panel?.firstElementChild?.className).toContain("goal-row");
  expect(panel?.querySelector(".todo-panel-toggle")).toBeTruthy();
  expect(panel?.querySelector(".goal-row")?.nextElementSibling?.className).toContain(
    "todo-panel-body",
  );
  if (!panel) throw new Error("缺少任务清单面板");
  const expand = panel.querySelector<HTMLButtonElement>('[aria-label="展开"]');
  if (!expand) throw new Error("缺少目标行展开按钮");
  fireEvent.click(expand);
  expect(screen.getByText(goal.objective).closest(".goal-detail")).toBeTruthy();
  const toggle = panel.querySelector<HTMLButtonElement>(".todo-panel-toggle");
  if (!toggle) throw new Error("缺少清单开关条");
  fireEvent.click(toggle);
  expect(panel.querySelector('[aria-label="收起"]')).toBeNull();
  expect(screen.getByRole("list", { name: "任务清单列表" })).toBeTruthy();
  expect(localStorage.getItem(TODOS_KEY)).toBe("false");
  expect(localStorage.getItem(PREFS_KEY)).toBeNull();
});

it("mobile 受控折叠不读写桌面 prefs 的 todosCollapsed", () => {
  const prefs = {
    get: () => ({ todosCollapsed: false }),
    update: vi.fn(),
  } as unknown as PrefsStore;
  const onChange = vi.fn();
  render(
    <div className="phone">
      <TodoPanel items={items} prefs={prefs} mobile={{ collapsed: true, onChange }} />
    </div>,
  );
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button"));
  expect(onChange).toHaveBeenCalledWith(false);
  expect(prefs.update).not.toHaveBeenCalled();
});
