/**
 * 顶层会话只读快照观察 RPC 映射（ADR-0099、rpc.md 4.2）：
 * session.observe / session.observeEvent / session.observeAttachment；
 * 远程白名单与附件上限边界、afterSeq 续接升级无重复无遗漏、非法参数校验。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider, type Runtime } from "@nocturne/core";
import { createSessionView, reduceSessionView, type DurableEvent } from "@nocturne/core/protocol";
import { createMemoryTransportPair, createRpcClient, type RpcClient } from "@nocturne/rpc/client";
import { createRpcServer, REMOTE_METHODS } from "@nocturne/rpc/server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const iso = (seq: number): string => new Date(Date.UTC(2026, 10, 19, 9, 0, seq)).toISOString();

function writeLog(dir: string, id: string, lines: unknown[]): void {
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

async function pair(
  runtime: Runtime,
  options: { origin?: "local" | "remote"; remoteLimit?: number } = {},
): Promise<{ client: RpcClient; cleanup: () => Promise<void> }> {
  const server = createRpcServer({
    nocturneVersion: "0.0.0-test",
    createRuntime: async () => ({ runtime }),
    ...(options.remoteLimit !== undefined ? { remoteMessageLimit: options.remoteLimit } : {}),
  });
  const origin = options.origin ?? "local";
  if (origin === "local") {
    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const served = server.serve(serverTransport, { origin: "local" });
    const client = createRpcClient(clientTransport, { clientName: "observe-test" });
    await client.initialize();
    return {
      client,
      cleanup: async () => {
        await client.close();
        await served;
      },
    };
  }
  const [localClientT, localServerT] = createMemoryTransportPair();
  const localServed = server.serve(localServerT, { origin: "local" });
  const localClient = createRpcClient(localClientT, { clientName: "observe-host" });
  await localClient.initialize();
  const [remoteClientT, remoteServerT] = createMemoryTransportPair();
  const remoteServed = server.serve(remoteServerT, { origin: "remote" });
  const client = createRpcClient(remoteClientT, { clientName: "observe-remote" });
  await client.initialize();
  return {
    client,
    cleanup: async () => {
      await client.close();
      await remoteServed;
      await localClient.close();
      await localServed;
    },
  };
}

describe("session.observe / session.observeAttachment RPC（ADR-0099）", () => {
  it("远程白名单包含 session.observe 与 session.observeAttachment", () => {
    expect(REMOTE_METHODS).toContain("session.observe");
    expect(REMOTE_METHODS).toContain("session.observeAttachment");
  });

  it("远程免唤醒观察不取锁，按 afterSeq 升级为 resumeSession + subscribe 无重复不丢事件", async () => {
    const ws = tmp("nct-rpc-obs-ws-");
    const sessionsDir = tmp("nct-rpc-obs-sess-");
    const id = "202611190900-abcdef01";
    writeLog(sessionsDir, id, [
      {
        type: "session.created",
        sessionId: id,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
        },
      },
      {
        type: "turn.started",
        sessionId: id,
        seq: 2,
        turnId: "t1",
        time: iso(2),
        payload: { turnIndex: 1 },
      },
      {
        type: "message.user",
        sessionId: id,
        seq: 3,
        turnId: "t1",
        time: iso(3),
        payload: { messageId: "m1", content: [{ type: "text", text: "第一句" }] },
      },
      {
        type: "message.assistant",
        sessionId: id,
        seq: 4,
        turnId: "t1",
        time: iso(4),
        payload: {
          messageId: "a1",
          model: { provider: "fake", model: "fake-1" },
          content: [{ type: "text", text: "第一回复" }],
          toolCalls: [],
          finishReason: "stop",
        },
      },
      {
        type: "turn.completed",
        sessionId: id,
        seq: 5,
        turnId: "t1",
        time: iso(5),
        payload: { reason: "done", steps: 1, usage: { inputTokens: 10, outputTokens: 5 } },
      },
    ]);

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "第二回复" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    const { client, cleanup } = await pair(runtime, { origin: "remote" });
    try {
      const view = createSessionView();
      const observedSeqs: number[] = [];
      const snap = await client.runtime.observeSession(
        { sessionId: id },
        {
          onEvent: (event: DurableEvent) => {
            observedSeqs.push(event.seq);
            reduceSessionView(view, event);
          },
        },
      );
      expect(snap).toEqual({
        sessionId: id,
        lastSeq: 5,
        cwd: ws,
        workspaceRoot: ws,
        openHere: false,
        tailIgnored: false,
      });
      expect(observedSeqs).toEqual([1, 2, 3, 4, 5]);
      // 尚未打开会话、未创建锁文件
      expect(existsSync(path.join(sessionsDir, `${id}.lock`))).toBe(false);

      // 升级：resumeSession + subscribe({ afterSeq: view.lastSeq })，然后发第二句
      const { session } = await client.runtime.resumeSession(id);
      const subSeqs: number[] = [];
      const sub = await session.subscribe(
        (event) => {
          if ("seq" in event) subSeqs.push(event.seq);
          reduceSessionView(view, event);
        },
        { afterSeq: view.lastSeq },
      );
      // 升级瞬间不应重复回放 1..5
      expect(subSeqs).toEqual([]);
      expect(sub.lastSeq).toBe(5);

      await session.submit({ text: "第二句" });
      await sub.unsubscribe();
      await session.close();

      // 新事件从 seq 6 连续递增，无重复无缺口
      expect(subSeqs[0]).toBe(6);
      expect(view.entries.filter((e) => e.kind === "user")).toHaveLength(2);
      expect(view.entries.filter((e) => e.kind === "assistant")).toHaveLength(2);
    } finally {
      await cleanup();
      await runtime.close();
    }
  });

  it("远程 session.observeAttachment 遵守与 session.readAttachment 相同的附件大小上限与权限边界", async () => {
    const ws = tmp("nct-rpc-obs-att-ws-");
    const sessionsDir = tmp("nct-rpc-obs-att-sess-");
    const id = "202611190901-22334455";
    const small = PNG_2x3;
    const big = new Uint8Array(4096);
    big.set(PNG_2x3);
    const smallSha = createHash("sha256").update(small).digest("hex");
    const bigSha = createHash("sha256").update(big).digest("hex");
    const smallFile = `${smallSha.slice(0, 16)}.png`;
    const bigFile = `${bigSha.slice(0, 16)}.png`;
    const attDir = path.join(sessionsDir, "attachments", id);
    mkdirSync(attDir, { recursive: true });
    writeFileSync(path.join(attDir, smallFile), small);
    writeFileSync(path.join(attDir, bigFile), big);

    writeLog(sessionsDir, id, [
      {
        type: "session.created",
        sessionId: id,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
        },
      },
      {
        type: "message.user",
        sessionId: id,
        seq: 2,
        turnId: "t1",
        time: iso(2),
        payload: {
          messageId: "m1",
          content: [{ type: "text", text: "两张图" }],
          attachments: [
            {
              type: "image",
              file: smallFile,
              mimeType: "image/png",
              bytes: small.byteLength,
              sha256: smallSha,
              source: "paste",
            },
            {
              type: "image",
              file: bigFile,
              mimeType: "image/png",
              bytes: big.byteLength,
              sha256: bigSha,
              source: "paste",
            },
          ],
        },
      },
    ]);

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    // 压低 remoteLimit 让 big 触发上限（remoteAttachmentLimit 约占 3/4 减去 64KB，这里给足够小值触发限制）
    const { client, cleanup } = await pair(runtime, { origin: "remote", remoteLimit: 1024 });
    try {
      await expect(
        client.runtime.readSessionAttachment({ sessionId: id, file: bigFile }),
      ).rejects.toMatchObject({ code: "attachment_too_large" });
    } finally {
      await cleanup();
    }

    // 默认 remoteLimit 下 small 可直接只读读取
    const normal = await pair(runtime, { origin: "remote" });
    try {
      const att = await normal.client.runtime.readSessionAttachment({
        sessionId: id,
        file: smallFile,
      });
      expect(att.mimeType).toBe("image/png");
      expect(att.bytes).toBe(small.byteLength);
      expect(new Uint8Array(att.data)).toEqual(small);
      expect(existsSync(path.join(sessionsDir, `${id}.lock`))).toBe(false);
    } finally {
      await normal.cleanup();
      await runtime.close();
    }
  });

  it("非法参数校验：空 observeId、负 afterSeq、越界 afterSeq 返回 invalid_params", async () => {
    const ws = tmp("nct-rpc-obs-err-ws-");
    const sessionsDir = tmp("nct-rpc-obs-err-sess-");
    const id = "202611190902-99887766";
    writeLog(sessionsDir, id, [
      {
        type: "session.created",
        sessionId: id,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
        },
      },
    ]);
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    const { client, cleanup } = await pair(runtime, { origin: "remote" });
    try {
      await expect(
        client.call("session.observe", { sessionId: id, observeId: "" }),
      ).rejects.toMatchObject({ rpcCode: -32602 });
      await expect(
        client.call("session.observe", { sessionId: id, observeId: "o1", afterSeq: -1 }),
      ).rejects.toMatchObject({ rpcCode: -32602 });
      await expect(
        client.runtime.observeSession(
          { sessionId: id, afterSeq: 99 },
          { onEvent: () => undefined },
        ),
      ).rejects.toMatchObject({ rpcCode: -32602 });
    } finally {
      await cleanup();
      await runtime.close();
    }
  });
});
