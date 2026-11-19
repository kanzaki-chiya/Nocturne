/**
 * 多连接侧栏状态回归：另一条 RPC 连接（如外部 agent 经本机管道）在同一个后台里
 * 新建并运行会话，桌面窗口从未打开过该会话时，侧栏仍显示运行标记并排在分组最前；
 * 结束后按 activityMs 回到正常顺序，运行标记消失。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type FakeScript,
  type ModelInfo,
} from "@nocturne/core";
import {
  createMemoryTransportPair,
  createRpcClient,
  type LineTransport,
  type RpcClient,
} from "@nocturne/rpc/client";
import { createRpcServer, type RpcServer } from "@nocturne/rpc/server";
import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

const MODEL = { provider: "fake", model: "fake-model" } as const;
const MODELS: ModelInfo[] = [
  {
    ref: MODEL,
    capabilities: {
      toolCalls: true,
      parallelToolCalls: false,
      reasoning: "none",
      imageInput: true,
      promptCache: false,
      editTool: "edit",
    },
  },
];

const dirsToClean: string[] = [];

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

it("另一条 RPC 连接新建并运行的会话，本窗口未打开时，侧栏显示运行并排在最前", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "r1119q-ext-ws-"));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), "r1119q-ext-sessions-"));
  const home = mkdtempSync(path.join(tmpdir(), "r1119q-ext-home-"));
  dirsToClean.push(ws, sessionsDir, home);

  let releaseExternal!: () => void;
  const externalGate = new Promise<void>((resolve) => {
    releaseExternal = resolve;
  });
  let externalEntered!: () => void;
  const externalStarted = new Promise<void>((resolve) => {
    externalEntered = resolve;
  });

  const provider = new FakeProvider({
    models: MODELS,
    handler: async (request): Promise<FakeScript> => {
      const serialized = JSON.stringify(request.messages);
      if ((request.tools?.length ?? 0) === 0) {
        const title = serialized.includes("外部连接任务") ? "外部连接任务" : "本地会话 B";
        return [
          { type: "text_delta", text: title },
          { type: "finish", reason: "stop" },
        ];
      }
      if (serialized.includes("外部连接任务")) {
        externalEntered();
        await externalGate;
        return [
          { type: "text_delta", text: "外部连接任务已完成" },
          { type: "finish", reason: "stop" },
        ];
      }
      return [
        { type: "text_delta", text: "本地会话 B 已回复" },
        { type: "finish", reason: "stop" },
      ];
    },
  });

  let serverReady!: (server: RpcServer) => void;
  const serverPromise = new Promise<RpcServer>((resolve) => {
    serverReady = resolve;
  });

  const channels = new Map<number, (message: BackendMessage) => void>();
  const clients = new Map<number, LineTransport>();
  const host: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => home,
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
      if (command === "plain_workspace") return ws;
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = Math.max(0, ...channels.keys()) + 1;
        channels.set(id, channel as (m: BackendMessage) => void);
        const [clientEnd, serverEnd] = createMemoryTransportPair();
        const server = createRpcServer({
          nocturneVersion: "test",
          createRuntime: async () => {
            const platform = createPlatform();
            const config = await loadConfig(platform, {
              nocturneHome: home,
              env: () => undefined,
            });
            return {
              runtime: await createRuntime({
                cwd: ws,
                sessionsDir,
                providers: [provider],
                interactive: true,
                config,
              }),
              sessionsDir,
            };
          },
        });
        void server.serve(serverEnd);
        serverReady(server);
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
        const id = Number(args?.backendId);
        clients.get(id)?.close();
        return;
      }
      if (command === "backend_stderr") return [];
      if (command === "backend_send") {
        const id = Number(args?.backendId);
        clients.get(id)?.send(String(args?.line ?? ""));
        return;
      }
      if (command === "app_note") return;
      if (command === "shell_log") return [];
      throw new Error(`未处理外壳命令 ${command}`);
    },
  };

  const { container } = render(<App host={host} />);
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入", undefined, {
    timeout: 15_000,
  });
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: "切换模型" }).textContent).toContain("fake-model"),
    { timeout: 15_000 },
  );

  // 1. 另一条 RPC 连接接入同一个后台，新建会话并开始运行（桌面窗口从未打开它）
  const server = await serverPromise;
  const [extClientEnd, extServerEnd] = createMemoryTransportPair();
  const extServed = server.serve(extServerEnd, { origin: "remote" });
  const extClient: RpcClient = createRpcClient(extClientEnd, {
    clientName: "external-agent",
    interactive: false,
  });
  let externalTurn: Promise<string> | undefined;
  try {
    await extClient.initialize();
    const { session: externalSession } = await extClient.runtime.createSession({
      cwd: ws,
      model: MODEL,
    });
    externalTurn = externalSession.submit({ text: "外部连接任务" });
    await externalStarted;

    // 2. 在桌面窗口里发一条更新的本地会话消息（使本地会话 activityMs 晚于外部会话）
    fireEvent.change(field, { target: { value: "本地会话 B 第一句" } });
    await waitFor(
      () => expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", false),
      { timeout: 10_000 },
    );
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await screen.findByText("本地会话 B 已回复", undefined, { timeout: 15_000 });

    const rowSummary = () =>
      [...container.querySelectorAll(".side .irow .item")].map((btn) => ({
        title: btn.querySelector(".t")?.textContent?.trim(),
        running: btn.querySelector(".row-spin") !== null,
      }));

    // 3. 尽管本地会话更新且本窗口从未打开过外部会话，运行中的外部会话仍排在分组最前并显示运行标记
    await waitFor(
      () => {
        const rows = rowSummary();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ running: true });
        expect(rows[0]?.title).toContain("外部连接任务");
        expect(rows[1]?.running).toBe(false);
        expect(rows[1]?.title).toContain("本地会话 B");
      },
      { timeout: 15_000 },
    );

    // 4. 外部会话结束后，按 activityMs 退回到本地会话之后，运行标记消失
    releaseExternal();
    expect(await externalTurn).toBe("done");

    await waitFor(
      () => {
        const rows = rowSummary();
        expect(rows).toHaveLength(2);
        expect(rows[0]?.running).toBe(false);
        expect(rows[0]?.title).toContain("本地会话 B");
        expect(rows[1]?.running).toBe(false);
        expect(rows[1]?.title).toContain("外部连接任务");
      },
      { timeout: 15_000 },
    );
  } finally {
    releaseExternal();
    await externalTurn?.catch(() => undefined);
    extClient.close();
    await extServed.catch(() => undefined);
    for (const c of clients.values()) c.close();
  }
}, 60_000);
