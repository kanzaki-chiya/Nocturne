import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createCheckpointRecorder } from "../src/session/checkpoints.js";
import { attachmentDescriptions } from "../src/context/index.js";
import { replaySessionView, decodeDurableEvent } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(provider = new FakeProvider({})) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-fork-"));
  dirs.push(root);
  const platform = createPlatform();
  const cwd = await platform.resolveReal(root),
    sessionsDir = path.join(cwd, "sessions");
  const runtime = await createRuntime({ cwd, sessionsDir, providers: [provider] });
  const source = await runtime.createSession({ model: "fake/fake-1" });
  return { cwd, sessionsDir, platform, runtime, source };
}

it("完整分叉保留 seq 引用、标题与配置，复制附件/快照，文件不变且原日志独立", async () => {
  const { cwd, sessionsDir, platform, runtime, source } = await setup();
  const attachment = {
    type: "image" as const,
    file: "img-1.png",
    mimeType: "image/png" as const,
    bytes: 3,
    sha256: "a".repeat(64),
    source: "paste" as const,
  };
  const image = await internalSession(source).emit("message.user", {
    messageId: "image",
    content: [{ type: "text", text: "image" }],
    attachments: [attachment],
  });
  const attachmentDir = path.join(sessionsDir, "attachments", source.id);
  mkdirSync(attachmentDir, { recursive: true });
  writeFileSync(path.join(attachmentDir, attachment.file), Buffer.from([0, 1, 255]));
  writeFileSync(path.join(attachmentDir, "output.txt"), "落盘工具输出");
  const described = await internalSession(source).emit("attachment.described", {
    attachmentRef: { seq: image.seq, index: 0 },
    model: "fake/fake-1",
    text: "图片描述",
  });
  const compacted = await internalSession(source).emit("context.compacted", {
    kind: "summary",
    throughSeq: image.seq,
    summary: "概要",
  });
  await internalSession(source).emit("session.titled", { title: "原标题", model: "fake/fake-1" });
  await internalSession(source).emit("session.config_changed", { permissionPreset: "read-only" });
  const file = path.join(cwd, "data.txt");
  writeFileSync(file, "before\r\n");
  const record = createCheckpointRecorder(internalSession(source), platform, sessionsDir);
  const subjects = [{ kind: "edit" as const, target: file, resolved: file }];
  await record("before", "edit", subjects, source.id);
  writeFileSync(file, "after");
  await record("after", "edit", subjects, source.id);
  const original = [...source.durableEvents()];
  const titleLine = readFileSync(internalSession(source).logPath, "utf8")
    .split("\n")
    .findLast((line) => line.includes('"session.titled"'));
  expect(decodeDurableEvent(titleLine ?? "")).toMatchObject({
    type: "session.titled",
    payload: { title: "原标题" },
  });
  const id = await runtime.forkSession(source.id);
  expect(readFileSync(file, "utf8")).toBe("after");
  expect(source.durableEvents()).toEqual(original);
  expect(existsSync(path.join(sessionsDir, `${source.id}.lock`))).toBe(true);
  const fork = await runtime.resumeSession(id);
  expect(fork.durableEvents().slice(1)).toEqual(original.slice(1));
  expect(fork.state().meta).toMatchObject({
    id,
    forkedFrom: { sessionId: source.id, seq: original.at(-1)?.seq },
  });
  expect(fork.state().history).toContainEqual(
    expect.objectContaining({ kind: "compaction", seq: compacted.seq, throughSeq: image.seq }),
  );
  expect(attachmentDescriptions(fork.state().history, fork.durableEvents()).size).toBe(1);
  expect(fork.durableEvents()[described.seq - 1]).toEqual(described);
  expect(replaySessionView(fork.durableEvents()).title).toBe("原标题");
  expect(readFileSync(path.join(sessionsDir, "attachments", id, attachment.file))).toEqual(
    Buffer.from([0, 1, 255]),
  );
  expect(readFileSync(path.join(sessionsDir, "attachments", id, "output.txt"), "utf8")).toBe(
    "落盘工具输出",
  );
  expect((await runtime.listSessions()).find((s) => s.id === id)).toMatchObject({
    forkedFrom: { sessionId: source.id, seq: original.at(-1)?.seq },
    firstText: "原标题",
  });
  await fork.rewind(image.seq, "files");
  expect(readFileSync(file, "utf8")).toBe("before\r\n");
  expect(source.durableEvents()).toEqual(original);
  await fork.close();
  await source.close();
}, 20_000);

it("中途分叉追加 conversation 回退，原会话不截断，关闭后的会话也可分叉", async () => {
  const { runtime, source } = await setup();
  const first = await internalSession(source).emit("message.user", {
    messageId: "one",
    content: [{ type: "text", text: "one" }],
  });
  const second = await internalSession(source).emit("message.user", {
    messageId: "two",
    content: [{ type: "text", text: "two" }],
  });
  const id = await runtime.forkSession(source.id, { targetSeq: second.seq });
  const fork = await runtime.resumeSession(id);
  expect(
    fork
      .state()
      .history.filter((e) => e.kind === "user")
      .map((e) => e.seq),
  ).toEqual([first.seq]);
  expect(fork.state().history.at(-1)).toMatchObject({
    kind: "note",
    text: expect.stringContaining("文件保持回退前"),
  });
  expect(fork.durableEvents().at(-1)).toMatchObject({
    type: "session.rewound",
    payload: { targetSeq: second.seq, mode: "conversation", files: [] },
  });
  expect(source.state().history.filter((e) => e.kind === "user")).toHaveLength(2);
  await expect(runtime.forkSession(id, { targetSeq: second.seq })).rejects.toMatchObject({
    code: "invalid_command",
  });
  await fork.close();
  await source.close();
  const closedFork = await runtime.forkSession(source.id);
  const reopened = await runtime.resumeSession(closedFork);
  expect(reopened.state().history.filter((e) => e.kind === "user")).toHaveLength(2);
  await reopened.close();
}, 20_000);

it("Turn 进行中与非法分叉点拒绝操作", async () => {
  const { runtime, source } = await setup(new FakeProvider({ scripts: [[{ type: "wait" }]] }));
  await expect(runtime.forkSession(source.id, { targetSeq: 1 })).rejects.toMatchObject({
    code: "invalid_command",
  });
  const pending = source.submit({ text: "wait" });
  await expect(runtime.forkSession(source.id)).rejects.toMatchObject({ code: "session_busy" });
  source.interrupt();
  await pending;
  await source.close();
}, 20_000);
