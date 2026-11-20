/**
 * MCP Apps 桌面端宿主协议纯逻辑（ADR-0101 第 5、6 节；SEP-1865 2026-01-26）。
 * - 主题令牌 → MCP Apps 标准化 CSS 变量映射；
 * - postMessage JSON-RPC 2.0 双向分发与校验；
 * - 文件扩展名到已启用插件 surface 的匹配。
 */
import {
  NOCTURNE_VERSION,
  type SessionAppSurface,
  type ToolCompletedPayload,
} from "@nocturne/core/protocol";

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_TEARDOWN_TIMEOUT_MS = 1000;

export interface McpAppToolCallResultPayload {
  content: unknown[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

export type McpAppToolDelivery =
  | {
      kind: "result";
      seq: number;
      arguments: Record<string, unknown>;
      result: McpAppToolCallResultPayload;
    }
  | {
      kind: "cancelled";
      seq: number;
      arguments?: Record<string, unknown> | undefined;
      reason: string;
    };

/**
 * 规范标准化 CSS 变量名（McpUiStyleVariableKey）← Nocturne 主题令牌映射（ADR-0101 第 6 节）。
 * 以 `var(--token)` 形式指向 tokens.css，运行时用 getComputedStyle 读取当前亮/暗/自定义主题计算值；
 * 非 `--` 开头的值为常量字面值。
 */
export const MCP_APP_STYLE_SOURCES: readonly (readonly [target: string, source: string])[] = [
  // Background colors
  ["--color-background-primary", "--a-bg"],
  ["--color-background-secondary", "--a-panel"],
  ["--color-background-tertiary", "--a-raised"],
  ["--color-background-inverse", "--a-btn"],
  ["--color-background-ghost", "transparent"],
  ["--color-background-info", "--a-accent-subtle"],
  ["--color-background-danger", "--a-error-bg"],
  ["--color-background-success", "--a-success-bg"],
  ["--color-background-warning", "--a-warning-bg"],
  ["--color-background-disabled", "--a-raised"],
  // Text colors
  ["--color-text-primary", "--a-text"],
  ["--color-text-secondary", "--a-secondary"],
  ["--color-text-tertiary", "--a-muted"],
  ["--color-text-inverse", "--a-on-btn"],
  ["--color-text-info", "--a-accent"],
  ["--color-text-danger", "--a-error"],
  ["--color-text-success", "--a-success"],
  ["--color-text-warning", "--a-warning"],
  ["--color-text-disabled", "--a-faint"],
  ["--color-text-ghost", "--a-muted"],
  // Border colors
  ["--color-border-primary", "--a-border"],
  ["--color-border-secondary", "--a-border-strong"],
  ["--color-border-tertiary", "--a-border"],
  ["--color-border-inverse", "--a-on-btn"],
  ["--color-border-ghost", "transparent"],
  ["--color-border-info", "--a-accent-border"],
  ["--color-border-danger", "--a-error-border"],
  ["--color-border-success", "--a-success"],
  ["--color-border-warning", "--a-warning"],
  ["--color-border-disabled", "--a-border"],
  // Ring colors
  ["--color-ring-primary", "--a-focus-ring"],
  ["--color-ring-secondary", "--a-border-strong"],
  ["--color-ring-inverse", "--a-on-btn"],
  ["--color-ring-info", "--a-accent"],
  ["--color-ring-danger", "--a-error"],
  ["--color-ring-success", "--a-success"],
  ["--color-ring-warning", "--a-warning"],
  // Typography
  ["--font-sans", "--sans"],
  ["--font-mono", "--mono"],
  ["--font-weight-normal", "--fw-regular"],
  ["--font-weight-medium", "--fw-medium"],
  ["--font-weight-semibold", "--fw-semibold"],
  ["--font-weight-bold", "700"],
  ["--font-text-xs-size", "--fs-1"],
  ["--font-text-sm-size", "--fs-2"],
  ["--font-text-md-size", "--fs-3"],
  ["--font-text-lg-size", "--fs-4"],
  ["--font-heading-xs-size", "--fs-2"],
  ["--font-heading-sm-size", "--fs-3"],
  ["--font-heading-md-size", "--fs-4"],
  ["--font-heading-lg-size", "--fs-5"],
  ["--font-text-xs-line-height", "--lh-base"],
  ["--font-text-sm-line-height", "--lh-base"],
  ["--font-text-md-line-height", "--lh-base"],
  ["--font-text-lg-line-height", "--lh-base"],
  ["--font-heading-xs-line-height", "--lh-tight"],
  ["--font-heading-sm-line-height", "--lh-tight"],
  ["--font-heading-md-line-height", "--lh-tight"],
  ["--font-heading-lg-line-height", "--lh-tight"],
  // Border radius / width / shadows
  ["--border-radius-xs", "--radius-1"],
  ["--border-radius-sm", "--radius-1"],
  ["--border-radius-md", "--radius-2"],
  ["--border-radius-lg", "--radius-3"],
  ["--border-radius-xl", "--radius-composer"],
  ["--border-radius-full", "9999px"],
  ["--border-width-regular", "1px"],
  ["--shadow-hairline", "--shadow-focus"],
  ["--shadow-sm", "--shadow-popover"],
  ["--shadow-md", "--shadow-popover"],
  ["--shadow-lg", "--shadow-dialog"],
] as const;

export interface McpAppHostContext {
  theme: "light" | "dark";
  styles: {
    variables: Record<string, string>;
  };
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions?: { width: number; height: number } | undefined;
  locale: string;
  timeZone: string;
  platform: "desktop";
  deviceCapabilities: { touch: boolean; hover: boolean };
}

export function resolveAppSandboxFrameSrc(): string {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (window.location.origin === "http://tauri.localhost" || /Windows|Android/i.test(ua)) {
      return "http://nct-sandbox.localhost/app.html";
    }
    return "nct-sandbox://localhost/app.html";
  }
  return "/app.html";
}

export function readMcpAppTheme(): {
  theme: "light" | "dark";
  variables: Record<string, string>;
} {
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const variables: Record<string, string> = {};
  for (const [target, source] of MCP_APP_STYLE_SOURCES) {
    if (source.startsWith("--")) {
      const val = computed.getPropertyValue(source).trim();
      if (val !== "") variables[target] = val;
    } else {
      variables[target] = source;
    }
  }
  const explicit = root.dataset.theme;
  let theme: "light" | "dark";
  if (explicit === "light" || explicit === "dark") {
    theme = explicit;
  } else if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    theme = "light";
  } else {
    theme = "dark";
  }
  return { theme, variables };
}

export function readMcpAppHostContext(container?: {
  width: number;
  height: number;
}): McpAppHostContext {
  const { theme, variables } = readMcpAppTheme();
  const locale =
    typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh-CN";
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    timeZone = "UTC";
  }
  return {
    theme,
    styles: { variables },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    ...(container !== undefined && container.width > 0 && container.height > 0
      ? {
          containerDimensions: {
            width: Math.round(container.width),
            height: Math.round(container.height),
          },
        }
      : {}),
    locale,
    timeZone,
    platform: "desktop",
    deviceCapabilities: { touch: false, hover: true },
  };
}

export function buildInitializeResult(hostContext: McpAppHostContext) {
  return {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: "nocturne", version: NOCTURNE_VERSION },
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      sandbox: {},
    },
    hostContext,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeToolArgs(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? { ...raw } : {};
}

export function deliveryFromToolCompleted(
  payload: ToolCompletedPayload,
  input: unknown,
  seq: number,
): McpAppToolDelivery {
  const args = normalizeToolArgs(input);
  if (
    payload.status === "cancelled" ||
    payload.status === "interrupted" ||
    payload.status === "denied"
  ) {
    return {
      kind: "cancelled",
      seq,
      arguments: args,
      reason: payload.error?.message ?? payload.status,
    };
  }
  const structured =
    isPlainObject(payload.output) && isPlainObject(payload.output.structured)
      ? payload.output.structured
      : undefined;
  const content = payload.modelContent !== "" ? [{ type: "text", text: payload.modelContent }] : [];
  return {
    kind: "result",
    seq,
    arguments: args,
    result: {
      content,
      ...(structured !== undefined ? { structuredContent: structured } : {}),
      ...(payload.status === "error" ? { isError: true } : {}),
    },
  };
}

export function extractUiMessageText(params: unknown): string | undefined {
  if (!isPlainObject(params)) return undefined;
  const content = params.content;
  if (isPlainObject(content)) {
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    return undefined;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

export function isAllowedHttpsLink(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function fileExtensionLower(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * 命中某个已启用插件 surface 的 open.fileTypes 时返回匹配项；
 * 命中多个插件时取 pluginId 字典序第一个（ADR-0101 第 5 节）。
 */
export function matchSurfaceForFile(
  surfaces: readonly SessionAppSurface[],
  filePath: string,
): SessionAppSurface | undefined {
  const ext = fileExtensionLower(filePath);
  if (ext === "") return undefined;
  const matches = surfaces.filter((s) => s.open?.fileTypes.includes(ext) === true);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  return matches[0];
}
