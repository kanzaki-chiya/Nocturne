import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionView, WorkspaceBranches } from "@nocturne/core/protocol";
import type { RpcRuntime, RpcSession } from "@nocturne/rpc/client";
import { Menu } from "./Menu";
import { Icon, ICON_SM } from "./ui";
import { useSessionRefresh } from "./use-session-refresh";
import "./branch-menu.css";

export function isValidGitBranchName(raw: string): boolean {
  const name = raw.trim();
  if (
    name === "" ||
    name !== raw ||
    name === "@" ||
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name.includes("\\")
  ) {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
    const ch = name.charAt(i);
    if ("~^:?*[".includes(ch)) return false;
  }
  for (const part of name.split("/")) {
    if (part === "" || part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  return true;
}

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
  const effectiveWorkspace = view.currentCwd ?? workspace;
  const owner = useMemo(
    () => ({ session, workspace: effectiveWorkspace, client }),
    [session, effectiveWorkspace, client],
  );
  const [snapshot, setSnapshot] = useState<{ owner: object; value: WorkspaceBranches }>();
  const data = snapshot?.owner === owner ? snapshot.value : undefined;
  const [opened, setOpened] = useState<object | null>(null);
  const open = opened === owner;
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<object | null>(null);
  const [active, setActive] = useState(-1);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const triggerBusy = switching === owner || (view.status !== "idle" && view.status !== "failed");
  const optionBusy = triggerBusy || data?.busy === true;
  const refresh = useSessionRefresh(owner, !replaying, async (isCurrent) => {
    try {
      const value = await client.workspaceBranches({ workspace: effectiveWorkspace });
      if (isCurrent()) setSnapshot({ owner, value });
    } catch {
      if (isCurrent()) setSnapshot(undefined);
    }
  });
  useEffect(() => {
    void refresh();
  }, [refresh, replaying, view.turnCount, view.status]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    try {
      void Promise.resolve(listen("tauri://focus", focus))
        .then((off) => {
          if (disposed) off();
          else unlisten = off;
        })
        .catch(() => undefined);
    } catch {
      // Non-Tauri test environments rely on window focus.
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
      unlisten?.();
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
  const enabled = optionBusy ? [] : options.filter((option) => option.worktree === undefined);
  const selected = active < 0 ? -1 : Math.min(active, Math.max(0, enabled.length - 1));
  const close = () => {
    setOpened(null);
  };
  const choose = async (branch: string, create: boolean, returnFocus: boolean) => {
    if (optionBusy) return;
    setSwitching(owner);
    setError(null);
    try {
      await client.switchBranch({
        workspace: effectiveWorkspace,
        branch,
        ...(create ? { create: true } : {}),
      });
      if (currentOwner.current !== owner) return;
      await refresh();
      if (currentOwner.current !== owner) return;
      close();
      if (returnFocus) {
        requestAnimationFrame(() => {
          if (currentOwner.current === owner) trigger.current?.focus();
        });
      }
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
      if (option) void choose(option.name, option.create, true);
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
        disabled={triggerBusy}
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
              }}
            />
          </label>
          <div className="branch-list">
            {options.map((option) => (
              <div key={option.name} className="branch-row" title={option.worktree}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!option.create && option.name === data.current}
                  data-branch-enabled={!optionBusy && option.worktree === undefined}
                  className={`branch-option${enabled[selected] === option ? " act" : ""}${option.create ? " branch-create" : ""}`}
                  disabled={optionBusy || option.worktree !== undefined}
                  onMouseEnter={() => {
                    const index = enabled.indexOf(option);
                    if (index >= 0) setActive(index);
                  }}
                  onClick={() => {
                    void choose(option.name, option.create, false);
                  }}
                >
                  <span className="branch-check">
                    {option.create ? (
                      <Icon name="add" size={ICON_SM} />
                    ) : (
                      option.name === data.current && <Icon name="check" size={ICON_SM} />
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
      )}
    </>
  );
}
