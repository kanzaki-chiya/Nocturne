import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  parseFileRefs,
  parseWorkModeSlash,
  type ImageMimeType,
  type ExternalAgentOverview,
  type McpServerViewState,
  type PendingInputsSnapshot,
  type SkillOverview,
  type SkillInvocation,
  type TodoItem,
  type GoalState,
  type WorkModeName,
  type WorkspaceBranch,
} from "@nocturne/core/protocol";

import { isValidGitBranchName, useBranchMenu } from "./BranchMenu";
import { completeSlash, parseSlash, type SlashGroup } from "./commands";
import { searchInputHistory, splitHighlightSegments, type MatchRange } from "./history-search";
import {
  completeFileRefs,
  fileRefDeleteRange,
  fileRefToken,
  type FileIndexEntry,
  type FileRefCandidate,
} from "./file-refs";
import { BrandIcon } from "./BrandIcon";
import { ChoiceMenu, Menu, MenuHeading, MenuItem, MenuSeparator, MenuSubmenu } from "./Menu";
import { IMAGE_TYPES, mimeTypeForImageName, type PickedImage } from "./picked-images";
import "./composer.css";
import { PendingInputs } from "./PendingInputs";
import type { PrefsStore } from "./prefs";
import { TodoPanel } from "./TodoList";
import type { GoalActions } from "./GoalRow";
import { ICON_MD, ICON_SM, Icon, IconButton } from "./ui";
import { InputLabel, InputLabelIcon, useDraftSkillAnchor, useSkillBackspace } from "./InputLabel";
import {
  draftLabel,
  insertSkillCommand,
  invocableSkills,
  PLUGIN_ICON,
  SKILL_ICON,
  skillLabel,
  WORK_MODE_ITEMS,
  type InputLabelData,
} from "./input-labels";
import { ImageViewerBoundary, useImageViewer, type ViewerImageItem } from "./ImageViewer";
import { fileIconText, formatBytes } from "./web/phone-images";

export interface ChoiceOption {
  value: string;
  label: string;
  detail?: string;
  /** 悬停说明（如模型菜单里的原始模型 id） */
  title?: string;
  /** 选项图标键（纯字符串，由渲染层解析为品牌或通用图标） */
  icon?: string;
  /** 自绘下拉（Dropdown）里的中文名与危险标记；中文名统一来自 choice-info.ts */
  tag?: string;
  risk?: boolean;
  /** 禁用原因（menu item 的 title） */
  disabled?: string;
}

export interface ChoiceGroup {
  label?: string;
  options: ChoiceOption[];
}

export interface ChoiceControl {
  value: string | undefined;
  /** 芯片上的短标签 */
  label: string;
  /** 芯片上的图标键（如模型芯片的品牌/通用图标） */
  icon?: string;
  /** 菜单顶部标题 */
  heading?: string;
  groups: ChoiceGroup[];
  /** 整个控件禁用的原因 */
  disabled?: string;
  /** 菜单底部说明 */
  note?: string;
  onSelect: (value: string) => void | Promise<void>;
}

export interface ComposerControls {
  model: ChoiceControl;
  effort: ChoiceControl;
  preset: ChoiceControl;
  error?: string;
}

export interface DraftBranchChoice {
  current: string | null;
  branches: WorkspaceBranch[];
  selected?: { name: string; create?: boolean } | undefined;
  canCreate: boolean;
  onSelect: (branch: string, create: boolean) => void;
  onOpen?: () => void;
}

export interface WorkspaceChoice {
  label: string;
  kind: "plain" | "project";
  title?: string;
  /** 会话内目录不可切换（无菜单、无 ▾） */
  readOnly: boolean;
  /** 当前目录的项目 key；普通对话为 null */
  currentKey: string | null;
  projects: { key: string; path: string; name: string }[];
  onSelectPlain: () => void;
  onSelectProject: (path: string) => void;
  onOpenOther: () => void;
}

export interface FileRefSource {
  load: () => Promise<FileIndexEntry[]>;
  /** 变化时丢弃已缓存的索引并重新拉取（如 Turn 数） */
  key: string | number;
}

export interface ComposerSubmit {
  text: string;
  skill?: SkillInvocation;
  delegate?: { agent: string; task: string };
  /** 执行方式（ADR-0076）；此时 text 是去掉命令名后的任务 */
  workMode?: WorkModeName;
  /**
   * 输入框原文。执行方式会把 text 改成去掉命令名的任务，拒收放回草稿时用这个。
   * 与 text 相同时可以不传。
   */
  draftText?: string;
  attachments: { data: Uint8Array; mimeType: string; label: string; source?: "paste" | "upload" }[];
}

export interface ComposerProps {
  hidden?: boolean;
  todos?: readonly TodoItem[];
  goal?: GoalState | undefined;
  goalActions?: GoalActions | undefined;
  onGoalError?: (error: unknown) => void;
  prefs?: PrefsStore;
  skills?: readonly SkillOverview[];
  externalAgents?: readonly ExternalAgentOverview[];
  running: boolean;
  disabled?: boolean;
  /**
   * 调用前输入框已经清空。resolve true 表示已接受；false 或抛错表示未接受，
   * 输入框把这次的文字和附件放回去（期间用户又输入过则不覆盖）。
   * mode：Turn 运行中提交时为 steer（插话）或 queue（排队），空闲时为 undefined。
   */
  onSubmit: (input: ComposerSubmit, mode?: "steer" | "queue") => boolean | Promise<boolean>;
  onInterrupt: () => void | Promise<void>;
  /** 待发输入快照（ADR-0070）；默认空列表 */
  pendingInputs?: PendingInputsSnapshot | undefined;
  /** 编辑/切换插话排队 */
  onUpdatePending?:
    ((id: string, patch: { mode?: "steer" | "queue"; text?: string }) => Promise<void>) | undefined;
  /** 撤回一条待发输入 */
  onCancelPending?: ((id: string) => Promise<void>) | undefined;
  /** 解除暂停：「继续发送」 */
  onResumePending?: (() => Promise<void>) | undefined;
  /**
   * draft（空状态）：卡片底部工具行含工作区/预设/分支，上方 hero。
   * session：同一卡片，工具行含权限预设、上下文圆环、模型、思考档位与发送/中断。
   */
  variant?: "draft" | "session";
  historyKey?: string | null;
  /** 挂载时填入的文字（分叉后的原消息，或新会话拒收后放回的草稿），光标放在末尾 */
  initialDraft?: string | undefined;
  /** 挂载时放回的附件（新会话拒收）。只在首次挂载取用 */
  initialAttachments?: ComposerSubmit["attachments"] | undefined;
  /** 挂载时恢复的执行方式（新会话/重建输入框拒收）。只在首次挂载取用 */
  initialWorkMode?: WorkModeName | undefined;
  /** 挂载时显示的发送失败 */
  initialError?: string | undefined;
  onInitialDraftUsed?: (() => void) | undefined;
  /** 外部预填草稿（如插件「立即试用」）：无错误提示，填入后光标置于末尾并聚焦 */
  prefillDraft?: { text: string; seq: number; append?: boolean | undefined } | null | undefined;
  onPrefillDraftUsed?: (() => void) | undefined;
  readInputHistory?: () => Promise<string[]>;
  /** 父层从当前会话引用记录，因而首次输入创建会话后也能写入历史。 */
  recordInputHistory?: (text: string) => Promise<void>;
  /** draft 与 session 共用：模型、思考档位、权限预设选择 */
  controls?: ComposerControls | undefined;
  /** 权限预设菜单底部附加内容（如本会话已允许的授权列表） */
  presetFooter?: ReactNode;
  contextUsage?: ReactNode;
  /** 会话 MCP 服务状态（用于在「+」按钮和 MCP 子菜单显示可用性圆点） */
  mcpServers?: Readonly<Record<string, McpServerViewState>> | undefined;
  /** 被禁用的执行方式（值即悬停说明原因） */
  workModeDisabled?: Partial<Record<WorkModeName, string>> | undefined;
  /** draft 必需；session 变体忽略 */
  workspace?: WorkspaceChoice | undefined;
  /** 新会话页分支选择（ADR-0085） */
  branch?: DraftBranchChoice | undefined;
  /** null 表示本目录无项目文件索引（普通对话、或尚未建会话） */
  fileRefs: FileRefSource | null;
  /** 首张图片加入时调用一次；显示在卡片上方气泡 */
  getVisionHint?: () => Promise<string | undefined>;
  pickImages: () => Promise<PickedImage[]>;
  /** 关闭附件按钮及粘贴 / 拖入文件（如组曲线程标签只支持纯文本）；默认开启 */
  allowAttachments?: boolean | undefined;
  dirMenuOpen?: boolean;
  onDirMenuOpenChange?: (open: boolean) => void;
  /** 处理 /compact、/mcp；false 时草稿保留 */
  onSlash: (line: string) => boolean | Promise<boolean>;
  /** 模型菜单底部「管理服务商…」（进入设置 › 服务商）；不传则不显示 */
  onManageProviders?: () => void;
  /** 「+」->「MCP」子菜单底部「管理 MCP」（进入设置 › MCP） */
  onManageMcp?: () => void;
  /** 「+」->「技能」子菜单底部「管理技能」（进入设置 › 技能） */
  onManageSkills?: () => void;
  onManagePlugins?: (() => void) | undefined;
  placeholder?: string;
}

interface Attachment {
  name: string;
  data: Uint8Array;
  mimeType: string;
  url: string;
  source?: "paste" | "upload";
}

function materializeAttachment(attachment: ComposerSubmit["attachments"][number]): Attachment {
  return {
    name: attachment.label,
    data: attachment.data,
    mimeType: attachment.mimeType,
    url: URL.createObjectURL(
      new Blob([attachment.data as BlobPart], { type: attachment.mimeType }),
    ),
    ...(attachment.source ? { source: attachment.source } : {}),
  };
}

type MenuKind = "plus" | "model" | "effort" | "preset" | "dir" | "branch";
type PopupKind = "slash" | "refs" | "history";

const MAX_TEXTAREA_HEIGHT = 280;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendHistory(history: readonly string[], text: string): string[] {
  return history.at(-1) === text ? [...history] : [...history.slice(-999), text];
}

interface PopupRow {
  decoration?: InputLabelData | undefined;
  argumentHint?: string | undefined;
  source?: string | undefined;
  key: string;
  label: string;
  summary?: string;
  insert: string;
  directory?: boolean;
  ranges?: MatchRange[];
}

export function Composer({
  hidden = false,
  running,
  disabled = false,
  onSubmit,
  onInterrupt,
  pendingInputs,
  onUpdatePending,
  onCancelPending,
  onResumePending,
  variant = "draft",
  historyKey,
  initialDraft,
  initialAttachments,
  initialWorkMode,
  initialError,
  onInitialDraftUsed,
  prefillDraft,
  onPrefillDraftUsed,
  readInputHistory,
  recordInputHistory,
  controls,
  presetFooter,
  contextUsage,
  mcpServers,
  workModeDisabled,
  workspace,
  branch,
  fileRefs,
  getVisionHint,
  pickImages,
  allowAttachments = true,
  dirMenuOpen,
  onDirMenuOpenChange,
  onSlash,
  onManageProviders,
  onManageMcp,
  onManageSkills,
  onManagePlugins,
  placeholder,
  skills = [],
  externalAgents = [],
  todos = [],
  goal,
  goalActions,
  onGoalError,
  prefs,
}: ComposerProps) {
  const isSession = variant === "session";
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [showTypedWorkMode, setShowTypedWorkMode] = useState(false);
  const [workMode, setWorkMode] = useState<WorkModeName | null>(initialWorkMode ?? null);
  const [skillQuery, setSkillQuery] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    (initialAttachments ?? []).map(materializeAttachment),
  );
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [selected, setSelected] = useState(0);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [enterHint, setEnterHint] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (hidden) {
      setMenu(null);
      setDismissed(true);
      setHistoryOpen(false);
    } else if (wasHidden.current) {
      textarea.current?.focus();
    }
    wasHidden.current = hidden;
  }, [hidden]);
  const [dragOver, setDragOver] = useState(false);
  const [vision, setVision] = useState<string | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<MenuKind, HTMLButtonElement | null>>>({});
  const composingRef = useRef(false);
  const interruptingRef = useRef(false);
  const draftRef = useRef(draft);
  const draftPresentation = draftLabel(draft, skills, showTypedWorkMode);
  const lastPresentation = useRef(draftPresentation);
  if (!composing) lastPresentation.current = draftPresentation;
  const {
    prefix,
    skill: draftSkill,
    workMode: typedMode,
  } = composing ? lastPresentation.current : draftPresentation;
  const offset = prefix.length;
  const visibleDraft = draft.slice(offset);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const skillAnchor = useDraftSkillAnchor(textarea, draftSkill);
  const workModeRef = useRef<WorkModeName | null>(workMode);
  workModeRef.current = workMode;
  const attachmentsRef = useRef<Attachment[]>([]);
  const revision = useRef(0);
  const pendingCaret = useRef<number | null>(null);
  const mounted = useRef(true);
  const readHistoryRef = useRef(readInputHistory);
  readHistoryRef.current = readInputHistory;
  const fileRefsRef = useRef(fileRefs);
  fileRefsRef.current = fileRefs;
  const indexCache = useRef<{
    key: string | number;
    entries: FileIndexEntry[];
    failed?: boolean;
  } | null>(null);
  const indexLoading = useRef<string | number | null>(null);
  const [, bumpIndex] = useState(0);
  const id = useId();
  const listId = `${id}-popup`;

  attachmentsRef.current = attachments;
  const dirControlled = dirMenuOpen !== undefined;
  const dirOpen = dirMenuOpen ?? menu === "dir";
  // 受控时 dir 开合以 prop 为准；打开其他菜单会顺带把受控的目录菜单关掉
  const openMenu: MenuKind | null =
    menu !== null && menu !== "dir"
      ? menu
      : dirControlled
        ? dirMenuOpen || menu === "dir"
          ? "dir"
          : null
        : menu;
  const requestDirOpen = useCallback(
    (open: boolean) => {
      setMenu(open ? "dir" : null);
      onDirMenuOpenChange?.(open);
    },
    [onDirMenuOpenChange],
  );
  const setMenuExclusive = useCallback(
    (kind: MenuKind | null) => {
      setMenu(kind);
      if (dirControlled && kind !== "dir") onDirMenuOpenChange?.(false);
    },
    [dirControlled, onDirMenuOpenChange],
  );
  const closeMenu = useCallback(() => {
    if (openMenu === "dir") requestDirOpen(false);
    else setMenu(null);
  }, [openMenu, requestDirOpen]);
  useEffect(() => {
    if (openMenu !== "plus") setSkillQuery("");
  }, [openMenu]);
  const branchIsGit = branch?.current != null;
  const branchControl = useBranchMenu({
    label: branch?.selected?.name ?? branch?.current ?? "-",
    branches: branch?.branches ?? [],
    checked:
      branch?.selected?.create === true
        ? undefined
        : (branch?.selected?.name ?? branch?.current ?? undefined),
    open: branchIsGit && openMenu === "branch",
    onOpen: () => {
      setMenuExclusive("branch");
      branch?.onOpen?.();
    },
    onClose: closeMenu,
    onChoose: (name, create) => {
      branch?.onSelect(name, create);
      closeMenu();
      return true;
    },
    triggerClassName: `chip chip-branch${openMenu === "branch" ? " on" : ""}`,
    hasMenu: branchIsGit,
    disabled: !branchIsGit || disabled,
    occupiedSelectable: true,
    canCreate: (name) => branch?.canCreate === true && isValidGitBranchName(name),
    align: "left",
    placement: "below",
    caret: branchIsGit,
    ariaLabel: "选择分支",
  });
  const branchMenu = branch === undefined ? undefined : branchControl;

  // ── 文件索引：首次用到时拉取，fileRefs.key 变化时失效 ──
  const ensureFileIndex = useCallback(() => {
    const source = fileRefsRef.current;
    if (source === null) return;
    if (indexCache.current?.key === source.key || indexLoading.current === source.key) return;
    indexLoading.current = source.key;
    const key = source.key;
    source
      .load()
      .then(
        (entries) => {
          indexCache.current = { key, entries };
        },
        () => {
          indexCache.current = { key, entries: [], failed: true };
        },
      )
      .finally(() => {
        if (indexLoading.current === key) indexLoading.current = null;
        bumpIndex((v) => v + 1);
      });
  }, []);

  // ── 输入历史 ──
  const history = useRef<string[]>([]);
  const historySinceRead = useRef<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const historyDraft = useRef("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const initialDraftUsed = useRef(
    initialDraft === undefined &&
      initialAttachments === undefined &&
      initialWorkMode === undefined &&
      initialError === undefined
      ? undefined
      : onInitialDraftUsed,
  );
  useEffect(() => {
    const text = draftRef.current;
    if (text !== "") {
      const field = textarea.current;
      field?.focus();
      field?.setSelectionRange(text.length - offsetRef.current, text.length - offsetRef.current);
      setCaret(text.length);
    }
    initialDraftUsed.current?.();
  }, []);
  const appliedPrefillSeq = useRef<number | null>(null);
  const onPrefillDraftUsedRef = useRef(onPrefillDraftUsed);
  onPrefillDraftUsedRef.current = onPrefillDraftUsed;
  useEffect(() => {
    if (prefillDraft == null || appliedPrefillSeq.current === prefillDraft.seq) return;
    appliedPrefillSeq.current = prefillDraft.seq;
    setShowTypedWorkMode(false);
    const prev = draftRef.current;
    const text =
      prefillDraft.append === true && prev !== ""
        ? `${prev}${/\s$/.test(prev) ? "" : "\n"}${prefillDraft.text}`
        : prefillDraft.text;
    const pos = text.length;
    pendingCaret.current = pos;
    revision.current += 1;
    draftRef.current = text;
    setDraft(text);
    setSelected(0);
    setDismissed(false);
    setError(null);
    setEnterHint(null);
    historyIndex.current = null;
    setCaret(pos);
    const focusField = () => {
      const field = textarea.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(pos - offsetRef.current, pos - offsetRef.current);
    };
    focusField();
    const raf =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(focusField) : undefined;
    onPrefillDraftUsedRef.current?.();
    return () => {
      if (raf !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf);
      }
    };
  }, [prefillDraft]);
  useEffect(() => {
    let active = true;
    history.current = [];
    historySinceRead.current = [];
    historyIndex.current = null;
    setHistoryOpen(false);
    setHistoryVersion((v) => v + 1);
    const readHistory = readHistoryRef.current;
    if (readHistory !== undefined) {
      void readHistory()
        .then((rows) => {
          if (!active) return;
          history.current = historySinceRead.current.reduce(appendHistory, rows.slice(-1000));
          setHistoryVersion((v) => v + 1);
        })
        .catch((reason: unknown) => {
          if (active) setError(`读取输入历史失败：${errorText(reason)}`);
        });
    }
    return () => {
      active = false;
    };
  }, [historyKey]);

  const updateDraft = (text: string, fromHistory = false) => {
    revision.current += 1;
    draftRef.current = text;
    setDraft(text);
    setSelected(0);
    setDismissed(false);
    setError(null);
    setEnterHint(null);
    if (!fromHistory) historyIndex.current = null;
  };

  const updateWorkMode = (next: WorkModeName | null) => {
    revision.current += 1;
    workModeRef.current = next;
    setWorkMode(next);
    setError(null);
    setEnterHint(null);
  };

  const interrupt = useCallback(async () => {
    if (!running || interruptingRef.current) return;
    interruptingRef.current = true;
    setInterrupting(true);
    setError(null);
    try {
      await onInterrupt();
    } catch (reason) {
      if (mounted.current) setError(`中断失败：${errorText(reason)}`);
    } finally {
      interruptingRef.current = false;
      if (mounted.current) setInterrupting(false);
    }
  }, [running, onInterrupt]);

  // ── 弹窗与补全 ──
  const showHistoryPopup = historyOpen && !composing;
  const token = focused && !composing && !showHistoryPopup ? fileRefToken(draft, caret) : undefined;
  const refCompletion =
    token !== undefined && fileRefs !== null && !dismissed
      ? completeFileRefs(draft, caret, indexCache.current?.entries ?? [])
      : undefined;
  const showRefPopup =
    token !== undefined && fileRefs !== null && !dismissed && refCompletion !== undefined;
  const slashGroups = useMemo<SlashGroup[]>(
    () =>
      focused && !composing && !dismissed && !showHistoryPopup && token === undefined
        ? completeSlash(draft, skills, externalAgents)
        : [],
    [focused, composing, dismissed, showHistoryPopup, token, draft, skills, externalAgents],
  );
  const historyRows: PopupRow[] = useMemo(() => {
    if (!showHistoryPopup || historyVersion < 0) return [];
    return searchInputHistory(history.current, draft).map((item) => ({
      key: item.text,
      label: item.label,
      insert: item.text,
      ranges: item.ranges,
    }));
  }, [showHistoryPopup, historyVersion, draft]);
  const popup: PopupKind | null = showHistoryPopup
    ? "history"
    : showRefPopup
      ? "refs"
      : slashGroups.length > 0
        ? "slash"
        : null;

  const refRows: PopupRow[] =
    popup === "refs" && refCompletion !== undefined
      ? refCompletion.candidates.map((candidate: FileRefCandidate) => ({
          key: candidate.path,
          label: candidate.path,
          insert: candidate.insert,
          directory: candidate.directory,
        }))
      : [];
  const slashRows: { group: SlashGroup; row: PopupRow }[] = useMemo(() => {
    if (popup !== "slash") return [];
    return slashGroups.flatMap((group) =>
      group.items.map((item) => ({
        group,
        row: {
          key: `${group.id}:${item.insert}`,
          label: item.label,
          summary: item.summary,
          argumentHint: item.argumentHint,
          source: group.id === "plugins" ? undefined : item.source,
          decoration: item.decoration,
          insert: item.insert,
        },
      })),
    );
  }, [popup, slashGroups]);
  const flatRows: PopupRow[] =
    popup === "history"
      ? historyRows
      : popup === "refs"
        ? refRows
        : slashRows.map((item) => item.row);
  const activeIndex = Math.min(selected, Math.max(0, flatRows.length - 1));
  const indexLoadingNow = showRefPopup && indexCache.current?.key !== fileRefs.key;

  useEffect(() => {
    if (showRefPopup) ensureFileIndex();
  }, [showRefPopup, ensureFileIndex]);

  const fillHistoryDraft = (text: string, fromHistory: boolean) => {
    const nextOffset = draftLabel(text, skills, false).prefix.length;
    setShowTypedWorkMode(false);
    if (text === draftRef.current && nextOffset === offsetRef.current) {
      pendingCaret.current = null;
      const localPos = text.length - nextOffset;
      textarea.current?.setSelectionRange(localPos, localPos);
      setCaret(text.length);
    } else {
      pendingCaret.current = text.length;
    }
    updateDraft(text, fromHistory);
  };

  const chooseRow = (row: PopupRow) => {
    if (popup === "history") {
      setHistoryOpen(false);
      fillHistoryDraft(row.insert, false);
      setDismissed(true);
      textarea.current?.focus();
      return;
    }
    if (popup === "refs") {
      const completion = completeFileRefs(
        draftRef.current,
        caret,
        indexCache.current?.entries ?? [],
      );
      if (completion !== undefined) {
        const text = draftRef.current;
        const next = text.slice(0, completion.start) + row.insert + text.slice(completion.end);
        pendingCaret.current = completion.start + row.insert.length;
        updateDraft(next);
      }
      textarea.current?.focus();
      return;
    }
    pendingCaret.current = row.insert.length;
    updateDraft(row.insert);
    setDismissed(true);
    textarea.current?.focus();
  };

  const insertSkillToken = (name: string) => {
    const next = insertSkillCommand(draftRef.current, name, skills);
    pendingCaret.current = name.length + 2;
    updateDraft(next);
    textarea.current?.focus();
  };

  // ── 附件 ──
  const addImages = useCallback(
    (
      files: { name: string; data: Uint8Array; mimeType?: string; source?: "paste" | "upload" }[],
    ) => {
      const added: Attachment[] = [];
      for (const file of files) {
        const mimeType =
          (file.mimeType === "" ? undefined : file.mimeType) ??
          mimeTypeForImageName(file.name) ??
          "application/octet-stream";
        added.push({
          name: file.name,
          ...(file.source ? { source: file.source } : {}),
          data: file.data,
          mimeType,
          url: URL.createObjectURL(new Blob([file.data as BlobPart], { type: mimeType })),
        });
      }
      if (added.length > 0) setAttachments((current) => [...current, ...added]);
    },
    [],
  );

  const removeAttachment = (index: number) => {
    setAttachments((current) => {
      const removed = current[index];
      if (removed !== undefined) URL.revokeObjectURL(removed.url);
      return current.filter((_, i) => i !== index);
    });
  };

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
    },
    [],
  );

  useEffect(() => {
    if (attachments.length === 0) {
      setVision(undefined);
      return;
    }
    if (vision !== undefined || getVisionHint === undefined) return;
    let cancelled = false;
    void getVisionHint().then(
      (hint) => {
        if (!cancelled) setVision(hint);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [attachments.length, getVisionHint, vision]);

  const openPicker = () => {
    closeMenu();
    void pickImages().then(
      (picked) => {
        if (picked.length > 0) addImages(picked.map((image) => ({ ...image })));
      },
      (reason: unknown) => {
        setError(errorText(reason));
      },
    );
  };

  // ── 发送 / 命令 ──
  const submit = (mode?: "steer" | "queue") => {
    const text = draftRef.current;
    // Turn 运行中也允许发送（ADR-0070）：mode 由 Enter / Alt+Enter 决定
    if (disabled || composingRef.current) return;
    const selectedMode = workModeRef.current;
    if (text.trim() === "") {
      if (selectedMode !== null) {
        const usage = parseWorkModeSlash(`/${selectedMode}`);
        setEnterHint(usage?.kind === "usage" ? usage.hint : `用法：/${selectedMode} 任务`);
        return;
      }
      if (attachmentsRef.current.length === 0) return;
    }
    const parsed = parseSlash(text, variant, skills, externalAgents);
    if (parsed?.kind === "unknown" || parsed?.kind === "redirect") {
      setEnterHint(parsed.hint);
      return;
    }
    if (parsed?.kind === "command") {
      void runSlash(text);
      return;
    }
    const workModeFromTag = parsed === null && selectedMode !== null;
    const effectiveWorkMode =
      parsed?.kind === "work" ? parsed.workMode : workModeFromTag ? selectedMode : undefined;
    const task = parsed?.kind === "work" ? parsed.text : text;
    const snapshot = attachmentsRef.current.slice();
    const payload: ComposerSubmit = {
      text: task,
      ...(task !== text ? { draftText: text } : {}),
      ...(effectiveWorkMode !== undefined ? { workMode: effectiveWorkMode } : {}),
      ...(parsed?.kind === "skill" ? { skill: parsed.invocation } : {}),
      ...(parsed?.kind === "agent" ? { delegate: parsed.delegate } : {}),
      attachments: snapshot.map((attachment) => ({
        data: attachment.data,
        mimeType: attachment.mimeType,
        label: attachment.name,
        ...(attachment.source ? { source: attachment.source } : {}),
      })),
    };
    // 同一轮事件里清空。不等 Core 接受；拒收再放回。连发时第二次读到的是空草稿。
    historyIndex.current = null;
    updateDraft("");
    if (workModeFromTag) updateWorkMode(null);
    attachmentsRef.current = [];
    setAttachments([]);
    const clearedRevision = revision.current;
    const expectedWorkMode = workModeFromTag ? null : selectedMode;
    const untouched = () =>
      mounted.current &&
      revision.current === clearedRevision &&
      workModeRef.current === expectedWorkMode &&
      attachmentsRef.current.length === 0;
    const dropSnapshot = () => {
      for (const attachment of snapshot) URL.revokeObjectURL(attachment.url);
    };
    const restore = () => {
      if (!untouched()) {
        dropSnapshot();
        return;
      }
      attachmentsRef.current = snapshot;
      setAttachments(snapshot);
      updateDraft(text);
      if (workModeFromTag) updateWorkMode(selectedMode);
    };
    void (async () => {
      try {
        const accepted =
          mode === undefined ? await onSubmit(payload) : await onSubmit(payload, mode);
        if (!accepted) {
          restore();
          return;
        }
        dropSnapshot();
        if (text !== "" && recordInputHistory !== undefined) {
          try {
            await recordInputHistory(text);
          } catch (reason) {
            if (mounted.current) setError(`消息已接收，但保存输入历史失败：${errorText(reason)}`);
          }
        }
        if (text !== "") {
          history.current = appendHistory(history.current, text);
          historySinceRead.current = appendHistory(historySinceRead.current, text);
          setHistoryVersion((v) => v + 1);
        }
      } catch (reason) {
        restore();
        if (mounted.current) setError(`发送失败：${errorText(reason)}`);
      }
    })();
  };

  const runSlash = async (line: string) => {
    setError(null);
    try {
      const accepted = await onSlash(line);
      if (!accepted) return;
      if (mounted.current) updateDraft("");
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    }
  };

  const navigateHistory = (
    direction: "up" | "down",
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const field = event.currentTarget;
    if (
      field.selectionStart !== field.selectionEnd ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const position = field.selectionStart + offset;
    if (direction === "up" && draft.slice(0, position).includes("\n")) return;
    if (direction === "down" && draft.slice(position).includes("\n")) return;
    if (history.current.length === 0) return;
    if (direction === "up") {
      if (historyIndex.current === null) {
        historyDraft.current = draftRef.current;
        historyIndex.current = history.current.length - 1;
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1);
      }
      event.preventDefault();
      const next = history.current[historyIndex.current] ?? "";
      fillHistoryDraft(next, true);
    } else if (historyIndex.current !== null) {
      event.preventDefault();
      const next = historyIndex.current + 1;
      historyIndex.current = next < history.current.length ? next : null;
      const nextText =
        historyIndex.current === null ? historyDraft.current : (history.current[next] ?? "");
      fillHistoryDraft(nextText, true);
    }
  };

  const removeSkill = () => {
    pendingCaret.current = 0;
    setCaret(0);
    updateDraft(draftRef.current.slice(offset));
  };
  useSkillBackspace(textarea, draftSkill !== undefined, (event) => {
    if (composingRef.current) return;
    event.preventDefault();
    removeSkill();
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    literalPaste.current =
      (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v";
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 旧 IME 用 keyCode 229 标记组合中
    if (event.nativeEvent.isComposing || composingRef.current || event.nativeEvent.keyCode === 229)
      return;
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "r"
    ) {
      event.preventDefault();
      closeMenu();
      if (!historyOpen) {
        setHistoryOpen(true);
        setDismissed(true);
        setSelected(0);
      } else if (historyRows.length > 0) {
        setSelected((index) => (Math.min(index, historyRows.length - 1) + 1) % historyRows.length);
      }
      return;
    }
    if (event.key === "Escape") {
      // 权限卡片等捕获阶段处理器已消费时不再处理（否则拒绝后会误触发中断）
      if (event.nativeEvent.defaultPrevented) return;
      if (openMenu !== null) {
        event.preventDefault();
        closeMenu();
      } else if (popup !== null) {
        event.preventDefault();
        setHistoryOpen(false);
        setDismissed(true);
      } else if (running) {
        event.preventDefault();
        void interrupt();
      }
      return;
    }
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if ((event.key === "Backspace" || event.key === "Delete") && plain) {
      // U-05：光标紧挨完整 @引用 时整删；有选区走默认。输入法组合在函数开头已拦截
      const field = event.currentTarget;
      if (field.selectionStart === field.selectionEnd) {
        if (draftSkill && event.key === "Backspace" && field.selectionStart === 0) {
          event.preventDefault();
          removeSkill();
          return;
        }
        const range = fileRefDeleteRange(
          draftRef.current,
          field.selectionStart + offset,
          event.key === "Backspace" ? "backward" : "forward",
        );
        if (range !== undefined) {
          event.preventDefault();
          pendingCaret.current = range.start;
          updateDraft(draftRef.current.slice(0, range.start) + draftRef.current.slice(range.end));
          return;
        }
      }
    }
    if (popup !== null && plain) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        if (flatRows.length > 0 || popup === "history") {
          event.preventDefault();
          if (flatRows.length > 0) {
            const count = flatRows.length;
            setSelected((index) =>
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count,
            );
          }
          return;
        }
      }
      if (event.key === "Tab" && (flatRows.length > 0 || popup === "history")) {
        event.preventDefault();
        if (flatRows.length > 0) {
          const row = flatRows[activeIndex];
          if (row !== undefined) chooseRow(row);
        }
        return;
      }
    }
    // Alt+Enter（ADR-0070）：运行中直接插话；空闲时与 Enter 相同
    if (
      event.key === "Enter" &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      setHistoryOpen(false);
      const line = draftRef.current;
      const parsed = parseSlash(line, variant, skills, externalAgents);
      if (parsed?.kind === "command") {
        event.preventDefault();
        void runSlash(line);
        return;
      }
      event.preventDefault();
      submit(running ? "steer" : undefined);
      return;
    }
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      if (popup === "history") {
        const row = flatRows[activeIndex];
        if (row !== undefined) chooseRow(row);
        return;
      }
      const line = draftRef.current;
      const parsed = parseSlash(line, variant, skills, externalAgents);
      if (parsed?.kind === "command") {
        void runSlash(line);
        return;
      }
      if (parsed?.kind === "skill" || parsed?.kind === "agent" || parsed?.kind === "work") {
        submit(running ? "queue" : undefined);
        return;
      }
      if (popup !== null && flatRows.length > 0) {
        const row = flatRows[activeIndex];
        if (row !== undefined) chooseRow(row);
        return;
      }
      if (parsed?.kind === "redirect") return; // 提示条已显示
      if (parsed?.kind === "unknown") {
        setEnterHint(parsed.hint);
        return;
      }
      submit(running ? "queue" : undefined);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (popup !== null) return;
      navigateHistory(event.key === "ArrowUp" ? "up" : "down", event);
    }
  };

  // 窗口级 Esc：先关弹窗，再中断；已被权限卡片 preventDefault 的不再处理
  const popupOpenRef = useRef(false);
  popupOpenRef.current = popup !== null || openMenu !== null;
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        composingRef.current ||
        // 设置区盖住会话时（会话区 inert）Esc 属于设置区，不中断
        textarea.current?.closest("[inert]") != null
      )
        return;
      if (popupOpenRef.current) {
        event.preventDefault();
        closeMenu();
        setHistoryOpen(false);
        setDismissed(true);
        return;
      }
      if (!running || interruptingRef.current) return;
      event.preventDefault();
      void interrupt();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [running, interrupt, closeMenu]);

  const literalPaste = useRef(false);
  const pasteNumber = useRef(1);
  // ── 粘贴 / 拖入文件 ──
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!allowAttachments) return;
    const items = Array.from(event.clipboardData.items);
    const files = items.flatMap((item) => {
      if (item.kind !== "file") return [];
      const file = item.getAsFile();
      return file === null ? [] : [file];
    });
    if (files.length === 0) {
      const text = event.clipboardData.getData("text/plain");
      if (!literalPaste.current && new TextEncoder().encode(text).byteLength >= 32768) {
        event.preventDefault();
        addImages([
          {
            name: `pasted-${pasteNumber.current++}.txt`,
            data: new TextEncoder().encode(text),
            mimeType: "text/plain",
            source: "paste",
          },
        ]);
      }
      literalPaste.current = false;
      return;
    }
    event.preventDefault();
    const supported = files;
    void Promise.all(
      supported.map(async (file) => ({
        name: file.name || "粘贴图片",
        data: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type as ImageMimeType,
      })),
    ).then(addImages);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!allowAttachments) return;
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const images = files;
    void Promise.all(
      images.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        mimeType: ((IMAGE_TYPES as readonly string[]).includes(file.type)
          ? file.type
          : mimeTypeForImageName(file.name)) as ImageMimeType,
      })),
    ).then(addImages);
  };

  // ── 输入区渲染辅助 ──
  const refSpans = useMemo(() => {
    const refs = parseFileRefs(visibleDraft);
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [index, ref] of refs.entries()) {
      if (ref.start > at) parts.push(visibleDraft.slice(at, ref.start));
      parts.push(
        <span className="composer-ref" key={index}>
          {visibleDraft.slice(ref.start, ref.end)}
        </span>,
      );
      at = ref.end;
    }
    if (at < visibleDraft.length) parts.push(visibleDraft.slice(at));
    return parts;
  }, [visibleDraft]);

  const syncMirror = () => {
    if (mirror.current !== null && textarea.current !== null) {
      mirror.current.scrollTop = textarea.current.scrollTop;
    }
  };
  const grow = () => {
    const field = textarea.current;
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    syncMirror();
  };
  useEffect(grow, [visibleDraft, draftSkill?.label]);
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    textarea.current?.setSelectionRange(pos - offset, pos - offset);
    setCaret(pos);
  }, [draft, offset]);
  useEffect(() => {
    if (popup === null || flatRows.length === 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [popup, activeIndex, flatRows.length, listId]);

  const CHIP_LABELS: Record<"model" | "effort" | "preset" | "dir", string> = {
    model: "切换模型",
    effort: "切换思考档位",
    preset: "切换权限预设",
    dir: "切换目录",
  };
  const parsedSlash = useMemo(
    () => (composing ? null : parseSlash(draft, variant, skills, externalAgents)),
    [composing, draft, variant, skills, externalAgents],
  );
  const slashHint = parsedSlash?.kind === "redirect" ? parsedSlash.hint : enterHint;
  const canSend =
    workMode !== null ? draft.trim() !== "" : draft.trim() !== "" || attachments.length > 0;
  const shownError = error ?? controls?.error ?? null;
  const selectedWorkMode = WORK_MODE_ITEMS.find((item) => item.name === (typedMode ?? workMode));
  const mcpEntries = Object.entries(mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const hasUnavailableMcp = mcpEntries.some(
    ([, server]) => server.state === "failed" || server.state === "crashed",
  );
  const skillFilter = skillQuery.trim().toLowerCase();
  const availableSkills = invocableSkills(skills);
  const pluginSkills = availableSkills.filter((skill) => skill.source === "plugin");
  const ordinarySkills = availableSkills.filter((skill) => skill.source !== "plugin");
  const filteredSkills =
    skillFilter === ""
      ? ordinarySkills
      : ordinarySkills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(skillFilter) ||
            skill.description.toLowerCase().includes(skillFilter),
        );

  const chip = (
    kind: "model" | "effort" | "preset" | "dir",
    control: { label: string; disabled?: string },
    content: ReactNode,
    tip?: string,
  ) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[kind] = node;
      }}
      className={`chip${kind === "model" ? " chip-model" : ""}${openMenu === kind ? " on" : ""}`}
      disabled={control.disabled !== undefined || disabled}
      title={control.disabled ?? tip}
      aria-label={CHIP_LABELS[kind]}
      aria-haspopup="menu"
      aria-expanded={openMenu === kind}
      onClick={() => {
        setMenuExclusive(openMenu === kind ? null : kind);
      }}
    >
      {content}
    </button>
  );

  const controlMenu = (kind: "model" | "effort" | "preset", control: ChoiceControl) => (
    <ChoiceMenu
      anchor={triggers.current[kind] ?? null}
      align={kind === "preset" ? "left" : "right"}
      label={control.heading ?? control.label}
      control={control}
      searchable={kind === "model"}
      {...(kind === "preset" && presetFooter !== undefined ? { footer: presetFooter } : {})}
      action={
        kind === "model" && onManageProviders !== undefined
          ? { label: "管理服务商…", onSelect: onManageProviders }
          : undefined
      }
      onClose={closeMenu}
      // 先同步关菜单：若异步关闭会误伤用户随后打开的下一个菜单
      onError={(reason: unknown) => {
        setError(errorText(reason));
      }}
    />
  );

  const plusButton = (
    <IconButton
      ref={(node) => {
        triggers.current.plus = node;
      }}
      className="plus-btn"
      active={openMenu === "plus"}
      aria-label="添加"
      aria-haspopup="menu"
      aria-expanded={openMenu === "plus"}
      onClick={() => {
        setMenuExclusive(openMenu === "plus" ? null : "plus");
      }}
    >
      <Icon name="add" size={ICON_MD} />
      {hasUnavailableMcp && <span className="mcp-dot" aria-hidden="true" />}
    </IconButton>
  );

  const paperclipButton = (
    <IconButton disabled={disabled} aria-label="添加文件" onClick={openPicker}>
      <Icon name="attachment" size={ICON_MD} />
    </IconButton>
  );

  // 运行中保留中断键 ■，输入非空时旁边再出现发送键：Enter 排队，Alt+Enter 插话
  const sendButton = (
    <>
      {running && (
        <button
          type="button"
          className="send stop"
          disabled={interrupting}
          aria-label="中断"
          title="中断（Esc）"
          onClick={() => {
            void interrupt();
          }}
        >
          <Icon name="stop" size={ICON_MD} />
        </button>
      )}
      {(running ? canSend : true) && (
        <button
          type="button"
          className={`send${canSend ? "" : " off"}`}
          disabled={disabled || composing || !canSend}
          aria-label="发送"
          title={running ? "发送" : "发送（Enter）"}
          onClick={() => {
            submit(running ? "queue" : undefined);
          }}
        >
          <Icon name="arrow_up" size={ICON_MD} />
        </button>
      )}
    </>
  );

  const defaultPlaceholder = "输入消息";

  const txtBlock = (
    <div className="txt">
      <div
        className={`composer-mirror${draftSkill ? " draft-skill" : ""}`}
        aria-hidden="true"
        ref={mirror}
      >
        {draftSkill && <InputLabel data={draftSkill} anchor={skillAnchor} />}
        {refSpans}
        {"​"}
      </div>

      <label htmlFor={id} className="composer-label">
        消息输入
      </label>
      <textarea
        id={id}
        ref={textarea}
        rows={1}
        value={visibleDraft}
        placeholder={draftSkill ? undefined : (placeholder ?? defaultPlaceholder)}
        aria-autocomplete="list"
        aria-controls={popup !== null ? listId : undefined}
        aria-activedescendant={
          popup !== null && flatRows.length > 0 ? `${listId}-${activeIndex}` : undefined
        }
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          setHistoryOpen(false);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart + offset);
        }}
        onChange={(event) => {
          setShowTypedWorkMode(true);
          const next = prefix + event.target.value;
          const pos = event.target.selectionStart + offset;
          setCaret(pos);
          if (draftLabel(next, skills, true).prefix !== prefix) pendingCaret.current = pos;
          updateDraft(next);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={syncMirror}
        onCompositionStart={() => {
          composingRef.current = true;
          setComposing(true);
        }}
        onCompositionEnd={(event) => {
          // 只在组字结束后标签出现或消失（可见文本整体平移）时才摆光标；否则这里留下的
          // 位置会在下一次输入时把光标拉回组字结束处
          if (draftPresentation.prefix !== prefix) {
            pendingCaret.current = event.currentTarget.selectionStart + offset;
          }
          composingRef.current = false;
          setComposing(false);
        }}
      />
    </div>
  );

  return (
    <div className={`composer${isSession ? " session" : ""}`} hidden={hidden}>
      <div className="cw">
        {slashHint !== null && (
          <div className="composer-redirect" role="status">
            {slashHint}
          </div>
        )}
        {vision !== undefined && (
          <div className="composer-redirect" role="status">
            {vision}
          </div>
        )}
        {popup !== null && (
          <div
            className="composer-popup"
            role="listbox"
            aria-label={
              popup === "history" ? "输入历史" : popup === "refs" ? "文件引用补全" : "斜杠命令补全"
            }
            id={listId}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
          >
            {popup === "history" ? (
              <>
                <div className="composer-popup-h">历史</div>
                {historyRows.length === 0 ? (
                  <div className="composer-popup-note">没有匹配的历史</div>
                ) : (
                  historyRows.map((row, index) => (
                    <div
                      id={`${listId}-${index}`}
                      key={row.key}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`composer-popup-row${index === activeIndex ? " is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        chooseRow(row);
                      }}
                    >
                      <span className="composer-popup-name">
                        {splitHighlightSegments(row.label, row.ranges ?? []).map((seg, segIndex) =>
                          seg.hit ? (
                            <mark className="composer-history-hl" key={segIndex}>
                              {seg.text}
                            </mark>
                          ) : (
                            <Fragment key={segIndex}>{seg.text}</Fragment>
                          ),
                        )}
                      </span>
                    </div>
                  ))
                )}
              </>
            ) : popup === "refs" ? (
              <>
                <div className="composer-popup-h">文件</div>
                {indexLoadingNow ? (
                  <div className="composer-popup-note">正在索引…</div>
                ) : indexCache.current?.failed === true ? (
                  <div className="composer-popup-note">文件索引不可用</div>
                ) : refRows.length === 0 ? (
                  <div className="composer-popup-note">没有匹配的文件</div>
                ) : (
                  refRows.map((row, index) => (
                    <div
                      id={`${listId}-${index}`}
                      key={row.key}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`composer-popup-row${index === activeIndex ? " is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        chooseRow(row);
                      }}
                    >
                      <span className="composer-popup-name">{row.label}</span>
                    </div>
                  ))
                )}
              </>
            ) : (
              slashRows.map((item, index) => {
                const previous = slashRows[index - 1];
                return (
                  <Fragment key={item.row.key}>
                    {(index === 0 || previous?.group.id !== item.group.id) && (
                      <div className="composer-popup-h">{item.group.label}</div>
                    )}
                    <div
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`composer-popup-row${index === activeIndex ? " is-active" : ""}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        chooseRow(item.row);
                      }}
                    >
                      <span className="slash-item-icon">
                        {item.row.decoration && <InputLabelIcon {...item.row.decoration} />}
                      </span>
                      <span className="composer-popup-name">
                        {item.row.label}
                        {item.row.argumentHint && <em>{item.row.argumentHint}</em>}
                      </span>
                      <span className="composer-popup-summary">{item.row.summary}</span>
                      {item.row.source && (
                        <small className="composer-popup-source">{item.row.source}</small>
                      )}
                    </div>
                  </Fragment>
                );
              })
            )}
          </div>
        )}
        {isSession && (
          <TodoPanel
            items={todos}
            prefs={prefs}
            goal={goal}
            goalActions={goalActions}
            onGoalError={onGoalError}
          />
        )}
        {isSession && pendingInputs !== undefined && pendingInputs.items.length > 0 && (
          <PendingInputs
            snapshot={pendingInputs}
            running={running}
            disabled={disabled}
            onUpdate={onUpdatePending ?? (() => Promise.resolve())}
            onCancel={onCancelPending ?? (() => Promise.resolve())}
            onResume={onResumePending ?? (() => Promise.resolve())}
          />
        )}
        <div
          className={`cbox${dragOver ? " drop" : ""}`}
          onDragOver={(event) => {
            if (allowAttachments && event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            ) {
              setDragOver(false);
            }
          }}
          onDrop={onDrop}
        >
          {attachments.length > 0 && (
            <ImageViewerBoundary>
              <DraftAttachments attachments={attachments} onRemove={removeAttachment} />
            </ImageViewerBoundary>
          )}
          {txtBlock}
          <div className="tb">
            {plusButton}
            {allowAttachments && paperclipButton}
            {controls !== undefined &&
              chip(
                "preset",
                controls.preset,
                <>
                  <Icon name="shield" size={ICON_SM} />
                  <b>{controls.preset.label}</b>
                  <Icon name="down_small" size={ICON_SM} className="caret" />
                </>,
              )}
            {selectedWorkMode && (
              <>
                <button
                  type="button"
                  className="work-mode-tag"
                  disabled={disabled}
                  aria-label={`取消${selectedWorkMode.label}`}
                  onClick={() => {
                    if (typedMode) {
                      pendingCaret.current =
                        textarea.current?.selectionStart ?? visibleDraft.length;
                      updateDraft(visibleDraft);
                    }
                    updateWorkMode(null);
                    textarea.current?.focus();
                  }}
                >
                  <InputLabel data={selectedWorkMode} dismissible />
                </button>
                <span className="tb-sep" aria-hidden="true" />
              </>
            )}
            <span className="sp" />
            {isSession && contextUsage}
            {controls !== undefined &&
              chip(
                "model",
                controls.model,
                <>
                  <BrandIcon iconKey={controls.model.icon ?? "box_3"} size="sm" />
                  <span className="t">{controls.model.label}</span>
                  <Icon name="down_small" size={ICON_SM} className="caret" />
                </>,
                controls.model.label,
              )}
            {controls !== undefined &&
              chip(
                "effort",
                controls.effort,
                <>
                  <span className="t">{controls.effort.label}</span>
                  <Icon name="down_small" size={ICON_SM} className="caret" />
                </>,
                controls.effort.label,
              )}
            {sendButton}
          </div>
        </div>
        {!isSession && ((workspace !== undefined && controls !== undefined) || branchIsGit) && (
          <div className="tray">
            {workspace !== undefined && controls !== undefined && (
              <button
                type="button"
                ref={(node) => {
                  triggers.current.dir = node;
                }}
                className={`chip chip-dir${openMenu === "dir" ? " on" : ""}${workspace.readOnly ? " ro" : ""}`}
                disabled={workspace.readOnly || disabled}
                title={workspace.title}
                aria-label="切换目录"
                aria-haspopup={workspace.readOnly ? undefined : "menu"}
                aria-expanded={!workspace.readOnly && openMenu === "dir"}
                onClick={() => {
                  if (!workspace.readOnly) requestDirOpen(!dirOpen);
                }}
              >
                {workspace.kind === "plain" ? (
                  <Icon name="chat_1" size={ICON_SM} />
                ) : (
                  <Icon name="folder" size={ICON_SM} />
                )}
                <b>{workspace.label}</b>
                {!workspace.readOnly && <Icon name="down_small" size={ICON_SM} className="caret" />}
              </button>
            )}
            {branchIsGit && branchMenu?.trigger}
          </div>
        )}
      </div>
      {openMenu === "plus" && (
        <Menu
          anchor={triggers.current.plus ?? null}
          align="left"
          placement="above"
          className="composer-plus-menu"
          label="添加"
          onClose={closeMenu}
        >
          {WORK_MODE_ITEMS.map((item) => {
            const disabledReason = workModeDisabled?.[item.name];
            return (
              <MenuItem
                key={item.name}
                icon={<Icon name={item.icon} size={ICON_SM} />}
                label={item.label}
                {...(disabledReason !== undefined ? { disabled: disabledReason } : {})}
                onSelect={() => {
                  closeMenu();
                  if (typedMode) updateDraft(visibleDraft);
                  updateWorkMode(item.name);
                  textarea.current?.focus();
                }}
              />
            );
          })}
          <MenuSeparator />
          <MenuSubmenu
            icon={<Icon name={SKILL_ICON} size={ICON_SM} />}
            label="技能"
            right={<Icon name="right_small" size={ICON_SM} />}
          >
            <div className="menu-search-box">
              <Icon name="search" size={ICON_SM} />
              <input
                className="menu-search"
                type="search"
                aria-label="搜索技能"
                value={skillQuery}
                onChange={(event) => {
                  setSkillQuery(event.target.value);
                }}
              />
            </div>
            {filteredSkills.map((skill) => (
              <MenuItem
                key={skill.name}
                label={skill.name}
                icon={<Icon name={SKILL_ICON} size={ICON_SM} />}
                onSelect={() => {
                  closeMenu();
                  insertSkillToken(skill.name);
                }}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              icon={<Icon name="settings_1" size={ICON_SM} />}
              label="管理技能"
              onSelect={() => {
                closeMenu();
                onManageSkills?.();
              }}
            />
          </MenuSubmenu>
          <MenuSubmenu
            icon={<Icon name={PLUGIN_ICON} size={ICON_SM} />}
            label="插件"
            right={<Icon name="right_small" size={ICON_SM} />}
          >
            {pluginSkills.map((skill) => {
              const label = skillLabel(skill.name, skill);
              return (
                <MenuItem
                  key={skill.name}
                  label={label.label}
                  icon={<InputLabelIcon {...label} />}
                  onSelect={() => {
                    closeMenu();
                    insertSkillToken(skill.name);
                  }}
                />
              );
            })}
            {pluginSkills.length > 0 && <MenuSeparator />}
            <MenuItem
              icon={<Icon name="settings_1" size={ICON_SM} />}
              label="管理插件"
              onSelect={() => {
                closeMenu();
                onManagePlugins?.();
              }}
            />
          </MenuSubmenu>
          <MenuSubmenu
            icon={<Icon name="server" size={ICON_SM} />}
            label="MCP"
            right={
              <>
                {hasUnavailableMcp && <span className="mcp-dot" aria-hidden="true" />}
                <Icon name="right_small" size={ICON_SM} />
              </>
            }
          >
            {mcpEntries.length > 0 && (
              <>
                {mcpEntries.map(([name, server]) => (
                  <MenuItem
                    key={name}
                    icon={
                      <span className={`mcp-state-dot is-${server.state}`} aria-hidden="true" />
                    }
                    label={name}
                    onSelect={() => {
                      closeMenu();
                      onManageMcp?.();
                    }}
                  />
                ))}
                <MenuSeparator />
              </>
            )}
            <MenuItem
              icon={<Icon name="settings_1" size={ICON_SM} />}
              label="管理 MCP"
              onSelect={() => {
                closeMenu();
                onManageMcp?.();
              }}
            />
          </MenuSubmenu>
        </Menu>
      )}
      {controls !== undefined && openMenu === "model" && controlMenu("model", controls.model)}
      {controls !== undefined && openMenu === "effort" && controlMenu("effort", controls.effort)}
      {controls !== undefined && openMenu === "preset" && controlMenu("preset", controls.preset)}
      {workspace !== undefined && openMenu === "dir" && !workspace.readOnly && (
        <Menu
          anchor={triggers.current.dir ?? null}
          align="left"
          placement="below"
          label="工作区"
          onClose={closeMenu}
        >
          <MenuItem
            icon={<Icon name="chat_1" size={ICON_SM} />}
            checked={workspace.currentKey === null}
            label="普通对话"
            right="不属于任何项目"
            onSelect={() => {
              closeMenu();
              workspace.onSelectPlain();
            }}
          />
          {workspace.projects.length > 0 && (
            <>
              <MenuSeparator />
              <MenuHeading>项目</MenuHeading>
            </>
          )}
          {workspace.projects.map((project) => (
            <MenuItem
              key={project.key}
              icon={<Icon name="folder" size={ICON_SM} />}
              checked={workspace.currentKey === project.key}
              label={project.name}
              detail={project.path}
              onSelect={() => {
                closeMenu();
                workspace.onSelectProject(project.path);
              }}
            />
          ))}
          <MenuSeparator />
          <MenuItem
            icon={<Icon name="add" size={ICON_SM} />}
            label="打开其他文件夹…"
            onSelect={() => {
              closeMenu();
              workspace.onOpenOther();
            }}
          />
        </Menu>
      )}
      {branchMenu?.menu}
      {shownError !== null && (
        <div className="composer-error" role="alert">
          {shownError}
        </div>
      )}
    </div>
  );
}

function DraftAttachments({
  attachments,
  onRemove,
}: {
  attachments: readonly Attachment[];
  onRemove: (index: number) => void;
}) {
  const openViewer = useImageViewer();
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(() => new Set());
  const openAt = (targetUrl: string, opener: HTMLElement) => {
    const items: ViewerImageItem[] = [];
    let initialIndex = 0;
    for (const att of attachments) {
      if (!att.mimeType.startsWith("image/") || brokenUrls.has(att.url)) continue;
      if (att.url === targetUrl) initialIndex = items.length;
      items.push({
        src: att.url,
        filename: att.name,
        alt: att.name,
        blob: new Blob([att.data as BlobPart], { type: att.mimeType }),
      });
    }
    openViewer(items, initialIndex, opener);
  };
  return (
    <div className="atts">
      {attachments.map((attachment, index) => {
        const isImg = attachment.mimeType.startsWith("image/");
        const broken = brokenUrls.has(attachment.url);
        return (
          <span className="thumb2" key={`${attachment.name}:${index}`}>
            {isImg ? (
              broken ? (
                <img src={attachment.url} alt={attachment.name} />
              ) : (
                <button
                  type="button"
                  className="thumb2-open"
                  aria-label={attachment.name}
                  onClick={(event) => {
                    openAt(attachment.url, event.currentTarget);
                  }}
                >
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    onError={() => {
                      setBrokenUrls((prev) => {
                        const next = new Set(prev);
                        next.add(attachment.url);
                        return next;
                      });
                    }}
                  />
                </button>
              )
            ) : (
              <span className="ficon" aria-hidden="true">
                {fileIconText(attachment.name)}
              </span>
            )}
            <span className="fname">{attachment.name}</span>
            <span className="fsize">{formatBytes(attachment.data.byteLength)}</span>
            <button
              type="button"
              className="x"
              aria-label={`移除 ${attachment.name}`}
              onClick={() => {
                onRemove(index);
              }}
            >
              <Icon name="close" size={ICON_SM} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
