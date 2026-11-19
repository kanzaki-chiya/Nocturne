import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument } from "pdf-lib";

import { LibreOfficeEngine, type LibreOfficeEngineOptions } from "../shared/engine.js";
import { DocPluginError } from "../shared/errors.js";
import { jsonTextResult, PLUGIN_SERVER_VERSION, type PluginServerSpec } from "../shared/mcp.js";
import {
  assertAbsolutePath,
  assertNonEmptyFileProduced,
  assertOutputWritable,
  assertSourceExists,
  parsePageRange,
} from "../shared/paths.js";
import { runPageRender } from "../shared/render.js";

export const PDF_TOOLS: readonly Tool[] = [
  {
    name: "create",
    description:
      "Generate a PDF from a docx, xlsx, pptx, html, or other LibreOffice-supported document.",
    inputSchema: {
      type: "object",
      properties: {
        inputPath: {
          type: "string",
          description: "Absolute path to the source document (.docx, .xlsx, .pptx, .html, etc.).",
        },
        outputPath: { type: "string", description: "Absolute path for the generated .pdf file." },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["inputPath", "outputPath"],
    },
  },
  {
    name: "read",
    description:
      "Extract text from a PDF page by page, optionally limited to a 1-based page range.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the PDF file." },
        pages: {
          type: "string",
          description: 'Optional 1-based page range, e.g. "1", "1-3", "2,4".',
        },
      },
      required: ["path"],
    },
  },
  {
    name: "render",
    description:
      'Render PDF pages as PNG images for visual inspection. Defaults to the first 4 pages; pass pages (e.g. "1-4") to select specific pages.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the PDF file." },
        pages: {
          type: "string",
          description: 'Optional 1-based page range, e.g. "1", "1-3", "2,4".',
        },
      },
      required: ["path"],
    },
  },
  {
    name: "merge",
    description: "Merge multiple PDF files losslessly into a single PDF.",
    inputSchema: {
      type: "object",
      properties: {
        inputPaths: {
          type: "array",
          minItems: 2,
          items: { type: "string" },
          description: "Ordered list of absolute paths to the PDF files to merge.",
        },
        outputPath: { type: "string", description: "Absolute path for the merged .pdf file." },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["inputPaths", "outputPath"],
    },
  },
  {
    name: "split",
    description: "Extract a 1-based page range from a PDF into a new PDF file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the source PDF file." },
        pages: {
          type: "string",
          description: '1-based page range to extract, e.g. "1-2", "2,4-6", "3".',
        },
        outputPath: { type: "string", description: "Absolute path for the extracted .pdf file." },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["path", "pages", "outputPath"],
    },
  },
];

export function createPdfPluginServer(options?: LibreOfficeEngineOptions): PluginServerSpec {
  const engine = new LibreOfficeEngine(options);

  return {
    name: "pdf",
    version: PLUGIN_SERVER_VERSION,
    tools: PDF_TOOLS,
    close: () => engine.close(),
    handlers: {
      create: async (args) => {
        const inputPath = assertAbsolutePath(args.inputPath, "inputPath");
        assertSourceExists(inputPath, "inputPath");
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        assertOutputWritable(outputPath, args.overwrite === true);

        const result = await engine.callUnoOrCliFallback(
          () =>
            engine.callUno(
              "pdf_create",
              { inputPath, outputPath },
              { expectedOutputPath: outputPath },
            ),
          async () => {
            await engine.convertViaCli({
              inputPath,
              convertTo: "pdf",
              outputPath,
            });
            return { outputPath };
          },
        );
        return jsonTextResult(result);
      },

      read: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        const parsedPages = parsePageRange(args.pages);
        const result = await engine.callUno("pdf_read", {
          path: filePath,
          ...(parsedPages ? { pages: parsedPages } : {}),
        });
        return jsonTextResult(result);
      },

      render: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        return runPageRender(engine, "pdf_render", filePath, args.pages);
      },

      merge: async (args) => {
        if (!Array.isArray(args.inputPaths) || args.inputPaths.length < 2) {
          throw new DocPluginError(
            "invalid_argument",
            "inputPaths must be an array of at least 2 absolute PDF file paths.",
          );
        }
        const resolvedInputs = args.inputPaths.map((p, idx) => {
          const abs = assertAbsolutePath(p, `inputPaths[${idx}]`);
          assertSourceExists(abs, `inputPaths[${idx}]`);
          return abs;
        });
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        assertOutputWritable(outputPath, args.overwrite === true);

        const merged = await PDFDocument.create();
        for (const srcPath of resolvedInputs) {
          const bytes = readFileSync(srcPath);
          const srcDoc = await PDFDocument.load(bytes);
          const indices = srcDoc.getPageIndices();
          const copied = await merged.copyPages(srcDoc, indices);
          for (const page of copied) {
            merged.addPage(page);
          }
        }
        const outBytes = await merged.save();
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, outBytes);
        assertNonEmptyFileProduced(outputPath);
        return jsonTextResult({
          outputPath,
          inputCount: resolvedInputs.length,
          totalPages: merged.getPageCount(),
        });
      },

      split: async (args) => {
        const inputPath = assertAbsolutePath(args.path, "path");
        assertSourceExists(inputPath);
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        assertOutputWritable(outputPath, args.overwrite === true);
        const selected = parsePageRange(args.pages);
        if (!selected || selected.length === 0) {
          throw new DocPluginError("invalid_argument", "pages is required for split.");
        }

        const srcBytes = readFileSync(inputPath);
        const srcDoc = await PDFDocument.load(srcBytes);
        const totalPages = srcDoc.getPageCount();
        for (const p of selected) {
          if (p < 1 || p > totalPages) {
            throw new DocPluginError(
              "invalid_argument",
              `Page ${p} is out of range (PDF has ${totalPages} page(s)).`,
            );
          }
        }

        const outDoc = await PDFDocument.create();
        const copied = await outDoc.copyPages(
          srcDoc,
          selected.map((p) => p - 1),
        );
        for (const page of copied) {
          outDoc.addPage(page);
        }
        const outBytes = await outDoc.save();
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, outBytes);
        assertNonEmptyFileProduced(outputPath);
        return jsonTextResult({
          outputPath,
          sourcePages: totalPages,
          extractedPages: selected,
        });
      },
    },
  };
}
