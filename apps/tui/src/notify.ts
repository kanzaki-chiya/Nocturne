/**
 * 通知响铃（ADR-0056 §3，TUI 自有一份判定）：终端没在看时，三类事件各响
 * 一次终端响铃（BEL）——
 *   需要确认：`permission.requested`、`question.requested`；
 *   出错停止：`turn.completed` 且 `reason === "error"`，不看用时；
 *   完成：其余非中断结束，用时 ≥ `notifications.doneAfterSeconds`（等于阈值也
 *     提醒）；用户中断（`reason === "aborted"`）与恢复补写（`recovered`）永不提醒。
 * 「没在看」= 终端失焦，或从未收到过焦点回送（终端不支持焦点报告）。
 *
 * 只对本次运行实时到达的事件判定：恢复会话读到的事件不经过 subscribe，
 * 恢复补写的事件另有 `recovered` 标记挡掉；恢复中途接手的进行中 Turn
 * 按日志里未闭合的 `turn.started` 计时。`notifications.sound` 不影响 TUI
 * （铃声由终端 bellStyle 决定）；不做 OSC 9 与系统通知。
 */
import { useEffect, useRef } from "react";

import type { Runtime, RuntimeEvent, RuntimeSession } from "@nocturne/core";

import type { FocusSource } from "./mouse.js";

/** 终端响铃；走帧外写出通道（cursor.ts 的 writeOob），不打乱全屏同步帧。 */
export const BELL = "\x07";

export interface NotifySettings {
  enabled: boolean;
  attention: boolean;
  error: boolean;
  done: boolean;
  /** 完成提醒的用时阈值（秒）；与 Core 缺省一致 */
  doneAfterSeconds: number;
}

/** 与 Core 的缺省一致：总开关与三类事件全开、阈值 60 秒 */
export const NOTIFY_DEFAULTS: NotifySettings = {
  enabled: true,
  attention: true,
  error: true,
  done: true,
  doneAfterSeconds: 60,
};

/**
 * 从 `Runtime.describeSettings()` 的六个逐字段条目读生效值。
 * 设置保存后 `describeSettings()` 立即反映新值，因此判定时每次重读
 * 即已热更新（写在 /settings 或别处改过都算）。
 */
export function readNotifySettings(runtime: Runtime): NotifySettings {
  const items = runtime.describeSettings();
  const value = (key: string): string | undefined =>
    items.find((item) => item.key === key)?.effective;
  const doneAfterSeconds = Number(value("notifications.doneAfterSeconds"));
  return {
    enabled: value("notifications.enabled") !== "false",
    attention: value("notifications.events.attention") !== "false",
    error: value("notifications.events.error") !== "false",
    done: value("notifications.events.done") !== "false",
    doneAfterSeconds:
      Number.isInteger(doneAfterSeconds) && doneAfterSeconds >= 0
        ? doneAfterSeconds
        : NOTIFY_DEFAULTS.doneAfterSeconds,
  };
}

export type NotifyCategory = "attention" | "error" | "done";

/**
 * 判定该不该响：没在看 + 事件属于开着且够格的类别。
 * `turnStartedAt` 是该事件所属 Turn 的开始毫秒时间戳（来自 `turn.started`）；
 * 拿不到起点（没有对应 `turn.started`）时完成一类不提醒。
 */
export function shouldRing(
  event: RuntimeEvent,
  context: { focused: boolean; turnStartedAt?: number | undefined },
  settings: NotifySettings,
): NotifyCategory | undefined {
  if (!settings.enabled || context.focused) return undefined;
  switch (event.type) {
    case "permission.requested":
    case "question.requested":
      return settings.attention ? "attention" : undefined;
    case "turn.completed": {
      if (event.payload.recovered === true) return undefined;
      if (event.payload.reason === "error") return settings.error ? "error" : undefined;
      if (event.payload.reason === "aborted") return undefined;
      if (!settings.done || context.turnStartedAt === undefined) return undefined;
      const durationMs = Date.parse(event.time) - context.turnStartedAt;
      return durationMs >= settings.doneAfterSeconds * 1000 ? "done" : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 未闭合 Turn 的开始时间（turnId → 毫秒）：从日志里恢复——会话中途接手
 * 的 Turn 也能算用时；重放的事件只用于计时，不触发提醒。
 */
export function openTurnStarts(events: readonly RuntimeEvent[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const event of events) {
    if (event.turnId === undefined) continue;
    if (event.type === "turn.started") open.set(event.turnId, Date.parse(event.time));
    else if (event.type === "turn.completed") open.delete(event.turnId);
  }
  return open;
}

/**
 * 挂上响铃：会话实时事件 → 判定 → 帧外写出 BEL。会话切换（/resume、/new）
 * 时重建；焦点源缺省（测试未注入）时按没在看处理。
 */
export function useNotifyBell({
  session,
  runtime,
  focus,
  writeOob,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  focus?: FocusSource | undefined;
  writeOob?: ((data: string) => boolean) | undefined;
}): void {
  useEffect(() => {
    const open = openTurnStarts(session.durableEvents());
    return session.subscribe((event) => {
      if (event.type === "turn.started") {
        if (event.turnId !== undefined) open.set(event.turnId, Date.parse(event.time));
        return;
      }
      if (
        event.type !== "permission.requested" &&
        event.type !== "question.requested" &&
        event.type !== "turn.completed"
      ) {
        return;
      }
      const turnStartedAt = event.turnId !== undefined ? open.get(event.turnId) : undefined;
      const category = shouldRing(
        event,
        { focused: focus?.focused() === true, turnStartedAt },
        readNotifySettings(runtime),
      );
      if (event.type === "turn.completed" && event.turnId !== undefined) open.delete(event.turnId);
      if (category !== undefined) writeOob?.(BELL);
    });
  }, [session, runtime, focus, writeOob]);
}

/**
 * 成员待确认响铃判定（ADR-0089 §8）：指挥会话的 `ensemble.member_updated` 带成员的
 * `pendingPermissions`；订阅起始快照（`eseq === 0`）里已有的请求只登记，之后真正新出现的
 * requestId 才按「需要确认」一类判定一次。`viewing` 是正在显示的成员：它自己的
 * `permission.requested` 已由 useNotifyBell 判定，这里不重复响。
 */
export function ensembleMemberRing(
  event: RuntimeEvent,
  seen: Set<string>,
  context: { focused: boolean; viewing?: string | undefined },
  settings: NotifySettings,
): boolean {
  if (event.type === "ensemble.ended") {
    seen.clear();
    return false;
  }
  if (event.type !== "ensemble.member_updated") return false;
  const pending = event.payload.pendingPermissions ?? [];
  if (event.eseq === 0) {
    for (const p of pending) seen.add(p.requestId);
    return false;
  }
  const fresh = pending.filter((p) => !seen.has(p.requestId));
  for (const p of fresh) seen.add(p.requestId);
  if (fresh.length === 0 || event.payload.name === context.viewing) return false;
  // 与 permission.requested 同属「需要确认」一类
  return settings.enabled && settings.attention && !context.focused;
}

/** 挂上成员待确认响铃：订阅指挥会话，规则见 ensembleMemberRing */
export function useEnsembleMemberBell({
  session,
  runtime,
  focus,
  writeOob,
  viewing,
}: {
  session: RuntimeSession;
  runtime: Runtime;
  focus?: FocusSource | undefined;
  writeOob?: ((data: string) => boolean) | undefined;
  viewing?: string | undefined;
}): void {
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  useEffect(() => {
    const seen = new Set<string>();
    return session.subscribe((event) => {
      if (
        ensembleMemberRing(
          event,
          seen,
          { focused: focus?.focused() === true, viewing: viewingRef.current },
          readNotifySettings(runtime),
        )
      )
        writeOob?.(BELL);
    });
  }, [session, runtime, focus, writeOob]);
}
