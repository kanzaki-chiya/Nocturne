/**
 * Ensemble 面板主体（ADR-0089、ADR-0131）：概览、留言板与成员页。
 * 桌面右侧面板与手机全屏页共用这一份结构，尺寸差异只由外层 `.phone` 的少量 CSS 覆盖提供。
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
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  EnsembleLine,
  EnsembleMemberView,
  EnsemblePostView,
  EnsembleTask,
  EnsembleView,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Markdown, type FileLinkHooks } from "./Conversation";
import { ChoiceMenu, Menu, MenuItem } from "./Menu";
import { EnsembleAvatar } from "./EnsembleAvatar";
import {
  ENSEMBLE_TASK_STATUS_ORDER,
  ensembleDefaultOpenLines,
  ensembleLineStats,
  ensembleOverviewStats,
  filterEnsembleBoardPosts,
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
  /** `/ensemble board` 直达信号：值变化时强制切到留言板页签（ADR-0131 §6） */
  boardNonce?: number | undefined;
}

type EnsembleTab = "overview" | "board" | "members";

/** 当前展开的溢出菜单：子栏「结束」或某一行成员的「移除」 */
type OpenMenu =
  | { kind: "bar"; anchor: HTMLElement }
  | { kind: "member"; anchor: HTMLElement; member: EnsembleMemberView }
  | { kind: "filter"; which: "from" | "to"; anchor: HTMLElement };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 按场隔离的界面状态（ADR-0131 §6）：createdSeq 变化时整体重置为默认 */
interface EnsemblePaneState {
  tab: EnsembleTab;
  query: string;
  filterFrom: string | undefined;
  filterTo: string | undefined;
  filterOpen: boolean;
  follow: boolean;
  retiredOpen: boolean;
  draft: string;
  /** 用户显式操作过展开状态的工作线；其余跟随默认展开规则 */
  lineToggles: Record<string, boolean>;
}

function initialPaneState(boardNonce?: number | undefined): EnsemblePaneState {
  return {
    // 首次打开就是被 /ensemble board 触发（nonce > 0）时直接落在留言板（ADR-0131 §6）
    tab: (boardNonce ?? 0) > 0 ? "board" : "overview",
    query: "",
    filterFrom: undefined,
    filterTo: undefined,
    filterOpen: false,
    follow: true,
    retiredOpen: false,
    draft: "",
    lineToggles: {},
  };
}

/** 工作线展开状态：用户手动折叠后不强制展开，未碰过的线跟随默认规则 */
function isLineOpen(
  line: EnsembleLine,
  defaultOpen: ReadonlySet<string>,
  toggles: Record<string, boolean>,
): boolean {
  const toggle = toggles[line.id];
  if (toggle !== undefined) return toggle;
  return defaultOpen.has(line.id);
}

export function EnsemblePane({
  ensemble,
  session,
  openUrl,
  fileLinks,
  onOpenMember,
  onSelectMaestro,
  visible,
  boardNonce,
}: EnsemblePaneProps) {
  // ── 按场（createdSeq）隔离的全部界面状态：新一场合奏回到「概览」与默认展开 ──
  // useState 的初值只取首次挂载；场 key 变化时用 React 官方认可的「渲染期 key 派生重置」
  // （存上一次 key，不一致就同步 setState 触发丢弃式重渲染）
  const [store, setStore] = useState<{ key: number; state: EnsemblePaneState }>(() => ({
    key: ensemble.createdSeq,
    state: initialPaneState(boardNonce),
  }));
  if (store.key !== ensemble.createdSeq) {
    // 场次变化只重置页内状态；boardNonce 是打开意图，不随新场再次生效
    setStore({ key: ensemble.createdSeq, state: initialPaneState() });
  }
  const pane = store.key === ensemble.createdSeq ? store.state : initialPaneState();
  const patch = (part: Partial<EnsemblePaneState>) => {
    setStore((current) => ({
      key: ensemble.createdSeq,
      state: {
        // 场刚切换时 current 还是上一场的状态：以默认态为底再叠本次修改，避免旧状态残留
        ...(current.key === ensemble.createdSeq ? current.state : initialPaneState()),
        ...part,
      },
    }));
  };
  const {
    tab,
    query,
    filterFrom,
    filterTo,
    filterOpen,
    follow,
    retiredOpen,
    draft,
    lineToggles,
  } = pane;
  const setTab = (next: EnsembleTab) => {
    patch({ tab: next });
  };

  const [caret, setCaret] = useState(0);
  const [composingState, setComposingState] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const body = useRef<HTMLDivElement>(null);
  const previousScrollTop = useRef(0);
  const boardField = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const sending = useRef(false);
  const mentionListId = useId();

  // /ensemble board 直达：nonce 变化时强制切到留言板（ADR-0131 §6）
  const seenNonce = useRef(boardNonce ?? 0);
  useEffect(() => {
    const current = boardNonce ?? 0;
    if (current !== seenNonce.current) {
      seenNonce.current = current;
      setStore((previous) => ({
        key: previous.key,
        state: { ...previous.state, tab: "board" },
      }));
    }
  }, [boardNonce]);

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
  }, [follow, tab, shown, postCount, query, filterFrom, filterTo]);

  // 留言板输入框随内容增高，超过约六行改为内滚
  useLayoutEffect(() => {
    const field = boardField.current;
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, BOARD_INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  const setDraft = (next: string) => {
    patch({ draft: next });
  };

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
    if (element.scrollTop < previousScrollTop.current && distance > FOLLOW_SLACK)
      patch({ follow: false });
    previousScrollTop.current = element.scrollTop;
  };

  const onBodyWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) patch({ follow: false });
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

  // ── 留言板筛选（ADR-0131 §7）：关键词、作者、收件人取交集 ──
  const highlight = query.trim() !== "" ? query.trim() : undefined;
  const posts = filterEnsembleBoardPosts(
    ensemble.posts,
    {
      ...(filterFrom !== undefined ? { from: filterFrom } : {}),
      ...(filterTo !== undefined ? { to: filterTo } : {}),
      ...(query.trim() !== "" ? { query } : {}),
    },
    ensemble.members,
  );
  const filtered = posts.length !== ensemble.posts.length;
  const filterCount = (filterFrom !== undefined ? 1 : 0) + (filterTo !== undefined ? 1 : 0);

  const groups = groupEnsembleMembers(ensemble.members);
  const maestroModel = shortModelName(ensemble.maestro.model);
  const maestroSummary = ensembleActivitySummary(ensemble.maestro.activity);

  // ── 概览（ADR-0131 §6）：初始展开规则与用户手动折叠状态分离 ──
  const overview = ensemble.overview;
  const defaultOpenLines = new Set(overview !== undefined ? ensembleDefaultOpenLines(overview) : []);
  const stats = overview !== undefined ? ensembleOverviewStats(overview) : undefined;
  const allTasks = overview !== undefined ? overview.lines.flatMap((line) => line.tasks) : [];
  const ended = ensemble.status === "ended";

  const filterIdentities = (which: "from" | "to") => {
    const value = which === "from" ? filterFrom : filterTo;
    return {
      value,
      heading: which === "from" ? "来自" : "发给",
      groups: [
        {
          options: [
            { value: "", label: "全部" },
            { value: "maestro", label: "指挥" },
            ...ensemble.members.map((member) => ({
              value: member.name,
              label: `@${member.name}`,
            })),
          ],
        },
      ],
      onSelect: (next: string) => {
        patch(which === "from" ? { filterFrom: next === "" ? undefined : next } : { filterTo: next === "" ? undefined : next });
      },
    };
  };

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
                highlight={highlight}
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

  const ownerBadge = (owner: string) => {
    if (owner === "maestro") {
      return (
        <span className="ensemble-owner" title="指挥">
          <EnsembleAvatar kind="maestro" size="sm" />
          <span>指挥</span>
        </span>
      );
    }
    const member = ensemble.members.find((item) => item.name === owner);
    const color = member !== undefined ? ensembleAuthorColor(ensemble.members, owner, "member") : undefined;
    return (
      <span className="ensemble-owner" title={`@${owner}`}>
        <EnsembleAvatar kind="member" color={color} size="sm" />
        <span>{`@${owner}`}</span>
      </span>
    );
  };

  const taskRow = (task: EnsembleTask) => {
    const label =
      task.status === "done" ? "已完成" : task.status === "work" ? "进行中" : task.status === "wait" ? "等待" : "待办";
    return (
      <li key={task.id} className={`ensemble-task ${task.status}`}>
        <span className="ensemble-task-glyph" title={label} aria-label={label}>
          {task.status === "done" ? (
            <Icon name="check" size={ICON_SM} />
          ) : task.status === "wait" ? (
            <Icon name="time" size={ICON_SM} />
          ) : task.status === "todo" ? (
            <span className="todo" aria-hidden="true" />
          ) : (
            <span className="work" aria-hidden="true" />
          )}
        </span>
        <span className="ensemble-task-ttl">
          {task.title}
          {(task.status === "work" || task.status === "wait") && (
            <span className={`ensemble-task-st ${task.status}`}>{label}</span>
          )}
        </span>
        {ownerBadge(task.owner)}
        {task.post !== undefined && <span className="ensemble-postref">#{task.post}</span>}
      </li>
    );
  };

  const sortTasks = (tasks: readonly EnsembleTask[]): EnsembleTask[] =>
    [...tasks].sort(
      (a, b) =>
        ENSEMBLE_TASK_STATUS_ORDER.indexOf(a.status) - ENSEMBLE_TASK_STATUS_ORDER.indexOf(b.status),
    );

  const lineBlock = (line: EnsembleLine) => {
    const lineStats = ensembleLineStats(line);
    const open = isLineOpen(line, defaultOpenLines, lineToggles);
    const waiting = line.progress?.wait === true;
    const owners = [...new Set(line.tasks.map((task) => task.owner))];
    if (owners.length === 0) owners.push(line.owner);
    return (
      <section key={line.id} className={`ensemble-line${open ? " open" : ""}${waiting ? " wait" : ""}`}>
        <button
          type="button"
          className="ensemble-line-head"
          aria-expanded={open}
          onClick={() => {
            patch({ lineToggles: { ...lineToggles, [line.id]: !open } });
          }}
        >
          <Icon
            name="right_small"
            size={ICON_SM}
            className={`fold-arrow${open ? " down" : ""}`}
          />
          <span className="ensemble-line-title">
            <span className="ensemble-line-name">{line.title}</span>
            {lineStats.total > 0 && (
              <span
                className={`ensemble-line-count${lineStats.done === lineStats.total && lineStats.total > 0 ? " full" : ""}`}
              >
                {lineStats.done}/{lineStats.total}
              </span>
            )}
            {line.post !== undefined && <span className="ensemble-postref">#{line.post}</span>}
          </span>
          <span className="ensemble-line-owners">
            {owners.slice(0, 4).map((owner) =>
              owner === "maestro" ? (
                <EnsembleAvatar key={owner} kind="maestro" size="sm" />
              ) : (
                <EnsembleAvatar
                  key={owner}
                  kind="member"
                  color={ensembleAuthorColor(ensemble.members, owner, "member")}
                  size="sm"
                />
              ),
            )}
          </span>
          {line.progress !== undefined && (
            <span className={`ensemble-line-progress${waiting ? " wait" : ""}`}>
              {waiting && <Icon name="time" size={ICON_SM} />}
              <span className="txt">{line.progress.text}</span>
              {line.progress.post !== undefined && (
                <span className="ensemble-postref ref">#{line.progress.post}</span>
              )}
            </span>
          )}
        </button>
        {open && line.tasks.length > 0 && (
          <ul className="ensemble-tasks">{sortTasks(line.tasks).map((task) => taskRow(task))}</ul>
        )}
      </section>
    );
  };

  const overviewBody: ReactNode =
    overview === undefined ? (
      // ADR-0131 §5：没有概览数据的旧合奏降级显示标题/结束摘要/成员入口
      <div className="ensemble-legacy">
        <h3 className="ensemble-legacy-title">{ensemble.title}</h3>
        {ended && ensemble.summary !== undefined && (
          <p className="ensemble-legacy-summary">{ensemble.summary}</p>
        )}
        {ended && !ensemble.summary && <p className="ensemble-legacy-note">合奏已结束。</p>}
        {ended && ensemble.unmerged !== undefined && ensemble.unmerged.length > 0 && (
          <div className="ensemble-legacy-unmerged">
            <div className="ensemble-grp">未并回的工作树</div>
            {ensemble.unmerged.map((item) => (
              <div key={item.childSessionId} className="ensemble-legacy-branch">
                @{item.name}（{item.branch}）
              </div>
            ))}
          </div>
        )}
        <div className="ensemble-grp">成员</div>
        <div className="ensemble-mems embedded">
          {ensemble.members
            .filter((member) => member.status !== "removed")
            .map((member) => memberRow(member))}
        </div>
      </div>
    ) : (
      <div className="ensemble-overview">
        {overview.goal !== undefined && (
          <section className="ensemble-ov-block">
            <h4 className="ensemble-ov-h">目标</h4>
            <p className="ensemble-ov-goal">{overview.goal}</p>
          </section>
        )}
        {overview.checkpoints.length > 0 && (
          <ul className="ensemble-ov-cps">
            {overview.checkpoints.map((checkpoint) => (
              <li key={checkpoint}>
                <span className="ensemble-cp-tag">检查点</span>
                <span>{checkpoint}</span>
              </li>
            ))}
          </ul>
        )}
        {stats !== undefined && stats.total > 0 && (
          <div className="ensemble-ov-progress">
            <div className="ensemble-ov-sum">
              <h3>任务</h3>
              <span className="n">{`${stats.done}/${stats.total}`}</span>
              <span className="t">已完成</span>
              <span className="flags">
                {ended && <span className="ensemble-ov-ended">已结束</span>}
                {stats.work > 0 && (
                  <span className="flag">
                    <span className="ensemble-dot work" aria-hidden="true" />
                    {`${stats.work} 进行中`}
                  </span>
                )}
                {stats.wait > 0 && (
                  <span className="flag wait">
                    <Icon name="time" size={ICON_SM} />
                    {`${stats.wait} 等待`}
                  </span>
                )}
              </span>
            </div>
            <div className="ensemble-ov-bar" aria-hidden="true">
              {allTasks.map((task) => (
                <i key={task.id} className={task.status} />
              ))}
            </div>
          </div>
        )}
        {ended && stats?.total === 0 && (
          <div className="ensemble-ov-progress">
            <div className="ensemble-ov-sum">
              <span className="ensemble-ov-ended">已结束</span>
            </div>
          </div>
        )}
        {overview.lines.map(lineBlock)}
        {ended && ensemble.summary !== undefined && (
          <section className="ensemble-ov-block">
            <h4 className="ensemble-ov-h">结束摘要</h4>
            <p className="ensemble-ov-goal">{ensemble.summary}</p>
          </section>
        )}
        {ended && ensemble.unmerged !== undefined && ensemble.unmerged.length > 0 && (
          <section className="ensemble-ov-block">
            <h4 className="ensemble-ov-h">未并回的工作树</h4>
            {ensemble.unmerged.map((item) => (
              <div key={item.childSessionId} className="ensemble-legacy-branch">
                @{item.name}（{item.branch}）
              </div>
            ))}
          </section>
        )}
      </div>
    );

  return (
    <div className="ensemble-pane">
      <div className="ensemble-subbar">
        <div className="ensemble-seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            className={tab === "overview" ? "on" : undefined}
            onClick={() => {
              setTab("overview");
            }}
          >
            概览
          </button>
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
            <button
              type="button"
              className={follow ? "ensemble-ib on" : "ensemble-ib"}
              aria-label="跟随最新"
              aria-pressed={follow}
              onClick={() => {
                if (follow) {
                  patch({ follow: false });
                  return;
                }
                patch({ follow: true });
                const element = body.current;
                if (element !== null) {
                  element.scrollTop = element.scrollHeight;
                  previousScrollTop.current = element.scrollTop;
                }
              }}
            >
              <Icon name="down_small" size={ICON_MD} />
            </button>
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
      {tab === "overview" && <div className="ensemble-body overview-body">{overviewBody}</div>}
      {tab === "board" && (
        <>
          <div className="ensemble-boardbar">
            <div className="ensemble-boardbar-row">
              <div className="ensemble-q-wrap">
                <input
                  type="text"
                  className="ensemble-q"
                  aria-label="搜索留言"
                  placeholder="搜索留言"
                  value={query}
                  onChange={(event) => {
                    patch({ query: event.target.value });
                  }}
                />
                {query.trim() !== "" && (
                  <span className="ensemble-q-hits">{`${posts.length}/${ensemble.posts.length}`}</span>
                )}
                {query.trim() !== "" && (
                  <span className="ensemble-q-hits" aria-hidden="true">
                    {posts.length}
                  </span>
                )}
                {query !== "" && (
                  <button
                    type="button"
                    className="ensemble-q-x"
                    aria-label="清空搜索"
                    onClick={() => {
                      patch({ query: "" });
                    }}
                  >
                    <Icon name="close" size={ICON_SM} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className={filterOpen || filterCount > 0 ? "ensemble-ib on" : "ensemble-ib"}
                aria-label="筛选"
                aria-expanded={filterOpen}
                aria-pressed={filterOpen}
                onClick={() => {
                  patch({ filterOpen: !filterOpen });
                }}
              >
                <Icon name="settings_6" size={ICON_MD} />
                {filterCount > 0 && <span className="ensemble-filter-n">{filterCount}</span>}
              </button>
            </div>
            {!filterOpen && (filterFrom !== undefined || filterTo !== undefined) && (
              <div className="ensemble-fchips">
                {filterFrom !== undefined && (
                  <span className="ensemble-fchip">
                    {`来自 ${filterFrom === "maestro" ? "指挥" : `@${filterFrom}`}`}
                    <button
                      type="button"
                      aria-label="移除作者筛选"
                      onClick={() => {
                        patch({ filterFrom: undefined });
                      }}
                    >
                      <Icon name="close" size={ICON_SM} />
                    </button>
                  </span>
                )}
                {filterTo !== undefined && (
                  <span className="ensemble-fchip">
                    {`发给 ${filterTo === "maestro" ? "指挥" : `@${filterTo}`}`}
                    <button
                      type="button"
                      aria-label="移除收件人筛选"
                      onClick={() => {
                        patch({ filterTo: undefined });
                      }}
                    >
                      <Icon name="close" size={ICON_SM} />
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  className="ensemble-fclear"
                  onClick={() => {
                    patch({ filterFrom: undefined, filterTo: undefined });
                  }}
                >
                  清除筛选
                </button>
              </div>
            )}
          </div>
          <div className="ensemble-body-wrap">
            {filterOpen && (
              <div className="ensemble-filterpop">
                <div className="ensemble-fselrow">
                  <span className="ensemble-flab">来自</span>
                  <button
                    type="button"
                    className="ensemble-fsel"
                    aria-haspopup="menu"
                    aria-expanded={menu !== null && menu.kind === "filter" && menu.which === "from"}
                    onClick={(event) => {
                      setMenu({ kind: "filter", which: "from", anchor: event.currentTarget });
                    }}
                  >
                    <span className="ensemble-fsel-v">
                      {filterFrom === undefined
                        ? "全部"
                        : filterFrom === "maestro"
                          ? "指挥"
                          : `@${filterFrom}`}
                    </span>
                    <Icon name="down_small" size={ICON_SM} />
                  </button>
                </div>
                <div className="ensemble-fselrow">
                  <span className="ensemble-flab">发给</span>
                  <button
                    type="button"
                    className="ensemble-fsel"
                    aria-haspopup="menu"
                    aria-expanded={menu !== null && menu.kind === "filter" && menu.which === "to"}
                    onClick={(event) => {
                      setMenu({ kind: "filter", which: "to", anchor: event.currentTarget });
                    }}
                  >
                    <span className="ensemble-fsel-v">
                      {filterTo === undefined
                        ? "全部"
                        : filterTo === "maestro"
                          ? "指挥"
                          : `@${filterTo}`}
                    </span>
                    <Icon name="down_small" size={ICON_SM} />
                  </button>
                </div>
                <div className="ensemble-fselrow end">
                  <button
                    type="button"
                    className="ensemble-fclear"
                    onClick={() => {
                      patch({ filterFrom: undefined, filterTo: undefined });
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              </div>
            )}
            <div className="ensemble-body" ref={body} onScroll={onBodyScroll} onWheel={onBodyWheel}>
              {posts.map(post)}
              {posts.length === 0 && ensemble.posts.length > 0 && (
                <p className="ensemble-nomatch">没有符合筛选的帖子</p>
              )}
            </div>
          </div>
          <div className="ensemble-meta">
            {filtered ? `${posts.length}/${ensemble.posts.length}` : `${ensemble.posts.length}`}
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
      )}
      {tab === "members" && (
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
                    patch({ retiredOpen: !retiredOpen });
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
      {menu !== null && menu.kind === "filter" && (
        <ChoiceMenu
          anchor={menu.anchor}
          label={menu.which === "from" ? "来自" : "发给"}
          control={filterIdentities(menu.which)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}
