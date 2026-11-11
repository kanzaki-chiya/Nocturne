import type { SubjectRequest } from "../../protocol/index.js";
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

export interface RenderHtmlInput {
  title: string;
  html: string;
  images?: string[] | undefined;
}

export interface RenderHtmlOutput {
  title: string;
  file: string;
  bytes: number;
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

/** 逐个读取 images 并内联进 html；任一失败整次调用失败 */
async function inlineImages(
  input: RenderHtmlInput,
  ctx: ToolContext,
): Promise<{ html: string } | { error: ToolResult<RenderHtmlOutput> }> {
  const images = input.images ?? [];
  let html = input.html;
  for (const ref of images) {
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
    "在对话中内嵌渲染一份自包含的单文件 HTML 页面。仅在图表、对比表、示意图、界面草图或轻量交互明显优于文字时，或用户明确要求时使用；普通说明与代码直接用 Markdown 回复。页面在断网沙箱中运行：允许内联脚本与内联样式，完全不能联网（远程脚本、样式、图片、字体、fetch、WebSocket 均不可用，图片与字体须用内联 SVG 或 data:），链接跳转、表单提交、弹窗与下载均无效。要显示本地图片文件时，把路径列进 images，并在 html 的属性值或 CSS url() 中写同一字符串，保存时会自动内联。容器桌面宽约 720px、手机宽约 360px，需响应式自适应，高于 420px 自动折叠并可展开或全屏。页面直接显示在对话中，回复正文不要复述页面里的数据、结论或说明。显示时自动注入主题 CSS 变量（随深浅色实时切换）：--bg（页面底色）、--raised（凸起面）、--text（文字）、--secondary（次要文字）、--muted（弱文字）、--border（边线）、--accent（强调色）、--ok（成功色）、--warn（警告色）、--bad（危险色）、--sans（正文字体）、--mono（等宽字体）。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "html"],
    properties: {
      title: {
        type: "string",
        description: "单行页面标题（至多 80 字符）",
      },
      html: {
        type: "string",
        description: "自包含的单文件 HTML（UTF-8 至多 256 KiB）",
      },
      images: {
        type: "array",
        maxItems: MAX_INLINE_HTML_IMAGES,
        items: { type: "string", minLength: 1 },
        description:
          '页面引用的本地图片路径（相对 cwd 或绝对路径，至多 20 个）；HTML 里用与数组项完全相同的字符串引用，如 src="a.png" 或 url(a.png)',
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
    if (typeof input.title !== "string" || input.title.trim() === "") {
      return "title 不能为空";
    }
    if (/[\r\n]/.test(input.title)) {
      return "title 必须是单行文本，不能包含换行";
    }
    if (
      input.title.trim().length > MAX_INLINE_HTML_TITLE_CHARS ||
      input.title.length > MAX_INLINE_HTML_TITLE_CHARS
    ) {
      return `title 长度不能超过 ${MAX_INLINE_HTML_TITLE_CHARS} 个字符`;
    }
    if (typeof input.html !== "string" || input.html.trim() === "") {
      return "html 不能为空";
    }
    const bytes = Buffer.byteLength(input.html, "utf8");
    if (bytes > MAX_INLINE_HTML_BYTES) {
      return `html 大小不能超过 ${MAX_INLINE_HTML_BYTES / 1024} KiB（当前 ${bytes} B）`;
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
    const title = input.title.trim();
    const label = sanitizeInlineHtmlLabel(title);
    const inlined = await inlineImages(input, ctx);
    if ("error" in inlined) return inlined.error;
    const data = new TextEncoder().encode(inlined.html);
    try {
      const saved = await ctx.saveFileAttachment({
        data,
        mimeType: "text/html",
        label,
        inline: { title },
      });
      return {
        status: "ok",
        modelContent: `内嵌页面「${title}」已显示给用户（${saved.file}，${saved.bytes} B）。回复中不要复述页面里的数据、结论或说明。`,
        output: { title, file: saved.file, bytes: saved.bytes },
        files: [saved],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        status: "error",
        modelContent: `保存内嵌页面失败：${message}`,
        error: { code: "io_error", message },
      };
    }
  },
};
