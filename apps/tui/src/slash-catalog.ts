/**
 * 斜杠命令表：/help 与补全共用这一份，CLI readline completer 也用它。
 * 不许在补全路径再抄一份命令名。
 */

export interface SlashCommand {
  /** 含斜杠，如 `/model` */
  name: string;
  /** 补全行与 TUI /help 的短说明 */
  summary: string;
  /** CLI /help 的说明；缺省用 summary */
  cli?: string | undefined;
  /** 命令名后空格进入的参数补全 */
  args?: "effort" | "provider" | "preset" | "shell" | undefined;
  /** 页面命令只在 TUI 展示；逐行 CLI 不支持。 */
  tuiOnly?: boolean | undefined;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", summary: "显示帮助", cli: "列出命令与快捷键" },
  { name: "/theme", summary: "切换深浅主题", tuiOnly: true },
  {
    name: "/settings",
    summary: "设置会话默认值与界面偏好",
    cli: "查看设置；preset|effort <值|reset>",
  },
  { name: "/model", summary: "切换模型", cli: "列出或切换模型" },
  { name: "/effort", summary: "切换思考档位", cli: "显示或切换思考强度", args: "effort" },
  { name: "/preset", summary: "切换权限预设", cli: "显示或切换权限预设", args: "preset" },
  {
    name: "/shell",
    summary: "切换 shell",
    cli: "列出或切换 shell（pwsh/bash/cmd…）",
    args: "shell",
  },
  { name: "/context", summary: "查看上下文", cli: "显示上下文组成" },
  { name: "/mcp", summary: "MCP 状态", cli: "显示本会话 MCP 服务器状态" },
  { name: "/skills", summary: "查看技能目录", cli: "列出当前会话的技能、来源和模型目录状态" },
  { name: "/agents", summary: "查看外部 agent", cli: "只读列出外部 agent、来源、启停与斜杠冲突" },
  { name: "/compact", summary: "压缩上下文", cli: "手动压缩上下文" },
  { name: "/resume", summary: "切换会话", cli: "列出会话或按 id 切换" },
  { name: "/rewind", summary: "回退对话或还原文件" },
  { name: "/fork", summary: "从当前位置分叉新会话" },
  { name: "/new", summary: "新建会话", cli: "新建并切换到空会话" },
  { name: "/clear", summary: "新建会话", cli: "/new 的别名" },
  { name: "/provider", summary: "管理服务商", cli: "列出或管理服务商", args: "provider" },
  { name: "/exit", summary: "退出", cli: "退出" },
  { name: "/quit", summary: "退出", cli: "退出" },
];

/** 与权限层预设名一致；补全与 Alt+M 共用，不另抄一份。 */
export const PRESET_NAMES = [
  "read-only",
  "default",
  "auto-edit",
  "guarded",
  "smart",
  "bypass",
] as const;

/** 与 platform SHELL_KINDS 一致（本文件不许 import，depcheck 固化）；补全只列名字，可用性以 /shell 为准 */
const SHELL_KIND_NAMES = ["pwsh", "powershell", "bash", "cmd", "sh"] as const;

export const PROVIDER_SUBCOMMANDS: readonly { name: string; summary: string }[] = [
  { name: "login", summary: "登录服务商账号" },
  { name: "logout", summary: "退出服务商登录" },
  { name: "add", summary: "添加服务商" },
  { name: "key", summary: "更新密钥" },
  { name: "refresh", summary: "刷新模型列表" },
  { name: "model", summary: "编辑模型设置" },
  { name: "remove", summary: "删除服务商" },
];

export interface CompletionContext {
  skills?:
    | readonly {
        name: string;
        description: string;
        invocation: string;
        fields: Record<string, unknown>;
        enabled?: boolean | undefined;
        shadowedBy?: string | undefined;
        commandConflict?: boolean | undefined;
      }[]
    | undefined;
  externalAgents?: readonly ExternalSlashAgent[] | undefined;
  /** 当前模型可用档位，不含 off（off 由补全自行加上） */
  effortLevels: readonly string[];
  /** 已配置服务商 id */
  providerIds: readonly string[];
}

export interface Candidate {
  group?: "commands" | "skills" | "agents" | undefined;
  /** 显示行，如 `/model  切换模型` */
  label: string;
  /** 写入输入框或交给 readline 的完整文本 */
  insert: string;
}

export interface ExternalSlashAgent {
  name: string;
  enabled: boolean;
  description?: string | undefined;
  origin?: "app" | "user" | undefined;
  command?: string | undefined;
  args?: readonly string[] | undefined;
}

export function externalAgentConflict(
  agent: ExternalSlashAgent,
  skills: CompletionContext["skills"],
): string | undefined {
  const name = agent.name.toLowerCase();
  if (SLASH_COMMANDS.some((command) => command.name.slice(1).toLowerCase() === name))
    return "与内置命令重名，不能斜杠点名，模型仍可调用";
  if (skills?.some((skill) => skill.name.toLowerCase() === name))
    return "与技能重名，不能斜杠点名，模型仍可调用";
  return undefined;
}

export function parseExternalAgentSlash(
  line: string,
  agents: readonly ExternalSlashAgent[],
  skills: CompletionContext["skills"],
): { agent: string; task: string } | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match) return undefined;
  const agent = agents.find(
    (item) => item.enabled && item.name.toLowerCase() === match[1]?.toLowerCase(),
  );
  return agent && externalAgentConflict(agent, skills) === undefined
    ? { agent: agent.name, task: match[2] ?? "" }
    : undefined;
}

export function externalAgentListLines(
  description: { agents: readonly ExternalSlashAgent[]; warnings: readonly string[] },
  skills: CompletionContext["skills"],
): string[] {
  return [
    ...(description.agents.length
      ? [
          "外部 agent：",
          ...description.agents.map((agent) => {
            const conflict = externalAgentConflict(agent, skills);
            const command =
              agent.command === undefined
                ? ""
                : ` · ${[agent.command, ...(agent.args ?? [])].join(" ").replace(/[\r\n]/g, " ")}`;
            return `  ${agent.name} · ${agent.origin === "app" ? "程序管理" : "config.json"} · ${agent.enabled ? "已启用" : "已停用"}${command}${agent.description ? ` · ${agent.description}` : ""}${conflict ? ` · 警告：${conflict}` : ""}`;
          }),
        ]
      : ["本会话没有配置外部 agent"]),
    ...description.warnings.map((warning) => `! ${warning}`),
    "费用与额度计在该 agent 自己的账号上",
  ];
}

export function helpLines(): string[] {
  const lines = ["斜杠命令："];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === "/quit") continue;
    const extra = cmd.name === "/exit" ? ", /quit" : "";
    lines.push(`  ${cmd.name}${extra}`.padEnd(18) + cmd.summary);
  }
  lines.push("快捷键：Ctrl+O 展开/收起思考；Shift+Tab 思考档位；Alt+M 权限预设；Ctrl+J 换行；");
  lines.push("Esc 中断；空闲且输入为空时 600ms 内双按 Esc 打开回退列表。");
  lines.push("Ctrl+C 中断（空闲时退出）；Ctrl+D 退出。输入历史按工作区保存为明文 history.jsonl。");
  return lines;
}

export function cliHelpText(): string {
  const lines = ["斜杠命令："];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === "/quit" || cmd.tuiOnly === true) continue;
    const name = cmd.name === "/exit" ? "/exit, /quit" : cmd.name;
    lines.push(`  ${name.padEnd(22)}${cmd.cli ?? cmd.summary}`);
  }
  lines.push("快捷键：Ctrl+C 中断当前 Turn（空闲时退出）；Ctrl+D 退出。");
  lines.push("输入历史按工作区保存为明文 <NOCTURNE_HOME>/history.jsonl。");
  return lines.join("\n");
}

function rank(
  query: string,
  items: readonly { key: string; label: string; insert: string }[],
): Candidate[] {
  const q = query.toLowerCase();
  const prefix: Candidate[] = [];
  const contains: Candidate[] = [];
  for (const item of items) {
    const key = item.key.toLowerCase();
    const hit: Candidate = { label: item.label, insert: item.insert };
    if (q === "" || key.startsWith(q)) prefix.push(hit);
    else if (key.includes(q)) contains.push(hit);
  }
  return [...prefix, ...contains];
}

function commandItems(tui: boolean): { key: string; label: string; insert: string }[] {
  return SLASH_COMMANDS.filter((cmd) => tui || cmd.tuiOnly !== true).map((cmd) => ({
    key: cmd.name,
    label: `${cmd.name}  ${cmd.summary}`,
    insert: cmd.name,
  }));
}

function labeled(
  key: string,
  label: string,
  insert: string,
): { key: string; label: string; insert: string } {
  return { key, label, insert };
}

function argItems(
  command: SlashCommand,
  ctx: CompletionContext,
): { key: string; label: string; insert: string }[] {
  const prefix = `${command.name} `;
  if (command.args === "effort") {
    const levels = ["off", ...ctx.effortLevels.filter((level) => level !== "off")];
    return levels.map((level) => labeled(level, level, `${prefix}${level}`));
  }
  if (command.args === "preset") {
    return PRESET_NAMES.map((name) => labeled(name, name, `${prefix}${name}`));
  }
  if (command.args === "shell") {
    // ADR-0022：auto 在前；可用性以选择页（/shell）为准，补全只列名字
    return ["auto", ...SHELL_KIND_NAMES].map((name) => labeled(name, name, `${prefix}${name}`));
  }
  const subs = PROVIDER_SUBCOMMANDS.map((sub) =>
    labeled(sub.name, `${sub.name}  ${sub.summary}`, `${prefix}${sub.name}`),
  );
  const providers = ctx.providerIds.map((id) => labeled(id, `${id}  已配置`, `${prefix}${id}`));
  return [...subs, ...providers];
}

/**
 * 输入以 / 开头时的候选。排序：前缀匹配优先，其次包含匹配。
 * 完整命令名加一个空格后进入参数补全。
 * 调用方按帧预算截断行数（最多 8）。
 */
export function completeSlash(line: string, ctx: CompletionContext, tui = true): Candidate[] {
  if (!line.startsWith("/")) return [];
  const space = line.indexOf(" ");
  if (space === -1) {
    const commands = rank(line, commandItems(tui)).map((c) => ({
      ...c,
      group: "commands" as const,
    }));
    const skills = (ctx.skills ?? [])
      .filter(
        (s) =>
          (s.invocation === "both" || s.invocation === "user") &&
          s.enabled !== false &&
          s.shadowedBy === undefined &&
          s.commandConflict !== true &&
          !SLASH_COMMANDS.some((c) => c.name.toLowerCase() === `/${s.name.toLowerCase()}`),
      )
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return [
      ...commands,
      ...rank(
        line,
        skills.map((s) => ({
          key: `/${s.name}`,
          insert: `/${s.name} `,
          label: `/${s.name} ${typeof s.fields["argument-hint"] === "string" ? s.fields["argument-hint"] : ""}  ${s.description.slice(0, 250) || "没有说明"}`,
        })),
      ).map((c) => ({ ...c, group: "skills" as const })),
      ...rank(
        line,
        (ctx.externalAgents ?? [])
          .filter(
            (agent) => agent.enabled && externalAgentConflict(agent, ctx.skills) === undefined,
          )
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .map((agent) => ({
            key: `/${agent.name}`,
            insert: `/${agent.name} `,
            label: `/${agent.name}  ${agent.description?.slice(0, 250) ?? "没有说明"}`,
          })),
      ).map((candidate) => ({ ...candidate, group: "agents" as const })),
    ];
  }
  const name = line.slice(0, space);
  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name && (tui || cmd.tuiOnly !== true));
  if (command?.args === undefined) return [];
  const rest = line.slice(space + 1);
  const query = rest.includes(" ") ? (rest.split(/\s+/).at(-1) ?? "") : rest.trimStart();
  if (command.args === "provider" && rest.includes(" ")) {
    const token = rest.slice(0, rest.lastIndexOf(" ")).trim();
    const sub = PROVIDER_SUBCOMMANDS.find((item) => item.name === token);
    if (sub !== undefined) {
      return rank(
        query,
        ctx.providerIds.map((id) =>
          labeled(id, `${id}  已配置`, `${command.name} ${sub.name} ${id}`),
        ),
      );
    }
  }
  return rank(query, argItems(command, ctx));
}

/**
 * readline completer：匹配列表是补全后的整行，被替换的前缀也是整行。
 * 多个匹配时 readline 取公共前缀。
 */
export function readlineCompleter(line: string, ctx: CompletionContext): [string[], string] {
  const hits = completeSlash(line, ctx, false);
  if (hits.length === 0) return [[], line];
  return [hits.map((h) => h.insert), line];
}
