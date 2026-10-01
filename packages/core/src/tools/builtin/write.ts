/**
 * write 工具（tools.md 第 6 节）：创建或整体覆盖文件。
 * 覆盖已存在文件前必须在本会话读过它且未过期（"先读后写"）；
 * 写入前重新解析路径，批准与实际不一致时报 resource_changed。
 */
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolDefinition, ToolScope } from "../types.js";
import { diffLines } from "./diff.js";
import { countLines, guardWritable, isGuardError, toolError } from "./guard.js";

interface WriteInput {
  path: string;
  content: string;
}

interface WriteOutput {
  path: string;
  created: boolean;
  lines: number;
  /** 创建或覆盖时的 unified 风格 diff（客户端渲染用） */
  diff?: string | undefined;
}

export const writeTool: ToolDefinition<WriteInput, WriteOutput> = {
  name: "write",
  description:
    "创建或整体覆盖文件。覆盖已存在的文件前必须先在本会话中 read 过它或由用户 @文件 附带文本；文件被外部修改后需重新读取。新建文件或整体重写时用本工具。",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "文件路径（相对 cwd 或绝对路径）" },
      content: { type: "string", description: "完整的文件内容" },
    },
    additionalProperties: false,
  },
  traits: { mutates: true, concurrencySafe: false, timeoutMs: 15_000, editTool: "edit" },

  permissionSubjects(input: WriteInput, scope: ToolScope): SubjectRequest[] {
    return [{ kind: "edit", target: scope.paths.resolve(scope.cwd, input.path) }];
  },

  async execute(input, ctx) {
    const approved = ctx.subjects.find((s) => s.kind === "edit");
    const resolved = approved?.resolved;
    const target = approved?.target ?? input.path;
    if (resolved === undefined) {
      return toolError("internal", "缺少已批准的写入路径");
    }

    const guard = await guardWritable(target, resolved, ctx, false);
    if (isGuardError(guard)) return guard;
    const oldText = guard?.oldText;

    // 竞态复检：写入瞬间文件恰好出现按已存在文件处理（要求先读）
    if (oldText === undefined && (await ctx.fs.exists(resolved))) {
      return toolError("not_read", `拒绝覆盖未读取的文件：${resolved}。请先用 read 读取该文件`);
    }

    await ctx.fs.mkdir(ctx.paths.dirname(resolved)).catch(() => undefined);
    try {
      await ctx.fs.writeFile(resolved, input.content);
    } catch (e) {
      return toolError("write_failed", `写入失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 写入后记录新状态，使本会话内的后续编辑通过先读检查
    const stat = await ctx.fs.stat(resolved);
    ctx.readState.record(resolved, { mtimeMs: stat.mtimeMs, size: stat.size });

    const lines = countLines(input.content);
    const created = oldText === undefined;
    const diff = diffLines(oldText ?? "", input.content, resolved);
    return {
      status: "ok",
      modelContent: created
        ? `已创建 ${resolved}（${lines} 行）`
        : `已覆盖 ${resolved}（${lines} 行）`,
      output: {
        path: resolved,
        created,
        lines,
        ...(diff !== "" ? { diff } : {}),
      },
    };
  },
};
