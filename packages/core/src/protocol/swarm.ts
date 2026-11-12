/**
 * Swarm 协议契约、提及解析、`<swarm-post>` 编解码与派生视图纯函数（ADR-0089）。
 * 纯类型与纯函数，无 I/O、无 Node 内置依赖。
 */
import type { DurableEvent, SubagentChanges } from "./events.js";
import type { ModelRef, PermissionOption, PermissionSubject, ReasoningEffort } from "./types.js";

export type SwarmAuthorKind = "coordinator" | "member" | "user" | "runtime";

export type SwarmMemberStatus = "working" | "waiting" | "paused" | "removed";

export type SwarmEndReason = "coordinator" | "user" | "rewound";

export interface SwarmCharter {
  owns: string;
  handsOff: string;
  doneWhen: string;
}

export interface SwarmWorktreeRef {
  path: string;
  branch: string;
  base: string;
}

export interface SwarmUnmergedWorktree {
  name: string;
  childSessionId: string;
  branch: string;
  base: string;
  head: string;
  worktree: string;
  files: SubagentChanges["files"];
}

/** 投递给成员或协调者的 `message.user.swarm` 扩展标记（ADR-0089 §7） */
export interface SwarmPostDelivery {
  postNumber: number;
  from: string;
  fromKind: SwarmAuthorKind;
}

// ── 协调者会话持久事件 payload ──────────────────────────────

export interface SwarmCreatedPayload {
  title: string;
}

export interface SwarmMemberAddedPayload {
  name: string;
  childSessionId: string;
  charter: SwarmCharter;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: SwarmWorktreeRef | undefined;
}

export interface SwarmPostedPayload {
  number: number;
  from: string;
  fromKind: SwarmAuthorKind;
  text: string;
  mentions: string[];
  recipients: string[];
  charterOf?: string | undefined;
}

export interface SwarmMemberModelChangedPayload {
  name: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
}

export interface SwarmMemberRemovedPayload {
  name: string;
  reason?: string | undefined;
}

export interface SwarmEndedPayload {
  reason: SwarmEndReason;
  summary?: string | undefined;
  unmerged?: SwarmUnmergedWorktree[] | undefined;
}

// ── 协调者会话临时事件 payload ──────────────────────────────

export interface SwarmMemberPermission {
  requestId: string;
  callId: string;
  reason: string;
  subjects: PermissionSubject[];
  options: PermissionOption[];
}

/** 成员当前工具行摘要：工具名与可选的主要参数（命令首行、路径、标题等） */
export interface SwarmToolActivity {
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
export type SwarmActivity =
  | { kind: "tool"; tool: string; detail?: string | undefined }
  | { kind: "permission"; target?: string | undefined }
  | { kind: "paused"; code: string; message: string }
  | { kind: "post"; number: number; line: string }
  | { kind: "charter"; line: string }
  | { kind: "removed"; reason?: string | undefined };

export interface SwarmMemberUpdatedPayload {
  name: string;
  status: "working" | "waiting" | "paused";
  toolActivity?: SwarmToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions?: SwarmMemberPermission[] | undefined;
}

// ── 共享派生视图（SessionView.swarm，view.md §4） ────────────

export interface SwarmCoordinatorView {
  model: ModelRef | undefined;
  status: "working" | "waiting";
  lastPostNumber?: number | undefined;
  activity?: SwarmActivity | undefined;
  awaitingPermission: boolean;
}

export interface SwarmMemberView {
  name: string;
  childSessionId: string;
  charter: SwarmCharter;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktree?: SwarmWorktreeRef | undefined;
  status: SwarmMemberStatus;
  lastPostNumber?: number | undefined;
  /** 最近在做什么：工具行摘要、等待确认、暂停原因、最近帖子首行或任务书首行 */
  activity?: SwarmActivity | undefined;
  /** 最近一条由该成员发出的帖子首行（工作结束回到 waiting 时回退显示） */
  lastPostLine?: string | undefined;
  toolActivity?: SwarmToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions: SwarmMemberPermission[];
}

export interface SwarmPostView {
  seq: number;
  time: string;
  number: number;
  from: string;
  fromKind: SwarmAuthorKind;
  text: string;
  mentions: string[];
  recipients: string[];
  charterOf?: string | undefined;
}

export interface SwarmView {
  createdSeq: number;
  title: string;
  status: "active" | "ended";
  endedReason?: SwarmEndReason | undefined;
  summary?: string | undefined;
  unmerged?: SwarmUnmergedWorktree[] | undefined;
  coordinator: SwarmCoordinatorView;
  members: SwarmMemberView[];
  /** 当前在等待用户确认权限的成员名列表（ADR-0089 §8） */
  awaitingPermissionMembers: string[];
  posts: SwarmPostView[];
}

// ── 名字校验与提及解析 ──────────────────────────────────────

export const SWARM_RESERVED_NAMES = ["coordinator", "协调者", "all", "user", "runtime"] as const;

const RESERVED_SET: ReadonlySet<string> = new Set(SWARM_RESERVED_NAMES);
const MEMBER_NAME_RE = /^[a-z0-9-]+$/;

export function isSwarmReservedName(name: string): boolean {
  return RESERVED_SET.has(name) || RESERVED_SET.has(name.toLowerCase());
}

export function validateSwarmMemberName(
  name: string,
  existingNames: Iterable<string>,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed !== name) {
    return "Member name must be non-empty without leading or trailing spaces.";
  }
  if (isSwarmReservedName(name)) {
    return `Member name "${name}" is reserved (${SWARM_RESERVED_NAMES.join(", ")}).`;
  }
  if (!MEMBER_NAME_RE.test(name)) {
    return `Member name "${name}" is invalid; use only lowercase letters, digits, and hyphens ([a-z0-9-]).`;
  }
  for (const existing of existingNames) {
    if (existing === name) {
      return `Member "${name}" already exists in this swarm.`;
    }
  }
  return undefined;
}

export function validateSwarmCharter(
  charter: Partial<SwarmCharter> | undefined | null,
): { ok: true; charter: SwarmCharter } | { ok: false; error: string } {
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

export function formatCharterPostText(name: string, charter: SwarmCharter): string {
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

const MENTION_TOKEN_RE = /(?<![A-Za-z0-9_./-])@(协调者|[a-z0-9-]+)(?![A-Za-z0-9_./-])/gu;

/** 提取正文中代码块之外的所有 `@token`（保留出现顺序、去重） */
export function extractSwarmMentionTokens(text: string): string[] {
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

export interface SwarmMentionMemberRef {
  name: string;
  removed: boolean;
}

export type ResolveSwarmMentionsResult =
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
 * - `@coordinator` / `@协调者` → `"coordinator"`
 * - `@all` → 除作者自身外的全体在场成员 + `"coordinator"`
 * - `@<name>` → 对应成员（若已移除则报错拒绝唤醒）
 * - `@<prefix>` → 展开为 `<prefix>-<digits>` 全部未移除成员（若仅有已移除成员则按已移除报错）
 * - 其他未知 token（如正文偶现装饰器名）忽略，不计入有效提及
 */
export function resolveSwarmMentions(options: {
  text: string;
  author: string;
  authorKind: SwarmAuthorKind;
  members: readonly SwarmMentionMemberRef[];
  defaultToCoordinator?: boolean | undefined;
}): ResolveSwarmMentionsResult {
  const tokens = extractSwarmMentionTokens(options.text);
  const selfTarget = options.authorKind === "coordinator" ? "coordinator" : options.author;
  const mentions: string[] = [];
  const recipientSet = new Set<string>();

  const addMention = (label: string) => {
    if (!mentions.includes(label)) mentions.push(label);
  };
  const addRecipient = (target: string) => {
    if (target !== selfTarget) recipientSet.add(target);
  };

  for (const token of tokens) {
    if (token === "coordinator" || token === "协调者") {
      addMention("coordinator");
      addRecipient("coordinator");
      continue;
    }
    if (token === "all") {
      addMention("all");
      addRecipient("coordinator");
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

  if (mentions.length === 0 && options.defaultToCoordinator === true) {
    addMention("coordinator");
    addRecipient("coordinator");
  }

  return {
    ok: true,
    mentions,
    recipients: [...recipientSet],
  };
}

// ── `<swarm-post>` 包裹与解包（ADR-0089 §7） ────────────────

export function formatSwarmPostForModel(input: {
  number: number;
  from: string;
  text: string;
  checkedOut?: { member: string; commit: string } | undefined;
}): string {
  const safeFrom = input.from.replace(/"/gu, "");
  const note = input.checkedOut
    ? `\n\n[Worktree] Your worktree was cleaned and checked out at detached HEAD ${input.checkedOut.commit.slice(0, 12)} from @${input.checkedOut.member}.`
    : "";
  return `<swarm-post n="${input.number}" from="${safeFrom}">\n${input.text}${note}\n</swarm-post>`;
}

export function unwrapSwarmPostText(text: string): string {
  return text
    .replace(/^<swarm-post[^>]*>\r?\n?/u, "")
    .replace(/\r?\n?<\/swarm-post>$/u, "")
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

export function summarizeSwarmToolCall(name: string, input: unknown): SwarmToolActivity {
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

function computeMemberActivity(member: SwarmMemberView): SwarmActivity | undefined {
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

function charterActivity(charter: SwarmCharter): SwarmActivity | undefined {
  const line = firstNonEmptyLine(charter.owns);
  return line !== undefined ? { kind: "charter", line } : undefined;
}

function recomputeAwaitingPermissionMembers(swarm: SwarmView): void {
  swarm.awaitingPermissionMembers = swarm.members
    .filter((m) => m.status !== "removed" && m.pendingPermissions.length > 0)
    .map((m) => m.name);
}

/**
 * 按单条持久事件推进 `SwarmView`（纯函数）：
 * - 分叉会话不继承 `seq <= forkSeq` 的 Swarm（ADR-0089 §7）；
 * - 协调者自身的模型、工作状态、工具摘要与权限等待状态同步反映到 `swarm.coordinator`。
 */
export function reduceSwarmDurable(
  swarm: SwarmView | undefined,
  event: DurableEvent,
  options: {
    forkSeq: number;
    coordinatorModel: ModelRef | undefined;
  },
): SwarmView | undefined {
  // 分叉点及之前的 Swarm 事件不进入新会话
  if (options.forkSeq > 0 && event.seq <= options.forkSeq) {
    return undefined;
  }

  switch (event.type) {
    case "swarm.created": {
      return {
        createdSeq: event.seq,
        title: event.payload.title,
        status: "active",
        coordinator: {
          model: options.coordinatorModel,
          status: "working",
          awaitingPermission: false,
        },
        members: [],
        awaitingPermissionMembers: [],
        posts: [],
      };
    }
    case "swarm.member_added": {
      if (swarm === undefined) return undefined;
      const p = event.payload;
      const existingIdx = swarm.members.findIndex((m) => m.name === p.name);
      const member: SwarmMemberView = {
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
      if (existingIdx >= 0) swarm.members[existingIdx] = member;
      else swarm.members.push(member);
      return swarm;
    }
    case "swarm.posted": {
      if (swarm === undefined) return undefined;
      const p = event.payload;
      swarm.posts.push({
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
      if (p.fromKind === "coordinator" && p.charterOf === undefined) {
        swarm.coordinator.lastPostNumber = p.number;
        if (line !== undefined)
          swarm.coordinator.activity = { kind: "post", number: p.number, line };
      } else if (p.fromKind === "member") {
        const m = swarm.members.find((item) => item.name === p.from);
        if (m !== undefined) {
          m.lastPostNumber = p.number;
          if (line !== undefined) m.lastPostLine = line;
          m.activity = computeMemberActivity(m);
        }
      }
      return swarm;
    }
    case "swarm.member_model_changed": {
      if (swarm === undefined) return undefined;
      const p = event.payload;
      const m = swarm.members.find((item) => item.name === p.name);
      if (m !== undefined) {
        m.model = p.model;
        m.reasoningEffort = p.reasoningEffort;
        m.profile = p.profile;
      }
      return swarm;
    }
    case "swarm.member_removed": {
      if (swarm === undefined) return undefined;
      const p = event.payload;
      const m = swarm.members.find((item) => item.name === p.name);
      if (m !== undefined) {
        m.status = "removed";
        m.toolActivity = undefined;
        m.pauseError = undefined;
        m.pendingPermissions = [];
        m.activity =
          p.reason !== undefined ? { kind: "removed", reason: p.reason } : { kind: "removed" };
        recomputeAwaitingPermissionMembers(swarm);
      }
      return swarm;
    }
    case "swarm.ended": {
      if (swarm === undefined) return undefined;
      swarm.status = "ended";
      swarm.endedReason = event.payload.reason;
      if (event.payload.summary !== undefined) swarm.summary = event.payload.summary;
      if (event.payload.unmerged !== undefined) swarm.unmerged = event.payload.unmerged;
      swarm.coordinator.status = "waiting";
      swarm.coordinator.awaitingPermission = false;
      for (const m of swarm.members) {
        if (m.status !== "removed") {
          m.status = "waiting";
          m.toolActivity = undefined;
          m.pendingPermissions = [];
          m.activity = computeMemberActivity(m);
        }
      }
      swarm.awaitingPermissionMembers = [];
      return swarm;
    }
    case "session.config_changed": {
      if (swarm !== undefined && event.payload.model !== undefined) {
        swarm.coordinator.model = event.payload.model;
      }
      return swarm;
    }
    case "turn.started": {
      if (swarm?.status === "active") {
        swarm.coordinator.status = "working";
      }
      return swarm;
    }
    case "tool.started": {
      if (swarm?.status === "active") {
        swarm.coordinator.activity = {
          kind: "tool",
          ...summarizeSwarmToolCall(event.payload.name, event.payload.input),
        };
      }
      return swarm;
    }
    case "permission.requested": {
      if (swarm?.status === "active") {
        swarm.coordinator.awaitingPermission = true;
      }
      return swarm;
    }
    case "permission.resolved": {
      if (swarm?.status === "active") {
        swarm.coordinator.awaitingPermission = false;
      }
      return swarm;
    }
    case "turn.completed": {
      if (swarm !== undefined) {
        swarm.coordinator.status = "waiting";
        swarm.coordinator.awaitingPermission = false;
      }
      return swarm;
    }
    default:
      return swarm;
  }
}

export function applySwarmMemberUpdated(
  swarm: SwarmView | undefined,
  payload: SwarmMemberUpdatedPayload,
): void {
  if (swarm?.status !== "active") return;
  const member = swarm.members.find((m) => m.name === payload.name);
  if (member === undefined || member.status === "removed") return;
  member.status = payload.status;
  member.toolActivity = payload.toolActivity;
  member.pauseError = payload.status === "paused" ? payload.pauseError : undefined;
  member.pendingPermissions = payload.pendingPermissions ? [...payload.pendingPermissions] : [];
  member.activity = computeMemberActivity(member);
  recomputeAwaitingPermissionMembers(swarm);
}
