/**
 * r1114d：手写旧 swarm 日志。桌面端会话控制器与手机网页都照常列出它，
 * 打开时显示 Runtime 原文；归档、取消归档和搜索不因为这一份日志失败。
 */
import { webcrypto } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Runtime } from "@nocturne/core";
import { createMemoryTransportPair, createRpcClient, RpcError } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";

import { Conversations } from "../src/conversations";
import { PhoneApp } from "../src/web/App";
import { PhonePush } from "../src/web/push";
import { memoryStorage } from "../src/web/storage";

const LEGACY_OPEN_ERROR = "日志包含不认识的持久化事件类型: 不认识的持久化事件类型: swarm.created";

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

const roots: string[] = [];
let reactRoot: Root | undefined;

afterEach(async () => {
  await act(() => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{
  runtime: Runtime;
  cwd: string;
  parentId: string;
  goodId: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nct-desktop-legacy-"));
  roots.push(root);
  const cwd = path.join(root, "repo");
  const sessionsDir = path.join(root, "sessions");
  const runtime = await createRuntime({
    cwd,
    sessionsDir,
    providers: [
      new FakeProvider({
        handler: () => [
          { type: "text_delta", text: "好" },
          { type: "finish", reason: "stop" },
        ],
      }),
    ],
  });
  const good = await runtime.createSession({ model: "fake/fake-1" });
  await good.submit({ text: "可搜索的好会话" });
  await vi.waitFor(() => expect(good.state().openTurn).toBeUndefined());
  const meta = good.state().meta;
  const goodId = good.id;
  await good.close();
  const parentId = "20261114-deskparent";
  await writeFile(
    path.join(sessionsDir, `${parentId}.jsonl`),
    [
      JSON.stringify({
        type: "session.created",
        sessionId: parentId,
        seq: 1,
        time: "2026-11-14T00:00:00.000Z",
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: meta.cwd,
          workspaceRoot: meta.workspaceRoot,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
        },
      }),
      JSON.stringify({
        type: "message.user",
        sessionId: parentId,
        seq: 2,
        time: "2026-11-14T00:00:01.000Z",
        payload: {
          messageId: "m-parent",
          content: [{ type: "text", text: "旧合奏要改订单页" }],
        },
      }),
      JSON.stringify({
        type: "swarm.created",
        sessionId: parentId,
        seq: 3,
        time: "2026-11-14T00:00:02.000Z",
        payload: { title: "订单页" },
      }),
    ].join("\n") + "\n",
  );
  return { runtime, cwd: meta.cwd, parentId, goodId };
}

it("桌面端打开旧日志只记下 Runtime 原文，列表、搜索、归档不受影响", async () => {
  const { runtime, cwd, parentId, goodId } = await setup();
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: () => Promise.resolve({ runtime }),
  });
  const [serverEnd, transport] = createMemoryTransportPair();
  const done = server.serve(serverEnd);
  const client = createRpcClient(transport, { clientName: "desktop-test" });
  try {
    await client.initialize();
    const listed = await client.runtime.listSessions({ cwd });
    expect(listed.map((item) => item.id).sort()).toEqual([goodId, parentId].sort());
    expect(
      (await client.runtime.searchSessions({ query: "旧合奏要改订单页" })).map(
        (item) => item.sessionId,
      ),
    ).toEqual([parentId]);
    expect(
      (await client.runtime.searchSessions({ query: "可搜索的好会话" })).map(
        (item) => item.sessionId,
      ),
    ).toEqual([goodId]);

    const failures: unknown[] = [];
    const controller = new Conversations(
      { ensure: () => Promise.resolve(client), get: () => client },
      () => "plain",
      () => undefined,
      (error) => failures.push(error),
    );
    await expect(controller.open(parentId, cwd)).rejects.toBeInstanceOf(RpcError);
    expect(controller.openErrors.get(parentId)?.message).toBe(LEGACY_OPEN_ERROR);
    expect(failures).toEqual([]);
    const good = await client.runtime.resumeSession(goodId);
    expect(good.session.id).toBe(goodId);
    await good.session.close();

    await client.runtime.archiveSession(parentId);
    expect((await client.runtime.listSessions({ cwd })).map((item) => item.id)).toEqual([goodId]);
    expect(
      (await client.runtime.listSessions({ cwd, includeArchived: true })).map((item) => item.id),
    ).toEqual(expect.arrayContaining([goodId, parentId]));
    await client.runtime.unarchiveSession(parentId);
    expect((await client.runtime.listSessions({ cwd })).map((item) => item.id).sort()).toEqual(
      [goodId, parentId].sort(),
    );
  } finally {
    await client.shutdown();
    await done;
  }
});

it("手机网页列出旧日志，打开时警告是 Runtime 原文，归档后从列表消失", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { runtime, cwd, parentId, goodId } = await setup();
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: () => Promise.resolve({ runtime }),
  });
  const [localServer, localTransport] = createMemoryTransportPair();
  const [phoneServer, phoneTransport] = createMemoryTransportPair();
  const localDone = server.serve(localServer);
  const phoneDone = server.serve(phoneServer, { origin: "remote" });
  const local = createRpcClient(localTransport, { clientName: "desktop-test" });
  const phone = createRpcClient(phoneTransport, { clientName: "phone-test" });
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
  const container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
  try {
    await local.initialize();
    await phone.initialize();
    await act(async () => {
      reactRoot?.render(
        <PhoneApp
          storage={storage}
          push={push}
          platform={{ relay: "page", onAndroidBack: () => () => undefined }}
        />,
      );
    });
    await act(async () => {
      await shared.connect?.(phone, { subscribePush: vi.fn(), unsubscribePush: vi.fn() });
    });
    const base = path.basename(cwd);
    const project = [...container.querySelectorAll<HTMLButtonElement>(".phone-row")].find((row) =>
      row.textContent?.includes(base),
    );
    expect(project).toBeTruthy();
    await act(() => project?.click());
    expect(container.textContent).toContain("旧合奏要改订单页");
    expect(container.textContent).toContain("可搜索的好会话");
    const oldRow = [...container.querySelectorAll<HTMLButtonElement>(".phone-row.session")].find(
      (row) => row.textContent?.includes("旧合奏要改订单页"),
    );
    await act(() => oldRow?.click());
    await vi.waitFor(() =>
      expect(container.querySelector(".phone-error")?.textContent).toBe(LEGACY_OPEN_ERROR),
    );
    expect(container.textContent).not.toContain("旧格式");
    expect(container.textContent).not.toContain("迁移");
    expect((await phone.runtime.listSessions()).map((item) => item.id).sort()).toEqual(
      [goodId, parentId].sort(),
    );

    await local.runtime.archiveSession(parentId);
    await vi.waitFor(async () => {
      expect((await phone.runtime.listSessions()).map((item) => item.id)).toEqual([goodId]);
    });
    await local.runtime.unarchiveSession(parentId);
    await vi.waitFor(async () => {
      expect((await phone.runtime.listSessions()).map((item) => item.id).sort()).toEqual(
        [goodId, parentId].sort(),
      );
    });
  } finally {
    await local.shutdown().catch(() => undefined);
    await phone.shutdown().catch(() => undefined);
    await Promise.all([localDone, phoneDone]);
  }
});
