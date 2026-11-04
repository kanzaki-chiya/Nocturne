import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import * as workspaceBranches from "../src/platform/workspace-branches.js";
import { createPlatform, createRuntime, FakeProvider, loadConfig } from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

import { createRulePolicy, grantFromSubject } from "../src/permission/index.js";

it("sibling read notice preserves deny, ask and Grant decisions from the permission policy", async () => {
  const f = fixture();
  const subject = {
    kind: "read" as const,
    target: path.join(f.project, "file.txt"),
    resolved: path.join(f.project, "file.txt"),
  };
  const session = {
    cwd: f.worktree,
    worktrees: { current: f.worktree, roots: await workspaceBranches.gitWorktrees(f.project) },
  };
  const base = { workspaceRoot: f.worktree, caseSensitive: false };
  const blocked = createRulePolicy({
    ...base,
    preset: "bypass",
    rules: [{ origin: "user", rule: { kind: "read", pattern: "**", action: "deny" } }],
  });
  expect(blocked.evaluate([subject], { session }).decision.action).toBe("deny");
  const asking = createRulePolicy({ ...base, preset: "default" });
  expect(asking.evaluate([subject], { session }).decision.action).toBe("ask");
  const granted = createRulePolicy({
    ...base,
    preset: "default",
    grants: {
      project: [grantFromSubject(subject, false, "2026-11-04T00:00:00.000Z")],
    },
  });
  const result = granted.evaluate([subject], { session });
  expect(result.decision.source).toBe("grant");
  expect(result.resultNotice).toContain(f.worktree);
});

it("nested worktrees use the most specific worktree root for current and target paths", async () => {
  const f = fixture();
  const nested = path.join(f.project, "trees", "nested");
  git(f.project, "worktree", "add", "-qb", "nested", nested);
  const policy = createRulePolicy({
    workspaceRoot: nested,
    caseSensitive: false,
    preset: "bypass",
  });
  const worktrees = { current: nested, roots: await workspaceBranches.gitWorktrees(f.project) };
  const file = (root: string) => path.join(root, "file.txt");
  const check = (root: string) =>
    policy.evaluate([{ kind: "edit", target: file(root), resolved: file(root) }], {
      session: { cwd: nested, worktrees },
    });
  expect(check(nested).decision.action).toBe("allow");
  expect(check(f.project).decision.action).toBe("deny");
  expect(check(f.worktree).decision.action).toBe("deny");
});

it("switching keeps trusted project configuration and applies project Grants without importing worktree configuration", async () => {
  const f = fixture();
  const home = path.join(f.base, "home");
  const outside = path.join(f.base, "comparison.txt");
  writeFileSync(outside, "comparison\n");
  for (const directory of [f.project, f.worktree])
    mkdirSync(path.join(directory, ".nocturne"), { recursive: true });
  writeFileSync(
    path.join(f.project, ".nocturne", "config.json"),
    JSON.stringify({ compaction: { pruneLimit: 12345 } }),
  );
  writeFileSync(
    path.join(f.worktree, ".nocturne", "config.json"),
    JSON.stringify({ permissions: { rules: [{ kind: "read", pattern: "**", action: "deny" }] } }),
  );
  const cfg = await loadConfig(createPlatform(), { nocturneHome: home });
  await cfg.setWorkspaceTrusted(f.project, true);
  const workspace = await cfg.forWorkspace(f.project);
  await workspace.grants.add(
    grantFromSubject(
      { kind: "read", target: outside, resolved: outside },
      process.platform !== "win32",
      "2026-11-04T00:00:00.000Z",
    ),
  );
  const provider = new FakeProvider({
    scripts: [
      [
        call("switch", "switch_worktree", { path: f.worktree }),
        call("comparison", "read", { path: outside }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    config: cfg,
    providers: [provider],
    interactive: true,
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "default" });
  const asks: string[] = [];
  s.subscribe((event) => {
    if (event.type === "permission.requested") {
      asks.push(event.payload.callId);
      void s.respondPermission(event.payload.requestId, { decision: "allow" });
    }
  });
  await s.submit({ text: "switch then compare" });
  expect(asks).toHaveLength(1);
  const read = replaySessionView(internalSession(s).durableEvents()).entries.find(
    (entry) => entry.kind === "tool" && entry.name === "read",
  );
  expect(read?.kind === "tool" && read.status).toBe("ok");
  expect(read?.kind === "tool" && read.permission?.source).toBe("grant");
  expect(workspace.projectConfig.trusted).toBe(true);
  expect(workspace.resolved.compactionPruneLimit).toBe(12345);
  expect(provider.requests[1]?.system).toEqual(provider.requests[0]?.system);
  await s.close();
});

it("file index and file resolution follow the mapped current subdirectory", async () => {
  const f = fixture();
  for (const root of [f.project, f.worktree])
    mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(f.worktree, "sub", "local.txt"), "local\n");
  const provider = new FakeProvider({
    scripts: [
      [
        call("sw", "switch_worktree", { path: f.worktree }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
      [
        call("parent-read", "read", { path: "../file.txt" }),
        call("parent-edit", "edit", { path: "../file.txt", old: "worktree", new: "modified" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "modified" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const rt = await createRuntime({
    cwd: path.join(f.project, "sub"),
    workspaceRoot: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s.submit({ text: "switch" });
  expect(await s.fileIndex()).toContainEqual(expect.objectContaining({ path: "local.txt" }));
  expect((await s.resolveFiles(["local.txt"]))[0]?.absolutePath).toBe(
    path.join(f.worktree, "sub", "local.txt"),
  );
  await s.submit({ text: "edit parent" });
  const editSeq = s.state().history.findLast((entry) => entry.kind === "user")?.seq ?? 1;
  rmSync(f.worktree, { recursive: true, force: true });
  const files = await s.rewind(editSeq, "files");
  expect(files.find((file) => file.path === path.join(f.worktree, "file.txt"))?.result).toBe(
    "failed",
  );
  expect(existsSync(f.worktree)).toBe(false);
  await s.close();
});

it("nested current worktree activity does not block switching the project branch", async () => {
  const f = fixture();
  const nested = path.join(f.project, "trees", "nested");
  git(f.project, "worktree", "add", "-qb", "nested", nested);
  let release: (() => void) | undefined;
  const provider = new FakeProvider({
    handler: async (_req, idx) => {
      if (idx === 0)
        return [
          call("sw", "switch_worktree", { path: nested }),
          { type: "finish", reason: "tool_calls" },
        ];
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  const running = s.submit({ text: "switch and hold" });
  try {
    for (let i = 0; i < 100 && release === undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(release).toBeDefined();
    expect((await rt.workspaceBranches({ workspace: f.project })).busy).toBe(false);
    expect((await rt.workspaceBranches({ workspace: nested })).busy).toBe(true);
  } finally {
    release?.();
    await running;
    await s.close();
  }
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
function fixture() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "nct-switch-")));
  roots.push(base);
  const project = path.join(base, "project");
  const worktree = path.join(base, "worktree");
  const sessionsDir = path.join(base, "sessions");
  mkdirSync(project);
  git(project, "init", "-q");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "core.autocrlf", "false");
  writeFileSync(path.join(project, "file.txt"), "project\n");
  git(project, "add", ".");
  git(project, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "initial");
  git(project, "worktree", "add", "-qb", "feature", worktree);
  writeFileSync(path.join(worktree, "file.txt"), "worktree\n");
  return { base, project, worktree, sessionsDir };
}
const call = (callId: string, name: string, input: unknown) => ({
  type: "tool_call" as const,
  toolCallId: callId,
  name,
  input,
});

it("current directory events route read edit shell and branch reads without changing project metadata or system bytes", async () => {
  const f = fixture();
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "text_delta", text: "seed" },
        { type: "finish", reason: "stop" },
      ],
      [
        call("read", "read", { path: "file.txt" }),
        call("edit", "edit", { path: "file.txt", old: "worktree", new: "edited" }),
        call("shell", "shell", { command: "git branch --show-current" }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s.submit({ text: "seed" });
  const system = provider.requests[0]?.system;
  const inner = internalSession(s);
  await inner.emit("session.config_changed", {
    worktree: { current: f.worktree, previous: f.project, branch: "feature" },
    branch: { current: "feature" },
  });
  await s.submit({ text: "operate" });
  expect(readFileSync(path.join(f.worktree, "file.txt"), "utf8")).toBe("edited\n");
  expect(readFileSync(path.join(f.project, "file.txt"), "utf8")).toBe("project\n");
  const tools = s.state().history.filter((e) => e.kind === "tool");
  expect(tools.find((e) => e.name === "read")?.modelContent).toContain("worktree");
  expect(tools.find((e) => e.name === "shell")?.modelContent).toContain("feature");
  expect(s.state().meta.cwd).toBe(f.project);
  expect(s.state().meta.workspaceRoot).toBe(f.project);
  expect(s.state().config.worktree?.current).toBe(f.worktree);
  const view = replaySessionView(inner.durableEvents());
  expect(view.currentCwd).toBe(f.worktree);
  expect(provider.requests[1]?.system).toEqual(system);
  expect(
    s.state().history.filter((e) => e.kind === "note" && e.text.includes("Git branch changed")),
  ).toHaveLength(0);
  await s.close();
});

it("switch_worktree validates repository worktrees, maps subdirectories, keeps project config and skills, updates batch scopes, and drives isolated subagent baseline and apply target", async () => {
  const f = fixture();
  mkdirSync(path.join(f.project, ".nocturne", "skills", "proj-skill"), { recursive: true });
  writeFileSync(
    path.join(f.project, ".nocturne", "skills", "proj-skill", "SKILL.md"),
    "---\nname: proj-skill\ndescription: project skill\n---\nProject body\n",
  );
  mkdirSync(path.join(f.worktree, ".nocturne", "skills", "wt-skill"), { recursive: true });
  writeFileSync(
    path.join(f.worktree, ".nocturne", "skills", "wt-skill", "SKILL.md"),
    "---\nname: wt-skill\ndescription: worktree skill\n---\nWorktree body\n",
  );
  mkdirSync(path.join(f.project, "packages", "sub"), { recursive: true });
  mkdirSync(path.join(f.worktree, "packages", "sub"), { recursive: true });
  writeFileSync(path.join(f.worktree, "packages", "sub", "item.txt"), "wt-sub\n");
  git(f.worktree, "add", ".");
  git(f.worktree, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "wt commit");
  const missingSub = path.join(f.base, "missing-sub");
  git(f.project, "worktree", "add", "-qb", "no-sub", missingSub);
  const isolatedCopy = path.join(f.sessionsDir, "worktrees", "child-copy");
  git(f.project, "worktree", "add", "-qb", "isolated-copy", isolatedCopy);

  let subagentDone = false;
  let childId = "";
  let parentCalls = 0;
  const provider = new FakeProvider({
    handler: (req) => {
      if (
        req.messages.some(
          (m) => m.role === "user" && JSON.stringify(m.content).includes("Implement child change"),
        )
      ) {
        if (!subagentDone) {
          subagentDone = true;
          return [
            call("c-read", "read", { path: "item.txt" }),
            call("c-edit", "edit", { path: "item.txt", old: "wt-sub", new: "child-sub" }),
            call("c-fin", "finish", { result: "child done" }),
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [{ type: "finish", reason: "stop" }];
      }
      const idx = parentCalls++;
      if (idx === 0) {
        const mixed = `${f.worktree.slice(0, 1).toLowerCase()}${f.worktree.slice(1).replaceAll("\\", "/")}/`;
        return [
          call("bad-out", "switch_worktree", { path: f.base }),
          call("bad-iso", "switch_worktree", { path: isolatedCopy }),
          call("bad-sub", "switch_worktree", { path: missingSub }),
          call("bad-mapped", "switch_worktree", { path: path.join(f.worktree, "packages", "sub") }),
          call("sw", "switch_worktree", { path: mixed }),
          call("after-read", "read", { path: "item.txt" }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (idx === 1)
        return [
          call("bg", "task", { task: "Implement child change", background: true }),
          { type: "finish", reason: "tool_calls" },
        ];
      const m = /subagent-result id=\\?"([^"\\]+)/.exec(JSON.stringify(req.messages));
      if (m && !childId) {
        childId = m[1] ?? "";
        return [
          call("apply", "apply_subagent_changes", { id: childId }),
          call("sw-back", "switch_worktree", {
            path: path.relative(path.join(f.worktree, "packages", "sub"), f.project),
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      return [
        { type: "text_delta", text: "complete" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const home = path.join(f.base, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path.join(f.project, ".nocturne", "config.json"),
    JSON.stringify({ compaction: { pruneLimit: 12345 } }),
  );
  writeFileSync(
    path.join(f.worktree, ".nocturne", "config.json"),
    JSON.stringify({
      compaction: { pruneLimit: 54321 },
      permissions: { rules: [{ action: "deny", kind: "read", pattern: "**" }] },
    }),
  );
  const cfg = await loadConfig(createPlatform(), { nocturneHome: home });
  await cfg.setWorkspaceTrusted(f.project, true);
  const wsCfg = await cfg.forWorkspace(f.project);
  expect(wsCfg.projectConfig.trusted).toBe(true);
  expect(wsCfg.resolved.compactionPruneLimit).toBe(12345);
  const configRoots = vi.spyOn(cfg, "forWorkspace");
  await wsCfg.grants.add({
    kind: "shell",
    target: "git status",
    createdAt: new Date().toISOString(),
  });
  const rt = await createRuntime({
    cwd: path.join(f.project, "packages", "sub"),
    workspaceRoot: f.project,
    config: cfg,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    interactive: true,
    subagent: { enabled: true, background: true },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s.submit({ text: "start" });
  for (
    let i = 0;
    i < 120 &&
    s.state().history.filter((e) => e.kind === "tool" && e.name === "switch_worktree").length < 6;
    i++
  ) {
    if (
      s
        .state()
        .history.some(
          (e) =>
            e.kind === "tool" &&
            e.name === "switch_worktree" &&
            e.status === "error" &&
            e.modelContent.includes("未知"),
        )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const tools = s.state().history.filter((e) => e.kind === "tool");
  const swCalls = tools.filter((e) => e.name === "switch_worktree");
  expect(swCalls.map((e) => `${e.status}:${e.modelContent}`)).toEqual([
    expect.stringContaining("error:"),
    expect.stringContaining("error:"),
    expect.stringContaining("error:"),
    expect.stringContaining("error:"),
    expect.stringContaining("ok:"),
    expect.stringContaining("ok:"),
  ]);
  const switchErrors = internalSession(s)
    .durableEvents()
    .flatMap((event) =>
      event.type === "tool.completed" &&
      event.payload.name === "switch_worktree" &&
      event.payload.status === "error"
        ? [event.payload.error?.code]
        : [],
    );
  expect(switchErrors).toEqual([
    "invalid_input",
    "invalid_input",
    "invalid_input",
    "invalid_input",
  ]);
  const activeCalls = new Set<string>();
  for (const event of internalSession(s).durableEvents()) {
    if (event.type === "tool.started") activeCalls.add(event.payload.callId);
    if (event.type === "tool.completed") activeCalls.delete(event.payload.callId);
    expect(activeCalls.size).toBeLessThanOrEqual(1);
  }
  expect(activeCalls.size).toBe(0);
  expect(configRoots.mock.calls.every(([root]) => root === f.project)).toBe(true);
  expect(tools.find((e) => e.name === "read")?.modelContent).toContain("wt-sub");
  expect(readFileSync(path.join(f.worktree, "packages", "sub", "item.txt"), "utf8")).toBe(
    "child-sub\n",
  );
  const skillNames = (await s.describeSkills()).skills.map((k) => k.name);
  expect(skillNames).toContain("proj-skill");
  expect(skillNames).not.toContain("wt-skill");
  expect(await rt.listGrants({ workspace: f.project })).toMatchObject([
    { kind: "shell", target: "git status" },
  ]);
  expect(await rt.listGrants({ workspace: f.worktree })).toEqual([]);
  expect(provider.requests[1]?.system).toEqual(provider.requests[0]?.system);
  const childReq = provider.requests.find((r) =>
    r.messages.some(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("Implement child change"),
    ),
  );
  expect(childReq?.tools?.some((t) => t.name === "switch_worktree")).toBe(false);
  expect(existsSync(path.join(f.project, "packages", "sub", "item.txt"))).toBe(false);
  expect(s.state().config.worktree?.current).toBe(path.join(f.project, "packages", "sub"));
  await s.close();
}, 30_000);

it("sibling worktrees deny edit in bypass, allow read with notice, persist after switching back to project, and deactivate when rewound before the first switch", async () => {
  const f = fixture();
  const wt2 = path.join(f.base, "worktree-2");
  git(f.project, "worktree", "add", "-qb", "feature-2", wt2);
  writeFileSync(path.join(wt2, "file.txt"), "from-wt2\n");
  const provider = new FakeProvider({
    handler: (_req, idx) => {
      if (idx === 0)
        return [
          call("pre-read", "read", { path: path.join(f.worktree, "file.txt") }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (idx === 1)
        return [
          { type: "text_delta", text: "pre" },
          { type: "finish", reason: "stop" },
        ];
      if (idx === 2) {
        return [
          call("sw-wt", "switch_worktree", { path: f.worktree }),
          call("read-proj", "read", { path: path.join(f.project, "file.txt") }),
          call("edit-proj", "edit", {
            path: path.join(f.project, "file.txt"),
            old: "project",
            new: "blocked",
          }),
          call("sw-proj", "switch_worktree", { path: f.project }),
          call("read-wt2", "read", { path: path.join(wt2, "file.txt") }),
          call("edit-wt2", "edit", {
            path: path.join(wt2, "file.txt"),
            old: "from-wt2",
            new: "blocked-2",
          }),
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (idx === 3)
        return [
          { type: "text_delta", text: "checked" },
          { type: "finish", reason: "stop" },
        ];
      if (idx === 4)
        return [
          call("after-rewind-read", "read", { path: path.join(f.worktree, "file.txt") }),
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "after rewind" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const wtSpy = vi.spyOn(workspaceBranches, "gitWorktrees");
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  expect(wtSpy).not.toHaveBeenCalled();
  const asked: string[] = [];
  s.subscribe((e) => {
    if (e.type === "permission.requested") asked.push(e.payload.requestId);
  });
  await s.submit({ text: "zero" });
  expect(wtSpy).not.toHaveBeenCalled();
  await s.submit({ text: "first" });
  expect(wtSpy).toHaveBeenCalledTimes(2);
  expect(asked).toEqual([]);
  const tools = s.state().history.filter((e) => e.kind === "tool");
  expect(tools[0]?.modelContent).not.toContain("[Note: This file is in another worktree");
  expect(tools[2]?.modelContent).toContain(
    `[Note: This file is in another worktree (${f.project}); current worktree is ${f.worktree}.]`,
  );
  expect(tools[3]?.status).toBe("denied");
  expect(tools[3]?.modelContent).toContain(f.project);
  expect(tools[3]?.modelContent).toContain(f.worktree);
  expect(tools[5]?.modelContent).toContain(
    `[Note: This file is in another worktree (${wt2}); current worktree is ${f.project}.]`,
  );
  expect(tools[6]?.status).toBe("denied");
  expect(tools[6]?.modelContent).toContain(wt2);
  expect(tools[6]?.modelContent).toContain(f.project);
  expect(readFileSync(path.join(f.project, "file.txt"), "utf8")).toBe("project\n");
  expect(readFileSync(path.join(wt2, "file.txt"), "utf8")).toBe("from-wt2\n");

  const firstUserSeq = s.state().history.find((e) => e.kind === "user")?.seq ?? 1;
  await s.rewind(firstUserSeq, "conversation");
  await s.submit({ text: "second" });
  const afterRewindRead = s
    .state()
    .history.filter((e) => e.kind === "tool")
    .at(-1);
  expect(afterRewindRead?.modelContent).not.toContain("[Note: This file is in another worktree");
  await s.close();
});

it("cross-switch rewind restores files across worktrees, reports only deleted-worktree files as failed, forks inherit current directory, resume falls back when deleted and reloads sibling rules, switchBranch busy follows current directory, and next turn does not duplicate branch note", async () => {
  const f = fixture();
  const wt2 = path.join(f.base, "worktree-2");
  git(f.project, "worktree", "add", "-qb", "feature-2", wt2);
  writeFileSync(path.join(wt2, "file.txt"), "wt2-orig\n");
  let gateResolve: (() => void) | undefined;
  const provider = new FakeProvider({
    handler: async (_req, idx) => {
      if (idx === 0)
        return [
          call("r1", "read", { path: "file.txt" }),
          call("e1", "edit", { path: "file.txt", old: "project", new: "project-mod" }),
          call("sw1", "switch_worktree", { path: f.worktree }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (idx === 1)
        return [
          { type: "text_delta", text: "turn1" },
          { type: "finish", reason: "stop" },
        ];
      if (idx === 2)
        return [
          call("r2", "read", { path: "file.txt" }),
          call("e2", "edit", { path: "file.txt", old: "worktree", new: "worktree-mod" }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (idx === 3) {
        if (gateResolve === undefined) {
          await new Promise<void>((r) => {
            gateResolve = r;
          });
        }
        return [
          { type: "text_delta", text: "turn2" },
          { type: "finish", reason: "stop" },
        ];
      }
      return [
        { type: "text_delta", text: "next" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s.submit({ text: "m1" });
  const running = s.submit({ text: "m2" });
  for (let i = 0; i < 50 && gateResolve === undefined; i++)
    await new Promise((r) => setTimeout(r, 20));
  expect((await rt.workspaceBranches({ workspace: f.project })).busy).toBe(false);
  expect((await rt.workspaceBranches({ workspace: f.worktree })).busy).toBe(true);
  await rt.switchBranch({ workspace: f.project, branch: "proj-b", create: true });
  await expect(
    rt.switchBranch({ workspace: f.worktree, branch: "wt-b", create: true }),
  ).rejects.toThrow();
  gateResolve?.();
  await running;

  const branchNotesBefore = s
    .state()
    .history.filter((e) => e.kind === "note" && e.text.includes("Git branch changed"));
  await s.submit({ text: "m3" });
  const branchNotesAfter = s
    .state()
    .history.filter((e) => e.kind === "note" && e.text.includes("Git branch changed"));
  expect(branchNotesAfter.length).toBe(branchNotesBefore.length);

  const forkedId = await rt.forkSession(s.id);
  const forked = await rt.resumeSession(forkedId);
  expect(forked.state().config.worktree?.current).toBe(f.worktree);
  await forked.close();

  const u1 = s.state().history.find((e) => e.kind === "user")?.seq ?? 1;
  const beforeSwitchId = await rt.forkSession(s.id, { targetSeq: u1 });
  const beforeSwitch = await rt.resumeSession(beforeSwitchId);
  expect(beforeSwitch.state().config.worktree).toBeUndefined();
  await beforeSwitch.close();
  const restoredAll = await s.rewind(u1, "both");
  expect(restoredAll.every((r) => r.result === "restored")).toBe(true);
  expect(readFileSync(path.join(f.project, "file.txt"), "utf8")).toBe("project\n");
  expect(readFileSync(path.join(f.worktree, "file.txt"), "utf8")).toBe("worktree\n");
  expect(s.state().config.worktree).toBeUndefined();
  expect(replaySessionView(internalSession(s).durableEvents()).currentCwd).toBe(f.project);
  await s.close();

  const p2 = new FakeProvider({
    handler: (_req, idx) => {
      if (idx === 0)
        return [
          call("r1", "read", { path: "file.txt" }),
          call("e1", "edit", { path: "file.txt", old: "project", new: "project-mod2" }),
          call("sw", "switch_worktree", { path: f.worktree }),
          call("r2", "read", { path: "file.txt" }),
          call("e2", "edit", { path: "file.txt", old: "worktree", new: "worktree-mod2" }),
          { type: "finish", reason: "tool_calls" },
        ];
      if (idx === 1)
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      if (idx === 2)
        return [
          call("r-wt2", "read", { path: path.join(wt2, "file.txt") }),
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "after" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const rt2 = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [p2],
    subagent: { enabled: false },
  });
  const s2 = await rt2.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s2.submit({ text: "edit-both" });
  const id2 = s2.id;
  await s2.close();

  const resumedAlive = await rt2.resumeSession(id2);
  expect(resumedAlive.state().config.worktree?.current).toBe(f.worktree);
  await resumedAlive.submit({ text: "check-sibling-after-resume" });
  expect(
    resumedAlive
      .state()
      .history.filter((e) => e.kind === "tool")
      .at(-1)?.modelContent,
  ).toContain(
    `[Note: This file is in another worktree (${wt2}); current worktree is ${f.worktree}.]`,
  );
  await resumedAlive.close();

  rmSync(f.worktree, { recursive: true, force: true });
  const resumedGone = await rt2.resumeSession(id2);
  expect(resumedGone.state().config.worktree?.current).toBe(f.project);
  expect(
    resumedGone
      .state()
      .history.some(
        (e) =>
          e.kind === "note" &&
          e.text.includes(`Working directory changed from ${f.worktree} to ${f.project}`),
      ),
  ).toBe(true);
  const firstSeq2 = resumedGone.state().history.find((e) => e.kind === "user")?.seq ?? 1;
  const filesGone = await resumedGone.rewind(firstSeq2, "files");
  expect(filesGone.find((x) => x.path.startsWith(f.project))?.result).toBe("restored");
  expect(filesGone.find((x) => x.path.startsWith(f.worktree))?.result).toBe("failed");
  expect(existsSync(f.worktree)).toBe(false);
  await resumedGone.close();
}, 30_000);

it("switch_worktree results do not include sibling worktree read notice when switching to worktree and back, while subsequent read still includes notice", async () => {
  const f = fixture();
  const provider = new FakeProvider({
    scripts: [
      [
        call("sw-wt", "switch_worktree", { path: f.worktree }),
        call("sw-proj", "switch_worktree", { path: f.project }),
        call("read-wt", "read", { path: path.join(f.worktree, "file.txt") }),
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ],
  });
  const rt = await createRuntime({
    cwd: f.project,
    sessionsDir: f.sessionsDir,
    providers: [provider],
    subagent: { enabled: false },
  });
  const s = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
  await s.submit({ text: "switch and read" });
  const tools = s.state().history.filter((e) => e.kind === "tool");
  expect(tools).toHaveLength(3);
  expect(tools[0]?.modelContent).not.toContain("[Note:");
  expect(tools[1]?.modelContent).not.toContain("[Note:");
  expect(tools[2]?.modelContent).toContain(
    `[Note: This file is in another worktree (${f.worktree}); current worktree is ${f.project}.]`,
  );
  await s.close();
});
