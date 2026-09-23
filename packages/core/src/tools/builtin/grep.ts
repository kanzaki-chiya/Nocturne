/**
 * grep 工具（tools.md 第 6 节）：按正则搜索文件内容。
 * 优先使用 ripgrep（自带 .gitignore 与不跟随链接语义）；
 * rg 不可用时回退到内部 walker（同样遵守 .gitignore、不跟随链接）。
 * 每个结果文件逐条经 ctx.permissions.check 过滤（permissions.md 4.4）。
 */
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolContext, ToolDefinition, ToolScope } from "../types.js";
import { globToRegExp } from "./globmatch.js";
import { walkFiles } from "./walk.js";

interface GrepInput {
  pattern: string;
  /** 搜索根目录（相对 cwd 或绝对路径），默认 cwd */
  path?: string;
  /** 文件过滤 glob（相对搜索根），如 "*.ts" */
  include?: string;
  caseInsensitive?: boolean;
}

interface GrepMatch {
  path: string;
  rel: string;
  line: number;
  text: string;
}

interface GrepOutput {
  matches: GrepMatch[];
  omittedByPermission: number;
  truncated: boolean;
  engine: "ripgrep" | "internal";
}

const MAX_MATCHES = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface RawMatch {
  rel: string;
  line: number;
  text: string;
}

async function collectStdout(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

/** 用 ripgrep 搜索；返回 null 表示 rg 不可用 */
async function grepWithRipgrep(
  input: GrepInput,
  rootAbs: string,
  ctx: ToolContext,
): Promise<RawMatch[] | null> {
  // include 不走 rg -g（白名单会覆盖 .gitignore），统一在结果上过滤
  const args = [
    "--no-config",
    "--no-require-git",
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--with-filename",
    "--encoding",
    "utf-8",
    "--regexp",
    input.pattern,
    ...(input.caseInsensitive === true ? ["--ignore-case"] : []),
    ".",
  ];
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
  if (exit.code === null) return null; // spawn 失败（rg 不存在等）
  // rg：0=有匹配，1=无匹配，>1=错误（按无匹配处理，错误文本不进结果）
  if (exit.code !== 0 && exit.code !== 1) return [];

  const matches: RawMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    // 相对路径格式 "path:line:text"；Windows 下 cwd 相对路径不含盘符冒号
    const m = /^(?:\.[\\/])?(.+?):(\d+):(.*)$/.exec(line);
    const rel = m?.[1];
    const lineno = m?.[2];
    const text = m?.[3];
    if (rel === undefined || lineno === undefined || text === undefined) {
      continue; // 跳过 "binary file matches" 等提示行
    }
    matches.push({
      rel: rel.replaceAll("\\", "/"),
      line: Number(lineno),
      text,
    });
  }
  const includeRe = input.include !== undefined ? globToRegExp(input.include) : undefined;
  return includeRe === undefined ? matches : matches.filter((m) => includeRe.test(m.rel));
}

/** 内部实现：walker + 正则（兜底路径，结果与 rg 同构） */
async function grepInternal(
  input: GrepInput,
  rootAbs: string,
  ctx: ToolContext,
): Promise<{ matches: RawMatch[]; hitCap: boolean }> {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.caseInsensitive === true ? "i" : "");
  } catch (e) {
    throw new Error(`无效正则 "${input.pattern}"：${e instanceof Error ? e.message : String(e)}`);
  }
  const includeRe = input.include !== undefined ? globToRegExp(input.include) : undefined;
  const matches: RawMatch[] = [];
  for await (const file of walkFiles(ctx.fs, ctx.paths, rootAbs, {
    signal: ctx.signal,
  })) {
    if (ctx.signal.aborted) break;
    if (includeRe !== undefined && !includeRe.test(file.rel)) continue;
    if (file.size > MAX_FILE_BYTES) continue;
    const text = await ctx.fs.readTextFile(file.path).catch(() => undefined);
    if (text === undefined || text.includes("")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (re.test(line)) {
        matches.push({ rel: file.rel, line: i + 1, text: line });
        if (matches.length >= MAX_MATCHES) {
          return { matches, hitCap: true };
        }
      }
    }
  }
  return { matches, hitCap: false };
}

export const grepTool: ToolDefinition<GrepInput, GrepOutput> = {
  name: "grep",
  description: "按正则搜索文件内容，返回 path:line 匹配列表。遵守 .gitignore，不跟随符号链接。",
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "搜索根目录，默认会话 cwd" },
      include: { type: "string", description: "文件过滤 glob，如 *.ts" },
      caseInsensitive: { type: "boolean" },
    },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 30_000 },

  permissionSubjects(input: GrepInput, scope: ToolScope): SubjectRequest[] {
    return [
      {
        kind: "read",
        target: scope.paths.resolve(scope.cwd, input.path ?? "."),
      },
    ];
  },

  async execute(input: GrepInput, ctx: ToolContext) {
    const root = ctx.subjects.find((s) => s.kind === "read")?.resolved;
    if (root === undefined) {
      return {
        status: "error",
        modelContent: "缺少已批准的搜索根目录",
        error: { code: "internal", message: "no resolved root" },
      };
    }

    // 搜索根是单个文件时直接搜它（其自身已通过权限批准，不再逐条过滤）
    const rootStat = await ctx.fs.stat(root).catch(() => undefined);
    const kept: GrepMatch[] = [];
    let omittedByPermission = 0;
    let truncated = false;
    let engine: GrepOutput["engine"];
    if (rootStat?.type === "file") {
      const text = await ctx.fs.readTextFile(root).catch(() => undefined);
      if (text === undefined) {
        return {
          status: "error",
          modelContent: `无法读取：${root}`,
          error: { code: "read_failed", message: "无法读取目标文件" },
        };
      }
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.caseInsensitive === true ? "i" : "");
      } catch (e) {
        return {
          status: "error",
          modelContent: `无效正则：${e instanceof Error ? e.message : String(e)}`,
          error: { code: "invalid_input", message: "无效正则表达式" },
        };
      }
      const base = ctx.paths.basename(root);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          kept.push({ path: root, rel: base, line: i + 1, text: line });
        }
      }
      truncated = kept.length > MAX_MATCHES;
      engine = "internal";
    } else {
      const rg = await grepWithRipgrep(input, root, ctx).catch(() => null);
      let raw: RawMatch[];
      if (rg !== null) {
        raw = rg;
        engine = "ripgrep";
      } else {
        let internal;
        try {
          internal = await grepInternal(input, root, ctx);
        } catch (e) {
          return {
            status: "error",
            modelContent: e instanceof Error ? e.message : String(e),
            error: { code: "invalid_input", message: "搜索失败" },
          };
        }
        raw = internal.matches;
        truncated = internal.hitCap;
        engine = "internal";
      }

      // 逐条权限过滤（permissions.md 4.4）：同一文件只查一次
      const fileVerdict = new Map<string, boolean>();
      for (const m of raw) {
        const abs = ctx.paths.join(root, m.rel);
        let allowed = fileVerdict.get(abs);
        if (allowed === undefined) {
          allowed = ctx.permissions.check({ kind: "read", target: abs }) === "allow";
          fileVerdict.set(abs, allowed);
        }
        if (allowed) {
          kept.push({ path: abs, rel: m.rel, line: m.line, text: m.text });
        } else {
          omittedByPermission++;
        }
      }
      if (kept.length > MAX_MATCHES) truncated = true;
    }

    const shown = truncated ? kept.slice(0, MAX_MATCHES) : kept;
    const body = shown.map((m) => `${m.rel}:${m.line}: ${m.text}`).join("\n");
    const notes: string[] = [];
    if (truncated) notes.push(`结果超过 ${MAX_MATCHES} 条，已截断`);
    if (omittedByPermission > 0) notes.push(`${omittedByPermission} 个条目因权限规则被省略`);
    const modelContent =
      shown.length === 0
        ? `（无匹配）${notes.length > 0 ? ` [${notes.join("；")}]` : ""}`
        : body + (notes.length > 0 ? `\n[${notes.join("；")}]` : "");
    return {
      status: "ok",
      modelContent,
      output: {
        matches: shown,
        omittedByPermission,
        truncated,
        engine,
      },
    };
  },
};
