import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectDependents,
  computeWorkspaceFingerprint,
  discoverWorkspaces,
  formatReport,
  getCachedStep,
  getVerifyCachePath,
  isDocOnlyFile,
  makeStepCacheKey,
  parseDepcheckSummary,
  parseLintSummary,
  parseVerifyArgs,
  parseVitestSummary,
  planVerifyTests,
  readVerifyCache,
  stripProxyEnv,
  tailLines,
  writeVerifyCacheStep,
} from "../verify.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

const sampleWorkspaces = [
  { name: "@nocturne/core", dir: "packages/core", hasTest: true, deps: [] },
  { name: "@nocturne/remote", dir: "packages/remote", hasTest: true, deps: [] },
  {
    name: "@nocturne/rpc",
    dir: "packages/rpc",
    hasTest: true,
    deps: ["@nocturne/core", "@nocturne/remote"],
  },
  { name: "@nocturne/tui", dir: "apps/tui", hasTest: true, deps: ["@nocturne/core"] },
  {
    name: "@nocturne/desktop",
    dir: "apps/desktop",
    hasTest: true,
    deps: ["@nocturne/core", "@nocturne/remote", "@nocturne/rpc"],
  },
  {
    name: "@nocturne/cli",
    dir: "apps/cli",
    hasTest: true,
    deps: ["@nocturne/core", "@nocturne/rpc", "@nocturne/tui"],
  },
];

describe("verify helpers", () => {
  it("stripProxyEnv 去掉大小写形式的 HTTP_PROXY / HTTPS_PROXY，保留其余变量", () => {
    const cleaned = stripProxyEnv({
      PATH: "/usr/bin",
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      Http_Proxy: "http://127.0.0.1:7890",
      NO_PROXY: "localhost",
    });
    expect(cleaned).toEqual({ PATH: "/usr/bin", NO_PROXY: "localhost" });
  });

  it("parseVerifyArgs 解析默认与显式参数并拦截非法参数", () => {
    expect(parseVerifyArgs([])).toEqual({
      help: false,
      base: "main",
      report: undefined,
      skipBuild: false,
      noCache: false,
    });
    expect(
      parseVerifyArgs([
        "--base",
        "origin/main",
        "--report",
        "Z:/out/r.md",
        "--skip-build",
        "--no-cache",
      ]),
    ).toEqual({
      help: false,
      base: "origin/main",
      report: "Z:/out/r.md",
      skipBuild: true,
      noCache: true,
    });
    expect(parseVerifyArgs(["--", "--base=dev", "--report=Z:/out/a.md", "--no-cache"])).toEqual({
      help: false,
      base: "dev",
      report: "Z:/out/a.md",
      skipBuild: false,
      noCache: true,
    });
    expect(() => parseVerifyArgs(["--unknown"])).toThrow(/未知参数/);
    expect(() => parseVerifyArgs(["--base"])).toThrow(/--base 缺少参数值/);
    expect(() => parseVerifyArgs(["--report", "--skip-build"])).toThrow(/--report 缺少参数值/);
  });

  it("isDocOnlyFile 区分文档文件与代码文件", () => {
    expect(isDocOnlyFile("docs/development/workflow.md")).toBe(true);
    expect(isDocOnlyFile("site-docs/index.md")).toBe(true);
    expect(isDocOnlyFile("AGENTS.md")).toBe(true);
    expect(isDocOnlyFile("README.md")).toBe(true);
    expect(isDocOnlyFile("scripts/verify.mjs")).toBe(false);
    expect(isDocOnlyFile("packages/core/README.md")).toBe(false);
    expect(isDocOnlyFile("package.json")).toBe(false);
  });

  it("discoverWorkspaces 能发现仓库内全部 workspace 包及依赖边", () => {
    const workspaces = discoverWorkspaces(repoRoot);
    const byName = new Map(workspaces.map((w) => [w.name, w]));
    expect(byName.has("@nocturne/core")).toBe(true);
    expect(byName.has("@nocturne/tui")).toBe(true);
    expect(byName.has("@nocturne/desktop")).toBe(true);
    expect(byName.has("@nocturne/cli")).toBe(true);
    expect(byName.get("@nocturne/cli")?.deps).toContain("@nocturne/core");
    expect(byName.get("@nocturne/cli")?.deps).toContain("@nocturne/tui");
    expect(byName.get("@nocturne/relay")?.deps).toContain("@nocturne/core");
  });

  it("collectDependents 递归追踪跨多跳依赖方", () => {
    const affected = collectDependents(["@nocturne/remote"], sampleWorkspaces);
    // cli 不直接依赖 remote，但经 rpc 传递依赖 remote
    expect([...affected.keys()].sort()).toEqual([
      "@nocturne/cli",
      "@nocturne/desktop",
      "@nocturne/rpc",
    ]);
    expect([...affected.get("@nocturne/cli")]).toEqual(["@nocturne/remote"]);
  });

  it("planVerifyTests：仅文档改动时跳过全部测试", () => {
    const plan = planVerifyTests(
      ["docs/development/workflow.md", "site-docs/cli.md", "AGENTS.md"],
      sampleWorkspaces,
    );
    expect(plan.skippedReason).toBe("仅文档变更");
    expect(plan.directPackages).toEqual([]);
    expect(plan.relatedPackages).toEqual([]);
    expect(plan.runScriptsTests).toBe(false);
  });

  it("planVerifyTests：只改 scripts/ 时仅跑 scripts 测试", () => {
    const plan = planVerifyTests(["scripts/verify.mjs", "AGENTS.md"], sampleWorkspaces);
    expect(plan.skippedReason).toBeNull();
    expect(plan.directPackages).toEqual([]);
    expect(plan.relatedPackages).toEqual([]);
    expect(plan.runScriptsTests).toBe(true);
  });

  it("planVerifyTests：改 core 源文件时直接跑 core 全量，递归依赖方跑 related", () => {
    const plan = planVerifyTests(["packages/core/src/protocol/view.ts"], sampleWorkspaces);
    expect(plan.skippedReason).toBeNull();
    expect(plan.directPackages.map((p) => p.name)).toEqual(["@nocturne/core"]);
    expect(plan.relatedPackages.map((p) => p.name)).toEqual([
      "@nocturne/rpc",
      "@nocturne/desktop",
      "@nocturne/tui",
      "@nocturne/cli",
    ]);
    for (const rel of plan.relatedPackages) {
      expect(rel.sourceFiles).toEqual(["packages/core/src/protocol/view.ts"]);
    }
    expect(plan.runScriptsTests).toBe(false);
  });

  it("planVerifyTests：只改 core 测试文件时下游不跑 related", () => {
    const plan = planVerifyTests(["packages/core/test/agent.test.ts"], sampleWorkspaces);
    expect(plan.directPackages.map((p) => p.name)).toEqual(["@nocturne/core"]);
    expect(plan.relatedPackages).toEqual([]);
  });

  it("planVerifyTests：同时改上游与下游包时，已进直接全量的包不重复进 related，更下游合并双方源文件", () => {
    const plan = planVerifyTests(
      ["packages/core/src/a.ts", "apps/tui/src/b.tsx"],
      sampleWorkspaces,
    );
    expect(plan.directPackages.map((p) => p.name)).toEqual(["@nocturne/core", "@nocturne/tui"]);
    const relMap = new Map(plan.relatedPackages.map((p) => [p.name, p.sourceFiles]));
    expect(relMap.has("@nocturne/tui")).toBe(false);
    expect(relMap.get("@nocturne/cli")).toEqual(["apps/tui/src/b.tsx", "packages/core/src/a.ts"]);
    expect(relMap.get("@nocturne/desktop")).toEqual(["packages/core/src/a.ts"]);
  });

  it("摘要解析与失败尾部 30 行截断准确", () => {
    expect(
      parseVitestSummary(" Test Files  10 passed (10)\n      Tests  67 passed (67)\n", 0),
    ).toBe("67/67 通过");
    expect(
      parseVitestSummary(
        " Test Files  1 failed | 9 passed (10)\n      Tests  2 failed | 65 passed (67)\n",
        1,
      ),
    ).toBe("65/67 通过，2 失败");
    expect(parseVitestSummary("No test files found, exiting with code 0\n", 0)).toBe(
      "0/0 通过（无相关测试）",
    );

    expect(parseLintSummary("间距警告 598 处\n", 0)).toBe("0 错误，598 警告");
    expect(parseLintSummary("✖ 3 problems (2 errors, 1 warning)\n间距警告 598 处\n", 1)).toBe(
      "2 错误，599 警告",
    );
    expect(
      parseDepcheckSummary("✔ no dependency violations found (120 modules, 400 dependencies)\n", 0),
    ).toBe("0 违规");
    expect(parseDepcheckSummary("2 dependency violations (2 errors, 0 warnings)\n", 1)).toBe(
      "2 违规（2 错误，0 警告）",
    );

    const fortyLines = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
    const tail = tailLines(fortyLines, 30).split("\n");
    expect(tail).toHaveLength(30);
    expect(tail[0]).toBe("line-11");
    expect(tail[29]).toBe("line-40");

    const report = formatReport({
      baseRef: "main",
      mergeBase: "00bdf30dda75a6b4",
      changedFiles: ["scripts/verify.mjs"],
      skippedTestsReason: null,
      results: [
        { name: "typecheck", ok: true, durationMs: 1200, summary: "通过", output: "" },
        {
          name: "lint",
          ok: false,
          durationMs: 2500,
          summary: "1 错误，598 警告",
          output: fortyLines,
        },
      ],
    });
    expect(report).toContain("| typecheck | PASS | 1.2s | 通过 |");
    expect(report).toContain("| lint | FAIL | 2.5s | 1 错误，598 警告 |");
    expect(report).toContain("## 失败输出：lint");
    expect(report).toContain("line-11");
    expect(report).not.toContain("line-10\n");
  });

  it("formatReport 命中缓存的步骤显示 PASS (cached) 且顶部总状态按 PASS 计算", () => {
    const report = formatReport({
      baseRef: "main",
      mergeBase: "00bdf30dda75a6b4",
      changedFiles: ["scripts/verify.mjs"],
      skippedTestsReason: null,
      results: [
        {
          name: "typecheck",
          ok: true,
          cached: true,
          durationMs: 1200,
          summary: "通过",
          output: "",
        },
        {
          name: "lint",
          ok: true,
          cached: false,
          durationMs: 2500,
          summary: "0 错误，598 警告",
          output: "",
        },
      ],
    });
    expect(report).toContain("- 状态: PASS");
    expect(report).toContain("| typecheck | PASS (cached) | 1.2s | 通过 |");
    expect(report).toContain("| lint | PASS | 2.5s | 0 错误，598 警告 |");
  });
});

describe("verify cache", () => {
  const tempDirs = [];

  function createTempGitRepo() {
    const dir = mkdtempSync(join(tmpdir(), "nocturne-verify-cache-test-"));
    tempDirs.push(dir);
    const git = (args) => {
      const res = spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        windowsHide: true,
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`git ${args.join(" ")} 失败：${res.stderr || res.stdout}`);
      }
      return res.stdout;
    };

    git(["init"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(dir, ".gitignore"), "ignored.log\nignored-dir/\n", "utf8");
    writeFileSync(join(dir, "tracked-a.txt"), "a-v1\n", "utf8");
    writeFileSync(join(dir, "tracked-b.txt"), "b-v1\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    return { dir, git };
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("指纹随已跟踪改动、暂存改动与未跟踪文件变化，忽略 .gitignore 文件，且不改动真实 index", () => {
    const { dir, git } = createTempGitRepo();

    const fpClean = computeWorkspaceFingerprint(dir);
    expect(fpClean).toMatch(/^[0-9a-f]{40}$/);

    // 已跟踪文件未暂存改动
    writeFileSync(join(dir, "tracked-a.txt"), "a-v2\n", "utf8");
    const fpModified = computeWorkspaceFingerprint(dir);
    expect(fpModified).not.toBe(fpClean);

    // 暂存改动
    writeFileSync(join(dir, "tracked-b.txt"), "b-v2\n", "utf8");
    git(["add", "tracked-b.txt"]);
    const fpStaged = computeWorkspaceFingerprint(dir);
    expect(fpStaged).not.toBe(fpModified);

    // 新增未跟踪文件
    writeFileSync(join(dir, "untracked.txt"), "hello\n", "utf8");
    const fpUntracked = computeWorkspaceFingerprint(dir);
    expect(fpUntracked).not.toBe(fpStaged);

    // 被 .gitignore 忽略的文件变化时指纹不变
    writeFileSync(join(dir, "ignored.log"), "noise-1\n", "utf8");
    mkdirSync(join(dir, "ignored-dir"), { recursive: true });
    writeFileSync(join(dir, "ignored-dir", "tmp.txt"), "noise-2\n", "utf8");
    const fpIgnored = computeWorkspaceFingerprint(dir);
    expect(fpIgnored).toBe(fpUntracked);

    // 计算指纹前后真实 index 完全不变
    const indexPath = join(dir, ".git", "index");
    const cachedBefore = git(["diff", "--cached", "--name-only"]);
    const indexBytesBefore = readFileSync(indexPath);

    const fpRepeat = computeWorkspaceFingerprint(dir);
    expect(fpRepeat).toBe(fpUntracked);

    const cachedAfter = git(["diff", "--cached", "--name-only"]);
    const indexBytesAfter = readFileSync(indexPath);
    expect(cachedAfter).toBe(cachedBefore);
    expect(cachedAfter.trim()).toBe("tracked-b.txt");
    expect(indexBytesAfter.equals(indexBytesBefore)).toBe(true);
  });

  it("缓存按指纹和命令参数读写，指纹变化时丢弃旧记录，FAIL 不写入，损坏文件按无缓存处理", () => {
    const { dir } = createTempGitRepo();
    const cachePath = getVerifyCachePath(dir);
    expect(cachePath).toBe(join(dir, ".git", "verify-cache.json"));

    const stepTypecheck = { name: "typecheck", cmd: "pnpm", args: ["typecheck"] };
    const stepLint = { name: "lint", cmd: "pnpm", args: ["lint"] };
    const stepLintOtherArgs = { name: "lint", cmd: "pnpm", args: ["lint", "--fix"] };

    const fp1 = computeWorkspaceFingerprint(dir);

    // 写入 PASS 步骤并在同一指纹下命中
    expect(
      writeVerifyCacheStep(cachePath, fp1, stepTypecheck, {
        ok: true,
        durationMs: 3200,
        summary: "通过",
      }),
    ).toBe(true);

    // FAIL 步骤不写入缓存
    expect(
      writeVerifyCacheStep(cachePath, fp1, stepLint, {
        ok: false,
        durationMs: 1800,
        summary: "1 错误，598 警告",
      }),
    ).toBe(false);

    const cache1 = readVerifyCache(cachePath);
    expect(getCachedStep(cache1, fp1, stepTypecheck)).toEqual({
      durationMs: 3200,
      summary: "通过",
    });
    expect(getCachedStep(cache1, fp1, stepLint)).toBeNull();
    // 参数不同也不命中
    expect(getCachedStep(cache1, fp1, stepLintOtherArgs)).toBeNull();

    // 指纹变化后查询不命中，写入新指纹时整份丢弃旧记录
    writeFileSync(join(dir, "tracked-a.txt"), "a-v3\n", "utf8");
    const fp2 = computeWorkspaceFingerprint(dir);
    expect(fp2).not.toBe(fp1);
    expect(getCachedStep(cache1, fp2, stepTypecheck)).toBeNull();

    expect(
      writeVerifyCacheStep(cachePath, fp2, stepLint, {
        ok: true,
        durationMs: 4100,
        summary: "0 错误，598 警告",
      }),
    ).toBe(true);

    const cache2 = readVerifyCache(cachePath);
    expect(cache2?.fingerprint).toBe(fp2);
    expect(Object.keys(cache2?.steps ?? {})).toEqual([makeStepCacheKey(stepLint)]);
    expect(getCachedStep(cache2, fp2, stepTypecheck)).toBeNull();
    expect(getCachedStep(cache2, fp2, stepLint)).toEqual({
      durationMs: 4100,
      summary: "0 错误，598 警告",
    });

    // 缓存文件损坏或格式非法时按无缓存处理，不报错
    writeFileSync(cachePath, "{not valid json", "utf8");
    expect(readVerifyCache(cachePath)).toBeNull();

    writeFileSync(cachePath, JSON.stringify({ version: 99, fingerprint: fp2, steps: {} }), "utf8");
    expect(readVerifyCache(cachePath)).toBeNull();

    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        fingerprint: fp2,
        steps: { [makeStepCacheKey(stepLint)]: { durationMs: "bad", summary: 123 } },
      }),
      "utf8",
    );
    expect(getCachedStep(readVerifyCache(cachePath), fp2, stepLint)).toBeNull();
  });
});
