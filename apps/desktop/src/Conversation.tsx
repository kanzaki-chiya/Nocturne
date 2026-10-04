import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import {
  parseFileRefs,
  type PendingPermission,
  type PendingQuestion,
  type PermissionOption,
  type PermissionReply,
  type QuestionReply,
  type RuntimeEvent,
  type SessionView,
  type ToolEntry,
  type UserEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import type { AttachmentImageSource } from "./attachment-images";
import { isAllowedExternalUrl } from "./external-url";
import { fileRefTitle, userText } from "./file-refs";
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
}

type OpenUrl = ConversationProps["openUrl"];
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const inputOf = (entry: ToolEntry): Record<string, unknown> | undefined =>
  entry.input !== null && typeof entry.input === "object"
    ? (entry.input as Record<string, unknown>)
    : undefined;

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
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
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

function Markdown({ text: markdown, openUrl }: { text: string; openUrl: OpenUrl }) {
  return (
    <div className="conversation-markdown">
      {markdownNodes(marked.lexer(markdown, { gfm: true }), openUrl)}
    </div>
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
  const part = parts.get(messageId)?.at(-1);
  if (reasoning === "" && part === undefined) return null;
  const seconds =
    part?.started === undefined
      ? 0
      : Math.max(0, Math.floor(((part.active ? now : (part.ended ?? now)) - part.started) / 1000));
  const label =
    seconds < 1 ? "思考" : part?.active === true ? `思考中 ${seconds}s` : `思考了 ${seconds}s`;
  const body = reasoning !== "" ? reasoning : (part?.text ?? "");
  if (body === "") return <div className="think">{label}</div>;
  return (
    <details className="think">
      <summary>{label}</summary>
      <pre>{body}</pre>
    </details>
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

function UserMessage({ entry, images }: { entry: UserEntry; images: AttachmentImageSource }) {
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
  return (
    <article className="u" aria-label="用户消息">
      <div className="u-bubble">
        {(entry.attachments ?? []).map((attachment, index) => {
          const url = images.url(attachment);
          return url !== undefined ? (
            <img
              key={index}
              className="u-img"
              src={url}
              alt={attachment.label ?? attachment.file}
            />
          ) : (
            <span key={index} className="u-img-chip" title="暂不支持查看历史图片">
              <ImageIcon />
              {attachment.label ?? attachment.file}
            </span>
          );
        })}
        {body !== "" && <div className="u-text">{segments}</div>}
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

export function toolMeta(name: string): { icon: string; label: string } {
  return TOOL_META[name] ?? { icon: "·", label: name };
}

export function toolArgument(entry: ToolEntry, cwd: string): string {
  const input = inputOf(entry);
  switch (entry.name) {
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
      return `✕ 已拒绝${toolMeta(entry.name ?? "").label} ${toolArgument(entry, cwd)}`.trim();
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
              <div key={index} className={`diff-row diff-${row.kind}`}>
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
  const meta = toolMeta(entry.name ?? "");
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

function EntryView({
  entry,
  openUrl,
  cwd,
  parts,
  now,
  images,
}: {
  entry: ViewEntry;
  openUrl: OpenUrl;
  cwd: string;
  parts: ReasoningMap;
  now: number;
  images: AttachmentImageSource;
}) {
  switch (entry.kind) {
    case "user":
      return <UserMessage entry={entry} images={images} />;
    case "assistant":
      return (
        <article className="a" aria-label="助手消息">
          <Think messageId={entry.messageId} text={entry.reasoning} parts={parts} now={now} />
          <Markdown text={entry.text} openUrl={openUrl} />
          {entry.finishReason === "aborted" ? (
            <p className="conversation-review">回复已中断</p>
          ) : null}
        </article>
      );
    case "tool":
      return <ToolEntryView entry={entry} cwd={cwd} />;
    case "notice":
      if (entry.subtype === "permission" || entry.subtype === "config") return null;
      return (
        <div className="note">{entry.subtype === "compacted" ? "上下文已压缩" : entry.message}</div>
      );
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
}: ConversationProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const [following, setFollowing] = useState(true);
  const { parts, now } = useReasoning(subscribeEvents);
  const scrollToBottom = () => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    previousTop.current = element.scrollTop;
  };
  useLayoutEffect(() => {
    if (follow.current) scrollToBottom();
  });
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
      </div>
      {!following ? (
        <button
          className="conversation-jump btn"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            scrollToBottom();
          }}
        >
          回到最新消息
        </button>
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
