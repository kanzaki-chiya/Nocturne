/**
 * 桌面斜杠命令（docs/apps/desktop.md 5.3）：界面上没有对应操作的才保留为命令，
 * 其余旧命令解析为「去哪里操作」的提示，不作为消息发出。
 */

import { parseSkillSlash, type SkillOverview, type SkillInvocation } from "@nocturne/core/protocol";

export const COMMANDS = [
  { name: "/compact", summary: "压缩当前上下文" },
  { name: "/mcp", summary: "查看本会话 MCP 状态" },
] as const;

export type SlashCommandName = (typeof COMMANDS)[number]["name"];

/** 输入框所在场景：空状态控件在卡片/托盘里，会话内控件在底部状态栏。 */
export type SlashContext = "draft" | "session";

type RedirectHint = string | Record<SlashContext, string>;

/** 已移除命令 → 提示对应的界面操作。 */
export const REDIRECTS: Record<string, RedirectHint> = {
  "/model": { draft: "在输入框右下角切换模型", session: "在底部状态栏切换模型" },
  "/effort": { draft: "在输入框右下角切换思考档位", session: "在底部状态栏切换思考档位" },
  "/preset": { draft: "在输入框下方切换权限预设", session: "在底部状态栏切换权限预设" },
  "/shell": { draft: "Shell 在会话内的底部状态栏切换", session: "在底部状态栏切换 Shell" },
  "/context": {
    draft: "会话内可点底部状态栏的上下文用量查看占比",
    session: "点底部状态栏的上下文用量查看占比",
  },
  "/new": "点左栏「＋ 新会话」新建会话",
  "/clear": "点左栏「＋ 新会话」新建会话",
  "/resume": "在左栏选择要继续的会话",
  "/help": {
    draft: "输入 / 查看可用命令；模型与档位在输入框右下、权限预设在下方托盘",
    session: "输入 / 查看可用命令；模型、档位和预设在底部状态栏切换",
  },
  "/provider": "在 设置 › 服务商 管理；状态栏模型菜单的「管理服务商…」也能进入",
  "/settings": "点左栏底部「设置」打开 设置 › 常规",
  "/theme": "在 设置 › 外观 切换主题",
  "/rewind": "回退在后续版本提供",
  "/fork": "分叉在后续版本提供",
  "/exit": "关闭窗口即可退出",
  "/quit": "关闭窗口即可退出",
};

export type ParsedSlash =
  | { kind: "skill"; invocation: SkillInvocation }
  | { kind: "command"; name: SlashCommandName; raw: string }
  | { kind: "redirect"; name: string; hint: string }
  | { kind: "unknown"; name: string; hint: string };

/** 非斜杠行或多行返回 null；已知命令带多余参数时按 unknown 给出用法提示。 */
export function parseSlash(
  line: string,
  context: SlashContext = "session",
  skills: readonly SkillOverview[] = [],
): ParsedSlash | null {
  if (/[\r\n]/.test(line)) return null;
  const match = /^\s*(\/\S*)(?:\s+([\s\S]*))?$/.exec(line);
  if (match === null) return null;
  const name = match[1] ?? "/";
  const args = (match[2] ?? "").trim();
  const known = COMMANDS.some((command) => command.name === name);
  if (known) {
    if (args !== "") return { kind: "unknown", name, hint: `用法：${name}` };
    return { kind: "command", name: name as SlashCommandName, raw: line };
  }
  const hint = REDIRECTS[name];
  if (hint !== undefined)
    return { kind: "redirect", name, hint: typeof hint === "string" ? hint : hint[context] };
  const invocation = parseSkillSlash(line.trimStart(), skills);
  if (invocation) return { kind: "skill", invocation };
  return { kind: "unknown", name, hint: `未知命令 ${name}；输入 / 查看可用命令` };
}

export interface SlashItem {
  argumentHint?: string | undefined;
  source?: string | undefined;
  label: string;
  summary: string;
  insert: string;
}

export interface SlashGroup {
  id: "commands" | "skills";
  label: string;
  items: SlashItem[];
}

/** 单行 / 前缀的分组补全；空组不返回。 */
export function completeSlash(line: string, skills: readonly SkillOverview[] = []): SlashGroup[] {
  if (/[\r\n]/.test(line)) return [];
  const text = line.trimStart();
  if (!text.startsWith("/") || /\s/.test(text.slice(1))) return [];
  const query = text.slice(1).toLowerCase();
  const leading = line.slice(0, line.length - text.length);
  const items: SlashItem[] = COMMANDS.filter((command) =>
    command.name.slice(1).startsWith(query),
  ).map((command) => ({
    label: command.name,
    summary: command.summary,
    insert: `${leading}${command.name} `,
  }));
  const skillItems = skills
    .filter(
      (skill) =>
        (skill.invocation === "both" || skill.invocation === "user") &&
        !skill.commandConflict &&
        skill.name.toLowerCase().startsWith(query),
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((skill) => ({
      label: `/${skill.name}`,
      argumentHint:
        typeof skill.fields["argument-hint"] === "string"
          ? skill.fields["argument-hint"]
          : undefined,
      source: skill.layer === "user" ? "用户" : "项目",
      summary: Array.from(skill.description).slice(0, 250).join("") || "没有说明",
      insert: `${leading}/${skill.name} `,
    }));
  return [
    ...(items.length ? [{ id: "commands" as const, label: "命令", items }] : []),
    ...(skillItems.length ? [{ id: "skills" as const, label: "技能", items: skillItems }] : []),
  ];
}
