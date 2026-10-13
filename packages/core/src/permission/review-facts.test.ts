import { describe, expect, it, vi } from "vitest";
import {
  createReviewFacts,
  detectFactNeeds,
  isTrustedRemote,
  parseGitRemotes,
  readTrustedRemotes,
  type GitRunner,
} from "./review-facts.js";
import type { ReviewSubject } from "./types.js";

const shell = (target: string): ReviewSubject => ({ kind: "shell", target });
const signal = () => new AbortController().signal;

describe("审查补充事实", () => {
  it("识别 reset --hard / clean / checkout -- . 与 push", () => {
    expect(detectFactNeeds([shell("git reset --hard HEAD~1")]).status).toBe(true);
    expect(detectFactNeeds([shell("git -C sub clean -fd")]).status).toBe(true);
    expect(detectFactNeeds([shell("git checkout -- .")]).status).toBe(true);
    expect(detectFactNeeds([shell("git checkout main")]).status).toBe(false);
    expect(detectFactNeeds([shell("git status")])).toEqual({ status: false });
    expect(detectFactNeeds([shell("git push --force origin feature:release")]).push).toEqual({
      remote: "origin",
      branch: "release",
    });
    expect(detectFactNeeds([shell("git push origin --delete old")]).push).toEqual({
      remote: "origin",
      branch: "old",
    });
    expect(detectFactNeeds([{ kind: "network", target: "https://x" }])).toEqual({ status: false });
  });

  it("解析 git remote -v 并判断是否可信", () => {
    const remotes = parseGitRemotes(
      "origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\nfork\tgit@x.test:me/b.git (push)\n",
    );
    expect(remotes).toEqual(["origin https://github.com/a/b.git", "fork git@x.test:me/b.git"]);
    expect(isTrustedRemote("origin", remotes)).toBe(true);
    expect(isTrustedRemote("git@x.test:me/b.git", remotes)).toBe(true);
    expect(isTrustedRemote("evil", remotes)).toBe(false);
  });

  it("会话开始读一次 remote；读不到为空列表", async () => {
    const git: GitRunner = vi.fn(async () => "origin\tu (fetch)\n");
    expect(await readTrustedRemotes(git, signal())).toEqual(["origin u"]);
    expect(await readTrustedRemotes(async () => undefined, signal())).toEqual([]);
    expect(
      await readTrustedRemotes(async () => {
        throw new Error("no git");
      }, signal()),
    ).toEqual([]);
  });

  it("reset --hard 给出未提交改动行数", async () => {
    const git: GitRunner = vi.fn(async () => " M a.ts\n?? b.ts\n\n");
    const facts = createReviewFacts({ git, trustedRemotes: () => [] });
    expect(await facts([shell("git reset --hard")], signal())).toEqual({ uncommittedChanges: 2 });
    expect(git).toHaveBeenCalledWith(["status", "--porcelain"], expect.anything());
  });

  it("推送给出 remote、分支与是否可信，缺省值经 git 查询补全", async () => {
    const git: GitRunner = vi.fn(async (args) => {
      if (args.includes("HEAD")) return "feature\n";
      if (args.includes("@{u}")) return "origin/feature\n";
      return undefined;
    });
    const facts = createReviewFacts({ git, trustedRemotes: () => ["origin https://u"] });
    expect(await facts([shell("git push origin main")], signal())).toEqual({
      push: { remote: "origin", branch: "main", trusted: true },
    });
    expect(await facts([shell("git push evil main")], signal())).toEqual({
      push: { remote: "evil", branch: "main", trusted: false },
    });
    expect(await facts([shell("git push")], signal())).toEqual({
      push: { remote: "origin", branch: "feature", trusted: true },
    });
  });

  it("查询失败就不给事实，不抛错", async () => {
    const failing = createReviewFacts({
      git: async () => {
        throw new Error("git missing");
      },
      trustedRemotes: () => [],
    });
    expect(await failing([shell("git reset --hard")], signal())).toBeUndefined();
    const empty = createReviewFacts({ git: async () => undefined, trustedRemotes: () => [] });
    expect(await empty([shell("git reset --hard")], signal())).toBeUndefined();
    expect(await empty([shell("ls")], signal())).toBeUndefined();
  });
});
