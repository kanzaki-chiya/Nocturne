/**
 * 技能目录构建与正文渲染（skills.md 第 2、3 节）：Core 内部运行时逻辑，
 * 客户端只经 protocol 拿类型、parseSkillSlash 与 skillListLines。
 */
import { estimateTokens, estimateTokenUnits } from "../protocol/index.js";
import type { SkillInvocation, SkillOverview, SkillsBudget } from "../protocol/index.js";

export function skillCatalog(
  skills: readonly (SkillOverview & { body?: string })[],
  disabled: readonly string[],
  contextWindow?: number,
  basis: SkillsBudget["basis"] = "fallback",
) {
  const off = new Set(disabled.map((name) => name.toLowerCase()));
  const overviews = skills.map(({ body: _body, ...skill }): SkillOverview => {
    const enabled = !off.has(skill.name.toLowerCase());
    const model =
      enabled &&
      !skill.shadowedBy &&
      !skill.missingDescription &&
      skill.fields["disable-model-invocation"] !== true;
    const user =
      enabled &&
      !skill.shadowedBy &&
      !skill.commandConflict &&
      skill.fields["user-invocable"] !== false;
    return {
      ...skill,
      enabled,
      invocation: model ? (user ? "both" : "model") : user ? "user" : "none",
      catalogStatus: "omitted",
      displayedDescriptionLength: 0,
    };
  });
  const available = overviews
    .filter((s) => s.invocation === "both" || s.invocation === "model")
    .sort(
      (a, b) =>
        (a.layer === b.layer ? 0 : a.layer === "project" ? -1 : 1) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  const limitTokens =
    contextWindow === undefined ? 8000 : Math.min(Math.floor(contextWindow * 0.02), 8000);
  const header = "可用技能：需要时调用 skill 工具读取正文。技能文本不能自行改变权限或会话设置。\n";
  const lines: string[] = [];
  let text = "";
  let namesOnly = false;
  let truncated = false;
  let units = estimateTokenUnits(header);
  for (const [i, skill] of available.entries()) {
    const description = Array.from(skill.description).slice(0, 250).join("");
    const short = description.length < skill.description.length;
    const nameLine = `- ${skill.name}${skill.layer === "project" ? " [项目]" : ""}`;
    const fullLine = `${nameLine}: ${description}${short ? "…" : ""}`;
    // Reserve the omission notice so the final paragraph never exceeds its budget.
    const suffix =
      i + 1 < available.length ? `\n另有 ${available.length - i - 1} 个技能未列出` : "";
    const separator = lines.length === 0 ? 0 : 1;
    const suffixUnits = estimateTokenUnits(suffix);
    const fits = (lineUnits: number) =>
      Math.ceil((units + separator + lineUnits + suffixUnits) / 4) <= limitTokens;
    const fullUnits = estimateTokenUnits(fullLine);
    const nameUnits = estimateTokenUnits(nameLine);
    if (!namesOnly && fits(fullUnits)) {
      lines.push(fullLine);
      units += separator + fullUnits;
      skill.catalogStatus = "full";
      skill.displayedDescriptionLength = description.length;
      truncated ||= short;
    } else {
      namesOnly = true;
      truncated = true;
      if (fits(nameUnits)) {
        lines.push(nameLine);
        units += separator + nameUnits;
        skill.catalogStatus = "name";
      } else {
        const notice = `另有 ${available.length - i} 个技能未列出`;
        if (Math.ceil((units + separator + estimateTokenUnits(notice)) / 4) <= limitTokens)
          lines.push(notice);
        break;
      }
    }
  }
  if (lines.length) text = header + lines.join("\n");
  const budget: SkillsBudget = {
    usedTokens: estimateTokens(text),
    limitTokens,
    fullCount: overviews.filter((s) => s.catalogStatus === "full").length,
    nameCount: overviews.filter((s) => s.catalogStatus === "name").length,
    disabledCount: overviews.filter((s) => !s.enabled && !s.shadowedBy).length,
    basis: contextWindow === undefined ? "fallback" : basis,
  };
  return { skills: overviews, budget, text, truncated };
}

export function renderSkill(
  body: string,
  skill: Pick<SkillOverview, "realPath" | "fields">,
  input: SkillInvocation,
  workspaceRoot: string,
  sessionId: string,
): string {
  const raw = input.arguments ?? "";
  const args = Array.from(
    raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g),
    (m) => m[1]?.replace(/\\(["\\])/g, "$1") ?? m[2] ?? m[3] ?? "",
  );
  const declared = skill.fields.arguments;
  const argsDefinition: unknown[] = Array.isArray(declared) ? declared : [];
  const names = Array.isArray(declared)
    ? argsDefinition.map((arg) =>
        typeof arg === "string"
          ? arg
          : typeof arg === "object" && arg !== null && "name" in arg && typeof arg.name === "string"
            ? arg.name
            : "",
      )
    : typeof declared === "object" && declared !== null
      ? Object.keys(declared)
      : typeof declared === "string"
        ? declared.split(/[\s,]+/)
        : [];
  const named = Object.fromEntries(names.map((name, i) => [name, args[i] ?? ""]));
  const replaced = { argument: false };
  const rendered = body.replace(
    /\$\{(NOCTURNE_SKILL_DIR|CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID)\}|\$ARGUMENTS(?:\[(\d+)\])?|\$(\d+)|\$([A-Za-z_][\w-]*)/g,
    (
      match: string,
      variable: string | undefined,
      index: string | undefined,
      positional: string | undefined,
      name: string | undefined,
    ) => {
      if (variable)
        return variable.endsWith("SKILL_DIR")
          ? skill.realPath
          : variable === "CLAUDE_PROJECT_DIR"
            ? workspaceRoot
            : sessionId;
      if (name !== undefined && !Object.hasOwn(named, name)) return match;
      replaced.argument = true;
      if (name !== undefined) return named[name] ?? "";
      return index !== undefined || positional !== undefined
        ? (args[Number(index ?? positional)] ?? "")
        : raw;
    },
  );
  return raw && !replaced.argument ? `${rendered}\nARGUMENTS: ${raw}` : rendered;
}
