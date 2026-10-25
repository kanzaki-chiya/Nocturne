/**
 * 计划的校验与下一次触发时间（ADR-0064 验收：计划解析与下一次时间，含 weekdays、cron、
 * 本地时区、夏令时边界；最小间隔校验）。
 */
import { describe, expect, it } from "vitest";

import { CronError, parseCron } from "./cron.js";
import { firesBetween, nextFire, ScheduleError, validatePlan, type PlanContext } from "./plan.js";
import { createZone } from "./zone.js";

const shanghai = createZone("Asia/Shanghai");
const newYork = createZone("America/New_York");
const kolkata = createZone("Asia/Kolkata");
const utc = createZone("UTC");

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();
const ctx = (zone = shanghai, anchor = 0): PlanContext => ({ zone, anchor });
const next = (plan: unknown, after: string, zone = shanghai, anchor = 0) =>
  iso(nextFire(plan as never, at(after), ctx(zone, anchor)));
const validate = (plan: unknown, zone = shanghai) =>
  validatePlan(plan, { zone, now: at("2026-10-25T00:00:00Z") });

describe("validatePlan：七种计划", () => {
  it("合法计划原样规范化", () => {
    expect(validate({ type: "interval", minutes: 30 })).toEqual({ type: "interval", minutes: 30 });
    expect(validate({ type: "hourly" })).toEqual({ type: "hourly" });
    expect(validate({ type: "daily", time: "09:00" })).toEqual({ type: "daily", time: "09:00" });
    expect(validate({ type: "weekdays", time: "23:59" })).toEqual({
      type: "weekdays",
      time: "23:59",
    });
    expect(validate({ type: "weekly", day: "mon", time: "10:00" })).toEqual({
      type: "weekly",
      day: "mon",
      time: "10:00",
    });
    expect(validate({ type: "manual" })).toEqual({ type: "manual" });
    expect(validate({ type: "cron", expr: "  0   9 * *  1-5 " })).toEqual({
      type: "cron",
      expr: "0 9 * * 1-5",
    });
  });

  it.each([
    [{ type: "interval", minutes: 29 }, "最小间隔"],
    [{ type: "interval", minutes: 0 }, "最小间隔"],
    [{ type: "interval", minutes: 45.5 }, "整数"],
    [{ type: "interval", minutes: "30" }, "整数"],
    [{ type: "interval", minutes: 600_000 }, "太长"],
    [{ type: "daily", time: "9:00" }, "HH:MM"],
    [{ type: "daily", time: "24:00" }, "HH:MM"],
    [{ type: "weekdays", time: "09:60" }, "HH:MM"],
    [{ type: "weekdays" }, "HH:MM"],
    [{ type: "weekly", day: "monday", time: "10:00" }, "星期"],
    [{ type: "weekly", time: "10:00" }, "星期"],
    [{ type: "hourly", minutes: 5 }, "未知字段"],
    [{ type: "yearly" }, "计划类型"],
    [{}, "计划类型"],
    ["daily", "对象"],
    [null, "对象"],
  ])("非法计划 %j → %s", (plan, hint) => {
    expect(() => validate(plan)).toThrow(ScheduleError);
    expect(() => validate(plan)).toThrow(hint);
  });

  it("interval 恰好 30 分钟合法", () => {
    expect(() => validate({ type: "interval", minutes: 30 })).not.toThrow();
  });
});

describe("cron：最小间隔按相邻两次触发校验", () => {
  it.each(["*/15 * * * *", "* * * * *", "0,20 * * * *", "*/29 * * * *"])("拒绝 %s", (expr) => {
    expect(() => validate({ type: "cron", expr })).toThrow("间隔不能小于 30 分钟");
  });

  it.each([
    "*/30 * * * *",
    "0,30 * * * *",
    "0 * * * *",
    "0 9 * * 1-5",
    "15 3 1 * *",
    "0 0 29 2 *",
    "0 8-18/2 * * *",
  ])("接受 %s", (expr) => {
    expect(() => validate({ type: "cron", expr })).not.toThrow();
  });

  it("跨天的间隔也算：23:50 与次日 00:10 相隔 20 分钟", () => {
    expect(() => validate({ type: "cron", expr: "50 23 * * *" })).not.toThrow();
    expect(() => validate({ type: "cron", expr: "10,50 0,23 * * *" })).toThrow("间隔不能小于");
  });

  it("日与星期都限定时是「或」：15 号遇上周日 23:50 再到周一 00:10 只隔 20 分钟", () => {
    expect(() => validate({ type: "cron", expr: "50 23 15 * *" })).not.toThrow();
    expect(() => validate({ type: "cron", expr: "10,50 0,23 15 * 1" })).toThrow("间隔不能小于");
  });

  it("表达式语法错误给出可读信息", () => {
    expect(() => validate({ type: "cron", expr: "0 9 * *" })).toThrow("五段");
    expect(() => validate({ type: "cron", expr: "61 * * * *" })).toThrow("超出范围");
    expect(() => validate({ type: "cron", expr: "* * * * FOO" })).toThrow("无法识别");
    expect(() => validate({ type: "cron", expr: "*/0 * * * *" })).toThrow("步长");
    expect(() => validate({ type: "cron", expr: "5-1 * * * *" })).toThrow("起点大于终点");
    expect(() => validate({ type: "cron", expr: 5 })).toThrow("字符串");
  });
});

describe("parseCron", () => {
  it("星期 0 和 7 都是周日；名称不分大小写", () => {
    expect([...parseCron("0 0 * * 7").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * sun,MON").dayOfWeek].sort()).toEqual([0, 1]);
    expect([...parseCron("0 0 1 JAN,mar *").months].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("步长：* 与范围与起点", () => {
    expect(parseCron("*/20 * * * *").minutes).toEqual([0, 20, 40]);
    expect(parseCron("10-30/10 * * * *").minutes).toEqual([10, 20, 30]);
    expect(parseCron("50/5 * * * *").minutes).toEqual([50, 55]);
  });

  it("CronError 是 Error", () => {
    expect(() => parseCron("")).toThrow(CronError);
  });
});

describe("nextFire：本地时间（Asia/Shanghai，UTC+8）", () => {
  it("daily：今天还没到点就是今天，过了就是明天", () => {
    const plan = { type: "daily", time: "09:00" };
    expect(next(plan, "2026-10-25T00:59:59Z")).toBe("2026-10-25T01:00:00.000Z");
    expect(next(plan, "2026-10-25T01:00:00Z")).toBe("2026-10-26T01:00:00.000Z");
  });

  it("weekdays：周五之后跳到周一，周末不触发", () => {
    const plan = { type: "weekdays", time: "09:00" };
    // 2026-10-23 是周五
    expect(next(plan, "2026-10-23T00:00:00Z")).toBe("2026-10-23T01:00:00.000Z");
    expect(next(plan, "2026-10-23T01:00:00Z")).toBe("2026-10-26T01:00:00.000Z");
    expect(next(plan, "2026-10-24T05:00:00Z")).toBe("2026-10-26T01:00:00.000Z");
    expect(next(plan, "2026-10-26T01:00:00Z")).toBe("2026-10-27T01:00:00.000Z");
  });

  it("weekdays：用的是本地星期而不是 UTC 星期", () => {
    // 周一 07:00 本地 = 周日 23:00 UTC
    const plan = { type: "weekdays", time: "07:00" };
    expect(next(plan, "2026-10-25T00:00:00Z")).toBe("2026-10-25T23:00:00.000Z");
  });

  it("weekly：每周指定的一天", () => {
    const plan = { type: "weekly", day: "mon", time: "10:00" };
    expect(next(plan, "2026-10-25T00:00:00Z")).toBe("2026-10-26T02:00:00.000Z");
    expect(next(plan, "2026-10-26T02:00:00Z")).toBe("2026-11-02T02:00:00.000Z");
    expect(next({ type: "weekly", day: "sun", time: "10:00" }, "2026-10-25T02:00:00Z")).toBe(
      "2026-11-01T02:00:00.000Z",
    );
  });

  it("hourly：每个本地整点；半小时偏移的时区（Asia/Kolkata）落在 UTC 的 :30", () => {
    expect(next({ type: "hourly" }, "2026-10-25T01:20:00Z")).toBe("2026-10-25T02:00:00.000Z");
    expect(next({ type: "hourly" }, "2026-10-25T01:20:00Z", kolkata)).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("interval：以起算时刻为起点按间隔推，不受时区影响", () => {
    const anchor = at("2026-10-25T00:10:00Z");
    const plan = { type: "interval", minutes: 45 };
    expect(next(plan, "2026-10-25T00:00:00Z", shanghai, anchor)).toBe("2026-10-25T00:55:00.000Z");
    expect(next(plan, "2026-10-25T00:55:00Z", shanghai, anchor)).toBe("2026-10-25T01:40:00.000Z");
    expect(next(plan, "2026-10-25T01:00:00Z", shanghai, anchor)).toBe("2026-10-25T01:40:00.000Z");
  });

  it("manual 没有下一次", () => {
    expect(next({ type: "manual" }, "2026-10-25T00:00:00Z")).toBeUndefined();
  });

  it("触发时刻严格晚于 after", () => {
    const plan = { type: "daily", time: "09:00" };
    const first = nextFire(plan as never, at("2026-10-25T00:00:00Z"), ctx()) as number;
    expect(nextFire(plan as never, first, ctx())).toBeGreaterThan(first);
  });
});

describe("nextFire：cron", () => {
  it("工作日 09:00", () => {
    const plan = { type: "cron", expr: "0 9 * * 1-5" };
    expect(next(plan, "2026-10-23T01:00:00Z")).toBe("2026-10-26T01:00:00.000Z");
  });

  it("*/30：整点和半点", () => {
    const plan = { type: "cron", expr: "*/30 * * * *" };
    expect(next(plan, "2026-10-25T01:10:00Z")).toBe("2026-10-25T01:30:00.000Z");
    expect(next(plan, "2026-10-25T01:30:00Z")).toBe("2026-10-25T02:00:00.000Z");
  });

  it("列表与范围的组合", () => {
    const plan = { type: "cron", expr: "15,45 9-10 * * *" };
    const all = firesBetween(
      plan as never,
      at("2026-10-24T16:00:00Z"),
      at("2026-10-25T04:00:00Z"),
      ctx(),
    );
    expect(all.map((t) => new Date(t).toISOString())).toEqual([
      "2026-10-25T01:15:00.000Z",
      "2026-10-25T01:45:00.000Z",
      "2026-10-25T02:15:00.000Z",
      "2026-10-25T02:45:00.000Z",
    ]);
  });

  it("日与星期都限定：满足其一即触发；只限定一个则两者都要满足", () => {
    // 2026-11-01 周日；每月 1 号或周一
    const either = { type: "cron", expr: "0 12 1 * 1" };
    const days = firesBetween(
      either as never,
      at("2026-10-31T00:00:00Z"),
      at("2026-11-10T00:00:00Z"),
      ctx(utc),
    ).map((t) => new Date(t).toISOString().slice(0, 10));
    expect(days).toEqual(["2026-11-01", "2026-11-02", "2026-11-09"]);
    // 日是 *：星期必须满足
    const dowOnly = { type: "cron", expr: "0 12 * * 1" };
    const mondays = firesBetween(
      dowOnly as never,
      at("2026-10-31T00:00:00Z"),
      at("2026-11-10T00:00:00Z"),
      ctx(utc),
    ).map((t) => new Date(t).toISOString().slice(0, 10));
    expect(mondays).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("2 月 29 日：跳到下一个闰年", () => {
    expect(next({ type: "cron", expr: "0 0 29 2 *" }, "2026-10-25T00:00:00Z", utc)).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("永远不会发生的日期（2 月 30 日）没有下一次", () => {
    expect(next({ type: "cron", expr: "0 0 30 2 *" }, "2026-10-25T00:00:00Z", utc)).toBeUndefined();
  });
});

describe("夏令时（America/New_York）", () => {
  // 2026-03-08 02:00 EST 前拨到 03:00 EDT；2026-11-01 02:00 EDT 回拨到 01:00 EST
  it("春季前拨：不存在的 02:30 落在空档之后（03:30 EDT），其余日子照常 02:30", () => {
    const plan = { type: "daily", time: "02:30" };
    expect(next(plan, "2026-03-07T12:00:00Z", newYork)).toBe("2026-03-08T07:30:00.000Z");
    expect(next(plan, "2026-03-08T07:30:00Z", newYork)).toBe("2026-03-09T06:30:00.000Z");
  });

  it("春季前拨当天：每天 03:30 不会重复触发", () => {
    const fires = firesBetween(
      { type: "cron", expr: "30 2,3 * * *" } as never,
      at("2026-03-07T12:00:00Z"),
      at("2026-03-09T12:00:00Z"),
      ctx(newYork),
    ).map((t) => new Date(t).toISOString());
    expect(fires).toEqual([
      "2026-03-08T07:30:00.000Z", // 02:30 → 03:30 EDT，与 03:30 合并
      "2026-03-09T06:30:00.000Z",
      "2026-03-09T07:30:00.000Z",
    ]);
  });

  it("秋季回拨：重复出现的 01:30 只取第一次", () => {
    const plan = { type: "daily", time: "01:30" };
    expect(next(plan, "2026-10-31T12:00:00Z", newYork)).toBe("2026-11-01T05:30:00.000Z");
    // 第二次出现的 01:30 EST（06:30Z）不触发；下一次是次日
    expect(next(plan, "2026-11-01T05:30:00Z", newYork)).toBe("2026-11-02T06:30:00.000Z");
  });

  it("每天 09:00 的 UTC 时刻随夏令时变化", () => {
    const plan = { type: "daily", time: "09:00" };
    expect(next(plan, "2026-11-01T00:00:00Z", newYork)).toBe("2026-11-01T14:00:00.000Z");
    expect(next(plan, "2026-10-31T14:00:00Z", newYork)).toBe("2026-11-01T14:00:00.000Z");
    expect(next(plan, "2026-10-30T14:00:00Z", newYork)).toBe("2026-10-31T13:00:00.000Z");
  });

  it("*/30 在 23 小时的前拨日有 46 次，在 25 小时的回拨日仍是 48 次（重复的小时不再触发）", () => {
    const plan = { type: "cron", expr: "*/30 * * * *" } as never;
    const dayStart = (iso: string) => at(iso);
    const spring = firesBetween(
      plan,
      dayStart("2026-03-08T05:00:00Z") - 1,
      dayStart("2026-03-09T04:00:00Z") - 1,
      ctx(newYork),
    );
    expect(spring).toHaveLength(46);
    const fall = firesBetween(
      plan,
      dayStart("2026-11-01T04:00:00Z") - 1,
      dayStart("2026-11-02T05:00:00Z") - 1,
      ctx(newYork),
    );
    expect(fall).toHaveLength(48);
    // 严格递增、无重复
    for (const list of [spring, fall])
      for (let i = 1; i < list.length; i++)
        expect(list[i] as number).toBeGreaterThan(list[i - 1] as number);
  });

  it("hourly 在前拨日不重复触发 03:00", () => {
    const fires = firesBetween(
      { type: "hourly" },
      at("2026-03-08T05:00:00Z") - 1,
      at("2026-03-08T09:00:00Z"),
      ctx(newYork),
    ).map((t) => new Date(t).toISOString());
    expect(fires).toEqual([
      "2026-03-08T05:00:00.000Z", // 00:00 EST
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T07:00:00.000Z", // 02:00 不存在 → 03:00 EDT
      "2026-03-08T08:00:00.000Z", // 04:00 EDT
      "2026-03-08T09:00:00.000Z", // 05:00 EDT
    ]);
  });

  it("cron 的最小间隔校验在前拨日不会误判", () => {
    expect(() => validate({ type: "cron", expr: "0,30 2 * * *" }, newYork)).not.toThrow();
  });
});
