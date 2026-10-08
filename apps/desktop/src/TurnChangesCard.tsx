import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  RewindTarget,
  TurnChangeDiff,
  TurnChangeFile,
  TurnChanges,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { displayPath } from "./paths";

interface Props {
  turn: TurnChanges;
  latest: boolean;
  busy: boolean;
  cwd: string;
  session: RpcSession;
  onRewind: (seq: number) => Promise<void>;
  loadDiff: (seq: number, path: string) => Promise<TurnChangeDiff>;
  renderDiff: (diff: string) => ReactNode;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="diff-add">+{added}</span>
      {removed > 0 && <span className="diff-del">−{removed}</span>}
    </>
  );
}

function ChangedFile({
  file,
  turn,
  cwd,
  loadDiff,
  renderDiff,
}: Pick<Props, "turn" | "cwd" | "loadDiff" | "renderDiff"> & { file: TurnChangeFile }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<TurnChangeDiff>();
  const [error, setError] = useState<string>();
  const loader = useRef(loadDiff);
  loader.current = loadDiff;
  const fingerprint = JSON.stringify([
    file.added,
    file.removed,
    file.approximate,
    file.unavailable,
  ]);
  useEffect(() => {
    if (!open || file.unavailable) return;
    let active = true;
    setResult(undefined);
    setError(undefined);
    void loader
      .current(turn.seq, file.path)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [open, turn.seq, file.path, fingerprint, file.unavailable]);
  const label = displayPath(file.path, cwd).replaceAll("\\", "/");
  const slash = label.lastIndexOf("/");
  return (
    <div className="turn-change-file">
      <button
        type="button"
        className="diff-h"
        aria-expanded={open}
        aria-label={`文件差异 ${label}`}
        title={file.unavailable ?? file.path}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className={`fold-arrow${open ? " down" : ""}`} aria-hidden="true">
          ▶
        </span>
        <span className="turn-change-path" title={file.path}>
          <span className="turn-change-directory">{label.slice(0, slash + 1)}</span>
          {label.slice(slash + 1)}
        </span>
        {file.status === "added" && <span className="turn-change-tag">新建</span>}
        {file.status === "deleted" && <span className="turn-change-tag">已删除</span>}
        {!file.unavailable && <Counts added={file.added ?? 0} removed={file.removed ?? 0} />}
      </button>
      {open &&
        (file.unavailable ? (
          <p className="turn-change-note">{file.unavailable}</p>
        ) : error ? (
          <p className="conversation-error" role="alert">
            {error}
          </p>
        ) : result ? (
          renderDiff(result.diff)
        ) : (
          <p className="turn-change-note" role="status">
            正在读取差异…
          </p>
        ))}
    </div>
  );
}

function revertedText(turn: TurnChanges): string {
  const files = turn.reverted?.files ?? [];
  const restored = files.filter((f) => f.result === "restored").length;
  const deleted = files.filter((f) => f.result === "deleted").length;
  const failed = files.filter((f) => f.result === "failed").length;
  return `已撤销 · 还原 ${restored} 个文件${deleted ? `，删除 ${deleted} 个` : ""}${failed ? `，${failed} 个失败` : ""}`;
}

const PREVIEW = 3;

export function TurnChangesCard(props: Props) {
  const { turn, latest, busy, cwd, session, onRewind } = props;
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState<RewindTarget>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLElement>(null);
  const request = useRef(0);
  const undo = useRef<HTMLButtonElement>(null);
  const revertedSeq = turn.reverted?.seq;
  useEffect(() => {
    if (!latest || revertedSeq !== undefined) {
      request.current++;
      setConfirming(false);
      setTarget(undefined);
    }
  }, [latest, revertedSeq]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const canUndo = latest && !turn.reverted && turn.files.some((f) => f.restorable);
  const counted = turn.files.filter((f) => f.added !== undefined && f.removed !== undefined);
  const added = counted.reduce((total, f) => total + (f.added ?? 0), 0);
  const removed = counted.reduce((total, f) => total + (f.removed ?? 0), 0);
  const dismiss = () => {
    request.current++;
    setConfirming(false);
    setTarget(undefined);
    setError(undefined);
    undo.current?.focus();
  };
  useEffect(() => {
    if (!confirming) return;
    cancel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || container.current?.closest("[inert]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!working) {
        request.current++;
        setConfirming(false);
        setTarget(undefined);
        setError(undefined);
        undo.current?.focus();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
    };
  }, [confirming, working]);
  const preview = async () => {
    setConfirming(true);
    setTarget(undefined);
    setError(undefined);
    const token = ++request.current;
    try {
      const targets = await session.rewindTargets();
      if (request.current !== token) return;
      const value = targets.find((t) => t.seq === turn.seq);
      if (!value) throw new Error("这一轮已不在当前有效对话中");
      setTarget(value);
    } catch (e) {
      if (request.current === token) setError(e instanceof Error ? e.message : String(e));
    }
  };
  const confirm = async () => {
    setWorking(true);
    setError(undefined);
    try {
      await onRewind(turn.seq);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  const external = target?.files
    .filter((f) => f.external)
    .map((f) => displayPath(f.path, cwd).split(/[\\/]/).at(-1))
    .join("、");
  const shellNote = (
    <p className="turn-change-note">
      这一轮有 {turn.untrackedCalls} 次 shell 调用，它们造成的改动不在统计里
    </p>
  );
  if (turn.files.length === 0) {
    if (turn.untrackedCalls === 0) return null;
    return <div className="turn-changes-shell-only">{shellNote}</div>;
  }
  return (
    <section
      ref={container}
      className={`turn-changes${turn.reverted ? " reverted" : ""}`}
      aria-label={`本轮文件更改 ${turn.seq}`}
    >
      <div className="turn-changes-header">
        <div className="turn-changes-heading">
          <span className="turn-changes-title">已编辑 {turn.files.length} 个文件</span>
          {counted.length > 0 && (
            <span className="turn-changes-counts">
              {turn.files.some((f) => f.approximate) && <span>约 </span>}
              <Counts added={added} removed={removed} />
            </span>
          )}
        </div>
        {turn.reverted && (
          <span className="turn-change-note" role="status">
            {revertedText(turn)}
          </span>
        )}
        {canUndo && !confirming && (
          <button
            ref={undo}
            type="button"
            className="u-act"
            disabled={busy}
            title={
              busy ? "请先等待或按 Esc 中断" : "把这一轮改过的文件还原到发送这条消息之前；对话保留"
            }
            onClick={() => {
              void preview();
            }}
          >
            ↶ 撤销
          </button>
        )}
      </div>
      <div className="turn-changes-files">
        {(showAll ? turn.files : turn.files.slice(0, PREVIEW)).map((file) => (
          <ChangedFile key={file.path} {...props} file={file} />
        ))}
        {turn.files.length > PREVIEW && (
          <button
            type="button"
            className="turn-changes-more"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll(!showAll);
            }}
          >
            <span className={`fold-arrow${showAll ? " up" : ""}`} aria-hidden="true">
              ▶
            </span>
            {showAll ? "收起" : `再显示 ${turn.files.length - PREVIEW} 个文件`}
          </button>
        )}
        {turn.untrackedCalls > 0 && shellNote}
      </div>
      {confirming && (
        <div className="turn-changes-confirm" role="group" aria-label="确认撤销文件改动">
          {!target && !error && (
            <p className="turn-change-note" role="status">
              正在读取还原目标…
            </p>
          )}
          {target?.files.map((file) => (
            <div className="turn-change-preview" key={file.path}>
              <span>
                {file.action === "restore"
                  ? "还原"
                  : file.action === "delete"
                    ? "删除"
                    : `无法还原（${file.reason ?? "未追踪"}）`}
              </span>
              <span className="turn-change-path">{displayPath(file.path, cwd)}</span>
              {file.action === "delete" && <span className="turn-change-tag">本轮新建</span>}
              {file.external && <span className="turn-change-tag">已在外部修改</span>}
            </div>
          ))}
          {external && (
            <p className="turn-change-note">
              {external} 在这一轮之后被外部修改过，撤销会覆盖那些修改
            </p>
          )}
          <p className="turn-change-note">对话保留，会告诉模型这些文件已经还原。</p>
          {(target?.untrackedCalls ?? 0) > 0 && (
            <p className="turn-change-note">
              这一轮有 {target?.untrackedCalls} 次 shell 调用，它们造成的改动不会被还原。
            </p>
          )}
          {error && (
            <p className="conversation-error" role="alert">
              {error}
            </p>
          )}
          <div className="u-edit-actions">
            <button ref={cancel} type="button" className="btn" disabled={working} onClick={dismiss}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                busy ||
                working ||
                !latest ||
                !!turn.reverted ||
                !target?.files.some((f) => f.action !== "untracked")
              }
              onClick={() => {
                void confirm();
              }}
            >
              {working ? "正在撤销…" : "撤销文件改动"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
