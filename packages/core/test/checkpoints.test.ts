import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider, type FakeScript } from "../src/provider/index.js";
import { decodeDurableEvent, replaySessionView } from "../src/protocol/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createSessionStore } from "../src/session/index.js";
import { createCheckpointRecorder } from "../src/session/checkpoints.js";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-checkpoints-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const write = (content: string): FakeScript => [
  { type: "tool_call", toolCallId: content, name: "write", input: { path: "a.txt", content } },
  { type: "finish", reason: "tool_calls" },
];
const done: FakeScript = [
  { type: "text_delta", text: "done" },
  { type: "finish", reason: "stop" },
];

it("每轮每路径只记最初 before，每次执行都记 after；原始字节落盘且不进入历史或视图", async () => {
  const cwd = temp();
  const sessionsDir = temp();
  writeFileSync(path.join(cwd, "a.txt"), "old\r\n");
  const runtime = await createRuntime({
    cwd,
    sessionsDir,
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "tool_call", toolCallId: "read", name: "read", input: { path: "a.txt" } },
            { type: "finish", reason: "tool_calls" },
          ],
          write("one"),
          write("two"),
          done,
          write("three"),
          done,
        ],
      }),
    ],
    permissions: { autoApproveAsk: true },
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "first" });
  await session.submit({ text: "second" });
  const events = session.durableEvents();
  const checkpoints = events.filter((e) => e.type === "checkpoint.file");
  expect(checkpoints.map((e) => e.payload.phase)).toEqual([
    "before",
    "after",
    "after",
    "before",
    "after",
  ]);
  expect(checkpoints[0]?.payload).toMatchObject({ before: { sha256: hash("old\r\n"), size: 5 } });
  expect(checkpoints[3]?.payload).toMatchObject({ before: { sha256: hash("two"), size: 3 } });
  expect(
    readFileSync(path.join(sessionsDir, "checkpoints", session.id, hash("old\r\n")), "utf8"),
  ).toBe("old\r\n");
  expect(replaySessionView(events).entries).toEqual(
    replaySessionView(events.filter((e) => e.type !== "checkpoint.file")).entries,
  );
  const state = session.state();
  expect(state.history).toHaveLength(
    events.filter((e) =>
      ["message.user", "message.assistant", "tool.completed", "context.compacted"].includes(e.type),
    ).length,
  );
  const id = session.id;
  await session.close();
  const resumed = await runtime.resumeSession(id);
  expect(resumed.state().history).toEqual(state.history);
  await resumed.close();
}, 20_000);

it("不存在的文件记 null；目录、大文件、读取失败给出 checkpoint_untracked 并继续记录", async () => {
  const cwd = temp();
  const sessionsDir = temp();
  const platform = createPlatform();
  const session = await createSessionStore({ platform, sessionsDir }).create({
    cwd,
    workspaceRoot: cwd,
    model: { provider: "fake", model: "fake-1" },
    permissionPreset: "default",
    nocturneVersion: "test",
  });
  const warnings: string[] = [];
  session.subscribe((e) => {
    if (e.type === "runtime.warning") warnings.push(e.payload.code);
  });
  const record = createCheckpointRecorder(session, platform, sessionsDir);
  writeFileSync(path.join(cwd, "big"), Buffer.alloc(10 * 1024 * 1024 + 1));
  for (const target of [path.join(cwd, "new"), cwd, path.join(cwd, "big")])
    await record("before", "c", [{ kind: "edit", target }], session.id);
  const original = platform.fs.readFile;
  platform.fs.readFile = async () => {
    throw new Error("read failed");
  };
  writeFileSync(path.join(cwd, "bad"), "x");
  await record("before", "c", [{ kind: "edit", target: path.join(cwd, "bad") }], session.id);
  platform.fs.readFile = original;
  expect(warnings).toEqual([
    "checkpoint_untracked",
    "checkpoint_untracked",
    "checkpoint_untracked",
  ]);
  expect(
    session
      .durableEvents()
      .filter((e) => e.type === "checkpoint.file")
      .map((e) => (e.payload.phase === "before" ? e.payload.before : undefined)),
  ).toEqual([
    null,
    { untracked: "不是普通文件" },
    { untracked: "文件超过 10MB" },
    { untracked: "read failed" },
  ]);
  await session.close();
});

it("子代理编辑的检查点只进入根日志，指明来源并共用根轮次的 before", async () => {
  const cwd = temp();
  const sessionsDir = temp();
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "tool_call", toolCallId: "task", name: "task", input: { task: "write a.txt" } },
        { type: "finish", reason: "tool_calls" },
      ],
      write("child"),
      [
        { type: "tool_call", toolCallId: "finish", name: "finish", input: { result: "done" } },
        { type: "finish", reason: "tool_calls" },
      ],
      write("parent"),
      done,
    ],
  });
  const runtime = await createRuntime({
    cwd,
    sessionsDir,
    providers: [provider],
    permissions: { autoApproveAsk: true },
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "go" });
  const checkpoints = session.durableEvents().filter((e) => e.type === "checkpoint.file");
  expect(checkpoints.map((e) => e.payload.phase)).toEqual(["before", "after", "after"]);
  const childId = checkpoints[0]?.payload.sessionId;
  expect(childId).toBeTruthy();
  const childEvents = readFileSync(path.join(sessionsDir, `${childId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map(decodeDurableEvent);
  expect(childEvents.some((e) => e.type === "checkpoint.file")).toBe(false);
  expect(checkpoints[0]?.payload).toMatchObject({ before: null });
  await session.close();
});
