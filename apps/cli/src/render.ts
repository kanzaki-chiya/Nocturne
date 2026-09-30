/**
 * 事件渲染（cli.md 第 5 节）：把 RuntimeEvent 映射为
 * "写哪个流、写什么文本"的纯函数集合，便于离线测试。
 * 颜色经 util.styleText（终端不支持或 NO_COLOR 时自动降级）。
 */
import { styleText } from "node:util";
import { truncateMiddle } from "@nocturne/tui/text-format";

import { todoItemsFromCompletion, todoSnapshotLines } from "@nocturne/core/protocol";
import type {
  QuestionAnswer,
  QuestionItem,
  RuntimeEvent,
  ToolCompletedPayload,
} from "@nocturne/core/protocol";

export type Channel = "stdout" | "stderr";

/**
 * 一段渲染输出。缺省是"整行"（写出器负责补齐前后换行）；
 * `stream` 为真时是流式片段（模型文本、shell 输出），原样拼接。
 */
export interface Rendered {
  channel: Channel;
  text: string;
  stream?: true;
  /** 仅流式片段：每个新行的行首缩进 */
  indent?: string;
}

export type RenderMode = "interactive" | "print";

const ARGS_SUMMARY_LIMIT = 100;

function style(fmt: string | string[], text: string): string {
  return styleText(fmt as never, text);
}

function summarizeInput(input: unknown): string {
  if (input === undefined) return "";
  let s: string;
  try {
    const j: unknown = JSON.stringify(input);
    s = typeof j === "string" ? j : "";
  } catch {
    s = "[unserializable]";
  }
  if (s.length > ARGS_SUMMARY_LIMIT) s = `${s.slice(0, ARGS_SUMMARY_LIMIT)}…`;
  return s;
}

/** 输出已保留的完整 diff；旧路径头部和无头部结果不臆造行号。 */
export function renderDiff(diff: string): string {
  let oldNo: number | undefined;
  let newNo: number | undefined;
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) {
        const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(line);
        oldNo = header === null ? undefined : Number(header[1]);
        newNo = header === null ? undefined : Number(header[3]);
        return style("cyan", line);
      }
      const mark = line[0] ?? " ";
      if (mark === "\\") return line;
      const oldColumn =
        (mark === " " || mark === "-") && oldNo !== undefined
          ? String(oldNo++).padStart(4)
          : "    ";
      const newColumn =
        (mark === " " || mark === "+") && newNo !== undefined
          ? String(newNo++).padStart(4)
          : "    ";
      const rendered = `${oldColumn} ${newColumn} ${line}`;
      if (mark === "+") return style("green", rendered);
      if (mark === "-") return style("red", rendered);
      return rendered;
    })
    .join("\n");
}

function toolCompletedLines(p: ToolCompletedPayload): string[] {
  if (p.name === "ask_user") {
    if (p.status === "cancelled" || p.status === "interrupted") return ["  已取消"];
    if (p.error?.code === "timeout") return ["  已超时"];
    if (p.error?.code === "not_interactive") return ["  无法提问（非交互）"];
    if (p.status !== "ok") return [p.error?.message ?? "无法提问"];
    const output = p.output as { answers?: (QuestionAnswer & { question: string })[] } | undefined;
    if (!Array.isArray(output?.answers)) return ["无法读取回答"];
    return [renderQuestionSummary(output.answers, output.answers)];
  }
  const dur = p.durationMs !== undefined ? `（${p.durationMs}ms）` : "";
  const lines: string[] = [];
  if (p.status === "ok") {
    lines.push(`└ ${style("green", "ok")}${dur}`);
  } else {
    const reason = p.error !== undefined ? `${p.error.code}: ${p.error.message}` : "";
    lines.push(`└ ${style("red", p.status)}${dur}${reason !== "" ? ` ${reason}` : ""}`);
  }
  const todos = todoItemsFromCompletion(p);
  if (todos !== undefined) lines.push(...todoSnapshotLines(todos).map((line) => `  ${line}`));
  if (p.truncated === true) {
    lines.push(
      p.spillPath !== undefined
        ? `  输出已截断，完整内容在 ${p.spillPath}`
        : "  输出已截断（落盘不可用，完整内容未保留）",
    );
  }
  const out = p.output;
  if (
    out !== null &&
    typeof out === "object" &&
    "diff" in out &&
    typeof (out as { diff?: unknown }).diff === "string"
  ) {
    const diff = (out as { diff: string }).diff;
    const changes = diff.split("\n");
    const added = changes.filter((line) => line.startsWith("+")).length;
    const removed = changes.filter((line) => line.startsWith("-")).length;
    lines.push(`  ${p.modelContent.split("\n")[0] ?? ""}；新增 ${added} 行，删除 ${removed} 行`);
    lines.push(renderDiff(diff));
  } else if (p.modelContent.includes("[结构化 output 超过大小上限，已省略]")) {
    lines.push("  结构化 output 超过大小上限，已省略");
  }
  return lines;
}

/**
 * 把事件渲染成行输出。非交互模式只有模型文本进 stdout，
 * 其余一切走 stderr（cli.md「输出分流」）。
 */
export function renderEvent(ev: RuntimeEvent, mode: RenderMode): Rendered[] {
  const side: Channel = mode === "print" ? "stderr" : "stdout";
  const out = (text: string): Rendered => ({ channel: "stdout", text, stream: true });
  const aux = (text: string): Rendered => ({ channel: side, text });

  switch (ev.type) {
    case "message.user":
      return (ev.payload.fileRefs ?? []).map((ref) =>
        aux(
          `  附带 @${ref.path}${ref.kind === "file" ? `（${ref.lines ?? 0}/${ref.totalLines ?? 0} 行）` : ref.kind === "directory" ? "（目录）" : "（图片）"}`,
        ),
      );
    case "message.assistant.delta": {
      const p = ev.payload;
      if (p.kind === "text") return [out(p.delta)];
      return [out(style("dim", p.delta))];
    }
    case "tool.started": {
      const p = ev.payload;
      if (p.name === "ask_user") {
        const input = p.input as { questions?: unknown[] } | undefined;
        const n = input?.questions?.length ?? 0;
        return [aux("? 提问" + (n > 1 ? `（${n} 题）` : ""))];
      }
      const rule = p.permission.rule !== undefined ? `（命中：${p.permission.rule}）` : "";
      return [aux(`● ${p.name}(${summarizeInput(p.input)})${rule}`)];
    }
    case "tool.input.delta":
      return [];
    case "tool.progress":
      if (ev.payload.stream === "info") return [aux(`  ${ev.payload.chunk}`)];
      // stdout/stderr 的流式片段可能断在行中间，缩进由写出器按行首补
      return [{ channel: side, text: ev.payload.chunk, stream: true, indent: "  " }];
    case "tool.completed":
      return toolCompletedLines(ev.payload).map(aux);
    case "permission.requested":
      // 交互模式的确认提示由 permission.ts 接管，这里只兜底说明
      return [aux(`! 权限请求 ${ev.payload.requestId}：${ev.payload.reason}`)];
    case "permission.resolved": {
      const p = ev.payload;
      const detail = p.rule !== undefined ? `${p.source}：${p.rule}` : p.source;
      const remembered =
        p.remember === "project"
          ? "，已写入项目授权"
          : p.remember === "session"
            ? "，本会话内有效"
            : "";
      return [aux(`└ 权限：${p.action}（${detail}）${remembered}`)];
    }
    case "context.compacted": {
      const p = ev.payload;
      return [aux(`◇ 上下文已压缩（${p.kind}，至 seq ${p.throughSeq}）`)];
    }
    case "session.config_changed": {
      const p = ev.payload;
      const lines: string[] = [];
      if (p.model !== undefined) lines.push(`◇ 模型已切换为 ${p.model.provider}/${p.model.model}`);
      if (p.permissionPreset !== undefined) lines.push(`◇ 权限预设已切换为 ${p.permissionPreset}`);
      if (p.reasoningEffort !== undefined) lines.push(`◇ 思考强度已切换为 ${p.reasoningEffort}`);
      if (p.shell !== undefined) {
        lines.push(`◇ shell 已切换为 ${p.shell.kind}（${p.shell.path}）`);
      }
      return lines.map(aux);
    }
    case "provider.retry": {
      const p = ev.payload;
      return [
        aux(
          `! Provider 错误（${p.error.kind}），${p.delayMs}ms 后第 ${p.attempt}/${p.maxAttempts} 次重试`,
        ),
      ];
    }
    case "runtime.warning":
    case "runtime.error":
      return [aux(`! ${ev.payload.code}: ${ev.payload.message}`)];
    case "runtime.status":
      return ev.payload.status === "compacting" ? [aux("◇ 压缩中…")] : [];
    case "mcp.server": {
      const p = ev.payload;
      const tools = p.toolCount !== undefined ? `（${p.toolCount} 个工具）` : "";
      const err = p.error !== undefined ? `：${p.error}` : "";
      return [aux(`◇ MCP 服务器 ${p.name} → ${p.state}${tools}${err}`)];
    }
    case "turn.completed": {
      const p = ev.payload;
      const lines: Rendered[] = [];
      if (p.reason !== "done") {
        const detail = p.error !== undefined ? `：${p.error.code} ${p.error.message}` : "";
        lines.push(aux(`! Turn 结束（${p.reason}）${detail}`));
      }
      if (mode === "interactive") {
        lines.push(aux(`── tokens: in ${p.usage.inputTokens} / out ${p.usage.outputTokens}`));
      }
      return lines;
    }
    default:
      return [];
  }
}

export interface EventWriter {
  /** 写出 renderEvent 的结果 */
  write(items: readonly Rendered[]): void;
  /** 写一个整行块（可含内部换行）：该通道不在行首时先补换行 */
  line(channel: Channel, text: string): void;
  /** 该通道不在行首时补一个换行 */
  endLine(channel: Channel): void;
}

/**
 * 按通道记录"是否停在行首"的写出器：整行输出前补齐被流式片段留下的半行，
 * 使交互模式（全部走 stdout）与非交互模式（分流）共用同一套换行规则。
 */
export function createEventWriter(sink: (channel: Channel, text: string) => void): EventWriter {
  const atLineStart: Record<Channel, boolean> = { stdout: true, stderr: true };

  const endLine = (channel: Channel): void => {
    if (!atLineStart[channel]) {
      sink(channel, "\n");
      atLineStart[channel] = true;
    }
  };

  const stream = (channel: Channel, text: string, indent: string): void => {
    if (text === "") return;
    let buf = "";
    text.split("\n").forEach((part, i) => {
      if (i > 0) {
        buf += "\n";
        atLineStart[channel] = true;
      }
      if (part !== "") {
        buf += atLineStart[channel] ? indent + part : part;
        atLineStart[channel] = false;
      }
    });
    sink(channel, buf);
  };

  const line = (channel: Channel, text: string): void => {
    endLine(channel);
    sink(channel, `${text}\n`);
  };

  return {
    write(items) {
      for (const r of items) {
        if (r.stream === true) stream(r.channel, r.text, r.indent ?? "");
        else line(r.channel, r.text);
      }
    },
    line,
    endLine,
  };
}

const OPTION_LABELS: Record<string, string> = {
  allow_once: "允许一次",
  allow_session: "本会话内允许",
  allow_project: "在此项目中始终允许",
  deny: "拒绝（可附反馈）",
  deny_stop: "拒绝并停止本 Turn",
};
const OPTION_KEYS: Record<string, string> = {
  allow_once: "a",
  allow_session: "s",
  allow_project: "p",
  deny: "d",
  deny_stop: "x",
};

/** 权限确认提示块（cli.md 第 6 节）：主体、命中原因与完整选项 */
export function renderPermissionPrompt(
  subjects: {
    kind: string;
    target: string;
    resolved?: string | undefined;
    detail?: string | undefined;
  }[],
  reason: string,
  options?: readonly string[],
  width = 80,
): string {
  const lines = subjects.flatMap((s) => {
    const resolved = s.resolved !== undefined && s.resolved !== s.target ? ` → ${s.resolved}` : "";
    const detail = s.detail;
    const limit = Math.max(1, width - 2);
    const shown = truncateMiddle(detail ?? "", limit);
    return [`  ${s.kind}: ${s.target}${resolved}`, ...(detail === undefined ? [] : [`  ${shown}`])];
  });
  const opts = options !== undefined && options.length > 0 ? options : ["allow_once", "deny"];
  const rendered = opts
    .map(
      (o) =>
        `${style("bold", `[${OPTION_KEYS[o] ?? o[0] ?? "?"}]`)} ${
          o === "allow_session" && subjects.some((s) => s.kind === "network")
            ? `本会话允许访问 ${subjects
                .filter((s) => s.kind === "network")
                .map((s) => s.target)
                .join("、")}`
            : (OPTION_LABELS[o] ?? o)
        }`,
    )
    .join("  ");
  return [style("yellow", "? 操作需要确认"), ...lines, `  ${reason}`, `  ${rendered}`].join("\n");
}

/** 逐行 CLI 的单题提示（ADR-0032 §6）：编号选项 + 输入规则说明 */
export function renderQuestionPrompt(q: QuestionItem, index: number, total: number): string {
  const tag = q.header !== undefined ? `[${q.header}] ` : "";
  const counter = total > 1 ? `（第 ${index + 1}/${total} 题）` : "";
  const lines = [`${style("yellow", "?")} ${tag}${q.question}${counter}`];
  const options = q.options ?? [];
  for (const [i, o] of options.entries()) {
    const desc = o.description !== undefined ? ` — ${o.description}` : "";
    lines.push(`  ${i + 1}. ${o.label}${desc}`);
  }
  const hints: string[] = [];
  if (options.length > 0) {
    hints.push("输入编号选择");
    if (q.multiSelect === true) hints.push("可输入多个编号，用逗号分隔");
  }
  lines.push(`  ${options.length + 1}. 拒绝回答`);
  hints.push("直接输入文字作为「其他」；空行重新提示");
  lines.push(`  ${hints.join("；")}`);
  return lines.join("\n");
}

/** ask_user 完成条目的摘要：每题一行「问题 → 回答」。 */
export function renderQuestionSummary(
  questions: readonly QuestionItem[],
  answers: readonly QuestionAnswer[],
): string {
  const lines = questions.map((q, i) => {
    const a = answers[i];
    const parts: string[] = [];
    if (a !== undefined && "declined" in a)
      return `  ${q.question.replace(/\r\n?|\n/g, " ")} → 拒绝回答`;
    if (a !== undefined && a.selected.length > 0) parts.push(a.selected.join("、"));
    if (a?.text !== undefined) parts.push(a.text.replace(/\r\n?|\n/g, " "));
    return `  ${q.question.replace(/\r\n?|\n/g, " ")} → ${parts.length > 0 ? parts.join("、") : "（未回答）"}`;
  });
  return lines.join("\n");
}
