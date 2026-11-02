/**
 * 分叉后填回原消息：真实 RPC 服务端 + Core（预先写好会话日志），在界面上点「分叉」，
 * 新会话输入框填好原消息、光标在末尾、不自动发送、不出「已回退到…」提示。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createPlatform, createRuntime, FakeProvider, loadConfig } from "@nocturne/core";
import type { RuntimeSession } from "@nocturne/core";
import { createMemoryTransportPair, type LineTransport } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const provider = () =>
  new FakeProvider({
    models: [
      {
        ref: { provider: "fake", model: "fake-model" },
        capabilities: {
          toolCalls: true,
          parallelToolCalls: false,
          reasoning: "none",
          imageInput: true,
          promptCache: false,
          editTool: "edit",
        },
      },
    ],
  });

async function runtimeFor(ws: string, sessionsDir: string, home: string) {
  const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
  return createRuntime({
    cwd: ws,
    sessionsDir,
    providers: [provider()],
    interactive: true,
    config,
  });
}

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

function host(ws: string, plain: string, sessionsDir: string, home: string) {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const clients = new Map<number, LineTransport>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const desktop: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "C:/Users/me",
    appVersion: async () => "0.0.0-test",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: () => undefined,
    notify: async () => ({ shown: true }),
    dismissNotification: async () => undefined,
    requestAttention: async () => undefined,
    onNotificationActivated: () => () => undefined,
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return plain;
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = Math.max(0, ...channels.keys()) + 1;
        channels.set(id, channel as (m: BackendMessage) => void);
        const [clientEnd, serverEnd] = createMemoryTransportPair();
        const server = createRpcServer({
          nocturneVersion: "test",
          createRuntime: async () => ({
            runtime: await runtimeFor(ws, sessionsDir, home),
            sessionsDir,
          }),
        });
        void server.serve(serverEnd);
        clients.set(id, clientEnd);
        clientEnd.onLine((line) => {
          channels.get(id)?.({ kind: "lines", lines: [line] });
        });
        clientEnd.onClose(() => {
          channels.get(id)?.({ kind: "closed", code: 0, stderr: [] });
        });
        return id;
      }
      if (command === "backend_close") {
        clients.get(Number(args?.backendId))?.close();
        return;
      }
      if (command === "backend_stderr") return [];
      if (command === "backend_send") {
        const line = String(args?.line ?? "");
        try {
          const parsed = JSON.parse(line) as { method?: unknown; params?: unknown };
          if (typeof parsed.method === "string")
            calls.push({
              method: parsed.method,
              params: (parsed.params ?? {}) as Record<string, unknown>,
            });
        } catch {
          // 非 JSON 行不记录
        }
        clients.get(Number(args?.backendId))?.send(line);
        return;
      }
      if (command === "app_note") return;
      if (command === "shell_log") return [];
      throw new Error(`未处理外壳命令 ${command}`);
    },
  };
  return { desktop, calls };
}

/** 预先写好的会话：普通消息、用户提交的 /goal 消息、Runtime 写入的核对消息 */
async function seed() {
  const ws = temp("fork-ws-");
  const plain = temp("fork-plain-");
  const sessionsDir = temp("fork-sessions-");
  const home = temp("fork-home-");
  const runtime = await runtimeFor(ws, sessionsDir, home);
  const session = await runtime.createSession({ model: "fake/fake-model" });
  await emit(session, "message.user", {
    messageId: "plain",
    content: [{ type: "text", text: "第一条普通消息" }],
  });
  await emit(session, "message.user", {
    messageId: "goal",
    content: [
      { type: "text", text: "修好登录" },
      { type: "text", text: "目标说明块" },
    ],
    workMode: { name: "goal", body: "目标说明块" },
  });
  await emit(session, "message.user", {
    messageId: "check",
    content: [{ type: "text", text: "核对说明块" }],
    workMode: { name: "goal", body: "核对说明块", source: "runtime" },
  });
  await session.close();
  return { ...host(ws, plain, sessionsDir, home), ws };
}

async function forkAt(index: number) {
  const stream = await screen.findByRole("region", { name: "会话消息" }, { timeout: 15_000 });
  const messages = await within(stream).findAllByRole("article", { name: "用户消息" });
  expect(messages).toHaveLength(3);
  const message = messages[index] as HTMLElement;
  fireEvent.click(within(message).getByRole("button", { name: "分叉" }));
  const confirm = await within(message).findByRole("group", { name: "确认分叉" });
  fireEvent.click(within(confirm).getByRole("button", { name: "分叉" }));
}

async function openSeeded() {
  const seeded = await seed();
  render(<App host={seeded.desktop} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /^第一条普通消息/ }, { timeout: 15_000 }),
  );
  return seeded;
}

it("从 /goal 消息分叉：新会话输入框填好带命令名的原消息，光标在末尾，不发送、无回退提示", async () => {
  const seeded = await openSeeded();
  await forkAt(1);
  await waitFor(
    () => {
      const stream = screen.getByRole("region", { name: "会话消息" });
      expect(within(stream).getAllByRole("article", { name: "用户消息" })).toHaveLength(1);
    },
    { timeout: 15_000 },
  );
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  await waitFor(() => {
    expect(field.value).toBe("/goal 修好登录");
  });
  expect(field.selectionStart).toBe(field.value.length);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(document.activeElement).toBe(field);
  expect(screen.queryByText(/已回退到/)).toBeNull();
  const sent = () =>
    seeded.calls.filter(
      (c) => c.method === "session.submit" || c.method === "session.enqueueInput",
    );
  expect(sent()).toEqual([]);
  // 直接发送：按原执行方式提交
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => {
    expect(sent()[0]?.params).toMatchObject({ text: "修好登录", workMode: "goal" });
  });
}, 60_000);

it("从 Runtime 写入的消息分叉：输入框不填", async () => {
  await openSeeded();
  await forkAt(2);
  await waitFor(
    () => {
      const stream = screen.getByRole("region", { name: "会话消息" });
      expect(within(stream).getAllByRole("article", { name: "用户消息" })).toHaveLength(2);
    },
    { timeout: 15_000 },
  );
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  expect(field.value).toBe("");
  expect(screen.queryByText(/已回退到/)).toBeNull();
}, 60_000);

it("分叉后清空输入框，切走再切回，原消息不再填一次", async () => {
  await openSeeded();
  await forkAt(1);
  await waitFor(
    () => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("消息输入").value).toBe("/goal 修好登录");
    },
    { timeout: 15_000 },
  );
  fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: "" } });
  // 原会话（3 条）与分叉会话（1 条）来回各切两次：输入框都保持为空
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: /^第一条普通消息/ })).toHaveLength(2);
  });
  const count = () =>
    within(screen.getByRole("region", { name: "会话消息" })).queryAllByRole("article", {
      name: "用户消息",
    }).length;
  /** 两个侧栏项都叫「第一条普通消息」：点当前会话不变，点另一个才切换 */
  const switchTo = async (expected: number) => {
    for (const button of screen.getAllByRole("button", { name: /^第一条普通消息/ })) {
      fireEvent.click(button);
      try {
        await waitFor(
          () => {
            expect(count()).toBe(expected);
          },
          { timeout: 5000 },
        );
        return;
      } catch {
        // 点到的是当前会话，换另一个
      }
    }
    throw new Error(`没能切到有 ${expected} 条用户消息的会话`);
  };
  for (const expected of [3, 1, 3, 1]) {
    await switchTo(expected);
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.getByLabelText<HTMLTextAreaElement>("消息输入").value).toBe("");
  }
}, 60_000);
