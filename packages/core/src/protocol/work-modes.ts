/**
 * 执行方式（ADR-0076）：提交时的 `workMode`、用户消息上的快照、目标状态折叠与
 * 客户端斜杠解析。纯函数，客户端与 Runtime 共用。
 */
import type { DurableEvent } from "./events.js";

export const WORK_MODE_NAMES = ["grill-me", "goal", "plan", "boost"] as const;

export type WorkModeName = (typeof WORK_MODE_NAMES)[number];

/**
 * `message.user.workMode`：说明块正文快照，回放与回退沿用，不重新生成。
 * name 按字符串读取：较新版本写入的未知名字不让整条日志解析失败。
 */
export interface WorkModeSnapshot {
  name: WorkModeName | (string & {});
  body: string;
  /**
   * 写入来源：缺省为用户提交；`"runtime"` 为 Runtime 自己写的模式消息（目标核对、
   * 继续目标、批准计划），客户端不对它提供重发。按字符串读取，未知值同样视为非用户提交。
   */
  source?: "runtime" | (string & {}) | undefined;
}

/** 用户提交的执行方式名；Runtime 写入的模式消息与未知名字返回 undefined（重发据此保留模式） */
export function userWorkMode(
  workMode: { name: string; source?: string | undefined } | undefined,
): WorkModeName | undefined {
  if (workMode === undefined || workMode.source !== undefined) return undefined;
  return isWorkModeName(workMode.name) ? workMode.name : undefined;
}

/** Runtime 写入的模式消息（不是用户提交的） */
export function isRuntimeWorkMode(workMode: { source?: string | undefined } | undefined): boolean {
  return workMode?.source !== undefined;
}

export function isWorkModeName(value: unknown): value is WorkModeName {
  return typeof value === "string" && (WORK_MODE_NAMES as readonly string[]).includes(value);
}

// ── 目标模式（ADR-0076 §4）────────────────────────────────────

export const GOAL_STATUSES = ["active", "met", "blocked", "limit", "stopped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** 默认上限（ADR-0076 §4.4） */
export const GOAL_MAX_ROUNDS = 10;
export const GOAL_MAX_MINUTES = 60;

/** `session.config_changed.goal`：每次都写完整对象 */
export interface GoalConfig {
  objective: string;
  status: GoalStatus;
  maxMinutes: number;
  maxRounds: number;
  /** blocked 的原因；stopped 的来源（"user" | "interrupted" | "rewound"） */
  reason?: string | undefined;
}

/** 折叠后的目标：配置 + 自最近一次变为 active 起的用量 */
export interface GoalState extends GoalConfig {
  /** 最近一次变为 active 的事件 seq */
  since: number;
  /** 自 since 起写入的核对说明条数 */
  rounds: number;
  /** 自 since 起已结束 Turn 的运行时长之和（毫秒） */
  activeMs: number;
  /** 目标为 active 时进行中 Turn 的计时起点（墙钟 ISO） */
  turnStartedAt?: string | undefined;
}

const elapsedSince = (from: string, to: string): number =>
  Math.max(0, Date.parse(to) - Date.parse(from));

/**
 * 按持久事件推进目标状态。Core 折叠与客户端视图共用，折叠本身不看回退：调用方对
 * 回退区间外的事件同样调用；回退撤回目标由 Runtime 另写事件（ADR-0076 §2）。`turnOpen` 是处理该事件前是否有进行中的 Turn。
 */
export function reduceGoal(
  goal: GoalState | undefined,
  event: DurableEvent,
  turnOpen: boolean,
): GoalState | undefined {
  switch (event.type) {
    case "session.config_changed": {
      const next = event.payload.goal;
      if (next === undefined) return goal;
      if (next.status === "active")
        return {
          ...next,
          since: event.seq,
          rounds: 0,
          activeMs: 0,
          ...(turnOpen ? { turnStartedAt: event.time } : {}),
        };
      const running = goal?.turnStartedAt;
      return {
        ...next,
        since: goal?.since ?? event.seq,
        rounds: goal?.rounds ?? 0,
        activeMs: (goal?.activeMs ?? 0) + (running ? elapsedSince(running, event.time) : 0),
      };
    }
    case "turn.started":
      return goal?.status === "active" ? { ...goal, turnStartedAt: event.time } : goal;
    case "turn.completed": {
      if (goal?.turnStartedAt === undefined) return goal;
      const { turnStartedAt, ...rest } = goal;
      return { ...rest, activeMs: goal.activeMs + elapsedSince(turnStartedAt, event.time) };
    }
    case "message.user":
      return goal?.status === "active" &&
        event.payload.steer === true &&
        event.payload.workMode?.name === "goal"
        ? { ...goal, rounds: goal.rounds + 1 }
        : goal;
    default:
      return goal;
  }
}

/** 已用时长：已结束 Turn 之和 + 进行中 Turn 到 now 为止 */
export function goalElapsedMs(goal: GoalState, nowMs: number): number {
  const running = goal.turnStartedAt;
  return goal.activeMs + (running ? Math.max(0, nowMs - Date.parse(running)) : 0);
}

const GOAL_STATUS_TEXT: Record<GoalStatus, string> = {
  active: "进行中",
  met: "已完成",
  blocked: "受阻",
  limit: "已达上限",
  stopped: "已停止",
};

/** `/goal` 无参数时显示的行：目标、状态、已用轮数与时长 */
export function goalStatusLines(goal: GoalState | undefined, nowMs: number): string[] {
  if (goal === undefined) return ["没有目标"];
  const minutes = Math.floor(goalElapsedMs(goal, nowMs) / 60_000);
  const reason = goal.status === "blocked" && goal.reason ? `（${goal.reason}）` : "";
  return [
    `目标：${goal.objective}`,
    `状态：${GOAL_STATUS_TEXT[goal.status]}${reason}`,
    `轮数：${goal.rounds}/${goal.maxRounds}`,
    `时长：${minutes}/${goal.maxMinutes} 分钟`,
  ];
}

/** `/goal stop` 的回执：按调用前的状态说明结果；目标不在进行中时 stopGoal 不改动 */
export function goalStopText(before: GoalStatus | undefined): string {
  if (before === undefined || before === "active" || before === "stopped") return "目标已停止";
  return `目标${GOAL_STATUS_TEXT[before]}，无需停止`;
}

// ── 计划模式（ADR-0076 §5）────────────────────────────────────

/** `session.config_changed.plan`：进入时记下要恢复的预设；null = 退出 */
export interface PlanConfig {
  restorePreset: string;
}

/** 按持久事件推进计划模式状态；与目标一样折叠本身不看回退，调用方对全部事件调用 */
export function reducePlan(
  plan: PlanConfig | undefined,
  event: DurableEvent,
): PlanConfig | undefined {
  if (event.type !== "session.config_changed") return plan;
  const next = event.payload.plan;
  if (next === undefined) return plan;
  return next === null ? undefined : { restorePreset: next.restorePreset };
}

/**
 * 当前目标与当前计划的起点消息（ADR-0076 §2）：`goal` 是最近一条用户提交的 `/goal`
 * 消息；`plan` 是自最近一次退出计划模式以来第一条用户提交的 `/plan` 消息（之后的
 * `/plan` 只是修订）。回退到起点或更早时，Runtime 停止目标、放弃计划。按原始日志
 * 计算，已被回退截掉的消息同样算起点：回退时模式已随之撤回。
 */
export function workModeOrigins(events: readonly DurableEvent[]): {
  goal?: number | undefined;
  plan?: number | undefined;
} {
  let goal: number | undefined;
  let plan: number | undefined;
  for (const event of events) {
    if (event.type === "session.config_changed" && event.payload.plan === null) plan = undefined;
    if (event.type !== "message.user") continue;
    const name = userWorkMode(event.payload.workMode);
    if (name === "goal") goal = event.seq;
    if (name === "plan") plan ??= event.seq;
  }
  return { goal, plan };
}

// ── 客户端斜杠解析 ─────────────────────────────────────────

/** 不开新任务的子命令（ADR-0076 §7） */
export type WorkModeAction =
  "goal-status" | "goal-stop" | "goal-resume" | "plan-approve" | "plan-cancel";

/** 斜杠解析结果：带任务的提交、整行只是命令名时的用法提示，或会话操作 */
export type WorkModeSlash =
  | { kind: "submit"; workMode: WorkModeName; text: string }
  | { kind: "usage"; name: WorkModeName; hint: string }
  | { kind: "action"; action: WorkModeAction };

const USAGE: Record<WorkModeName, string> = {
  "grill-me": "用法：/grill-me 需求",
  goal: "用法：/goal 目标",
  plan: "用法：/plan 任务",
  boost: "用法：/boost 任务",
};

/** 子命令：整行恰好是命令名（+ 一个单词）时才算，其余文字都当任务 */
const ACTIONS: Partial<Record<WorkModeName, Record<string, WorkModeAction>>> = {
  goal: { "": "goal-status", stop: "goal-stop", resume: "goal-resume" },
  plan: { approve: "plan-approve", cancel: "plan-cancel" },
};

/**
 * 解析 `/<模式> …`；不是执行方式命令时返回 undefined。命令名与子命令不区分
 * 大小写，任务可以包含换行。
 */
export function parseWorkModeSlash(line: string): WorkModeSlash | undefined {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  const name = match?.[1]?.toLowerCase();
  if (!isWorkModeName(name)) return undefined;
  const text = (match?.[2] ?? "").trim();
  const action = ACTIONS[name]?.[text.toLowerCase()];
  if (action !== undefined) return { kind: "action", action };
  if (text === "") return { kind: "usage", name, hint: USAGE[name] };
  return { kind: "submit", workMode: name, text };
}

/** 用户消息的显示文本：执行方式消息在正文前加命令名（核对说明只有命令名） */
export function workModeDisplayText(text: string, workMode: { name: string } | undefined): string {
  if (workMode === undefined) return text;
  return text === "" ? `/${workMode.name}` : `/${workMode.name} ${text}`;
}

/** 客户端补全用的命令表（名称、一行摘要） */
export const WORK_MODE_COMMANDS: readonly { name: `/${WorkModeName}`; summary: string }[] = [
  { name: "/grill-me", summary: "追问需求" },
  { name: "/goal", summary: "目标模式" },
  { name: "/plan", summary: "计划模式" },
  { name: "/boost", summary: "多代理攻坚" },
];
