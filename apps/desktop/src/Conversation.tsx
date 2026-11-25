import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { marked, type Token, type Tokens } from "marked";
import { Badge, Button, Checkbox, ICON_MD, ICON_SM, Icon, IconButton } from "./ui";
import { DraftAttachments } from "./DraftAttachments";
import {
  createDraftAttachments,
  loadStoredImageAttachments,
  readClipboardAttachments,
  readDroppedAttachments,
  readFileListAttachments,
  revokeDraftAttachments,
  toSubmitAttachments,
  type DraftAttachment,
  type NewAttachmentFile,
  type SubmitAttachment,
} from "./draft-attachments";
import type { PickedImage } from "./picked-images";
import {
  ImageViewerBoundary,
  triggerBytesDownload,
  useImageViewer,
  useSaveFile,
  type SaveFileFn,
  type ViewerImageItem,
} from "./ImageViewer";
import { InlinePage, PageEntryRow } from "./InlinePage";
import "./grants.css";
import "./code-colors.css";
import { diffRows } from "./code-lines";
import { useCodeHighlight } from "./use-code-highlight";
import {
  QUOTE_FLASH_DURATION_MS,
  QUOTE_FLASH_FADE_AT_MS,
  applyQuoteFlashHighlight,
  clearQuoteFlashHighlight,
  findQuoteRangesInElement,
  readQuoteSelection,
  type QuoteSelectionAnchor,
} from "./quote-reply";
import { shellResultSummary, shellResultText, shellToolStatus } from "./background-shell";
import { useMotionAllowed } from "./motion";
import { hasPrimaryModOrMetaOnOther, isMacOS } from "./platform";

export function GrantedTag({
  permission,
  target,
  kind,
}: {
  permission: ToolEntry["permission"];
  target?: string | undefined;
  kind?: Grant["kind"] | undefined;
}) {
  if (permission?.source !== "grant") return null;
  const grant = permission.grant;
  const time =
    grant === undefined
      ? ""
      : new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(grant.createdAt))
          .replace("/", "-");
  const tooltip =
    grant === undefined
      ? "已授权"
      : grant.match === "pattern"
        ? [`命令规则 · ${time}`, grant.pattern ?? target].filter(Boolean).join("\n")
        : [
            `${grant.scope === "session" ? "本会话允许" : "本项目允许"} · ${time}`,
            [kind && grantKind(kind), target].filter(Boolean).join(" · "),
          ]
            .filter(Boolean)
            .join("\n");
  return (
    <span
      className="granted-tag granted-tooltip"
      tabIndex={0}
      data-tooltip={tooltip}
      title={tooltip}
    >
      已授权
    </span>
  );
}
import {
  allPendingPermissions,
  inlineFilesOfTool,
  isNotReadToolFailure,
  pageCommentsLabel,
  resolveInlinePageDisplay,
  resolveInlinePageId,
  parseFileRefs,
  untrackedCallsText,
  todoItemsFromCompletion,
  subagentRowInfo,
  subagentResultText,
  subagentResultLine,
  backgroundToolStatus,
  subagentStartRejected,
  splitCodeRef,
  isRuntimeWorkMode,
  userWorkMode,
  unwrapEnsemblePostText,
  permissionReviewLabel,
  validateShellRulePattern,
  matchesShellPatternGrant,
  shellDialect,
  type SkillOverview,
  thinkingPhrase,
  type FileAttachment,
  type MessageQuote,
  type WorkModeName,
  type PendingPermission,
  type ImageAttachment,
  type LiveTool,
  type PendingQuestion,
  type PermissionOption,
  type PermissionReply,
  type PermissionSubject,
  type QuestionReply,
  type AttachmentInput,
  type RewindMode,
  type RewindTarget,
  type RuntimeEvent,
  type SessionView,
  type EnsembleView,
  type SuiteView,
  type ToolEntry,
  type TurnEndReason,
  type UserEntry,
  type ViewEntry,
  type TurnChanges,
  type TurnChangeDiff,
  type Grant,
  type ApplicationTarget,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { fileIconText, formatBytes } from "./web/phone-images";
import { isAllowedExternalUrl } from "./external-url";
import { fileRefTitle, userText } from "./file-refs";
import { InputLabel } from "./InputLabel";
import { skillCommandLength, skillLabel, workModeLabel } from "./input-labels";
import { grantKind } from "./GrantsPage";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { operationForSubjectKind } from "./notify";
import { displayPath } from "./paths";
import { isNetworkPath } from "./side-panel";
import { elapsedText, type SubagentLink } from "./subagent-panel";
import { EnsembleAvatar } from "./EnsembleAvatar";
import {
  currentEnsembleInitKey,
  ensembleAuthorColor,
  ensembleAuthorLabel,
  ensembleMemberMetaLabel,
  ensemblePostHead,
  ensembleReadFilterParts,
  ensembleReadPostsFromOutput,
  ensembleStatusDot,
  ensembleToolSummary,
  partitionEnsemblePermissions,
  splitEnsembleMentions,
} from "./ensemble-ui";
import { parseSuiteThreadReport, suiteReportDotTone } from "./suite-ui";
import { mcpToolLabel, noteItemsFromEntry, noteWriteSummary, toolMeta } from "./tool-meta";
import { TurnChangesCard } from "./TurnChangesCard";
import { TodoList, TodoProgress, todoSummary } from "./TodoList";
import { useReasoning, type ReasoningMap } from "./reasoning";
import { MCP_STATE_NOTICE_CODES } from "./mcp-status";
import { openWarningsToShow } from "./open-warnings";
import { useStickyOutput } from "./useStickyOutput";
import { ShellToolOutput } from "./ShellPane";
import type { ShellSession } from "./use-shell-output";
import { useCopyText } from "./useCopyText";
import { KeyHint } from "./KeyHint";
import {
  buildVirtualOffsets,
  buildVirtualSegments,
  computeVirtualRange,
  DEFAULT_VIEWPORT_HEIGHT,
  findIndexAtOffset,
  isPinnedInlineHtmlEntry,
  type VirtualRange,
} from "./virtual-stream";
import {
  applyConversationHighlights,
  canHandleConversationShortcut,
  clearConversationHighlights,
  extractSelectionPrefill,
  FIND_DEBOUNCE_MS,
  findConversationMatches,
  pickInitialMatchIndex,
  stepMatchIndex,
} from "./conversation-find";
import { ConversationFindBar } from "./ConversationFindBar";
import {
  extractConversationTurns,
  findCurrentTurnIndex,
  MIN_TURNS_FOR_RAIL,
  MIN_WIDTH_FOR_RAIL,
  stepTurnIndex,
} from "./turn-rail";
import { TurnRail } from "./TurnRail";
import { goalCheckFailedItems, goalCheckUnavailableReason, isGoalUnverified } from "./goal-check";
import "./conversation.css";

export { toolMeta };

/**
 * 只读观察（ADR-0060 第 4 轮）：子代理视图只有身份和读图能力，没有任何命令入口。
 * 它不是 RpcSession——不伪造命令句柄，写入口所在的分支靠 isLiveSession 排除。
 */
export interface ReadOnlySessionRef {
  readonly id: string;
  readonly readOnly: true;
  readAttachment: RpcSession["readAttachment"];
}

/** 只读渲染开关：缺省（undefined）时主对话与手机的行为和渲染完全不变 */
export interface ReadOnlyMode {
  /**
   * 日志未收束或观察已结束而没有终止事实：停止转圈与计时，仍在 running 的工具行标「未收束」，
   * 但不伪造任何 reducer 事件
   */
  frozen: boolean;
  /** 接在时间线末尾、随对话一起滚动的内容（子代理的最终结果）；只读视图只有这一个滚动区 */
  footer?: ReactNode;
  /** 父会话转发的实时待决权限卡片（由 SubagentPane 从父视图传入） */
  requests?: ReactNode;
}

/** 父对话 task 行的「在面板中查看」（ADR-0060 第 6 节）；手机不传，只读视图里嵌套的 task 也不传 */
export interface SubagentLinks {
  link: (entry: ToolEntry) => SubagentLink;
  open: (childSessionId: string) => void;
  diff?: (childSessionId: string, file: string) => void;
}

export function isLiveSession(session: RpcSession | ReadOnlySessionRef): session is RpcSession {
  return !("readOnly" in session && session.readOnly);
}

export interface ConversationProps {
  skills?: readonly SkillOverview[] | undefined;
  session: RpcSession;
  /** task 行的「在面板中查看」；缺省不显示（手机不传） */
  subagentLinks?: SubagentLinks | undefined;
  view: SessionView;
  openUrl: (url: string) => void;
  /** 会话工作区（工具行与权限主体里的路径相对化） */
  cwd: string;
  /** 会话生效 Shell 种类（权限主体行前缀） */
  shellKind?: string | undefined;
  /** 本会话历史 permission.requested 的 callId → 是否带 ruleSuggestion（Core 证据） */
  ruleEligibleCalls?: ReadonlyMap<string, boolean> | undefined;
  /** 本会话的事件订阅（思考时长簿记；tracker 之外的第二个订阅点） */
  subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void;
  images: AttachmentImageSource;
  /** 非空闲（Turn 进行中 / 等待确认）时禁用重发与编辑重发（U-01） */
  busy: boolean;
  /**
   * 重发一条用户消息：先 rewind(targetSeq, mode) 再 submit（Conversations.resubmit）。
   * 用户提交的执行方式消息带 workMode 重发（ADR-0076 §1）；附件随重发带上。
   */
  onResubmit?:
    | ((
        targetSeq: number,
        text: string,
        mode: RewindMode,
        workMode?: WorkModeName,
        quotes?: MessageQuote[],
        attachments?: SubmitAttachment[],
      ) => Promise<void>)
    | undefined;
  /** 编辑重发时的附件选择入口（桌面由外壳提供；缺省时使用浏览器文件选择） */
  pickImages?: (() => Promise<PickedImage[]>) | undefined;
  /** 选中消息文字点「回复」时回调（ADR-0116；仅桌面端主会话传入） */
  onQuote?: ((quote: MessageQuote) => void) | undefined;
  /** 批准当前计划（ADR-0076 §5、§7）：在计划模式且空闲时显示在最后一条助手消息下方 */
  onApprovePlan?: (() => void) | undefined;
  /**
   * 从一条用户消息之前分叉出新会话（runtime.forkSession 的 targetSeq）。
   * 缺省时不显示「分叉」。
   */
  onFork?: ((targetSeq: number) => Promise<void>) | undefined;
  /** 远程会话的页面使用手机全屏确认。 */
  remote?: boolean;
  /** 手机端隐藏持久授权选项；缺省保留桌面行为。 */
  hidePersistentPermissions?: boolean;
  /** 底部面板由手机外壳统一渲染。 */
  hideRequests?: boolean;
  turnChanges?: ReadonlyMap<number, TurnChanges>;
  onRewindFiles?: (seq: number) => Promise<void>;
  loadChangeDiff?: (seq: number, path: string) => Promise<TurnChangeDiff>;
  /** 改动卡片「查看变更」：打开右侧面板的变更标签（ADR-0060）；手机不传 */
  onViewChanges?: ((seq: number) => void) | undefined;
  /**
   * 回答内文件引用的打开能力（U-09，方案 A）：缺省时 codespan 保持普通
   * 行内代码。历史助手消息传入，实时流式消息不传（流式中引用不完整）。
   */
  fileLinks?: FileLinkHooks | undefined;
  /** 会话打开时的警告（`SessionOpened.warnings`），显示在消息流顶部；缺省不显示 */
  openWarnings?: readonly string[] | undefined;
  /** Core 接受前显示在对话末尾的本地用户消息，外观与正式条目相同 */
  localEntries?: readonly UserEntry[] | undefined;
  /** 正式条目 key → 被它替换的本地 id，替换时 React key 保持不变 */
  entryKey?: ((key: string) => string) | undefined;
  /**
   * 定时任务发起的会话：标在第一条用户消息上（ADR-0064）。
   * preface 只在补跑时有，写在气泡正文前面。
   */
  searchTarget?: { sessionId: string; seq?: number | undefined; nonce: number } | undefined;
  scheduleSource?:
    | {
        name: string;
        trigger: "schedule" | "catchup" | "manual";
        preface?: string | undefined;
      }
    | undefined;
  resolveAppIcon?: ((app: ApplicationTarget) => Promise<string | undefined>) | undefined;
  /** 平台接管文件保存（安卓 App）；未传时沿用外层 ImageViewerProvider 或 `<a download>` */
  saveFile?: SaveFileFn | undefined;
  /** 帖子送达头部「作者 → 本会话 · #n」中的本会话显示名：指挥会话默认「指挥」，成员会话传 `@name` */
  ensembleRecipientLabel?: string | undefined;
  /** 点击合奏工具行打开右侧面板的合奏留言板（仅桌面端指挥会话传入） */
  onOpenEnsemble?: (() => void) | undefined;
  /** 点击合奏成员待确认提示行打开该成员的会话标签（仅桌面端指挥会话传入） */
  onOpenEnsembleMember?: ((member: { name: string; childSessionId: string }) => void) | undefined;
  /** 点击组曲汇报行在右侧面板打开对应线程 */
  onOpenSuiteThread?: ((threadId: string) => void) | undefined;
  /** 点击面板页面入口行或内嵌页面「在面板打开」在右侧面板打开对应页面与版本（仅桌面端传入） */
  onOpenPage?: ((page: string, version?: number) => void) | undefined;
  /** 当前右侧面板正在显示的页面与版本号（仅桌面端传入，供入口行高亮选中态） */
  activePage?: { page: string; version: number } | undefined;
  /** 启用消息列表虚拟化（仅手机网页开启，桌面端保持整段渲染） */
  virtualize?: boolean | undefined;
  /** 启用会话内搜索（Ctrl+F，仅桌面端主窗口开启） */
  enableFind?: boolean | undefined;
  /** 启用轮次导航轨与 Alt+↑/↓ 按轮跳转（仅桌面端主窗口开启） */
  enableTurnNav?: boolean | undefined;
  /** 设置或同类覆盖页遮挡主区时为 true：关闭轮次列表并隐藏刻度，同时保留阅读位置 */
  turnNavHidden?: boolean | undefined;
}

/** 回答内文件引用（U-09）：存在性经后台只读接口，打开经宿主能力。 */
export interface FileLinkHooks {
  /**
   * 左键：按"默认打开方式"设置打开（面板与编辑器带行号，系统默认不带）。
   * ref 给面板用：endLine 高亮行范围。
   */
  open: (
    absolutePath: string,
    line?: number,
    ref?: { endLine?: number | undefined },
  ) => Promise<void>;
  /**
   * 工作区外的文件能否左键打开（ADR-0060 修订 2026-10-18）：面板只读查看、编辑器
   * 只是打开，都可以；「系统默认」可能直接运行文件，工作区外仍然只开菜单（ADR-0046）。
   */
  outsideOpenable: () => boolean;
  /** 已检测到的编辑器：右键菜单逐个列出 */
  editors: () => { vscode: boolean; cursor: boolean };
  /** 用指定编辑器打开并跳到行号 */
  openInEditor: (editor: "vscode" | "cursor", absolutePath: string, line?: number) => Promise<void>;
  /** 目录的左键动作：交给系统（资源管理器打开） */
  openFolder: (absolutePath: string) => Promise<void>;
  /** 复制文本（绝对或相对路径） */
  copy: (text: string) => Promise<void>;
  /** 在资源管理器中显示 */
  reveal: (absolutePath: string) => Promise<void>;
  /**
   * 左键会在面板浏览器里打开（工作区内的 HTML、默认打开方式 = 面板）：菜单「打开」写成
   * 浏览器，并多一项「查看源码」。没有时按普通文件处理。
   */
  previewsHtml?: (absolutePath: string) => boolean;
  /** 「查看源码」：在面板的文件标签里打开 */
  viewSource?: (absolutePath: string, line?: number) => Promise<void>;
}

/**
 * 只读观察的 props（子代理标签）：session 换成只读引用，必带 readOnly；没有 onResubmit、onFork、
 * 改动卡片、权限/提问应答等写入口的位置（Omit 掉，类型上就传不进去）。
 */
export type ReadOnlyConversationProps = Omit<
  ConversationProps,
  | "session"
  | "onResubmit"
  | "pickImages"
  | "onQuote"
  | "onApprovePlan"
  | "onFork"
  | "turnChanges"
  | "onRewindFiles"
  | "loadChangeDiff"
  | "onViewChanges"
  | "subagentLinks"
  | "hideRequests"
  | "hidePersistentPermissions"
  | "openWarnings"
> & {
  session: ReadOnlySessionRef;
  /** 只读观察：不挂权限/提问应答卡片，用户消息只读展示，没有编辑、重发、分叉、撤销 */
  readOnly: ReadOnlyMode;
};

/** 内部统一形状：实时对话与只读观察共用同一份渲染 */
type ContentProps = Omit<ConversationProps, "session"> & {
  session: RpcSession | ReadOnlySessionRef;
  readOnly?: ReadOnlyMode | undefined;
};

type OpenUrl = ConversationProps["openUrl"];

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copy, copied, error } = useCopyText();
  return (
    <>
      <button
        type="button"
        className="u-act u-act-icon"
        aria-label={copied ? "已复制" : label}
        title={copied ? "已复制" : label}
        onClick={() => {
          void copy(text);
        }}
      >
        <Icon name={copied ? "check" : "copy_2"} size={ICON_SM} />
      </button>
      {error !== undefined && (
        <span className="conversation-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function replyTime(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 回答内文件引用的解析结果（U-09）：codespan 文本经 splitCodeRef 拆出行号，
 * 路径批量 resolveFiles 后按原文查表。value 为 undefined = 普通行内代码。
 */
export interface ResolvedCodeRef {
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
  absolutePath: string;
  relativePath?: string | undefined;
  withinWorkspace: boolean;
  exists: boolean;
  isDirectory: boolean;
}

const FileLinksContext = createContext<{
  lookup: (codeText: string) => ResolvedCodeRef | undefined;
  hooks: FileLinkHooks;
} | null>(null);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const effectiveToolName = (entry: ToolEntry): string => entry.target?.name ?? entry.name ?? "";
const rawInputOf = (entry: ToolEntry): unknown =>
  entry.target !== undefined ? entry.target.input : entry.input;
const inputOf = (entry: ToolEntry): Record<string, unknown> | undefined => {
  const raw = rawInputOf(entry);
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
};

/**
 * 文件引用收集与渲染共用的解析选项（两处 token 流必须一致）。
 * `breaks` 让段落内的单个换行按聊天惯例显示为换行，而不是被
 * CommonMark 软换行折叠成空格；多出的 br token 由 markdownNodes 渲染。
 */
const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

/**
 * 表格短格（源文本不超过 10 个半角宽，全角算 2）：整格不换行，窄屏不再逐字折开。
 * 只抬高这一列的最小宽度，不改它的自然宽度，宽窗口下列宽分配与原来一样。
 */
function isShortTableCell(source: string): boolean {
  let width = 0;
  for (const char of source.trim()) {
    width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
    if (width > 10) return false;
  }
  return true;
}

function renderEnsembleTextNode(text: string, mentions: readonly string[] | undefined): ReactNode {
  if (mentions === undefined || mentions.length === 0) return text;
  const parts = splitEnsembleMentions(text, mentions);
  if (parts.length === 1 && parts[0]?.kind === "text") return text;
  return parts.map((part, index) =>
    part.kind === "mention" ? (
      <span key={index} className="ensemble-at">
        {part.value}
      </span>
    ) : (
      <Fragment key={index}>{part.value}</Fragment>
    ),
  );
}

/** 判断 marked 产出的代码块围栏是否已闭合；缩进块和未闭合围栏在流式输出时不启动解析。 */
export function isClosedCodeFence(code: Tokens.Code): boolean {
  if (code.codeBlockStyle === "indented") return false;
  const open = /^ {0,3}(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*)$/.exec(code.raw);
  if (open?.[1] === undefined || open[2] === undefined) return false;
  const fence = open[1];
  const body = open[2].replace(/\r?\n$/, "");
  const lastNewline = body.lastIndexOf("\n");
  const lastLine = lastNewline < 0 ? body : body.slice(lastNewline + 1);
  return new RegExp(`^ {0,3}${fence}[~` + "`" + `]* *$`).test(lastLine);
}

const WRAP_CODE_LANGUAGES = new Set(["", "markdown", "md", "text", "txt", "plaintext"]);

/** 文字类或未写语言的代码块自动换行，其余代码语言保持横向滚动。 */
export function shouldWrapCodeBlock(lang: string): boolean {
  const token = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return WRAP_CODE_LANGUAGES.has(token);
}

const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  lang,
  text: codeText,
  closed,
}: {
  lang: string;
  text: string;
  closed: boolean;
}) {
  const ref = useCodeHighlight<HTMLElement>(undefined, codeText, "text", {
    language: lang,
    enabled: closed,
  });
  const wrap = shouldWrapCodeBlock(lang);
  return (
    <div className={wrap ? "conversation-code wrap" : "conversation-code"}>
      <div className="conversation-code-language">
        <span>{lang}</span>
        <CopyButton text={codeText} label="复制代码" />
      </div>
      <pre>
        <code ref={ref}>{codeText}</code>
      </pre>
    </div>
  );
});

/** Only lexer tokens become React elements. Raw HTML and remote images stay inert text. */
function markdownNodes(
  tokens: readonly Token[],
  openUrl: OpenUrl,
  mentions?: readonly string[],
): ReactNode[] {
  return tokens.map((token, index) => {
    const key = index;
    switch (token.type) {
      case "space":
      case "def":
        return null;
      case "html":
        return <Fragment key={key}>{token.raw}</Fragment>;
      case "heading": {
        const heading = token as Tokens.Heading;
        const content = markdownNodes(heading.tokens, openUrl, mentions);
        switch (heading.depth) {
          case 1:
            return <h1 key={key}>{content}</h1>;
          case 2:
            return <h2 key={key}>{content}</h2>;
          case 3:
            return <h3 key={key}>{content}</h3>;
          case 4:
            return <h4 key={key}>{content}</h4>;
          case 5:
            return <h5 key={key}>{content}</h5>;
          default:
            return <h6 key={key}>{content}</h6>;
        }
      }
      case "paragraph":
        return (
          <p key={key}>{markdownNodes((token as Tokens.Paragraph).tokens, openUrl, mentions)}</p>
        );
      case "text": {
        const node = token as Tokens.Text;
        return (
          <Fragment key={key}>
            {node.tokens
              ? markdownNodes(node.tokens, openUrl, mentions)
              : renderEnsembleTextNode(node.text, mentions)}
          </Fragment>
        );
      }
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case "strong":
        return (
          <strong key={key}>
            {markdownNodes((token as Tokens.Strong).tokens, openUrl, mentions)}
          </strong>
        );
      case "em":
        return <em key={key}>{markdownNodes((token as Tokens.Em).tokens, openUrl, mentions)}</em>;
      case "del":
        return (
          <del key={key}>{markdownNodes((token as Tokens.Del).tokens, openUrl, mentions)}</del>
        );
      case "codespan":
        return <CodeRef key={key} text={(token as Tokens.Codespan).text} />;
      case "code": {
        const code = token as Tokens.Code;
        return (
          <MarkdownCodeBlock
            key={key}
            lang={code.lang ?? ""}
            text={code.text}
            closed={isClosedCodeFence(code)}
          />
        );
      }
      case "blockquote":
        return (
          <blockquote key={key}>
            {markdownNodes((token as Tokens.Blockquote).tokens, openUrl, mentions)}
          </blockquote>
        );
      case "hr":
        return <hr key={key} />;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const content = markdownNodes(link.tokens, openUrl, mentions);
        return isAllowedExternalUrl(link.href) ? (
          <a
            key={key}
            href={link.href}
            title={link.title ?? undefined}
            onClick={(event) => {
              event.preventDefault();
              openUrl(link.href);
            }}
          >
            {content}
          </a>
        ) : (
          <span key={key}>{content}</span>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        return (
          <span key={key} className="conversation-image-ref">
            图片：{image.text || image.href}
          </span>
        );
      }
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {item.task ? (
              <Checkbox
                checked={item.checked === true}
                disabled
                aria-label="任务完成状态"
                onChange={() => undefined}
              />
            ) : null}
            {markdownNodes(item.tokens, openUrl, mentions)}
          </li>
        ));
        return list.ordered ? (
          <ol key={key} start={typeof list.start === "number" ? list.start : 1}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <div key={key} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {table.header.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      scope="col"
                      className={cell.align === "right" ? "r" : undefined}
                      style={{ textAlign: cell.align ?? "left" }}
                    >
                      {markdownNodes(cell.tokens, openUrl, mentions)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={
                          [
                            cell.align === "right" ? "r" : undefined,
                            isShortTableCell(cell.text) ? "short" : undefined,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                        style={cell.align ? { textAlign: cell.align } : undefined}
                      >
                        {markdownNodes(cell.tokens, openUrl, mentions)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      default:
        return <Fragment key={key}>{token.raw}</Fragment>;
    }
  });
}

export function Markdown({
  text: markdown,
  openUrl,
  session,
  fileLinks,
  mentions,
  quoteSourceSeq,
}: {
  text: string;
  openUrl: OpenUrl;
  session?: RpcSession | undefined;
  fileLinks?: FileLinkHooks | undefined;
  mentions?: readonly string[] | undefined;
  quoteSourceSeq?: string | undefined;
}) {
  const [refs, setRefs] = useState<Map<string, ResolvedCodeRef> | null>(null);
  useEffect(() => {
    if (session === undefined || fileLinks === undefined) {
      setRefs(null);
      return;
    }
    let alive = true;
    // 收集本消息 codespan 里的候选路径，一次批量 resolveFiles。网络路径不链接化，
    // 也不送去判断存在性（ADR-0060 修订 2026-10-18；Core 侧同样拦截）
    const paths: string[] = [];
    const seen = new Set<string>();
    const collect = (tokens: readonly Token[]) => {
      for (const token of tokens) {
        if (token.type === "codespan") {
          const split = splitCodeRef((token as Tokens.Codespan).text);
          if (split !== undefined && !seen.has(split.path) && !isNetworkPath(split.path)) {
            seen.add(split.path);
            paths.push(split.path);
          }
        }
        const inner = (token as { tokens?: readonly Token[] }).tokens;
        if (inner !== undefined) collect(inner);
        if (token.type === "table") {
          for (const row of (token as Tokens.Table).rows) {
            for (const cell of row) collect(cell.tokens);
          }
        }
        if (token.type === "list") {
          for (const item of (token as Tokens.List).items) collect(item.tokens);
        }
      }
    };
    collect(marked.lexer(markdown, MARKED_OPTIONS));
    if (paths.length === 0) {
      setRefs(new Map());
      return;
    }
    session
      .resolveFiles(paths)
      .then((resolutions) => {
        if (!alive) return;
        const table = new Map<string, ResolvedCodeRef>();
        for (const resolution of resolutions) {
          const split = splitCodeRef(resolution.input);
          // 原文查表：CodeRef 用 codespan 全文（含行号）查，这里按路径回填
          table.set(resolution.input, {
            path: resolution.input,
            ...(split?.line !== undefined ? { line: split.line } : {}),
            ...(split?.endLine !== undefined ? { endLine: split.endLine } : {}),
            absolutePath: resolution.absolutePath,
            ...(resolution.relativePath !== undefined
              ? { relativePath: resolution.relativePath }
              : {}),
            withinWorkspace: resolution.withinWorkspace,
            exists: resolution.exists,
            isDirectory: resolution.isDirectory,
          });
        }
        setRefs(table);
      })
      .catch(() => {
        if (alive) setRefs(new Map());
      });
    return () => {
      alive = false;
    };
  }, [session, fileLinks, markdown]);
  const lookup = useMemo(() => {
    if (refs === null || fileLinks === undefined) return null;
    return {
      hooks: fileLinks,
      lookup: (codeText: string): ResolvedCodeRef | undefined => {
        const split = splitCodeRef(codeText);
        if (split === undefined) return undefined;
        const hit = refs.get(split.path);
        if (hit?.exists !== true) return undefined;
        return {
          ...hit,
          ...(split.line !== undefined ? { line: split.line } : {}),
          ...(split.endLine !== undefined ? { endLine: split.endLine } : {}),
        };
      },
    };
  }, [refs, fileLinks]);
  return (
    <div className="conversation-markdown" data-quote-source-seq={quoteSourceSeq}>
      <FileLinksContext.Provider value={lookup}>
        {markdownNodes(marked.lexer(markdown, MARKED_OPTIONS), openUrl, mentions)}
      </FileLinksContext.Provider>
    </div>
  );
}

/**
 * 行内代码的文件引用（U-09）：存在的文件渲染成「类型图标 + 路径」链接。
 * 工作区内：左键按"默认打开方式"设置打开（目录交给系统），右键开菜单
 * （打开、资源管理器、检测到的编辑器、复制绝对/相对路径）。工作区外的文件：
 * 「默认打开方式」是面板或编辑器时左键同样打开，菜单多一项「打开」；是系统默认时
 * 左右键都只开菜单（资源管理器与复制绝对路径）。工作区外的目录只开菜单。
 * 不存在、网络路径 → 普通行内代码。
 */
function CodeRef({ text }: { text: string }) {
  const context = useContext(FileLinksContext);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (context === null) return <code>{text}</code>;
  const hit = context.lookup(text);
  if (hit === undefined) return <code>{text}</code>;
  const { hooks } = context;
  const canOpen = hit.withinWorkspace || (!hit.isDirectory && hooks.outsideOpenable());
  const editors = hooks.editors();
  const run = (action: () => Promise<void>) => {
    setAnchor(null);
    setError(null);
    void action().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  const openDefault = () =>
    hit.isDirectory
      ? hooks.openFolder(hit.absolutePath)
      : hooks.open(hit.absolutePath, hit.line, { endLine: hit.endLine });
  const relative = hit.relativePath;
  const viewSource = hooks.viewSource;
  const preview =
    !hit.isDirectory && viewSource !== undefined && hooks.previewsHtml?.(hit.absolutePath) === true;
  const activate = (target: HTMLElement) => {
    if (canOpen) run(openDefault);
    else setAnchor(target);
  };
  return (
    <>
      {/* span 而不是 button：button 再设 display:inline 也是原子行内块，长路径整块掉到下一行 */}
      <span
        role="button"
        tabIndex={0}
        className="file-ref-link"
        title={hit.absolutePath}
        onClick={(event) => {
          activate(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate(event.currentTarget);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setError(null);
          setAnchor(event.currentTarget);
        }}
      >
        <FileGlyph directory={hit.isDirectory} />
        <span className="file-ref-text">{text}</span>
      </span>
      {anchor !== null && (
        <Menu
          anchor={anchor}
          label={text}
          onClose={() => {
            setAnchor(null);
          }}
        >
          {canOpen && (
            <>
              <MenuItem
                label="打开"
                onSelect={() => {
                  run(openDefault);
                }}
              />
              {preview && (
                <MenuItem
                  label="查看源码"
                  onSelect={() => {
                    run(() => viewSource(hit.absolutePath, hit.line));
                  }}
                />
              )}
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={<MenuGlyph kind="folder" />}
            label={isMacOS() ? "访达" : "资源管理器"}
            onSelect={() => {
              run(() => hooks.reveal(hit.absolutePath));
            }}
          />
          {hit.withinWorkspace && !hit.isDirectory && editors.vscode && (
            <MenuItem
              icon={<MenuGlyph kind="editor" />}
              label="VS Code"
              onSelect={() => {
                run(() => hooks.openInEditor("vscode", hit.absolutePath, hit.line));
              }}
            />
          )}
          {hit.withinWorkspace && !hit.isDirectory && editors.cursor && (
            <MenuItem
              icon={<MenuGlyph kind="editor" />}
              label="Cursor"
              onSelect={() => {
                run(() => hooks.openInEditor("cursor", hit.absolutePath, hit.line));
              }}
            />
          )}
          <MenuSeparator />
          <MenuItem
            icon={<MenuGlyph kind="copy" />}
            label="复制绝对路径"
            onSelect={() => {
              run(() => hooks.copy(hit.absolutePath));
            }}
          />
          {relative !== undefined && (
            <MenuItem
              icon={<MenuGlyph kind="copy" />}
              label="复制相对路径"
              onSelect={() => {
                run(() => hooks.copy(relative));
              }}
            />
          )}
        </Menu>
      )}
      {error !== null && (
        <span className="file-ref-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** 文件引用前的类型图标：文件 / 目录 */
function FileGlyph({ directory }: { directory: boolean }) {
  return <Icon name={directory ? "folder" : "file"} size={ICON_SM} className="file-ref-glyph" />;
}

/** 文件引用菜单的通用图标（不用编辑器商标） */
function MenuGlyph({ kind }: { kind: "folder" | "editor" | "copy" }) {
  return (
    <Icon
      name={kind === "folder" ? "folder" : kind === "editor" ? "code" : "copy_2"}
      size={ICON_SM}
    />
  );
}

/**
 * 消息流与思考块之间的滚动协作：思考块要知道一屏多高（决定是否显示底部「收起思考」），
 * 收起后由消息流决定怎么滚（跟随最新时保持在底部，否则把标题行滚回视野）。
 */
interface ThinkScroll {
  viewportHeight: () => number;
  collapsed: (header: HTMLElement) => void;
}

const ThinkScrollContext = createContext<ThinkScroll>({
  viewportHeight: () => Number.POSITIVE_INFINITY,
  collapsed: () => undefined,
});

/** 只读且日志未收束：工具行停止转圈与计时（ReadOnlyMode.frozen） */
const FrozenContext = createContext(false);
const MessageSkillsContext = createContext<readonly SkillOverview[] | undefined>(undefined);
const ShellSessionContext = createContext<ShellSession | undefined>(undefined);
const BackgroundViewContext = createContext<
  Pick<SessionView, "entries" | "backgroundShells" | "pendingSubagentPermissions" | "pages">
>({
  entries: [],
  backgroundShells: [],
  pendingSubagentPermissions: [],
  pages: [],
});
const SubagentLinksContext = createContext<SubagentLinks | null>(null);

interface PageRowContextValue {
  remote?: boolean | undefined;
  onOpenPage?: ((page: string, version?: number) => void) | undefined;
  activePage?: { page: string; version: number } | undefined;
}
const PageRowContext = createContext<PageRowContextValue | null>(null);

interface EnsembleRowContextValue {
  ensemble: EnsembleView | undefined;
  currentInitKey: string | undefined;
  onOpen: () => void;
}
const EnsembleRowContext = createContext<EnsembleRowContextValue | null>(null);

interface EntryUiStateStore {
  getToggle: (key: string) => boolean | undefined;
  setToggle: (key: string, value: boolean) => void;
  getRecord: (key: string) => Record<string, boolean> | undefined;
  setRecord: (key: string, value: Record<string, boolean>) => void;
}

const EntryUiStateContext = createContext<EntryUiStateStore | null>(null);

function usePersistedToggle(
  persistKey: string,
  initial: boolean,
): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const store = useContext(EntryUiStateContext);
  const [value, setValue] = useState<boolean>(() => store?.getToggle(persistKey) ?? initial);
  const setPersisted = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        store?.setToggle(persistKey, resolved);
        return resolved;
      });
    },
    [store, persistKey],
  );
  return [value, setPersisted];
}

function usePersistedRecord(
  persistKey: string,
): [
  Record<string, boolean>,
  (
    next: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>),
  ) => void,
] {
  const store = useContext(EntryUiStateContext);
  const [value, setValue] = useState<Record<string, boolean>>(
    () => store?.getRecord(persistKey) ?? {},
  );
  const setPersisted = useCallback(
    (
      next:
        Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>),
    ) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        store?.setRecord(persistKey, resolved);
        return resolved;
      });
    },
    [store, persistKey],
  );
  return [value, setPersisted];
}

function durationText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} 秒`;
  const rest = seconds % 60;
  return `${String(Math.floor(seconds / 60))} 分${rest > 0 ? ` ${String(rest)} 秒` : ""}`;
}

const THINK_PHRASE_FADE_MS = 200;
const SHIMMER_ANIMATION_NAME = "nct-shimmer";

/** 将思考流光动画对齐到同一时间原点（document.timeline 0ms），避免切换文案时跳回第 0 帧。 */
function syncShimmerPhase(root: Element | null): void {
  if (root === null || typeof root.getAnimations !== "function") return;
  for (const anim of root.getAnimations({ subtree: true })) {
    if (
      "animationName" in anim &&
      anim.animationName === SHIMMER_ANIMATION_NAME &&
      anim.startTime !== 0
    ) {
      anim.startTime = 0;
    }
  }
}

/** 思考进行中文案切换槽：允许动效时 200ms 淡入淡出，禁用动效时直接替换。 */
function ThinkPhrase({
  phrase,
  animate,
  shimmer,
}: {
  phrase: string;
  animate: boolean;
  shimmer: boolean;
}) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const [transition, setTransition] = useState<{
    current: string;
    exiting?: string;
    animated: boolean;
  }>({ current: phrase, animated: false });

  if (transition.current !== phrase) {
    setTransition({
      current: phrase,
      ...(animate ? { exiting: transition.current, animated: true } : { animated: false }),
    });
  }

  useEffect(() => {
    if (transition.exiting === undefined) return;
    if (!animate) {
      setTransition((prev) =>
        prev.exiting === undefined ? prev : { current: prev.current, animated: false },
      );
      return;
    }
    const timer = setTimeout(() => {
      setTransition((prev) =>
        prev.exiting === undefined ? prev : { current: prev.current, animated: false },
      );
    }, THINK_PHRASE_FADE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [transition.exiting, transition.current, animate]);

  useLayoutEffect(() => {
    if (!shimmer || !animate || transition.exiting === undefined) return;
    syncShimmerPhase(slotRef.current);
  }, [shimmer, animate, transition.exiting, transition.current]);

  const inClass = `think-phrase-layer${transition.animated && animate ? " think-phrase-in" : ""}`;
  if (transition.exiting === undefined || !animate) {
    return <>{transition.current}</>;
  }
  return (
    <span ref={slotRef} className="think-phrase-slot" aria-hidden="true">
      <span key={`out:${transition.exiting}`} className="think-phrase-layer think-phrase-out">
        <span className={shimmer ? "shim" : undefined}>{transition.exiting}</span>
      </span>
      <span key={transition.current} className={inClass}>
        <span className={shimmer ? "shim" : undefined}>{transition.current}</span>
      </span>
    </span>
  );
}

function Think({
  messageId,
  text: reasoning,
  parts,
  now,
}: {
  messageId: string;
  text: string;
  parts: ReasoningMap;
  now: number;
}) {
  const scroll = useContext(ThinkScrollContext);
  const frozen = useContext(FrozenContext);
  const motion = useMotionAllowed();
  const [open, setOpen] = usePersistedToggle(`think:${messageId}`, false);
  const [tall, setTall] = useState(false);
  const header = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const reveal = useRef(false);
  const part = parts.get(messageId)?.at(-1);
  const body = reasoning !== "" ? reasoning : (part?.text ?? "");
  const active = part?.active === true;
  const shimmer = !frozen && active && motion;
  const hasBody = body !== "";

  useLayoutEffect(() => {
    if (!shimmer) return;
    syncShimmerPhase(labelRef.current);
  }, [shimmer, hasBody]);

  // 展开时量一次：思考不到一屏就不显示底部「收起思考」，只用标题行
  useLayoutEffect(() => {
    if (!open) {
      setTall(false);
      return;
    }
    const el = bodyRef.current;
    if (el !== null) setTall(el.scrollHeight > scroll.viewportHeight());
  }, [open, body, scroll]);

  // 收起后再滚：此时块已经变矮，标题行回到正常流里
  useLayoutEffect(() => {
    if (open || !reveal.current) return;
    reveal.current = false;
    if (header.current !== null) scroll.collapsed(header.current);
  }, [open, scroll]);

  if (reasoning === "" && part === undefined) return null;
  const seconds =
    part?.started === undefined
      ? 0
      : Math.max(0, Math.floor(((part.active ? now : (part.ended ?? now)) - part.started) / 1000));
  const animatePhrase = !frozen && motion;
  const rotating = active && seconds >= 1;
  const phrase = rotating ? thinkingPhrase(part.started, now) : undefined;
  const srStatus = rotating ? (
    <span className="sr-only" aria-live="polite">
      思考中
    </span>
  ) : null;
  const label =
    seconds < 1 ? (
      "思考"
    ) : phrase !== undefined ? (
      <>
        <ThinkPhrase phrase={phrase} animate={animatePhrase} shimmer={shimmer} />
        {` ${seconds}s`}
      </>
    ) : (
      `思考了 ${seconds}s`
    );
  if (body === "") {
    return (
      <div className="think">
        {srStatus}
        <span
          ref={labelRef}
          className={`think-label${shimmer ? " shim" : ""}`}
          aria-hidden={rotating ? true : undefined}
        >
          {label}
        </span>
      </div>
    );
  }
  const openLabel =
    seconds < 1 ? (
      "思考"
    ) : (
      <>
        {phrase !== undefined ? (
          <ThinkPhrase phrase={phrase} animate={animatePhrase} shimmer={shimmer} />
        ) : (
          "思考"
        )}
        <span className="muted-value">{durationText(seconds)}</span>
      </>
    );
  const collapse = () => {
    reveal.current = true;
    setOpen(false);
  };
  return (
    <div className={`think${open ? " open" : ""}`}>
      <button
        ref={header}
        type="button"
        className="think-h"
        aria-expanded={open}
        title={open ? "收起思考" : "展开思考"}
        onClick={() => {
          if (open) collapse();
          else setOpen(true);
        }}
      >
        {srStatus}
        <span
          ref={labelRef}
          className={`think-label${shimmer ? " shim" : ""}`}
          aria-hidden={rotating ? true : undefined}
        >
          {open ? openLabel : label}
        </span>
        <span className="think-tw" aria-hidden="true">
          <Icon name="right_small" size={ICON_SM} className={`fold-arrow${open ? " up" : ""}`} />
        </span>
      </button>
      {open && (
        <>
          <pre ref={bodyRef}>{body}</pre>
          {tall && (
            <div className="think-end">
              <button type="button" onClick={collapse}>
                <Icon name="right_small" size={ICON_SM} className="fold-arrow up" /> 收起思考
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ImageIcon() {
  return <Icon name="pic" size={ICON_SM} />;
}

/**
 * 工具结果里的截图（第 5 轮）：桌面内置浏览器返回的 PNG 走工具附件，
 * 和用户消息里的图片共用窗口级缓存；只在这里显示缩略图，不重复进上下文。
 */
function ToolImage({
  index,
  attachment,
  images,
  session,
  slots,
  onOpen,
}: {
  index: number;
  attachment: ImageAttachment;
  images: AttachmentImageSource;
  session: Pick<RpcSession, "readAttachment">;
  slots: Map<number, string>;
  onOpen: (index: number, opener: HTMLElement) => void;
}) {
  const [url, setUrl] = useState<string | undefined>(() => images.url(attachment));
  const [error, setError] = useState<string>();
  useEffect(() => {
    // 手机远程没有本地图片缓存：和用户图一样只留占位，不把截图字节拉过远程通道
    if (url !== undefined || images.placeholder) return;
    let active = true;
    void images.load(attachment, session).then(
      (loaded) => {
        if (active) setUrl(loaded);
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [attachment, images, session, url]);
  useEffect(
    () => () => {
      slots.delete(index);
    },
    [index, slots],
  );
  if (!images.placeholder && error === undefined && url !== undefined) {
    slots.set(index, url);
  } else {
    slots.delete(index);
  }
  if (images.placeholder) {
    return (
      <span className="u-img-chip" title={attachment.file}>
        <ImageIcon />
        {images.placeholder}
      </span>
    );
  }
  if (error !== undefined) {
    return (
      <span className="u-img-chip" title={`截图加载失败：${error}`}>
        <ImageIcon />
        {attachment.file}
      </span>
    );
  }
  if (url !== undefined) {
    const alt = attachment.label ?? attachment.file;
    return (
      <button
        type="button"
        className="u-img-frame tool-shot"
        aria-label={alt}
        onClick={(event) => {
          onOpen(index, event.currentTarget);
        }}
      >
        <img
          className="u-img"
          src={url}
          alt={alt}
          onError={() => {
            setError("图片无法解码或显示");
          }}
        />
      </button>
    );
  }
  return (
    <span className="u-img-placeholder" role="status" aria-label={`加载截图：${attachment.file}`}>
      <ImageIcon />
    </span>
  );
}

function ToolShots({
  attachments,
  images,
  session,
}: {
  attachments: readonly ImageAttachment[];
  images?: AttachmentImageSource | undefined;
  session?: Pick<RpcSession, "readAttachment"> | undefined;
}) {
  const openViewer = useImageViewer();
  const slotsRef = useRef<Map<number, string>>(new Map());
  if (attachments.length === 0) return null;
  if (images === undefined || session === undefined) {
    return (
      <div className="tool-shots">
        {attachments.map((attachment, index) => (
          <span key={index} className="u-img-chip">
            <ImageIcon />
            {attachment.label ?? attachment.file}
          </span>
        ))}
      </div>
    );
  }
  const openAt = (clickedIndex: number, opener: HTMLElement) => {
    const items: ViewerImageItem[] = [];
    let initialIndex = 0;
    attachments.forEach((att, idx) => {
      const src = slotsRef.current.get(idx);
      if (src === undefined) return;
      if (idx === clickedIndex) initialIndex = items.length;
      const name = att.label ?? att.file;
      items.push({ src, filename: name, alt: name, blob: images.blob?.(att) });
    });
    openViewer(items, initialIndex, opener);
  };
  return (
    <div className="tool-shots">
      {attachments.map((attachment, index) => (
        <ToolImage
          key={index}
          index={index}
          attachment={attachment}
          images={images}
          session={session}
          slots={slotsRef.current}
          onOpen={openAt}
        />
      ))}
    </div>
  );
}

function UserImage({
  index,
  attachment,
  images,
  session,
  visible,
  slots,
  onOpen,
}: {
  index: number;
  attachment: ImageAttachment;
  images: AttachmentImageSource;
  session: Pick<RpcSession, "readAttachment">;
  visible: boolean;
  slots: Map<number, string>;
  onOpen: (index: number, opener: HTMLElement) => void;
}) {
  // 本地消息的预览图立即显示；历史图片照旧进入可视区才取（命中缓存也一样）
  const eager = visible || attachment.sha256.startsWith("local:");
  const known = eager ? images.url(attachment) : undefined;
  const [url, setUrl] = useState<string | undefined>(known);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const immediate = eager ? images.url(attachment) : undefined;
    if (immediate !== undefined) {
      setUrl(immediate);
      setError(undefined);
      return;
    }
    if (!visible || images.placeholder) return;
    let active = true;
    void images.load(attachment, session).then(
      (loaded) => {
        if (active) setUrl(loaded);
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [attachment, eager, images, session, visible]);
  useEffect(
    () => () => {
      slots.delete(index);
    },
    [index, slots],
  );
  if (!images.placeholder && error === undefined && url !== undefined) {
    slots.set(index, url);
  } else {
    slots.delete(index);
  }
  if (images.placeholder) return <span className="u-img-chip">{images.placeholder}</span>;
  if (error !== undefined) {
    return (
      <span className="u-img-chip" title={`图片加载失败：${error}`}>
        <ImageIcon />
        {images.showErrors
          ? error
          : attachment.sha256.startsWith("local:")
            ? (attachment.label ?? attachment.file)
            : attachment.file}
      </span>
    );
  }
  if (url !== undefined) {
    const alt = attachment.label ?? attachment.file;
    return (
      <button
        type="button"
        className="u-img-frame"
        aria-label={alt}
        onClick={(event) => {
          onOpen(index, event.currentTarget);
        }}
      >
        <img
          className="u-img"
          src={url}
          alt={alt}
          onError={() => {
            setError("图片无法解码或显示");
          }}
        />
      </button>
    );
  }
  return (
    <span
      className="u-img-placeholder"
      role="status"
      aria-label={`加载图片：${attachment.file}`}
      aria-busy={visible}
      title={visible ? "图片加载中…" : undefined}
    >
      <ImageIcon />
    </span>
  );
}

function UserImages({
  attachments,
  images,
  session,
  visible,
}: {
  attachments: readonly ImageAttachment[];
  images: AttachmentImageSource;
  session: Pick<RpcSession, "readAttachment">;
  visible: boolean;
}) {
  const openViewer = useImageViewer();
  const slotsRef = useRef<Map<number, string>>(new Map());
  if (attachments.length === 0) return null;
  const openAt = (clickedIndex: number, opener: HTMLElement) => {
    const items: ViewerImageItem[] = [];
    let initialIndex = 0;
    attachments.forEach((att, idx) => {
      const src = slotsRef.current.get(idx);
      if (src === undefined) return;
      if (idx === clickedIndex) initialIndex = items.length;
      const name = att.label ?? att.file;
      items.push({ src, filename: name, alt: name, blob: images.blob?.(att) });
    });
    openViewer(items, initialIndex, opener);
  };
  return (
    <>
      {attachments.map((attachment, index) => (
        <UserImage
          key={`${attachment.file}:${attachment.sha256}:${index}`}
          index={index}
          attachment={attachment}
          images={images}
          session={session}
          visible={visible}
          slots={slotsRef.current}
          onOpen={openAt}
        />
      ))}
    </>
  );
}

/**
 * 用户消息（U-01）：悬停显示「复制」「编辑并重发」「重发」「分叉」四个图标按钮。重发与编辑重发
 * 先 rewind 再 submit——成功前旧回复保持显示（编辑中变暗，见 .u.editing ~ *）。
 */
function UserMessage({
  entry,
  searchHit = false,
  images,
  session,
  cwd,
  busy,
  repliesAfter,
  onResubmit,
  pickImages,
  onFork,
  scheduleSource,
  fileLinks,
  quoteFlash = false,
  quoteFlashMode,
  availableSeqs,
  onJumpQuote,
  quotable = false,
}: {
  fileLinks?: FileLinkHooks | undefined;
  entry: UserEntry;
  searchHit?: boolean;
  images: AttachmentImageSource;
  session: RpcSession | ReadOnlySessionRef;
  cwd: string;
  busy: boolean;
  /** 这条消息之后将被撤回的回复轮数（助手 turn 数） */
  repliesAfter: number;
  onResubmit: ConversationProps["onResubmit"];
  pickImages?: ConversationProps["pickImages"];
  onFork?: ConversationProps["onFork"];
  scheduleSource?: ConversationProps["scheduleSource"];
  quoteFlash?: boolean;
  quoteFlashMode?: "message" | "text" | undefined;
  availableSeqs?: ReadonlySet<number> | undefined;
  onJumpQuote?: ((quote: MessageQuote) => void) | undefined;
  quotable?: boolean;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const editPasteNumber = useRef(1);
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editAttachments, setEditAttachments] = useState<DraftAttachment[]>([]);
  const editAttachmentsRef = useRef<DraftAttachment[]>([]);
  editAttachmentsRef.current = editAttachments;
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"both" | "conversation">("both");
  const [target, setTarget] = useState<RewindTarget | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fileSaveErrors, setFileSaveErrors] = useState<Record<string, string | undefined>>({});
  const [confirmFork, setConfirmFork] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const skills = useContext(MessageSkillsContext);
  const saveFile = useSaveFile();
  const { copy, copied } = useCopyText(setError);
  useEffect(
    () => () => {
      revokeDraftAttachments(editAttachmentsRef.current);
    },
    [],
  );
  const replaceEditAttachments = useCallback((files: readonly NewAttachmentFile[]) => {
    setEditAttachments((current) => {
      revokeDraftAttachments(current);
      return createDraftAttachments(files);
    });
  }, []);
  const addEditAttachments = useCallback((files: readonly NewAttachmentFile[]) => {
    const added = createDraftAttachments(files);
    if (added.length > 0) setEditAttachments((current) => [...current, ...added]);
  }, []);
  const removeEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => {
      const removed = current[index];
      if (removed !== undefined) URL.revokeObjectURL(removed.url);
      return current.filter((_, i) => i !== index);
    });
  }, []);
  const closeEdit = useCallback(() => {
    replaceEditAttachments([]);
    setDragOver(false);
    setEditing(false);
    setError(undefined);
  }, [replaceEditAttachments]);
  const growEditTextarea = useCallback(() => {
    const field = editTextareaRef.current;
    if (field === null) return;
    const computed = getComputedStyle(field);
    const lineHeight = parseFloat(computed.lineHeight) || 21;
    const paddingY =
      (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
    const borderY =
      (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
    const minHeight = Math.ceil(lineHeight * 4 + paddingY + borderY);
    const maxHeight = Math.ceil(lineHeight * 12 + paddingY + borderY);
    field.style.height = "auto";
    const contentHeight = field.scrollHeight + borderY;
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight));
    field.style.height = `${nextHeight}px`;
    field.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, []);
  useLayoutEffect(() => {
    if (!editing) return;
    growEditTextarea();
  }, [editing, draft, growEditTextarea]);
  useEffect(() => {
    if (!editing) return;
    const field = editTextareaRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      growEditTextarea();
    });
    observer.observe(field);
    return () => {
      observer.disconnect();
    };
  }, [editing, growEditTextarea]);
  const hasImages = (entry.attachments?.length ?? 0) > 0;
  useEffect(() => {
    const element = bubble.current;
    if (!hasImages || !element) return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((item) => item.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { root: element.closest(".conversation-scroll") },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasImages]);
  const body = userText(entry);
  const refs = parseFileRefs(body);
  const byPath = new Map((entry.fileRefs ?? []).map((ref) => [ref.path, ref]));
  const segments: ReactNode[] = [];
  let at = 0;
  if (entry.delegate) {
    // 斜杠委派：正文开头的 `/agent` 渲染成行内标记；正文不以它开头（旧数据或别的客户端）时补一个
    const tag = `/${entry.delegate.agent}`;
    const leading =
      body.slice(0, tag.length).toLowerCase() === tag.toLowerCase() &&
      (body.length === tag.length || /\s/.test(body.charAt(tag.length)));
    const label = `委派给外部 agent ${entry.delegate.agent}`;
    segments.push(
      <span key="delegate" className="delegate-ref" title={label} aria-label={label}>
        {leading ? body.slice(0, tag.length) : tag}
      </span>,
    );
    if (leading) at = tag.length;
    else if (body !== "") segments.push(" ");
  }
  const snapshot = entry.workMode ?? entry.skill;
  if (snapshot) {
    const name = snapshot.name;
    const metadata = skills?.find(
      (skill) => !skill.shadowedBy && skill.name.toLowerCase() === name.toLowerCase(),
    );
    const data = entry.workMode ? workModeLabel(name) : skillLabel(name, metadata);
    if (entry.skill) at = skillCommandLength(body, name);
    segments.push(
      <InputLabel
        key="input-label"
        data={data}
        button={
          snapshot.body === ""
            ? undefined
            : {
                expanded: modeOpen,
                onClick: () => {
                  setModeOpen((open) => !open);
                },
              }
        }
      />,
    );
    if (body.length > at && !/^\s/.test(body.slice(at))) segments.push(" ");
  }
  refs.forEach((ref, index) => {
    if (ref.start < at) return;
    if (ref.start > at) segments.push(body.slice(at, ref.start));
    const file = byPath.get(ref.path);
    segments.push(
      <span
        key={`ref-${index}`}
        className="ref"
        {...(file !== undefined ? { title: fileRefTitle(file) } : {})}
      >
        {body.slice(ref.start, ref.end)}
      </span>,
    );
    at = ref.end;
  });
  if (at < body.length) segments.push(body.slice(at));

  const reasonText = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);
  const startEdit = () => {
    if (!isLiveSession(session)) return;
    setError(undefined);
    setPending(true);
    void Promise.all([
      session.rewindTargets(),
      loadStoredImageAttachments(entry.attachments ?? [], images, session),
    ])
      .then(([targets, stored]) => {
        setTarget(targets.find((item) => item.seq === entry.seq));
        setDraft(body);
        setMode("both");
        replaceEditAttachments(stored.loaded);
        if (stored.errors.length > 0) {
          setError(`读取原图失败：${stored.errors.join("；")}`);
        }
        setEditing(true);
      })
      .catch((reason: unknown) => {
        setError(`读取回退信息失败：${reasonText(reason)}`);
      })
      .finally(() => {
        setPending(false);
      });
  };
  const sendResubmit = (
    content: string,
    rewindMode: "both" | "conversation",
    attachmentsOverride?: SubmitAttachment[],
  ) => {
    if (!onResubmit) return;
    setError(undefined);
    setPending(true);
    const submitAttachments =
      attachmentsOverride ?? (editing ? toSubmitAttachments(editAttachmentsRef.current) : []);
    const hasQuotes = Boolean(entry.quotes && entry.quotes.length > 0);
    const call =
      submitAttachments.length > 0
        ? onResubmit(
            entry.seq,
            content,
            rewindMode,
            userWorkMode(entry.workMode),
            hasQuotes ? entry.quotes : undefined,
            submitAttachments,
          )
        : hasQuotes
          ? onResubmit(entry.seq, content, rewindMode, userWorkMode(entry.workMode), entry.quotes)
          : onResubmit(entry.seq, content, rewindMode, userWorkMode(entry.workMode));
    void call.catch((reason: unknown) => {
      // 回退/发送失败：编辑内容保留（编辑框仍打开时错误显示在框内）
      setError(`重发失败：${reasonText(reason)}`);
      setPending(false);
    });
  };
  const resendDirectly = () => {
    const existing = entry.attachments ?? [];
    if (existing.length === 0) {
      sendResubmit(body, "both");
      return;
    }
    setError(undefined);
    setPending(true);
    void loadStoredImageAttachments(existing, images, session).then(
      (stored) => {
        if (stored.errors.length > 0) {
          setError(`读取原图失败：${stored.errors.join("；")}`);
          setPending(false);
          return;
        }
        sendResubmit(
          body,
          "both",
          stored.loaded.map((file) => ({
            data: file.data,
            mimeType: file.mimeType ?? "application/octet-stream",
            label: file.name,
            ...(file.source ? { source: file.source } : {}),
          })),
        );
      },
      (reason: unknown) => {
        setError(`读取原图失败：${reasonText(reason)}`);
        setPending(false);
      },
    );
  };
  const onEditPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const parsed = readClipboardAttachments(event.clipboardData, {
      nextPasteNumber: () => editPasteNumber.current++,
    });
    if (!parsed.handled) return;
    event.preventDefault();
    if (Array.isArray(parsed.files)) {
      addEditAttachments(parsed.files);
    } else {
      void parsed.files.then(addEditAttachments, (reason: unknown) => {
        setError(reasonText(reason));
      });
    }
  };
  const onEditDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const dropped = readDroppedAttachments(event.dataTransfer);
    if (dropped === null) return;
    void dropped.then(addEditAttachments, (reason: unknown) => {
      setError(reasonText(reason));
    });
  };
  const openEditPicker = () => {
    if (pickImages !== undefined) {
      void pickImages().then(
        (picked) => {
          if (picked.length > 0) addEditAttachments(picked.map((image) => ({ ...image })));
        },
        (reason: unknown) => {
          setError(reasonText(reason));
        },
      );
      return;
    }
    editFileInputRef.current?.click();
  };
  // ADR-0076：Runtime 写入的模式消息（目标核对、继续目标、批准计划）不能重发
  const resubmittable = onResubmit !== undefined && !isRuntimeWorkMode(entry.workMode);
  const busyTitle = busy ? "请先等待或按 Esc 中断" : undefined;
  const restorable = target?.files.filter((file) => file.action !== "untracked") ?? [];
  const editInfoParts: string[] = [];
  if (repliesAfter > 0) editInfoParts.push(`将撤回 ${repliesAfter} 轮回复`);
  if (restorable.length > 0) {
    editInfoParts.push(
      `将还原 ${restorable.length} 个文件：${restorable
        .map((file) => displayPath(file.path, cwd))
        .join("、")}`,
    );
  }
  const editInfoLead = editInfoParts.join("，");
  const editInfoTail =
    (target?.untrackedCalls ?? 0) > 0
      ? `${untrackedCallsText(target?.untrackedCalls ?? 0, target?.untrackedByKind)}的改动不还原`
      : "";
  const editInfo = [editInfoLead, editInfoTail].filter(Boolean).join("；");
  return (
    <article
      className={`u${editing ? " editing" : ""}${searchHit ? " search-hit" : ""}${quoteFlash && quoteFlashMode === "message" ? " quote-flash" : ""}`}
      data-session-seq={entry.seq}
      data-quote-flash={quoteFlash ? (quoteFlashMode ?? "message") : undefined}
      aria-label="用户消息"
    >
      {scheduleSource !== undefined && (
        <span className="sched-src">
          由定时任务 <span className="k">{scheduleSource.name}</span> 发送
          {scheduleSource.trigger === "catchup"
            ? " · 补跑"
            : scheduleSource.trigger === "manual"
              ? " · 手动"
              : ""}
        </span>
      )}
      <div className="u-body">
        {editing ? (
          <div
            className={`u-edit${dragOver ? " drop" : ""}`}
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
            onDrop={onEditDrop}
          >
            {editAttachments.length > 0 && (
              <ImageViewerBoundary>
                <DraftAttachments attachments={editAttachments} onRemove={removeEditAttachment} />
              </ImageViewerBoundary>
            )}
            <textarea
              ref={editTextareaRef}
              aria-label="编辑消息"
              value={draft}
              rows={4}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onPaste={onEditPaste}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !pending) {
                  event.preventDefault();
                  closeEdit();
                }
              }}
            />
            {editInfo !== "" ? <p className="u-edit-info">{editInfo}</p> : null}
            {restorable.length > 0 ? (
              <div className="u-edit-mode" role="radiogroup" aria-label="回退方式">
                <label>
                  <input
                    type="radio"
                    name={`rewind-${entry.seq}`}
                    checked={mode === "both"}
                    onChange={() => {
                      setMode("both");
                    }}
                  />
                  对话和文件
                </label>
                <label>
                  <input
                    type="radio"
                    name={`rewind-${entry.seq}`}
                    checked={mode === "conversation"}
                    onChange={() => {
                      setMode("conversation");
                    }}
                  />
                  仅对话
                </label>
              </div>
            ) : null}
            {error !== undefined ? (
              <p className="conversation-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="u-edit-actions">
              <IconButton
                className="u-edit-attach"
                disabled={pending}
                aria-label="添加文件"
                onClick={openEditPicker}
              >
                <Icon name="attachment" size={ICON_MD} />
              </IconButton>
              {pickImages === undefined && (
                <input
                  ref={editFileInputRef}
                  type="file"
                  multiple
                  hidden
                  aria-label="选择文件"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length === 0) return;
                    void readFileListAttachments(files, {
                      inferImageMime: true,
                      source: "upload",
                    }).then(addEditAttachments, (reason: unknown) => {
                      setError(reasonText(reason));
                    });
                  }}
                />
              )}
              <Button
                variant="primary"
                disabled={
                  pending ||
                  (draft.trim() === "" &&
                    editAttachments.length === 0 &&
                    (entry.quotes?.length ?? 0) === 0)
                }
                onClick={() => {
                  sendResubmit(draft, mode);
                }}
              >
                {pending ? "发送中…" : "发送"}
              </Button>
              <Button disabled={pending} onClick={closeEdit}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="u-bubble" ref={bubble}>
              {scheduleSource?.preface !== undefined && (
                <span className="sched-pre">{scheduleSource.preface}</span>
              )}
              <UserImages
                attachments={entry.attachments ?? []}
                images={images}
                session={session}
                visible={visible}
              />
              {(entry.files ?? []).map((file) => (
                <button
                  type="button"
                  className="fcard"
                  key={file.file}
                  title={fileSaveErrors[file.file]}
                  onClick={() => {
                    // 本地消息的文件还没写进会话，点了没有可打开的副本
                    if (file.sha256.startsWith("local:")) return;
                    if (fileLinks) {
                      const escaped = file.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                      const reference = entry.content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join("\n");
                      const raw = new RegExp(`path="([^"]*[\\\\/]${escaped})"`).exec(
                        reference,
                      )?.[1];
                      if (raw) {
                        const path = raw
                          .replace(/&quot;/g, '"')
                          .replace(/&lt;/g, "<")
                          .replace(/&gt;/g, ">")
                          .replace(/&amp;/g, "&");
                        const action =
                          file.text && fileLinks.viewSource
                            ? fileLinks.viewSource(path)
                            : fileLinks.reveal(path);
                        void action.catch((reason: unknown) => {
                          setError(String(reason));
                        });
                        return;
                      }
                    }
                    if (saveFile !== undefined) {
                      setFileSaveErrors((prev) =>
                        prev[file.file] === undefined ? prev : { ...prev, [file.file]: undefined },
                      );
                      void (async () => {
                        try {
                          const result = await session.readAttachment(file.file);
                          await saveFile({
                            filename: file.label,
                            mimeType: result.mimeType,
                            bytes: result.data,
                          });
                        } catch (reason: unknown) {
                          const msg = reason instanceof Error ? reason.message : String(reason);
                          setFileSaveErrors((prev) => ({ ...prev, [file.file]: msg }));
                        }
                      })();
                      return;
                    }
                    void session.readAttachment(file.file).then(
                      (result) => {
                        const url = URL.createObjectURL(
                          new Blob([result.data as BlobPart], { type: result.mimeType }),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = file.label;
                        link.click();
                        setTimeout(() => {
                          URL.revokeObjectURL(url);
                        }, 1000);
                      },
                      (reason: unknown) => {
                        setError(String(reason));
                      },
                    );
                  }}
                >
                  <span className="ficon" aria-hidden="true">
                    {fileIconText(file.label)}
                  </span>
                  <span className="fname">{file.label}</span>
                  <span className="fsize">{formatBytes(file.bytes)}</span>
                </button>
              ))}
              {entry.pageComments !== undefined && (
                <div className="u-page-comments">
                  <span className="page-comment-chip">
                    <Icon name="chat_1" size={ICON_SM} />
                    <span className="page-comment-chip-text">
                      {pageCommentsLabel(entry.pageComments)}
                    </span>
                  </span>
                </div>
              )}
              {entry.quotes !== undefined && entry.quotes.length > 0 && (
                <div className="u-quotes">
                  {entry.quotes.map((quote, index) => {
                    const jumpable =
                      quote.seq !== undefined &&
                      availableSeqs !== undefined &&
                      availableSeqs.has(quote.seq) &&
                      onJumpQuote !== undefined;
                    return (
                      <button
                        key={`${quote.seq ?? ""}:${index}:${quote.text}`}
                        type="button"
                        className="u-quote"
                        data-jumpable={jumpable ? "true" : undefined}
                        title={quote.text}
                        onClick={() => {
                          if (jumpable) onJumpQuote(quote);
                        }}
                      >
                        <span className="u-quote-text">{quote.text}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {(body !== "" || entry.delegate !== undefined || snapshot !== undefined) && (
                <div
                  className="u-text"
                  data-quote-source-seq={
                    quotable ? (entry.seq > 0 ? String(entry.seq) : "") : undefined
                  }
                >
                  {segments}
                </div>
              )}
              {snapshot && modeOpen && <pre className="mode-body">{snapshot.body}</pre>}
            </div>
            <div className="u-actions">
              <button
                type="button"
                className="u-act u-act-icon"
                aria-label={copied ? "已复制" : "复制"}
                title={copied ? "已复制" : "复制"}
                onClick={() => {
                  void copy(body);
                }}
              >
                <Icon name={copied ? "check" : "copy_2"} size={ICON_SM} />
              </button>
              {resubmittable && (
                <button
                  type="button"
                  className="u-act u-act-icon"
                  disabled={busy || pending}
                  aria-label="编辑并重发"
                  title={busyTitle ?? "编辑并重发"}
                  onClick={startEdit}
                >
                  <Icon name="edit_2" size={ICON_SM} />
                </button>
              )}
              {resubmittable && (
                <button
                  type="button"
                  className="u-act u-act-icon"
                  disabled={busy || pending}
                  aria-label="重发"
                  title={busyTitle ?? "重发"}
                  onClick={resendDirectly}
                >
                  <Icon name="refresh_2" size={ICON_SM} />
                </button>
              )}
              {onFork && (
                <button
                  type="button"
                  className="u-act u-act-icon"
                  disabled={pending}
                  aria-label="分叉"
                  title="分叉"
                  onClick={() => {
                    setError(undefined);
                    setConfirmFork(true);
                  }}
                >
                  <Icon name="git_branch" size={ICON_SM} />
                </button>
              )}
            </div>
            {confirmFork && onFork ? (
              <div className="u-fork" role="group" aria-label="确认分叉">
                <p>
                  将以这条消息之前的对话新建会话，可在新会话里重新提问。原会话不变；工作区文件保持当前状态，不会回退。
                </p>
                <div className="u-edit-actions">
                  <Button
                    variant="primary"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void onFork(entry.seq)
                        .then(() => {
                          setConfirmFork(false);
                        })
                        .catch((reason: unknown) => {
                          setError(`分叉失败：${reasonText(reason)}`);
                        })
                        .finally(() => {
                          setPending(false);
                        });
                    }}
                  >
                    {pending ? "分叉中…" : "分叉"}
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setConfirmFork(false);
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : null}
            {error !== undefined ? (
              <p className="conversation-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
      {entry.descriptions?.map((description, index) =>
        description.text ? (
          <details key={index}>
            <summary>
              <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
              图片说明<span className="muted-value">{description.model}</span>
            </summary>
            <pre>{description.text}</pre>
          </details>
        ) : null,
      )}
    </article>
  );
}

// ── 工具行 ──

export function toolArgument(entry: ToolEntry, cwd: string): string {
  return toolArgumentValue(entry, cwd).text;
}

/** 参数位原文；path 为真时行头按「文件名 + 淡色目录」拆开显示，mono 仅用于代码/路径/命令等机器值。 */
function toolArgumentValue(
  entry: ToolEntry,
  cwd: string,
): { text: string; path: boolean; mono: boolean } {
  const plain = (value: string, mono = false) => ({ text: value, path: false, mono });
  const input = inputOf(entry);
  const name = effectiveToolName(entry);
  const ensembleArg = ensembleToolSummary(name, input);
  if (ensembleArg !== undefined) return plain(ensembleArg, false);
  switch (name) {
    case "note_write":
      return plain(noteWriteSummary(entry)?.text ?? "", false);
    case "skill":
      return plain(input === undefined ? "" : text(input.name), true);
    case "render_html":
      return plain(input === undefined ? "" : text(input.title) || text(input.page), false);
    case "task":
      return plain(input === undefined ? "" : text(input.task), false);
    case "read":
    case "edit":
    case "write":
      return {
        text: input === undefined ? "" : displayPath(text(input.path), cwd),
        path: true,
        mono: true,
      };
    case "switch_worktree": {
      const output = entry.result?.output as { current?: unknown } | undefined;
      const target = text(output?.current) || text(input?.path);
      return plain(
        `· ${
          target
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .at(-1) ?? ""
        }`,
        true,
      );
    }
    case "grep": {
      const path = input === undefined ? "" : text(input.path);
      return plain(
        `"${input === undefined ? "" : text(input.pattern)}"${path === "" ? "" : ` · ${displayPath(path, cwd)}`}`,
        true,
      );
    }
    case "glob": {
      const path = input === undefined ? "" : text(input.path);
      return plain(
        `${input === undefined ? "" : text(input.pattern)}${path === "" ? "" : ` · ${displayPath(path, cwd)}`}`,
        true,
      );
    }
    case "shell":
      return plain(input === undefined ? "" : text(input.command).replace(/\s+/g, " "), true);
    case "web_fetch":
      return plain(input === undefined ? "" : text(input.url), true);
    case "web_search":
      return plain(input === undefined ? "" : text(input.query), false);
    case "apply_subagent_changes": {
      // ADR-0075 §7：行头「并回子代理改动 · N 个文件」，冲突时「有冲突 · N 个文件」
      const output = entry.result?.output as { files?: unknown; conflicts?: unknown } | undefined;
      if (output === undefined) return plain("", false);
      const conflicts = Array.isArray(output.conflicts) ? output.conflicts.length : 0;
      const files = Array.isArray(output.files) ? output.files.length : 0;
      return plain(conflicts > 0 ? `有冲突 · ${conflicts} 个文件` : `${files} 个文件`, false);
    }
    case "mcp_search": {
      const q = input === undefined ? "" : text(input.query);
      const srv = input === undefined ? "" : text(input.server);
      return plain(srv !== "" ? `${q} · ${srv}` : q, false);
    }
    default:
      // MCP 工具的名称列已是 server/tool；参数位展示主要输入（第一个非空
      // 字符串入参，如搜索 query、抓取 url），拿不到就留空，不再显示一遍名字。
      if (name.startsWith("mcp__computer__")) {
        const action = name.slice("mcp__computer__".length);
        const subject = entry.subjects.find((subject) => subject.kind === "app");
        const target = subject?.app?.name ?? subject?.target;
        return plain(target === undefined ? action : `${action} · ${target}`, false);
      }
      if (mcpToolLabel(name, entry.subjects) !== undefined) {
        if (input === undefined) return plain("", false);
        return plain(
          Object.values(input).find(
            (value): value is string => typeof value === "string" && value !== "",
          ) ?? "",
          false,
        );
      }
      return plain(
        entry.subjects[0]?.target ?? "",
        entry.subjects[0]?.kind === "read" ||
          entry.subjects[0]?.kind === "edit" ||
          entry.subjects[0]?.kind === "shell" ||
          entry.subjects[0]?.kind === "network",
      );
  }
}

/** 读取工具的展示范围：ok 时用结果里的实际区间，否则用请求 offset/limit。 */
export function toolRange(entry: ToolEntry): string | undefined {
  if (entry.name !== "read") return undefined;
  const output = entry.result?.output;
  if (output !== null && typeof output === "object") {
    const value = output as { offset?: unknown; returnedLines?: unknown };
    const offset = Number(value.offset);
    const lines = Number(value.returnedLines);
    if (Number.isFinite(offset) && Number.isFinite(lines) && lines > 0) {
      return `${offset}–${offset + lines - 1}`;
    }
    return undefined;
  }
  const input = inputOf(entry);
  if (input === undefined) return undefined;
  const offset = typeof input.offset === "number" ? input.offset : 1;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  return limit !== undefined && limit > 0 ? `${offset}–${offset + limit - 1}` : undefined;
}

/** 超过 10 秒才展示的人读时长："12 秒" / "1 分 45 秒"；更短的不显示。 */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 10_000) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

export function toolResultText(entry: ToolEntry): { text: string; error?: boolean } {
  switch (entry.status) {
    case "running":
      return { text: "运行中…" };
    case "awaiting_permission":
      return { text: "等待确认" };
    case "cancelled":
      return { text: "已取消" };
    case "interrupted":
      return { text: "已中断" };
    case "denied":
      return { text: "已拒绝" };
    case "error":
      return { text: "失败", error: true };
    case "ok":
      break;
  }
  const output = entry.result?.output;
  const value =
    output !== null && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  let base = "完成";
  switch (effectiveToolName(entry)) {
    case "skill":
      base = "已加载";
      break;
    case "read":
      base = `${typeof value?.returnedLines === "number" ? value.returnedLines : 0} 行`;
      break;
    case "grep":
      base = `${Array.isArray(value?.matches) ? value.matches.length : 0} 处${entry.result?.truncated === true ? "+" : ""}`;
      break;
    case "glob":
      base = `${Array.isArray(value?.entries) ? value.entries.length : 0} 个文件`;
      break;
    case "edit":
      base = `${typeof value?.replaced === "number" ? value.replaced : 0} 处`;
      break;
    case "write":
      base = `${typeof value?.lines === "number" ? value.lines : 0} 行`;
      break;
    case "apply_patch":
      base = `${Array.isArray(value?.files) ? value.files.length : 0} 个文件`;
      break;
    case "shell":
      if (value?.timedOut === true) base = "超时";
      else if (typeof value?.exitCode === "number" && value.exitCode !== 0)
        base = `退出码 ${value.exitCode}`;
      break;
    case "mcp_search":
      if (Array.isArray(value?.matches)) base = `${value.matches.length} 个工具`;
      break;
    case "ensemble_read":
      if (Array.isArray(value?.posts)) base = `${value.posts.length} 条`;
      break;
    default:
      break;
  }
  const duration =
    entry.result?.durationMs === undefined ? undefined : formatDuration(entry.result.durationMs);
  return { text: duration === undefined ? base : `${base} · ${duration}` };
}

/** 可恢复的守卫错误：保护机制在起作用，模型重新读取或补证据就能继续，行尾用中性淡色，不标红。 */
export const RECOVERABLE_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "stale_file",
  "goal_unverified",
]);

function isRecoverableToolErrorCode(code: string | undefined): boolean {
  return code !== undefined && RECOVERABLE_TOOL_ERRORS.has(code);
}

/** stale_file 是否附带了 diff：Core 把行级 diff 放进 modelContent，hunk 行以「@@ -」开头。 */
function hasStaleDiff(entry: ToolEntry): boolean {
  return /^@@ -\d/m.test(entry.result?.modelContent ?? "");
}

/** 超时行尾摘要：优先用 output.timeoutMs 换算秒数，不解析中文文案；缺失时回退通用文案。 */
function timeoutSummary(entry: ToolEntry): string {
  const output = entry.result?.output;
  const ms =
    output !== null &&
    typeof output === "object" &&
    "timeoutMs" in output &&
    typeof (output as { timeoutMs?: unknown }).timeoutMs === "number"
      ? (output as { timeoutMs: number }).timeoutMs
      : undefined;
  if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
    return `超时（${Math.round(ms / 1000)} 秒）`;
  }
  return "超时";
}

/** 超时展开区：取 modelContent 中实际输出的最后 40 行，不重复摘要那一句。 */
function timeoutBody(modelContent: string): string {
  const index = modelContent.indexOf("\n");
  const body = index === -1 ? "" : modelContent.slice(index + 1);
  return body.split("\n").slice(-40).join("\n");
}

/** 简述只取 Core 的第一句；扩展名与小数中的 "." 不算句末。 */
function toolErrorSummary(entry: ToolEntry, cwd: string): string {
  const error = entry.result?.error;
  if (error?.code === "stale_file") {
    return hasStaleDiff(entry) ? "文件已变化，已附上变更" : "文件已变化，需重新读取";
  }
  if (error?.code === "goal_unverified") {
    return "核对未通过";
  }
  if (error?.code === "timeout") return timeoutSummary(entry);
  const message = error?.message.trim() ?? "";
  const end = /[。！？!?]|\.(?=\s|$)|\r?\n/u.exec(message);
  const first = end === null ? message : message.slice(0, end.index + end[0].trim().length);
  if (cwd === "") return first;
  // 只匹配工作区前缀，保留路径中的空格及后续原文；是否确实属于 cwd 由 displayPath 判定。
  const prefix = cwd
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", "[\\\\/]");
  return first.replace(
    new RegExp(`${prefix}[\\\\/][^\\s"'\\x60<>，。！？；：（）]*`, "gi"),
    (path) => displayPath(path, cwd),
  );
}

/** 被拒绝的工具：一行红字，feedback 放 title。 */
export function deniedLine(entry: ToolEntry, cwd: string): string {
  const input = inputOf(entry);
  const name = effectiveToolName(entry);
  const target = (value: unknown): string =>
    displayPath(
      typeof value === "string" && value !== "" ? value : (entry.subjects[0]?.target ?? ""),
      cwd,
    );
  switch (name) {
    case "shell":
      return `✕ 已拒绝执行 ${text(input?.command)}`;
    case "edit":
    case "write":
    case "apply_patch":
      return `✕ 已拒绝修改 ${target(input?.path)}`;
    case "read":
      return `✕ 已拒绝读取 ${target(input?.path)}`;
    case "web_fetch":
      return `✕ 已拒绝访问 ${text(input?.url)}`;
    default:
      return `✕ 已拒绝${toolMeta(name, entry.subjects).label} ${toolArgument(entry, cwd)}`.trim();
  }
}

interface FileDiff {
  /** 稳定 key：展示路径（含改名目标） */
  label: string;
  path: string;
  movedTo?: string;
  diff?: string;
}

/** Mirrors the TUI's output.files/output.diff and historical write result shapes. */
function fileDiffs(entry: ToolEntry, cwd: string): FileDiff[] {
  if (
    entry.result?.status !== "ok" ||
    !entry.result.output ||
    typeof entry.result.output !== "object"
  )
    return [];
  const output = entry.result.output;
  if ("files" in output && Array.isArray(output.files)) {
    return output.files.flatMap((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("path" in value) ||
        typeof value.path !== "string"
      )
        return [];
      const path = displayPath(value.path, cwd);
      const movedTo =
        "movedTo" in value && typeof value.movedTo === "string"
          ? displayPath(value.movedTo, cwd)
          : undefined;
      return [
        {
          label: movedTo === undefined ? path : `${path} → ${movedTo}`,
          path,
          ...(movedTo === undefined ? {} : { movedTo }),
          ...("diff" in value && typeof value.diff === "string" && value.diff
            ? { diff: value.diff }
            : {}),
        },
      ];
    });
  }
  const label =
    "path" in output && typeof output.path === "string"
      ? displayPath(output.path, cwd)
      : (entry.name ?? "文件");
  if ("diff" in output && typeof output.diff === "string" && output.diff)
    return [{ label, path: label, diff: output.diff }];
  const content =
    entry.input && typeof entry.input === "object" && "content" in entry.input
      ? entry.input.content
      : undefined;
  if ("created" in output && output.created === true && typeof content === "string" && content) {
    return [
      {
        label,
        path: label,
        diff: content
          .replace(/\r\n?/g, "\n")
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n"),
      },
    ];
  }
  return [];
}

export function diffCounts(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const row of diffRows(diff)) {
    if (row.kind === "add") add += 1;
    else if (row.kind === "delete") del += 1;
  }
  return { add, del };
}

/** 展开的 diff 正文；折叠行的「展开」与这里的正文共用同一份按行渲染。 */
/**
 * 差异行。wrap：长行自动换行，续行缩进到代码起点（行号和 +/− 不重复）；
 * 不传时整行不折、横向滚动（对话里的改动卡片）。
 */
export function DiffBody({
  diff,
  wrap = false,
  path,
}: {
  diff: string;
  wrap?: boolean;
  path?: string | undefined;
}) {
  const ref = useCodeHighlight<HTMLDivElement>(path, diff, "diff");
  return (
    <div ref={ref} className={`diff-body${wrap ? " diff-wrap" : ""}`} aria-label="文件差异">
      {diffRows(diff).map((row, index) =>
        row.kind === "sep" ? (
          <div key={index} className="diff-row diff-sep" aria-hidden="true">
            ⋯
          </div>
        ) : (
          <div key={index} className={`diff-row diff-row-${row.kind}`}>
            <span className="diff-num" aria-hidden="true">
              {row.num ?? ""}
            </span>
            <span className="diff-mark" aria-hidden="true">
              {row.mark}
            </span>
            <code data-code-line={index}>{row.code === "" ? " " : row.code}</code>
          </div>
        ),
      )}
    </div>
  );
}

/** 参数位：路径类参数拆成「文件名 + 淡色目录」，其余整段放在 name。 */
export interface ArgParts {
  name: string;
  dir: string;
  title: string;
}

export function pathParts(path: string, suffix = ""): ArgParts {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash < 0 ? path : path.slice(slash + 1);
  if (slash < 0 || name === "") {
    return { name: `${path}${suffix}`, dir: "", title: `${path}${suffix}` };
  }
  return { name: `${name}${suffix}`, dir: path.slice(0, slash), title: `${path}${suffix}` };
}

/**
 * 工具行头：接收参数、执行中、完成三个阶段共用同一结构
 * （箭头 · 图标 · 名称 · 参数位 · 可选附加 · 行尾状态），只有行尾在变。
 * 接收参数阶段箭头占位但不可点。
 */
export function ToolLine({
  open,
  disabled,
  label,
  arg,
  argClassName,
  extras,
  profile,
  status,
  onToggle,
}: {
  open: boolean;
  disabled: boolean;
  label: string;
  arg: ArgParts;
  argClassName?: string | undefined;
  extras?: ReactNode;
  profile?: string | undefined;
  status: ReactNode;
  onToggle: () => void;
}) {
  return (
    <summary
      className="tool-line"
      aria-label="工具详细信息"
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        event.preventDefault();
        if (!disabled) onToggle();
      }}
    >
      <Icon name="right_small" size={ICON_SM} className={`fold-arrow${open ? " down" : ""}`} />
      <span className="tool-name">{label}</span>
      {profile !== undefined && <span className="subagent-badge">{profile}</span>}
      <span
        className={`tool-arg${argClassName ? ` ${argClassName}` : ""}`}
        title={arg.title || undefined}
      >
        {arg.name}
        {arg.dir !== "" && (
          <>
            {arg.name !== "" ? " " : null}
            <span className="tool-dir">{arg.dir}</span>
          </>
        )}
      </span>
      {extras}
      {status}
    </summary>
  );
}

export function DiffCounts({ diff }: { diff: string | undefined }) {
  const counts = diff === undefined ? undefined : diffCounts(diff);
  return (
    <span className="tool-res tool-counts">
      {counts !== undefined && <span className="diff-add">+{counts.add}</span>}
      {counts !== undefined && counts.del > 0 && <span className="diff-del">−{counts.del}</span>}
    </span>
  );
}

/** 行中淡色预览：liveOutput 的最后一行非空内容（超长由 CSS 截断）。 */
function lastOutputLine(liveOutput: string): string {
  const lines = liveOutput.replace(/\r\n?/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trimEnd();
    if (line.trim() !== "") return line;
  }
  return "";
}

/**
 * 运行中秒数：前端首次看到这条工具 running 时开始计时，只改前端展示，不动协议。
 * 组件实例随 `entry.key` 稳定，用户的展开选择不会被 status 变化重置。
 */
function useRunningSeconds(running: boolean): number | undefined {
  const startedAt = useRef<number | null>(null);
  if (running && startedAt.current === null) startedAt.current = Date.now();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  if (!running || startedAt.current === null) return undefined;
  return Math.max(0, Math.floor((now - startedAt.current) / 1000));
}

/** schedule 主体的多行 detail 超过这么多行就折叠，按钮展开看全（ADR-0064） */
const SUBJECT_DETAIL_FOLD_LINES = 10;

/**
 * 多行纯文本：保留换行。超过折叠行数时默认只给前几行，展开后是全文。
 * 桌面确认卡片、手机端同一张卡片、以及工具行展开后的 schedule detail 共用。
 */
function FoldedPlainText({ text }: { text: string }) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const foldable = lines.length > SUBJECT_DETAIL_FOLD_LINES;
  const [open, setOpen] = useState(false);
  const shown =
    foldable && !open ? lines.slice(0, SUBJECT_DETAIL_FOLD_LINES).join("\n") : normalized;
  return (
    <div className="subject-detail">
      <pre>{shown}</pre>
      {foldable ? (
        <button
          type="button"
          className="subject-detail-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {open ? "收起" : `展开其余 ${lines.length - SUBJECT_DETAIL_FOLD_LINES} 行`}
        </button>
      ) : null}
    </div>
  );
}

/** 运行中的实时输出：粘底跟随，上翻时保留阅读位置。 */
function LiveOutput({ text }: { text: string }) {
  const output = useStickyOutput(text);
  return (
    <pre ref={output} className="conversation-tool-output" aria-label="工具实时输出">
      {text}
    </pre>
  );
}

function ToolCode({ text, path, numbered }: { text: string; path: string; numbered: boolean }) {
  const ref = useCodeHighlight<HTMLPreElement>(path, text, numbered ? "numbered" : "text");
  return (
    <pre ref={ref} className="tool-payload conversation-tool-output">
      {text}
    </pre>
  );
}

function ToolDetails({
  entry,
  cwd,
  images,
  session,
}: {
  entry: ToolEntry;
  cwd: string;
  images?: AttachmentImageSource | undefined;
  session?: Pick<RpcSession, "readAttachment"> | undefined;
}) {
  const [detailsOpen, setDetailsOpen] = usePersistedToggle(`tool-details:${entry.key}`, false);
  const result = entry.result;
  const isTimeout = result?.error?.code === "timeout";
  const input = inputOf(entry);
  const output = result?.output;
  const subagent = subagentRowInfo(entry);
  const value =
    output !== null && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const rawInput = rawInputOf(entry);
  const hasDetails = detailRows(rawInput).length > 0 || detailRows(output).length > 0;
  const goalUnverified = isGoalUnverified(entry);
  const goalFailed = goalUnverified ? goalCheckFailedItems(entry) : [];
  const goalUnavailableReason = goalCheckUnavailableReason(entry);
  const body =
    result?.error !== undefined
      ? isTimeout
        ? timeoutBody(result.modelContent)
        : goalUnverified
          ? result.modelContent || result.error.message
          : result.error.message
      : entry.status === "running"
        ? entry.liveOutput
        : (result?.modelContent ?? "");
  const hasDiff = fileDiffs(entry, cwd).length > 0;
  return (
    <>
      {subagent.reason !== undefined && (
        <div className="tool-info">
          <span>选择理由</span>
          <span>{subagent.reason}</span>
        </div>
      )}
      {goalUnavailableReason !== undefined && (
        <div className="tool-info">
          <span>核对不可用</span>
          <span>{goalUnavailableReason}</span>
        </div>
      )}
      {!hasDiff &&
        (goalUnverified && goalFailed.length > 0 ? (
          <ul className="tool-payload todo-list note-list">
            {goalFailed.map((item, index) => (
              <li key={index}>
                <span className="todo-mark">×</span>
                <span className="todo-text">
                  {item.label}
                  {item.note !== undefined ? `：${item.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : command !== undefined ? (
          <div className="tool-payload tool-shell">
            <pre className="tool-command">
              <span>$ </span>
              {command}
            </pre>
            {entry.status === "running" ? (
              <LiveOutput text={body} />
            ) : (
              <pre className="conversation-tool-output">{body}</pre>
            )}
          </div>
        ) : body !== "" ? (
          entry.status === "running" ? (
            <LiveOutput text={body} />
          ) : !result?.error &&
            (entry.name === "read" || entry.name === "write") &&
            typeof input?.path === "string" ? (
            <ToolCode
              text={displayResultPaths(body, cwd)}
              path={input.path}
              numbered={entry.name === "read"}
            />
          ) : (
            <pre className="tool-payload conversation-tool-output">
              {result?.error ? body : displayResultPaths(body, cwd)}
            </pre>
          )
        ) : null)}
      <div className="tool-info">
        {command !== undefined && typeof value?.exitCode === "number" && (
          <span>退出码 {value.exitCode}</span>
        )}
        {command !== undefined && typeof input?.cwd === "string" && (
          <span>目录 {displayPath(input.cwd, cwd)}</span>
        )}
        {typeof value?.replaced === "number" && <span>{value.replaced} 处替换</span>}
        {entry.review && (
          <span title={entry.review.reason}>
            安全审查
            <span className="muted-value">{permissionReviewLabel(entry.review.verdict)}</span>
          </span>
        )}
        {entry.subjects.map((subject, index) => {
          // schedule 的 detail 是多行任务说明，不塞进这一行；下面单独成块
          if (subject.kind === "schedule") return null;
          return (subject.resolved && subject.resolved !== subject.target) || subject.detail ? (
            <span key={index}>
              {subject.resolved && subject.resolved !== subject.target
                ? `实际路径 → ${displayPath(subject.resolved, cwd)}`
                : ""}
              {subject.detail ? ` ${subject.detail}` : ""}
            </span>
          ) : null;
        })}
        {hasDetails && (
          <button
            type="button"
            className="tool-detail-toggle"
            aria-expanded={detailsOpen}
            onClick={() => {
              setDetailsOpen((current) => !current);
            }}
          >
            <Icon
              name="right_small"
              size={ICON_SM}
              className={`fold-arrow${detailsOpen ? " down" : ""}`}
            />{" "}
            详情
          </button>
        )}
      </div>
      {entry.subjects.map((subject, index) =>
        subject.kind === "schedule" && subject.detail !== undefined && subject.detail !== "" ? (
          <FoldedPlainText key={`schedule-detail:${index}`} text={subject.detail} />
        ) : null,
      )}
      {detailsOpen && hasDetails && (
        <div className="tool-payload tool-fields">
          <DetailGroup label="参数" value={rawInput} cwd={cwd} />
          <DetailGroup label="结果" value={output} cwd={cwd} />
        </div>
      )}
      {result?.truncated ? (
        <p className="conversation-review">
          输出已截断{result.spillPath ? `，完整输出：${displayPath(result.spillPath, cwd)}` : ""}
        </p>
      ) : null}
      {(result?.attachments ?? []).length > 0 && (
        <ToolShots attachments={result?.attachments ?? []} images={images} session={session} />
      )}
      {(result?.files ?? []).filter((f) => f.inline === undefined).length > 0 && (
        <div className="tool-files">
          {(result?.files ?? [])
            .filter((f) => f.inline === undefined)
            .map((file) => (
              <FileAttachmentCard key={file.file} file={file} session={session} />
            ))}
        </div>
      )}
      {entry.descriptions?.map((description, index) =>
        description.text ? (
          <p key={index} className="conversation-review">
            图片说明<span className="muted-value">{description.model}</span>：{description.text}
          </p>
        ) : null,
      )}
    </>
  );
}

function detailRows(value: unknown): [string, unknown][] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "object" && !Array.isArray(value)) return Object.entries(value);
  return [["", value]];
}

function displayResultPaths(value: string, cwd: string): string {
  if (cwd === "") return value;
  const prefix = cwd
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("/", "[\\\\/]");
  return value.replace(
    new RegExp(`${prefix}[\\\\/][^\\r\\n\"'\\x60<>，。！？；：（）]*`, "gi"),
    (path) => displayPath(path, cwd),
  );
}

function FileAttachmentCard({
  file,
  session,
  initialError,
}: {
  file: FileAttachment;
  session: Pick<RpcSession, "readAttachment"> | undefined;
  initialError?: string | undefined;
}) {
  const saveFile = useSaveFile();
  const [error, setError] = useState<string | undefined>(
    initialError !== undefined && initialError !== "" ? initialError : undefined,
  );

  return (
    <button
      type="button"
      className="fcard"
      title={error}
      onClick={() => {
        if (!session) return;
        setError(undefined);
        void session.readAttachment(file.file).then(
          (result) => {
            triggerBytesDownload({
              filename: file.label,
              mimeType: result.mimeType,
              bytes: result.data,
              saveFile,
              onError: setError,
            });
          },
          (reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
      }}
    >
      <span className="ficon" aria-hidden="true">
        {fileIconText(file.label)}
      </span>
      <span className="fname">{file.label}</span>
      <span className="fsize">{formatBytes(file.bytes)}</span>
    </button>
  );
}

const DETAIL_STRING_FOLD_CHARS = 400;

function FoldedDetailString({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  if (lines.length > SUBJECT_DETAIL_FOLD_LINES) {
    return <FoldedPlainText text={text} />;
  }
  if (text.length <= DETAIL_STRING_FOLD_CHARS) {
    return <>{text}</>;
  }
  return (
    <div className="subject-detail">
      <pre>{open ? text : `${text.slice(0, DETAIL_STRING_FOLD_CHARS)}…`}</pre>
      <button
        type="button"
        className="subject-detail-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {open ? "收起" : "展开"}
      </button>
    </div>
  );
}

function DetailGroup({ label, value, cwd }: { label: string; value: unknown; cwd: string }) {
  const rows = detailRows(value);
  if (rows.length === 0) return null;
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <dl>
        {rows.map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {typeof item === "string" ? (
                /^(?:[A-Za-z]:[\\/]|\/|\\\\|\.\/)/.test(item) ? (
                  displayPath(item, cwd)
                ) : (
                  <FoldedDetailString text={item} />
                )
              ) : (
                JSON.stringify(item, null, 2)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 工具行：默认收起，点击展开。接收参数（preparing）、执行中、完成都渲染这一个组件，
 * 行头结构不变；运行中展开是实时输出（粘底跟随），完成后展开是完整结果与详情。
 * 结果带文件 diff（fileDiffs 非空）时每个文件一行，收起时行尾是 +N −M，展开才出现 diff 框。
 * 第一行固定 key "row"，从接收参数到完成始终是同一个 DOM 节点。
 */
function ToolRow({
  entry,
  searchHit = false,
  searchExpand = false,
  cwd,
  preparing = false,
  queued = false,
  waiting = false,
  images,
  session,
}: {
  entry: ToolEntry;
  searchHit?: boolean;
  searchExpand?: boolean;
  cwd: string;
  preparing?: boolean;
  queued?: boolean;
  waiting?: boolean;
  images?: AttachmentImageSource | undefined;
  session?: Pick<RpcSession, "readAttachment"> | undefined;
}) {
  const [open, setOpen] = usePersistedToggle(`tool:${entry.key}`, searchExpand);
  const [fileOpen, setFileOpen] = usePersistedRecord(`tool-files:${entry.key}`);
  const renderedDetails = useRef(new Set<string>());
  const rowElement = useRef<HTMLElement>(null);
  useEffect(() => {
    if (searchExpand) {
      for (const details of rowElement.current?.querySelectorAll("details") ?? []) {
        delete details.dataset.motionFold;
      }
      setOpen(true);
    }
  }, [searchExpand]);
  const shownName = effectiveToolName(entry);
  const meta = toolMeta(shownName, entry.subjects);
  const subagent = subagentRowInfo(entry);
  const todos = todoItemsFromCompletion({
    name: entry.name ?? "",
    status: entry.status,
    output: entry.result?.output,
  });
  const summary = todos === undefined ? undefined : todoSummary(todos);
  const notes = noteItemsFromEntry(entry);
  const noteSummary = noteWriteSummary(entry);
  const boardFilter =
    shownName === "ensemble_read" ? ensembleReadFilterParts(rawInputOf(entry)) : undefined;
  const boardPosts =
    shownName === "ensemble_read" && entry.status === "ok"
      ? ensembleReadPostsFromOutput(entry.result?.output)
      : undefined;
  const argument = toolArgumentValue(entry, cwd);
  const arg: ArgParts =
    summary !== undefined
      ? { name: summary.count, dir: summary.note, title: summary.text }
      : noteSummary !== undefined
        ? { name: noteSummary.count, dir: noteSummary.note, title: noteSummary.text }
        : boardFilter !== undefined
          ? { name: boardFilter.primary, dir: boardFilter.query, title: boardFilter.text }
          : preparing && inputOf(entry) === undefined
            ? { name: "", dir: "", title: "" }
            : argument.path
              ? pathParts(argument.text)
              : { name: argument.text, dir: "", title: argument.text };
  const range = toolRange(entry);
  const running = !preparing && entry.status === "running";
  // 只读且日志未收束：保留 running 的事实，但不转圈、不计时
  const frozen = useContext(FrozenContext) && running;
  const animating = running && !frozen;
  const motion = useMotionAllowed();
  const links = useContext(SubagentLinksContext);
  const subagentLink = links !== null && !preparing ? links.link(entry) : undefined;
  const result = toolResultText(entry);
  const backgroundView = useContext(BackgroundViewContext);
  const shellSession = useContext(ShellSessionContext);
  const shellTask = backgroundView.backgroundShells.find((task) => task.callId === entry.callId);
  const backgroundStatus =
    shellToolStatus(entry, backgroundView) ?? backgroundToolStatus(entry, backgroundView.entries);
  const childAwaitingPermission =
    !frozen &&
    entry.name === "task" &&
    backgroundView.pendingSubagentPermissions.some((p) => p.parentCallId === entry.callId);
  const selfAwaitingPermission =
    !frozen && entry.name === "task" && entry.status === "awaiting_permission";
  const seconds = useRunningSeconds(animating && !waiting && !childAwaitingPermission);
  const error = entry.result?.error;
  const preview = running ? lastOutputLine(entry.liveOutput) : "";
  const notStarted = subagentStartRejected(entry);
  // 并回的 output.files 只是清单（无 diff）：改动由下方变更卡片展示，行头保持「N 个文件」
  const diffs =
    entry.status === "ok" && shownName !== "apply_subagent_changes" ? fileDiffs(entry, cwd) : [];
  const asked = running && waiting;
  const shimmer = !preparing && animating && !asked && !childAwaitingPermission && motion;
  const status = preparing ? (
    <span className="tool-res">{queued ? "排队中" : "接收参数中"}</span>
  ) : (
    <>
      {animating && !asked && !childAwaitingPermission && !motion && (
        <span className="tool-spin" aria-hidden="true" />
      )}
      {(subagent.model !== undefined || subagent.effort !== undefined) && (
        <span
          className="tool-range"
          title={[subagent.model, subagent.effort].filter(Boolean).join(" ") || undefined}
        >
          {subagent.model}
          {subagent.effort !== undefined && <span className="muted-value">{subagent.effort}</span>}
        </span>
      )}
      {asked && (
        <span className="tool-res tool-wait">
          <span aria-hidden="true" />
          等待你回答
        </span>
      )}
      {childAwaitingPermission && (
        <span className="tool-res tool-wait warn">
          <span aria-hidden="true" />
          等待确认
        </span>
      )}
      {seconds !== undefined && !asked && !childAwaitingPermission && (
        <span className="tool-secs">{seconds} 秒</span>
      )}
      {(!running || frozen) && todos === undefined && !childAwaitingPermission && (
        <span
          className={`tool-res${
            error !== undefined && !notStarted
              ? isRecoverableToolErrorCode(error.code)
                ? " recoverable"
                : " err"
              : selfAwaitingPermission
                ? " warn"
                : ""
          }`}
        >
          {notStarted
            ? "未启动"
            : (backgroundStatus ??
              (frozen
                ? "未收束"
                : error === undefined
                  ? result.text
                  : toolErrorSummary(entry, cwd)))}
        </span>
      )}
    </>
  );
  const extras = (
    <>
      {todos !== undefined && todos.length > 0 && <TodoProgress items={todos} />}
      {range !== undefined && <span className="tool-range">{range}</span>}
      <GrantedTag
        permission={entry.permission}
        kind={entry.subjects[0]?.kind}
        target={entry.subjects.map((subject) => subject.target).join("\n")}
      />
      {entry.review && (
        <span className="granted-tag" title={entry.review.reason}>
          审查：{permissionReviewLabel(entry.review.verdict)}
        </span>
      )}
      {subagentLink !== undefined && subagentLink.kind !== "none" && links !== null && (
        // 独立按钮：不触发行的展开/收起（ADR-0060 第 6 节）
        <button
          type="button"
          className="subagent-view"
          disabled={subagentLink.kind === "locating"}
          title={subagentLink.kind === "locating" ? "正在定位子代理…" : "查看"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (subagentLink.kind === "ready") links.open(subagentLink.childSessionId);
          }}
        >
          {subagentLink.kind === "locating" ? "正在定位…" : "在面板中查看"}
        </button>
      )}
      {preview !== "" && (
        <span className="tool-live" title={entry.liveOutput}>
          {preview}
        </span>
      )}
    </>
  );
  const rows: (FileDiff | undefined)[] = diffs.length > 0 ? diffs : [undefined];
  return (
    <article
      ref={rowElement}
      className={`tool${animating ? " running" : ""}${shimmer ? " shim" : ""}${preparing ? " preparing" : ""}${searchHit ? " search-hit" : ""}${childAwaitingPermission || selfAwaitingPermission ? " warn" : ""}`}
      data-session-seq={entry.seq}
      data-completed-seq={entry.completedSeq}
      aria-label={`工具 ${shownName || entry.callId}`}
    >
      {rows.map((file, index) => {
        const isOpen = file === undefined ? open : (fileOpen[file.label] ?? open);
        const detailKey = file?.label ?? "row";
        if (isOpen) renderedDetails.current.add(detailKey);
        return (
          <details
            key={index === 0 ? "row" : `file:${file?.label ?? index}`}
            className="tool-details"
            open={isOpen}
          >
            <ToolLine
              open={isOpen}
              disabled={preparing}
              label={subagent.profile !== undefined ? "子代理" : meta.label}
              profile={subagent.profile}
              arg={
                file === undefined
                  ? arg
                  : pathParts(file.path, file.movedTo === undefined ? "" : ` → ${file.movedTo}`)
              }
              argClassName={
                [
                  file !== undefined || (summary === undefined && argument.mono) ? "mono" : "",
                  file === undefined && summary?.complete ? "todo-complete" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              extras={file === undefined ? extras : null}
              status={file === undefined ? status : <DiffCounts diff={file.diff} />}
              onToggle={() => {
                if (file === undefined) {
                  setOpen((current) => !current);
                  return;
                }
                setFileOpen((current) => ({
                  ...current,
                  [file.label]: !(current[file.label] ?? open),
                }));
              }}
            />
            {renderedDetails.current.has(detailKey) ? (
              todos !== undefined ? (
                <TodoList items={todos} />
              ) : notes !== undefined ? (
                notes.length > 0 ? (
                  <ol className="todo-list note-list">
                    {notes.map((item) => (
                      <li key={item.n}>
                        <span className="todo-mark">{item.n}.</span>
                        <span className="todo-text">{item.text}</span>
                      </li>
                    ))}
                  </ol>
                ) : null
              ) : boardPosts !== undefined ? (
                boardPosts.length > 0 ? (
                  <div className="tool-body">
                    <div className="tool-payload conversation-tool-output board-posts">
                      {boardPosts.map((post) => (
                        <div key={post.number} className="board-post">
                          <strong className="board-post-head">{ensemblePostHead(post)}</strong>
                          <div className="board-post-text">{post.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              ) : (
                <div className="tool-body">
                  {file?.diff !== undefined ? (
                    <div className="tool-diff">
                      <div className="diff-h">
                        <Icon name="edit_2" size={ICON_SM} className="diff-icon" />
                        <span className="diff-path" title={file.path}>
                          {file.label}
                        </span>
                        <span className="diff-h-counts">
                          {(() => {
                            const counts = diffCounts(file.diff);
                            return (
                              <>
                                <span className="diff-add">+{counts.add}</span>
                                {counts.del > 0 && <span className="diff-del">−{counts.del}</span>}
                              </>
                            );
                          })()}
                        </span>
                      </div>
                      <DiffBody diff={file.diff} path={file.path} />
                    </div>
                  ) : null}
                  {shellTask && shellSession ? (
                    <ShellToolOutput session={shellSession} task={shellTask} enabled={isOpen} />
                  ) : (
                    <ToolDetails entry={entry} cwd={cwd} images={images} session={session} />
                  )}
                </div>
              )
            ) : null}
          </details>
        );
      })}
    </article>
  );
}

/**
 * 参数仍在流式接收的工具调用：合成只含 name/input 的 ToolEntry，交给 ToolRow 渲染。
 * inputText 能整体解析为 JSON 才作为 input；半截 JSON 不进参数位，也不进 title。
 */
function preparingEntry(tool: LiveTool): ToolEntry {
  let input: unknown;
  try {
    input = JSON.parse(tool.inputText);
  } catch {
    input = undefined;
  }
  const target =
    tool.name === "mcp_call" &&
    input !== null &&
    typeof input === "object" &&
    typeof (input as { tool?: unknown }).tool === "string" &&
    (input as { tool: string }).tool !== ""
      ? {
          name: (input as { tool: string }).tool,
          input: (input as { arguments?: unknown }).arguments ?? {},
        }
      : undefined;
  return {
    kind: "tool",
    key: `t:${tool.callId}`,
    turnId: tool.turnId ?? "",
    callId: tool.callId,
    name: tool.name,
    seq: 0,
    status: "running",
    input,
    ...(target !== undefined ? { target } : {}),
    subjects: [],
    permission: undefined,
    resolution: undefined,
    liveOutput: "",
    result: undefined,
  };
}

function EnsembleInitRow({
  entry,
  searchHit,
  ensembleRow,
}: {
  entry: ToolEntry;
  searchHit: boolean;
  ensembleRow: EnsembleRowContextValue;
}) {
  const backgroundView = useContext(BackgroundViewContext);
  const shownName = effectiveToolName(entry);
  const meta = toolMeta(shownName, entry.subjects);
  const title = ensembleToolSummary(shownName, inputOf(entry)) ?? "";
  const isCurrent = ensembleRow.ensemble !== undefined && ensembleRow.currentInitKey === entry.key;
  const ensemble = isCurrent ? ensembleRow.ensemble : undefined;
  const active = ensemble?.status === "active";
  const activeMembers = active
    ? ensemble.members.filter((member) => member.status !== "removed")
    : [];
  const awaitingChildIds = active
    ? new Set(backgroundView.pendingSubagentPermissions.map((item) => item.childSessionId))
    : undefined;
  const dot = active
    ? ensembleStatusDot(ensemble) === "warn" ||
      activeMembers.some((member) => awaitingChildIds?.has(member.childSessionId) === true)
      ? "warn"
      : "ok"
    : undefined;
  const content = (
    <>
      <EnsembleAvatar kind="maestro" size="sm" />
      <span className="tool-name">{meta.label}</span>
      <span className="tool-arg" title={title !== "" ? title : undefined}>
        {title}
      </span>
      {active ? (
        <>
          <span className="ensemble-row-avatars">
            <EnsembleAvatar kind="maestro" size="sm" />
            {activeMembers.map((member) => (
              <EnsembleAvatar
                key={member.name}
                kind="member"
                color={ensembleAuthorColor(ensemble.members, member.name, "member")}
                size="sm"
                warn={
                  member.pendingPermissions.length > 0 ||
                  awaitingChildIds?.has(member.childSessionId) === true
                }
              />
            ))}
          </span>
          {dot !== undefined ? (
            <span className={`sp-ensemble-dot ${dot} ensemble-row-dot`} aria-hidden="true" />
          ) : null}
        </>
      ) : (
        <span className="tool-res">已结束</span>
      )}
      {isCurrent ? (
        <Icon name="right_small" size={ICON_SM} className="ensemble-row-chevron" />
      ) : null}
    </>
  );
  return (
    <article
      className={`tool${searchHit ? " search-hit" : ""}`}
      data-session-seq={entry.seq}
      data-completed-seq={entry.completedSeq}
      aria-label={`工具 ${shownName || entry.callId}`}
    >
      {isCurrent ? (
        <button
          type="button"
          className="tool-line ensemble-row"
          onClick={ensembleRow.onOpen}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              ensembleRow.onOpen();
            }
          }}
        >
          {content}
        </button>
      ) : (
        <div className="tool-line ensemble-row ensemble-row-past">{content}</div>
      )}
    </article>
  );
}

function ToolEntryView({
  entry,
  searchHit = false,
  searchExpand = false,
  cwd,
  preparing = false,
  queued = false,
  waiting = false,
  images,
  session,
}: {
  entry: ToolEntry;
  searchHit?: boolean;
  searchExpand?: boolean;
  cwd: string;
  preparing?: boolean;
  queued?: boolean;
  /** 提问等待回答中：行尾用等待圆点，不计秒 */
  waiting?: boolean;
  images?: AttachmentImageSource | undefined;
  session?: Pick<RpcSession, "readAttachment"> | undefined;
}) {
  const thinkScroll = useContext(ThinkScrollContext);
  const ensembleRow = useContext(EnsembleRowContext);
  const backgroundView = useContext(BackgroundViewContext);
  const pageRow = useContext(PageRowContext);
  if (entry.status === "denied") {
    const shownName = effectiveToolName(entry);
    return (
      <div
        className="note deny"
        title={entry.resolution?.feedback ?? undefined}
        aria-label={`工具 ${shownName || entry.callId} 被拒绝`}
      >
        {deniedLine(entry, cwd)}
      </div>
    );
  }
  // 未读文件即写（not_read）的已结束工具行不显示；执行中照常渲染，出结果后该行消失。
  if (isNotReadToolFailure(entry)) return null;
  const inlineFiles = !preparing ? inlineFilesOfTool(entry) : [];
  if (inlineFiles.length > 0) {
    return (
      <>
        {inlineFiles.map((file, idx) => {
          const pageId = resolveInlinePageId(file);
          const sessionPage = backgroundView.pages.find((p) => p.page === pageId);
          const display = sessionPage?.display ?? resolveInlinePageDisplay(file);
          const version =
            sessionPage?.versions.find((v) => v.file.file === file.file)?.version ??
            file.inline?.version ??
            1;
          if (display === "panel") {
            const onOpenPage = pageRow?.onOpenPage;
            const openInPanel =
              onOpenPage !== undefined
                ? () => {
                    onOpenPage(pageId, version);
                  }
                : undefined;
            const activePage = pageRow?.activePage;
            const isActive = activePage?.page === pageId && activePage.version === version;
            return (
              <PageEntryRow
                key={file.file}
                file={file}
                version={version}
                versions={sessionPage?.versions}
                active={isActive}
                session={session}
                remote={pageRow?.remote}
                onOpenInPanel={openInPanel}
                searchHit={searchHit && idx === 0}
                sessionSeq={idx === 0 ? entry.seq : undefined}
                completedSeq={idx === 0 ? entry.completedSeq : undefined}
              />
            );
          }
          return (
            <InlinePage
              key={file.file}
              file={file}
              session={session}
              remote={pageRow?.remote}
              versions={sessionPage?.versions}
              version={version}
              searchHit={searchHit && idx === 0}
              sessionSeq={idx === 0 ? entry.seq : undefined}
              completedSeq={idx === 0 ? entry.completedSeq : undefined}
              onCollapseAboveViewport={(el) => {
                thinkScroll.collapsed(el);
              }}
              renderFallback={(err) => (
                <FileAttachmentCard file={file} session={session} initialError={err} />
              )}
            />
          );
        })}
      </>
    );
  }
  if (
    !preparing &&
    effectiveToolName(entry) === "ensemble_init" &&
    entry.status === "ok" &&
    ensembleRow !== null
  ) {
    return <EnsembleInitRow entry={entry} searchHit={searchHit} ensembleRow={ensembleRow} />;
  }
  return (
    <ToolRow
      entry={entry}
      searchHit={searchHit}
      searchExpand={searchExpand}
      cwd={cwd}
      preparing={preparing}
      queued={queued}
      waiting={waiting}
      images={images}
      session={session}
    />
  );
}

const TURN_END_LABELS: Record<TurnEndReason, string> = {
  done: "已完成",
  truncated: "回复已截断",
  refused: "已拒绝",
  aborted: "已中断",
  max_steps: "已达到最大步骤数",
  error: "发生错误",
};

function matchesSearchSeq(entry: ViewEntry, seq: number | undefined): boolean {
  if (seq === undefined) return false;
  if (entry.seq === seq) return true;
  return entry.kind === "tool" && entry.completedSeq === seq;
}

function EntryView({
  entry,
  searchHit = false,
  searchExpand = false,
  openUrl,
  cwd,
  parts,
  now,
  images,
  session,
  busy,
  repliesAfter,
  onResubmit,
  pickImages,
  onFork,
  fileLinks,
  showReplyActions,
  onApprovePlan,
  changesCard,
  preparing = false,
  queued = false,
  waitingCallId,
  userRole,
  scheduleSource,
  ensembleRecipientLabel,
  viewSuite,
  onOpenSuiteThread,
  quoteFlash = false,
  quoteFlashMode,
  availableSeqs,
  onJumpQuote,
  quotable = false,
}: {
  entry: ViewEntry;
  searchHit?: boolean;
  searchExpand?: boolean;
  openUrl: OpenUrl;
  cwd: string;
  parts: ReasoningMap;
  now: number;
  images: AttachmentImageSource;
  session: RpcSession | ReadOnlySessionRef;
  busy: boolean;
  repliesAfter: number;
  onResubmit: ConversationProps["onResubmit"];
  pickImages?: ConversationProps["pickImages"];
  onFork?: ConversationProps["onFork"];
  fileLinks: ConversationProps["fileLinks"];
  showReplyActions: boolean;
  onApprovePlan?: (() => void) | undefined;
  changesCard: ReactNode;
  /** 实时工具行（参数尚在流式接收或排队等待执行）以合成 ToolEntry 走同一条渲染路径 */
  preparing?: boolean;
  queued?: boolean;
  /** 与待回答提问同 callId 的工具行：行尾等待圆点，不计秒 */
  waitingCallId?: string | undefined;
  /** 只读视图里用户消息的角色：第一条是任务，之后是催促；缺省 = 普通用户气泡 */
  userRole?: "task" | "nudge" | undefined;
  scheduleSource?: ConversationProps["scheduleSource"];
  ensembleRecipientLabel?: string | undefined;
  viewSuite?: SuiteView | undefined;
  onOpenSuiteThread?: ((threadId: string) => void) | undefined;
  quoteFlash?: boolean;
  quoteFlashMode?: "message" | "text" | undefined;
  availableSeqs?: ReadonlySet<number> | undefined;
  onJumpQuote?: ((quote: MessageQuote) => void) | undefined;
  quotable?: boolean;
}) {
  const subagentLinks = useContext(SubagentLinksContext);
  const backgroundView = useContext(BackgroundViewContext);
  switch (entry.kind) {
    case "user":
      if (entry.suiteReport !== undefined) {
        const report = entry.suiteReport;
        const parsed = parseSuiteThreadReport(userText(entry));
        const thread = viewSuite?.threads.find((item) => item.threadId === report.threadId);
        const title = thread?.title ?? parsed?.title ?? report.threadId;
        const line = parsed?.line ?? thread?.lastReportLine ?? "";
        const dotTone = suiteReportDotTone(report.status, thread);
        return (
          <button
            type="button"
            className={`suite-report-row${searchHit ? " search-hit" : ""}`}
            data-session-seq={entry.seq}
            onClick={() => {
              onOpenSuiteThread?.(report.threadId);
            }}
          >
            <span className={`ensemble-dot suite-dot ${dotTone}`} aria-hidden="true" />
            <span className="suite-report-title">{title}</span>
            <span className="suite-report-line">{line}</span>
            <Icon name="right_small" size={ICON_SM} className="suite-report-arrow" />
          </button>
        );
      }
      if (entry.ensemble !== undefined) {
        const author = ensembleAuthorLabel(entry.ensemble.from, entry.ensemble.fromKind);
        const recipient = ensembleRecipientLabel ?? "指挥";
        return (
          <div className={`post-in${searchHit ? " search-hit" : ""}`} data-session-seq={entry.seq}>
            <div className="post-in-head">
              <span className={entry.ensemble.fromKind === "member" ? "ensemble-who" : undefined}>
                {author}
              </span>
              {` → ${recipient} · #${entry.ensemble.postNumber}`}
            </div>
            <Markdown
              text={unwrapEnsemblePostText(userText(entry))}
              openUrl={openUrl}
              session={isLiveSession(session) ? session : undefined}
              fileLinks={fileLinks}
            />
          </div>
        );
      }
      if (entry.backgroundShell !== undefined) {
        return (
          <details className="ro-user shell-result" aria-label="后台任务">
            <summary>
              <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
              <Icon name="terminal" size={ICON_SM} />
              <span className="ro-user-preview">{shellResultSummary(entry, backgroundView)}</span>
            </summary>
            <pre className="conversation-tool-output">{shellResultText(userText(entry))}</pre>
          </details>
        );
      }
      if (entry.subagent !== undefined) {
        const subagent = entry.subagent;
        return (
          <details className="ro-user subagent-result" aria-label="子代理结果">
            <summary>
              <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
              <span className="ro-user-tag">子代理结果</span>
              <span className="ro-user-preview">
                {subagentResultLine(subagent)}
                {subagent.durationMs !== undefined && ` · ${elapsedText(subagent.durationMs)}`}
              </span>
              {subagentLinks && (
                <button
                  type="button"
                  className="subagent-view"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    subagentLinks.open(subagent.childSessionId);
                  }}
                >
                  在面板中查看
                </button>
              )}
            </summary>
            {subagent.changes && (
              <ul className="subagent-files">
                {subagent.changes.files.map((file) => (
                  <li key={file.path}>
                    {subagentLinks?.diff ? (
                      <button
                        type="button"
                        className="subagent-file"
                        onClick={() => {
                          subagentLinks.diff?.(subagent.childSessionId, file.path);
                        }}
                      >
                        {file.path}
                      </button>
                    ) : (
                      file.path
                    )}
                    {file.additions !== undefined && (
                      <>
                        {" "}
                        <span className="diff-add">+{file.additions}</span>
                        {(file.deletions ?? 0) > 0 && (
                          <>
                            {" "}
                            <span className="diff-del">−{file.deletions}</span>
                          </>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Markdown
              text={subagentResultText(userText(entry), subagent.changes !== undefined)}
              openUrl={openUrl}
              fileLinks={fileLinks}
            />
          </details>
        );
      }
      if (userRole !== undefined) {
        // 只读：任务原文与催促折叠展示，不当作可编辑的用户气泡（没有编辑、重发、分叉）
        return (
          <details className="ro-user" open={searchExpand ? true : undefined}>
            <summary>
              <Icon name="right_small" size={ICON_SM} className="fold-arrow" />
              <span className="ro-user-tag">{userRole === "task" ? "任务" : "催促"}</span>
              <span className="ro-user-preview">
                {Array.from(userText(entry).replace(/\s+/g, " ").trim()).slice(0, 120).join("")}
              </span>
            </summary>
            <UserMessage
              fileLinks={fileLinks}
              entry={entry}
              images={images}
              session={session}
              cwd={cwd}
              busy={false}
              repliesAfter={0}
              onResubmit={undefined}
            />
          </details>
        );
      }
      return (
        <UserMessage
          fileLinks={fileLinks}
          entry={entry}
          searchHit={searchHit}
          images={images}
          session={session}
          cwd={cwd}
          busy={busy}
          repliesAfter={repliesAfter}
          onResubmit={onResubmit}
          pickImages={pickImages}
          onFork={onFork}
          scheduleSource={scheduleSource}
          quoteFlash={quoteFlash}
          quoteFlashMode={quoteFlashMode}
          availableSeqs={availableSeqs}
          onJumpQuote={onJumpQuote}
          quotable={quotable}
        />
      );
    case "assistant":
      if (
        entry.reasoning === "" &&
        parts.get(entry.messageId)?.at(-1) === undefined &&
        entry.text.trim() === "" &&
        entry.finishReason !== "aborted" &&
        (changesCard === null || changesCard === undefined || changesCard === false) &&
        !showReplyActions
      ) {
        return null;
      }
      return (
        <article
          className={`a${searchHit ? " search-hit" : ""}${quoteFlash && quoteFlashMode === "message" ? " quote-flash" : ""}`}
          data-session-seq={entry.seq}
          data-quote-flash={quoteFlash ? (quoteFlashMode ?? "message") : undefined}
          aria-label="助手消息"
        >
          <Think messageId={entry.messageId} text={entry.reasoning} parts={parts} now={now} />
          <Markdown
            text={entry.text}
            openUrl={openUrl}
            session={isLiveSession(session) ? session : undefined}
            fileLinks={fileLinks}
            quoteSourceSeq={quotable ? String(entry.seq) : undefined}
          />
          {entry.finishReason === "aborted" ? (
            <p className="conversation-review">回复已中断</p>
          ) : null}
          {changesCard}
          {showReplyActions && (
            <div className="assistant-actions" role="group" aria-label="回复操作">
              {onApprovePlan && (
                <button type="button" className="u-act" onClick={onApprovePlan}>
                  批准
                </button>
              )}
              <CopyButton text={entry.text} label="复制回复" />
              <time dateTime={entry.time} title={entry.time}>
                {replyTime(entry.time)}
              </time>
            </div>
          )}
        </article>
      );
    case "tool":
      return (
        <ToolEntryView
          entry={entry}
          searchHit={searchHit}
          searchExpand={searchExpand}
          cwd={cwd}
          preparing={preparing}
          queued={queued}
          waiting={entry.callId === waitingCallId}
          images={images}
          session={session}
        />
      );
    case "notice": {
      if (entry.subtype === "permission" || entry.subtype === "config") return null;
      let message = entry.message;
      if (entry.subtype === "turn_end") {
        const reason = (entry.payload as { reason?: TurnEndReason } | null)?.reason;
        if (reason) message = message.replace(`Turn 结束（${reason}）`, TURN_END_LABELS[reason]);
      }
      return <div className="note">{message}</div>;
    }
  }
}

// ── 权限与提问卡片 ──

const permissionLabels: Record<PermissionOption, string> = {
  allow_once: "允许一次",
  allow_session: "本会话允许",
  allow_project: "本项目允许",
  allow_always: "始终允许",
  deny: "拒绝",
  deny_stop: "拒绝并停止",
};
const permissionReplies: Record<PermissionOption, PermissionReply> = {
  allow_once: { decision: "allow" },
  allow_session: { decision: "allow", remember: "session" },
  allow_project: { decision: "allow", remember: "project" },
  allow_always: { decision: "allow", remember: "always" },
  deny: { decision: "deny" },
  deny_stop: { decision: "deny", stop: true },
};

function permissionOperation(pending: PendingPermission): string {
  return operationForSubjectKind(pending.subjects[0]?.kind, pending.toolName ?? "操作");
}

function permissionWhy(pending: PendingPermission): string {
  switch (pending.review?.verdict) {
    case "unsure":
      return "审查器交给你确认";
    case "block":
      return "审查器建议拒绝";
    case "allow":
      return "审查器认为可以执行";
    default:
      return "按权限规则需要确认";
  }
}

function permissionWhyKind(pending: PendingPermission): "unsure" | "block" | "allow" | "rule" {
  switch (pending.review?.verdict) {
    case "unsure":
      return "unsure";
    case "block":
      return "block";
    case "allow":
      return "allow";
    default:
      return "rule";
  }
}

function isDenyActionItem(item: PermissionActionItem): boolean {
  return item.kind === "option" && (item.option === "deny" || item.option === "deny_stop");
}

/** Lock only transport submission; the pending request remains owned by SessionView. */
function useReply<Reply>(send: (reply: Reply) => Promise<void>) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reply = async (value: Reply) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await send(value);
    } catch (cause) {
      locked.current = false;
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return { reply, busy, error };
}

const appIconCache = new Map<string, string>();

export function shellHistoryFromView(
  entries: readonly ViewEntry[],
  ruleEligibleCalls?: ReadonlyMap<string, boolean>,
): PermissionSubject[] {
  const out: PermissionSubject[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    // 规则/Hook/用户等拒绝可能仅结算在 entry.resolution（deny 不发 tool.started）
    if (entry.resolution?.action === "deny" || entry.permission?.action === "deny") continue;

    const requested = ruleEligibleCalls?.get(entry.callId);
    if (requested === false) continue;

    const confirmed =
      requested === true ||
      // 曾由模式 Grant 放行：Core 已证实非 userOnly、非 forceAsk、非组合/高风险
      (entry.permission?.action === "allow" &&
        entry.permission.source === "grant" &&
        entry.permission.grant?.match === "pattern") ||
      (entry.resolution?.action === "allow" &&
        entry.resolution.source === "grant" &&
        entry.resolution.grant?.match === "pattern") ||
      // 规则直接放行（未经过人工 ask/userOnly 确认）
      (entry.permission?.action === "allow" &&
        entry.permission.source === "rule" &&
        entry.resolution?.requestId === undefined &&
        entry.resolution?.source !== "user");
    if (!confirmed) continue;

    for (const subject of entry.subjects) {
      if (subject.kind === "shell") out.push(subject);
    }
  }
  return out;
}

type PermissionActionItem =
  { kind: "option"; option: PermissionOption } | { kind: "rule"; label: string };

export function PermissionCard({
  pending,
  session,
  onRespond,
  source,
  primaryShortcut = true,
  cwd,
  shellKind,
  shellHistory,
  hidePersistentPermissions = false,
  resolveAppIcon,
}: {
  pending: PendingPermission;
  session?: Pick<RpcSession, "respondPermission"> | undefined;
  onRespond?: ((value: PermissionReply) => Promise<void>) | undefined;
  source?: { profile?: string | undefined; taskSummary?: string | undefined } | undefined;
  primaryShortcut?: boolean | undefined;
  cwd: string;
  shellKind?: string | undefined;
  shellHistory?: readonly PermissionSubject[] | undefined;
  hidePersistentPermissions?: boolean;
  resolveAppIcon?: ((app: ApplicationTarget) => Promise<string | undefined>) | undefined;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rulePattern, setRulePattern] = useState<string | null>(null);
  const [inPhone, setInPhone] = useState(false);
  const [icons, setIcons] = useState<ReadonlyMap<string, string>>(() => new Map(appIconCache));
  useEffect(() => {
    setFeedback(null);
    setRulePattern(null);
  }, [pending.requestId]);
  useEffect(() => {
    let alive = true;
    for (const s of pending.subjects) {
      if (s.kind !== "app") continue;
      if (s.app?.icon) {
        appIconCache.set(s.target, s.app.icon);
        continue;
      }
      if (appIconCache.has(s.target) || !resolveAppIcon || !s.app) continue;
      void resolveAppIcon(s.app).then((icon) => {
        if (!alive || !icon) return;
        appIconCache.set(s.target, icon);
        setIcons(new Map(appIconCache));
      });
    }
    return () => {
      alive = false;
    };
  }, [pending.subjects, resolveAppIcon]);
  const { reply, busy, error } = useReply((value: PermissionReply) => {
    if (onRespond !== undefined) return onRespond(value);
    if (session === undefined) return Promise.reject(new Error("会话未连接"));
    return session.respondPermission(pending.requestId, value);
  });
  // 客户端可能比后台旧：不认识的选项跳过，不能让整张卡片抛错
  const known = pending.options.filter((option) => Object.hasOwn(permissionReplies, option));
  const options: PermissionOption[] = (
    known.length ? known : (["allow_once", "deny"] as PermissionOption[])
  ).filter(
    (option) =>
      !hidePersistentPermissions ||
      !["project", "always"].includes(permissionReplies[option].remember ?? ""),
  );
  const shellSubject =
    pending.subjects.length === 1 && pending.subjects[0]?.kind === "shell"
      ? pending.subjects[0]
      : undefined;
  const canTurnIntoRule =
    !hidePersistentPermissions &&
    !inPhone &&
    pending.ruleSuggestion !== undefined &&
    options.includes("allow_project") &&
    shellSubject !== undefined;
  const actionItems: PermissionActionItem[] = [];
  for (const option of options) {
    actionItems.push({ kind: "option", option });
    if (option === "allow_project" && canTurnIntoRule) {
      actionItems.push({ kind: "rule", label: "改成规则…" });
    }
  }
  const allowItems = actionItems.filter((item) => !isDenyActionItem(item));
  const denyItems = actionItems.filter((item) => isDenyActionItem(item));
  const orderedItems = [...allowItems, ...denyItems];
  const ruleValidation =
    rulePattern !== null && shellSubject !== undefined
      ? validateShellRulePattern(
          rulePattern,
          shellSubject.target,
          shellDialect(shellSubject.shell ?? shellKind),
        )
      : undefined;
  const matchedCommands = useMemo(() => {
    if (!ruleValidation?.ok || shellSubject === undefined) return [];
    const fallbackShell =
      shellSubject.shell !== undefined || shellKind === undefined
        ? shellSubject
        : { ...shellSubject, shell: shellKind };
    const list: string[] = [shellSubject.target];
    const seen = new Set<string>(list);
    for (const s of shellHistory ?? []) {
      if (list.length >= 5) break;
      if (seen.has(s.target)) continue;
      if (matchesShellPatternGrant(ruleValidation.pattern, s, fallbackShell)) {
        seen.add(s.target);
        list.push(s.target);
      }
    }
    return list;
  }, [ruleValidation, shellSubject, shellKind, shellHistory]);
  const actionItemsRef = useRef(orderedItems);
  actionItemsRef.current = orderedItems;
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const setFeedbackRef = useRef(setFeedback);
  setFeedbackRef.current = setFeedback;
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const rulePatternRef = useRef(rulePattern);
  rulePatternRef.current = rulePattern;
  const ruleSuggestionRef = useRef(pending.ruleSuggestion);
  ruleSuggestionRef.current = pending.ruleSuggestion;
  const pendingSubjectsRef = useRef(pending.subjects);
  pendingSubjectsRef.current = pending.subjects;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const primaryShortcutRef = useRef(primaryShortcut);
  primaryShortcutRef.current = primaryShortcut;
  const cardRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    setInPhone(cardRef.current?.closest(".phone") != null);
  }, []);

  // 卡片挂载即拿走焦点：数字键/Esc 立刻可用（多卡并发时不抢已聚焦卡）
  useEffect(() => {
    if (!primaryShortcutRef.current) return;
    if (document.activeElement?.closest(".ask") != null) return;
    cardRef.current?.focus();
  }, []);

  // 数字键直选、Esc 直接拒绝（捕获阶段 + preventDefault，不与输入框中断冲突）。
  // Esc 只在以下情况让位：规则表单展开中先退回选项、目标在卡片内部（反馈 textarea 自己处理 Esc 返回选项）、
  // 或输入框的补全/菜单弹层开着（Esc 先关弹层）；焦点在输入框时 Esc 也直接拒绝。
  useEffect(() => {
    const editable = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
    const insideCard = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      cardRef.current !== null &&
      target !== cardRef.current &&
      cardRef.current.contains(target);
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // 设置区盖住会话时（会话区 inert）快捷键属于设置区
      if (cardRef.current?.closest("[inert]") != null) return;
      const activeAsk = document.activeElement?.closest(".ask") ?? null;
      if (activeAsk !== null && activeAsk !== cardRef.current) return;
      if (activeAsk === null && !primaryShortcutRef.current) return;
      if (event.key === "Escape") {
        if (rulePatternRef.current !== null) {
          if (!busyRef.current) {
            event.preventDefault();
            setRulePattern(null);
            cardRef.current?.focus();
          }
          return;
        }
        if (insideCard(event.target)) return;
        if (document.querySelector('[role="menu"], .composer-popup') !== null) return;
        event.preventDefault();
        void replyRef.current({ decision: "deny" });
        return;
      }
      if (feedbackRef.current !== null || rulePatternRef.current !== null) return;
      if (editable(event.target)) return;
      const digit = /^[1-9]$/.exec(event.key);
      if (digit === null) return;
      const item = actionItemsRef.current[Number(digit[0]) - 1];
      if (item === undefined) return;
      event.preventDefault();
      if (item.kind === "rule") {
        const suggestion = ruleSuggestionRef.current;
        if (suggestion !== undefined) setRulePattern(suggestion.pattern);
        return;
      }
      const option = item.option;
      const allApp =
        pendingSubjectsRef.current.length > 0 &&
        pendingSubjectsRef.current.every((subject) => subject.kind === "app");
      if (option === "deny" && !allApp) {
        setFeedbackRef.current("");
      } else {
        void replyRef.current(permissionReplies[option]);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);

  const operation = permissionOperation(pending);
  const why = permissionWhy(pending);
  const whyKind = permissionWhyKind(pending);
  const sourceText = [source?.profile, source?.taskSummary]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  const hover = [pending.reason, pending.review?.reason].filter(Boolean).join("；");
  const networks = pending.subjects.filter((subject) => subject.kind === "network");
  const renderActionButton = (item: PermissionActionItem, allowIndex?: number) => {
    if (item.kind === "rule") {
      return (
        <Button
          key="turn_into_rule"
          variant="default"
          disabled={busy}
          onClick={() => {
            if (pending.ruleSuggestion !== undefined) {
              setRulePattern(pending.ruleSuggestion.pattern);
            }
          }}
        >
          {item.label}
        </Button>
      );
    }
    const option = item.option;
    const label =
      option === "allow_always" && pending.subjects[0]?.kind === "app"
        ? `始终允许 ${pending.subjects[0].app?.name ?? pending.subjects[0].target}`
        : option === "allow_session" && networks.length
          ? `本会话允许访问 ${networks.map((subject) => subject.target).join("、")}`
          : permissionLabels[option];
    const variant =
      allowIndex === 0
        ? "primary"
        : option === "deny_stop"
          ? "danger-text"
          : option === "deny"
            ? "ghost"
            : "default";
    return (
      <Button
        key={option}
        variant={variant}
        disabled={busy}
        onClick={() => {
          if (
            option === "deny" &&
            !(
              pending.subjects.length > 0 &&
              pending.subjects.every((subject) => subject.kind === "app")
            )
          )
            setFeedback("");
          else void reply(permissionReplies[option]);
        }}
      >
        {label}
      </Button>
    );
  };
  return (
    <section className="ask v2" aria-label="权限确认" aria-busy={busy} tabIndex={-1} ref={cardRef}>
      <div className="ask-t" title={hover}>
        <Icon name="safe_shield" size={ICON_MD} className="ask-ico" />
        <span className="ask-op">{operation}</span>
        {sourceText !== "" && (
          <span className="ask-source" title={sourceText}>
            {sourceText}
          </span>
        )}
        <span className={`ask-why ask-why-${whyKind}`}>
          <span className="ask-why-dot" aria-hidden="true" />
          {why}
        </span>
      </div>
      {pending.subjects.length > 0 ? (
        <ul className="ask-subjects">
          {pending.subjects.map((subject, index) => {
            if (subject.kind === "app") {
              const name = subject.appUnresolved
                ? subject.app?.pid !== undefined
                  ? `PID ${subject.app.pid}`
                  : /^PID \d+$/u.test(subject.target)
                    ? subject.target
                    : "操作软件"
                : (subject.app?.name ?? subject.target);
              const title = subject.app?.title ?? subject.detail;
              const icon = subject.app?.icon ?? icons.get(subject.target);
              return (
                <li key={index} className="ask-app">
                  <span className="app-ic" style={{ background: icon ? "transparent" : "#1f7a46" }}>
                    {icon ? <img src={`data:image/png;base64,${icon}`} alt="" /> : (name[0] ?? "A")}
                  </span>
                  <span className="app-name">{name}</span>
                  {!subject.appUnresolved &&
                    !subject.app?.packageFamilyName &&
                    subject.target !== name && <span className="exe">{subject.target}</span>}
                  {title !== undefined && title !== "" && <span className="title">{title}</span>}
                </li>
              );
            }
            if (subject.kind === "schedule") {
              return (
                <li key={index} className="ask-schedule">
                  <span className="ask-target">{subject.target}</span>
                  {subject.detail !== undefined && subject.detail !== "" ? (
                    <FoldedPlainText text={subject.detail} />
                  ) : null}
                </li>
              );
            }
            if (subject.kind === "shell") {
              const prefix = `${subject.shell ?? shellKind ?? "shell"} › `;
              const tail =
                subject.resolved !== undefined && subject.resolved !== subject.target
                  ? `${subject.target} → ${subject.resolved}`
                  : subject.target;
              const full = `${prefix}${tail}`;
              return (
                <li key={index} title={subject.detail ?? full}>
                  <span className="ask-sh">{prefix}</span>
                  {tail}
                </li>
              );
            }
            const shown =
              subject.kind === "network" ? subject.target : displayPath(subject.target, cwd);
            const full =
              subject.resolved !== undefined && subject.resolved !== subject.target
                ? `${shown} → ${subject.resolved}`
                : shown;
            return (
              <li key={index} title={subject.detail ?? full}>
                {full}
              </li>
            );
          })}
        </ul>
      ) : null}
      {rulePattern !== null ? (
        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ruleValidation?.ok || busy) return;
            void reply({
              decision: "allow",
              remember: "pattern",
              pattern: ruleValidation.pattern,
            });
          }}
        >
          <label>
            命令规则
            <input
              autoFocus
              className={`input mono ask-rule-input${ruleValidation?.ok ? "" : " invalid"}`}
              value={rulePattern}
              disabled={busy}
              onChange={(event) => {
                setRulePattern(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  setRulePattern(null);
                  cardRef.current?.focus();
                }
              }}
            />
          </label>
          {ruleValidation?.ok ? (
            <ul className="ask-rule-matches">
              {matchedCommands.map((cmd) => (
                <li key={cmd}>
                  <Icon name="check" size={12} />
                  <span>{cmd}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ask-rule-err" role="alert">
              {ruleValidation?.message}
            </p>
          )}
          <div className="ask-actions">
            <Button type="submit" variant="primary" disabled={busy || !ruleValidation?.ok}>
              允许并保存
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setRulePattern(null);
                cardRef.current?.focus();
              }}
            >
              返回
            </Button>
          </div>
        </form>
      ) : feedback === null ? (
        <div className="ask-actions">
          {allowItems.map((item, index) => renderActionButton(item, index))}
          {denyItems.length > 0 ? (
            <div className="ask-actions-deny">
              {denyItems.map((item) => renderActionButton(item))}
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="ask-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = feedback.trim();
            void reply({ decision: "deny", ...(value ? { feedback: value } : {}) });
          }}
        >
          <label>
            拒绝反馈（可选）
            <textarea
              autoFocus
              value={feedback}
              disabled={busy}
              onChange={(event) => {
                setFeedback(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  setFeedback(null);
                }
              }}
            />
          </label>
          <div className="ask-actions">
            <Button type="submit" disabled={busy}>
              发送拒绝
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setFeedback(null);
              }}
            >
              返回
            </Button>
          </div>
        </form>
      )}
      {busy ? (
        <p className="conversation-review" role="status">
          等待后台确认选择…
        </p>
      ) : null}
      {error ? (
        <p className="conversation-error" role="alert">
          发送失败：{error}
        </p>
      ) : null}
    </section>
  );
}

interface AnswerDraft {
  selected: string[];
  /** 选项题的「其他」输入：null = 未启用（该行是按钮），字符串 = 已就地变成输入框 */
  other: string | null;
  /** 自由文本题的输入（options 为空时） */
  text: string;
  declined: boolean;
  attachments?: AttachmentInput[];
}

const OTHER_TEXT_LIMIT = 2000;
const SINGLE_AUTO_NEXT_MS = 200;
/** 「其他」/自由文本多行框高度上限：约 8 行（8 * 20px + 上下内边距），再多在框内滚动 */
const OTHER_MAX_HEIGHT = 164;
const FREE_MAX_HEIGHT = 176;

function resizeQuestionTextarea(
  el: HTMLTextAreaElement | null,
  maxHeight = OTHER_MAX_HEIGHT,
): void {
  if (el === null) return;
  el.style.height = "auto";
  if (el.scrollHeight > 0) {
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }
}

export function QuestionCard({
  pending,
  session,
  attachmentLimit,
}: {
  pending: PendingQuestion;
  session: RpcSession;
  attachmentLimit?: number;
}) {
  const questions = pending.questions;
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() =>
    questions.map(() => ({ selected: [], other: null, text: "", declined: false })),
  );
  const [cur, setCur] = useState(0);
  const { reply, busy, error } = useReply(async (value: QuestionReply) => {
    const bytes = value.answers.reduce(
      (sum, answer) =>
        sum +
        ("declined" in answer
          ? 0
          : (answer.attachments ?? []).reduce((n, file) => n + file.data.byteLength, 0)),
      0,
    );
    if (attachmentLimit !== undefined && bytes > attachmentLimit) throw new Error("附件过大");
    await session.respondQuestion(pending.requestId, value);
  });
  const cardRef = useRef<HTMLElement>(null);
  const otherRef = useRef<HTMLTextAreaElement | null>(null);
  const freeRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  const addAnswerFiles = async (files: File[]) => {
    const at = stateRef.current.index;
    const attachments = await Promise.all(
      files.map(async (file) => ({
        data: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type || "application/octet-stream",
        label: file.name,
        source: "answer" as const,
      })),
    );
    setDrafts((prev) =>
      prev.map((item, i) =>
        i === at
          ? { ...item, declined: false, attachments: [...(item.attachments ?? []), ...attachments] }
          : item,
      ),
    );
  };
  const index = Math.min(cur, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const draft = drafts[index];
  const last = index === questions.length - 1;
  const isAnswered = (item: AnswerDraft): boolean =>
    item.declined ||
    item.selected.length > 0 ||
    (item.other ?? "").trim() !== "" ||
    item.text.trim() !== "" ||
    (item.attachments?.length ?? 0) > 0;
  const allAnswered =
    questions.length > 0 &&
    questions.every((item, itemIndex) => {
      const itemDraft = drafts[itemIndex];
      return itemDraft !== undefined && isAnswered(itemDraft);
    });

  // 窗口级快捷键经 ref 读最新状态（PermissionCard 同一手法，避免闭包过期）
  const stateRef = useRef({ index, last, busy });
  stateRef.current = { index, last, busy };
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const allRef = useRef(allAnswered);
  allRef.current = allAnswered;
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const chooseRef = useRef<(option: number) => void>(() => undefined);
  const nextRef = useRef<() => void>(() => undefined);

  const go = (next: number): void => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setCur(next);
  };

  const choose = (option: number): void => {
    const at = stateRef.current.index;
    if (stateRef.current.busy) return;
    const current = draftsRef.current[at];
    const currentQuestion = questionsRef.current[at];
    if (current === undefined || currentQuestion === undefined) return;
    if ((currentQuestion.options?.length ?? 0) === 0) return;
    const count = currentQuestion.options?.length ?? 0;
    if (option < 0 || option > count) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    if (option === count) {
      // 「其他」行：点一次就地变成输入框；单选同时清掉已选
      if (current.other !== null) return;
      setDrafts((prev) =>
        prev.map((item, itemIndex) =>
          itemIndex === at
            ? {
                ...item,
                declined: false,
                other: "",
                ...(currentQuestion.multiSelect ? {} : { selected: [] }),
              }
            : item,
        ),
      );
      return;
    }
    const label = currentQuestion.options?.[option]?.label;
    if (label === undefined) return;
    if (currentQuestion.multiSelect === true) {
      setDrafts((prev) =>
        prev.map((item, itemIndex) => {
          if (itemIndex !== at) return item;
          const on = item.selected.includes(label);
          return {
            ...item,
            declined: false,
            attachments: [],
            selected: on
              ? item.selected.filter((entry) => entry !== label)
              : [...item.selected, label],
          };
        }),
      );
      return;
    }
    setDrafts((prev) =>
      prev.map((item, itemIndex) =>
        itemIndex === at
          ? { ...item, declined: false, selected: [label], other: null, attachments: [] }
          : item,
      ),
    );
    // 单选选中即 200ms 后自动下一题；末题停留等提交
    if (at < questionsRef.current.length - 1) {
      const target = at + 1;
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        setCur(target);
      }, SINGLE_AUTO_NEXT_MS);
    }
  };
  chooseRef.current = choose;

  const handleNext = (): void => {
    if (stateRef.current.busy) return;
    const list = questionsRef.current;
    const current = draftsRef.current;
    if (stateRef.current.index < list.length - 1) {
      go(stateRef.current.index + 1);
      return;
    }
    if (!allRef.current) return;
    const answers: QuestionReply["answers"] = current.map((item, itemIndex) => {
      if (item.declined) return { declined: true as const };
      const itemQuestion = list[itemIndex];
      const extra =
        itemQuestion !== undefined && (itemQuestion.options?.length ?? 0) > 0
          ? (item.other ?? "").trim()
          : item.text.trim();
      return {
        selected: item.selected,
        ...(extra !== "" ? { text: extra } : {}),
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
      };
    });
    void replyRef.current({ answers });
  };
  nextRef.current = handleNext;

  const toggleDecline = (): void => {
    const at = stateRef.current.index;
    if (stateRef.current.busy) return;
    if (draftsRef.current[at] === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    const declining = !draftsRef.current[at].declined;
    if (!declining) {
      setDrafts((prev) =>
        prev.map((item, itemIndex) => (itemIndex === at ? { ...item, declined: false } : item)),
      );
      return;
    }
    setDrafts((prev) =>
      prev.map((item, itemIndex) =>
        itemIndex === at ? { ...item, declined: true, selected: [], other: null, text: "" } : item,
      ),
    );
  };

  // 挂载拿走焦点（PermissionCard 同样）：数字键立刻可用。
  // 自由文本题与已展开的「其他」输入框用 autoFocus 接管；切回选项题时回到卡片。
  useEffect(() => {
    const current = draftsRef.current[stateRef.current.index];
    const currentQuestion = questionsRef.current[stateRef.current.index];
    if (current === undefined || currentQuestion === undefined) return;
    const input = cardRef.current?.querySelector<HTMLElement>("input, textarea");
    if (input) input.focus();
    else cardRef.current?.focus();
  }, [index]);

  useEffect(() => {
    resizeQuestionTextarea(otherRef.current, OTHER_MAX_HEIGHT);
    resizeQuestionTextarea(freeRef.current, FREE_MAX_HEIGHT);
  }, [index, draft?.other, draft?.text]);

  // 数字键直选、Enter 下一题/提交：可编辑目标里数字键留给输入；IME 组合中不触发；
  // Shift+Enter 在多行输入里换行；Esc 不处理，留给全局（输入框中断）。设置区盖住时（inert）不响应。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing || composingRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- 旧 IME 用 keyCode 229 标记组合中
      if ((event as KeyboardEvent & { keyCode?: number }).keyCode === 229) return;
      if (cardRef.current?.closest("[inert]") != null) return;
      if (document.querySelector('[role="menu"], .composer-popup') !== null) return;
      if (stateRef.current.busy) return;
      const at = stateRef.current.index;
      const currentQuestion = questionsRef.current[at];
      if (currentQuestion === undefined) return;
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      const inside = target instanceof Node && (cardRef.current?.contains(target) ?? false);
      if (/^[1-9]$/.test(event.key)) {
        if (editable) return;
        const count = (currentQuestion.options?.length ?? 0) + 1;
        if ((currentQuestion.options?.length ?? 0) === 0) return;
        const option = Number(event.key) - 1;
        if (option >= count) return;
        event.preventDefault();
        chooseRef.current(option);
        return;
      }
      if (event.key === "Enter") {
        // 卡片外的可编辑区（状态栏搜索等）的 Enter 不抢
        if (editable && !inside) return;
        if (event.shiftKey) return;
        event.preventDefault();
        nextRef.current();
      }
      if (event.key === "Escape" && editable && inside) {
        event.preventDefault();
        cardRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, []);

  if (question === undefined || draft === undefined) return null;
  const multi = question.multiSelect === true;
  const options = question.options ?? [];
  const otherOn = draft.other !== null;
  const total = options.length + 1;
  const canAttach = options.length === 0 || (otherOn && draft.selected.length === 0);
  const attachmentRow =
    canAttach && (draft.attachments?.length ?? 0) > 0 ? (
      <div className="qattachments">
        {(draft.attachments ?? []).map((file, i) => (
          <span className="fcard" key={i}>
            <span className="ficon" aria-hidden="true">
              {fileIconText(file.label ?? "")}
            </span>
            <span className="fname">{file.label}</span>
            <span className="fsize">{formatBytes(file.data.byteLength)}</span>
            <button
              type="button"
              aria-label={`移除 ${file.label}`}
              disabled={busy}
              onClick={() => {
                setDrafts((prev) =>
                  prev.map((item, at) =>
                    at === index
                      ? { ...item, attachments: item.attachments?.filter((_, n) => n !== i) ?? [] }
                      : item,
                  ),
                );
              }}
            >
              <Icon name="close" size={ICON_SM} />
            </button>
          </span>
        ))}
      </div>
    ) : null;
  return (
    <section className="qcard" aria-label="提问" aria-busy={busy} tabIndex={-1} ref={cardRef}>
      <div className="qhead">
        <span className="qmark" aria-hidden="true">
          ?
        </span>
        <span className="qlabel">
          需要你回答
          {questions.length > 1 && (
            <span className="muted-value">
              {index + 1}/{questions.length}
            </span>
          )}
        </span>
        {questions.length > 1 ? (
          <div className="tabs" role="tablist" aria-label="问题列表">
            {questions.map((item, itemIndex) => {
              const itemDraft = drafts[itemIndex];
              const mark =
                itemDraft === undefined ? null : itemDraft.declined ? (
                  <span className="skip" aria-label="已拒绝回答">
                    —
                  </span>
                ) : itemDraft.selected.length > 0 ||
                  (itemDraft.other ?? "").trim() !== "" ||
                  itemDraft.text.trim() !== "" ? (
                  <span className="ok" aria-label="已回答">
                    ✓
                  </span>
                ) : null;
              return (
                <button
                  key={itemIndex}
                  type="button"
                  className="tab"
                  role="tab"
                  aria-selected={itemIndex === index}
                  disabled={busy}
                  onClick={() => {
                    go(itemIndex);
                  }}
                >
                  {item.header ?? `第${itemIndex + 1}题`}
                  {mark}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div
        className="qbody"
        onDragOver={(event) => {
          if (canAttach) event.preventDefault();
        }}
        onDrop={(event) => {
          if (canAttach && !busy) {
            event.preventDefault();
            void addAnswerFiles(Array.from(event.dataTransfer.files));
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (canAttach && !busy && files.length) {
            event.preventDefault();
            void addAnswerFiles(files);
          }
        }}
      >
        <p className="qtext">{question.question}</p>
        {multi && options.length > 0 ? <p className="qsub">可多选</p> : null}
        {options.length === 0 ? (
          <div>
            {attachmentRow}
            <textarea
              ref={freeRef}
              className="free"
              rows={1}
              autoFocus
              aria-label={`${question.question} · 回答`}
              placeholder="输入回答"
              value={draft.text}
              disabled={busy}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onChange={(event) => {
                const value = Array.from(event.target.value).slice(0, OTHER_TEXT_LIMIT).join("");
                setDrafts((prev) =>
                  prev.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, text: value, declined: false } : item,
                  ),
                );
              }}
            />
          </div>
        ) : (
          <div className={`opts${multi ? " multi" : ""}`} role={multi ? "group" : "radiogroup"}>
            {options.map((option, optionIndex) => {
              const on = draft.selected.includes(option.label);
              const recommended = option.label.endsWith("（推荐）");
              const display = recommended ? option.label.slice(0, -4) : option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  className="opt"
                  role={multi ? "checkbox" : "radio"}
                  aria-checked={on}
                  disabled={busy}
                  onClick={() => {
                    choose(optionIndex);
                  }}
                >
                  <span className="key" aria-hidden="true">
                    {optionIndex + 1}
                  </span>
                  <span className="lab">
                    <span>
                      {display}
                      {recommended ? (
                        <Badge variant="accent" className="rec">
                          推荐
                        </Badge>
                      ) : null}
                    </span>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  <span className="tick" aria-hidden="true">
                    ✓
                  </span>
                </button>
              );
            })}
            {otherOn ? (
              <div className="opt" role={multi ? "checkbox" : "radio"} aria-checked="true">
                <span className="key" aria-hidden="true">
                  {total}
                </span>
                <span className="lab">
                  {attachmentRow}
                  <textarea
                    ref={otherRef}
                    className="other-in"
                    rows={1}
                    autoFocus
                    aria-label={`${question.question} · 其他`}
                    placeholder="自己输入…"
                    value={draft.other ?? ""}
                    disabled={busy}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false;
                    }}
                    onChange={(event) => {
                      const value = Array.from(event.target.value)
                        .slice(0, OTHER_TEXT_LIMIT)
                        .join("");
                      setDrafts((prev) =>
                        prev.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, other: value, declined: false } : item,
                        ),
                      );
                    }}
                  />
                </span>
                <span className="tick" aria-hidden="true">
                  ✓
                </span>
              </div>
            ) : (
              <button
                type="button"
                className="opt"
                role={multi ? "checkbox" : "radio"}
                aria-checked="false"
                disabled={busy}
                onClick={() => {
                  choose(options.length);
                }}
              >
                <span className="key" aria-hidden="true">
                  {total}
                </span>
                <span className="lab">
                  <span className="other-placeholder">其他…</span>
                </span>
                <span className="tick" aria-hidden="true">
                  ✓
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="qfoot">
        {canAttach && (
          <>
            <input
              ref={attachmentInput}
              type="file"
              multiple
              hidden
              aria-label="回答附件"
              disabled={busy}
              onChange={(event) => {
                void addAnswerFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <IconButton
              aria-label="添加文件"
              title="添加文件"
              disabled={busy}
              onClick={() => attachmentInput.current?.click()}
            >
              <Icon name="attachment" size={ICON_MD} />
            </IconButton>
          </>
        )}
        <button type="button" className="link" disabled={busy} onClick={toggleDecline}>
          {draft.declined ? "撤销拒绝回答" : "拒绝回答"}
        </button>
        <KeyHint
          className="hint"
          groups={[
            ...(options.length > 0
              ? [{ keys: ["1", String(total)], range: true, label: "选择" }]
              : []),
            { keys: ["Enter"], label: last ? "提交" : "下一题" },
          ]}
        />
        <span className="sp" />
        {index > 0 ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              go(index - 1);
            }}
          >
            上一题
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          disabled={busy || (last && !allAnswered)}
          onClick={handleNext}
        >
          {last ? "提交" : "下一题"}
        </Button>
      </div>
      {busy ? (
        <p className="conversation-review" role="status">
          正在发送回答…
        </p>
      ) : null}
      {error ? (
        <p className="conversation-error" role="alert">
          发送失败：{error}
        </p>
      ) : null}
    </section>
  );
}

function EnsembleEndedRow({ ensemble }: { ensemble: EnsembleView }) {
  const [open, setOpen] = usePersistedToggle(`ensemble-ended:${ensemble.createdSeq}`, false);
  const unmerged = ensemble.unmerged ?? [];
  const hasUnmerged = unmerged.length > 0;
  return (
    <article className="tool ensemble-ended-row" data-session-seq={ensemble.endedSeq}>
      <details className="tool-details" open={open}>
        <ToolLine
          open={open}
          disabled={!hasUnmerged}
          label="结束"
          arg={{ name: ensemble.title, dir: "", title: ensemble.title }}
          status={null}
          onToggle={() => {
            setOpen((current) => !current);
          }}
        />
        {hasUnmerged && open ? (
          <div className="tool-body">
            <ul className="ensemble-unmerged-list">
              {unmerged.map((item) => (
                <li key={item.name}>
                  <span className="ensemble-who">{`@${item.name}`}</span> <code>{item.branch}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </details>
    </article>
  );
}

export interface ScrollToSessionSeqParams {
  seq: number;
  entries: readonly ViewEntry[];
  entryKeys: readonly string[];
  measuredHeights: ReadonlyMap<string, number>;
  scrollEl: HTMLDivElement | null;
  virtualize: boolean;
  followRef: { current: boolean };
  previousTopRef: { current: number };
  anchorRef: { current: { key: string; topInViewport: number } | null };
  setFollowing: (following: boolean) => void;
  setVirtualRange: (updater: (prev: VirtualRange) => VirtualRange) => void;
}

/**
 * 跨会话搜索、会话内搜索与轮次导航共用的跳转定位函数：
 * 关闭粘底跟随，虚拟化时按估算偏移定位 scrollTop 并把目标条目纳入渲染窗口。
 */
export function scrollToSessionSeq(params: ScrollToSessionSeqParams): boolean {
  const {
    seq,
    entries,
    entryKeys,
    measuredHeights,
    scrollEl,
    virtualize,
    followRef,
    previousTopRef,
    anchorRef,
    setFollowing,
    setVirtualRange,
  } = params;
  followRef.current = false;
  setFollowing(false);
  anchorRef.current = null;
  if (!virtualize) return true;
  const targetIndex = entries.findIndex((entry) => matchesSearchSeq(entry, seq));
  if (targetIndex < 0) return false;
  const currentOffsets = buildVirtualOffsets(entries, entryKeys, measuredHeights);
  const measuredViewport = scrollEl?.clientHeight ?? 0;
  const viewportHeight = measuredViewport > 0 ? measuredViewport : DEFAULT_VIEWPORT_HEIGHT;
  const estScrollTop = Math.max(0, (currentOffsets[targetIndex] ?? 0) - viewportHeight / 2);
  if (scrollEl) {
    scrollEl.scrollTop = estScrollTop;
    previousTopRef.current = scrollEl.scrollTop;
  }
  const nextRange = computeVirtualRange({
    offsets: currentOffsets,
    count: entries.length,
    scrollTop: estScrollTop,
    viewportHeight,
    followBottom: false,
  });
  const clamped: VirtualRange = {
    start: Math.min(nextRange.start, targetIndex),
    end: Math.max(nextRange.end, targetIndex),
  };
  setVirtualRange((prev) =>
    prev.start === clamped.start && prev.end === clamped.end ? prev : clamped,
  );
  return true;
}

function ConversationContent({
  session,
  view,
  openUrl,
  cwd,
  shellKind,
  ruleEligibleCalls,
  subscribeEvents,
  images,
  busy,
  onResubmit,
  pickImages,
  onQuote,
  onApprovePlan,
  onFork,
  fileLinks,
  turnChanges,
  onRewindFiles,
  loadChangeDiff,
  onViewChanges,
  ensembleRecipientLabel,
  hidePersistentPermissions,
  hideRequests = false,
  openWarnings,
  readOnly,
  scheduleSource,
  searchTarget,
  resolveAppIcon,
  localEntries = [],
  entryKey,
  onOpenEnsembleMember,
  onOpenSuiteThread,
  virtualize = false,
  enableFind = false,
  enableTurnNav = false,
  turnNavHidden = false,
}: ContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const [highlightedSeq, setHighlightedSeq] = useState<number | undefined>();
  const [quoteSelection, setQuoteSelection] = useState<QuoteSelectionAnchor | null>(null);
  const quoteBtnRef = useRef<HTMLButtonElement>(null);
  const quoteDismissedRef = useRef(false);
  const [quoteFlash, setQuoteFlash] = useState<{
    seq: number;
    text: string;
    nonce: number;
    mode: "message" | "text";
  } | null>(null);
  const quoteFlashNonceRef = useRef(0);
  const quotable = onQuote !== undefined && readOnly === undefined;
  const { parts, now } = useReasoning(subscribeEvents);
  const liveRuleEligibleRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    liveRuleEligibleRef.current = new Map();
    return subscribeEvents((event) => {
      if (event.type === "permission.requested") {
        liveRuleEligibleRef.current.set(
          event.payload.callId,
          event.payload.ruleSuggestion !== undefined,
        );
      }
    });
  }, [subscribeEvents]);
  const lastEntry = view.entries.at(-1);
  // view.entries 可能在 reduceSessionView 或测试中被原地 push/更新，不能仅以数组引用做 memo 依赖
  const entriesVersion = `${String(view.lastSeq)}:${String(view.entries.length)}:${lastEntry?.key ?? ""}:${
    lastEntry?.kind === "assistant" ? String(lastEntry.text.length) : ""
  }`;
  const users = useMemo(
    () => view.entries.filter((e) => e.kind === "user"),
    [view.entries, entriesVersion],
  );
  const lastSeq = users.at(-1)?.seq;
  const firstUserSeq = users[0]?.seq;
  /** 只读视图里的用户消息是任务/催促，不是可编辑的气泡；Ensemble 成员会话里的私信保留用户消息气泡 */
  const roleOf = (entry: ViewEntry): "task" | "nudge" | undefined =>
    readOnly === undefined || ensembleRecipientLabel !== undefined || entry.kind !== "user"
      ? undefined
      : entry.seq === firstUserSeq
        ? "task"
        : "nudge";
  const changesByKey = useMemo(() => {
    const map = new Map<string, TurnChanges>();
    for (const [index, user] of users.entries()) {
      const turn = turnChanges?.get(user.seq);
      if (
        !turn ||
        (!turn.files.length && !turn.untrackedCalls) ||
        (user.seq === lastSeq && view.currentTurn !== undefined)
      )
        continue;
      const nextSeq = users[index + 1]?.seq ?? Infinity;
      const entries = view.entries.filter((e) => e.seq >= user.seq && e.seq < nextSeq);
      const anchor =
        entries.findLast((e) => e.kind === "assistant" && e.text.trim() !== "") ?? entries.at(-1);
      if (anchor) map.set(anchor.key, turn);
    }
    return map;
  }, [users, turnChanges, lastSeq, view.currentTurn, view.entries, entriesVersion]);
  const renderChanges = (turn: TurnChanges | undefined) =>
    turn && onRewindFiles && loadChangeDiff && isLiveSession(session) ? (
      <TurnChangesCard
        key={turn.seq}
        turn={turn}
        latest={turn.seq === lastSeq}
        busy={busy}
        cwd={cwd}
        session={session}
        onRewind={onRewindFiles}
        loadDiff={loadChangeDiff}
        renderDiff={(diff, path) => <DiffBody diff={diff} path={path} />}
        onViewChanges={onViewChanges}
      />
    ) : null;
  const { replyActionKeys, latestReplyKey } = useMemo(() => {
    const replies = new Map<string, string>();
    let userSeq: number | undefined;
    for (const entry of view.entries) {
      if (entry.kind === "user") userSeq = entry.seq;
      if (
        entry.kind !== "assistant" ||
        entry.text.trim() === "" ||
        entry.turnId === view.currentTurn?.turnId ||
        (userSeq !== undefined && userSeq === lastSeq && view.currentTurn !== undefined)
      )
        continue;
      const key = userSeq === undefined ? entry.turnId : String(userSeq);
      replies.set(key, entry.key);
    }
    const keys = new Set(replies.values());
    return { replyActionKeys: keys, latestReplyKey: [...keys].at(-1) };
  }, [view.entries, view.currentTurn, lastSeq, entriesVersion]);
  const canApprovePlan = view.plan !== undefined && !busy && onApprovePlan !== undefined;
  const entryKeys = useMemo(
    () => new Set(view.entries.map((entry) => entry.key)),
    [view.entries, entriesVersion],
  );
  // U-01：每条用户消息之后将被撤回的回复轮数（按助手 turnId 去重）
  const repliesAfter = useMemo(() => {
    const counts = new Map<number, number>();
    let replies = 0;
    const turns = new Set<string>();
    for (let index = view.entries.length - 1; index >= 0; index -= 1) {
      const entry = view.entries[index];
      if (entry === undefined) continue;
      if (entry.kind === "assistant") {
        if (!turns.has(entry.turnId)) {
          turns.add(entry.turnId);
          replies += 1;
        }
      } else if (entry.kind === "user") {
        counts.set(entry.seq, replies);
      }
    }
    return counts;
  }, [view.entries, entriesVersion]);

  const [entryUiState] = useState<EntryUiStateStore>(() => {
    const toggles = new Map<string, boolean>();
    const records = new Map<string, Record<string, boolean>>();
    return {
      getToggle: (key) => toggles.get(key),
      setToggle: (key, value) => {
        toggles.set(key, value);
      },
      getRecord: (key) => records.get(key),
      setRecord: (key, value) => {
        records.set(key, value);
      },
    };
  });

  const entryKeysList = useMemo(
    () => view.entries.map((entry) => entryKey?.(entry.key) ?? entry.key),
    [view.entries, entryKey, entriesVersion],
  );
  const entryKeysListRef = useRef(entryKeysList);
  entryKeysListRef.current = entryKeysList;
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const pinnedKeysRef = useRef<Set<string>>(new Set());
  const itemNodesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const anchorRef = useRef<{ key: string; topInViewport: number } | null>(null);
  const offsets = useMemo(
    () =>
      virtualize
        ? buildVirtualOffsets(view.entries, entryKeysList, measuredHeightsRef.current)
        : new Float64Array(0),
    [virtualize, view.entries, entryKeysList, entriesVersion],
  );
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const [virtualRange, setVirtualRange] = useState<VirtualRange>(() =>
    virtualize
      ? computeVirtualRange({
          offsets,
          count: view.entries.length,
          scrollTop: 0,
          viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
          followBottom: true,
        })
      : { start: 0, end: -1 },
  );
  const virtualRangeRef = useRef(virtualRange);
  const effectiveRange: VirtualRange = virtualize
    ? following
      ? computeVirtualRange({
          offsets,
          count: view.entries.length,
          scrollTop: 0,
          viewportHeight: scroll.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT,
          followBottom: true,
        })
      : virtualRange
    : { start: 0, end: view.entries.length - 1 };
  virtualRangeRef.current = effectiveRange;

  const captureAnchor = useCallback(() => {
    const scrollEl = scroll.current;
    if (!scrollEl) {
      anchorRef.current = null;
      return;
    }
    const scrollTopRect = scrollEl.getBoundingClientRect().top;
    let best: { index: number; key: string; topInViewport: number } | null = null;
    for (const [index, node] of itemNodesRef.current) {
      const key = entryKeysListRef.current[index];
      if (key === undefined) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.bottom > scrollTopRect + 1) {
        if (best === null || index < best.index) {
          best = { index, key, topInViewport: rect.top - scrollTopRect };
        }
      }
    }
    anchorRef.current = best !== null ? { key: best.key, topInViewport: best.topInViewport } : null;
  }, []);

  const restoreAnchor = useCallback(() => {
    const scrollEl = scroll.current;
    const anchor = anchorRef.current;
    if (!scrollEl || anchor === null || follow.current) return;
    const index = entryKeysListRef.current.indexOf(anchor.key);
    if (index < 0) return;
    const node = itemNodesRef.current.get(index);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0) return;
    const actualTop = rect.top - scrollEl.getBoundingClientRect().top;
    const drift = actualTop - anchor.topInViewport;
    if (Math.abs(drift) > 0.5) {
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + drift);
      previousTop.current = scrollEl.scrollTop;
    }
  }, []);

  const measureMountedItems = useCallback(() => {
    for (const [index, node] of itemNodesRef.current) {
      const key = entryKeysListRef.current[index];
      if (key === undefined) continue;
      const height = node.getBoundingClientRect().height;
      if (height > 0) {
        measuredHeightsRef.current.set(key, height);
      }
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  }, []);
  const entriesRef = useRef(view.entries);
  entriesRef.current = view.entries;
  const jumpNonceRef = useRef(0);
  const [jumpTarget, setJumpTarget] = useState<{ seq: number; nonce: number } | undefined>();
  const scrolledNonce = useRef<number | undefined>(undefined);
  const jumpToSeq = useCallback(
    (seq: number): void => {
      scrollToSessionSeq({
        seq,
        entries: entriesRef.current,
        entryKeys: entryKeysListRef.current,
        measuredHeights: measuredHeightsRef.current,
        scrollEl: scroll.current,
        virtualize,
        followRef: follow,
        previousTopRef: previousTop,
        anchorRef,
        setFollowing,
        setVirtualRange,
      });
      jumpNonceRef.current += 1;
      setJumpTarget({ seq, nonce: jumpNonceRef.current });
    },
    [virtualize],
  );
  const handledSearchNonce = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (searchTarget?.seq === undefined) return;
    const seq = searchTarget.seq;
    if (handledSearchNonce.current !== searchTarget.nonce) {
      handledSearchNonce.current = searchTarget.nonce;
      jumpToSeq(seq);
    }
    setHighlightedSeq(seq);
    const timer = window.setTimeout(() => {
      setHighlightedSeq(undefined);
    }, 1800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchTarget, jumpToSeq]);
  useEffect(() => {
    if (jumpTarget === undefined || scrolledNonce.current === jumpTarget.nonce) return;
    const seq = jumpTarget.seq;
    const anchor = content.current?.querySelector<HTMLElement>(
      `[data-session-seq="${seq}"], [data-completed-seq="${seq}"]`,
    );
    if (anchor === null || anchor === undefined) {
      if (virtualize) {
        scrollToSessionSeq({
          seq,
          entries: entriesRef.current,
          entryKeys: entryKeysListRef.current,
          measuredHeights: measuredHeightsRef.current,
          scrollEl: scroll.current,
          virtualize: true,
          followRef: follow,
          previousTopRef: previousTop,
          anchorRef,
          setFollowing,
          setVirtualRange,
        });
      }
      return;
    }
    const frame = requestAnimationFrame(() => {
      scrolledNonce.current = jumpTarget.nonce;
      anchor.scrollIntoView({ block: "center" });
      if (virtualize) {
        previousTop.current = scroll.current?.scrollTop ?? 0;
        captureAnchor();
      }
      scheduleTurnSyncRef.current();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [
    jumpTarget,
    entriesVersion,
    effectiveRange.start,
    effectiveRange.end,
    virtualize,
    captureAnchor,
  ]);

  const availableSeqs = useMemo(() => {
    const set = new Set<number>();
    for (const entry of view.entries) set.add(entry.seq);
    return set;
  }, [view.entries, entriesVersion]);

  const handleJumpQuote = useCallback(
    (quote: MessageQuote) => {
      if (quote.seq === undefined || !availableSeqs.has(quote.seq)) return;
      jumpToSeq(quote.seq);
      quoteFlashNonceRef.current += 1;
      setQuoteFlash({
        seq: quote.seq,
        text: quote.text,
        nonce: quoteFlashNonceRef.current,
        mode: "message",
      });
    },
    [availableSeqs, jumpToSeq],
  );

  const appliedQuoteFlashNonce = useRef<number | undefined>(undefined);
  const quoteFlashTimers = useRef<{ fade?: number; clear?: number }>({});
  useEffect(() => {
    return () => {
      if (quoteFlashTimers.current.fade !== undefined) {
        window.clearTimeout(quoteFlashTimers.current.fade);
      }
      if (quoteFlashTimers.current.clear !== undefined) {
        window.clearTimeout(quoteFlashTimers.current.clear);
      }
      clearQuoteFlashHighlight();
    };
  }, []);
  useEffect(() => {
    if (quoteFlash === null || appliedQuoteFlashNonce.current === quoteFlash.nonce) return;
    const anchor = content.current?.querySelector<HTMLElement>(
      `[data-session-seq="${quoteFlash.seq}"]`,
    );
    if (anchor === null || anchor === undefined) return;
    appliedQuoteFlashNonce.current = quoteFlash.nonce;
    if (quoteFlashTimers.current.fade !== undefined) {
      window.clearTimeout(quoteFlashTimers.current.fade);
    }
    if (quoteFlashTimers.current.clear !== undefined) {
      window.clearTimeout(quoteFlashTimers.current.clear);
    }
    clearQuoteFlashHighlight();

    const bodyContainer =
      anchor.querySelector<HTMLElement>(":scope > .conversation-markdown, .u-text") ?? anchor;
    const ranges = findQuoteRangesInElement(bodyContainer, quoteFlash.text);
    const highlightedText = ranges.length > 0 && applyQuoteFlashHighlight(ranges, false);
    if (highlightedText) {
      setQuoteFlash((prev) =>
        prev?.nonce === quoteFlash.nonce ? { ...prev, mode: "text" } : prev,
      );
      quoteFlashTimers.current.fade = window.setTimeout(() => {
        applyQuoteFlashHighlight(ranges, true);
      }, QUOTE_FLASH_FADE_AT_MS);
    }
    const activeNonce = quoteFlash.nonce;
    quoteFlashTimers.current.clear = window.setTimeout(() => {
      clearQuoteFlashHighlight();
      setQuoteFlash((prev) => (prev?.nonce === activeNonce ? null : prev));
    }, QUOTE_FLASH_DURATION_MS);
  }, [quoteFlash, entriesVersion, effectiveRange.start, effectiveRange.end]);

  useEffect(() => {
    if (!quotable) {
      setQuoteSelection(null);
      return;
    }
    const syncSelection = () => {
      if (quoteDismissedRef.current) return;
      const next = readQuoteSelection(window.getSelection(), rootRef.current, scroll.current);
      setQuoteSelection(next);
    };
    const onSelectionChange = () => {
      quoteDismissedRef.current = false;
      syncSelection();
    };
    const onMouseUp = () => {
      syncSelection();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      syncSelection();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && quoteBtnRef.current?.contains(target) === true) return;
      setQuoteSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        quoteDismissedRef.current = true;
        setQuoteSelection(null);
      }
    };
    const onScrollOrResize = () => {
      syncSelection();
    };
    const scrollEl = scroll.current;
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    scrollEl?.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      scrollEl?.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [quotable]);

  // ── 会话内搜索（Ctrl+F，ADR-0107） ──
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [debouncedFindQuery, setDebouncedFindQuery] = useState("");
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [findCurrentSeq, setFindCurrentSeq] = useState<number | undefined>();
  const [findFallbackSeq, setFindFallbackSeq] = useState<number | undefined>();
  const findDebounceTimerRef = useRef<number | undefined>(undefined);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;
  const debouncedFindQueryRef = useRef(debouncedFindQuery);
  debouncedFindQueryRef.current = debouncedFindQuery;
  const findCurrentSeqRef = useRef(findCurrentSeq);
  findCurrentSeqRef.current = findCurrentSeq;

  const getViewportFirstEntryIndex = useCallback((): number => {
    const scrollEl = scroll.current;
    const contentEl = content.current;
    const entries = entriesRef.current;
    if (scrollEl !== null && contentEl !== null) {
      const scrollTopRect = scrollEl.getBoundingClientRect().top;
      const nodes = contentEl.querySelectorAll<HTMLElement>("[data-session-seq]");
      let firstVisibleSeq: number | undefined;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.height <= 0) continue;
        if (rect.bottom > scrollTopRect + 1) {
          const raw = node.getAttribute("data-session-seq");
          if (raw !== null) {
            firstVisibleSeq = Number(raw);
            break;
          }
        }
      }
      if (firstVisibleSeq !== undefined) {
        const idx = entries.findIndex((entry) => entry.seq === firstVisibleSeq);
        if (idx >= 0) return idx;
      }
      if (virtualize && scrollEl.scrollTop > 0) {
        return findIndexAtOffset(offsetsRef.current, entries.length, scrollEl.scrollTop);
      }
    }
    return 0;
  }, [virtualize]);

  const openFind = useCallback(() => {
    if (findDebounceTimerRef.current !== undefined) {
      window.clearTimeout(findDebounceTimerRef.current);
      findDebounceTimerRef.current = undefined;
    }
    const prefill = extractSelectionPrefill(scroll.current);
    const nextQuery = prefill ?? findQueryRef.current;
    setFindOpen(true);
    setFindQuery(nextQuery);
    setDebouncedFindQuery(nextQuery);
    setFindFocusNonce((n) => n + 1);
    if (nextQuery.trim() === "") {
      setFindCurrentSeq(undefined);
      setFindFallbackSeq(undefined);
      return;
    }
    const matches = findConversationMatches(entriesRef.current, nextQuery);
    if (matches.length === 0) {
      setFindCurrentSeq(undefined);
      setFindFallbackSeq(undefined);
      return;
    }
    const existing =
      findOpenRef.current &&
      findCurrentSeqRef.current !== undefined &&
      nextQuery === debouncedFindQueryRef.current
        ? matches.find((item) => item.seq === findCurrentSeqRef.current)
        : undefined;
    if (existing !== undefined) return;
    const initialIdx = pickInitialMatchIndex(matches, getViewportFirstEntryIndex());
    const target = matches[initialIdx];
    if (target !== undefined) {
      setFindCurrentSeq(target.seq);
      jumpToSeq(target.seq);
    }
  }, [getViewportFirstEntryIndex, jumpToSeq]);

  const closeFind = useCallback(() => {
    if (findDebounceTimerRef.current !== undefined) {
      window.clearTimeout(findDebounceTimerRef.current);
      findDebounceTimerRef.current = undefined;
    }
    setFindOpen(false);
    setFindCurrentSeq(undefined);
    setFindFallbackSeq(undefined);
    clearConversationHighlights();
    const mainPane = rootRef.current?.closest(".mainpane") ?? document;
    mainPane.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }, []);

  const handleFindQueryChange = useCallback(
    (value: string) => {
      setFindQuery(value);
      if (findDebounceTimerRef.current !== undefined) {
        window.clearTimeout(findDebounceTimerRef.current);
        findDebounceTimerRef.current = undefined;
      }
      if (value.trim() === "") {
        setDebouncedFindQuery("");
        setFindCurrentSeq(undefined);
        setFindFallbackSeq(undefined);
        return;
      }
      findDebounceTimerRef.current = window.setTimeout(() => {
        findDebounceTimerRef.current = undefined;
        setDebouncedFindQuery(value);
        const matches = findConversationMatches(entriesRef.current, value);
        if (matches.length === 0) {
          setFindCurrentSeq(undefined);
          return;
        }
        const initialIdx = pickInitialMatchIndex(matches, getViewportFirstEntryIndex());
        const target = matches[initialIdx];
        if (target !== undefined) {
          setFindCurrentSeq(target.seq);
          jumpToSeq(target.seq);
        }
      }, FIND_DEBOUNCE_MS);
    },
    [getViewportFirstEntryIndex, jumpToSeq],
  );

  const stepFind = useCallback(
    (direction: 1 | -1) => {
      const query = findQueryRef.current;
      if (findDebounceTimerRef.current !== undefined) {
        window.clearTimeout(findDebounceTimerRef.current);
        findDebounceTimerRef.current = undefined;
      }
      const queryChanged = query !== debouncedFindQueryRef.current;
      if (queryChanged) {
        setDebouncedFindQuery(query);
      }
      const matches = findConversationMatches(entriesRef.current, query);
      if (matches.length === 0) {
        setFindCurrentSeq(undefined);
        return;
      }
      const nextIdx = queryChanged
        ? pickInitialMatchIndex(matches, getViewportFirstEntryIndex())
        : stepMatchIndex(
            matches.findIndex((item) => item.seq === findCurrentSeqRef.current),
            matches.length,
            direction,
          );
      const target = matches[nextIdx];
      if (target !== undefined) {
        setFindCurrentSeq(target.seq);
        jumpToSeq(target.seq);
      }
    },
    [getViewportFirstEntryIndex, jumpToSeq],
  );

  useEffect(() => {
    if (!enableFind) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.key === "Process") return;
      if (
        hasPrimaryModOrMetaOnOther(event) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        if (!canHandleConversationShortcut(rootRef.current, event)) return;
        event.preventDefault();
        openFind();
        return;
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        findOpenRef.current &&
        rootRef.current !== null &&
        rootRef.current.closest("[inert]") === null
      ) {
        const active = document.activeElement instanceof Element ? document.activeElement : null;
        if (active === null || active === document.body || rootRef.current.contains(active)) {
          event.preventDefault();
          closeFind();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [enableFind, openFind, closeFind]);

  useEffect(() => {
    return () => {
      if (findDebounceTimerRef.current !== undefined) {
        window.clearTimeout(findDebounceTimerRef.current);
      }
      clearConversationHighlights();
    };
  }, []);

  const findMatches = useMemo(
    () => (findOpen ? findConversationMatches(view.entries, debouncedFindQuery) : []),
    [findOpen, view.entries, entriesVersion, debouncedFindQuery],
  );
  const findCurrentIndex = useMemo(() => {
    if (!findOpen || findMatches.length === 0 || findCurrentSeq === undefined) return -1;
    return findMatches.findIndex((item) => item.seq === findCurrentSeq);
  }, [findOpen, findMatches, findCurrentSeq]);
  const activeFindSeq =
    findOpen && findCurrentIndex >= 0 ? findMatches[findCurrentIndex]?.seq : undefined;

  const liveTextVersion = view.live.assistants
    .map((assistant) => `${assistant.messageId}:${String(assistant.text.length)}`)
    .join(",");

  useLayoutEffect(() => {
    if (!findOpen || debouncedFindQuery.trim() === "") {
      clearConversationHighlights();
      setFindFallbackSeq(undefined);
      return;
    }
    const result = applyConversationHighlights(content.current, debouncedFindQuery, activeFindSeq);
    const nextFallback =
      activeFindSeq !== undefined && result.currentMounted && !result.currentHasDomMatch
        ? activeFindSeq
        : undefined;
    setFindFallbackSeq((prev) => (prev === nextFallback ? prev : nextFallback));
  }, [
    findOpen,
    debouncedFindQuery,
    activeFindSeq,
    entriesVersion,
    liveTextVersion,
    effectiveRange.start,
    effectiveRange.end,
  ]);

  // ── 轮次导航与 Alt+↑/↓（ADR-0107） ──
  const turns = useMemo(
    () => (enableTurnNav ? extractConversationTurns(view.entries) : []),
    [enableTurnNav, view.entries, entriesVersion],
  );
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const [railNarrow, setRailNarrow] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number>(() =>
    turns.length > 0 ? turns.length - 1 : -1,
  );
  const currentTurnIndexRef = useRef(currentTurnIndex);
  currentTurnIndexRef.current = currentTurnIndex;
  const turnSyncRafRef = useRef<number | undefined>(undefined);

  const syncCurrentTurn = useCallback(() => {
    const list = turnsRef.current;
    if (list.length === 0) {
      setCurrentTurnIndex((prev) => (prev === -1 ? prev : -1));
      return;
    }
    const scrollEl = scroll.current;
    const contentEl = content.current;
    const entries = entriesRef.current;
    let midEntryIndex: number | undefined;
    if (scrollEl !== null && contentEl !== null) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const midClientY = scrollRect.top + scrollRect.height / 2;
      const nodes = contentEl.querySelectorAll<HTMLElement>("[data-session-seq]");
      let lastBeforeMidSeq: number | undefined;
      let anyMeasured = false;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.height <= 0) continue;
        anyMeasured = true;
        if (rect.top <= midClientY) {
          const raw = node.getAttribute("data-session-seq");
          if (raw !== null) lastBeforeMidSeq = Number(raw);
        }
      }
      if (anyMeasured) {
        if (lastBeforeMidSeq !== undefined) {
          const idx = entries.findIndex((entry) => entry.seq === lastBeforeMidSeq);
          if (idx >= 0) midEntryIndex = idx;
        } else {
          midEntryIndex = 0;
        }
      } else if (virtualize && scrollEl.scrollTop > 0) {
        midEntryIndex = findIndexAtOffset(
          offsetsRef.current,
          entries.length,
          scrollEl.scrollTop + scrollEl.clientHeight / 2,
        );
      }
    }
    let nextIdx: number;
    if (midEntryIndex !== undefined) {
      nextIdx = findCurrentTurnIndex(list, midEntryIndex);
    } else if (follow.current) {
      nextIdx = list.length - 1;
    } else if (currentTurnIndexRef.current >= 0) {
      nextIdx = Math.min(currentTurnIndexRef.current, list.length - 1);
    } else {
      nextIdx = list.length - 1;
    }
    setCurrentTurnIndex((prev) => (prev === nextIdx ? prev : nextIdx));
  }, [virtualize]);

  const scheduleTurnSync = useCallback(() => {
    if (!enableTurnNav) return;
    if (turnSyncRafRef.current !== undefined) return;
    turnSyncRafRef.current = requestAnimationFrame(() => {
      turnSyncRafRef.current = undefined;
      syncCurrentTurn();
    });
  }, [enableTurnNav, syncCurrentTurn]);
  const scheduleTurnSyncRef = useRef(scheduleTurnSync);
  scheduleTurnSyncRef.current = scheduleTurnSync;

  useEffect(() => {
    return () => {
      if (turnSyncRafRef.current !== undefined) {
        cancelAnimationFrame(turnSyncRafRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!enableTurnNav) return;
    syncCurrentTurn();
  }, [enableTurnNav, turns.length, entriesVersion, syncCurrentTurn]);

  useLayoutEffect(() => {
    if (!enableTurnNav) return;
    const root = rootRef.current;
    if (root === null) return;
    const updateSize = (width: number, height: number) => {
      const nextNarrow = width > 0 && width < MIN_WIDTH_FOR_RAIL;
      setRailNarrow((prev) => (prev === nextNarrow ? prev : nextNarrow));
      if (height > 0) {
        setRailHeight((prev) => (Math.abs(prev - height) < 1 ? prev : height));
      }
    };
    updateSize(root.clientWidth, root.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((items) => {
      const box = items[0]?.contentRect;
      if (box !== undefined) {
        updateSize(box.width, box.height);
      } else {
        updateSize(root.clientWidth, root.clientHeight);
      }
      scheduleTurnSyncRef.current();
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, [enableTurnNav]);

  const jumpToTurn = useCallback(
    (seq: number, index: number) => {
      setCurrentTurnIndex(index);
      jumpToSeq(seq);
    },
    [jumpToSeq],
  );

  useEffect(() => {
    if (!enableTurnNav || turnNavHidden) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.key === "Process"
      )
        return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const list = turnsRef.current;
      if (list.length === 0) return;
      if (!canHandleConversationShortcut(rootRef.current, event)) return;
      const mainPane = rootRef.current?.closest(".mainpane") ?? document;
      if (mainPane.querySelector('.composer [role="listbox"]') !== null) return;
      event.preventDefault();
      const nextIdx = stepTurnIndex(
        currentTurnIndexRef.current,
        list.length,
        event.key === "ArrowUp" ? -1 : 1,
      );
      const target = list[nextIdx];
      if (target !== undefined) {
        jumpToTurn(target.seq, nextIdx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [enableTurnNav, turnNavHidden, jumpToTurn]);

  const showTurnRail = enableTurnNav && turns.length >= MIN_TURNS_FOR_RAIL && !railNarrow;

  useLayoutEffect(() => {
    if (virtualize) {
      measureMountedItems();
      if (follow.current) scrollToBottom();
      else restoreAnchor();
    } else if (follow.current) {
      scrollToBottom();
    }
  });
  // 思考块收起：跟随最新时留在底部（先于滚动事件把位置定下来，跟随不会被误关）；
  // 否则标题行若已在视野上方，把它滚回顶部，读者停在刚收起的位置
  const [thinkScroll] = useState<ThinkScroll>(() => ({
    viewportHeight: () => scroll.current?.clientHeight ?? Number.POSITIVE_INFINITY,
    collapsed: (header) => {
      const element = scroll.current;
      if (!element) return;
      if (follow.current) {
        element.scrollTop = element.scrollHeight;
        previousTop.current = element.scrollTop;
        return;
      }
      const delta = header.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (delta < 0) {
        element.scrollTop += delta;
        previousTop.current = element.scrollTop;
      }
      captureAnchor();
    },
  }));
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (virtualize) {
        measureMountedItems();
        if (follow.current) scrollToBottom();
        else restoreAnchor();
      } else if (follow.current) {
        scrollToBottom();
      }
    });
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => {
      observer.disconnect();
    };
  }, [virtualize, measureMountedItems, scrollToBottom, restoreAnchor]);
  const updateVirtualWindowFromScroll = useCallback(
    (element: HTMLDivElement, nextFollowing: boolean) => {
      if (!virtualize) return;
      if (nextFollowing) {
        anchorRef.current = null;
        return;
      }
      captureAnchor();
      const currentOffsets = buildVirtualOffsets(
        view.entries,
        entryKeysListRef.current,
        measuredHeightsRef.current,
      );
      offsetsRef.current = currentOffsets;
      const next = computeVirtualRange({
        offsets: currentOffsets,
        count: view.entries.length,
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        followBottom: false,
      });
      const prev = virtualRangeRef.current;
      if (next.start !== prev.start || next.end !== prev.end) {
        setVirtualRange(next);
      }
    },
    [virtualize, view.entries, captureAnchor],
  );
  const inner = (
    <div className={`conversation${showTurnRail ? " has-turn-rail" : ""}`} ref={rootRef}>
      {enableFind && findOpen ? (
        <ConversationFindBar
          query={findQuery}
          currentIndex={findCurrentIndex}
          total={findMatches.length}
          focusNonce={findFocusNonce}
          onQueryChange={handleFindQueryChange}
          onPrev={() => {
            stepFind(-1);
          }}
          onNext={() => {
            stepFind(1);
          }}
          onClose={closeFind}
        />
      ) : null}
      {showTurnRail ? (
        <TurnRail
          turns={turns}
          currentIndex={currentTurnIndex}
          containerHeight={railHeight}
          hidden={turnNavHidden}
          onJump={jumpToTurn}
        />
      ) : null}
      {quotable && quoteSelection !== null ? (
        <button
          ref={quoteBtnRef}
          type="button"
          className="quote-reply-btn"
          aria-label="回复"
          title="回复"
          style={{ left: `${quoteSelection.left}px`, top: `${quoteSelection.top}px` }}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            const picked = quoteSelection.quote;
            setQuoteSelection(null);
            window.getSelection()?.removeAllRanges();
            onQuote(picked);
          }}
        >
          <Icon name="corner_down_left" size={ICON_SM} className="quote-reply-icon" />
          回复
        </button>
      ) : null}
      <div
        className="stream conversation-stream conversation-scroll"
        ref={scroll}
        role="region"
        aria-label="会话消息"
        tabIndex={0}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            follow.current = false;
            setFollowing(false);
            if (scroll.current) updateVirtualWindowFromScroll(scroll.current, false);
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          let nextFollowing = follow.current;
          if (element.scrollHeight - element.clientHeight - element.scrollTop <= 2) {
            follow.current = true;
            setFollowing(true);
            nextFollowing = true;
          } else if (element.scrollTop < previousTop.current) {
            follow.current = false;
            setFollowing(false);
            nextFollowing = false;
          }
          previousTop.current = element.scrollTop;
          updateVirtualWindowFromScroll(element, nextFollowing);
          scheduleTurnSync();
        }}
      >
        <ThinkScrollContext.Provider value={thinkScroll}>
          <div className="conversation-transcript" ref={content}>
            {openWarningsToShow(openWarnings, view.notices).map((warning, index) => (
              <div
                key={`open-warning:${index}`}
                className="conversation-notice conversation-notice-warning"
                role="alert"
              >
                {warning}
              </div>
            ))}
            {(() => {
              const byAfterEntry = new Map<
                number,
                { notice: (typeof view.notices)[number]; index: number }[]
              >();
              const trailing: { notice: (typeof view.notices)[number]; index: number }[] = [];
              view.notices.forEach((notice, index) => {
                if (MCP_STATE_NOTICE_CODES.has(notice.code)) return;
                if (notice.afterEntry === undefined) {
                  trailing.push({ notice, index });
                  return;
                }
                const pos = Math.min(Math.max(0, notice.afterEntry), view.entries.length);
                const list = byAfterEntry.get(pos) ?? [];
                list.push({ notice, index });
                byAfterEntry.set(pos, list);
              });
              const renderNotice = ({
                notice,
                index,
              }: {
                notice: (typeof view.notices)[number];
                index: number;
              }) => (
                <div
                  key={`notice:${index}`}
                  className={`conversation-notice conversation-notice-${notice.level}`}
                  role={notice.level === "info" ? "status" : "alert"}
                  title={notice.code}
                >
                  {notice.message}
                </div>
              );
              const ensemble = view.ensemble;
              // 结束行按 endedSeq 定位在对应条目之后（无条目早于 endedSeq 时放在最前，缺省 endedSeq 时放在末尾）
              const ensembleEnded = ensemble?.status === "ended" ? ensemble : undefined;
              let ensembleEndedAfterIdx: number | undefined;
              let ensembleEndedTrailing = false;
              if (ensembleEnded !== undefined) {
                if (ensembleEnded.endedSeq === undefined) {
                  ensembleEndedTrailing = true;
                } else {
                  let idx = -1;
                  for (const [i, item] of view.entries.entries()) {
                    if (item.seq <= ensembleEnded.endedSeq) idx = i;
                  }
                  if (idx === view.entries.length - 1) {
                    ensembleEndedTrailing = true;
                  } else {
                    ensembleEndedAfterIdx = idx;
                  }
                }
              }

              const renderEntryBlock = (entry: ViewEntry, entryIndex: number) => (
                <>
                  <EntryView
                    entry={entry}
                    searchHit={
                      matchesSearchSeq(entry, highlightedSeq) ||
                      matchesSearchSeq(entry, findFallbackSeq)
                    }
                    searchExpand={
                      matchesSearchSeq(entry, searchTarget?.seq) ||
                      matchesSearchSeq(entry, activeFindSeq)
                    }
                    openUrl={openUrl}
                    cwd={cwd}
                    parts={parts}
                    now={now}
                    images={images}
                    session={session}
                    busy={busy}
                    waitingCallId={view.pendingQuestion?.callId}
                    userRole={roleOf(entry)}
                    repliesAfter={entry.kind === "user" ? (repliesAfter.get(entry.seq) ?? 0) : 0}
                    scheduleSource={
                      entry.kind === "user" && entry.seq === firstUserSeq
                        ? scheduleSource
                        : undefined
                    }
                    ensembleRecipientLabel={ensembleRecipientLabel}
                    viewSuite={view.suite}
                    onOpenSuiteThread={onOpenSuiteThread}
                    onResubmit={onResubmit}
                    pickImages={pickImages}
                    onFork={onFork}
                    fileLinks={fileLinks}
                    quoteFlash={quoteFlash?.seq === entry.seq}
                    quoteFlashMode={quoteFlash?.seq === entry.seq ? quoteFlash.mode : undefined}
                    availableSeqs={availableSeqs}
                    onJumpQuote={handleJumpQuote}
                    quotable={quotable}
                    showReplyActions={replyActionKeys.has(entry.key)}
                    onApprovePlan={
                      canApprovePlan && entry.key === latestReplyKey ? onApprovePlan : undefined
                    }
                    changesCard={
                      entry.kind === "assistant" ? renderChanges(changesByKey.get(entry.key)) : null
                    }
                  />
                  {entry.kind !== "assistant" && renderChanges(changesByKey.get(entry.key))}
                  {(byAfterEntry.get(entryIndex + 1) ?? []).map(renderNotice)}
                  {ensembleEnded !== undefined && ensembleEndedAfterIdx === entryIndex ? (
                    <EnsembleEndedRow
                      key={`ensemble-ended:${ensembleEnded.createdSeq}`}
                      ensemble={ensembleEnded}
                    />
                  ) : null}
                </>
              );

              const renderEntries = () => {
                if (!virtualize) {
                  return view.entries.map((entry, entryIndex) => (
                    <Fragment key={entryKeysList[entryIndex] ?? entry.key}>
                      {renderEntryBlock(entry, entryIndex)}
                    </Fragment>
                  ));
                }
                if (effectiveRange.end >= effectiveRange.start) {
                  const lo = Math.max(0, effectiveRange.start);
                  const hi = Math.min(view.entries.length - 1, effectiveRange.end);
                  for (let i = lo; i <= hi; i += 1) {
                    const item = view.entries[i];
                    const itemKey = entryKeysList[i];
                    if (
                      item !== undefined &&
                      itemKey !== undefined &&
                      isPinnedInlineHtmlEntry(item)
                    ) {
                      pinnedKeysRef.current.add(itemKey);
                    }
                  }
                }
                const pinnedIndices: number[] = [];
                if (pinnedKeysRef.current.size > 0) {
                  for (let i = 0; i < entryKeysList.length; i += 1) {
                    const itemKey = entryKeysList[i];
                    if (itemKey !== undefined && pinnedKeysRef.current.has(itemKey)) {
                      pinnedIndices.push(i);
                    }
                  }
                }
                if (jumpTarget !== undefined) {
                  const targetIdx = view.entries.findIndex((entry) =>
                    matchesSearchSeq(entry, jumpTarget.seq),
                  );
                  if (targetIdx >= 0) pinnedIndices.push(targetIdx);
                }
                const segments = buildVirtualSegments({
                  count: view.entries.length,
                  range: effectiveRange,
                  pinnedIndices,
                  offsets,
                });
                return (
                  <div className="conversation-virtual-list">
                    {segments.map((segment) => {
                      if (segment.kind === "spacer") {
                        return (
                          <div
                            key={segment.key}
                            className="conversation-virtual-spacer"
                            aria-hidden="true"
                            style={{ height: `${String(segment.height)}px` }}
                          />
                        );
                      }
                      const entry = view.entries[segment.index];
                      if (entry === undefined) return null;
                      const key = entryKeysList[segment.index] ?? entry.key;
                      return (
                        <div
                          key={key}
                          className="conversation-virtual-item"
                          data-virtual-index={segment.index}
                          ref={(node) => {
                            if (node !== null) itemNodesRef.current.set(segment.index, node);
                            else itemNodesRef.current.delete(segment.index);
                          }}
                        >
                          {renderEntryBlock(entry, segment.index)}
                        </div>
                      );
                    })}
                  </div>
                );
              };

              return (
                <>
                  {(byAfterEntry.get(0) ?? []).map(renderNotice)}
                  {ensembleEnded !== undefined && ensembleEndedAfterIdx === -1 ? (
                    <EnsembleEndedRow
                      key={`ensemble-ended:${ensembleEnded.createdSeq}`}
                      ensemble={ensembleEnded}
                    />
                  ) : null}
                  {virtualize ? renderEntries() : null}
                  {[
                    ...(virtualize ? [] : (renderEntries() as ReactNode[])),
                    ...localEntries.map((entry) => (
                      <Fragment key={entry.key}>
                        <EntryView
                          entry={entry}
                          openUrl={openUrl}
                          cwd={cwd}
                          parts={parts}
                          now={now}
                          images={images}
                          session={session}
                          busy={busy}
                          userRole={roleOf(entry)}
                          repliesAfter={0}
                          onResubmit={undefined}
                          onFork={undefined}
                          fileLinks={fileLinks}
                          availableSeqs={availableSeqs}
                          onJumpQuote={handleJumpQuote}
                          showReplyActions={false}
                          changesCard={null}
                        />
                      </Fragment>
                    )),
                    ...view.live.assistants.map((assistant) => (
                      <article
                        className="a"
                        key={`assistant:${assistant.messageId}`}
                        aria-label="助手实时回复"
                      >
                        <Think
                          messageId={assistant.messageId}
                          text={assistant.reasoning}
                          parts={parts}
                          now={now}
                        />
                        <Markdown text={assistant.text} openUrl={openUrl} />
                      </article>
                    )),
                    // 实时工具行与正式条目同在这一个数组、同用 key t:<callId>、同一组件树：
                    // reducer 提升条目时 React 只移动节点，不卸载重挂。
                    ...view.live.tools
                      .filter((tool) => !entryKeys.has(`t:${tool.callId}`))
                      .map((tool) => {
                        const entry = preparingEntry(tool);
                        return (
                          <Fragment key={entry.key}>
                            <EntryView
                              entry={entry}
                              openUrl={openUrl}
                              cwd={cwd}
                              parts={parts}
                              now={now}
                              images={images}
                              session={session}
                              busy={busy}
                              repliesAfter={0}
                              onResubmit={onResubmit}
                              fileLinks={fileLinks}
                              showReplyActions={false}
                              changesCard={null}
                              preparing
                              queued={tool.queued === true}
                            />
                            {null}
                          </Fragment>
                        );
                      }),
                  ]}
                  {ensembleEndedTrailing && ensembleEnded !== undefined ? (
                    <EnsembleEndedRow
                      key={`ensemble-ended:${ensembleEnded.createdSeq}`}
                      ensemble={ensembleEnded}
                    />
                  ) : null}
                  {trailing.map(renderNotice)}
                </>
              );
            })()}
            {readOnly?.footer}
          </div>
        </ThinkScrollContext.Provider>
      </div>
      {!following ? (
        <div className="conversation-jump-row">
          <Button
            className="conversation-jump"
            onClick={() => {
              follow.current = true;
              anchorRef.current = null;
              setFollowing(true);
              scrollToBottom();
            }}
          >
            回到最新消息
          </Button>
        </div>
      ) : null}
      {(() => {
        if (readOnly !== undefined) {
          return readOnly.requests !== undefined ? (
            <div className="conversation-requests">{readOnly.requests}</div>
          ) : null;
        }
        if (hideRequests || !isLiveSession(session)) return null;
        const allPending = allPendingPermissions(view);
        const { cards: pendingPermissions, awaitingMembers } =
          onOpenEnsembleMember !== undefined
            ? partitionEnsemblePermissions(allPending, view.ensemble)
            : { cards: allPending, awaitingMembers: [] };
        if (pendingPermissions.length === 0 && awaitingMembers.length === 0) return null;
        const activeEnsemble = view.ensemble?.status === "active" ? view.ensemble : undefined;
        const mergedRuleEligible =
          liveRuleEligibleRef.current.size === 0
            ? ruleEligibleCalls
            : ruleEligibleCalls === undefined || ruleEligibleCalls.size === 0
              ? liveRuleEligibleRef.current
              : new Map([...ruleEligibleCalls, ...liveRuleEligibleRef.current]);
        const shellHistory = shellHistoryFromView(view.entries, mergedRuleEligible);
        return (
          <div className="conversation-requests">
            {pendingPermissions.map((item, index) =>
              item.kind === "session" ? (
                <PermissionCard
                  key={`permission:${item.permission.requestId}`}
                  pending={item.permission}
                  session={session}
                  cwd={cwd}
                  primaryShortcut={index === 0}
                  shellHistory={shellHistory}
                  {...(hidePersistentPermissions !== undefined
                    ? { hidePersistentPermissions }
                    : {})}
                  {...(shellKind !== undefined ? { shellKind } : {})}
                  {...(resolveAppIcon !== undefined ? { resolveAppIcon } : {})}
                />
              ) : (
                // 子代理转发请求属于 childSessionId，父对话未加载该子会话视图时不混入父会话历史
                <PermissionCard
                  key={`subagent-permission:${item.permission.childSessionId}:${item.permission.requestId}`}
                  pending={item.permission}
                  onRespond={(value) =>
                    session.respondSubagentPermission(
                      item.permission.childSessionId,
                      item.permission.requestId,
                      value,
                    )
                  }
                  source={{
                    profile: item.permission.profile,
                    taskSummary: item.permission.taskSummary,
                  }}
                  cwd={cwd}
                  primaryShortcut={index === 0}
                  {...(hidePersistentPermissions !== undefined
                    ? { hidePersistentPermissions }
                    : {})}
                  {...(shellKind !== undefined ? { shellKind } : {})}
                  {...(resolveAppIcon !== undefined ? { resolveAppIcon } : {})}
                />
              ),
            )}
            {activeEnsemble !== undefined && onOpenEnsembleMember !== undefined
              ? awaitingMembers.map((member) => {
                  const modelLabel = ensembleMemberMetaLabel(member);
                  return (
                    <button
                      key={`ensemble-ask:${member.childSessionId}`}
                      type="button"
                      className="ensemble-ask-hint"
                      onClick={() => {
                        onOpenEnsembleMember({
                          name: member.name,
                          childSessionId: member.childSessionId,
                        });
                      }}
                    >
                      <EnsembleAvatar
                        kind="member"
                        color={ensembleAuthorColor(activeEnsemble.members, member.name, "member")}
                        size="sm"
                        warn
                      />
                      <span className="ensemble-ask-name">{member.name}</span>
                      {modelLabel !== "" ? (
                        <span className="ensemble-ask-meta">{modelLabel}</span>
                      ) : null}
                      <span className="ensemble-ask-status">等待确认</span>
                      <Icon name="right_small" size={ICON_SM} className="ensemble-ask-chevron" />
                    </button>
                  );
                })
              : null}
          </div>
        );
      })()}
    </div>
  );
  return virtualize ? (
    <EntryUiStateContext.Provider value={entryUiState}>{inner}</EntryUiStateContext.Provider>
  ) : (
    inner
  );
}

export function Conversation(props: ConversationProps | ReadOnlyConversationProps) {
  const readOnly = "readOnly" in props ? props.readOnly : undefined;
  const links = "subagentLinks" in props ? props.subagentLinks : undefined;
  const onOpenEnsemble = "onOpenEnsemble" in props ? props.onOpenEnsemble : undefined;
  const onOpenPage = "onOpenPage" in props ? props.onOpenPage : undefined;
  const activePage = "activePage" in props ? props.activePage : undefined;
  const pageRow: PageRowContextValue | null =
    readOnly === undefined ? { onOpenPage, activePage, remote: props.remote } : null;
  const ensembleRow: EnsembleRowContextValue | null =
    readOnly === undefined && onOpenEnsemble !== undefined
      ? {
          ensemble: props.view.ensemble,
          currentInitKey: currentEnsembleInitKey(props.view.entries, props.view.ensemble),
          onOpen: onOpenEnsemble,
        }
      : null;
  return (
    <ImageViewerBoundary saveFile={props.saveFile}>
      <FrozenContext.Provider value={readOnly?.frozen === true}>
        <SubagentLinksContext.Provider value={readOnly === undefined ? (links ?? null) : null}>
          <EnsembleRowContext.Provider value={ensembleRow}>
            <PageRowContext.Provider value={pageRow}>
              <BackgroundViewContext.Provider value={props.view}>
                <ShellSessionContext.Provider
                  value={
                    readOnly === undefined && isLiveSession(props.session)
                      ? props.session
                      : undefined
                  }
                >
                  <MessageSkillsContext.Provider value={props.skills}>
                    <ConversationContent key={props.session.id} {...props} />
                  </MessageSkillsContext.Provider>
                </ShellSessionContext.Provider>
              </BackgroundViewContext.Provider>
            </PageRowContext.Provider>
          </EnsembleRowContext.Provider>
        </SubagentLinksContext.Provider>
      </FrozenContext.Provider>
    </ImageViewerBoundary>
  );
}
