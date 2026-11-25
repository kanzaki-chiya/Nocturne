import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlatform, createRuntime, FakeProvider, loadConfig } from "../src/index.js";
import {
  buildGitPushArgs,
  buildGitTextGuidance,
  buildPrCreateArgs,
  buildPrMergeArgs,
  DEFAULT_GIT_CONFIG,
  DEFAULT_WORKTREE_CONFIG,
  formatAutoBranchName,
  validateGitBranchPrefix,
  validateWorktreeKeepCount,
  validateWorktreeRoot,
} from "../src/protocol/git.js";
import { createWorktree } from "../src/agent/worktree.js";
import {
  registerManagedWorktree,
  restoreWorktreeRecoverySnapshot,
} from "../src/platform/managed-worktrees.js";

const FAKE_MODEL = { provider: "fake", model: "fake-1" } as const;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempDir = (prefix = "nct-git-wt-") => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
    },
  }).trim();

function initRepo(dir: string, branch = "main"): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-qm", "initial");
  return realpathSync.native(dir);
}

function initBareWithClone(base: string): { bare: string; repo: string; peer: string } {
  const bare = path.join(base, "origin.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q");
  const repo = initRepo(path.join(base, "repo"), "main");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-qu", "origin", "main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  const peer = path.join(base, "peer");
  git(base, "clone", "-q", bare, peer);
  git(peer, "config", "user.email", "peer@example.invalid");
  git(peer, "config", "user.name", "Peer");
  return {
    bare: realpathSync.native(bare),
    repo: realpathSync.native(repo),
    peer: realpathSync.native(peer),
  };
}

describe("Git 与工作树设置：旧配置兼容、默认值、校验与持久化往返", () => {
  const platform = createPlatform();
  const noEnv = () => undefined;

  it("旧 settings.json 无 git/worktree 字段时回退到约定默认值，写入后往返保留并支持清除恢复", async () => {
    const base = tempDir();
    const home = path.join(base, "home");
    const ws = path.join(base, "ws");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ permissionPreset: "smart", unknownFutureFlag: 42 }),
    );

    const cfg1 = await loadConfig(platform, { nocturneHome: home, env: noEnv });
    expect(cfg1.resolvedSettings().git).toEqual(DEFAULT_GIT_CONFIG);
    expect(cfg1.resolvedSettings().worktree).toEqual(DEFAULT_WORKTREE_CONFIG);

    const customSessionRoot = path.join(base, "custom-session-wt");
    const customSubagentRoot = path.join(base, "custom-subagent-wt");
    await cfg1.updateSettings({
      "git.branchPrefix": "team/",
      "git.forcePush": true,
      "git.mergeMethod": "squash",
      "git.draftPr": false,
      "git.reviewView": "separate",
      "git.instructions.commit": "Use conventional commits",
      "git.instructions.prTitle": "module: concise summary",
      "git.instructions.prBody": "Include tests and screenshots",
      "worktree.sessionRoot": customSessionRoot,
      "worktree.subagentRoot": customSubagentRoot,
      "worktree.fetchBeforeCreate": true,
      "worktree.autoDelete": false,
      "worktree.keepCount": 7,
      "worktree.askBeforeDelete": false,
    });

    const cfg2 = await loadConfig(platform, { nocturneHome: home, env: noEnv });
    expect(cfg2.resolvedSettings().git).toEqual({
      branchPrefix: "team/",
      forcePush: true,
      mergeMethod: "squash",
      draftPr: false,
      reviewView: "separate",
      instructions: {
        commit: "Use conventional commits",
        prTitle: "module: concise summary",
        prBody: "Include tests and screenshots",
      },
    });
    expect(cfg2.resolvedSettings().worktree).toEqual({
      sessionRoot: customSessionRoot,
      subagentRoot: customSubagentRoot,
      fetchBeforeCreate: true,
      autoDelete: false,
      keepCount: 7,
      askBeforeDelete: false,
    });

    const rawSaved = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(rawSaved.unknownFutureFlag).toBe(42);

    // 清除为 null 恢复默认值
    await cfg2.updateSettings({
      "git.branchPrefix": null,
      "git.forcePush": null,
      "git.mergeMethod": null,
      "git.draftPr": null,
      "git.reviewView": null,
      "git.instructions.commit": null,
      "git.instructions.prTitle": null,
      "git.instructions.prBody": null,
      "worktree.sessionRoot": null,
      "worktree.subagentRoot": null,
      "worktree.fetchBeforeCreate": null,
      "worktree.autoDelete": null,
      "worktree.keepCount": null,
      "worktree.askBeforeDelete": null,
    });
    const cfg3 = await loadConfig(platform, { nocturneHome: home, env: noEnv });
    expect(cfg3.resolvedSettings().git).toEqual(DEFAULT_GIT_CONFIG);
    expect(cfg3.resolvedSettings().worktree).toEqual(DEFAULT_WORKTREE_CONFIG);
  });

  it("非法分支前缀、非法根目录与非正整数保留数量被拒绝且不破坏已有配置", async () => {
    const base = tempDir();
    const home = path.join(base, "home");
    mkdirSync(home, { recursive: true });
    const cfg = await loadConfig(platform, { nocturneHome: home, env: noEnv });

    expect(validateGitBranchPrefix("")).not.toBeNull();
    expect(validateGitBranchPrefix("bad prefix/")).not.toBeNull();
    expect(validateGitBranchPrefix("a..b/")).not.toBeNull();
    expect(validateGitBranchPrefix("/leading/")).not.toBeNull();
    expect(validateGitBranchPrefix("foo.lock/")).not.toBeNull();
    expect(validateGitBranchPrefix("nocturne/")).toBeNull();
    expect(validateGitBranchPrefix("team/feature-")).toBeNull();

    expect(validateWorktreeRoot("relative/path", "win32")).not.toBeNull();
    expect(validateWorktreeRoot("D:\\bad*path", "win32")).not.toBeNull();
    expect(validateWorktreeRoot("D:\\worktrees", "win32")).toBeNull();
    expect(validateWorktreeRoot("~/worktrees", "darwin")).toBeNull();
    expect(validateWorktreeRoot("relative/path", "darwin")).not.toBeNull();

    expect(validateWorktreeKeepCount(0)).not.toBeNull();
    expect(validateWorktreeKeepCount(-3)).not.toBeNull();
    expect(validateWorktreeKeepCount(1.5)).not.toBeNull();
    expect(validateWorktreeKeepCount(15)).toBeNull();

    await expect(cfg.updateSettings({ "git.branchPrefix": "bad prefix" })).rejects.toThrow();
    await expect(cfg.updateSettings({ "worktree.sessionRoot": "relative/dir" })).rejects.toThrow();
    await expect(cfg.updateSettings({ "worktree.keepCount": 0 })).rejects.toThrow();
    expect(cfg.resolvedSettings().git?.branchPrefix ?? "nocturne/").toBe("nocturne/");
    expect(cfg.resolvedSettings().worktree?.keepCount ?? 15).toBe(15);
  });
});

describe("Git 偏好真实消费边界", () => {
  it("推送参数绝不用裸 --force；开启 forcePush 时本地 bare 远端以 --force-with-lease 拒绝覆盖远端新提交", () => {
    const base = tempDir();
    const { repo, peer } = initBareWithClone(base);

    const normalArgs = buildGitPushArgs({ forcePush: false }, { remote: "origin", branch: "main" });
    expect(normalArgs).toEqual(["push", "origin", "main"]);
    expect(normalArgs).not.toContain("--force");
    expect(normalArgs).not.toContain("--force-with-lease");

    const leaseArgs = buildGitPushArgs({ forcePush: true }, { remote: "origin", branch: "main" });
    expect(leaseArgs).toContain("--force-with-lease");
    expect(leaseArgs).not.toContain("--force");

    // 另一端推送新提交使远端前进，本地制造分叉提交
    writeFileSync(path.join(peer, "peer.txt"), "peer\n");
    git(peer, "add", "peer.txt");
    git(peer, "commit", "-qm", "peer commit");
    git(peer, "push", "-q", "origin", "main");

    writeFileSync(path.join(repo, "local.txt"), "local\n");
    git(repo, "add", "local.txt");
    git(repo, "commit", "-qm", "local diverged commit");

    // 使用 buildGitPushArgs 生成的 --force-with-lease 推送必须拒绝覆盖远端新提交
    expect(() => git(repo, ...leaseArgs)).toThrow();
  });

  it("PR 创建/合并参数、文案指引与自动分支前缀命名按偏好输出且不改写手输分支", () => {
    expect(buildPrCreateArgs({ draftPr: true }, { title: "t", body: "b" })).toEqual([
      "pr",
      "create",
      "--draft",
      "--title",
      "t",
      "--body",
      "b",
    ]);
    expect(buildPrCreateArgs({ draftPr: false }, { title: "t" })).toEqual([
      "pr",
      "create",
      "--title",
      "t",
    ]);
    expect(buildPrMergeArgs({ mergeMethod: "merge" }, { pr: "12" })).toEqual([
      "pr",
      "merge",
      "12",
      "--merge",
    ]);
    expect(buildPrMergeArgs({ mergeMethod: "squash" }, { pr: "12" })).toEqual([
      "pr",
      "merge",
      "12",
      "--squash",
    ]);
    expect(
      buildGitTextGuidance(
        { instructions: { commit: "中文摘要", prTitle: "模块前缀", prBody: "两节结构" } },
        "commit",
      ),
    ).toBe("中文摘要");
    expect(
      buildGitTextGuidance(
        { instructions: { commit: "中文摘要", prTitle: "模块前缀", prBody: "两节结构" } },
        "pr",
      ),
    ).toContain("PR title instructions:\n模块前缀");
    expect(formatAutoBranchName("feat/", "20261125-abc")).toBe("feat/20261125-abc");
    expect(formatAutoBranchName("invalid prefix", "20261125-abc")).toBe("nocturne/20261125-abc");
  });

  it("Agent Turn 上下文注入生效的 Git 偏好，且审查呈现同时支持当前会话与独立会话路径", async () => {
    const base = tempDir();
    const home = path.join(base, "home");
    const sessionsDir = path.join(base, "sessions");
    const repo = initRepo(path.join(base, "app"));
    mkdirSync(home, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    const platform = createPlatform();
    const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
    await cfg.updateSettings({
      "git.branchPrefix": "dev/",
      "git.forcePush": true,
      "git.mergeMethod": "squash",
      "git.draftPr": false,
      "git.reviewView": "inline",
      "git.instructions.commit": "摘要不超过 50 字",
      "git.instructions.prTitle": "module: title",
      "git.instructions.prBody": "改动与验证",
    });

    const provider = new FakeProvider({
      scripts: [
        [
          { type: "text_delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const rt = await createRuntime({
      cwd: repo,
      sessionsDir,
      config: cfg,
      providers: [provider],
      subagent: { enabled: false },
    });

    const session = await rt.createSession({ cwd: repo, model: FAKE_MODEL });
    await session.submit({ text: "hello" });

    const capturedSystem = provider.requests[0]?.system.map((b) => b.text).join("\n") ?? "";
    expect(capturedSystem).toContain("Automatic branch prefix: `dev/`");
    expect(capturedSystem).toContain("--force-with-lease");
    expect(capturedSystem).toContain("gh pr merge --squash");
    expect(capturedSystem).toContain("omit `--draft`");
    expect(capturedSystem).toContain("摘要不超过 50 字");
    expect(capturedSystem).toContain("module: title");
    expect(capturedSystem).toContain("改动与验证");
    expect(capturedSystem).toContain("never perform network writes");

    // 审查呈现：inline 保持当前会话
    const inlineReview = await rt.startReview({ sessionId: session.id, prompt: "packages/core" });
    expect(inlineReview.presentation).toBe("inline");
    expect(inlineReview.createdSession).toBe(false);
    expect(inlineReview.sessionId).toBe(session.id);
    expect(inlineReview.prompt).toContain("packages/core");

    // 切换为 separate 后，发起审查创建独立会话并保留当前会话不变
    await cfg.updateSettings({ "git.reviewView": "separate" });
    const separateReview = await rt.startReview({ sessionId: session.id, prompt: "apps/desktop" });
    expect(separateReview.presentation).toBe("separate");
    expect(separateReview.createdSession).toBe(true);
    expect(separateReview.sessionId).not.toBe(session.id);
    expect(separateReview.prompt).toContain("dedicated review session");

    await session.close();
  });
});

describe("工作树根目录、创建前 fetch、托管注册聚合、保留清理与恢复快照", () => {
  it(
    "自定义新会话/子代理根目录生效、不同仓库同名目录不冲突、手输分支名不加前缀、自动子代理分支使用自定义前缀",
    { timeout: 30_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      const customSessionRoot = path.join(base, "my-session-wts");
      const customSubagentRoot = path.join(base, "my-subagent-wts");
      const repoA = initRepo(path.join(base, "org-a", "same-name"));
      const repoB = initRepo(path.join(base, "org-b", "same-name"));
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      await cfg.updateSettings({
        "git.branchPrefix": "custom/",
        "worktree.sessionRoot": customSessionRoot,
        "worktree.subagentRoot": customSubagentRoot,
      });

      const rt = await createRuntime({
        cwd: repoA,
        sessionsDir,
        config: cfg,
        providers: [new FakeProvider({})],
        subagent: { enabled: false },
      });

      // 手输分支名：保留原样，不自动加 custom/ 前缀
      const sA = await rt.createSession({
        cwd: repoA,
        model: FAKE_MODEL,
        branch: { name: "manual/fix-1", create: true },
      });
      const sB = await rt.createSession({
        cwd: repoB,
        model: FAKE_MODEL,
        branch: { name: "manual/fix-1", create: true },
      });

      const cwdA = sA.state().config.worktree?.current ?? "";
      const cwdB = sB.state().config.worktree?.current ?? "";
      expect(cwdA.startsWith(customSessionRoot)).toBe(true);
      expect(cwdB.startsWith(customSessionRoot)).toBe(true);
      expect(cwdA).not.toBe(cwdB);
      expect(git(cwdA, "branch", "--show-current")).toBe("manual/fix-1");
      expect(git(cwdB, "branch", "--show-current")).toBe("manual/fix-1");
      // 主检出未被改动
      expect(git(repoA, "branch", "--show-current")).toBe("main");

      // 子代理隔离工作树使用自定义 subagentRoot 和自定义 branchPrefix
      const sub = await createWorktree({
        repository: repoA,
        cwd: repoA,
        workspaceRoot: repoA,
        sessionsDir,
        subagentRoot: customSubagentRoot,
        branchPrefix: "custom/",
        parentSessionId: sA.id,
        childSessionId: "child-sub-1",
        task: "verify custom subagent root",
        trusted: true,
      });
      expect(sub.worktree.startsWith(customSubagentRoot)).toBe(true);
      expect(sub.branch.startsWith("custom/")).toBe(true);

      await registerManagedWorktree(sessionsDir, {
        kind: "subagent",
        repository: sub.repository,
        worktreePath: sub.worktree,
        branch: sub.branch,
        ownsBranch: true,
        sessionId: sA.id,
        childSessionId: sub.childSessionId,
      });

      const described = await rt.describeManagedWorktrees();
      expect(described.effectiveSubagentRoot).toBe(customSubagentRoot);
      // 聚合了两个项目的两类真实工作树（2 个 session + 1 个 subagent）
      expect(described.worktrees).toHaveLength(3);
      expect(described.worktrees.filter((w) => w.kind === "session")).toHaveLength(2);
      expect(described.worktrees.filter((w) => w.kind === "subagent")).toHaveLength(1);
      expect(described.worktrees.filter((w) => w.state === "active")).toHaveLength(2);

      await sA.close();
      await sB.close();
    },
  );

  it(
    "创建前获取上游更新：开启时更新跟踪引用且不改父仓库工作区，离线失败给出明确报错并可关闭恢复",
    { timeout: 30_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      const { repo, peer } = initBareWithClone(base);
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      // 父仓库留未提交改动，验证 fetch 不会破坏父工作区基线
      writeFileSync(path.join(repo, "README.md"), "parent dirty\n");

      // peer 推送新提交到 origin/main
      writeFileSync(path.join(peer, "upstream.txt"), "from upstream\n");
      git(peer, "add", "upstream.txt");
      git(peer, "commit", "-qm", "upstream advance");
      git(peer, "push", "-q", "origin", "main");
      const upstreamSha = git(peer, "rev-parse", "HEAD");

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      await cfg.updateSettings({ "worktree.fetchBeforeCreate": true });

      const rt = await createRuntime({
        cwd: repo,
        sessionsDir,
        config: cfg,
        providers: [new FakeProvider({})],
        subagent: { enabled: false },
      });

      const s1 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/after-fetch", create: true },
      });
      expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(upstreamSha);
      expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("parent dirty\n");
      await s1.close();

      // 模拟离线 / 不可达远端：fetch 失败明确报错
      git(repo, "remote", "set-url", "origin", path.join(base, "missing-remote.git"));
      await expect(
        rt.createSession({
          cwd: repo,
          model: FAKE_MODEL,
          branch: { name: "nocturne/offline-fail", create: true },
        }),
      ).rejects.toThrow(/获取上游更新失败/);
      expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("parent dirty\n");

      // 关闭 fetchBeforeCreate 后可正常恢复创建
      await cfg.updateSettings({ "worktree.fetchBeforeCreate": false });
      const s2 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/offline-ok", create: true },
      });
      expect(git(s2.state().config.worktree?.current ?? "", "branch", "--show-current")).toBe(
        "nocturne/offline-ok",
      );
      await s2.close();
    },
  );

  it(
    "保留数量、置顶与使用中保护、禁止删主检出/非托管副本、恢复快照完整取回独有提交与本地改动、快照失败跳过保原件及并发安全",
    { timeout: 60_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      const repo = initRepo(path.join(base, "proj"));
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      // 建一个非 Nocturne 托管的手工工作树，验证永不被聚合或清理
      const unmanagedWt = path.join(base, "unmanaged-wt");
      git(repo, "worktree", "add", "-q", "-b", "user-manual", unmanagedWt, "main");

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      await cfg.updateSettings({
        "worktree.autoDelete": true,
        "worktree.keepCount": 1,
      });

      const rt = await createRuntime({
        cwd: repo,
        sessionsDir,
        config: cfg,
        providers: [new FakeProvider({})],
        subagent: { enabled: false },
      });

      // 创建 4 个托管会话工作树：
      // wt1: 最旧、有 2 个独有提交 + 修改已跟踪文件 + 未跟踪文件（将被自动清理并存快照）
      // wt2: 置顶保护（不计入保留数、不可自动删除）
      // wt3: 保留的最新 1 个非置顶非活跃工作树
      // wt4: 使用中（打开状态，不计入保留数、不可删除）
      await cfg.updateSettings({ "worktree.autoDelete": false }); // 创建阶段先关自动删以便准备夹具

      const s1 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/wt1", create: true },
      });
      const wt1Path = s1.state().config.worktree?.current ?? "";
      writeFileSync(path.join(wt1Path, "README.md"), "commit-1\n");
      git(wt1Path, "add", "README.md");
      git(wt1Path, "commit", "-qm", "wt1 commit 1");
      writeFileSync(path.join(wt1Path, "feat.txt"), "commit-2\n");
      git(wt1Path, "add", "feat.txt");
      git(wt1Path, "commit", "-qm", "wt1 commit 2");
      writeFileSync(path.join(wt1Path, "feat.txt"), "commit-2\nlocal-edit\n");
      writeFileSync(path.join(wt1Path, "untracked.txt"), "untracked-payload\n");
      const wt1Head = git(wt1Path, "rev-parse", "HEAD");
      await s1.close();

      const s2 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/wt2", create: true },
      });
      const wt2Path = s2.state().config.worktree?.current ?? "";
      await s2.close();

      const s3 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/wt3", create: true },
      });
      const wt3Path = s3.state().config.worktree?.current ?? "";
      await s3.close();

      const s4 = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/wt4", create: true },
      });
      const wt4Path = s4.state().config.worktree?.current ?? "";

      let desc = await rt.describeManagedWorktrees();
      expect(desc.worktrees).toHaveLength(4);
      expect(desc.worktrees.some((w) => w.path === unmanagedWt)).toBe(false);
      expect(desc.worktrees.some((w) => w.path === repo)).toBe(false);

      const w1 = desc.worktrees.find((w) => w.branch === "nocturne/wt1");
      const w2 = desc.worktrees.find((w) => w.branch === "nocturne/wt2");
      const w3 = desc.worktrees.find((w) => w.branch === "nocturne/wt3");
      const w4 = desc.worktrees.find((w) => w.branch === "nocturne/wt4");
      if (w1 === undefined || w2 === undefined || w3 === undefined || w4 === undefined) {
        throw new Error("expected all four managed worktrees");
      }
      expect(w1).toMatchObject({ state: "ahead", aheadCount: 2, dirty: true });
      expect(w2.state).toBe("merged");
      expect(w4.state).toBe("active");

      // 置顶 wt2
      await rt.setManagedWorktreePinned({ id: w2.id, pinned: true });

      // 开启自动删除 + keepCount=1：活跃 wt4 和置顶 wt2 不计入保留数，仅 wt1 超出
      await cfg.updateSettings({ "worktree.autoDelete": true, "worktree.keepCount": 1 });
      desc = await rt.describeManagedWorktrees();
      expect(desc.worktrees.filter((w) => w.autoDeleteCandidate).map((w) => w.branch)).toEqual([
        "nocturne/wt1",
      ]);

      // 尝试删除使用中的 wt4 或非托管 id 均受保护
      const activeAttempt = await rt.deleteManagedWorktrees({ ids: [w4.id, "nonexistent"] });
      expect(activeAttempt.deleted).toHaveLength(0);
      expect(
        activeAttempt.skipped.some((o) => o.id === w4.id && o.status === "skipped_protected"),
      ).toBe(true);
      expect(existsSync(wt4Path)).toBe(true);

      // 快照失败路径：用同名普通文件堵住快照目录，自动清理必须跳过并完整保留 wt1 原件！
      const snapshotsRoot = path.join(sessionsDir, "worktrees", "snapshots");
      writeFileSync(snapshotsRoot, "block-directory-creation");
      const blockedPrune = await rt.pruneManagedWorktrees();
      expect(blockedPrune.deleted).toHaveLength(0);
      expect(blockedPrune.skipped).toHaveLength(1);
      expect(blockedPrune.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(existsSync(wt1Path)).toBe(true);
      expect(readFileSync(path.join(wt1Path, "untracked.txt"), "utf8")).toBe("untracked-payload\n");

      // 解除阻塞后重试自动清理：wt1 被保存快照并删除，wt2(置顶)、wt3(保留1个)、wt4(使用中)、非托管工作树、主检出全部完好
      rmSync(snapshotsRoot, { force: true });
      const pruneResult = await rt.pruneManagedWorktrees();
      expect(pruneResult.deleted).toHaveLength(1);
      expect(pruneResult.deleted[0]?.branch).toBe("nocturne/wt1");
      expect(pruneResult.deleted[0]?.snapshot).toBeDefined();
      expect(existsSync(wt1Path)).toBe(false);
      expect(existsSync(wt2Path)).toBe(true);
      expect(existsSync(wt3Path)).toBe(true);
      expect(existsSync(wt4Path)).toBe(true);
      expect(existsSync(unmanagedWt)).toBe(true);
      expect(existsSync(repo)).toBe(true);

      // 从恢复快照完整还原 wt1（2 个独有提交 + 工作区补丁 + 未跟踪文件）
      const snapId = pruneResult.deleted[0]?.snapshot?.id;
      if (snapId === undefined) throw new Error("expected recovery snapshot id");
      const restored = await restoreWorktreeRecoverySnapshot(sessionsDir, { snapshotId: snapId });
      expect(restored.headSha).toBe(wt1Head);
      expect(restored.appliedPatch).toBe(true);
      expect(restored.restoredUntrackedCount).toBe(1);
      expect(git(restored.worktreePath, "rev-parse", "HEAD")).toBe(wt1Head);
      expect(readFileSync(path.join(restored.worktreePath, "feat.txt"), "utf8")).toBe(
        "commit-2\nlocal-edit\n",
      );
      expect(readFileSync(path.join(restored.worktreePath, "untracked.txt"), "utf8")).toBe(
        "untracked-payload\n",
      );

      // 并发删除竞争：同时删同一个 id，仅一次成功删除，第二次优雅跳过/not_found
      const [rA, rB] = await Promise.all([
        rt.deleteManagedWorktrees({ ids: [w3.id] }),
        rt.deleteManagedWorktrees({ ids: [w3.id] }),
      ]);
      expect(rA.deleted.length + rB.deleted.length).toBe(1);
      expect(rA.failed.length + rB.failed.length).toBe(0);

      await s4.close();
    },
  );
});
