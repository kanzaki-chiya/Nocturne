import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SessionView, WorkspaceBranches } from "@nocturne/core/protocol";
import type { RpcRuntime, RpcSession } from "@nocturne/rpc/client";
import { Menu } from "./Menu";
import { Icon, ICON_SM } from "./ui";
import { useSessionRefresh } from "./use-session-refresh";
import "./branch-menu.css";

export function BranchMenu({
  client,
  session,
  workspace,
  view,
  replaying = false,
}: {
  client: Pick<RpcRuntime, "workspaceBranches" | "switchBranch">;
  session: RpcSession;
  workspace: string;
  view: SessionView;
  replaying?: boolean;
}) {
  const owner = useMemo(() => ({ session, workspace, client }), [session, workspace, client]);
  const [snapshot, setSnapshot] = useState<{ owner: object; value: WorkspaceBranches }>();
  const data = snapshot?.owner === owner ? snapshot.value : undefined;
  const [opened, setOpened] = useState<object | null>(null);
  const open = opened === owner;
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<object | null>(null);
  const [active, setActive] = useState(-1);
  const [hoverPath, setHoverPath] = useState<{ path: string; left: number; top: number } | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const busy =
    switching === owner ||
    data?.busy === true ||
    (view.status !== "idle" && view.status !== "failed");
  const refresh = useSessionRefresh(owner, !replaying, async (isCurrent) => {
    try {
      const value = await client.workspaceBranches({ workspace });
      if (isCurrent()) setSnapshot({ owner, value });
    } catch {
      if (isCurrent()) setSnapshot(undefined);
    }
  });
  useEffect(() => {
    void refresh();
  }, [refresh, replaying, view.turnCount, view.status]);
  useEffect(() => {
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);

  const filtered =
    data?.branches.filter((branch) => branch.name.toLowerCase().includes(query.toLowerCase())) ??
    [];
  const create = query.length > 0 && !data?.branches.some((branch) => branch.name === query);
  const options = [
    ...filtered.map((branch) => ({ ...branch, create: false })),
    ...(create ? [{ name: query, create: true, worktree: undefined }] : []),
  ];
  const enabled = options.filter((option) => option.worktree === undefined);
  const selected = active < 0 ? -1 : Math.min(active, Math.max(0, enabled.length - 1));
  const close = () => {
    setHoverPath(null);
    setOpened(null);
    trigger.current?.focus();
  };
  const choose = async (branch: string, create: boolean) => {
    if (busy) return;
    setSwitching(owner);
    setError(null);
    try {
      await client.switchBranch({ workspace, branch, ...(create ? { create: true } : {}) });
      if (currentOwner.current !== owner) return;
      await refresh();
      if (currentOwner.current !== owner) return;
      close();
      requestAnimationFrame(() => {
        if (currentOwner.current === owner) trigger.current?.focus();
      });
    } catch (failure) {
      if (currentOwner.current === owner)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (currentOwner.current === owner) setSwitching(null);
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (["Home", "End"].includes(event.key) && event.target === search.current) return;
    if (event.key === "Enter") {
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      const option = enabled[selected >= 0 ? selected : 0];
      if (option) void choose(option.name, option.create);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : selected < 0
              ? event.key === "ArrowUp"
                ? enabled.length - 1
                : 0
              : (selected + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) %
                Math.max(1, enabled.length);
      setActive(Math.max(0, next));
      search.current?.focus();
      const option = event.currentTarget.querySelectorAll<HTMLElement>(
        '[data-branch-enabled="true"]',
      )[next];
      if (option && "scrollIntoView" in option) option.scrollIntoView({ block: "nearest" });
    }
  };

  if (!data?.current) return null;
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className="status-pill status-branch"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          if (open) close();
          else {
            setQuery("");
            setError(null);
            setActive(-1);
            setOpened(owner);
            void refresh();
          }
        }}
      >
        <Icon name="git_branch" size={ICON_SM} />
        <b>{data.current}</b>
      </button>
      {open && (
        <>
          <Menu
            anchor={trigger.current}
            align="right"
            className="branch-menu"
            onClose={close}
            onKeyDown={keyboard}
          >
            <label className="branch-search">
              <Icon name="search" size={ICON_SM} />
              <input
                ref={search}
                className="menu-search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(-1);
                  setHoverPath(null);
                }}
              />
            </label>
            <div className="branch-list">
              {options.map((option) => (
                <div
                  key={option.name}
                  className="branch-row"
                  onMouseEnter={(event) => {
                    if (option.worktree === undefined) return;
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setHoverPath({
                      path: option.worktree,
                      left: Math.max(8, Math.min(bounds.left, window.innerWidth - 368)),
                      top: Math.min(bounds.bottom + 4, window.innerHeight - 64),
                    });
                  }}
                  onMouseLeave={() => {
                    setHoverPath(null);
                  }}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!option.create && option.name === data.current}
                    data-branch-enabled={option.worktree === undefined}
                    className={`branch-option${enabled[selected] === option ? " act" : ""}${option.create ? " branch-create" : ""}`}
                    disabled={busy || option.worktree !== undefined}
                    title={option.worktree}
                    onMouseEnter={() => {
                      const index = enabled.indexOf(option);
                      if (index >= 0) setActive(index);
                    }}
                    onClick={() => {
                      void choose(option.name, option.create);
                    }}
                  >
                    <span className="branch-check">
                      {!option.create && option.name === data.current && (
                        <Icon name="check" size={ICON_SM} />
                      )}
                    </span>
                    <span>{option.create ? `新建分支 ${option.name}` : option.name}</span>
                  </button>
                </div>
              ))}
            </div>
            {error !== null && (
              <pre className="branch-error" role="alert">
                {error}
              </pre>
            )}
          </Menu>
          {hoverPath && (
            <div
              role="tooltip"
              className="branch-path"
              style={{ left: hoverPath.left, top: hoverPath.top }}
            >
              {hoverPath.path}
            </div>
          )}
        </>
      )}
    </>
  );
}
