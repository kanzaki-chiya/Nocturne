/**
 * 时区与本地时间换算（docs/architecture/schedule.md 第 3 节）。
 * 只用 `Intl.DateTimeFormat`，不依赖进程的 TZ 环境变量，测试可以指定任意 IANA 时区。
 *
 * 夏令时边界的规则（与 JavaScript `Date` / Temporal 的 `compatible` 一致）：
 * - 本地时间不存在（春季前拨的空档）：按跳变前的偏移换算，落在空档之后（02:30 → 03:30）；
 * - 本地时间出现两次（秋季回拨）：取第一次。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface LocalFields {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日 */
  weekday: number;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface Zone {
  readonly id: string;
  /** 某个 UTC 时刻的本地各字段 */
  fields(utcMs: number): LocalFields;
  /** 某个 UTC 时刻的偏移（本地墙钟 − UTC，毫秒） */
  offsetAt(utcMs: number): number;
  /** 本地墙钟时间 → UTC 毫秒（夏令时规则见文件头） */
  toInstant(year: number, month: number, day: number, hour: number, minute: number): number;
  /**
   * 某个本地日期的换算函数：当天（含前后若干小时）没有偏移跳变时走快速路径，
   * 否则逐个按 `toInstant` 精确换算。
   */
  dayConverter(date: LocalDate): (hour: number, minute: number) => number;
}

export function systemZoneId(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function createZone(id: string = systemZoneId()): Zone {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  const fields = (utcMs: number): LocalFields => {
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(utcMs)) {
      if (part.type !== "literal") parts[part.type] = Number(part.value);
    }
    const year = parts.year ?? 1970;
    const month = parts.month ?? 1;
    const day = parts.day ?? 1;
    return {
      year,
      month,
      day,
      // 个别 ICU 版本在午夜输出 24
      hour: (parts.hour ?? 0) % 24,
      minute: parts.minute ?? 0,
      second: parts.second ?? 0,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
  };

  const offsetAt = (utcMs: number): number => {
    const f = fields(utcMs);
    const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    return wall - Math.floor(utcMs / 1000) * 1000;
  };

  const toInstant: Zone["toInstant"] = (year, month, day, hour, minute) => {
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const before = offsetAt(wall - DAY);
    const after = offsetAt(wall + DAY);
    const candidates = new Set<number>();
    for (const offset of new Set([before, after])) {
      const instant = wall - offset;
      if (offsetAt(instant) === offset) candidates.add(instant);
    }
    if (candidates.size === 0) return wall - before;
    return Math.min(...candidates);
  };

  const dayConverter: Zone["dayConverter"] = (date) => {
    const base = Date.UTC(date.year, date.month - 1, date.day);
    const start = base - offsetAt(base);
    const early = offsetAt(start - 6 * HOUR);
    const late = offsetAt(start + 30 * HOUR);
    if (early === late) return (hour, minute) => base + hour * HOUR + minute * MINUTE - early;
    return (hour, minute) => toInstant(date.year, date.month, date.day, hour, minute);
  };

  return { id, fields, offsetAt, toInstant, dayConverter };
}

/** 本地日期加 n 天（纯日历运算，不涉及时区） */
export function addDays(date: LocalDate, n: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + n * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 日历日期的星期（0 = 周日） */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}
