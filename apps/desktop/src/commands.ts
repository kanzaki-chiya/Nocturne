export type CommandStatus = "supported" | "planned" | "unsupported";

export type CommandName =
  | "/help"
  | "/theme"
  | "/settings"
  | "/model"
  | "/effort"
  | "/preset"
  | "/shell"
  | "/context"
  | "/mcp"
  | "/compact"
  | "/resume"
  | "/rewind"
  | "/fork"
  | "/new"
  | "/clear"
  | "/provider"
  | "/exit"
  | "/quit";

export interface CommandDefinition {
  name: CommandName;
  summary: string;
  usage: string;
  status: CommandStatus;
  statusText: string;
  arguments?: "model" | "effort" | "preset" | "shell" | "resume" | "provider";
}

// 桌面有自己的能力表；不加载 TUI 的页面或命令分发代码。
export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "/help",
    summary: "列出命令与快捷键",
    usage: "/help",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/theme",
    summary: "主题跟随系统外观",
    usage: "/theme",
    status: "unsupported",
    statusText: "暂不支持",
  },
  {
    name: "/settings",
    summary: "设置默认值与界面偏好",
    usage: "/settings",
    status: "planned",
    statusText: "第 3 步实现",
  },
  {
    name: "/model",
    summary: "列出或切换模型",
    usage: "/model [服务商/模型]",
    status: "supported",
    statusText: "可用",
    arguments: "model",
  },
  {
    name: "/effort",
    summary: "查看或切换思考强度",
    usage: "/effort [档位]",
    status: "supported",
    statusText: "可用",
    arguments: "effort",
  },
  {
    name: "/preset",
    summary: "查看或切换权限预设",
    usage: "/preset [预设]",
    status: "supported",
    statusText: "可用",
    arguments: "preset",
  },
  {
    name: "/shell",
    summary: "列出或切换 shell",
    usage: "/shell [种类]",
    status: "supported",
    statusText: "可用",
    arguments: "shell",
  },
  {
    name: "/context",
    summary: "查看上下文组成",
    usage: "/context",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/mcp",
    summary: "查看本会话 MCP 状态",
    usage: "/mcp",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/compact",
    summary: "压缩当前上下文",
    usage: "/compact",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/resume",
    summary: "列出或切换会话",
    usage: "/resume [会话 id]",
    status: "supported",
    statusText: "可用",
    arguments: "resume",
  },
  {
    name: "/rewind",
    summary: "回退对话或还原文件",
    usage: "/rewind",
    status: "unsupported",
    statusText: "暂不支持",
  },
  {
    name: "/fork",
    summary: "从当前位置分叉会话",
    usage: "/fork",
    status: "unsupported",
    statusText: "暂不支持",
  },
  {
    name: "/new",
    summary: "新建并切换到空会话",
    usage: "/new",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/clear",
    summary: "/new 的别名",
    usage: "/clear",
    status: "supported",
    statusText: "可用",
  },
  {
    name: "/provider",
    summary: "管理服务商",
    usage: "/provider [子命令]",
    status: "planned",
    statusText: "第 3 步实现",
    arguments: "provider",
  },
  {
    name: "/exit",
    summary: "请使用窗口的关闭按钮退出",
    usage: "/exit",
    status: "unsupported",
    statusText: "暂不支持",
  },
  {
    name: "/quit",
    summary: "/exit 的别名；请关闭窗口",
    usage: "/quit",
    status: "unsupported",
    statusText: "暂不支持",
  },
];

export type ParsedCommand =
  | { kind: "command"; command: CommandDefinition; name: CommandName; args: string; raw: string }
  | {
      kind: "invalid";
      command: CommandDefinition;
      name: CommandName;
      args: string;
      raw: string;
      message: string;
    }
  | { kind: "unknown"; name: string; args: string; raw: string };

/** 非命令返回 null；参数仅去掉边缘空白，模型 id 等内容不做解释或归一化。 */
export function parseCommand(line: string): ParsedCommand | null {
  const match = /^\s*(\/[^\s]*)(?:\s+([\s\S]*))?$/.exec(line);
  if (match === null) return null;
  const name = match[1] ?? "/";
  const args = (match[2] ?? "").trim();
  const command = COMMANDS.find((item) => item.name === name);
  if (command === undefined) return { kind: "unknown", name, args, raw: line };
  if (args !== "" && command.arguments === undefined) {
    return {
      kind: "invalid",
      command,
      name: command.name,
      args,
      raw: line,
      message: `用法：${command.usage}`,
    };
  }
  return { kind: "command", command, name: command.name, args, raw: line };
}

export interface CommandCompletionContext {
  effortLevels?: readonly string[];
  providerIds?: readonly string[];
  modelRefs?: readonly string[];
  sessionIds?: readonly string[];
}

export interface CommandCompletion {
  label: string;
  summary: string;
  insert: string;
  status: CommandStatus;
  statusText: string;
}

const PRESETS = ["read-only", "default", "auto-edit", "guarded", "smart", "bypass"] as const;
const SHELLS = ["auto", "pwsh", "powershell", "bash", "cmd", "sh"] as const;
const PROVIDER_SUBCOMMANDS = [
  { name: "login", summary: "登录服务商账号" },
  { name: "logout", summary: "退出服务商登录" },
  { name: "add", summary: "添加服务商" },
  { name: "key", summary: "更新密钥" },
  { name: "refresh", summary: "刷新模型列表" },
  { name: "model", summary: "编辑模型设置" },
  { name: "remove", summary: "删除服务商" },
] as const;

function rank(query: string, items: CommandCompletion[]): CommandCompletion[] {
  const q = query.toLowerCase();
  return [
    ...items.filter((item) => item.label.toLowerCase().startsWith(q)),
    ...items.filter(
      (item) => !item.label.toLowerCase().startsWith(q) && item.label.toLowerCase().includes(q),
    ),
  ];
}

/** 只补全单行命令，避免把多行草稿整体替换；不执行命令。 */
export function completeCommands(
  line: string,
  context: CommandCompletionContext = {},
): CommandCompletion[] {
  if (/[\r\n]/.test(line)) return [];
  const text = line.trimStart();
  if (!text.startsWith("/")) return [];
  const leading = line.slice(0, line.length - text.length);
  const separator = text.search(/\s/);
  if (separator < 0) {
    return rank(
      text,
      COMMANDS.map((command) => ({
        label: command.name,
        summary: command.summary,
        insert: `${leading}${command.name} `,
        status: command.status,
        statusText: command.statusText,
      })),
    );
  }
  const command = COMMANDS.find((item) => item.name === text.slice(0, separator));
  if (command?.arguments === undefined) return [];
  const argument = text.slice(separator).trimStart();
  let values: readonly string[] = [];
  let prefix = `${leading}${command.name} `;
  let query = argument;
  switch (command.arguments) {
    case "effort":
      values = [...new Set(["off", ...(context.effortLevels ?? [])])];
      break;
    case "preset":
      values = PRESETS;
      break;
    case "shell":
      values = SHELLS;
      break;
    case "model":
      values = context.modelRefs ?? [];
      break;
    case "resume":
      values = context.sessionIds ?? [];
      break;
    case "provider": {
      const split = argument.search(/\s/);
      if (split < 0) {
        return rank(
          query,
          PROVIDER_SUBCOMMANDS.map((sub) => ({
            label: sub.name,
            summary: sub.summary,
            insert: `${prefix}${sub.name} `,
            status: command.status,
            statusText: command.statusText,
          })),
        );
      }
      const sub = argument.slice(0, split);
      if (!PROVIDER_SUBCOMMANDS.some((item) => item.name === sub)) return [];
      query = argument.slice(split).trimStart();
      prefix += `${sub} `;
      values = context.providerIds ?? [];
      break;
    }
  }
  return rank(
    query,
    [...new Set(values)].map((value) => ({
      label: value,
      summary: command.summary,
      insert: `${prefix}${value}`,
      status: command.status,
      statusText: command.statusText,
    })),
  );
}
