import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SessionView, WorkspaceBranch, WorkspaceBranches } from "@nocturne/core/protocol";
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

export interface BranchMenuOptions {
  /** 触发按钮上的分支名 */
  label: string;
  branches: readonly WorkspaceBranch[];
  /** 打勾的分支名 */
  checked: string | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** 选中一项；返回 true 表示已完成并关闭菜单（键盘选中时焦点回到触发按钮） */
  onChoose: (name: string, create: boolean) => boolean | Promise<boolean>;
  triggerClassName: string;
  /** false：没有菜单（非仓库），按钮不带菜单属性 */
  hasMenu?: boolean;
  disabled?: boolean;
  /** 整个列表不可选（切换中、目录忙） */
  optionsDisabled?: boolean;
  /** 其他工作树占用的分支也可选（新会话页） */
  occupiedSelectable?: boolean;
  /** 搜索词不匹配已有分支时，是否给出「新建分支」项 */
  canCreate?: (name: string) => boolean;
  align?: "left" | "right";
  caret?: boolean;
  ariaLabel?: string;
  error?: string | null;
}

/**
 * 分支触发按钮与下拉菜单（会话状态栏与新会话页共用）。分开返回两个节点，
 * 调用方各自决定菜单挂在 DOM 的哪里。
 */
export function useBranchMenu({
  label,
  branches,
  checked,
  open,
  onOpen,
  onClose,
  onChoose,
  triggerClassName,
  hasMenu = true,
  disabled = false,
  optionsDisabled = false,
  occupiedSelectable = false,
  canCreate,
  align = "right",
  caret = false,
  ariaLabel,
  error,
}: BranchMenuOptions): { trigger: ReactNode; menu: ReactNode } {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const filtered = branches.filter((branch) =>
    branch.name.toLowerCase().includes(query.toLowerCase()),
  );
  const create =
    query.length > 0 &&
    !branches.some((branch) => branch.name === query) &&
    (canCreate?.(query) ?? true);
  const options = [
    ...filtered.map((branch) => ({ ...branch, create: false })),
    ...(create ? [{ name: query, create: true, worktree: undefined }] : []),
  ];
  const selectable = (option: (typeof options)[number]) =>
    !optionsDisabled && (occupiedSelectable || option.worktree === undefined);
  const enabled = options.filter(selectable);
  const selected = active < 0 ? -1 : Math.min(active, Math.max(0, enabled.length - 1));
  const choose = async (name: string, isCreate: boolean, returnFocus: boolean) => {
    if (optionsDisabled) return;
    const done = await onChoose(name, isCreate);
    if (done && returnFocus) {
      requestAnimationFrame(() => {
        trigger.current?.focus();
      });
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
      if (enabled.length === 0) return;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : selected < 0
              ? event.key === "ArrowUp"
                ? enabled.length - 1
                : 0
              : (selected + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
      setActive(Math.max(0, next));
      search.current?.focus();
      const option = event.currentTarget.querySelectorAll<HTMLElement>(
        '[data-branch-enabled="true"]',
      )[next];
      if (option && "scrollIntoView" in option) option.scrollIntoView({ block: "nearest" });
    }
  };

  const triggerNode = (
    <button
      type="button"
      ref={trigger}
      className={triggerClassName}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup={hasMenu ? "menu" : undefined}
      aria-expanded={hasMenu ? open : undefined}
      onClick={() => {
        if (!hasMenu) return;
        if (open) onClose();
        else {
          setQuery("");
          setActive(-1);
          onOpen();
        }
      }}
    >
      <Icon name="git_branch" size={ICON_SM} />
      <b>{label}</b>
      {caret && <Icon name="down_small" size={ICON_SM} className="caret" />}
    </button>
  );
  const menu = open && hasMenu && (
    <Menu
      anchor={trigger.current}
      align={align}
      className="branch-menu"
      onClose={onClose}
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
        {options.map((option) => {
          const isChecked = !option.create && option.name === checked;
          return (
            <div
              key={`${option.create ? "new:" : ""}${option.name}`}
              className="branch-row"
              title={option.worktree}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={isChecked}
                data-branch-enabled={selectable(option)}
                className={`branch-option${enabled[selected] === option ? " act" : ""}${option.create ? " branch-create" : ""}`}
                disabled={!selectable(option)}
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
                    isChecked && <Icon name="check" size={ICON_SM} />
                  )}
                </span>
                <span>{option.create ? `新建分支 ${option.name}` : option.name}</span>
              </button>
            </div>
          );
        })}
      </div>
      {error != null && (
        <pre className="branch-error" role="alert">
          {error}
        </pre>
      )}
    </Menu>
  );
  return { trigger: triggerNode, menu };
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
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<object | null>(null);
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

  const close = () => {
    setOpened(null);
  };
  const choose = async (branch: string, create: boolean): Promise<boolean> => {
    setSwitching(owner);
    setError(null);
    try {
      await client.switchBranch({
        workspace: effectiveWorkspace,
        branch,
        ...(create ? { create: true } : {}),
      });
      if (currentOwner.current !== owner) return false;
      await refresh();
      if (currentOwner.current !== owner) return false;
      close();
      return currentOwner.current === owner;
    } catch (failure) {
      if (currentOwner.current === owner)
        setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (currentOwner.current === owner) setSwitching(null);
    }
  };
  const { trigger, menu } = useBranchMenu({
    label: data?.current ?? "",
    branches: data?.branches ?? [],
    checked: data?.current ?? undefined,
    open,
    onOpen: () => {
      setError(null);
      setOpened(owner);
      void refresh();
    },
    onClose: close,
    onChoose: choose,
    triggerClassName: "status-pill status-branch",
    disabled: triggerBusy,
    optionsDisabled: optionBusy,
    error,
  });

  if (!data?.current) return null;
  return (
    <>
      {trigger}
      {menu}
    </>
  );
}
