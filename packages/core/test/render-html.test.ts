import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  MAX_INLINE_HTML_IMAGES,
  MAX_INLINE_HTML_SAVED_BYTES,
  MAX_INLINE_HTML_TITLE_CHARS,
  isSvgImage,
  renderHtmlTool,
  replaceImageReferences,
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
      expect(completed?.payload.modelContent).toMatch(
        /^内嵌页面「季度对比: Q1\/Q2」已显示给用户（file-1\.html，\d+ B）。回复中不要复述页面里的数据、结论或说明。$/,
      );
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

  describe("images：本地图片内联", () => {
    const PNG = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]);
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

    async function runCall(
      input: Record<string, unknown>,
      opts: { preset?: string; plan?: boolean; files?: Record<string, Uint8Array | string> } = {},
    ) {
      const root = mkdtempSync(path.join(tmpdir(), "nct-render-html-img-"));
      roots.push(root);
      const ws = path.join(root, "ws");
      mkdirSync(ws);
      for (const [name, content] of Object.entries(opts.files ?? {})) {
        const full = path.join(root, name);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      let step = 0;
      const provider = new FakeProvider({
        handler: () =>
          step++ === 0
            ? [
                { type: "tool_call", toolCallId: "rh-img", name: "render_html", input },
                { type: "finish", reason: "tool_calls" },
              ]
            : [
                { type: "text_delta", text: "ok" },
                { type: "finish", reason: "stop" },
              ],
      });
      const runtime = await createRuntime({
        cwd: ws,
        sessionsDir: path.join(root, "sessions"),
        providers: [provider],
        interactive: true,
      });
      const session = await runtime.createSession({
        model: "fake/fake-model",
        ...(opts.preset !== undefined ? { permissionPreset: opts.preset } : {}),
      });
      const captured: RuntimeEvent[] = [];
      session.subscribe((ev) => {
        captured.push(ev);
        if (ev.type === "permission.requested") {
          void session.respondPermission(ev.payload.requestId, { decision: "allow" });
        }
      });
      try {
        await session.submit({ text: "画", ...(opts.plan ? { workMode: "plan" as const } : {}) });
        const completed = captured.find(
          (e): e is DurableEvent<"tool.completed"> => e.type === "tool.completed",
        );
        const started = captured.find(
          (e): e is DurableEvent<"tool.started"> => e.type === "tool.started",
        );
        const saved =
          completed?.payload.status === "ok"
            ? new TextDecoder().decode((await session.readAttachment("file-1.html")).data)
            : undefined;
        return { root, ws, captured, completed, started, saved, durable: session.durableEvents() };
      } finally {
        await session.close();
      }
    }

    it("四种引用写法（双引号、单引号属性值与 url() 三种）被替换为 data:，其余文字不变", () => {
      const html = [
        '<img src="a.png" alt="a.png">',
        "<img src='a.png'>",
        '<div style="background:url(a.png)"></div>',
        "<style>.x{background:url(\"a.png\")} .y{background:url('a.png')}</style>",
        "<p>a.png 原样 src=a.png ./a.png</p>",
        '<img src="./a.png"><img src="ba.png">',
      ].join("\n");
      const { html: out, count } = replaceImageReferences(
        html,
        "a.png",
        "data:image/png;base64,QQ==",
      );
      expect(count).toBe(6);
      expect(out).toBe(
        [
          '<img src="data:image/png;base64,QQ==" alt="data:image/png;base64,QQ==">',
          "<img src='data:image/png;base64,QQ=='>",
          '<div style="background:url(data:image/png;base64,QQ==)"></div>',
          "<style>.x{background:url(\"data:image/png;base64,QQ==\")} .y{background:url('data:image/png;base64,QQ==')}</style>",
          "<p>a.png 原样 src=a.png ./a.png</p>",
          '<img src="./a.png"><img src="ba.png">',
        ].join("\n"),
      );
      // 替换串里的 $ 不被当作替换模式
      expect(replaceImageReferences('="$&.png"', "$&.png", "D$1").html).toBe('="D$1"');
    });

    it("SVG 按扩展名加内容开头识别（BOM 与前导空白去掉后以 <svg 或 <?xml 开头）", () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      expect(isSvgImage("a.svg", enc("<svg xmlns='x'/>"))).toBe(true);
      expect(isSvgImage("A.SVG", enc("\uFEFF \n\t<?xml version='1.0'?><svg/>"))).toBe(true);
      expect(isSvgImage("a.svg", enc("<html></html>"))).toBe(false);
      expect(isSvgImage("a.txt", enc("<svg/>"))).toBe(false);
    });

    it("成功：工作区内图片在 read-only 与计划模式下不确认，读取主体逐项列出，存档已内联、事件只含路径", async () => {
      const svg = "\uFEFF  <svg xmlns='http://www.w3.org/2000/svg'/>";
      const r = await runCall(
        {
          title: "图",
          html: '<img src="img/a.png"><div style="background:url(\'b.svg\')"></div>',
          images: ["img/a.png", "b.svg"],
        },
        { preset: "read-only", plan: true, files: { "ws/img/a.png": PNG, "ws/b.svg": svg } },
      );
      expect(r.captured.some((e) => e.type === "permission.requested")).toBe(false);
      expect(r.completed?.payload.status).toBe("ok");
      expect(r.started?.payload.subjects.map((s) => [s.kind, s.target])).toEqual([
        ["read", path.join(r.ws, "img", "a.png")],
        ["read", path.join(r.ws, "b.svg")],
      ]);
      const svgB64 = b64(new TextEncoder().encode(svg));
      expect(r.saved).toBe(
        `<img src="data:image/png;base64,${b64(PNG)}"><div style="background:url('data:image/svg+xml;base64,${svgB64}')"></div>`,
      );
      const savedBytes = Buffer.byteLength(r.saved ?? "", "utf8");
      expect(r.completed?.payload.modelContent).toContain(`${savedBytes} B`);
      const durable = JSON.stringify(r.durable);
      expect(durable).not.toContain(b64(PNG));
      expect(durable).not.toContain(svgB64);
      expect(durable).not.toContain("base64,");
    });

    it("permissionSubjects 为每个路径返回一条 read 主体（相对 cwd 解析）", () => {
      const scope = {
        cwd: "/w",
        workspaceRoot: "/w",
        paths: { resolve: (cwd: string, p: string) => path.posix.resolve(cwd, p) },
      } as unknown as Parameters<NonNullable<typeof renderHtmlTool.permissionSubjects>>[1];
      expect(
        renderHtmlTool.permissionSubjects(
          { title: "t", html: "x", images: ["a.png", "/abs/b.gif"] },
          scope,
        ),
      ).toEqual([
        { kind: "read", target: "/w/a.png" },
        { kind: "read", target: "/abs/b.gif" },
      ]);
      expect(renderHtmlTool.permissionSubjects({ title: "t", html: "x" }, scope)).toEqual([]);
    });

    it("工作区外的图片走读取确认", async () => {
      const outside = "outside.png";
      const r = await runCall(
        { title: "图", html: '<img src="../outside.png">', images: [`../${outside}`] },
        { files: { [outside]: PNG } },
      );
      const asked = r.captured.filter((e) => e.type === "permission.requested");
      expect(asked).toHaveLength(1);
      expect(r.completed?.payload.status).toBe("ok");
    });

    it.each([
      ["不存在", { "ws/x.txt": "x" }, "missing.png", "file_not_found", "missing.png"],
      ["是目录", { "ws/dir/x.txt": "x" }, "dir", "is_directory", "dir"],
      ["不是图片", { "ws/note.png": "plain text" }, "note.png", "unsupported_image", "note.png"],
      ["内容不是 SVG", { "ws/fake.svg": "<html/>" }, "fake.svg", "unsupported_image", "fake.svg"],
    ])("路径%s时整次调用失败并点名", async (_label, files, ref, code, named) => {
      const r = await runCall(
        { title: "图", html: `<img src="${ref}">`, images: [ref] },
        { files },
      );
      expect(r.completed?.payload.status).toBe("error");
      expect(r.completed?.payload.error?.code).toBe(code);
      expect(r.completed?.payload.modelContent).toContain(named);
      expect(r.completed?.payload.files ?? []).toEqual([]);
    });

    it("images 中有但 html 未引用的路径整次调用失败并点名", async () => {
      const r = await runCall(
        { title: "图", html: '<img src="a.png"><p>b.png</p>', images: ["a.png", "b.png"] },
        { files: { "ws/a.png": PNG, "ws/b.png": PNG } },
      );
      expect(r.completed?.payload.error?.code).toBe("image_unreferenced");
      expect(r.completed?.payload.modelContent).toContain("b.png");
      expect(r.completed?.payload.modelContent).not.toContain("a.png 在");
    });

    it("超过 20 项被拒绝，恰好 20 项可通过校验", async () => {
      const twenty = Array.from({ length: MAX_INLINE_HTML_IMAGES }, (_, i) => `${i}.png`);
      expect(MAX_INLINE_HTML_IMAGES).toBe(20);
      expect(
        renderHtmlTool.validateInput?.({ title: "t", html: "x", images: twenty }),
      ).toBeUndefined();
      expect(
        renderHtmlTool.validateInput?.({ title: "t", html: "x", images: [...twenty, "20.png"] }),
      ).toContain("20");
      const r = await runCall({ title: "图", html: "x", images: [...twenty, "20.png"] });
      expect(r.completed?.payload.error?.code).toBe("invalid_input");
      expect(r.captured.some((e) => e.type === "tool.started")).toBe(false);
    });

    it("替换后超过 8 MiB 整次调用失败", async () => {
      expect(MAX_INLINE_HTML_SAVED_BYTES).toBe(8 * 1024 * 1024);
      // 6.5 MiB 原图 base64 后约 8.67 MiB：原图本身未超限，替换后超限
      const big = new Uint8Array(6.5 * 1024 * 1024);
      big.set(PNG);
      const r = await runCall(
        { title: "图", html: '<img src="big.png">', images: ["big.png"] },
        { files: { "ws/big.png": big } },
      );
      expect(r.completed?.payload.status).toBe("error");
      expect(r.completed?.payload.error?.code).toBe("html_too_large");
      expect(r.completed?.payload.modelContent).toContain("8 MiB");
    });
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
