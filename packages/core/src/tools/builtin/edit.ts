/**
 * edit 工具（tools.md 第 6 节）：精确字符串替换。
 * old 必须在文件中唯一出现（或显式 replaceAll）；
 * 同样要求先读且未过期；output 返回 unified 风格 diff 供客户端显示。
 */
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolDefinition, ToolScope } from "../types.js";
import { diffLines } from "./diff.js";
import { diagnoseNoMatch } from "./edit-diagnostic.js";
import { countLines, guardWritable, isGuardError, toolError } from "./guard.js";

interface EditInput {
  path: string;
  old: string;
  new: string;
  /** 替换全部出现位置 */
  replaceAll?: boolean;
}

interface EditOutput {
  path: string;
  replaced: number;
  diff: string;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    const found = text.indexOf(needle, i);
    if (found === -1) return count;
    count++;
    i = found + needle.length;
  }
}

export const editTool: ToolDefinition<EditInput, EditOutput> = {
  name: "edit",
  description:
    "精确字符串替换：old 必须在文件中唯一出现，或用 replaceAll 替换全部。目标文件必须先在本会话中 read 过或由用户 @文件 附带文本，且未被外部修改。",
  inputSchema: {
    type: "object",
    required: ["path", "old", "new"],
    properties: {
      path: { type: "string", description: "文件路径（相对 cwd 或绝对路径）" },
      old: { type: "string", minLength: 1, description: "要被替换的原文" },
      new: { type: "string", description: "替换后的内容" },
      replaceAll: { type: "boolean", description: "替换全部出现位置" },
    },
    additionalProperties: false,
  },
  traits: { mutates: true, concurrencySafe: false, timeoutMs: 15_000 },

  permissionSubjects(input: EditInput, scope: ToolScope): SubjectRequest[] {
    return [{ kind: "edit", target: scope.paths.resolve(scope.cwd, input.path) }];
  },

  async execute(input, ctx) {
    const approved = ctx.subjects.find((s) => s.kind === "edit");
    const resolved = approved?.resolved;
    const target = approved?.target ?? input.path;
    if (resolved === undefined) {
      return toolError("internal", "缺少已批准的编辑路径");
    }
    if (input.old === input.new) {
      return toolError("no_change", "old 与 new 相同，无需修改");
    }

    const guard = await guardWritable(target, resolved, ctx, true);
    if (isGuardError(guard) || guard === undefined) {
      return guard ?? toolError("file_not_found", `文件不存在：${resolved}`);
    }
    const { oldText } = guard;

    const count = occurrences(oldText, input.old);
    if (count === 0) {
      return toolError(
        "no_match",
        `old 在 ${resolved} 中未出现。${diagnoseNoMatch(oldText, input.old)}`,
      );
    }
    if (count > 1 && input.replaceAll !== true) {
      return toolError(
        "not_unique",
        `old 在 ${resolved} 中出现 ${count} 次；请提供更长的唯一片段，或显式 replaceAll`,
      );
    }

    const replaced = input.replaceAll === true ? count : 1;
    const newText =
      input.replaceAll === true
        ? oldText.split(input.old).join(input.new)
        : // 函数形式保证 new 按字面值写入（$&、$$ 等不被解释）
          oldText.replace(input.old, () => input.new);

    try {
      await ctx.fs.writeFile(resolved, newText);
    } catch (e) {
      return toolError("write_failed", `写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const stat = await ctx.fs.stat(resolved);
    ctx.readState.record(resolved, { mtimeMs: stat.mtimeMs, size: stat.size });

    return {
      status: "ok",
      modelContent: `已修改 ${resolved}（替换 ${replaced} 处，现 ${countLines(newText)} 行）`,
      output: { path: resolved, replaced, diff: diffLines(oldText, newText, resolved) },
    };
  },
};
