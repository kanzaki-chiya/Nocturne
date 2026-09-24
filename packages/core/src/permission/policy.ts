/**
 * 权限策略（permissions.md 第 5、6 节）。
 *
 * - `createRulePolicy`：Phase 3 完整实现——内置预设 + 分层规则（后写优先）
 *   + 不可信项目规则收紧 + Grant + autoApproveAsk（--yes）+ 命中解释。
 * - `createDefaultPolicy` / `createWorkspaceReadPolicy`：旧签名的兼容封装，
 *   语义分别等于 default 预设与"工作区内只读"固定策略。
 */
import type {
  AnnotatedRule,
  Grant,
  PermissionAction,
  PermissionPresetName,
  PermissionRule,
  PermissionSubject,
  RuleHit,
  RuleOrigin,
} from "../protocol/index.js";
import { matchGrant } from "./grants.js";
import { isCompositeShell, isPathKind, matchPattern, normalizePathText } from "./pattern.js";
import { presetRules, type PresetContext } from "./presets.js";
import { computeWhere } from "./where.js";
import type { EvaluateOptions, PermissionPolicy, SubjectEvaluation } from "./types.js";

export interface RulePolicyOptions {
  /** 已解析为真实路径的工作区根目录 */
  workspaceRoot: string;
  /** 路径比较是否大小写敏感（来自 platform 的文件系统信息） */
  caseSensitive: boolean;
  /** 内置预设名；缺省 "default" */
  preset?: PermissionPresetName | undefined;
  /** 预设构造上下文（落盘目录、授权数据路径）；缺省时不生成对应规则 */
  presetContext?: Omit<PresetContext, "workspaceRoot" | "caseSensitive"> | undefined;
  /** 完整替换预设规则（旧固定策略封装用）；与 preset 互斥 */
  baseRules?: PermissionRule[] | undefined;
  /** 可信规则序列（user < project < cli，已按层序排好） */
  rules?: readonly AnnotatedRule[] | undefined;
  /** 未信任项目配置中仅收紧方向的规则（与可信结果取更严格者，permissions.md 5.2） */
  untrustedRules?: readonly AnnotatedRule[] | undefined;
  /**
   * 内置硬拒绝路径集（provider-setup.md 第 8 节：凭据索引 credentials.json
   * 及其原子写临时文件）。lexical 匹配词法 target、resolved 匹配真实路径；
   * 任何规则、Grant、--yes、full-access 都不能放开。
   */
  protectedPaths?:
    | { lexical?: readonly string[] | undefined; resolved?: readonly string[] | undefined }
    | undefined;
  /** Grant 集合：session 数组由 gate 就地追加（policy 读取活引用），project 为只读快照 */
  grants?: { session?: Grant[]; project?: readonly Grant[] } | undefined;
  /**
   * 命令行允许（permissions.md 5.3）：最终判定为 ask 的调用提升为 allow。
   * 不覆盖 deny，不绕过校验与工具边界。
   */
  autoApproveAsk?: boolean | undefined;
}

interface SubjectVerdict {
  action: PermissionAction;
  hit: RuleHit;
  /** 补充说明（组合命令降级、命令行提升等） */
  note?: string | undefined;
}

const STRICTNESS: Record<PermissionAction, number> = { deny: 2, ask: 1, allow: 0 };

/**
 * 凭据后端命令模式（provider-setup.md 第 8 节）：shell 命令中出现系统
 * 凭据后端的读取调用时至少 ask——即便宽规则/Grant 已 allow。
 * - macOS：security …-generic-password（-i 交互模式同命令族）
 * - Linux：secret-tool（store/lookup/clear 都经它）
 * - Windows：ProtectedData（DPAPI 的 .NET 入口类名）
 */
const CREDENTIAL_COMMAND_PATTERNS = [
  /\bsecurity\b[^\n]*-generic-password\b/i,
  /\bsecret-tool\b/i,
  /\bProtectedData\b/i,
];

function isCredentialBackendCommand(command: string): boolean {
  return CREDENTIAL_COMMAND_PATTERNS.some((re) => re.test(command));
}

function describeHit(origin: RuleOrigin, index: number | undefined, presetName: string): string {
  switch (origin) {
    case "preset":
      return `预设 ${presetName} 第 ${index ?? "?"} 条`;
    case "user":
      return `用户配置第 ${index ?? "?"} 条`;
    case "project":
      return `项目配置第 ${index ?? "?"} 条`;
    case "project-untrusted":
      return `项目配置第 ${index ?? "?"} 条（不可信，仅收紧）`;
    case "cli":
      return `命令行规则第 ${index ?? "?"} 条`;
    case "grant":
      return "Grant";
    case "default":
      return "默认询问（无规则匹配）";
  }
}

function withLabel(description: string, rule: PermissionRule | undefined): string {
  return rule?.label !== undefined ? `${description}（${rule.label}）` : description;
}

function subjectDesc(s: PermissionSubject): string {
  // 命令、URL、MCP 工具名没有路径可解析，原样展示 target
  if (!isPathKind(s.kind)) return `${s.kind} ${s.target}`;
  return s.resolved === undefined
    ? `${s.kind} ${s.target}（无法解析路径）`
    : `${s.kind} ${s.resolved}（${s.where ?? "unknown"}）`;
}

export function createRulePolicy(options: RulePolicyOptions): PermissionPolicy {
  const { workspaceRoot, caseSensitive, autoApproveAsk = false } = options;
  const presetName = options.preset ?? "default";
  const presetRulesList =
    options.baseRules ??
    presetRules(presetName, {
      workspaceRoot,
      caseSensitive,
      sessionsDir: options.presetContext?.sessionsDir,
      sessionId: options.presetContext?.sessionId,
      nocturneHome: options.presetContext?.nocturneHome,
    });
  const preset = presetRulesList.map((rule, i) => ({
    rule,
    origin: "preset" as const,
    index: i + 1,
  }));

  // 可信规则序列：预设 < 用户 < 可信项目 < 命令行；同层内后写优先
  const trusted: { rule: PermissionRule; origin: RuleOrigin; index: number | undefined }[] = [
    ...preset,
    ...numberByOrigin(options.rules ?? []),
  ];
  const untrusted = numberByOrigin(options.untrustedRules ?? []);
  const sessionGrants = options.grants?.session;
  const projectGrants = options.grants?.project ?? [];

  // 内置硬拒绝路径集（词法 + 真实路径两组，规范化后比对）
  const protectedLexical = new Set(
    (options.protectedPaths?.lexical ?? []).map((p) => normalizePathText(p, caseSensitive)),
  );
  const protectedResolved = new Set(
    (options.protectedPaths?.resolved ?? []).map((p) => normalizePathText(p, caseSensitive)),
  );
  const isProtected = (s: PermissionSubject): boolean => {
    if (!isPathKind(s.kind)) return false;
    const lex = normalizePathText(s.target, caseSensitive);
    if ([...protectedLexical].some((p) => lex === p || lex.startsWith(`${p}.tmp-`))) return true;
    if (s.resolved !== undefined) {
      const real = normalizePathText(s.resolved, caseSensitive);
      if ([...protectedResolved].some((p) => real === p || real.startsWith(`${p}.tmp-`))) {
        return true;
      }
    }
    return false;
  };

  function numberByOrigin(rules: readonly AnnotatedRule[]) {
    const counters = new Map<RuleOrigin, number>();
    return rules.map(({ rule, origin }) => {
      const index = (counters.get(origin) ?? 0) + 1;
      counters.set(origin, index);
      return { rule, origin, index };
    });
  }

  function lastMatch(
    list: readonly { rule: PermissionRule; origin: RuleOrigin; index: number | undefined }[],
    s: PermissionSubject,
  ): RuleHit | undefined {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry === undefined) continue;
      const { rule, origin, index } = entry;
      if (rule.kind !== undefined && rule.kind !== "*" && rule.kind !== s.kind) continue;
      if (rule.where !== undefined && rule.where !== s.where) continue;
      if (!matchPattern(rule.pattern, s, workspaceRoot, caseSensitive)) continue;
      return {
        origin,
        index,
        rule,
        description: withLabel(describeHit(origin, index, presetName), rule),
      };
    }
    return undefined;
  }

  function decideSubject(s: PermissionSubject, skipApprovals: boolean | undefined): SubjectVerdict {
    // 内置硬拒绝（provider-setup.md 第 8 节）：凭据索引等文件在任何
    // 规则/Grant/--yes/full-access/Hook 下都不可读写——词法与真实路径都查
    if (isProtected(s)) {
      return {
        action: "deny",
        hit: {
          origin: "default",
          description: "内置硬拒绝：Nocturne 凭据索引（任何规则与授权都不能放开）",
        },
      };
    }

    const trustedHit = lastMatch(trusted, s);
    let action: PermissionAction = trustedHit?.rule?.action ?? "ask";
    let hit: RuleHit =
      trustedHit ??
      ({
        origin: "default",
        description: describeHit("default", undefined, presetName),
      } satisfies RuleHit);
    let note: string | undefined;

    // 不可信项目规则只收紧：取更严格者（permissions.md 5.2）
    const untrustedHit = lastMatch(untrusted, s);
    const untrustedAction = untrustedHit?.rule?.action;
    if (
      untrustedHit !== undefined &&
      untrustedAction !== undefined &&
      STRICTNESS[untrustedAction] > STRICTNESS[action]
    ) {
      action = untrustedAction;
      hit = untrustedHit;
    }

    // 组合命令：基于模式的 allow 降级为 ask（deny 不受影响，grant 精确匹配不受影响）
    if (s.kind === "shell" && action === "allow" && isCompositeShell(s.target)) {
      action = "ask";
      note = "命令包含控制符/重定向，模式匹配的 allow 降级为需确认";
    }

    // 凭据后端命令至少 ask（provider-setup.md 第 8 节）：shell allow 命中
    // 系统凭据后端的读取命令时降级；Grant/--yes 仍可在 ask 层批准
    if (s.kind === "shell" && action === "allow" && isCredentialBackendCommand(s.target)) {
      action = "ask";
      note = [note, "命令涉及系统凭据后端"].filter(Boolean).join("；");
    }

    if (action === "ask" && skipApprovals !== true) {
      const sessionHit =
        sessionGrants !== undefined ? matchGrant(sessionGrants, s, caseSensitive) : undefined;
      const projectHit =
        sessionHit === undefined ? matchGrant(projectGrants, s, caseSensitive) : undefined;
      const grant = sessionHit ?? projectHit;
      if (grant !== undefined) {
        return {
          action: "allow",
          hit: {
            origin: "grant",
            description: `Grant（${sessionHit !== undefined ? "本会话" : "本项目"}）：${s.kind} ${grant.target}`,
          },
        };
      }
      if (autoApproveAsk) {
        return {
          action: "allow",
          hit,
          note: [note, "命令行参数自动批准"].filter(Boolean).join("；"),
        };
      }
    }
    return { action, hit, note };
  }

  return {
    evaluate(subjects, options?: EvaluateOptions): SubjectEvaluation {
      const evaluated = subjects.map((s) => ({
        ...s,
        where:
          s.resolved !== undefined
            ? computeWhere(s.resolved, workspaceRoot, caseSensitive)
            : s.where,
      }));

      // 多主体合并：任一 deny → deny；否则任一 ask → ask；否则 allow（5.3）
      const verdicts = evaluated.map((s) => decideSubject(s, options?.skipApprovals));
      let action: PermissionAction = "allow";
      let decisive: SubjectVerdict | undefined;
      for (const v of verdicts) {
        if (v.action === "deny") {
          action = "deny";
          decisive ??= v;
        } else if (v.action === "ask" && action === "allow") {
          action = "ask";
          decisive ??= v;
        }
      }
      decisive ??= verdicts.at(-1);

      // 空主体集：工具声明不触碰任何资源，直接放行
      if (verdicts.length === 0) {
        return {
          subjects: evaluated,
          decision: { action: "allow", source: "rule", reason: "允许——工具声明不触碰任何资源" },
        };
      }

      const descriptions = evaluated.map(subjectDesc).join("；");
      const hitDesc = decisive?.hit.description ?? describeHit("default", undefined, presetName);
      const note = decisive?.note;
      const reason =
        action === "allow"
          ? `允许（命中：${hitDesc}）${note !== undefined ? `；${note}` : ""}`
          : action === "ask"
            ? `需确认——${descriptions}（命中：${hitDesc}）${note !== undefined ? `；${note}` : ""}`
            : `拒绝——${descriptions}（命中：${hitDesc}）${note !== undefined ? `；${note}` : ""}`;

      return {
        subjects: evaluated,
        decision: {
          action,
          // Grant / autoApproveAsk 产生的 allow 仍属规则层的最终判定；用户应答的
          // source="user" 由 gate 在 ask 流程中给出
          source: decisive?.hit.origin === "grant" && action === "allow" ? "grant" : "rule",
          reason,
          matchedRule: decisive?.hit,
        },
      };
    },
  };
}

// ── 兼容封装（旧签名） ─────────────────────────────────────

export interface WorkspaceReadPolicyOptions {
  workspaceRoot: string;
  caseSensitive: boolean;
}

/** Phase 1 固定策略：工作区内读取 allow，其余 deny（permissions.md 第 6 节前的过渡策略） */
export function createWorkspaceReadPolicy(options: WorkspaceReadPolicyOptions): PermissionPolicy {
  return createRulePolicy({
    workspaceRoot: options.workspaceRoot,
    caseSensitive: options.caseSensitive,
    baseRules: [
      { kind: "*", pattern: "**", action: "deny", label: "仅允许工作区内读取" },
      { kind: "read", pattern: "**", where: "workspace", action: "allow" },
    ],
  });
}

export interface DefaultPolicyOptions extends WorkspaceReadPolicyOptions {
  /**
   * 命令行允许（permissions.md 第 7 节）：最终判定为 ask 的调用提升为 allow。
   * 只作用于 ask；不覆盖任何 deny，也不绕过输入校验、主体解析与工具边界。
   */
  autoApproveAsk?: boolean | undefined;
}

/** Phase 2 的 default 预设：工作区内读取 allow，其余 ask（permissions.md 第 6 节） */
export function createDefaultPolicy(options: DefaultPolicyOptions): PermissionPolicy {
  return createRulePolicy({
    workspaceRoot: options.workspaceRoot,
    caseSensitive: options.caseSensitive,
    preset: "default",
    autoApproveAsk: options.autoApproveAsk,
  });
}
