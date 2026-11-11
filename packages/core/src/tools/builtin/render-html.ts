import type { ToolDefinition } from "../types.js";

export const MAX_INLINE_HTML_TITLE_CHARS = 80;
export const MAX_INLINE_HTML_BYTES = 256 * 1024;

export interface RenderHtmlInput {
  title: string;
  html: string;
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

export const renderHtmlTool: ToolDefinition<RenderHtmlInput, RenderHtmlOutput> = {
  name: "render_html",
  description:
    "在对话中内嵌渲染一份自包含的单文件 HTML 页面。仅在图表、对比表、示意图、界面草图或轻量交互明显优于文字时，或用户明确要求时使用；普通说明与代码直接用 Markdown 回复。页面在断网沙箱中运行：允许内联脚本与内联样式，完全不能联网（远程脚本、样式、图片、字体、fetch、WebSocket 均不可用，图片与字体须用内联 SVG 或 data:），链接跳转、表单提交、弹窗与下载均无效。容器桌面宽约 720px、手机宽约 360px，需响应式自适应，高于 420px 自动折叠并可展开或全屏。页面直接显示在对话中，回复正文不要复述页面内容。显示时自动注入主题 CSS 变量（随深浅色实时切换）：--bg（页面底色）、--raised（凸起面）、--text（文字）、--secondary（次要文字）、--muted（弱文字）、--border（边线）、--accent（强调色）、--ok（成功色）、--warn（警告色）、--bad（危险色）、--sans（正文字体）、--mono（等宽字体）。",
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
    },
  },
  traits: {
    mutates: false,
    concurrencySafe: true,
    mainSessionOnly: true,
  },
  permissionSubjects: () => [],
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
    const data = new TextEncoder().encode(input.html);
    try {
      const saved = await ctx.saveFileAttachment({
        data,
        mimeType: "text/html",
        label,
        inline: { title },
      });
      return {
        status: "ok",
        modelContent: `已渲染内嵌页面「${title}」（${saved.file}，${saved.bytes} B）。`,
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
