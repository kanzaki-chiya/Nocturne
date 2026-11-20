import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";

import { DocPluginError } from "./errors.js";
import type { PluginResourceSpec, ToolHandler } from "./mcp.js";
import { assertAbsolutePath, assertNonEmptyFileProduced, assertSourceExists } from "./paths.js";
import { MAX_DOCUMENT_BYTES } from "./viewer-errors.js";

export { MAX_DOCUMENT_BYTES };
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const VIEWER_SURFACE_ID = "viewer";
/**
 * 实测单块上限：@nocturne/mcp StdioPipeTransport 单行上限为 8 MiB；
 * 4 MiB 原始字节经 base64 编码后约 5.33 MiB（单份存 structuredContent.data），可稳定往返。
 */
export const READ_DOCUMENT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ViewerAssetManifest {
  readonly version?: string;
  readonly files: Readonly<Record<string, { readonly size: number; readonly mimeType?: string }>>;
}

export interface ViewerFeatureOptions {
  readonly serverId: string;
  readonly title: string;
  /**
   * 将非 PDF 文档转为 PDF 输出到 outputPath。
   * 未提供（如 pdf 插件）或输入本身是 .pdf 时直接读取源文件。
   */
  readonly convertToPdf?: ((inputPath: string, outputPath: string) => Promise<void>) | undefined;
  readonly viewerHtmlPath?: string | undefined;
  readonly viewerAssetsDir?: string | undefined;
  readonly maxDocumentBytes?: number | undefined;
  readonly maxChunkBytes?: number | undefined;
}

export interface ViewerFeature {
  readonly tools: readonly Tool[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
  readonly resources: readonly PluginResourceSpec[];
  readonly close: () => void;
}

interface RegisteredDoc {
  readonly docId: string;
  readonly sourcePath: string;
  readonly pdfPath: string;
  readonly fileName: string;
  readonly totalBytes: number;
  readonly pageCount: number;
}

interface CachedConversion {
  readonly key: string;
  readonly pdfPath: string;
}

export function viewerResourceUri(serverId: string): string {
  return `ui://${serverId}/viewer.html`;
}

export function buildViewerTools(serverId: string): readonly Tool[] {
  return [
    {
      name: "show_in_viewer",
      description:
        "Open a document in the side panel viewer (converts Office documents to PDF automatically). Returns a brief summary with filename and page count.",
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          resourceUri: viewerResourceUri(serverId),
          surface: VIEWER_SURFACE_ID,
          visibility: ["model", "app"],
        },
      },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the document to display.",
          },
          page: {
            type: "integer",
            minimum: 1,
            description: "Optional 1-based initial page number.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "read_document",
      description: "Read a byte chunk from a registered viewer document handle as base64.",
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
      inputSchema: {
        type: "object",
        properties: {
          docId: {
            type: "string",
            description: "Document handle returned by show_in_viewer.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Byte offset to start reading from.",
          },
          length: {
            type: "integer",
            minimum: 1,
            description: "Maximum bytes to read (clamped to server chunk limit).",
          },
        },
        required: ["docId", "offset"],
      },
    },
    {
      name: "viewer_asset",
      description: "Read a packaged pdf.js auxiliary asset (cMap, standard font, or WebAssembly).",
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Packaged asset name listed in viewer-assets/manifest.json.",
          },
        },
        required: ["name"],
      },
    },
  ];
}

function resolveDefaultViewerPath(relativeName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, relativeName);
  if (existsSync(sibling)) return sibling;
  const builtFallback = path.resolve(here, "../../../plugins/pdf", relativeName);
  if (existsSync(builtFallback)) return builtFallback;
  return sibling;
}

function resolveRealPathSafe(absPath: string): string {
  try {
    return realpathSync.native(absPath);
  } catch {
    return absPath;
  }
}

async function detectPdfPageCount(pdfPath: string): Promise<number> {
  try {
    const bytes = readFileSync(pdfPath);
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

function parseOptionalInitialPage(raw: unknown): number {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new DocPluginError("invalid_argument", "page must be a positive integer.");
  }
  return raw;
}

function readChunkFromFile(filePath: string, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    let totalRead = 0;
    while (totalRead < length) {
      const n = readSync(fd, buf, totalRead, length - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return totalRead === length ? buf : buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

export function createViewerFeature(options: ViewerFeatureOptions): ViewerFeature {
  const maxDocumentBytes = options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
  const maxChunkBytes = options.maxChunkBytes ?? READ_DOCUMENT_MAX_CHUNK_BYTES;
  const uri = viewerResourceUri(options.serverId);

  const docsById = new Map<string, RegisteredDoc>();
  const conversionCache = new Map<string, CachedConversion>();
  const inflightConversions = new Map<string, Promise<string>>();

  let cacheDir: string | undefined;
  let cacheSeq = 0;
  let cachedManifest: ViewerAssetManifest | undefined;

  const ensureCacheDir = (): string => {
    if (cacheDir !== undefined && existsSync(cacheDir)) return cacheDir;
    cacheDir = mkdtempSync(path.join(tmpdir(), `nocturne-viewer-${options.serverId}-`));
    return cacheDir;
  };

  const cleanupCacheDir = (): void => {
    if (cacheDir === undefined) return;
    const dir = cacheDir;
    cacheDir = undefined;
    conversionCache.clear();
    docsById.clear();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略进程退出时的清理错误
    }
  };

  const exitHandler = (): void => {
    cleanupCacheDir();
  };
  process.once("exit", exitHandler);

  const loadManifest = (assetsDir: string): ViewerAssetManifest => {
    if (cachedManifest !== undefined) return cachedManifest;
    const manifestPath = path.join(assetsDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new DocPluginError("asset_not_found", "Viewer asset manifest is missing.");
    }
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("files" in parsed) ||
      typeof (parsed as { files?: unknown }).files !== "object" ||
      (parsed as { files?: unknown }).files === null
    ) {
      throw new DocPluginError("engine_error", "Viewer asset manifest is malformed.");
    }
    cachedManifest = parsed as ViewerAssetManifest;
    return cachedManifest;
  };

  const resolvePdfForDocument = async (
    realPath: string,
    sourceStat: { mtimeMs: number; size: number },
  ): Promise<string> => {
    if (!options.convertToPdf || path.extname(realPath).toLowerCase() === ".pdf") {
      return realPath;
    }

    const cacheKey = `${realPath}\0${sourceStat.mtimeMs}\0${sourceStat.size}`;
    const existing = conversionCache.get(realPath);
    if (existing?.key === cacheKey && existsSync(existing.pdfPath)) {
      return existing.pdfPath;
    }

    const inflight = inflightConversions.get(cacheKey);
    if (inflight !== undefined) {
      return inflight;
    }

    const dir = ensureCacheDir();
    const outPdf = path.join(dir, `doc-${++cacheSeq}.pdf`);
    const convert = options.convertToPdf;
    const task = (async () => {
      await convert(realPath, outPdf);
      assertNonEmptyFileProduced(outPdf);
      conversionCache.set(realPath, { key: cacheKey, pdfPath: outPdf });
      return outPdf;
    })();

    inflightConversions.set(cacheKey, task);
    try {
      return await task;
    } finally {
      inflightConversions.delete(cacheKey);
    }
  };

  const showInViewer: ToolHandler = async (args): Promise<CallToolResult> => {
    const absPath = assertAbsolutePath(args.path, "path");
    assertSourceExists(absPath);
    const requestedPage = parseOptionalInitialPage(args.page);

    const realPath = resolveRealPathSafe(absPath);
    const sourceStat = statSync(realPath);
    if (sourceStat.size > maxDocumentBytes) {
      throw new DocPluginError(
        "document_too_large",
        `Document exceeds the ${Math.round(maxDocumentBytes / (1024 * 1024))} MiB limit (${sourceStat.size} bytes).`,
      );
    }

    const pdfPath = await resolvePdfForDocument(realPath, sourceStat);
    const pdfStat = statSync(pdfPath);
    if (pdfStat.size > maxDocumentBytes) {
      throw new DocPluginError(
        "document_too_large",
        `Converted PDF exceeds the ${Math.round(maxDocumentBytes / (1024 * 1024))} MiB limit (${pdfStat.size} bytes).`,
      );
    }

    const pageCount = await detectPdfPageCount(pdfPath);
    const initialPage = pageCount > 0 ? Math.min(requestedPage, pageCount) : requestedPage;
    const docId = randomBytes(12).toString("hex");
    const fileName = path.basename(absPath);

    docsById.set(docId, {
      docId,
      sourcePath: absPath,
      pdfPath,
      fileName,
      totalBytes: pdfStat.size,
      pageCount,
    });

    const summary = pageCount > 0 ? `${fileName}（共 ${pageCount} 页）` : fileName;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        docId,
        path: absPath,
        fileName,
        pageCount,
        initialPage,
        totalBytes: pdfStat.size,
        chunkSize: maxChunkBytes,
      },
    };
  };

  const readDocument: ToolHandler = (args): Promise<CallToolResult> =>
    Promise.resolve().then(() => {
      if (typeof args.docId !== "string" || args.docId.trim() === "") {
        throw new DocPluginError("invalid_argument", "docId must be a non-empty string.");
      }
      const doc = docsById.get(args.docId);
      if (!doc) {
        throw new DocPluginError("document_unknown", `Unknown document handle: ${args.docId}`);
      }
      if (!existsSync(doc.pdfPath)) {
        docsById.delete(args.docId);
        throw new DocPluginError(
          "document_unknown",
          `Document backing file is no longer available: ${args.docId}`,
        );
      }

      const offset = args.offset;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        throw new DocPluginError("invalid_argument", "offset must be a non-negative integer.");
      }
      if (offset >= doc.totalBytes) {
        throw new DocPluginError(
          "invalid_argument",
          `offset (${offset}) is out of range (totalBytes=${doc.totalBytes}).`,
        );
      }

      const rawLength = args.length === undefined ? maxChunkBytes : args.length;
      if (typeof rawLength !== "number" || !Number.isInteger(rawLength) || rawLength < 1) {
        throw new DocPluginError("invalid_argument", "length must be a positive integer.");
      }

      const clampedLength = Math.min(rawLength, maxChunkBytes, doc.totalBytes - offset);
      const chunk = readChunkFromFile(doc.pdfPath, offset, clampedLength);
      const bytesRead = chunk.length;
      const eof = offset + bytesRead >= doc.totalBytes;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              docId: doc.docId,
              offset,
              bytesRead,
              totalBytes: doc.totalBytes,
              eof,
            }),
          },
        ],
        structuredContent: {
          docId: doc.docId,
          offset,
          bytesRead,
          totalBytes: doc.totalBytes,
          eof,
          data: chunk.toString("base64"),
        },
      };
    });

  const viewerAsset: ToolHandler = (args): Promise<CallToolResult> =>
    Promise.resolve().then(() => {
      if (typeof args.name !== "string" || args.name.trim() === "") {
        throw new DocPluginError("invalid_argument", "name must be a non-empty string.");
      }
      const name = args.name;
      if (
        name.includes("\\") ||
        name.includes("..") ||
        name.startsWith("/") ||
        path.isAbsolute(name)
      ) {
        throw new DocPluginError("asset_not_found", `Asset is not in package manifest: ${name}`);
      }

      const assetsDir = options.viewerAssetsDir ?? resolveDefaultViewerPath("viewer-assets");
      const manifest = loadManifest(assetsDir);
      if (!Object.prototype.hasOwnProperty.call(manifest.files, name)) {
        throw new DocPluginError("asset_not_found", `Asset is not in package manifest: ${name}`);
      }

      const resolvedAssetsDir = path.resolve(assetsDir);
      const targetPath = path.resolve(resolvedAssetsDir, name);
      if (
        targetPath !== resolvedAssetsDir &&
        !targetPath.startsWith(`${resolvedAssetsDir}${path.sep}`)
      ) {
        throw new DocPluginError("asset_not_found", `Asset path escapes manifest root: ${name}`);
      }
      if (!existsSync(targetPath)) {
        throw new DocPluginError("asset_not_found", `Packaged asset file missing: ${name}`);
      }

      const buf = readFileSync(targetPath);
      return {
        content: [{ type: "text", text: JSON.stringify({ name, bytes: buf.length }) }],
        structuredContent: {
          name,
          bytes: buf.length,
          data: buf.toString("base64"),
        },
      };
    });

  const resources: readonly PluginResourceSpec[] = [
    {
      uri,
      name: options.title,
      mimeType: MCP_APP_MIME_TYPE,
      read: () => {
        const htmlPath = options.viewerHtmlPath ?? resolveDefaultViewerPath("viewer.html");
        if (!existsSync(htmlPath)) {
          throw new Error(`Viewer HTML not found: ${htmlPath}`);
        }
        return readFileSync(htmlPath, "utf8");
      },
    },
  ];

  return {
    tools: buildViewerTools(options.serverId),
    handlers: {
      show_in_viewer: showInViewer,
      read_document: readDocument,
      viewer_asset: viewerAsset,
    },
    resources,
    close: () => {
      process.off("exit", exitHandler);
      cleanupCacheDir();
    },
  };
}
