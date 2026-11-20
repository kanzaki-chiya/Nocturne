export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export interface ToolResultLike {
  isError?: boolean | undefined;
  content?: readonly { type?: string | undefined; text?: string | undefined }[] | undefined;
  structuredContent?: Record<string, unknown> | undefined;
}

export interface FormattedViewerError {
  readonly display: string;
  readonly raw: string;
  readonly code?: string | undefined;
}

export class ViewerToolError extends Error {
  readonly formatted: FormattedViewerError;

  constructor(formatted: FormattedViewerError) {
    super(formatted.raw);
    this.name = "ViewerToolError";
    this.formatted = formatted;
  }
}

const BRACKET_CODE_RE = /^\[([a-z0-9_]+)\]\s*/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResultLike(value: unknown): value is ToolResultLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.isError === "boolean" ||
    Array.isArray(value.content) ||
    isRecord(value.structuredContent)
  );
}

export function mapViewerErrorCode(
  code: string | undefined,
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
): string {
  switch (code) {
    case "libreoffice_not_found":
    case "libreoffice_uno_unavailable":
      return "未找到 LibreOffice";
    case "file_not_found":
      return "文件不存在";
    case "document_too_large": {
      const mb = Math.round(maxDocumentBytes / (1024 * 1024));
      return `文件超过 ${String(mb)} MB`;
    }
    case "timeout":
      return "转换超时";
    case "PasswordException":
      return "文件已加密";
    default:
      return "无法打开此文件";
  }
}

export function extractToolError(res: ToolResultLike): {
  code: string | undefined;
  raw: string;
} {
  let code: string | undefined;
  let raw: string | undefined;

  const sc = res.structuredContent;
  if (isRecord(sc) && isRecord(sc.error)) {
    if (typeof sc.error.code === "string" && sc.error.code.length > 0) {
      code = sc.error.code;
    }
    if (typeof sc.error.message === "string" && sc.error.message.length > 0) {
      raw = code !== undefined ? `[${code}] ${sc.error.message}` : sc.error.message;
    }
  }

  if (res.content !== undefined) {
    const texts: string[] = [];
    for (const item of res.content) {
      if (item.type === "text" && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
    if (texts.length > 0) {
      const joined = texts.join("\n");
      raw ??= joined;
      if (code === undefined) {
        const match = BRACKET_CODE_RE.exec(joined.trim());
        if (match?.[1] !== undefined) {
          code = match[1];
        }
      }
    }
  }

  return { code, raw: raw ?? "Unknown error" };
}

export function isDocumentUnknownError(res: ToolResultLike): boolean {
  const { code, raw } = extractToolError(res);
  return code === "document_unknown" || raw.includes("document_unknown");
}

export function formatViewerError(
  source: unknown,
  maxDocumentBytes = MAX_DOCUMENT_BYTES,
): FormattedViewerError {
  if (source instanceof ViewerToolError) {
    return source.formatted;
  }

  if (isToolResultLike(source)) {
    const { code, raw } = extractToolError(source);
    return {
      display: mapViewerErrorCode(code, maxDocumentBytes),
      raw,
      ...(code !== undefined ? { code } : {}),
    };
  }

  if (source instanceof Error) {
    const raw = source.message || source.name || "Unknown error";
    const bracketMatch = BRACKET_CODE_RE.exec(raw.trim());
    const code =
      source.name === "PasswordException"
        ? "PasswordException"
        : (bracketMatch?.[1] ?? (source.name !== "Error" ? source.name : undefined));
    return {
      display: mapViewerErrorCode(code, maxDocumentBytes),
      raw,
      ...(code !== undefined ? { code } : {}),
    };
  }

  if (typeof source === "string") {
    const bracketMatch = BRACKET_CODE_RE.exec(source.trim());
    const code = bracketMatch?.[1];
    return {
      display: mapViewerErrorCode(code, maxDocumentBytes),
      raw: source,
      ...(code !== undefined ? { code } : {}),
    };
  }

  if (isRecord(source) && typeof source.name === "string") {
    const raw =
      typeof source.message === "string" && source.message.length > 0
        ? source.message
        : source.name;
    const code = source.name === "PasswordException" ? "PasswordException" : source.name;
    return {
      display: mapViewerErrorCode(code, maxDocumentBytes),
      raw,
      code,
    };
  }

  return {
    display: mapViewerErrorCode(undefined, maxDocumentBytes),
    raw: String(source),
  };
}
