import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { LibreOfficeEngine, type LibreOfficeEngineOptions } from "../shared/engine.js";
import { DocPluginError } from "../shared/errors.js";
import { jsonTextResult, PLUGIN_SERVER_VERSION, type PluginServerSpec } from "../shared/mcp.js";
import { assertAbsolutePath, assertOutputWritable, assertSourceExists } from "../shared/paths.js";
import { runPageRender } from "../shared/render.js";

function validateSlideImagePaths(items: unknown[]): void {
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (rec.imagePath !== undefined) {
      const imgPath = assertAbsolutePath(rec.imagePath, "imagePath");
      assertSourceExists(imgPath, "imagePath");
    }
  }
}

export const SLIDES_TOOLS: readonly Tool[] = [
  {
    name: "read",
    description: "Read total slide count and each slide's text content and speaker notes.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the presentation (.pptx, .ppt, .odp).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create",
    description:
      "Create a new .pptx presentation from slide definitions (title, bullets/body, optional local image, and speaker notes).",
    inputSchema: {
      type: "object",
      properties: {
        outputPath: { type: "string", description: "Absolute path for the output .pptx file." },
        slides: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Slide title." },
              bullets: {
                type: "array",
                items: { type: "string" },
                description: "Bullet points for the slide body.",
              },
              body: { type: "string", description: "Additional body text." },
              imagePath: {
                type: "string",
                description: "Optional absolute path to a local image to embed on the slide.",
              },
              notes: { type: "string", description: "Optional speaker notes." },
            },
          },
        },
        overwrite: {
          type: "boolean",
          description: "Set true to overwrite an existing output file.",
        },
      },
      required: ["outputPath", "slides"],
    },
  },
  {
    name: "edit",
    description:
      "Edit a presentation in sequence (replace text, add slide, delete slide, reorder slides). Saves in place by default or to outputPath.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the presentation to edit." },
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
                enum: ["replace", "add_slide", "delete_slide", "reorder_slides"],
              },
              find: { type: "string" },
              replace: { type: "string" },
              caseSensitive: { type: "boolean" },
              slide: { type: "integer", minimum: 1 },
              index: { type: "integer", minimum: 1 },
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              body: { type: "string" },
              imagePath: { type: "string" },
              notes: { type: "string" },
              order: {
                type: "array",
                items: { type: "integer", minimum: 1 },
                description: "1-based permutation of slide numbers for reorder_slides.",
              },
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
    description: "Convert a presentation to pdf or odp.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the source presentation." },
        outputPath: { type: "string", description: "Absolute path for the converted output file." },
        format: {
          type: "string",
          enum: ["pdf", "odp"],
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
      'Render presentation slides as PNG images for visual inspection. Defaults to the first 4 slides; pass pages (e.g. "1-4") to select specific slides.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the presentation." },
        pages: {
          type: "string",
          description: 'Optional 1-based slide range, e.g. "1", "1-3", "2,4".',
        },
      },
      required: ["path"],
    },
  },
];

export function createSlidesPluginServer(options?: LibreOfficeEngineOptions): PluginServerSpec {
  const engine = new LibreOfficeEngine(options);

  return {
    name: "slides",
    version: PLUGIN_SERVER_VERSION,
    tools: SLIDES_TOOLS,
    close: () => engine.close(),
    handlers: {
      read: async (args) => {
        const filePath = assertAbsolutePath(args.path, "path");
        assertSourceExists(filePath);
        const result = await engine.callUno("pptx_read", { path: filePath });
        return jsonTextResult(result);
      },

      create: async (args) => {
        const outputPath = assertAbsolutePath(args.outputPath, "outputPath");
        if (!Array.isArray(args.slides) || args.slides.length === 0) {
          throw new DocPluginError("invalid_argument", "slides must be a non-empty array.");
        }
        validateSlideImagePaths(args.slides);
        assertOutputWritable(outputPath, args.overwrite === true);
        const result = await engine.callUno(
          "pptx_create",
          { outputPath, slides: args.slides },
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
        validateSlideImagePaths(args.operations);
        const targetPath =
          args.outputPath !== undefined
            ? assertAbsolutePath(args.outputPath, "outputPath")
            : inputPath;
        if (targetPath !== inputPath) {
          assertOutputWritable(targetPath, args.overwrite === true);
        }
        const result = await engine.callUno(
          "pptx_edit",
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
        if (format !== "pdf" && format !== "odp") {
          throw new DocPluginError("invalid_argument", 'format must be "pdf" or "odp".');
        }
        assertOutputWritable(outputPath, args.overwrite === true);
        const cliConvertTo = format === "pdf" ? "pdf:impress_pdf_Export" : "odp:impress8";
        const result = await engine.callUnoOrCliFallback(
          () =>
            engine.callUno(
              "pptx_convert",
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
        return runPageRender(engine, "pptx_render", filePath, args.pages);
      },
    },
  };
}
