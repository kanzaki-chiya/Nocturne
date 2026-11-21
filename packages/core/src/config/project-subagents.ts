/**
 * 项目级子代理发现与解析（ADR-0108）：
 * 从 cwd 上溯到 workspaceRoot，单层扫描 `.nocturne/agents/*.md` 与 `.claude/agents/*.md`
 * （后者受 `skills.sources.claude` 控制）。不要求项目信任。
 */
import { fsErrorCode, type Platform } from "../platform/index.js";
import {
  PROJECT_SUBAGENT_PREFIX,
  type ProjectSubagentOverview,
  type ProjectSubagentSource,
  type ReasoningEffort,
} from "../protocol/index.js";
import { parseClaudeSubagentMarkdown, parseNocturneSubagentMarkdown } from "./subagent-markdown.js";

export interface DiscoveredProjectSubagent {
  /** 档位 id：`project:<name>` */
  id: string;
  name: string;
  description: string;
  source: ProjectSubagentSource;
  /** 文件绝对路径 */
  path: string;
  /** 相对 workspaceRoot 的路径（POSIX `/` 分隔，用于提示词段首） */
  relativePath: string;
  prompt: string;
  effort?: ReasoningEffort | undefined;
  tools?: string[] | undefined;
  disallowedTools?: string[] | undefined;
  shadowedBy?: string | undefined;
}

export interface ProjectSubagentsDiscovery {
  /** 全部解析成功的项目子代理（含被同名覆盖的条目，覆盖者在前） */
  agents: DiscoveredProjectSubagent[];
  /** 生效的项目子代理（不含 shadowedBy 条目） */
  active: DiscoveredProjectSubagent[];
  /** 解析、读取与覆盖警告（带文件路径） */
  warnings: string[];
}

export function toProjectSubagentOverview(
  agent: DiscoveredProjectSubagent,
): ProjectSubagentOverview {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    source: agent.source,
    path: agent.path,
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
    ...(agent.tools !== undefined ? { tools: [...agent.tools] } : {}),
    ...(agent.shadowedBy !== undefined ? { shadowedBy: agent.shadowedBy } : {}),
  };
}

export async function discoverProjectSubagents(
  platform: Platform,
  input: {
    workspaceRoot: string;
    cwd: string;
    /** 是否扫描 `.claude/agents`（受 `skills.sources.claude` 控制，缺省 true） */
    includeClaude?: boolean | undefined;
  },
): Promise<ProjectSubagentsDiscovery> {
  const { fs, paths } = platform;
  const includeClaude = input.includeClaude !== false;
  const workspaceRoot = paths.resolve(input.workspaceRoot, ".");
  const startDir = paths.resolve(input.cwd, ".");

  const roots: { path: string; source: ProjectSubagentSource }[] = [];
  const pushLevel = (base: string) => {
    roots.push({ path: paths.join(base, ".nocturne", "agents"), source: ".nocturne" });
    if (includeClaude) {
      roots.push({ path: paths.join(base, ".claude", "agents"), source: ".claude" });
    }
  };

  if (paths.isWithin(workspaceRoot, startDir)) {
    let dir = startDir;
    while (paths.isWithin(workspaceRoot, dir)) {
      pushLevel(dir);
      if (paths.equals(dir, workspaceRoot)) break;
      const parent = paths.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } else {
    pushLevel(workspaceRoot);
  }

  const agents: DiscoveredProjectSubagent[] = [];
  const active: DiscoveredProjectSubagent[] = [];
  const warnings: string[] = [];
  const winners = new Map<string, DiscoveredProjectSubagent>();
  const realSeen = new Set<string>();

  for (const root of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(root.path);
    } catch (e) {
      const code = fsErrorCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      warnings.push(`项目子代理目录 ${root.path}：读取失败（${String(e)}）`);
      continue;
    }
    if (rootStat.type !== "directory") continue;

    let entries;
    try {
      entries = await fs.readdir(root.path);
    } catch (e) {
      warnings.push(`项目子代理目录 ${root.path}：读取失败（${String(e)}）`);
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== "file" && entry.type !== "symlink") continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;

      let realPath: string;
      try {
        realPath = await platform.resolveReal(entry.path);
      } catch (e) {
        warnings.push(
          `项目子代理 ${entry.path}：路径解析失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
        );
        continue;
      }

      let fileStat;
      try {
        fileStat = await fs.stat(realPath);
      } catch (e) {
        warnings.push(
          `项目子代理 ${entry.path}：读取失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
        );
        continue;
      }
      if (fileStat.type !== "file") continue;

      const canonicalReal = paths.canonicalize(realPath);
      if (realSeen.has(canonicalReal)) continue;
      realSeen.add(canonicalReal);

      let text: string;
      try {
        text = await fs.readTextFile(realPath);
      } catch (e) {
        warnings.push(
          `项目子代理 ${entry.path}：读取失败（${e instanceof Error ? e.message : String(e)}），已跳过`,
        );
        continue;
      }

      const prefix = `项目子代理 ${entry.path}：`;
      const parsed =
        root.source === ".nocturne"
          ? parseNocturneSubagentMarkdown(text, {
              prefix,
              rejectLongDescription: false,
              modelIgnoreReason: "项目子代理不能指定模型",
            })
          : parseClaudeSubagentMarkdown(text, { prefix });
      warnings.push(...parsed.warnings);
      if (parsed.agent === undefined) continue;

      const rel = paths.relative(workspaceRoot, entry.path).replace(/\\/g, "/");
      const winner = winners.get(parsed.agent.name);
      const discovered: DiscoveredProjectSubagent = {
        id: `${PROJECT_SUBAGENT_PREFIX}${parsed.agent.name}`,
        name: parsed.agent.name,
        description: parsed.agent.description,
        source: root.source,
        path: entry.path,
        relativePath: rel !== "" ? rel : entry.name,
        prompt: parsed.agent.prompt,
        ...(parsed.agent.effort !== undefined ? { effort: parsed.agent.effort } : {}),
        ...(parsed.agent.tools !== undefined ? { tools: parsed.agent.tools } : {}),
        ...(parsed.agent.disallowedTools !== undefined
          ? { disallowedTools: parsed.agent.disallowedTools }
          : {}),
        ...(winner !== undefined ? { shadowedBy: winner.path } : {}),
      };
      agents.push(discovered);
      if (winner !== undefined) {
        warnings.push(
          `项目子代理 ${entry.path}：名称 "${parsed.agent.name}" 已被 ${winner.path} 覆盖，已忽略`,
        );
      } else {
        winners.set(parsed.agent.name, discovered);
        active.push(discovered);
      }
    }
  }

  return { agents, active, warnings };
}
