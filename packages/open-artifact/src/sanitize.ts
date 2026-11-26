import {
  isOpenArtifactUrl,
  openArtifactIdFromUrl,
  OPEN_ARTIFACT_URL_PREFIX,
  type ToolCompletedArtifact,
} from "@nocturne/core";

const LOOPBACK_URL_RE =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[^/]+\.localhost)(?::\d+)?(?:\/|$)/i;
const INLINE_LOOPBACK_VIEW_RE =
  /\s*View it:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[^/\s]+\.localhost)(?::\d+)?[^\s]*\.?/gi;
const INLINE_LOOPBACK_URL_RE =
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[^/\s]+\.localhost)(?::\d+)?[^\s]*/gi;
const SENSITIVE_URL_KEYS = new Set(["view_url", "viewUrl", "embed_url", "embedUrl"]);

/** 剥离唤醒消息中的宿主回环 URL，避免进入持久事件日志或泄露给远端客户端（ADR-0125） */
export function sanitizeWakeText(text: string): string {
  return text
    .replace(INLINE_LOOPBACK_VIEW_RE, "")
    .replace(INLINE_LOOPBACK_URL_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * 清除工具输出中的宿主回环 URL（ADR-0125：事件日志仅保存稳定的 open-artifact:// 标识，
 * 不向远程设备或持久日志写入 127.0.0.1 / localhost 链接）。
 */
export function sanitizeToolOutput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolOutput(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_URL_KEYS.has(key)) {
        continue;
      }
      if (typeof val === "string" && LOOPBACK_URL_RE.test(val.trim())) {
        continue;
      }
      out[key] = sanitizeToolOutput(val);
    }
    return out;
  }
  return value;
}

export interface KnownArtifactMeta {
  title: string;
  type: string;
  summary?: string | undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function inferTypeFromTypeUrl(typeUrl: string | undefined): string | undefined {
  if (!typeUrl) return undefined;
  const trimmed = typeUrl.trim();
  const marker = "open-artifact://type/";
  if (trimmed.startsWith(marker)) {
    const rest = trimmed.slice(marker.length);
    const cut = rest.search(/[/?#]/);
    const id = (cut === -1 ? rest : rest.slice(0, cut)).trim();
    return id || undefined;
  }
  return undefined;
}

function summarizeArtifactResult(result: Record<string, unknown>): string | undefined {
  const boards = result.boards;
  if (Array.isArray(boards) && boards.length > 0) {
    return `${boards.length} 个画板`;
  }
  const slides = result.slides;
  if (Array.isArray(slides) && slides.length > 0) {
    return `${slides.length} 页`;
  }
  const files = result.files;
  if (Array.isArray(files) && files.length > 0) {
    return `${files.length} 个文件`;
  }
  if (files && typeof files === "object") {
    const count = Object.keys(files).length;
    if (count > 0) return `${count} 个文件`;
  }
  return undefined;
}

/**
 * 从 Artifact 工具入参与返回结果中提取要持久化到 tool.completed.artifact 的稳定作品元数据。
 */
export function extractCompletedArtifact(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  cache: Map<string, KnownArtifactMeta>,
): ToolCompletedArtifact | undefined {
  if (toolName !== "Artifact") return undefined;
  const rawAction = asNonEmptyString(args.action) ?? "publish";
  if (rawAction === "quickstart" || rawAction === "list") return undefined;

  const candidateUrl = asNonEmptyString(result.url) ?? asNonEmptyString(args.url);
  if (!candidateUrl || !isOpenArtifactUrl(candidateUrl)) return undefined;
  const id = asNonEmptyString(result.id) ?? openArtifactIdFromUrl(candidateUrl);
  if (!id) return undefined;
  const stableUrl = `${OPEN_ARTIFACT_URL_PREFIX}${id}`;

  const existing = cache.get(id);
  const title =
    asNonEmptyString(result.title) ?? asNonEmptyString(args.title) ?? existing?.title ?? id;
  const type =
    asNonEmptyString(result.type) ??
    inferTypeFromTypeUrl(asNonEmptyString(result.type_url) ?? asNonEmptyString(args.type_url)) ??
    existing?.type ??
    "artifact";
  const summary = summarizeArtifactResult(result) ?? existing?.summary;

  if (rawAction === "delete") {
    cache.delete(id);
    return {
      url: stableUrl,
      id,
      title,
      type,
      removed: true,
    };
  }

  cache.set(id, { title, type, ...(summary ? { summary } : {}) });

  const openArg = asNonEmptyString(args.open);
  const opened =
    rawAction === "open" ||
    result.opened === true ||
    (rawAction === "publish" && openArg !== "never");

  return {
    url: stableUrl,
    id,
    title,
    type,
    ...(summary ? { summary } : {}),
    ...(opened ? { open: true } : {}),
  };
}
