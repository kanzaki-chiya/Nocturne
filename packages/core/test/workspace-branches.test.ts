import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

it("pumps inputs queued while a branch switch is running after the switch finishes or fails", async () => {
  const root = repository();
  const hooks = temp();
  const gate = path.join(hooks, "hold");
  const fail = path.join(hooks, "fail");
  const hook = path.join(hooks, "post-checkout");
  writeFileSync(
    hook,
    `#!/bin/sh\nwhile [ -f "${gate.replace(/\\/g, "/")}" ]; do sleep 0.05; done\n[ ! -f "${fail.replace(/\\/g, "/")}" ]\n`,
  );
  chmodSync(hook, 0o755);
  git(root, "config", "core.hooksPath", hooks);
  let parentCalls = 0;
  let childCalls = 0;
  const provider = new FakeProvider({
    handler: (request) => {
      if (request.tools.some((tool) => tool.name === "finish")) {
        const id = ++childCalls;
        return [
          { type: "wait", ms: 80 },
          {
            type: "tool_call",
            toolCallId: `finished-${id}`,
            name: "finish",
            input: { result: `bg-${id}` },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (parentCalls === 0 || parentCalls === 2) {
        parentCalls++;
        return [
          {
            type: "tool_call",
            toolCallId: `task-${parentCalls}`,
            name: "task",
            input: { task: "isolated", preset: "explore", background: true, isolation: "worktree" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      parentCalls++;
      return [
        { type: "text_delta", text: "delivered" },
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
  let turnIdle = true;
  session.subscribe((event) => {
    if (event.type === "turn.started") turnIdle = false;
    if (event.type === "runtime.status" && event.payload.status === "idle") turnIdle = true;
  });
  const delivered = (marker: string) =>
    turnIdle &&
    session.pendingInputs().items.length === 0 &&
    session.state().openTurn === undefined &&
    session
      .state()
      .history.some((e) => e.kind === "user" && JSON.stringify(e.content).includes(marker));
  const waitForDelivered = (marker: string) =>
    new Promise<void>((resolve) => {
      if (delivered(marker)) {
        resolve();
        return;
      }
      const off = session.subscribe(() => {
        if (delivered(marker)) {
          off();
          resolve();
        }
      });
    });
  await session.submit({ text: "launch-success" });
  writeFileSync(gate, "1");
  const switching = rt.switchBranch({
    workspace: root,
    branch: "queued-during-success",
    create: true,
  });
  for (let i = 0; i < 40 && session.pendingInputs().items.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 40));
  expect(session.pendingInputs().items).toHaveLength(1);
  rmSync(gate);
  await switching;
  await waitForDelivered("bg-1");
  expect(session.pendingInputs().items).toHaveLength(0);
  expect(delivered("bg-1")).toBe(true);
  await session.submit({ text: "launch-failure" });
  writeFileSync(gate, "1");
  writeFileSync(fail, "1");
  const failing = rt.switchBranch({
    workspace: root,
    branch: "queued-during-failure",
    create: true,
  });
  for (let i = 0; i < 40 && session.pendingInputs().items.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 40));
  expect(session.pendingInputs().items).toHaveLength(1);
  rmSync(gate);
  await expect(failing).rejects.toThrow();
  await waitForDelivered("bg-2");
  expect(session.pendingInputs().items).toHaveLength(0);
  expect(delivered("bg-2")).toBe(true);
  await session.close();
});

it("createSession with branch reuses or creates <repo>-wt/<branch> worktree without changing project directory HEAD or files (ADR-0085)", async () => {
  const base = realpathSync.native(temp());
  const root = path.join(base, "myrepo");
  mkdirSync(path.join(root, "sub"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(path.join(root, "file.txt"), "main-v1\n");
  writeFileSync(path.join(root, "sub", "nested.txt"), "nested-main\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial main");
  const mainCommit1 = git(root, "rev-parse", "HEAD");

  // 建立已有分支 feat/occupied（已检出在其他工作树）和 fix/unoccupied（未检出）
  git(root, "branch", "feat/occupied");
  git(root, "branch", "fix/unoccupied");
  const occupiedWt = path.join(base, "occupied-wt");
  git(root, "worktree", "add", "-q", occupiedWt, "feat/occupied");

  // 在 main 上再提交一次，使 main 的 HEAD 与旧分支不同，并在工作区留未提交改动
  writeFileSync(path.join(root, "file.txt"), "main-v2\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "second main");
  const mainCommit2 = git(root, "rev-parse", "HEAD");
  expect(mainCommit2).not.toBe(mainCommit1);
  writeFileSync(path.join(root, "file.txt"), "main-dirty-working-tree\n");

  const rt = await runtime(root);

  // 1. 选当前分支：不建工作树，没有 worktree 记录
  const sCurrent = await rt.createSession({
    model: "fake/fake-1",
    cwd: root,
    workspaceRoot: root,
    branch: { name: "main" },
  });
  expect(sCurrent.state().config.worktree).toBeUndefined();
  expect(
    internalSession(sCurrent)
      .durableEvents()
      .some((e) => e.type === "session.config_changed" && e.payload.worktree !== undefined),
  ).toBe(false);
  await sCurrent.close();

  // 2. 选已在工作树检出的分支（且项目目录是子目录 sub）：映射到该工作树对应的子目录
  const sOccupied = await rt.createSession({
    model: "fake/fake-1",
    cwd: path.join(root, "sub"),
    workspaceRoot: root,
    branch: { name: "feat/occupied" },
  });
  expect(sOccupied.state().meta.cwd.toLowerCase()).toBe(path.join(root, "sub").toLowerCase());
  expect(sOccupied.state().meta.workspaceRoot.toLowerCase()).toBe(root.toLowerCase());
  expect(sOccupied.state().config.worktree?.current.toLowerCase()).toBe(
    path.join(occupiedWt, "sub").toLowerCase(),
  );
  expect(sOccupied.state().config.branch).toBe("feat/occupied");
  await sOccupied.close();

  // 3. 选已有未检出分支：在 <repo>-wt/<branch（/ 换 -）> 建出工作树
  const expectedUnoccupiedWt = path.join(base, "myrepo-wt", "fix-unoccupied");
  const sUnoccupied = await rt.createSession({
    model: "fake/fake-1",
    cwd: root,
    workspaceRoot: root,
    branch: { name: "fix/unoccupied" },
  });
  expect(sUnoccupied.state().config.worktree?.current.toLowerCase()).toBe(
    expectedUnoccupiedWt.toLowerCase(),
  );
  expect(git(expectedUnoccupiedWt, "branch", "--show-current")).toBe("fix/unoccupied");
  expect(git(expectedUnoccupiedWt, "rev-parse", "HEAD")).toBe(mainCommit1);
  await sUnoccupied.close();

  // 4. 新建分支：基准是 main 的提交；/ 换成 -
  // 先把主目录切到 fix/other（先临时建工作树不能占 main，所以在主目录直接检出新分支再测 main 基准）
  git(root, "checkout", "-qb", "working-branch");
  writeFileSync(path.join(root, "working.txt"), "on-working\n");
  git(root, "add", "working.txt");
  git(root, "commit", "-qm", "working commit");
  const workingCommit = git(root, "rev-parse", "HEAD");
  expect(workingCommit).not.toBe(mainCommit2);
  writeFileSync(path.join(root, "file.txt"), "still-dirty\n");

  const expectedCreatedWt = path.join(base, "myrepo-wt", "feat-new-branch");
  const sCreated = await rt.createSession({
    model: "fake/fake-1",
    cwd: root,
    workspaceRoot: root,
    branch: { name: "feat/new-branch", create: true },
  });
  expect(sCreated.state().config.worktree?.current.toLowerCase()).toBe(
    expectedCreatedWt.toLowerCase(),
  );
  expect(git(expectedCreatedWt, "branch", "--show-current")).toBe("feat/new-branch");
  // 新建分支基准是 main（mainCommit2），而不是当前 working-branch（workingCommit）
  expect(git(expectedCreatedWt, "rev-parse", "HEAD")).toBe(mainCommit2);
  await sCreated.close();

  // 5. 目标目录已存在且不是该分支的工作树：报错，目录原样保留
  git(root, "branch", "feat/conflict");
  const conflictDir = path.join(base, "myrepo-wt", "feat-conflict");
  mkdirSync(conflictDir, { recursive: true });
  writeFileSync(path.join(conflictDir, "keep.txt"), "do-not-touch\n");
  await expect(
    rt.createSession({
      model: "fake/fake-1",
      cwd: root,
      workspaceRoot: root,
      branch: { name: "feat/conflict" },
    }),
  ).rejects.toThrow(/已存在/);
  expect(readFileSync(path.join(conflictDir, "keep.txt"), "utf8")).toBe("do-not-touch\n");

  // 全程项目目录的 HEAD 和工作区文件不变
  expect(git(root, "branch", "--show-current")).toBe("working-branch");
  expect(git(root, "rev-parse", "HEAD")).toBe(workingCommit);
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("still-dirty\n");
});

it("createSession branch creation resolves base ref via origin/HEAD or master when main is absent, and rejects when none exists (ADR-0085)", async () => {
  const base = realpathSync.native(temp());
  const root = path.join(base, "nomain");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "trunk");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  writeFileSync(path.join(root, "a.txt"), "trunk\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "trunk commit");
  const trunkCommit = git(root, "rev-parse", "HEAD");

  const rt = await runtime(root);
  // 既无 main、又无 origin/HEAD、也无 master：defaultBranch 为 null，拒绝新建
  expect((await rt.workspaceBranches({ workspace: root })).defaultBranch).toBeNull();
  await expect(
    rt.createSession({
      model: "fake/fake-1",
      cwd: root,
      workspaceRoot: root,
      branch: { name: "feat/no-base", create: true },
    }),
  ).rejects.toThrow(/基准分支/);

  // 设置 refs/remotes/origin/HEAD -> refs/remotes/origin/trunk：按 origin/HEAD 解析到 trunk
  git(root, "update-ref", "refs/remotes/origin/trunk", trunkCommit);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect((await rt.workspaceBranches({ workspace: root })).defaultBranch).toBe("trunk");
  const sOrigin = await rt.createSession({
    model: "fake/fake-1",
    cwd: root,
    workspaceRoot: root,
    branch: { name: "feat/from-origin-head", create: true },
  });
  expect(git(path.join(base, "nomain-wt", "feat-from-origin-head"), "rev-parse", "HEAD")).toBe(
    trunkCommit,
  );
  await sOrigin.close();

  // 移除 origin/HEAD，但存在本地 master 分支：回退到 master
  git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  git(root, "branch", "master", trunkCommit);
  expect((await rt.workspaceBranches({ workspace: root })).defaultBranch).toBe("master");
  const sMaster = await rt.createSession({
    model: "fake/fake-1",
    cwd: root,
    workspaceRoot: root,
    branch: { name: "feat/from-master", create: true },
  });
  expect(git(path.join(base, "nomain-wt", "feat-from-master"), "rev-parse", "HEAD")).toBe(
    trunkCommit,
  );
  await sMaster.close();
});
