/**
 * 成员会话标签（ADR-0089 §8）：经 `session.open` 打开常驻成员子会话，复用 `Conversation`、
 * `QuestionCard` 与 `Composer` 实现私信、权限确认、回答提问与中断。
 * 成员被移除或 Swarm 结束后转为只读冻结展示，隐藏输入区；关闭标签只释放句柄。
 */
import { useMemo, useState } from "react";
import type { SwarmMemberStatus, SwarmView } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { parseSlash } from "./commands";
import { Composer, type ComposerSubmit, type FileRefSource } from "./Composer";
import { Conversation, QuestionCard, type FileLinkHooks } from "./Conversation";
import type { DesktopHost } from "./host";
import type { PrefsStore } from "./prefs";
import { useSwarmMemberSession } from "./swarm-member-session";

export interface SwarmMemberPaneProps {
  childSessionId: string;
  memberName: string;
  memberStatus: SwarmMemberStatus | undefined;
  swarmStatus: SwarmView["status"] | undefined;
  workspace: string;
  ensureClient: () => Promise<RpcClient>;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
  fileLinks?: FileLinkHooks | undefined;
  prefs?: PrefsStore | undefined;
  pickImages: DesktopHost["pickImages"];
}

export function SwarmMemberPane({
  childSessionId,
  memberName,
  memberStatus,
  swarmStatus,
  workspace,
  ensureClient,
  images,
  openUrl,
  fileLinks,
  prefs,
  pickImages,
}: SwarmMemberPaneProps) {
  const state = useSwarmMemberSession({
    ensureClient,
    childSessionId,
    fallbackCwd: workspace,
  });
  const [submitError, setSubmitError] = useState<string>();
  const frozen =
    swarmStatus !== "active" || memberStatus === undefined || memberStatus === "removed";
  const recipientLabel = `@${memberName}`;

  const readySession = state.status === "ready" ? state.session : undefined;
  const readyTurnCount = state.status === "ready" ? state.view.turnCount : 0;
  const fileRefs = useMemo<FileRefSource | null>(
    () =>
      readySession === undefined
        ? null
        : {
            load: () => readySession.fileIndex(),
            key: `${childSessionId}:${readyTurnCount}`,
          },
    [readySession, childSessionId, readyTurnCount],
  );

  if (state.status === "loading") {
    return <div className="sp-swarm-member" />;
  }
  if (state.status === "error") {
    return (
      <div className="sp-swarm-member">
        <p className="conversation-error" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  const { session, cwd, shellKind, view, running, pendingInputs, skills, externalAgents } = state;

  if (frozen) {
    return (
      <div className="sp-swarm-member">
        <Conversation
          session={{
            id: session.id,
            readOnly: true,
            readAttachment: (file) => session.readAttachment(file),
          }}
          readOnly={{ frozen: true }}
          view={view}
          openUrl={openUrl}
          cwd={cwd}
          shellKind={shellKind}
          subscribeEvents={state.subscribeEvents}
          images={images}
          busy={false}
          fileLinks={fileLinks}
          swarmRecipientLabel={recipientLabel}
        />
      </div>
    );
  }

  const handleSubmit = async (
    input: ComposerSubmit,
    mode?: "steer" | "queue",
  ): Promise<boolean> => {
    setSubmitError(undefined);
    await Promise.all(
      input.attachments.map((attachment) => images.register(attachment.data, attachment.mimeType)),
    );
    try {
      if (running || pendingInputs.paused) {
        if (input.text !== "") await session.recordInputHistory(input.text);
        await session.enqueueInput(input.workMode ? "queue" : (mode ?? "steer"), {
          text: input.text,
          ...(input.skill ? { skill: input.skill } : {}),
          ...(input.delegate ? { delegate: input.delegate } : {}),
          ...(input.workMode ? { workMode: input.workMode } : {}),
          attachments: input.attachments,
        });
        return true;
      }
      const baseline = view.entries.length;
      const isAccepted = () => view.currentTurn !== undefined || view.entries.length > baseline;
      const accepted = new Promise<"accepted">((resolve) => {
        if (isAccepted()) {
          resolve("accepted");
          return;
        }
        const stop = state.subscribeEvents(() => {
          if (isAccepted()) {
            stop();
            resolve("accepted");
          }
        });
      });
      const submission = session.submit({
        text: input.text,
        ...(input.skill ? { skill: input.skill } : {}),
        ...(input.delegate ? { delegate: input.delegate } : {}),
        ...(input.workMode ? { workMode: input.workMode } : {}),
        attachments: input.attachments,
      });
      await Promise.race([accepted, submission.then(() => "finished" as const)]);
      void submission.catch((cause: unknown) => {
        setSubmitError(cause instanceof Error ? cause.message : String(cause));
      });
      return true;
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  };

  const handleSlash = async (line: string): Promise<boolean> => {
    const parsed = parseSlash(line, "session", skills, externalAgents);
    if (parsed?.kind === "command" && parsed.name === "/compact") {
      await session.recordInputHistory(line);
      await session.compact();
      return true;
    }
    return false;
  };

  return (
    <div className="sp-swarm-member">
      <Conversation
        session={session}
        view={view}
        openUrl={openUrl}
        cwd={cwd}
        shellKind={shellKind}
        subscribeEvents={state.subscribeEvents}
        images={images}
        busy={running}
        fileLinks={fileLinks}
        swarmRecipientLabel={recipientLabel}
      />
      {submitError !== undefined ? (
        <p className="conversation-error" role="alert">
          {submitError}
        </p>
      ) : null}
      {view.pendingQuestion !== undefined ? (
        <div className="question-dock">
          <QuestionCard
            key={view.pendingQuestion.requestId}
            pending={view.pendingQuestion}
            session={session}
          />
        </div>
      ) : null}
      <Composer
        key={`member-composer:${childSessionId}`}
        hidden={view.pendingQuestion !== undefined}
        variant="session"
        {...(prefs !== undefined ? { prefs } : {})}
        skills={skills}
        externalAgents={externalAgents}
        todos={view.todos}
        running={running}
        onSubmit={handleSubmit}
        onInterrupt={() => {
          session.interrupt();
        }}
        pendingInputs={pendingInputs}
        onUpdatePending={(id, patch) => session.updateInput(id, patch)}
        onCancelPending={(id) => session.cancelInput(id)}
        onResumePending={() => session.resumeInputs()}
        historyKey={cwd}
        readInputHistory={() => session.readInputHistory()}
        recordInputHistory={(text) => session.recordInputHistory(text)}
        fileRefs={fileRefs}
        pickImages={pickImages}
        onSlash={handleSlash}
      />
    </div>
  );
}
