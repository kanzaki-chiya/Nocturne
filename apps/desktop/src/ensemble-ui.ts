/**
 * Ensemble 界面的纯逻辑（ADR-0089）：工具行参数、活动摘要组词、状态圆点、作者与提及文案、
 * 留言板筛选与搜索、成员分组、入口行计数，以及正文按 `mentions` 切分高亮。
 * 桌面端与手机网页共用；只依赖 `@nocturne/core/protocol` 与 `./tool-meta`，不依赖 React。
 */
import type {
  AggregatedPendingPermission,
  ModelRef,
  EnsembleActivity,
  EnsembleAuthorKind,
  EnsembleLine,
  EnsembleMemberView,
  EnsembleOverview,
  EnsemblePostView,
  EnsembleTaskStatus,
  EnsembleView,
  ViewEntry,
} from "@nocturne/core/protocol";

import { toolMeta } from "./tool-meta";

/** 状态圆点色调：work 在跑、ask 等确认、pause 暂停、wait 等待、retired 已移除 */
export type EnsembleDotTone = "work" | "ask" | "pause" | "wait" | "retired";

/** Ensemble 标签页与入口行的状态点：活动中 ok，有成员待确认 warn，已结束无点 */
export type EnsembleStatusDot = "ok" | "warn" | undefined;

/** 正文片段：mention 供强调色 + 等宽渲染，text 原样保留 */
export interface EnsembleTextFragment {
  kind: "text" | "mention";
  value: string;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function atToken(value: unknown): string {
  const s = stringOf(value);
  if (s === "") return "";
  return s.startsWith("@") ? s : `@${s}`;
}

/** 留言板查询参数位：`@作者`、`@提及` 原样（不重复 `@`）放在 `primary`，关键词放在淡色 `query`。 */
export function ensembleReadFilterParts(input: unknown): {
  primary: string;
  query: string;
  text: string;
} {
  const rec = recordOf(input);
  const from = atToken(rec.from);
  const mention = atToken(rec.mention);
  const primary = [from, mention].filter(Boolean).join(" ");
  const query = firstEnsembleLine(rec.query);
  const text = [primary, query].filter(Boolean).join(" ");
  return { primary, query, text };
}

/** 取多行文本首个非空行（去掉首尾空白）；为空或非字符串时返回 "" */
export function firstEnsembleLine(value: unknown): string {
  if (typeof value !== "string") return "";
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** 去掉可选 `<provider>/` 前缀的模型名；也支持直接传入 `ModelRef` */
export function shortModelName(model: ModelRef | string | undefined): string {
  if (model === undefined) return "";
  if (typeof model !== "string") return model.model;
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Ensemble 工具行的参数位摘要；非 Ensemble 工具返回 `undefined`，交给通用工具参数逻辑处理。
 */
export function ensembleToolSummary(name: string, input: unknown): string | undefined {
  const rec = recordOf(input);
  switch (name) {
    case "ensemble_init":
      return firstEnsembleLine(rec.title);
    case "ensemble_add_member": {
      const member = stringOf(rec.name);
      return member === "" ? "" : `@${member}`;
    }
    case "ensemble_post":
      return firstEnsembleLine(rec.text);
    case "ensemble_read":
      return ensembleReadFilterParts(input).text;
    case "ensemble_overview": {
      // 指挥概览更新：优先显示目标文本，否则报告行/任务变更数量
      if (typeof rec.goal === "string" && rec.goal.trim() !== "")
        return firstEnsembleLine(rec.goal);
      const lines = Array.isArray(rec.lines) ? rec.lines.length : 0;
      const tasks = Array.isArray(rec.tasks) ? rec.tasks.length : 0;
      const removed =
        (Array.isArray(rec.removeLines) ? rec.removeLines.length : 0) +
        (Array.isArray(rec.removeTasks) ? rec.removeTasks.length : 0);
      if (lines + tasks + removed === 0) return "";
      return "+" + String(lines + tasks) + (removed > 0 ? " -" + String(removed) : "");
    }
    case "ensemble_change_model": {
      const member = stringOf(rec.name) || stringOf(rec.member);
      const target = shortModelName(stringOf(rec.model) || stringOf(rec.profile));
      if (member === "") return target;
      return target === "" ? `@${member}` : `@${member} ${target}`;
    }
    case "ensemble_remove_member": {
      const member = stringOf(rec.name) || stringOf(rec.member);
      return member === "" ? "" : `@${member}`;
    }
    case "ensemble_end":
      return firstEnsembleLine(rec.summary);
    case "ensemble_checkout": {
      const member = stringOf(rec.member) || stringOf(rec.name);
      return member === "" ? "" : `@${member}`;
    }
    default:
      return undefined;
  }
}

/** 暂停错误文案：复用桌面端已有的错误码映射，未命中时取 message 首行 */
export function ensemblePausedErrorText(code: string, message: string): string {
  switch (code) {
    case "session_not_found":
      return "找不到这个子代理的日志，可能已被删除";
    case "subagent_parent_mismatch":
      return "这个子会话不属于当前会话，无法查看";
    default: {
      const line = firstEnsembleLine(message);
      return line !== "" ? line : code;
    }
  }
}

/**
 * 将结构化 `EnsembleActivity` 组装成成员页第二行文字；没有可显示内容（如无原因移除）时返回 `""`。
 */
export function ensembleActivitySummary(activity: EnsembleActivity | undefined): string {
  if (activity === undefined) return "";
  switch (activity.kind) {
    case "tool": {
      const label = toolMeta(activity.tool).label;
      return activity.detail !== undefined && activity.detail !== ""
        ? `${label} ${activity.detail}`
        : label;
    }
    case "permission":
      return activity.target !== undefined && activity.target !== ""
        ? `等待确认：${activity.target}`
        : "等待确认";
    case "paused":
      return ensemblePausedErrorText(activity.code, activity.message);
    case "post":
    case "charter":
      return activity.line;
    case "removed":
      return activity.reason !== undefined ? firstEnsembleLine(activity.reason) : "";
  }
}

/** Ensemble 标签与对话入口行的状态圆点 */
export function ensembleStatusDot(
  ensemble: Pick<EnsembleView, "status" | "awaitingPermissionMembers"> | undefined,
): EnsembleStatusDot {
  if (ensemble === undefined || ensemble.status === "ended") return undefined;
  return ensemble.awaitingPermissionMembers.length > 0 ? "warn" : "ok";
}

/**
 * 找出创建当前 `view.ensemble` 的那一条成功 `ensemble_init` 工具条目的 `key`。
 * Core 在 `ensemble_init` 执行期间落盘 `ensemble.created`（`tool.started.seq < createdSeq < tool.completed.seq`）；
 * 若条目未携带 `completedSeq`（例如合成的测试视图），回退为 `seq <= createdSeq` 且最接近 `createdSeq` 的无 `completedSeq` 成功条目。
 */
export function currentEnsembleInitKey(
  entries: readonly ViewEntry[],
  ensemble: Pick<EnsembleView, "createdSeq"> | undefined,
): string | undefined {
  if (ensemble === undefined) return undefined;
  const createdSeq = ensemble.createdSeq;
  let fallback: { key: string; seq: number } | undefined;
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.status !== "ok") continue;
    const name = entry.target?.name ?? entry.name;
    if (name !== "ensemble_init") continue;
    if (
      entry.completedSeq !== undefined &&
      entry.seq <= createdSeq &&
      createdSeq <= entry.completedSeq
    ) {
      return entry.key;
    }
    if (entry.completedSeq === undefined && entry.seq <= createdSeq) {
      if (fallback === undefined || entry.seq >= fallback.seq) {
        fallback = { key: entry.key, seq: entry.seq };
      }
    }
  }
  return fallback?.key;
}

/**
 * 桌面端指挥会话拆分待确认请求（ADR-0089 修订）：
 * 当合奏处于 `active` 时，过滤掉 `childSessionId` 属于当前合奏未移除成员的转发请求
 * （指挥自身、普通 `task` 子代理与组曲线程的确认卡片保持原顺序），并按加入顺序返回待确认成员列表。
 */
export function partitionEnsemblePermissions<T extends AggregatedPendingPermission>(
  pendingPermissions: readonly T[],
  ensemble: Pick<EnsembleView, "status" | "members"> | undefined,
): {
  cards: T[];
  awaitingMembers: EnsembleMemberView[];
} {
  if (ensemble?.status !== "active") {
    return { cards: [...pendingPermissions], awaitingMembers: [] };
  }
  const activeMemberChildIds = new Set<string>();
  for (const member of ensemble.members) {
    if (member.status !== "removed") {
      activeMemberChildIds.add(member.childSessionId);
    }
  }
  const forwardedChildIds = new Set<string>();
  const cards: T[] = [];
  for (const item of pendingPermissions) {
    if (item.kind === "subagent" && activeMemberChildIds.has(item.permission.childSessionId)) {
      forwardedChildIds.add(item.permission.childSessionId);
      continue;
    }
    cards.push(item);
  }
  const awaitingMembers = ensemble.members.filter(
    (member) =>
      member.status !== "removed" &&
      (member.pendingPermissions.length > 0 || forwardedChildIds.has(member.childSessionId)),
  );
  return { cards, awaitingMembers };
}

/** 指挥行的状态圆点（已结束时统一变成 wait） */
export function ensembleMaestroDot(
  ensemble: Pick<EnsembleView, "status" | "maestro">,
): Exclude<EnsembleDotTone, "retired"> {
  if (ensemble.status === "ended") return "wait";
  if (ensemble.maestro.awaitingPermission) return "ask";
  return ensemble.maestro.status === "working" ? "work" : "wait";
}

/** 成员行的状态圆点（已结束时未移除成员统一变成 wait，已移除保持 retired） */
export function ensembleMemberDot(
  member: Pick<EnsembleMemberView, "status" | "pendingPermissions">,
  ensembleStatus: "active" | "ended" = "active",
): EnsembleDotTone {
  if (member.status === "removed") return "retired";
  if (ensembleStatus === "ended") return "wait";
  if (member.pendingPermissions.length > 0) return "ask";
  if (member.status === "working") return "work";
  if (member.status === "paused") return "pause";
  return "wait";
}

/** 作者显示规则（全文通用）：指挥 / 你 / Runtime / @name */
export function ensembleAuthorLabel(from: string, fromKind: EnsembleAuthorKind): string {
  switch (fromKind) {
    case "maestro":
      return "指挥";
    case "user":
      return "你";
    case "runtime":
      return "Runtime";
    case "member":
      return `@${from}`;
  }
}

/** 帖子头部 `mentions` 单项显示：maestro → 指挥，all → @all，组前缀和成员名 → @x */
export function ensembleMentionLabel(mention: string): string {
  if (mention === "maestro") return "指挥";
  if (mention === "all") return "@all";
  return `@${mention}`;
}

/** 成员头像调色板（按加入顺序轮流取用，与指挥/用户/Runtime 错开） */
export const ENSEMBLE_AUTHOR_PALETTE = [
  "var(--a-cat1)",
  "var(--a-cat2)",
  "var(--a-cat3)",
  "var(--a-cat4)",
  "var(--a-cat5)",
] as const;

/**
 * 作者头像颜色：成员按在 `members`（加入顺序，含已移除成员）中的位置轮流取
 * `--a-cat1`..`--a-cat5`，同一名成员颜色固定；指挥、用户、Runtime 返回 `undefined`（不上色）。
 */
export function ensembleAuthorColor(
  members: readonly Pick<EnsembleMemberView, "name">[],
  author: string,
  fromKind: EnsembleAuthorKind = "member",
): string | undefined {
  if (fromKind !== "member") return undefined;
  const index = members.findIndex((member) => member.name === author);
  if (index < 0) return undefined;
  return ENSEMBLE_AUTHOR_PALETTE[index % ENSEMBLE_AUTHOR_PALETTE.length];
}

/** 成员的模型或档位显示（优先档位名，否则去前缀后的模型名） */
export function ensembleMemberMetaLabel(
  member: Pick<EnsembleMemberView, "model" | "profile">,
): string {
  const profile = member.profile?.trim();
  return profile !== undefined && profile !== "" ? profile : shortModelName(member.model);
}

/**
 * 帖子头显示的收件人列表：从 `mentions` 中去掉作者自身
 * （成员作者去掉 `post.from`，指挥作者去掉 `"maestro"`）；
 * 任务书帖将 `charterOf` 合并在首位（与已有项及作者自身去重）。
 */
export function ensemblePostRecipients(
  post: Pick<EnsemblePostView, "from" | "fromKind" | "mentions" | "charterOf">,
): string[] {
  const self = post.fromKind === "maestro" ? "maestro" : post.from;
  const list = post.mentions.filter((mention) => mention !== self);
  const charterOf = post.charterOf?.trim();
  if (
    charterOf !== undefined &&
    charterOf !== "" &&
    charterOf !== self &&
    !list.includes(charterOf)
  ) {
    return [charterOf, ...list];
  }
  return list;
}

export interface EnsembleBoardPost {
  number: number;
  from: string;
  fromKind: EnsembleAuthorKind;
  text: string;
  mentions: string[];
}

/** 帖子标题 `#n 作者 → 提及`（没有提及时省去箭头） */
export function ensemblePostHead(
  post: Pick<EnsemblePostView, "number" | "from" | "fromKind" | "mentions" | "charterOf">,
): string {
  const mentions = ensemblePostRecipients(post).map(ensembleMentionLabel).join(" ");
  const author = ensembleAuthorLabel(post.from, post.fromKind);
  return mentions === "" ? `#${post.number} ${author}` : `#${post.number} ${author} → ${mentions}`;
}

function isAuthorKind(value: unknown): value is EnsembleAuthorKind {
  return value === "maestro" || value === "member" || value === "user" || value === "runtime";
}

/** 从 `ensemble_read` 的 `output` 提取命中的帖子列表。 */
export function ensembleReadPostsFromOutput(output: unknown): EnsembleBoardPost[] | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const raw = (output as { posts?: unknown }).posts;
  if (!Array.isArray(raw)) return undefined;
  const posts: EnsembleBoardPost[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.number !== "number" ||
      typeof rec.from !== "string" ||
      typeof rec.text !== "string"
    ) {
      continue;
    }
    const fromKind: EnsembleAuthorKind = isAuthorKind(rec.fromKind) ? rec.fromKind : "member";
    const mentions = Array.isArray(rec.mentions)
      ? rec.mentions.filter((mention): mention is string => typeof mention === "string")
      : [];
    posts.push({ number: rec.number, from: rec.from, fromKind, text: rec.text, mentions });
  }
  return posts;
}

export interface EnsembleMentionToken {
  start: number;
  end: number;
  query: string;
}

export interface EnsembleMentionCandidate {
  kind: "maestro" | "member" | "group" | "all";
  /** 填入 `@<insert> ` 的名字 */
  insert: string;
  /** 列表主显示文字 */
  label: string;
  /** 淡色后缀（模型或档位） */
  meta?: string | undefined;
  /** 成员头像颜色 token */
  color?: string | undefined;
}

/**
 * 识别发帖框光标前的 `@` 补全词：光标前是 `@` 加零个或多个名字字符时返回起止位置与已输前缀，
 * 若 `@` 紧跟在英文/数字/路径字符后（如邮箱）则返回 `null`。
 */
export function ensembleMentionToken(value: string, cursor: number): EnsembleMentionToken | null {
  const clamped = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, clamped);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_./-]/.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9\u4e00-\u9fa5-]*$/u.test(query)) return null;
  return { start: at, end: clamped, query };
}

/**
 * 生成 `@` 补全候选（依次：指挥、未移除成员、同前缀组、`all`），按输入前缀不区分大小写过滤。
 */
export function ensembleMentionCandidates(
  ensemble: Pick<EnsembleView, "maestro" | "members">,
  query: string,
): EnsembleMentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const out: EnsembleMentionCandidate[] = [];

  const coordModel = shortModelName(ensemble.maestro.model);
  if (needle === "" || "maestro".startsWith(needle) || "指挥".startsWith(needle)) {
    out.push({
      kind: "maestro",
      insert: "maestro",
      label: "指挥",
      ...(coordModel !== "" ? { meta: coordModel } : {}),
    });
  }

  const activeMembers = ensemble.members.filter((member) => member.status !== "removed");
  const activeNames = new Set(activeMembers.map((member) => member.name));
  const groupCounts = new Map<string, number>();

  for (const member of activeMembers) {
    const match = /^(.+)-(\d+)$/.exec(member.name);
    if (match !== null) {
      const prefix = match[1] ?? "";
      if (prefix !== "") groupCounts.set(prefix, (groupCounts.get(prefix) ?? 0) + 1);
    }
    if (needle === "" || member.name.toLowerCase().startsWith(needle)) {
      const meta = ensembleMemberMetaLabel(member);
      const color = ensembleAuthorColor(ensemble.members, member.name, "member");
      out.push({
        kind: "member",
        insert: member.name,
        label: member.name,
        ...(meta !== "" ? { meta } : {}),
        ...(color !== undefined ? { color } : {}),
      });
    }
  }

  for (const [prefix, count] of groupCounts) {
    if (count < 2 || activeNames.has(prefix)) continue;
    if (needle === "" || prefix.toLowerCase().startsWith(needle)) {
      out.push({
        kind: "group",
        insert: prefix,
        label: `@${prefix}`,
      });
    }
  }

  if (needle === "" || "all".startsWith(needle)) {
    out.push({
      kind: "all",
      insert: "all",
      label: "all",
    });
  }

  return out;
}

/** 成员页分组：工作中（working）、已暂停（paused）、等待（waiting）、已移除（removed） */
export function groupEnsembleMembers<T extends Pick<EnsembleMemberView, "status">>(
  members: readonly T[],
): {
  working: T[];
  paused: T[];
  waiting: T[];
  removed: T[];
} {
  const working: T[] = [];
  const paused: T[] = [];
  const waiting: T[] = [];
  const removed: T[] = [];
  for (const member of members) {
    switch (member.status) {
      case "working":
        working.push(member);
        break;
      case "paused":
        paused.push(member);
        break;
      case "waiting":
        waiting.push(member);
        break;
      case "removed":
        removed.push(member);
        break;
    }
  }
  return { working, paused, waiting, removed };
}

/** 本地时间 `HH:MM` */
export function formatEnsembleTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// ── 合奏概览（ADR-0131）────────────────────────────────────

/** 概览负责人显示：maestro → 指挥，成员 → @name */
export function ensembleOwnerLabel(owner: string): string {
  return owner === "maestro" ? "指挥" : `@${owner}`;
}

export interface EnsembleLineStats {
  total: number;
  done: number;
  /** 完成占比（无任务时为 0） */
  ratio: number;
  hasWork: boolean;
  allDone: boolean;
}

export function ensembleLineStats(line: Pick<EnsembleLine, "tasks">): EnsembleLineStats {
  const total = line.tasks.length;
  const done = line.tasks.filter((task) => task.status === "done").length;
  return {
    total,
    done,
    ratio: total === 0 ? 0 : done / total,
    hasWork: line.tasks.some((task) => task.status === "work"),
    allDone: total > 0 && done === total,
  };
}

/** 概览合计：任务总数、完成数、进行中/等待数与总进度条占比 */
export function ensembleOverviewStats(overview: Pick<EnsembleOverview, "lines">): {
  total: number;
  done: number;
  work: number;
  wait: number;
  ratio: number;
} {
  let total = 0;
  let done = 0;
  let work = 0;
  let wait = 0;
  for (const line of overview.lines) {
    total += line.tasks.length;
    for (const task of line.tasks) {
      if (task.status === "done") done += 1;
      else if (task.status === "work") work += 1;
      else if (task.status === "wait") wait += 1;
    }
  }
  return { total, done, work, wait, ratio: total === 0 ? 0 : done / total };
}

/**
 * 概览工作线的初始展开集合（ADR-0131 §6 草案细节）：
 * 首条有进行中任务的工作线；没有则首条未完成的工作线；全部完成时初始收起（空集合）。
 */
export function ensembleDefaultOpenLines(overview: Pick<EnsembleOverview, "lines">): string[] {
  const stats = overview.lines.map((line) => ({ line, stats: ensembleLineStats(line) }));
  const working = stats.find((item) => item.stats.hasWork);
  if (working !== undefined) return [working.line.id];
  const unfinished = stats.find((item) => !item.stats.allDone);
  if (unfinished !== undefined) return [unfinished.line.id];
  return [];
}

/** 留言板「发给」筛选：命中发帖当时的历史投递记录（含显式任务书归属），不用回算后的 mentions（ADR-0131 §7） */
export function ensemblePostDeliveredTo(post: EnsemblePostView, identity: string): boolean {
  if (post.charterOf === identity) return true;
  return post.recipients.includes(identity);
}

/** 留言板「来自」筛选 */
export function ensemblePostFromMatches(post: EnsemblePostView, identity: string): boolean {
  return post.from === identity;
}

export interface EnsembleBoardFilter {
  /** 作者身份："maestro" 或成员名；undefined 不限 */
  from?: string | undefined;
  /** 收件人身份："maestro" 或成员名；undefined 不限 */
  to?: string | undefined;
  /** 关键词（不区分大小写子串；命中正文、作者或任务书） */
  query?: string | undefined;
}

/**
 * 留言板筛选：关键词、作者、收件人三项取交集（ADR-0131 §7）。
 * 关键词命中正文、作者显示名/原名或任务书三段（与原成员筛选行的搜索口径一致）。
 */
export function filterEnsembleBoardPosts(
  posts: readonly EnsemblePostView[],
  filter: EnsembleBoardFilter,
  members?: readonly Pick<EnsembleMemberView, "name" | "charter">[],
): EnsemblePostView[] {
  const needle = filter.query?.trim().toLowerCase() ?? "";
  const charters =
    members !== undefined ? new Map(members.map((m) => [m.name, m.charter])) : undefined;
  return posts.filter((post) => {
    if (filter.from !== undefined && !ensemblePostFromMatches(post, filter.from)) return false;
    if (filter.to !== undefined && !ensemblePostDeliveredTo(post, filter.to)) return false;
    if (needle !== "") {
      const authorLabel = ensembleAuthorLabel(post.from, post.fromKind).toLowerCase();
      const fromRaw = post.from.toLowerCase();
      const charter = post.charterOf !== undefined ? charters?.get(post.charterOf) : undefined;
      const bodyText =
        charter !== undefined
          ? `${charter.owns}\n${charter.handsOff}\n${charter.doneWhen}`.toLowerCase()
          : post.text.toLowerCase();
      if (
        !authorLabel.includes(needle) &&
        !fromRaw.includes(needle) &&
        !bodyText.includes(needle)
      ) {
        return false;
      }
    }
    return true;
  });
}

/** 任务状态显示顺序与文案（ADR-0131 §6）：待办→进行中→等待→完成 */
export const ENSEMBLE_TASK_STATUS_ORDER: readonly EnsembleTaskStatus[] = [
  "todo",
  "work",
  "wait",
  "done",
];

export function ensembleTaskStatusLabel(status: EnsembleTaskStatus): string {
  switch (status) {
    case "todo":
      return "待办";
    case "work":
      return "进行中";
    case "wait":
      return "等待";
    case "done":
      return "完成";
  }
}

/**
 * 在纯文本里切出大小写不敏感的命中片段（供 `<mark>` 高亮）。
 * 空串/空白查询原样返回单段文本；大小写保留原文。
 */
export function splitHighlight(text: string, query: string): { hit: boolean; value: string }[] {
  const needle = query.trim().toLowerCase();
  if (needle === "" || text === "") return text === "" ? [] : [{ hit: false, value: text }];
  const lower = text.toLowerCase();
  const out: { hit: boolean; value: string }[] = [];
  let index = 0;
  let plainStart = 0;
  while (index <= lower.length - needle.length) {
    const at = lower.indexOf(needle, index);
    if (at < 0) break;
    if (at > plainStart) out.push({ hit: false, value: text.slice(plainStart, at) });
    out.push({ hit: true, value: text.slice(at, at + needle.length) });
    index = at + needle.length;
    plainStart = index;
  }
  if (plainStart < text.length) out.push({ hit: false, value: text.slice(plainStart) });
  return out.length > 0 ? out : [{ hit: false, value: text }];
}

function isTokenBoundaryChar(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return false; // 0-9
  if (code >= 65 && code <= 90) return false; // A-Z
  if (code >= 97 && code <= 122) return false; // a-z
  return ch !== "_" && ch !== "." && ch !== "/" && ch !== "-";
}

/**
 * 在 Markdown 文本节点内切分 `@token`：不另写提及正则，只匹配出现在 `mentions` 里的词
 * （`"maestro"` 同时对应 `@maestro` 与 `@指挥`）。
 */
export function splitEnsembleMentions(
  text: string,
  mentions: readonly string[] | undefined,
): EnsembleTextFragment[] {
  if (text === "" || mentions === undefined || mentions.length === 0) {
    return text === "" ? [] : [{ kind: "text", value: text }];
  }
  const tokenSet = new Set<string>();
  for (const mention of mentions) {
    if (mention === "") continue;
    if (mention === "maestro") {
      tokenSet.add("@maestro");
      tokenSet.add("@指挥");
    } else {
      tokenSet.add(`@${mention}`);
    }
  }
  if (tokenSet.size === 0) return [{ kind: "text", value: text }];
  const candidates = [...tokenSet].sort((a, b) => b.length - a.length);
  const out: EnsembleTextFragment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "@" && isTokenBoundaryChar(index > 0 ? text[index - 1] : undefined)) {
      let matched: string | undefined;
      for (const candidate of candidates) {
        if (
          text.startsWith(candidate, index) &&
          isTokenBoundaryChar(text[index + candidate.length])
        ) {
          matched = candidate;
          break;
        }
      }
      if (matched !== undefined) {
        if (index > plainStart) {
          out.push({ kind: "text", value: text.slice(plainStart, index) });
        }
        out.push({ kind: "mention", value: matched });
        index += matched.length;
        plainStart = index;
        continue;
      }
    }
    index += 1;
  }
  if (plainStart < text.length) {
    out.push({ kind: "text", value: text.slice(plainStart) });
  }
  return out;
}
