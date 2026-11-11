import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  inlineFilesOfTool,
  replaySessionView,
  type DurableEvent,
  type FileAttachment,
  type RuntimeEvent,
} from "../src/protocol/index.js";
import {
  MAX_INLINE_HTML_BYTES,
  MAX_INLINE_HTML_TITLE_CHARS,
  renderHtmlTool,
  sanitizeInlineHtmlLabel,
} from "../src/tools/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("render_html 工具与内嵌页面标记", () => {
  it("输入校验：缺标题、空标题、多行标题、标题过长、空 HTML、HTML 超限", () => {
    expect(renderHtmlTool.validateInput?.({ title: "", html: "<p>x</p>" })).toContain("title");
    expect(renderHtmlTool.validateInput?.({ title: "   ", html: "<p>x</p>" })).toContain("title");
    expect(renderHtmlTool.validateInput?.({ title: "a\nb", html: "<p>x</p>" })).toContain("单行");
    expect(
      renderHtmlTool.validateInput?.({
        title: "测".repeat(MAX_INLINE_HTML_TITLE_CHARS + 1),
        html: "<p>x</p>",
      }),
    ).toContain(String(MAX_INLINE_HTML_TITLE_CHARS));
    expect(
      renderHtmlTool.validateInput?.({
        title: "测".repeat(MAX_INLINE_HTML_TITLE_CHARS),
        html: "<p>x</p>",
      }),
    ).toBeUndefined();

    expect(renderHtmlTool.validateInput?.({ title: "标题", html: "" })).toContain("html");
    expect(renderHtmlTool.validateInput?.({ title: "标题", html: "   \n " })).toContain("html");

    const exact = `<p>${"a".repeat(MAX_INLINE_HTML_BYTES - 7)}</p>`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_INLINE_HTML_BYTES);
    expect(renderHtmlTool.validateInput?.({ title: "刚好上限", html: exact })).toBeUndefined();

    const over = `${exact}x`;
    expect(renderHtmlTool.validateInput?.({ title: "超过上限", html: over })).toContain("256 KiB");
  });

  it("文件名清洗：非法字符替换、首尾点与空格清理、Windows 保留名加前缀", () => {
    expect(sanitizeInlineHtmlLabel('A/B:C*D?"E<F>G|H')).toBe("A_B_C_D_E_F_G_H.html");
    expect(sanitizeInlineHtmlLabel("  报表.html  ")).toBe("报表.html");
    expect(sanitizeInlineHtmlLabel("...")).toBe("page.html");
    expect(sanitizeInlineHtmlLabel("CON")).toBe("_CON.html");
    expect(sanitizeInlineHtmlLabel("nul.html")).toBe("_nul.html");
  });

  it("read-only 预设与计划模式下可调用且不产生权限确认，tool.completed.files 带 inline 且不含 HTML 原文", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-render-html-"));
    roots.push(root);
    const secretHtml =
      "<!doctype html><html><body><h1 id='unique-secret-marker'>季度对比图</h1></body></html>";
    let step = 0;
    const provider = new FakeProvider({
      handler: (request) => {
        expect(request.tools.some((t) => t.name === "render_html")).toBe(true);
        if (step++ === 0) {
          return [
            {
              type: "tool_call",
              toolCallId: "rh-1",
              name: "render_html",
              input: { title: "季度对比: Q1/Q2", html: secretHtml },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "以上为对比图表。" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({
      model: "fake/fake-model",
      permissionPreset: "read-only",
    });
    try {
      const captured: RuntimeEvent[] = [];
      session.subscribe((ev) => captured.push(ev));

      await session.submit({ text: "画一张季度对比图", workMode: "plan" });

      expect(captured.some((e) => e.type === "permission.requested")).toBe(false);
      const completed = captured.find(
        (e): e is DurableEvent<"tool.completed"> =>
          e.type === "tool.completed" && e.payload.name === "render_html",
      );
      expect(completed).toBeDefined();
      expect(completed?.payload.status).toBe("ok");
      expect(JSON.stringify(completed?.payload)).not.toContain("unique-secret-marker");
      expect(completed?.payload.files).toHaveLength(1);
      const att = completed?.payload.files?.[0];
      expect(att).toMatchObject({
        type: "file",
        file: "file-1.html",
        label: "季度对比_ Q1_Q2.html",
        mimeType: "text/html",
        source: "upload",
        inline: { title: "季度对比: Q1/Q2" },
      });

      const loaded = await session.readAttachment("file-1.html");
      expect(new TextDecoder().decode(loaded.data)).toBe(secretHtml);

      const view = replaySessionView(session.durableEvents());
      const toolEntry = view.entries.find((e) => e.kind === "tool" && e.name === "render_html");
      expect(toolEntry?.kind).toBe("tool");
      if (toolEntry?.kind === "tool") {
        expect(inlineFilesOfTool(toolEntry)).toHaveLength(1);
        expect(inlineFilesOfTool(toolEntry)[0]?.inline?.title).toBe("季度对比: Q1/Q2");
        expect(inlineFilesOfTool({ ...toolEntry, status: "error" })).toEqual([]);
      }
    } finally {
      await session.close();
    }
  });

  it("用户提交的文件带同名 inline 字段时在入口与日志解码中均被丢弃", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-render-html-user-"));
    roots.push(root);
    const provider = new FakeProvider({
      handler: () => [
        { type: "text_delta", text: "收到" },
        { type: "finish", reason: "stop" },
      ],
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    try {
      const maliciousInput = {
        data: new TextEncoder().encode("<h1>spoof</h1>"),
        mimeType: "text/html",
        label: "spoof.html",
        source: "upload" as const,
        inline: { title: "伪造内嵌页" },
      };
      await session.submit({
        text: "请看附件",
        attachments: [maliciousInput],
      });
      const userEvent = session
        .durableEvents()
        .find((e): e is DurableEvent<"message.user"> => e.type === "message.user");
      expect(userEvent?.payload.files).toHaveLength(1);
      expect(userEvent?.payload.files?.[0]?.inline).toBeUndefined();

      if (!userEvent || !userEvent.payload.files?.[0]) {
        throw new Error("missing userEvent");
      }
      // 即使外部手工构造含 inline 的 message.user 日志行，schema 解码与视图归约也会剥离
      const forgedRaw = JSON.parse(encodeDurableEvent(userEvent)) as {
        payload: { files: FileAttachment[] };
      };
      const baseFile = forgedRaw.payload.files[0];
      if (!baseFile) throw new Error("missing baseFile");
      forgedRaw.payload.files[0] = {
        ...baseFile,
        inline: { title: "日志注入" },
      };
      const decoded = decodeDurableEvent(JSON.stringify(forgedRaw));
      expect(decoded.type).toBe("message.user");
      if (decoded.type === "message.user") {
        expect(decoded.payload.files?.[0]?.inline).toBeUndefined();
      }
    } finally {
      await session.close();
    }
  });

  it("子代理（general 与 explore）工具集中不包含 render_html，显式点名也被拒绝", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-render-html-sub-"));
    roots.push(root);
    let parentStep = 0;
    const childToolSets: string[][] = [];
    const provider = new FakeProvider({
      handler: (request) => {
        const isChild = request.tools.some((t) => t.name === "finish");
        if (isChild) {
          childToolSets.push(request.tools.map((t) => t.name));
          return [
            {
              type: "tool_call",
              toolCallId: "fin",
              name: "finish",
              input: { result: "ok" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (parentStep === 0) {
          parentStep++;
          return [
            {
              type: "tool_call",
              toolCallId: "sub-general",
              name: "task",
              input: { task: "检查 general 工具集", preset: "general" },
            },
            {
              type: "tool_call",
              toolCallId: "sub-explore",
              name: "task",
              input: { task: "检查 explore 工具集", preset: "explore" },
            },
            {
              type: "tool_call",
              toolCallId: "sub-explicit",
              name: "task",
              input: { task: "显式点名 render_html", tools: ["render_html"] },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    session.subscribe((ev) => {
      if (ev.type === "permission.requested") {
        void session.respondPermission(ev.payload.requestId, { decision: "allow" });
      }
    });
    try {
      await session.submit({ text: "测试子代理工具集" });

      expect(childToolSets).toHaveLength(2);
      for (const names of childToolSets) {
        expect(names).not.toContain("render_html");
      }
      const explicitDenied = session
        .durableEvents()
        .find(
          (e): e is DurableEvent<"tool.completed"> =>
            e.type === "tool.completed" &&
            e.payload.name === "task" &&
            e.payload.status === "error",
        );
      expect(explicitDenied?.payload.status).toBe("error");
      expect(explicitDenied?.payload.modelContent).toContain("render_html");
    } finally {
      await session.close();
    }
  });
});
