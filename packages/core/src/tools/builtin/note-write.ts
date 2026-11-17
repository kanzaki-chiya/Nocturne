import {
  applyNoteWrite,
  formatNoteBlock,
  NOTE_MAX_ITEM_CHARS,
  NOTE_MAX_TOTAL_CHARS,
  parseNoteWriteInput,
  type NoteItem,
  type NoteWriteInput,
} from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

export const noteWriteTool: ToolDefinition<NoteWriteInput, { notes: NoteItem[] }> = {
  name: "note_write",
  description:
    `在当前会话中新增或删除持久笔记，用于记录长任务后续还要用到的事实、约束、决定和失败过的做法（进度跟踪仍用 todo_write）。` +
    `输入 { add?: string[], remove?: number[] }，至少一项非空；先删后加，每次成功更新后编号重排为 1..N。` +
    `add 每条去除首尾空白后非空且至多 ${NOTE_MAX_ITEM_CHARS} 字符（允许换行，禁止控制字符），全部笔记合计至多 ${NOTE_MAX_TOTAL_CHARS} 字符；不限条数。`,
  inputSchema: {
    type: "object",
    properties: {
      add: {
        type: "array",
        items: { type: "string" },
      },
      remove: {
        type: "array",
        items: { type: "integer", minimum: 1 },
      },
    },
    additionalProperties: false,
  },
  traits: {
    mutates: false,
    concurrencySafe: false,
    timeoutMs: 5_000,
    pinResult: true,
    // 8000 字符上限最多可写 8000 条单字符笔记；即使全需 JSON 转义，output 与 modelContent 均在 185k 字符内
    maxModelChars: 256_000,
    maxOutputChars: 256_000,
  },
  validateInput(input) {
    const parsed = parseNoteWriteInput(input);
    return "error" in parsed ? parsed.error : undefined;
  },
  permissionSubjects: () => [],
  execute(input, ctx) {
    const parsed = parseNoteWriteInput(input);
    if ("error" in parsed) {
      return Promise.resolve({
        status: "error",
        modelContent: parsed.error,
        error: { code: "invalid_input", message: parsed.error },
      } as const);
    }
    const current = ctx.notes?.() ?? [];
    const applied = applyNoteWrite(current, parsed);
    if (!applied.ok) {
      return Promise.resolve({
        status: "error",
        modelContent: applied.error,
        error: { code: "invalid_input", message: applied.error },
      } as const);
    }
    const confirmation = `会话笔记已更新：当前共 ${applied.notes.length} 条（合计 ${applied.totalChars}/${NOTE_MAX_TOTAL_CHARS} 字符）。`;
    return Promise.resolve({
      status: "ok",
      modelContent:
        applied.notes.length === 0
          ? confirmation
          : `${confirmation}\n\n${formatNoteBlock(applied.notes)}`,
      output: { notes: applied.notes },
    } as const);
  },
};
