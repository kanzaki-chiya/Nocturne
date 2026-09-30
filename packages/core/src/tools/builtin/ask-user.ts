/**
 * ask_user 内置工具（ADR-0032）：需要用户拍板时暂停并提问。
 * 输入校验按 §1 的全部边界；提问经 ToolContext.askUser 走
 * 会话级提问通道（tools/question.ts），回答/跳过/不可用按 §2 结算，
 * 中断/超时由执行器按 signal 统一结算。本工具不产生任何权限主体。
 */
import type { QuestionItem, QuestionOption } from "../../protocol/index.js";
import type { ToolDefinition } from "../types.js";

const MAX_QUESTIONS = 4;
const MAX_QUESTION_CHARS = 300;
const MAX_HEADER_CHARS = 12;
const MAX_LABEL_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 200;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
/** 等待回答的默认超时（ADR-0032 §5）：24 小时 */
const ASK_TIMEOUT_MS = 86_400_000;

const NOT_INTERACTIVE_MESSAGE =
  "当前为非交互模式，无法向用户提问；请按最合理的默认继续，并在最终回复中说明所做的假设";
const SKIPPED_MESSAGE = "用户未回答，请按你的判断继续，并在回复中说明所做的假设";

/** tool.completed.output 的形状（ADR-0032 §2） */
interface AskUserOutput {
  answers: { question: string; selected: string[]; text?: string | undefined }[];
  skipped?: true;
}
const charLen = (s: string): number => Array.from(s).length;
// ADR-0032 §1：所有文本字段禁止控制字符；label/header 额外不允许换行。
// question/description 放行换行（0x0A）；行/段分隔符（0x2028/0x2029）一律拒绝。
// 用码点判断而非字面量：源码中不出现控制字符
const hasForbiddenChar = (s: string, allowNewline: boolean): boolean =>
  Array.from(s).some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (allowNewline && code === 0x0a) return false;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });

interface NormalizedInput {
  questions: QuestionItem[];
}

/** 按 §1 规范化并校验；通过返回规范后的问题集，不通过返回错误说明 */
function normalizeQuestions(raw: unknown): NormalizedInput | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) {
    return { error: `questions 必须提供 1–${MAX_QUESTIONS} 个问题` };
  }
  const questions: QuestionItem[] = [];
  for (const [i, item] of raw.entries()) {
    const tag = `第 ${i + 1} 个问题`;
    if (typeof item !== "object" || item === null) return { error: `${tag}无效` };
    const q = item as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (typeof q.question !== "string") return { error: `${tag}缺少 question` };
    const question = q.question.trim();
    if (question === "") {
      return { error: `${tag}的 question 去首尾空白后不能为空` };
    }
    if (charLen(question) > MAX_QUESTION_CHARS) {
      return { error: `${tag}的 question 超过 ${MAX_QUESTION_CHARS} 字符` };
    }
    if (hasForbiddenChar(question, true)) {
      return { error: `${tag}的 question 含禁止的控制字符（允许换行）` };
    }
    let header: string | undefined;
    if (q.header !== undefined) {
      if (typeof q.header !== "string") return { error: `${tag}的 header 无效` };
      const h = q.header.trim();
      if (hasForbiddenChar(h, false)) {
        return { error: `${tag}的 header 不允许换行或控制字符` };
      }
      if (charLen(h) > MAX_HEADER_CHARS) {
        return { error: `${tag}的 header 超过 ${MAX_HEADER_CHARS} 字符` };
      }
      if (h !== "") header = h;
    }
    let options: QuestionOption[] | undefined;
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) return { error: `${tag}的 options 无效` };
      // options 省略或为空 = 自由文本题；提供时必须 2–6 项（§1）
      if (q.options.length === 1 || q.options.length > MAX_OPTIONS) {
        return { error: `${tag}提供选项时必须为 ${MIN_OPTIONS}–${MAX_OPTIONS} 项` };
      }
      if (q.options.length >= MIN_OPTIONS) {
        const seen = new Set<string>();
        const list: QuestionOption[] = [];
        for (const rawOpt of q.options) {
          if (typeof rawOpt !== "object" || rawOpt === null) {
            return { error: `${tag}的选项无效` };
          }
          const opt = rawOpt as { label?: unknown; description?: unknown };
          if (typeof opt.label !== "string") return { error: `${tag}的选项缺少 label` };
          const label = opt.label.trim();
          if (label === "" || charLen(label) > MAX_LABEL_CHARS || hasForbiddenChar(label, false)) {
            return {
              error: `${tag}的选项 label 须为非空单行且至多 ${MAX_LABEL_CHARS} 字符`,
            };
          }
          if (seen.has(label)) return { error: `${tag}的选项 label 重复` };
          seen.add(label);
          let description: string | undefined;
          if (opt.description !== undefined) {
            if (typeof opt.description !== "string") {
              return { error: `${tag}的选项 description 无效` };
            }
            const d = opt.description.trim();
            if (hasForbiddenChar(d, true)) {
              return { error: `${tag}的选项 description 含禁止的控制字符` };
            }
            if (charLen(d) > MAX_DESCRIPTION_CHARS) {
              return { error: `${tag}的选项 description 超过 ${MAX_DESCRIPTION_CHARS} 字符` };
            }
            if (d !== "") description = d;
          }
          list.push({ label, ...(description !== undefined ? { description } : {}) });
        }
        options = list;
      }
    }
    questions.push({
      question,
      ...(header !== undefined ? { header } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return { questions };
}

/** §2 的人读摘要：逐题列出问题与回答 */
function formatAnswers(questions: QuestionItem[], answers: AskUserOutput["answers"]): string {
  const lines: string[] = [];
  for (const [i, q] of questions.entries()) {
    const a = answers[i];
    const parts: string[] = [];
    if (a !== undefined && a.selected.length > 0) parts.push(a.selected.join("、"));
    if (a?.text !== undefined) parts.push(`补充：${a.text}`);
    lines.push(`问：${q.question}`);
    lines.push(`答：${parts.length > 0 ? parts.join("；") : "（未回答）"}`);
  }
  return lines.join("\n");
}

export const askUserTool: ToolDefinition<{ questions: unknown }, AskUserOutput> = {
  name: "ask_user",
  description:
    "需要用户拍板时暂停并提问，用户回答后继续。仅在确实需要用户决定、且无法通过读代码、查文档或合理默认解决时使用；不要用来请求执行许可（权限由权限层处理），也不要用来确认可以直接做的事。一次调用 1–4 题；每题可提供 2–6 个选项（界面会自动附加「其他」供自由输入，不要自行添加），推荐选项放在第一位并在 label 末尾标「（推荐）」；options 省略即为自由文本回答。非交互环境调用会返回 not_interactive，此时自行采用最合理的默认继续。",
  inputSchema: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: {
              type: "array",
              maxItems: MAX_OPTIONS,
              items: {
                type: "object",
                required: ["label"],
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                additionalProperties: false,
              },
            },
            multiSelect: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  // §5：不改外部状态；提问会阻塞等回答，不与其他调用并行；等待上限 24h
  traits: { mutates: false, concurrencySafe: false, timeoutMs: ASK_TIMEOUT_MS, needsUser: true },
  validateInput(input) {
    const r = normalizeQuestions(input.questions);
    return "error" in r ? r.error : undefined;
  },
  permissionSubjects: () => [],
  async execute(input, ctx) {
    const normalized = normalizeQuestions(input.questions);
    if ("error" in normalized) {
      throw new Error(`validated ask_user input became invalid: ${normalized.error}`);
    }
    const { questions } = normalized;
    const notInteractive = {
      status: "error",
      modelContent: NOT_INTERACTIVE_MESSAGE,
      error: { code: "not_interactive", message: NOT_INTERACTIVE_MESSAGE },
    } as const;
    if (ctx.askUser === undefined) return notInteractive;
    const reply = await ctx.askUser({ questions });
    if (reply.kind === "unavailable") return notInteractive;
    if (reply.kind === "skipped") {
      return {
        status: "ok",
        modelContent: SKIPPED_MESSAGE,
        output: { answers: [], skipped: true },
      };
    }
    const answers: AskUserOutput["answers"] = questions.map((q, i) => {
      const a = reply.answers[i];
      return {
        question: q.question,
        selected: a?.selected ?? [],
        ...(a?.text !== undefined ? { text: a.text } : {}),
      };
    });
    return {
      status: "ok",
      modelContent: formatAnswers(questions, answers),
      output: { answers },
    };
  },
};
