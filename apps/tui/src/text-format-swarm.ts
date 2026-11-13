/**
 * Swarm 界面的纯逻辑（ADR-0089、tui.md §2「Swarm 状态块」与「/swarm board」）：
 * 工具行标签与参数、活动摘要组词、作者与提及文案、状态点、留言板筛选、
 * 正文按 `mentions` 切分。词与桌面端一致；不依赖 React/Ink。
 */
import type {
  ModelRef,
  SwarmActivity,
  SwarmAuthorKind,
  SwarmMemberView,
  SwarmPostView,
  SwarmView,
} from "@nocturne/core/protocol";

/** Swarm 协调者工具的工具行标签（与桌面端 tool-meta 同词） */
export const SWARM_TOOL_LABELS: Readonly<Record<string, string>> = {
  swarm_init: "合奏",
  swarm_add_member: "添加",
  swarm_post: "发帖",
  swarm_change_model: "换模型",
  swarm_remove_member: "移除",
  swarm_end: "结束",
  swarm_checkout: "检出",
};

/** 工具行头部显示的名字：Swarm 工具用标签，其余沿用工具名 */
export function toolDisplayName(name: string): string {
  return SWARM_TOOL_LABELS[name] ?? name;
}

/** 活动摘要里的工具动词：与 TUI 工具行头部的写法一致 */

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 多行文本的首个非空行 */
export function firstLine(value: unknown): string {
  if (typeof value !== "string") return "";
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** 去掉 `provider/` 前缀的模型名 */
export function shortModelName(model: ModelRef | string | undefined): string {
  if (model === undefined) return "";
  if (typeof model !== "string") return model.model;
  const slash = model.indexOf("/");
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}

/** Swarm 工具行的参数摘要；非 Swarm 工具返回 undefined，交给通用摘要 */
export function swarmToolSummary(name: string, input: unknown): string | undefined {
  const rec = recordOf(input);
  switch (name) {
    case "swarm_init":
      return firstLine(rec.title);
    case "swarm_add_member": {
      const member = stringOf(rec.name);
      return member === "" ? "" : `@${member}`;
    }
    case "swarm_post":
      return firstLine(rec.text);
    case "swarm_change_model": {
      const member = stringOf(rec.name) || stringOf(rec.member);
      const target = shortModelName(stringOf(rec.model) || stringOf(rec.profile));
      if (member === "") return target;
      return target === "" ? `@${member}` : `@${member} ${target}`;
    }
    case "swarm_remove_member": {
      const member = stringOf(rec.name) || stringOf(rec.member);
      return member === "" ? "" : `@${member}`;
    }
    case "swarm_end":
      return firstLine(rec.summary);
    case "swarm_checkout": {
      const member = stringOf(rec.member) || stringOf(rec.name);
      return member === "" ? "" : `@${member}`;
    }
    default:
      return undefined;
  }
}

/** 结构化活动摘要组成一行文字；没有可显示内容时返回 "" */
export function swarmActivityText(activity: SwarmActivity | undefined): string {
  if (activity === undefined) return "";
  switch (activity.kind) {
    case "tool": {
      const verb = toolDisplayName(activity.tool);
      return activity.detail !== undefined && activity.detail !== ""
        ? `${verb} ${activity.detail}`
        : verb;
    }
    case "permission":
      return activity.target !== undefined && activity.target !== ""
        ? `等待确认：${activity.target}`
        : "等待确认";
    case "paused": {
      // 与工具行错误同一写法：Runtime 的原文首行，没有时用错误码
      const line = firstLine(activity.message);
      return line !== "" ? line : activity.code;
    }
    case "post":
    case "charter":
      return activity.line;
    case "removed":
      return activity.reason !== undefined ? firstLine(activity.reason) : "";
  }
}

/** 作者显示：协调者 / 你 / Runtime / @name */
export function swarmAuthorLabel(from: string, fromKind: SwarmAuthorKind): string {
  switch (fromKind) {
    case "coordinator":
      return "协调者";
    case "user":
      return "你";
    case "runtime":
      return "Runtime";
    case "member":
      return `@${from}`;
  }
}

/** 提及显示：coordinator → 协调者，其余 → @x */
export function swarmMentionLabel(mention: string): string {
  return mention === "coordinator" ? "协调者" : `@${mention}`;
}

/** 帖子头展示的收件人：剔除作者自身（协调者剔除 `coordinator`） */
export function swarmPostRecipients(
  post: Pick<SwarmPostView, "from" | "fromKind" | "mentions">,
): string[] {
  const self = post.fromKind === "coordinator" ? "coordinator" : post.from;
  return post.mentions.filter((mention) => mention !== self);
}

/** 帖子标题 `#n 作者 → 提及`（没有提及时省去箭头） */
export function swarmPostHead(
  post: Pick<SwarmPostView, "number" | "from" | "fromKind" | "mentions">,
): string {
  const mentions = swarmPostRecipients(post).map(swarmMentionLabel).join(" ");
  const author = swarmAuthorLabel(post.from, post.fromKind);
  return mentions === "" ? `#${post.number} ${author}` : `#${post.number} ${author} → ${mentions}`;
}

export type SwarmDot = "work" | "attention" | "wait" | "removed";

/** 成员状态点：working 强调色实心、待确认与 paused 警告色实心、waiting 淡色空心 */
export function swarmMemberDot(
  member: Pick<SwarmMemberView, "status" | "pendingPermissions">,
  swarmStatus: SwarmView["status"],
): SwarmDot {
  if (member.status === "removed") return "removed";
  if (swarmStatus === "ended") return "wait";
  if (member.pendingPermissions.length > 0 || member.status === "paused") return "attention";
  return member.status === "working" ? "work" : "wait";
}

export function swarmCoordinatorDot(swarm: Pick<SwarmView, "status" | "coordinator">): SwarmDot {
  if (swarm.status === "ended") return "wait";
  if (swarm.coordinator.awaitingPermission) return "attention";
  return swarm.coordinator.status === "working" ? "work" : "wait";
}

/** 状态块列出的成员：working、paused 与有待确认请求的成员（已移除除外） */
export function swarmStripMembers(swarm: SwarmView): SwarmMemberView[] {
  if (swarm.status !== "active") return [];
  return swarm.members.filter(
    (m) =>
      m.status !== "removed" &&
      (m.status === "working" || m.status === "paused" || m.pendingPermissions.length > 0),
  );
}

/** 留言板筛选：`all` 全部；`coordinator` 与成员名按 `from` 或 `recipients` */
export function filterSwarmPosts(posts: readonly SwarmPostView[], target: string): SwarmPostView[] {
  if (target === "all") return [...posts];
  if (target === "coordinator")
    return posts.filter(
      (p) => p.fromKind === "coordinator" || p.recipients.includes("coordinator"),
    );
  return posts.filter(
    (p) => (p.fromKind === "member" && p.from === target) || p.recipients.includes(target),
  );
}

/** 本地时间 HH:MM */
export function formatSwarmTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface MentionFragment {
  text: string;
  mention: boolean;
}

function boundary(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9_./-]/u.test(ch);
}

/**
 * 正文切分：只把 `mentions` 里出现的词（`coordinator` 对应 `@coordinator` 与 `@协调者`）
 * 切成提及片段，不另写提及正则；其余原样保留。
 */
export function splitSwarmMentions(text: string, mentions: readonly string[]): MentionFragment[] {
  const tokens = new Set<string>();
  for (const m of mentions) {
    if (m === "") continue;
    if (m === "coordinator") {
      tokens.add("@coordinator");
      tokens.add("@协调者");
    } else tokens.add(`@${m}`);
  }
  if (tokens.size === 0) return text === "" ? [] : [{ text, mention: false }];
  const candidates = [...tokens].sort((a, b) => b.length - a.length);
  const out: MentionFragment[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && boundary(i > 0 ? text[i - 1] : undefined)) {
      const hit = candidates.find((c) => text.startsWith(c, i) && boundary(text[i + c.length]));
      if (hit !== undefined) {
        if (i > start) out.push({ text: text.slice(start, i), mention: false });
        out.push({ text: hit, mention: true });
        i += hit.length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  if (start < text.length) out.push({ text: text.slice(start), mention: false });
  return out;
}

export interface SwarmMentionToken {
  start: number;
  end: number;
  query: string;
}

export interface SwarmMentionCandidate {
  kind: "coordinator" | "member" | "group" | "all";
  insert: string;
  label: string;
  meta?: string | undefined;
}

/** 识别光标前的 `@名字` 触发词 */
export function swarmMentionToken(value: string, cursor: number): SwarmMentionToken | null {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_./-]/u.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9\u4e00-\u9fa5-]*$/u.test(query)) return null;
  return { start: at, end: cursor, query };
}

/** 留言板 `@` 补全候选（协调者、未移除成员、同前缀组、all），按前缀不区分大小写筛选 */
export function swarmMentionCandidates(
  swarm: Pick<SwarmView, "coordinator" | "members">,
  query: string,
): SwarmMentionCandidate[] {
  const q = query.trim().toLowerCase();
  const out: SwarmMentionCandidate[] = [];

  if (q === "" || "coordinator".startsWith(q) || "协调者".startsWith(q)) {
    const coordModel = shortModelName(swarm.coordinator.model);
    out.push({
      kind: "coordinator",
      insert: "coordinator",
      label: "协调者",
      ...(coordModel !== "" ? { meta: coordModel } : {}),
    });
  }

  const activeMembers = swarm.members.filter((m) => m.status !== "removed");
  const activeNames = new Set(activeMembers.map((m) => m.name));
  const prefixCounts = new Map<string, number>();

  for (const member of activeMembers) {
    const groupMatch = /^(.+)-(\d+)$/u.exec(member.name);
    if (groupMatch?.[1] !== undefined) {
      const prefix = groupMatch[1];
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    if (q === "" || member.name.toLowerCase().startsWith(q)) {
      const meta = member.profile?.trim() ? member.profile : shortModelName(member.model);
      out.push({
        kind: "member",
        insert: member.name,
        label: member.name,
        ...(meta !== "" ? { meta } : {}),
      });
    }
  }

  for (const [prefix, count] of prefixCounts) {
    if (count < 2 || activeNames.has(prefix)) continue;
    if (q === "" || prefix.toLowerCase().startsWith(q)) {
      out.push({
        kind: "group",
        insert: prefix,
        label: `@${prefix}`,
      });
    }
  }

  if (q === "" || "all".startsWith(q)) {
    out.push({
      kind: "all",
      insert: "all",
      label: "all",
    });
  }

  return out;
}
