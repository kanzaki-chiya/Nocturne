import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmp, connectWithConfig, MODEL, tmpDir } from "./harness.js";

afterEach(cleanupTmp);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
  }).trim();

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "rpc@example.invalid");
  git(dir, "config", "user.name", "RPC Test");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "app.txt"), "base\n");
  git(dir, "add", "app.txt");
  git(dir, "commit", "-qm", "init");
}

describe("Git 与工作树 RPC 往返", () => {
  it("git.* 与 worktree.* 设置经 runtime.updateSettings / describeSettings 往返生效并校验参数", async () => {
    const h = await connectWithConfig();
    const initial = await h.client.runtime.describeSettings();
    expect(initial.find((i) => i.key === "git.branchPrefix")?.effective).toBe("nocturne/");
    expect(initial.find((i) => i.key === "worktree.keepCount")?.effective).toBe("15");

    const updated = await h.client.runtime.updateSettings({
      "git.branchPrefix": "rpc/",
      "git.forcePush": true,
      "git.mergeMethod": "squash",
      "git.draftPr": false,
      "git.reviewView": "separate",
      "git.instructions.commit": "Use Chinese summary",
      "worktree.fetchBeforeCreate": true,
      "worktree.keepCount": 3,
      "worktree.askBeforeDelete": false,
    });
    expect(updated.find((i) => i.key === "git.branchPrefix")?.effective).toBe("rpc/");
    expect(updated.find((i) => i.key === "git.forcePush")?.effective).toBe("true");
    expect(updated.find((i) => i.key === "git.mergeMethod")?.effective).toBe("squash");
    expect(updated.find((i) => i.key === "git.draftPr")?.effective).toBe("false");
    expect(updated.find((i) => i.key === "git.reviewView")?.effective).toBe("separate");
    expect(updated.find((i) => i.key === "worktree.keepCount")?.effective).toBe("3");

    await expect(
      h.client.call("worktrees.setPinned", { id: 123 as never, pinned: true }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(h.client.call("worktrees.delete", { ids: "bad" as never })).rejects.toMatchObject({
      rpcCode: -32602,
    });

    h.client.close();
    await h.served;
  });

  it(
    "托管工作树 describe / setPinned / delete / prune / restoreSnapshot 与 review.start 经 RPC 端到端往返",
    { timeout: 30_000 },
    async () => {
      const repo = tmpDir("nct-rpc-wt-repo-");
      initRepo(repo);
      const h = await connectWithConfig({ ws: repo });

      // 创建真实会话工作树并产生独有提交与本地改动
      const { session: s1 } = await h.client.runtime.createSession({
        cwd: repo,
        model: MODEL,
        branch: { name: "nocturne/rpc-demo", create: true },
      });
      const initialDesc = await h.client.runtime.describeManagedWorktrees();
      expect(initialDesc.worktrees).toHaveLength(1);
      expect(initialDesc.worktrees[0]?.state).toBe("active");
      const wtPath = initialDesc.worktrees[0]?.path ?? "";
      expect(wtPath).not.toBe("");
      writeFileSync(path.join(wtPath, "app.txt"), "rpc-commit\n");
      git(wtPath, "add", "app.txt");
      git(wtPath, "commit", "-qm", "rpc unique commit");
      writeFileSync(path.join(wtPath, "extra.txt"), "untracked-rpc\n");

      // 审查呈现：先验证 inline，再切 separate 验证创建独立会话
      const inline = await h.client.runtime.startReview({
        sessionId: s1.id,
        prompt: "check app.txt",
      });
      expect(inline.presentation).toBe("inline");
      expect(inline.createdSession).toBe(false);
      expect(inline.sessionId).toBe(s1.id);

      await h.client.runtime.updateSettings({ "git.reviewView": "separate" });
      const separate = await h.client.runtime.startReview({
        sessionId: s1.id,
        prompt: "check app.txt",
      });
      expect(separate.presentation).toBe("separate");
      expect(separate.createdSession).toBe(true);
      expect(separate.sessionId).not.toBe(s1.id);

      // 释放会话使其变为非使用中
      await s1.close();

      let desc = await h.client.runtime.describeManagedWorktrees();
      expect(desc.worktrees).toHaveLength(1);
      const wt = desc.worktrees[0];
      expect(wt).toMatchObject({
        branch: "nocturne/rpc-demo",
        state: "ahead",
        aheadCount: 1,
        dirty: true,
        pinned: false,
      });

      if (wt === undefined) throw new Error("expected managed worktree");

      // 置顶 / 取消置顶
      const pinned = await h.client.runtime.setManagedWorktreePinned({ id: wt.id, pinned: true });
      expect(pinned).toEqual({ id: wt.id, pinned: true });
      desc = await h.client.runtime.describeManagedWorktrees();
      expect(desc.worktrees[0]?.pinned).toBe(true);
      await h.client.runtime.setManagedWorktreePinned({ id: wt.id, pinned: false });

      // 手动删除并保存恢复快照
      const deleted = await h.client.runtime.deleteManagedWorktrees({ ids: [wt.id] });
      expect(deleted.deleted).toHaveLength(1);
      expect(deleted.deleted[0]?.snapshot).toBeDefined();
      expect(existsSync(wtPath)).toBe(false);

      // 恢复快照还原工作树与未跟踪文件
      const snapId = deleted.deleted[0]?.snapshot?.id;
      if (snapId === undefined) throw new Error("expected recovery snapshot id");
      const restored = await h.client.runtime.restoreWorktreeSnapshot({ snapshotId: snapId });
      expect(restored.restoredUntrackedCount).toBe(1);
      expect(readFileSync(path.join(restored.worktreePath, "app.txt"), "utf8")).toBe(
        "rpc-commit\n",
      );
      expect(readFileSync(path.join(restored.worktreePath, "extra.txt"), "utf8")).toBe(
        "untracked-rpc\n",
      );

      // prune 空操作正常返回
      const pruned = await h.client.runtime.pruneManagedWorktrees();
      expect(pruned.failed).toHaveLength(0);

      h.client.close();
      await h.served;
    },
  );
});
