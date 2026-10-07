export interface SkillsConfig {
  sources?: { agents?: boolean | undefined; claude?: boolean | undefined } | undefined;
  extraDirs?: string[] | undefined;
}

export interface SkillWarning {
  path: string;
  line: number;
  message: string;
  kind: "parse" | "name" | "read";
}

export interface SkillOverview {
  name: string;
  layer: "user" | "project";
  source: ".nocturne" | ".agents" | ".claude" | "extra";
  entryPath: string;
  realPath: string;
  otherEntries: string[];
  description: string;
  displayedDescriptionLength: number;
  invocation: "both" | "user" | "model" | "none";
  catalogStatus: "full" | "name" | "omitted";
  enabled: boolean;
  shadowedBy?: string | undefined;
  commandConflict: boolean;
  missingDescription: boolean;
  fields: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
  ignored: { syntax: string; reason: string }[];
  bodyLines: number;
  bodyPreview: string;
  files: { name: string; directory: boolean }[];
  size: number;
}

export interface SkillsBudget {
  usedTokens: number;
  limitTokens: number;
  fullCount: number;
  nameCount: number;
  disabledCount: number;
  basis: "session-model" | "default-model" | "fallback";
}

export interface SkillsDescription {
  skills: SkillOverview[];
  warnings: SkillWarning[];
  budget: SkillsBudget;
  scannedDirs: string[];
  homeDir: string;
}

/**
 * 导入预检的单个候选（skills.md 第 7 节）：与 Core 的 SkillImportCandidate
 * 同形，protocol 层重述一次，RPC 方法签名引用这里。
 */
export interface SkillImportCandidateView {
  name: string;
  sourcePath: string;
  declaredName?: string | undefined;
  valid: boolean;
  reason?: string | undefined;
  skippedLinks: string[];
  sizeBytes: number;
  missingDescription: boolean;
  targetConflict: boolean;
  shadowNote?: string | undefined;
  suggestedName?: string | undefined;
}

export interface SkillImportDecisionView {
  sourcePath: string;
  name?: string | undefined;
  action: "rename" | "overwrite" | "skip";
}

export interface SkillImportResultView {
  sourcePath: string;
  name: string;
  status: "imported" | "skipped";
  reason?: string | undefined;
  targetPath: string;
  finalName?: string | undefined;
  missingDescription: boolean;
}

export type SkillImportInput =
  | {
      mode: "preview";
      sourceDir: string;
      target: "user" | "project";
      workspaceRoot?: string | undefined;
    }
  | {
      mode: "commit";
      target: "user" | "project";
      workspaceRoot?: string | undefined;
      decisions: SkillImportDecisionView[];
    };

export type SkillImportOutput =
  | {
      mode: "preview";
      targetDir: string;
      targetLayer: "user" | "project";
      candidates: SkillImportCandidateView[];
    }
  | {
      mode: "commit";
      targetDir: string;
      results: SkillImportResultView[];
      affectedSessions: number;
    };

export interface SkillInvocation {
  name: string;
  arguments?: string | undefined;
}

export interface SkillSnapshot {
  name: string;
  body: string;
}

/**
 * 客户端内置斜杠命令名单（不含斜杠）：CLI / TUI / 桌面端命令表的并集
 * （skills.md 第 6 节）。技能名与之冲突时标记 commandConflict，不能经
 * 斜杠调用。各客户端有测试断言本端命令都在名单内，新增命令要同步这里。
 */
export const BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "help",
  "theme",
  "settings",
  "model",
  "effort",
  "preset",
  "shell",
  "context",
  "mcp",
  "skills",
  "agents",
  "compact",
  "resume",
  "rewind",
  "fork",
  "new",
  "clear",
  "provider",
  "exit",
  "quit",
];

export function parseSkillSlash(
  line: string,
  skills: readonly SkillOverview[],
): SkillInvocation | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match) return undefined;
  if (BUILTIN_SLASH_COMMANDS.includes(match[1]?.toLowerCase() ?? "")) return undefined;
  const skill = skills.find(
    (s) =>
      s.name.toLowerCase() === match[1]?.toLowerCase() &&
      s.enabled &&
      !s.shadowedBy &&
      !s.commandConflict &&
      (s.invocation === "both" || s.invocation === "user"),
  );
  return skill ? { name: skill.name, arguments: match[2] ?? "" } : undefined;
}

export function skillListLines(skills: readonly SkillOverview[]): string[] {
  return skills.length
    ? [
        "技能：",
        ...skills.map(
          (s) =>
            `  ${s.name} · ${s.layer === "user" ? "用户" : "项目"} ${s.source} · ${s.shadowedBy ? `被 ${s.shadowedBy} 覆盖` : !s.enabled ? "已停用" : s.catalogStatus === "full" ? "完整说明" : s.catalogStatus === "name" ? "只显示名字" : "不进入模型目录"}`,
        ),
      ]
    : ["本会话没有发现技能"];
}
