/**
 * Ensemble 界面的纯逻辑（ADR-0089）：工具行参数、活动摘要组词、状态圆点、作者与提及文案、
 * 留言板筛选与搜索、成员分组、入口行计数，以及正文按 `mentions` 切分高亮。
 * 桌面端与手机网页共用；只依赖 `@nocturne/core/protocol` 与 `./tool-meta`，不依赖 React。
 */
import type {
  ModelRef,
  EnsembleActivity,
  EnsembleAuthorKind,
  EnsembleMemberView,
  EnsemblePostView,
  EnsembleView,
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
 * （成员作者去掉 `post.from`，指挥作者去掉 `"maestro"`）。
 */
export function ensemblePostRecipients(
  post: Pick<EnsemblePostView, "from" | "fromKind" | "mentions">,
): string[] {
  const self = post.fromKind === "maestro" ? "maestro" : post.from;
  return post.mentions.filter((mention) => mention !== self);
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

/** 留言板按成员筛选（`from` 或 `recipients`）与正文/作者不区分大小写子串搜索 */
export function filterEnsemblePosts<
  T extends Pick<EnsemblePostView, "from" | "fromKind" | "text" | "recipients" | "charterOf">,
>(
  posts: readonly T[],
  options: {
    member?: string | undefined;
    query?: string | undefined;
    members?: readonly Pick<EnsembleMemberView, "name" | "charter">[] | undefined;
  } = {},
): T[] {
  const selected = options.member?.trim() ?? "";
  const needle = options.query?.trim().toLowerCase() ?? "";
  const charters =
    options.members !== undefined
      ? new Map(options.members.map((m) => [m.name, m.charter]))
      : undefined;
  return posts.filter((post) => {
    if (selected !== "") {
      const isAuthor = post.fromKind === "member" && post.from === selected;
      if (!isAuthor && !post.recipients.includes(selected)) return false;
    }
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
