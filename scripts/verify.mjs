#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** 去掉 ANSI 颜色/光标转义序列，便于稳定解析和写入报告 */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

/** 去掉大小写形式的 HTTP_PROXY / HTTPS_PROXY，避免子进程访问本地端口或离线测试走代理 */
export function stripProxyEnv(env = process.env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^https?_proxy$/i.test(key)) continue;
    next[key] = value;
  }
  return next;
}

/** 解析 pnpm verify CLI 参数 */
export function parseVerifyArgs(argv = process.argv.slice(2)) {
  let base = "main";
  let report;
  let skipBuild = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--base") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--base 缺少参数值");
      base = value;
    } else if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (!value) throw new Error("--base 缺少参数值");
      base = value;
    } else if (arg === "--report") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("--report 缺少参数值");
      report = value;
    } else if (arg.startsWith("--report=")) {
      const value = arg.slice("--report=".length);
      if (!value) throw new Error("--report 缺少参数值");
      report = value;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, base, report, skipBuild };
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return { help: false, base, report, skipBuild };
}

/** 仅文档文件（docs/、site-docs/ 或根目录 Markdown） */
export function isDocOnlyFile(relPath) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm.startsWith("docs/") || norm.startsWith("site-docs/")) return true;
  return !norm.includes("/") && /\.md$/i.test(norm);
}

/** 包内用于传给下游 `vitest related` 的源文件判定（排除包内测试与 Markdown） */
export function isSourceFileForRelated(relPath, pkgDir) {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const prefix = `${pkgDir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  if (!norm.startsWith(prefix)) return false;
  const inside = norm.slice(prefix.length);
  if (!inside) return false;
  if (inside.startsWith("test/") || inside.includes("/test/")) return false;
  if (/\.(test|spec|smoke)\.[^/]+$/i.test(inside)) return false;
  if (/\.md$/i.test(inside)) return false;
  return true;
}

/** 从 pnpm-workspace.yaml 提取 packages 条目（形如 `packages/*`、`apps/*`） */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim()) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^\S/.test(line)) {
        inPackages = false;
        continue;
      }
      const match = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (match) globs.push(match[1]);
    }
  }
  return globs;
}

/** 扫描仓库内所有 workspace 包及其内部依赖关系 */
export function discoverWorkspaces(repoRoot = defaultRepoRoot) {
  const wsYamlPath = join(repoRoot, "pnpm-workspace.yaml");
  const globs = existsSync(wsYamlPath)
    ? parseWorkspaceGlobs(readFileSync(wsYamlPath, "utf8"))
    : ["packages/*", "apps/*"];

  const dirs = [];
  for (const pattern of globs) {
    const norm = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.endsWith("/*")) {
      const parent = norm.slice(0, -2);
      const fullParent = join(repoRoot, parent);
      if (!existsSync(fullParent)) continue;
      for (const entry of readdirSync(fullParent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relDir = `${parent}/${entry.name}`;
        if (existsSync(join(repoRoot, relDir, "package.json"))) dirs.push(relDir);
      }
    } else if (existsSync(join(repoRoot, norm, "package.json"))) {
      dirs.push(norm);
    }
  }

  const rawPackages = dirs.sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
    return {
      name: pkg.name,
      dir,
      hasTest: Boolean(pkg.scripts?.test),
      rawDeps: {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      },
    };
  });

  const knownNames = new Set(rawPackages.map((p) => p.name));
  return rawPackages.map((p) => {
    const deps = Object.keys(p.rawDeps)
      .filter((depName) => knownNames.has(depName) && depName !== p.name)
      .sort();
    return {
      name: p.name,
      dir: p.dir,
      hasTest: p.hasTest,
      deps,
    };
  });
}

/** 计算包拓扑顺序（被依赖者在前，依赖者在后） */
export function sortTopologically(workspaces) {
  const byName = new Map(workspaces.map((ws) => [ws.name, ws]));
  const inDegree = new Map(workspaces.map((ws) => [ws.name, 0]));
  const dependents = new Map(workspaces.map((ws) => [ws.name, []]));

  for (const ws of workspaces) {
    for (const dep of ws.deps) {
      if (!byName.has(dep)) continue;
      dependents.get(dep).push(ws.name);
      inDegree.set(ws.name, (inDegree.get(ws.name) ?? 0) + 1);
    }
  }

  const ready = workspaces
    .filter((ws) => (inDegree.get(ws.name) ?? 0) === 0)
    .map((ws) => ws.name)
    .sort();
  const order = [];

  while (ready.length > 0) {
    const name = ready.shift();
    order.push(byName.get(name));
    for (const next of (dependents.get(name) ?? []).sort()) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  // 若出现循环依赖，兜底把剩余包按名称附在后面
  if (order.length < workspaces.length) {
    const seen = new Set(order.map((w) => w.name));
    for (const ws of [...workspaces].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!seen.has(ws.name)) order.push(ws);
    }
  }
  return order;
}

/**
 * 按 workspace 依赖关系递归找出依赖 changedPkgNames 中任意包的下游包，
 * 并记录每个下游包实际依赖了哪些已改动源包（用于只传相关包的改动源文件）。
 */
export function collectDependents(changedPkgNames, workspaces) {
  const reverse = new Map(workspaces.map((ws) => [ws.name, []]));
  for (const ws of workspaces) {
    for (const dep of ws.deps) {
      if (reverse.has(dep)) reverse.get(dep).push(ws.name);
    }
  }

  /** @type {Map<string, Set<string>>} 下游包名 -> 其递归依赖的已改动包名集合 */
  const affectedBy = new Map();

  for (const rootPkg of changedPkgNames) {
    if (!reverse.has(rootPkg)) continue;
    const visited = new Set([rootPkg]);
    const queue = [rootPkg];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const depOfCurrent of reverse.get(current) ?? []) {
        if (visited.has(depOfCurrent)) continue;
        visited.add(depOfCurrent);
        queue.push(depOfCurrent);
        if (!affectedBy.has(depOfCurrent)) affectedBy.set(depOfCurrent, new Set());
        affectedBy.get(depOfCurrent).add(rootPkg);
      }
    }
  }

  return affectedBy;
}

/**
 * 纯函数：根据改动文件清单与 workspace 图，决定本次应跑哪些测试。
 */
export function planVerifyTests(changedFiles, workspaces) {
  const normalized = [
    ...new Set(changedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean)),
  ].sort();

  if (normalized.length === 0) {
    return {
      skippedReason: "无改动文件",
      directPackages: [],
      relatedPackages: [],
      runScriptsTests: false,
    };
  }

  if (normalized.every((file) => isDocOnlyFile(file))) {
    return {
      skippedReason: "仅文档变更",
      directPackages: [],
      relatedPackages: [],
      runScriptsTests: false,
    };
  }

  const ordered = sortTopologically(workspaces);
  const directSet = new Set();
  /** @type {Map<string, string[]>} */
  const changedSourcesByPkg = new Map();
  let runScriptsTests = false;

  // 按目录长度降序匹配，避免嵌套路径歧义
  const matchOrder = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);

  for (const file of normalized) {
    if (file.startsWith("scripts/")) {
      runScriptsTests = true;
    }
    const owner = matchOrder.find((ws) => {
      const prefix = `${ws.dir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
      return file.startsWith(prefix);
    });
    if (!owner) continue;
    directSet.add(owner.name);
    if (isSourceFileForRelated(file, owner.dir)) {
      if (!changedSourcesByPkg.has(owner.name)) changedSourcesByPkg.set(owner.name, []);
      changedSourcesByPkg.get(owner.name).push(file);
    }
  }

  const directPackages = ordered
    .filter((ws) => directSet.has(ws.name) && ws.hasTest)
    .map((ws) => ({ name: ws.name, dir: ws.dir }));

  const pkgsWithSourceChanges = [...changedSourcesByPkg.keys()];
  const affectedBy = collectDependents(pkgsWithSourceChanges, workspaces);

  const relatedPackages = ordered
    .filter((ws) => !directSet.has(ws.name) && ws.hasTest && affectedBy.has(ws.name))
    .map((ws) => {
      const sourceFiles = new Set();
      for (const upstream of affectedBy.get(ws.name)) {
        for (const file of changedSourcesByPkg.get(upstream) ?? []) {
          sourceFiles.add(file);
        }
      }
      return {
        name: ws.name,
        dir: ws.dir,
        sourceFiles: [...sourceFiles].sort(),
      };
    })
    .filter((item) => item.sourceFiles.length > 0);

  return {
    skippedReason: null,
    directPackages,
    relatedPackages,
    runScriptsTests,
  };
}

/** 收集 merge-base 以来已提交 + 暂存 + 工作区 + 未跟踪的改动文件，去掉已删除文件 */
export function collectChangedFiles(repoRoot, baseRef, env) {
  const git = (args) => {
    const res = spawnSync("git", args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} 失败：${(res.stderr || res.stdout || "").trim()}`);
    }
    return res.stdout;
  };

  const mergeBase = git(["merge-base", baseRef, "HEAD"]).trim();
  const splitNul = (text) => text.split("\0").filter(Boolean);

  const rawFiles = new Set([
    ...splitNul(git(["diff", "--name-only", "-z", `${mergeBase}...HEAD`])),
    ...splitNul(git(["diff", "--name-only", "-z", "--cached"])),
    ...splitNul(git(["diff", "--name-only", "-z"])),
    ...splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);

  const existing = [...rawFiles]
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => existsSync(resolve(repoRoot, file)))
    .sort();

  return { mergeBase, files: existing };
}

/** 解析 vitest 输出中的测试数与通过数 */
export function parseVitestSummary(output, exitCode) {
  const clean = stripAnsi(output);
  if (/No test files found/i.test(clean) && exitCode === 0) {
    return "0/0 通过（无相关测试）";
  }

  const testsLines = [...clean.matchAll(/^\s*Tests\s+(.+)$/gm)];
  const last = testsLines.at(-1)?.[1];
  if (!last) {
    return exitCode === 0 ? "通过" : `失败（退出码 ${exitCode}）`;
  }

  const totalMatch = /\((\d+)\)/.exec(last);
  const passedMatch = /(\d+)\s+passed/.exec(last);
  const failedMatch = /(\d+)\s+failed/.exec(last);
  const skippedMatch = /(\d+)\s+skipped/.exec(last);

  const total = totalMatch ? Number(totalMatch[1]) : 0;
  const passed = passedMatch ? Number(passedMatch[1]) : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;

  const parts = [`${passed}/${total} 通过`];
  if (failed > 0) parts.push(`${failed} 失败`);
  if (skipped > 0) parts.push(`${skipped} 跳过`);
  return parts.join("，");
}

/** 解析 lint（eslint + stylelint + check 脚本）的错误数和警告数 */
export function parseLintSummary(output, exitCode) {
  const clean = stripAnsi(output);
  let errors = 0;
  let warnings = 0;

  for (const m of clean.matchAll(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/g)) {
    errors += Number(m[2]);
    warnings += Number(m[3]);
  }

  for (const m of clean.matchAll(/间距警告(?:已降到)?\s*(\d+)\s*处/g)) {
    warnings += Number(m[1]);
  }

  // stylelint 逐条错误行（例如 `  12:3  Unexpected ...`）
  if (exitCode !== 0 && errors === 0) {
    const styleErrors = [...clean.matchAll(/^\s+\d+:\d+\s+\S/gm)].length;
    const scriptErrors = [
      ...clean.matchAll(/undefined CSS variable|路径不存在|不存在|不一致|mismatch|exceeded/gi),
    ].length;
    errors = styleErrors > 0 ? styleErrors : Math.max(1, scriptErrors);
  }

  return `${errors} 错误，${warnings} 警告`;
}

/** 解析 depcheck 输出 */
export function parseDepcheckSummary(output, exitCode) {
  const clean = stripAnsi(output);
  const m = /(\d+)\s+dependency violations?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/i.exec(
    clean,
  );
  if (m) {
    return `${m[1]} 违规（${m[2]} 错误，${m[3]} 警告）`;
  }
  return exitCode === 0 ? "0 违规" : `失败（退出码 ${exitCode}）`;
}

/** 解析 typecheck / format:check / build 输出 */
export function parseGenericSummary(kind, output, exitCode) {
  const clean = stripAnsi(output);
  if (kind === "typecheck") {
    if (exitCode === 0) return "通过";
    const tsErrors = [...clean.matchAll(/error TS\d+:/g)].length;
    return tsErrors > 0 ? `${tsErrors} 个类型错误` : `失败（退出码 ${exitCode}）`;
  }
  if (kind === "format:check") {
    if (exitCode === 0) return "通过";
    const warnFiles = [...clean.matchAll(/^\[warn\]\s+(?!Code style issues found)/gm)].length;
    return warnFiles > 0 ? `${warnFiles} 个文件格式不符` : `失败（退出码 ${exitCode}）`;
  }
  return exitCode === 0 ? "通过" : `失败（退出码 ${exitCode}）`;
}

/** 取末尾 N 行（去掉首尾空白行后截取） */
export function tailLines(text, maxLines = 30) {
  const clean = stripAnsi(text).replace(/\r\n/g, "\n");
  const lines = clean.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/** 格式化耗时 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 渲染步骤汇总行 */
export function formatStepRow(result) {
  const status = result.ok ? "PASS" : "FAIL";
  return `| ${result.name} | ${status} | ${formatDuration(result.durationMs)} | ${result.summary} |`;
}

/** 生成完整 Markdown 报告（终端与 --report 共用同一内容） */
export function formatReport({ baseRef, mergeBase, changedFiles, results, skippedTestsReason }) {
  const allOk = results.every((r) => r.ok);
  const lines = [
    "# Verify Report",
    "",
    `- Base: \`${baseRef}\` (\`${mergeBase.slice(0, 10)}\`)`,
    `- 改动文件: ${changedFiles.length} 个`,
    `- 状态: ${allOk ? "PASS" : "FAIL"}`,
  ];
  if (skippedTestsReason) {
    lines.push(`- 测试: 跳过（${skippedTestsReason}）`);
  }
  lines.push("", "| 步骤 | 状态 | 耗时 | 关键结果 |", "|---|---|---|---|");
  for (const r of results) {
    lines.push(formatStepRow(r));
  }

  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    lines.push("", `## 失败输出：${f.name}`, "", "```text", tailLines(f.output, 30), "```");
  }
  lines.push("");
  return lines.join("\n");
}

function quoteWin(arg) {
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function runCommand(cmd, args, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const win = process.platform === "win32";
    const command = win ? [cmd, ...args].map(quoteWin).join(" ") : cmd;
    const child = spawn(command, win ? [] : args, {
      cwd,
      env,
      shell: win,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      resolvePromise({
        exitCode: 1,
        durationMs: Date.now() - start,
        output: `${output}\n${error.message}`,
      });
    });
    child.once("exit", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        output,
      });
    });
  });
}

async function runVerify(argv = process.argv.slice(2), repoRoot = defaultRepoRoot) {
  const args = parseVerifyArgs(argv);
  if (args.help) {
    console.log(
      "用法: pnpm verify [--base <ref>] [--report <绝对路径>] [--skip-build]\n" +
        "  --base <ref>       对比基准分支/提交，默认 main（取与 HEAD 的 merge-base）\n" +
        "  --report <路径>    将 Markdown 汇总写入指定路径\n" +
        "  --skip-build       跳过最后的 build 步骤",
    );
    return 0;
  }

  const env = stripProxyEnv(process.env);
  const { mergeBase, files: changedFiles } = collectChangedFiles(repoRoot, args.base, env);
  const workspaces = discoverWorkspaces(repoRoot);
  const testPlan = planVerifyTests(changedFiles, workspaces);

  const steps = [
    { name: "typecheck", kind: "typecheck", cmd: "pnpm", args: ["typecheck"] },
    { name: "lint", kind: "lint", cmd: "pnpm", args: ["lint"] },
    { name: "format:check", kind: "format:check", cmd: "pnpm", args: ["format:check"] },
    { name: "depcheck", kind: "depcheck", cmd: "pnpm", args: ["depcheck"] },
  ];

  for (const pkg of testPlan.directPackages) {
    steps.push({
      name: `test: ${pkg.name} (full)`,
      kind: "vitest",
      cmd: "pnpm",
      args: ["--dir", pkg.dir, "exec", "vitest", "run", "--maxWorkers=2"],
    });
  }

  for (const pkg of testPlan.relatedPackages) {
    const absSources = pkg.sourceFiles.map((rel) => resolve(repoRoot, rel));
    steps.push({
      name: `test: ${pkg.name} (related)`,
      kind: "vitest",
      cmd: "pnpm",
      args: [
        "--dir",
        pkg.dir,
        "exec",
        "vitest",
        "related",
        "--run",
        "--maxWorkers=2",
        "--passWithNoTests",
        ...absSources,
      ],
    });
  }

  if (testPlan.runScriptsTests) {
    steps.push({
      name: "test: scripts",
      kind: "vitest",
      cmd: "pnpm",
      args: ["exec", "vitest", "run", "--root", "scripts", "--maxWorkers=2"],
    });
  }

  if (!args.skipBuild) {
    steps.push({ name: "build", kind: "build", cmd: "pnpm", args: ["build"] });
  }

  const results = [];
  for (const step of steps) {
    const res = await runCommand(step.cmd, step.args, { cwd: repoRoot, env });
    let summary;
    if (step.kind === "vitest") summary = parseVitestSummary(res.output, res.exitCode);
    else if (step.kind === "lint") summary = parseLintSummary(res.output, res.exitCode);
    else if (step.kind === "depcheck") summary = parseDepcheckSummary(res.output, res.exitCode);
    else summary = parseGenericSummary(step.kind, res.output, res.exitCode);

    const record = {
      name: step.name,
      ok: res.exitCode === 0,
      durationMs: res.durationMs,
      summary,
      output: res.output,
    };
    results.push(record);
    // 实时打印每步一行，让终端可见进度
    process.stderr.write(`${formatStepRow(record)}\n`);
  }

  const reportText = formatReport({
    baseRef: args.base,
    mergeBase,
    changedFiles,
    results,
    skippedTestsReason: testPlan.skippedReason,
  });

  process.stdout.write(reportText);

  if (args.report) {
    const reportPath = isAbsolute(args.report) ? args.report : resolve(repoRoot, args.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, reportText, "utf8");
  }

  return results.every((r) => r.ok) ? 0 : 1;
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  runVerify()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
