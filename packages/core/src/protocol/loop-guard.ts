/**
 * 重复调用保护（ADR-0063）：签名、连续计数与说明文案。
 *
 * 纯函数、无 Node 内置依赖。Agent Loop 与 Context Builder 用同一份实现：
 * Loop 用它决定何时以 loop_detected 结束 Turn，Builder 用它从持久事件
 * 确定性地重建"第 warnAt 次之后"的系统说明——同一份历史在两边得到同样的
 * 签名与计数，回放与恢复也一致。
 *
 * 签名 = 工具名 + 规范化入参（JSON 键排序后序列化）+ 结果正文的哈希。
 * 只看签名，不按工具名分支；参数解析失败（只有原文）时用原文参与签名。
 */
import type { DurableEvent } from "./events.js";
import type { ToolCallRef } from "./types.js";
import { effectiveEvents } from "./rewind.js";

/** 重复调用保护的生效值（context.md 第 3 节、config.md 第 2 节） */
export interface LoopGuardConfig {
  /** 连续相同签名达到该次数时，在该工具结果后附系统说明；至少 2 */
  warnAt: number;
  /** 连续相同签名达到该次数时以 loop_detected 结束 Turn；必须大于 warnAt */
  stopAt: number;
}

/** `turn.loopGuard` 缺省值：第 3 次提醒，第 6 次停止 */
export const DEFAULT_LOOP_GUARD: LoopGuardConfig = { warnAt: 3, stopAt: 6 };

/** 连续相同签名的运行状态；签名不同即重置（只穿插模型文本/推理不重置） */
export interface LoopGuardRun {
  signature: string;
  /** 含本次在内的连续次数 */
  count: number;
}

/**
 * 规范化序列化：对象键排序、丢弃 undefined、数组保持顺序。
 * 同一组参数无论键的书写顺序如何都得到同一个字符串。
 */
export function canonicalLoopInput(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalLoopInput(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalLoopInput(item)}`);
    return `{${entries.join(",")}}`;
  }
  // 函数、symbol 等不可序列化的值等价于不存在
  return "null";
}

/**
 * 结果正文的哈希：cyrb53，53 位、无外部依赖。
 * 只用于判断两次结果是否一字不差，不作为安全哈希。
 */
export function hashLoopResult(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 一次工具调用的入参部分：`message.assistant.toolCalls` 里模型给出的入参；
 * 参数解析失败、只有原文时用原文。两侧都只用持久化数据，保证重建一致。
 */
export function loopGuardArgs(call: Pick<ToolCallRef, "input" | "rawInput">): string {
  return call.input !== undefined ? canonicalLoopInput(call.input) : (call.rawInput ?? "");
}

/** 工具名 + 入参 + 结果正文哈希（结果正文 = tool.completed.modelContent） */
export function loopGuardSignature(name: string, args: string, resultBody: string): string {
  return `${name}\u0000${args}\u0000${hashLoopResult(resultBody)}`;
}

/** 推进连续计数：签名相同则累加，否则从 1 重新开始 */
export function advanceLoopGuard(run: LoopGuardRun | undefined, signature: string): LoopGuardRun {
  if (run?.signature === signature) return { signature, count: run.count + 1 };
  return { signature, count: 1 };
}

/**
 * 第 `warnAt` 次之后附在工具结果后的系统说明（英文，context.md 第 3 节）。
 * 文案只由工具名与次数决定，不含阈值与时间，同一份历史重建结果一字不差。
 */
export function loopGuardNoteText(name: string, count: number): string {
  return (
    `[Loop guard] In this turn, the tool "${name}" has returned an identical result ` +
    `${count} times in a row with identical arguments. Repeating this call will not produce ` +
    `new information: change the approach, or stop and explain the situation to the user. ` +
    `If the same call keeps returning the same result, the runtime will end this turn.`
  );
}

/** 一条需要附说明的调用（tool.completed 的 seq） */
export interface LoopGuardWarning {
  seq: number;
  callId: string;
  name: string;
  count: number;
  /** 附在结果正文之后的说明（含前导空行） */
  text: string;
}

/**
 * 从持久事件确定性地推出全部循环说明（context.md 第 3 节）：
 * 只在同一 Turn 内按 tool.completed 的顺序数连续相同签名，签名不同即重置，
 * 只穿插模型文本或推理不重置。每段连续重复只在第 `warnAt` 次附一次说明。
 * 关闭（config 为 false）时返回空列表。
 */
export function loopGuardWarnings(
  events: readonly DurableEvent[],
  config: LoopGuardConfig | false | undefined,
): LoopGuardWarning[] {
  if (config === false) return [];
  const { warnAt } = config ?? DEFAULT_LOOP_GUARD;
  const argsByCall = new Map<string, string>();
  const warnings: LoopGuardWarning[] = [];
  let run: LoopGuardRun | undefined;
  for (const event of effectiveEvents(events)) {
    switch (event.type) {
      case "turn.started":
      case "turn.completed":
        run = undefined;
        break;
      case "message.assistant": {
        for (const call of event.payload.toolCalls)
          argsByCall.set(call.callId, loopGuardArgs(call));
        break;
      }
      case "tool.completed": {
        const p = event.payload;
        // 取消/恢复补写的结算不是工具"返回的结果"（正文是结算说明），
        // 两侧都不计数：Agent Loop 只在真正执行的调用后判停，
        // 所以这里同样跳过，保证 Loop 与 Builder 的计数一致。
        if (p.status === "cancelled" || p.status === "interrupted") break;
        // 结果正文缺失（手工事件/异常日志）按空正文参与签名，不抛错
        const body = (p.modelContent as string | undefined) ?? "";
        const signature = loopGuardSignature(p.name, argsByCall.get(p.callId) ?? "", body);
        run = advanceLoopGuard(run, signature);
        if (run.count === warnAt) {
          warnings.push({
            seq: event.seq,
            callId: p.callId,
            name: p.name,
            count: run.count,
            text: `\n\n${loopGuardNoteText(p.name, run.count)}`,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return warnings;
}

/** tool.completed 的 seq → 附在其后的说明（Builder 投影用） */
export function loopGuardNotes(
  events: readonly DurableEvent[],
  config: LoopGuardConfig | false | undefined,
): Map<number, string> {
  return new Map(loopGuardWarnings(events, config).map((w) => [w.seq, w.text]));
}
