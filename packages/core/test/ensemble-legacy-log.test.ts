/**
 * r1114d：手写的旧格式合奏日志（持久事件仍叫 swarm.*）。
 * 打开报 session_log_newer，原文不另加说明；列表、搜索、归档、取消归档、
 * 删除日志文件都不受这一个会话影响。
 * 旧成员子会话（parent.callId 以 swarm: 开头）没有专门处理：主列表不显示。
 * 父日志读不出来，listSubagents 整次失败，所以它不会出现在子代理目录里。
 * 直接打开子会话时按普通用户消息显示：没有送达头，正文保留 <swarm-post>。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, SessionError, type RuntimeSession } from "../src/index.js";
import {
  extractEnsembleMentionTokens,
  parseWorkModeSlash,
  replaySessionView,
  resolveEnsembleMentions,
  unwrapEnsemblePostText,
  WORK_MODE_NAMES,
} from "../src/protocol/index.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/protocol/skills.js";

const roots: string[] = [];
const sessions: RuntimeSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const LEGACY_OPEN_ERROR = "日志包含不认识的持久化事件类型: 不认识的持久化事件类型: swarm.created";

function eventLine(event: unknown): string {
  return JSON.stringify(event);
}

function created(
  id: string,
  cwd: string,
  workspaceRoot: string,
  parent?: { sessionId: string; callId: string },
): unknown {
  return {
    type: "session.created",
    sessionId: id,
    seq: 1,
    time: "2026-11-14T00:00:00.000Z",
    payload: {
      formatVersion: 1,
      nocturneVersion: "0.0.0",
      cwd,
      workspaceRoot,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      ...(parent !== undefined ? { parent } : {}),
    },
  };
}

it("旧 swarm 日志打不开，列表、搜索、归档和删文件仍正常；旧成员直接打开才按普通用户消息显示", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nct-legacy-"));
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
  sessions.push(good);
  await good.submit({ text: "可搜索的好会话" });
  await vi.waitFor(() => expect(good.state().openTurn).toBeUndefined());
  const meta = good.state().meta;
  await good.close();
  sessions.pop();

  const parentId = "20261114-oldparent";
  const childId = "20261114-oldmember";
  const post = '<swarm-post n="1" from="orders">成员汇报订单</swarm-post>';
  await writeFile(
    path.join(sessionsDir, `${parentId}.jsonl`),
    [
      eventLine(created(parentId, meta.cwd, meta.workspaceRoot)),
      eventLine({
        type: "message.user",
        sessionId: parentId,
        seq: 2,
        time: "2026-11-14T00:00:01.000Z",
        payload: {
          messageId: "m-parent",
          content: [{ type: "text", text: "旧合奏要改订单页" }],
        },
      }),
      eventLine({
        type: "swarm.created",
        sessionId: parentId,
        seq: 3,
        time: "2026-11-14T00:00:02.000Z",
        payload: { title: "订单页" },
      }),
    ].join("\n") + "\n",
  );
  await writeFile(
    path.join(sessionsDir, `${childId}.jsonl`),
    [
      eventLine(
        created(childId, meta.cwd, meta.workspaceRoot, {
          sessionId: parentId,
          callId: "swarm:orders",
        }),
      ),
      eventLine({
        type: "message.user",
        sessionId: childId,
        seq: 2,
        time: "2026-11-14T00:00:03.000Z",
        payload: {
          messageId: "m-child",
          content: [{ type: "text", text: post }],
          swarm: { postNumber: 1, from: "orders", fromKind: "member" },
        },
      }),
    ].join("\n") + "\n",
  );

  const listed = await runtime.listSessions({ cwd: meta.cwd });
  expect(listed.map((item) => item.id).sort()).toEqual([good.id, parentId].sort());
  expect(listed.find((item) => item.id === parentId)?.firstText).toBe("旧合奏要改订单页");

  const foundOld = await runtime.searchSessions("旧合奏要改订单页");
  const foundGood = await runtime.searchSessions("可搜索的好会话");
  expect(foundOld.map((item) => item.sessionId)).toEqual([parentId]);
  expect(foundGood.map((item) => item.sessionId)).toEqual([good.id]);

  const opened = await runtime.resumeSession(parentId).catch((error: unknown) => error);
  expect(opened).toBeInstanceOf(SessionError);
  expect(opened).toMatchObject({ code: "session_log_newer", message: LEGACY_OPEN_ERROR });

  const child = await runtime.resumeSession(childId);
  sessions.push(child);
  const view = replaySessionView(child.durableEvents());
  const user = view.entries.find((entry) => entry.kind === "user");
  expect(user?.kind).toBe("user");
  if (user?.kind !== "user") throw new Error("缺少用户消息");
  // 旧字段 swarm 被忽略，没有 ensemble 送达头；<swarm-post> 原样留在正文里。
  expect(user.ensemble).toBeUndefined();
  const text = user.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(text).toBe(post);
  expect(unwrapEnsemblePostText(text)).toBe(post);
  await child.close();
  sessions.pop();

  await expect(runtime.listSubagents({ parentSessionId: parentId })).rejects.toMatchObject({
    code: "session_log_newer",
    message: LEGACY_OPEN_ERROR,
  });

  await runtime.archiveSession(parentId);
  expect((await runtime.listSessions({ cwd: meta.cwd })).map((item) => item.id)).toEqual([good.id]);
  expect(
    (await runtime.listSessions({ cwd: meta.cwd, includeArchived: true })).map((item) => item.id),
  ).toEqual(expect.arrayContaining([good.id, parentId]));
  await runtime.unarchiveSession(parentId);
  expect((await runtime.listSessions({ cwd: meta.cwd })).map((item) => item.id).sort()).toEqual(
    [good.id, parentId].sort(),
  );

  await rm(path.join(sessionsDir, `${parentId}.jsonl`));
  await rm(path.join(sessionsDir, `${childId}.jsonl`));
  expect((await runtime.listSessions({ cwd: meta.cwd })).map((item) => item.id)).toEqual([good.id]);
  expect(await runtime.searchSessions("旧合奏要改订单页")).toEqual([]);
  expect((await runtime.searchSessions("可搜索的好会话")).map((item) => item.sessionId)).toEqual([
    good.id,
  ]);

  expect(parseWorkModeSlash("/swarm")).toBeUndefined();
  expect(parseWorkModeSlash("/swarm board")).toBeUndefined();
  expect(WORK_MODE_NAMES).not.toContain("swarm");
  expect(BUILTIN_SLASH_COMMANDS).not.toContain("swarm");
  expect(extractEnsembleMentionTokens("叫 @协调者")).toEqual([]);
  expect(
    resolveEnsembleMentions({
      text: "@coordinator 汇报",
      author: "orders",
      authorKind: "member",
      members: [{ name: "orders", removed: false }],
    }),
  ).toEqual({ ok: true, mentions: [], recipients: [] });
  expect(
    resolveEnsembleMentions({
      text: "@指挥 汇报",
      author: "orders",
      authorKind: "member",
      members: [{ name: "orders", removed: false }],
    }),
  ).toEqual({ ok: true, mentions: ["maestro"], recipients: ["maestro"] });
});
