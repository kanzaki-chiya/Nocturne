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
import { afterEach, expect, it } from "vitest";
import { createPlatform, createRuntime, FakeProvider, loadConfig } from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import { internalSession } from "./internal-session.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    path.join(home, "trust.json"),
    JSON.stringify({ trustedWorkspaces: [f.project, f.worktree] }),
  );
  writeFileSync(
    path.join(f.project, ".nocturne", "config.json"),
    JSON.stringify({ compactionPruneLimit: 12345 }),
  );
  writeFileSync(
    path.join(f.worktree, ".nocturne", "config.json"),
    JSON.stringify({
      compactionPruneLimit: 54321,
      permissions: [{ action: "deny", kind: "read", pattern: "**" }],
    }),
  );
  const cfg = await loadConfig(createPlatform(), { nocturneHome: home });
  const wsCfg = await cfg.forWorkspace(f.project);
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
    s.state().history.filter((e) => e.kind === "tool" && e.name === "switch_worktree").length < 5;
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
    expect.stringContaining("ok:"),
    expect.stringContaining("ok:"),
  ]);
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
