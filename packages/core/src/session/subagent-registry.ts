/**
 * Runtime 级子会话观察登记簿（rpc.md 4.1、subagent.md 12.1）：
 * 与运行级 limiter 同寿命，注入所有 launcher（嵌套递归共享）。
 * 活动项不落盘；launcher 在 SessionEnd、写入落定与 child.close 之后才调用
 * end()，由此给观察者排入终止标记并移除登记。观察者抛错或退出不影响运行。
 */
import type { DurableEvent, RuntimeEvent } from "../protocol/index.js";
import type { Session } from "./types.js";

export type ObservedSignal =
  { kind: "event"; event: RuntimeEvent } | { kind: "end"; endedAt: string };

/** 一个仍在运行的内置子会话的观察源 */
export interface ActiveSubagent {
  readonly parentSessionId: string;
  readonly callId: string;
  readonly childSessionId: string;
  readonly background: boolean;
  readonly profile: string;
  readonly taskSummary: string;
  readonly startedAt: string;
  /** 子会话已提交的全部持久事件（只读视图） */
  durableEvents(): readonly DurableEvent[];
  /**
   * 同步取得观察源：先挂监听，再复制已提交前缀，两步之间没有异步间隙，
   * 所以任何持久事件要么在前缀里、要么经监听到达，不丢不重。
   * 登记项已结束时返回 undefined。
   */
  attach(
    listener: (signal: ObservedSignal) => void,
  ): { prefix: DurableEvent[]; detach(): void } | undefined;
}

export interface SubagentRegistration {
  /** 发终止标记并移除登记；幂等 */
  end(): void;
}

export interface SubagentRegistry {
  /** 子创建事件提交后、执行与进度转发前登记 */
  register(input: {
    child: Session;
    parentSessionId: string;
    callId: string;
    profile: string;
    taskSummary: string;
    background?: boolean;
  }): SubagentRegistration;
  find(childSessionId: string): ActiveSubagent | undefined;
  activeOf(parentSessionId: string): ActiveSubagent[];
  /** 登记本 Runtime 打开的会话，供查询父调用时直接读已提交事件；返回撤销函数 */
  trackSession(session: Session): () => void;
  /** 已打开的顶层会话或仍在运行的子会话 */
  liveSession(sessionId: string): Session | undefined;
}

export function createSubagentRegistry(): SubagentRegistry {
  const active = new Map<string, ActiveSubagent & { child: Session }>();
  const sessions = new Map<string, Session>();

  return {
    register({ child, parentSessionId, callId, profile, taskSummary, background = false }) {
      const listeners = new Set<(signal: ObservedSignal) => void>();
      let ended = false;
      const deliver = (signal: ObservedSignal): void => {
        for (const listener of [...listeners]) {
          try {
            listener(signal);
          } catch {
            // 观察者抛错不影响运行与其他观察者
          }
        }
      };
      const unsubscribeChild = child.subscribe((event) => {
        if (!ended) deliver({ kind: "event", event });
      });
      const entry: ActiveSubagent & { child: Session } = {
        child,
        parentSessionId,
        callId,
        childSessionId: child.id,
        profile,
        background,
        taskSummary,
        startedAt: child.durableEvents()[0]?.time ?? new Date().toISOString(),
        durableEvents: () => child.durableEvents(),
        attach(listener) {
          if (ended) return undefined;
          listeners.add(listener);
          return {
            prefix: [...child.durableEvents()],
            detach: () => {
              listeners.delete(listener);
            },
          };
        },
      };
      active.set(child.id, entry);
      return {
        end() {
          if (ended) return;
          ended = true;
          unsubscribeChild();
          if (active.get(child.id) === entry) active.delete(child.id);
          deliver({ kind: "end", endedAt: new Date().toISOString() });
          listeners.clear();
        },
      };
    },
    find: (childSessionId) => active.get(childSessionId),
    activeOf: (parentSessionId) =>
      [...active.values()].filter((entry) => entry.parentSessionId === parentSessionId),
    trackSession(session) {
      sessions.set(session.id, session);
      return () => {
        if (sessions.get(session.id) === session) sessions.delete(session.id);
      };
    },
    liveSession: (sessionId) => sessions.get(sessionId) ?? active.get(sessionId)?.child,
  };
}
