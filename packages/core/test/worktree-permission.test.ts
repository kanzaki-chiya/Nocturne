import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { createRulePolicy } from "../src/permission/policy.js";

describe("worktree shell hard denial", () => {
  const root = path.join(os.tmpdir(), "isolated-checkout");
  const main = path.join(os.tmpdir(), "main-checkout");
  const policy = createRulePolicy({
    workspaceRoot: root,
    caseSensitive: false,
    preset: "bypass",
    autoApproveAsk: true,
    worktree: { root, cwd: root },
  });
  it.each([
    { target: "git status", shellCwd: main },
    { target: `git -C "${main}" status`, shellCwd: root },
    { target: `GIT_DIR="${main}/.git" git status`, shellCwd: root },
    { target: `$env:GIT_WORK_TREE='${main}'; git status`, shellCwd: root },
    { target: `cd ${main}; git commit -am x`, shellCwd: root },
    { target: `cd "${main}" && git status`, shellCwd: root },
    { target: `chdir '${main}'; git status`, shellCwd: root },
    { target: `pushd ${main} && git status`, shellCwd: root },
    { target: "Set-Location ..\\..; git status", shellCwd: root },
    { target: `sl "${main}"; git status`, shellCwd: root },
    { target: "Push-Location ..; git status", shellCwd: root },
    { target: "cd", shellCwd: root },
    { target: "cd ; git status", shellCwd: root },
    { target: "cd ~ && git status", shellCwd: root },
    { target: "cd ~/other && git status", shellCwd: root },
  ])("denies external git paths, cd targets, and cwd even in bypass: %s", (subject) => {
    const result = policy.evaluate([{ kind: "shell", ...subject }]);
    expect(result.decision.action).toBe("deny");
    expect(result.decision.reason).toContain(
      "This subagent is isolated in its own worktree; commands must stay inside it.",
    );
  });
  it.each([
    "git status",
    "cd sub && git status",
    `cd "${path.join(root, "sub")}" && git status`,
    "Set-Location ./sub; git status",
    "pushd sub && git status",
  ])("allows git and directory changes inside the worktree: %s", (target) => {
    expect(policy.evaluate([{ kind: "shell", target, shellCwd: root }]).decision.action).toBe(
      "allow",
    );
  });
});
