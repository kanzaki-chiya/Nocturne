/**
 * 成员会话标签的会话句柄（ADR-0089 §8）：Ensemble 存续期间用幂等的 `session.open`
 * 打开成员的子会话（rpc.md 第 3.2 节），折叠自己的 `SessionView`，并向
 * `Conversation` / `Composer` 提供与普通会话一致的属性。
 *
 * 关闭成员标签只释放本连接对子会话的引用（`session.close`），绝不
 * `session.interrupt`：成员可能仍在工作，中断要由用户在确认框里显式发起。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSessionView,
  reduceSessionView,
  type ExternalAgentOverview,
  type PendingInputsSnapshot,
  type RuntimeEvent,
  type SessionView,
  type SkillOverview,
} from "@nocturne/core/protocol";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

/** 成员会话的技能摘要（与 Composer 的 skills 入参同形） */
export type SkillSummary = SkillOverview;

/** 成员会话可斜杠点名/委派的外部 agent（与 Composer 的 externalAgents 入参同形） */
export type ExternalAgentSummary = ExternalAgentOverview;

export interface EnsembleMemberSessionOptions {
  /** 桌面端后台池：与指挥会话共用同一个后台（ADR-0051） */
  ensureClient: () => Promise<RpcClient>;
  /** 成员的子会话 id（`SessionView.ensemble.members[].childSessionId`） */
  childSessionId: string;
  /** 打开结果缺少 cwd 时的回退（指挥会话的工作区） */
  fallbackCwd: string;
}

export interface EnsembleMemberSessionReady {
  status: "ready";
  session: RpcSession;
  cwd: string;
  shellKind?: string | undefined;
  view: SessionView;
  /** 每次折叠后 +1：界面据此重算依赖视图的派生数据 */
  version: number;
  /** 成员正在跑（非空闲或已有进行中的 Turn） */
  running: boolean;
  /** 需要禁用发送与切换控件：运行中或等待确认/回答 */
  busy: boolean;
  pendingInputs: PendingInputsSnapshot;
  skills: SkillSummary[];
  externalAgents: ExternalAgentSummary[];
  /** 供 `Conversation` 的思考计时等同会话事件的消费者订阅 */
  subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void;
}

export type EnsembleMemberSessionState =
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | EnsembleMemberSessionReady;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 打开并管理一名活动 Ensemble 成员的子会话。
 *
 * 回放期间只折叠、不逐条渲染；`session.subscribe` 返回后统一刷新一次。
 * `pendingInputs` / 技能 / 外部 agent / shell 是临时或运行期状态，订阅后
 * 各取一次对齐（失败静默降级，界面按缺省处理）。
 */
export function useEnsembleMemberSession(
  options: EnsembleMemberSessionOptions,
): EnsembleMemberSessionState {
  const { ensureClient, childSessionId, fallbackCwd } = options;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EnsembleMemberSessionState>({ status: "loading" });
  const listeners = useRef(new Set<(event: RuntimeEvent) => void>());
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);
  const subscribeEvents = useCallback((listener: (event: RuntimeEvent) => void) => {
    const current = listeners.current;
    current.add(listener);
    return () => {
      current.delete(listener);
    };
  }, []);
  // 打开参数变化不该重开会话：回调与回退目录取最新值，只有会话 id 变化才重开
  const latest = useRef({ ensureClient, fallbackCwd });
  useEffect(() => {
    latest.current = { ensureClient, fallbackCwd };
  }, [ensureClient, fallbackCwd]);

  useEffect(() => {
    let disposed = false;
    /** 回放结束（subscribe 返回）前只折叠，不逐条渲染 */
    let live = false;
    let session: RpcSession | undefined;
    let stopSubscription: (() => Promise<void>) | undefined;
    const view = createSessionView();
    let pendingInputs: PendingInputsSnapshot = { items: [], paused: false };
    let skills: SkillSummary[] = [];
    let externalAgents: ExternalAgentSummary[] = [];
    let shellKind: string | undefined;
    let cwd = latest.current.fallbackCwd;
    let version = 0;

    const publish = (): void => {
      if (disposed || session === undefined) return;
      version += 1;
      const running = view.status !== "idle" || view.currentTurn !== undefined;
      setState({
        status: "ready",
        session,
        cwd,
        ...(shellKind !== undefined ? { shellKind } : {}),
        view,
        version,
        running,
        busy: running || view.pendingPermission !== undefined || view.pendingQuestion !== undefined,
        pendingInputs,
        skills,
        externalAgents,
        subscribeEvents,
      });
    };

    /** 卸载标记由清理函数改写：包一层读取，避免控制流把它当成常量 */
    const unmounted = (): boolean => disposed;

    const open = async (): Promise<void> => {
      try {
        const client = await latest.current.ensureClient();
        // 幂等打开（rpc.md 3.2）：复用 Runtime 托管的同一常驻子会话实例
        const opened = await client.call("session.open", { sessionId: childSessionId });
        const handle = client.session(opened.sessionId);
        session = handle;
        cwd = opened.meta.cwd === "" ? latest.current.fallbackCwd : opened.meta.cwd;
        if (disposed) {
          // 关闭标签发生在打开途中：句柄已建立，释放引用后退出
          await handle.close().catch(() => undefined);
          return;
        }
        const subscription = await handle.subscribe((event) => {
          reduceSessionView(view, event);
          if (event.type === "input.pending") pendingInputs = event.payload;
          for (const listener of [...listeners.current]) {
            try {
              listener(event);
            } catch {
              // 订阅者异常不影响视图折叠（events.md 第 6 节）
            }
          }
          if (live) publish();
        });
        stopSubscription = () => subscription.unsubscribe();
        live = true;
        if (unmounted()) {
          // 卸载发生在订阅途中：清理已关闭会话句柄，这里只退订
          await stopSubscription().catch(() => undefined);
          return;
        }
        publish();
        // 临时/运行期状态不回放：订阅后各取一次对齐，失败按缺省处理
        void handle
          .pendingInputs()
          .then((snapshot) => {
            if (disposed) return;
            pendingInputs = snapshot;
            publish();
          })
          .catch(() => undefined);
        void handle
          .describeSkills()
          .then((result) => {
            if (disposed) return;
            skills = result.skills;
            publish();
          })
          .catch(() => undefined);
        void handle
          .describeExternalAgents()
          .then((result) => {
            if (disposed) return;
            externalAgents = result.agents;
            publish();
          })
          .catch(() => undefined);
        void handle
          .shellInfo()
          .then((info) => {
            if (disposed) return;
            shellKind = info.effective?.kind;
            publish();
          })
          .catch(() => undefined);
      } catch (error) {
        if (disposed) return;
        setState({ status: "error", message: errorText(error), retry });
      }
    };

    setState({ status: "loading" });
    void open();

    return () => {
      disposed = true;
      void (async () => {
        await stopSubscription?.().catch(() => undefined);
        // 关闭标签只释放本连接的引用；成员可能仍在工作，绝不 interrupt
        if (session !== undefined) await session.close().catch(() => undefined);
      })();
    };
  }, [attempt, childSessionId, retry, subscribeEvents]);

  return state;
}
