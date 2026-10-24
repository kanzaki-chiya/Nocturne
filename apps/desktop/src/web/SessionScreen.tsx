import { useCallback, useEffect, useState } from "react";

import type { ExternalAgentOverview, SkillOverview } from "@nocturne/core/protocol";
import { RpcError, type RpcRuntime } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "../attachment-images";
import type { ComposerSubmit } from "../Composer";
import { Conversation, PermissionCard, QuestionCard } from "../Conversation";
import { phoneWarningText } from "../open-warnings";
import { useDraftControls, useSessionControls } from "../session-controls";
import { PhoneComposer } from "./PhoneComposer";
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
 * 会话页：消息流 + 输入框 + 工具栏 + 权限/提问面板。模型、档位、预设与桌面
 * 状态栏共用 useSessionControls；手机不写桌面的 lastEffort 偏好。
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
}: {
  entry: PhoneSession;
  /** 回退、改动摘要与分叉经由会话管理器（与桌面 Conversations 相同的刷新规则） */
  sessions: PhoneSessions;
  /** 分叉出的新会话已打开，跳过去 */
  onForked: (sessionId: string) => void;
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
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState("");
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
  const submit = async (input: ComposerSubmit): Promise<boolean> => {
    if (entry.dead) throw new Error("电脑尚未连接");
    if (view.pendingPermission ?? view.pendingQuestion) throw new Error("请先处理待确认的请求");
    setBusy(true);
    try {
      await submitAccepted(
        entry,
        {
          text: input.text,
          ...(input.skill ? { skill: input.skill } : {}),
          ...(input.delegate ? { delegate: input.delegate } : {}),
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
  const slash = async (line: string): Promise<string | boolean> => {
    void session.recordInputHistory(line).catch(() => undefined);
    if (line.trim().toLowerCase().startsWith("/compact")) {
      setBusy(true);
      try {
        await session.compact();
      } finally {
        setBusy(false);
      }
      onChanged();
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
        onResubmit={async (targetSeq, text, mode) => {
          // 同桌面 resubmit：先回退再按普通发送；重发只带文本
          setBusy(true);
          try {
            await sessions.rewind(entry, targetSeq, mode);
          } finally {
            setBusy(false);
          }
          await submit({ text, attachments: [] });
        }}
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
      <PhoneComposer
        key={session.id}
        variant="session"
        controls={controls.controls}
        running={running}
        disabled={connected && !entry.dead ? undefined : "电脑尚未连接"}
        skills={skills}
        externalAgents={agents}
        onSubmit={submit}
        onInterrupt={() => {
          session.interrupt();
        }}
        onSlash={slash}
        context={{
          load: loadContext,
          replaying: entry.replaying === true,
          key: `${view.entries.length}:${view.status}`,
        }}
        fileRefs={plain ? null : { load: () => session.fileIndex(), key: view.turnCount }}
        readInputHistory={() => session.readInputHistory()}
        getVisionHint={controls.visionHint}
        shell={{
          label: controls.shell?.effective?.kind ?? controls.shell?.selected ?? "—",
          note: controls.shellControl.note,
        }}
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
              <QuestionCard key={pendingKey} pending={view.pendingQuestion} session={reply} />
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
      placeholder="输入消息，在这里新建会话"
      onSubmit={async (input) => {
        await onCreate(input, draft.createOptions());
        return true;
      }}
      onInterrupt={() => undefined}
      onSlash={() => Promise.reject(new Error("请先打开会话"))}
    />
  );
}
