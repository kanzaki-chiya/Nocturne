import { renderSkill } from "../../skills/index.js";
import type { SkillInvocation, SkillOverview } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

export const SKILL_TOOL_NAME = "skill";

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(
          (next[j] ?? Infinity) + 1,
          (row[j + 1] ?? Infinity) + 1,
          (row[j] ?? Infinity) + (a[i] === b[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[b.length] ?? Infinity;
}

export function createSkillTool(
  snapshot: readonly (SkillOverview & { body: string })[],
  summaryEpoch: () => number = () => 0,
  loaded = new Map<string, string>(),
): ToolDefinition {
  return {
    name: SKILL_TOOL_NAME,
    description:
      "加载可用技能的正文、目录路径与支持文件。输入技能名，可选 arguments 参数。技能不会预先放行工具或执行命令。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 }, arguments: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    traits: { mutates: false, concurrencySafe: true, timeoutMs: 10_000, pinResult: true },
    permissionSubjects: () => [],
    execute(value, ctx) {
      const input = value as SkillInvocation;
      const skills = snapshot.filter(
        (s) =>
          s.enabled &&
          !s.shadowedBy &&
          !s.missingDescription &&
          s.catalogStatus !== "omitted" &&
          s.fields["disable-model-invocation"] !== true,
      );
      const skill = skills.find((s) => s.name.toLowerCase() === input.name.toLowerCase());
      if (!skill) {
        const nearest = [...skills]
          .sort(
            (a, b) =>
              distance(a.name.toLowerCase(), input.name.toLowerCase()) -
                distance(b.name.toLowerCase(), input.name.toLowerCase()) ||
              a.name.localeCompare(b.name),
          )
          .slice(0, 3)
          .map((s) => s.name);
        const message = `技能 ${input.name} 不存在。最接近的名字：${nearest.join("、") || "无"}`;
        return Promise.resolve({
          status: "error",
          modelContent: message,
          error: { code: "skill_not_found", message },
        });
      }
      const body = renderSkill(skill.body, skill, input, ctx.workspaceRoot, ctx.sessionId);
      const key = `${ctx.sessionId}:${skill.realPath}`;
      const content = `${summaryEpoch()}:${body}`;
      if (loaded.get(key) === content)
        return Promise.resolve({
          status: "ok",
          modelContent: `${skill.name} 已加载，见前文。`,
          output: { name: skill.name, repeated: true },
        });
      loaded.set(key, content);
      return Promise.resolve({
        status: "ok",
        modelContent: `技能 ${skill.name}\n目录：${skill.realPath}\n文件：${skill.files.map((f) => f.name + (f.directory ? "/" : "")).join("、")}\n\n${body}`,
        output: { name: skill.name, directory: skill.realPath, files: skill.files },
      });
    },
  };
}
