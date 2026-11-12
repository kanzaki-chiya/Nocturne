import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWorktree,
  inspectWorktreeRepository,
  settleWorktree,
  worktreeGit,
  applyWorktreeChanges,
  cleanupMergedWorktrees,
  listWorktreeRecords,
  removeWorktree,
  resetWorktreeToCommit,
  worktreeResultText,
} from "../src/agent/worktree.js";
import { subagentResultText } from "../src/protocol/index.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "nocturne-worktree-"));
  temporary.push(root);
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await worktreeGit(repository, ["init"]);
  await worktreeGit(repository, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repository, "file.txt"), "original\n");
  await writeFile(path.join(repository, ".gitignore"), "*.secret\n");
  await worktreeGit(repository, ["add", "."]);
  await worktreeGit(repository, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--no-verify",
    "-m",
    "initial",
  ]);
  return {
    root,
    repository,
    input: {
      repository,
      sessionsDir: path.join(root, "sessions"),
      childSessionId: "child-12345678",
      parentSessionId: "parent",
      cwd: repository,
      workspaceRoot: repository,
      task: "Implement changes",
      trusted: true,
    },
  };
}
describe("result text for display", () => {
  it("drops the model-facing merge instructions only when changes are attached", () => {
    const changes = {
      branch: "nocturne/x",
      base: "a",
      head: "b",
      snapshot: false,
      worktree: "w",
      files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0 }],
    };
    const text = `<subagent-result id="x">\nDone.${worktreeResultText(changes)}\n</subagent-result>`;
    expect(text).toContain("Changes (1 files):");
    expect(subagentResultText(text, true)).toBe("Done.");
    expect(subagentResultText(text)).toContain("Branch: nocturne/x");
  });
});

describe("isolated worktree with real git", () => {
  it("retains the branch after apply and cleans it once merged", async () => {
    const { repository, input } = await fixture();
    const record = await createWorktree(input);
    await writeFile(path.join(record.worktree, "file.txt"), "child\n");
    const changes = await settleWorktree(record);
    if (!changes) throw new Error("Expected changes");
    await applyWorktreeChanges(repository, changes, "clean");
    await removeWorktree(record, false);
    expect((await worktreeGit(repository, ["branch", "--list", record.branch])).trim()).toContain(
      record.branch,
    );
    expect(await listWorktreeRecords(input.sessionsDir, input.parentSessionId)).toHaveLength(1);
    await worktreeGit(repository, ["checkout", "--", "file.txt"]);
    await worktreeGit(repository, ["merge", "--ff-only", record.branch]);
    await cleanupMergedWorktrees(input.sessionsDir, input.parentSessionId);
    expect(await worktreeGit(repository, ["branch", "--list", record.branch])).toBe("");
    expect(await listWorktreeRecords(input.sessionsDir, input.parentSessionId)).toHaveLength(0);
  });
  it("three-way applies dirty working files without modifying the index", async () => {
    const { repository, input } = await fixture();
    const record = await createWorktree(input);
    await writeFile(path.join(record.worktree, "file.txt"), "child\n");
    const changes = await settleWorktree(record);
    if (!changes) throw new Error("Expected changes");
    await writeFile(path.join(repository, "file.txt"), "parent\n");
    const index = await worktreeGit(repository, ["write-tree"]);
    expect((await applyWorktreeChanges(repository, changes, "3way")).conflicts).toEqual([
      "file.txt",
    ]);
    expect(await worktreeGit(repository, ["write-tree"])).toBe(index);
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toContain("<<<<<<<");
  });
  it("applies clean changes and reports three-way conflict markers", async () => {
    const { repository, input } = await fixture();
    const record = await createWorktree(input);
    await writeFile(path.join(record.worktree, "file.txt"), "child result\n");
    const changes = await settleWorktree(record);
    if (!changes) throw new Error("Expected child changes");
    await applyWorktreeChanges(repository, changes, "clean");
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toBe("child result\n");
    await worktreeGit(repository, ["checkout", "--", "file.txt"]);
    await writeFile(path.join(repository, "file.txt"), "parent result\n");
    await expect(applyWorktreeChanges(repository, changes, "clean")).rejects.toThrow("file.txt");
    await worktreeGit(repository, ["add", "file.txt"]);
    await worktreeGit(repository, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      "parent",
    ]);
    expect((await applyWorktreeChanges(repository, changes, "3way")).conflicts).toEqual([
      "file.txt",
    ]);
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toContain("<<<<<<<");
  });
  it("rejects a non-git workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nocturne-nongit-"));
    temporary.push(root);
    await expect(inspectWorktreeRepository(root)).rejects.toThrow("not a git repository");
  });
  it("uses HEAD for a clean baseline and removes unchanged worktrees and branches", async () => {
    const { repository, input } = await fixture();
    const record = await createWorktree(input);
    expect(record.base).toBe((await worktreeGit(repository, ["rev-parse", "HEAD"])).trim());
    expect(record.snapshot).toBe(false);
    expect(await settleWorktree(record)).toBeUndefined();
    await expect(readFile(path.join(record.worktree, "file.txt"))).rejects.toThrow();
    expect(await worktreeGit(repository, ["branch", "--list", record.branch])).toBe("");
  });
  it("copies dirty tracked and untracked state without changing the main workspace", async () => {
    const { repository, input } = await fixture();
    await writeFile(path.join(repository, "file.txt"), "dirty\n");
    await writeFile(path.join(repository, "new.txt"), "untracked\n");
    const status = await worktreeGit(repository, ["status", "--porcelain"]);
    const mainHead = await worktreeGit(repository, ["rev-parse", "HEAD"]);
    const record = await createWorktree(input);
    expect(record.snapshot).toBe(true);
    expect(await readFile(path.join(record.worktree, "file.txt"), "utf8")).toBe("dirty\n");
    expect(await readFile(path.join(record.worktree, "new.txt"), "utf8")).toBe("untracked\n");
    await writeFile(path.join(record.worktree, "file.txt"), "result\n");
    const changes = await settleWorktree(record);
    expect(changes?.files).toEqual([
      { path: "file.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    expect(await readFile(path.join(repository, "file.txt"), "utf8")).toBe("dirty\n");
    expect(await worktreeGit(repository, ["status", "--porcelain"])).toBe(status);
    expect(await worktreeGit(repository, ["rev-parse", "HEAD"])).toBe(mainHead);
  });
  it.each([true, false])(
    "copies only ignored include matches in trusted=%s projects",
    async (trusted) => {
      const { repository, input } = await fixture();
      const withoutInclude = await createWorktree({
        ...input,
        childSessionId: `noinc-${String(trusted)}`,
        trusted,
      });
      expect(withoutInclude.includeSkipped).toBe(false);
      await settleWorktree(withoutInclude);

      await writeFile(path.join(repository, ".worktreeinclude"), "copy.secret\n");
      await writeFile(path.join(repository, "copy.secret"), "included");
      await writeFile(path.join(repository, "skip.secret"), "excluded");
      const record = await createWorktree({ ...input, trusted });
      expect(record.includeSkipped).toBe(!trusted);
      if (trusted)
        expect(await readFile(path.join(record.worktree, "copy.secret"), "utf8")).toBe("included");
      else await expect(readFile(path.join(record.worktree, "copy.secret"))).rejects.toThrow();
      await expect(readFile(path.join(record.worktree, "skip.secret"))).rejects.toThrow();
      expect(await settleWorktree(record)).toBeUndefined();
    },
  );
  it("skips untracked symbolic links and records their paths", async () => {
    const { repository, input } = await fixture();
    await writeFile(path.join(repository, "real.txt"), "real\n");
    await symlink(
      path.join(repository, "real.txt"),
      path.join(repository, "link.txt"),
      process.platform === "win32" ? "file" : undefined,
    );
    const record = await createWorktree(input);
    expect(record.skippedSymlinks).toEqual(["link.txt"]);
    expect(await readFile(path.join(record.worktree, "real.txt"), "utf8")).toBe("real\n");
    await expect(lstat(path.join(record.worktree, "link.txt"))).rejects.toThrow();
    await settleWorktree(record);
  });
  it("maps a subdirectory workspace into the full checkout", async () => {
    const { repository, input } = await fixture();
    await mkdir(path.join(repository, "sub"));
    await writeFile(path.join(repository, "sub", "nested.txt"), "nested");
    const record = await createWorktree({
      ...input,
      cwd: path.join(repository, "sub"),
      workspaceRoot: path.join(repository, "sub"),
    });
    expect(record.cwd).toBe(path.join(record.worktree, "sub"));
    expect(record.workspaceRoot).toBe(record.cwd);
    expect(await readFile(path.join(record.cwd, "nested.txt"), "utf8")).toBe("nested");
    await settleWorktree(record);
  });

  it("resetWorktreeToCommit cleans untracked non-ignored files while preserving gitignored files", async () => {
    const { repository, input } = await fixture();
    await writeFile(path.join(repository, ".gitignore"), "*.secret\n.env.local\nnode_modules/\n");
    await worktreeGit(repository, ["add", ".gitignore"]);
    await worktreeGit(repository, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--no-verify",
      "-m",
      "update gitignore",
    ]);

    const author = await createWorktree({ ...input, childSessionId: "author-1234" });
    await writeFile(path.join(author.worktree, "feature.txt"), "author-v2\n");
    const authorChanges = await settleWorktree(author);
    if (!authorChanges) throw new Error("Expected author changes");

    const verifier = await createWorktree({ ...input, childSessionId: "verifier-1234" });
    // 放入被忽略的环境文件与依赖目录，以及未跟踪非忽略的脏产物与被篡改的已跟踪文件
    await writeFile(path.join(verifier.worktree, ".env.local"), "API_URL=http://local\n");
    await writeFile(path.join(verifier.worktree, "keep.secret"), "token=kept\n");
    await mkdir(path.join(verifier.worktree, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(verifier.worktree, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
    );
    await writeFile(path.join(verifier.worktree, "untracked-temp.txt"), "should-be-removed\n");
    await writeFile(path.join(verifier.worktree, "file.txt"), "tampered\n");

    const sha = await resetWorktreeToCommit(verifier.worktree, authorChanges.head);
    expect(sha).toBe(authorChanges.head);
    // 被忽略的依赖和环境文件完好保留
    expect(await readFile(path.join(verifier.worktree, ".env.local"), "utf8")).toBe(
      "API_URL=http://local\n",
    );
    expect(await readFile(path.join(verifier.worktree, "keep.secret"), "utf8")).toBe(
      "token=kept\n",
    );
    expect(
      await readFile(path.join(verifier.worktree, "node_modules", "pkg", "index.js"), "utf8"),
    ).toBe("module.exports = 1;\n");
    // 未跟踪且未被忽略的文件被清掉，已跟踪文件恢复并检出目标提交
    await expect(lstat(path.join(verifier.worktree, "untracked-temp.txt"))).rejects.toThrow();
    expect(await readFile(path.join(verifier.worktree, "file.txt"), "utf8")).toBe("original\n");
    expect(await readFile(path.join(verifier.worktree, "feature.txt"), "utf8")).toBe("author-v2\n");

    await removeWorktree(verifier, true);
    await removeWorktree(author, true);
  });

  it("removeWorktree ignores missing branch for detached worktrees but rethrows real branch deletion failures", async () => {
    const { repository, input } = await fixture();
    // 1. 分离头指针创建的工作树：其 record.branch 从未创建，removeWorktree(..., true) 应正常忽略缺失分支
    const detached = await createWorktree({
      ...input,
      childSessionId: "detached-1234",
      detach: true,
    });
    await expect(removeWorktree(detached, true)).resolves.toBeUndefined();

    // 2. 分支真实存在但被另一个辅助工作树检出占用导致 branch -D 失败：应照旧抛出错误，不得静默吞掉
    const normal = await createWorktree({ ...input, childSessionId: "locked-branch-1234" });
    await worktreeGit(repository, ["worktree", "remove", "--force", normal.worktree]);
    const holderPath = path.join(input.sessionsDir, "holder-wt");
    await worktreeGit(repository, ["worktree", "add", holderPath, normal.branch]);
    try {
      await expect(removeWorktree(normal, true)).rejects.toThrow();
    } finally {
      await worktreeGit(repository, ["worktree", "remove", "--force", holderPath]);
      await removeWorktree(normal, true);
    }
  });
});
