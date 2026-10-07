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
  type ImageMimeType,
  type ExternalAgentOverview,
  type SkillOverview,
  type SkillInvocation,
} from "@nocturne/core/protocol";

import { completeSlash, parseSlash, type SlashGroup } from "./commands";
import {
  completeFileRefs,
  fileRefDeleteRange,
  fileRefToken,
  type FileIndexEntry,
  type FileRefCandidate,
} from "./file-refs";
import { ChoiceMenu, Menu, MenuHeading, MenuItem, MenuSeparator } from "./Menu";
import {
  IMAGE_TYPES,
  IMAGE_TYPE_ERROR,
  mimeTypeForImageName,
  type PickedImage,
} from "./picked-images";
import "./composer.css";

export interface ChoiceOption {
  value: string;
  label: string;
  detail?: string;
  /** 自绘下拉（Dropdown）里的中文名、说明与危险标记；说明统一来自 choice-info.ts */
  tag?: string;
  description?: string;
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
  attachments: { data: Uint8Array; mimeType: ImageMimeType; label: string }[];
}

export interface ComposerProps {
  skills?: readonly SkillOverview[];
  externalAgents?: readonly ExternalAgentOverview[];
  running: boolean;
  disabled?: boolean;
  /** false 表示未接收；resolve 表示已接收（草稿与附件才可清空） */
  onSubmit: (input: ComposerSubmit) => boolean | Promise<boolean>;
  onInterrupt: () => void | Promise<void>;
  /**
   * draft（空状态）：卡片 + 下方 tray（目录/预设/提示）；模型/档位 chip 在卡内工具栏。
   * session：同一卡片，文字区在上、工具行左 ＋ 右发送/中断；无 tray、无 chip，切换都在底部状态栏。
   */
  variant?: "draft" | "session";
  historyKey?: string | null;
  readInputHistory?: () => Promise<string[]>;
  /** 父层从当前会话引用记录，因而首次输入创建会话后也能写入历史。 */
  recordInputHistory?: (text: string) => Promise<void>;
  /** draft 必需；session 变体忽略 */
  controls?: ComposerControls | undefined;
  /** draft 必需；session 变体忽略 */
  workspace?: WorkspaceChoice | undefined;
  /** null 表示本目录无项目文件索引（普通对话、或尚未建会话） */
  fileRefs: FileRefSource | null;
  fileRefsUnavailable?: string;
  /** 首张图片加入时调用一次；draft 显示在托盘，session 显示在卡片上方 */
  getVisionHint?: () => Promise<string | undefined>;
  pickImages: () => Promise<PickedImage[]>;
  dirMenuOpen?: boolean;
  onDirMenuOpenChange?: (open: boolean) => void;
  /** 处理 /compact、/mcp；false 时草稿保留 */
  onSlash: (line: string) => boolean | Promise<boolean>;
  /** 模型菜单底部「管理服务商…」（进入设置 › 服务商）；不传则不显示 */
  onManageProviders?: () => void;
  placeholder?: string;
}

interface Attachment {
  name: string;
  data: Uint8Array;
  mimeType: ImageMimeType;
  url: string;
}

type MenuKind = "plus" | "model" | "effort" | "preset" | "dir";
type PopupKind = "slash" | "refs";

const MAX_TEXTAREA_HEIGHT = 280;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendHistory(history: readonly string[], text: string): string[] {
  return history.at(-1) === text ? [...history] : [...history.slice(-999), text];
}

// mockup 托盘/菜单图标（stroke 图标，currentColor）
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinejoin: "round" as const,
};
function IconChat() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3.5h12v7H6.5L3.5 13v-2.5H2z" {...stroke} />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 3h4l1.5 1.5h7.5v8h-13z" {...stroke} />
    </svg>
  );
}
function IconShield() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.8 13 3.6v4c0 3.2-2.2 5.4-5 6.6-2.8-1.2-5-3.4-5-6.6v-4z" {...stroke} />
    </svg>
  );
}
function IconImage() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" {...stroke} />
      <circle cx="5.6" cy="6.3" r="1.2" fill="currentColor" stroke="none" />
      <path d="m2.5 12 3.8-3.6 2.6 2.2 2-1.7 2.8 2.6" {...stroke} />
    </svg>
  );
}
function IconAt() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" {...stroke} />
      <path
        d="M10.6 8v1.1a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </svg>
  );
}

interface PopupRow {
  argumentHint?: string | undefined;
  source?: string | undefined;
  key: string;
  label: string;
  summary?: string;
  insert: string;
  directory?: boolean;
}

export function Composer({
  running,
  disabled = false,
  onSubmit,
  onInterrupt,
  variant = "draft",
  historyKey,
  readInputHistory,
  recordInputHistory,
  controls,
  workspace,
  fileRefs,
  fileRefsUnavailable = "无项目文件索引",
  getVisionHint,
  pickImages,
  dirMenuOpen,
  onDirMenuOpenChange,
  onSlash,
  onManageProviders,
  placeholder,
  skills = [],
  externalAgents = [],
}: ComposerProps) {
  const isSession = variant === "session";
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enterHint, setEnterHint] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [vision, setVision] = useState<string | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<MenuKind, HTMLButtonElement | null>>>({});
  const composingRef = useRef(false);
  const submittingRef = useRef(false);
  const interruptingRef = useRef(false);
  const draftRef = useRef("");
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
  useEffect(() => {
    let active = true;
    history.current = [];
    historySinceRead.current = [];
    historyIndex.current = null;
    const readHistory = readHistoryRef.current;
    if (readHistory !== undefined) {
      void readHistory()
        .then((rows) => {
          if (!active) return;
          history.current = historySinceRead.current.reduce(appendHistory, rows.slice(-1000));
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
  const token = focused && !composing ? fileRefToken(draft, caret) : undefined;
  const refCompletion =
    token !== undefined && fileRefs !== null && !dismissed
      ? completeFileRefs(draft, caret, indexCache.current?.entries ?? [])
      : undefined;
  const showRefPopup =
    token !== undefined && fileRefs !== null && !dismissed && refCompletion !== undefined;
  const slashGroups = useMemo<SlashGroup[]>(
    () =>
      focused && !composing && !dismissed && token === undefined
        ? completeSlash(draft, skills, externalAgents)
        : [],
    [focused, composing, dismissed, token, draft, skills, externalAgents],
  );
  const popup: PopupKind | null = showRefPopup ? "refs" : slashGroups.length > 0 ? "slash" : null;

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
          source: item.source,
          insert: item.insert,
        },
      })),
    );
  }, [popup, slashGroups]);
  const flatRows: PopupRow[] = popup === "refs" ? refRows : slashRows.map((item) => item.row);
  const activeIndex = Math.min(selected, Math.max(0, flatRows.length - 1));
  const indexLoadingNow = showRefPopup && indexCache.current?.key !== fileRefs.key;

  useEffect(() => {
    if (showRefPopup) ensureFileIndex();
  }, [showRefPopup, ensureFileIndex]);

  const chooseRow = (row: PopupRow) => {
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
    updateDraft(row.insert);
    setDismissed(true);
    textarea.current?.focus();
  };

  const insertRefToken = () => {
    const field = textarea.current;
    const text = draftRef.current;
    const pos = field?.selectionStart ?? text.length;
    const before = text.slice(0, pos);
    const after = text.slice(field?.selectionEnd ?? pos);
    const prefix = before === "" || /\s$/.test(before) ? "" : " ";
    const next = `${before}${prefix}@${after}`;
    pendingCaret.current = before.length + prefix.length + 1;
    updateDraft(next);
    field?.focus();
    ensureFileIndex();
  };

  // ── 附件 ──
  const addImages = useCallback(
    (files: { name: string; data: Uint8Array; mimeType?: ImageMimeType }[]) => {
      let unsupported = false;
      const added: Attachment[] = [];
      for (const file of files) {
        const mimeType = file.mimeType ?? mimeTypeForImageName(file.name);
        if (mimeType === undefined) {
          unsupported = true;
          continue;
        }
        added.push({
          name: file.name,
          data: file.data,
          mimeType,
          url: URL.createObjectURL(new Blob([file.data as BlobPart], { type: mimeType })),
        });
      }
      if (added.length > 0) setAttachments((current) => [...current, ...added]);
      if (unsupported) setError(IMAGE_TYPE_ERROR);
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
  const submit = async () => {
    const text = draftRef.current;
    if (disabled || running || submittingRef.current || composingRef.current) return;
    if (text.trim() === "" && attachmentsRef.current.length === 0) return;
    const submittedRevision = revision.current;
    const parsed = parseSlash(text, variant, skills, externalAgents);
    if (parsed?.kind === "unknown" || parsed?.kind === "redirect") {
      setEnterHint(parsed.hint);
      return;
    }
    if (parsed?.kind === "command") {
      await runSlash(text);
      return;
    }
    const payload: ComposerSubmit = {
      text,
      ...(parsed?.kind === "skill" ? { skill: parsed.invocation } : {}),
      ...(parsed?.kind === "agent" ? { delegate: parsed.delegate } : {}),
      attachments: attachmentsRef.current.map((attachment) => ({
        data: attachment.data,
        mimeType: attachment.mimeType,
        label: attachment.name,
      })),
    };
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await onSubmit(payload);
      if (!accepted) return;
      historyIndex.current = null;
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
      setAttachments([]);
      if (mounted.current && revision.current === submittedRevision) updateDraft("");
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
      }
    } catch (reason) {
      if (mounted.current) setError(`发送失败：${errorText(reason)}`);
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
    }
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
    const position = field.selectionStart;
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
      updateDraft(history.current[historyIndex.current] ?? "", true);
    } else if (historyIndex.current !== null) {
      event.preventDefault();
      const next = historyIndex.current + 1;
      historyIndex.current = next < history.current.length ? next : null;
      updateDraft(
        historyIndex.current === null ? historyDraft.current : (history.current[next] ?? ""),
        true,
      );
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 旧 IME 用 keyCode 229 标记组合中
    if (event.nativeEvent.isComposing || composingRef.current || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Escape") {
      // 权限卡片等捕获阶段处理器已消费时不再处理（否则拒绝后会误触发中断）
      if (event.nativeEvent.defaultPrevented) return;
      if (openMenu !== null) {
        event.preventDefault();
        closeMenu();
      } else if (popup !== null) {
        event.preventDefault();
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
        const range = fileRefDeleteRange(
          draftRef.current,
          field.selectionStart,
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
    if (popup !== null && flatRows.length > 0 && plain) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const count = flatRows.length;
        setSelected((index) =>
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count,
        );
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const row = flatRows[activeIndex];
        if (row !== undefined) chooseRow(row);
        return;
      }
    }
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      const line = draftRef.current;
      const parsed = parseSlash(line, variant, skills, externalAgents);
      if (parsed?.kind === "command") {
        void runSlash(line);
        return;
      }
      if (parsed?.kind === "skill" || parsed?.kind === "agent") {
        void submit();
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
      void submit();
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

  // ── 粘贴 / 拖入图片 ──
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const files = items.flatMap((item) => {
      if (item.kind !== "file") return [];
      const file = item.getAsFile();
      return file === null ? [] : [file];
    });
    if (files.length === 0) return;
    const supported = files.filter((file) =>
      (IMAGE_TYPES as readonly string[]).includes(file.type),
    );
    const unsupported = files.some(
      (file) =>
        file.type.startsWith("image/") && !(IMAGE_TYPES as readonly string[]).includes(file.type),
    );
    // 有文本时保持默认粘贴行为；只有文件时阻止文件名被粘贴成文本
    if (!items.some((item) => item.kind === "string")) event.preventDefault();
    if (unsupported) setError(IMAGE_TYPE_ERROR);
    if (supported.length === 0) return;
    void Promise.all(
      supported.map(async (file) => ({
        name: file.name || "粘贴图片",
        data: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type as ImageMimeType,
      })),
    ).then(addImages);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const images: File[] = [];
    let nonImage = false;
    let unsupported = false;
    for (const file of files) {
      const mimeType = (IMAGE_TYPES as readonly string[]).includes(file.type)
        ? (file.type as ImageMimeType)
        : file.type === ""
          ? mimeTypeForImageName(file.name)
          : undefined;
      if (file.type !== "" && !file.type.startsWith("image/")) {
        nonImage = true;
      } else if (mimeType === undefined) {
        unsupported = true;
      } else {
        images.push(file);
      }
    }
    if (nonImage) setError("只能拖入图片");
    else if (unsupported) setError(IMAGE_TYPE_ERROR);
    if (images.length === 0) return;
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
    const refs = parseFileRefs(draft);
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [index, ref] of refs.entries()) {
      if (ref.start > at) parts.push(draft.slice(at, ref.start));
      parts.push(
        <span className="composer-ref" key={index}>
          {draft.slice(ref.start, ref.end)}
        </span>,
      );
      at = ref.end;
    }
    if (at < draft.length) parts.push(draft.slice(at));
    return parts;
  }, [draft]);

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
  useEffect(grow, [draft]);
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    textarea.current?.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [draft]);
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
  const canSend = !running && (draft.trim() !== "" || attachments.length > 0);
  // draft：能力提示落在 tray；session：无 tray，显示在卡片上方气泡
  const hint = isSession
    ? null
    : (vision ?? (draft.trim() !== "" ? "Enter 发送 · Shift+Enter 换行" : null));
  const shownError = error ?? controls?.error ?? null;

  const chip = (
    kind: "model" | "effort" | "preset" | "dir",
    control: { label: string; disabled?: string },
    content: ReactNode,
  ) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[kind] = node;
      }}
      className={`chip${openMenu === kind ? " on" : ""}`}
      disabled={control.disabled !== undefined || disabled}
      title={control.disabled}
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
    <button
      type="button"
      ref={(node) => {
        triggers.current.plus = node;
      }}
      className={`ib${openMenu === "plus" ? " on" : ""}`}
      aria-label="添加图片或引用文件"
      aria-haspopup="menu"
      aria-expanded={openMenu === "plus"}
      onClick={() => {
        setMenuExclusive(openMenu === "plus" ? null : "plus");
      }}
    >
      ＋
    </button>
  );

  const sendButton = running ? (
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
      ■
    </button>
  ) : (
    <button
      type="button"
      className={`send${canSend ? "" : " off"}`}
      disabled={disabled || submitting || composing || !canSend}
      aria-label="发送"
      title="发送（Enter）"
      onClick={() => {
        void submit();
      }}
    >
      ↑
    </button>
  );

  const defaultPlaceholder = isSession
    ? "输入消息，@ 引用文件，Enter 发送，Shift+Enter 换行"
    : "输入消息，@ 引用文件";

  const txtBlock = (
    <div className="txt">
      <div className="composer-mirror" aria-hidden="true" ref={mirror}>
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
        value={draft}
        placeholder={placeholder ?? (running ? "继续输入，Esc 中断" : defaultPlaceholder)}
        aria-autocomplete="list"
        aria-controls={popup !== null ? listId : undefined}
        aria-activedescendant={popup !== null ? `${listId}-${activeIndex}` : undefined}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onSelect={(event) => {
          setCaret(event.currentTarget.selectionStart);
        }}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          updateDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onScroll={syncMirror}
        onCompositionStart={() => {
          composingRef.current = true;
          setComposing(true);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          setComposing(false);
        }}
      />
    </div>
  );

  return (
    <div className={`composer${isSession ? " session" : ""}`}>
      <div className="cw">
        {slashHint !== null && (
          <div className="composer-redirect" role="status">
            {slashHint}
          </div>
        )}
        {isSession && vision !== undefined && (
          <div className="composer-redirect" role="status">
            {vision}
          </div>
        )}
        {popup !== null && (
          <div
            className="composer-popup"
            role="listbox"
            aria-label={popup === "refs" ? "文件引用补全" : "斜杠命令补全"}
            id={listId}
          >
            {popup === "refs" ? (
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
        <div
          className={`cbox${dragOver ? " drop" : ""}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
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
            <div className="atts">
              {attachments.map((attachment, index) => (
                <span className="thumb2" key={`${attachment.name}:${index}`}>
                  <img src={attachment.url} alt="" />
                  {attachment.name}
                  <button
                    type="button"
                    className="x"
                    aria-label={`移除 ${attachment.name}`}
                    onClick={() => {
                      removeAttachment(index);
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {txtBlock}
          <div className="tb">
            {plusButton}
            <span className="sp" />
            {!isSession &&
              controls !== undefined &&
              chip(
                "model",
                controls.model,
                <>
                  <span className="pd" aria-hidden="true" />
                  {controls.model.label}
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </>,
              )}
            {!isSession &&
              controls !== undefined &&
              chip(
                "effort",
                controls.effort,
                <>
                  {controls.effort.label}
                  <span className="caret" aria-hidden="true">
                    ▾
                  </span>
                </>,
              )}
            {sendButton}
          </div>
        </div>
        {!isSession && workspace !== undefined && controls !== undefined && (
          <div className="tray">
            <button
              type="button"
              ref={(node) => {
                triggers.current.dir = node;
              }}
              className={`chip${openMenu === "dir" ? " on" : ""}${workspace.readOnly ? " ro" : ""}`}
              disabled={workspace.readOnly || disabled}
              title={workspace.title}
              aria-label="切换目录"
              aria-haspopup={workspace.readOnly ? undefined : "menu"}
              aria-expanded={!workspace.readOnly && openMenu === "dir"}
              onClick={() => {
                if (!workspace.readOnly) requestDirOpen(!dirOpen);
              }}
            >
              {workspace.kind === "plain" ? <IconChat /> : <IconFolder />}
              <b>{workspace.label}</b>
              {!workspace.readOnly && (
                <span className="caret" aria-hidden="true">
                  ▾
                </span>
              )}
            </button>
            {chip(
              "preset",
              controls.preset,
              <>
                <IconShield />
                <b>{controls.preset.label}</b>
                <span className="caret" aria-hidden="true">
                  ▾
                </span>
              </>,
            )}
            {hint !== null && <span className="hint">{hint}</span>}
          </div>
        )}
      </div>
      {openMenu === "plus" && (
        <Menu anchor={triggers.current.plus ?? null} label="添加" onClose={closeMenu}>
          <MenuItem
            icon={<IconImage />}
            label="添加图片…"
            right="也可粘贴、拖入"
            onSelect={openPicker}
          />
          <MenuItem
            icon={<IconAt />}
            label="引用文件…"
            right={<span className="mono">@</span>}
            {...(fileRefs === null ? { disabled: fileRefsUnavailable } : {})}
            onSelect={() => {
              closeMenu();
              insertRefToken();
            }}
          />
        </Menu>
      )}
      {controls !== undefined && openMenu === "model" && controlMenu("model", controls.model)}
      {controls !== undefined && openMenu === "effort" && controlMenu("effort", controls.effort)}
      {controls !== undefined && openMenu === "preset" && controlMenu("preset", controls.preset)}
      {workspace !== undefined && openMenu === "dir" && !workspace.readOnly && (
        <Menu anchor={triggers.current.dir ?? null} label="工作区" onClose={closeMenu}>
          <MenuItem
            icon={<IconChat />}
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
              icon={<IconFolder />}
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
            icon={<IconPlus />}
            label="打开其他文件夹…"
            onSelect={() => {
              closeMenu();
              workspace.onOpenOther();
            }}
          />
        </Menu>
      )}
      {shownError !== null && (
        <div className="composer-error" role="alert">
          {shownError}
        </div>
      )}
    </div>
  );
}
