import {
  nextSessionPageId,
  type InlinePageDisplay,
  type SessionPage,
  type SubjectRequest,
} from "../../protocol/index.js";
import { sniffImageMime } from "../image.js";
import type { ToolContext, ToolDefinition, ToolResult, ToolScope } from "../types.js";

export const MAX_INLINE_HTML_TITLE_CHARS = 80;
export const MAX_INLINE_HTML_BYTES = 256 * 1024;
/** images 参数至多引用的图片数 */
export const MAX_INLINE_HTML_IMAGES = 20;
/**
 * 图片内联后存下的整份 HTML 上限（ADR-0088 第二版）：低于远程读取附件的
 * 原始字节上限（rpc remoteAttachmentLimit，约 11.95 MiB），手机端也能读到。
 */
export const MAX_INLINE_HTML_SAVED_BYTES = 8 * 1024 * 1024;

export interface RenderHtmlEdit {
  old: string;
  new: string;
}

export interface RenderHtmlInput {
  title?: string | undefined;
  html?: string | undefined;
  images?: string[] | undefined;
  page?: string | undefined;
  edits?: RenderHtmlEdit[] | undefined;
  display?: InlinePageDisplay | undefined;
}

export interface RenderHtmlOutput {
  page: string;
  version: number;
  display: InlinePageDisplay;
  title: string;
  file: string;
  path: string;
  bytes: number;
}

/** 防止同一 step 并发新建多个页面时分配重复 page-<n> */
const inFlightPageIds = new WeakMap<object, Set<string>>();

function getInFlightSet(key: object | undefined): Set<string> | undefined {
  if (key === undefined) return undefined;
  let set = inFlightPageIds.get(key);
  if (set === undefined) {
    set = new Set<string>();
    inFlightPageIds.set(key, set);
  }
  return set;
}

/** 统计 needle 在 text 中不重叠出现的次数（与 edit 工具一致） */
function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    const found = text.indexOf(needle, i);
    if (found === -1) return count;
    count += 1;
    i = found + needle.length;
  }
}

/** 按顺序依次对 HTML 做精确替换；任一条 old 未恰好出现一次即失败，不生效 */
export function applyHtmlEdits(
  baseHtml: string,
  edits: readonly RenderHtmlEdit[],
): { ok: true; html: string } | { ok: false; error: string } {
  let current = baseHtml;
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === undefined) continue;
    const count = countOccurrences(current, edit.old);
    if (count !== 1) {
      return {
        ok: false,
        error: `edits 第 ${i + 1} 条的 old 在当前 HTML 中出现了 ${count} 次（必须恰好出现 1 次）`,
      };
    }
    const idx = current.indexOf(edit.old);
    current = `${current.slice(0, idx)}${edit.new}${current.slice(idx + edit.old.length)}`;
  }
  return { ok: true, html: current };
}

/** 将标题清洗为可安全用于文件下载名 `<标题>.html` 的前缀 */
export function sanitizeInlineHtmlLabel(title: string): string {
  let base = title
    .trim()
    .replace(/\.html?$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/^[. ]+/g, "");
  if (base === "") base = "page";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) {
    base = `_${base}`;
  }
  return `${base}.html`;
}

/** 图片路径作为属性值或 CSS url() 出现的精确写法（ADR-0088 第二版） */
const REFERENCE_FORMS: readonly (readonly [prefix: string, suffix: string])[] = [
  ['="', '"'],
  ["='", "'"],
  ["url(", ")"],
  ['url("', '")'],
  ["url('", "')"],
];

/** 把 html 中 ref 的五种精确引用换成 dataUrl；返回替换后的文本与命中次数 */
export function replaceImageReferences(
  html: string,
  ref: string,
  dataUrl: string,
): { html: string; count: number } {
  let count = 0;
  let out = html;
  for (const [prefix, suffix] of REFERENCE_FORMS) {
    const parts = out.split(`${prefix}${ref}${suffix}`);
    if (parts.length === 1) continue;
    count += parts.length - 1;
    out = parts.join(`${prefix}${dataUrl}${suffix}`);
  }
  return { html: out, count };
}

/** 扩展名 .svg 且去掉 BOM 与前导空白后以 <svg 或 <?xml 开头 */
export function isSvgImage(path: string, bytes: Uint8Array): boolean {
  if (!/\.svg$/i.test(path)) return false;
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 1024));
  const text = head.replace(/^\uFEFF/, "").trimStart();
  return text.startsWith("<svg") || text.startsWith("<?xml");
}

function failure(code: string, message: string): ToolResult<RenderHtmlOutput> {
  return { status: "error", modelContent: message, error: { code, message } };
}

function validateTitle(title: unknown): string | undefined {
  if (typeof title !== "string" || title.trim() === "") {
    return "title 不能为空";
  }
  if (/[\r\n]/.test(title)) {
    return "title 必须是单行文本，不能包含换行";
  }
  if (
    title.trim().length > MAX_INLINE_HTML_TITLE_CHARS ||
    title.length > MAX_INLINE_HTML_TITLE_CHARS
  ) {
    return `title 长度不能超过 ${MAX_INLINE_HTML_TITLE_CHARS} 个字符`;
  }
  return undefined;
}

function validateHtmlText(html: unknown): string | undefined {
  if (typeof html !== "string" || html.trim() === "") {
    return "html 不能为空";
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_INLINE_HTML_BYTES) {
    return `html 大小不能超过 ${MAX_INLINE_HTML_BYTES / 1024} KiB（当前 ${bytes} B）`;
  }
  return undefined;
}

function formatExistingPages(pages: readonly SessionPage[]): string {
  if (pages.length === 0) {
    return "当前会话尚未创建任何页面";
  }
  const lines = pages.map((p) => `- ${p.page}: ${p.title}`);
  return `当前会话已有页面：\n${lines.join("\n")}`;
}

/** 逐个读取 images 并内联进 html；任一失败整次调用失败 */
async function inlineImages(
  baseHtml: string,
  images: readonly string[] | undefined,
  ctx: ToolContext,
): Promise<{ html: string } | { error: ToolResult<RenderHtmlOutput> }> {
  let html = baseHtml;
  for (const ref of images ?? []) {
    const lexical = ctx.paths.resolve(ctx.cwd, ref);
    const approved = ctx.subjects.find((s) => s.kind === "read" && s.target === lexical);
    const target = approved?.resolved ?? lexical;
    const stat = await ctx.fs.stat(target).catch(() => undefined);
    if (stat === undefined) {
      return { error: failure("file_not_found", `images 中的 ${ref} 不存在或不可访问`) };
    }
    if (stat.type === "directory") {
      return { error: failure("is_directory", `images 中的 ${ref} 是目录，不是图片文件`) };
    }
    if (stat.size > MAX_INLINE_HTML_SAVED_BYTES) {
      return {
        error: failure(
          "html_too_large",
          `images 中的 ${ref} 有 ${stat.size} B，内联后超过 ${MAX_INLINE_HTML_SAVED_BYTES / 1024 / 1024} MiB 上限`,
        ),
      };
    }
    const bytes = await ctx.fs.readFile(target).catch(() => undefined);
    if (bytes === undefined) {
      return { error: failure("read_failed", `无法读取 images 中的 ${ref}`) };
    }
    const mime = sniffImageMime(bytes) ?? (isSvgImage(target, bytes) ? "image/svg+xml" : undefined);
    if (mime === undefined) {
      return {
        error: failure(
          "unsupported_image",
          `images 中的 ${ref} 不是可识别的图片（支持 PNG、JPEG、GIF、WebP、SVG）`,
        ),
      };
    }
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    const replaced = replaceImageReferences(html, ref, dataUrl);
    if (replaced.count === 0) {
      return {
        error: failure(
          "image_unreferenced",
          `images 中的 ${ref} 在 html 里没有被引用；须在属性值（="${ref}"）或 CSS url(${ref}) 中使用与数组完全相同的字符串`,
        ),
      };
    }
    html = replaced.html;
    const size = Buffer.byteLength(html, "utf8");
    if (size > MAX_INLINE_HTML_SAVED_BYTES) {
      return {
        error: failure(
          "html_too_large",
          `内联图片后页面超过 ${MAX_INLINE_HTML_SAVED_BYTES / 1024 / 1024} MiB 上限（内联到 ${ref} 时已达 ${size} B）`,
        ),
      };
    }
  }
  return { html };
}

export const renderHtmlTool: ToolDefinition<RenderHtmlInput, RenderHtmlOutput> = {
  name: "render_html",
  description:
    "Create or update a self-contained single-file HTML page rendered in an offline sandbox. " +
    "Use only when a chart, comparison table, diagram, UI mockup, interactive widget, dashboard, or standalone document is clearly better than prose, or when the user asks for one; use Markdown for ordinary explanations and code. " +
    "Choose display when creating a page (ignored on updates): use 'inline' (default) for charts, diagrams, and comparison tables that accompany the reply; use 'panel' for pages the user will iterate on or use alongside the chat (widgets, dashboards, documents). " +
    "To update an existing page, pass its page id returned by an earlier call with either 'edits' (preferred for small changes: sequential exact replacements where each old string appears once) or 'html' (full rewrite); omit 'title' to keep the previous title. " +
    "Use 'read' on the saved file path from the tool result when you need to inspect the current full HTML. " +
    "Sandbox rules: inline scripts and styles are allowed; all network access is blocked (no external scripts, stylesheets, images, fonts, fetch, or WebSocket—inline SVG or data: URIs only); links, form submissions, popups, and downloads are disabled. " +
    "To embed local images, list their paths in 'images' and reference the exact same strings in HTML attributes or CSS url(); they are inlined automatically on save. " +
    "Make layouts responsive (inline width ~720px on desktop and ~360px on mobile; inline pages taller than 420px collapse with expand/fullscreen). " +
    "Do not repeat the page's data, conclusions, or explanations in your reply text. " +
    "Theme CSS variables are injected dynamically on display (live-updated for light/dark mode): --bg, --raised, --text, --secondary, --muted, --border, --accent, --ok, --warn, --bad, --sans, --mono.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        description:
          "Single-line page title (up to 80 chars). Required when creating a page; optional when updating (defaults to the previous version's title).",
      },
      html: {
        type: "string",
        description:
          "Self-contained single-file HTML (UTF-8 up to 256 KiB). Required when creating a page; when updating, provide either html (full rewrite) or edits, not both.",
      },
      page: {
        type: "string",
        minLength: 1,
        description: "Existing page id (e.g. 'page-1') to update as a new version.",
      },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["old", "new"],
          properties: {
            old: {
              type: "string",
              minLength: 1,
              description: "Exact substring in the current HTML; must occur once.",
            },
            new: {
              type: "string",
              description: "Replacement text.",
            },
          },
        },
        description:
          "Sequential exact replacements applied to the previous version's HTML (update only; mutually exclusive with html). Prefer for small edits.",
      },
      display: {
        type: "string",
        enum: ["inline", "panel"],
        description:
          "Presentation mode on creation (default 'inline'; ignored on updates): 'inline' embeds in the reply (charts, diagrams, comparison tables); 'panel' shows a compact entry row and opens in the side panel (widgets, dashboards, iterative documents).",
      },
      images: {
        type: "array",
        maxItems: MAX_INLINE_HTML_IMAGES,
        items: { type: "string", minLength: 1 },
        description:
          'Local image paths (relative to cwd or absolute, up to 20) to inline; reference each exact string in HTML attributes or CSS url(), e.g. src="a.png" or url(a.png).',
      },
    },
  },
  traits: {
    mutates: false,
    concurrencySafe: true,
    mainSessionOnly: true,
  },
  permissionSubjects(input: RenderHtmlInput, scope: ToolScope): SubjectRequest[] {
    return (input.images ?? []).map((ref) => ({
      kind: "read",
      target: scope.paths.resolve(scope.cwd, ref),
    }));
  },
  validateInput(input) {
    const isUpdate = input.page !== undefined;
    if (isUpdate) {
      if (typeof input.page !== "string" || input.page.trim() === "") {
        return "page 必须是非空字符串";
      }
      if (input.title !== undefined) {
        const titleErr = validateTitle(input.title);
        if (titleErr !== undefined) return titleErr;
      }
      const hasHtml = input.html !== undefined;
      const hasEdits = input.edits !== undefined;
      if (hasHtml === hasEdits) {
        return "更新页面时 html 与 edits 必须且只能提供一个";
      }
      if (hasHtml) {
        const htmlErr = validateHtmlText(input.html);
        if (htmlErr !== undefined) return htmlErr;
      }
      if (hasEdits) {
        if (!Array.isArray(input.edits) || input.edits.length === 0) {
          return "edits 必须是非空数组";
        }
        for (let i = 0; i < input.edits.length; i += 1) {
          const item = input.edits[i];
          if (
            item === undefined ||
            typeof item.old !== "string" ||
            item.old.length === 0 ||
            typeof item.new !== "string"
          ) {
            return `edits 第 ${i + 1} 条必须包含非空字符串 old 和字符串 new`;
          }
        }
      }
    } else {
      const titleErr = validateTitle(input.title);
      if (titleErr !== undefined) return titleErr;
      if (input.edits !== undefined) {
        return "新建页面时不能传入 edits，请提供 html";
      }
      const htmlErr = validateHtmlText(input.html);
      if (htmlErr !== undefined) return htmlErr;
      const rawDisplay: unknown = input.display;
      if (rawDisplay !== undefined && rawDisplay !== "inline" && rawDisplay !== "panel") {
        return 'display 必须是 "inline" 或 "panel"';
      }
    }
    if (input.images !== undefined) {
      if (!Array.isArray(input.images) || input.images.length > MAX_INLINE_HTML_IMAGES) {
        return `images 至多 ${MAX_INLINE_HTML_IMAGES} 项`;
      }
      const seen = new Set<string>();
      for (const ref of input.images) {
        if (typeof ref !== "string" || ref.trim() === "") return "images 的每一项都必须是非空路径";
        if (seen.has(ref)) return `images 中的 ${ref} 重复`;
        seen.add(ref);
      }
    }
    return undefined;
  },
  async execute(input, ctx) {
    if (!ctx.saveFileAttachment) {
      return {
        status: "error",
        modelContent: "附件存储不可用，无法保存内嵌页面",
        error: { code: "attachment_unavailable", message: "附件存储不可用" },
      };
    }

    const pages = ctx.pages?.() ?? [];
    let pageId: string;
    let version: number;
    let display: InlinePageDisplay;
    let title: string;
    let baseHtml: string;
    let reservedId: string | undefined;
    const inFlight = getInFlightSet(ctx.pages);

    if (input.page !== undefined) {
      const requestedPage = input.page.trim();
      const existing = pages.find((p) => p.page === requestedPage);
      if (existing === undefined) {
        return failure(
          "invalid_input",
          `页面 "${requestedPage}" 不存在。${formatExistingPages(pages)}`,
        );
      }
      pageId = existing.page;
      const latest = existing.versions.at(-1);
      version = (latest?.version ?? existing.versions.length) + 1;
      // 更新时沿用第一版的显示方式，忽略本次传入的 display
      display = existing.display;
      title = input.title !== undefined ? input.title.trim() : existing.title;

      if (input.edits !== undefined) {
        if (!ctx.loadFileAttachment || latest === undefined) {
          return failure("attachment_unavailable", "附件存储不可用，无法读取上一版页面内容");
        }
        const prevBytes = await ctx.loadFileAttachment(latest.file);
        if (prevBytes === undefined) {
          return failure(
            "io_error",
            `无法读取页面 "${pageId}" 上一版（v${latest.version}，${latest.file.file}）的 HTML 内容`,
          );
        }
        const prevHtml = new TextDecoder("utf-8").decode(prevBytes);
        const applied = applyHtmlEdits(prevHtml, input.edits);
        if (!applied.ok) {
          return failure("invalid_input", applied.error);
        }
        const htmlErr = validateHtmlText(applied.html);
        if (htmlErr !== undefined) {
          return failure("invalid_input", htmlErr);
        }
        baseHtml = applied.html;
      } else {
        if (input.html === undefined) {
          return failure("invalid_input", "更新页面时请提供 html 或 edits");
        }
        baseHtml = input.html;
      }
    } else {
      if (input.title === undefined || input.html === undefined) {
        return failure("invalid_input", "新建页面必须提供 title 与 html");
      }
      pageId = nextSessionPageId(pages, inFlight);
      if (inFlight !== undefined) {
        inFlight.add(pageId);
        reservedId = pageId;
      }
      version = 1;
      display = input.display ?? "inline";
      title = input.title.trim();
      baseHtml = input.html;
    }

    try {
      const label = sanitizeInlineHtmlLabel(title);
      const inlined = await inlineImages(baseHtml, input.images, ctx);
      if ("error" in inlined) return inlined.error;
      const data = new TextEncoder().encode(inlined.html);
      const saved = await ctx.saveFileAttachment({
        data,
        mimeType: "text/html",
        label,
        inline: { title, page: pageId, version, display },
      });
      const filePath = ctx.attachmentPath ? ctx.attachmentPath(saved.file) : saved.file;
      return {
        status: "ok",
        modelContent:
          `页面「${title}」（${pageId} v${version}，${display === "panel" ? "面板" : "内嵌"}）已保存：${filePath}（${saved.bytes} B）。` +
          `回复中不要复述页面里的数据、结论或说明；需要核对当前全文时可用 read 读取该路径。`,
        output: {
          page: pageId,
          version,
          display,
          title,
          file: saved.file,
          path: filePath,
          bytes: saved.bytes,
        },
        files: [saved],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        status: "error",
        modelContent: `保存内嵌页面失败：${message}`,
        error: { code: "io_error", message },
      };
    } finally {
      if (reservedId !== undefined) {
        inFlight?.delete(reservedId);
      }
    }
  },
};
