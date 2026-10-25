/**
 * 定时任务的数据形态（ADR-0064 第 2、3 节，docs/architecture/schedule.md）。
 * 类型、常量与纯展示函数，客户端与 Core 共用；校验与计算在 Core 的 schedule 模块。
 */
import type { ReasoningEffort, ScheduleTrigger } from "./types.js";

/** 相邻两次触发的最小间隔（分钟）；`interval` 与 `cron` 都按它校验 */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 30;
/** 单次运行时长上限的缺省值（分钟） */
export const SCHEDULE_DEFAULT_MAX_DURATION_MINUTES = 60;
/** 每个任务保留的历史条数 */
export const SCHEDULE_HISTORY_LIMIT = 200;
/** 同时运行的定时任务上限（含手动运行） */
export const SCHEDULE_MAX_CONCURRENT = 2;
/** 错过补跑的回看范围（天） */
export const SCHEDULE_CATCHUP_DAYS = 7;

export const SCHEDULE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type ScheduleDay = (typeof SCHEDULE_DAYS)[number];

/**
 * 计划（七种）。`time` 是本地时间 `HH:MM`（24 小时制），`cron` 是五段表达式、本地时区。
 * `hourly` 在每个整点触发。
 */
export type SchedulePlan =
  | { type: "interval"; minutes: number }
  | { type: "hourly" }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; day: ScheduleDay; time: string }
  | { type: "manual" }
  | { type: "cron"; expr: string };

export type SchedulePlanType = SchedulePlan["type"];

/** 保存任务的入参：带 `id` 为编辑（整体替换），不带为新建 */
export interface ScheduleSaveInput {
  id?: string | undefined;
  name: string;
  /** 指令正文，每次运行作为新会话的第一条用户消息 */
  prompt: string;
  /** 工作区目录；缺省或 null 为「普通对话」 */
  workspace?: string | null | undefined;
  /** `provider/model`；缺省用运行时的默认模型 */
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  /** 缺省用运行时的默认预设 */
  permissionPreset?: string | undefined;
  schedule: SchedulePlan;
  /** 缺省 true */
  enabled?: boolean | undefined;
  /** 缺省 60 */
  maxDurationMinutes?: number | undefined;
}

/** 规范化后的任务（schedules.json 里的条目，去掉内部记账字段） */
export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  workspace: string | null;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  permissionPreset?: string | undefined;
  schedule: SchedulePlan;
  enabled: boolean;
  maxDurationMinutes: number;
}

/** 历史行的结果；`running` 只出现在运行中的行 */
export type ScheduleRunResult = "running" | "done" | "error" | "aborted" | "skipped";

/** 跳过原因（ADR-0064 第 3、4 节） */
export type ScheduleSkipReason = "previous_running" | "concurrency" | "missed";

/** 历史里的一次触发 */
export interface ScheduleHistoryEntry {
  /** 触发的唯一标识；同一次触发的「开始」与「结束」两行共用 */
  id: string;
  taskId: string;
  /** 原计划时间（ISO 8601）；手动运行为触发时刻 */
  scheduledAt: string;
  trigger: ScheduleTrigger;
  result: ScheduleRunResult;
  /** result 为 skipped 时的原因 */
  reason?: ScheduleSkipReason | undefined;
  /** result 为 error 时的错误码 */
  error?: string | undefined;
  sessionId?: string | undefined;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  /** 运行中因无人值守被拒绝（`non_interactive`）的操作数；0 或缺省为没有 */
  denied?: number | undefined;
}

export interface ScheduleTaskStats {
  /** 最近 7 天：实际运行与被跳过的次数 */
  last7Days: { runs: number; skipped: number };
  /** 已结束的运行的平均用时；没有时缺省 */
  averageDurationMs?: number | undefined;
}

/** 列表中的一项：任务 + 服务端算好的下次时间、上次结果与是否在运行 */
export interface ScheduleTaskOverview extends ScheduledTask {
  createdAt: string;
  /** 下次计划时间（ISO 8601）；已暂停或 manual 缺省 */
  nextRunAt?: string | undefined;
  /** 最近一次实际运行（跳过的不算） */
  lastRun?: ScheduleHistoryEntry | undefined;
  running: boolean;
  stats: ScheduleTaskStats;
}

/** 调度器此刻能否触发任务；不能时给出原因 */
export interface ScheduleSchedulerStatus {
  running: boolean;
  /** `disabled`：本进程没有启用调度器；`locked`：另一个 Nocturne 正在调度 */
  reason?: "disabled" | "locked" | undefined;
}

export interface ScheduleListResult {
  tasks: ScheduleTaskOverview[];
  scheduler: ScheduleSchedulerStatus;
  /** 读取 schedules.json 时被忽略的条目等警告 */
  warnings: string[];
}

export type ScheduleRunNowResult =
  | { started: true; sessionId: string }
  | { started: false; reason: Exclude<ScheduleSkipReason, "missed"> };

/** 保存、删除、启停、运行状态变化时发出的易失事件载荷（`schedule.changed`） */
export interface ScheduleChangedPayload {
  /** 变化的任务；任务列表整体变化（如启动时加载）时缺省 */
  taskId?: string | undefined;
}

const DAY_LABELS: Record<ScheduleDay, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
};

/** 星期的中文简称（周一…周日） */
export function scheduleDayLabel(day: ScheduleDay): string {
  return DAY_LABELS[day];
}

/**
 * 计划的一句话摘要（确认卡片、列表副标题共用）：`每天 09:00`、`每 30 分钟`、
 * `cron 0 9 * * 1-5`。时间都是本地时间，不在这里重复说明。
 */
export function describeSchedulePlan(plan: SchedulePlan): string {
  switch (plan.type) {
    case "interval":
      return `每 ${plan.minutes} 分钟`;
    case "hourly":
      return "每小时整点";
    case "daily":
      return `每天 ${plan.time}`;
    case "weekdays":
      return `工作日 ${plan.time}`;
    case "weekly":
      return `每${DAY_LABELS[plan.day]} ${plan.time}`;
    case "manual":
      return "仅手动运行";
    case "cron":
      return `cron ${plan.expr}`;
  }
}
