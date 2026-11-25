import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_GIT_CONFIG,
  DEFAULT_WORKTREE_CONFIG,
  normalizeWorktreeRootInput,
  validateGitBranchPrefix,
  validateWorktreeKeepCount,
  validateWorktreeRoot,
  type GitMergeMethod,
  type GitReviewView,
  type ManagedWorktreeItem,
  type ManagedWorktreesDescription,
  type WorktreeRecoverySnapshot,
} from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { Scrim } from "./ProvidersPage";
import { isMacOS } from "./platform";
import type { SettingItem, SettingsPatch } from "./rpc-types";
import { settingOverrideTitle } from "./setting-source";
import {
  Badge,
  Button,
  Checkbox,
  ICON_MD,
  ICON_SM,
  Icon,
  IconButton,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Switch,
} from "./ui";
import "./git-worktree-settings.css";

const RESET_ICON = <Icon name="refresh_2" size={ICON_MD} />;

export type SaveSettingFn = (
  key: string,
  label: string,
  patch: SettingsPatch,
  options?: { toastText?: string | undefined },
) => Promise<string | undefined>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readBool(item: SettingItem | undefined, fallback: boolean): boolean {
  const raw = item?.effective;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function readString(item: SettingItem | undefined, fallback: string): string {
  return item?.effective ?? fallback;
}

function readPositiveInt(item: SettingItem | undefined, fallback: number): number {
  const raw = Number(item?.effective);
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : fallback;
}

function inferPlatform(defaultSubagentRoot: string | undefined): "win32" | "darwin" {
  if (defaultSubagentRoot !== undefined) {
    if (defaultSubagentRoot.startsWith("/")) return "darwin";
    if (/^[A-Za-z]:\\/.test(defaultSubagentRoot)) return "win32";
  }
  return isMacOS() ? "darwin" : "win32";
}

function formatRelativeAge(timestampMs: number, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - timestampMs) / 86_400_000));
  if (days === 0) return "今天";
  if (days === 1) return "1 天前";
  return `${days} 天前`;
}

function worktreeStateBadge(item: ManagedWorktreeItem): ReactNode {
  if (item.state === "active") return <Badge variant="accent">使用中</Badge>;
  if (item.state === "ahead") {
    return (
      <Badge variant="warn">
        {item.aheadCount > 0 ? `${item.aheadCount} 个独有提交` : "有未提交改动"}
      </Badge>
    );
  }
  return (
    <>
      <Badge variant="ok">已并回</Badge>
      {item.dirty && <Badge variant="warn">有未提交改动</Badge>}
    </>
  );
}

function groupWorktreesByProject(
  items: readonly ManagedWorktreeItem[],
): { projectPath: string; projectName: string; items: ManagedWorktreeItem[] }[] {
  const map = new Map<
    string,
    { projectPath: string; projectName: string; items: ManagedWorktreeItem[] }
  >();
  for (const item of items) {
    let group = map.get(item.projectPath);
    if (group === undefined) {
      group = { projectPath: item.projectPath, projectName: item.projectName, items: [] };
      map.set(item.projectPath, group);
    }
    group.items.push(item);
  }
  return [...map.values()];
}

function AutoResizeTextarea({
  id,
  rows,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  rows: number;
  value: string;
  disabled?: boolean | undefined;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const resize = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    if (el.value === "") {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    const scrollHeight = el.scrollHeight;
    if (scrollHeight > 0) {
      el.style.height = `${scrollHeight + 2}px`;
    } else {
      el.style.height = "";
    }
  }, []);

  useEffect(() => {
    resize();
  }, [draft, resize]);

  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
    };
  }, [resize]);

  return (
    <textarea
      ref={ref}
      id={id}
      className="textarea"
      rows={rows}
      spellCheck={false}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        if (draft === value) return;
        onCommit(draft);
      }}
    />
  );
}

export function GitSettingsSection({
  items,
  save,
  rowError,
  setRowErr,
  disabled = false,
}: {
  items: readonly SettingItem[];
  save: SaveSettingFn;
  rowError: Record<string, string>;
  setRowErr: (key: string, message: string | null) => void;
  disabled?: boolean | undefined;
}) {
  const find = (key: SettingItem["key"]) => items.find((entry) => entry.key === key);

  const prefixItem = find("git.branchPrefix");
  const forcePushItem = find("git.forcePush");
  const mergeMethodItem = find("git.mergeMethod");
  const draftPrItem = find("git.draftPr");
  const reviewViewItem = find("git.reviewView");
  const insCommitItem = find("git.instructions.commit");
  const insPrTitleItem = find("git.instructions.prTitle");
  const insPrBodyItem = find("git.instructions.prBody");

  const prefixValue = readString(prefixItem, DEFAULT_GIT_CONFIG.branchPrefix);
  const forcePush = readBool(forcePushItem, DEFAULT_GIT_CONFIG.forcePush);
  const mergeMethod: GitMergeMethod = mergeMethodItem?.effective === "squash" ? "squash" : "merge";
  const draftPr = readBool(draftPrItem, DEFAULT_GIT_CONFIG.draftPr);
  const reviewView: GitReviewView =
    reviewViewItem?.effective === "separate" ? "separate" : "inline";
  const insCommit = readString(insCommitItem, DEFAULT_GIT_CONFIG.instructions.commit);
  const insPrTitle = readString(insPrTitleItem, DEFAULT_GIT_CONFIG.instructions.prTitle);
  const insPrBody = readString(insPrBodyItem, DEFAULT_GIT_CONFIG.instructions.prBody);

  const [prefixDraft, setPrefixDraft] = useState(prefixValue);
  useEffect(() => {
    setPrefixDraft(prefixValue);
  }, [prefixValue]);

  const commitPrefix = async (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === prefixValue) {
      setRowErr("git.branchPrefix", null);
      setPrefixDraft(prefixValue);
      return;
    }
    const validationError = validateGitBranchPrefix(trimmed);
    if (validationError !== null) {
      setRowErr("git.branchPrefix", `保存失败：${validationError}，已恢复原值`);
      setPrefixDraft(prefixValue);
      return;
    }
    setRowErr("git.branchPrefix", null);
    const err = await save(
      "git.branchPrefix",
      "自动分支前缀",
      {
        "git.branchPrefix": trimmed === DEFAULT_GIT_CONFIG.branchPrefix ? null : trimmed,
      },
      { toastText: `已保存 自动分支前缀 = ${trimmed}` },
    );
    if (err !== undefined) setPrefixDraft(prefixValue);
  };

  return (
    <>
      <SettingsGroup title="分支">
        <SettingsRow
          label="自动分支前缀"
          labelFor="git-branch-prefix"
          overrideTitle={settingOverrideTitle(prefixItem)}
          error={rowError["git.branchPrefix"]}
        >
          {prefixValue !== DEFAULT_GIT_CONFIG.branchPrefix && (
            <IconButton
              aria-label="恢复默认"
              title="恢复默认"
              disabled={disabled}
              onClick={() => {
                setPrefixDraft(DEFAULT_GIT_CONFIG.branchPrefix);
                void commitPrefix(DEFAULT_GIT_CONFIG.branchPrefix);
              }}
            >
              {RESET_ICON}
            </IconButton>
          )}
          <input
            id="git-branch-prefix"
            className="input mono md-w"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            value={prefixDraft}
            onChange={(event) => {
              setPrefixDraft(event.target.value);
            }}
            onBlur={() => {
              void commitPrefix(prefixDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRowErr("git.branchPrefix", null);
                setPrefixDraft(prefixValue);
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="始终强制推送"
          desc={
            <>
              使用 <code>--force-with-lease</code>，远端有本地未见过的提交时拒绝覆盖
            </>
          }
          overrideTitle={settingOverrideTitle(forcePushItem)}
          error={rowError["git.forcePush"]}
        >
          <Switch
            aria-label="始终强制推送"
            checked={forcePush}
            disabled={disabled}
            onChange={(next) => {
              void save(
                "git.forcePush",
                "始终强制推送",
                { "git.forcePush": next ? true : null },
                {
                  toastText: `已${next ? "开启" : "关闭"} 始终强制推送${
                    next ? "，推送将使用 --force-with-lease" : ""
                  }`,
                },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Pull Request">
        <SettingsRow
          label="合并方法"
          overrideTitle={settingOverrideTitle(mergeMethodItem)}
          error={rowError["git.mergeMethod"]}
        >
          <SegmentedControl
            role="radiogroup"
            aria-label="合并方法"
            disabled={disabled}
            value={mergeMethod}
            options={[
              { value: "merge", label: "合并" },
              { value: "squash", label: "压缩合并" },
            ]}
            onChange={(next) => {
              if (next === mergeMethod) return;
              void save(
                "git.mergeMethod",
                "合并方法",
                { "git.mergeMethod": next === DEFAULT_GIT_CONFIG.mergeMethod ? null : next },
                { toastText: `已保存 合并方法 = ${next === "squash" ? "压缩合并" : "合并"}` },
              );
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="创建草稿 Pull Request"
          overrideTitle={settingOverrideTitle(draftPrItem)}
          error={rowError["git.draftPr"]}
        >
          <Switch
            aria-label="创建草稿 Pull Request"
            checked={draftPr}
            disabled={disabled}
            onChange={(next) => {
              void save(
                "git.draftPr",
                "创建草稿 Pull Request",
                { "git.draftPr": next ? null : false },
                { toastText: `已${next ? "开启" : "关闭"} 创建草稿 Pull Request` },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="审查">
        <SettingsRow
          label="审查结果呈现方式"
          overrideTitle={settingOverrideTitle(reviewViewItem)}
          error={rowError["git.reviewView"]}
        >
          <SegmentedControl
            role="radiogroup"
            aria-label="审查结果呈现方式"
            disabled={disabled}
            value={reviewView}
            options={[
              { value: "inline", label: "内联" },
              { value: "separate", label: "单独" },
            ]}
            onChange={(next) => {
              if (next === reviewView) return;
              void save(
                "git.reviewView",
                "审查结果呈现方式",
                { "git.reviewView": next === DEFAULT_GIT_CONFIG.reviewView ? null : next },
                {
                  toastText: `已保存 审查结果呈现方式 = ${next === "separate" ? "单独" : "内联"}`,
                },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="指引">
        <SettingsRow
          className="top"
          label="提交说明"
          labelFor="git-ins-commit"
          overrideTitle={settingOverrideTitle(insCommitItem)}
          error={rowError["git.instructions.commit"]}
        >
          <AutoResizeTextarea
            id="git-ins-commit"
            rows={3}
            disabled={disabled}
            value={insCommit}
            onCommit={(next) => {
              void save(
                "git.instructions.commit",
                "提交说明",
                { "git.instructions.commit": next === "" ? null : next },
                { toastText: "已保存 提交说明" },
              );
            }}
          />
        </SettingsRow>
        <SettingsRow
          className="top"
          label="PR 标题"
          labelFor="git-ins-pr-title"
          overrideTitle={settingOverrideTitle(insPrTitleItem)}
          error={rowError["git.instructions.prTitle"]}
        >
          <AutoResizeTextarea
            id="git-ins-pr-title"
            rows={2}
            disabled={disabled}
            value={insPrTitle}
            onCommit={(next) => {
              void save(
                "git.instructions.prTitle",
                "PR 标题",
                { "git.instructions.prTitle": next === "" ? null : next },
                { toastText: "已保存 PR 标题" },
              );
            }}
          />
        </SettingsRow>
        <SettingsRow
          className="top"
          label="PR 描述"
          labelFor="git-ins-pr-body"
          overrideTitle={settingOverrideTitle(insPrBodyItem)}
          error={rowError["git.instructions.prBody"]}
        >
          <AutoResizeTextarea
            id="git-ins-pr-body"
            rows={5}
            disabled={disabled}
            value={insPrBody}
            onCommit={(next) => {
              void save(
                "git.instructions.prBody",
                "PR 描述",
                { "git.instructions.prBody": next === "" ? null : next },
                { toastText: "已保存 PR 描述" },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

export function WorktreeSettingsSection({
  client,
  items,
  version,
  save,
  showToast,
  rowError,
  setRowErr,
  cleanOpen,
  onCloseClean,
  onCanCleanChange,
  onOpenDirectory,
  onOpenSession,
}: {
  client: RpcClient | undefined;
  items: readonly SettingItem[];
  version: number;
  save: SaveSettingFn;
  showToast: (text: string) => void;
  rowError: Record<string, string>;
  setRowErr: (key: string, message: string | null) => void;
  cleanOpen: boolean;
  onCloseClean: () => void;
  onCanCleanChange?: ((canClean: boolean) => void) | undefined;
  onOpenDirectory?: ((path: string) => Promise<void>) | undefined;
  onOpenSession?: ((sessionId: string, projectPath: string) => void) | undefined;
}) {
  const find = (key: SettingItem["key"]) => items.find((entry) => entry.key === key);

  const sessionRootItem = find("worktree.sessionRoot");
  const subagentRootItem = find("worktree.subagentRoot");
  const fetchItem = find("worktree.fetchBeforeCreate");
  const autoDeleteItem = find("worktree.autoDelete");
  const keepCountItem = find("worktree.keepCount");
  const askDeleteItem = find("worktree.askBeforeDelete");

  const sessionRoot = readString(sessionRootItem, DEFAULT_WORKTREE_CONFIG.sessionRoot);
  const subagentRoot = readString(subagentRootItem, DEFAULT_WORKTREE_CONFIG.subagentRoot);
  const fetchBeforeCreate = readBool(fetchItem, DEFAULT_WORKTREE_CONFIG.fetchBeforeCreate);
  const autoDelete = readBool(autoDeleteItem, DEFAULT_WORKTREE_CONFIG.autoDelete);
  const keepCount = readPositiveInt(keepCountItem, DEFAULT_WORKTREE_CONFIG.keepCount);
  const askBeforeDelete = readBool(askDeleteItem, DEFAULT_WORKTREE_CONFIG.askBeforeDelete);

  const [desc, setDesc] = useState<ManagedWorktreesDescription | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [sessionRootDraft, setSessionRootDraft] = useState(sessionRoot);
  const [subagentRootDraft, setSubagentRootDraft] = useState(subagentRoot);
  const [keepDraft, setKeepDraft] = useState(String(keepCount));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [delTarget, setDelTarget] = useState<ManagedWorktreeItem | null>(null);
  const [skipAsk, setSkipAsk] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const cleanCancelRef = useRef<HTMLButtonElement>(null);
  const delCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setSessionRootDraft(sessionRoot);
  }, [sessionRoot]);
  useEffect(() => {
    setSubagentRootDraft(subagentRoot);
  }, [subagentRoot]);
  useEffect(() => {
    setKeepDraft(String(keepCount));
  }, [keepCount]);

  const loadGen = useRef(0);
  const refreshWorktrees = useCallback(async () => {
    if (client === undefined) return;
    const gen = ++loadGen.current;
    setListError(null);
    try {
      const next = await client.runtime.describeManagedWorktrees();
      if (gen === loadGen.current) setDesc(next);
    } catch (error) {
      if (gen === loadGen.current) setListError(errText(error));
    }
  }, [client]);

  useEffect(() => {
    void refreshWorktrees();
    return () => {
      loadGen.current++;
    };
  }, [refreshWorktrees, version]);

  const worktrees = useMemo(() => desc?.worktrees ?? [], [desc]);
  const snapshots = useMemo(() => desc?.snapshots ?? [], [desc]);
  const platformKey = inferPlatform(desc?.defaultSubagentRoot);
  const sessionRootPlaceholder =
    platformKey === "win32" ? "<仓库父目录>\\<仓库名>-wt" : "<仓库父目录>/<仓库名>-wt";

  const canClean = useMemo(() => worktrees.some((item) => item.state !== "active"), [worktrees]);
  useEffect(() => {
    onCanCleanChange?.(canClean);
  }, [canClean, onCanCleanChange]);

  const doomedCount = useMemo(
    () => worktrees.filter((item) => item.autoDeleteCandidate).length,
    [worktrees],
  );
  const projectGroups = useMemo(() => groupWorktreesByProject(worktrees), [worktrees]);

  // 清理预览弹窗打开时，按默认规则勾选（已并回、干净、未置顶）
  const cleanCandidates = useMemo(
    () => worktrees.filter((item) => item.state !== "active"),
    [worktrees],
  );
  const cleanGroups = useMemo(() => groupWorktreesByProject(cleanCandidates), [cleanCandidates]);
  useEffect(() => {
    if (!cleanOpen) return;
    setPicked(
      new Set(
        cleanCandidates
          .filter((item) => item.state === "merged" && !item.dirty && !item.pinned)
          .map((item) => item.id),
      ),
    );
    requestAnimationFrame(() => {
      cleanCancelRef.current?.focus();
    });
  }, [cleanOpen, cleanCandidates]);

  useEffect(() => {
    if (delTarget === null) return;
    setSkipAsk(false);
    requestAnimationFrame(() => {
      delCancelRef.current?.focus();
    });
  }, [delTarget]);

  const commitRoot = async (
    key: "worktree.sessionRoot" | "worktree.subagentRoot",
    label: string,
    currentValue: string,
    raw: string,
    revert: (v: string) => void,
  ) => {
    const normalized = normalizeWorktreeRootInput(raw, platformKey);
    if (normalized === currentValue) {
      setRowErr(key, null);
      revert(currentValue);
      return;
    }
    const validationError = validateWorktreeRoot(normalized, platformKey);
    if (validationError !== null) {
      setRowErr(key, `保存失败：${validationError}，已恢复原值`);
      revert(currentValue);
      return;
    }
    setRowErr(key, null);
    const patchValue = normalized === "" ? null : normalized;
    const patch: SettingsPatch =
      key === "worktree.sessionRoot"
        ? { "worktree.sessionRoot": patchValue }
        : { "worktree.subagentRoot": patchValue };
    const err = await save(key, label, patch, {
      toastText: `已保存 ${label} = ${
        normalized === "" ? "默认" : normalized
      }，只影响之后新建的工作树`,
    });
    if (err !== undefined) {
      revert(currentValue);
    } else {
      await refreshWorktrees();
    }
  };

  const commitKeepCount = async (raw: string) => {
    const trimmed = raw.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (parsed === keepCount) {
      setRowErr("worktree.keepCount", null);
      setKeepDraft(String(keepCount));
      return;
    }
    const validationError = validateWorktreeKeepCount(parsed);
    if (validationError !== null) {
      setRowErr("worktree.keepCount", `保存失败：${validationError}，已恢复原值`);
      setKeepDraft(String(keepCount));
      return;
    }
    setRowErr("worktree.keepCount", null);
    const err = await save(
      "worktree.keepCount",
      "保留的工作树数量",
      {
        "worktree.keepCount": parsed === DEFAULT_WORKTREE_CONFIG.keepCount ? null : parsed,
      },
      { toastText: `已保存 保留的工作树数量 = ${parsed}` },
    );
    if (err !== undefined) {
      setKeepDraft(String(keepCount));
    } else {
      await refreshWorktrees();
    }
  };

  const openDir = async (targetPath: string, errorRowKey?: string) => {
    if (onOpenDirectory === undefined) return;
    if (errorRowKey !== undefined) setRowErr(errorRowKey, null);
    try {
      await onOpenDirectory(targetPath);
    } catch (error) {
      const msg = `无法打开目录：${errText(error)}`;
      if (errorRowKey !== undefined) setRowErr(errorRowKey, msg);
      else setListError(msg);
    }
  };

  const togglePin = async (item: ManagedWorktreeItem) => {
    if (client === undefined) return;
    setBusyId(item.id);
    setListError(null);
    try {
      await client.runtime.setManagedWorktreePinned({ id: item.id, pinned: !item.pinned });
      await refreshWorktrees();
      showToast(`${item.pinned ? "已取消置顶" : "已置顶"} ${item.branch}`);
    } catch (error) {
      setListError(errText(error));
    } finally {
      setBusyId(null);
    }
  };

  const executeDelete = async (
    ids: string[],
    opts: { label?: string | undefined; skipAfter?: boolean | undefined },
  ) => {
    if (client === undefined || ids.length === 0) return;
    setCleaning(true);
    setListError(null);
    try {
      if (opts.skipAfter === true) {
        await save(
          "worktree.askBeforeDelete",
          "删除工作树前询问",
          { "worktree.askBeforeDelete": false },
          { toastText: "已关闭 删除工作树前询问" },
        );
      }
      const result = await client.runtime.deleteManagedWorktrees({ ids });
      await refreshWorktrees();
      const deletedCount = result.deleted.length;
      const skippedCount = result.skipped.length;
      const failedCount = result.failed.length;
      if (failedCount > 0 || skippedCount > 0) {
        const reasons = [...result.skipped, ...result.failed]
          .map((entry) => entry.error ?? entry.status)
          .filter(Boolean);
        setListError(reasons.join("；"));
      }
      if (deletedCount > 0) {
        const snapCount = result.deleted.filter((entry) => entry.snapshot !== undefined).length;
        const suffix =
          (snapCount > 0 ? "，已保存恢复快照" : "") +
          (opts.skipAfter === true ? "，之后不再询问" : "");
        showToast(
          opts.label !== undefined
            ? `已删除 ${opts.label}${suffix}`
            : `已清理 ${deletedCount} 个工作树${suffix}`,
        );
      } else if (skippedCount > 0) {
        showToast(`已跳过 ${skippedCount} 个受保护或无法保存快照的工作树`);
      }
    } catch (error) {
      setListError(errText(error));
    } finally {
      setCleaning(false);
    }
  };

  const requestDelete = (item: ManagedWorktreeItem) => {
    if (item.state === "active") return;
    if (!askBeforeDelete) {
      void executeDelete([item.id], { label: item.branch });
      return;
    }
    setDelTarget(item);
  };

  const restoreSnapshot = async (snapshot: WorktreeRecoverySnapshot) => {
    if (client === undefined) return;
    setRestoringId(snapshot.id);
    setListError(null);
    try {
      const restored = await client.runtime.restoreWorktreeSnapshot({ snapshotId: snapshot.id });
      await refreshWorktrees();
      showToast(`已恢复 ${restored.branch}`);
    } catch (error) {
      setListError(`恢复失败：${errText(error)}`);
    } finally {
      setRestoringId(null);
    }
  };

  const chosenForClean = useMemo(
    () => cleanCandidates.filter((item) => picked.has(item.id)),
    [cleanCandidates, picked],
  );
  const chosenBranchCount = useMemo(
    () => chosenForClean.filter((item) => item.ownsBranch).length,
    [chosenForClean],
  );
  const chosenAheadCommits = useMemo(
    () =>
      chosenForClean.reduce((sum, item) => sum + (item.state === "ahead" ? item.aheadCount : 0), 0),
    [chosenForClean],
  );
  const chosenDirtyCount = useMemo(
    () => chosenForClean.filter((item) => item.dirty).length,
    [chosenForClean],
  );

  const disabled = client === undefined;

  return (
    <>
      <SettingsGroup title="根目录">
        <SettingsRow
          label="新会话"
          labelFor="wt-root-session"
          overrideTitle={settingOverrideTitle(sessionRootItem)}
          error={rowError["worktree.sessionRoot"]}
        >
          {sessionRoot !== "" && (
            <IconButton
              aria-label="恢复默认"
              title="恢复默认"
              disabled={disabled}
              onClick={() => {
                setSessionRootDraft("");
                void commitRoot(
                  "worktree.sessionRoot",
                  "新会话根目录",
                  sessionRoot,
                  "",
                  setSessionRootDraft,
                );
              }}
            >
              {RESET_ICON}
            </IconButton>
          )}
          <input
            id="wt-root-session"
            className="input mono lg-w"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            placeholder={sessionRootPlaceholder}
            value={sessionRootDraft}
            onChange={(event) => {
              setSessionRootDraft(event.target.value);
            }}
            onBlur={() => {
              void commitRoot(
                "worktree.sessionRoot",
                "新会话根目录",
                sessionRoot,
                sessionRootDraft,
                setSessionRootDraft,
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRowErr("worktree.sessionRoot", null);
                setSessionRootDraft(sessionRoot);
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="子代理"
          labelFor="wt-root-subagent"
          overrideTitle={settingOverrideTitle(subagentRootItem)}
          error={rowError["worktree.subagentRoot"]}
        >
          {subagentRoot !== "" && (
            <IconButton
              aria-label="恢复默认"
              title="恢复默认"
              disabled={disabled}
              onClick={() => {
                setSubagentRootDraft("");
                void commitRoot(
                  "worktree.subagentRoot",
                  "子代理根目录",
                  subagentRoot,
                  "",
                  setSubagentRootDraft,
                );
              }}
            >
              {RESET_ICON}
            </IconButton>
          )}
          <input
            id="wt-root-subagent"
            className="input mono lg-w"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            placeholder={desc?.defaultSubagentRoot ?? ""}
            value={subagentRootDraft}
            onChange={(event) => {
              setSubagentRootDraft(event.target.value);
            }}
            onBlur={() => {
              void commitRoot(
                "worktree.subagentRoot",
                "子代理根目录",
                subagentRoot,
                subagentRootDraft,
                setSubagentRootDraft,
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRowErr("worktree.subagentRoot", null);
                setSubagentRootDraft(subagentRoot);
                event.currentTarget.blur();
              }
            }}
          />
          <Button
            size="sm"
            disabled={disabled || (desc?.effectiveSubagentRoot ?? "") === ""}
            onClick={() => {
              const target = desc?.effectiveSubagentRoot ?? "";
              if (target !== "") void openDir(target, "worktree.subagentRoot");
            }}
          >
            打开
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="创建">
        <SettingsRow
          label="创建工作树前始终获取上游更新"
          overrideTitle={settingOverrideTitle(fetchItem)}
          error={rowError["worktree.fetchBeforeCreate"]}
        >
          <Switch
            aria-label="创建工作树前始终获取上游更新"
            checked={fetchBeforeCreate}
            disabled={disabled}
            onChange={(next) => {
              void save(
                "worktree.fetchBeforeCreate",
                "创建工作树前始终获取上游更新",
                { "worktree.fetchBeforeCreate": next ? true : null },
                { toastText: `已${next ? "开启" : "关闭"} 创建工作树前始终获取上游更新` },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="清理">
        <SettingsRow
          label="自动删除旧工作树"
          overrideTitle={settingOverrideTitle(autoDeleteItem)}
          error={rowError["worktree.autoDelete"]}
        >
          <Switch
            aria-label="自动删除旧工作树"
            checked={autoDelete}
            disabled={disabled}
            onChange={(next) => {
              void save(
                "worktree.autoDelete",
                "自动删除旧工作树",
                { "worktree.autoDelete": next ? null : false },
                {
                  toastText: `已${next ? "开启" : "关闭"} 自动删除旧工作树${
                    !next ? "，保留数量暂不生效" : ""
                  }`,
                },
              ).then(() => refreshWorktrees());
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="保留的工作树数量"
          labelFor="wt-keep-count"
          className={!autoDelete ? "off" : undefined}
          overrideTitle={settingOverrideTitle(keepCountItem)}
          warning={
            autoDelete && doomedCount > 0
              ? `超出 ${doomedCount} 个，将先保存恢复快照，再删除最久未用的 ${doomedCount} 个`
              : undefined
          }
          error={rowError["worktree.keepCount"]}
        >
          {keepCount !== DEFAULT_WORKTREE_CONFIG.keepCount && (
            <IconButton
              aria-label="恢复默认"
              title="恢复默认"
              disabled={disabled || !autoDelete}
              onClick={() => {
                setKeepDraft(String(DEFAULT_WORKTREE_CONFIG.keepCount));
                void commitKeepCount(String(DEFAULT_WORKTREE_CONFIG.keepCount));
              }}
            >
              {RESET_ICON}
            </IconButton>
          )}
          <input
            id="wt-keep-count"
            className="input mono sm-w num"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled || !autoDelete}
            value={keepDraft}
            onChange={(event) => {
              setKeepDraft(event.target.value);
            }}
            onBlur={() => {
              void commitKeepCount(keepDraft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRowErr("worktree.keepCount", null);
                setKeepDraft(String(keepCount));
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="删除工作树前询问"
          overrideTitle={settingOverrideTitle(askDeleteItem)}
          error={rowError["worktree.askBeforeDelete"]}
        >
          <Switch
            aria-label="删除工作树前询问"
            checked={askBeforeDelete}
            disabled={disabled}
            onChange={(next) => {
              void save(
                "worktree.askBeforeDelete",
                "删除工作树前询问",
                { "worktree.askBeforeDelete": next ? null : false },
                { toastText: `已${next ? "开启" : "关闭"} 删除工作树前询问` },
              );
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      {listError !== null && (
        <p className="desc err" role="alert">
          {listError}
        </p>
      )}

      {desc !== null && projectGroups.length === 0 ? (
        <div className="empty">没有托管的工作树</div>
      ) : (
        projectGroups.map((group) => (
          <section
            key={group.projectPath}
            className="group"
            aria-label={`${group.projectName} · ${group.items.length}`}
          >
            <div className="ghead wt-group-head">
              <Icon name="folder" size={ICON_MD} />
              <h2>
                {group.projectName}
                <span className="count"> · {group.items.length}</span>
              </h2>
            </div>
            <div className="card">
              {group.items.map((item) => {
                const active = item.state === "active";
                const isDoomed = autoDelete && item.autoDeleteCandidate;
                return (
                  <div
                    key={item.id}
                    className={`wt-row${isDoomed ? " doomed" : ""}`}
                    data-worktree-id={item.id}
                  >
                    <Icon
                      name={item.kind === "subagent" ? "robot" : "chat_1"}
                      size={ICON_MD}
                      className="wt-lead"
                    />
                    <div className="wt-main">
                      <div className="wt-top">
                        <span className="wt-branch" title={item.branch}>
                          {item.branch}
                        </span>
                        {worktreeStateBadge(item)}
                        {isDoomed && <Badge>将自动删除</Badge>}
                      </div>
                      <span className="wt-src" title={item.sourceTitle}>
                        {item.sourceTitle}
                        <span className="age"> · {formatRelativeAge(item.lastUsedAt)}</span>
                      </span>
                      <span className="wt-path" title={item.path}>
                        {item.path}
                      </span>
                    </div>
                    <div className="wt-acts">
                      <IconButton
                        aria-pressed={item.pinned}
                        aria-label={item.pinned ? "取消置顶" : "置顶"}
                        title={item.pinned ? "取消置顶" : "置顶，自动清理时保留"}
                        disabled={busyId === item.id || cleaning}
                        onClick={() => {
                          void togglePin(item);
                        }}
                      >
                        <Icon name="pin" size={ICON_MD} />
                      </IconButton>
                      <Button
                        size="sm"
                        onClick={() => {
                          void openDir(item.path);
                        }}
                      >
                        打开目录
                      </Button>
                      <Button
                        size="sm"
                        disabled={!item.sourceExists || onOpenSession === undefined}
                        title={item.sourceExists ? undefined : "来源会话已不存在"}
                        onClick={() => {
                          onOpenSession?.(item.sourceSessionId, item.projectPath);
                        }}
                      >
                        回到会话
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={active || busyId === item.id || cleaning}
                        title={active ? "使用中，不能删除" : undefined}
                        onClick={() => {
                          requestDelete(item);
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {snapshots.length > 0 && (
        <SettingsGroup title="恢复快照" count={snapshots.length}>
          {snapshots.map((snap) => (
            <div key={snap.id} className="wt-row" data-snapshot-id={snap.id}>
              <Icon
                name={snap.kind === "subagent" ? "robot" : "chat_1"}
                size={ICON_MD}
                className="wt-lead"
              />
              <div className="wt-main">
                <div className="wt-top">
                  <span className="wt-branch" title={snap.branch}>
                    {snap.branch}
                  </span>
                  {snap.aheadCount > 0 && (
                    <Badge variant="warn">{snap.aheadCount} 个独有提交</Badge>
                  )}
                  {snap.dirty && <Badge variant="warn">含本地改动</Badge>}
                </div>
                <span className="wt-src" title={snap.projectName}>
                  {snap.projectName}
                  <span className="age">
                    {" "}
                    · {formatRelativeAge(Date.parse(snap.createdAt) || Date.now())}
                  </span>
                </span>
                <span className="wt-path" title={snap.originalPath}>
                  {snap.originalPath}
                </span>
              </div>
              <div className="wt-acts">
                <Button
                  size="sm"
                  onClick={() => {
                    void openDir(snap.snapshotDir);
                  }}
                >
                  打开目录
                </Button>
                <Button
                  size="sm"
                  disabled={restoringId === snap.id}
                  onClick={() => {
                    void restoreSnapshot(snap);
                  }}
                >
                  {restoringId === snap.id ? "恢复中…" : "恢复"}
                </Button>
              </div>
            </div>
          ))}
        </SettingsGroup>
      )}

      {cleanOpen && (
        <Scrim onClose={onCloseClean}>
          <div
            className="dlg clean-dlg"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wt-clean-title"
          >
            <div className="dh3">
              <b id="wt-clean-title">清理工作树</b>
            </div>
            <div className="db">
              {cleanGroups.map((group) => (
                <div key={group.projectPath} className="cl-group">
                  <div className="cl-proj">
                    <Icon name="folder" size={ICON_SM} />
                    {group.projectName}
                  </div>
                  {group.items.map((item) => (
                    <Checkbox
                      key={item.id}
                      className="cl-item"
                      checked={picked.has(item.id)}
                      onChange={(checked) => {
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                    >
                      <span className="cl-text">
                        <span className="wt-top">
                          <span className="wt-branch">{item.branch}</span>
                          {worktreeStateBadge(item)}
                          {item.pinned && <Badge>已置顶</Badge>}
                        </span>
                        <span className="wt-path" title={item.path}>
                          {item.path}
                        </span>
                      </span>
                    </Checkbox>
                  ))}
                </div>
              ))}
            </div>
            <div className="df">
              <span className="cl-sum">
                {chosenForClean.length > 0 && (
                  <>
                    将移除 {chosenForClean.length} 个目录
                    {chosenBranchCount > 0 ? `和 ${chosenBranchCount} 个分支` : ""}
                    {chosenAheadCommits > 0 ? (
                      <span className="warnt">{chosenAheadCommits} 个独有提交会先保存恢复快照</span>
                    ) : chosenDirtyCount > 0 ? (
                      <span className="warnt">未提交改动会先保存恢复快照</span>
                    ) : null}
                  </>
                )}
              </span>
              <span className="sp" />
              <Button ref={cleanCancelRef} onClick={onCloseClean} disabled={cleaning}>
                取消
              </Button>
              <Button
                variant="danger-solid"
                disabled={chosenForClean.length === 0 || cleaning}
                onClick={() => {
                  const ids = [...picked];
                  onCloseClean();
                  void executeDelete(ids, {});
                }}
              >
                {chosenForClean.length === 0 ? "清理" : `清理 ${chosenForClean.length} 个`}
              </Button>
            </div>
          </div>
        </Scrim>
      )}

      {delTarget !== null && (
        <Scrim
          onClose={() => {
            setDelTarget(null);
          }}
        >
          <div
            className="dlg narrow del-dlg"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="wt-del-title"
            aria-describedby="wt-del-body"
          >
            <div className="dh3">
              <b id="wt-del-title">删除工作树？</b>
            </div>
            <div className="db" id="wt-del-body">
              <div className="del-what">
                <span className="wt-top">
                  <span className="wt-branch">{delTarget.branch}</span>
                  {worktreeStateBadge(delTarget)}
                </span>
                <span className="wt-path" title={delTarget.path}>
                  {delTarget.path}
                </span>
              </div>
              {delTarget.state === "ahead" && delTarget.aheadCount > 0 ? (
                <div className="del-note warnt">
                  将移除目录{delTarget.ownsBranch ? "和分支" : ""}，{delTarget.aheadCount}{" "}
                  个独有提交会先保存恢复快照
                </div>
              ) : delTarget.dirty ? (
                <div className="del-note warnt">
                  将移除目录{delTarget.ownsBranch ? "和分支" : ""}，未提交改动会先保存恢复快照
                </div>
              ) : (
                <div className="del-note">将移除目录{delTarget.ownsBranch ? "和分支" : ""}</div>
              )}
              <Checkbox className="del-skip" checked={skipAsk} onChange={setSkipAsk}>
                不再询问
              </Checkbox>
            </div>
            <div className="df">
              <span className="sp" />
              <Button
                ref={delCancelRef}
                disabled={cleaning}
                onClick={() => {
                  setDelTarget(null);
                }}
              >
                取消
              </Button>
              <Button
                variant="danger-solid"
                disabled={cleaning}
                onClick={() => {
                  const target = delTarget;
                  const skip = skipAsk;
                  setDelTarget(null);
                  void executeDelete([target.id], { label: target.branch, skipAfter: skip });
                }}
              >
                删除
              </Button>
            </div>
          </div>
        </Scrim>
      )}
    </>
  );
}
