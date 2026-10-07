/**
 * 桌面斜杠命令（docs/apps/desktop.md 5.3）：界面上没有对应操作的才保留为命令，
 * 其余旧命令解析为「去哪里操作」的提示，不作为消息发出。
 */

import {
  BUILTIN_SLASH_COMMANDS,
  parseSkillSlash,
  type ExternalAgentOverview,
  type SkillOverview,
  type SkillInvocation,
} from "@nocturne/core/protocol";

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
  "/agents": "在 设置 › 外部 agent 查看与管理",
  "/skills": "在 设置 › 技能 查看与管理",
  "/settings": "点左栏底部「设置」打开 设置 › 常规",
  "/theme": "在 设置 › 外观 切换主题",
  "/rewind": "回退在后续版本提供",
  "/fork": "分叉在后续版本提供",
  "/exit": "关闭窗口即可退出",
  "/quit": "关闭窗口即可退出",
};

export type ParsedSlash =
  | { kind: "skill"; invocation: SkillInvocation }
  | { kind: "agent"; delegate: { agent: string; task: string } }
  | { kind: "command"; name: SlashCommandName; raw: string }
  | { kind: "redirect"; name: string; hint: string }
  | { kind: "unknown"; name: string; hint: string };

/** 内置命令只处理单行；技能和外部 agent 的任务可以包含换行。 */
export function parseSlash(
  line: string,
  context: SlashContext = "session",
  skills: readonly SkillOverview[] = [],
  agents: readonly ExternalAgentOverview[] = [],
): ParsedSlash | null {
  const multiline = /[\r\n]/.test(line);
  const match = /^\s*(\/\S*)(?:\s+([\s\S]*))?$/.exec(line);
  if (match === null) return null;
  const name = match[1] ?? "/";
  const lowerName = name.toLowerCase();
  const args = (match[2] ?? "").trim();
  const known = COMMANDS.find((command) => command.name === lowerName);
  if (multiline && (known || REDIRECTS[lowerName] !== undefined)) return null;
  if (known) {
    if (args !== "") return { kind: "unknown", name, hint: `用法：${known.name}` };
    return { kind: "command", name: known.name, raw: line };
  }
  const hint = REDIRECTS[lowerName];
  if (hint !== undefined)
    return { kind: "redirect", name, hint: typeof hint === "string" ? hint : hint[context] };
  const invocation = parseSkillSlash(line.trimStart(), skills);
  if (invocation) return { kind: "skill", invocation };
  const agent = agents.find(
    (candidate) =>
      candidate.enabled &&
      `/${candidate.name.toLowerCase()}` === lowerName &&
      !externalAgentSlashConflict(candidate.name, skills),
  );
  if (agent) {
    if (!args) return { kind: "unknown", name, hint: `用法：/${agent.name} 任务` };
    return { kind: "agent", delegate: { agent: agent.name, task: args } };
  }
  if (multiline) return null;
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
  id: "commands" | "skills" | "external";
  label: string;
  items: SlashItem[];
}

/** 单行 / 前缀的分组补全；空组不返回。 */
export function completeSlash(
  line: string,
  skills: readonly SkillOverview[] = [],
  agents: readonly ExternalAgentOverview[] = [],
): SlashGroup[] {
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
  const agentItems = agents
    .filter(
      (agent) =>
        agent.enabled &&
        !externalAgentSlashConflict(agent.name, skills) &&
        agent.name.toLowerCase().startsWith(query),
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((agent) => ({
      label: `/${agent.name}`,
      source: agent.origin === "app" ? "程序管理" : "config.json",
      summary: agent.description ?? "没有说明",
      insert: `${leading}/${agent.name} `,
    }));
  return [
    ...(items.length ? [{ id: "commands" as const, label: "命令", items }] : []),
    ...(skillItems.length ? [{ id: "skills" as const, label: "技能", items: skillItems }] : []),
    ...(agentItems.length
      ? [{ id: "external" as const, label: "外部 agent", items: agentItems }]
      : []),
  ];
}

/** 名字不区分大小写；冲突 agent 仍可由模型调用，不能斜杠点名。 */
export function externalAgentSlashConflict(
  name: string,
  skills: readonly SkillOverview[],
): string | undefined {
  const lower = name.toLowerCase();
  if (BUILTIN_SLASH_COMMANDS.some((command) => command.toLowerCase() === lower))
    return `与内置命令 /${name} 重名，不能用斜杠点名；模型仍可调用`;
  if (skills.some((skill) => skill.name.toLowerCase() === lower))
    return `与技能 /${name} 重名，不能用斜杠点名；模型仍可调用`;
  return undefined;
}
