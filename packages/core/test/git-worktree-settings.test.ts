import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  deleteManagedWorktrees,
  listWorktreeRecoverySnapshots,
  registerManagedWorktree,
  restoreWorktreeRecoverySnapshot,
  setManagedWorktreePinned,
  type ManagedWorktreeInspector,
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

  it(
    "恢复快照区分暂存区与工作区：同一文件先暂存 A 再写 B，以及暂存后改回 HEAD、二进制、AD、rm --cached 与 add -N 均分别精准恢复",
    { timeout: 60_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      const repo = initRepo(path.join(base, "proj"));
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      writeFileSync(path.join(repo, "dual.txt"), "head-O\n");
      writeFileSync(path.join(repo, "revert-in-wt.txt"), "head-same\n");
      writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
      writeFileSync(path.join(repo, "rm-cached.txt"), "tracked-keep-wt\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "seed files");

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
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
        branch: { name: "nocturne/staged-vs-worktree", create: true },
      });
      const wtPath = s1.state().config.worktree?.current ?? "";
      await s1.close();

      // 1) 同一文件先暂存 A，工作区再写 B（MM）
      writeFileSync(path.join(wtPath, "dual.txt"), "staged-version-A\n");
      git(wtPath, "add", "dual.txt");
      writeFileSync(path.join(wtPath, "dual.txt"), "worktree-version-B\n");

      // 2) 暂存 A 后把工作区改回与 HEAD 完全相同的内容（git diff HEAD 为空但暂存区独有 A）
      writeFileSync(path.join(wtPath, "revert-in-wt.txt"), "only-in-staged-index\n");
      git(wtPath, "add", "revert-in-wt.txt");
      writeFileSync(path.join(wtPath, "revert-in-wt.txt"), "head-same\n");

      // 3) 二进制文件先暂存 binA，工作区再写 binB
      writeFileSync(path.join(wtPath, "bin.dat"), Buffer.from([0, 11, 22, 33]));
      git(wtPath, "add", "bin.dat");
      writeFileSync(path.join(wtPath, "bin.dat"), Buffer.from([0, 99, 88, 77]));

      // 4) 新文件暂存 A 后在工作区删除（AD）
      writeFileSync(path.join(wtPath, "index-only.txt"), "staged-new-A\n");
      git(wtPath, "add", "index-only.txt");
      rmSync(path.join(wtPath, "index-only.txt"), { force: true });

      // 5) git rm --cached（索引删除、工作区保留并修改）
      git(wtPath, "rm", "--cached", "-q", "rm-cached.txt");
      writeFileSync(path.join(wtPath, "rm-cached.txt"), "kept-and-edited-in-wt\n");

      // 6) intent-to-add（git add -N）
      writeFileSync(path.join(wtPath, "intent.txt"), "intent-payload\n");
      git(wtPath, "add", "-N", "intent.txt");

      const statusBefore = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
        cwd: wtPath,
        encoding: "utf8",
      });

      const desc = await rt.describeManagedWorktrees();
      const target = desc.worktrees.find((w) => w.branch === "nocturne/staged-vs-worktree");
      if (target === undefined) throw new Error("expected managed worktree");

      const del = await rt.deleteManagedWorktrees({ ids: [target.id], saveSnapshot: true });
      expect(del.deleted).toHaveLength(1);
      expect(existsSync(wtPath)).toBe(false);
      const snap = del.deleted[0]?.snapshot;
      if (snap === undefined) throw new Error("expected snapshot");
      expect(snap.hasStagedPatch).toBe(true);
      expect(snap.hasWorkingPatch).toBe(true);
      expect(snap.stateFingerprint).toBeTruthy();

      const restored = await restoreWorktreeRecoverySnapshot(sessionsDir, { snapshotId: snap.id });
      expect(restored.appliedPatch).toBe(true);
      expect(restored.appliedStagedPatch).toBe(true);
      expect(restored.appliedWorkingPatch).toBe(true);

      // 分别核对索引版本（git show :<file>）和工作区版本（readFileSync）
      expect(git(restored.worktreePath, "show", ":dual.txt")).toBe("staged-version-A");
      expect(readFileSync(path.join(restored.worktreePath, "dual.txt"), "utf8")).toBe(
        "worktree-version-B\n",
      );

      expect(git(restored.worktreePath, "show", ":revert-in-wt.txt")).toBe("only-in-staged-index");
      expect(readFileSync(path.join(restored.worktreePath, "revert-in-wt.txt"), "utf8")).toBe(
        "head-same\n",
      );

      const restoredIdxBin = execFileSync("git", ["show", ":bin.dat"], {
        cwd: restored.worktreePath,
      });
      expect([...restoredIdxBin]).toEqual([0, 11, 22, 33]);
      expect([...readFileSync(path.join(restored.worktreePath, "bin.dat"))]).toEqual([
        0, 99, 88, 77,
      ]);

      expect(git(restored.worktreePath, "show", ":index-only.txt")).toBe("staged-new-A");
      expect(existsSync(path.join(restored.worktreePath, "index-only.txt"))).toBe(false);

      expect(() => git(restored.worktreePath, "show", ":rm-cached.txt")).toThrow();
      expect(readFileSync(path.join(restored.worktreePath, "rm-cached.txt"), "utf8")).toBe(
        "kept-and-edited-in-wt\n",
      );

      expect(readFileSync(path.join(restored.worktreePath, "intent.txt"), "utf8")).toBe(
        "intent-payload\n",
      );

      const statusAfter = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
        cwd: restored.worktreePath,
        encoding: "utf8",
      });
      expect(statusAfter).toBe(statusBefore);
    },
  );

  it(
    "包含被忽略文件或目录时绝不复制到快照，自动与手动清理均跳过并保留工作树，移走后可正常清理",
    { timeout: 60_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      const repo = initRepo(path.join(base, "proj"));
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      writeFileSync(path.join(repo, ".gitignore"), "local-secret.txt\nuser-ignored-dir/\n");
      git(repo, "add", ".gitignore");
      git(repo, "commit", "-qm", "add gitignore");

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      await cfg.updateSettings({ "worktree.autoDelete": true, "worktree.keepCount": 1 });
      const rt = await createRuntime({
        cwd: repo,
        sessionsDir,
        config: cfg,
        providers: [new FakeProvider({})],
        subagent: { enabled: false },
      });

      // wtIgnored：仅有 ignored 文件（git status --porcelain 为空，但包含敏感用户数据）
      const sIgnored = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/has-ignored", create: true },
      });
      const wtIgnored = sIgnored.state().config.worktree?.current ?? "";
      await sIgnored.close();

      writeFileSync(path.join(wtIgnored, "local-secret.txt"), "SENSITIVE_USER_SECRET_VALUE\n");
      mkdirSync(path.join(wtIgnored, "user-ignored-dir"), { recursive: true });
      writeFileSync(
        path.join(wtIgnored, "user-ignored-dir", "notes.json"),
        '{"private":"must-not-copy-or-delete"}\n',
      );

      // 建一个较新的干净工作树，并明确提高其 lastUsedAt 使 wtIgnored 处于自动清理候选位（keepCount=1）
      const sNewer = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/newer-clean", create: true },
      });
      const wtNewer = sNewer.state().config.worktree?.current ?? "";
      await sNewer.close();
      await registerManagedWorktree(sessionsDir, {
        kind: "session",
        repository: repo,
        worktreePath: wtNewer,
        branch: "nocturne/newer-clean",
        ownsBranch: true,
        sessionId: sNewer.id,
        lastUsedAt: Date.now() + 60_000,
      });

      const desc = await rt.describeManagedWorktrees();
      const ignoredEntry = desc.worktrees.find((w) => w.branch === "nocturne/has-ignored");
      if (ignoredEntry === undefined) throw new Error("expected ignored worktree");
      expect(ignoredEntry.autoDeleteCandidate).toBe(true);

      // 1) 自动清理必须跳过并保留原工作树与被忽略文件
      const autoRes = await rt.pruneManagedWorktrees();
      expect(autoRes.deleted).toHaveLength(0);
      expect(autoRes.skipped).toHaveLength(1);
      expect(autoRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(autoRes.skipped[0]?.error).toMatch(/\.gitignore|忽略/);
      expect(existsSync(wtIgnored)).toBe(true);
      expect(readFileSync(path.join(wtIgnored, "local-secret.txt"), "utf8")).toBe(
        "SENSITIVE_USER_SECRET_VALUE\n",
      );
      expect(
        readFileSync(path.join(wtIgnored, "user-ignored-dir", "notes.json"), "utf8"),
      ).toContain("must-not-copy-or-delete");

      // 2) 手动清理（即使不显式要求 saveSnapshot 且工作树无 tracked 改动）也必须跳过并保留原工作树
      const manualRes = await rt.deleteManagedWorktrees({ ids: [ignoredEntry.id] });
      expect(manualRes.deleted).toHaveLength(0);
      expect(manualRes.skipped).toHaveLength(1);
      expect(manualRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(manualRes.skipped[0]?.error).toMatch(/local-secret\.txt|user-ignored-dir/);
      expect(existsSync(wtIgnored)).toBe(true);

      // 3) 核对快照目录中绝对没有偷偷复制任何被忽略或敏感文件
      const snapshotsDir = path.join(sessionsDir, "worktrees", "snapshots");
      if (existsSync(snapshotsDir)) {
        const walkFiles = (dir: string): string[] => {
          const out: string[] = [];
          for (const item of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) out.push(...walkFiles(full));
            else out.push(full);
          }
          return out;
        };
        for (const f of walkFiles(snapshotsDir)) {
          expect(f).not.toMatch(/local-secret|user-ignored-dir/);
          expect(readFileSync(f, "utf8")).not.toContain("SENSITIVE_USER_SECRET_VALUE");
        }
      }
      expect(await listWorktreeRecoverySnapshots(sessionsDir)).toHaveLength(0);

      // 4) 用户移走被忽略文件后，手动清理可正常删除
      rmSync(path.join(wtIgnored, "local-secret.txt"), { force: true });
      rmSync(path.join(wtIgnored, "user-ignored-dir"), { recursive: true, force: true });
      const retryRes = await rt.deleteManagedWorktrees({ ids: [ignoredEntry.id] });
      expect(retryRes.deleted).toHaveLength(1);
      expect(existsSync(wtIgnored)).toBe(false);
    },
  );

  it(
    "子模块内部未保存改动/未跟踪文件/独立提交，以及合并冲突、进行中操作、嵌套仓库与 assume-unchanged 均保守跳过并保留工作树",
    { timeout: 90_000 },
    async () => {
      const base = tempDir();
      const home = path.join(base, "home");
      const sessionsDir = path.join(base, "sessions");
      mkdirSync(home, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });

      // 搭建带真实本地子模块的临时仓库
      const subOrigin = initRepo(path.join(base, "sub-origin"));
      writeFileSync(path.join(subOrigin, "lib.txt"), "v1\n");
      git(subOrigin, "add", "lib.txt");
      git(subOrigin, "commit", "-qm", "sub v1");

      const repo = initRepo(path.join(base, "proj-with-sub"));
      git(
        repo,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        subOrigin,
        "deps/sub",
      );
      git(repo, "commit", "-qm", "add submodule");

      const platform = createPlatform();
      const cfg = await loadConfig(platform, { nocturneHome: home, env: () => undefined });
      await cfg.updateSettings({ "worktree.autoDelete": true, "worktree.keepCount": 1 });
      const rt = await createRuntime({
        cwd: repo,
        sessionsDir,
        config: cfg,
        providers: [new FakeProvider({})],
        subagent: { enabled: false },
      });

      const sSub = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/sub-dirty", create: true },
      });
      const wtSub = sSub.state().config.worktree?.current ?? "";
      await sSub.close();

      git(wtSub, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
      const subDir = path.join(wtSub, "deps", "sub");
      git(subDir, "config", "user.email", "sub@example.invalid");
      git(subDir, "config", "user.name", "SubTest");
      git(subDir, "config", "core.autocrlf", "false");

      // 再建一个较新的干净工作树，明确提高其 lastUsedAt 使 wtSub 处于自动清理候选位（keepCount=1）
      const sKeep = await rt.createSession({
        cwd: repo,
        model: FAKE_MODEL,
        branch: { name: "nocturne/keep-newer", create: true },
      });
      const wtKeep = sKeep.state().config.worktree?.current ?? "";
      await sKeep.close();
      await registerManagedWorktree(sessionsDir, {
        kind: "session",
        repository: repo,
        worktreePath: wtKeep,
        branch: "nocturne/keep-newer",
        ownsBranch: true,
        sessionId: sKeep.id,
        lastUsedAt: Date.now() + 60_000,
      });

      const desc = await rt.describeManagedWorktrees();
      const subEntry = desc.worktrees.find((w) => w.branch === "nocturne/sub-dirty");
      if (subEntry === undefined) throw new Error("expected submodule worktree");

      // (a) 子模块内部未保存修改：自动与手动均跳过并保留工作树
      writeFileSync(path.join(subDir, "lib.txt"), "unsaved-in-submodule\n");
      const subDirtyAuto = await rt.pruneManagedWorktrees();
      expect(subDirtyAuto.deleted).toHaveLength(0);
      expect(subDirtyAuto.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(subDirtyAuto.skipped[0]?.error).toMatch(/子模块.*deps\/sub/);
      expect(readFileSync(path.join(subDir, "lib.txt"), "utf8")).toBe("unsaved-in-submodule\n");

      const subDirtyManual = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(subDirtyManual.deleted).toHaveLength(0);
      expect(subDirtyManual.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(existsSync(wtSub)).toBe(true);

      // (b) 还原已修改文件，但在子模块内部加入未跟踪文件：仍必须保留
      git(subDir, "checkout", "--", "lib.txt");
      writeFileSync(path.join(subDir, "sub-untracked.txt"), "local-sub-untracked\n");
      const subUntrackedRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(subUntrackedRes.deleted).toHaveLength(0);
      expect(subUntrackedRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(readFileSync(path.join(subDir, "sub-untracked.txt"), "utf8")).toBe(
        "local-sub-untracked\n",
      );

      // (b2) 子模块内部加入被忽略文件：仍必须保留
      rmSync(path.join(subDir, "sub-untracked.txt"), { force: true });
      writeFileSync(path.join(subDir, ".gitignore"), "sub-ignored.dat\n");
      git(subDir, "add", ".gitignore");
      git(subDir, "commit", "-qm", "sub gitignore");
      writeFileSync(path.join(subDir, "sub-ignored.dat"), "sub-secret\n");
      const subIgnoredRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(subIgnoredRes.deleted).toHaveLength(0);
      expect(subIgnoredRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(readFileSync(path.join(subDir, "sub-ignored.dat"), "utf8")).toBe("sub-secret\n");
      rmSync(path.join(subDir, "sub-ignored.dat"), { force: true });
      git(subDir, "reset", "--hard", "HEAD~1");

      // (c) 在子模块内部制造独立本地提交（HEAD 偏离父 gitlink）：仍必须保留
      writeFileSync(path.join(subDir, "lib.txt"), "sub-local-commit\n");
      git(subDir, "add", "lib.txt");
      git(subDir, "commit", "-qm", "local sub commit");
      const subAheadRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(subAheadRes.deleted).toHaveLength(0);
      expect(subAheadRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(subAheadRes.skipped[0]?.error).toMatch(/子模块.*deps\/sub/);
      expect(existsSync(wtSub)).toBe(true);

      // (d) 恢复子模块到父 HEAD 干净状态后，再测试其它未能完整捕获的 Git 状态
      git(subDir, "reset", "--hard", "HEAD~1");

      // (d1) 未跟踪嵌套 Git 仓库
      const nestedRepo = initRepo(path.join(wtSub, "nested-untracked-repo"));
      const nestedRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(nestedRes.deleted).toHaveLength(0);
      expect(nestedRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(nestedRes.skipped[0]?.error).toMatch(/嵌套.*Git 仓库|未跟踪目录/);
      expect(existsSync(nestedRepo)).toBe(true);
      rmSync(nestedRepo, { recursive: true, force: true });

      // (d2) assume-unchanged 标记
      git(wtSub, "update-index", "--assume-unchanged", "README.md");
      writeFileSync(path.join(wtSub, "README.md"), "hidden-edit\n");
      const assumeRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(assumeRes.deleted).toHaveLength(0);
      expect(assumeRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(assumeRes.skipped[0]?.error).toMatch(/assume-unchanged|skip-worktree/);
      expect(readFileSync(path.join(wtSub, "README.md"), "utf8")).toBe("hidden-edit\n");
      git(wtSub, "update-index", "--no-assume-unchanged", "README.md");
      git(wtSub, "checkout", "--", "README.md");

      // (d3) 真实合并冲突（未解决的 unmerged index + MERGE_HEAD）
      writeFileSync(path.join(wtSub, "README.md"), "branch-side\n");
      git(wtSub, "add", "README.md");
      git(wtSub, "commit", "-qm", "branch edit");
      writeFileSync(path.join(repo, "README.md"), "main-side\n");
      git(repo, "add", "README.md");
      git(repo, "commit", "-qm", "main edit");
      expect(() => git(wtSub, "merge", "main")).toThrow();
      const conflictRes = await rt.deleteManagedWorktrees({ ids: [subEntry.id] });
      expect(conflictRes.deleted).toHaveLength(0);
      expect(conflictRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(conflictRes.skipped[0]?.error).toMatch(/未完成的 Git 操作|合并冲突/);
      expect(existsSync(wtSub)).toBe(true);
      git(wtSub, "merge", "--abort");
    },
  );

  it(
    "删除前最终复核：快照后发生新本地修改、并发置顶或变为使用中时，中止删除、清理过期快照并保留原工作树",
    { timeout: 60_000 },
    async () => {
      const base = tempDir();
      const sessionsDir = path.join(base, "sessions");
      const repo = initRepo(path.join(base, "proj-recheck"));
      mkdirSync(sessionsDir, { recursive: true });

      const wtPath = path.join(base, "wt-race");
      git(repo, "worktree", "add", "-q", "-b", "nocturne/race", wtPath, "main");
      const entry = await registerManagedWorktree(sessionsDir, {
        kind: "session",
        repository: repo,
        worktreePath: wtPath,
        branch: "nocturne/race",
        ownsBranch: true,
        sessionId: "sess-race",
      });
      writeFileSync(path.join(wtPath, "README.md"), "snapshot-v1\n");

      let activeFlag = false;
      const inspector: ManagedWorktreeInspector = {
        isActive: () => activeFlag,
        sessionInfo: () => ({ title: "Race Session", exists: true }),
        worktreeConfig: () => ({ subagentRoot: "", autoDelete: true, keepCount: 1 }),
      };

      // 1) 快照建完后、删除前瞬间工作区写入新改动 -> 指纹不匹配，取消删除并清理过期快照
      let createdSnapDir: string | undefined;
      const mutRes = await deleteManagedWorktrees(sessionsDir, inspector, {
        ids: [entry.id],
        reason: "auto",
        saveSnapshot: true,
        beforeFinalRemoveCheck: ({ snapshot }) => {
          createdSnapDir = snapshot?.snapshotDir;
          writeFileSync(path.join(wtPath, "README.md"), "newer-edit-after-snapshot\n");
        },
      });
      expect(mutRes.deleted).toHaveLength(0);
      expect(mutRes.skipped).toHaveLength(1);
      expect(mutRes.skipped[0]?.status).toBe("skipped_snapshot_failed");
      expect(mutRes.skipped[0]?.error).toMatch(/状态.*发生变化|不一致/);
      expect(existsSync(wtPath)).toBe(true);
      expect(readFileSync(path.join(wtPath, "README.md"), "utf8")).toBe(
        "newer-edit-after-snapshot\n",
      );
      if (createdSnapDir !== undefined) {
        expect(existsSync(createdSnapDir)).toBe(false);
      }

      // 2) 快照建完后、删除前瞬间变为使用中 -> 保护复核拦截，取消删除并清理本次快照
      let activeSnapDir: string | undefined;
      const actRes = await deleteManagedWorktrees(sessionsDir, inspector, {
        ids: [entry.id],
        reason: "manual",
        saveSnapshot: true,
        beforeFinalRemoveCheck: ({ snapshot }) => {
          activeSnapDir = snapshot?.snapshotDir;
          activeFlag = true;
        },
      });
      expect(actRes.deleted).toHaveLength(0);
      expect(actRes.skipped).toHaveLength(1);
      expect(actRes.skipped[0]?.status).toBe("skipped_protected");
      expect(actRes.skipped[0]?.error).toMatch(/使用中/);
      expect(existsSync(wtPath)).toBe(true);
      if (activeSnapDir !== undefined) {
        expect(existsSync(activeSnapDir)).toBe(false);
      }
      activeFlag = false;

      // 3) 快照建完后、自动删除前瞬间条目被置顶（模拟跨进程写入注册表置顶）-> 保护复核拦截
      let pinSnapDir: string | undefined;
      const pinRes = await deleteManagedWorktrees(sessionsDir, inspector, {
        ids: [entry.id],
        reason: "auto",
        saveSnapshot: true,
        beforeFinalRemoveCheck: async ({ snapshot }) => {
          pinSnapDir = snapshot?.snapshotDir;
          // 模拟外部已置顶（绕过同进程 id 锁直接改注册表文件）
          const regPath = path.join(sessionsDir, "worktrees", "managed.json");
          const raw = JSON.parse(readFileSync(regPath, "utf8")) as {
            version: 1;
            entries: { id: string; pinned: boolean }[];
          };
          for (const rec of raw.entries) {
            if (rec.id === entry.id) rec.pinned = true;
          }
          writeFileSync(regPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        },
      });
      expect(pinRes.deleted).toHaveLength(0);
      expect(pinRes.skipped).toHaveLength(1);
      expect(pinRes.skipped[0]?.status).toBe("skipped_protected");
      expect(pinRes.skipped[0]?.error).toMatch(/置顶/);
      expect(existsSync(wtPath)).toBe(true);
      if (pinSnapDir !== undefined) {
        expect(existsSync(pinSnapDir)).toBe(false);
      }

      // 取消置顶后，正常自动删除并可完整恢复最新内容
      await setManagedWorktreePinned(sessionsDir, entry.id, false);
      const okRes = await deleteManagedWorktrees(sessionsDir, inspector, {
        ids: [entry.id],
        reason: "auto",
        saveSnapshot: true,
      });
      expect(okRes.deleted).toHaveLength(1);
      expect(existsSync(wtPath)).toBe(false);
      const okSnapId = okRes.deleted[0]?.snapshot?.id;
      if (okSnapId === undefined) throw new Error("expected recovery snapshot id");
      const restored = await restoreWorktreeRecoverySnapshot(sessionsDir, {
        snapshotId: okSnapId,
      });
      expect(readFileSync(path.join(restored.worktreePath, "README.md"), "utf8")).toBe(
        "newer-edit-after-snapshot\n",
      );
    },
  );
});
