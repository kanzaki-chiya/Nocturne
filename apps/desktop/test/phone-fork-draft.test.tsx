/**
 * 手机分叉后填回原消息：真实 RPC 服务端 + Core（预先写好会话日志），在手机界面点「分叉」，
 * 新会话输入框填好原消息、光标在末尾、不自动发送、不出「已回退到…」提示；切走再回来不再填。
 */
import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createPlatform, createRuntime, FakeProvider, loadConfig } from "@nocturne/core";
import type { RuntimeSession } from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { PhoneApp } from "../src/web/App";
import { PhonePush } from "../src/web/push";
import { memoryStorage } from "../src/web/storage";

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

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  shared.connect = undefined;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emit(session: RuntimeSession, type: string, payload: unknown): Promise<unknown> {
  const inner = (
    session as unknown as Record<
      symbol,
      { emit: (t: string, p: unknown) => Promise<unknown> } | undefined
    >
  )[Symbol.for("nocturne.core.internalSession")];
  if (inner === undefined) throw new Error("不是由 createRuntime 创建的会话");
  return inner.emit(type, payload);
}

async function setup() {
  const ws = temp("phone-fork-ws-");
  const sessionsDir = temp("phone-fork-sessions-");
  const home = temp("phone-fork-home-");
  const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
  const runtime = await createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [new FakeProvider({})],
    interactive: true,
    config,
  });
  const seeded = await runtime.createSession({ model: "fake/fake-1" });
  await emit(seeded, "message.user", {
    messageId: "plain",
    content: [{ type: "text", text: "第一条普通消息" }],
  });
  await emit(seeded, "message.user", {
    messageId: "goal",
    content: [
      { type: "text", text: "拆分模块" },
      { type: "text", text: "计划说明块" },
    ],
    workMode: { name: "plan", body: "计划说明块" },
  });
  await emit(seeded, "message.user", {
    messageId: "check",
    content: [{ type: "text", text: "核对说明块" }],
    workMode: { name: "goal", body: "核对说明块", source: "runtime" },
  });
  await seeded.close();

  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: async () => ({ runtime, sessionsDir }),
  });
  void server.serve(serverEnd);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const send = clientEnd.send.bind(clientEnd);
  clientEnd.send = (line: string) => {
    const parsed = JSON.parse(line) as { method?: unknown; params?: unknown };
    if (typeof parsed.method === "string")
      calls.push({
        method: parsed.method,
        params: (parsed.params ?? {}) as Record<string, unknown>,
      });
    send(line);
  };
  const client = createRpcClient(clientEnd, { clientName: "test" });
  await client.initialize();

  const storage = memoryStorage();
  await storage.putHost({ hostId: "host", hostPub: "pub", name: "电脑 1", pairedAt: 1 });
  await storage.identity();
  const push = new PhonePush({
    registration: () => Promise.reject(new Error("unsupported")),
    permission: () => "default",
    requestPermission: vi.fn(),
    info: vi.fn(),
    changed: vi.fn(),
  });
  const { container } = render(<PhoneApp storage={storage} push={push} />);
  const connect = await waitFor(() => {
    expect(shared.connect).toBeDefined();
    return shared.connect as NonNullable<typeof shared.connect>;
  });
  await act(async () => {
    await connect(client, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
  });
  const project = await waitFor(() => {
    const row = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((item) =>
      item.textContent?.includes(path.basename(ws)),
    );
    expect(row).toBeDefined();
    return row as HTMLButtonElement;
  });
  fireEvent.click(project);
  const row = await waitFor(() => {
    const item = container.querySelector<HTMLButtonElement>(".phone-row.session");
    expect(item?.textContent).toContain("第一条普通消息");
    return item as HTMLButtonElement;
  });
  fireEvent.click(row);
  return { container, calls };
}

async function forkAt(index: number) {
  const messages = await screen.findAllByRole("article", { name: "用户消息" }, { timeout: 10_000 });
  expect(messages).toHaveLength(3);
  const message = messages[index] as HTMLElement;
  fireEvent.click(within(message).getByRole("button", { name: "分叉" }));
  const confirm = await within(message).findByRole("group", { name: "确认分叉" });
  fireEvent.click(within(confirm).getByRole("button", { name: "分叉" }));
}

const field = () => screen.getByLabelText<HTMLTextAreaElement>("消息");

it("手机从 /plan 消息分叉：输入框填好带命令名的原消息，光标在末尾，不发送、无回退提示；再进不填", async () => {
  const { calls } = await setup();
  await forkAt(1);
  await waitFor(
    () => {
      expect(screen.getAllByRole("article", { name: "用户消息" })).toHaveLength(1);
      expect(field().value).toBe("/plan 拆分模块");
    },
    { timeout: 10_000 },
  );
  expect(field().selectionStart).toBe(field().value.length);
  expect(screen.queryByText(/已回退到/)).toBeNull();
  expect(
    calls.filter((c) => c.method === "session.submit" || c.method === "session.enqueueInput"),
  ).toEqual([]);
  // 清空后回到列表，再依次进入两个会话：都不再填
  fireEvent.change(field(), { target: { value: "" } });
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".phone-row.session")];
  const backToList = async () => {
    for (let i = 0; i < 3 && rows().length === 0; i++) {
      fireEvent.click(screen.getByRole("button", { name: "返回" }));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
  };
  for (const index of [0, 1]) {
    await backToList();
    fireEvent.click(rows()[index] as HTMLButtonElement);
    await screen.findAllByRole("article", { name: "用户消息" }, { timeout: 10_000 });
    // 等输入框挂载后的填回 effect 跑完再断言
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(field().value).toBe("");
  }
}, 60_000);

it("手机从 Runtime 写入的消息分叉：输入框不填", async () => {
  await setup();
  await forkAt(2);
  await waitFor(
    () => {
      expect(screen.getAllByRole("article", { name: "用户消息" })).toHaveLength(2);
    },
    { timeout: 10_000 },
  );
  expect(field().value).toBe("");
  expect(screen.queryByText(/已回退到/)).toBeNull();
}, 60_000);
