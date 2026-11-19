import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { marked } from "marked";

import { LibreOfficeEngine, type LibreOfficeEngineOptions } from "../shared/engine.js";
import { DocPluginError } from "../shared/errors.js";
import { jsonTextResult, PLUGIN_SERVER_VERSION, type PluginServerSpec } from "../shared/mcp.js";
import {
  assertAbsolutePath,
  assertNonEmptyFileProduced,
  assertOutputWritable,
  assertSourceExists,
} from "../shared/paths.js";
import { runPageRender } from "../shared/render.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapHtmlDocument(bodyHtml: string, title?: string): string {
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : "";
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    titleTag,
    "<style>",
    'body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Liberation Sans", sans-serif; line-height: 1.5; }',
    "table { border-collapse: collapse; width: 100%; margin: 8px 0; }",
    "th, td { border: 1px solid #666666; padding: 6px 8px; text-align: left; }",
    "th { background-color: #f0f0f0; font-weight: bold; }",
    "</style>",
    "</head>",
    "<body>",
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

export const WORD_TOOLS: readonly Tool[] = [
  {
    name: "read",
    description:
      "Read paragraphs (with index, text, heading level, and style) and tables from a Word document.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the source Word document (.docx, .doc, .odt).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create",
    description: "Create a new .docx document from Markdown (default) or HTML content.",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Absolute path for the output .docx file." },
        content: { type: "string", description: "Document body in Markdown or HTML." },
        format: {
          type: "string",
          enum: ["markdown", "html"],
          description: 'Input content format: "markdown" (default) or "html".',
        },
        title: { type: "string", description: "Optional HTML document title metadata." },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["outputPath", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a Word document in sequence (replace text, insert/delete paragraph, set heading level, insert table). Saves in place by default or to outputPath.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the Word document to edit." },
        outputPath: {
          type: "string",
          description: "Optional absolute path to save as a new file.",
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing file when outputPath differs from path.",
        },
        operations: {
          type: "array",
          description: "Ordered list of edit operations.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "replace",
                  "insert_paragraph",
                  "delete_paragraph",
                  "set_heading",
                  "insert_table",
                ],
              },
              find: { type: "string" },
              replace: { type: "string" },
              caseSensitive: { type: "boolean" },
              regex: { type: "boolean" },
              text: { type: "string" },
              index: { type: "integer" },
              headingLevel: { type: "integer", minimum: 0, maximum: 6 },
              level: { type: "integer", minimum: 0, maximum: 6 },
              rows: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
              },
              afterParagraph: { type: "integer" },
            },
            required: ["type"],
          },
        },
      },
      required: ["path", "operations"],
    },
  },
  {
    name: "convert",
    description: "Convert a Word document to pdf, odt, html, or utf-8 txt.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the source document." },
        outputPath: { type: "string", description: "Absolute path for the converted output file." },
        format: {
          type: "string",
          enum: ["pdf", "odt", "html", "txt"],
          description: "Target output format.",
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["path", "outputPath", "format"],
    },
  },
  {
    name: "render",
    description:
      'Render Word document pages as PNG images for visual inspection. Defaults to the first 4 pages; pass pages (e.g. "1-4") to select specific pages.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the Word document." },
        pages: {
          type: "string",
          description: 'Optional 1-based page range, e.g. "1", "1-3", "2,4".',
        },
      },
      required: ["path"],
    },
  },
];

export function createWordPluginServer(options?: LibreOfficeEngineOptions): PluginServerSpec {
  const engine = new LibreOfficeEngine(options);

  return {
    name: "word",
    version: PLUGIN_SERVER_VERSION,
    tools: WORD_TOOLS,
    close: () => engine.close(),
    handlers: {
      read: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        const result = await engine.callUno("docx_read", { path: filePath });
        return jsonTextResult(result);
      },

      create: async (args) => {
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        if (typeof args.content !== "string") {
          throw new DocPluginError("invalid_argument", "content must be a string.");
        }
        const format = args.format === undefined ? "markdown" : args.format;
        if (format !== "markdown" && format !== "html") {
          throw new DocPluginError("invalid_argument", 'format must be "markdown" or "html".');
        }
        const title = typeof args.title === "string" ? args.title : undefined;
        const overwrite = args.overwrite === true;
        assertOutputWritable(outputPath, overwrite);

        const bodyHtml =
          format === "html"
            ? args.content
            : marked.parse(args.content, { async: false, gfm: true });
        const fullHtml =
          format === "html" && /<html[\s>]/i.test(bodyHtml)
            ? bodyHtml
            : wrapHtmlDocument(bodyHtml, title);

        const tmpDir = mkdtempSync(path.join(tmpdir(), "nocturne-word-create-"));
        const htmlPath = path.join(tmpDir, "source.html");
        try {
          writeFileSync(htmlPath, fullHtml, "utf8");
          await engine.callUnoOrCliFallback(
            () =>
              engine.callUno(
                "docx_create",
                { htmlPath, outputPath },
                { expectedOutputPath: outputPath },
              ),
            async () => {
              await engine.convertViaCli({
                inputPath: htmlPath,
                convertTo: "docx:MS Word 2007 XML",
                outputPath,
              });
              return { outputPath };
            },
          );
          assertNonEmptyFileProduced(outputPath);
          return jsonTextResult({ outputPath, format });
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      },

      edit: async (args) => {
        const inputPath = assertAbsolutePath(args.path, "path");
        assertSourceExists(inputPath);
        if (!Array.isArray(args.operations) || args.operations.length === 0) {
          throw new DocPluginError("invalid_argument", "operations must be a non-empty array.");
        }
        const targetPath =
          args.outputPath !== undefined
            ? assertAbsolutePath(args.outputPath, "outputPath")
            : inputPath;
        if (targetPath !== inputPath) {
          assertOutputWritable(targetPath, args.overwrite === true);
        }
        const result = await engine.callUno(
          "docx_edit",
          { path: inputPath, outputPath: targetPath, operations: args.operations },
          { expectedOutputPath: targetPath },
        );
        return jsonTextResult(result);
      },

      convert: async (args) => {
        const inputPath = assertAbsolutePath(args.path, "path");
        assertSourceExists(inputPath);
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        const format = args.format;
        if (format !== "pdf" && format !== "odt" && format !== "html" && format !== "txt") {
          throw new DocPluginError(
            "invalid_argument",
            'format must be one of "pdf", "odt", "html", "txt".',
          );
        }
        assertOutputWritable(outputPath, args.overwrite === true);

        const cliFormatMap: Record<typeof format, string> = {
          pdf: "pdf:writer_pdf_Export",
          odt: "odt:writer8",
          html: "html:HTML (StarWriter)",
          txt: "txt:Text (encoded):UTF8",
        };

        const result = await engine.callUnoOrCliFallback(
          () =>
            engine.callUno(
              "docx_convert",
              { path: inputPath, outputPath, format },
              { expectedOutputPath: outputPath },
            ),
          async () => {
            await engine.convertViaCli({
              inputPath,
              convertTo: cliFormatMap[format],
              outputPath,
              stripUtf8Bom: format === "txt",
            });
            return { outputPath, format };
          },
        );
        return jsonTextResult(result);
      },

      render: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        return runPageRender(engine, "docx_render", filePath, args.pages);
      },
    },
  };
}
