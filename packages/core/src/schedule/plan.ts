/**
 * 计划（七种）的校验与「下一次触发时间」计算（ADR-0064 第 2 节，schedule.md 第 3 节）。
 * 所有时刻都是 UTC 毫秒；本地日期、时区、夏令时的处理见 zone.ts。
 */
import {
  SCHEDULE_DAYS,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  type SchedulePlan,
} from "../protocol/schedule.js";
import { CronError, cronMatchesDate, parseCron, type CronSpec } from "./cron.js";
import { addDays, weekdayOf, type LocalDate, type Zone } from "./zone.js";

/** 字段校验失败；`field` 对应表单字段，客户端可以据此定位 */
export class ScheduleError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_INTERVAL_MINUTES = 525_600;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 校验 cron 最小间隔时向前看多少天：覆盖夏令时和「日 + 星期」的或关系 */
const CRON_GAP_HORIZON_DAYS = 800;
/** 找下一次触发时最多翻多少天：够 2 月 29 日这类四年一次的表达式 */
const MAX_SCAN_DAYS = 3000;

export interface PlanContext {
  zone: Zone;
  /** `interval` 的起算时刻（UTC 毫秒） */
  anchor: number;
}

const DAY_INDEX: Record<(typeof SCHEDULE_DAYS)[number], number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

function parseTime(value: unknown, field: string): [number, number] {
  const m = typeof value === "string" ? TIME_PATTERN.exec(value) : null;
  if (m === null) throw new ScheduleError(field, "时间必须是 HH:MM（24 小时制），例如 09:00");
  return [Number(m[1]), Number(m[2])];
}

function rejectExtraKeys(raw: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new ScheduleError("schedule", `计划里有未知字段 ${key}`);
}

/**
 * 校验并规范化一个计划；非法时抛 `ScheduleError`。
 * `cron` 还要检查相邻两次触发的间隔不小于 30 分钟（以 `ctx` 的时区从 `now` 起向前看 800 天）。
 */
export function validatePlan(raw: unknown, ctx: { zone: Zone; now: number }): SchedulePlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ScheduleError("schedule", "计划必须是对象");
  const obj = raw as Record<string, unknown>;
  switch (obj.type) {
    case "interval": {
      rejectExtraKeys(obj, ["type", "minutes"]);
      const minutes = obj.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes))
        throw new ScheduleError("schedule", "间隔必须是整数分钟");
      if (minutes < SCHEDULE_MIN_INTERVAL_MINUTES)
        throw new ScheduleError("schedule", `最小间隔是 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟`);
      if (minutes > MAX_INTERVAL_MINUTES)
        throw new ScheduleError("schedule", "间隔太长，请改用每天、每周或 cron");
      return { type: "interval", minutes };
    }
    case "hourly":
      rejectExtraKeys(obj, ["type"]);
      return { type: "hourly" };
    case "daily":
    case "weekdays": {
      rejectExtraKeys(obj, ["type", "time"]);
      parseTime(obj.time, "schedule");
      return { type: obj.type, time: obj.time as string };
    }
    case "weekly": {
      rejectExtraKeys(obj, ["type", "day", "time"]);
      const day = obj.day;
      if (typeof day !== "string" || !(SCHEDULE_DAYS as readonly string[]).includes(day))
        throw new ScheduleError("schedule", `星期必须是 ${SCHEDULE_DAYS.join(" | ")} 之一`);
      parseTime(obj.time, "schedule");
      return {
        type: "weekly",
        day: day as (typeof SCHEDULE_DAYS)[number],
        time: obj.time as string,
      };
    }
    case "manual":
      rejectExtraKeys(obj, ["type"]);
      return { type: "manual" };
    case "cron": {
      rejectExtraKeys(obj, ["type", "expr"]);
      if (typeof obj.expr !== "string" || obj.expr.length > 200)
        throw new ScheduleError("schedule", "cron 表达式必须是不超过 200 字符的字符串");
      const expr = obj.expr.trim().split(/\s+/).join(" ");
      try {
        parseCron(expr);
      } catch (e) {
        throw new ScheduleError("schedule", e instanceof CronError ? e.message : "cron 表达式无效");
      }
      const plan: SchedulePlan = { type: "cron", expr };
      const gap = shortestGap(plan, ctx);
      if (gap !== undefined && gap.minutes < SCHEDULE_MIN_INTERVAL_MINUTES)
        throw new ScheduleError(
          "schedule",
          `相邻两次触发的间隔不能小于 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟（${gap.minutes} 分钟）`,
        );
      return plan;
    }
    default:
      throw new ScheduleError(
        "schedule",
        "计划类型必须是 interval | hourly | daily | weekdays | weekly | manual | cron 之一",
      );
  }
}

/** 日期规则与当天的触发时刻（本地 [时, 分]，升序） */
interface CalendarRule {
  matches(date: LocalDate, weekday: number): boolean;
  times: readonly (readonly [number, number])[];
}

function calendarRule(plan: Exclude<SchedulePlan, { type: "interval" | "manual" }>): CalendarRule {
  switch (plan.type) {
    case "hourly":
      return {
        matches: () => true,
        times: Array.from({ length: 24 }, (_, h) => [h, 0] as const),
      };
    case "daily":
      return { matches: () => true, times: [parseTime(plan.time, "schedule")] };
    case "weekdays":
      return {
        matches: (_date, weekday) => weekday >= 1 && weekday <= 5,
        times: [parseTime(plan.time, "schedule")],
      };
    case "weekly": {
      const target = DAY_INDEX[plan.day];
      return {
        matches: (_date, weekday) => weekday === target,
        times: [parseTime(plan.time, "schedule")],
      };
    }
    case "cron": {
      const spec: CronSpec = parseCron(plan.expr);
      const times: (readonly [number, number])[] = [];
      for (const h of spec.hours) for (const m of spec.minutes) times.push([h, m]);
      return {
        matches: (date, weekday) => cronMatchesDate(spec, date, weekday),
        times,
      };
    }
  }
}

/**
 * 严格晚于 `after` 的触发时刻，按时间升序、惰性产生。
 * `manual` 不产生；`cron` 找不到（如 2 月 30 日）时在翻过 MAX_SCAN_DAYS 天后结束。
 */
export function* fires(plan: SchedulePlan, after: number, ctx: PlanContext): Generator<number> {
  if (plan.type === "manual") return;
  if (plan.type === "interval") {
    const step = plan.minutes * MINUTE;
    let k = after < ctx.anchor ? 1 : Math.floor((after - ctx.anchor) / step) + 1;
    for (; ; k++) yield ctx.anchor + k * step;
  }
  const rule = calendarRule(plan);
  const start = ctx.zone.fields(after);
  const first: LocalDate = { year: start.year, month: start.month, day: start.day };
  let last = after;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const date = addDays(first, i);
    if (!rule.matches(date, weekdayOf(date))) continue;
    const convert = ctx.zone.dayConverter(date);
    const instants = [...new Set(rule.times.map(([h, m]) => convert(h, m)))].sort((a, b) => a - b);
    for (const instant of instants) {
      if (instant <= last) continue;
      last = instant;
      yield instant;
    }
  }
}

export function nextFire(plan: SchedulePlan, after: number, ctx: PlanContext): number | undefined {
  const next = fires(plan, after, ctx).next();
  return next.done === true ? undefined : next.value;
}

/** `(after, until]` 内的触发时刻，最多 `limit` 个 */
export function firesBetween(
  plan: SchedulePlan,
  after: number,
  until: number,
  ctx: PlanContext,
  limit = 400,
): number[] {
  const out: number[] = [];
  for (const instant of fires(plan, after, ctx)) {
    if (instant > until || out.length >= limit) break;
    out.push(instant);
  }
  return out;
}

/** 未来 800 天内相邻两次触发的最短间隔（分钟）与较晚的那次；少于两次触发时为 undefined */
function shortestGap(
  plan: SchedulePlan,
  ctx: { zone: Zone; now: number },
): { minutes: number; at: number } | undefined {
  const horizon = ctx.now + CRON_GAP_HORIZON_DAYS * DAY;
  let previous: number | undefined;
  let shortest: { minutes: number; at: number } | undefined;
  for (const instant of fires(plan, ctx.now, { zone: ctx.zone, anchor: ctx.now })) {
    if (instant > horizon) break;
    if (previous !== undefined) {
      const minutes = Math.round((instant - previous) / MINUTE);
      if (shortest === undefined || minutes < shortest.minutes) shortest = { minutes, at: instant };
      // 已经违规，不必再算
      if (minutes < SCHEDULE_MIN_INTERVAL_MINUTES) return shortest;
    }
    previous = instant;
  }
  return shortest;
}
