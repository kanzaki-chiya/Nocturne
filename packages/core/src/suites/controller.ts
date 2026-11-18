/**
 * 组曲（Suite）指挥会话控制器（ADR-0097）：
 * 管理线程生命周期、常驻子会话懒打开、工作树增量检查点与并回、
 * 每轮自动汇报（`<thread-report>`）、状态广播、重启补报、用户直连动作与关闭收尾。
 */
import { clampReasoningEffort, type ResolvedModel } from "../provider/index.js";
import {
  computeSuiteThreadGroup,
  DEFAULT_SUBAGENT_PROFILE,
  firstSuiteLine,
  formatSuiteThreadReport,
  reduceSuiteDurable,
  summarizeSuiteToolCall,
  type ContentBlock,
  type DurableEvent,
  type DurablePayloadMap,
  type DurableType,
  type EphemeralPayloadMap,
  type EphemeralType,
  type ModelPricing,
  type ModelRef,
  type PreparedInput,
  type ReasoningEffort,
  type SubagentChanges,
  type SubagentProfileConfig,
  type SuiteActionSource,
  type SuiteRecord,
  type SuiteThreadPermission,
  type SuiteThreadReportStatus,
  type SuiteThreadStatus,
  type SuiteThreadUpdatedPayload,
  type SuiteThreadView,
  type SuiteToolActivity,
  type SuiteView,
  type SuiteWorktreeRef,
  type TurnEndReason,
} from "../protocol/index.js";
import type {
  ResidentChildOpenSpec,
  ResidentChildSession,
  ResidentWorktreeHandle,
  ResidentWorktreeOps,
} from "../resident/index.js";
import type { ToolDefinition } from "../tools/index.js";
import { buildSuiteCoordinatorPrompt, buildSuiteThreadPrompt } from "./prompts.js";
import {
  createSuiteCoordinatorTools,
  SUITE_THREAD_READ_DEFAULT_LIMIT,
  SUITE_THREAD_READ_MAX_LIMIT,
  type SuiteModelCatalogSnapshot,
  type SuiteThreadListItem,
  type SuiteThreadReadOutput,
  type SuiteThreadReportRecord,
  type SuiteToolActionResult,
} from "./tools.js";

export interface SuiteEnabledModelEntry {
  provider: string;
  model: string;
  name?: string | undefined;
}

export type SuiteAvailableProfileEntry = SubagentProfileConfig & {
  name: string;
};

export interface SuiteControllerDeps {
  suite: SuiteRecord;
  coordinatorSessionId: string;
  newChildSessionId(): string;
  isClosing(): boolean;
  currentDirectory(): { cwd: string; workspaceRoot: string };
  pathsEqual(a: string, b: string): boolean;
  coordinatorModel(): ResolvedModel;
  coordinatorEffort(): ReasoningEffort | undefined;
  enabledModels(): SuiteEnabledModelEntry[];
  availableProfiles(): SuiteAvailableProfileEntry[];
  externalAgentNames(): ReadonlySet<string>;
  resolveEnabledModel(ref: ModelRef): ResolvedModel | undefined;
  pricing(modelKey: string | undefined): ModelPricing | undefined;
  durableEvents(): readonly DurableEvent[];
  readChildDurableEvents(childSessionId: string): Promise<readonly DurableEvent[]>;
  emitDurable<T extends DurableType>(type: T, payload: DurablePayloadMap[T]): Promise<DurableEvent>;
  emitEphemeral<T extends EphemeralType>(type: T, payload: EphemeralPayloadMap[T]): void;
  deliverToCoordinator(input: PreparedInput, forcePaused?: boolean): Promise<void>;
  notifyCoordinatorIdle(): void;
  openThreadSession(spec: ResidentChildOpenSpec): Promise<ResidentChildSession>;
  worktrees: ResidentWorktreeOps;
  commandError(code: "invalid_command" | "session_busy", message: string): Error;
}

interface ThreadRuntimeState {
  threadId: string;
  childSessionId: string;
  title: string;
  task: string;
  workspace: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktreeRef?: SuiteWorktreeRef | undefined;
  worktreeRecord?: ResidentWorktreeHandle | undefined;
  status: SuiteThreadStatus;
  resolved: boolean;
  hasUnmergedWorktree: boolean;
  hasPendingQuestion: boolean;
  lastReportLine?: string | undefined;
  lastReportTurnId?: string | undefined;
  toolActivity?: SuiteToolActivity | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions: SuiteThreadPermission[];
  questionCallIds: Set<string>;
  session?: ResidentChildSession | undefined;
  opening?: Promise<ResidentChildSession> | undefined;
  unsubscribe?: (() => void) | undefined;
}

export interface SuiteController {
  /** 从指挥日志初始化线程登记，并在重启后补回未落入指挥对话的汇报（暂停态） */
  initializeFromLog(): Promise<void>;
  /** 更新内存中的组曲记录（如 updateSuite 后刷新说明与默认项） */
  updateSuiteRecord(next: SuiteRecord): void;
  /** 构建指挥系统提示（含组曲元数据、说明与线程名单摘要） */
  basePrompt(): string;
  /** 指挥组曲工具列表（thread_start/send/list/read/resolve） */
  coordinatorTools(): ToolDefinition[];
  /** 当前活动的独立工作树线程 childSessionId 集合（防清理误删） */
  activeIsolatedChildIds(): ReadonlySet<string>;
  /** 是否存在正在运行的共享工作区线程（供分支切换保护） */
  hasWorkspaceThreads(): boolean;
  /** 是否有任何线程正在运行（供指挥 isIdle 判断） */
  hasRunningWork(): boolean;
  /** 当前非默认线程运行态快照列表（供新订阅同步） */
  threadSnapshots(): SuiteThreadUpdatedPayload[];
  /** 按 childSessionId 查找或懒打开线程会话（供 runtime.resumeSession 复用） */
  openOrGetThreadBySessionId(
    childSessionId: string,
  ): Promise<{ session: ResidentChildSession; active: boolean } | undefined>;
  /** 用户在总览面板标记完成或重新打开 */
  resolveThreadFromUser(input: { thread: string; reopen?: boolean | undefined }): Promise<void>;
  /** 用户在总览面板绕过指挥直接向线程发消息 */
  sendToThreadFromUser(input: { thread: string; text: string }): Promise<void>;
  /** 供 apply_subagent_changes 同步按 threadId 或 childSessionId 查找已提交未并回改动 */
  lookupThreadWorktreeSync(
    idOrThreadId: string,
  ): { changes: SubagentChanges; repository: string; applied: boolean } | undefined;
  /** apply_subagent_changes 应用成功后推进工作树基准并更新线程状态 */
  onThreadWorktreeApplied(idOrThreadId: string, appliedHead: string): Promise<void>;
  /** 会话关闭时停止并释放所有常驻线程句柄 */
  dispose(): Promise<void>;
}

function parseThreadNumber(threadId: string): number {
  const m = /^t(\d+)$/.exec(threadId);
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}

function textFromContent(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractLastTurnReport(
  childEvents: readonly DurableEvent[],
  reason: TurnEndReason,
  error?: { code: string; message: string },
): { turnId: string; reportBody: string } {
  const lastCompleted = childEvents.findLast((ev) => ev.type === "turn.completed");
  const turnId = lastCompleted?.turnId ?? `turn-${Date.now()}`;

  let lastAssistantText = "";
  for (let i = childEvents.length - 1; i >= 0; i--) {
    const ev = childEvents[i];
    if (ev?.type === "message.assistant" && (lastCompleted === undefined || ev.turnId === turnId)) {
      const text = textFromContent(ev.payload.content).trim();
      if (text !== "") {
        lastAssistantText = text;
        break;
      }
    }
  }

  if (reason === "done") {
    return {
      turnId,
      reportBody: lastAssistantText !== "" ? lastAssistantText : "(Completed with no text output.)",
    };
  }
  if (reason === "aborted") {
    return {
      turnId,
      reportBody:
        lastAssistantText !== "" ? `${lastAssistantText}\n\n[Turn aborted]` : "[Turn aborted]",
    };
  }
  const errLine =
    error !== undefined
      ? `[Turn paused (${error.code}): ${error.message}]`
      : `[Turn paused: ${reason}]`;
  return {
    turnId,
    reportBody: lastAssistantText !== "" ? `${lastAssistantText}\n\n${errLine}` : errLine,
  };
}

function toThreadView(t: ThreadRuntimeState): SuiteThreadView {
  const group = computeSuiteThreadGroup(t);
  return {
    threadId: t.threadId,
    childSessionId: t.childSessionId,
    title: t.title,
    task: t.task,
    workspace: t.workspace,
    model: t.model,
    ...(t.reasoningEffort !== undefined ? { reasoningEffort: t.reasoningEffort } : {}),
    ...(t.profile !== undefined ? { profile: t.profile } : {}),
    preset: t.preset,
    isolated: t.isolated,
    ...(t.worktreeRef !== undefined ? { worktree: t.worktreeRef } : {}),
    status: t.status,
    group,
    resolved: t.resolved,
    hasUnmergedWorktree: t.hasUnmergedWorktree,
    hasPendingQuestion: t.hasPendingQuestion,
    ...(t.lastReportLine !== undefined ? { lastReportLine: t.lastReportLine } : {}),
    ...(t.lastReportTurnId !== undefined ? { lastReportTurnId: t.lastReportTurnId } : {}),
    ...(t.toolActivity !== undefined ? { toolActivity: t.toolActivity } : {}),
    ...(t.pauseError !== undefined ? { pauseError: t.pauseError } : {}),
    pendingPermissions: [...t.pendingPermissions],
  };
}

function threadUpdatePayload(t: ThreadRuntimeState): SuiteThreadUpdatedPayload {
  return {
    threadId: t.threadId,
    status: t.status,
    ...(t.toolActivity !== undefined ? { toolActivity: t.toolActivity } : {}),
    ...(t.status === "paused" && t.pauseError !== undefined ? { pauseError: t.pauseError } : {}),
    pendingPermissions: [...t.pendingPermissions],
    hasPendingQuestion: t.hasPendingQuestion,
    hasUnmergedWorktree: t.hasUnmergedWorktree,
  };
}

export function createSuiteController(deps: SuiteControllerDeps): SuiteController {
  let suite = deps.suite;
  const threads = new Map<string, ThreadRuntimeState>();
  let nextThreadNumber = 1;
  let disposed = false;

  const findThread = (idOrThreadId: string): ThreadRuntimeState | undefined => {
    const key = idOrThreadId.trim();
    if (key === "") return undefined;
    const direct = threads.get(key);
    if (direct !== undefined) return direct;
    for (const t of threads.values()) {
      if (t.childSessionId === key) return t;
    }
    return undefined;
  };

  const emitThreadUpdate = (t: ThreadRuntimeState): void => {
    if (disposed || deps.isClosing()) return;
    deps.emitEphemeral("suite.thread_updated", threadUpdatePayload(t));
  };

  async function ensureWorktreeRecord(
    t: ThreadRuntimeState,
  ): Promise<ResidentWorktreeHandle | undefined> {
    if (!t.isolated) return undefined;
    if (t.worktreeRecord !== undefined) return t.worktreeRecord;
    const loaded = await deps.worktrees.loadRecord(t.childSessionId).catch(() => undefined);
    if (loaded !== undefined) t.worktreeRecord = loaded;
    return loaded;
  }

  const catalogSnapshot = (): SuiteModelCatalogSnapshot => {
    const coordRef = deps.coordinatorModel().model.ref;
    const defaultKey = `${coordRef.provider}/${coordRef.model}`;
    const enabled = deps.enabledModels().map((m) => ({
      provider: m.provider,
      model: m.model,
      ...(m.name !== undefined ? { name: m.name } : {}),
    }));
    const profiles = deps.availableProfiles().map((p) => ({
      ...p,
      pricing: deps.pricing(p.model ?? defaultKey),
    }));
    return {
      defaultModel: defaultKey,
      profiles,
      enabledModels: enabled,
      pricing: (key) => deps.pricing(key),
      workspaces: suite.workspaces,
    };
  };

  function availableOptionsSummary(): string {
    const snap = catalogSnapshot();
    const modelKeys = snap.enabledModels.map((m) => `${m.provider}/${m.model}`);
    const profileNames = [DEFAULT_SUBAGENT_PROFILE, ...snap.profiles.map((p) => p.name)];
    return `Available enabled models: ${modelKeys.length > 0 ? modelKeys.join(", ") : "(none)"}. Available profiles: ${profileNames.join(", ")}.`;
  }

  function resolveThreadSelection(input: {
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    preset?: "general" | "explore" | undefined;
  }):
    | {
        ok: true;
        resolved: ResolvedModel;
        effort: ReasoningEffort | undefined;
        profile: string | undefined;
        preset: "general" | "explore";
      }
    | { ok: false; message: string } {
    const rawModel = input.model?.trim() ? input.model.trim() : undefined;
    const rawProfile = input.profile?.trim() ? input.profile.trim() : undefined;

    if (rawModel !== undefined && rawProfile !== undefined) {
      return {
        ok: false,
        message: "Parameters `model` and `profile` are mutually exclusive; specify at most one.",
      };
    }

    const externalNames = deps.externalAgentNames();
    if (rawModel !== undefined && externalNames.has(rawModel)) {
      return {
        ok: false,
        message: `"${rawModel}" is an external ACP agent and cannot be a suite thread. ${availableOptionsSummary()}`,
      };
    }
    if (rawProfile !== undefined && externalNames.has(rawProfile)) {
      return {
        ok: false,
        message: `"${rawProfile}" is an external ACP agent and cannot be a suite thread. ${availableOptionsSummary()}`,
      };
    }

    const enabledList = deps.enabledModels();
    const matchEnabledModel = (
      spec: string,
    ): { ok: true; resolved: ResolvedModel } | { ok: false; message: string } => {
      let candidates: SuiteEnabledModelEntry[];
      if (spec.includes("/")) {
        const slash = spec.indexOf("/");
        const prov = spec.slice(0, slash);
        const mod = spec.slice(slash + 1);
        candidates = enabledList.filter((m) => m.provider === prov && m.model === mod);
      } else {
        candidates = enabledList.filter((m) => m.model === spec);
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          message: `Model "${spec}" is not enabled or does not exist. ${availableOptionsSummary()}`,
        };
      }
      if (candidates.length > 1) {
        const keys = candidates.map((c) => `${c.provider}/${c.model}`).join(", ");
        return {
          ok: false,
          message: `Model "${spec}" matches multiple enabled providers (${keys}); specify full "provider/model". ${availableOptionsSummary()}`,
        };
      }
      const chosen = candidates[0];
      if (chosen === undefined) {
        return {
          ok: false,
          message: `Model "${spec}" is not available. ${availableOptionsSummary()}`,
        };
      }
      const resolved = deps.resolveEnabledModel({
        provider: chosen.provider,
        model: chosen.model,
      });
      if (resolved === undefined) {
        return {
          ok: false,
          message: `Model "${spec}" is not available. ${availableOptionsSummary()}`,
        };
      }
      return { ok: true, resolved };
    };

    const defaultPreset: "general" | "explore" =
      suite.threadDefaults.preset === "explore" ? "explore" : "general";

    const resolveFallbackModel = ():
      { ok: true; resolved: ResolvedModel } | { ok: false; message: string } => {
      if (suite.threadDefaults.model !== undefined && suite.threadDefaults.model.trim() !== "") {
        const matched = matchEnabledModel(suite.threadDefaults.model.trim());
        if (matched.ok) return matched;
      }
      return { ok: true, resolved: deps.coordinatorModel() };
    };

    if (rawProfile !== undefined) {
      if (rawProfile === DEFAULT_SUBAGENT_PROFILE) {
        const fb = resolveFallbackModel();
        if (!fb.ok) return fb;
        const effort = clampReasoningEffort(
          input.effort ?? suite.threadDefaults.reasoningEffort ?? deps.coordinatorEffort(),
          fb.resolved.model.capabilities.reasoningEffort,
        );
        return {
          ok: true,
          resolved: fb.resolved,
          effort,
          profile: DEFAULT_SUBAGENT_PROFILE,
          preset: input.preset ?? defaultPreset,
        };
      }
      const found = deps.availableProfiles().find((p) => p.name === rawProfile);
      if (found === undefined) {
        return {
          ok: false,
          message: `Profile "${rawProfile}" is not available or disabled. ${availableOptionsSummary()}`,
        };
      }
      const cap = found.tools ?? "general";
      if (cap === "explore" && input.preset === "general") {
        return {
          ok: false,
          message: `Profile "${rawProfile}" restricts tools to "explore"; cannot widen preset to "general".`,
        };
      }
      let resolved: ResolvedModel;
      if (found.model !== undefined) {
        const matched = matchEnabledModel(found.model);
        if (!matched.ok) return matched;
        resolved = matched.resolved;
      } else {
        const fb = resolveFallbackModel();
        if (!fb.ok) return fb;
        resolved = fb.resolved;
      }
      const effort = clampReasoningEffort(
        input.effort ??
          found.effort ??
          suite.threadDefaults.reasoningEffort ??
          deps.coordinatorEffort(),
        resolved.model.capabilities.reasoningEffort,
      );
      return {
        ok: true,
        resolved,
        effort,
        profile: found.name,
        preset: input.preset ?? cap,
      };
    }

    if (rawModel !== undefined) {
      const matched = matchEnabledModel(rawModel);
      if (!matched.ok) return matched;
      const effort = clampReasoningEffort(
        input.effort ?? suite.threadDefaults.reasoningEffort ?? deps.coordinatorEffort(),
        matched.resolved.model.capabilities.reasoningEffort,
      );
      return {
        ok: true,
        resolved: matched.resolved,
        effort,
        profile: undefined,
        preset: input.preset ?? defaultPreset,
      };
    }

    const fb = resolveFallbackModel();
    if (!fb.ok) return fb;
    const effort = clampReasoningEffort(
      input.effort ?? suite.threadDefaults.reasoningEffort ?? deps.coordinatorEffort(),
      fb.resolved.model.capabilities.reasoningEffort,
    );
    return {
      ok: true,
      resolved: fb.resolved,
      effort,
      profile: undefined,
      preset: input.preset ?? defaultPreset,
    };
  }

  function resolveWorkspace(
    rawWorkspace: string | undefined,
  ): { ok: true; workspace: string } | { ok: false; message: string } {
    const trimmed = rawWorkspace?.trim();
    if (trimmed === undefined || trimmed === "") {
      return {
        ok: true,
        workspace: suite.workspaces[0] ?? deps.currentDirectory().workspaceRoot,
      };
    }
    if (suite.workspaces.length === 0) {
      return { ok: true, workspace: trimmed };
    }
    const matched = suite.workspaces.find((ws) => deps.pathsEqual(ws, trimmed));
    if (matched === undefined) {
      return {
        ok: false,
        message: `Workspace "${trimmed}" is not in this suite's workspaces (${suite.workspaces.join(", ")}).`,
      };
    }
    return { ok: true, workspace: matched };
  }

  function buildThreadSystemPrompt(t: ThreadRuntimeState): string {
    const wt = t.worktreeRecord;
    return buildSuiteThreadPrompt({
      suiteName: suite.name,
      suiteGoal: suite.goal,
      suiteInstructions: suite.instructions,
      threadId: t.threadId,
      title: t.title,
      task: t.task,
      preset: t.preset,
      ...(t.isolated && wt !== undefined
        ? {
            worktree: {
              worktree: wt.worktree,
              repository: wt.repository,
              branch: wt.branch,
              includeSkipped: wt.includeSkipped,
              skippedSymlinks: wt.skippedSymlinks,
            },
          }
        : {}),
    });
  }

  async function ensureThreadSession(
    t: ThreadRuntimeState,
    create = false,
  ): Promise<ResidentChildSession> {
    if (t.session !== undefined) return t.session;
    if (t.opening !== undefined) return await t.opening;

    const openTask = (async () => {
      const record = await ensureWorktreeRecord(t);
      const cwd = record?.cwd ?? t.workspace;
      const workspaceRoot = record?.workspaceRoot ?? t.workspace;

      const handle = await deps.openThreadSession({
        kind: "suite",
        childSessionId: t.childSessionId,
        name: t.threadId,
        create,
        cwd,
        workspaceRoot,
        model: t.model,
        reasoningEffort: t.reasoningEffort,
        preset: t.preset,
        ...(record !== undefined ? { worktreePath: record.worktree } : {}),
        suite: { id: suite.id, role: "thread", threadId: t.threadId },
        extraTools: [],
        basePrompt: () => buildThreadSystemPrompt(t),
        onTurnLifecycle: {
          onSlotWaitStart: () => {
            t.status = "working";
            t.pauseError = undefined;
            emitThreadUpdate(t);
          },
          onTurnCompleted: async (reason, error) => {
            if (t.isolated) {
              const wt = await ensureWorktreeRecord(t);
              if (wt !== undefined) {
                const onBranch = await deps.worktrees.isOnBranch(wt).catch(() => false);
                if (onBranch) {
                  const changes = await deps.worktrees
                    .checkpoint(wt, `Suite ${t.threadId}: ${t.title}`)
                    .catch(() => undefined);
                  t.hasUnmergedWorktree = changes !== undefined;
                }
              }
            }
            if (disposed || deps.isClosing()) return;
            t.toolActivity = undefined;
            t.pendingPermissions = [];
            t.hasPendingQuestion = false;
            t.questionCallIds.clear();

            const childEvents =
              handle.durableEvents?.() ??
              (await deps.readChildDurableEvents(t.childSessionId).catch(() => []));
            const { turnId, reportBody } = extractLastTurnReport(childEvents, reason, error);
            const reportStatus: SuiteThreadReportStatus =
              reason === "done" || reason === "aborted" ? "idle" : "paused";

            if (reportStatus === "paused") {
              t.status = "paused";
              t.pauseError = error ?? { code: reason, message: `Turn ended with ${reason}` };
            } else if (!handle.hasActivePendingInputs()) {
              t.status = "idle";
              t.pauseError = undefined;
            }

            const summaryLine = firstSuiteLine(reportBody);
            if (summaryLine !== undefined) {
              t.lastReportLine = summaryLine;
            }
            t.lastReportTurnId = turnId;

            await deps.emitDurable("suite.thread_reported", {
              threadId: t.threadId,
              childSessionId: t.childSessionId,
              turnId,
              status: reportStatus,
              report: reportBody,
              ...(summaryLine !== undefined ? { summaryLine } : {}),
              ...(reportStatus === "paused" && t.pauseError !== undefined
                ? { error: t.pauseError }
                : {}),
              ...(t.isolated ? { hasUnmergedWorktree: t.hasUnmergedWorktree } : {}),
            });

            emitThreadUpdate(t);

            const xml = formatSuiteThreadReport({
              threadId: t.threadId,
              title: t.title,
              status: reportStatus,
              body: reportBody,
            });
            await deps.deliverToCoordinator(
              {
                suiteReport: {
                  threadId: t.threadId,
                  turnId,
                  status: reportStatus,
                },
                content: [{ type: "text", text: xml }],
                appended: [],
              },
              false,
            );
            deps.notifyCoordinatorIdle();
          },
        },
      });

      const unsub = handle.subscribe((event) => {
        if (disposed) return;
        if (event.type === "turn.started") {
          t.status = "working";
          t.pauseError = undefined;
          emitThreadUpdate(t);
        } else if (event.type === "tool.started") {
          t.toolActivity = summarizeSuiteToolCall(event.payload.name, event.payload.input);
          emitThreadUpdate(t);
        } else if (event.type === "permission.requested") {
          const p = event.payload;
          if (!t.pendingPermissions.some((item) => item.requestId === p.requestId)) {
            t.pendingPermissions.push({
              requestId: p.requestId,
              callId: p.callId,
              reason: p.reason,
              subjects: p.subjects,
              options: p.options,
            });
            emitThreadUpdate(t);
          }
        } else if (event.type === "permission.resolved") {
          const p = event.payload;
          const before = t.pendingPermissions.length;
          t.pendingPermissions = t.pendingPermissions.filter(
            (item) =>
              (p.requestId !== undefined ? item.requestId !== p.requestId : true) &&
              item.callId !== p.callId,
          );
          if (t.pendingPermissions.length !== before) {
            emitThreadUpdate(t);
          }
        } else if (event.type === "question.requested") {
          t.questionCallIds.add(event.payload.callId);
          if (!t.hasPendingQuestion) {
            t.hasPendingQuestion = true;
            emitThreadUpdate(t);
          }
        } else if (event.type === "tool.completed") {
          if (t.questionCallIds.delete(event.payload.callId) && t.questionCallIds.size === 0) {
            if (t.hasPendingQuestion) {
              t.hasPendingQuestion = false;
              emitThreadUpdate(t);
            }
          }
        } else if (event.type === "session.config_changed") {
          const nextModel = event.payload.model;
          const nextEffort = event.payload.reasoningEffort;
          if (nextModel !== undefined || nextEffort !== undefined) {
            const modelChanged =
              nextModel !== undefined &&
              (nextModel.provider !== t.model.provider || nextModel.model !== t.model.model);
            const effortChanged = nextEffort !== undefined && nextEffort !== t.reasoningEffort;
            if (modelChanged || effortChanged) {
              if (nextModel !== undefined) t.model = nextModel;
              if (nextEffort !== undefined) t.reasoningEffort = nextEffort;
              if (!deps.isClosing()) {
                void deps
                  .emitDurable("suite.thread_model_changed", {
                    threadId: t.threadId,
                    model: t.model,
                    ...(t.reasoningEffort !== undefined
                      ? { reasoningEffort: t.reasoningEffort }
                      : {}),
                  })
                  .catch(() => undefined);
              }
            }
          }
        }
      });

      t.session = handle;
      t.unsubscribe = unsub;
      return handle;
    })();

    t.opening = openTask;
    try {
      return await openTask;
    } finally {
      t.opening = undefined;
    }
  }

  async function sendToThreadCore(
    t: ThreadRuntimeState,
    text: string,
    source: SuiteActionSource,
  ): Promise<void> {
    if (t.resolved) {
      t.resolved = false;
      await deps.emitDurable("suite.thread_reopened", {
        threadId: t.threadId,
        source,
      });
    }
    const handle = await ensureThreadSession(t, false);
    if (t.status === "paused") {
      t.status = "working";
      t.pauseError = undefined;
      emitThreadUpdate(t);
    }
    await handle.deliverInput(
      {
        content: [{ type: "text", text }],
        appended: [],
      },
      false,
    );
  }

  async function resolveThreadCore(
    t: ThreadRuntimeState,
    reopen: boolean,
    source: SuiteActionSource,
  ): Promise<void> {
    if (reopen) {
      if (t.resolved) {
        t.resolved = false;
        await deps.emitDurable("suite.thread_reopened", {
          threadId: t.threadId,
          source,
        });
      }
      return;
    }
    if (!t.resolved) {
      t.resolved = true;
      await deps.emitDurable("suite.thread_resolved", {
        threadId: t.threadId,
        source,
      });
    }
  }

  const toolHandlers = {
    catalog: catalogSnapshot,

    async startThread(input: {
      title: string;
      task: string;
      model?: string | undefined;
      profile?: string | undefined;
      effort?: ReasoningEffort | undefined;
      preset?: "general" | "explore" | undefined;
      isolated?: boolean | undefined;
      workspace?: string | undefined;
    }): Promise<SuiteToolActionResult> {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (title === "") {
        return {
          ok: false,
          code: "invalid_input",
          message: "Thread `title` must not be empty.",
        };
      }
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (task === "") {
        return {
          ok: false,
          code: "invalid_input",
          message: "Thread `task` must not be empty.",
        };
      }

      const ws = resolveWorkspace(input.workspace);
      if (!ws.ok) {
        return { ok: false, code: "invalid_input", message: ws.message };
      }
      const selected = resolveThreadSelection({
        model: input.model,
        profile: input.profile,
        effort: input.effort,
        preset: input.preset,
      });
      if (!selected.ok) {
        return { ok: false, code: "invalid_input", message: selected.message };
      }

      const isolated = input.isolated ?? suite.threadDefaults.isolated === true;
      let threadId = `t${nextThreadNumber++}`;
      while (threads.has(threadId)) {
        threadId = `t${nextThreadNumber++}`;
      }
      const childSessionId = deps.newChildSessionId();

      let worktreeRecord: ResidentWorktreeHandle | undefined;
      if (isolated) {
        try {
          const repository = await deps.worktrees.inspectRepository(ws.workspace);
          worktreeRecord = await deps.worktrees.create({
            childSessionId,
            repository,
            cwd: ws.workspace,
            workspaceRoot: ws.workspace,
            task: `Suite ${threadId}: ${title}`,
          });
        } catch (err) {
          return {
            ok: false,
            code: "invalid_input",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const modelRef = selected.resolved.model.ref;
      const t: ThreadRuntimeState = {
        threadId,
        childSessionId,
        title,
        task,
        workspace: ws.workspace,
        model: modelRef,
        reasoningEffort: selected.effort,
        profile: selected.profile,
        preset: selected.preset,
        isolated,
        ...(worktreeRecord !== undefined
          ? {
              worktreeRef: {
                path: worktreeRecord.worktree,
                branch: worktreeRecord.branch,
                base: worktreeRecord.base,
              },
              worktreeRecord,
            }
          : {}),
        status: "idle",
        resolved: false,
        hasUnmergedWorktree: false,
        hasPendingQuestion: false,
        pendingPermissions: [],
        questionCallIds: new Set(),
      };
      threads.set(threadId, t);

      let handle: ResidentChildSession;
      try {
        handle = await ensureThreadSession(t, true);
      } catch (err) {
        threads.delete(threadId);
        if (worktreeRecord !== undefined) {
          await deps.worktrees.remove(worktreeRecord, true).catch(() => undefined);
        }
        return {
          ok: false,
          code: "suite_error",
          message: `Failed to create thread session: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      await deps.emitDurable("suite.thread_started", {
        threadId: t.threadId,
        childSessionId: t.childSessionId,
        title: t.title,
        task: t.task,
        workspace: t.workspace,
        model: t.model,
        ...(t.reasoningEffort !== undefined ? { reasoningEffort: t.reasoningEffort } : {}),
        ...(t.profile !== undefined ? { profile: t.profile } : {}),
        preset: t.preset,
        isolated: t.isolated,
        ...(t.worktreeRef !== undefined ? { worktree: t.worktreeRef } : {}),
      });

      t.status = "working";
      emitThreadUpdate(t);

      await handle.deliverInput(
        {
          content: [{ type: "text", text: task }],
          appended: [],
        },
        false,
      );

      const modelKey = `${t.model.provider}/${t.model.model}`;
      return {
        ok: true,
        text: `Started thread ${t.threadId} ("${t.title}", session: ${t.childSessionId}, model: ${modelKey}, preset: ${t.preset}, workspace: ${t.workspace}${t.isolated && t.worktreeRef ? `, isolated branch: ${t.worktreeRef.branch}` : ""}).`,
        output: {
          threadId: t.threadId,
          childSessionId: t.childSessionId,
          title: t.title,
          workspace: t.workspace,
          model: modelKey,
          ...(t.reasoningEffort !== undefined ? { reasoningEffort: t.reasoningEffort } : {}),
          preset: t.preset,
          isolated: t.isolated,
          ...(t.worktreeRef !== undefined ? { worktree: t.worktreeRef } : {}),
        },
      };
    },

    async sendToThread(input: { thread: string; text: string }): Promise<SuiteToolActionResult> {
      const t = findThread(input.thread);
      if (t === undefined) {
        return {
          ok: false,
          code: "invalid_input",
          message: `Unknown suite thread "${input.thread}".`,
        };
      }
      const trimmed = typeof input.text === "string" ? input.text.trim() : "";
      if (trimmed === "") {
        return {
          ok: false,
          code: "invalid_input",
          message: "Message `text` must not be empty.",
        };
      }
      await sendToThreadCore(t, trimmed, "coordinator");
      return {
        ok: true,
        text: `Delivered message to thread ${t.threadId} ("${t.title}").`,
        output: { threadId: t.threadId, childSessionId: t.childSessionId },
      };
    },

    listThreads(): Promise<SuiteToolActionResult<{ threads: SuiteThreadListItem[] }>> {
      const items: SuiteThreadListItem[] = [...threads.values()].map((t) => {
        const group = computeSuiteThreadGroup(t);
        return {
          threadId: t.threadId,
          childSessionId: t.childSessionId,
          title: t.title,
          status: t.status,
          group,
          resolved: t.resolved,
          workspace: t.workspace,
          model: `${t.model.provider}/${t.model.model}`,
          isolated: t.isolated,
          ...(t.worktreeRef !== undefined ? { worktree: t.worktreeRef } : {}),
          hasUnmergedWorktree: t.hasUnmergedWorktree,
          ...(t.lastReportLine !== undefined ? { lastReportLine: t.lastReportLine } : {}),
          pendingPermissionCount: t.pendingPermissions.length,
          hasPendingQuestion: t.hasPendingQuestion,
          ...(t.pauseError !== undefined ? { pauseError: t.pauseError } : {}),
        };
      });
      const text =
        items.length > 0
          ? items
              .map(
                (item) =>
                  `- ${item.threadId} ("${item.title}") [${item.group} / ${item.status}] model=${item.model} workspace=${item.workspace}${item.isolated && item.worktree ? ` branch=${item.worktree.branch}` : ""}${item.lastReportLine ? ` — ${item.lastReportLine}` : ""}`,
              )
              .join("\n")
          : "(No threads in this suite yet.)";
      return Promise.resolve({
        ok: true,
        text,
        output: { threads: items },
      });
    },

    readThread(input: {
      thread: string;
      limit?: number | undefined;
    }): Promise<SuiteToolActionResult<SuiteThreadReadOutput>> {
      const t = findThread(input.thread);
      if (t === undefined) {
        return Promise.resolve({
          ok: false,
          code: "invalid_input",
          message: `Unknown suite thread "${input.thread}".`,
        });
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return Promise.resolve({
          ok: false,
          code: "invalid_input",
          message: "`limit` must be a positive integer.",
        });
      }
      const limit =
        input.limit === undefined
          ? SUITE_THREAD_READ_DEFAULT_LIMIT
          : Math.min(SUITE_THREAD_READ_MAX_LIMIT, input.limit);

      const allReports: SuiteThreadReportRecord[] = [];
      for (const ev of deps.durableEvents()) {
        if (ev.type === "suite.thread_reported" && ev.payload.threadId === t.threadId) {
          allReports.push({
            seq: ev.seq,
            time: ev.time,
            turnId: ev.payload.turnId,
            status: ev.payload.status,
            report: ev.payload.report,
            ...(ev.payload.error !== undefined ? { error: ev.payload.error } : {}),
          });
        }
      }
      const start = Math.max(0, allReports.length - limit);
      const reports = allReports.slice(start);
      const hasMore = start > 0;
      const group = computeSuiteThreadGroup(t);

      const reportBlocks =
        reports.length > 0
          ? reports.map((r) => `## Turn ${r.turnId} (${r.status}, ${r.time})\n${r.report}`)
          : ["(No reports yet from this thread.)"];

      const text = [
        `Thread ${t.threadId} ("${t.title}") — group: ${group}, status: ${t.status}, workspace: ${t.workspace}`,
        ...reportBlocks,
      ].join("\n\n");

      return Promise.resolve({
        ok: true,
        text,
        output: {
          threadId: t.threadId,
          title: t.title,
          status: t.status,
          group,
          workspace: t.workspace,
          isolated: t.isolated,
          reports,
          hasMore,
        },
      });
    },

    async resolveThread(input: {
      thread: string;
      reopen?: boolean | undefined;
    }): Promise<SuiteToolActionResult> {
      const t = findThread(input.thread);
      if (t === undefined) {
        return {
          ok: false,
          code: "invalid_input",
          message: `Unknown suite thread "${input.thread}".`,
        };
      }
      const reopen = input.reopen === true;
      await resolveThreadCore(t, reopen, "coordinator");
      return {
        ok: true,
        text: reopen
          ? `Reopened thread ${t.threadId} ("${t.title}").`
          : `Marked thread ${t.threadId} ("${t.title}") as resolved.`,
        output: { threadId: t.threadId, resolved: !reopen },
      };
    },
  };

  return {
    async initializeFromLog() {
      let view: SuiteView | undefined;
      const allEvents = deps.durableEvents();
      for (const ev of allEvents) {
        view = reduceSuiteDurable(view, ev);
      }

      threads.clear();
      nextThreadNumber = 1;

      if (view === undefined) return;

      const existingWorktrees = await deps.worktrees.listParentRecords().catch(() => []);
      const wtMap = new Map(existingWorktrees.map((r) => [r.childSessionId, r]));

      for (const tv of view.threads) {
        const num = parseThreadNumber(tv.threadId);
        if (num >= nextThreadNumber) nextThreadNumber = num + 1;
        const wtRecord = wtMap.get(tv.childSessionId);
        const hasUnmergedWorktree =
          tv.isolated && wtRecord !== undefined
            ? wtRecord.changes !== undefined && wtRecord.applied !== true
            : tv.hasUnmergedWorktree;

        threads.set(tv.threadId, {
          threadId: tv.threadId,
          childSessionId: tv.childSessionId,
          title: tv.title,
          task: tv.task,
          workspace: tv.workspace,
          model: tv.model,
          reasoningEffort: tv.reasoningEffort,
          profile: tv.profile,
          preset: tv.preset,
          isolated: tv.isolated,
          worktreeRef: tv.worktree,
          ...(wtRecord !== undefined ? { worktreeRecord: wtRecord } : {}),
          status: tv.status === "paused" ? "paused" : "idle",
          resolved: tv.resolved,
          hasUnmergedWorktree,
          hasPendingQuestion: false,
          lastReportLine: tv.lastReportLine,
          lastReportTurnId: tv.lastReportTurnId,
          pauseError: tv.status === "paused" ? tv.pauseError : undefined,
          pendingPermissions: [],
          questionCallIds: new Set(),
        });
      }

      // ADR-0097 §3.5：已发出（suite.thread_reported）但尚未落盘为指挥 message.user 的汇报，
      // 在重启恢复时以暂停状态补回待发输入，不自动唤醒
      const delivered = new Set<string>();
      for (const ev of allEvents) {
        if (ev.type === "message.user" && ev.payload.suiteReport !== undefined) {
          delivered.add(`${ev.payload.suiteReport.threadId}\0${ev.payload.suiteReport.turnId}`);
        }
      }
      for (const ev of allEvents) {
        if (ev.type !== "suite.thread_reported") continue;
        const key = `${ev.payload.threadId}\0${ev.payload.turnId}`;
        if (delivered.has(key)) continue;
        delivered.add(key);
        const t = threads.get(ev.payload.threadId);
        const title = t?.title ?? ev.payload.threadId;
        const xml = formatSuiteThreadReport({
          threadId: ev.payload.threadId,
          title,
          status: ev.payload.status,
          body: ev.payload.report,
        });
        await deps.deliverToCoordinator(
          {
            suiteReport: {
              threadId: ev.payload.threadId,
              turnId: ev.payload.turnId,
              status: ev.payload.status,
            },
            content: [{ type: "text", text: xml }],
            appended: [],
          },
          true,
        );
      }
    },

    updateSuiteRecord(next) {
      suite = next;
    },

    basePrompt() {
      const threadViews = [...threads.values()].map(toThreadView);
      return buildSuiteCoordinatorPrompt({ suite, threads: threadViews });
    },

    coordinatorTools: () => createSuiteCoordinatorTools(toolHandlers),

    activeIsolatedChildIds() {
      const ids = new Set<string>();
      for (const t of threads.values()) {
        if (t.isolated) ids.add(t.childSessionId);
      }
      return ids;
    },

    hasWorkspaceThreads() {
      for (const t of threads.values()) {
        if (
          !t.isolated &&
          (t.status === "working" || t.opening !== undefined || t.session?.isBusy() === true)
        ) {
          return true;
        }
      }
      return false;
    },

    hasRunningWork() {
      for (const t of threads.values()) {
        if (t.status === "working" || t.opening !== undefined || t.session?.isBusy() === true) {
          return true;
        }
      }
      return false;
    },

    threadSnapshots() {
      const out: SuiteThreadUpdatedPayload[] = [];
      for (const t of threads.values()) {
        if (
          t.status !== "idle" ||
          t.pendingPermissions.length > 0 ||
          t.hasPendingQuestion ||
          t.hasUnmergedWorktree
        ) {
          out.push(threadUpdatePayload(t));
        }
      }
      return out;
    },

    async openOrGetThreadBySessionId(childSessionId) {
      for (const t of threads.values()) {
        if (t.childSessionId === childSessionId) {
          const handle = await ensureThreadSession(t, false);
          return { session: handle, active: true };
        }
      }
      return undefined;
    },

    async resolveThreadFromUser(input) {
      const t = findThread(input.thread);
      if (t === undefined) {
        throw deps.commandError("invalid_command", `组曲线程不存在：${input.thread}`);
      }
      await resolveThreadCore(t, input.reopen === true, "user");
    },

    async sendToThreadFromUser(input) {
      const t = findThread(input.thread);
      if (t === undefined) {
        throw deps.commandError("invalid_command", `组曲线程不存在：${input.thread}`);
      }
      const trimmed = input.text.trim();
      if (trimmed === "") {
        throw deps.commandError("invalid_command", "发送给线程的消息不能为空");
      }
      await sendToThreadCore(t, trimmed, "user");
    },

    lookupThreadWorktreeSync(idOrThreadId) {
      const t = findThread(idOrThreadId);
      if (!t?.isolated) return undefined;
      const wt = t.worktreeRecord;
      if (wt?.changes === undefined) return undefined;
      return {
        changes: wt.changes,
        repository: wt.repository,
        applied: wt.applied === true,
      };
    },

    async onThreadWorktreeApplied(idOrThreadId, appliedHead) {
      const t = findThread(idOrThreadId);
      if (!t?.isolated) return;
      const wt = await ensureWorktreeRecord(t);
      if (wt === undefined) return;
      await deps.worktrees.markApplied(wt, appliedHead);
      t.hasUnmergedWorktree = false;
      emitThreadUpdate(t);
    },

    async dispose() {
      disposed = true;
      for (const t of threads.values()) {
        if (t.unsubscribe !== undefined) {
          t.unsubscribe();
          t.unsubscribe = undefined;
        }
        if (t.session !== undefined) {
          await t.session.interruptAndWait().catch(() => undefined);
          await t.session.closeUnderlying().catch(() => undefined);
          t.session = undefined;
        }
      }
    },
  };
}
