/**
 * 顶层会话只读快照观察（ADR-0099）：不打开会话、不取锁、不修改磁盘日志；
 * 支持 afterSeq 增量回放、已打开会话读内存快照、只读附件回读，以及子会话拒绝。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime, FakeProvider } from "../src/index.js";
import type { DurableEvent } from "../src/protocol/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const iso = (seq: number): string => new Date(Date.UTC(2026, 10, 19, 8, 0, seq)).toISOString();

function writeJsonl(dir: string, id: string, lines: unknown[], tail = ""): string {
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n${tail}`, "utf8");
  return file;
}

describe("Runtime.observeSession & readSessionAttachment（ADR-0099）", () => {
  it("未打开会话只读回放：不取锁、不改坏末行、返回 openHere=false 与 afterSeq 增量", async () => {
    const ws = tmp("nct-obs-ws-");
    const sessionsDir = tmp("nct-obs-sess-");
    const id = "202611190800-deadbeef";
    const badTail = '{"type":"turn.started","seq":4';
    const logPath = writeJsonl(
      sessionsDir,
      id,
      [
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
          payload: { messageId: "m1", content: [{ type: "text", text: "你好" }] },
        },
      ],
      badTail,
    );
    const originalRaw = readFileSync(logPath, "utf8");
    // 即使外部进程持有锁，只读观察也不受锁阻拦、不删改锁文件
    const lockPath = path.join(sessionsDir, `${id}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: iso(0) }), "utf8");

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    try {
      const received: DurableEvent[] = [];
      const snap = await runtime.observeSession(
        { sessionId: id },
        { onEvent: (event) => received.push(event) },
      );
      expect(snap).toEqual({
        sessionId: id,
        lastSeq: 3,
        cwd: ws,
        workspaceRoot: ws,
        openHere: false,
        tailIgnored: true,
      });
      expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
      // 不修改磁盘日志、不触发修复、不删除锁文件
      expect(readFileSync(logPath, "utf8")).toBe(originalRaw);
      expect(existsSync(lockPath)).toBe(true);

      // afterSeq 增量回放只返回 seq > afterSeq
      const delta: DurableEvent[] = [];
      const snapDelta = await runtime.observeSession(
        { sessionId: id, afterSeq: 2 },
        { onEvent: (event) => delta.push(event) },
      );
      expect(snapDelta.lastSeq).toBe(3);
      expect(delta.map((e) => e.seq)).toEqual([3]);

      // afterSeq 越界报 invalid_after_seq
      await expect(
        runtime.observeSession({ sessionId: id, afterSeq: 4 }, { onEvent: () => undefined }),
      ).rejects.toMatchObject({ code: "invalid_after_seq" });
    } finally {
      await runtime.close();
    }
  });

  it("已在本 Runtime 打开的会话：从内存持久事件回放并返回 openHere=true", async () => {
    const ws = tmp("nct-obs-open-ws-");
    const sessionsDir = tmp("nct-obs-open-sess-");
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [
        new FakeProvider({
          scripts: [
            [
              { type: "text_delta", text: "收到" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    try {
      const session = await runtime.createSession({
        model: { provider: "fake", model: "fake-1" },
        cwd: ws,
        workspaceRoot: ws,
      });
      await session.submit({ text: "hello" });

      const events: DurableEvent[] = [];
      const snap = await runtime.observeSession(
        { sessionId: session.id },
        { onEvent: (event) => events.push(event) },
      );
      expect(snap.openHere).toBe(true);
      expect(snap.lastSeq).toBeGreaterThanOrEqual(4);
      expect(events.at(-1)?.seq).toBe(snap.lastSeq);
    } finally {
      await runtime.close();
    }
  });

  it("拒绝子会话并支持不取锁读取已登记附件、拒绝未登记文件", async () => {
    const ws = tmp("nct-obs-att-ws-");
    const sessionsDir = tmp("nct-obs-att-sess-");
    const topId = "202611190801-11223344";
    const childId = "202611190801-55667788";
    const sha256 = createHash("sha256").update(PNG_HEADER).digest("hex");
    const fileName = `${sha256.slice(0, 16)}.png`;
    const attDir = path.join(sessionsDir, "attachments", topId);
    mkdirSync(attDir, { recursive: true });
    writeFileSync(path.join(attDir, fileName), PNG_HEADER);
    writeFileSync(path.join(attDir, "unregistered.png"), PNG_HEADER);

    writeJsonl(sessionsDir, topId, [
      {
        type: "session.created",
        sessionId: topId,
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
        sessionId: topId,
        seq: 2,
        turnId: "t1",
        time: iso(2),
        payload: {
          messageId: "m1",
          content: [{ type: "text", text: "看图" }],
          attachments: [
            {
              type: "image",
              file: fileName,
              mimeType: "image/png",
              bytes: PNG_HEADER.byteLength,
              sha256,
              source: "paste",
            },
          ],
        },
      },
    ]);
    writeJsonl(sessionsDir, childId, [
      {
        type: "session.created",
        sessionId: childId,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
          parent: { sessionId: topId, callId: "call-1" },
        },
      },
    ]);

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    try {
      // 子会话拒绝
      await expect(
        runtime.observeSession({ sessionId: childId }, { onEvent: () => undefined }),
      ).rejects.toMatchObject({ code: "invalid_command" });
      await expect(
        runtime.readSessionAttachment({ sessionId: childId, file: fileName }),
      ).rejects.toMatchObject({ code: "invalid_command" });

      // 已登记附件可不取锁读取
      const att = await runtime.readSessionAttachment({ sessionId: topId, file: fileName });
      expect(att.mimeType).toBe("image/png");
      expect(att.bytes).toBe(PNG_HEADER.byteLength);
      expect(new Uint8Array(att.data)).toEqual(PNG_HEADER);
      expect(existsSync(path.join(sessionsDir, `${topId}.lock`))).toBe(false);

      // 未登记附件拒绝
      await expect(
        runtime.readSessionAttachment({ sessionId: topId, file: "unregistered.png" }),
      ).rejects.toMatchObject({ code: "attachment_not_found" });
    } finally {
      await runtime.close();
    }
  });

  it("分叉会话只读回放允许源会话前缀，但仍拒绝分叉边界后 sessionId 不一致的损坏日志", async () => {
    const ws = tmp("nct-obs-fork-ws-");
    const sessionsDir = tmp("nct-obs-fork-sess-");
    const sourceId = "202611190803-source01";
    const forkId = "202611190803-fork0001";
    const badForkId = "202611190803-badfork1";

    writeJsonl(sessionsDir, forkId, [
      {
        type: "session.created",
        sessionId: forkId,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
          forkedFrom: { sessionId: sourceId, seq: 2 },
        },
      },
      {
        type: "message.user",
        sessionId: sourceId,
        seq: 2,
        turnId: "t1",
        time: iso(2),
        payload: { messageId: "m1", content: [{ type: "text", text: "来自源会话" }] },
      },
      {
        type: "session.rewound",
        sessionId: forkId,
        seq: 3,
        time: iso(3),
        payload: { targetSeq: 2, mode: "conversation", files: [], fork: true },
      },
    ]);
    writeJsonl(sessionsDir, badForkId, [
      {
        type: "session.created",
        sessionId: badForkId,
        seq: 1,
        time: iso(1),
        payload: {
          formatVersion: 1,
          nocturneVersion: "0.0.0",
          cwd: ws,
          workspaceRoot: ws,
          model: { provider: "fake", model: "fake-1" },
          permissionPreset: "default",
          forkedFrom: { sessionId: sourceId, seq: 2 },
        },
      },
      {
        type: "message.user",
        sessionId: sourceId,
        seq: 2,
        turnId: "t1",
        time: iso(2),
        payload: { messageId: "m1", content: [{ type: "text", text: "源前缀" }] },
      },
      {
        type: "message.user",
        sessionId: "stranger-id",
        seq: 3,
        turnId: "t2",
        time: iso(3),
        payload: { messageId: "m2", content: [{ type: "text", text: "边界后串台" }] },
      },
    ]);

    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir,
      providers: [new FakeProvider({ scripts: [] })],
    });
    try {
      const received: DurableEvent[] = [];
      const snap = await runtime.observeSession(
        { sessionId: forkId },
        { onEvent: (event) => received.push(event) },
      );
      expect(snap.lastSeq).toBe(3);
      expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);

      await expect(
        runtime.observeSession({ sessionId: badForkId }, { onEvent: () => undefined }),
      ).rejects.toMatchObject({ code: "session_log_corrupt" });
    } finally {
      await runtime.close();
    }
  });
});
