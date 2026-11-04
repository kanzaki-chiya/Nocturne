import { expect, it } from "vitest";
import { summarizeToolInput } from "../src/format.js";

it("switch_worktree summarizes the destination directory on Windows and POSIX", () => {
  expect(summarizeToolInput("switch_worktree", { path: "Z:\\repo-wt\\" })).toBe("repo-wt");
  expect(summarizeToolInput("switch_worktree", { path: "/repos/repo/" })).toBe("repo");
});
