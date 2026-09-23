/**
 * read 工具（tools.md 第 6 节）：读取文本文件，带行号输出。
 * 检测二进制文件；记录"已读状态"（路径、修改时间）。
 */
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolContext, ToolDefinition, ToolScope } from "../types.js";

interface ReadInput {
  path: string;
  /** 起始行（1 起），默认 1 */
  offset?: number;
  /** 最多返回行数，默认 2000 */
  limit?: number;
}

interface ReadOutput {
  path: string;
  totalLines: number;
  offset: number;
  returnedLines: number;
}

const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_LIMIT = 2000;

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export const readTool: ToolDefinition<ReadInput, ReadOutput> = {
  name: "read",
  description: "读取文本文件，返回带行号的内容。支持 offset（起始行）与 limit（行数）。",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "文件路径（相对 cwd 或绝对路径）" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 10_000 },

  permissionSubjects(input: ReadInput, scope: ToolScope): SubjectRequest[] {
    return [
      {
        kind: "read",
        target: scope.paths.resolve(scope.cwd, input.path),
      },
    ];
  },

  async execute(input: ReadInput, ctx: ToolContext) {
    const approved = ctx.subjects.find((s) => s.kind === "read");
    const target = approved?.resolved ?? input.path;

    const stat = await ctx.fs.stat(target).catch(() => undefined);
    if (stat === undefined) {
      return {
        status: "error",
        modelContent: `文件不存在或不可访问：${target}`,
        error: { code: "file_not_found", message: `文件不存在：${target}` },
      };
    }
    if (stat.type === "directory") {
      return {
        status: "error",
        modelContent: `${target} 是目录，不是文件`,
        error: { code: "is_directory", message: `${target} 是目录` },
      };
    }

    const bytes = await ctx.fs.readFile(target).catch(() => undefined);
    if (bytes === undefined) {
      return {
        status: "error",
        modelContent: `无法读取文件：${target}`,
        error: { code: "read_failed", message: `无法读取：${target}` },
      };
    }
    if (isBinary(bytes)) {
      return {
        status: "error",
        modelContent: `${target} 是二进制文件，无法用 read 读取`,
        error: { code: "binary_file", message: "二进制文件" },
      };
    }

    const text = new TextDecoder("utf-8").decode(bytes);
    const lines = text.split("\n");
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const start = Math.min(Math.max(offset - 1, 0), lines.length);
    const end = Math.min(start + limit, lines.length);

    const numbered: string[] = [];
    for (let i = start; i < end; i++) {
      numbered.push(`${i + 1}|${(lines[i] ?? "").replace(/\r$/, "")}`);
    }
    const remaining = lines.length - end;
    if (remaining > 0) {
      numbered.push(`…（其后还有 ${remaining} 行，用 offset 继续读取）`);
    }

    // 记录"已读状态"（Phase 2 的 write/edit 据此做先读检查与过期检测）
    ctx.readState.record(target, { mtimeMs: stat.mtimeMs, size: stat.size });

    return {
      status: "ok",
      modelContent: numbered.join("\n"),
      output: {
        path: target,
        totalLines: lines.length,
        offset,
        returnedLines: end - start,
      },
    };
  },
};
