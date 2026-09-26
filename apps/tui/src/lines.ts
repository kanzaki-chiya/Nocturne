/**
 * 把活动条目铺成固定行；<Static> 已写出的历史交给终端回滚区。
 */
import stringWidth from "string-width";

import type { SessionView } from "@nocturne/core/protocol";

import { boxSafe, summarizeToolInput, tailLines, truncateLine } from "./format.js";
import type { TranscriptItem } from "./components/transcript.js";
import type { LaidLine } from "./viewport.js";

const SAFE = 4;

function budget(width: number): number {
  return Math.max(1, width - SAFE);
}

function paint(text: string, width: number): string {
  return truncateLine(boxSafe(text.replace(/\r\n?/g, "\n")), budget(width), "...");
}

function wrap(text: string, width: number): string[] {
  const limit = budget(width);
  const flat = text.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  for (const part of flat.split("\n")) {
    if (part === "") {
      out.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const ch of part) {
      const w = Math.max(1, stringWidth(ch));
      if (used + w > limit && line !== "") {
        out.push(line);
        line = "";
        used = 0;
      }
      if (w > limit) continue;
      line += ch;
      used += w;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

function rows(key: string, text: string, width: number, extra?: Partial<LaidLine>): LaidLine[] {
  return wrap(text, width).map((line, i) => ({
    key: `${key}:${i}`,
    text: paint(line, width),
    ...extra,
  }));
}

export function layoutEntry(entry: TranscriptItem, width: number, ascii: boolean): LaidLine[] {
  const dot = ascii ? "*" : "•";
  const prompt = ascii ? ">" : "›";
  switch (entry.kind) {
    case "user": {
      const text = entry.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      return rows(entry.key, `${prompt} ${text}`, width, { color: "cyan", bold: true });
    }
    case "assistant": {
      const lines: LaidLine[] = [];
      if (entry.reasoning !== "") {
        lines.push(...rows(`${entry.key}:r`, entry.reasoning, width, { dim: true }).slice(-4));
      }
      if (entry.text !== "") lines.push(...rows(`${entry.key}:t`, entry.text, width));
      if (entry.finishReason === "aborted") {
        lines.push({ key: `${entry.key}:x`, text: "（中断）", dim: true });
      }
      return lines.length > 0 ? lines : [{ key: entry.key, text: "" }];
    }
    case "tool": {
      const mark =
        entry.status === "ok"
          ? ascii
            ? "+"
            : "✓"
          : entry.status === "error" || entry.status === "denied"
            ? ascii
              ? "x"
              : "✗"
            : dot;
      const summary = summarizeToolInput(entry.name, entry.input);
      const head = `${mark} ${entry.name ?? "?"} ${summary} ${entry.status}`;
      const lines = rows(entry.key, head, width);
      if (entry.liveOutput !== "") {
        for (const [i, line] of tailLines(entry.liveOutput, 3).entries()) {
          lines.push({
            key: `${entry.key}:live:${i}`,
            text: paint(`  ${line}`, width),
            dim: true,
          });
        }
      }
      const content = entry.result?.modelContent;
      if (content !== undefined && content !== "") {
        for (const [i, line] of tailLines(content, 4).entries()) {
          lines.push({
            key: `${entry.key}:out:${i}`,
            text: paint(`  ${line}`, width),
            dim: true,
          });
        }
      }
      return lines;
    }
    case "notice":
      return rows(entry.key, `${dot} ${entry.message}`, width, { dim: true });
    case "separator":
      return rows(entry.key, `-- ${entry.text} --`, width, { dim: true });
    case "header":
      return entry.lines;
  }
}

export function layoutLive(view: SessionView, width: number, ascii: boolean): LaidLine[] {
  const lines: LaidLine[] = [];
  const cursor = ascii ? "_" : "|";
  for (const tool of view.live.tools) {
    lines.push({
      key: `live:${tool.callId}`,
      text: paint(`${ascii ? "*" : "•"} ${tool.name}`, width),
      color: "cyan",
    });
  }
  for (const a of view.live.assistants) {
    // 思考与正文都显示：有的模型先吐几个正文字再回去思考，
    // 只显示正文会让画面停在那几个字上（思考灰色在上，正文在下）
    const reasoning = a.reasoning !== "" ? wrap(a.reasoning, width) : [];
    const text = a.text !== "" || reasoning.length === 0 ? wrap(a.text, width) : [];
    reasoning.forEach((line, i) => {
      const last = text.length === 0 && i === reasoning.length - 1;
      lines.push({
        key: `live-r:${a.messageId}:${i}`,
        text: paint(last ? `${line}${cursor}` : line, width),
        dim: true,
      });
    });
    text.forEach((line, i) => {
      const last = i === text.length - 1;
      lines.push({
        key: `live-a:${a.messageId}:${i}`,
        text: paint(last ? `${line}${cursor}` : line, width),
      });
    });
  }
  if (view.retry !== undefined) {
    lines.push({
      key: "retry",
      text: paint(
        `重试 ${view.retry.attempt}/${view.retry.maxAttempts}：${view.retry.error.message}`,
        width,
      ),
      color: "yellow",
    });
  }
  if (view.status === "compacting") {
    lines.push({ key: "compact", text: "正在压缩上下文...", dim: true });
  }
  return lines;
}
