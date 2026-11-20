import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

import { createViewerBinaryDataFactory } from "../src/shared/pdfjs-factory.js";
import {
  formatViewerError,
  isDocumentUnknownError,
  ViewerToolError,
  type ToolResultLike,
} from "../src/shared/viewer-errors.js";

declare const __NOCTURNE_PLUGIN_VERSION__: string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string> };
}

interface ShowInViewerData {
  docId: string;
  path: string;
  fileName: string;
  pageCount: number;
  initialPage: number;
  totalBytes: number;
  chunkSize: number;
}

interface ReadChunkData {
  docId: string;
  offset: number;
  bytesRead: number;
  totalBytes: number;
  eof: boolean;
  data: string;
}

interface ViewerAssetData {
  name: string;
  bytes: number;
  data: string;
}

interface ViewerDiagnosticState {
  workerMode: "pending" | "blob" | "main";
  status: "idle" | "loading" | "ready" | "error";
  fileName: string;
  pageCount: number;
  currentPage: number;
  scale: number;
  renderedPages: number[];
  error: string | null;
}

declare global {
  interface Window {
    __NOCTURNE_VIEWER_STATE__?: ViewerDiagnosticState;
    pdfjsWorker?: { WorkerMessageHandler?: unknown };
  }
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3];
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const INITIAL_FIT_WIDTH_MAX_SCALE = 1.25;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const WORKER_READY_TIMEOUT_MS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function parseShowInViewerPayload(res: ToolResultLike): ShowInViewerData | null {
  const sc = res.structuredContent;
  if (!isRecord(sc)) return null;
  if (
    typeof sc.docId !== "string" ||
    typeof sc.path !== "string" ||
    typeof sc.fileName !== "string" ||
    typeof sc.totalBytes !== "number"
  ) {
    return null;
  }
  return {
    docId: sc.docId,
    path: sc.path,
    fileName: sc.fileName,
    pageCount: typeof sc.pageCount === "number" ? sc.pageCount : 0,
    initialPage: typeof sc.initialPage === "number" && sc.initialPage >= 1 ? sc.initialPage : 1,
    totalBytes: sc.totalBytes,
    chunkSize:
      typeof sc.chunkSize === "number" && sc.chunkSize > 0 ? sc.chunkSize : DEFAULT_CHUNK_BYTES,
  };
}

function getEl<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`Missing element #${id}`);
  return el;
}

const docNameEl = getEl("doc-name", HTMLDivElement);
const btnPrev = getEl("btn-prev", HTMLButtonElement);
const btnNext = getEl("btn-next", HTMLButtonElement);
const pageInput = getEl("page-input", HTMLInputElement);
const pageTotalEl = getEl("page-total", HTMLSpanElement);
const btnZoomOut = getEl("btn-zoom-out", HTMLButtonElement);
const zoomLabelEl = getEl("zoom-label", HTMLSpanElement);
const btnZoomIn = getEl("btn-zoom-in", HTMLButtonElement);
const btnFitWidth = getEl("btn-fit-width", HTMLButtonElement);
const progressEl = getEl("progress", HTMLDivElement);
const stageEl = getEl("stage", HTMLElement);
const errorBoxEl = getEl("error-box", HTMLDivElement);
const pagesEl = getEl("pages", HTMLDivElement);

const diagState: ViewerDiagnosticState = {
  workerMode: "pending",
  status: "idle",
  fileName: "",
  pageCount: 0,
  currentPage: 0,
  scale: 1,
  renderedPages: [],
  error: null,
};
window.__NOCTURNE_VIEWER_STATE__ = diagState;

// ── MCP Apps JSON-RPC 传输 ──
let nextRpcId = 1;
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

function sendRpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    window.parent.postMessage(
      { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) },
      "*",
    );
  });
}

function sendRpcNotification(method: string, params?: Record<string, unknown>): void {
  window.parent.postMessage(
    { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) },
    "*",
  );
}

async function callServerTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResultLike> {
  const raw = await sendRpcRequest("tools/call", { name, arguments: args });
  if (!isRecord(raw)) {
    throw new Error(`Invalid tools/call response for ${name}`);
  }
  return raw;
}

// ── 主题同步 ──
function applyHostContext(ctx: HostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme === "light" || ctx.theme === "dark") {
    document.documentElement.dataset.theme = ctx.theme;
    document.documentElement.style.colorScheme = ctx.theme;
  }
  const vars = ctx.styles?.variables;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith("--") && typeof v === "string") {
        document.documentElement.style.setProperty(k, v);
      }
    }
  }
}

// ── Worker 初始化（优先 blob Worker，失败时回退主线程模式）──
let sharedWorkerPromise: Promise<pdfjsLib.PDFWorker | undefined> | null = null;
let sharedPdfWorker: pdfjsLib.PDFWorker | undefined;
let workerBlobUrl: string | undefined;

function readEmbeddedWorkerBytes(): Uint8Array {
  const scriptEl = document.getElementById("nocturne-pdf-worker");
  const raw = scriptEl?.textContent.trim() ?? "";
  if (!raw || raw === "__PDFJS_WORKER_BASE64__") {
    throw new Error("Embedded pdf.js worker source is missing.");
  }
  return decodeBase64(raw);
}

async function initMainThreadWorker(workerBytes: Uint8Array): Promise<void> {
  if (window.pdfjsWorker?.WorkerMessageHandler) {
    diagState.workerMode = "main";
    return;
  }
  const sourceText = new TextDecoder("utf-8").decode(workerBytes);
  const inlineScript = document.createElement("script");
  inlineScript.textContent = sourceText;
  document.head.appendChild(inlineScript);

  await new Promise<void>((resolve, reject) => {
    const start = performance.now();
    const poll = (): void => {
      if (window.pdfjsWorker?.WorkerMessageHandler) {
        diagState.workerMode = "main";
        resolve();
        return;
      }
      if (performance.now() - start > WORKER_READY_TIMEOUT_MS) {
        reject(new Error("Main-thread pdf.js worker initialization timed out."));
        return;
      }
      window.setTimeout(poll, 16);
    };
    poll();
  });
}

function tryCreateBlobWorker(workerBytes: Uint8Array): Promise<Worker> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === "undefined") {
      reject(new Error("Web Worker is unavailable."));
      return;
    }
    const copy = new Uint8Array(workerBytes.byteLength);
    copy.set(workerBytes);
    const blob = new Blob([copy], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const finish = (ok: boolean, detail?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (ok) {
        workerBlobUrl = url;
        resolve(worker);
      } else {
        worker.terminate();
        URL.revokeObjectURL(url);
        reject(detail ?? new Error("Blob worker failed to start."));
      }
    };

    const onMessage = (ev: MessageEvent): void => {
      const data = ev.data as { action?: unknown; sourceName?: unknown } | null;
      if (data?.sourceName === "worker" && data.action === "ready") {
        finish(true);
      }
    };
    const onError = (ev: ErrorEvent): void => {
      finish(false, new Error(ev.message || "Blob worker error"));
    };

    const timer = window.setTimeout(() => {
      finish(false, new Error("Blob worker ready timeout"));
    }, WORKER_READY_TIMEOUT_MS);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

function ensurePdfWorker(): Promise<pdfjsLib.PDFWorker | undefined> {
  if (sharedWorkerPromise) return sharedWorkerPromise;
  sharedWorkerPromise = (async () => {
    const workerBytes = readEmbeddedWorkerBytes();
    try {
      const rawWorker = await tryCreateBlobWorker(workerBytes);
      diagState.workerMode = "blob";
      sharedPdfWorker = new pdfjsLib.PDFWorker({
        port: rawWorker as unknown as null,
      });
      return sharedPdfWorker;
    } catch {
      await initMainThreadWorker(workerBytes);
      return undefined;
    }
  })();
  return sharedWorkerPromise;
}

// ── 自定义 BinaryDataFactory（经 viewer_asset 读取 cMap / 标准字体 / wasm）──
const ViewerBinaryDataFactory = createViewerBinaryDataFactory({
  fetchAsset: async (assetName: string): Promise<Uint8Array> => {
    const res = await callServerTool("viewer_asset", { name: assetName });
    if (res.isError) {
      throw new ViewerToolError(formatViewerError(res));
    }
    const sc = res.structuredContent as Partial<ViewerAssetData> | undefined;
    if (!sc || typeof sc.data !== "string") {
      throw new Error(`Empty viewer_asset payload for ${assetName}`);
    }
    return decodeBase64(sc.data);
  },
});

// ── 文档渲染状态 ──
interface PageSlot {
  readonly pageNumber: number;
  readonly el: HTMLDivElement;
  baseWidth: number;
  baseHeight: number;
  dimsKnown: boolean;
  canvas: HTMLCanvasElement | null;
  renderedScale: number;
  renderTask: RenderTask | null;
  renderingScale: number;
  renderSeq: number;
}

let activeLoadToken = 0;
let currentDoc: PDFDocumentProxy | null = null;
let lastToolInputPath: string | null = null;
let lastToolInputPage = 1;
let slots: PageSlot[] = [];
let visibleSet = new Set<number>();
let currentPage = 0;
let currentScale = 1;
let fitWidthMode = true;
let fitWidthMaxScale = INITIAL_FIT_WIDTH_MAX_SCALE;
let intersectionObserver: IntersectionObserver | null = null;
let scrollRaf = 0;
let programmaticScrollUntil = 0;

function setLoading(loading: boolean): void {
  progressEl.dataset.loading = loading ? "true" : "false";
}

function syncToolbar(): void {
  const total = currentDoc ? currentDoc.numPages : 0;
  const hasDoc = total > 0;
  pageTotalEl.textContent = String(total);
  if (document.activeElement !== pageInput) {
    pageInput.value = String(hasDoc ? currentPage : 0);
  }
  pageInput.disabled = !hasDoc;
  btnPrev.disabled = !hasDoc || currentPage <= 1;
  btnNext.disabled = !hasDoc || currentPage >= total;
  btnZoomOut.disabled = !hasDoc || currentScale <= MIN_SCALE + 0.001;
  btnZoomIn.disabled = !hasDoc || currentScale >= MAX_SCALE - 0.001;
  btnFitWidth.disabled = !hasDoc;
  zoomLabelEl.textContent = `${Math.round(currentScale * 100)}%`;

  diagState.pageCount = total;
  diagState.currentPage = hasDoc ? currentPage : 0;
  diagState.scale = currentScale;
}

function syncRenderedPagesDiag(): void {
  diagState.renderedPages = slots
    .filter((s) => s.canvas !== null && s.renderedScale > 0)
    .map((s) => s.pageNumber);
}

function clearDocumentViews(): void {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  for (const slot of slots) {
    slot.renderTask?.cancel();
    slot.renderTask = null;
    if (slot.canvas) {
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas = null;
    }
  }
  slots = [];
  visibleSet = new Set<number>();
  pagesEl.replaceChildren();
  currentPage = 0;
  syncRenderedPagesDiag();
}

function showError(source: unknown): void {
  const formatted = formatViewerError(source);
  clearDocumentViews();
  errorBoxEl.textContent = formatted.display;
  errorBoxEl.hidden = false;
  diagState.status = "error";
  diagState.error = formatted.raw;
  console.error("[nocturne-doc-viewer]", formatted.raw);
  setLoading(false);
  syncToolbar();
}

function hideError(): void {
  errorBoxEl.hidden = true;
  errorBoxEl.textContent = "";
  diagState.error = null;
}

function computeFitWidthScale(pageWidth: number, maxScale = MAX_SCALE): number {
  const available = Math.max(160, stageEl.clientWidth - 36);
  const raw = available / Math.max(1, pageWidth);
  return Math.max(MIN_SCALE, Math.min(maxScale, raw));
}

function applySlotSize(slot: PageSlot): void {
  slot.el.style.width = `${Math.round(slot.baseWidth * currentScale)}px`;
  slot.el.style.height = `${Math.round(slot.baseHeight * currentScale)}px`;
}

function releaseSlotCanvas(slot: PageSlot): void {
  slot.renderSeq += 1;
  if (slot.renderTask) {
    slot.renderTask.cancel();
    slot.renderTask = null;
  }
  if (slot.canvas) {
    slot.canvas.width = 0;
    slot.canvas.height = 0;
    slot.canvas.remove();
    slot.canvas = null;
  }
  slot.renderedScale = 0;
  slot.renderingScale = 0;
}

async function renderSlot(slot: PageSlot, token: number): Promise<void> {
  const doc = currentDoc;
  if (!doc || token !== activeLoadToken) return;
  const targetScale = currentScale;
  if (
    slot.renderedScale === targetScale &&
    slot.canvas !== null &&
    slot.renderTask === null &&
    slot.renderingScale === 0
  ) {
    return;
  }
  if (slot.renderingScale === targetScale) {
    return;
  }

  const seq = ++slot.renderSeq;
  const prevTask = slot.renderTask;
  slot.renderTask = null;
  slot.renderingScale = targetScale;
  if (prevTask) {
    prevTask.cancel();
    try {
      await prevTask.promise;
    } catch {
      // ignore cancellation rejection
    }
  }
  if (
    seq !== slot.renderSeq ||
    token !== activeLoadToken ||
    currentDoc !== doc ||
    currentScale !== targetScale
  ) {
    return;
  }

  let page: PDFPageProxy;
  try {
    page = await doc.getPage(slot.pageNumber);
  } catch {
    if (seq === slot.renderSeq) slot.renderingScale = 0;
    return;
  }
  if (
    seq !== slot.renderSeq ||
    token !== activeLoadToken ||
    currentDoc !== doc ||
    currentScale !== targetScale
  ) {
    return;
  }

  const baseVp = page.getViewport({ scale: 1 });
  if (!slot.dimsKnown) {
    slot.baseWidth = baseVp.width;
    slot.baseHeight = baseVp.height;
    slot.dimsKnown = true;
    applySlotSize(slot);
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: targetScale });
  const canvas = slot.canvas ?? document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  if (!slot.canvas) {
    slot.canvas = canvas;
    slot.el.replaceChildren(canvas);
  }

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    if (seq === slot.renderSeq) slot.renderingScale = 0;
    return;
  }

  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}),
  });
  slot.renderTask = task;

  try {
    await task.promise;
    if (seq === slot.renderSeq && token === activeLoadToken && slot.renderTask === task) {
      slot.renderTask = null;
      slot.renderingScale = 0;
      slot.renderedScale = targetScale;
      syncRenderedPagesDiag();
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (seq === slot.renderSeq && token === activeLoadToken) {
      slot.renderTask = null;
      slot.renderingScale = 0;
      if (name !== "RenderingCancelledException") {
        diagState.error = err instanceof Error ? err.message : String(err);
      }
    }
  }
}

function updateVisibleRenders(token: number): void {
  if (!currentDoc || token !== activeLoadToken || slots.length === 0) return;

  const activeNumbers = new Set<number>();
  if (visibleSet.size === 0) {
    const anchor = Math.max(1, Math.min(slots.length, currentPage || 1));
    activeNumbers.add(anchor);
    if (anchor > 1) activeNumbers.add(anchor - 1);
    if (anchor < slots.length) activeNumbers.add(anchor + 1);
  } else {
    for (const num of visibleSet) {
      activeNumbers.add(num);
      if (num > 1) activeNumbers.add(num - 1);
      if (num < slots.length) activeNumbers.add(num + 1);
    }
  }

  for (const slot of slots) {
    if (activeNumbers.has(slot.pageNumber)) {
      void renderSlot(slot, token);
    } else if (slot.canvas !== null) {
      releaseSlotCanvas(slot);
    }
  }
  syncRenderedPagesDiag();
}

function detectCurrentPageFromScroll(): void {
  if (slots.length === 0) return;
  const stageRect = stageEl.getBoundingClientRect();
  const focusY = stageRect.top + Math.min(stageRect.height * 0.35, 160);
  let bestPage = currentPage || 1;
  let bestDist = Infinity;

  for (const slot of slots) {
    const r = slot.el.getBoundingClientRect();
    if (r.top <= focusY && r.bottom >= focusY) {
      bestPage = slot.pageNumber;
      break;
    }
    const dist = Math.min(Math.abs(r.top - focusY), Math.abs(r.bottom - focusY));
    if (dist < bestDist) {
      bestDist = dist;
      bestPage = slot.pageNumber;
    }
  }

  if (bestPage !== currentPage) {
    currentPage = bestPage;
    syncToolbar();
  }
}

function scrollToPage(pageNumber: number): void {
  if (slots.length === 0) return;
  const clamped = Math.max(1, Math.min(slots.length, Math.trunc(pageNumber)));
  const slot = slots[clamped - 1];
  if (!slot) return;
  currentPage = clamped;
  syncToolbar();
  programmaticScrollUntil = performance.now() + 250;
  stageEl.scrollTop = Math.max(0, slot.el.offsetTop - 16);
  visibleSet.add(clamped);
  updateVisibleRenders(activeLoadToken);
}

function setScale(nextScale: number, isFitWidth: boolean): void {
  if (!currentDoc || slots.length === 0) return;
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  fitWidthMode = isFitWidth;
  if (Math.abs(clamped - currentScale) < 0.001) {
    syncToolbar();
    return;
  }
  const anchorPage = Math.max(1, Math.min(slots.length, currentPage || 1));
  const anchorSlot = slots[anchorPage - 1];
  const relOffset =
    anchorSlot && anchorSlot.el.offsetHeight > 0
      ? Math.max(0, (stageEl.scrollTop - anchorSlot.el.offsetTop + 16) / anchorSlot.el.offsetHeight)
      : 0;

  currentScale = clamped;
  for (const slot of slots) {
    applySlotSize(slot);
  }
  if (anchorSlot) {
    stageEl.scrollTop = Math.max(
      0,
      anchorSlot.el.offsetTop - 16 + relOffset * anchorSlot.el.offsetHeight,
    );
  }
  syncToolbar();
  updateVisibleRenders(activeLoadToken);
}

async function readPdfBytesWithRecovery(
  initial: ShowInViewerData,
  token: number,
  retried = false,
): Promise<{ bytes: Uint8Array; info: ShowInViewerData }> {
  const out = new Uint8Array(initial.totalBytes);
  let offset = 0;

  while (offset < initial.totalBytes) {
    if (token !== activeLoadToken) {
      throw new Error("cancelled");
    }
    const reqLength = Math.min(initial.chunkSize, initial.totalBytes - offset);
    const chunkRes = await callServerTool("read_document", {
      docId: initial.docId,
      offset,
      length: reqLength,
    });

    if (chunkRes.isError) {
      if (!retried && isDocumentUnknownError(chunkRes) && initial.path) {
        const reopenRes = await callServerTool("show_in_viewer", {
          path: initial.path,
          page: initial.initialPage,
        });
        if (reopenRes.isError) {
          throw new ViewerToolError(formatViewerError(reopenRes));
        }
        const reopened = parseShowInViewerPayload(reopenRes);
        if (!reopened) {
          throw new Error("Invalid show_in_viewer recovery payload.");
        }
        return readPdfBytesWithRecovery(reopened, token, true);
      }
      throw new ViewerToolError(formatViewerError(chunkRes));
    }

    const sc = chunkRes.structuredContent as Partial<ReadChunkData> | undefined;
    if (!sc || typeof sc.data !== "string" || typeof sc.bytesRead !== "number") {
      throw new Error("Invalid read_document response.");
    }
    const part = decodeBase64(sc.data);
    out.set(part, offset);
    offset += part.byteLength;
    if (sc.eof === true || part.byteLength === 0) break;
  }

  return { bytes: out, info: initial };
}

async function openDocument(info: ShowInViewerData): Promise<void> {
  const token = ++activeLoadToken;
  hideError();
  setLoading(true);
  diagState.status = "loading";
  diagState.fileName = info.fileName;
  docNameEl.textContent = info.fileName;

  const prevDoc = currentDoc;
  currentDoc = null;
  clearDocumentViews();
  syncToolbar();
  if (prevDoc) {
    void prevDoc.loadingTask.destroy().catch(() => undefined);
  }

  try {
    const [worker, loaded] = await Promise.all([
      ensurePdfWorker(),
      readPdfBytesWithRecovery(info, token),
    ]);
    if (token !== activeLoadToken) return;

    const docParams: Parameters<typeof pdfjsLib.getDocument>[0] & {
      isEvalSupported?: boolean;
    } = {
      data: loaded.bytes,
      useWorkerFetch: false,
      disableWorkerRendering: true,
      isEvalSupported: false,
      useWasm: true,
      cMapUrl: "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "standard_fonts/",
      wasmUrl: "wasm/",
      BinaryDataFactory: ViewerBinaryDataFactory,
      ...(worker !== undefined ? { worker } : {}),
    };

    const loadingTask = pdfjsLib.getDocument(docParams);
    const pdfDoc = await loadingTask.promise;
    if (token !== activeLoadToken) {
      void pdfDoc.loadingTask.destroy().catch(() => undefined);
      return;
    }

    currentDoc = pdfDoc;
    const firstPage = await pdfDoc.getPage(1);
    if (token !== activeLoadToken) return;

    const firstVp = firstPage.getViewport({ scale: 1 });
    fitWidthMode = true;
    fitWidthMaxScale = INITIAL_FIT_WIDTH_MAX_SCALE;
    currentScale = computeFitWidthScale(firstVp.width, fitWidthMaxScale);

    const frag = document.createDocumentFragment();
    slots = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const slotEl = document.createElement("div");
      slotEl.className = "page-slot";
      slotEl.dataset.page = String(p);
      const slot: PageSlot = {
        pageNumber: p,
        el: slotEl,
        baseWidth: firstVp.width,
        baseHeight: firstVp.height,
        dimsKnown: p === 1,
        canvas: null,
        renderedScale: 0,
        renderTask: null,
        renderingScale: 0,
        renderSeq: 0,
      };
      applySlotSize(slot);
      slots.push(slot);
      frag.appendChild(slotEl);
    }
    pagesEl.replaceChildren(frag);

    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const num = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isInteger(num) || num < 1) continue;
          if (entry.isIntersecting) visibleSet.add(num);
          else visibleSet.delete(num);
        }
        updateVisibleRenders(token);
      },
      { root: stageEl, rootMargin: "600px 0px" },
    );
    for (const slot of slots) {
      intersectionObserver.observe(slot.el);
    }

    const startPage = Math.max(1, Math.min(pdfDoc.numPages, loaded.info.initialPage));
    currentPage = startPage;
    syncToolbar();
    if (startPage > 1) {
      scrollToPage(startPage);
    } else {
      stageEl.scrollTop = 0;
      visibleSet.add(1);
      updateVisibleRenders(token);
    }
    const startSlot = slots[startPage - 1];
    if (startSlot) {
      await renderSlot(startSlot, token);
    }
    if (token !== activeLoadToken) return;

    diagState.status = "ready";
    setLoading(false);
    syncToolbar();
  } catch (err) {
    if (token !== activeLoadToken) return;
    const message = err instanceof Error ? err.message : String(err);
    if (message === "cancelled") return;
    showError(err);
  }
}

// ── 工具栏与视口事件 ──
btnPrev.addEventListener("click", () => {
  if (currentPage > 1) scrollToPage(currentPage - 1);
});

btnNext.addEventListener("click", () => {
  if (currentDoc && currentPage < currentDoc.numPages) {
    scrollToPage(currentPage + 1);
  }
});

function commitPageInput(): void {
  if (!currentDoc) return;
  const parsed = Number.parseInt(pageInput.value.trim(), 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= currentDoc.numPages) {
    scrollToPage(parsed);
  } else {
    pageInput.value = String(currentPage);
  }
}

pageInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    commitPageInput();
    pageInput.blur();
  }
});
pageInput.addEventListener("blur", commitPageInput);

btnZoomOut.addEventListener("click", () => {
  const prev = [...ZOOM_STEPS].reverse().find((z) => z < currentScale - 0.01);
  setScale(prev ?? Math.max(MIN_SCALE, currentScale / 1.25), false);
});

btnZoomIn.addEventListener("click", () => {
  const next = ZOOM_STEPS.find((z) => z > currentScale + 0.01);
  setScale(next ?? Math.min(MAX_SCALE, currentScale * 1.25), false);
});

btnFitWidth.addEventListener("click", () => {
  const ref = slots[Math.max(0, currentPage - 1)] ?? slots[0];
  if (!ref) return;
  fitWidthMaxScale = MAX_SCALE;
  setScale(computeFitWidthScale(ref.baseWidth, fitWidthMaxScale), true);
});

stageEl.addEventListener(
  "scroll",
  () => {
    if (performance.now() < programmaticScrollUntil) return;
    if (scrollRaf !== 0) return;
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0;
      if (performance.now() < programmaticScrollUntil) return;
      detectCurrentPageFromScroll();
    });
  },
  { passive: true },
);

if (typeof ResizeObserver !== "undefined") {
  const resizeObserver = new ResizeObserver(() => {
    if (!fitWidthMode || !currentDoc || slots.length === 0) return;
    const ref = slots[Math.max(0, currentPage - 1)] ?? slots[0];
    if (!ref) return;
    setScale(computeFitWidthScale(ref.baseWidth, fitWidthMaxScale), true);
  });
  resizeObserver.observe(stageEl);
}

// ── 宿主消息监听 ──
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data as JsonRpcMessage | null;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

  if (msg.method === undefined && typeof msg.id === "number") {
    const waiter = pendingRequests.get(msg.id);
    if (!waiter) return;
    pendingRequests.delete(msg.id);
    if (msg.error) {
      waiter.reject(new Error(msg.error.message ?? "RPC error"));
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }

  switch (msg.method) {
    case "ui/notifications/host-context-changed": {
      if (isRecord(msg.params)) {
        applyHostContext(msg.params);
      }
      break;
    }
    case "ui/notifications/tool-input": {
      if (isRecord(msg.params) && isRecord(msg.params.arguments)) {
        const toolArgs = msg.params.arguments;
        if (typeof toolArgs.path === "string" && toolArgs.path.length > 0) {
          lastToolInputPath = toolArgs.path;
        }
        if (typeof toolArgs.page === "number" && Number.isInteger(toolArgs.page)) {
          lastToolInputPage = Math.max(1, toolArgs.page);
        }
      }
      break;
    }
    case "ui/notifications/tool-result": {
      if (!isRecord(msg.params)) return;
      const result = msg.params as ToolResultLike;
      if (result.isError) {
        showError(result);
        return;
      }
      const parsed = parseShowInViewerPayload(result);
      if (parsed) {
        void openDocument(parsed);
        return;
      }
      if (lastToolInputPath) {
        void (async () => {
          try {
            const reopen = await callServerTool("show_in_viewer", {
              path: lastToolInputPath,
              page: lastToolInputPage,
            });
            if (reopen.isError) {
              showError(reopen);
              return;
            }
            const info = parseShowInViewerPayload(reopen);
            if (info) await openDocument(info);
          } catch (err) {
            showError(err);
          }
        })();
      }
      break;
    }
    case "ui/notifications/tool-cancelled": {
      setLoading(false);
      break;
    }
    case "ui/resource-teardown": {
      activeLoadToken++;
      clearDocumentViews();
      const doc = currentDoc;
      currentDoc = null;
      const worker = sharedPdfWorker;
      sharedPdfWorker = undefined;
      sharedWorkerPromise = null;
      if (workerBlobUrl) {
        URL.revokeObjectURL(workerBlobUrl);
        workerBlobUrl = undefined;
      }
      worker?.destroy();
      void Promise.resolve(doc?.loadingTask.destroy())
        .catch(() => undefined)
        .finally(() => {
          if (msg.id !== undefined) {
            window.parent.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
          }
        });
      break;
    }
    default:
      break;
  }
});

// ── 握手初始化 ──
void sendRpcRequest("ui/initialize", {
  appInfo: { name: "nocturne-doc-viewer", version: __NOCTURNE_PLUGIN_VERSION__ },
  appCapabilities: { availableDisplayModes: ["inline"] },
  protocolVersion: "2026-01-26",
})
  .then((res) => {
    if (isRecord(res) && isRecord(res.hostContext)) {
      applyHostContext(res.hostContext);
    }
    sendRpcNotification("ui/notifications/initialized", {});
  })
  .catch((err: unknown) => {
    showError(err);
  });
