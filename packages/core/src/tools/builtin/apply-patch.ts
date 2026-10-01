/**
 * apply_patch 工具（ADR-0035）：Codex 补丁格式的多文件编辑。
 *
 * 格式：
 *   *** Begin Patch
 *   *** Add File: <path>        —— 其后每行以 "+" 开头
 *   *** Delete File: <path>
 *   *** Update File: <path>     —— 可紧跟 "*** Move to: <path>" 改名
 *   @@ [定位上下文]
 *    <上下文行> / -<删除行> / +<新增行>
 *   *** End of File             —— 该 hunk 必须贴着文件末尾
 *   *** End Patch
 *
 * 每个 hunk 按四级匹配定位（逐字 → 忽略行尾空白 → 忽略首尾空白 →
 * Unicode 标点归一），同一文件的多个 hunk 顺序应用、后一个从前一个
 * 结束位置之后开始找。整体成败：全部在内存中算完才开始写盘，写盘
 * 中途失败用内存里的原内容恢复。先读后写与 edit 同一套检查：
 * Update/Delete/Move 源要求本会话读过且未过期，Add/Move 目标必须
 * 不存在。写回逐行保留原有换行符，BOM 与末尾换行状态不变。
 */
import { resolveRealPath } from "../../platform/index.js";
import type { SubjectRequest } from "../../protocol/index.js";
import type { ToolDefinition, ToolScope } from "../types.js";
import { diffLines } from "./diff.js";
import { diagnoseNoMatch } from "./edit-diagnostic.js";
import { guardWritable, isGuardError, toolError, type GuardError } from "./guard.js";

interface ApplyPatchInput {
  /** 补丁原文（可包一层 apply_patch <<'EOF' … EOF heredoc 外壳） */
  input: string;
}

interface PatchFileResult {
  path: string;
  op: "add" | "update" | "delete" | "move";
  movedTo?: string | undefined;
  /** 该文件的行级 unified diff（客户端逐文件渲染） */
  diff?: string | undefined;
}

interface ApplyPatchOutput {
  files: PatchFileResult[];
}

// ── 解析（纯函数，无 I/O；格式错误一律报错，不猜测） ──────────

interface PatchHunk {
  /** "@@" 后的定位上下文原文（去除首尾空白）；无上下文为 undefined */
  context: string | undefined;
  /** mark 空格=上下文、"-"=删除、"+"=新增 */
  lines: { mark: " " | "-" | "+"; text: string }[];
  /** "*** End of File"：该 hunk 必须贴着文件末尾 */
  eof: boolean;
}

type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | undefined; hunks: PatchHunk[] };

type ParsedPatch = { ok: true; ops: PatchOp[] } | { ok: false; message: string };

function fail(message: string): ParsedPatch {
  return { ok: false, message };
}

const MARKER = "*** ";
const OP_MARKER = /^\*\*\* (Add File|Delete File|Update File|Move to):\s*(.*)$/;
const MOVE_MARKER = /^\*\*\* Move to:\s*(.*)$/;
const EOF_MARKER = "*** End of File";
const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";

/** 剥掉 heredoc 外壳与首尾空白行，统一换行为 \n 后按行切分 */
function stripShell(input: string): string[] {
  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  // 外层 heredoc：首词 apply_patch（可带 <<'EOF'），末行是定界符
  const first = lines[0] ?? "";
  if (/^apply_patch\b/.test(first)) {
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(first);
    lines.shift();
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    const last = lines.at(-1)?.trim();
    if (
      last !== undefined &&
      (heredoc !== null ? last === heredoc[1] : /^[A-Za-z_][A-Za-z0-9_]*$/.test(last))
    ) {
      lines.pop();
      while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    }
  }
  return lines;
}

export function parsePatch(input: string): ParsedPatch {
  const lines = stripShell(input);
  if (lines.length === 0) return fail("补丁为空");
  if ((lines[0] ?? "").trimEnd() !== BEGIN_MARKER) {
    return fail('补丁必须以 "*** Begin Patch" 开头');
  }
  const ops: PatchOp[] = [];
  let i = 1;
  let ended = false;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trimEnd() === END_MARKER) {
      ended = true;
      i++;
      break;
    }
    const m = OP_MARKER.exec(line.trimEnd());
    if (m === null) {
      return fail(`第 ${i + 1} 行无法识别：${line.slice(0, 80)}`);
    }
    const directive = m[1] ?? "";
    const path = (m[2] ?? "").trim();
    if (path === "") return fail(`第 ${i + 1} 行缺少文件路径`);
    i++;
    if (directive === "Add File") {
      const content: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").startsWith(MARKER)) {
        const l = lines[i] ?? "";
        if (!l.startsWith("+")) {
          return fail(`第 ${i + 1} 行：Add File 的内容行必须以 "+" 开头`);
        }
        content.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path, lines: content });
      continue;
    }
    if (directive === "Delete File") {
      ops.push({ kind: "delete", path });
      continue;
    }
    if (directive === "Move to") {
      return fail('"*** Move to" 只能紧跟 "*** Update File" 之后');
    }
    // Update File
    let moveTo: string | undefined;
    const move = MOVE_MARKER.exec(lines[i]?.trimEnd() ?? "");
    if (move !== null) {
      moveTo = (move[1] ?? "").trim();
      if (moveTo === "") return fail(`第 ${i + 1} 行缺少改名目标路径`);
      i++;
    }
    const hunks: PatchHunk[] = [];
    while (i < lines.length && !(lines[i] ?? "").startsWith(MARKER)) {
      const head = lines[i] ?? "";
      const hunk: PatchHunk = { context: undefined, lines: [], eof: false };
      // "@@ <上下文>" 可选：没有时整个段就是一个无定位上下文的 hunk
      if (head.startsWith("@@")) {
        const context = head.slice(2).trim();
        hunk.context = context === "" ? undefined : context;
        i++;
      }
      // hunk 体：空格/−/+ 行；空行按空上下文行处理；*** End of File 收尾
      for (;;) {
        if (i >= lines.length) break;
        const l = lines[i] ?? "";
        if (l.trimEnd() === EOF_MARKER) {
          hunk.eof = true;
          i++;
          break;
        }
        if (l.startsWith(MARKER) || l.startsWith("@@")) break;
        const mark = l.charAt(0);
        if (mark === " " || mark === "-" || mark === "+") {
          hunk.lines.push({ mark, text: l.slice(1) });
        } else if (l === "") {
          // 空行按空上下文行处理（模型常省略单空格前缀）
          hunk.lines.push({ mark: " ", text: "" });
        } else {
          return fail(`第 ${i + 1} 行：hunk 行必须以空格、"-" 或 "+" 开头`);
        }
        i++;
      }
      hunks.push(hunk);
    }
    if (hunks.length === 0) {
      return fail(`Update File ${path} 没有任何 hunk`);
    }
    ops.push({ kind: "update", path, moveTo, hunks });
  }
  if (!ended) return fail('补丁缺少 "*** End Patch"');
  for (; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "") {
      return fail(`"*** End Patch" 之后还有内容（第 ${i + 1} 行）`);
    }
  }
  if (ops.length === 0) return fail("补丁不包含任何文件操作");
  return { ok: true, ops };
}

// ── 匹配（ADR-0035 §2 的四级定位） ──────────────────────────

/** Unicode 标点归一：破折号→-、弯引号→' / "、不间断空格→空格、省略号→... */
function foldPunct(s: string): string {
  return s
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2007\u202F\u3000]/g, " ");
}

const MATCHERS: ((a: string, b: string) => boolean)[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => foldPunct(a.trim()) === foldPunct(b.trim()),
];

/** @@ 定位上下文用「包含」语义：先找到包含该上下文的行（ADR-0035 §2） */
const CTX_MATCHERS: ((a: string, b: string) => boolean)[] = [
  (a, b) => a.includes(b),
  (a, b) => a.trimEnd().includes(b.trimEnd()),
  (a, b) => a.trim().includes(b.trim()),
  (a, b) => foldPunct(a.trim()).includes(foldPunct(b.trim())),
];

/** 从 from 起按比较器找 pattern 的第一次出现；eofOnly 时只认贴着文件末尾的位置 */
function seek(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  cmp: (a: string, b: string) => boolean,
  eofOnly: boolean,
): number {
  const max = lines.length - pattern.length;
  for (let i = Math.max(0, from); i <= max; i++) {
    if (eofOnly && i + pattern.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < pattern.length; j++) {
      if (!cmp(lines[i + j] ?? "", pattern[j] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** 四级查找：返回命中下标，未命中返回 -1 */
function seekLevels(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  eofOnly: boolean,
  matchers: ((a: string, b: string) => boolean)[] = MATCHERS,
): number {
  for (const cmp of matchers) {
    const at = seek(lines, pattern, from, cmp, eofOnly);
    if (at !== -1) return at;
  }
  return -1;
}

interface ApplyFail {
  /** 出错的 hunk 序号（1 起） */
  hunk: number;
  /** 给诊断用的失败侧原文 */
  needle: string;
  /** 失败原因注记（如 @@ 上下文未命中） */
  detail?: string;
}

/** 文件的一行：内容与其原有换行符（末行无换行时 ending 为 ""） */
interface FileLine {
  text: string;
  ending: string;
}

/**
 * 按顺序把 hunks 应用到行数组。新增行的换行符取文件主导 eol；
 * 触及文件末尾的 hunk 保留原末行的换行状态（不新增/不丢失末尾换行）。
 */
function applyHunks(
  lines: FileLine[],
  hunks: PatchHunk[],
  eol: string,
): { lines: FileLine[] } | ApplyFail {
  const out = [...lines];
  const texts = () => out.map((l) => l.text);
  let cursor = 0;
  for (const [n, hunk] of hunks.entries()) {
    const oldLines = hunk.lines.filter((l) => l.mark === " " || l.mark === "-").map((l) => l.text);
    let from = cursor;
    if (hunk.context !== undefined) {
      const at = seekLevels(texts(), [hunk.context], from, false, CTX_MATCHERS);
      if (at === -1) {
        return { hunk: n + 1, needle: hunk.context, detail: "@@ 定位上下文未命中" };
      }
      from = at + 1;
    }
    let pos: number;
    if (oldLines.length === 0) {
      // 纯新增：有上下文贴在上下文行后；无上下文插在游标处；eof 贴文件末尾
      pos = hunk.eof ? out.length : from;
    } else {
      pos = seekLevels(texts(), oldLines, from, hunk.eof);
      if (pos === -1) {
        return {
          hunk: n + 1,
          needle: oldLines.join("\n"),
          ...(hunk.eof ? { detail: "*** End of File 要求 hunk 贴着文件末尾" } : {}),
        };
      }
    }
    // context 行保留文件原字节（文本+原换行符）；"-" 删除、"+" 用补丁文本。
    // 这样 L2/L3 模糊命中不会把补丁里的空白差异写回文件。
    const fileSlice = out.slice(pos, pos + oldLines.length);
    const replacement: FileLine[] = [];
    let oi = 0;
    for (const l of hunk.lines) {
      if (l.mark === "-") oi++;
      else if (l.mark === "+") replacement.push({ text: l.text, ending: eol });
      else {
        const fl = fileSlice[oi++];
        if (fl === undefined) {
          return { hunk: n + 1, needle: oldLines.join("\n"), detail: "hunk 行数与命中段不符" };
        }
        replacement.push(fl);
      }
    }
    // 末尾换行状态：替换/追加触及末行时沿用原末行 ending
    const touchesEnd = pos + oldLines.length === out.length;
    const endEnding = touchesEnd && out.length > 0 ? (out.at(-1)?.ending ?? eol) : eol;
    out.splice(pos, oldLines.length, ...replacement);
    const last = out.at(-1);
    if (touchesEnd && last !== undefined) {
      last.ending = endEnding;
    }
    // 下一个 hunk 从本次替换区的结束位置之后开始找
    cursor = pos + replacement.length;
  }
  return { lines: out };
}

// ── 文本 ↔ 行数组（逐行保留换行符，保留 BOM 与末尾换行状态） ──

interface TextLines {
  lines: FileLine[];
  bom: boolean;
  /** 文件主导换行符（首个非空 ending）；新增行的换行符取它 */
  eol: string;
}

const BOM = "\uFEFF";

function splitText(text: string): TextLines {
  let body = text;
  const bom = body.startsWith(BOM);
  if (bom) body = body.slice(1);

  const lines: FileLine[] = [];
  let eol = "\n";
  for (const match of body.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (match[0] === "") break;
    const ending = match[2] ?? "";
    if (ending !== "" && eol === "\n") eol = ending;
    lines.push({ text: match[1] ?? "", ending });
  }
  // matchAll 会把文件末尾换行后的空串当成一行（ending ""），去掉它
  if (lines.length > 1 && lines.at(-1)?.text === "" && lines.at(-1)?.ending === "") {
    lines.pop();
  }
  return { lines, bom, eol };
}

function joinText(t: TextLines): string {
  return (t.bom ? BOM : "") + t.lines.map((l) => l.text + l.ending).join("");
}

// ── 工具本体 ──────────────────────────────────────────────

const DESCRIPTION = `用补丁格式一次修改多个文件（新建、更新、删除、改名）。补丁原文放在 input 字段：

*** Begin Patch
*** Add File: <path>          —— 新建文件；其后每行以 "+" 开头
*** Update File: <path>       —— 修改文件；可紧跟 "*** Move to: <path>" 改名
@@ [可选的定位上下文]
 <上下文行>                    —— 以空格开头，须出现在原文中
-<删除的行>
+<新增的行>
*** End of File               —— 可选；该 hunk 必须贴着文件末尾
*** Delete File: <path>
*** End Patch

规则：
- 一次补丁可含任意多个文件操作与 hunk；同一文件的多个 hunk 从上到下顺序应用。
- "@@" 后写一行定位用的上下文（如函数签名）；上下文行多给几行（3 行左右）保证唯一定位。匹配先逐字尝试，再放宽到忽略行尾/首尾空白与常见 Unicode 标点差异。
- 修改、删除或改名已有文件前，必须先在本会话用 read 读过它（或经用户 @文件 附带），且之后未被外部修改；Add File 与 Move to 的目标必须不存在。
- 路径相对当前工作目录或绝对路径均可。补丁有一处失败则整个不落盘。

示例：
*** Begin Patch
*** Update File: src/app.ts
@@ function start
 const a = 1;
-const b = 2;
+const b = 3;
*** End Patch`;

export const applyPatchTool: ToolDefinition<ApplyPatchInput, ApplyPatchOutput> = {
  name: "apply_patch",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    required: ["input"],
    properties: {
      input: {
        type: "string",
        minLength: 1,
        description: "补丁原文（*** Begin Patch … *** End Patch）",
      },
    },
    additionalProperties: false,
  },
  traits: { mutates: true, concurrencySafe: false, timeoutMs: 15_000, editTool: "apply_patch" },

  /** 纯函数：解析补丁并为每个涉及的路径产出一个 edit 主体（改名的源与目标都算） */
  permissionSubjects(input: ApplyPatchInput, scope: ToolScope): SubjectRequest[] {
    const parsed = parsePatch(input.input);
    if (!parsed.ok) return []; // validateInput 已先拒绝；此处兜底
    const targets = new Set<string>();
    for (const op of parsed.ops) {
      targets.add(scope.paths.resolve(scope.cwd, op.path));
      if (op.kind === "update" && op.moveTo !== undefined) {
        targets.add(scope.paths.resolve(scope.cwd, op.moveTo));
      }
    }
    return [...targets].map((target) => ({ kind: "edit" as const, target }));
  },

  validateInput(input: ApplyPatchInput): string | undefined {
    const parsed = parsePatch(input.input);
    return parsed.ok ? undefined : `补丁格式错误：${parsed.message}`;
  },

  async execute(input, ctx) {
    const parsed = parsePatch(input.input);
    if (!parsed.ok) {
      // 正常路径下 validateInput 已拒绝；Hook 改写输入时可能走到这里
      return toolError("invalid_input", `补丁格式错误：${parsed.message}`);
    }

    // 批准的 edit 主体：词法目标 → 解析后的真实路径
    const approved = new Map<string, string>();
    for (const s of ctx.subjects) {
      if (s.kind === "edit" && s.resolved !== undefined) approved.set(s.target, s.resolved);
    }
    const resolveOp = (p: string): { target: string; resolved: string } | GuardError => {
      const target = ctx.paths.resolve(ctx.cwd, p);
      const resolved = approved.get(target);
      if (resolved === undefined) {
        return toolError("internal", `缺少已批准的编辑路径：${p}`);
      }
      return { target, resolved };
    };

    /** 新增/改名目标的守卫：路径未漂移 + 目标尚不存在 */
    const guardNew = async (target: string, resolved: string): Promise<GuardError | undefined> => {
      const now = await resolveRealPath(ctx.fs, ctx.paths, target);
      if (!ctx.paths.equals(now, resolved)) {
        return toolError(
          "resource_changed",
          `批准的路径与当前解析结果不一致（批准：${resolved}，当前：${now}）。请重新确认后再写入`,
        );
      }
      const stat = await ctx.fs.stat(resolved).catch(() => undefined);
      if (stat !== undefined) {
        return stat.type === "directory"
          ? toolError("is_directory", `${resolved} 是目录，不是文件`)
          : toolError("file_exists", `目标已存在：${resolved}。要修改已有文件请改用 Update File`);
      }
      return undefined;
    };

    // 第一遍：全部在内存中计算。plan 记录每个触及路径的原始文本与目标文本
    //（undefined = 该路径在对应状态下不存在）；opResults 供输出按 op 顺序生成
    const plan = new Map<string, { before: string | undefined; after: string | undefined }>();
    const opResults: {
      op: PatchOp;
      resolvedSrc: string;
      resolvedDst: string | undefined;
      /** 该 op 产出的新文件文本；delete 为 undefined */
      newText: string | undefined;
    }[] = [];

    for (const op of parsed.ops) {
      if (op.kind === "add") {
        const r = resolveOp(op.path);
        if ("status" in r) return r;
        let entry = plan.get(r.resolved);
        if (entry !== undefined) {
          if (entry.after !== undefined) {
            return toolError("file_exists", `补丁多次写入同一路径且已有内容：${r.resolved}`);
          }
        } else {
          const g = await guardNew(r.target, r.resolved);
          if (g !== undefined) return g;
          entry = { before: undefined, after: undefined };
          plan.set(r.resolved, entry);
        }
        const text = op.lines.length === 0 ? "" : `${op.lines.join("\n")}\n`;
        entry.after = text;
        opResults.push({ op, resolvedSrc: r.resolved, resolvedDst: undefined, newText: text });
        continue;
      }
      if (op.kind === "delete") {
        const r = resolveOp(op.path);
        if ("status" in r) return r;
        let entry = plan.get(r.resolved);
        if (entry === undefined) {
          const g = await guardWritable(r.target, r.resolved, ctx, true);
          if (isGuardError(g) || g === undefined) {
            return g ?? toolError("file_not_found", `文件不存在：${r.resolved}`);
          }
          entry = { before: g.oldText, after: g.oldText };
          plan.set(r.resolved, entry);
        }
        if (entry.after === undefined) {
          return toolError("file_not_found", `文件不存在：${r.resolved}`);
        }
        entry.after = undefined;
        opResults.push({
          op,
          resolvedSrc: r.resolved,
          resolvedDst: undefined,
          newText: undefined,
        });
        continue;
      }
      // update（含可选改名）
      const r = resolveOp(op.path);
      if ("status" in r) return r;
      let resolvedDst: string | undefined;
      if (op.moveTo !== undefined) {
        const d = resolveOp(op.moveTo);
        if ("status" in d) return d;
        if (ctx.paths.equals(d.resolved, r.resolved)) {
          return toolError("invalid_input", `Move to 目标与源路径相同：${op.moveTo}`);
        }
        const dst = plan.get(d.resolved);
        if (dst !== undefined) {
          if (dst.after !== undefined) {
            return toolError("file_exists", `改名目标已被本补丁写入：${d.resolved}`);
          }
        } else {
          const g = await guardNew(d.target, d.resolved);
          if (g !== undefined) return g;
          plan.set(d.resolved, { before: undefined, after: undefined });
        }
        resolvedDst = d.resolved;
      }
      let srcEntry = plan.get(r.resolved);
      if (srcEntry === undefined) {
        const g = await guardWritable(r.target, r.resolved, ctx, true);
        if (isGuardError(g) || g === undefined) {
          return g ?? toolError("file_not_found", `文件不存在：${r.resolved}`);
        }
        srcEntry = { before: g.oldText, after: g.oldText };
        plan.set(r.resolved, srcEntry);
      }
      if (srcEntry.after === undefined) {
        return toolError("file_not_found", `文件不存在：${r.resolved}`);
      }
      const text = splitText(srcEntry.after);
      const applied = applyHunks(text.lines, op.hunks, text.eol);
      if ("hunk" in applied) {
        const detail = applied.detail !== undefined ? `${applied.detail}。` : "";
        return toolError(
          "no_match",
          `${r.resolved} 的第 ${applied.hunk} 个 hunk 未命中。${detail}${diagnoseNoMatch(
            srcEntry.after,
            applied.needle,
          )}`,
        );
      }
      const newText = joinText({ ...text, lines: applied.lines });
      if (resolvedDst !== undefined) {
        // 改名：源删除、目标写新内容（dst 项已在上面 plan.set 就位）
        srcEntry.after = undefined;
        const dstEntry = plan.get(resolvedDst);
        if (dstEntry === undefined) {
          return toolError("internal", `改名目标缺少计划项：${resolvedDst}`);
        }
        dstEntry.after = newText;
      } else {
        srcEntry.after = newText;
      }
      opResults.push({ op, resolvedSrc: r.resolved, resolvedDst, newText });
    }

    // 第二遍：写盘。commits 按 plan 插入序（= op 首次触及顺序）；
    // 前后状态相同的路径不产生写盘（如 add 后被 delete）
    interface Commit {
      path: string;
      action: "write" | "delete";
      text?: string;
      before: string | undefined;
    }
    const commits: Commit[] = [];
    for (const [path, entry] of plan) {
      if (entry.before === entry.after) continue;
      if (entry.after === undefined) {
        commits.push({ path, action: "delete", before: entry.before });
      } else {
        commits.push({ path, action: "write", text: entry.after, before: entry.before });
      }
    }

    const done: Commit[] = [];
    for (const c of commits) {
      try {
        if (c.action === "write") {
          // 竞态复检：规划时目标是新建，落盘瞬间恰好出现按冲突处理（触发回滚）
          if (c.before === undefined && (await ctx.fs.exists(c.path))) {
            throw new Error(`目标已存在：${c.path}`);
          }
          await ctx.fs.mkdir(ctx.paths.dirname(c.path)).catch(() => undefined);
          if (c.text === undefined) throw new Error(`内部错误：write 缺少内容 ${c.path}`);
          await ctx.fs.writeFile(c.path, c.text);
        } else {
          await ctx.fs.unlink(c.path);
        }
        done.push(c);
      } catch (e) {
        // 回滚：逆序恢复已执行的写入（内存里的原内容），逐个报告实际状态
        const why = e instanceof Error ? e.message : String(e);
        const states = [`${c.path}：写入失败（${why}）`];
        for (const d of [...done].reverse()) {
          try {
            if (d.action === "write") {
              if (d.before === undefined) await ctx.fs.unlink(d.path);
              else await ctx.fs.writeFile(d.path, d.before);
            } else if (d.before !== undefined) {
              await ctx.fs.writeFile(d.path, d.before);
            }
            states.push(`${d.path}：已恢复原状`);
          } catch (re) {
            states.push(
              `${d.path}：恢复失败（${re instanceof Error ? re.message : String(re)}），文件可能已改动`,
            );
          }
        }
        return toolError("write_failed", `补丁写盘失败，未全部应用。\n${states.join("\n")}`);
      }
    }

    // 全部成功：记录最终仍为文件的路径的新 stat（供本会话后续先读检查）
    for (const c of commits) {
      if (c.action !== "write") continue;
      const stat = await ctx.fs.stat(c.path).catch(() => undefined);
      if (stat !== undefined) {
        ctx.readState.record(c.path, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }

    // 输出：按 op 顺序逐文件给出 diff；改名记 movedTo
    const files: PatchFileResult[] = opResults.map((r) => {
      const srcBefore = r.op.kind === "add" ? "" : (plan.get(r.resolvedSrc)?.before ?? "");
      const diff = diffLines(srcBefore, r.newText ?? "", r.resolvedSrc);
      return {
        path: r.resolvedSrc,
        op: r.op.kind === "update" ? (r.resolvedDst !== undefined ? "move" : "update") : r.op.kind,
        ...(r.resolvedDst !== undefined ? { movedTo: r.resolvedDst } : {}),
        ...(diff !== "" ? { diff } : {}),
      };
    });
    const letters = { add: "A", update: "M", delete: "D", move: "M" } as const;
    const summary = files.map((f) => `${letters[f.op]} ${f.path}`).join("\n");
    return {
      status: "ok",
      modelContent: `Success. Updated the following files:\n${summary}`,
      output: { files },
    };
  },
};
