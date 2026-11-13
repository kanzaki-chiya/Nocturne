/**
 * Ensemble 面板主体（ADR-0089）：留言板与成员页。桌面右侧面板与手机全屏页共用这一份结构，
 * 尺寸差异只由外层 `.phone` 的少量 CSS 覆盖提供。
 *
 * 数据来自 `SessionView.ensemble`（协议层已归约），写操作全部走 RpcSession：
 * 发帖 `postToEnsemble`、移除成员 `removeEnsembleMember`、结束 `endEnsemble`。
 */
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { EnsembleMemberView, EnsemblePostView, EnsembleView } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Markdown, type FileLinkHooks } from "./Conversation";
import { Menu, MenuItem } from "./Menu";
import { EnsembleAvatar } from "./EnsembleAvatar";
import {
  filterEnsemblePosts,
  formatEnsembleTime,
  groupEnsembleMembers,
  shortModelName,
  ensembleActivitySummary,
  ensembleAuthorColor,
  ensembleAuthorLabel,
  ensembleMaestroDot,
  ensembleMemberDot,
  ensembleMemberMetaLabel,
  ensembleMentionCandidates,
  ensembleMentionLabel,
  ensembleMentionToken,
  ensemblePostRecipients,
  type EnsembleMentionCandidate,
} from "./ensemble-ui";
import { ICON_MD, ICON_SM, Icon } from "./ui";
import "./ensemble-panel.css";

/** 留言板输入框最大高度：约 6 行之后改为内滚 */
const BOARD_INPUT_MAX_HEIGHT = 132;
/** 距底部不超过该距离仍算「在底部」，避免像素级抖动把跟随关掉 */
const FOLLOW_SLACK = 4;

/** Ensemble 面板用到的会话能力（手机网页与桌面端传的都是当前指挥会话） */
export type EnsembleSession = Pick<
  RpcSession,
  "postToEnsemble" | "removeEnsembleMember" | "endEnsemble"
> &
  Partial<Pick<RpcSession, "resolveFiles">>;

export interface EnsemblePaneProps {
  ensemble: EnsembleView;
  session: EnsembleSession;
  openUrl: (url: string) => void;
  fileLinks?: FileLinkHooks | undefined;
  /** 点击某个成员行时打开该成员会话 */
  onOpenMember: (member: EnsembleMemberView) => void;
  /** 点击顶部指挥行时回调（桌面聚焦主输入框，手机返回主会话） */
  onSelectMaestro?: (() => void) | undefined;
  /** 面板当前是否可见（可见或切换回留言板且跟随开启时滚到底） */
  visible?: boolean | undefined;
}

type EnsembleTab = "board" | "members";

/** 当前展开的溢出菜单：子栏「结束」或某一行成员的「移除」 */
type OpenMenu =
  | { kind: "bar"; anchor: HTMLElement }
  | { kind: "member"; anchor: HTMLElement; member: EnsembleMemberView };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function EnsemblePane({
  ensemble,
  session,
  openUrl,
  fileLinks,
  onOpenMember,
  onSelectMaestro,
  visible,
}: EnsemblePaneProps) {
  const [tab, setTab] = useState<EnsembleTab>("board");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedMember, setSelectedMember] = useState("");
  const [follow, setFollow] = useState(true);
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [composingState, setComposingState] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const body = useRef<HTMLDivElement>(null);
  const previousScrollTop = useRef(0);
  const searchField = useRef<HTMLInputElement>(null);
  const boardField = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const sending = useRef(false);
  const mentionListId = useId();

  const shown = visible !== false;
  const postCount = ensemble.posts.length;
  const active = ensemble.status === "active";

  const mentionToken =
    !composingState && active && tab === "board" ? ensembleMentionToken(draft, caret) : null;
  const mentionCandidates =
    mentionToken !== null && dismissedAt !== mentionToken.start
      ? ensembleMentionCandidates(ensemble, mentionToken.query)
      : [];
  const mentionOpen = mentionCandidates.length > 0;
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1));
  const mentionQueryKey = mentionToken?.query ?? "";

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQueryKey, mentionToken?.start]);

  useEffect(() => {
    if (!mentionOpen) return;
    const node = document.getElementById(`${mentionListId}-${activeMentionIndex}`);
    if (node && "scrollIntoView" in node) node.scrollIntoView({ block: "nearest" });
  }, [mentionOpen, activeMentionIndex, mentionListId]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    boardField.current?.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [draft]);

  // 跟随最新：新帖、首次挂载、面板回到可见、切回留言板或换了筛选/搜索词时贴底
  useLayoutEffect(() => {
    if (!follow || tab !== "board" || !shown) return;
    const element = body.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    previousScrollTop.current = element.scrollTop;
  }, [follow, tab, shown, postCount, selectedMember, query, searchOpen]);

  // 展开搜索时直接聚焦输入框（不写 placeholder，聚焦即提示）
  useLayoutEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);

  // 留言板输入框随内容增高，超过约六行改为内滚
  useLayoutEffect(() => {
    const field = boardField.current;
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, BOARD_INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  const send = () => {
    if (draft.trim() === "" || sending.current) return;
    sending.current = true;
    setBoardError(null);
    void session.postToEnsemble({ text: draft }).then(
      () => {
        sending.current = false;
        setDraft("");
        setCaret(0);
        setDismissedAt(null);
      },
      (cause: unknown) => {
        sending.current = false;
        setBoardError(errorText(cause));
      },
    );
  };

  const applyMention = (candidate: EnsembleMentionCandidate) => {
    if (mentionToken === null) return;
    const inserted = `@${candidate.insert} `;
    const next = draft.slice(0, mentionToken.start) + inserted + draft.slice(mentionToken.end);
    pendingCaret.current = mentionToken.start + inserted.length;
    setDismissedAt(null);
    setDraft(next);
    boardField.current?.focus();
  };

  const end = () => {
    setMenu(null);
    setActionError(null);
    void session.endEnsemble().catch((cause: unknown) => {
      setActionError(errorText(cause));
    });
  };

  const remove = (member: EnsembleMemberView) => {
    setMenu(null);
    setActionError(null);
    void session.removeEnsembleMember(member.name).catch((cause: unknown) => {
      setActionError(errorText(cause));
    });
  };

  const onBodyScroll = () => {
    const element = body.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (element.scrollTop < previousScrollTop.current && distance > FOLLOW_SLACK) setFollow(false);
    previousScrollTop.current = element.scrollTop;
  };

  const onBodyWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) setFollow(false);
  };

  const onBoardKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const picked = mentionCandidates[activeMentionIndex];
        if (picked !== undefined) {
          event.preventDefault();
          applyMention(picked);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (mentionToken !== null) setDismissedAt(mentionToken.start);
        return;
      }
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    send();
  };

  const posts = filterEnsemblePosts(ensemble.posts, {
    member: selectedMember,
    query,
    members: ensemble.members,
  });
  const groups = groupEnsembleMembers(ensemble.members);
  const maestroModel = shortModelName(ensemble.maestro.model);
  const maestroSummary = ensembleActivitySummary(ensemble.maestro.activity);

  const memberRow = (member: EnsembleMemberView) => {
    const summary = ensembleActivitySummary(member.activity);
    const retired = member.status === "removed";
    const removable = active && !retired;
    const color = ensembleAuthorColor(ensemble.members, member.name, "member");
    return (
      <div
        key={member.name}
        className={retired ? "ensemble-mem retired" : "ensemble-mem"}
        onContextMenu={(event) => {
          if (!removable) return;
          event.preventDefault();
          setActionError(null);
          setMenu({ kind: "member", anchor: event.currentTarget, member });
        }}
      >
        <button
          type="button"
          className="ensemble-mem-main"
          onClick={() => {
            onOpenMember(member);
          }}
        >
          <EnsembleAvatar kind="member" color={color} size="sm" />
          <span className="ensemble-mem-col">
            <span className="ensemble-mem-top">
              <span
                className={`ensemble-dot ${ensembleMemberDot(member, ensemble.status)}`}
                aria-hidden="true"
              />
              <span className="ensemble-mem-name">
                {member.name}
                <i>{ensembleMemberMetaLabel(member)}</i>
              </span>
              {member.lastPostNumber !== undefined ? (
                <span className="ensemble-mem-no">{`#${member.lastPostNumber}`}</span>
              ) : (
                <span className="ensemble-mem-no" />
              )}
            </span>
            {summary !== "" && <span className="ensemble-mem-last">{summary}</span>}
          </span>
        </button>
        {removable && (
          <button
            type="button"
            className="ensemble-ib ensemble-mem-menu"
            aria-label="更多操作"
            aria-expanded={
              menu !== null && menu.kind === "member" && menu.member.name === member.name
            }
            onClick={(event) => {
              event.stopPropagation();
              setActionError(null);
              setMenu({ kind: "member", anchor: event.currentTarget, member });
            }}
          >
            <Icon name="more_1" size={ICON_MD} />
          </button>
        )}
      </div>
    );
  };

  const post = (item: EnsemblePostView) => {
    const time = formatEnsembleTime(item.time);
    const recipients = ensemblePostRecipients(item);
    const charter =
      item.charterOf !== undefined
        ? ensemble.members.find((member) => member.name === item.charterOf)?.charter
        : undefined;
    const className = `ensemble-post${item.fromKind === "user" ? " user" : ""}${
      item.fromKind === "runtime" && item.charterOf === undefined ? " sys" : ""
    }`;
    const avatarColor = ensembleAuthorColor(ensemble.members, item.from, item.fromKind);
    return (
      <article key={item.seq} className={className}>
        <EnsembleAvatar kind={item.fromKind} color={avatarColor} />
        <div className="ensemble-post-col">
          <div className="ensemble-post-head">
            <span className="ensemble-post-head-main">
              <span className="ensemble-post-from">
                {ensembleAuthorLabel(item.from, item.fromKind)}
              </span>
              {recipients.length > 0 && (
                <span className="ensemble-post-to">
                  {" → "}
                  {recipients.map((mention, index) => (
                    <Fragment key={mention}>
                      {index > 0 ? " " : null}
                      <span>{ensembleMentionLabel(mention)}</span>
                    </Fragment>
                  ))}
                </span>
              )}
            </span>
            <span className="ensemble-post-meta">{`#${item.number}${
              time !== "" ? ` · ${time}` : ""
            }`}</span>
          </div>
          <div className="ensemble-post-txt">
            {charter !== undefined ? (
              <>
                <div className="ensemble-charter-row">
                  <span className="ensemble-charter-tag">负责</span>
                  <span>{charter.owns}</span>
                </div>
                <div className="ensemble-charter-row">
                  <span className="ensemble-charter-tag">不碰</span>
                  <span>{charter.handsOff}</span>
                </div>
                <div className="ensemble-charter-row">
                  <span className="ensemble-charter-tag">完成</span>
                  <span>{charter.doneWhen}</span>
                </div>
              </>
            ) : item.fromKind === "runtime" ? (
              <div className="ensemble-sys-text">{item.text}</div>
            ) : (
              <Markdown
                text={item.text}
                openUrl={openUrl}
                mentions={item.mentions}
                session={
                  typeof session.resolveFiles === "function" ? (session as RpcSession) : undefined
                }
                fileLinks={fileLinks}
              />
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="ensemble-pane">
      <div className="ensemble-subbar">
        <div className="ensemble-seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "board"}
            className={tab === "board" ? "on" : undefined}
            onClick={() => {
              setTab("board");
            }}
          >
            留言板
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "members"}
            className={tab === "members" ? "on" : undefined}
            onClick={() => {
              setTab("members");
            }}
          >
            成员
          </button>
        </div>
        <div className="ensemble-tools">
          {tab === "board" && (
            <>
              <button
                type="button"
                className={searchOpen ? "ensemble-ib on" : "ensemble-ib"}
                aria-label="搜索"
                aria-pressed={searchOpen}
                onClick={() => {
                  if (searchOpen) {
                    setQuery("");
                    setSearchOpen(false);
                    return;
                  }
                  setSearchOpen(true);
                }}
              >
                <Icon name="search" size={ICON_MD} />
              </button>
              <button
                type="button"
                className={follow ? "ensemble-ib on" : "ensemble-ib"}
                aria-label="跟随最新"
                aria-pressed={follow}
                onClick={() => {
                  if (follow) {
                    setFollow(false);
                    return;
                  }
                  setFollow(true);
                  const element = body.current;
                  if (element !== null) {
                    element.scrollTop = element.scrollHeight;
                    previousScrollTop.current = element.scrollTop;
                  }
                }}
              >
                <Icon name="down_small" size={ICON_MD} />
              </button>
            </>
          )}
          {active && (
            <button
              type="button"
              className="ensemble-ib"
              aria-label="更多操作"
              aria-expanded={menu !== null && menu.kind === "bar"}
              onClick={(event) => {
                setActionError(null);
                setMenu({ kind: "bar", anchor: event.currentTarget });
              }}
            >
              <Icon name="more_1" size={ICON_MD} />
            </button>
          )}
        </div>
      </div>
      {actionError !== null && (
        <p className="conversation-error ensemble-error" role="alert">
          {actionError}
        </p>
      )}
      {tab === "board" ? (
        <>
          {searchOpen && (
            <div className="ensemble-search">
              <input
                ref={searchField}
                type="text"
                aria-label="搜索"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                  setSearchOpen(false);
                }}
              />
            </div>
          )}
          <div className="ensemble-filters">
            <button
              type="button"
              className={selectedMember === "" ? "ensemble-chip on" : "ensemble-chip"}
              onClick={() => {
                setSelectedMember("");
              }}
            >
              全部
            </button>
            {ensemble.members.map((member) => (
              <button
                key={member.name}
                type="button"
                className={selectedMember === member.name ? "ensemble-chip on" : "ensemble-chip"}
                onClick={() => {
                  setSelectedMember(member.name);
                }}
              >
                {`@${member.name}`}
              </button>
            ))}
          </div>
          <div className="ensemble-body" ref={body} onScroll={onBodyScroll} onWheel={onBodyWheel}>
            {posts.map(post)}
          </div>
          {active && (
            <div className="ensemble-boardin">
              {mentionOpen && (
                <div
                  className="ensemble-ac"
                  role="listbox"
                  aria-label="提及补全"
                  id={mentionListId}
                >
                  {mentionCandidates.map((candidate, index) => (
                    <div
                      key={`${candidate.kind}:${candidate.insert}`}
                      id={`${mentionListId}-${index}`}
                      role="option"
                      aria-selected={index === activeMentionIndex}
                      className={`ensemble-ac-row${index === activeMentionIndex ? " is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        applyMention(candidate);
                      }}
                    >
                      <EnsembleAvatar kind={candidate.kind} color={candidate.color} size="sm" />
                      <span className="ensemble-ac-name">{candidate.label}</span>
                      {candidate.meta !== undefined && (
                        <span className="ensemble-ac-meta">{candidate.meta}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {boardError !== null && (
                <p className="conversation-error" role="alert">
                  {boardError}
                </p>
              )}
              <textarea
                ref={boardField}
                aria-label="留言板"
                aria-autocomplete="list"
                aria-expanded={mentionOpen}
                aria-controls={mentionOpen ? mentionListId : undefined}
                aria-activedescendant={
                  mentionOpen ? `${mentionListId}-${activeMentionIndex}` : undefined
                }
                rows={1}
                value={draft}
                onSelect={(event) => {
                  setCaret(event.currentTarget.selectionStart);
                }}
                onChange={(event) => {
                  setDismissedAt(null);
                  setCaret(event.currentTarget.selectionStart);
                  setDraft(event.target.value);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                  setComposingState(true);
                }}
                onCompositionEnd={(event) => {
                  composing.current = false;
                  setComposingState(false);
                  setCaret(event.currentTarget.selectionStart);
                }}
                onKeyDown={onBoardKeyDown}
              />
            </div>
          )}
        </>
      ) : (
        <div className="ensemble-mems">
          <div className="ensemble-mem coord">
            <button
              type="button"
              className="ensemble-mem-main"
              onClick={() => {
                onSelectMaestro?.();
              }}
            >
              <EnsembleAvatar kind="maestro" size="sm" />
              <span className="ensemble-mem-col">
                <span className="ensemble-mem-top">
                  <span
                    className={`ensemble-dot ${ensembleMaestroDot(ensemble)}`}
                    aria-hidden="true"
                  />
                  <span className="ensemble-mem-name">
                    指挥
                    {maestroModel !== "" ? <i>{maestroModel}</i> : null}
                  </span>
                  {ensemble.maestro.lastPostNumber !== undefined ? (
                    <span className="ensemble-mem-no">{`#${ensemble.maestro.lastPostNumber}`}</span>
                  ) : (
                    <span className="ensemble-mem-no" />
                  )}
                </span>
                {maestroSummary !== "" && (
                  <span className="ensemble-mem-last">{maestroSummary}</span>
                )}
              </span>
            </button>
          </div>
          {groups.working.length > 0 && (
            <>
              <div className="ensemble-grp">工作中</div>
              {groups.working.map(memberRow)}
            </>
          )}
          {groups.paused.length > 0 && (
            <>
              <div className="ensemble-grp">已暂停</div>
              {groups.paused.map(memberRow)}
            </>
          )}
          {groups.waiting.length > 0 && (
            <>
              <div className="ensemble-grp">等待</div>
              {groups.waiting.map(memberRow)}
            </>
          )}
          {groups.removed.length > 0 && (
            <>
              <div className="ensemble-grp">
                <button
                  type="button"
                  className="ensemble-retired-toggle"
                  aria-expanded={retiredOpen}
                  onClick={() => {
                    setRetiredOpen((value) => !value);
                  }}
                >
                  <Icon
                    name="right_small"
                    size={ICON_SM}
                    className={`fold-arrow${retiredOpen ? " down" : ""}`}
                  />
                  {`已移除 ${groups.removed.length}`}
                </button>
              </div>
              {retiredOpen && groups.removed.map(memberRow)}
            </>
          )}
        </div>
      )}
      {menu !== null && menu.kind === "bar" && (
        <Menu
          anchor={menu.anchor}
          label="更多操作"
          align="right"
          onClose={() => {
            setMenu(null);
          }}
        >
          <MenuItem label="结束" danger onSelect={end} />
        </Menu>
      )}
      {menu !== null && menu.kind === "member" && (
        <Menu
          anchor={menu.anchor}
          label="更多操作"
          align="right"
          onClose={() => {
            setMenu(null);
          }}
        >
          <MenuItem
            label="移除"
            danger
            onSelect={() => {
              remove(menu.member);
            }}
          />
        </Menu>
      )}
    </div>
  );
}
