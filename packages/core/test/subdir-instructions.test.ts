import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type FakeScript, type Runtime } from "../src/index.js";
import { buildContext, estimateTokens } from "../src/context/index.js";
import { decodeDurableEvent, replaySessionView } from "../src/protocol/index.js";
import type { ModelMessage } from "../src/provider/index.js";
import { internalSession } from "./internal-session.js";

const MODEL = "fake/fake-model";
const INTRO =
  "Project instructions for a directory you just accessed. They apply to files under that directory and take precedence over default practices:";
const roots: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tool = (name: string, input: unknown): FakeScript[number] => ({
  type: "tool_call",
  toolCallId: name + JSON.stringify(input),
  name,
  input,
});
const read = (file: string) => tool("read", { path: file });
const call = (...calls: FakeScript): FakeScript => [
  ...calls,
  { type: "finish", reason: "tool_calls" },
];
const answer = (text = "done"): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];
const userTexts = (messages: readonly ModelMessage[]) =>
  messages.flatMap((m) => (m.role === "user" ? m.content.map((block) => block.text) : []));
const notes = (messages: readonly ModelMessage[]) =>
  userTexts(messages).filter((text) => text.startsWith(INTRO));
const block = (source: string, content: string) =>
  `<instructions source="${source}">\n${content}\n</instructions>`;

async function fixture(
  provider: FakeProvider,
  files: Record<string, string | Uint8Array> = {},
  cwd = "",
) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-subdir-instructions-"));
  roots.push(root);
  const workspace = path.join(root, "repo");
  const write = (relative: string, text: string | Uint8Array) => {
    const file = path.join(workspace, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write("AGENTS.md", "ROOT_MARKER");
  for (const [relative, text] of Object.entries(files)) write(relative, text);
  vi.stubEnv("NOCTURNE_HOME", path.join(root, "home"));
  const openRuntime = async () => {
    const runtime = await createRuntime({
      cwd: path.join(workspace, cwd),
      workspaceRoot: workspace,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = await openRuntime();
  const session = await runtime.createSession({ model: MODEL, permissionPreset: "bypass" });
  return { runtime, session, provider, write, openRuntime };
}

it("loads approved file and directory subjects once, top-down and after all tool results", async () => {
  const provider = new FakeProvider({
    scripts: [
      call(read("a/src/x.ts"), tool("glob", { path: "b", pattern: "*.ts" })),
      answer(),
      call(
        read("a/src/y.ts"),
        read("../../outside/x.ts"),
        read("fail/missing.ts"),
        read("invalid/x.ts"),
      ),
      answer(),
    ],
  });
  const { session } = await fixture(
    provider,
    {
      "pkg/AGENTS.md": "PKG",
      "pkg/a/AGENTS.md": "A",
      "pkg/a/src/AGENTS.md": "SRC",
      "pkg/a/src/x.ts": "x",
      "pkg/a/src/y.ts": "y",
      "pkg/b/AGENTS.md": "B",
      "pkg/b/x.ts": "b",
      "../outside/AGENTS.md": "OUTSIDE",
      "../outside/x.ts": "outside",
      "pkg/fail/AGENTS.md": "FAILED",
      "pkg/invalid/AGENTS.md": Uint8Array.of(0xff),
      "pkg/invalid/x.ts": "invalid instructions",
    },
    "pkg",
  );
  // Paths from the model are relative to cwd, but starting instructions include repo/ and pkg/.
  await session.submit({ text: "load two paths" });
  await session.submit({ text: "revisit and try invalid targets" });
  const projection = provider.requests[1];
  expect(projection?.system.map((b) => b.text).join("\n")).toContain("ROOT_MARKER");
  expect(projection?.system.map((b) => b.text).join("\n")).toContain("PKG");
  const expected = [
    `${INTRO}\n${block("pkg/a/AGENTS.md", "A")}\n${block("pkg/a/src/AGENTS.md", "SRC")}`,
    `${INTRO}\n${block("pkg/b/AGENTS.md", "B")}`,
  ];
  expect(notes(projection?.messages ?? [])).toEqual(expected);
  expect(projection?.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "user",
    "user",
  ]);
  expect(notes(provider.requests[3]?.messages ?? [])).toEqual(expected);
  const events = session.durableEvents();
  const loaded = events.filter((e) => e.type === "instructions.loaded");
  expect(loaded.map((e) => events.find((prev) => prev.seq === e.seq - 1)?.type)).toEqual([
    "tool.completed",
    "tool.completed",
  ]);
  expect(replaySessionView(events).entries.some((e) => JSON.stringify(e).includes(INTRO))).toBe(
    false,
  );
});

it("truncates a UTF-8 file and records each skipped source after the session budget is reached", async () => {
  const provider = new FakeProvider({
    scripts: [call(read("a/b/c/x.ts")), answer(), call(read("a/b/c/d/x.ts")), answer()],
  });
  const { session } = await fixture(provider, {
    "a/AGENTS.md": "a".repeat(65535) + "界",
    "a/b/AGENTS.md": "b".repeat(65536),
    "a/b/c/AGENTS.md": "too large for the remaining byte",
    "a/b/c/x.ts": "x",
    "a/b/c/d/AGENTS.md": "d",
    "a/b/c/d/x.ts": "x",
  });
  await session.submit({ text: "fill budget" });
  await session.submit({ text: "load another" });
  const loaded = session.durableEvents().filter((e) => e.type === "instructions.loaded");
  expect(loaded.map((e) => e.payload.skipped)).toEqual([
    ["a/b/c/AGENTS.md"],
    ["a/b/c/d/AGENTS.md"],
  ]);
  expect(loaded[0]?.payload.files.map((f) => [f.source, f.content.length, f.truncated])).toEqual([
    ["a/AGENTS.md", 65535, true],
    ["a/b/AGENTS.md", 65536, undefined],
  ]);
  expect(loaded[1]?.payload.files).toEqual([]);
  const firstNote = notes(provider.requests[1]?.messages ?? [])[0];
  expect(firstNote?.split("\n").slice(0, 3)).toEqual([
    INTRO,
    'Skipped (session instruction limit reached): "a/b/c/AGENTS.md"',
    '<instructions source="a/AGENTS.md">',
  ]);
  expect(firstNote).toContain("[Truncated at the 64 KiB instruction file limit]");
});

it("keeps L1 instructions in user history and moves the L2 snapshot before the notes and todos", async () => {
  const provider = new FakeProvider({
    scripts: [
      call(
        read("z/x.ts"),
        read("a/x.ts"),
        tool("note_write", { add: ["note fact"] }),
        tool("todo_write", { items: [{ text: "finish later", status: "pending" }] }),
      ),
      answer(),
      answer("Fixture summary"),
      call(read("new/x.ts")),
      answer(),
    ],
  });
  const { session } = await fixture(provider, {
    "z/AGENTS.md": "Z",
    "z/x.ts": "z",
    "a/AGENTS.md": "A",
    "a/x.ts": "a",
    "new/AGENTS.md": "NEW",
    "new/x.ts": "new",
  });
  await session.submit({ text: "instructions and state" });
  const initial = session.describeContext();
  expect(initial.report.sections.some((s) => s.name === "subdirInstructions")).toBe(false);
  const closed = session.durableEvents().at(-1);
  if (closed?.type !== "turn.completed") throw new Error("Expected a closed turn");
  await internalSession(session).emit("context.compacted", {
    kind: "prune",
    throughSeq: closed.seq,
  });
  const pruned = session.describeContext();
  expect(notes(pruned.request.messages)).toEqual(notes(initial.request.messages));
  expect(pruned.report.sections.find((s) => s.name === "history")?.breakdown?.user).toEqual(
    initial.report.sections.find((s) => s.name === "history")?.breakdown?.user,
  );
  await session.compact();
  const compacted = session.describeContext();
  const expected = `${INTRO}\n${block("a/AGENTS.md", "A")}\n${block("z/AGENTS.md", "Z")}`;
  const texts = userTexts(compacted.request.messages);
  expect(texts[0]).toContain("Fixture summary");
  expect(texts[1]).toBe(expected);
  expect(texts[2]).toContain("note fact");
  expect(texts[3]).toContain("finish later");
  expect(notes(compacted.request.messages)).toEqual([expected]);
  expect(compacted.report.sections.find((s) => s.name === "subdirInstructions")).toEqual({
    name: "subdirInstructions",
    source: "a/AGENTS.md, z/AGENTS.md",
    chars: expected.length,
    estimatedTokens: estimateTokens(expected),
  });
  await session.submit({ text: "another directory" });
  expect(notes(provider.requests.at(-1)?.messages ?? [])).toEqual([
    expected,
    `${INTRO}\n${block("new/AGENTS.md", "NEW")}`,
  ]);
  expect(
    session.describeContext().report.sections.find((s) => s.name === "subdirInstructions")?.source,
  ).toBe("a/AGENTS.md, z/AGENTS.md");
});

it("restores the snapshot from disk, inherits it in a fork, and reads again after rewind", async () => {
  const provider = new FakeProvider({
    scripts: [
      call(read("a/x.ts")),
      answer(),
      call(read("a/x.ts")),
      answer(),
      call(read("a/x.ts")),
      answer(),
    ],
  });
  const { session, runtime, openRuntime, write } = await fixture(provider, {
    "a/AGENTS.md": "BEFORE",
    "a/x.ts": "x",
  });
  await session.submit({ text: "first access" });
  const target = session.durableEvents().find((e) => e.type === "message.user");
  if (target === undefined) throw new Error("Missing rewind target");
  const forkId = await runtime.forkSession(session.id);
  write("a/AGENTS.md", "AFTER");
  await session.close();
  const reopenedRuntime = await openRuntime();
  const reopened = await reopenedRuntime.resumeSession(session.id);
  const expected = `${INTRO}\n${block("a/AGENTS.md", "BEFORE")}`;
  expect(notes(reopened.describeContext().request.messages)).toEqual([expected]);
  const fork = await reopenedRuntime.resumeSession(forkId);
  await fork.submit({ text: "read in fork" });
  expect(notes(provider.requests[3]?.messages ?? [])).toEqual([expected]);
  expect(fork.durableEvents().filter((e) => e.type === "instructions.loaded")).toHaveLength(1);
  await reopened.rewind(target.seq, "conversation");
  expect(notes(reopened.describeContext().request.messages)).toEqual([]);
  await reopened.submit({ text: "read again" });
  expect(notes(provider.requests[5]?.messages ?? [])).toEqual([
    `${INTRO}\n${block("a/AGENTS.md", "AFTER")}`,
  ]);
});

it("loads instructions in a task child with its own history", async () => {
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((t) => t.name === "finish")) {
        return notes(request.messages).length
          ? call(tool("finish", { result: "child read instructions" }))
          : call(read("a/x.ts"));
      }
      return request.messages.some((m) => m.role === "tool")
        ? answer()
        : call(tool("task", { task: "Read file", preset: "explore" }));
    },
  });
  const { session } = await fixture(provider, { "a/AGENTS.md": "CHILD", "a/x.ts": "x" });
  await session.submit({ text: "delegate a read" });
  expect(notes(provider.requests[2]?.messages ?? [])).toEqual([
    `${INTRO}\n${block("a/AGENTS.md", "CHILD")}`,
  ]);
  expect(notes(provider.requests.at(-1)?.messages ?? [])).toEqual([]);
  expect(session.durableEvents().some((e) => e.type === "instructions.loaded")).toBe(false);
  const completion = session
    .durableEvents()
    .filter((e) => e.type === "tool.completed")
    .find((e) => e.payload.name === "task");
  expect(completion?.payload.status).toBe("ok");
});

it("decodes instruction snapshots with additive fields and keeps an old log request byte-for-byte", () => {
  expect(
    decodeDurableEvent(
      JSON.stringify({
        type: "instructions.loaded",
        seq: 2,
        time: "2026-11-24T00:00:00Z",
        sessionId: "id",
        turnId: "turn",
        payload: { files: [{ source: "a/AGENTS.md", content: "A", future: true }], future: true },
      }),
    ).payload,
  ).toEqual({ files: [{ source: "a/AGENTS.md", content: "A" }] });
  const model = new FakeProvider({}).models()[0];
  if (model === undefined) throw new Error("Missing fake model");
  const event = decodeDurableEvent(
    '{"type":"message.user","seq":2,"time":"2026-11-24T00:00:00Z","sessionId":"id","turnId":"turn","payload":{"messageId":"u","content":[{"type":"text","text":"hello"}]}}',
  );
  if (event.type !== "message.user") throw new Error("Expected old user event");
  const built = buildContext({
    history: [
      {
        kind: "user",
        turnId: "turn",
        seq: event.seq,
        messageId: event.payload.messageId,
        content: event.payload.content,
      },
    ],
    events: [event],
    model,
    tools: [],
    instructions: { project: [] },
    basePrompt: "base",
    environment: { os: "test", cwd: "/repo", workspaceRoot: "/repo", sessionDate: "2026-11-24" },
  });
  expect(JSON.stringify(built.request.messages)).toBe(
    '[{"role":"user","content":[{"type":"text","text":"hello"}]}]',
  );
  expect(built.report.sections.map((s) => s.name)).toEqual([
    "system",
    "tools",
    "environment",
    "history",
  ]);
});
