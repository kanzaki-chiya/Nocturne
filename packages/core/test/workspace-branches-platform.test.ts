import { beforeEach, expect, it, vi } from "vitest";
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:child_process", () => {
  const execute = (...args: unknown[]) => execFile(...args);
  Object.defineProperty(execute, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => execFile(...args),
  });
  return { execFile: execute };
});
import { gitCurrentBranch, gitSwitchBranch } from "../src/platform/workspace-branches.js";

beforeEach(() => {
  execFile.mockReset();
});

it("bounds every branch read and treats timeout as failure without falling back to a false detached HEAD", async () => {
  execFile.mockRejectedValue(
    Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }),
  );
  expect(await gitCurrentBranch("Z:/fixture")).toBeNull();
  expect(execFile).toHaveBeenCalledOnce();
  expect(execFile.mock.calls[0]).toEqual([
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    expect.objectContaining({
      cwd: "Z:/fixture",
      timeout: 4000,
      encoding: "utf8",
      windowsHide: true,
    }),
  ]);
});

it("uses argument arrays and preserves Git stderr byte for byte as the failure message", async () => {
  const stderr = "error: local changes would be overwritten\n\tfile.txt\nAborting\n";
  execFile
    .mockResolvedValueOnce({ stdout: "main;calc\n", stderr: "" })
    .mockRejectedValueOnce(Object.assign(new Error("failed"), { stderr }));
  await expect(gitSwitchBranch("Z:/fixture", "main;calc", true)).rejects.toMatchObject({
    message: stderr,
  });
  expect(
    execFile.mock.calls.map(([file, args, options]) => ({ file, args, shell: options.shell })),
  ).toEqual([
    { file: "git", args: ["check-ref-format", "--branch", "main;calc"], shell: undefined },
    { file: "git", args: ["switch", "-c", "main;calc", "--"], shell: undefined },
  ]);
});

it("does not read failures as a branch and shortens a detached commit to exactly eight characters", async () => {
  execFile
    .mockResolvedValueOnce({ stdout: "HEAD\n" })
    .mockResolvedValueOnce({ stdout: "1234567890abcdef1234567890abcdef12345678\n" });
  expect(await gitCurrentBranch("Z:/fixture")).toBe("12345678");
  execFile.mockRejectedValue(new Error("unreadable"));
  expect(await gitCurrentBranch("Z:/fixture")).toBeNull();
});
