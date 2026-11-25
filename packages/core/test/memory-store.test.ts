import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearMemoryDir,
  deleteMemoryEntry,
  describeMemoryStore,
  formatMemoryScopeIndex,
  listMemoryDir,
  projectMemoryKey,
  readMemoryEntry,
  resolveMemoryScopeDir,
  snapshotMemoryContext,
  writeMemoryEntry,
} from "../src/memory/index.js";
import { createPlatform } from "../src/platform/index.js";

const dirs: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("memory 存储与范围模块", () => {
  it("项目键：普通目录、git 主目录与它的工作树中后两者键相同，且各自创建 workspace.json", async () => {
    const platform = createPlatform();
    const root = makeTmp("nct-mem-key-");
    const home = path.join(root, "home");
    const plainDir = path.join(root, "plain");
    const repoDir = path.join(root, "repo");
    const wtDir = path.join(root, "repo-wt-feat");
    mkdirSync(home, { recursive: true });
    mkdirSync(plainDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    git(repoDir, ["init", "-q"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "README.md"), "# hi\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-q", "-m", "init"]);
    git(repoDir, ["worktree", "add", "-q", "-b", "feat", wtDir]);

    const plainKey = await projectMemoryKey(platform, plainDir);
    const repoKey = await projectMemoryKey(platform, repoDir);
    const wtKey = await projectMemoryKey(platform, wtDir);

    expect(plainKey.key).not.toBe(repoKey.key);
    expect(wtKey.key).toBe(repoKey.key);
    expect(platform.paths.equals(wtKey.repoRoot, repoKey.repoRoot)).toBe(true);

    // 首次写项目范围时创建 workspace.json 记下主仓库路径
    const wtResolved = await resolveMemoryScopeDir(platform, home, {
      scope: "project",
      workspaceRoot: wtDir,
    });
    expect(wtResolved).toBeDefined();
    if (!wtResolved) throw new Error("expected resolved project dir");
    await writeMemoryEntry(
      platform,
      { dir: wtResolved.dir, scope: "project", projectPath: wtResolved.projectPath },
      {
        name: "repo-rule",
        description: "Always run pnpm lint",
        type: "project",
        content: "Run pnpm lint.",
      },
    );

    const wsJson = JSON.parse(
      readFileSync(path.join(wtResolved.dir, "workspace.json"), "utf8"),
    ) as {
      version: number;
      path: string;
    };
    expect(wsJson.version).toBe(1);
    expect(platform.paths.equals(wsJson.path, repoKey.repoRoot)).toBe(true);

    // 主仓库路径下也能读到在工作树写入的记忆
    const descFromMain = await describeMemoryStore(platform, home, {
      workspaceRoot: repoDir,
      switches: { global: true, project: true },
    });
    expect(descFromMain.project?.entries.map((e) => e.name)).toEqual(["repo-rule"]);

    // 清理 git worktree 再删临时目录，避免 Windows 句柄占用
    git(repoDir, ["worktree", "remove", "--force", wtDir]);
  });

  it("默认工作区 <NOCTURNE_HOME>/workspace 没有项目范围，只有全局", async () => {
    const platform = createPlatform();
    const root = makeTmp("nct-mem-defws-");
    const home = path.join(root, "home");
    const defaultWs = path.join(home, "workspace");
    mkdirSync(defaultWs, { recursive: true });

    const resolvedProject = await resolveMemoryScopeDir(platform, home, {
      scope: "project",
      workspaceRoot: defaultWs,
    });
    expect(resolvedProject).toBeUndefined();

    const desc = await describeMemoryStore(platform, home, {
      workspaceRoot: defaultWs,
      switches: { global: true, project: true },
    });
    expect(desc.project).toBeUndefined();
    expect(desc.global.enabled).toBe(true);

    const snap = await snapshotMemoryContext(platform, home, {
      scopes: ["global", "project"],
      workspaceRoot: defaultWs,
      writable: true,
    });
    expect(snap?.scopes.map((s) => s.scope)).toEqual(["global"]);
    expect(snap?.scopes[0]?.text).toBe("(empty)");
  });

  it("写、读、覆盖同名、删与清空，以及前言损坏进入 warnings", async () => {
    const platform = createPlatform();
    const root = makeTmp("nct-mem-crud-");
    const home = path.join(root, "home");
    const ws = path.join(root, "proj");
    mkdirSync(home, { recursive: true });
    mkdirSync(ws, { recursive: true });

    const globalResolved = await resolveMemoryScopeDir(platform, home, { scope: "global" });
    if (!globalResolved) throw new Error("expected global dir");

    const written = await writeMemoryEntry(
      platform,
      { dir: globalResolved.dir, scope: "global" },
      {
        name: "user-style",
        description: "User prefers concise TypeScript",
        type: "user",
        content: "Keep responses concise.\nUse strict TypeScript.",
      },
    );
    expect(written.name).toBe("user-style");

    const read1 = await readMemoryEntry(platform, globalResolved.dir, "global", "user-style");
    expect(read1.ok).toBe(true);
    if (!read1.ok) throw new Error("expected ok");
    expect(read1.entry.description).toBe("User prefers concise TypeScript");
    expect(read1.entry.content).toBe("Keep responses concise.\nUse strict TypeScript.");

    // 覆盖同名
    await writeMemoryEntry(
      platform,
      { dir: globalResolved.dir, scope: "global" },
      {
        name: "user-style",
        description: "Updated preference",
        type: "feedback",
        content: "Updated body.",
      },
    );
    const read2 = await readMemoryEntry(platform, globalResolved.dir, "global", "user-style");
    expect(read2.ok).toBe(true);
    if (read2.ok) {
      expect(read2.entry.type).toBe("feedback");
      expect(read2.entry.description).toBe("Updated preference");
      expect(read2.entry.content).toBe("Updated body.");
    }

    // 写入损坏前言的文件和命名不匹配的 .md 文件
    writeFileSync(
      path.join(globalResolved.dir, "broken-yaml.md"),
      "---\nname: [broken\n---\nbody\n",
    );
    writeFileSync(
      path.join(globalResolved.dir, "wrong-name.md"),
      "---\nname: other-name\ndescription: mismatch\ntype: user\n---\nbody\n",
    );
    writeFileSync(
      path.join(globalResolved.dir, "bad-type.md"),
      "---\nname: bad-type\ndescription: bad\ntype: unknown\n---\nbody\n",
    );

    const listed = await listMemoryDir(platform, globalResolved.dir);
    expect(listed.entries.map((e) => e.name)).toEqual(["user-style"]);
    expect(listed.warnings).toHaveLength(3);

    // 删除单条
    expect(await deleteMemoryEntry(platform, globalResolved.dir, "user-style")).toBe(true);
    expect(await deleteMemoryEntry(platform, globalResolved.dir, "user-style")).toBe(false);

    // 项目记忆 + otherProjects + 清空范围
    const projResolved = await resolveMemoryScopeDir(platform, home, {
      scope: "project",
      workspaceRoot: ws,
    });
    if (!projResolved) throw new Error("expected project dir");
    await writeMemoryEntry(
      platform,
      { dir: projResolved.dir, scope: "project", projectPath: projResolved.projectPath },
      {
        name: "build-cmd",
        description: "Run pnpm build",
        type: "project",
        content: "Use pnpm build.",
      },
    );

    const otherWs = path.join(root, "other-ws");
    mkdirSync(otherWs, { recursive: true });
    const descOther = await describeMemoryStore(platform, home, {
      workspaceRoot: otherWs,
      switches: { global: true, project: true },
    });
    expect(descOther.otherProjects).toHaveLength(1);
    expect(descOther.otherProjects[0]).toMatchObject({
      key: projResolved.key,
      count: 1,
    });
    // 其他项目条目以摘要形式随总览返回（ADR-0122 §2），列表、详情页不再需要额外枚举请求
    expect(descOther.otherProjects[0]?.entries).toHaveLength(1);
    expect(descOther.otherProjects[0]?.entries[0]).toMatchObject({
      name: "build-cmd",
      description: "Run pnpm build",
      type: "project",
    });

    await clearMemoryDir(platform, projResolved.dir, "project");
    const descAfterClear = await describeMemoryStore(platform, home, {
      workspaceRoot: otherWs,
      switches: { global: true, project: true },
    });
    expect(descAfterClear.otherProjects).toEqual([]);
  });

  it("索引生成：空范围为 (empty)，超过 25,000 字符截断并加标记", () => {
    expect(formatMemoryScopeIndex([])).toEqual({ text: "(empty)", truncated: false });

    const small = formatMemoryScopeIndex([
      { name: "a", type: "user", description: "alpha" },
      { name: "b", type: "project", description: "beta" },
    ]);
    expect(small).toEqual({
      text: "- a (user): alpha\n- b (project): beta",
      truncated: false,
    });

    const entries = Array.from({ length: 120 }, (_, i) => ({
      name: `item-${String(i).padStart(3, "0")}`,
      type: "project" as const,
      description: "x".repeat(280),
    }));
    const big = formatMemoryScopeIndex(entries);
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThanOrEqual(25_000);
    expect(big.text).toContain("[truncated:");
    expect(big.text).toContain("- item-000 (project):");
    expect(big.text).not.toContain("- item-119 (project):");
  });
});
