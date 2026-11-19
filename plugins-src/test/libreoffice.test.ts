import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWordPluginServer } from "../src/servers/docx.js";
import { createPdfPluginServer } from "../src/servers/pdf.js";
import { createSlidesPluginServer } from "../src/servers/pptx.js";
import { createSheetsPluginServer } from "../src/servers/xlsx.js";
import { findPython, findSoffice } from "../src/shared/discovery.js";
import type { PluginServerSpec } from "../src/shared/mcp.js";

function detectRealLibreOfficeUno(): boolean {
  try {
    const soffice = findSoffice();
    const python = findPython(soffice);
    execFileSync(python, ["-c", "import uno"], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

const HAS_REAL_LIBREOFFICE = detectRealLibreOfficeUno();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function callTool(
  server: PluginServerSpec,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const handler = server.handlers[name];
  if (!handler) throw new Error(`Unknown tool handler: ${name}`);
  return handler(args);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(tag: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tagBuf = Buffer.from(tag, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([tagBuf, data])), 0);
  return Buffer.concat([len, tagBuf, data, crcBuf]);
}

/** Generate a minimal valid RGBA PNG fixture in memory without binary repo assets. */
function writeSamplePng(filePath: string): void {
  const width = 160;
  const height = 100;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px] = 37;
      raw[px + 1] = 99;
      raw[px + 2] = 235;
      raw[px + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    PNG_MAGIC,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(filePath, png);
}

function parseJsonResult<T>(res: CallToolResult): T {
  const textBlock = res.content.find((c) => c.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";
  expect(text.length).toBeGreaterThan(0);
  return JSON.parse(text) as T;
}

function extractFirstPng(res: CallToolResult): Buffer {
  const img = res.content.find((c) => c.type === "image");
  expect(img).toBeDefined();
  expect(img?.type === "image" ? img.mimeType : undefined).toBe("image/png");
  const buf = Buffer.from(img?.type === "image" ? img.data : "", "base64");
  expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  expect(buf.length).toBeGreaterThan(500);
  return buf;
}

function maybeSaveShot(name: string, png: Buffer): void {
  const shotsDir = process.env.NOCTURNE_SAVE_SHOTS_DIR;
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  writeFileSync(path.join(shotsDir, name), png);
}

describe.skipIf(!HAS_REAL_LIBREOFFICE)("Real LibreOffice end-to-end chains", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "nocturne-real-lo-"));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("docx: create -> read -> edit -> read -> render -> convert (pdf/odt/html/txt)", async () => {
    const server = createWordPluginServer();
    const docxPath = path.join(workDir, "季度报告.docx");
    const pdfPath = path.join(workDir, "季度报告.pdf");
    const odtPath = path.join(workDir, "季度报告.odt");
    const htmlPath = path.join(workDir, "季度报告.html");
    const txtPath = path.join(workDir, "季度报告.txt");

    try {
      // 1. Create from Markdown with Chinese content and a table
      await callTool(server, "create", {
        outputPath: docxPath,
        content: [
          "# 2026年第四季度研发总结",
          "",
          "本季度核心目标：待替换状态。",
          "",
          "待删除的草稿段落。",
          "",
          "| 模块 | 负责人 | 进度 |",
          "| --- | --- | --- |",
          "| 文档插件 | 小明 | 95% |",
        ].join("\n"),
      });
      expect(existsSync(docxPath)).toBe(true);

      // 2. Read & verify initial structure
      const initial = parseJsonResult<{
        paragraphs: { index: number; text: string; headingLevel: number }[];
        tables: { index: number; rows: string[][] }[];
      }>(await callTool(server, "read", { path: docxPath }));
      expect(
        initial.paragraphs.some(
          (p) => p.text.includes("2026年第四季度研发总结") && p.headingLevel === 1,
        ),
      ).toBe(true);
      expect(initial.tables).toHaveLength(1);
      expect(initial.tables[0]?.rows[1]).toEqual(["文档插件", "小明", "95%"]);

      const draftPara = initial.paragraphs.find((p) => p.text.includes("待删除的草稿段落"));
      if (!draftPara) throw new Error("Expected draft paragraph in initial docx");

      // 3. Edit: replace text, delete draft paragraph, insert heading & paragraph, set heading, insert table
      await callTool(server, "edit", {
        path: docxPath,
        operations: [
          { type: "replace", find: "待替换状态", replace: "已按期完成" },
          { type: "delete_paragraph", index: draftPara.index },
          { type: "insert_paragraph", text: "下季度计划", headingLevel: 0 },
          { type: "insert_paragraph", text: "完善四个内置文档插件的端到端验收。" },
          {
            type: "insert_table",
            rows: [
              ["阶段", "交付物"],
              ["一期", "四个内置文档插件"],
            ],
          },
        ],
      });

      const afterInsert = parseJsonResult<{
        paragraphs: { index: number; text: string; headingLevel: number }[];
        tables: { index: number; rows: string[][] }[];
      }>(await callTool(server, "read", { path: docxPath }));

      const planPara = afterInsert.paragraphs.find((p) => p.text === "下季度计划");
      if (!planPara) throw new Error("Expected plan paragraph after insert");
      await callTool(server, "edit", {
        path: docxPath,
        operations: [{ type: "set_heading", index: planPara.index, level: 2 }],
      });

      // 4. Re-read & verify all edits
      const verified = parseJsonResult<{
        paragraphs: { index: number; text: string; headingLevel: number }[];
        tables: { index: number; rows: string[][] }[];
      }>(await callTool(server, "read", { path: docxPath }));
      const allText = verified.paragraphs.map((p) => p.text).join("\n");
      expect(allText).toContain("已按期完成");
      expect(allText).not.toContain("待替换状态");
      expect(allText).not.toContain("待删除的草稿段落");
      expect(verified.paragraphs.some((p) => p.text === "下季度计划" && p.headingLevel === 2)).toBe(
        true,
      );
      expect(verified.tables.length).toBeGreaterThanOrEqual(2);

      // 5. Render page PNG
      const renderRes = await callTool(server, "render", { path: docxPath, pages: "1" });
      const png = extractFirstPng(renderRes);
      maybeSaveShot("docx.png", png);

      // 6. Convert to pdf, odt, html, txt
      await callTool(server, "convert", { path: docxPath, outputPath: pdfPath, format: "pdf" });
      await callTool(server, "convert", { path: docxPath, outputPath: odtPath, format: "odt" });
      await callTool(server, "convert", { path: docxPath, outputPath: htmlPath, format: "html" });
      await callTool(server, "convert", { path: docxPath, outputPath: txtPath, format: "txt" });

      expect(existsSync(pdfPath)).toBe(true);
      expect(existsSync(odtPath)).toBe(true);
      expect(existsSync(htmlPath)).toBe(true);
      const txtContent = readFileSync(txtPath, "utf8");
      expect(txtContent).toContain("2026年第四季度研发总结");
      expect(txtContent).toContain("已按期完成");
    } finally {
      await server.close();
    }
  });

  it("xlsx: create -> read -> edit -> recalculate -> read -> render -> convert (pdf/csv/ods)", async () => {
    const server = createSheetsPluginServer();
    const xlsxPath = path.join(workDir, "销售报表.xlsx");
    const pdfPath = path.join(workDir, "销售报表.pdf");
    const odsPath = path.join(workDir, "销售报表.ods");
    const csvDir = path.join(workDir, "csv-out");

    try {
      // 1. Create workbook with Chinese sheet name and formula
      await callTool(server, "create", {
        outputPath: xlsxPath,
        sheets: [
          {
            name: "销售明细",
            rows: [
              ["商品名称", "单价", "销量", "金额"],
              ["无线键盘", 299, 10, "=B2*C2"],
              ["显示器", 1899, 4, "=B3*C3"],
              ["合计", "", "", "=SUM(D2:D3)"],
            ],
          },
          {
            name: "备注",
            rows: [
              ["说明", "货币单位"],
              ["第四季度统计", "人民币"],
            ],
          },
        ],
      });

      // 2. Read & verify values + formulas
      const initial = parseJsonResult<{
        sheets: { name: string }[];
        values: (string | number)[][];
        formulas: string[][];
      }>(await callTool(server, "read", { path: xlsxPath, sheet: "销售明细", range: "A1:D4" }));
      expect(initial.sheets.map((s) => s.name)).toEqual(["销售明细", "备注"]);
      expect(initial.values[1]?.[3]).toBe(2990);
      expect(initial.values[3]?.[3]).toBe(10586);
      expect(initial.formulas[1]?.[3]).toBe("=B2*C2");

      // 3. Edit: update cell, insert/delete row, add/rename/delete sheet
      await callTool(server, "edit", {
        path: xlsxPath,
        operations: [
          { type: "set_cells", sheet: "销售明细", cells: [{ cell: "C2", value: 20 }] },
          { type: "add_sheet", name: "临时表" },
          { type: "rename_sheet", from: "临时表", to: "待删表" },
          { type: "delete_sheet", name: "待删表" },
          { type: "insert_rows", sheet: "备注", index: 2, count: 1 },
          { type: "set_cells", sheet: "备注", cells: [{ cell: "A3", value: "补充行" }] },
          { type: "delete_rows", sheet: "备注", index: 2, count: 1 },
        ],
      });

      // 4. Explicit recalculate & re-read
      await callTool(server, "recalculate", { path: xlsxPath });
      const verified = parseJsonResult<{
        sheets: { name: string }[];
        values: (string | number)[][];
      }>(await callTool(server, "read", { path: xlsxPath, sheet: "销售明细", range: "A1:D4" }));
      expect(verified.sheets.map((s) => s.name)).toEqual(["销售明细", "备注"]);
      expect(verified.values[1]?.[3]).toBe(5980);
      expect(verified.values[3]?.[3]).toBe(13576);

      // 5. Render PNG
      const renderRes = await callTool(server, "render", { path: xlsxPath, pages: "1" });
      const png = extractFirstPng(renderRes);
      maybeSaveShot("xlsx.png", png);

      // 6. Convert to pdf, ods, and multi-sheet csv
      await callTool(server, "convert", { path: xlsxPath, outputPath: pdfPath, format: "pdf" });
      await callTool(server, "convert", { path: xlsxPath, outputPath: odsPath, format: "ods" });
      const csvRes = parseJsonResult<{ outputPaths: string[] }>(
        await callTool(server, "convert", { path: xlsxPath, outputPath: csvDir, format: "csv" }),
      );
      expect(existsSync(pdfPath)).toBe(true);
      expect(existsSync(odsPath)).toBe(true);
      expect(csvRes.outputPaths).toHaveLength(2);
      const joinedCsv = csvRes.outputPaths.map((p) => readFileSync(p, "utf8")).join("\n");
      expect(joinedCsv).toContain("无线键盘");
      expect(joinedCsv).toContain("13576");
      expect(joinedCsv).toContain("人民币");
    } finally {
      await server.close();
    }
  });

  it("pptx: create (with image & notes) -> read -> edit (replace/add/reorder/delete) -> read -> render -> convert", async () => {
    const server = createSlidesPluginServer();
    const pptxPath = path.join(workDir, "产品演示.pptx");
    const pdfPath = path.join(workDir, "产品演示.pdf");
    const odpPath = path.join(workDir, "产品演示.odp");
    const sampleImg = path.join(workDir, "banner.png");
    writeSamplePng(sampleImg);

    try {
      // 1. Create presentation with 2 slides, embedded PNG, and speaker notes
      await callTool(server, "create", {
        outputPath: pptxPath,
        slides: [
          {
            title: "Nocturne 文档插件概览",
            bullets: ["支持 Word、表格、演示与 PDF", "版本：草稿版"],
            imagePath: sampleImg,
            notes: "第一页演讲备注：介绍四个内置插件。",
          },
          {
            title: "核心能力亮点",
            bullets: ["中文排版与公式重算", "按页出图辅助视觉自查"],
            notes: "第二页演讲备注：强调视觉验收流程。",
          },
        ],
      });

      // 2. Read & verify
      const initial = parseJsonResult<{
        totalSlides: number;
        slides: { slide: number; texts: string[]; notes: string }[];
      }>(await callTool(server, "read", { path: pptxPath }));
      expect(initial.totalSlides).toBe(2);
      expect(initial.slides[0]?.texts.join("\n")).toContain("Nocturne 文档插件概览");
      expect(initial.slides[0]?.notes).toContain("第一页演讲备注");

      // 3. Edit: replace text, add 3rd slide, reorder [3, 1, 2], then delete slide 3
      await callTool(server, "edit", {
        path: pptxPath,
        operations: [
          { type: "replace", find: "草稿版", replace: "正式发布版" },
          {
            type: "add_slide",
            title: "封面：2026 年度汇报",
            bullets: ["主讲人：研发团队", "开场总览"],
          },
          { type: "reorder_slides", order: [3, 1, 2] },
          { type: "delete_slide", slide: 3 },
        ],
      });

      // 4. Re-read & verify new order, replacement, and deletion
      const verified = parseJsonResult<{
        totalSlides: number;
        slides: { slide: number; texts: string[]; notes: string }[];
      }>(await callTool(server, "read", { path: pptxPath }));
      expect(verified.totalSlides).toBe(2);
      expect(verified.slides[0]?.texts.join("\n")).toContain("封面：2026 年度汇报");
      expect(verified.slides[1]?.texts.join("\n")).toContain("正式发布版");
      expect(verified.slides[1]?.texts.join("\n")).not.toContain("草稿版");

      // 5. Render slide 2 (the slide with Chinese title, bullets, and embedded image)
      const renderRes = await callTool(server, "render", { path: pptxPath, pages: "2" });
      const png = extractFirstPng(renderRes);
      maybeSaveShot("pptx.png", png);

      // 6. Convert to pdf & odp
      await callTool(server, "convert", { path: pptxPath, outputPath: pdfPath, format: "pdf" });
      await callTool(server, "convert", { path: pptxPath, outputPath: odpPath, format: "odp" });
      expect(existsSync(pdfPath)).toBe(true);
      expect(existsSync(odpPath)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("pdf: create (from html/docx) -> read -> render -> merge -> split", async () => {
    const server = createPdfPluginServer();
    const html1 = path.join(workDir, "part1.html");
    const html2 = path.join(workDir, "part2.html");
    const pdf1 = path.join(workDir, "part1.pdf");
    const pdf2 = path.join(workDir, "part2.pdf");
    const mergedPdf = path.join(workDir, "merged.pdf");
    const splitPdf = path.join(workDir, "split-page2.pdf");

    writeFileSync(
      html1,
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei",sans-serif;}</style></head><body><h1>第一部分：系统架构</h1><p>这是用于测试 PDF 生成、文本提取与合并的中文第一页。</p></body></html>',
      "utf8",
    );
    writeFileSync(
      html2,
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:"Microsoft YaHei",sans-serif;}</style></head><body><h1>第二部分：验收结论</h1><p>这是合并后位于第二页的中文内容，用于验证按页拆分。</p></body></html>',
      "utf8",
    );

    try {
      // 1. Generate PDFs from HTML
      await callTool(server, "create", { inputPath: html1, outputPath: pdf1 });
      await callTool(server, "create", { inputPath: html2, outputPath: pdf2 });
      expect(existsSync(pdf1)).toBe(true);
      expect(existsSync(pdf2)).toBe(true);

      // 2. Merge the two PDFs
      const mergeInfo = parseJsonResult<{ totalPages: number }>(
        await callTool(server, "merge", { inputPaths: [pdf1, pdf2], outputPath: mergedPdf }),
      );
      expect(mergeInfo.totalPages).toBe(2);

      // 3. Extract text page by page from merged PDF
      const extracted = parseJsonResult<{
        totalPages: number;
        pages: { page: number; text: string }[];
      }>(await callTool(server, "read", { path: mergedPdf }));
      expect(extracted.totalPages).toBe(2);
      expect(extracted.pages[0]?.text).toContain("第一部分：系统架构");
      expect(extracted.pages[1]?.text).toContain("第二部分：验收结论");

      // 4. Render page 1 of merged PDF to PNG
      const renderRes = await callTool(server, "render", { path: mergedPdf, pages: "1" });
      const png = extractFirstPng(renderRes);
      maybeSaveShot("pdf.png", png);

      // 5. Split page 2 into a standalone PDF and verify its text
      const splitInfo = parseJsonResult<{ extractedPages: number[] }>(
        await callTool(server, "split", { path: mergedPdf, pages: "2", outputPath: splitPdf }),
      );
      expect(splitInfo.extractedPages).toEqual([2]);

      const splitRead = parseJsonResult<{
        totalPages: number;
        pages: { page: number; text: string }[];
      }>(await callTool(server, "read", { path: splitPdf }));
      expect(splitRead.totalPages).toBe(1);
      expect(splitRead.pages[0]?.text).toContain("第二部分：验收结论");
      expect(splitRead.pages[0]?.text).not.toContain("第一部分：系统架构");
    } finally {
      await server.close();
    }
  });
});
