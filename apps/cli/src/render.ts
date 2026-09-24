/**
 * 事件渲染（cli.md 第 5 节）：把 RuntimeEvent 映射为
 * "写哪个流、写什么文本"的纯函数集合，便于离线测试。
 * 颜色经 util.styleText（终端不支持或 NO_COLOR 时自动降级）。
 */
import { styleText } from "node:util";

import type { RuntimeEvent, ToolCompletedPayload } from "@nocturne/core/protocol";

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

/** unified diff 着色：+ 绿、- 红、@@ 青、其余默认色 */
export function renderDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return style("bold", line);
      if (line.startsWith("+")) return style("green", line);
      if (line.startsWith("-")) return style("red", line);
      if (line.startsWith("@@")) return style("cyan", line);
      return line;
    })
    .join("\n");
}

function toolCompletedLines(p: ToolCompletedPayload): string[] {
  const dur = p.durationMs !== undefined ? `（${p.durationMs}ms）` : "";
  const lines: string[] = [];
  if (p.status === "ok") {
    lines.push(`└ ${style("green", "ok")}${dur}`);
  } else {
    const reason = p.error !== undefined ? `${p.error.code}: ${p.error.message}` : "";
    lines.push(`└ ${style("red", p.status)}${dur}${reason !== "" ? ` ${reason}` : ""}`);
  }
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
    lines.push(renderDiff((out as { diff: string }).diff));
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
    case "message.assistant.delta": {
      const p = ev.payload;
      if (p.kind === "text") return [out(p.delta)];
      return [out(style("dim", p.delta))];
    }
    case "tool.started": {
      const p = ev.payload;
      const rule = p.permission.rule !== undefined ? `（命中：${p.permission.rule}）` : "";
      return [aux(`● ${p.name}(${summarizeInput(p.input)})${rule}`)];
    }
    case "tool.input.delta":
      return [];
    case "tool.progress":
      // shell 的流式输出：片段可能断在行中间，缩进由写出器按行首补
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
  subjects: { kind: string; target: string; resolved?: string | undefined }[],
  reason: string,
  options?: readonly string[],
): string {
  const lines = subjects.map((s) => {
    const resolved = s.resolved !== undefined && s.resolved !== s.target ? ` → ${s.resolved}` : "";
    return `  ${s.kind}: ${s.target}${resolved}`;
  });
  const opts = options !== undefined && options.length > 0 ? options : ["allow_once", "deny"];
  const rendered = opts
    .map((o) => `${style("bold", `[${OPTION_KEYS[o] ?? o[0] ?? "?"}]`)} ${OPTION_LABELS[o] ?? o}`)
    .join("  ");
  return [style("yellow", "? 操作需要确认"), ...lines, `  ${reason}`, `  ${rendered}`].join("\n");
}
