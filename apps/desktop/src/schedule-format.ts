/**
 * 定时任务页与会话来源标注的展示文案（ADR-0064）。时间用运行环境的本地时区。
 */
import type {
  ScheduleHistoryEntry,
  ScheduleRunResult,
  ScheduleSkipReason,
  ScheduleTrigger,
} from "@nocturne/core/protocol";

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `今天 09:03` / `昨天 09:00` / `周一 10-27 09:00` */
export function formatScheduleWhen(iso: string | undefined, now = new Date()): string {
  if (iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const day = startOf(date).getTime();
  const today = startOf(now).getTime();
  if (day === today) return `今天 ${clock}`;
  if (day === today - 86_400_000) return `昨天 ${clock}`;
  return `${WEEK[date.getDay()] ?? ""} ${date.getMonth() + 1}-${pad(date.getDate())} ${clock}`;
}

/** 统计用「2 分 40 秒」；不足一分钟只写秒 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${pad(seconds)} 秒`;
}

/** 历史表用时 `2:41` */
export function formatDurationClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export function scheduleResultLabel(result: ScheduleRunResult): string {
  switch (result) {
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "error":
      return "出错";
    case "aborted":
      return "已中断";
    case "skipped":
      return "跳过";
  }
}

export function scheduleSkipLabel(reason: ScheduleSkipReason | undefined): string {
  switch (reason) {
    case "previous_running":
      return "上一次还在运行";
    case "concurrency":
      return "同时运行的任务已满 2 个";
    case "missed":
      return "错过，只补最近一次";
    default:
      return "跳过";
  }
}

export function scheduleTriggerLabel(trigger: ScheduleTrigger | undefined): string {
  switch (trigger) {
    case "schedule":
      return "计划";
    case "catchup":
      return "补跑";
    case "manual":
      return "手动";
    default:
      return "—";
  }
}

/** 补跑时加在第一条用户消息前面的说明 */
export function catchupPreface(scheduledAt: string, now = new Date()): string | undefined {
  return `原计划 ${formatScheduleWhen(scheduledAt, now)}，当时 Nocturne 没开，现在补跑。`;
}

/** 列表与统计里的「上次运行」 */
export function describeLastRun(entry: ScheduleHistoryEntry | undefined, now = new Date()): string {
  if (entry === undefined) return "还没运行过";
  const when = formatScheduleWhen(entry.endedAt ?? entry.startedAt ?? entry.scheduledAt, now);
  const result = scheduleResultLabel(entry.result);
  const extra =
    entry.result === "done" && (entry.denied ?? 0) > 0
      ? `（${entry.denied} 项被拒绝）`
      : entry.result === "error" && entry.error !== undefined
        ? `（${entry.error}）`
        : entry.trigger === "catchup" && entry.result === "done"
          ? "（补跑）"
          : entry.result === "skipped"
            ? `（${scheduleSkipLabel(entry.reason)}）`
            : "";
  return `${when} · ${result}${extra}`;
}
