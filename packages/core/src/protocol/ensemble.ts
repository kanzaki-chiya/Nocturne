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
  const tokens = extractEnsembleMentionTokens(options.text);
  const selfTarget = options.authorKind === "maestro" ? "maestro" : options.author;
  const mentions: string[] = [];
  const recipientSet = new Set<string>();

  const addMention = (label: string) => {
    if (!mentions.includes(label)) mentions.push(label);
  };
  const addRecipient = (target: string) => {
    if (target !== selfTarget) recipientSet.add(target);
  };

  for (const token of tokens) {
    if (token === "maestro" || token === "指挥") {
      addMention("maestro");
      addRecipient("maestro");
      continue;
    }
    if (token === "all") {
      addMention("all");
      addRecipient("maestro");
      for (const m of options.members) {
        if (!m.removed) addRecipient(m.name);
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
      addRecipient(exact.name);
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
      for (const m of activeGroup) addRecipient(m.name);
    }
  }

  if (mentions.length === 0 && options.defaultToMaestro === true) {
    addMention("maestro");
    addRecipient("maestro");
  }

  return {
    ok: true,
    mentions,
    recipients: [...recipientSet],
  };
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
