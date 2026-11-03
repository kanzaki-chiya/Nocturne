import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider } from "../src/index.js";
import { internalSession } from "./internal-session.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(path.join(tmpdir(), "nct-branches-"));
  roots.push(root);
  return root;
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
function repository() {
  const root = temp();
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(path.join(root, "file.txt"), "first\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "initial");
  return root;
}
async function runtime(root: string, provider = new FakeProvider({})) {
  return createRuntime({
    cwd: root,
    sessionsDir: temp(),
    providers: [provider],
    subagent: { enabled: false },
  });
}

it("lists local branches, detached HEAD, worktree occupancy and an absent repository", async () => {
  const root = repository();
  const rt = await runtime(root);
  const main = git(root, "branch", "--show-current");
  expect(await rt.workspaceBranches({ workspace: root })).toMatchObject({
    current: main,
    busy: false,
  });
  expect(
    (await rt.workspaceBranches({ workspace: root })).branches.find((b) => b.name === main)
      ?.worktree,
  ).toBeUndefined();
  await rt.switchBranch({ workspace: root, branch: "feature", create: true });
  expect((await rt.workspaceBranches({ workspace: root })).branches.map((b) => b.name)).toContain(
    "feature",
  );
  const other = path.join(temp(), "占用 worktree");
  git(root, "worktree", "add", "-q", other, main);
  expect(
    (await rt.workspaceBranches({ workspace: root })).branches
      .find((b) => b.name === main)
      ?.worktree?.toLowerCase()
      .replaceAll("/", "\\"),
  ).toContain(path.basename(other).toLowerCase());
  await expect(rt.switchBranch({ workspace: root, branch: main })).rejects.toThrow();
  git(root, "checkout", "-q", "--detach");
  expect((await rt.workspaceBranches({ workspace: root })).current).toBe(
    git(root, "rev-parse", "--short=8", "HEAD"),
  );
  expect(await rt.workspaceBranches({ workspace: temp() })).toEqual({
    current: null,
    branches: [],
    busy: false,
  });
});

it("validates names without a shell and leaves conflicting working files alone", async () => {
  const root = repository();
  const rt = await runtime(root);
  for (const branch of ["-x", "--force", "bad name", "..", "a..b", "@{-1}"])
    await expect(rt.switchBranch({ workspace: root, branch })).rejects.toThrow();
  await rt.switchBranch({ workspace: root, branch: "main;calc", create: true });
  expect(git(root, "branch", "--show-current")).toBe("main;calc");
  const main = git(root, "branch", "--list", "master").length ? "master" : "main";
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "changed");
  writeFileSync(path.join(root, "file.txt"), "dirty\n");
  await expect(rt.switchBranch({ workspace: root, branch: main })).rejects.toThrow();
  expect(git(root, "branch", "--show-current")).toBe("main;calc");
});

it("carries compatible uncommitted changes without creating a stash", async () => {
  const root = repository();
  const rt = await runtime(root);
  writeFileSync(path.join(root, "file.txt"), "uncommitted\n");
  const head = git(root, "rev-parse", "HEAD");
  await rt.switchBranch({ workspace: root, branch: "carry", create: true });
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "branch", "--show-current")).toBe("carry");
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("uncommitted\n");
  expect(git(root, "stash", "list")).toBe("");
});

it("records first observation silently, then an English note in the next raw model request; resume retains baseline", async () => {
  const root = repository();
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "first" });
  expect(session.state().history.filter((e) => e.kind === "note")).toHaveLength(0);
  expect(session.state().config.branch).toBe(git(root, "branch", "--show-current"));
  await rt.switchBranch({ workspace: root, branch: "next", create: true });
  await session.submit({ text: "second" });
  const notes = session.state().history.filter((e) => e.kind === "note");
  expect(notes).toHaveLength(1);
  expect(notes[0]?.text).toContain("File contents read earlier may now be outdated");
  expect(
    provider.requests
      .at(-1)
      ?.messages.some(
        (m) =>
          m.role === "user" &&
          JSON.stringify(m).includes("[Environment change] Git branch changed"),
      ),
  ).toBe(true);
  const id = session.id;
  await session.close();
  const resumed = await rt.resumeSession(id);
  expect(resumed.state().config.branch).toBe("next");
  await resumed.submit({ text: "third" });
  expect(resumed.state().history.filter((e) => e.kind === "note")).toHaveLength(1);
  await resumed.close();
  git(root, "switch", "-c", "offline");
  const offline = await rt.resumeSession(id);
  expect(offline.state().config.branch).toBe("next");
  await offline.submit({ text: "after offline switch" });
  expect(offline.state().config.branch).toBe("offline");
  expect(offline.state().history.filter((e) => e.kind === "note")).toHaveLength(2);
  expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(
    "Git branch changed from next to offline",
  );
  await offline.close();
});

it("blocks another session's running Turn and compaction, including nested workspace paths", async () => {
  const root = repository();
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "wait", ms: 3000 },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1", cwd: nested });
  const turn = session.submit({ text: "wait" });
  expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(true);
  await expect(
    rt.switchBranch({ workspace: root, branch: "next", create: true }),
  ).rejects.toMatchObject({ code: "session_busy" });
  session.interrupt();
  await turn;
  expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(false);
  await session.close();
});

it("rewind and fork rebuild the observation baseline from effective events", async () => {
  const root = repository();
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  const original = git(root, "branch", "--show-current");
  await session.submit({ text: "first" });
  const first = session.state().history.find((e) => e.kind === "user")?.seq;
  if (first === undefined) throw new Error("first message missing");
  await rt.switchBranch({ workspace: root, branch: "new", create: true });
  await session.submit({ text: "second" });
  expect(session.state().config.branch).toBe("new");
  const forkId = await rt.forkSession(session.id, { targetSeq: first });
  const fork = await rt.resumeSession(forkId);
  expect(fork.state().config.branch).toBe(original);
  await fork.submit({ text: "fork next" });
  expect(
    fork
      .state()
      .history.filter((e) => e.kind === "note" && e.text.startsWith("[Environment change]")),
  ).toHaveLength(1);
  await fork.close();
  await session.rewind(first, "conversation");
  expect(session.state().config.branch).toBe(original);
  await session.submit({ text: "after rewind" });
  expect(
    session
      .state()
      .history.filter((e) => e.kind === "note" && e.text.startsWith("[Environment change]")),
  ).toHaveLength(1);
  await session.close();
});

it("treats a manual summary as directory activity", async () => {
  const root = repository();
  const provider = new FakeProvider({
    handler: (_request, index) =>
      index === 0
        ? [
            { type: "text_delta", text: "seed" },
            { type: "finish", reason: "stop" },
          ]
        : [
            { type: "wait", ms: 3000 },
            { type: "text_delta", text: "summary" },
            { type: "finish", reason: "stop" },
          ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "seed" });
  const compacting = session.compact();
  expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(true);
  await expect(
    rt.switchBranch({ workspace: root, branch: "blocked", create: true }),
  ).rejects.toMatchObject({ code: "session_busy" });
  session.interrupt();
  await expect(compacting).rejects.toMatchObject({ code: "compaction_interrupted" });
  await session.close();
});

it("blocks switching while another session is still committing a rewind", async () => {
  const root = repository();
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "first" });
  const target = session.state().history.find((e) => e.kind === "user")?.seq;
  if (target === undefined) throw new Error("missing user message");
  const inner = internalSession(session);
  const emit = inner.emit.bind(inner);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spy = vi.spyOn(inner, "emit").mockImplementation(async (type, payload, options) => {
    if (type === "session.rewound") {
      started();
      await gate;
    }
    return emit(type, payload, options);
  });
  const rewind = session.rewind(target, "conversation");
  try {
    await entered;
    expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(true);
    await expect(
      rt.switchBranch({ workspace: root, branch: "blocked", create: true }),
    ).rejects.toMatchObject({ code: "session_busy" });
  } finally {
    release();
    await rewind;
    spy.mockRestore();
    await session.close();
  }
});

it("does not record branch observations or block a Turn outside Git", async () => {
  const root = temp();
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  expect(await session.submit({ text: "continue" })).toBe("done");
  expect(
    session
      .durableEvents()
      .filter((e) => e.type === "session.config_changed" && e.payload.branch !== undefined),
  ).toHaveLength(0);
  expect(session.state().history.filter((e) => e.kind === "note")).toHaveLength(0);
  await session.close();
});

it("keeps branch notes through L1 and uses the L2 summary boundary", async () => {
  const root = repository();
  const provider = new FakeProvider({
    handler: () => [
      { type: "text_delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ],
  });
  const rt = await runtime(root, provider);
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "first" });
  await rt.switchBranch({ workspace: root, branch: "next", create: true });
  await session.submit({ text: "second" });
  const note = session.state().history.find((e) => e.kind === "note")?.text;
  expect(note).toContain("[Environment change]");
  const end = session.durableEvents().findLast((e) => e.type === "turn.completed")?.seq;
  if (end === undefined) throw new Error("turn boundary missing");
  await internalSession(session).emit("context.compacted", { kind: "prune", throughSeq: end });
  await session.submit({ text: "after prune" });
  expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(note);
  const nextEnd = session.durableEvents().findLast((e) => e.type === "turn.completed")?.seq;
  if (nextEnd === undefined) throw new Error("turn boundary missing");
  await internalSession(session).emit("context.compacted", {
    kind: "summary",
    throughSeq: nextEnd,
    summary: "Summary: changed branch to next",
  });
  await session.submit({ text: "after summary" });
  const projected = JSON.stringify(provider.requests.at(-1)?.messages);
  expect(projected).toContain("Summary: changed branch to next");
  expect(projected).not.toContain(note);
  await session.close();
});

it("holds directory admission while git switch is still running", async () => {
  const root = repository();
  const hooks = temp();
  const hook = path.join(hooks, "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nsleep 1\n");
  chmodSync(hook, 0o755);
  git(root, "config", "core.hooksPath", hooks);
  const rt = await runtime(
    root,
    new FakeProvider({
      handler: () => [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    }),
  );
  const session = await rt.createSession({ model: "fake/fake-1" });
  const switching = rt.switchBranch({ workspace: root, branch: "slow", create: true });
  let observed = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    if ((await rt.workspaceBranches({ workspace: root })).busy) {
      observed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  expect(observed).toBe(true);
  await expect(session.submit({ text: "must not start during switch" })).rejects.toMatchObject({
    code: "session_busy",
  });
  await expect(
    rt.switchBranch({ workspace: root, branch: "other", create: true }),
  ).rejects.toMatchObject({ code: "session_busy" });
  await switching;
  await session.submit({ text: "now allowed" });
  await session.close();
});

it("blocks on a shared read-only background child after its parent Turn has ended", async () => {
  const root = repository();
  let parentCalls = 0;
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((tool) => tool.name === "finish"))
        return [
          { type: "wait", ms: 1200 },
          { type: "tool_call", toolCallId: "finished", name: "finish", input: { result: "done" } },
          { type: "finish", reason: "tool_calls" },
        ];
      if (parentCalls++ === 0)
        return [
          {
            type: "tool_call",
            toolCallId: "task",
            name: "task",
            input: { task: "read-only", preset: "explore", background: true },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const rt = await createRuntime({
    cwd: root,
    sessionsDir: temp(),
    providers: [provider],
    subagent: { background: true },
    permissions: { autoApproveAsk: true },
  });
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "launch" });
  expect(session.state().openTurn).toBeUndefined();
  expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(true);
  await expect(
    rt.switchBranch({ workspace: root, branch: "blocked", create: true }),
  ).rejects.toMatchObject({ code: "session_busy" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await session.close();
});

it("does not block the parent repository for an isolated background worktree", async () => {
  const root = repository();
  let parentCalls = 0;
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((tool) => tool.name === "finish"))
        return [
          { type: "wait", ms: 1200 },
          { type: "tool_call", toolCallId: "finished", name: "finish", input: { result: "done" } },
          { type: "finish", reason: "tool_calls" },
        ];
      if (parentCalls++ === 0)
        return [
          {
            type: "tool_call",
            toolCallId: "task",
            name: "task",
            input: { task: "isolated", preset: "explore", background: true, isolation: "worktree" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const rt = await createRuntime({
    cwd: root,
    sessionsDir: temp(),
    providers: [provider],
    subagent: { background: true },
    permissions: { autoApproveAsk: true },
  });
  const session = await rt.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "launch" });
  expect(
    (await rt.listSubagents({ parentSessionId: session.id })).some(
      (child) => child.state === "running",
    ),
  ).toBe(true);
  expect((await rt.workspaceBranches({ workspace: root })).busy).toBe(false);
  await rt.switchBranch({ workspace: root, branch: "independent", create: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await session.close();
});
