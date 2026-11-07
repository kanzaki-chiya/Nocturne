import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  goalStatusLines,
  visibleGoal,
  parseWorkModeSlash,
  pendingBackgroundSubagents,
  type ExternalAgentOverview,
  type SkillOverview,
} from "@nocturne/core/protocol";
import { RpcError, type RpcRuntime } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "../attachment-images";
import type { ComposerSubmit } from "../Composer";
import { Conversation, PermissionCard, QuestionCard } from "../Conversation";
import { phoneWarningText } from "../open-warnings";
import { useDraftControls, useSessionControls } from "../session-controls";
import { PhoneComposer } from "./PhoneComposer";
import { PhoneTasks } from "./PhoneTasks";
import { SessionHeaderTools, sessionInputHistory } from "./SessionHeaderTools";
import { SessionGrants, useSessionGrants } from "../SessionGrants";
import { Button } from "../ui";
import { GoalRow, useGoalExpansion } from "../GoalRow";
import {
  submitAccepted,
  type PhoneCreateOptions,
  type PhoneSession,
  type PhoneSessions,
} from "./sessions";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** /mcp 的文字输出（与桌面 runSlash 相同格式） */
export function mcpText(
  servers: readonly { name: string; state: string; error?: string | undefined }[],
): string {
  return servers.length === 0
    ? "本会话没有配置 MCP 服务器"
    : servers
        .map(
          (server) =>
            `${server.name}  ${server.state}${server.error === undefined ? "" : `：${server.error}`}`,
        )
        .join("\n");
}

/**
 * 会话页：消息流 + 输入框 + 工具栏 + 权限/提问面板，顶栏右侧的上下文圆环与会话菜单
 * 经 portal 放进外壳给的 headerSlot。模型、档位、预设与桌面状态栏共用
 * useSessionControls；手机不写桌面的 lastEffort 偏好。
 */
export function SessionScreen({
  entry,
  connected,
  images,
  openUrl,
  onError,
  onChanged,
  plain = false,
  sessions,
  onForked,
  onManageGrants,
  headerSlot,
  onRename,
}: {
  entry: PhoneSession;
  /** 回退、改动摘要与分叉经由会话管理器（与桌面 Conversations 相同的刷新规则） */
  sessions: PhoneSessions;
  /** 分叉出的新会话已打开，跳过去 */
  onForked: (sessionId: string) => void;
  onManageGrants?: (() => void) | undefined;
  /** 顶栏右侧的位置：上下文圆环与会话菜单渲染在这里 */
  headerSlot?: HTMLElement | null;
  /** 会话菜单「重命名」：弹框在外壳里 */
  onRename?: (() => void) | undefined;
  /** 普通对话工作区：没有项目文件索引，@ 引用不可用（同桌面） */
  plain?: boolean;
  connected: boolean;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
  onError: (message: string) => void;
  /** 发送、压缩后刷新会话列表 */
  onChanged: () => void;
}) {
  const { session, view } = entry;
  const shownGoal = visibleGoal(view.goal);
  const { grants } = useSessionGrants(session, entry.client);
  // 查询函数按会话稳定：圆环的刷新边界由 replaying/key 决定，不因父组件重绘重建。
  const loadContext = useCallback(() => session.describeContext(), [session]);
  const controls = useSessionControls(
    session,
    entry.client.runtime,
    view,
    undefined,
    0,
    entry.workspace,
    entry.replaying,
  );
  const [skills, setSkills] = useState<SkillOverview[]>([]);
  const [agents, setAgents] = useState<ExternalAgentOverview[]>([]);
  // 远程不开放 subagent.list：运行中的后台子代理从视图推导（ADR-0073 §6）
  const backgrounds = useMemo(() => pendingBackgroundSubagents(view.entries), [view.entries]);
  const [busy, setBusy] = useState(false);
  const [goalExpanded, setGoalExpanded] = useGoalExpansion(shownGoal);
  const [dismissed, setDismissed] = useState("");
  // 分叉后的原消息只填一次：取用后清掉，切走再回来或重新打开都不再填
  const [fill, setFill] = useState<{ text: string; seq: number } | undefined>(() => {
    const text = sessions.forkDrafts.get(session.id);
    return text === undefined ? undefined : { text, seq: 1 };
  });
  useEffect(() => {
    sessions.forkDrafts.delete(session.id);
  }, [sessions, session.id]);
  useEffect(() => {
    let active = true;
    void session.describeSkills().then(
      (result) => {
        if (active) setSkills(result.skills);
      },
      () => {
        if (active) setSkills([]);
      },
    );
    void session.describeExternalAgents().then(
      (result) => {
        if (active) setAgents(result.agents);
      },
      () => {
        if (active) setAgents([]);
      },
    );
    return () => {
      active = false;
    };
  }, [session, view.turnCount]);

  const running = busy || view.currentTurn !== undefined || view.status === "compacting";
  /**
   * 发送（ADR-0070 修订 2026-11-01）：Turn 运行中入列为排队，在 done 之后开新 Turn
   * （待发列表的「立即发送」再将其转为插话并入当前 Turn）；空闲时与普通发送相同。
   */
  const submit = async (
    input: ComposerSubmit,
    mode: "steer" | "queue" = "queue",
  ): Promise<boolean> => {
    if (entry.dead) throw new Error("电脑尚未连接");
    if (view.pendingPermission ?? view.pendingQuestion) throw new Error("请先处理待确认的请求");
    if (running || entry.pendingInputs.paused) {
      // ADR-0076：执行方式只能排队
      await session.enqueueInput(input.workMode ? "queue" : mode, {
        text: input.text,
        ...(input.skill ? { skill: input.skill } : {}),
        ...(input.delegate ? { delegate: input.delegate } : {}),
        ...(input.workMode ? { workMode: input.workMode } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      });
      if (input.text !== "") void session.recordInputHistory(input.text).catch(() => undefined);
      onChanged();
      return true;
    }
    setBusy(true);
    try {
      await submitAccepted(
        entry,
        {
          text: input.text,
          ...(input.skill ? { skill: input.skill } : {}),
          ...(input.delegate ? { delegate: input.delegate } : {}),
          ...(input.workMode ? { workMode: input.workMode } : {}),
          ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        },
        (error) => {
          if (
            error !== undefined &&
            !(error instanceof RpcError && error.code === "connection_closed")
          )
            onError(errorText(error));
          onChanged();
        },
      );
    } finally {
      setBusy(false);
    }
    // 与桌面相同：消息被接收后才记入输入历史，记录失败不影响发送
    if (input.text !== "") void session.recordInputHistory(input.text).catch(() => undefined);
    onChanged();
    return true;
  };
  const approvePlan = () => {
    void session.approvePlan().then(onChanged, (error: unknown) => {
      onError(errorText(error));
    });
  };
  const compact = async () => {
    setBusy(true);
    try {
      await session.compact();
    } finally {
      setBusy(false);
    }
    onChanged();
  };
  const slash = async (line: string): Promise<string | boolean> => {
    void session.recordInputHistory(line).catch(() => undefined);
    // ADR-0076 §7：/goal 与 /plan 的无任务子命令
    const work = parseWorkModeSlash(line);
    if (work?.kind === "action") {
      if (work.action === "goal-status") return goalStatusLines(view.goal, Date.now()).join("\n");
      if (work.action === "goal-cancel") {
        await session.cancelGoal();
        return true;
      }
      if (work.action === "goal-stop" || work.action === "goal-resume") {
        if (view.goal === undefined) throw new Error("没有目标");
        if (work.action === "goal-stop") await session.stopGoal();
        else
          void session.resumeGoal().then(onChanged, (error: unknown) => {
            onError(errorText(error));
          });
        return true;
      }
      if (view.plan === undefined) throw new Error("不在计划模式");
      if (work.action === "plan-cancel") await session.cancelPlan();
      else if (running) throw new Error("会话正忙，不能批准计划");
      else approvePlan();
      return true;
    }
    if (line.trim().toLowerCase().startsWith("/compact")) {
      await compact();
      return true;
    }
    return mcpText(await session.mcpServers());
  };
  const subscribeEvents = useCallback(
    (listener: Parameters<NonNullable<Parameters<typeof Conversation>[0]["subscribeEvents"]>>[0]) =>
      entry.client.onEvent((id, event) => {
        if (id === session.id) listener(event);
      }),
    [entry.client, session.id],
  );

  const pendingKey = view.pendingPermission?.requestId ?? view.pendingQuestion?.requestId;
  const reply = {
    ...session,
    respondPermission: async (...args: Parameters<typeof session.respondPermission>) => {
      try {
        await session.respondPermission(...args);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === "unknown_request")) throw e;
      }
      setDismissed(args[0]);
    },
    respondQuestion: async (...args: Parameters<typeof session.respondQuestion>) => {
      try {
        await session.respondQuestion(...args);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === "unknown_request")) throw e;
      }
      setDismissed(args[0]);
    },
  };

  return (
    <>
      {headerSlot &&
        createPortal(
          <>
            <PhoneTasks
              key={session.id}
              tasks={view.backgroundShells}
              session={session}
              connected={connected && !entry.dead}
            />
            <SessionHeaderTools
              context={{
                load: loadContext,
                replaying: entry.replaying === true,
                key: `${view.entries.length}:${view.status}`,
              }}
              connected={connected && !entry.dead}
              running={view.currentTurn !== undefined}
              shell={{
                label: controls.shell?.effective?.kind ?? controls.shell?.selected ?? "—",
                probing: controls.shells === undefined,
                load: () => {
                  controls.loadShells();
                },
              }}
              onRename={() => onRename?.()}
              onCompact={() => {
                void compact().catch((reason: unknown) => {
                  onError(errorText(reason));
                });
              }}
              loadMcp={async () => mcpText(await session.mcpServers())}
              inputHistory={() => sessionInputHistory(view.entries)}
              onPickHistory={(text) => {
                setFill((current) => ({ text, seq: (current?.seq ?? 0) + 1 }));
              }}
            />
          </>,
          headerSlot,
        )}
      <Conversation
        session={session}
        view={view}
        openWarnings={entry.warnings.map(phoneWarningText)}
        openUrl={openUrl}
        cwd={entry.workspace}
        shellKind={controls.shell?.effective?.kind}
        images={images}
        busy={running}
        hidePersistentPermissions
        hideRequests
        subscribeEvents={subscribeEvents}
        onResubmit={async (targetSeq, text, mode, workMode) => {
          // 同桌面 resubmit：先回退再按普通发送；重发只带文本与用户提交的执行方式
          setBusy(true);
          try {
            await sessions.rewind(entry, targetSeq, mode);
          } finally {
            setBusy(false);
          }
          await submit({ text, attachments: [], ...(workMode ? { workMode } : {}) });
        }}
        onApprovePlan={approvePlan}
        onFork={async (targetSeq) => {
          const forked = await sessions.fork(entry, targetSeq);
          onForked(forked.session.id);
        }}
        turnChanges={entry.turnChanges}
        onRewindFiles={async (seq) => {
          setBusy(true);
          try {
            await sessions.rewind(entry, seq, "files");
          } finally {
            setBusy(false);
          }
        }}
        loadChangeDiff={(seq, path) => sessions.turnChangeDiff(entry, seq, path)}
      />
      {backgrounds.length > 0 && (
        <div className="pi-list" aria-label="后台子代理">
          {backgrounds.map((item) => (
            <div className="pi-item" key={item.childSessionId}>
              <span>
                {[item.profile, item.model, item.effort, "后台"].filter(Boolean).join(" · ")}
              </span>
              <span className="pi-text">{item.task}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void entry.client.runtime
                    .cancelSubagent({
                      parentSessionId: session.id,
                      childSessionId: item.childSessionId,
                    })
                    .catch((cause: unknown) => {
                      onError(errorText(cause));
                    });
                }}
              >
                取消
              </Button>
            </div>
          ))}
        </div>
      )}
      {shownGoal && (
        <GoalRow
          goal={shownGoal}
          expanded={goalExpanded}
          onExpand={setGoalExpanded}
          onError={(error) => {
            onError(errorText(error));
          }}
          onStopGoal={() => session.stopGoal()}
          onResumeGoal={() => session.resumeGoal()}
          onCancelGoal={() => session.cancelGoal()}
        />
      )}
      <PhoneComposer
        key={session.id}
        variant="session"
        controls={controls.controls}
        grantsFooter={<SessionGrants grants={grants} session={session} onManage={onManageGrants} />}
        running={running}
        disabled={connected && !entry.dead ? undefined : "电脑尚未连接"}
        skills={skills}
        externalAgents={agents}
        onSubmit={submit}
        onInterrupt={() => {
          session.interrupt();
        }}
        pendingInputs={entry.pendingInputs}
        onUpdatePending={async (id, patch) => {
          try {
            await session.updateInput(id, {
              ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
              ...(patch.text !== undefined ? { input: { text: patch.text } } : {}),
            });
          } finally {
            entry.pendingInputs = await session.pendingInputs().catch(() => entry.pendingInputs);
          }
        }}
        onCancelPending={async (id) => {
          try {
            await session.cancelInput(id);
          } finally {
            entry.pendingInputs = await session.pendingInputs().catch(() => entry.pendingInputs);
          }
        }}
        onResumePending={async () => {
          setBusy(true);
          try {
            await session.resumeInputs();
          } finally {
            setBusy(false);
            entry.pendingInputs = await session.pendingInputs().catch(() => entry.pendingInputs);
          }
        }}
        onSlash={slash}
        fileRefs={plain ? null : { load: () => session.fileIndex(), key: view.turnCount }}
        fill={fill}
        getVisionHint={controls.visionHint}
      />
      {pendingKey !== undefined &&
        pendingKey !== dismissed &&
        connected &&
        (view.pendingPermission ?? view.pendingQuestion) && (
          <div
            className="phone-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={view.pendingPermission ? "权限面板" : "提问面板"}
          >
            {view.pendingPermission ? (
              <PermissionCard
                key={pendingKey}
                pending={view.pendingPermission}
                session={reply}
                cwd={entry.workspace}
                hidePersistentPermissions
              />
            ) : view.pendingQuestion ? (
              <QuestionCard
                key={pendingKey}
                pending={view.pendingQuestion}
                session={reply}
                attachmentLimit={Math.floor(((16 * 1024 * 1024 - 64 * 1024) * 3) / 4) - 1024}
              />
            ) : null}
          </div>
        )}
    </>
  );
}

/**
 * 项目页底部的输入框：直接输入即在该目录新建会话。草稿控件不读设置（远程不开放
 * describeSettings），未选过的档位与预设显示「默认」，由 Core 解析项目默认。
 */
export function DraftComposer({
  runtime,
  workspace,
  connected,
  onCreate,
}: {
  runtime: RpcRuntime | undefined;
  workspace: string;
  connected: boolean;
  onCreate: (input: ComposerSubmit, options: PhoneCreateOptions) => Promise<void>;
}) {
  const draft = useDraftControls(runtime, undefined, 0, workspace, false);
  return (
    <PhoneComposer
      variant="draft"
      controls={draft.controls}
      running={false}
      disabled={!connected ? "电脑尚未连接" : draft.loading ? "正在读取电脑上的模型…" : undefined}
      placeholder="输入消息"
      onSubmit={async (input) => {
        await onCreate(input, draft.createOptions());
        return true;
      }}
      onInterrupt={() => undefined}
      onSlash={() => Promise.reject(new Error("请先打开会话"))}
    />
  );
}
