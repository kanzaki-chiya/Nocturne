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
import {
  isCompositeShell,
  isOpaquePowerShellCommand,
  isPathKind,
  findRiskySegment,
  matchPattern,
  normalizePathText,
  shellDialect,
  shellSegments,
} from "./pattern.js";
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
   * 内置硬拒绝路径集（provider-setup.md 第 4 节：凭据索引 credentials.json
   * 及其原子写临时文件）。lexical 匹配词法 target、resolved 匹配真实路径；
   * 任何规则、Grant、--yes、guarded 都不能放开。
   */
  protectedPaths?:
    | { lexical?: readonly string[] | undefined; resolved?: readonly string[] | undefined }
    | undefined;
  /** 生效 external-file 的绝对词法路径与真实路径，由 Runtime 解析后注入。 */
  externalCredentialPaths?:
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
  userOnly?: boolean | undefined;
}

const STRICTNESS: Record<PermissionAction, number> = { deny: 2, ask: 1, allow: 0 };

/**
 * 凭据相关命令模式（provider-setup.md 第 4 节第 3 条）：shell 命令中
 * 出现凭据索引文件名或系统凭据后端的读取调用时至少 ask——即便宽
 * 规则/Grant 已 allow。
 * - 索引：credentials.json
 * - macOS：security …-generic-password（-i 交互模式同命令族）
 * - Linux：secret-tool（store/lookup/clear 都经它）
 * - Windows：ProtectedData（DPAPI 的 .NET 入口类名）
 */
const CREDENTIAL_COMMAND_PATTERNS = [
  /\bcredentials\.json\b/i,
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
      skillRoots: options.presetContext?.skillRoots,
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
  const externalPaths = new Set(
    [
      ...(options.externalCredentialPaths?.lexical ?? []),
      ...(options.externalCredentialPaths?.resolved ?? []),
    ].map((p) => normalizePathText(p, caseSensitive)),
  );
  const isExternalCredential = (s: PermissionSubject): boolean =>
    isPathKind(s.kind) &&
    [s.target, s.resolved].some(
      (p) => p !== undefined && externalPaths.has(normalizePathText(p, caseSensitive)),
    );
  // 和已有凭据命令提示一致：按文件名保守匹配，可覆盖 ~、相对路径及分隔符别名。
  const externalFileNames = [...externalPaths].map((p) => p.split("/").at(-1) ?? p);
  const isCredentialCommand = (command: string): boolean =>
    isCredentialBackendCommand(command) ||
    externalFileNames.some((name) =>
      (caseSensitive ? command : command.toLowerCase()).includes(name),
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
    // 内置硬拒绝（provider-setup.md 第 4 节）：凭据索引等文件在任何
    // 规则/Grant/--yes/guarded/Hook 下都不可读写——词法与真实路径都查
    const externalCredential = isExternalCredential(s);
    if (isProtected(s) || externalCredential) {
      return {
        action: "deny",
        hit: {
          origin: "default",
          description: `${externalCredential ? "外部服务商凭据文件" : "Nocturne 凭据文件"}（内置硬拒绝：任何规则与授权都不能放开）`,
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

    // bypass 仍保护 Runtime 的授权数据；显式 deny 不受影响。
    const protectedEdit =
      presetName === "bypass" && s.kind === "edit" ? lastMatch(preset, s) : undefined;
    if (action === "allow" && protectedEdit?.rule?.action === "ask") {
      action = "ask";
      hit = protectedEdit;
    }

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

    // 组合命令（permissions.md 5.3）：窄模式的 allow 降级为 ask（deny 不受影响，grant 精确匹配不受影响）。
    // 全放行规则（pattern 为 "*"，如 guarded）降级没有意义，改为逐段求值：
    // 任一段命中 ask/deny（高风险命令、用户 deny 等）就取最严格者。
    // ADR-0022：分段方言由主体携带的 shell 种类决定（PowerShell 另切脚本块）
    const dialect = shellDialect(s.kind === "shell" ? s.shell : undefined);
    if (s.kind === "shell" && action === "allow" && isCompositeShell(s.target, dialect)) {
      if (hit.rule?.pattern === "*") {
        for (const segment of shellSegments(s.target, dialect)) {
          const seg = { ...s, target: segment };
          const segTrusted = lastMatch(trusted, seg);
          let segAction: PermissionAction = segTrusted?.rule?.action ?? "ask";
          let segHit = segTrusted;
          const segUntrusted = lastMatch(untrusted, seg);
          const segUntrustedAction = segUntrusted?.rule?.action;
          if (
            segUntrustedAction !== undefined &&
            STRICTNESS[segUntrustedAction] > STRICTNESS[segAction]
          ) {
            segAction = segUntrustedAction;
            segHit = segUntrusted;
          }
          if (STRICTNESS[segAction] > STRICTNESS[action]) {
            action = segAction;
            if (segHit !== undefined) hit = segHit;
            note = `组合命令中的「${segment}」需逐段放行`;
          }
        }
      } else {
        action = "ask";
        note = "命令包含控制符/重定向，模式匹配的 allow 降级为需确认";
      }
    }

    // 高风险元数据（ADR-0022 第 6 节）：表由生效 ShellDescriptor 经主体
    // 透传，通配符表达不了的 PowerShell/cmd 语义（参数前缀缩写、标志共存、
    // 大小写不敏感）在此按元数据匹配；只把预设级宽规则的 allow 降级为 ask，
    // 用户/项目/CLI 显式规则照旧覆盖
    if (
      s.kind === "shell" &&
      action === "allow" &&
      hit.origin === "preset" &&
      presetName !== "bypass"
    ) {
      // 含嵌套 shell 调用（pwsh -c "…"、cmd /c "…"）的命令体，按内层方言再查
      const risky = findRiskySegment(s.target, dialect, s.shellRisk, s.shellRiskByDialect);
      if (risky !== undefined) {
        action = "ask";
        hit = { origin: "preset", description: `预设 ${presetName} 高风险命令` };
        note = [note, `高风险命令「${risky}」按 ${s.shell ?? "sh"} 语法判定`]
          .filter(Boolean)
          .join("；");
      }
    }

    // 凭据相关命令至少 ask（provider-setup.md 第 4 节）：shell allow 命中
    // 凭据文件名或后端读取命令时降级；Grant/--yes 仍可在 ask 层批准
    if (s.kind === "shell" && action === "allow" && isCredentialCommand(s.target)) {
      action = "ask";
      note = [note, "可能读取 Nocturne 凭据"].filter(Boolean).join("；");
    }

    // 不透明 PowerShell -EncodedCommand 至少 ask（ADR-0022 第 6 节）：
    // 编码负载无法做内容审查，含嵌套调用同样降级
    if (
      s.kind === "shell" &&
      action === "allow" &&
      presetName !== "bypass" &&
      isOpaquePowerShellCommand(s.target)
    ) {
      action = "ask";
      note = [note, "包含 PowerShell -EncodedCommand（内容不透明）"].filter(Boolean).join("；");
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
    const presetHit = s.kind === "edit" ? lastMatch(preset, s) : undefined;
    const userOnly =
      (s.kind === "shell" && isCredentialCommand(s.target)) ||
      presetHit?.rule?.userOnly === true ||
      (hit.rule?.action === "ask" && hit.origin !== "preset" && hit.origin !== "default");
    return { action, hit, note, userOnly };
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
          decisive = v;
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
        userOnly: verdicts.some((v) => v.action === "ask" && v.userOnly),
        reviewSubjects: evaluated.flatMap((s, i) =>
          verdicts[i]?.action === "ask"
            ? [
                {
                  kind: s.kind,
                  target: s.resolved ?? s.target,
                  where: s.where,
                  rule: verdicts[i].hit,
                },
              ]
            : [],
        ),
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
