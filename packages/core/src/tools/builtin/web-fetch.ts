import { NodeHtmlMarkdown } from "node-html-markdown";
import { NOCTURNE_VERSION } from "../../protocol/version.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "../image.js";
import type { ToolDefinition, ToolResult } from "../types.js";

interface WebFetchInput {
  url: string;
}

interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  chars: number;
  truncatedBytes?: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024;
const REMOVED_TAGS = "script style noscript svg iframe nav header footer aside form";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function validateUrl(value: string): string | undefined {
  const url = URL.parse(value);
  if (value.length > 2000 || url === null) return "URL 必须是至多 2000 字符的有效地址";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "URL 只支持 http: 与 https:";
  if (url.username !== "" || url.password !== "") return "URL 不得包含用户名或密码";
  return undefined;
}

/** URL.port 已由 WHATWG URL 去掉协议默认端口，升级 HTTPS 不改变授权主机。 */
function hostTarget(url: URL): string {
  return `${url.hostname.toLowerCase()}${url.port === "" ? "" : `:${url.port}`}`;
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      const remaining = MAX_BYTES - length;
      chunks.push(next.value.subarray(0, remaining));
      length += Math.min(next.value.length, remaining);
      if (next.value.length > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function decode(bytes: Uint8Array, contentType: string, html: boolean): string {
  let charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  if (charset === undefined && html) {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 1024));
    charset = /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'/>]+)/i.exec(prefix)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** 用转换器已有的解析树提取正文，不增加 DOM 或解析器依赖。 */
interface HtmlNode {
  textContent: string;
  innerHTML: string;
  querySelector(selector: string): HtmlNode | null;
  querySelectorAll(selector: string): HtmlNode[];
  remove(): void;
}

function htmlContent(html: string): { text: string; title?: string } {
  let title: string | undefined;
  const text = NodeHtmlMarkdown.translate(
    `<nocturne-fetch-root>${html}</nocturne-fetch-root>`,
    {},
    {
      "nocturne-fetch-root": ({ node }) => {
        // 库的联合类型含浏览器 HTMLElement；Core 无 DOM，使用解析树的最小结构。
        const root = node as unknown as HtmlNode;
        const heading = root.querySelector("title")?.textContent.replace(/\s+/g, " ").trim();
        title = heading === "" ? undefined : heading;
        for (const tag of REMOVED_TAGS.split(" ")) {
          for (const element of root.querySelectorAll(tag)) element.remove();
        }
        const body = root.querySelector("main") ?? root.querySelector("article") ?? root;
        return { recurse: false, content: NodeHtmlMarkdown.translate(body.innerHTML) };
      },
    },
  );
  return { text, ...(title === undefined ? {} : { title }) };
}

function error(code: string, message: string, output?: WebFetchOutput): ToolResult<WebFetchOutput> {
  return {
    status: "error",
    modelContent: message,
    error: { code, message },
    ...(output === undefined ? {} : { output }),
  };
}

export const webFetchTool: ToolDefinition<WebFetchInput, WebFetchOutput> = {
  name: "web_fetch",
  description:
    "读取用户给出的链接、官方文档和公开网页，HTML 转 Markdown；不能登录、不带 Cookie、不执行脚本，脚本渲染页面可能没有正文。没有搜索能力，搜索需配置搜索类 MCP。explore 子代理可使用，但非交互子会话不能确认访问：仅规则放行或父会话已授权的主机可访问，受阻访问写入 finish 结果。",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", minLength: 1, maxLength: 2000 } },
    additionalProperties: false,
  },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 30_000, maxModelChars: 30_000 },
  validateInput: (input) => validateUrl(input.url),
  permissionSubjects(input) {
    return [{ kind: "network", target: hostTarget(new URL(input.url)), detail: input.url }];
  },
  async execute(input, ctx) {
    const invalid = validateUrl(input.url);
    if (invalid !== undefined) return error("invalid_input", invalid);
    let url = new URL(input.url);
    try {
      for (let redirects = 0; ; redirects++) {
        const response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal: ctx.signal,
          headers: {
            "User-Agent": `nocturne/${NOCTURNE_VERSION}`,
            Accept: "text/html, text/markdown, text/plain, application/json, */*;q=0.5",
          },
        });
        const contentType = response.headers.get("content-type") ?? "";
        const output: WebFetchOutput = {
          url: input.url,
          finalUrl: url.href,
          status: response.status,
          contentType,
          chars: 0,
        };
        if (REDIRECTS.has(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (location === null)
            return error("http_error", `HTTP ${response.status}：重定向缺少 Location`, output);
          const next = URL.parse(location, url.href);
          const invalidRedirect = next === null ? "无效的重定向 URL" : validateUrl(next.href);
          if (invalidRedirect !== undefined || next === null)
            return error("network_error", `重定向被拒绝：${invalidRedirect}`, output);
          if (hostTarget(next) !== hostTarget(url)) {
            const modelContent = `该地址重定向到 ${next.href}；如需继续，请用新地址再次调用 web_fetch`;
            return {
              status: "ok",
              modelContent,
              output: { ...output, chars: modelContent.length },
            };
          }
          if (redirects >= 5) return error("network_error", "重定向超过 5 次", output);
          url = next;
          continue;
        }
        const { bytes, truncated } = await readBody(response, ctx.signal);
        if (truncated) output.truncatedBytes = true;
        const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
        if (!response.ok) {
          const message = `HTTP ${response.status} ${response.statusText}\n\n${decode(bytes, contentType, isHtml).slice(0, 2000)}`;
          return error("http_error", message, { ...output, chars: message.length });
        }
        const notice = truncated ? "\n\n页面过大，只处理了前 5 MB" : "";
        if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
          if (truncated || bytes.length > IMAGE_MAX_BYTES)
            return error("image_too_large", "图片超过 5 MB 上限", output);
          const imageMime = sniffImageMime(bytes);
          const size = imageMime === undefined ? undefined : parseImageSize(bytes, imageMime);
          if (size === undefined || imageMime === undefined)
            return error("image_corrupt", "图片文件头损坏或被截断，无法解析尺寸", output);
          if (size.width > IMAGE_MAX_EDGE || size.height > IMAGE_MAX_EDGE)
            return error("image_too_large", "图片每边不得超过 8000 px", output);
          const modelContent = `URL: ${url.href}\n\nImage: ${imageMime}, ${size.width}×${size.height}, ${bytes.length} bytes`;
          return {
            status: "ok",
            modelContent,
            output: { ...output, chars: modelContent.length },
            attachments: [{ mimeType: imageMime, data: bytes, label: url.href }],
          };
        }
        if (
          !isHtml &&
          !mime.startsWith("text/") &&
          !["application/json", "application/xml"].includes(mime) &&
          !/\+(?:json|xml)$/.test(mime)
        ) {
          return error(
            "unsupported_content",
            `不支持的内容类型：${mime || "未知"}，已读取 ${bytes.length} 字节${notice}`,
            output,
          );
        }
        const decoded = decode(bytes, contentType, isHtml);
        const content = isHtml ? htmlContent(decoded) : { text: decoded };
        const modelContent = `URL: ${url.href}${content.title === undefined ? "" : `\n标题: ${content.title}`}\n\n${content.text}${notice}`;
        return {
          status: "ok",
          modelContent,
          output: {
            ...output,
            ...(content.title === undefined ? {} : { title: content.title }),
            chars: modelContent.length,
          },
        };
      }
    } catch (cause) {
      // 中断/超时留给执行器统一结算，避免被转换为普通 network_error。
      ctx.signal.throwIfAborted();
      const reason =
        cause instanceof Error
          ? `${cause.message}${cause.cause instanceof Error ? `：${cause.cause.message}` : ""}`
          : String(cause);
      return error("network_error", `网络请求失败：${reason}`);
    }
  },
};
