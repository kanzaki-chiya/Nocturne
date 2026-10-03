import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createCheckpointRecorder } from "../src/session/checkpoints.js";
import { attachmentDescriptions } from "../src/context/index.js";
import { createSessionView, reduceSessionView, replaySessionView } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

const dirs: string[] = [];
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "nct-rewind-")));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(provider = new FakeProvider({})) {
  const platform = createPlatform();
  const cwd = await platform.resolveReal(temp()),
    sessionsDir = temp();
  const runtime = await createRuntime({ cwd, sessionsDir, providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  return {
    cwd,
    sessionsDir,
    platform,
    runtime,
    session,
    recorder: createCheckpointRecorder(internalSession(session), platform, sessionsDir),
  };
}

it("只回退对话后仍按原始日志取最早 before；新文件删除、外部标记、失败逐项处理，多次回退可重放", async () => {
  const { cwd, session, recorder, runtime } = await setup();
  const online = createSessionView();
  for (const event of session.durableEvents()) reduceSessionView(online, event);
  session.subscribe((e) => reduceSessionView(online, e));
  const first = await internalSession(session).emit("message.user", {
    messageId: "u1",
    content: [{ type: "text", text: "first" }],
  });
  const file = path.join(cwd, "a.txt"),
    fresh = path.join(cwd, "new.txt");
  writeFileSync(file, "original\r\n");
  const edit = async (call: string, value: string) => {
    const subjects = [file, fresh].map((target) => ({
      kind: "edit" as const,
      target,
      resolved: target,
    }));
    await recorder("before", call, subjects, session.id);
    writeFileSync(file, value);
    writeFileSync(fresh, value);
    await recorder("after", call, subjects, session.id);
  };
  await edit("one", "one");
  const second = await internalSession(session).emit("message.user", {
    messageId: "u2",
    content: [{ type: "text", text: "second" }],
  });
  await edit("two", "two");
  await internalSession(session).emit("tool.started", {
    callId: "shell",
    name: "anything",
    mutates: true,
    input: {},
    subjects: [],
    permission: { action: "allow", source: "rule" },
  });
  await internalSession(session).emit("checkpoint.file", {
    callId: "x",
    path: path.join(cwd, "dir"),
    phase: "before",
    before: { untracked: "目录" },
  });
  await session.rewind(second.seq, "conversation");
  expect(
    session
      .state()
      .history.filter((e) => e.kind === "user")
      .map((e) => e.seq),
  ).toEqual([first.seq]);
  expect(readFileSync(file, "utf8")).toBe("two");
  writeFileSync(fresh, "outside");
  const [target] = await session.rewindTargets();
  expect(target?.untrackedCalls).toBe(1);
  expect(target?.files.find((f) => f.path === fresh)).toMatchObject({
    action: "delete",
    external: true,
  });
  const result = await session.rewind(first.seq, "files");
  expect(result).toMatchObject([
    { result: "restored" },
    { result: "deleted" },
    { result: "failed" },
  ]);
  expect(readFileSync(file, "utf8")).toBe("original\r\n");
  expect(existsSync(fresh)).toBe(false);
  expect(session.state().history.at(-1)).toMatchObject({
    kind: "note",
    text: expect.stringContaining(file),
  });
  await session.rewind(first.seq, "both");
  expect(await session.rewindTargets()).toEqual([]);
  expect(session.state().history).toEqual([]);
  const third = await internalSession(session).emit("message.user", {
    messageId: "u3",
    content: [{ type: "text", text: "new branch" }],
  });
  expect((await session.rewindTargets()).map((t) => t.seq)).toEqual([third.seq]);
  await session.rewind(third.seq, "conversation");
  expect(online.entries).toEqual(replaySessionView(session.durableEvents()).entries);
  expect(online.todos).toEqual(replaySessionView(session.durableEvents()).todos);
  const expected = session.state();
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  expect(resumed.state()).toEqual(expected);
  await resumed.close();
}, 20_000);

it("回填原用户文字不包含 @ 引用的文件快照", async () => {
  const { session } = await setup();
  try {
    await internalSession(session).emit("message.user", {
      messageId: "ref",
      content: [
        { type: "text", text: "检查 @a.txt" },
        { type: "text", text: "原消息第二段" },
        { type: "text", text: "文件快照内容" },
      ],
      fileRefs: [{ path: "a.txt", kind: "file", chars: 6, truncated: false }],
    });
    expect((await session.rewindTargets())[0]?.text).toBe("检查 @a.txt\n原消息第二段");
  } finally {
    await session.close();
  }
});

it("回退重算任务清单与图片描述，保持配置、标题和累计用量，移除压缩边界", async () => {
  const { session } = await setup();
  const s = internalSession(session);
  const old = await s.emit("message.user", {
    messageId: "old",
    content: [{ type: "text", text: "old" }],
    attachments: [
      {
        type: "image",
        file: "image.png",
        mimeType: "image/png",
        bytes: 1,
        sha256: "a".repeat(64),
        source: "paste",
      },
    ],
  });

  await s.emit("tool.completed", {
    callId: "todo",
    name: "todo_write",
    status: "ok",
    modelContent: "",
    output: { items: [{ text: "keep", status: "pending" }] },
  });
  const target = await s.emit("message.user", {
    messageId: "cut",
    content: [{ type: "text", text: "cut" }],
  });
  await s.emit("attachment.described", {
    attachmentRef: { seq: old.seq, index: 0 },
    model: "fake/fake-1",
    text: "drop description",
  });
  expect(attachmentDescriptions(session.state().history, s.durableEvents()).size).toBe(1);
  await s.emit("tool.completed", {
    callId: "todo2",
    name: "todo_write",
    status: "ok",
    modelContent: "",
    output: { items: [{ text: "drop", status: "completed" }] },
  });
  await s.emit("message.assistant", {
    messageId: "a",
    model: { provider: "fake", model: "fake-1" },
    content: [],
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 2 },
    finishReason: "stop",
  });
  await s.emit("context.compacted", { kind: "summary", throughSeq: target.seq, summary: "drop" });
  await s.emit("session.config_changed", { permissionPreset: "read-only" });
  await s.emit("session.titled", { title: "kept title", model: "fake/fake-1" });
  await session.rewind(target.seq, "conversation");
  expect(session.state().todos).toEqual([{ text: "keep", status: "pending" }]);
  expect(session.state().usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  expect(session.state().config.permissionPreset).toBe("read-only");
  expect(session.state().history.some((e) => e.kind === "compaction")).toBe(false);
  expect(attachmentDescriptions(session.state().history, s.durableEvents()).size).toBe(0);
  expect(replaySessionView(s.durableEvents())).toMatchObject({
    title: "kept title",
    todos: [{ text: "keep", status: "pending" }],
    config: { permissionPreset: "read-only" },
  });
  await session.close();
}, 20_000);

it("Turn 进行中（包括中断尚未收束）拒绝回退，非法目标与模式拒绝 invalid_command", async () => {
  const { session } = await setup(new FakeProvider({ scripts: [[{ type: "wait" }]] }));
  const turn = session.submit({ text: "busy" });
  await expect(session.rewind(1, "both")).rejects.toMatchObject({ code: "session_busy" });
  expect(() => session.rewindTargets()).toThrow("请先等待或按 Esc 中断");
  session.interrupt();
  await expect(session.rewind(1, "both")).rejects.toMatchObject({ code: "session_busy" });
  await turn;
  await expect(session.rewind(1, "both")).rejects.toMatchObject({ code: "invalid_command" });
  const target = (await session.rewindTargets())[0];
  if (target === undefined) throw new Error("缺少回退目标");
  await expect(session.rewind(target.seq, "bad" as "both")).rejects.toMatchObject({
    code: "invalid_command",
  });
  await session.close();
}, 20_000);
