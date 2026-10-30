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
  ])("denies external git paths and cwd even in bypass: %s", (subject) => {
    const result = policy.evaluate([{ kind: "shell", ...subject }]);
    expect(result.decision.action).toBe("deny");
    expect(result.decision.reason).toContain(
      "This subagent is isolated in its own worktree; commands must stay inside it.",
    );
  });
  it("allows git status inside the worktree", () => {
    expect(
      policy.evaluate([{ kind: "shell", target: "git status", shellCwd: root }]).decision.action,
    ).toBe("allow");
  });
});
