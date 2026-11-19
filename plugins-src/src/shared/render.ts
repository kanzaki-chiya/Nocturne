import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { LibreOfficeEngine } from "./engine.js";
import { assertNonEmptyFileProduced, parsePageRange } from "./paths.js";

/** Default and per-call cap matching Nocturne MCP client's 4-image attachment budget. */
export const DEFAULT_RENDER_MAX_PAGES = 4;

interface EngineRenderResult {
  totalPages: number;
  renderedPages: { page: number; path: string }[];
}

export async function runPageRender(
  engine: LibreOfficeEngine,
  op: "docx_render" | "xlsx_render" | "pptx_render" | "pdf_render",
  filePath: string,
  rawPages: unknown,
): Promise<CallToolResult> {
  const parsed = parsePageRange(rawPages);
  let capped = false;
  let requested = parsed;
  if (requested && requested.length > DEFAULT_RENDER_MAX_PAGES) {
    requested = requested.slice(0, DEFAULT_RENDER_MAX_PAGES);
    capped = true;
  }

  const outDir = mkdtempSync(path.join(tmpdir(), "nocturne-doc-render-"));
  try {
    const res = await engine.callUno<EngineRenderResult>(op, {
      path: filePath,
      outDir,
      ...(requested ? { pages: requested } : {}),
    });

    const pageNumbers = res.renderedPages.map((p) => p.page);
    const summaryParts = [
      `Rendered ${pageNumbers.length} of ${res.totalPages} page(s): [${pageNumbers.join(", ")}].`,
    ];
    if (capped) {
      summaryParts.push(
        `Returned the first ${DEFAULT_RENDER_MAX_PAGES} pages of the requested range; call render again with pages to inspect more.`,
      );
    } else if (!parsed && res.totalPages > DEFAULT_RENDER_MAX_PAGES) {
      summaryParts.push(
        `Default render returns up to ${DEFAULT_RENDER_MAX_PAGES} pages; pass pages (e.g. "${DEFAULT_RENDER_MAX_PAGES + 1}-${Math.min(res.totalPages, DEFAULT_RENDER_MAX_PAGES * 2)}") for remaining pages.`,
      );
    }

    const content: CallToolResult["content"] = [{ type: "text", text: summaryParts.join(" ") }];
    for (const item of res.renderedPages) {
      assertNonEmptyFileProduced(item.path);
      const data = readFileSync(item.path).toString("base64");
      content.push({
        type: "image",
        data,
        mimeType: "image/png",
      });
    }
    return { content };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
