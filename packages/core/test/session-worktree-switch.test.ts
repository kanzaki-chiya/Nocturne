import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntime, FakeProvider } from "../src/index.js";
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
