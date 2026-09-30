/**
 * 权限预设（permissions.md 第 6 节）。
 * 预设只是一组有序规则（后写优先），没有隐藏逻辑：
 *   1. 宽规则（按预设表）
 *   2. 本会话落盘目录可读（sessionsDir/attachments/<sessionId>/**）
 *   3. 受保护路径 edit 至少 ask（read-only 中不生成，保持 deny）
 *   4. Nocturne 授权数据 edit 至少 ask（label "修改 Nocturne 授权配置"）
 *
 * 高风险 shell 命令不再由预设规则表达（ADR-0022 第 1 节）：表集中在
 * platform 的 ShellDescriptor.risk，full-access 的宽 allow 命中时由
 * policy 按主体透传的元数据降级为 ask。
 */
import type { PermissionPresetName, PermissionRule } from "../protocol/index.js";
import { normalizePathText } from "./pattern.js";

export const PERMISSION_PRESET_NAMES: readonly PermissionPresetName[] = [
  "read-only",
  "default",
  "auto-edit",
  "full-access",
];

export function isPermissionPresetName(name: string): name is PermissionPresetName {
  return (PERMISSION_PRESET_NAMES as readonly string[]).includes(name);
}

/** 预设构造上下文：生成具体路径模式所需的绝对路径（调用方传 realpath 后的值） */
export interface PresetContext {
  workspaceRoot: string;
  caseSensitive: boolean;
  /** 会话目录与当前会话 id：生成"本会话落盘目录可读"规则 */
  sessionsDir?: string | undefined;
  sessionId?: string | undefined;
  /** Nocturne 数据目录：生成授权数据保护规则 */
  nocturneHome?: string | undefined;
}

const PROTECTED_LABEL = "受保护路径";
const AUTH_DATA_LABEL = "修改 Nocturne 授权配置";
const ATTACHMENTS_LABEL = "本会话落盘目录";

interface BroadRule {
  kind?: PermissionRule["kind"];
  pattern: string;
  action: PermissionRule["action"];
  where?: PermissionRule["where"];
}

function broadRules(name: PermissionPresetName): BroadRule[] {
  const readWs: BroadRule = { kind: "read", pattern: "**", where: "workspace", action: "allow" };
  const readOut = (a: PermissionRule["action"]): BroadRule => ({
    kind: "read",
    pattern: "**",
    where: "outside",
    action: a,
  });
  const edit = (a: PermissionRule["action"], where?: PermissionRule["where"]): BroadRule => ({
    kind: "edit",
    pattern: "**",
    ...(where !== undefined ? { where } : {}),
    action: a,
  });
  const shell = (a: PermissionRule["action"]): BroadRule => ({
    kind: "shell",
    pattern: "*",
    action: a,
  });
  const other = (a: PermissionRule["action"]): BroadRule[] => [
    { kind: "network", pattern: "*", action: a },
    { kind: "mcp", pattern: "*", action: a },
  ];
  // subagent（Phase 6，subagent.md 第 7 节）：explore 是只读工具集，
  // 它能拿到的 allow 都是父会话本就会自动放行的，default/auto-edit 下直接放行；
  // general/custom 不落规则 → 无匹配默认 ask（求值取最严命中，不能靠 * 兜底）
  const subagentExplore: BroadRule[] = [{ kind: "subagent", pattern: "explore", action: "allow" }];

  switch (name) {
    case "read-only":
      return [
        readWs,
        readOut("ask"),
        edit("deny"),
        shell("ask"),
        ...other("ask"),
        { kind: "subagent", pattern: "*", action: "ask" },
      ];
    case "default":
      return [
        readWs,
        readOut("ask"),
        edit("ask"),
        shell("ask"),
        ...other("ask"),
        ...subagentExplore,
      ];
    case "auto-edit":
      return [
        readWs,
        readOut("ask"),
        edit("allow", "workspace"),
        edit("ask", "outside"),
        shell("ask"),
        ...other("ask"),
        ...subagentExplore,
      ];
    case "full-access":
      return [
        readWs,
        readOut("allow"),
        edit("allow", "workspace"),
        edit("ask", "outside"),
        shell("allow"),
        ...other("allow"),
        { kind: "subagent", pattern: "*", action: "allow" },
      ];
  }
}

/** 生成预设的规则序列（按"后写优先"排序：靠后的规则覆盖靠前的） */
export function presetRules(name: PermissionPresetName, ctx: PresetContext): PermissionRule[] {
  const rules: PermissionRule[] = broadRules(name);

  // 本会话落盘目录可读：模型回读自己的完整输出不触发确认；
  // 只放行当前 sessionId，其他会话附件仍走正常求值
  if (ctx.sessionsDir !== undefined && ctx.sessionId !== undefined) {
    const dir = normalizePathText(
      `${ctx.sessionsDir}/attachments/${ctx.sessionId}`,
      ctx.caseSensitive,
    );
    rules.push({ kind: "read", pattern: `${dir}/**`, action: "allow", label: ATTACHMENTS_LABEL });
  }

  // 受保护路径与授权数据"至少 ask"：read-only 中 edit 已一律 deny，不再生成 ask 规则
  if (name !== "read-only") {
    for (const pattern of ["**/.git/**", "**/.nocturne/**"]) {
      rules.push({ kind: "edit", pattern, action: "ask", label: PROTECTED_LABEL });
    }
    if (ctx.nocturneHome !== undefined) {
      const home = normalizePathText(ctx.nocturneHome, ctx.caseSensitive);
      // 授权数据组（permissions.md 第 6 节）：providers.json 是向导写入的
      // 服务商清单，与 config.json/trust.json/grants 同级保护；
      // credentials.json 不在这里——它是内置硬拒绝（policy.ts），非 ask
      for (const pattern of [
        `${home}/config.json`,
        `${home}/trust.json`,
        `${home}/grants/**`,
        `${home}/providers.json`,
        `${home}/settings.json`,
      ]) {
        rules.push({ kind: "edit", pattern, action: "ask", label: AUTH_DATA_LABEL });
      }
    }
  }
  return rules;
}
