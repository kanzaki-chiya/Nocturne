/**
 * 把会话内容铺成固定行。普通屏幕模式下 <Static> 已写出的历史交给终端
 * 回滚区，这里只铺活动区；全屏模式下 transcriptBlocks 把整段对话
 * （欢迎区 + 冻结前缀 + 条目 + live）铺成 LineBlock 交给视口按需布局。
 */
import stringWidth from "string-width";

import type { SessionView, ViewEntry } from "@nocturne/core/protocol";
import { todoItemsFromCompletion } from "@nocturne/core/protocol";

import { questionToolLines } from "./question-format.js";
import { webFetchSummary } from "./web-fetch.js";
import { attachmentLine, descriptionLine } from "./attachment-line.js";
import { diffSummary, layoutDiffRow, parseDiff, toolFileDiffs } from "./diff-format.js";
import { interleaveClient, type ClientLine } from "./client-lines.js";
import { splitInputTokens, userText, fileRefLine } from "./file-refs.js";
import {
  boxSafe,
  permissionReviewLine,
  stripControls,
  summarizeToolInput,
  subagentModel,
  tailLines,
  truncateLine,
} from "./format.js";
import { renderAssistant } from "./markdown.js";
import { reasoningLabel, type ReasoningMap, type ReasoningPart } from "./reasoning.js";
import { palettes, type ThemePalette } from "./theme.js";
import { todoHeadline, todoItemRows, todoSnapshotWindow } from "./todo-format.js";
import type { TranscriptItem } from "./components/transcript.js";
import type { LaidLine, LineBlock } from "./viewport.js";

const SAFE = 4;

function budget(width: number): number {
  return Math.max(1, width - SAFE);
}

function paint(text: string, width: number): string {
  return truncateLine(boxSafe(stripControls(text.replace(/\r\n?/g, "\n"))), budget(width), "...");
}

interface WrappedLine {
  text: string;
  /** 自动折行断开的续行（真换行产生的行不标，复制时拼回） */
  continued: boolean;
}

function wrap(text: string, width: number): WrappedLine[] {
  const limit = budget(width);
  const flat = stripControls(text.replace(/\r\n?/g, "\n"));
  const out: WrappedLine[] = [];
  for (const part of flat.split("\n")) {
    if (part === "") {
      out.push({ text: "", continued: false });
      continue;
    }
    let line = "";
    let used = 0;
    let continued = false;
    for (const ch of part) {
      const w = Math.max(1, stringWidth(ch));
      if (used + w > limit && line !== "") {
        out.push({ text: line, continued });
        continued = true;
        line = "";
        used = 0;
      }
      if (w > limit) continue;
      line += ch;
      used += w;
    }
    out.push({ text: line, continued });
  }
  return out.length > 0 ? out : [{ text: "", continued: false }];
}

function rows(key: string, text: string, width: number, extra?: Partial<LaidLine>): LaidLine[] {
  return wrap(text, width).map((line, i) => ({
    key: `${key}:${i}`,
    text: paint(line.text, width),
    continued: line.continued,
    ...extra,
  }));
}

const DIFF_HEAD = 20;
const DIFF_TAIL = 20;

/** 工具结果里可展示的逐文件 diff（ADR-0035：apply_patch 的 output.files 逐文件渲染） */
function toolDiffs(entry: Extract<ViewEntry, { kind: "tool" }>) {
  return toolFileDiffs(entry.status, entry.result?.output, entry.input);
}

/** 全屏 diff 超过 40 个内容行时折叠为前后各 20 行。 */
function diffLines(
  key: string,
  diff: string,
  width: number,
  ascii: boolean,
  expanded: boolean,
  theme: ThemePalette,
): LaidLine[] {
  const all = parseDiff(diff);
  const folded = !expanded && all.length > DIFF_HEAD + DIFF_TAIL;
  const head =
    folded || (expanded && all.length > DIFF_HEAD + DIFF_TAIL) ? all.slice(0, DIFF_HEAD) : all;
  const tail = folded ? all.slice(all.length - DIFF_TAIL) : expanded ? all.slice(DIFF_HEAD) : [];
  const line = (row: (typeof all)[number], i: number): LaidLine[] =>
    layoutDiffRow(
      `${key}:diff:${i}`,
      row,
      width,
      !ascii && process.env.NO_COLOR === undefined,
      theme,
    );
  const out = head.flatMap(line);
  if (folded || (expanded && all.length > DIFF_HEAD + DIFF_TAIL)) {
    out.push({
      key: `${key}:diff:more`,
      text: folded
        ? `  ${ascii ? "..." : "…"} 还有 ${all.length - head.length - tail.length} 行`
        : `  ${ascii ? "..." : "…"} 单击收起`,
      dim: true,
    });
  }
  out.push(...tail.flatMap((t, i) => line(t, all.length - tail.length + i)));
  return out;
}

interface LayoutOptions {
  fullscreen?: boolean;
  reasoningExpanded?: ReadonlyMap<string, boolean> | undefined;
  continued?: boolean;
  written?: ReadonlyMap<string, number>;
}

export function layoutEntry(
  entry: TranscriptItem,
  width: number,
  ascii: boolean,
  parts: ReasoningMap = new Map(),
  now = Date.now(),
  expanded = false,
  diffExpanded = false,
  theme: ThemePalette = palettes.dark,
  options: LayoutOptions = {},
): LaidLine[] {
  const out = layoutEntryBody(
    entry,
    width,
    ascii,
    parts,
    now,
    expanded,
    diffExpanded,
    theme,
    options,
  );
  if (entry.kind === "user" || entry.kind === "tool") {
    for (const description of entry.descriptions ?? []) {
      const index = description.attachmentRef.index;
      const id = `description:${entry.key}:${index}`;
      const anchor = `${entry.key}:description:${index}`;
      const open = options.reasoningExpanded?.get(id) ?? expanded;
      const att = (entry.kind === "user" ? entry.attachments : entry.result?.attachments)?.[index];
      out.push(
        ...rows(
          anchor,
          `  ${descriptionLine(description, att)}${options.fullscreen ? (open ? " • 单击收起" : " • 单击展开") : ""}`,
          width,
          { dim: true, ...(options.fullscreen ? { toggle: { id, anchor: `${anchor}:0` } } : {}) },
        ),
      );
      if (open) out.push(...reasoningBody(anchor, description.text, width));
    }
  }
  return out;
}

function layoutEntryBody(
  entry: TranscriptItem,
  width: number,
  ascii: boolean,
  parts: ReasoningMap = new Map(),
  now = Date.now(),
  expanded = false,
  diffExpanded = false,
  theme: ThemePalette = palettes.dark,
  options: LayoutOptions = {},
): LaidLine[] {
  const dot = ascii ? "*" : "•";
  const prompt = ascii ? ">" : "›";
  switch (entry.kind) {
    case "user": {
      const text = userText(entry);
      const fullText = stripControls(`${prompt} ${text}`.replace(/\r\n?/g, "\n"));
      let offset = 0;
      return [
        ...rows(entry.key, `${prompt} ${text}`, width, { color: theme.accent, bold: true }).map(
          (line) => {
            // [Image #n] 占位换色，与正文区分（其余分段继承本行的 cyan/bold）
            if (offset > 0 && !line.continued) offset++;
            const parts = splitInputTokens(line.text, fullText, offset);
            offset += line.text.length;
            return parts.some((p) => p.image)
              ? {
                  ...line,
                  segments: parts.map((p) =>
                    p.image ? { text: p.text, color: theme.accentAlt } : { text: p.text },
                  ),
                }
              : line;
          },
        ),
        ...(entry.fileRefs ?? []).flatMap((ref, i) =>
          rows(`${entry.key}:ref:${i}`, `  ${fileRefLine(ref)}`, width, { color: theme.accentAlt }),
        ),
        ...(entry.attachments ?? []).flatMap((att, i) =>
          rows(`${entry.key}:image:${i}`, `  ${attachmentLine(att, i, ascii)}`, width, {
            color: theme.accent,
          }),
        ),
      ];
    }
    case "assistant": {
      const lines: LaidLine[] = [];
      if (entry.reasoning !== "") {
        const sections = parts.get(entry.messageId) ?? [{ text: entry.reasoning, active: false }];
        sections.forEach((part, i) => {
          const id = `reasoning:${entry.messageId}:${i}`;
          const open = options.reasoningExpanded?.get(id) ?? expanded;
          const anchor = `${entry.key}:r:${i}`;
          lines.push(
            ...(options.fullscreen
              ? rows(anchor, reasoningLabel(part, now, ascii, open, true), width, {
                  toggle: { id, anchor: `${anchor}:0` },
                  dim: true,
                })
              : [
                  {
                    key: anchor,
                    text: paint(reasoningLabel(part, now, ascii, open), width),
                    dim: true,
                  },
                ]),
          );
          if (open) lines.push(...reasoningBody(`${entry.key}:r:${i}`, part.text, width));
        });
      }
      if (entry.text !== "")
        lines.push(
          ...renderAssistant(
            entry.text,
            width,
            `${entry.key}:t`,
            ascii,
            theme,
            options.continued ?? entry.bodyContinued,
          ),
        );
      if (entry.finishReason === "aborted") {
        lines.push({ key: `${entry.key}:x`, text: "（中断）", dim: true });
      }
      return lines.length > 0 ? lines : [{ key: entry.key, text: "" }];
    }
    case "tool": {
      const available =
        entry.result !== undefined &&
        !entry.result.modelContent.includes("[结构化 output 超过大小上限，已省略]");
      const toggle = available ? { id: `tool:${entry.key}`, anchor: `${entry.key}:0` } : undefined;
      const review = entry.review
        ? rows(`${entry.key}:review`, permissionReviewLine(entry.review), width, { dim: true })
        : [];
      if (entry.name === "ask_user" && !diffExpanded)
        return [
          ...review,
          ...questionToolLines(entry).map((text, i) => ({
            key: `${entry.key}:${i}`,
            text: paint(text, width),
            ...(i === 0 ? { toggle } : {}),
          })),
        ];
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
      const todoItems =
        entry.result === undefined
          ? undefined
          : todoItemsFromCompletion({
              name: entry.name ?? "",
              status: entry.status,
              output: entry.result.output,
            });
      if (todoItems !== undefined && !diffExpanded) {
        // 非 ASCII 时 📋 图标已标明这一行，不再重复成功符号
        const segments = [
          ...(ascii ? [{ text: `${mark} `, color: theme.success }] : []),
          ...todoHeadline(todoItems, ascii, theme),
        ];
        const lines: LaidLine[] = [
          ...review,
          {
            key: `${entry.key}:0`,
            toggle,
            text: segments.map((seg) => seg.text).join(""),
            segments,
          },
        ];
        const snapshot = todoSnapshotWindow(todoItems);
        snapshot.shown.forEach((item, i) => {
          todoItemRows(item, ascii, budget(width), "  ", theme).forEach((segments, j) => {
            lines.push({
              key: `${entry.key}:todo:${i}:${j}`,
              text: segments.map((seg) => seg.text).join(""),
              segments,
              ...(j > 0 ? { continued: true, copyIndent: segments[0]?.text.length ?? 0 } : {}),
            });
          });
        });
        if (snapshot.after > 0) {
          lines.push({
            key: `${entry.key}:todo:more`,
            text: `  ${ascii ? "..." : "…"} 另有 ${snapshot.after} 项`,
            dim: true,
          });
        }
        return lines;
      }
      const summary = summarizeToolInput(entry.name, entry.input);
      const head = `${mark} ${entry.name ?? "?"}${subagentModel(entry)} ${summary} ${entry.status}`;
      const lines = [...review, ...rows(entry.key, head, width, { toggle })];
      const attachmentRows = (entry.result?.attachments ?? []).flatMap((att, i) =>
        rows(`${entry.key}:image:${i}`, `  ${attachmentLine(att, i, ascii)}`, width, {
          color: theme.accent,
        }),
      );
      if (entry.liveOutput !== "") {
        for (const [i, line] of tailLines(entry.liveOutput, 3).entries()) {
          lines.push({
            key: `${entry.key}:live:${i}`,
            text: paint(`  ${line}`, width),
            dim: true,
          });
        }
      }
      const fileDiffs = toolDiffs(entry);
      const single =
        fileDiffs?.length === 1 && fileDiffs[0]?.label === "" ? fileDiffs[0].diff : undefined;
      if (fileDiffs !== undefined && single === undefined) {
        // apply_patch：摘要行 + 逐文件标题与 diff
        const first = entry.result?.modelContent.split("\n")[0] ?? "";
        if (first !== "") {
          lines.push({ key: `${entry.key}:sum`, text: paint(`  ${first}`, width), dim: true });
        }
        fileDiffs.forEach((f, fi) => {
          lines.push({
            key: `${entry.key}:f${fi}`,
            text: paint(
              `  ${f.label}${f.diff !== undefined ? `（${diffSummary(parseDiff(f.diff))}）` : ""}`,
              width,
            ),
            dim: true,
          });
          if (f.diff !== undefined)
            lines.push(
              ...diffLines(`${entry.key}:f${fi}`, f.diff, width, ascii, diffExpanded, theme),
            );
        });
        return [...lines, ...attachmentRows].map((line) =>
          line.key.endsWith(":diff:more") ? { ...line, toggle } : line,
        );
      }
      if (single !== undefined) {
        // 摘要行（已修改/已创建 …）保留，其后接 diff
        const first = entry.result?.modelContent.split("\n")[0] ?? "";
        if (first !== "") {
          lines.push({
            key: `${entry.key}:sum`,
            text: paint(`  ${first}；${diffSummary(parseDiff(single))}`, width),
            dim: true,
          });
        }
        lines.push(...diffLines(entry.key, single, width, ascii, diffExpanded, theme));
        return [...lines, ...attachmentRows].map((line) =>
          line.key.endsWith(":diff:more") ? { ...line, toggle } : line,
        );
      }
      const content = diffExpanded
        ? entry.result?.modelContent
        : (webFetchSummary(entry) ?? entry.result?.modelContent);
      if (content !== undefined && content !== "") {
        if (diffExpanded) lines.push(...reasoningBody(`${entry.key}:out`, content, width));
        else
          for (const [i, line] of tailLines(content, 4).entries()) {
            lines.push({
              key: `${entry.key}:out:${i}`,
              text: paint(`  ${line}`, width),
              dim: true,
            });
          }
      }
      return [...lines, ...attachmentRows].map((line) =>
        line.key.endsWith(":diff:more") ? { ...line, toggle } : line,
      );
    }
    case "notice":
      return rows(entry.key, `${dot} ${entry.message}`, width, { dim: true });
    case "separator":
      return rows(entry.key, `-- ${entry.text} --`, width, { dim: true });
    case "header":
      return entry.lines;
  }
}

export function layoutLive(
  view: SessionView,
  width: number,
  ascii: boolean,
  parts: ReasoningMap = new Map(),
  now = Date.now(),
  expanded = false,
  theme: ThemePalette = palettes.dark,
  options: LayoutOptions = {},
): LaidLine[] {
  const lines: LaidLine[] = [];
  const cursor = ascii ? "_" : "|";
  for (const tool of view.live.tools) {
    lines.push({
      key: `live:${tool.callId}`,
      text: paint(tool.name === "ask_user" ? "? 提问" : `${ascii ? "*" : "•"} ${tool.name}`, width),
      color: theme.accent,
    });
  }
  for (const a of view.live.assistants) {
    // 思考与正文都显示：有的模型先吐几个正文字再回去思考，
    // 只显示正文会让画面停在那几个字上（思考灰色在上，正文在下）
    const sections: ReasoningPart[] =
      parts.get(a.messageId) ??
      (a.reasoning !== "" ? [{ text: a.reasoning, active: a.text === "" }] : []);
    const text =
      a.text !== "" || sections.length === 0
        ? renderAssistant(
            a.text,
            width,
            `live-a:${a.messageId}`,
            ascii,
            theme,
            (options.written?.get(a.messageId) ?? 0) > 0,
          )
        : [];
    const thoughtActive = sections.at(-1)?.active === true;
    sections.forEach((part, section) => {
      const id = `reasoning:${a.messageId}:${section}`;
      const open = options.reasoningExpanded?.get(id) ?? expanded;
      const anchor = `live-r:${a.messageId}:${section}:head`;
      lines.push(
        ...(options.fullscreen
          ? rows(anchor, reasoningLabel(part, now, ascii, open, true), width, {
              toggle: { id, anchor: `${anchor}:0` },
              dim: true,
            })
          : [
              {
                key: anchor,
                text: paint(reasoningLabel(part, now, ascii, open), width),
                dim: true,
              },
            ]),
      );
      if (!part.active && !open) return;
      const visible = open ? wrap(part.text, width - 2) : wrap(part.text, width).slice(-4);
      visible.forEach((line, i) => {
        const last = part.active && section === sections.length - 1 && i === visible.length - 1;
        const body = `${open ? "  " : ""}${line.text}`;
        lines.push({
          key: `live-r:${a.messageId}:${section}:${i}`,
          text: last
            ? `${truncateLine(boxSafe(body), Math.max(0, budget(width) - 1), "")}${cursor}`
            : paint(body, width),
          continued: line.continued,
          dim: true,
          ...(open ? { copyIndent: 2 } : {}),
        });
      });
    });
    text.forEach((line, i) => {
      const last = !thoughtActive && i === text.length - 1;
      lines.push({
        ...line,
        text: last ? truncateLine(`${line.text}${cursor}`, budget(width), "") : line.text,
        segments: last ? [...(line.segments ?? []), { text: cursor, dim: true }] : line.segments,
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
      color: theme.warning,
    });
  }
  if (view.status === "compacting") {
    lines.push({ key: "compact", text: "正在压缩上下文...", dim: true });
  }
  return lines;
}

function reasoningBody(key: string, text: string, width: number): LaidLine[] {
  return wrap(text, width - 2).map((line, i) => ({
    key: `${key}:body:${i}`,
    text: paint(`  ${line.text}`, width),
    continued: line.continued,
    dim: true,
    copyIndent: 2,
  }));
}

interface TranscriptSource {
  welcome: LaidLine[];
  notices: readonly string[];
  frozen: readonly TranscriptItem[];
  entries: readonly ViewEntry[];
  hide: (entry: ViewEntry) => boolean;
  live: SessionView;
  clientLines: readonly ClientLine[];
  ascii: boolean;
  fullscreen?: boolean;
  reasoning?: ReasoningMap;
  now?: number;
  expanded?: boolean;
  diffExpanded?: ReadonlySet<string>;
  reasoningExpanded?: ReadonlyMap<string, boolean> | undefined;
  theme?: ThemePalette;
}

function block(key: string, revision: string, lines: (width: number) => LaidLine[]): LineBlock {
  return { key, revision, layout: lines };
}

/**
 * 全屏模式的对话块表（ADR-0021 第 1 条）：欢迎区在最前，随对话滚走；
 * 冻结前缀是 /resume、/new 切换时旧会话已完结的条目；其后是当前会话的
 * 全部条目（进行中的工具也在这里按 revision 重排）与 live 区（流式输出、
 * 准备中的工具、重试/压缩提示）。快捷键插入的 config 通知由 hide 滤掉。
 */
export function transcriptBlocks(src: TranscriptSource): LineBlock[] {
  const theme = src.theme ?? palettes.dark;
  const options = { fullscreen: src.fullscreen ?? true, reasoningExpanded: src.reasoningExpanded };
  const overrides = JSON.stringify([...(src.reasoningExpanded ?? [])]);
  const blocks: LineBlock[] = [
    block("welcome", src.welcome.map((line) => line.text).join("\n"), () => src.welcome),
  ];
  if (src.notices.length > 0) {
    blocks.push(
      block("notices", src.notices.join("\n"), (width) =>
        src.notices.flatMap((text, i) =>
          rows(`n${i}`, `! ${text}`, width, { color: theme.warning }),
        ),
      ),
    );
  }
  for (const item of src.frozen) {
    blocks.push(
      block(
        item.key,
        `${item.kind === "separator" ? item.text : item.key}:${src.expanded}:${src.diffExpanded?.has(item.key)}:${overrides}`,
        (width) =>
          layoutEntry(
            item,
            width,
            src.ascii,
            src.reasoning,
            src.now,
            src.expanded,
            src.diffExpanded?.has(item.key),
            theme,
            options,
          ),
      ),
    );
  }
  // 本地提示行按推入位置插在条目之间；推入时尚无后续条目的排在 live 之后
  const clientBlock = (line: ClientLine): LineBlock =>
    block(`client:${line.id}`, line.text, (width) =>
      rows(`c${line.id}`, line.text, width, { dim: true }),
    );
  const entryBlocks = interleaveClient<ViewEntry, LineBlock>(
    src.entries,
    0,
    src.clientLines.filter((line) => line.after < src.entries.length),
    (entry) => (src.hide(entry) ? [] : [entryBlock(entry)]),
    clientBlock,
  );
  blocks.push(...entryBlocks);
  function entryBlock(entry: ViewEntry): LineBlock {
    const revision =
      entry.kind === "tool"
        ? `${entry.status}:${entry.liveOutput.length}:${entry.result?.modelContent.length ?? 0}`
        : entry.kind === "assistant"
          ? `${entry.text.length}:${entry.reasoning.length}:${
              src.reasoning
                ?.get(entry.messageId)
                ?.map((p) => p.ended ?? "")
                .join(",") ?? ""
            }`
          : entry.key;
    return block(
      entry.key,
      `${revision}:${entry.kind === "user" || entry.kind === "tool" ? entry.descriptions?.map((d) => `${d.model}:${d.text}`).join("|") : ""}:${src.expanded}:${src.diffExpanded?.has(entry.key)}:${overrides}`,
      (width) =>
        layoutEntry(
          entry,
          width,
          src.ascii,
          src.reasoning,
          src.now,
          src.expanded,
          src.diffExpanded?.has(entry.key),
          theme,
          options,
        ),
    );
  }
  // 缓存标记要覆盖布局的全部输入：思考长度、进行中工具、重试
  const liveRev = [
    src.expanded,
    overrides,
    src.live.live.assistants.map((a) => `${a.text.length}/${a.reasoning.length}`).join(","),
    src.live.live.tools.map((t) => t.callId).join(","),
    src.live.retry?.attempt ?? "",
    src.live.status,
    src.reasoning === undefined
      ? ""
      : src.live.live.assistants
          .map(
            (a) =>
              src.reasoning
                ?.get(a.messageId)
                ?.map(
                  (p) =>
                    `${p.active ? Math.floor((src.now ?? 0) / 1000) : (p.ended ?? "")}:${p.text.length}`,
                )
                .join(",") ?? "",
          )
          .join("|"),
  ].join("|");
  blocks.push(
    block("live", liveRev, (width) =>
      layoutLive(src.live, width, src.ascii, src.reasoning, src.now, src.expanded, theme, options),
    ),
  );
  blocks.push(
    ...src.clientLines.filter((line) => line.after >= src.entries.length).map(clientBlock),
  );
  return blocks.map((entry) => ({ ...entry, revision: `${theme.id}:${entry.revision}` }));
}

export const NEW_CONTENT_HINT = "有新内容，Ctrl+End 回到最新";
export const SCROLLED_HINT = "已向上翻阅，Ctrl+End 回到最新";
