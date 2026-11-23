/**
 * 组曲线程会话标签（ADR-0097 §3.7）：复用 `useEnsembleMemberSession`、`Conversation`、
 * `QuestionCard` 与 `Composer` 查看线程对话与确认权限；底部输入框发送走 `sendToThread`。
 */
import { useMemo, useState } from "react";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { parseSlash } from "./commands";
import { Composer, type ComposerSubmit, type FileRefSource } from "./Composer";
import { Conversation, QuestionCard, type FileLinkHooks } from "./Conversation";
import { useEnsembleMemberSession } from "./ensemble-member-session";
import type { DesktopHost } from "./host";
import type { PrefsStore } from "./prefs";

export interface SuiteThreadPaneProps {
  threadId: string;
  childSessionId: string;
  coordinatorSession: Pick<RpcSession, "sendToThread">;
  workspace: string;
  ensureClient: () => Promise<RpcClient>;
  images: AttachmentImageSource;
  openUrl: (url: string) => void;
  fileLinks?: FileLinkHooks | undefined;
  prefs?: PrefsStore | undefined;
  pickImages: DesktopHost["pickImages"];
}

export function SuiteThreadPane({
  threadId,
  childSessionId,
  coordinatorSession,
  workspace,
  ensureClient,
  images,
  openUrl,
  fileLinks,
  prefs,
  pickImages,
}: SuiteThreadPaneProps) {
  const state = useEnsembleMemberSession({
    ensureClient,
    childSessionId,
    fallbackCwd: workspace,
  });
  const [submitError, setSubmitError] = useState<string>();

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
    return <div className="sp-ensemble-member" />;
  }
  if (state.status === "error") {
    return (
      <div className="sp-ensemble-member">
        <p className="conversation-error" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  const { session, cwd, shellKind, view, running, pendingInputs, skills, externalAgents } = state;

  const handleSubmit = async (input: ComposerSubmit): Promise<boolean> => {
    setSubmitError(undefined);
    const trimmed = input.text.trim();
    if (trimmed === "") return false;
    try {
      void session.recordInputHistory(input.text).catch(() => undefined);
      await coordinatorSession.sendToThread({ thread: threadId, text: input.text });
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
    <div className="sp-ensemble-member">
      <Conversation
        session={session}
        skills={skills}
        view={view}
        openUrl={openUrl}
        cwd={cwd}
        shellKind={shellKind}
        subscribeEvents={state.subscribeEvents}
        images={images}
        busy={running}
        fileLinks={fileLinks}
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
        key={`suite-thread-composer:${childSessionId}`}
        hidden={view.pendingQuestion !== undefined}
        variant="session"
        {...(prefs !== undefined ? { prefs } : {})}
        skills={skills}
        externalAgents={externalAgents}
        workModeDisabled={{
          "grill-me": "子会话不能使用执行方式",
          goal: "子会话不能使用执行方式",
          plan: "子会话不能使用执行方式",
          boost: "子会话不能使用执行方式",
          ensemble: "子会话不能使用执行方式",
          panel: "子会话不能使用执行方式",
        }}
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
        allowAttachments={false}
        onSlash={handleSlash}
      />
    </div>
  );
}
