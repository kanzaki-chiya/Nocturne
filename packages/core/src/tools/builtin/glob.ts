/**
 * glob 工具（tools.md 第 6 节）：按模式匹配文件路径。
 * 优先 ripgrep --files，rg 不可用时回退内部 walker；
 * 遵守 .gitignore、不跟随符号链接；结果逐条经权限过滤；
 * 按修改时间倒序；数量有上限。
 */
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolContext, ToolDefinition, ToolScope } from "../types.js";
import { globToRegExp } from "./globmatch.js";
import { walkFiles, type WalkedFile } from "./walk.js";

interface GlobInput {
  pattern: string;
  /** 搜索根目录（相对 cwd 或绝对路径），默认 cwd */
  path?: string;
}

interface GlobOutput {
  entries: { path: string; rel: string; mtimeMs: number }[];
  omittedByPermission: number;
  truncated: boolean;
  engine: "ripgrep" | "internal";
}

const MAX_ENTRIES = 500;

async function collectStdout(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

/**
 * 用 ripgrep 枚举文件（--files 遵守 .gitignore、不跟随链接）。
 * 不把用户 pattern 传给 rg：-g 是白名单语义会覆盖 .gitignore，
 * pattern 统一由 globToRegExp 在结果上过滤，保证两个引擎语义一致。
 */
async function globWithRipgrep(rootAbs: string, ctx: ToolContext): Promise<string[] | null> {
  const args = ["--no-config", "--no-require-git", "--files", "--color", "never", "."];
  let proc;
  try {
    proc = ctx.process.spawn("rg", args, {
      cwd: rootAbs,
      signal: ctx.signal,
      timeoutMs: 30_000,
    });
  } catch {
    return null;
  }
  const [stdout, , exit] = await Promise.all([
    collectStdout(proc.stdout),
    collectStdout(proc.stderr),
    proc.wait(),
  ]);
  if (exit.code === null) return null;
  if (exit.code !== 0 && exit.code !== 1) return [];
  return stdout
    .split("\n")
    .map((l) => l.replace(/^\.\//, ""))
    .filter((l) => l !== "")
    .map((l) => l.replaceAll("\\", "/"));
}

async function globInternal(
  input: GlobInput,
  rootAbs: string,
  ctx: ToolContext,
): Promise<WalkedFile[]> {
  const re = globToRegExp(input.pattern);
  const files: WalkedFile[] = [];
  for await (const file of walkFiles(ctx.fs, ctx.paths, rootAbs, {
    signal: ctx.signal,
  })) {
    if (ctx.signal.aborted) break;
    if (re.test(file.rel)) files.push(file);
  }
  return files;
}

export const globTool: ToolDefinition<GlobInput, GlobOutput> = {
  name: "glob",
  description:
    "按 glob 模式匹配文件路径（如 **/*.ts）。遵守 .gitignore，不跟随符号链接，按修改时间倒序。",
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "glob 模式（相对搜索根）" },
      path: { type: "string", description: "搜索根目录，默认会话 cwd" },
    },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 30_000 },

  permissionSubjects(input: GlobInput, scope: ToolScope): SubjectRequest[] {
    return [
      {
        kind: "read",
        target: scope.paths.resolve(scope.cwd, input.path ?? "."),
      },
    ];
  },

  async execute(input: GlobInput, ctx: ToolContext) {
    const root = ctx.subjects.find((s) => s.kind === "read")?.resolved;
    if (root === undefined) {
      return {
        status: "error",
        modelContent: "缺少已批准的搜索根目录",
        error: { code: "internal", message: "no resolved root" },
      };
    }

    const rg = await globWithRipgrep(root, ctx).catch(() => null);
    let rels: string[];
    let engine: GlobOutput["engine"];
    const mtimes = new Map<string, number>();
    if (rg !== null) {
      rels = rg;
      engine = "ripgrep";
    } else {
      const files = await globInternal(input, root, ctx);
      rels = files.map((f) => f.rel);
      for (const f of files) mtimes.set(f.rel, f.mtimeMs);
      engine = "internal";
    }

    // 模式过滤（两引擎共用同一 glob 语义）
    const patternRe = globToRegExp(input.pattern);
    rels = rels.filter((r) => patternRe.test(r));

    // 逐条权限过滤 + mtime（rg 路径下需补 stat）
    const entries: { path: string; rel: string; mtimeMs: number }[] = [];
    let omittedByPermission = 0;
    for (const rel of rels) {
      const abs = ctx.paths.join(root, rel);
      if (ctx.permissions.check({ kind: "read", target: abs }) !== "allow") {
        omittedByPermission++;
        continue;
      }
      const mtimeMs =
        mtimes.get(rel) ?? (await ctx.fs.lstat(abs).catch(() => undefined))?.mtimeMs ?? 0;
      entries.push({ path: abs, rel, mtimeMs });
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const truncated = entries.length > MAX_ENTRIES;
    const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries;
    const notes: string[] = [];
    if (truncated) notes.push(`结果超过 ${MAX_ENTRIES} 条，已截断`);
    if (omittedByPermission > 0) notes.push(`${omittedByPermission} 个条目因权限规则被省略`);
    const modelContent =
      shown.length === 0
        ? `（无匹配）${notes.length > 0 ? ` [${notes.join("；")}]` : ""}`
        : shown.map((e) => e.rel).join("\n") + (notes.length > 0 ? `\n[${notes.join("；")}]` : "");
    return {
      status: "ok",
      modelContent,
      output: {
        entries: shown,
        omittedByPermission,
        truncated,
        engine,
      },
    };
  },
};
