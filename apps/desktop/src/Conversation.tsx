import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { marked, type Token, type Tokens } from "marked";
import {
  parseFileRefs,
  splitCodeRef,
  type PendingPermission,
  type ImageAttachment,
  type PendingQuestion,
  type PermissionOption,
  type PermissionReply,
  type QuestionReply,
  type RewindMode,
  type RewindTarget,
  type RuntimeEvent,
  type SessionView,
  type ToolEntry,
  type TurnEndReason,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { isAllowedExternalUrl } from "./external-url";
import { fileRefTitle, userText } from "./file-refs";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { displayPath } from "./paths";
import { useReasoning, type ReasoningMap } from "./reasoning";
import "./conversation.css";

export interface ConversationProps {
  session: RpcSession;
  view: SessionView;
  openUrl: (url: string) => void;
  /** 会话工作区（工具行与权限主体里的路径相对化） */
  cwd: string;
  /** 会话生效 Shell 种类（权限主体行前缀） */
  shellKind?: string | undefined;
  /** 本会话的事件订阅（思考时长簿记；tracker 之外的第二个订阅点） */
  subscribeEvents: (listener: (event: RuntimeEvent) => void) => () => void;
  images: AttachmentImageSource;
  /** 非空闲（Turn 进行中 / 等待确认）时禁用重发与编辑重发（U-01） */
  busy: boolean;
  /** 重发一条用户消息：先 rewind(targetSeq, mode) 再 submit（Conversations.resubmit） */
  onResubmit: (targetSeq: number, text: string, mode: RewindMode) => Promise<void>;
  /**
   * 回答内文件引用的打开能力（U-09，方案 A）：缺省时 codespan 保持普通
   * 行内代码。历史助手消息传入，实时流式消息不传（流式中引用不完整）。
   */
  fileLinks?: FileLinkHooks | undefined;
}

/** 回答内文件引用（U-09）：存在性经后台只读接口，打开经宿主能力。 */
export interface FileLinkHooks {
  /** 左键默认动作用的程序名（"打开文件用"设置），菜单「打开」项的说明 */
  openerLabel: () => string;
  /** 左键：按"打开文件用"设置打开（编辑器带行号，系统默认不带） */
  open: (absolutePath: string, line?: number) => Promise<void>;
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
}

type OpenUrl = ConversationProps["openUrl"];

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
const inputOf = (entry: ToolEntry): Record<string, unknown> | undefined =>
  entry.input !== null && typeof entry.input === "object"
    ? (entry.input as Record<string, unknown>)
    : undefined;

/**
 * 文件引用收集与渲染共用的解析选项（两处 token 流必须一致）。
 * `breaks` 让段落内的单个换行按聊天惯例显示为换行，而不是被
 * CommonMark 软换行折叠成空格；多出的 br token 由 markdownNodes 渲染。
 */
const MARKED_OPTIONS = { gfm: true, breaks: true } as const;

/** Only lexer tokens become React elements. Raw HTML and remote images stay inert text. */
function markdownNodes(tokens: readonly Token[], openUrl: OpenUrl): ReactNode[] {
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
        const content = markdownNodes(heading.tokens, openUrl);
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
        return <p key={key}>{markdownNodes((token as Tokens.Paragraph).tokens, openUrl)}</p>;
      case "text": {
        const node = token as Tokens.Text;
        return (
          <Fragment key={key}>
            {node.tokens ? markdownNodes(node.tokens, openUrl) : node.text}
          </Fragment>
        );
      }
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case "strong":
        return <strong key={key}>{markdownNodes((token as Tokens.Strong).tokens, openUrl)}</strong>;
      case "em":
        return <em key={key}>{markdownNodes((token as Tokens.Em).tokens, openUrl)}</em>;
      case "del":
        return <del key={key}>{markdownNodes((token as Tokens.Del).tokens, openUrl)}</del>;
      case "codespan":
        return <CodeRef key={key} text={(token as Tokens.Codespan).text} />;
      case "code": {
        const code = token as Tokens.Code;
        return (
          <div key={key} className="conversation-code">
            {code.lang ? <div className="conversation-code-language">{code.lang}</div> : null}
            <pre>
              <code>{code.text}</code>
            </pre>
          </div>
        );
      }
      case "blockquote":
        return (
          <blockquote key={key}>
            {markdownNodes((token as Tokens.Blockquote).tokens, openUrl)}
          </blockquote>
        );
      case "hr":
        return <hr key={key} />;
      case "br":
        return <br key={key} />;
      case "link": {
        const link = token as Tokens.Link;
        const content = markdownNodes(link.tokens, openUrl);
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
              <input
                type="checkbox"
                checked={item.checked === true}
                disabled
                aria-label="任务完成状态"
              />
            ) : null}
            {markdownNodes(item.tokens, openUrl)}
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
          <div key={key} className="conversation-table">
            <table>
              <thead>
                <tr>
                  {table.header.map((cell, cellIndex) => (
                    <th key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                      {markdownNodes(cell.tokens, openUrl)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                        {markdownNodes(cell.tokens, openUrl)}
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

function Markdown({
  text: markdown,
  openUrl,
  session,
  fileLinks,
}: {
  text: string;
  openUrl: OpenUrl;
  session?: RpcSession | undefined;
  fileLinks?: FileLinkHooks | undefined;
}) {
  const [refs, setRefs] = useState<Map<string, ResolvedCodeRef> | null>(null);
  useEffect(() => {
    if (session === undefined || fileLinks === undefined) {
      setRefs(null);
      return;
    }
    let alive = true;
    // 收集本消息 codespan 里的候选路径，一次批量 resolveFiles
    const paths: string[] = [];
    const seen = new Set<string>();
    const collect = (tokens: readonly Token[]) => {
      for (const token of tokens) {
        if (token.type === "codespan") {
          const split = splitCodeRef((token as Tokens.Codespan).text);
          if (split !== undefined && !seen.has(split.path)) {
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
    <div className="conversation-markdown">
      <FileLinksContext.Provider value={lookup}>
        {markdownNodes(marked.lexer(markdown, MARKED_OPTIONS), openUrl)}
      </FileLinksContext.Provider>
    </div>
  );
}

/**
 * 行内代码的文件引用（U-09）：存在的文件渲染成「类型图标 + 路径」链接。
 * 工作区内：左键按"打开文件用"设置打开（目录交给系统），右键开菜单
 * （打开、资源管理器、检测到的编辑器、复制绝对/相对路径）。工作区外：
 * 不直接打开，左右键都开菜单且只有资源管理器与复制绝对路径。
 * 不存在 → 普通行内代码。
 */
function CodeRef({ text }: { text: string }) {
  const context = useContext(FileLinksContext);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (context === null) return <code>{text}</code>;
  const hit = context.lookup(text);
  if (hit === undefined) return <code>{text}</code>;
  const { hooks } = context;
  const canOpen = hit.withinWorkspace;
  const editors = hooks.editors();
  const run = (action: () => Promise<void>) => {
    setAnchor(null);
    setError(null);
    void action().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  const openDefault = () =>
    hit.isDirectory ? hooks.openFolder(hit.absolutePath) : hooks.open(hit.absolutePath, hit.line);
  const relative = hit.relativePath;
  return (
    <>
      <button
        type="button"
        className="file-ref-link"
        title={`${hit.absolutePath}\n${canOpen ? "单击打开，右键更多" : "工作区外的文件：单击查看选项"}`}
        onClick={(event) => {
          if (canOpen) run(openDefault);
          else setAnchor(event.currentTarget);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setError(null);
          setAnchor(event.currentTarget);
        }}
      >
        <FileGlyph directory={hit.isDirectory} />
        <span className="file-ref-text">{text}</span>
      </button>
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
                detail={
                  hit.isDirectory
                    ? "资源管理器"
                    : `${hooks.openerLabel()}${hit.line !== undefined ? ` · 第 ${hit.line} 行` : ""}`
                }
                onSelect={() => {
                  run(openDefault);
                }}
              />
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={<MenuGlyph kind="folder" />}
            label="资源管理器"
            onSelect={() => {
              run(() => hooks.reveal(hit.absolutePath));
            }}
          />
          {canOpen && !hit.isDirectory && editors.vscode && (
            <MenuItem
              icon={<MenuGlyph kind="editor" />}
              label="VS Code"
              onSelect={() => {
                run(() => hooks.openInEditor("vscode", hit.absolutePath, hit.line));
              }}
            />
          )}
          {canOpen && !hit.isDirectory && editors.cursor && (
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

/** 文件引用前的类型图标：文件 / 目录（描边，随文字色） */
function FileGlyph({ directory }: { directory: boolean }) {
  return (
    <svg className="file-ref-glyph" viewBox="0 0 16 16" aria-hidden="true">
      {directory ? (
        <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" />
      ) : (
        <path d="M4 1.5h5l3.5 3.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1ZM9 1.5V5h3.5" />
      )}
    </svg>
  );
}

/** 文件引用菜单的通用图标（不用编辑器商标） */
function MenuGlyph({ kind }: { kind: "folder" | "editor" | "copy" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
      {kind === "folder" && (
        <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" />
      )}
      {kind === "editor" && <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3l-2 10" />}
      {kind === "copy" && (
        <path d="M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.5 10.5v-7a1 1 0 0 1 1-1h7" />
      )}
    </svg>
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

function durationText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)} 秒`;
  const rest = seconds % 60;
  return `${String(Math.floor(seconds / 60))} 分${rest > 0 ? ` ${String(rest)} 秒` : ""}`;
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
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const header = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const reveal = useRef(false);
  const part = parts.get(messageId)?.at(-1);
  const body = reasoning !== "" ? reasoning : (part?.text ?? "");

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
  const label =
    seconds < 1 ? "思考" : part?.active === true ? `思考中 ${seconds}s` : `思考了 ${seconds}s`;
  if (body === "") return <div className="think">{label}</div>;
  const openLabel =
    seconds < 1
      ? "思考"
      : `${part?.active === true ? "思考中" : "思考"} · ${durationText(seconds)}`;
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
        <span className="think-label">{open ? openLabel : label}</span>
        <span className="think-tw" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <>
          <pre ref={bodyRef}>{body}</pre>
          {tall && (
            <div className="think-end">
              <button type="button" onClick={collapse}>
                ▴ 收起思考
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.8"
        y="2.8"
        width="12.4"
        height="10.4"
        rx="1.8"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
      />
      <circle cx="5.6" cy="6.3" r="1.2" fill="currentColor" stroke="none" />
      <path
        d="m2.5 12 3.8-3.6 2.6 2.2 2-1.7 2.8 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UserImage({
  attachment,
  images,
  session,
  visible,
}: {
  attachment: ImageAttachment;
  images: AttachmentImageSource;
  session: RpcSession;
  visible: boolean;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!visible) return;
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
  }, [attachment, images, session, visible]);
  if (error !== undefined) {
    return (
      <span className="u-img-chip" title={`图片加载失败：${error}`}>
        <ImageIcon />
        {attachment.file}
      </span>
    );
  }
  if (url !== undefined) {
    return (
      <span className="u-img-frame">
        <img
          className="u-img"
          src={url}
          alt={attachment.label ?? attachment.file}
          onError={() => {
            setError("图片无法解码或显示");
          }}
        />
      </span>
    );
  }
  return (
    <span
      className="u-img-placeholder"
      role="status"
      aria-label={`加载图片：${attachment.file}`}
      aria-busy={visible}
      title={visible ? "图片加载中…" : "图片进入可视区后加载"}
    >
      <ImageIcon />
    </span>
  );
}

/**
 * 用户消息（U-01）：悬停显示「复制」「编辑并重发」「重发」。重发与编辑重发
 * 先 rewind 再 submit——成功前旧回复保持显示（编辑中变暗，见 .u.editing ~ *）。
 */
function UserMessage({
  entry,
  images,
  session,
  cwd,
  busy,
  repliesAfter,
  onResubmit,
}: {
  entry: UserEntry;
  images: AttachmentImageSource;
  session: RpcSession;
  cwd: string;
  busy: boolean;
  /** 这条消息之后将被撤回的回复轮数（助手 turn 数） */
  repliesAfter: number;
  onResubmit: ConversationProps["onResubmit"];
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"both" | "conversation">("both");
  const [target, setTarget] = useState<RewindTarget | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
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
  refs.forEach((ref, index) => {
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
  const copy = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setError("剪贴板不可用");
      return;
    }
    void clipboard
      .writeText(body)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      })
      .catch(() => {
        setError("复制失败");
      });
  };
  const startEdit = () => {
    setError(undefined);
    setPending(true);
    void session
      .rewindTargets()
      .then((targets) => {
        setTarget(targets.find((item) => item.seq === entry.seq));
        setDraft(body);
        setMode("both");
        setEditing(true);
      })
      .catch((reason: unknown) => {
        setError(`读取回退信息失败：${reasonText(reason)}`);
      })
      .finally(() => {
        setPending(false);
      });
  };
  const sendResubmit = (content: string, rewindMode: "both" | "conversation") => {
    setError(undefined);
    setPending(true);
    void onResubmit(entry.seq, content, rewindMode).catch((reason: unknown) => {
      // 回退/发送失败：编辑内容保留（编辑框仍打开时错误显示在框内）
      setError(`重发失败：${reasonText(reason)}`);
      setPending(false);
    });
  };
  const busyTitle = busy ? "请先等待或按 Esc 中断" : undefined;
  const restorable = target?.files.filter((file) => file.action !== "untracked") ?? [];
  return (
    <article className={`u${editing ? " editing" : ""}`} aria-label="用户消息">
      <div className="u-body">
        {editing ? (
          <div className="u-edit">
            <textarea
              aria-label="编辑消息"
              value={draft}
              rows={Math.min(12, Math.max(2, draft.split("\n").length + 1))}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !pending) {
                  event.preventDefault();
                  setEditing(false);
                  setError(undefined);
                }
              }}
            />
            <p className="u-edit-info">
              将撤回 {repliesAfter} 轮回复
              {restorable.length > 0
                ? `，将还原 ${restorable.length} 个文件：${restorable
                    .map((file) => displayPath(file.path, cwd))
                    .join("、")}`
                : ""}
              {(target?.untrackedCalls ?? 0) > 0
                ? `；另有 ${target?.untrackedCalls} 次命令改动不还原`
                : ""}
            </p>
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
              <button
                type="button"
                className="btn primary"
                disabled={pending || draft.trim() === ""}
                onClick={() => {
                  sendResubmit(draft, mode);
                }}
              >
                {pending ? "发送中…" : "发送"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setError(undefined);
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="u-bubble" ref={bubble}>
              {(entry.attachments ?? []).map((attachment, index) => (
                <UserImage
                  key={`${attachment.file}:${attachment.sha256}:${index}`}
                  attachment={attachment}
                  images={images}
                  session={session}
                  visible={visible}
                />
              ))}
              {body !== "" && <div className="u-text">{segments}</div>}
              {entry.skill && (
                <details className="skill-message">
                  <summary>
                    技能 <b>{entry.skill.name}</b> · 已附加正文{" "}
                    {entry.skill.body.length.toLocaleString()} 字 ▸
                  </summary>
                  <pre>{entry.skill.body}</pre>
                </details>
              )}
              {entry.delegate && (
                <details className="skill-message">
                  <summary>
                    委派给外部 agent <b>{entry.delegate.agent}</b>
                  </summary>
                  <pre>{entry.delegate.task}</pre>
                </details>
              )}
            </div>
            <div className="u-actions">
              <button type="button" className="u-act" onClick={copy}>
                {copied ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                className="u-act"
                disabled={busy || pending}
                title={busyTitle ?? "编辑消息并重新发送"}
                onClick={startEdit}
              >
                编辑并重发
              </button>
              <button
                type="button"
                className="u-act"
                disabled={busy || pending}
                title={busyTitle ?? "重新发送这条消息（连同之后的文件改动一起回退）"}
                onClick={() => {
                  sendResubmit(body, "both");
                }}
              >
                重发
              </button>
            </div>
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
            <summary>图片说明 · {description.model}</summary>
            <pre>{description.text}</pre>
          </details>
        ) : null,
      )}
    </article>
  );
}

// ── 工具行 ──

const TOOL_META: Record<string, { icon: string; label: string }> = {
  skill: { icon: "S", label: "技能" },
  read: { icon: "R", label: "读取" },
  grep: { icon: "S", label: "搜索" },
  glob: { icon: "F", label: "查找文件" },
  edit: { icon: "E", label: "编辑" },
  write: { icon: "W", label: "写入" },
  apply_patch: { icon: "P", label: "应用补丁" },
  shell: { icon: "$", label: "命令" },
  web_fetch: { icon: "U", label: "读取网页" },
  web_search: { icon: "Q", label: "网页搜索" },
  subagent: { icon: "T", label: "子任务" },
  task: { icon: "T", label: "子任务" },
  ask_user: { icon: "?", label: "提问" },
};

const MCP_NAME_PREFIX = "mcp__";

/**
 * MCP 工具的展示名：与权限主体、设置页一致的 `server/tool`。
 * 结构化来源优先——subjects 里 kind 为 "mcp" 的主体 target 就是 `server/tool`；
 * 没有 subjects（如实时工具行）时从注册名 `mcp__<server>__<tool>` 解析，去掉前缀。
 */
function mcpToolLabel(name: string, subjects?: ToolEntry["subjects"]): string | undefined {
  const subject = subjects?.find((entry) => entry.kind === "mcp");
  if (subject !== undefined) return subject.target;
  if (!name.startsWith(MCP_NAME_PREFIX)) return undefined;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep > 0) return `${rest.slice(0, sep)}/${rest.slice(sep + 2)}`;
  return rest === "" ? undefined : rest;
}

export function toolMeta(
  name: string,
  subjects?: ToolEntry["subjects"],
): { icon: string; label: string } {
  const known = TOOL_META[name];
  if (known !== undefined) return known;
  const mcp = mcpToolLabel(name, subjects);
  if (mcp !== undefined) return { icon: "·", label: mcp };
  return { icon: "·", label: name };
}

export function toolArgument(entry: ToolEntry, cwd: string): string {
  const input = inputOf(entry);
  switch (entry.name) {
    case "skill":
      return input === undefined ? "" : text(input.name);
    case "read":
    case "edit":
    case "write":
      return input === undefined ? "" : displayPath(text(input.path), cwd);
    case "grep": {
      const path = input === undefined ? "" : text(input.path);
      return `"${input === undefined ? "" : text(input.pattern)}"${path === "" ? "" : ` · ${displayPath(path, cwd)}`}`;
    }
    case "glob": {
      const path = input === undefined ? "" : text(input.path);
      return `${input === undefined ? "" : text(input.pattern)}${path === "" ? "" : ` · ${displayPath(path, cwd)}`}`;
    }
    case "shell":
      return input === undefined ? "" : text(input.command).replace(/\s+/g, " ");
    case "web_fetch":
      return input === undefined ? "" : text(input.url);
    case "web_search":
      return input === undefined ? "" : text(input.query);
    default:
      // MCP 工具的名称列已是 server/tool；参数位展示主要输入（第一个非空
      // 字符串入参，如搜索 query、抓取 url），拿不到就留空，不再显示一遍名字。
      if (mcpToolLabel(entry.name ?? "", entry.subjects) !== undefined) {
        if (input === undefined) return "";
        return (
          Object.values(input).find(
            (value): value is string => typeof value === "string" && value !== "",
          ) ?? ""
        );
      }
      return entry.subjects[0]?.target ?? "";
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
  switch (entry.name) {
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
    default:
      break;
  }
  const duration =
    entry.result?.durationMs === undefined ? undefined : formatDuration(entry.result.durationMs);
  return { text: duration === undefined ? base : `${base} · ${duration}` };
}

/** 简述只取 Core 的第一句；扩展名与小数中的 "." 不算句末。 */
function toolErrorSummary(entry: ToolEntry, cwd: string): string {
  const error = entry.result?.error;
  if (error?.code === "not_read") return "文件需要先读取";
  if (error?.code === "stale_file") return "文件在读取后被修改过";
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
  const target = (value: unknown): string =>
    displayPath(
      typeof value === "string" && value !== "" ? value : (entry.subjects[0]?.target ?? ""),
      cwd,
    );
  switch (entry.name) {
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
      return `✕ 已拒绝${toolMeta(entry.name ?? "", entry.subjects).label} ${toolArgument(entry, cwd)}`.trim();
  }
}

interface FileDiff {
  label: string;
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
      const movedTo =
        "movedTo" in value && typeof value.movedTo === "string"
          ? ` → ${displayPath(value.movedTo, cwd)}`
          : "";
      return [
        {
          label: `${displayPath(value.path, cwd)}${movedTo}`,
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
    return [{ label, diff: output.diff }];
  const content =
    entry.input && typeof entry.input === "object" && "content" in entry.input
      ? entry.input.content
      : undefined;
  if ("created" in output && output.created === true && typeof content === "string" && content) {
    return [
      {
        label,
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

interface DiffRow {
  kind: "add" | "delete" | "context" | "sep";
  num?: number;
  mark?: string;
  code?: string;
}

/** 去掉 ---/+++/diff/index 头和 "\" 行；@@ 变成分隔行。行号：新增与上下文用新号、删除用旧号。 */
function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.replace(/\r\n?/g, "\n").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (rows.length > 0) rows.push({ kind: "sep" });
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    )
      continue;
    const mark = line[0];
    if (mark === "+") {
      rows.push({ kind: "add", num: newLine, mark: "+", code: line.slice(1) });
      newLine += 1;
    } else if (mark === "-") {
      rows.push({ kind: "delete", num: oldLine, mark: "−", code: line.slice(1) });
      oldLine += 1;
    } else {
      rows.push({
        kind: "context",
        num: newLine,
        mark: " ",
        code: mark === " " ? line.slice(1) : line,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return rows;
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

function DiffCard({ label, diff }: { label: string; diff: string }) {
  const [open, setOpen] = useState(true);
  const { add, del } = diffCounts(diff);
  return (
    <div className="diff">
      <div className="diff-h">
        <span className="diff-path">{label}</span>
        <span className="diff-add">+{add}</span>
        <span className="diff-del">−{del}</span>
        <button
          type="button"
          className="diff-toggle"
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open && (
        <div className="diff-body" aria-label="文件差异">
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
                <code>{row.code === "" ? " " : row.code}</code>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolDetails({ entry, cwd }: { entry: ToolEntry; cwd: string }) {
  const result = entry.result;
  return (
    <>
      {entry.subjects.length ? (
        <ul className="conversation-subjects">
          {entry.subjects.map((subject, index) => (
            <li key={index}>
              {subject.kind}: {displayPath(subject.target, cwd)}
              {subject.resolved && subject.resolved !== subject.target
                ? ` → ${displayPath(subject.resolved, cwd)}`
                : ""}
              {subject.detail ? <pre>{subject.detail}</pre> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {entry.input !== undefined ? (
        <details>
          <summary>调用参数</summary>
          <pre>
            {typeof entry.input === "string" ? entry.input : JSON.stringify(entry.input, null, 2)}
          </pre>
        </details>
      ) : null}
      {entry.review ? (
        <p className="conversation-review">
          安全审查 · {entry.review.verdict} · {entry.review.reason}
        </p>
      ) : null}
      {result?.modelContent && result.error === undefined ? (
        <pre className="conversation-tool-output">{result.modelContent}</pre>
      ) : null}
      {result?.output !== undefined ? (
        <details>
          <summary>完整结果</summary>
          <pre className="conversation-tool-output">
            {typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output, null, 2)}
          </pre>
        </details>
      ) : null}
      {result?.truncated ? (
        <p className="conversation-review">
          输出已截断{result.spillPath ? ` · 完整输出：${result.spillPath}` : ""}
        </p>
      ) : null}
      {(result?.attachments ?? []).map((attachment, index) => (
        <span key={index} className="u-img-chip" title="暂不支持查看历史图片">
          <ImageIcon />
          {attachment.label ?? attachment.file}
        </span>
      ))}
      {entry.descriptions?.map((description, index) =>
        description.text ? (
          <details key={index}>
            <summary>图片说明 · {description.model}</summary>
            <pre>{description.text}</pre>
          </details>
        ) : null,
      )}
    </>
  );
}

function ToolRow({ entry, cwd }: { entry: ToolEntry; cwd: string }) {
  const meta = toolMeta(entry.name ?? "", entry.subjects);
  const arg = toolArgument(entry, cwd);
  const range = toolRange(entry);
  const result = toolResultText(entry);
  return (
    <article className="tool" aria-label={`工具 ${entry.name ?? entry.callId}`}>
      <details className="tool-details">
        <summary className="tool-line" aria-label="工具详细信息">
          <span className="ic" aria-hidden="true">
            {meta.icon}
          </span>
          <span className="tool-name">{meta.label}</span>
          {arg !== "" && (
            <span className="tool-arg" title={arg}>
              {arg}
            </span>
          )}
          {range !== undefined && <span className="tool-range">{range}</span>}
          <span className={`tool-res${result.error === true ? " err" : ""}`}>{result.text}</span>
        </summary>
        <ToolDetails entry={entry} cwd={cwd} />
      </details>
      {entry.liveOutput ? (
        <details className="conversation-tool-progress" open>
          <summary>实时输出</summary>
          <pre className="conversation-tool-output" aria-label="工具实时输出">
            {entry.liveOutput}
          </pre>
        </details>
      ) : null}
      {entry.result?.error ? (
        <details className="conversation-tool-error">
          <summary>{toolErrorSummary(entry, cwd)}</summary>
          <pre className="conversation-tool-output">{entry.result.error.message}</pre>
        </details>
      ) : null}
    </article>
  );
}

function ToolEntryView({ entry, cwd }: { entry: ToolEntry; cwd: string }) {
  if (entry.status === "denied") {
    return (
      <div
        className="note deny"
        title={entry.resolution?.feedback ?? undefined}
        aria-label={`工具 ${entry.name ?? entry.callId} 被拒绝`}
      >
        {deniedLine(entry, cwd)}
      </div>
    );
  }
  const diffs = fileDiffs(entry, cwd);
  if (diffs.length > 0 && entry.status === "ok") {
    return (
      <>
        {diffs.map((file, index) =>
          file.diff !== undefined ? (
            <DiffCard key={index} label={file.label} diff={file.diff} />
          ) : (
            <div key={index} className="diff">
              <div className="diff-h">
                <span className="diff-path">{file.label}</span>
              </div>
            </div>
          ),
        )}
      </>
    );
  }
  return <ToolRow entry={entry} cwd={cwd} />;
}

const TURN_END_LABELS: Record<TurnEndReason, string> = {
  done: "已完成",
  truncated: "回复已截断",
  refused: "已拒绝",
  aborted: "已中断",
  max_steps: "已达到最大步骤数",
  error: "发生错误",
};

function EntryView({
  entry,
  openUrl,
  cwd,
  parts,
  now,
  images,
  session,
  busy,
  repliesAfter,
  onResubmit,
  fileLinks,
}: {
  entry: ViewEntry;
  openUrl: OpenUrl;
  cwd: string;
  parts: ReasoningMap;
  now: number;
  images: AttachmentImageSource;
  session: RpcSession;
  busy: boolean;
  repliesAfter: number;
  onResubmit: ConversationProps["onResubmit"];
  fileLinks: ConversationProps["fileLinks"];
}) {
  switch (entry.kind) {
    case "user":
      return (
        <UserMessage
          entry={entry}
          images={images}
          session={session}
          cwd={cwd}
          busy={busy}
          repliesAfter={repliesAfter}
          onResubmit={onResubmit}
        />
      );
    case "assistant":
      return (
        <article className="a" aria-label="助手消息">
          <Think messageId={entry.messageId} text={entry.reasoning} parts={parts} now={now} />
          <Markdown text={entry.text} openUrl={openUrl} session={session} fileLinks={fileLinks} />
          {entry.finishReason === "aborted" ? (
            <p className="conversation-review">回复已中断</p>
          ) : null}
        </article>
      );
    case "tool":
      return <ToolEntryView entry={entry} cwd={cwd} />;
    case "notice": {
      if (entry.subtype === "permission" || entry.subtype === "config") return null;
      let message = entry.subtype === "compacted" ? "上下文已压缩" : entry.message;
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
  deny: "拒绝",
  deny_stop: "拒绝并停止",
};
const permissionReplies: Record<PermissionOption, PermissionReply> = {
  allow_once: { decision: "allow" },
  allow_session: { decision: "allow", remember: "session" },
  allow_project: { decision: "allow", remember: "project" },
  deny: { decision: "deny" },
  deny_stop: { decision: "deny", stop: true },
};

function permissionOperation(pending: PendingPermission): string {
  switch (pending.subjects[0]?.kind) {
    case "shell":
      return "执行命令";
    case "edit":
      return "修改文件";
    case "read":
      return "读取文件";
    case "network":
      return "访问网络";
    case "mcp":
      return "调用 MCP 工具";
    case "subagent":
      return "启动子任务";
    default:
      return pending.toolName ?? "操作";
  }
}

function permissionWhy(pending: PendingPermission): string {
  switch (pending.review?.verdict) {
    case "unsure":
      return "审查器拿不准，交给你决定";
    case "block":
      return "审查器建议拒绝";
    case "allow":
      return "审查器认为可以执行";
    default:
      return "按权限规则需要确认";
  }
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

function PermissionCard({
  pending,
  session,
  cwd,
  shellKind,
}: {
  pending: PendingPermission;
  session: RpcSession;
  cwd: string;
  shellKind?: string | undefined;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const { reply, busy, error } = useReply((value: PermissionReply) =>
    session.respondPermission(pending.requestId, value),
  );
  const options: PermissionOption[] = pending.options.length
    ? pending.options
    : ["allow_once", "deny"];
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const setFeedbackRef = useRef(setFeedback);
  setFeedbackRef.current = setFeedback;
  const cardRef = useRef<HTMLElement>(null);

  // 卡片挂载即拿走焦点：数字键/Esc 立刻可用（卡片本身不算可编辑目标）
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // 数字键直选、Esc 直接拒绝（捕获阶段 + preventDefault，不与输入框中断冲突）。
  // Esc 只在两种情况下让位：目标在卡片内部（反馈 textarea 自己处理 Esc 返回选项）、
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
      if (event.key === "Escape") {
        if (insideCard(event.target)) return;
        if (document.querySelector('[role="menu"], .composer-popup') !== null) return;
        event.preventDefault();
        void replyRef.current({ decision: "deny" });
        return;
      }
      if (editable(event.target)) return;
      const digit = /^[1-9]$/.exec(event.key);
      if (digit === null) return;
      const option = optionsRef.current[Number(digit[0]) - 1];
      if (option === undefined) return;
      event.preventDefault();
      if (option === "deny") {
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
  const hover = [pending.reason, pending.review?.reason].filter(Boolean).join("；");
  const networks = pending.subjects.filter((subject) => subject.kind === "network");
  return (
    <section className="ask v2" aria-label="权限确认" aria-busy={busy} tabIndex={-1} ref={cardRef}>
      <div className="ask-t" title={hover}>
        需要确认 · {operation}
        <span className="ask-why">{why}</span>
      </div>
      <ul className="ask-subjects">
        {pending.subjects.map((subject, index) => {
          const shown =
            subject.kind === "shell"
              ? `${subject.shell ?? shellKind ?? "shell"} › ${subject.target}`
              : subject.kind === "network"
                ? subject.target
                : displayPath(subject.target, cwd);
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
      {feedback === null ? (
        <div className="ask-actions">
          {options.map((option) => {
            const label =
              option === "allow_session" && networks.length
                ? `本会话允许访问 ${networks.map((subject) => subject.target).join("、")}`
                : permissionLabels[option];
            return (
              <button
                key={option}
                className={`btn${option === "allow_once" ? " primary" : ""}${option === "deny_stop" ? " danger" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (option === "deny") setFeedback("");
                  else void reply(permissionReplies[option]);
                }}
              >
                {label}
              </button>
            );
          })}
          <span className="ask-kbd">1–{options.length} 选择 · Esc 拒绝</span>
        </div>
      ) : (
        <form
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
            <button className="btn" type="submit" disabled={busy}>
              发送拒绝
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => {
                setFeedback(null);
              }}
            >
              返回
            </button>
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
  text: string;
  declined: boolean;
}

function QuestionCard({ pending, session }: { pending: PendingQuestion; session: RpcSession }) {
  const [drafts, setDrafts] = useState<AnswerDraft[]>(() =>
    pending.questions.map(() => ({ selected: [], text: "", declined: false })),
  );
  const { reply, busy, error } = useReply((value: QuestionReply) =>
    session.respondQuestion(pending.requestId, value),
  );
  const update = (index: number, patch: Partial<AnswerDraft>) => {
    setDrafts((current) =>
      current.map((draft, itemIndex) => (itemIndex === index ? { ...draft, ...patch } : draft)),
    );
  };
  return (
    <section className="ask" aria-label="提问" aria-busy={busy}>
      <div className="ask-t">提问</div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const answers = drafts.map((draft) =>
            draft.declined
              ? { declined: true as const }
              : {
                  selected: draft.selected,
                  ...(draft.text.trim() ? { text: draft.text.trim() } : {}),
                },
          );
          void reply({ answers });
        }}
      >
        {pending.questions.map((question, index) => {
          const draft = drafts[index];
          if (!draft) return null;
          return (
            <fieldset key={index} disabled={busy}>
              <legend>
                {question.header ? `${question.header} · ` : ""}
                {question.question}
              </legend>
              {question.multiSelect ? <p className="conversation-review">可多选</p> : null}
              {question.options?.map((option) => (
                <label className="conversation-question-option" key={option.label}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`question-${pending.requestId}-${index}`}
                    checked={draft.selected.includes(option.label)}
                    onChange={() => {
                      update(index, {
                        declined: false,
                        selected: question.multiSelect
                          ? draft.selected.includes(option.label)
                            ? draft.selected.filter((label) => label !== option.label)
                            : [...draft.selected, option.label]
                          : [option.label],
                        ...(question.multiSelect ? {} : { text: "" }),
                      });
                    }}
                  />
                  <span>
                    {option.label}
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </label>
              ))}
              <label>
                {question.options?.length ? "其他（自己输入）" : "回答"}
                <textarea
                  aria-label={`${question.question} · ${question.options?.length ? "其他" : "回答"}`}
                  value={draft.text}
                  onChange={(event) => {
                    update(index, {
                      text: Array.from(event.target.value).slice(0, 2000).join(""),
                      declined: false,
                      ...(question.multiSelect ? {} : { selected: [] }),
                    });
                  }}
                />
              </label>
              <label className="conversation-question-option">
                <input
                  type="checkbox"
                  checked={draft.declined}
                  onChange={(event) => {
                    update(index, { declined: event.target.checked, selected: [], text: "" });
                  }}
                />
                拒绝回答
              </label>
            </fieldset>
          );
        })}
        <div className="ask-actions">
          <button className="btn primary" type="submit" disabled={busy}>
            提交回答
          </button>
        </div>
      </form>
      {busy ? (
        <p className="conversation-review" role="status">
          等待后台确认回答…
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

function ConversationContent({
  session,
  view,
  openUrl,
  cwd,
  shellKind,
  subscribeEvents,
  images,
  busy,
  onResubmit,
  fileLinks,
}: ConversationProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const { parts, now } = useReasoning(subscribeEvents);
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
  }, [view.entries]);
  const scrollToBottom = () => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  };
  useLayoutEffect(() => {
    if (follow.current) scrollToBottom();
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
    },
  }));
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) scrollToBottom();
    });
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div className="conversation">
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
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight - element.clientHeight - element.scrollTop <= 2) {
            follow.current = true;
            setFollowing(true);
          } else if (element.scrollTop < previousTop.current) {
            follow.current = false;
            setFollowing(false);
          }
          previousTop.current = element.scrollTop;
        }}
      >
        <ThinkScrollContext.Provider value={thinkScroll}>
          <div className="conversation-transcript" ref={content}>
            {!view.entries.length && !view.live.assistants.length && !view.live.tools.length ? (
              <div className="conversation-empty">发送消息，开始这个会话。</div>
            ) : null}
            {view.entries.map((entry) => (
              <EntryView
                key={entry.key}
                entry={entry}
                openUrl={openUrl}
                cwd={cwd}
                parts={parts}
                now={now}
                images={images}
                session={session}
                busy={busy}
                repliesAfter={entry.kind === "user" ? (repliesAfter.get(entry.seq) ?? 0) : 0}
                onResubmit={onResubmit}
                fileLinks={fileLinks}
              />
            ))}
            {view.live.assistants.map((assistant) => (
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
            ))}
            {view.live.tools.map((tool) => {
              const meta = toolMeta(tool.name);
              return (
                <article
                  className="tool"
                  key={`tool:${tool.callId}`}
                  aria-label={`工具 ${tool.name} 实时参数`}
                >
                  <div className="tool-line">
                    <span className="ic" aria-hidden="true">
                      {meta.icon}
                    </span>
                    <span className="tool-name">{meta.label}</span>
                    <span className="tool-arg" title={tool.inputText}>
                      {tool.inputText}
                    </span>
                    <span className="tool-res">接收参数中</span>
                  </div>
                </article>
              );
            })}
            {view.notices.map((notice, index) => (
              <div
                key={index}
                className={`conversation-notice conversation-notice-${notice.level}`}
                role={notice.level === "info" ? "status" : "alert"}
                title={notice.code}
              >
                {notice.message}
              </div>
            ))}
          </div>
        </ThinkScrollContext.Provider>
      </div>
      {!following ? (
        <div className="conversation-jump-row">
          <button
            type="button"
            className="conversation-jump btn"
            onClick={() => {
              follow.current = true;
              setFollowing(true);
              scrollToBottom();
            }}
          >
            回到最新消息
          </button>
        </div>
      ) : null}
      {view.pendingPermission || view.pendingQuestion ? (
        <div className="conversation-requests">
          {view.pendingPermission ? (
            <PermissionCard
              key={`permission:${view.pendingPermission.requestId}`}
              pending={view.pendingPermission}
              session={session}
              cwd={cwd}
              {...(shellKind !== undefined ? { shellKind } : {})}
            />
          ) : null}
          {view.pendingQuestion ? (
            <QuestionCard
              key={`question:${view.pendingQuestion.requestId}`}
              pending={view.pendingQuestion}
              session={session}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Conversation(props: ConversationProps) {
  return <ConversationContent key={props.session.id} {...props} />;
}
