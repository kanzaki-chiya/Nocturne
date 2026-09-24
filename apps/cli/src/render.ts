/**
 * 事件渲染（cli.md 第 5 节）：把 RuntimeEvent 映射为
 * "写哪个流、写什么文本"的纯函数集合，便于离线测试。
 * 颜色经 util.styleText（终端不支持或 NO_COLOR 时自动降级）。
 */
import { styleText } from "node:util";

import type { RuntimeEvent, ToolCompletedPayload } from "@nocturne/core/protocol";

export type Channel = "stdout" | "stderr";

export interface Rendered {
  channel: Channel;
  text: string;
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
  const out = (text: string): Rendered => ({ channel: "stdout", text });
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
    case "tool.progress": {
      // shell 的流式输出：原样缩进
      const text = ev.payload.chunk
        .split("\n")
        .map((l) => (l === "" ? l : `  ${l}`))
        .join("\n");
      return [aux(text)];
    }
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
