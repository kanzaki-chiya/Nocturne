import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import type {
  ImageAttachment,
  PendingPermission,
  PendingQuestion,
  PermissionOption,
  PermissionReply,
  QuestionReply,
  SessionView,
  ToolEntry,
  ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";

import { isAllowedExternalUrl } from "./external-url";
import "./conversation.css";

export interface ConversationProps {
  session: RpcSession;
  view: SessionView;
  openUrl: (url: string) => void;
}

type OpenUrl = ConversationProps["openUrl"];

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
        const text = token as Tokens.Text;
        return (
          <Fragment key={key}>
            {text.tokens ? markdownNodes(text.tokens, openUrl) : text.text}
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

function Markdown({ text, openUrl }: { text: string; openUrl: OpenUrl }) {
  return (
    <div className="conversation-markdown">
      {markdownNodes(marked.lexer(text, { gfm: true }), openUrl)}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  return text ? (
    <details className="conversation-reasoning">
      <summary>思考</summary>
      <pre>{text}</pre>
    </details>
  ) : null;
}

function Attachments({ attachments }: { attachments: ImageAttachment[] | undefined }) {
  return attachments?.length ? (
    <ul className="conversation-attachments">
      {attachments.map((attachment, index) => (
        <li key={index}>
          图片 · {attachment.label ?? attachment.file}
          {attachment.width && attachment.height
            ? ` · ${attachment.width} × ${attachment.height}`
            : ""}{" "}
          · {attachment.bytes} 字节
        </li>
      ))}
    </ul>
  ) : null;
}

interface FileDiff {
  label: string;
  diff?: string;
}

/** Mirrors the TUI's output.files/output.diff and historical write result shapes. */
function fileDiffs(entry: ToolEntry): FileDiff[] {
  if (
    entry.result?.status !== "ok" ||
    !entry.result.output ||
    typeof entry.result.output !== "object"
  )
    return [];
  const output = entry.result.output;
  if ("files" in output && Array.isArray(output.files)) {
    const operations: Record<string, string> = { add: "A", update: "M", delete: "D", move: "M" };
    return output.files.flatMap((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("path" in value) ||
        typeof value.path !== "string"
      )
        return [];
      const operation =
        "op" in value && typeof value.op === "string" ? (operations[value.op] ?? "?") : "?";
      const movedTo =
        "movedTo" in value && typeof value.movedTo === "string" ? ` → ${value.movedTo}` : "";
      return [
        {
          label: `${operation} ${value.path}${movedTo}`,
          ...("diff" in value && typeof value.diff === "string" && value.diff
            ? { diff: value.diff }
            : {}),
        },
      ];
    });
  }
  const label =
    "path" in output && typeof output.path === "string" ? output.path : (entry.name ?? "文件");
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

function Diff({ diff }: { diff: string }) {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const rows = diff
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line, index) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      const header =
        line.startsWith("@@") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("diff ") ||
        line.startsWith("index ");
      const mark = line[0];
      const oldNumber = !header && (mark === "-" || mark === " ") ? oldLine : undefined;
      const newNumber = !header && (mark === "+" || mark === " ") ? newLine : undefined;
      if (oldNumber !== undefined) oldLine = oldNumber + 1;
      if (newNumber !== undefined) newLine = newNumber + 1;
      const kind = header ? "header" : mark === "+" ? "add" : mark === "-" ? "delete" : "context";
      return (
        <div key={index} className={`conversation-diff-row conversation-diff-${kind}`}>
          <span className="conversation-diff-number" aria-hidden="true">
            {oldNumber ?? ""}
          </span>
          <span className="conversation-diff-number" aria-hidden="true">
            {newNumber ?? ""}
          </span>
          <code>{line || " "}</code>
        </div>
      );
    });
  return (
    <div className="conversation-diff" aria-label="文件差异">
      {rows}
    </div>
  );
}

const toolStatus: Record<ToolEntry["status"], string> = {
  awaiting_permission: "等待确认",
  running: "运行中",
  ok: "完成",
  error: "失败",
  denied: "已拒绝",
  cancelled: "已取消",
  interrupted: "已中断",
};

const toolLabels: Record<string, string> = {
  read: "读取",
  grep: "搜索",
  glob: "查找文件",
  edit: "编辑",
  write: "写入",
  apply_patch: "应用补丁",
  shell: "命令",
  web_fetch: "读取网页",
  web_search: "网页搜索",
  ask_user: "提问",
  subagent: "子任务",
};

function Tool({ entry }: { entry: ToolEntry }) {
  const diffs = fileDiffs(entry);
  const result = entry.result;
  const input = entry.input;
  let argument = entry.subjects[0]?.target ?? diffs[0]?.label ?? "";
  if (input && typeof input === "object") {
    if ("command" in input && typeof input.command === "string") argument = input.command;
    else if ("pattern" in input && typeof input.pattern === "string") argument = input.pattern;
    else if ("path" in input && typeof input.path === "string") argument = input.path;
    else if ("url" in input && typeof input.url === "string") argument = input.url;
    else if ("query" in input && typeof input.query === "string") argument = input.query;
  }
  return (
    <article className="conversation-tool" aria-label={`工具 ${entry.name ?? entry.callId}`}>
      <details className="conversation-tool-details">
        <summary aria-label="工具详细信息">
          <span className="conversation-tool-heading">
            <span className="conversation-tool-name">
              {entry.name ? (toolLabels[entry.name] ?? entry.name) : entry.callId}
            </span>
            <span className="conversation-tool-argument" title={argument}>
              {argument.replace(/\s+/g, " ")}
            </span>
            <span className={`conversation-tool-status conversation-tool-status-${entry.status}`}>
              {toolStatus[entry.status]}
            </span>
            {result?.durationMs !== undefined ? <span>{result.durationMs} ms</span> : null}
          </span>
        </summary>
        {entry.subjects.length ? (
          <ul className="conversation-subjects">
            {entry.subjects.map((subject, index) => (
              <li key={index}>
                {subject.kind}: {subject.target}
                {subject.resolved && subject.resolved !== subject.target
                  ? ` → ${subject.resolved}`
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
        {result?.modelContent ? (
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
        <Attachments attachments={result?.attachments} />
        {entry.descriptions?.map((description, index) =>
          description.text ? (
            <details key={index}>
              <summary>图片说明 · {description.model}</summary>
              <pre>{description.text}</pre>
            </details>
          ) : null,
        )}
      </details>
      {entry.liveOutput ? (
        <details className="conversation-tool-progress" open>
          <summary>实时输出</summary>
          <pre className="conversation-tool-output" aria-label="工具实时输出">
            {entry.liveOutput}
          </pre>
        </details>
      ) : null}
      {result?.error ? (
        <details className="conversation-tool-error" open>
          <summary className="conversation-error">{result.error.code}</summary>
          <pre className="conversation-tool-output conversation-error">{result.error.message}</pre>
        </details>
      ) : null}
      {diffs.map((file, index) =>
        file.diff ? (
          <details className="conversation-file-diff" key={index} open>
            <summary>查看差异 · {file.label}</summary>
            <Diff diff={file.diff} />
          </details>
        ) : (
          <p key={index} className="conversation-file-diff">
            {file.label}
          </p>
        ),
      )}
    </article>
  );
}

function Entry({ entry, openUrl }: { entry: ViewEntry; openUrl: OpenUrl }) {
  switch (entry.kind) {
    case "user":
      return (
        <article className="conversation-message conversation-user" aria-label="用户消息">
          <div className="conversation-speaker">你</div>
          {entry.content.map((block, index) =>
            block.type === "text" ? (
              <div className="conversation-user-text" key={index}>
                {block.text}
              </div>
            ) : (
              <Reasoning key={index} text={block.text} />
            ),
          )}
          <Attachments attachments={entry.attachments} />
          {entry.fileRefs?.length ? (
            <ul className="conversation-attachments">
              {entry.fileRefs.map((file, index) => (
                <li key={index}>
                  @{file.path} · {file.kind}
                  {file.truncated ? " · 已截断" : ""}
                </li>
              ))}
            </ul>
          ) : null}
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
    case "assistant":
      return (
        <article className="conversation-message conversation-assistant" aria-label="助手消息">
          <div className="conversation-speaker">Nocturne</div>
          <Reasoning text={entry.reasoning} />
          <Markdown text={entry.text} openUrl={openUrl} />
          {entry.finishReason === "aborted" ? (
            <p className="conversation-review">回复已中断</p>
          ) : null}
        </article>
      );
    case "tool":
      return <Tool entry={entry} />;
    case "notice":
      return (
        <div className={`conversation-notice conversation-notice-${entry.subtype}`}>
          {entry.message}
        </div>
      );
  }
}

const permissionLabels: Record<PermissionOption, string> = {
  allow_once: "允许一次",
  allow_session: "本会话内允许",
  allow_project: "在此项目中始终允许",
  deny: "拒绝（可附反馈）",
  deny_stop: "拒绝并停止本 Turn",
};
const permissionReplies: Record<PermissionOption, PermissionReply> = {
  allow_once: { decision: "allow" },
  allow_session: { decision: "allow", remember: "session" },
  allow_project: { decision: "allow", remember: "project" },
  deny: { decision: "deny" },
  deny_stop: { decision: "deny", stop: true },
};

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

function PermissionCard({ pending, session }: { pending: PendingPermission; session: RpcSession }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const { reply, busy, error } = useReply((value: PermissionReply) =>
    session.respondPermission(pending.requestId, value),
  );
  const options: PermissionOption[] = pending.options.length
    ? pending.options
    : ["allow_once", "deny"];
  return (
    <section className="conversation-request" aria-label="权限确认" aria-busy={busy}>
      <h3>需要确认{pending.toolName ? ` · ${pending.toolName}` : ""}</h3>
      <ul className="conversation-subjects">
        {pending.subjects.map((subject, index) => (
          <li key={index}>
            {subject.kind}: {subject.target}
            {subject.resolved && subject.resolved !== subject.target
              ? ` → ${subject.resolved}`
              : ""}
            {subject.detail ? <pre>{subject.detail}</pre> : null}
          </li>
        ))}
      </ul>
      {pending.reason ? <p>原因：{pending.reason}</p> : null}
      {pending.review ? (
        <p className="conversation-review">
          安全审查 · {pending.review.verdict} · {pending.review.reason}
        </p>
      ) : null}
      {feedback === null ? (
        <div className="conversation-request-actions">
          {options.map((option) => {
            const networks = pending.subjects.filter((subject) => subject.kind === "network");
            const label =
              option === "allow_session" && networks.length
                ? `本会话允许访问 ${networks.map((subject) => subject.target).join("、")}`
                : permissionLabels[option];
            return (
              <button
                key={option}
                className={`btn ${option === "allow_once" ? "primary" : ""}`}
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
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = feedback.trim();
            void reply({ decision: "deny", ...(text ? { feedback: text } : {}) });
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
          <div className="conversation-request-actions">
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
    <section className="conversation-request" aria-label="提问" aria-busy={busy}>
      <h3>提问</h3>
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
        <div className="conversation-request-actions">
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

function ConversationContent({ session, view, openUrl }: ConversationProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const [following, setFollowing] = useState(true);
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
            <Entry key={entry.key} entry={entry} openUrl={openUrl} />
          ))}
          {view.live.assistants.map((assistant) => (
            <article
              className="conversation-message conversation-assistant conversation-live"
              key={`assistant:${assistant.messageId}`}
              aria-label="助手实时回复"
            >
              <div className="conversation-speaker">
                Nocturne <span>回复中</span>
              </div>
              <Reasoning text={assistant.reasoning} />
              <Markdown text={assistant.text} openUrl={openUrl} />
            </article>
          ))}
          {view.live.tools.map((tool) => (
            <article
              className="conversation-tool conversation-live"
              key={`tool:${tool.callId}`}
              aria-label={`工具 ${tool.name} 实时参数`}
            >
              <div className="conversation-tool-heading">
                <span className="conversation-tool-name">{tool.name}</span>
                <span className="conversation-tool-status">接收参数中</span>
              </div>
              <pre>{tool.inputText}</pre>
            </article>
          ))}
          {view.notices.map((notice, index) => (
            <div
              key={index}
              className={`conversation-notice conversation-notice-${notice.level}`}
              role={notice.level === "info" ? "status" : "alert"}
            >
              <span className="conversation-notice-code">{notice.code}</span>
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
