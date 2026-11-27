/**
 * Ensemble 协议契约、提及解析、`<ensemble-post>` 编解码与派生视图纯函数（ADR-0089）。
 * 纯类型与纯函数，无 I/O、无 Node 内置依赖。
 */
import type { DurableEvent, SubagentChanges } from "./events.js";
import type { ModelRef, PermissionOption, PermissionSubject, ReasoningEffort } from "./types.js";

export type EnsembleAuthorKind = "maestro" | "member" | "user" | "runtime";

export type EnsembleMemberStatus = "working" | "waiting" | "paused" | "removed";

export type EnsembleEndReason = "maestro" | "user" | "rewound";

export interface EnsembleCharter {
  owns: string;
  handsOff: string;
  doneWhen: string;
}

export interface EnsembleWorktreeRef {
  path: string;
  branch: string;
  base: string;
}

export interface EnsembleUnmergedWorktree {
  name: string;
  childSessionId: string;
  branch: string;
  base: string;
  head: string;
  worktree: string;
  files: SubagentChanges["files"];
}

/** 投递给成员或指挥的 `message.user.ensemble` 扩展标记（ADR-0089 §7） */
export interface EnsemblePostDelivery {
  postNumber: number;
  from: string;
  fromKind: EnsembleAuthorKind;
}

// ── 指挥会话持久事件 payload ──────────────────────────────

export interface EnsembleCreatedPayload {
  title: string;
}

export interface EnsembleMemberAddedPayload {
  name: string;
  childSessionId: string;
  charter: EnsembleCharter;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: EnsembleWorktreeRef | undefined;
}

export interface EnsemblePostedPayload {
  number: number;
  from: string;
  fromKind: EnsembleAuthorKind;
  text: string;
  mentions: string[];
  recipients: string[];
  charterOf?: string | undefined;
}

export interface EnsembleMemberModelChangedPayload {
  name: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
}

export interface EnsembleMemberRemovedPayload {
  name: string;
  reason?: string | undefined;
}

export interface EnsembleEndedPayload {
  reason: EnsembleEndReason;
  summary?: string | undefined;
  unmerged?: EnsembleUnmergedWorktree[] | undefined;
}

// ── 合奏概览（ADR-0131）────────────────────────────────────

/** 合奏概览任务状态；显示顺序固定 待办→进行中→等待→完成 */
export type EnsembleTaskStatus = "todo" | "work" | "wait" | "done";

/**
 * 概览中的负责人引用本场身份（ADR-0131 §2）：
 * "maestro" 表示指挥本人，其余为成员名；已移除成员的名字继续保留在历史负责人上。
 */
export type EnsembleOwnerRef = string;

/** 工作线当前进展（可选）；`wait` 为 true 时界面以阻塞样式显示 */
export interface EnsembleLineProgress {
  text: string;
  /** 进展来源帖号（可选，1 起） */
  post?: number | undefined;
  /** 阻塞/等待标记 */
  wait?: boolean | undefined;
}

/** 概览任务：稳定 ID 持久，标题、状态、负责人与来源可更新 */
export interface EnsembleTask {
  id: string;
  title: string;
  status: EnsembleTaskStatus;
  owner: EnsembleOwnerRef;
  /** 来源帖号（可选，1 起） */
  post?: number | undefined;
}

/** 有序工作线；任务在线内按创建顺序排列 */
export interface EnsembleLine {
  id: string;
  title: string;
  owner: EnsembleOwnerRef;
  /** 工作线来源帖号（可选，1 起） */
  post?: number | undefined;
  progress?: EnsembleLineProgress | undefined;
  tasks: EnsembleTask[];
}

/**
 * 合奏概览（ADR-0131 §2）。指挥显式维护；`revision` 随每次接受的更新递增（首次为 1）。
 * 从未写入概览时整个字段缺省——这也是旧合奏的降级入口。
 */
export interface EnsembleOverview {
  revision: number;
  goal?: string | undefined;
  checkpoints: string[];
  lines: EnsembleLine[];
}

export interface EnsembleOverviewLineDelta {
  id: string;
  title?: string | undefined;
  owner?: string | undefined;
  /** null 表示清除来源帖引用 */
  post?: number | null | undefined;
  /** null 表示清除进展 */
  progress?: EnsembleLineProgress | null | undefined;
  /** 移动/插入到该线之前；省略时新线排到末尾、既有线保持原位 */
  before?: string | undefined;
}

export interface EnsembleOverviewTaskDelta {
  id: string;
  line: string;
  title?: string | undefined;
  status?: EnsembleTaskStatus | undefined;
  owner?: string | undefined;
  /** null 表示清除来源帖引用 */
  post?: number | null | undefined;
}

/**
 * `ensemble.overview_updated` 持久事件 payload（ADR-0131 §4）：
 * 规范化后的概览增量。应用顺序固定为「先移除线（级联删除其任务）→ 移除任务 →
 * 线 upsert（按数组顺序，`before` 立即生效）→ 任务 upsert」；校验已在写入前完成。
 */
export interface EnsembleOverviewUpdatedPayload {
  /** 本次接受后的 revision；首次写入为 1 */
  revision: number;
  /** 规范化输入的 sha256（幂等重试识别，跨重启可用） */
  fingerprint: string;
  /** 完整替换目标；null 表示清除 */
  goal?: string | null | undefined;
  /** 完整替换检查点列表（元素已 trim 且非空） */
  checkpoints?: string[] | undefined;
  lines?: EnsembleOverviewLineDelta[] | undefined;
  tasks?: EnsembleOverviewTaskDelta[] | undefined;
  removeLines?: string[] | undefined;
  removeTasks?: string[] | undefined;
}

/** 应用一条规范化概览增量（纯函数；reducer 与控制器共用，调用方负责先校验） */
export function applyOverviewDelta(
  overview: EnsembleOverview | undefined,
  delta: EnsembleOverviewUpdatedPayload,
): EnsembleOverview {
  const next: EnsembleOverview = {
    revision: delta.revision,
    ...(overview?.goal !== undefined ? { goal: overview.goal } : {}),
    checkpoints: overview !== undefined ? [...overview.checkpoints] : [],
    lines:
      overview !== undefined
        ? overview.lines.map((line) => ({
            ...line,
            ...(line.progress !== undefined ? { progress: { ...line.progress } } : {}),
            tasks: line.tasks.map((task) => ({ ...task })),
          }))
        : [],
  };
  if (delta.goal !== undefined) {
    if (delta.goal === null) delete next.goal;
    else next.goal = delta.goal;
  }
  if (delta.checkpoints !== undefined) next.checkpoints = [...delta.checkpoints];
  const removeLines = new Set(delta.removeLines ?? []);
  if (removeLines.size > 0) next.lines = next.lines.filter((line) => !removeLines.has(line.id));
  const removeTasks = new Set(delta.removeTasks ?? []);
  if (removeTasks.size > 0) {
    for (const line of next.lines) {
      line.tasks = line.tasks.filter((task) => !removeTasks.has(task.id));
    }
  }
  for (const update of delta.lines ?? []) {
    let line = next.lines.find((item) => item.id === update.id);
    if (line === undefined) {
      line = {
        id: update.id,
        title: update.title ?? "",
        owner: update.owner ?? "",
        tasks: [],
        ...(update.post !== undefined && update.post !== null ? { post: update.post } : {}),
        ...(update.progress !== undefined && update.progress !== null
          ? { progress: { ...update.progress } }
          : {}),
      };
      const at =
        update.before !== undefined
          ? next.lines.findIndex((item) => item.id === update.before)
          : -1;
      next.lines.splice(at < 0 ? next.lines.length : at, 0, line);
      continue;
    }
    if (update.title !== undefined) line.title = update.title;
    if (update.owner !== undefined) line.owner = update.owner;
    if (update.post !== undefined) {
      if (update.post === null) delete line.post;
      else line.post = update.post;
    }
    if (update.progress !== undefined) {
      if (update.progress === null) delete line.progress;
      else line.progress = { ...update.progress };
    }
    if (update.before !== undefined) {
      const from = next.lines.indexOf(line);
      if (from >= 0) next.lines.splice(from, 1);
      const at = next.lines.findIndex((item) => item.id === update.before);
      next.lines.splice(at < 0 ? next.lines.length : at, 0, line);
    }
  }
  for (const update of delta.tasks ?? []) {
    const line = next.lines.find((item) => item.id === update.line);
    if (line === undefined) continue;
    let task = next.lines
      .flatMap((item) => item.tasks)
      .find((item) => item.id === update.id);
    if (task !== undefined) {
      const origin = next.lines.find((item) => item.tasks.some((t) => t.id === update.id));
      if (origin !== undefined && origin !== line) {
        origin.tasks = origin.tasks.filter((item) => item.id !== update.id);
        line.tasks.push(task);
      }
    } else {
      task = {
        id: update.id,
        title: update.title ?? "",
        status: update.status ?? "todo",
        owner: update.owner ?? "",
        ...(update.post !== undefined && update.post !== null ? { post: update.post } : {}),
      };
      line.tasks.push(task);
    }
    if (update.title !== undefined) task.title = update.title;
    if (update.status !== undefined) task.status = update.status;
    if (update.owner !== undefined) task.owner = update.owner;
    if (update.post !== undefined) {
      if (update.post === null) delete task.post;
      else task.post = update.post;
    }
  }
  return next;
}

// ── 指挥会话临时事件 payload ──────────────────────────────

export interface EnsembleMemberPermission {
  requestId: string;
  callId: string;
  reason: string;
  subjects: PermissionSubject[];
  options: PermissionOption[];
}

/** 成员当前工具行摘要：工具名与可选的主要参数（命令首行、路径、标题等） */
export interface EnsembleToolActivity {
  tool: string;
  detail?: string | undefined;
}

/**
 * 最近活动摘要（结构化，客户端自行组成文字；协议层不产出给人看的句子）：
 * - `tool`：正在执行的工具
 * - `permission`：等待用户确认，`target` 为首个确认对象（或原因）
 * - `paused`：上一轮以错误结束
 * - `post`：最近一条帖子首行
 * - `charter`：任务书「负责」段首行（尚未发帖时）
 * - `removed`：已移除，`reason` 为移除原因
 */
export type EnsembleActivity =
  | { kind: "tool"; tool: string; detail?: string | undefined }
  | { kind: "permission"; target?: string | undefined }
  | { kind: "paused"; code: string; message: string }
  | { kind: "post"; number: number; line: string }
  | { kind: "charter"; line: string }
  | { kind: "removed"; reason?: string | undefined };

export interface EnsembleMemberUpdatedPayload {
  name: string;
  status: "working" | "waiting" | "paused";
  toolActivity?: EnsembleToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions?: EnsembleMemberPermission[] | undefined;
}

// ── 共享派生视图（SessionView.ensemble，view.md §4） ────────────

export interface EnsembleMaestroView {
  model: ModelRef | undefined;
  status: "working" | "waiting";
  lastPostNumber?: number | undefined;
  activity?: EnsembleActivity | undefined;
  awaitingPermission: boolean;
}

export interface EnsembleMemberView {
  name: string;
  childSessionId: string;
  charter: EnsembleCharter;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: EnsembleWorktreeRef | undefined;
  status: EnsembleMemberStatus;
  lastPostNumber?: number | undefined;
  /** 最近在做什么：工具行摘要、等待确认、暂停原因、最近帖子首行或任务书首行 */
  activity?: EnsembleActivity | undefined;
  /** 最近一条由该成员发出的帖子首行（工作结束回到 waiting 时回退显示） */
  lastPostLine?: string | undefined;
  toolActivity?: EnsembleToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions: EnsembleMemberPermission[];
}

export interface EnsemblePostView {
  seq: number;
  time: string;
  number: number;
  from: string;
  fromKind: EnsembleAuthorKind;
  text: string;
  mentions: string[];
  recipients: string[];
  charterOf?: string | undefined;
}

export interface EnsembleView {
  createdSeq: number;
  /** `ensemble.ended` 事件自身的 seq；活动期间为 undefined，新 `ensemble.created` 时重置 */
  endedSeq?: number | undefined;
  title: string;
  status: "active" | "ended";
  endedReason?: EnsembleEndReason | undefined;
  summary?: string | undefined;
  unmerged?: EnsembleUnmergedWorktree[] | undefined;
  maestro: EnsembleMaestroView;
  members: EnsembleMemberView[];
  /** 当前在等待用户确认权限的成员名列表（ADR-0089 §8） */
  awaitingPermissionMembers: string[];
  posts: EnsemblePostView[];
  /** 指挥维护的概览（ADR-0131）；从未写入时缺省，旧合奏客户端据此降级显示 */
  overview?: EnsembleOverview | undefined;
}

// ── 名字校验与提及解析 ──────────────────────────────────────

export const ENSEMBLE_RESERVED_NAMES = ["maestro", "指挥", "all", "user", "runtime"] as const;

const RESERVED_SET: ReadonlySet<string> = new Set(ENSEMBLE_RESERVED_NAMES);
const MEMBER_NAME_RE = /^[a-z0-9-]+$/;

export function isEnsembleReservedName(name: string): boolean {
  return RESERVED_SET.has(name) || RESERVED_SET.has(name.toLowerCase());
}

export function validateEnsembleMemberName(
  name: string,
  existingNames: Iterable<string>,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed !== name) {
    return "Member name must be non-empty without leading or trailing spaces.";
  }
  if (isEnsembleReservedName(name)) {
    return `Member name "${name}" is reserved (${ENSEMBLE_RESERVED_NAMES.join(", ")}).`;
  }
  if (!MEMBER_NAME_RE.test(name)) {
    return `Member name "${name}" is invalid; use only lowercase letters, digits, and hyphens ([a-z0-9-]).`;
  }
  for (const existing of existingNames) {
    if (existing === name) {
      return `Member "${name}" already exists in this ensemble.`;
    }
  }
  return undefined;
}

export function validateEnsembleCharter(
  charter: Partial<EnsembleCharter> | undefined | null,
): { ok: true; charter: EnsembleCharter } | { ok: false; error: string } {
  if (!charter || typeof charter !== "object") {
    return {
      ok: false,
      error: "Charter is required with non-empty owns, handsOff, and doneWhen sections.",
    };
  }
  const owns = typeof charter.owns === "string" ? charter.owns.trim() : "";
  const handsOff = typeof charter.handsOff === "string" ? charter.handsOff.trim() : "";
  const doneWhen = typeof charter.doneWhen === "string" ? charter.doneWhen.trim() : "";
  const missing: string[] = [];
  if (owns === "") missing.push("owns");
  if (handsOff === "") missing.push("handsOff");
  if (doneWhen === "") missing.push("doneWhen");
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Charter is missing required section(s): ${missing.join(", ")}. All three (owns, handsOff, doneWhen) must be non-empty.`,
    };
  }
  return { ok: true, charter: { owns, handsOff, doneWhen } };
}

export function formatCharterPostText(name: string, charter: EnsembleCharter): string {
  return [
    `Charter for @${name}:`,
    `- Owns: ${charter.owns}`,
    `- Hands off: ${charter.handsOff}`,
    `- Done when: ${charter.doneWhen}`,
  ].join("\n");
}

function stripMarkdownCode(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, " ").replace(/`[^`\r\n]*`/gu, " ");
}

const MENTION_TOKEN_RE = /(?<![A-Za-z0-9_./-])@(指挥|[a-z0-9-]+)(?![A-Za-z0-9_./-])/gu;

/** 提取正文中代码块之外的所有 `@token`（保留出现顺序、去重） */
export function extractEnsembleMentionTokens(text: string): string[] {
  const cleaned = stripMarkdownCode(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of cleaned.matchAll(MENTION_TOKEN_RE)) {
    const token = match[1];
    if (token !== undefined && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export interface EnsembleMentionMemberRef {
  name: string;
  removed: boolean;
}

export type ResolveEnsembleMentionsResult =
  | {
      ok: true;
      mentions: string[];
      recipients: string[];
    }
  | {
      ok: false;
      removedMember: string;
      error: string;
    };

function resolveEnsembleMentionsCore(options: {
  text: string;
  author: string;
  authorKind: EnsembleAuthorKind;
  members: readonly EnsembleMentionMemberRef[];
  defaultToMaestro?: boolean | undefined;
}):
  | {
      ok: true;
      mentions: string[];
      recipients: string[];
      targets: string[];
    }
  | {
      ok: false;
      removedMember: string;
      error: string;
    } {
  const tokens = extractEnsembleMentionTokens(options.text);
  const selfTarget = options.authorKind === "maestro" ? "maestro" : options.author;
  const mentions: string[] = [];
  const recipientSet = new Set<string>();
  const targetSet = new Set<string>();

  const addMention = (label: string) => {
    if (!mentions.includes(label)) mentions.push(label);
  };
  const addTarget = (target: string) => {
    targetSet.add(target);
    if (target !== selfTarget) recipientSet.add(target);
  };

  for (const token of tokens) {
    if (token === "maestro" || token === "指挥") {
      addMention("maestro");
      addTarget("maestro");
      continue;
    }
    if (token === "all") {
      addMention("all");
      addTarget("maestro");
      for (const m of options.members) {
        if (!m.removed) addTarget(m.name);
      }
      continue;
    }
    const exact = options.members.find((m) => m.name === token);
    if (exact !== undefined) {
      if (exact.removed) {
        return {
          ok: false,
          removedMember: exact.name,
          error: `Member "${exact.name}" has been removed and cannot be woken.`,
        };
      }
      addMention(exact.name);
      addTarget(exact.name);
      continue;
    }
    const groupRe = new RegExp(`^${escapeRegExp(token)}-\\d+$`, "u");
    const groupMatches = options.members.filter((m) => groupRe.test(m.name));
    if (groupMatches.length > 0) {
      const activeGroup = groupMatches.filter((m) => !m.removed);
      if (activeGroup.length === 0) {
        const firstRemoved = groupMatches[0]?.name ?? token;
        return {
          ok: false,
          removedMember: firstRemoved,
          error: `All members in group "@${token}" have been removed and cannot be woken.`,
        };
      }
      addMention(token);
      for (const m of activeGroup) addTarget(m.name);
    }
  }

  if (mentions.length === 0 && options.defaultToMaestro === true) {
    addMention("maestro");
    addTarget("maestro");
  }

  return {
    ok: true,
    mentions,
    recipients: [...recipientSet],
    targets: [...targetSet],
  };
}

/**
 * 将正文中提取的 `@token` 解析为展示用 `mentions` 与展开后的实际接收者 `recipients`：
 * - `@maestro` / `@指挥` → `"maestro"`
 * - `@all` → 除作者自身外的全体在场成员 + `"maestro"`
 * - `@<name>` → 对应成员（若已移除则报错拒绝唤醒）
 * - `@<prefix>` → 展开为 `<prefix>-<digits>` 全部未移除成员（若仅有已移除成员则按已移除报错）
 * - 其他未知 token（如正文偶现装饰器名）忽略，不计入有效提及
 */
export function resolveEnsembleMentions(options: {
  text: string;
  author: string;
  authorKind: EnsembleAuthorKind;
  members: readonly EnsembleMentionMemberRef[];
  defaultToMaestro?: boolean | undefined;
}): ResolveEnsembleMentionsResult {
  const res = resolveEnsembleMentionsCore(options);
  if (!res.ok) return res;
  return {
    ok: true,
    mentions: res.mentions,
    recipients: res.recipients,
  };
}

/**
 * 解析帖子在发帖当时命中的全部目标成员（与 `resolveEnsembleMentions` 同源，但保留被 `recipients`
 * 排除的作者自身——例如组成员向自己所属组发 `@组名` 帖时，查询 `mention: <作者>` 仍应命中）。
 */
export function resolveEnsembleMentionTargets(options: {
  text: string;
  author: string;
  authorKind: EnsembleAuthorKind;
  members: readonly EnsembleMentionMemberRef[];
  defaultToMaestro?: boolean | undefined;
}): string[] {
  const res = resolveEnsembleMentionsCore(options);
  return res.ok ? res.targets : [];
}

// ── `<ensemble-post>` 包裹与解包（ADR-0089 §7） ────────────────

export function formatEnsemblePostForModel(input: {
  number: number;
  from: string;
  text: string;
  checkedOut?: { member: string; commit: string } | undefined;
}): string {
  const safeFrom = input.from.replace(/"/gu, "");
  const note = input.checkedOut
    ? `\n\n[Worktree] Your worktree was cleaned and checked out at detached HEAD ${input.checkedOut.commit.slice(0, 12)} from @${input.checkedOut.member}.`
    : "";
  return `<ensemble-post n="${input.number}" from="${safeFrom}">\n${input.text}${note}\n</ensemble-post>`;
}

export function unwrapEnsemblePostText(text: string): string {
  return text
    .replace(/^<ensemble-post[^>]*>\r?\n?/u, "")
    .replace(/\r?\n?<\/ensemble-post>$/u, "")
    .replace(
      /\r?\n\r?\n\[Worktree\] Your worktree was cleaned and checked out at detached HEAD [0-9a-f]+ from @[a-z0-9-]+\.$/u,
      "",
    );
}

// ── 活动摘要与视图归约 ──────────────────────────────────────

export function firstNonEmptyLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line !== "") return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }
  return undefined;
}

export function summarizeEnsembleToolCall(name: string, input: unknown): EnsembleToolActivity {
  const rec =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const command = typeof rec?.command === "string" ? firstNonEmptyLine(rec.command) : undefined;
  if (command !== undefined) return { tool: name, detail: command };
  const path =
    typeof rec?.path === "string"
      ? rec.path
      : typeof rec?.pattern === "string"
        ? rec.pattern
        : typeof rec?.title === "string"
          ? rec.title
          : typeof rec?.name === "string"
            ? rec.name
            : typeof rec?.member === "string"
              ? `@${rec.member}`
              : undefined;
  if (path !== undefined && path !== "") {
    return { tool: name, detail: path.length > 80 ? `${path.slice(0, 77)}…` : path };
  }
  return { tool: name };
}

function computeMemberActivity(member: EnsembleMemberView): EnsembleActivity | undefined {
  if (member.status === "removed") return member.activity;
  const firstPerm = member.pendingPermissions[0];
  if (firstPerm !== undefined) {
    const target = firstPerm.subjects[0]?.target ?? firstPerm.reason;
    return target ? { kind: "permission", target } : { kind: "permission" };
  }
  if (member.status === "paused") {
    const err = member.pauseError ?? { code: "unknown", message: "" };
    return { kind: "paused", code: err.code, message: err.message };
  }
  if (member.status === "working" && member.toolActivity !== undefined) {
    return { kind: "tool", ...member.toolActivity };
  }
  if (member.lastPostLine !== undefined && member.lastPostNumber !== undefined) {
    return { kind: "post", number: member.lastPostNumber, line: member.lastPostLine };
  }
  return charterActivity(member.charter);
}

function charterActivity(charter: EnsembleCharter): EnsembleActivity | undefined {
  const line = firstNonEmptyLine(charter.owns);
  return line !== undefined ? { kind: "charter", line } : undefined;
}

function recomputeAwaitingPermissionMembers(ensemble: EnsembleView): void {
  ensemble.awaitingPermissionMembers = ensemble.members
    .filter((m) => m.status !== "removed" && m.pendingPermissions.length > 0)
    .map((m) => m.name);
}

/**
 * 按单条持久事件推进 `EnsembleView`（纯函数）：
 * - 分叉会话不继承 `seq <= forkSeq` 的 Ensemble（ADR-0089 §7）；
 * - 指挥自身的模型、工作状态、工具摘要与权限等待状态同步反映到 `ensemble.maestro`。
 */
export function reduceEnsembleDurable(
  ensemble: EnsembleView | undefined,
  event: DurableEvent,
  options: {
    forkSeq: number;
    maestroModel: ModelRef | undefined;
  },
): EnsembleView | undefined {
  // 分叉点及之前的 Ensemble 事件不进入新会话
  if (options.forkSeq > 0 && event.seq <= options.forkSeq) {
    return undefined;
  }

  switch (event.type) {
    case "ensemble.created": {
      return {
        createdSeq: event.seq,
        title: event.payload.title,
        status: "active",
        maestro: {
          model: options.maestroModel,
          status: "working",
          awaitingPermission: false,
        },
        members: [],
        awaitingPermissionMembers: [],
        posts: [],
      };
    }
    case "ensemble.member_added": {
      if (ensemble === undefined) return undefined;
      const p = event.payload;
      const existingIdx = ensemble.members.findIndex((m) => m.name === p.name);
      const member: EnsembleMemberView = {
        name: p.name,
        childSessionId: p.childSessionId,
        charter: p.charter,
        model: p.model,
        ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}),
        ...(p.profile !== undefined ? { profile: p.profile } : {}),
        preset: p.preset,
        isolated: p.isolated,
        ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
        status: "waiting",
        activity: charterActivity(p.charter),
        pendingPermissions: [],
      };
      if (existingIdx >= 0) ensemble.members[existingIdx] = member;
      else ensemble.members.push(member);
      return ensemble;
    }
    case "ensemble.posted": {
      if (ensemble === undefined) return undefined;
      const p = event.payload;
      ensemble.posts.push({
        seq: event.seq,
        time: event.time,
        number: p.number,
        from: p.from,
        fromKind: p.fromKind,
        text: p.text,
        mentions: [...p.mentions],
        recipients: [...p.recipients],
        ...(p.charterOf !== undefined ? { charterOf: p.charterOf } : {}),
      });
      const line = firstNonEmptyLine(p.text);
      if (p.fromKind === "maestro" && p.charterOf === undefined) {
        ensemble.maestro.lastPostNumber = p.number;
        if (line !== undefined)
          ensemble.maestro.activity = { kind: "post", number: p.number, line };
      } else if (p.fromKind === "member") {
        const m = ensemble.members.find((item) => item.name === p.from);
        if (m !== undefined) {
          m.lastPostNumber = p.number;
          if (line !== undefined) m.lastPostLine = line;
          m.activity = computeMemberActivity(m);
        }
      }
      return ensemble;
    }
    case "ensemble.member_model_changed": {
      if (ensemble === undefined) return undefined;
      const p = event.payload;
      const m = ensemble.members.find((item) => item.name === p.name);
      if (m !== undefined) {
        m.model = p.model;
        m.reasoningEffort = p.reasoningEffort;
        m.profile = p.profile;
      }
      return ensemble;
    }
    case "ensemble.member_removed": {
      if (ensemble === undefined) return undefined;
      const p = event.payload;
      const m = ensemble.members.find((item) => item.name === p.name);
      if (m !== undefined) {
        m.status = "removed";
        m.toolActivity = undefined;
        m.pauseError = undefined;
        m.pendingPermissions = [];
        m.activity =
          p.reason !== undefined ? { kind: "removed", reason: p.reason } : { kind: "removed" };
        recomputeAwaitingPermissionMembers(ensemble);
      }
      return ensemble;
    }
    case "ensemble.overview_updated": {
      if (ensemble === undefined) return undefined;
      // 已规范化并校验过的增量直接应用；结束后不再接收新事件，快照保持只读（ADR-0131 §5）
      ensemble.overview = applyOverviewDelta(ensemble.overview, event.payload);
      return ensemble;
    }
    case "ensemble.ended": {
      if (ensemble === undefined) return undefined;
      ensemble.status = "ended";
      ensemble.endedSeq = event.seq;
      ensemble.endedReason = event.payload.reason;
      if (event.payload.summary !== undefined) ensemble.summary = event.payload.summary;
      if (event.payload.unmerged !== undefined) ensemble.unmerged = event.payload.unmerged;
      ensemble.maestro.status = "waiting";
      ensemble.maestro.awaitingPermission = false;
      for (const m of ensemble.members) {
        if (m.status !== "removed") {
          m.status = "waiting";
          m.toolActivity = undefined;
          m.pendingPermissions = [];
          m.activity = computeMemberActivity(m);
        }
      }
      ensemble.awaitingPermissionMembers = [];
      return ensemble;
    }
    case "session.config_changed": {
      if (ensemble !== undefined && event.payload.model !== undefined) {
        ensemble.maestro.model = event.payload.model;
      }
      return ensemble;
    }
    case "turn.started": {
      if (ensemble?.status === "active") {
        ensemble.maestro.status = "working";
      }
      return ensemble;
    }
    case "tool.started": {
      if (ensemble?.status === "active") {
        ensemble.maestro.activity = {
          kind: "tool",
          ...summarizeEnsembleToolCall(event.payload.name, event.payload.input),
        };
      }
      return ensemble;
    }
    case "permission.requested": {
      if (ensemble?.status === "active") {
        ensemble.maestro.awaitingPermission = true;
      }
      return ensemble;
    }
    case "permission.resolved": {
      if (ensemble?.status === "active") {
        ensemble.maestro.awaitingPermission = false;
      }
      return ensemble;
    }
    case "turn.completed": {
      if (ensemble !== undefined) {
        ensemble.maestro.status = "waiting";
        ensemble.maestro.awaitingPermission = false;
      }
      return ensemble;
    }
    default:
      return ensemble;
  }
}

export function applyEnsembleMemberUpdated(
  ensemble: EnsembleView | undefined,
  payload: EnsembleMemberUpdatedPayload,
): void {
  if (ensemble?.status !== "active") return;
  const member = ensemble.members.find((m) => m.name === payload.name);
  if (member === undefined || member.status === "removed") return;
  member.status = payload.status;
  member.toolActivity = payload.toolActivity;
  member.pauseError = payload.status === "paused" ? payload.pauseError : undefined;
  member.pendingPermissions = payload.pendingPermissions ? [...payload.pendingPermissions] : [];
  member.activity = computeMemberActivity(member);
  recomputeAwaitingPermissionMembers(ensemble);
}
