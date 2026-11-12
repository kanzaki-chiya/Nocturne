/**
 * Swarm 面板主体（ADR-0089）：留言板与成员页。桌面右侧面板与手机全屏页共用这一份结构，
 * 尺寸差异只由外层 `.phone` 的少量 CSS 覆盖提供。
 *
 * 数据来自 `SessionView.swarm`（协议层已归约），写操作全部走 RpcSession：
 * 发帖 `postToSwarm`、移除成员 `removeSwarmMember`、结束 `endSwarm`。
 */
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { SwarmMemberView, SwarmPostView, SwarmView } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { Markdown, type FileLinkHooks } from "./Conversation";
import { Menu, MenuItem } from "./Menu";
import {
  filterSwarmPosts,
  formatSwarmTime,
  groupSwarmMembers,
  shortModelName,
  swarmActivitySummary,
  swarmAuthorLabel,
  swarmCoordinatorDot,
  swarmMemberDot,
  swarmMentionLabel,
} from "./swarm-ui";
import { ICON_MD, ICON_SM, Icon } from "./ui";
import "./swarm-panel.css";

/** 留言板输入框最大高度：约 6 行之后改为内滚 */
const BOARD_INPUT_MAX_HEIGHT = 132;
/** 距底部不超过该距离仍算「在底部」，避免像素级抖动把跟随关掉 */
const FOLLOW_SLACK = 4;

/** Swarm 面板用到的会话能力（手机网页与桌面端传的都是当前协调者会话） */
export type SwarmSession = Pick<RpcSession, "postToSwarm" | "removeSwarmMember" | "endSwarm"> &
  Partial<Pick<RpcSession, "resolveFiles">>;

export interface SwarmPaneProps {
  swarm: SwarmView;
  session: SwarmSession;
  openUrl: (url: string) => void;
  fileLinks?: FileLinkHooks | undefined;
  /** 点击某个成员行时打开该成员会话 */
  onOpenMember: (member: SwarmMemberView) => void;
  /** 点击顶部协调者行时回调（桌面聚焦主输入框，手机返回主会话） */
  onSelectCoordinator?: (() => void) | undefined;
  /** 面板当前是否可见（可见或切换回留言板且跟随开启时滚到底） */
  visible?: boolean | undefined;
}

type SwarmTab = "board" | "members";

/** 当前展开的溢出菜单：子栏「结束」或某一行成员的「移除」 */
type OpenMenu =
  | { kind: "bar"; anchor: HTMLElement }
  | { kind: "member"; anchor: HTMLElement; member: SwarmMemberView };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SwarmPane({
  swarm,
  session,
  openUrl,
  fileLinks,
  onOpenMember,
  onSelectCoordinator,
  visible,
}: SwarmPaneProps) {
  const [tab, setTab] = useState<SwarmTab>("board");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedMember, setSelectedMember] = useState("");
  const [follow, setFollow] = useState(true);
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const body = useRef<HTMLDivElement>(null);
  const previousScrollTop = useRef(0);
  const searchField = useRef<HTMLInputElement>(null);
  const boardField = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sending = useRef(false);

  const shown = visible !== false;
  const postCount = swarm.posts.length;

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
    void session.postToSwarm({ text: draft }).then(
      () => {
        sending.current = false;
        setDraft("");
      },
      (cause: unknown) => {
        sending.current = false;
        setBoardError(errorText(cause));
      },
    );
  };

  const end = () => {
    setMenu(null);
    setActionError(null);
    void session.endSwarm().catch((cause: unknown) => {
      setActionError(errorText(cause));
    });
  };

  const remove = (member: SwarmMemberView) => {
    setMenu(null);
    setActionError(null);
    void session.removeSwarmMember(member.name).catch((cause: unknown) => {
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
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (composing.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const active = swarm.status === "active";
  const posts = filterSwarmPosts(swarm.posts, {
    member: selectedMember,
    query,
    members: swarm.members,
  });
  const groups = groupSwarmMembers(swarm.members);
  const coordinatorModel = shortModelName(swarm.coordinator.model);
  const coordinatorSummary = swarmActivitySummary(swarm.coordinator.activity);

  const memberRow = (member: SwarmMemberView) => {
    const summary = swarmActivitySummary(member.activity);
    const retired = member.status === "removed";
    const removable = active && !retired;
    return (
      <div
        key={member.name}
        className={retired ? "swarm-mem retired" : "swarm-mem"}
        onContextMenu={(event) => {
          if (!removable) return;
          event.preventDefault();
          setActionError(null);
          setMenu({ kind: "member", anchor: event.currentTarget, member });
        }}
      >
        <button
          type="button"
          className="swarm-mem-main"
          onClick={() => {
            onOpenMember(member);
          }}
        >
          <span
            className={`swarm-dot ${swarmMemberDot(member, swarm.status)}`}
            aria-hidden="true"
          />
          <span className="swarm-mem-name">
            {member.name}
            <i>{shortModelName(member.model)}</i>
          </span>
          {member.lastPostNumber !== undefined ? (
            <span className="swarm-mem-no">{`#${member.lastPostNumber}`}</span>
          ) : (
            <span className="swarm-mem-no" />
          )}
          {summary !== "" && <span className="swarm-mem-last">{summary}</span>}
        </button>
        {removable && (
          <button
            type="button"
            className="swarm-ib swarm-mem-menu"
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

  const post = (item: SwarmPostView) => {
    const time = formatSwarmTime(item.time);
    const charter =
      item.charterOf !== undefined
        ? swarm.members.find((member) => member.name === item.charterOf)?.charter
        : undefined;
    const className = `swarm-post${item.fromKind === "user" ? " user" : ""}${
      item.fromKind === "runtime" && item.charterOf === undefined ? " sys" : ""
    }`;
    return (
      <article key={item.seq} className={className}>
        <div className="swarm-post-head">
          <span className="swarm-post-from">
            {swarmAuthorLabel(item.from, item.fromKind)}
            {item.mentions.length > 0 && (
              <span className="swarm-post-to">
                {" → "}
                {item.mentions.map((mention, index) => (
                  <Fragment key={mention}>
                    {index > 0 ? " " : null}
                    <b>{swarmMentionLabel(mention)}</b>
                  </Fragment>
                ))}
              </span>
            )}
          </span>
          <span className="swarm-post-meta">{`#${item.number}${
            time !== "" ? ` · ${time}` : ""
          }`}</span>
        </div>
        <div className="swarm-post-txt">
          {charter !== undefined ? (
            <>
              <div className="swarm-charter-row">
                <span className="swarm-charter-tag">负责</span>
                <span>{charter.owns}</span>
              </div>
              <div className="swarm-charter-row">
                <span className="swarm-charter-tag">不碰</span>
                <span>{charter.handsOff}</span>
              </div>
              <div className="swarm-charter-row">
                <span className="swarm-charter-tag">完成</span>
                <span>{charter.doneWhen}</span>
              </div>
            </>
          ) : item.fromKind === "runtime" ? (
            <div className="swarm-sys-text">{item.text}</div>
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
      </article>
    );
  };

  return (
    <div className="swarm-pane">
      <div className="swarm-subbar">
        <div className="swarm-seg" role="tablist">
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
        <div className="swarm-tools">
          {tab === "board" && (
            <>
              <button
                type="button"
                className={searchOpen ? "swarm-ib on" : "swarm-ib"}
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
                className={follow ? "swarm-ib on" : "swarm-ib"}
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
              className="swarm-ib"
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
        <p className="conversation-error swarm-error" role="alert">
          {actionError}
        </p>
      )}
      {tab === "board" ? (
        <>
          {searchOpen && (
            <div className="swarm-search">
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
          <div className="swarm-filters">
            <button
              type="button"
              className={selectedMember === "" ? "swarm-chip on" : "swarm-chip"}
              onClick={() => {
                setSelectedMember("");
              }}
            >
              全部
            </button>
            {swarm.members.map((member) => (
              <button
                key={member.name}
                type="button"
                className={selectedMember === member.name ? "swarm-chip on" : "swarm-chip"}
                onClick={() => {
                  setSelectedMember(member.name);
                }}
              >
                {`@${member.name}`}
              </button>
            ))}
          </div>
          <div className="swarm-body" ref={body} onScroll={onBodyScroll} onWheel={onBodyWheel}>
            {posts.map(post)}
          </div>
          {active && (
            <div className="swarm-boardin">
              {boardError !== null && (
                <p className="conversation-error" role="alert">
                  {boardError}
                </p>
              )}
              <textarea
                ref={boardField}
                aria-label="留言板"
                rows={1}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onKeyDown={onBoardKeyDown}
              />
            </div>
          )}
        </>
      ) : (
        <div className="swarm-mems">
          <div className="swarm-mem coord">
            <button
              type="button"
              className="swarm-mem-main"
              onClick={() => {
                onSelectCoordinator?.();
              }}
            >
              <span className={`swarm-dot ${swarmCoordinatorDot(swarm)}`} aria-hidden="true" />
              <span className="swarm-mem-name">
                协调者
                {coordinatorModel !== "" ? <i>{coordinatorModel}</i> : null}
              </span>
              {swarm.coordinator.lastPostNumber !== undefined ? (
                <span className="swarm-mem-no">{`#${swarm.coordinator.lastPostNumber}`}</span>
              ) : (
                <span className="swarm-mem-no" />
              )}
              {coordinatorSummary !== "" && (
                <span className="swarm-mem-last">{coordinatorSummary}</span>
              )}
            </button>
          </div>
          {groups.working.length > 0 && (
            <>
              <div className="swarm-grp">工作中</div>
              {groups.working.map(memberRow)}
            </>
          )}
          {groups.paused.length > 0 && (
            <>
              <div className="swarm-grp">已暂停</div>
              {groups.paused.map(memberRow)}
            </>
          )}
          {groups.waiting.length > 0 && (
            <>
              <div className="swarm-grp">等待</div>
              {groups.waiting.map(memberRow)}
            </>
          )}
          {groups.removed.length > 0 && (
            <>
              <div className="swarm-grp">
                <button
                  type="button"
                  className="swarm-retired-toggle"
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
