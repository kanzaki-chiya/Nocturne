import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  buildStandaloneInlineHtml,
  resolveInlinePageId,
  type FileAttachment,
  type SessionPage,
  type SessionPageVersion,
  type ToolCompletedArtifact,
} from "@nocturne/core/protocol";
import { formatArtifactTypeLabel } from "./ArtifactPane";

import {
  triggerBytesDownload,
  useCustomOverlay,
  useFullscreenDialogTrap,
  useSaveFile,
} from "./ImageViewer";
import { Menu, MenuItem } from "./Menu";
import { PageCommentThreadPopover } from "./PageCommentThreadPopover";
import { PageModelPermission, PageModelStop, usePageBridge, type PageSession } from "./page-bridge";
import { ICON_LG, ICON_MD, ICON_SM, Icon, IconButton } from "./ui";
import "./inline-page.css";

export const INLINE_PAGE_COLLAPSE_HEIGHT = 420;
export const INLINE_PAGE_MIN_HEIGHT = 48;
export const INLINE_PAGE_MAX_HEIGHT = 4096;
export const INLINE_PAGE_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const INLINE_PAGE_CAPTURE_TIMEOUT_MS = 15_000;
const INLINE_PAGE_INITIAL_HEIGHT = 160;
const IMAGE_EXPORT_FAILED = "导出失败";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

interface ThemePayload {
  colorScheme: "light" | "dark";
  fontSize: string;
}

interface LoadedHtml {
  html: string;
  bytes: Uint8Array;
}

export function readInlineTheme(): ThemePayload {
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const explicit = root.dataset.theme;
  let colorScheme: "light" | "dark";
  if (explicit === "light" || explicit === "dark") {
    colorScheme = explicit;
  } else if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    colorScheme = "light";
  } else {
    colorScheme = "dark";
  }
  const fontSize = computed.getPropertyValue("--fs-3").trim() || "14px";
  return { colorScheme, fontSize };
}

export function resolveSandboxFrameSrc(): string {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (window.location.origin === "http://tauri.localhost" || /Windows|Android/i.test(ua)) {
      return "http://nct-sandbox.localhost/sandbox.html";
    }
    return "nct-sandbox://localhost/sandbox.html";
  }
  return "/sandbox.html";
}

function isValidResizeMessage(
  data: unknown,
  expectedId: string,
): data is { type: "nocturne:inline-html:resize"; id?: string; height: number } {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "nocturne:inline-html:resize") return false;
  if (rec.id !== undefined && rec.id !== expectedId) return false;
  return typeof rec.height === "number" && Number.isFinite(rec.height);
}

function isReadyMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).type === "nocturne:inline-html:ready"
  );
}

function isEscapeMessage(data: unknown, expectedId: string): boolean {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "nocturne:inline-html:escape") return false;
  return rec.id === undefined || rec.id === expectedId;
}

interface CapturedMessage {
  type: "nocturne:inline-html:captured";
  id: string;
  requestId: string;
  png?: unknown;
  error?: unknown;
}

interface SandboxCommentPin {
  id: string;
  number: number;
  x: number;
  y: number;
  path?: string;
  text?: string;
  relocate?: boolean;
  active?: boolean;
}

interface CommentPickMessage {
  type: "nocturne:inline-html:comment-pick";
  id: string;
  path: string;
  text: string;
  x: number;
  y: number;
  hasVisibleText: boolean;
  viewportX: number;
  viewportY: number;
}

interface CommentPinClickMessage {
  type: "nocturne:inline-html:comment-pin-click";
  id: string;
  pinId: string;
  viewportX: number;
  viewportY: number;
}

function isCommentPickMessage(data: unknown, expectedId: string): data is CommentPickMessage {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.type === "nocturne:inline-html:comment-pick" &&
    rec.id === expectedId &&
    typeof rec.path === "string" &&
    typeof rec.text === "string" &&
    typeof rec.x === "number" &&
    Number.isFinite(rec.x) &&
    typeof rec.y === "number" &&
    Number.isFinite(rec.y) &&
    typeof rec.hasVisibleText === "boolean" &&
    typeof rec.viewportX === "number" &&
    Number.isFinite(rec.viewportX) &&
    typeof rec.viewportY === "number" &&
    Number.isFinite(rec.viewportY)
  );
}

function isCommentPinClickMessage(
  data: unknown,
  expectedId: string,
): data is CommentPinClickMessage {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  return (
    rec.type === "nocturne:inline-html:comment-pin-click" &&
    rec.id === expectedId &&
    typeof rec.pinId === "string" &&
    typeof rec.viewportX === "number" &&
    Number.isFinite(rec.viewportX) &&
    typeof rec.viewportY === "number" &&
    Number.isFinite(rec.viewportY)
  );
}

function isCapturedMessage(data: unknown, expectedId: string): data is CapturedMessage {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  if (rec.type !== "nocturne:inline-html:captured") return false;
  if (rec.id !== expectedId) return false;
  return typeof rec.requestId === "string" && rec.requestId !== "";
}

function toArrayBufferBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
  ) {
    return new Uint8Array(value as ArrayBuffer);
  }
  return null;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

export function toPngFilename(filename: string): string {
  if (/\.html?$/i.test(filename)) {
    return filename.replace(/\.html?$/i, ".png");
  }
  return `${filename}.png`;
}

function versionCacheKey(file: Pick<FileAttachment, "file" | "sha256">): string {
  return `${file.file}:${file.sha256}`;
}

function findVersionIndex(
  versions: readonly SessionPageVersion[],
  targetVersion: number | undefined,
): number {
  if (versions.length === 0) return 0;
  if (targetVersion !== undefined) {
    const idx = versions.findIndex((v) => v.version === targetVersion);
    if (idx >= 0) return idx;
  }
  return versions.length - 1;
}

function usePageOverlay(session: PageSession | undefined) {
  const { open, closeFrom } = useCustomOverlay();
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(
    () => () => {
      if (openerRef.current) closeFrom(openerRef.current);
    },
    [closeFrom, session],
  );
  return (render: Parameters<typeof open>[0], opener: HTMLElement | null) => {
    openerRef.current = opener;
    open(render, opener);
  };
}

function useSandboxedHtmlFrame(opts: {
  html: string | undefined;
  instanceId: string;
  fullscreen: boolean;
  session?: PageSession | undefined;
  page?: string | undefined;
  commentMode?: boolean | undefined;
  commentPins?: readonly SandboxCommentPin[] | undefined;
  onCommentPick?: ((pick: CommentPickMessage) => void) | undefined;
  onCommentPinClick?: ((click: CommentPinClickMessage) => void) | undefined;
  onResize?: ((height: number) => void) | undefined;
  onEscape?: (() => void) | undefined;
  onCaptured?: ((message: CapturedMessage) => void) | undefined;
}) {
  const {
    html,
    instanceId,
    fullscreen,
    commentMode,
    commentPins,
    onCommentPick,
    onCommentPinClick,
    onResize,
    onEscape,
    onCaptured,
    page,
    session,
  } = opts;
  const bridge = usePageBridge(session, page, instanceId);
  const onPageMessage = useRef(bridge.onMessage);
  onPageMessage.current = bridge.onMessage;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;
  const onCommentPickRef = useRef(onCommentPick);
  onCommentPickRef.current = onCommentPick;
  const onCommentPinClickRef = useRef(onCommentPinClick);
  onCommentPinClickRef.current = onCommentPinClick;
  const commentModeRef = useRef(commentMode);
  commentModeRef.current = commentMode;
  const commentPinsRef = useRef(commentPins);
  commentPinsRef.current = commentPins;
  const htmlRef = useRef(html);
  htmlRef.current = html;

  const postCommentState = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || htmlRef.current === undefined) return;
    if (commentModeRef.current !== undefined) {
      win.postMessage(
        {
          type: "nocturne:inline-html:comment-mode",
          id: instanceId,
          enabled: commentModeRef.current,
        },
        "*",
      );
    }
    if (commentPinsRef.current !== undefined) {
      win.postMessage(
        {
          type: "nocturne:inline-html:comment-pins",
          id: instanceId,
          pins: commentPinsRef.current,
        },
        "*",
      );
    }
  }, [instanceId]);

  const postRender = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    const currentHtml = htmlRef.current;
    if (!win || currentHtml === undefined) return;
    const { colorScheme, fontSize } = readInlineTheme();
    win.postMessage(
      {
        type: "nocturne:inline-html:render",
        id: instanceId,
        html: currentHtml,
        colorScheme,
        fontSize,
        fullscreen,
        pageBridge: bridge.enabled,
      },
      "*",
    );
    postCommentState();
  }, [bridge.enabled, fullscreen, instanceId, postCommentState]);

  const postTheme = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || htmlRef.current === undefined) return;
    const { colorScheme, fontSize } = readInlineTheme();
    win.postMessage(
      {
        type: "nocturne:inline-html:theme",
        colorScheme,
        fontSize,
      },
      "*",
    );
  }, []);

  const commentPinState = commentPins === undefined ? undefined : JSON.stringify(commentPins);
  useEffect(() => {
    if (html === undefined) return;
    postCommentState();
  }, [html, commentMode, commentPinState, postCommentState]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const targetWindow = iframeRef.current?.contentWindow ?? null;
      if (targetWindow === null) return;
      if (event.source !== targetWindow) return;
      onPageMessage.current(event, targetWindow);
      if (isReadyMessage(event.data)) {
        postRender();
        return;
      }
      if (isEscapeMessage(event.data, instanceId)) {
        onEscapeRef.current?.();
        return;
      }
      if (isCapturedMessage(event.data, instanceId)) {
        onCapturedRef.current?.(event.data);
        return;
      }
      if (isCommentPickMessage(event.data, instanceId)) {
        onCommentPickRef.current?.(event.data);
        return;
      }
      if (isCommentPinClickMessage(event.data, instanceId)) {
        onCommentPinClickRef.current?.(event.data);
        return;
      }
      if (isValidResizeMessage(event.data, instanceId)) {
        const clamped = Math.max(
          INLINE_PAGE_MIN_HEIGHT,
          Math.min(INLINE_PAGE_MAX_HEIGHT, Math.ceil(event.data.height)),
        );
        onResizeRef.current?.(clamped);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [instanceId, postRender]);

  // 切换深浅色或修改外观字体/字号时，直接推送新主题变量，不重新加载 iframe
  useEffect(() => {
    if (html === undefined) return;
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            postTheme();
          })
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });
    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    const onMediaChange = () => {
      postTheme();
    };
    mql?.addEventListener("change", onMediaChange);
    return () => {
      observer?.disconnect();
      mql?.removeEventListener("change", onMediaChange);
    };
  }, [html, postTheme]);

  return { iframeRef, handleLoad: postRender, bridge };
}

export function PageVersionNav({
  index,
  total,
  onChange,
}: {
  index: number;
  total: number;
  onChange: (nextIndex: number) => void;
}) {
  const safeTotal = Math.max(1, total);
  const safeIndex = Math.max(0, Math.min(safeTotal - 1, index));
  return (
    <div className="page-ver-nav">
      <IconButton
        className="page-ver-btn"
        aria-label="上一版本"
        title="上一版本"
        disabled={safeIndex <= 0}
        onClick={() => {
          if (safeIndex > 0) onChange(safeIndex - 1);
        }}
      >
        <Icon name="right_small" size={ICON_SM} className="page-ver-prev-icon" />
      </IconButton>
      <span className="page-ver-count">
        {safeIndex + 1} / {safeTotal}
      </span>
      <IconButton
        className="page-ver-btn"
        aria-label="下一版本"
        title="下一版本"
        disabled={safeIndex >= safeTotal - 1}
        onClick={() => {
          if (safeIndex < safeTotal - 1) onChange(safeIndex + 1);
        }}
      >
        <Icon name="right_small" size={ICON_SM} />
      </IconButton>
    </div>
  );
}

function usePageImageDownload(filename: string, setDownloadError: (error?: string) => void) {
  const saveFile = useSaveFile();
  const [capturing, setCapturing] = useState(false);
  const pendingCaptureRef = useRef<{ requestId: string; timer: number } | null>(null);
  const captureSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (pendingCaptureRef.current !== null) {
        window.clearTimeout(pendingCaptureRef.current.timer);
        pendingCaptureRef.current = null;
      }
    };
  }, []);

  const handleCaptured = useCallback(
    (message: CapturedMessage) => {
      const pending = pendingCaptureRef.current;
      if (pending?.requestId !== message.requestId) return;
      window.clearTimeout(pending.timer);
      pendingCaptureRef.current = null;
      setCapturing(false);
      if (typeof message.error === "string") {
        setDownloadError(IMAGE_EXPORT_FAILED);
        return;
      }
      const pngBytes = toArrayBufferBytes(message.png);
      if (
        pngBytes === null ||
        pngBytes.byteLength > INLINE_PAGE_CAPTURE_MAX_BYTES ||
        !hasPngSignature(pngBytes)
      ) {
        setDownloadError(IMAGE_EXPORT_FAILED);
        return;
      }
      triggerBytesDownload({
        filename: toPngFilename(filename),
        mimeType: "image/png",
        bytes: pngBytes,
        saveFile,
        onError: setDownloadError,
      });
    },
    [filename, saveFile, setDownloadError],
  );

  const capture = (win: Window | null | undefined, instanceId: string) => {
    if (pendingCaptureRef.current !== null) return;
    if (!win) {
      setDownloadError(IMAGE_EXPORT_FAILED);
      return;
    }
    setDownloadError(undefined);
    setCapturing(true);
    captureSeqRef.current += 1;
    const requestId = `${instanceId}:capture:${captureSeqRef.current}`;
    const timer = window.setTimeout(() => {
      if (pendingCaptureRef.current?.requestId !== requestId) return;
      pendingCaptureRef.current = null;
      setCapturing(false);
      setDownloadError(IMAGE_EXPORT_FAILED);
    }, INLINE_PAGE_CAPTURE_TIMEOUT_MS);
    pendingCaptureRef.current = { requestId, timer };
    try {
      win.postMessage(
        {
          type: "nocturne:inline-html:capture",
          id: instanceId,
          requestId,
        },
        "*",
      );
    } catch {
      window.clearTimeout(timer);
      pendingCaptureRef.current = null;
      setCapturing(false);
      setDownloadError(IMAGE_EXPORT_FAILED);
    }
  };

  return { capturing, capture, handleCaptured };
}

export interface InlinePageFullscreenProps {
  title: string;
  filename: string;
  html?: string | undefined;
  bytes?: Uint8Array | undefined;
  versions?: readonly SessionPageVersion[] | undefined;
  initialVersion?: number | undefined;
  session?: PageSession | undefined;
  pageId?: string | undefined;
  remote?: boolean | undefined;
  initialLoaded?: { file: string; sha256: string; html: string; bytes: Uint8Array } | undefined;
  opener: HTMLElement | null;
  onClose: () => void;
}

export function InlinePageFullscreen({
  title,
  filename,
  html,
  bytes,
  versions,
  initialVersion,
  session,
  pageId,
  remote,
  initialLoaded,
  opener,
  onClose,
}: InlinePageFullscreenProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const downloadBtnRef = useRef<HTMLButtonElement | null>(null);
  const saveFile = useSaveFile();
  const [downloadError, setDownloadError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const instanceId = useId();
  const sandboxSrc = resolveSandboxFrameSrc();

  const versionList = versions && versions.length > 0 ? versions : undefined;
  const [activeIdx, setActiveIdx] = useState(() =>
    versionList ? findVersionIndex(versionList, initialVersion) : 0,
  );
  const safeIdx = versionList ? Math.max(0, Math.min(versionList.length - 1, activeIdx)) : 0;
  const activeVer = versionList?.[safeIdx];
  const activeTitle = activeVer?.title ?? title;
  const activeFilename = activeVer?.file.label ?? filename;

  const cacheRef = useRef<Map<string, LoadedHtml>>(new Map());
  if (initialLoaded !== undefined) {
    const key = versionCacheKey(initialLoaded);
    if (!cacheRef.current.has(key)) {
      cacheRef.current.set(key, { html: initialLoaded.html, bytes: initialLoaded.bytes });
    }
  }
  const [loadedMapVersion, setLoadedMapVersion] = useState(0);

  const activeCacheKey = activeVer ? versionCacheKey(activeVer.file) : undefined;
  const cachedActive = activeCacheKey ? cacheRef.current.get(activeCacheKey) : undefined;
  const activeLoaded: LoadedHtml | undefined =
    activeVer !== undefined
      ? cachedActive
      : html !== undefined && bytes !== undefined
        ? { html, bytes }
        : undefined;

  useEffect(() => {
    if (activeVer === undefined || activeCacheKey === undefined) return;
    if (cacheRef.current.has(activeCacheKey)) return;
    if (!session) return;
    let cancelled = false;
    session.readAttachment(activeVer.file.file).then(
      (res) => {
        if (cancelled) return;
        const decoded = new TextDecoder("utf-8").decode(res.data);
        cacheRef.current.set(activeCacheKey, { html: decoded, bytes: res.data });
        setLoadedMapVersion((n) => n + 1);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [activeVer, activeCacheKey, session, loadedMapVersion]);

  const fullInstanceId = `full:${instanceId}:${activeVer?.file.file ?? "single"}`;
  const { capturing, capture, handleCaptured } = usePageImageDownload(
    activeFilename,
    setDownloadError,
  );

  const handleEscape = useCallback(() => {
    if (menuOpenRef.current) {
      setMenuOpen(false);
      downloadBtnRef.current?.focus();
      return;
    }
    onClose();
  }, [onClose]);

  useFullscreenDialogTrap({ rootRef, opener, onClose: handleEscape });

  const { iframeRef, handleLoad, bridge } = useSandboxedHtmlFrame({
    html: activeLoaded?.html,
    instanceId: fullInstanceId,
    fullscreen: true,
    session,
    page: pageId ?? (activeVer && resolveInlinePageId(activeVer.file)),
    onEscape: handleEscape,
    onCaptured: handleCaptured,
  });

  const handleDownloadHtml = () => {
    setMenuOpen(false);
    if (!activeLoaded) return;
    setDownloadError(undefined);
    triggerBytesDownload({
      filename: activeFilename,
      mimeType: "text/html;charset=utf-8",
      bytes: new TextEncoder().encode(buildStandaloneInlineHtml(activeLoaded.html)),
      saveFile,
      onError: setDownloadError,
    });
  };

  const hasVersionNav = versionList !== undefined && versionList.length > 1;
  const hasToolbar = hasVersionNav || bridge.permission !== undefined;
  const actionButtons = (
    <>
      <PageModelStop bridge={bridge} className="inline-page-btn" />
      <IconButton
        ref={downloadBtnRef}
        className="inline-page-btn"
        aria-label="下载"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={downloadError ?? "下载"}
        disabled={capturing || activeLoaded === undefined}
        onClick={() => {
          setMenuOpen((open) => !open);
        }}
      >
        <Icon name="download_2" size={ICON_LG} />
      </IconButton>
      <IconButton className="inline-page-btn" aria-label="关闭" title="关闭" onClick={onClose}>
        <Icon name="close" size={ICON_LG} />
      </IconButton>
    </>
  );

  return (
    <div
      ref={rootRef}
      className="inline-page-fullscreen"
      role="dialog"
      aria-modal="true"
      aria-label={activeTitle}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === rootRef.current) {
          onClose();
        }
      }}
    >
      <div
        ref={sheetRef}
        className={`inline-page-sheet${hasToolbar ? " has-toolbar" : ""}${bridge.permission ? " has-permission" : ""}`}
      >
        {hasToolbar && (
          <div className="inline-page-full-bar">
            {hasVersionNav ? (
              <PageVersionNav
                index={safeIdx}
                total={versionList.length}
                onChange={(nextIdx) => {
                  setActiveIdx(nextIdx);
                  setDownloadError(undefined);
                }}
              />
            ) : null}
            <div className="inline-page-full-bar-actions">{actionButtons}</div>
          </div>
        )}
        <PageModelPermission bridge={bridge} remote={remote} />
        <div className="inline-page-full-body">
          {activeLoaded !== undefined && (
            <iframe
              key={activeVer?.file.file ?? "single"}
              ref={iframeRef}
              className="inline-page-frame"
              sandbox="allow-scripts"
              src={sandboxSrc}
              title={activeTitle}
              onLoad={handleLoad}
            />
          )}
        </div>
        {!hasToolbar && <div className="inline-page-full-tools">{actionButtons}</div>}
      </div>
      {menuOpen && (
        <Menu
          anchor={downloadBtnRef.current}
          align="right"
          placement="below"
          className="more-menu inline-page-dl-menu"
          label="下载"
          onClose={() => {
            setMenuOpen(false);
          }}
        >
          <MenuItem label="下载为 HTML" onSelect={handleDownloadHtml} />
          <MenuItem
            label="下载为图片"
            onSelect={() => {
              setMenuOpen(false);
              capture(iframeRef.current?.contentWindow, fullInstanceId);
            }}
          />
        </Menu>
      )}
    </div>
  );
}

export interface PageEntryRowProps {
  file: FileAttachment;
  version: number;
  versions?: readonly SessionPageVersion[] | undefined;
  active?: boolean | undefined;
  session: PageSession | undefined;
  remote?: boolean | undefined;
  /** 桌面端传入：在右侧面板打开对应页面与版本；手机端不传，点击直接进全屏遮罩 */
  onOpenInPanel?: (() => void) | undefined;
  searchHit?: boolean | undefined;
  sessionSeq?: number | undefined;
  completedSeq?: number | undefined;
}

export function PageEntryRow({
  file,
  version,
  versions,
  active = false,
  session,
  remote,
  onOpenInPanel,
  searchHit = false,
  sessionSeq,
  completedSeq,
}: PageEntryRowProps) {
  const title = file.inline?.title ?? file.label;
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const openOverlay = usePageOverlay(session);

  const handleClick = () => {
    if (onOpenInPanel !== undefined) {
      onOpenInPanel();
      return;
    }
    const opener = btnRef.current;
    const effectiveVersions: readonly SessionPageVersion[] =
      versions && versions.length > 0
        ? versions
        : [{ version, file, title, seq: completedSeq ?? sessionSeq ?? 0 }];
    openOverlay(
      (onClose) => (
        <InlinePageFullscreen
          title={title}
          filename={file.label}
          versions={effectiveVersions}
          initialVersion={version}
          session={session}
          pageId={resolveInlinePageId(file)}
          remote={remote}
          opener={opener}
          onClose={onClose}
        />
      ),
      opener,
    );
  };

  return (
    <button
      ref={btnRef}
      type="button"
      className={`page-entry-row${active ? " is-active" : ""}${searchHit ? " search-hit" : ""}`}
      aria-current={active ? "true" : undefined}
      data-session-seq={sessionSeq}
      data-completed-seq={completedSeq}
      onClick={handleClick}
    >
      <Icon name="file" size={ICON_SM} className="page-entry-icon" />
      <span className="page-entry-title">{title}</span>
      <span className="page-entry-ver">v{version}</span>
      <Icon name="right_small" size={ICON_SM} className="page-entry-arrow" />
    </button>
  );
}

export interface ArtifactEntryRowProps {
  artifact: ToolCompletedArtifact;
  active?: boolean | undefined;
  remote?: boolean | undefined;
  onOpenInPanel?: (() => void) | undefined;
  searchHit?: boolean | undefined;
  sessionSeq?: number | undefined;
  completedSeq?: number | undefined;
}

/** 聊天流中的 Open Artifact 作品卡（ADR-0125）：桌面端点击打开右侧真实编辑器；移动端只显示作品信息与桌面打开提示 */
export function ArtifactEntryRow({
  artifact,
  active = false,
  remote = false,
  onOpenInPanel,
  searchHit = false,
  sessionSeq,
  completedSeq,
}: ArtifactEntryRowProps) {
  const typeLabel = formatArtifactTypeLabel(artifact.type);
  const title = artifact.title || artifact.id;
  if (remote || onOpenInPanel === undefined) {
    return (
      <div
        className={`page-entry-row artifact-entry-row is-remote${searchHit ? " search-hit" : ""}`}
        data-session-seq={sessionSeq}
        data-completed-seq={completedSeq}
        data-artifact-url={artifact.url}
      >
        <Icon name="layout_right" size={ICON_SM} className="page-entry-icon" />
        <span className="page-entry-title">{title}</span>
        <span className="page-entry-ver">{typeLabel}</span>
        <span className="artifact-entry-hint">请在桌面端打开</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`page-entry-row artifact-entry-row${active ? " is-active" : ""}${searchHit ? " search-hit" : ""}`}
      aria-current={active ? "true" : undefined}
      data-session-seq={sessionSeq}
      data-completed-seq={completedSeq}
      data-artifact-url={artifact.url}
      onClick={onOpenInPanel}
    >
      <Icon name="layout_right" size={ICON_SM} className="page-entry-icon" />
      <span className="page-entry-title">{title}</span>
      <span className="page-entry-ver">{typeLabel}</span>
      <Icon name="right_small" size={ICON_SM} className="page-entry-arrow" />
    </button>
  );
}

export interface PagePaneCommentsController {
  /** 历史讨论串只读查看时的本地解决回调（不向模型投递新评论） */
  onResolve?: ((id: string) => Promise<void>) | undefined;
}

export interface PagePaneProps {
  page: SessionPage | undefined;
  selectedVersion: number | undefined;
  session: PageSession | undefined;
  onSelectVersion: (version: number | undefined) => void;
  /** 历史面板页面讨论串的只读操作（如本地标记解决）；不提供新建或回复评论 */
  comments?: PagePaneCommentsController | undefined;
}

export function PagePane({
  page,
  selectedVersion,
  session,
  onSelectVersion,
  comments,
}: PagePaneProps) {
  const saveFile = useSaveFile();
  const instanceId = useId();
  const sandboxSrc = resolveSandboxFrameSrc();
  const [downloadError, setDownloadError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [openThread, setOpenThread] = useState<CommentPinClickMessage | null>(null);
  const downloadBtnRef = useRef<HTMLButtonElement>(null);

  const cacheRef = useRef<Map<string, LoadedHtml>>(new Map());
  const sessionRef = useRef(session);
  if (sessionRef.current !== session) {
    sessionRef.current = session;
    cacheRef.current = new Map();
  }
  const [loadedTick, setLoadedTick] = useState(0);

  const versions = page?.versions ?? [];
  const activeIdx = findVersionIndex(versions, selectedVersion);
  const activeVer = versions[activeIdx];
  const latestVer = versions.at(-1);
  const activeVersion = activeVer?.version;
  const cacheKey = activeVer ? versionCacheKey(activeVer.file) : undefined;
  const loaded = cacheKey ? cacheRef.current.get(cacheKey) : undefined;
  const durableThreads = page?.comments ?? [];
  const visibleThreads = durableThreads
    .flatMap((thread) =>
      thread.id === undefined || thread.resolved
        ? []
        : [{ key: thread.id, number: Number(thread.id.slice(1)), thread }],
    )
    .filter(({ thread }) => activeVersion !== undefined && thread.version <= activeVersion);
  const currentThread = visibleThreads.find(({ key }) => key === openThread?.pinId)?.thread;

  // 切换页面或版本时收起当前讨论串弹窗
  useEffect(() => {
    setOpenThread(null);
  }, [page?.page, activeVersion]);

  useEffect(() => {
    if (activeVer === undefined || cacheKey === undefined) return;
    if (cacheRef.current.has(cacheKey)) return;
    if (!session) return;
    let cancelled = false;
    session.readAttachment(activeVer.file.file).then(
      (res) => {
        if (cancelled) return;
        const html = new TextDecoder("utf-8").decode(res.data);
        cacheRef.current.set(cacheKey, { html, bytes: res.data });
        setLoadedTick((n) => n + 1);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [activeVer, cacheKey, session, loadedTick]);

  const paneInstanceId = `pane:${instanceId}:${activeVer?.file.file ?? "empty"}`;
  const { capturing, capture, handleCaptured } = usePageImageDownload(
    activeVer?.file.label ?? "",
    setDownloadError,
  );

  const handleCommentPinClick = useCallback((click: CommentPinClickMessage) => {
    setOpenThread((open) => (open?.pinId === click.pinId ? null : click));
  }, []);

  const handleFrameEscape = useCallback(() => {
    if (openThread !== null) {
      setOpenThread(null);
    }
  }, [openThread]);

  const commentPins: SandboxCommentPin[] = visibleThreads.map(({ key, number, thread }) => ({
    id: key,
    number,
    x: thread.x,
    y: thread.y,
    path: thread.path,
    text: thread.text,
    relocate: thread.version !== activeVersion,
    active: openThread?.pinId === key,
  }));

  const { iframeRef, handleLoad, bridge } = useSandboxedHtmlFrame({
    html: loaded?.html,
    instanceId: paneInstanceId,
    fullscreen: true,
    session,
    page: page?.page,
    commentMode: false,
    commentPins,
    onCommentPinClick: handleCommentPinClick,
    onEscape: handleFrameEscape,
    onCaptured: handleCaptured,
  });

  if (page === undefined || activeVer === undefined) {
    return <div className="page-pane" />;
  }

  const handleSelectIndex = (nextIdx: number) => {
    const next = versions[nextIdx];
    if (next === undefined) return;
    setDownloadError(undefined);
    if (next.version === latestVer?.version) {
      onSelectVersion(undefined);
    } else {
      onSelectVersion(next.version);
    }
  };

  const handleDownload = () => {
    setMenuOpen(false);
    if (!loaded) return;
    setDownloadError(undefined);
    triggerBytesDownload({
      filename: activeVer.file.label,
      mimeType: "text/html;charset=utf-8",
      bytes: new TextEncoder().encode(buildStandaloneInlineHtml(loaded.html)),
      saveFile,
      onError: setDownloadError,
    });
  };

  return (
    <div className="page-pane">
      <div className="page-pane-bar">
        <PageVersionNav index={activeIdx} total={versions.length} onChange={handleSelectIndex} />
        <div className="page-pane-actions">
          <PageModelStop bridge={bridge} className="page-pane-action-btn" />
          <IconButton
            ref={downloadBtnRef}
            className="page-pane-action-btn"
            aria-label="下载"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={downloadError ?? "下载"}
            disabled={capturing || loaded === undefined}
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
          >
            <Icon name="download_2" size={ICON_MD} />
          </IconButton>
          {menuOpen && (
            <Menu
              anchor={downloadBtnRef.current}
              align="right"
              placement="below"
              className="more-menu inline-page-dl-menu"
              label="下载"
              onClose={() => {
                setMenuOpen(false);
              }}
            >
              <MenuItem label="下载为 HTML" onSelect={handleDownload} />
              <MenuItem
                label="下载为图片"
                onSelect={() => {
                  setMenuOpen(false);
                  capture(iframeRef.current?.contentWindow, paneInstanceId);
                }}
              />
            </Menu>
          )}
        </div>
      </div>
      <PageModelPermission bridge={bridge} />
      <div className="page-pane-body">
        {loaded !== undefined && (
          <iframe
            key={activeVer.file.file}
            ref={iframeRef}
            className="page-pane-frame"
            sandbox="allow-scripts"
            src={sandboxSrc}
            title={activeVer.title}
            onLoad={handleLoad}
          />
        )}
        {openThread && currentThread && (
          <PageCommentThreadPopover
            key={openThread.pinId}
            thread={currentThread}
            pending={false}
            x={openThread.viewportX}
            y={openThread.viewportY}
            onClose={() => {
              setOpenThread(null);
            }}
            onResolve={
              currentThread.id === undefined || comments?.onResolve === undefined
                ? undefined
                : () => {
                    const resolve = comments.onResolve;
                    return resolve ? resolve(openThread.pinId) : Promise.resolve();
                  }
            }
          />
        )}
      </div>
    </div>
  );
}

export interface InlinePageProps {
  file: FileAttachment;
  session: PageSession | undefined;
  remote?: boolean | undefined;
  renderFallback: (errorMessage?: string) => ReactNode;
  onCollapseAboveViewport?: ((container: HTMLElement) => void) | undefined;
  /** 本页面所有版本，供全屏遮罩切换版本 */
  versions?: readonly SessionPageVersion[] | undefined;
  /** 本次渲染对应的版本号 */
  version?: number | undefined;
  searchHit?: boolean | undefined;
  sessionSeq?: number | undefined;
  completedSeq?: number | undefined;
}

export function InlinePage({
  file,
  session,
  remote,
  renderFallback,
  onCollapseAboveViewport,
  versions,
  version,
  searchHit = false,
  sessionSeq,
  completedSeq,
}: InlinePageProps) {
  const title = file.inline?.title ?? file.label;
  const instanceId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fullBtnRef = useRef<HTMLButtonElement | null>(null);
  const [loaded, setLoaded] = useState<LoadedHtml | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const prevDisplayedHeightRef = useRef<number>(INLINE_PAGE_INITIAL_HEIGHT);

  const openOverlay = usePageOverlay(session);
  const sandboxSrc = resolveSandboxFrameSrc();

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailed(null);
    setContentHeight(null);
    setExpanded(false);
    if (!session) {
      setFailed("");
      return;
    }
    session.readAttachment(file.file).then(
      (res) => {
        if (cancelled) return;
        const html = new TextDecoder("utf-8").decode(res.data);
        setLoaded({ html, bytes: res.data });
      },
      (err: unknown) => {
        if (cancelled) return;
        setFailed(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file.file, file.sha256, session]);

  const { iframeRef, handleLoad, bridge } = useSandboxedHtmlFrame({
    html: loaded?.html,
    instanceId: `inline:${instanceId}:${file.file}`,
    fullscreen: false,
    onResize: setContentHeight,
    session,
    page: resolveInlinePageId(file),
    onEscape: () => {
      if (remote) void session?.stopPageModel?.(resolveInlinePageId(file)).catch(() => undefined);
    },
  });
  const phoneFullscreen = remote === true && bridge.busy;

  const collapsible = contentHeight !== null && contentHeight > INLINE_PAGE_COLLAPSE_HEIGHT;
  const displayedHeight =
    collapsible && !expanded
      ? INLINE_PAGE_COLLAPSE_HEIGHT
      : (contentHeight ?? INLINE_PAGE_INITIAL_HEIGHT);

  // 当页面位于视口上方且高度被动变化时补偿滚动容器，防止阅读位置跳动
  useLayoutEffect(() => {
    const prev = prevDisplayedHeightRef.current;
    prevDisplayedHeightRef.current = displayedHeight;
    const delta = displayedHeight - prev;
    if (delta === 0) return;
    const box = containerRef.current;
    const scroller = box?.closest<HTMLElement>(".conversation-scroll");
    if (!box || !scroller) return;
    const isAtBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 4;
    if (isAtBottom) return;
    const boxRect = box.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (boxRect.bottom <= scrollerRect.top) {
      scroller.scrollTop += delta;
    }
  }, [displayedHeight]);

  if (failed !== null) {
    return <>{renderFallback(failed)}</>;
  }

  const openFullscreen = () => {
    if (!loaded) return;
    const opener = fullBtnRef.current;
    openOverlay(
      (onClose) => (
        <InlinePageFullscreen
          title={title}
          filename={file.label}
          html={loaded.html}
          bytes={loaded.bytes}
          pageId={resolveInlinePageId(file)}
          remote={remote}
          versions={versions}
          initialVersion={version}
          session={session}
          initialLoaded={{
            file: file.file,
            sha256: file.sha256,
            html: loaded.html,
            bytes: loaded.bytes,
          }}
          opener={opener}
          onClose={onClose}
        />
      ),
      opener,
    );
  };

  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      if (containerRef.current) {
        onCollapseAboveViewport?.(containerRef.current);
      }
    } else {
      setExpanded(true);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`inline-page${collapsible && !expanded ? " is-collapsed" : ""}${collapsible && expanded ? " is-expanded" : ""}${searchHit ? " search-hit" : ""}`}
      data-session-seq={sessionSeq}
      data-completed-seq={completedSeq}
    >
      {!remote && <PageModelPermission bridge={bridge} />}
      <div
        className={phoneFullscreen ? "inline-page-body is-phone-fullscreen" : "inline-page-body"}
        style={phoneFullscreen ? undefined : { height: `${displayedHeight}px` }}
      >
        {phoneFullscreen && (
          <>
            <div className="inline-page-full-bar">
              <div className="inline-page-full-bar-actions">
                <PageModelStop bridge={bridge} className="inline-page-btn" />
                <IconButton aria-label="关闭" title="关闭" onClick={bridge.stop}>
                  <Icon name="close" size={ICON_MD} />
                </IconButton>
              </div>
            </div>
            <PageModelPermission bridge={bridge} remote />
          </>
        )}
        {loaded !== null && (
          <iframe
            ref={iframeRef}
            className="inline-page-frame"
            style={{ height: `${contentHeight ?? INLINE_PAGE_INITIAL_HEIGHT}px` }}
            sandbox="allow-scripts"
            src={sandboxSrc}
            title={title}
            onLoad={handleLoad}
          />
        )}
      </div>
      {collapsible && !expanded && <div className="inline-page-fade" aria-hidden="true" />}
      {loaded !== null && !phoneFullscreen && (
        <div className={`inline-page-tools${bridge.busy ? " is-busy" : ""}`}>
          <PageModelStop bridge={bridge} className="inline-page-tool-btn" />
          <IconButton
            ref={fullBtnRef}
            className="inline-page-tool-btn"
            aria-label="全屏"
            title="全屏"
            onClick={openFullscreen}
          >
            <Icon name="fullscreen" size={ICON_MD} />
          </IconButton>
        </div>
      )}
      {collapsible && (
        <div className="inline-page-more-wrap">
          <IconButton
            className="inline-page-more"
            aria-label={expanded ? "收起" : "展开"}
            title={expanded ? "收起" : "展开"}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            <Icon name="down_small" size={ICON_MD} className="inline-page-chevron" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
