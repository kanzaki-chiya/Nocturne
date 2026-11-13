/**
 * 成员会话标签（ADR-0089 §8）：经 `session.open` 打开常驻成员子会话，复用 `Conversation`、
 * `QuestionCard` 与 `Composer` 实现私信、权限确认、回答提问与中断。
 * 成员被移除或 Swarm 结束后转为只读冻结展示，隐藏输入区；关闭标签只释放句柄。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SwarmMemberStatus, SwarmView } from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { parseSlash } from "./commands";
import { Composer, type ComposerSubmit, type FileRefSource } from "./Composer";
import { Conversation, QuestionCard, type FileLinkHooks } from "./Conversation";
import type { DesktopHost } from "./host";
import type { PrefsStore } from "./prefs";
import {
  acceptOutgoing,
  bindPending,
  dropOutgoing,
  emptyOutgoing,
  localTurnEntries,
  mergePending,
  nextLocalId,
  pushOutgoing,
  reconcileOutgoing,
  submitBody,
  userSeqs,
  draftTextOf,
  type LocalOutgoing,
} from "./outgoing";
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
  const [outgoing, setOutgoing] = useState(emptyOutgoing);
  const outgoingRef = useRef(outgoing);
  outgoingRef.current = outgoing;
  const readyView = state.status === "ready" ? state.view : undefined;
  const readyPending = state.status === "ready" ? state.pendingInputs : undefined;
  // 视图对象原地更新：用 version 驱动重新对齐，否则新条目到达时不会重算
  const readyVersion = state.status === "ready" ? state.version : 0;
  useEffect(() => {
    if (readyView === undefined || readyPending === undefined) return;
    setOutgoing((book) => reconcileOutgoing(book, readyView.entries, readyPending));
  }, [readyView, readyPending, readyVersion]);
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

  const hasLocalTurn = outgoing.items.some((item) => item.place === "turn");
  const showRunning = running || hasLocalTurn;

  const track = (input: ComposerSubmit, place: "turn" | "pending", mode: "steer" | "queue") => {
    const local: LocalOutgoing = {
      id: nextLocalId(),
      place,
      mode,
      draftText: draftTextOf(input),
      input,
      sentAt: new Date().toISOString(),
      excludeUserSeqs: userSeqs(view.entries),
      excludePendingIds: pendingInputs.items.map((item) => item.id),
    };
    setOutgoing((book) =>
      reconcileOutgoing(pushOutgoing(book, local), view.entries, pendingInputs),
    );
    return local;
  };

  const handleSubmit = async (
    input: ComposerSubmit,
    mode?: "steer" | "queue",
  ): Promise<boolean> => {
    setSubmitError(undefined);
    const queued = running || hasLocalTurn || pendingInputs.paused;
    const local = track(input, queued ? "pending" : "turn", mode ?? "steer");
    try {
      if (input.text !== "") void session.recordInputHistory(input.text).catch(() => undefined);
      if (queued) {
        const result = await session.enqueueInput(
          input.workMode ? "queue" : (mode ?? "steer"),
          submitBody(input),
        );
        if (!result.queued) {
          // 直接开了新 Turn：enqueueInput 在 Turn 结束后才返回，正式消息早已到达
          setOutgoing((book) => dropOutgoing(book, local.id));
        } else {
          setOutgoing((book) => bindPending(book, local.id, result.id));
        }
        return true;
      }
      const baseline = view.entries.length;
      const isAccepted = () => view.currentTurn !== undefined || view.entries.length > baseline;
      const accepted = new Promise<void>((resolve, reject) => {
        let settled = false;
        let stop: () => void = () => undefined;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          stop();
          if (error !== undefined && !isAccepted()) reject(error);
          else resolve();
        };
        stop = state.subscribeEvents(() => {
          if (isAccepted()) finish();
        });
        if (isAccepted()) finish();
        const submission = session.submit(submitBody(input));
        submission.then(
          () => {
            finish();
          },
          (error: unknown) => {
            finish(error instanceof Error ? error : new Error(String(error)));
          },
        );
        void submission.catch((cause: unknown) => {
          if (isAccepted()) setSubmitError(cause instanceof Error ? cause.message : String(cause));
        });
        // submit 落定时本地消息一律收掉，对不上正式条目也不会一直留着
        void submission
          .catch(() => undefined)
          .finally(() => {
            setOutgoing((book) => dropOutgoing(book, local.id));
          });
      });
      await accepted;
      setOutgoing((book) =>
        reconcileOutgoing(acceptOutgoing(book, local.id), view.entries, pendingInputs),
      );
      return true;
    } catch (cause) {
      setOutgoing((book) => dropOutgoing(book, local.id));
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
        busy={showRunning}
        fileLinks={fileLinks}
        swarmRecipientLabel={recipientLabel}
        localEntries={localTurnEntries(outgoing, (key, data, mimeType) => {
          images.preview(key, data, mimeType);
        })}
        entryKey={(key) => outgoing.keys.get(key) ?? key}
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
        running={showRunning}
        onSubmit={handleSubmit}
        onInterrupt={() => {
          session.interrupt();
        }}
        pendingInputs={mergePending(pendingInputs, outgoing)}
        onUpdatePending={async (id, patch) => {
          if (outgoingRef.current.items.some((item) => item.id === id)) {
            setOutgoing((book) => ({
              items: book.items.map((item) =>
                item.id !== id
                  ? item
                  : {
                      ...item,
                      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
                      ...(patch.text !== undefined
                        ? { input: { ...item.input, text: patch.text } }
                        : {}),
                    },
              ),
              keys: book.keys,
            }));
            return;
          }
          await session.updateInput(id, patch);
        }}
        onCancelPending={async (id) => {
          if (outgoingRef.current.items.some((item) => item.id === id)) {
            setOutgoing((book) => dropOutgoing(book, id));
            return;
          }
          await session.cancelInput(id);
        }}
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
