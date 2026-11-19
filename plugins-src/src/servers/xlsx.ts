import path from "node:path";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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

const CALC_CSV_ALL_SHEETS_FILTER =
  "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1";

export const SHEETS_TOOLS: readonly Tool[] = [
  {
    name: "read",
    description:
      "List all worksheets in a spreadsheet and read evaluated values and formulas from a sheet and optional A1 range.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the spreadsheet (.xlsx, .xls, .ods).",
        },
        sheet: {
          type: "string",
          description: "Optional worksheet name (defaults to the first sheet).",
        },
        range: {
          type: "string",
          description: 'Optional A1 range such as "A1:F20" (defaults to used area).',
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create",
    description:
      "Create a new .xlsx workbook from sheet definitions and row data. Strings starting with '=' are written as formulas and recalculated.",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Absolute path for the output .xlsx file." },
        sheets: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Worksheet name." },
              rows: {
                type: "array",
                items: {
                  type: "array",
                  items: { type: ["string", "number", "boolean", "null"] },
                },
              },
            },
            required: ["name", "rows"],
          },
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["outputPath", "sheets"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a spreadsheet in sequence (set cell values/formulas, insert/delete rows or columns, add/delete/rename sheets) and recalculate formulas.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the spreadsheet to edit." },
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
                  "set_cells",
                  "insert_rows",
                  "delete_rows",
                  "insert_columns",
                  "delete_columns",
                  "add_sheet",
                  "delete_sheet",
                  "rename_sheet",
                ],
              },
              sheet: { type: "string" },
              cells: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    cell: { type: "string" },
                    value: { type: ["string", "number", "boolean", "null"] },
                    formula: { type: "string" },
                  },
                  required: ["cell"],
                },
              },
              index: { type: "integer", minimum: 0 },
              count: { type: "integer", minimum: 1 },
              name: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["type"],
          },
        },
      },
      required: ["path", "operations"],
    },
  },
  {
    name: "recalculate",
    description: "Recalculate all formulas in a workbook and save the updated values.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the spreadsheet." },
        outputPath: {
          type: "string",
          description: "Optional absolute path to save as a new file.",
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing file when outputPath differs from path.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "convert",
    description:
      "Convert a spreadsheet to pdf, ods, or csv (exports every worksheet as <stem>-<sheet>.csv).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the source spreadsheet." },
        outputPath: {
          type: "string",
          description:
            "Absolute output file path for pdf/ods, or output directory (or .csv base path) for csv.",
        },
        format: {
          type: "string",
          enum: ["pdf", "csv", "ods"],
          description: "Target output format.",
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite existing output file(s).",
        },
      },
      required: ["path", "outputPath", "format"],
    },
  },
  {
    name: "render",
    description:
      'Render spreadsheet pages as PNG images for visual inspection. Defaults to the first 4 pages; pass pages (e.g. "1-4") to select specific pages.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the spreadsheet." },
        pages: {
          type: "string",
          description: 'Optional 1-based page range, e.g. "1", "1-3", "2,4".',
        },
      },
      required: ["path"],
    },
  },
];

export function createSheetsPluginServer(options?: LibreOfficeEngineOptions): PluginServerSpec {
  const engine = new LibreOfficeEngine(options);

  return {
    name: "sheets",
    version: PLUGIN_SERVER_VERSION,
    tools: SHEETS_TOOLS,
    close: () => engine.close(),
    handlers: {
      read: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        const sheet =
          typeof args.sheet === "string" && args.sheet.length > 0 ? args.sheet : undefined;
        const range =
          typeof args.range === "string" && args.range.length > 0 ? args.range : undefined;
        const result = await engine.callUno("xlsx_read", {
          path: filePath,
          ...(sheet !== undefined ? { sheet } : {}),
          ...(range !== undefined ? { range } : {}),
        });
        return jsonTextResult(result);
      },

      create: async (args) => {
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        if (!Array.isArray(args.sheets) || args.sheets.length === 0) {
          throw new DocPluginError("invalid_argument", "sheets must be a non-empty array.");
        }
        assertOutputWritable(outputPath, args.overwrite === true);
        const result = await engine.callUno(
          "xlsx_create",
          { outputPath, sheets: args.sheets },
          { expectedOutputPath: outputPath },
        );
        return jsonTextResult(result);
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
          "xlsx_edit",
          { path: inputPath, outputPath: targetPath, operations: args.operations },
          { expectedOutputPath: targetPath },
        );
        return jsonTextResult(result);
      },

      recalculate: async (args) => {
        const inputPath = assertAbsolutePath(args.path, "path");
        assertSourceExists(inputPath);
        const targetPath =
          args.outputPath !== undefined
            ? assertAbsolutePath(args.outputPath, "outputPath")
            : inputPath;
        if (targetPath !== inputPath) {
          assertOutputWritable(targetPath, args.overwrite === true);
        }
        const result = await engine.callUno(
          "xlsx_recalculate",
          { path: inputPath, outputPath: targetPath },
          { expectedOutputPath: targetPath },
        );
        return jsonTextResult(result);
      },

      convert: async (args) => {
        const inputPath = assertAbsolutePath(args.path, "path");
        assertSourceExists(inputPath);
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        const format = args.format;
        const overwrite = args.overwrite === true;

        if (format !== "pdf" && format !== "csv" && format !== "ods") {
          throw new DocPluginError("invalid_argument", 'format must be "pdf", "csv", or "ods".');
        }

        if (format === "csv") {
          const isCsvPath = outputPath.toLowerCase().endsWith(".csv");
          const outDir = isCsvPath ? path.dirname(outputPath) : outputPath;
          const stem = isCsvPath
            ? path.basename(outputPath, path.extname(outputPath))
            : path.basename(inputPath, path.extname(inputPath));

          const result = await engine.callUnoOrCliFallback(
            async () => {
              const res = await engine.callUno<{ outputPaths: string[]; format: string }>(
                "xlsx_convert",
                { path: inputPath, outputPath, format: "csv", outDir, stem, overwrite },
              );
              for (const p of res.outputPaths) {
                assertNonEmptyFileProduced(p);
              }
              return res;
            },
            async () => {
              const res = await engine.convertViaCli({
                inputPath,
                convertTo: CALC_CSV_ALL_SHEETS_FILTER,
                multiOutputDir: outDir,
                multiOutputExt: ".csv",
                overwrite,
              });
              return { outputPaths: res.outputPaths, format: "csv" };
            },
          );
          return jsonTextResult(result);
        }

        assertOutputWritable(outputPath, overwrite);
        const cliConvertTo = format === "pdf" ? "pdf:calc_pdf_Export" : "ods:calc8";
        const result = await engine.callUnoOrCliFallback(
          () =>
            engine.callUno(
              "xlsx_convert",
              { path: inputPath, outputPath, format },
              { expectedOutputPath: outputPath },
            ),
          async () => {
            await engine.convertViaCli({
              inputPath,
              convertTo: cliConvertTo,
              outputPath,
            });
            return { outputPath, format };
          },
        );
        return jsonTextResult(result);
      },

      render: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        return runPageRender(engine, "xlsx_render", filePath, args.pages);
      },
    },
  };
}
