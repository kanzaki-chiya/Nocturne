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
  args?: "effort" | "provider" | "preset" | undefined;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", summary: "显示帮助", cli: "列出命令与快捷键" },
  { name: "/model", summary: "切换模型", cli: "列出或切换模型" },
  { name: "/effort", summary: "切换思考档位", cli: "显示或切换思考强度", args: "effort" },
  { name: "/preset", summary: "切换权限预设", cli: "显示或切换权限预设", args: "preset" },
  { name: "/context", summary: "查看上下文", cli: "显示上下文组成" },
  { name: "/mcp", summary: "MCP 状态", cli: "显示本会话 MCP 服务器状态" },
  { name: "/compact", summary: "压缩上下文", cli: "手动压缩上下文" },
  { name: "/resume", summary: "切换会话", cli: "列出会话或按 id 切换" },
  { name: "/new", summary: "新建会话", cli: "新建并切换到空会话" },
  { name: "/clear", summary: "新建会话", cli: "/new 的别名" },
  { name: "/provider", summary: "管理服务商", cli: "列出或管理服务商", args: "provider" },
  { name: "/exit", summary: "退出", cli: "退出" },
  { name: "/quit", summary: "退出", cli: "退出" },
];

/** 与权限层预设名一致；补全与 Alt+M 共用，不另抄一份。 */
export const PRESET_NAMES = ["read-only", "default", "auto-edit", "full-access"] as const;

export const PROVIDER_SUBCOMMANDS: readonly { name: string; summary: string }[] = [
  { name: "add", summary: "添加服务商" },
  { name: "key", summary: "更新密钥" },
  { name: "refresh", summary: "刷新模型列表" },
  { name: "thinking", summary: "调整思考档位" },
  { name: "remove", summary: "删除服务商" },
];

export interface CompletionContext {
  /** 当前模型可用档位，不含 off（off 由补全自行加上） */
  effortLevels: readonly string[];
  /** 已配置服务商 id */
  providerIds: readonly string[];
}

export interface Candidate {
  /** 显示行，如 `/model  切换模型` */
  label: string;
  /** 写入输入框或交给 readline 的完整文本 */
  insert: string;
}

export function helpLines(): string[] {
  const lines = ["斜杠命令："];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === "/quit") continue;
    const extra = cmd.name === "/exit" ? ", /quit" : "";
    lines.push(`  ${cmd.name}${extra}`.padEnd(18) + cmd.summary);
  }
  lines.push("快捷键：Shift+Tab 思考档位；Alt+M 权限预设；Ctrl+J 换行；");
  lines.push("Ctrl+C 中断（空闲时退出）；Ctrl+D 退出。输入历史按工作区保存为明文 history.jsonl。");
  return lines;
}

export function cliHelpText(): string {
  const lines = ["斜杠命令："];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === "/quit") continue;
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

function commandItems(): { key: string; label: string; insert: string }[] {
  return SLASH_COMMANDS.map((cmd) => ({
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
export function completeSlash(line: string, ctx: CompletionContext): Candidate[] {
  if (!line.startsWith("/")) return [];
  const space = line.indexOf(" ");
  if (space === -1) return rank(line, commandItems());
  const name = line.slice(0, space);
  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name);
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
  const hits = completeSlash(line, ctx);
  if (hits.length === 0) return [[], line];
  return [hits.map((h) => h.insert), line];
}
