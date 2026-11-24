import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryTransportPair,
  createRpcClient,
  RpcError,
  type RpcSession,
  type SessionOpened,
} from "@nocturne/rpc/client";
import type { RuntimeEvent, PendingPermission } from "@nocturne/core/protocol";
import { PhoneApp } from "../src/web/App";
import { estimateSubmitBytes, formatBytes, SUBMIT_MESSAGE_LIMIT } from "../src/web/phone-images";
import { memoryStorage } from "../src/web/storage";
import { PhonePush } from "../src/web/push";
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
  let androidBack: (() => void) | undefined;
  const submit = vi.fn(() => Promise.resolve("done"));
  const interrupt = vi.fn();
  const respondPermission = vi.fn(() => Promise.resolve());
  const session = fakeSession({
    id: "s",
    describeContext: async () => panelContext,
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
    root?.render(
      <PhoneApp
        storage={storage}
        push={push}
        platform={{
          relay: "page",
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
    await shared.connect?.(client, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
  });
  // 首页是项目列表，进入项目后才是会话列表
  const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
    row.textContent?.includes("work"),
  );
  expect(project?.textContent).toContain("work");
  await act(() => project?.click());
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.placeholder).toBe("输入消息");
  // 项目页的新会话输入框没有上下文圆环与会话菜单
  expect(container.querySelector(".phone-header-tools")).toBeNull();
  expect(container.querySelector('[aria-label^="上下文用量"]')).toBeNull();
  expect(container.querySelector('[aria-label="会话菜单"]')).toBeNull();
  const row = container.querySelector<HTMLButtonElement>(".phone-row.session");
  expect(row?.textContent).toContain("测试会话");
  await act(() => row?.click());
  // 会话页顶栏：返回、标题与项目名、会话菜单、侧边栏；观察入口集中在抽屉
  const header = container.querySelector(".phone-header");
  expect(header?.querySelector(".phone-header-project")?.textContent).toBe("work");
  expect(
    [...(header?.querySelectorAll(".phone-header-tools button") ?? [])].map((b) =>
      b.getAttribute("aria-label")?.replace(/ \d+%$/, ""),
    ),
  ).toEqual(["会话菜单", "侧边栏"]);
  expect(header?.querySelector('[aria-label^="上下文用量"]')).toBeNull();
  expect(header?.querySelector('[aria-label="后台任务"]')).toBeNull();
  expect(container.querySelector(".pi-list, .pi-item")).toBeNull();
  expect(container.querySelectorAll('[aria-label="会话菜单"]')).toHaveLength(1);
  expect(container.querySelector('.phone-composer [aria-label="更多"]')).toBeNull();
  expect(container.querySelector('.phone-composer [aria-label^="上下文用量"]')).toBeNull();
  vi.spyOn(client.runtime, "listSubagents").mockResolvedValue([]);
  const composerBeforePanel = container.querySelector("textarea");
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="侧边栏"]')?.click());
  expect(history.state.panel).toEqual({ kind: "overview" });
  expect(container.querySelector(".phone-panel-overview")).not.toBeNull();
  await act(() => container.querySelector<HTMLButtonElement>(".phone-panel-context")?.click());
  expect(history.state.panel).toEqual({ kind: "context" });
  await act(async () => {
    androidBack?.();
  });
  // 安卓返回键走 history.back()：popstate 是异步的，等面板回到总览
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-panel-overview")).not.toBeNull();
  });
  expect(history.state.kind).toBe("session");
  await act(async () => {
    androidBack?.();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-side-panel")).toBeNull();
  });
  expect(history.state.kind).toBe("session");
  expect(container.querySelector("textarea")).toBe(composerBeforePanel);
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="侧边栏"]')?.click());
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="侧边栏"]')?.click();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-side-panel")).toBeNull();
  });
  const rename = vi
    .spyOn(client.runtime, "renameSession")
    .mockRejectedValueOnce(new RpcError("session_locked", "锁冲突"));
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="会话菜单"]')?.click());
  await act(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "重命名")
      ?.click(),
  );
  const nameField = container.querySelector<HTMLInputElement>('[aria-label="会话名称"]');
  expect(nameField?.value).toBe("测试会话");
  await act(() => {
    if (nameField) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        nameField,
        "",
      );
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => {
    container
      .querySelector<HTMLFormElement>(".phone-rename-dialog")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(rename).toHaveBeenCalledWith("s", "");
  expect(container.querySelector('.phone-rename-dialog [role="alert"]')?.textContent).toBe(
    "这个会话正在别处打开，关掉后再改名",
  );
  await act(() =>
    container.querySelector<HTMLButtonElement>(".phone-rename-actions button")?.click(),
  );
  rename.mockResolvedValueOnce(undefined);
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="会话菜单"]')?.click());
  await act(() =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "重命名")
      ?.click(),
  );
  await act(() => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="会话名称"]');
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "新标题",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => {
    container
      .querySelector<HTMLFormElement>(".phone-rename-dialog")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(rename).toHaveBeenLastCalledWith("s", "新标题");
  expect(container.querySelector(".phone-rename-dialog")).toBeNull();
  // ADR-0060：右侧面板、概览按钮只在桌面窗口里，手机共用前端但不出现
  expect(container.querySelector(".side-panel")).toBeNull();
  for (const label of ["右侧面板", "会话概览", "查看变更"]) {
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.getAttribute("aria-label") === label || b.textContent === label,
      ),
    ).toBe(false);
  }
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("缺少文字输入");
  expect(field.placeholder).toBe("输入消息");
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
  await vi.waitFor(() => {
    expect(container.querySelector("textarea")).not.toBeNull();
  });
  expect(location.search).toBe("");
  // 返回时回到该会话所在的项目页
  await act(async () => {
    history.back();
  });
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-row.session")?.textContent).toContain("测试会话");
  });
  client.close();
});

it("手机对话页显示打开警告，且不出现命令行指令", async () => {
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
  vi.spyOn(client.runtime, "resumeSession").mockResolvedValue({
    session,
    opened: {
      warnings: [
        "检测到项目配置 a.json，但该工作区未信任——其中仅收紧方向的规则生效；执行 nctrn trust 信任该工作区",
      ],
    } as SessionOpened,
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
  await vi.waitFor(() => {
    expect(container.querySelector(".conversation-notice-warning")).not.toBeNull();
  });
  const text = container.querySelector(".conversation-notice-warning")?.textContent ?? "";
  expect(text).toContain("该工作区未信任");
  expect(text).toContain("请在电脑上信任该项目");
  expect(text).not.toContain("nctrn");
  client.close();
});

it("其他目录：输入路径进入项目页，后台拒绝时在输入框下显示原因；设置里进入用量", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  history.replaceState(null, "", "/");
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  vi.spyOn(client.runtime, "listSessions").mockResolvedValue([]);
  vi.spyOn(client.runtime, "listModels").mockResolvedValue([]);
  vi.spyOn(client.runtime, "listRecentModels").mockResolvedValue([]);
  vi.spyOn(client.runtime, "defaultModel").mockResolvedValue({ provider: "fake", model: "m" });
  const create = vi
    .spyOn(client.runtime, "createSession")
    .mockRejectedValue(
      new RpcError(
        "workspace_untrusted",
        "这个目录的项目配置还没有信任。手机不能代为决定，请在电脑上信任该项目，或先在电脑上新建会话",
      ),
    );
  // 统计内容的渲染由桌面用量页测试覆盖，这里只看入口与调用
  const usage = vi.spyOn(client.runtime, "usageStats").mockRejectedValue(new Error("统计暂不可用"));
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
  const byText = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(text),
    );
    if (!found) throw new Error(`缺少 ${text}`);
    return found;
  };
  await act(() => byText("其他目录").click());
  const input = container.querySelector<HTMLInputElement>(".phone-other-dir input");
  if (!input) throw new Error("缺少路径输入");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "Z:/fresh",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => byText("打开").click());
  expect(container.querySelector("h1")?.textContent).toBe("fresh");
  expect(container.textContent).toContain("0 个会话Z:/fresh");
  const field = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("缺少输入框");
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      "开始",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.click();
  });
  // 新建会话被后台拒绝：等错误条出现（请求走内存管道，纯 promise 链）
  await vi.waitFor(() => {
    expect(container.querySelector(".phone-composer-error")?.textContent).toContain(
      "请在电脑上信任该项目",
    );
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "Z:/fresh", workspaceRoot: "Z:/fresh" }),
  );
  expect(field.value).toBe("开始");

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === "用量›")?.click();
  });
  await vi.waitFor(() => {
    expect(container.querySelector("h1")?.textContent).toBe("用量");
  });
  await vi.waitFor(() => {
    expect(usage).toHaveBeenCalledWith({ days: 30 });
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain("统计暂不可用");
  });
  client.close();
});

it("执行方式消息重发带原 workMode；Runtime 写入的模式消息没有重发（ADR-0076 §1）", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const [transport] = createMemoryTransportPair();
  const client = createRpcClient(transport, { clientName: "test" });
  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  let receive: ((e: RuntimeEvent) => void) | undefined;
  const calls: string[] = [];
  const submit = vi.fn(() => {
    calls.push("submit");
    return Promise.resolve("done");
  });
  const rewind = vi.fn(() => {
    calls.push("rewind");
    return Promise.resolve([]);
  });
  const session = fakeSession({
    id: "s",
    submit,
    rewind,
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
      firstText: "模式会话",
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
  const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
    row.textContent?.includes("work"),
  );
  await act(() => project?.click());
  await act(() => container.querySelector<HTMLButtonElement>(".phone-row.session")?.click());
  let seq = 0;
  const user = async (turnId: string, text: string, source?: string) => {
    await act(() =>
      receive?.({
        sessionId: "s",
        seq: ++seq,
        time: new Date().toISOString(),
        turnId,
        type: "message.user",
        payload: {
          messageId: `m${seq}`,
          content: [
            { type: "text", text },
            { type: "text", text: '<work-mode name="plan">说明</work-mode>' },
          ],
          workMode: { name: "plan", body: "说明", ...(source ? { source } : {}) },
        },
      }),
    );
  };
  await user("t1", "加功能");
  await user("t2", "批准", "runtime");
  const [first, second] = [
    ...container.querySelectorAll<HTMLElement>('article[aria-label="用户消息"]'),
  ];
  if (!first || !second) throw new Error("缺少用户消息");
  expect(within(second).queryByRole("button", { name: "重发" })).toBeNull();
  expect(within(second).queryByRole("button", { name: "编辑并重发" })).toBeNull();
  const resend = within(first).getByRole("button", { name: "重发" });
  await act(async () => {
    resend.click();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(submit).toHaveBeenCalled());
  expect(rewind).toHaveBeenCalledWith(1, "both");
  expect(calls).toEqual(["rewind", "submit"]);
  expect(submit).toHaveBeenCalledWith({ text: "加功能", workMode: "plan" });
  client.close();
});

it("手机端编辑并重发：预载原图并粘贴新图后随提交一并发送", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let blobSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:test-${++blobSeq}`);
  URL.revokeObjectURL = vi.fn();
  try {
    const [transport] = createMemoryTransportPair();
    const client = createRpcClient(transport, { clientName: "test" });
    const storage = memoryStorage();
    await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
    await storage.identity();
    let receive: ((e: RuntimeEvent) => void) | undefined;
    const origBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const newBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4]);
    const submit = vi.fn<RpcSession["submit"]>(() => Promise.resolve("done"));
    const rewind = vi.fn(() => Promise.resolve([]));
    const readAttachment = vi.fn(async (file: string) => ({
      file,
      data: origBytes,
      mimeType: "image/png",
      bytes: origBytes.byteLength,
    }));
    const session = fakeSession({
      id: "s-img",
      submit,
      rewind,
      rewindTargets: vi.fn(async () => []),
      readAttachment,
      subscribe: (fn: typeof receive) => {
        receive = fn;
        return Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() });
      },
    });
    vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
      {
        id: "s-img",
        createdAt: new Date().toISOString(),
        model: { provider: "fake", model: "fake-1" },
        cwd: "Z:/work",
        workspaceRoot: "Z:/work",
        mtimeMs: 1,
        locked: true,
        firstText: "带图会话",
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
    const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
      row.textContent?.includes("work"),
    );
    await act(() => project?.click());
    await act(() => container.querySelector<HTMLButtonElement>(".phone-row.session")?.click());
    await act(() =>
      receive?.({
        sessionId: "s-img",
        seq: 1,
        time: new Date().toISOString(),
        turnId: "t1",
        type: "message.user",
        payload: {
          messageId: "m1",
          content: [{ type: "text", text: "看原图" }],
          attachments: [
            {
              type: "image",
              file: "img-1.png",
              mimeType: "image/png",
              bytes: origBytes.byteLength,
              sha256: "orig-sha",
              label: "orig.png",
              source: "paste",
            },
          ],
        },
      }),
    );

    const editBtn = within(container).getByRole("button", { name: "编辑并重发" });
    await act(async () => {
      editBtn.click();
      await Promise.resolve();
    });
    const box = await within(container).findByLabelText<HTMLTextAreaElement>("编辑消息");
    const editBox = box.closest(".u-edit") as HTMLElement;
    expect(within(editBox).getByRole("button", { name: "移除 orig.png" })).toBeTruthy();

    // 通过隐藏 file input 选一张新图
    const fileInput = editBox.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("缺少隐藏文件输入");
    const addedFile = new File([newBytes], "added.jpg", { type: "image/jpeg" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [addedFile] } });
      await Promise.resolve();
    });
    await within(editBox).findByRole("button", { name: "移除 added.jpg" });

    await act(async () => {
      within(editBox).getByRole("button", { name: "发送" }).click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(rewind).toHaveBeenCalledWith(1, "both");
    const sent = submit.mock.calls[0]?.[0];
    expect(sent?.text).toBe("看原图");
    expect(sent?.attachments?.map((a) => [a.label, a.mimeType])).toEqual([
      ["orig.png", "image/png"],
      ["added.jpg", "image/jpeg"],
    ]);
    client.close();
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});

it("手机端编辑并重发：附件超过远程单条上限时显示输入框原句且不触发 rewind", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  let blobSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:test-${++blobSeq}`);
  URL.revokeObjectURL = vi.fn();
  try {
    const [transport] = createMemoryTransportPair();
    const client = createRpcClient(transport, { clientName: "test" });
    const storage = memoryStorage();
    await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
    await storage.identity();
    let receive: ((e: RuntimeEvent) => void) | undefined;
    const chunkBytes = Math.floor((SUBMIT_MESSAGE_LIMIT / 3) * 0.8);
    const origBytes = new Uint8Array(chunkBytes);
    origBytes.set([0x89, 0x50, 0x4e, 0x47]);
    const addedBytes = new Uint8Array(chunkBytes);
    addedBytes.set([0xff, 0xd8, 0xff, 0xe0]);
    const submit = vi.fn<RpcSession["submit"]>(() => Promise.resolve("done"));
    const rewind = vi.fn(() => Promise.resolve([]));
    const readAttachment = vi.fn(async (file: string) => ({
      file,
      data: origBytes,
      mimeType: "image/png",
      bytes: origBytes.byteLength,
    }));
    const session = fakeSession({
      id: "s-oversize",
      submit,
      rewind,
      rewindTargets: vi.fn(async () => []),
      readAttachment,
      subscribe: (fn: typeof receive) => {
        receive = fn;
        return Promise.resolve({ lastSeq: 0, unsubscribe: vi.fn() });
      },
    });
    vi.spyOn(client.runtime, "listSessions").mockResolvedValue([
      {
        id: "s-oversize",
        createdAt: new Date().toISOString(),
        model: { provider: "fake", model: "fake-1" },
        cwd: "Z:/work",
        workspaceRoot: "Z:/work",
        mtimeMs: 1,
        locked: true,
        firstText: "超限带图会话",
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
    const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
      row.textContent?.includes("work"),
    );
    await act(() => project?.click());
    await act(() => container.querySelector<HTMLButtonElement>(".phone-row.session")?.click());
    await act(() =>
      receive?.({
        sessionId: "s-oversize",
        seq: 1,
        time: new Date().toISOString(),
        turnId: "t1",
        type: "message.user",
        payload: {
          messageId: "m1",
          content: [{ type: "text", text: "看原图" }],
          attachments: [
            {
              type: "image",
              file: "img-1.png",
              mimeType: "image/png",
              bytes: origBytes.byteLength,
              sha256: "orig-oversize-sha",
              label: "orig.png",
              source: "paste",
            },
          ],
        },
      }),
    );

    const editBtn = within(container).getByRole("button", { name: "编辑并重发" });
    await act(async () => {
      editBtn.click();
      await Promise.resolve();
    });
    const box = await within(container).findByLabelText<HTMLTextAreaElement>("编辑消息");
    const editBox = box.closest(".u-edit") as HTMLElement;
    await within(editBox).findByRole("button", { name: "移除 orig.png" });

    const fileInput = editBox.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("缺少隐藏文件输入");
    const added1 = new File([addedBytes], "added-1.jpg", { type: "image/jpeg" });
    const added2 = new File([addedBytes], "added-2.jpg", { type: "image/jpeg" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [added1, added2] } });
      await Promise.resolve();
    });
    await within(editBox).findByRole("button", { name: "移除 added-2.jpg" });

    await act(async () => {
      within(editBox).getByRole("button", { name: "发送" }).click();
      await Promise.resolve();
    });

    const expectedBytes = estimateSubmitBytes("看原图", [
      { data: origBytes, label: "orig.png" },
      { data: addedBytes, label: "added-1.jpg" },
      { data: addedBytes, label: "added-2.jpg" },
    ]);
    const expectedSentence = `这条消息约 ${formatBytes(expectedBytes)}，超过远程连接单条上限 ${formatBytes(SUBMIT_MESSAGE_LIMIT)}，不会发送。请减少图片。`;
    await vi.waitFor(() => {
      expect(editBox.textContent).toContain(expectedSentence);
    });
    expect(rewind).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    client.close();
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
});
