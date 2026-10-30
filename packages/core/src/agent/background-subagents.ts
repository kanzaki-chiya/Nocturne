/**
 * 后台子代理（ADR-0073）：准入、收束交付、取消与重启补报集中在这里，
 * 后续工作树隔离只在这三个接缝上扩展（第 8 节）。
 */
import {
  effectiveEvents,
  type DurableEvent,
  type PreparedInput,
  type SubagentResult,
} from "../protocol/index.js";
import type { SubagentOutcome, ToolDefinition } from "../tools/index.js";

/** 子代理的隔离方式；第一版只有「无」 */
export type BackgroundIsolation = "none";

export const BACKGROUND_READ_ONLY = "后台子代理只能只读；需要写入请同步调用";

/**
 * 准入接缝（ADR-0073 §2、§8）：外部 agent 一律不放行；没有隔离时只放行全部只读的工具集。
 * 返回拒绝说明，放行返回 undefined。
 */
export function backgroundAdmission(input: {
  tools: readonly Pick<ToolDefinition, "traits">[];
  isolation: BackgroundIsolation;
  external?: boolean | undefined;
}): string | undefined {
  if (input.external === true) return BACKGROUND_READ_ONLY;
  if (input.tools.some((tool) => tool.traits.mutates)) return BACKGROUND_READ_ONLY;
  return undefined;
}

interface Job {
  parentSessionId: string;
  childSessionId: string;
  callId: string;
  profile: string;
  controller: AbortController;
  startedAt: number;
  settled: Promise<void>;
  discard: boolean;
}

export function backgroundResultInput(meta: SubagentResult, text: string): PreparedInput {
  return {
    subagent: meta,
    content: [
      {
        type: "text",
        text: `<subagent-result id="${meta.childSessionId}" call="${meta.callId}" status="${meta.status}">\n${text}\n</subagent-result>`,
      },
    ],
    appended: [],
  };
}

function resultStatus(outcome: SubagentOutcome): SubagentResult["status"] {
  if (outcome.status === "ok") return "ok";
  const code = outcome.error.code;
  return code === "cancelled" || code === "timeout" ? code : "error";
}

function resultText(outcome: SubagentOutcome): string {
  if (outcome.status === "ok") return outcome.resultText;
  return outcome.tailText
    ? `${outcome.error.message}\n\n子会话没有提交结果，以下是它已有的产出（未完成，可能不完整，请自行核对）：\n${outcome.tailText}`
    : outcome.error.message;
}

/** 生命周期接缝（ADR-0073 §4、§8）：收束、取消、丢弃与重启补报 */
export class BackgroundSubagents {
  private readonly jobs = new Map<string, Job>();

  count(parentSessionId: string): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.parentSessionId === parentSessionId) n += 1;
    return n;
  }

  track(
    input: Pick<Job, "parentSessionId" | "childSessionId" | "callId" | "profile" | "controller">,
    run: () => Promise<SubagentOutcome>,
    deliver: (input: PreparedInput) => void | Promise<void>,
  ): void {
    const job: Job = {
      ...input,
      startedAt: Date.now(),
      discard: false,
      settled: Promise.resolve(),
    };
    this.jobs.set(job.childSessionId, job);
    job.settled = Promise.resolve()
      .then(run)
      .catch((cause: unknown): SubagentOutcome => ({
        status: "error",
        error: {
          code: "tool_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }))
      .then(async (outcome) => {
        if (job.discard) return;
        const code = outcome.status === "error" ? outcome.error.code : undefined;
        await deliver(
          backgroundResultInput(
            {
              childSessionId: job.childSessionId,
              callId: job.callId,
              status: resultStatus(outcome),
              ...(code !== undefined ? { code } : {}),
              profile: job.profile,
              durationMs: Date.now() - job.startedAt,
            },
            resultText(outcome),
          ),
        );
      })
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(job.childSessionId);
      });
  }

  /** 只对本父会话运行中的后台子代理有效；结果照常交付 cancelled */
  cancel(parentSessionId: string, childSessionId: string): boolean {
    const job = this.jobs.get(childSessionId);
    if (job?.parentSessionId !== parentSessionId || job.controller.signal.aborted) return false;
    job.controller.abort();
    return true;
  }

  /**
   * 取消且不交付：父会话关闭（keep 缺省）或回退到启动调用之前（keep = 仍保留的调用）。
   * 等子日志收束后才返回。
   */
  async discard(parentSessionId: string, keep?: ReadonlySet<string>): Promise<void> {
    const jobs = [...this.jobs.values()].filter(
      (job) => job.parentSessionId === parentSessionId && keep?.has(job.callId) !== true,
    );
    for (const job of jobs) {
      job.discard = true;
      job.controller.abort();
    }
    await Promise.all(jobs.map((job) => job.settled));
  }

  /**
   * 重启补报：父日志里启动过后台子代理、却没有对应结果消息的调用各补一条 interrupted。
   * 只读父日志；afterSeq 之前的调用（分叉继承的前缀）不补。
   */
  recover(log: readonly DurableEvent[], afterSeq = 0): PreparedInput[] {
    const events = effectiveEvents(log);
    const delivered = new Set<string>();
    const profiles = new Map<string, string>();
    for (const event of events) {
      if (event.type === "message.user" && event.payload.subagent !== undefined)
        delivered.add(event.payload.subagent.callId);
      if (event.type === "tool.started" && event.payload.name === "task") {
        const input = event.payload.input as { profile?: unknown } | undefined;
        profiles.set(
          event.payload.callId,
          typeof input?.profile === "string" ? input.profile : "default",
        );
      }
    }
    return events.flatMap((event) => {
      if (
        event.seq <= afterSeq ||
        event.type !== "tool.completed" ||
        event.payload.name !== "task" ||
        delivered.has(event.payload.callId)
      )
        return [];
      const output = event.payload.output as
        { background?: unknown; childSessionId?: unknown } | undefined;
      if (output?.background !== true || typeof output.childSessionId !== "string") return [];
      return [
        backgroundResultInput(
          {
            childSessionId: output.childSessionId,
            callId: event.payload.callId,
            status: "interrupted",
            profile: profiles.get(event.payload.callId) ?? "default",
          },
          "Background subagent was interrupted by a process restart; it produced no result.",
        ),
      ];
    });
  }
}
