import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPdfPluginServer } from "../src/servers/pdf.js";
import { isDocPluginError } from "../src/shared/errors.js";
import { createViewerBinaryDataFactory } from "../src/shared/pdfjs-factory.js";
import {
  buildViewerTools,
  createViewerFeature,
  READ_DOCUMENT_MAX_CHUNK_BYTES,
} from "../src/shared/viewer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const repoRoot = path.resolve(pkgDir, "..");
const builtPdfPluginDir = path.join(repoRoot, "plugins", "pdf");
const fixturesDir = path.join(here, "fixtures");

const CJK_PDF = path.join(fixturesDir, "cjk-unembedded.pdf");
const HELVETICA_PDF = path.join(fixturesDir, "helvetica-unembedded.pdf");
const TIMES_PDF = path.join(fixturesDir, "times-unembedded.pdf");

beforeAll(() => {
  if (!existsSync(path.join(builtPdfPluginDir, "viewer.html"))) {
    execFileSync(process.execPath, [path.join(pkgDir, "scripts", "build.mjs")], {
      cwd: pkgDir,
      stdio: "inherit",
    });
  }
});

async function expectDocError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected DocPluginError(${code}) to be thrown`);
  } catch (err) {
    expect(isDocPluginError(err)).toBe(true);
    if (isDocPluginError(err)) {
      expect(err.code).toBe(code);
    }
  }
}

describe("document viewer tools and caching", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "nocturne-viewer-unit-"));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("declares correct visibility and readOnlyHint for all three viewer tools", () => {
    const tools = buildViewerTools("word");
    const byName = new Map(tools.map((t) => [t.name, t]));

    const show = byName.get("show_in_viewer");
    const readDoc = byName.get("read_document");
    const asset = byName.get("viewer_asset");

    expect(show?.annotations?.readOnlyHint).toBe(true);
    expect(show?._meta?.ui).toEqual({
      resourceUri: "ui://word/viewer.html",
      surface: "viewer",
      visibility: ["model", "app"],
    });

    expect(readDoc?.annotations?.readOnlyHint).toBe(true);
    expect(readDoc?._meta?.ui).toEqual({ visibility: ["app"] });

    expect(asset?.annotations?.readOnlyHint).toBe(true);
    expect(asset?._meta?.ui).toEqual({ visibility: ["app"] });
  });

  it("builds shared viewer.html strictly under the 8 MiB ADR-0101 limit", () => {
    const htmlPath = path.join(builtPdfPluginDir, "viewer.html");
    const size = statSync(htmlPath).size;
    expect(size).toBeGreaterThan(500_000);
    expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("registers handles, returns document_unknown on invalid handles, and enforces chunk boundaries", async () => {
    const chunkSize = 256;
    const server = createPdfPluginServer({
      viewerHtmlPath: path.join(builtPdfPluginDir, "viewer.html"),
      viewerAssetsDir: path.join(builtPdfPluginDir, "viewer-assets"),
      maxChunkBytes: chunkSize,
    });
    const show = server.handlers.show_in_viewer;
    const readDoc = server.handlers.read_document;
    if (!show || !readDoc) throw new Error("Expected viewer tool handlers");

    try {
      // Unknown handle rejected with document_unknown
      await expectDocError(
        readDoc({ docId: "nonexistent-handle", offset: 0, length: 64 }),
        "document_unknown",
      );

      // Register real PDF
      const showRes = await show({ path: CJK_PDF, page: 1 });
      const sc = showRes.structuredContent as {
        docId: string;
        path: string;
        fileName: string;
        pageCount: number;
        initialPage: number;
        totalBytes: number;
        chunkSize: number;
      };
      const expectedBytes = readFileSync(CJK_PDF);
      expect(sc.docId.length).toBeGreaterThan(0);
      expect(sc.path).toBe(path.resolve(CJK_PDF));
      expect(sc.fileName).toBe("cjk-unembedded.pdf");
      expect(sc.pageCount).toBe(1);
      expect(sc.initialPage).toBe(1);
      expect(sc.totalBytes).toBe(expectedBytes.length);
      expect(sc.chunkSize).toBe(chunkSize);
      expect(showRes.content[0]).toEqual({
        type: "text",
        text: "cjk-unembedded.pdf（共 1 页）",
      });

      // Read chunks from offset 0 through EOF
      const parts: Buffer[] = [];
      let offset = 0;
      let chunks = 0;
      while (offset < sc.totalBytes) {
        const res = await readDoc({ docId: sc.docId, offset, length: chunkSize * 2 });
        const chunkSc = res.structuredContent as {
          offset: number;
          bytesRead: number;
          totalBytes: number;
          eof: boolean;
          data: string;
        };
        expect(chunkSc.offset).toBe(offset);
        expect(chunkSc.bytesRead).toBeLessThanOrEqual(chunkSize);
        const buf = Buffer.from(chunkSc.data, "base64");
        expect(buf.length).toBe(chunkSc.bytesRead);
        parts.push(buf);
        offset += buf.length;
        chunks += 1;
        if (offset < sc.totalBytes) {
          expect(chunkSc.eof).toBe(false);
        } else {
          expect(chunkSc.eof).toBe(true);
        }
      }
      expect(chunks).toBeGreaterThanOrEqual(2);
      expect(Buffer.concat(parts).equals(expectedBytes)).toBe(true);

      // Out-of-bounds offset and negative offset rejected
      await expectDocError(
        readDoc({ docId: sc.docId, offset: sc.totalBytes, length: 16 }),
        "invalid_argument",
      );
      await expectDocError(
        readDoc({ docId: sc.docId, offset: -1, length: 16 }),
        "invalid_argument",
      );
      await expectDocError(readDoc({ docId: sc.docId, offset: 0, length: 0 }), "invalid_argument");
    } finally {
      await server.close();
    }
  });

  it("invalidates Office-to-PDF conversion cache when source mtime changes and cleans up on close", async () => {
    const fakeDocx = path.join(workDir, "sample.docx");
    writeFileSync(fakeDocx, "initial docx payload", "utf8");

    let conversions = 0;
    const producedPdfs: string[] = [];
    const viewer = createViewerFeature({
      serverId: "word",
      title: "Word 文档",
      viewerHtmlPath: path.join(builtPdfPluginDir, "viewer.html"),
      viewerAssetsDir: path.join(builtPdfPluginDir, "viewer-assets"),
      convertToPdf: (_inputPath, outputPath) => {
        conversions += 1;
        producedPdfs.push(outputPath);
        copyFileSync(HELVETICA_PDF, outputPath);
        return Promise.resolve();
      },
    });

    const show = viewer.handlers.show_in_viewer;
    const readDoc = viewer.handlers.read_document;
    if (!show || !readDoc) throw new Error("Expected viewer handlers");
    const res1 = await show({ path: fakeDocx });
    expect(conversions).toBe(1);
    const firstPdf = producedPdfs[0];
    if (!firstPdf) throw new Error("Expected converted PDF path");
    const cacheDir = path.dirname(firstPdf);
    expect(existsSync(cacheDir)).toBe(true);

    // Same realpath + mtime + size hits cache
    const res2 = await show({ path: fakeDocx });
    expect(conversions).toBe(1);
    expect((res1.structuredContent as { docId: string }).docId).not.toBe(
      (res2.structuredContent as { docId: string }).docId,
    );

    // Updating mtime invalidates cache and triggers reconversion
    const st = statSync(fakeDocx);
    const bumped = new Date(st.mtimeMs + 5000);
    utimesSync(fakeDocx, bumped, bumped);
    await show({ path: fakeDocx });
    expect(conversions).toBe(2);

    // close() removes temporary cache directory and drops handles
    viewer.close();
    expect(existsSync(cacheDir)).toBe(false);
    await expectDocError(
      readDoc({
        docId: (res1.structuredContent as { docId: string }).docId,
        offset: 0,
        length: 64,
      }),
      "document_unknown",
    );
  });

  it("rejects documents exceeding maxDocumentBytes with document_too_large", async () => {
    const bigFile = path.join(workDir, "too-large.pdf");
    writeFileSync(bigFile, Buffer.alloc(2048, 0x20));

    const server = createPdfPluginServer({
      viewerHtmlPath: path.join(builtPdfPluginDir, "viewer.html"),
      viewerAssetsDir: path.join(builtPdfPluginDir, "viewer-assets"),
      maxDocumentBytes: 1024,
    });
    const show = server.handlers.show_in_viewer;
    if (!show) throw new Error("Expected show_in_viewer handler");

    try {
      await expectDocError(show({ path: bigFile }), "document_too_large");
    } finally {
      await server.close();
    }
  });

  it("viewer_asset serves manifest entries and rejects unknown, traversal, or unlicensed names", async () => {
    const server = createPdfPluginServer({
      viewerHtmlPath: path.join(builtPdfPluginDir, "viewer.html"),
      viewerAssetsDir: path.join(builtPdfPluginDir, "viewer-assets"),
    });
    const asset = server.handlers.viewer_asset;
    if (!asset) throw new Error("Expected viewer_asset handler");

    try {
      // Allowed entries succeed
      for (const name of [
        "cmaps/UniGB-UCS2-H.bcmap",
        "standard_fonts/FoxitSerif.pfb",
        "wasm/jbig2.wasm",
        "wasm/openjpeg.wasm",
      ]) {
        const res = await asset({ name });
        const sc = res.structuredContent as { name: string; bytes: number; data: string };
        expect(sc.name).toBe(name);
        expect(sc.bytes).toBeGreaterThan(0);
        expect(Buffer.from(sc.data, "base64").length).toBe(sc.bytes);
      }

      // Disallowed entries are rejected
      for (const badName of [
        "../server.mjs",
        "cmaps/../../package.json",
        "/etc/passwd",
        "cmaps\\UniGB-UCS2-H.bcmap",
        "cmaps/does-not-exist.bcmap",
        "standard_fonts/LiberationSans-Regular.ttf",
        "iccs/CGATS001Compat-v2-micro.icc",
        "manifest.json",
      ]) {
        await expectDocError(asset({ name: badName }), "asset_not_found");
      }
    } finally {
      await server.close();
    }
  });

  it("uses 4 MiB as default read_document chunk limit", () => {
    expect(READ_DOCUMENT_MAX_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("pdfjs-dist BinaryDataFactory offline CJK and standard font paths", () => {
  async function extractPdfTextWithFactory(
    pdfPath: string,
    opts?: { useSystemFonts?: boolean },
  ): Promise<{ text: string; requests: { kind: string; filename: string; assetName: string }[] }> {
    const server = createPdfPluginServer({
      viewerHtmlPath: path.join(builtPdfPluginDir, "viewer.html"),
      viewerAssetsDir: path.join(builtPdfPluginDir, "viewer-assets"),
    });
    const assetHandler = server.handlers.viewer_asset;
    if (!assetHandler) throw new Error("Expected viewer_asset handler");
    const requests: { kind: string; filename: string; assetName: string }[] = [];

    const BinaryDataFactory = createViewerBinaryDataFactory({
      onRequest: (kind, filename, assetName) => {
        requests.push({ kind, filename, assetName });
      },
      fetchAsset: async (assetName: string): Promise<Uint8Array> => {
        const res: CallToolResult = await assetHandler({ name: assetName });
        const sc = res.structuredContent as { data?: string } | undefined;
        if (!sc?.data) {
          throw new Error(`Missing data for ${assetName}`);
        }
        return new Uint8Array(Buffer.from(sc.data, "base64"));
      },
    });

    try {
      const pdfBytes = new Uint8Array(readFileSync(pdfPath));
      const loadingTask = pdfjsLib.getDocument({
        data: pdfBytes,
        useWorkerFetch: false,
        disableWorkerRendering: true,
        useSystemFonts: opts?.useSystemFonts ?? false,
        cMapUrl: "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "standard_fonts/",
        wasmUrl: "wasm/",
        BinaryDataFactory,
      });
      const doc = await loadingTask.promise;
      try {
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
        return { text, requests };
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await server.close();
    }
  }

  it("reads unembedded CJK PDF (STSong-Light + UniGB-UCS2-H) via packaged cMap factory", async () => {
    const { text, requests } = await extractPdfTextWithFactory(CJK_PDF);
    expect(requests.some((r) => r.kind === "cMapUrl" && r.filename === "UniGB-UCS2-H.bcmap")).toBe(
      true,
    );
    expect(text).toContain("你好，文档查看器中文测试。");
    expect(text).toContain("Hello PDF Viewer CJK Test.");
  });

  it("routes unembedded Helvetica and Times-Roman PDFs through standardFontDataUrl factory", async () => {
    // 1. Unembedded Helvetica: pdf.js routes to standardFontDataUrl (LiberationSans-Regular.ttf excluded for GPL-2.0)
    const helv = await extractPdfTextWithFactory(HELVETICA_PDF, { useSystemFonts: false });
    expect(
      helv.requests.some(
        (r) => r.kind === "standardFontDataUrl" && r.filename === "LiberationSans-Regular.ttf",
      ),
    ).toBe(true);
    expect(helv.text).toContain("Hello unembedded Helvetica standard font.");

    // 2. Unembedded Times-Roman: pdf.js routes to standardFontDataUrl -> packaged BSD-3-Clause FoxitSerif.pfb
    const times = await extractPdfTextWithFactory(TIMES_PDF, { useSystemFonts: false });
    expect(
      times.requests.some(
        (r) => r.kind === "standardFontDataUrl" && r.filename === "FoxitSerif.pfb",
      ),
    ).toBe(true);
    expect(times.text).toContain("Hello unembedded Times-Roman standard font.");
  });
});
