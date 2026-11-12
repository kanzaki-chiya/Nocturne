/**
 * Swarm 会话级控制器（ADR-0089）：
 * 管理留言板持久事件、常驻成员生命周期、唤醒投递、工作树增量提交与审查检出、
 * 未并回移除保护、状态广播、Runtime 安静提醒、重启补送与回退/结束收尾。
 */
import { clampReasoningEffort, type ResolvedModel } from "../provider/index.js";
import {
  DEFAULT_SUBAGENT_PROFILE,
  formatCharterPostText,
  formatSwarmPostForModel,
  reduceSwarmDurable,
  resolveSwarmMentions,
  summarizeSwarmToolCall,
  validateSwarmCharter,
  validateSwarmMemberName,
  type DurableEvent,
  type DurablePayloadMap,
  type DurableType,
  type EphemeralPayloadMap,
  type EphemeralType,
  type ModelPricing,
  type ModelRef,
  type PreparedInput,
  type ReasoningEffort,
  type RuntimeEvent,
  type SubagentChanges,
  type SubagentProfileConfig,
  type SwarmAuthorKind,
  type SwarmCharter,
  type SwarmMemberPermission,
  type SwarmMemberUpdatedPayload,
  type SwarmPostedPayload,
  type SwarmUnmergedWorktree,
  type SwarmView,
  type TurnEndReason,
} from "../protocol/index.js";
import type { ToolDefinition } from "../tools/index.js";
import { buildSwarmMemberPrompt } from "./prompts.js";
import {
  createSwarmCheckoutTool,
  createSwarmCoordinatorTools,
  createSwarmPostTool,
  type SwarmModelCatalogSnapshot,
  type SwarmToolActionResult,
} from "./tools.js";

export interface SwarmWorktreeHandle {
  childSessionId: string;
  parentSessionId: string;
  repository: string;
  worktree: string;
  branch: string;
  base: string;
  snapshot: boolean;
  cwd: string;
  workspaceRoot: string;
  task: string;
  includeSkipped: boolean;
  skippedSymlinks?: string[] | undefined;
  applied?: boolean | undefined;
  changes?: SubagentChanges | undefined;
}

export interface ManagedMemberSession {
  readonly id: string;
  isBusy(): boolean;
  hasActivePendingInputs(): boolean;
  deliverSwarmPost(input: PreparedInput, forcePaused?: boolean): Promise<void>;
  resumeFromModelChange(modelKey: string): Promise<void>;
  setModelAndEffort(model: ModelRef, effort?: ReasoningEffort): Promise<void>;
  interruptAndWait(): Promise<void>;
  clearPendingSwarmInputs(): void;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  closeUnderlying(): Promise<void>;
}

export interface SwarmMemberOpenSpec {
  childSessionId: string;
  name: string;
  create: boolean;
  cwd: string;
  workspaceRoot: string;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  preset: "general" | "explore";
  worktreePath?: string | undefined;
  extraTools: ToolDefinition[];
  basePrompt(): string;
  onTurnLifecycle: {
    onSlotWaitStart(): void;
    onTurnCompleted(
      reason: TurnEndReason,
      error?: { code: string; message: string },
    ): Promise<void>;
  };
}

export interface SwarmWorktreeOps {
  inspectRepository(cwd: string): Promise<string>;
  create(input: {
    childSessionId: string;
    repository: string;
    cwd: string;
    workspaceRoot: string;
    task: string;
  }): Promise<SwarmWorktreeHandle>;
  loadRecord(childSessionId: string): Promise<SwarmWorktreeHandle | undefined>;
  listParentRecords(): Promise<SwarmWorktreeHandle[]>;
  checkpoint(
    record: SwarmWorktreeHandle,
    commitMessage?: string,
  ): Promise<SubagentChanges | undefined>;
  currentHead(worktreePath: string): Promise<string>;
  isOnMemberBranch(record: SwarmWorktreeHandle): Promise<boolean>;
  resetToCommit(worktreePath: string, commitSha: string): Promise<string>;
  markApplied(record: SwarmWorktreeHandle, appliedHead: string): Promise<void>;
  remove(record: SwarmWorktreeHandle, removeBranch: boolean): Promise<void>;
  cleanupMerged(): Promise<void>;
}

export interface SwarmEnabledModelEntry {
  provider: string;
  model: string;
  name?: string | undefined;
}

export type SwarmAvailableProfileEntry = SubagentProfileConfig & {
  name: string;
};

export interface SwarmControllerDeps {
  coordinatorSessionId: string;
  newChildSessionId(): string;
  isClosing(): boolean;
  currentDirectory(): { cwd: string; workspaceRoot: string };
  coordinatorModel(): ResolvedModel;
  coordinatorEffort(): ReasoningEffort | undefined;
  enabledModels(): SwarmEnabledModelEntry[];
  availableProfiles(): SwarmAvailableProfileEntry[];
  externalAgentNames(): ReadonlySet<string>;
  resolveEnabledModel(ref: ModelRef): ResolvedModel | undefined;
  pricing(modelKey: string | undefined): ModelPricing | undefined;
  durableEvents(): readonly DurableEvent[];
  readChildDurableEvents(childSessionId: string): Promise<readonly DurableEvent[]>;
  emitDurable<T extends DurableType>(type: T, payload: DurablePayloadMap[T]): Promise<DurableEvent>;
  emitEphemeral<T extends EphemeralType>(type: T, payload: EphemeralPayloadMap[T]): void;
  deliverToCoordinator(input: PreparedInput, forcePaused?: boolean): Promise<void>;
  clearCoordinatorSwarmInputs(): void;
  isCoordinatorBusy(): boolean;
  hasCoordinatorPendingActive(): boolean;
  syncCoordinatorTools(): void;
  notifyCoordinatorIdle(): void;
  openMemberSession(spec: SwarmMemberOpenSpec): Promise<ManagedMemberSession>;
  registerActiveSubagent(childSessionId: string, onCancel: () => void): void;
  unregisterActiveSubagent(childSessionId: string): void;
  worktrees: SwarmWorktreeOps;
  commandError(code: "invalid_command" | "session_busy", message: string): Error;
}

interface MemberRuntimeState {
  name: string;
  childSessionId: string;
  charter: SwarmCharter;
  model: ModelRef;
  reasoningEffort?: ReasoningEffort | undefined;
  profile?: string | undefined;
  preset: "general" | "explore";
  isolated: boolean;
  worktreeRef?: { path: string; branch: string; base: string } | undefined;
  worktreeRecord?: SwarmWorktreeHandle | undefined;
  status: "working" | "waiting" | "paused" | "removed";
  toolActivity?: string | undefined;
  pauseError?: { code: string; message: string } | undefined;
  pendingPermissions: SwarmMemberPermission[];
  session?: ManagedMemberSession | undefined;
  unsubscribe?: (() => void) | undefined;
  opening?: Promise<ManagedMemberSession> | undefined;
  missedPosts: SwarmPostedPayload[];
  pendingCheckoutCommit?: string | undefined;
}

export interface SwarmController {
  /** 从协调者持久事件初始化（含重启未送达提及检测，不自动唤醒） */
  initializeFromLog(): Promise<void>;
  /** 当前是否存在未结束的持久 Swarm */
  isActive(): boolean;
  /** Swarm 建立事件的 seq（用于回退判定） */
  createdSeq(): number | undefined;
  /** 当前仍在活动 Swarm 中且未移除的独立工作树成员 childSessionId 集合（防后台清理误删） */
  activeIsolatedChildIds(): ReadonlySet<string>;
  /** 协调者 Swarm 工具列表 */
  coordinatorTools(): ToolDefinition[];
  /** 向新订阅协调者的监听器补发当前非默认成员运行态快照 */
  publishMemberSnapshots(
    listener: (event: RuntimeEvent) => void,
  ): EphemeralPayloadMap["swarm.member_updated"][];
  /** 当前成员运行态快照列表 */
  memberSnapshots(): SwarmMemberUpdatedPayload[];
  /** 是否有任何成员正在运行或投递中（供协调者 isIdle 判断） */
  hasRunningWork(): boolean;
  /** 按 childSessionId 查找本 Swarm 的成员（供 runtime.resumeSession 复用或懒打开托管会话） */
  openOrGetMemberBySessionId(childSessionId: string): Promise<
    | {
        session: ManagedMemberSession;
        active: boolean;
      }
    | undefined
  >;
  /** 用户在留言板发帖（RuntimeSession.postToSwarm） */
  postFromUser(input: { text: string }): Promise<{ number: number; recipients: string[] }>;
  /** 用户移除成员（RuntimeSession.removeSwarmMember） */
  removeMemberFromUser(name: string): Promise<void>;
  /** 用户结束 Swarm（RuntimeSession.endSwarm） */
  endFromUser(): Promise<{ unmerged: SwarmUnmergedWorktree[] }>;
  /** 对话回退到建立之前时结束 Swarm 并停止全部成员 */
  endOnRewind(): Promise<void>;
  /** 协调者一轮 Turn 结束归于空闲时触发（检查安静提醒） */
  onCoordinatorTurnSettled(): void;
  /** 供 apply_subagent_changes 同步按成员 id 或成员名查找已提交未并回的改动 */
  lookupMemberWorktreeSync(
    idOrName: string,
  ): { changes: SubagentChanges; repository: string; applied: boolean } | undefined;
  /** 供 apply_subagent_changes 按成员 id 或成员名查找未并回改动 */
  lookupMemberWorktreeChanges(idOrName: string): Promise<
    | {
        memberName: string;
        record: SwarmWorktreeHandle;
        changes: SubagentChanges;
        stillActive: boolean;
      }
    | undefined
  >;
  /** apply_subagent_changes 应用成功后推进基准或清理工作树 */
  onMemberWorktreeApplied(idOrName: string, appliedHead: string): Promise<void>;
  /** 会话关闭时停止并释放所有常驻成员句柄（不写结束事件，保留 Swarm 供下次恢复） */
  dispose(): Promise<void>;
}

export function createSwarmController(deps: SwarmControllerDeps): SwarmController {
  let title = "";
  let active = false;
  let initSeq: number | undefined;
  let nextPostNumber = 1;
  const members = new Map<string, MemberRuntimeState>();
  let armed = false;
  let quietReminderSent = false;
  let deliveringCount = 0;
  let quietTimer: ReturnType<typeof setImmediate> | undefined;
  let disposed = false;

  const warnWorktreeCleanupFailed = (cause: unknown): void => {
    deps.emitEphemeral("runtime.warning", {
      code: "worktree_cleanup_failed",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  };

  const catalogSnapshot = (): SwarmModelCatalogSnapshot => {
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
    };
  };

  function availableOptionsSummary(): string {
    const snap = catalogSnapshot();
    const modelKeys = snap.enabledModels.map((m) => `${m.provider}/${m.model}`);
    const profileNames = [DEFAULT_SUBAGENT_PROFILE, ...snap.profiles.map((p) => p.name)];
    return `Available enabled models: ${modelKeys.length > 0 ? modelKeys.join(", ") : "(none)"}. Available profiles: ${profileNames.join(", ")}.`;
  }

  function resolveMemberSelection(input: {
    model?: string | undefined;
    profile?: string | undefined;
    effort?: ReasoningEffort | undefined;
    preset?: "general" | "explore" | undefined;
    agent?: string | undefined;
    requireExplicitModelOrProfile: boolean;
  }):
    | {
        ok: true;
        resolved: ResolvedModel;
        effort: ReasoningEffort | undefined;
        profile: string | undefined;
        preset: "general" | "explore";
      }
    | { ok: false; message: string } {
    if (input.agent !== undefined && input.agent.trim() !== "") {
      return {
        ok: false,
        message: `External ACP agent "${input.agent}" cannot be a swarm member. Only built-in subagent sessions are supported.`,
      };
    }
    const rawModel = input.model?.trim() ? input.model.trim() : undefined;
    const rawProfile = input.profile?.trim() ? input.profile.trim() : undefined;

    if (rawModel !== undefined && rawProfile !== undefined) {
      return {
        ok: false,
        message: "Parameters `model` and `profile` are mutually exclusive; specify at most one.",
      };
    }
    if (input.requireExplicitModelOrProfile && rawModel === undefined && rawProfile === undefined) {
      return {
        ok: false,
        message: `Specify either \`model\` or \`profile\`. ${availableOptionsSummary()}`,
      };
    }

    const externalNames = deps.externalAgentNames();
    if (rawModel !== undefined && externalNames.has(rawModel)) {
      return {
        ok: false,
        message: `"${rawModel}" is an external ACP agent and cannot be a swarm member. ${availableOptionsSummary()}`,
      };
    }
    if (rawProfile !== undefined && externalNames.has(rawProfile)) {
      return {
        ok: false,
        message: `"${rawProfile}" is an external ACP agent and cannot be a swarm member. ${availableOptionsSummary()}`,
      };
    }

    const enabledList = deps.enabledModels();

    const matchEnabledModel = (
      spec: string,
    ): { ok: true; resolved: ResolvedModel } | { ok: false; message: string } => {
      let candidates: SwarmEnabledModelEntry[];
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

    if (rawProfile !== undefined) {
      if (rawProfile === DEFAULT_SUBAGENT_PROFILE) {
        const resolved = deps.coordinatorModel();
        const effort = clampReasoningEffort(
          input.effort ?? deps.coordinatorEffort(),
          resolved.model.capabilities.reasoningEffort,
        );
        return {
          ok: true,
          resolved,
          effort,
          profile: DEFAULT_SUBAGENT_PROFILE,
          preset: input.preset ?? "general",
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
        resolved = deps.coordinatorModel();
      }
      const effort = clampReasoningEffort(
        input.effort ?? found.effort ?? deps.coordinatorEffort(),
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
        input.effort ?? deps.coordinatorEffort(),
        matched.resolved.model.capabilities.reasoningEffort,
      );
      return {
        ok: true,
        resolved: matched.resolved,
        effort,
        profile: undefined,
        preset: input.preset ?? "general",
      };
    }

    const resolved = deps.coordinatorModel();
    const effort = clampReasoningEffort(
      input.effort ?? deps.coordinatorEffort(),
      resolved.model.capabilities.reasoningEffort,
    );
    return {
      ok: true,
      resolved,
      effort,
      profile: undefined,
      preset: input.preset ?? "general",
    };
  }

  function snapshotPayload(m: MemberRuntimeState): SwarmMemberUpdatedPayload | undefined {
    if (m.status === "removed") return undefined;
    return {
      name: m.name,
      status: m.status,
      ...(m.toolActivity !== undefined ? { toolActivity: m.toolActivity } : {}),
      ...(m.status === "paused" && m.pauseError !== undefined ? { pauseError: m.pauseError } : {}),
      ...(m.pendingPermissions.length > 0 ? { pendingPermissions: [...m.pendingPermissions] } : {}),
    };
  }

  function emitMemberUpdate(m: MemberRuntimeState): void {
    if (disposed || !active || m.status === "removed") return;
    const payload = snapshotPayload(m);
    if (payload !== undefined) {
      deps.emitEphemeral("swarm.member_updated", payload);
    }
  }

  function buildMemberSystemPrompt(member: MemberRuntimeState): string {
    const peers = [...members.values()].map((m) => ({
      name: m.name,
      charter: m.charter,
      status: m.status,
      isolated: m.isolated,
    }));
    return buildSwarmMemberPrompt({
      swarmTitle: title,
      name: member.name,
      charter: member.charter,
      preset: member.preset,
      peers,
      ...(member.worktreeRecord !== undefined
        ? {
            worktree: {
              worktree: member.worktreeRecord.worktree,
              repository: member.worktreeRecord.repository,
              branch: member.worktreeRecord.branch,
              includeSkipped: member.worktreeRecord.includeSkipped,
              skippedSymlinks: member.worktreeRecord.skippedSymlinks,
            },
          }
        : {}),
    });
  }

  async function ensureWorktreeRecord(
    member: MemberRuntimeState,
  ): Promise<SwarmWorktreeHandle | undefined> {
    if (!member.isolated) return undefined;
    if (member.worktreeRecord !== undefined) return member.worktreeRecord;
    const loaded = await deps.worktrees.loadRecord(member.childSessionId);
    if (loaded !== undefined) {
      member.worktreeRecord = loaded;
      return loaded;
    }
    return undefined;
  }

  async function checkoutIsolatedAuthorInto(
    viewer: MemberRuntimeState,
    authorName: string,
  ): Promise<SwarmToolActionResult<{ commit: string }>> {
    const viewerRecord = await ensureWorktreeRecord(viewer);
    if (viewerRecord === undefined) {
      return {
        ok: false,
        code: "invalid_input",
        message: "This member does not have an isolated worktree.",
      };
    }
    const target = members.get(authorName);
    if (target === undefined || target.status === "removed") {
      return {
        ok: false,
        code: "invalid_input",
        message: `Swarm member "${authorName}" does not exist or has been removed.`,
      };
    }
    const targetRecord = await ensureWorktreeRecord(target);
    if (targetRecord === undefined) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Member "${authorName}" shares the main workspace and does not have an isolated worktree.`,
      };
    }
    // ADR-0089 §4：保护调用者自身的工作树与分支——先对调用者做一次检查点，
    // 只要调用者自身分支上有未并回的改动就拒绝检出，防止丢弃未提交改动或切到分离头指针后漏提交
    const viewerOnBranch = await deps.worktrees.isOnMemberBranch(viewerRecord);
    const viewerOwnChanges = viewerOnBranch
      ? await deps.worktrees.checkpoint(viewerRecord, `Swarm @${viewer.name} snapshot`)
      : viewerRecord.changes;
    if (viewerOwnChanges !== undefined) {
      return {
        ok: false,
        code: "invalid_input",
        message: `Cannot check out @${target.name}'s commit because your own branch "${viewerRecord.branch}" has unapplied changes (${viewerOwnChanges.files.length} file(s)). Only members without unapplied branch changes (such as verifiers) may run \`swarm_checkout\`; ask \`@coordinator\` to apply your changes first.`,
      };
    }
    // 先把目标作者未提交的改动提交一次（若在自身分支上）
    const targetOnBranch = await deps.worktrees.isOnMemberBranch(targetRecord);
    if (targetOnBranch) {
      await deps.worktrees
        .checkpoint(targetRecord, `Swarm @${target.name} snapshot`)
        .catch(() => undefined);
    }
    const targetHead = await deps.worktrees.currentHead(targetRecord.worktree);
    const checkedOut = await deps.worktrees.resetToCommit(viewerRecord.worktree, targetHead);
    return {
      ok: true,
      text: `Cleaned worktree and checked out @${target.name}'s latest commit ${checkedOut} (detached HEAD).`,
      output: { commit: checkedOut },
    };
  }

  async function ensureMemberSession(
    member: MemberRuntimeState,
    create = false,
  ): Promise<ManagedMemberSession> {
    if (member.session !== undefined) return member.session;
    if (member.opening !== undefined) return await member.opening;

    const openTask = (async () => {
      const record = await ensureWorktreeRecord(member);
      const mainDir = deps.currentDirectory();
      const cwd = record?.cwd ?? mainDir.cwd;
      const workspaceRoot = record?.workspaceRoot ?? mainDir.workspaceRoot;

      const extraTools: ToolDefinition[] = [
        createSwarmPostTool((input) =>
          publishAndDeliverPost({
            text: input.text,
            from: member.name,
            fromKind: "member",
          }),
        ),
      ];
      if (member.isolated) {
        extraTools.push(
          createSwarmCheckoutTool((input) => checkoutIsolatedAuthorInto(member, input.member)),
        );
      }

      const handle = await deps.openMemberSession({
        childSessionId: member.childSessionId,
        name: member.name,
        create,
        cwd,
        workspaceRoot,
        model: member.model,
        reasoningEffort: member.reasoningEffort,
        preset: member.preset,
        ...(record !== undefined ? { worktreePath: record.worktree } : {}),
        extraTools,
        basePrompt: () => buildMemberSystemPrompt(member),
        onTurnLifecycle: {
          onSlotWaitStart: () => {
            armed = true;
            if (member.status !== "removed") {
              member.status = "working";
              member.pauseError = undefined;
              emitMemberUpdate(member);
            }
          },
          onTurnCompleted: async (reason, error) => {
            if (member.isolated) {
              const wt = await ensureWorktreeRecord(member);
              if (wt !== undefined) {
                const onBranch = await deps.worktrees.isOnMemberBranch(wt).catch(() => false);
                if (onBranch) {
                  await deps.worktrees
                    .checkpoint(wt, `Swarm @${member.name} changes`)
                    .catch(() => undefined);
                }
                if (member.pendingCheckoutCommit !== undefined) {
                  const nextSha = member.pendingCheckoutCommit;
                  member.pendingCheckoutCommit = undefined;
                  if (!onBranch || wt.changes === undefined) {
                    await deps.worktrees.resetToCommit(wt.worktree, nextSha).catch(() => undefined);
                  }
                }
              }
            }
            if (member.status === "removed") return;
            member.toolActivity = undefined;
            member.pendingPermissions = [];
            if (reason === "done" || reason === "aborted") {
              if (!handle.hasActivePendingInputs()) {
                member.status = "waiting";
                member.pauseError = undefined;
              }
            } else {
              member.status = "paused";
              member.pauseError = error ?? { code: reason, message: `Turn ended with ${reason}` };
            }
            emitMemberUpdate(member);
            deps.notifyCoordinatorIdle();
            scheduleQuietCheck();
          },
        },
      });

      const unsub = handle.subscribe((event) => {
        if (member.status === "removed") return;
        if (event.type === "turn.started") {
          armed = true;
          member.status = "working";
          member.pauseError = undefined;
          emitMemberUpdate(member);
        } else if (event.type === "tool.started") {
          member.toolActivity = summarizeSwarmToolCall(event.payload.name, event.payload.input);
          emitMemberUpdate(member);
        } else if (event.type === "permission.requested") {
          const p = event.payload;
          if (!member.pendingPermissions.some((item) => item.requestId === p.requestId)) {
            member.pendingPermissions.push({
              requestId: p.requestId,
              callId: p.callId,
              reason: p.reason,
              subjects: p.subjects,
              options: p.options,
            });
            emitMemberUpdate(member);
          }
        } else if (event.type === "permission.resolved") {
          const p = event.payload;
          const before = member.pendingPermissions.length;
          member.pendingPermissions = member.pendingPermissions.filter(
            (item) =>
              (p.requestId !== undefined ? item.requestId !== p.requestId : true) &&
              item.callId !== p.callId,
          );
          if (member.pendingPermissions.length !== before) {
            emitMemberUpdate(member);
          }
        }
      });

      member.session = handle;
      member.unsubscribe = unsub;
      deps.registerActiveSubagent(member.childSessionId, () => {
        void handle.interruptAndWait();
      });

      // 重启恢复时积压的未送达提及：补为已暂停的待发输入，不自动唤醒
      if (member.missedPosts.length > 0) {
        const missed = member.missedPosts.splice(0);
        for (const post of missed) {
          const prepared: PreparedInput = {
            swarm: {
              postNumber: post.number,
              from: post.from,
              fromKind: post.fromKind,
            },
            content: [
              {
                type: "text",
                text: formatSwarmPostForModel({
                  number: post.number,
                  from: post.from,
                  text: post.text,
                }),
              },
            ],
            appended: [],
          };
          await handle.deliverSwarmPost(prepared, true);
        }
      }

      return handle;
    })();

    member.opening = openTask;
    try {
      return await openTask;
    } finally {
      member.opening = undefined;
    }
  }

  function scheduleQuietCheck(): void {
    if (disposed || !active || !armed || quietReminderSent) return;
    if (quietTimer !== undefined) clearImmediate(quietTimer);
    quietTimer = setImmediate(() => {
      quietTimer = undefined;
      void maybeSendQuietReminder();
    });
  }

  async function maybeSendQuietReminder(): Promise<void> {
    // 让出一拍微任务，确保连续 Turn 衔接或并发投递已稳定落位
    await Promise.resolve();
    if (disposed || deps.isClosing() || !active || !armed || quietReminderSent) return;
    if (deliveringCount > 0) return;
    if (deps.isCoordinatorBusy() || deps.hasCoordinatorPendingActive()) return;
    if (members.size === 0 && nextPostNumber === 1) return;

    for (const m of members.values()) {
      if (m.status === "removed") continue;
      if (m.status === "working") return;
      if (m.opening !== undefined) return;
      if (m.session?.isBusy() || m.session?.hasActivePendingInputs()) return;
    }

    quietReminderSent = true;
    const text =
      "@coordinator All swarm members are waiting or paused and there are no pending deliveries. Review the board and member statuses, dispatch next steps, or call `swarm_end` if the work is complete.";
    const number = nextPostNumber++;
    await deps.emitDurable("swarm.posted", {
      number,
      from: "Runtime",
      fromKind: "runtime",
      text,
      mentions: ["coordinator"],
      recipients: ["coordinator"],
    });
    const prepared: PreparedInput = {
      swarm: { postNumber: number, from: "Runtime", fromKind: "runtime" },
      content: [
        {
          type: "text",
          text: formatSwarmPostForModel({ number, from: "Runtime", text }),
        },
      ],
      appended: [],
    };
    await deps.deliverToCoordinator(prepared, false);
  }

  async function publishAndDeliverPost(options: {
    text: string;
    from: string;
    fromKind: SwarmAuthorKind;
    defaultToCoordinator?: boolean | undefined;
    charterOf?: string | undefined;
    skipDelivery?: boolean | undefined;
  }): Promise<SwarmToolActionResult<{ number: number; recipients: string[] }>> {
    if (!active) {
      return {
        ok: false,
        code: "invalid_input",
        message: "No active swarm in this session. Call `swarm_init` first.",
      };
    }
    const trimmed = options.text.trim();
    if (trimmed === "") {
      return {
        ok: false,
        code: "invalid_input",
        message: "Post text must not be empty.",
      };
    }

    // ADR-0089 §4：独立工作树作者在发帖唤醒验证者之前先提交工作区改动
    let authorLatestCommit: string | undefined;
    const authorMember = options.fromKind === "member" ? members.get(options.from) : undefined;
    if (authorMember?.isolated) {
      const wt = await ensureWorktreeRecord(authorMember);
      if (wt !== undefined) {
        await deps.worktrees
          .checkpoint(wt, `Swarm @${authorMember.name} post`)
          .catch(() => undefined);
        authorLatestCommit = await deps.worktrees.currentHead(wt.worktree).catch(() => undefined);
      }
    }

    const resolved = options.skipDelivery
      ? { ok: true as const, mentions: [] as string[], recipients: [] as string[] }
      : resolveSwarmMentions({
          text: trimmed,
          author: options.from,
          authorKind: options.fromKind,
          members: [...members.values()].map((m) => ({
            name: m.name,
            removed: m.status === "removed",
          })),
          defaultToCoordinator: options.defaultToCoordinator,
        });

    if (!resolved.ok) {
      return {
        ok: false,
        code: "invalid_input",
        message: resolved.error,
        userMessage: `成员 ${resolved.removedMember} 已移除，无法被唤醒`,
      };
    }

    if (options.fromKind !== "runtime") {
      armed = true;
      quietReminderSent = false;
    }

    const number = nextPostNumber++;
    await deps.emitDurable("swarm.posted", {
      number,
      from: options.from,
      fromKind: options.fromKind,
      text: trimmed,
      mentions: resolved.mentions,
      recipients: resolved.recipients,
      ...(options.charterOf !== undefined ? { charterOf: options.charterOf } : {}),
    });

    if (resolved.recipients.length > 0) {
      deliveringCount += 1;
      try {
        for (const target of resolved.recipients) {
          if (target === "coordinator") {
            const prepared: PreparedInput = {
              swarm: { postNumber: number, from: options.from, fromKind: options.fromKind },
              content: [
                {
                  type: "text",
                  text: formatSwarmPostForModel({ number, from: options.from, text: trimmed }),
                },
              ],
              appended: [],
            };
            await deps.deliverToCoordinator(prepared, false);
            continue;
          }
          const member = members.get(target);
          if (member === undefined || member.status === "removed") continue;
          const handle = await ensureMemberSession(member, false);

          // ADR-0089 §4：若独立工作树作者 @ 了独立工作树审查成员，且该成员自身分支无未并回改动，
          // 在开轮前先把它的工作树清干净并检出作者最新提交（分离头指针）
          let checkedOut: { member: string; commit: string } | undefined;
          if (authorMember !== undefined && authorLatestCommit !== undefined && member.isolated) {
            if (!handle.isBusy()) {
              const targetWt = await ensureWorktreeRecord(member);
              if (targetWt !== undefined) {
                const onBranch = await deps.worktrees.isOnMemberBranch(targetWt);
                const ownChanges = onBranch
                  ? await deps.worktrees.checkpoint(targetWt, `Swarm @${member.name} snapshot`)
                  : undefined;
                if (ownChanges === undefined) {
                  const sha = await deps.worktrees.resetToCommit(
                    targetWt.worktree,
                    authorLatestCommit,
                  );
                  checkedOut = { member: authorMember.name, commit: sha };
                }
              }
            } else {
              member.pendingCheckoutCommit = authorLatestCommit;
            }
          }

          if (member.status === "paused") {
            member.status = "working";
            member.pauseError = undefined;
            emitMemberUpdate(member);
          }

          const prepared: PreparedInput = {
            swarm: { postNumber: number, from: options.from, fromKind: options.fromKind },
            content: [
              {
                type: "text",
                text: formatSwarmPostForModel({
                  number,
                  from: options.from,
                  text: trimmed,
                  checkedOut,
                }),
              },
            ],
            appended: [],
          };
          await handle.deliverSwarmPost(prepared, false);
        }
      } finally {
        deliveringCount -= 1;
        scheduleQuietCheck();
      }
    } else {
      scheduleQuietCheck();
    }

    return {
      ok: true,
      text:
        resolved.recipients.length > 0
          ? `Posted #${number}; delivered to ${resolved.recipients.map((r) => `@${r}`).join(", ")}.`
          : `Posted #${number} on the board (no recipients mentioned).`,
      output: { number, recipients: resolved.recipients },
    };
  }

  async function checkMemberUnmergedChanges(
    member: MemberRuntimeState,
  ): Promise<SubagentChanges | undefined> {
    if (!member.isolated) return undefined;
    const wt = await ensureWorktreeRecord(member);
    if (wt === undefined) return undefined;
    return await deps.worktrees.checkpoint(wt, `Swarm @${member.name} snapshot`);
  }

  async function removeMemberCore(
    name: string,
    reason?: string,
  ): Promise<
    | { ok: true }
    | { ok: false; kind: "not_found" | "unmerged"; message: string; userMessage: string }
  > {
    const member = members.get(name);
    if (member === undefined || member.status === "removed") {
      return {
        ok: false,
        kind: "not_found",
        message: `Member "${name}" does not exist or has already been removed.`,
        userMessage: `成员 ${name} 不存在或已移除`,
      };
    }

    // 先中断正在运行的轮次并等待落定，以便安全检查独立工作树是否有未并回提交
    if (member.session?.isBusy()) {
      await member.session.interruptAndWait();
    }

    if (member.isolated) {
      const unmerged = await checkMemberUnmergedChanges(member);
      if (unmerged !== undefined) {
        return {
          ok: false,
          kind: "unmerged",
          message: `Cannot remove isolated member "${name}" because it has unapplied commits on branch "${unmerged.branch}" (id: "${member.childSessionId}"). Call \`apply_subagent_changes\` with id "${member.name}" (or "${member.childSessionId}") first.`,
          userMessage: `成员 ${name} 在独立工作树分支 ${unmerged.branch} 上有未并回的提交，请先并回后再移除`,
        };
      }
    }

    member.status = "removed";
    member.toolActivity = undefined;
    member.pauseError = undefined;
    member.pendingPermissions = [];
    member.missedPosts = [];

    if (member.unsubscribe !== undefined) {
      member.unsubscribe();
      member.unsubscribe = undefined;
    }
    deps.unregisterActiveSubagent(member.childSessionId);
    if (member.session !== undefined) {
      member.session.clearPendingSwarmInputs();
      await member.session.closeUnderlying().catch(() => undefined);
      member.session = undefined;
    }
    if (member.isolated) {
      const wt = await ensureWorktreeRecord(member);
      if (wt !== undefined) {
        await deps.worktrees.remove(wt, true).catch(warnWorktreeCleanupFailed);
      }
    }

    await deps.emitDurable("swarm.member_removed", {
      name,
      ...(reason !== undefined && reason.trim() !== "" ? { reason: reason.trim() } : {}),
    });
    deps.notifyCoordinatorIdle();
    scheduleQuietCheck();
    return { ok: true };
  }

  async function terminateSwarm(
    reason: "coordinator" | "user" | "rewound",
    summary?: string,
  ): Promise<SwarmUnmergedWorktree[]> {
    if (quietTimer !== undefined) {
      clearImmediate(quietTimer);
      quietTimer = undefined;
    }
    active = false;
    deps.clearCoordinatorSwarmInputs();

    // 1. 中断并关闭所有仍在运行或打开的常驻成员会话
    for (const member of members.values()) {
      if (member.unsubscribe !== undefined) {
        member.unsubscribe();
        member.unsubscribe = undefined;
      }
      deps.unregisterActiveSubagent(member.childSessionId);
      if (member.session !== undefined) {
        member.session.clearPendingSwarmInputs();
        await member.session.interruptAndWait().catch(() => undefined);
        await member.session.closeUnderlying().catch(() => undefined);
        member.session = undefined;
      }
      if (member.status !== "removed") {
        member.status = "waiting";
        member.toolActivity = undefined;
        member.pendingPermissions = [];
      }
    }

    // 2. 结算独立工作树：收集未并回工作树，已并回的通过 cleanupMerged 清理
    const unmerged: SwarmUnmergedWorktree[] = [];
    for (const member of members.values()) {
      if (member.status === "removed" || !member.isolated) continue;
      const wt = await ensureWorktreeRecord(member);
      if (wt === undefined) continue;
      const onBranch = await deps.worktrees.isOnMemberBranch(wt).catch(() => false);
      const changes = onBranch
        ? await deps.worktrees
            .checkpoint(wt, `Swarm @${member.name} final snapshot`)
            .catch(() => undefined)
        : undefined;
      if (changes !== undefined) {
        unmerged.push({
          name: member.name,
          childSessionId: member.childSessionId,
          branch: changes.branch,
          base: changes.base,
          head: changes.head,
          worktree: changes.worktree,
          files: changes.files,
        });
      } else {
        await deps.worktrees.remove(wt, true).catch(warnWorktreeCleanupFailed);
      }
    }
    await deps.worktrees.cleanupMerged().catch(warnWorktreeCleanupFailed);

    // 若 cleanupMerged 因分支在主仓库 HEAD 已合并而删掉了工作树，从 unmerged 中剔除已合并项
    const remainingUnmerged: SwarmUnmergedWorktree[] = [];
    for (const item of unmerged) {
      const stillExists = await deps.worktrees.loadRecord(item.childSessionId);
      if (stillExists !== undefined) {
        remainingUnmerged.push(item);
      }
    }

    await deps.emitDurable("swarm.ended", {
      reason,
      ...(summary !== undefined && summary.trim() !== "" ? { summary: summary.trim() } : {}),
      ...(remainingUnmerged.length > 0 ? { unmerged: remainingUnmerged } : {}),
    });

    deps.syncCoordinatorTools();
    deps.notifyCoordinatorIdle();
    return remainingUnmerged;
  }

  // ── 协调者工具处理器 ────────────────────────────────────────

  const toolHandlers = {
    catalog: catalogSnapshot,
    async init(input: { title: string }): Promise<SwarmToolActionResult<{ title: string }>> {
      const trimmed = typeof input.title === "string" ? input.title.trim() : "";
      if (trimmed === "") {
        return {
          ok: false,
          code: "invalid_input",
          message: "Swarm title must not be empty.",
        };
      }
      if (active) {
        return {
          ok: false,
          code: "invalid_input",
          message: "A swarm is already active in this session.",
        };
      }
      title = trimmed;
      active = true;
      armed = true;
      quietReminderSent = false;
      nextPostNumber = 1;
      members.clear();
      const ev = await deps.emitDurable("swarm.created", { title: trimmed });
      initSeq = ev.seq;
      deps.syncCoordinatorTools();
      return {
        ok: true,
        text: `Initialized swarm "${trimmed}". Add members with \`swarm_add_member\` and dispatch tasks with \`swarm_post\`.`,
        output: { title: trimmed },
      };
    },

    async addMember(input: {
      name: string;
      charter?: Partial<SwarmCharter> | undefined;
      model?: string | undefined;
      profile?: string | undefined;
      effort?: ReasoningEffort | undefined;
      preset?: "general" | "explore" | undefined;
      isolated?: boolean | undefined;
      agent?: string | undefined;
    }): Promise<SwarmToolActionResult> {
      if (!active) {
        return {
          ok: false,
          code: "invalid_input",
          message: "Swarm is not initialized yet. Call `swarm_init` with a title first.",
        };
      }
      const nameError = validateSwarmMemberName(input.name, members.keys());
      if (nameError !== undefined) {
        return { ok: false, code: "invalid_input", message: nameError };
      }
      const charterValidated = validateSwarmCharter(input.charter);
      if (!charterValidated.ok) {
        return { ok: false, code: "invalid_input", message: charterValidated.error };
      }
      const selected = resolveMemberSelection({
        model: input.model,
        profile: input.profile,
        effort: input.effort,
        preset: input.preset,
        agent: input.agent,
        requireExplicitModelOrProfile: false,
      });
      if (!selected.ok) {
        return { ok: false, code: "invalid_input", message: selected.message };
      }

      const isolated = input.isolated === true;
      const childSessionId = deps.newChildSessionId();
      let worktreeRecord: SwarmWorktreeHandle | undefined;
      if (isolated) {
        const dir = deps.currentDirectory();
        let repository: string;
        try {
          repository = await deps.worktrees.inspectRepository(dir.cwd);
          worktreeRecord = await deps.worktrees.create({
            childSessionId,
            repository,
            cwd: dir.cwd,
            workspaceRoot: dir.workspaceRoot,
            task: `Swarm @${input.name}: ${charterValidated.charter.owns}`,
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
      const member: MemberRuntimeState = {
        name: input.name,
        childSessionId,
        charter: charterValidated.charter,
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
        status: "waiting",
        pendingPermissions: [],
        missedPosts: [],
      };
      members.set(member.name, member);

      try {
        await ensureMemberSession(member, true);
      } catch (err) {
        members.delete(member.name);
        if (worktreeRecord !== undefined) {
          await deps.worktrees.remove(worktreeRecord, true).catch(() => undefined);
        }
        return {
          ok: false,
          code: "swarm_error",
          message: `Failed to create member session: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      await deps.emitDurable("swarm.member_added", {
        name: member.name,
        childSessionId: member.childSessionId,
        charter: member.charter,
        model: member.model,
        ...(member.reasoningEffort !== undefined
          ? { reasoningEffort: member.reasoningEffort }
          : {}),
        ...(member.profile !== undefined ? { profile: member.profile } : {}),
        preset: member.preset,
        isolated: member.isolated,
        ...(member.worktreeRef !== undefined ? { worktree: member.worktreeRef } : {}),
      });

      // ADR-0089 §3：加入时将公开任务书作为一条帖子发到留言板
      const charterText = formatCharterPostText(member.name, member.charter);
      await publishAndDeliverPost({
        text: charterText,
        from: "coordinator",
        fromKind: "coordinator",
        charterOf: member.name,
        skipDelivery: true,
      });

      return {
        ok: true,
        text: `Added member @${member.name} (session: ${member.childSessionId}, model: ${member.model.provider}/${member.model.model}, preset: ${member.preset}${member.isolated ? `, isolated branch: ${member.worktreeRef?.branch}` : ""}) and posted its charter.`,
        output: {
          name: member.name,
          childSessionId: member.childSessionId,
          model: `${member.model.provider}/${member.model.model}`,
          reasoningEffort: member.reasoningEffort,
          preset: member.preset,
          isolated: member.isolated,
        },
      };
    },

    post(input: { text: string }) {
      return publishAndDeliverPost({
        text: input.text,
        from: "coordinator",
        fromKind: "coordinator",
      });
    },

    async changeModel(input: {
      name: string;
      model?: string | undefined;
      profile?: string | undefined;
      effort?: ReasoningEffort | undefined;
      agent?: string | undefined;
    }): Promise<SwarmToolActionResult> {
      if (!active) {
        return {
          ok: false,
          code: "invalid_input",
          message: "No active swarm in this session.",
        };
      }
      const member = members.get(input.name);
      if (member === undefined || member.status === "removed") {
        return {
          ok: false,
          code: "invalid_input",
          message: `Member "${input.name}" does not exist or has been removed.`,
        };
      }
      const selected = resolveMemberSelection({
        model: input.model,
        profile: input.profile,
        effort: input.effort,
        preset: member.preset,
        agent: input.agent,
        requireExplicitModelOrProfile: true,
      });
      if (!selected.ok) {
        return { ok: false, code: "invalid_input", message: selected.message };
      }

      const handle = await ensureMemberSession(member, false);
      const modelRef = selected.resolved.model.ref;
      await handle.setModelAndEffort(modelRef, selected.effort);

      member.model = modelRef;
      member.reasoningEffort = selected.effort;
      member.profile = selected.profile;

      await deps.emitDurable("swarm.member_model_changed", {
        name: member.name,
        model: member.model,
        ...(member.reasoningEffort !== undefined
          ? { reasoningEffort: member.reasoningEffort }
          : {}),
        ...(member.profile !== undefined ? { profile: member.profile } : {}),
      });

      const modelKey = `${modelRef.provider}/${modelRef.model}`;
      const wasPaused = member.status === "paused";
      if (wasPaused) {
        member.status = "working";
        member.pauseError = undefined;
        emitMemberUpdate(member);
        await handle.resumeFromModelChange(modelKey);
      }

      return {
        ok: true,
        text: `Switched @${member.name} to ${modelKey}${selected.effort ? ` (effort: ${selected.effort})` : ""}${wasPaused ? " and resumed from paused state" : ""}.`,
        output: {
          name: member.name,
          model: modelKey,
          reasoningEffort: selected.effort,
          resumed: wasPaused,
        },
      };
    },

    async removeMember(input: {
      name: string;
      reason?: string | undefined;
    }): Promise<SwarmToolActionResult> {
      if (!active) {
        return {
          ok: false,
          code: "invalid_input",
          message: "No active swarm in this session.",
        };
      }
      const res = await removeMemberCore(input.name, input.reason);
      if (!res.ok) {
        return {
          ok: false,
          code: "invalid_input",
          message: res.message,
        };
      }
      return {
        ok: true,
        text: `Removed member @${input.name}.`,
        output: { name: input.name },
      };
    },

    async end(input: {
      summary?: string | undefined;
    }): Promise<SwarmToolActionResult<{ unmerged: SwarmUnmergedWorktree[] }>> {
      if (!active) {
        return {
          ok: false,
          code: "invalid_input",
          message: "No active swarm in this session.",
        };
      }
      const unmerged = await terminateSwarm("coordinator", input.summary);
      const unmergedSummary =
        unmerged.length > 0
          ? ` Retained ${unmerged.length} unmerged worktree branch(es): ${unmerged.map((u) => `@${u.name} (${u.branch})`).join(", ")}.`
          : " All merged member worktrees were cleaned up.";
      return {
        ok: true,
        text: `Swarm "${title}" ended.${unmergedSummary}`,
        output: { unmerged },
      };
    },
  };

  // ── 公开控制器方法 ─────────────────────────────────────────

  return {
    async initializeFromLog() {
      const events = deps.durableEvents();
      const first = events[0];
      const forkSeq = first?.type === "session.created" ? (first.payload.forkedFrom?.seq ?? 0) : 0;

      let view: SwarmView | undefined;
      for (const ev of events) {
        view = reduceSwarmDurable(view, ev, {
          forkSeq,
          coordinatorModel: deps.coordinatorModel().model.ref,
        });
      }

      if (view === undefined) {
        active = false;
        initSeq = undefined;
        members.clear();
        return;
      }

      const existingWorktrees = await deps.worktrees.listParentRecords().catch(() => []);
      const wtMap = new Map(existingWorktrees.map((r) => [r.childSessionId, r]));

      title = view.title;
      initSeq = view.createdSeq;
      nextPostNumber = (view.posts.at(-1)?.number ?? 0) + 1;
      active = view.status === "active";
      // 重启刚打开时不立即主动触发安静提醒（等有新活动后再计）
      armed = false;
      quietReminderSent = view.posts.at(-1)?.fromKind === "runtime";

      members.clear();
      for (const mv of view.members) {
        const wtRecord = wtMap.get(mv.childSessionId);
        members.set(mv.name, {
          name: mv.name,
          childSessionId: mv.childSessionId,
          charter: mv.charter,
          model: mv.model,
          reasoningEffort: mv.reasoningEffort,
          profile: mv.profile,
          preset: mv.preset,
          isolated: mv.isolated,
          worktreeRef: mv.worktree,
          ...(wtRecord !== undefined ? { worktreeRecord: wtRecord } : {}),
          status: mv.status === "removed" ? "removed" : "waiting",
          pendingPermissions: [],
          missedPosts: [],
        });
      }

      if (!active) return;

      // ADR-0089 §7：比对已发帖子的 recipients 与目标会话日志，缺失的作为暂停待发输入补送（不自动唤醒）
      const coordDelivered = new Set<number>();
      for (const ev of events) {
        if (ev.seq <= view.createdSeq) continue;
        if (ev.type === "message.user" && ev.payload.swarm !== undefined) {
          coordDelivered.add(ev.payload.swarm.postNumber);
        }
      }

      const childDeliveredCache = new Map<string, Set<number>>();
      const getChildDelivered = async (childSessionId: string): Promise<Set<number>> => {
        const cached = childDeliveredCache.get(childSessionId);
        if (cached !== undefined) return cached;
        const set = new Set<number>();
        const childEvents = await deps.readChildDurableEvents(childSessionId).catch(() => []);
        for (const ev of childEvents) {
          if (ev.type === "message.user" && ev.payload.swarm !== undefined) {
            set.add(ev.payload.swarm.postNumber);
          }
        }
        childDeliveredCache.set(childSessionId, set);
        return set;
      };

      for (const post of view.posts) {
        for (const recipient of post.recipients) {
          if (recipient === "coordinator") {
            if (!coordDelivered.has(post.number)) {
              const prepared: PreparedInput = {
                swarm: {
                  postNumber: post.number,
                  from: post.from,
                  fromKind: post.fromKind,
                },
                content: [
                  {
                    type: "text",
                    text: formatSwarmPostForModel({
                      number: post.number,
                      from: post.from,
                      text: post.text,
                    }),
                  },
                ],
                appended: [],
              };
              await deps.deliverToCoordinator(prepared, true);
            }
            continue;
          }
          const m = members.get(recipient);
          if (m === undefined || m.status === "removed") continue;
          const delivered = await getChildDelivered(m.childSessionId);
          if (!delivered.has(post.number)) {
            m.missedPosts.push({
              number: post.number,
              from: post.from,
              fromKind: post.fromKind,
              text: post.text,
              mentions: post.mentions,
              recipients: post.recipients,
              ...(post.charterOf !== undefined ? { charterOf: post.charterOf } : {}),
            });
          }
        }
      }
    },

    isActive: () => active,

    createdSeq: () => initSeq,

    activeIsolatedChildIds() {
      if (!active) return new Set();
      const ids = new Set<string>();
      for (const m of members.values()) {
        if (m.status !== "removed" && m.isolated) ids.add(m.childSessionId);
      }
      return ids;
    },

    coordinatorTools: () => createSwarmCoordinatorTools(toolHandlers),

    publishMemberSnapshots(_listener) {
      return this.memberSnapshots();
    },

    memberSnapshots() {
      if (!active) return [];
      const out: SwarmMemberUpdatedPayload[] = [];
      for (const m of members.values()) {
        const snap = snapshotPayload(m);
        if (
          snap !== undefined &&
          (snap.status !== "waiting" || (snap.pendingPermissions?.length ?? 0) > 0)
        ) {
          out.push(snap);
        }
      }
      return out;
    },

    hasRunningWork() {
      if (!active) return false;
      if (deliveringCount > 0) return true;
      for (const m of members.values()) {
        if (m.status === "working" || m.opening !== undefined || m.session?.isBusy()) {
          return true;
        }
      }
      return false;
    },

    async openOrGetMemberBySessionId(childSessionId: string) {
      for (const m of members.values()) {
        if (m.childSessionId === childSessionId) {
          if (!active || m.status === "removed") {
            return undefined;
          }
          const handle = await ensureMemberSession(m, false);
          return { session: handle, active: true };
        }
      }
      return undefined;
    },

    async postFromUser(input: { text: string }) {
      if (!active) {
        throw deps.commandError("invalid_command", "当前会话没有进行中的 Swarm");
      }
      const trimmed = input.text.trim();
      if (trimmed === "") {
        throw deps.commandError("invalid_command", "Swarm 帖子内容不能为空");
      }
      const res = await publishAndDeliverPost({
        text: trimmed,
        from: "user",
        fromKind: "user",
        defaultToCoordinator: true,
      });
      if (!res.ok || res.output === undefined) {
        throw deps.commandError(
          "invalid_command",
          res.ok ? "发帖失败" : (res.userMessage ?? res.message),
        );
      }
      return res.output;
    },

    async removeMemberFromUser(name: string) {
      if (!active) {
        throw deps.commandError("invalid_command", "当前会话没有进行中的 Swarm");
      }
      const trimmed = name.trim();
      if (trimmed === "") {
        throw deps.commandError("invalid_command", "成员名称不能为空");
      }
      const res = await removeMemberCore(trimmed);
      if (!res.ok) {
        throw deps.commandError("invalid_command", res.userMessage);
      }
    },

    async endFromUser() {
      if (!active) {
        throw deps.commandError("invalid_command", "当前会话没有进行中的 Swarm");
      }
      const unmerged = await terminateSwarm("user");
      return { unmerged };
    },

    async endOnRewind() {
      if (!active) return;
      await terminateSwarm("rewound");
    },

    onCoordinatorTurnSettled() {
      if (!active) return;
      armed = true;
      scheduleQuietCheck();
    },

    lookupMemberWorktreeSync(idOrName: string) {
      for (const m of members.values()) {
        if ((m.childSessionId === idOrName || m.name === idOrName) && m.isolated) {
          const wt = m.worktreeRecord;
          if (wt?.changes === undefined) return undefined;
          return {
            changes: wt.changes,
            repository: wt.repository,
            applied: wt.applied === true,
          };
        }
      }
      return undefined;
    },

    async lookupMemberWorktreeChanges(idOrName: string) {
      for (const m of members.values()) {
        if ((m.childSessionId === idOrName || m.name === idOrName) && m.isolated) {
          const wt = await ensureWorktreeRecord(m);
          if (wt === undefined) return undefined;
          const changes = await deps.worktrees.checkpoint(wt, `Swarm @${m.name} snapshot`);
          if (changes === undefined) return undefined;
          return {
            memberName: m.name,
            record: wt,
            changes,
            stillActive: active && m.status !== "removed",
          };
        }
      }
      return undefined;
    },

    async onMemberWorktreeApplied(idOrName: string, appliedHead: string) {
      for (const m of members.values()) {
        if ((m.childSessionId === idOrName || m.name === idOrName) && m.isolated) {
          const wt = await ensureWorktreeRecord(m);
          if (wt === undefined) return;
          if (active && m.status !== "removed") {
            await deps.worktrees.markApplied(wt, appliedHead);
          } else {
            await deps.worktrees.remove(wt, true).catch(warnWorktreeCleanupFailed);
          }
          return;
        }
      }
    },

    async dispose() {
      disposed = true;
      if (quietTimer !== undefined) {
        clearImmediate(quietTimer);
        quietTimer = undefined;
      }
      for (const m of members.values()) {
        if (m.unsubscribe !== undefined) {
          m.unsubscribe();
          m.unsubscribe = undefined;
        }
        deps.unregisterActiveSubagent(m.childSessionId);
        if (m.session !== undefined) {
          await m.session.interruptAndWait().catch(() => undefined);
          await m.session.closeUnderlying().catch(() => undefined);
          m.session = undefined;
        }
      }
    },
  };
}
