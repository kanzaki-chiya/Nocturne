import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPlatform, createRuntime, loadConfig } from "../src/index.js";
import { createRulePolicy, PERMISSION_PRESET_NAMES } from "../src/permission/index.js";
import { FakeProvider } from "../src/provider/index.js";
import {
  decodeDurableEvent,
  encodeDurableEvent,
  inlineFilesOfTool,
  legacyInlinePageId,
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
  applyHtmlEdits,
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
      expect(completed?.payload.modelContent).toContain("page-1 v1");
      expect(completed?.payload.modelContent).toContain("file-1.html");
      expect(completed?.payload.modelContent).toContain("回复中不要复述页面里的数据、结论或说明");
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

  it("页面权限按预设、用户规则和项目收紧规则求值", () => {
    const subject = [{ kind: "page", target: "s/page-1" }] as const;
    const caller = { kind: "page", page: "page-1" } as const;
    for (const preset of PERMISSION_PRESET_NAMES) {
      const policy = createRulePolicy({
        workspaceRoot: "Z:/workspace",
        caseSensitive: true,
        preset,
      });
      expect(policy.evaluate(subject, { caller }).decision.action).toBe(
        preset === "bypass" ? "allow" : "ask",
      );
    }
    const projectCannotAllow = createRulePolicy({
      workspaceRoot: "Z:/workspace",
      caseSensitive: true,
      preset: "default",
      rules: [{ origin: "project", rule: { kind: "page", pattern: "*", action: "allow" } }],
    });
    expect(projectCannotAllow.evaluate(subject, { caller }).decision.action).toBe("ask");
    const projectCanDeny = createRulePolicy({
      workspaceRoot: "Z:/workspace",
      caseSensitive: true,
      preset: "bypass",
      rules: [{ origin: "project", rule: { kind: "page", pattern: "*", action: "deny" } }],
    });
    expect(projectCanDeny.evaluate(subject, { caller }).decision.action).toBe("deny");
    const userCanDeny = createRulePolicy({
      workspaceRoot: "Z:/workspace",
      caseSensitive: true,
      preset: "bypass",
      rules: [{ origin: "user", rule: { kind: "page", pattern: "*", action: "deny" } }],
      grants: {
        project: [{ kind: "page", target: "s/page-1", createdAt: "2026-11-23T00:00:00Z" }],
      },
    });
    expect(userCanDeny.evaluate(subject, { caller }).decision.action).toBe("deny");
  });

  it("页面模型调用独立于 Turn，按页面排队、授权、停止并计量", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "nct-page-model-"));
    roots.push(root);
    const platform = createPlatform();
    const config = await loadConfig(platform, {
      nocturneHome: path.join(root, "home"),
      credentials: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        has: () => false,
        backend: () => "plaintext",
      },
    });
    const first = new FakeProvider({});
    const [main] = first.models();
    if (!main) throw new Error("缺少测试模型");
    const provider = new FakeProvider({
      models: [
        main,
        {
          ...main,
          ref: { ...main.ref, model: "small" },
          maxOutputTokens: 500,
          capabilities: { ...main.capabilities, reasoningEffort: ["high", "low"] },
        },
      ],
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "page",
            name: "render_html",
            input: { title: "页面", html: "<p>页面</p>" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "页面已创建" },
          { type: "finish", reason: "stop" },
        ],
      ],
      roleHandler: (request) => {
        const content = request.messages[0]?.content;
        if (
          request.purpose === "page" &&
          Array.isArray(content) &&
          content[0]?.type === "text" &&
          content[0].text === "slow"
        ) {
          return [{ type: "wait" }, { type: "finish", reason: "stop" }];
        }
        return [
          { type: "text_delta", text: "结果" },
          { type: "usage", usage: { inputTokens: 15, outputTokens: 2 } },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const runtime = await createRuntime({
      cwd: root,
      config,
      providers: [provider],
      interactive: true,
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    try {
      const requests: Extract<RuntimeEvent, { type: "page.permission_requested" }>[] = [];
      session.subscribe((event) => {
        if (event.type === "page.permission_requested") requests.push(event);
      });
      await session.submit({ text: "会话原文" });
      await expect(
        session.callPageModel("page-1", { prompt: "测".repeat(90_000) }),
      ).rejects.toMatchObject({ code: "invalid_command" });
      const denied = session.callPageModel("page-1", { prompt: "拒绝" });
      const deniedCheck = expect(denied).rejects.toMatchObject({ code: "page_model_denied" });
      const allowed = session.callPageModel("page-1", { prompt: "成功", system: "系统" });
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      const [firstRequest] = requests;
      if (!firstRequest) throw new Error("缺少第一条页面确认");
      expect(firstRequest.payload.model).toBe("fake/fake-1");
      await session.respondPagePermission("page-1", firstRequest.payload.requestId, {
        action: "deny",
      });
      await deniedCheck;
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const secondRequest = requests[1];
      if (!secondRequest) throw new Error("缺少第二条页面确认");
      await session.respondPagePermission("page-1", secondRequest.payload.requestId, {
        action: "allow",
        remember: "project",
      });
      expect(await allowed).toBe("结果");
      expect(await runtime.listGrants({ workspace: root })).toContainEqual(
        expect.objectContaining({ kind: "page", title: "页面" }),
      );
      await runtime.setModelRole("smol", "fake/small");
      expect(
        await session.callPageModel(
          "page-1",
          { prompt: "small", maxTokens: 900 },
          AbortSignal.timeout(1000),
        ),
      ).toBe("结果");
      expect(provider.roleRequests.filter((req) => req.purpose === "page")).toMatchObject([
        {
          model: "fake-1",
          maxOutputTokens: 4096,
          system: [{ text: "系统" }],
          tools: [],
          messages: [{ role: "user", content: [{ type: "text", text: "成功" }] }],
        },
        { model: "small", maxOutputTokens: 500, reasoningEffort: "low", tools: [] },
      ]);
      expect(requests).toHaveLength(2);
      const slow = session.callPageModel("page-1", { prompt: "slow" });
      const queued = session.callPageModel("page-1", { prompt: "queued" });
      const outcomes = Promise.allSettled([slow, queued]);
      await vi.waitFor(() => expect(provider.waitState.waiting).toBe(1));
      session.stopPageModel("page-1");
      expect(await outcomes).toMatchObject([
        { status: "rejected", reason: { code: "page_model_aborted" } },
        { status: "rejected", reason: { code: "page_model_aborted" } },
      ]);
      const logs = session.durableEvents().filter((event) => event.type === "page.model_called");
      expect(logs.map((event) => event.payload.outcome)).toEqual([
        "error",
        "ok",
        "ok",
        "aborted",
        "aborted",
      ]);
      expect(logs.filter((event) => event.payload.usage)).toHaveLength(2);
      expect(replaySessionView(session.durableEvents()).usage?.inputTokens).toBeGreaterThanOrEqual(
        30,
      );
      await session.setPermissionPreset("bypass");
      await runtime.revokeAllGrants({ workspace: root });
      expect(await session.callPageModel("page-1", { prompt: "bypass" })).toBe("结果");
      expect(requests).toHaveLength(2);
    } finally {
      await runtime.close();
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

  describe("页面版本、edits、display 与预设读取放行（ADR-0109）", () => {
    it("validateInput：更新时 html 与 edits 必须且只能给一个，新建不能传 edits", () => {
      expect(renderHtmlTool.validateInput?.({ page: "page-1" })).toContain("html 与 edits");
      expect(
        renderHtmlTool.validateInput?.({
          page: "page-1",
          html: "<p>a</p>",
          edits: [{ old: "a", new: "b" }],
        }),
      ).toContain("html 与 edits");
      expect(
        renderHtmlTool.validateInput?.({
          title: "新建",
          html: "<p>a</p>",
          edits: [{ old: "a", new: "b" }],
        }),
      ).toContain("edits");
      expect(
        renderHtmlTool.validateInput?.({
          page: "page-1",
          edits: [{ old: "a", new: "b" }],
        }),
      ).toBeUndefined();
      expect(
        renderHtmlTool.validateInput?.({
          page: "page-1",
          html: "<p>rewrite</p>",
          display: "panel",
        }),
      ).toBeUndefined();
    });

    it("applyHtmlEdits：顺序依次替换，old 出现 0 次或多次时写明第几条和次数", () => {
      const ok = applyHtmlEdits("<p>alpha</p><p>beta</p>", [
        { old: "alpha", new: "ALPHA-$&" },
        { old: "ALPHA-$&</p><p>beta", new: "DONE" },
      ]);
      expect(ok).toEqual({ ok: true, html: "<p>DONE</p>" });

      const miss = applyHtmlEdits("<p>hello</p>", [
        { old: "hello", new: "world" },
        { old: "nope", new: "x" },
      ]);
      expect(miss.ok).toBe(false);
      if (!miss.ok) {
        expect(miss.error).toContain("第 2 条");
        expect(miss.error).toContain("0 次");
      }

      const dup = applyHtmlEdits("<p>dup</p><p>dup</p>", [{ old: "dup", new: "one" }]);
      expect(dup.ok).toBe(false);
      if (!dup.ok) {
        expect(dup.error).toContain("第 1 条");
        expect(dup.error).toContain("2 次");
      }
    });

    it("新建 id/版本号、edits 顺序替换、html 整份重写、title 沿用、更新忽略 display、结果含文件路径", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nct-render-ver-"));
      roots.push(root);
      const sessionsDir = path.join(root, "sessions");
      const calls: Record<string, unknown>[] = [
        // 1. 新建面板页面 page-1 v1
        {
          title: "每周提交看板",
          html: "<h1>看板</h1><p>总数: 100</p><p>环比: +10%</p>",
          display: "panel",
        },
        // 2. edits 顺序替换，不传 title（沿用），传入 display: "inline"（忽略）
        {
          page: "page-1",
          display: "inline",
          edits: [
            { old: "总数: 100", new: "总数: 162" },
            { old: "总数: 162</p><p>环比: +10%", new: "总数: 162</p><p>环比: +26%" },
          ],
        },
        // 3. html 整份重写并更新标题，传入合法但不同的 display: "inline" 仍忽略
        {
          page: "page-1",
          title: "每周提交看板（终版）",
          html: "<h1>终版看板</h1><p>八周平均: 20.3</p>",
          display: "inline",
        },
        // 4. 新建内嵌页面（缺省 display = "inline"）-> page-2 v1
        { title: "架构对比表", html: "<table><tr><td>A</td></tr></table>" },
      ];
      let idx = 0;
      const provider = new FakeProvider({
        handler: () => {
          const input = calls[idx];
          if (input !== undefined) {
            const callId = `rh-${++idx}`;
            return [
              { type: "tool_call", toolCallId: callId, name: "render_html", input },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "全部完成。" },
            { type: "finish", reason: "stop" },
          ];
        },
      });
      const runtime = await createRuntime({
        cwd: root,
        sessionsDir,
        providers: [provider],
        interactive: true,
      });
      const session = await runtime.createSession({ model: "fake/fake-model" });
      try {
        await session.submit({ text: "创建并迭代页面" });
        const completions = session
          .durableEvents()
          .filter(
            (e): e is DurableEvent<"tool.completed"> =>
              e.type === "tool.completed" && e.payload.name === "render_html",
          );
        expect(completions).toHaveLength(4);

        const [e1, e2, e3, e4] = completions;
        if (!e1 || !e2 || !e3 || !e4) throw new Error("expected 4 completions");
        const c1 = e1.payload;
        const c2 = e2.payload;
        const c3 = e3.payload;
        const c4 = e4.payload;

        expect(c1.files?.[0]?.inline).toEqual({
          title: "每周提交看板",
          page: "page-1",
          version: 1,
          display: "panel",
        });
        expect(c2.files?.[0]?.inline).toEqual({
          title: "每周提交看板",
          page: "page-1",
          version: 2,
          display: "panel",
        });
        expect(c3.files?.[0]?.inline).toEqual({
          title: "每周提交看板（终版）",
          page: "page-1",
          version: 3,
          display: "panel",
        });
        expect(c4.files?.[0]?.inline).toEqual({
          title: "架构对比表",
          page: "page-2",
          version: 1,
          display: "inline",
        });

        // 工具结果含页面 id、版本号和完整文件路径
        const file2 = c2.files?.[0]?.file;
        const file3 = c3.files?.[0]?.file;
        if (!file2 || !file3) throw new Error("expected attachment files");
        const expectedPath2 = path.join(sessionsDir, "attachments", session.id, file2);
        expect(c2.modelContent).toContain("page-1");
        expect(c2.modelContent).toContain("v2");
        expect(c2.modelContent).toContain(expectedPath2);

        // 验证 edits 落盘内容
        const v2Bytes = await session.readAttachment(file2);
        expect(new TextDecoder().decode(v2Bytes.data)).toBe(
          "<h1>看板</h1><p>总数: 162</p><p>环比: +26%</p>",
        );
        const v3Bytes = await session.readAttachment(file3);
        expect(new TextDecoder().decode(v3Bytes.data)).toBe(
          "<h1>终版看板</h1><p>八周平均: 20.3</p>",
        );

        // 派生视图校验
        const view = replaySessionView(session.durableEvents());
        expect(view.pages).toHaveLength(2);
        const [p0, p1] = view.pages;
        expect(p0).toMatchObject({
          page: "page-1",
          title: "每周提交看板（终版）",
          display: "panel",
        });
        expect(p0?.versions.map((v) => ({ version: v.version, title: v.title }))).toEqual([
          { version: 1, title: "每周提交看板" },
          { version: 2, title: "每周提交看板" },
          { version: 3, title: "每周提交看板（终版）" },
        ]);
        expect(p1).toMatchObject({
          page: "page-2",
          title: "架构对比表",
          display: "inline",
        });
        expect(p1?.versions).toHaveLength(1);
      } finally {
        await session.close();
      }
    });

    it("错误路径：page 不存在列出现有页面、edits 失败或超 256 KiB 时整次调用不生效", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nct-render-err-"));
      roots.push(root);
      const huge = "x".repeat(MAX_INLINE_HTML_BYTES + 10);
      const calls: Record<string, unknown>[] = [
        // 1. 新建 page-1
        { title: "首页", html: "<p>dup</p><p>dup</p><p>tail</p>" },
        // 2. page 不存在
        { page: "page-99", html: "<p>new</p>" },
        // 3. old 未出现（第 2 条）
        {
          page: "page-1",
          edits: [
            { old: "tail", new: "TAIL" },
            { old: "missing", new: "x" },
          ],
        },
        // 4. old 出现多次
        { page: "page-1", edits: [{ old: "dup", new: "one" }] },
        // 5. 替换后超过 256 KiB
        { page: "page-1", edits: [{ old: "tail", new: huge }] },
      ];
      let idx = 0;
      const provider = new FakeProvider({
        handler: () => {
          const input = calls[idx];
          if (input !== undefined) {
            const callId = `err-${++idx}`;
            return [
              { type: "tool_call", toolCallId: callId, name: "render_html", input },
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
      try {
        await session.submit({ text: "测试错误路径" });
        const completions = session
          .durableEvents()
          .filter(
            (e): e is DurableEvent<"tool.completed"> =>
              e.type === "tool.completed" && e.payload.name === "render_html",
          );
        expect(completions).toHaveLength(5);

        // page 不存在：报错并列出现有 page id 与标题
        expect(completions[1]?.payload.status).toBe("error");
        expect(completions[1]?.payload.error?.code).toBe("invalid_input");
        expect(completions[1]?.payload.modelContent).toContain("page-1");
        expect(completions[1]?.payload.modelContent).toContain("首页");

        // old 未出现：报第 2 条、0 次
        expect(completions[2]?.payload.status).toBe("error");
        expect(completions[2]?.payload.error?.code).toBe("invalid_input");
        expect(completions[2]?.payload.modelContent).toContain("第 2 条");
        expect(completions[2]?.payload.modelContent).toContain("0 次");

        // old 出现多次：报第 1 条、2 次
        expect(completions[3]?.payload.status).toBe("error");
        expect(completions[3]?.payload.error?.code).toBe("invalid_input");
        expect(completions[3]?.payload.modelContent).toContain("第 1 条");
        expect(completions[3]?.payload.modelContent).toContain("2 次");

        // 替换后超 256 KiB：报错
        expect(completions[4]?.payload.status).toBe("error");
        expect(completions[4]?.payload.error?.code).toBe("invalid_input");
        expect(completions[4]?.payload.modelContent).toContain("256 KiB");

        // 整次失败均不生效：页面仍只有 v1
        const view = replaySessionView(session.durableEvents());
        expect(view.pages).toHaveLength(1);
        expect(view.pages[0]?.versions).toHaveLength(1);
      } finally {
        await session.close();
      }
    });

    it("Runtime 会话中模型用 read 读取 render_html 产出的页面文件自动命中本会话落盘目录规则", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nct-render-read-"));
      roots.push(root);
      const sessionsDir = path.join(root, "sessions");
      let savedPath = "";
      let step = 0;
      const provider = new FakeProvider({
        handler: (req) => {
          if (step === 0) {
            step++;
            return [
              {
                type: "tool_call",
                toolCallId: "rh-1",
                name: "render_html",
                input: { title: "面板页", html: "<p>v1 content</p>", display: "panel" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (step === 1) {
            step++;
            const toolMsg = req.messages.findLast((m) => m.role === "tool");
            const text = toolMsg && "content" in toolMsg ? String(toolMsg.content) : "";
            const match = /已保存：(.+?)（/.exec(text);
            savedPath = match?.[1] ?? "";
            return [
              {
                type: "tool_call",
                toolCallId: "rd-1",
                name: "read",
                input: { path: savedPath },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "已核对全文。" },
            { type: "finish", reason: "stop" },
          ];
        },
      });
      const runtime = await createRuntime({
        cwd: root,
        sessionsDir,
        providers: [provider],
        interactive: true,
      });
      const session = await runtime.createSession({
        model: "fake/fake-model",
        permissionPreset: "read-only",
      });
      try {
        const events: RuntimeEvent[] = [];
        session.subscribe((ev) => events.push(ev));
        await session.submit({ text: "建页面再读回" });
        expect(savedPath).toContain("file-1.html");
        expect(events.some((e) => e.type === "permission.requested")).toBe(false);
        const readStarted = session
          .durableEvents()
          .find(
            (e): e is DurableEvent<"tool.started"> =>
              e.type === "tool.started" && e.payload.name === "read",
          );
        expect(readStarted?.payload.permission.action).toBe("allow");
        expect(readStarted?.payload.permission.rule).toContain("本会话落盘目录");
        const readCompleted = session
          .durableEvents()
          .find(
            (e): e is DurableEvent<"tool.completed"> =>
              e.type === "tool.completed" && e.payload.name === "read",
          );
        expect(readCompleted?.payload.status).toBe("ok");
        expect(readCompleted?.payload.modelContent).toContain("<p>v1 content</p>");
      } finally {
        await session.close();
      }
    });

    it("更新沿用内嵌，回退和分叉只保留有效版本", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "nct-render-rewind-"));
      roots.push(root);
      const sessionsDir = path.join(root, "sessions");
      let turn = 0;
      const provider = new FakeProvider({
        handler: () => {
          turn++;
          if (turn === 1) {
            return [
              {
                type: "tool_call",
                toolCallId: "rh-t1",
                name: "render_html",
                input: { title: "看板", html: "<p>v1</p>", display: "inline" },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          if (turn === 2) {
            return [
              { type: "text_delta", text: "第一版好了" },
              { type: "finish", reason: "stop" },
            ];
          }
          if (turn === 3) {
            return [
              {
                type: "tool_call",
                toolCallId: "rh-t2",
                name: "render_html",
                input: { page: "page-1", display: "panel", edits: [{ old: "v1", new: "v2" }] },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "第二版好了" },
            { type: "finish", reason: "stop" },
          ];
        },
      });
      const runtime = await createRuntime({
        cwd: root,
        sessionsDir,
        providers: [provider],
        interactive: true,
      });
      const session = await runtime.createSession({ model: "fake/fake-model" });
      try {
        await session.submit({ text: "做看板" });
        const first = replaySessionView(session.durableEvents());
        expect(first.pages[0]?.display).toBe("inline");
        await session.submit({ text: "改成 v2" });
        const events = session.durableEvents();
        const before = replaySessionView(events);
        expect(before.pages[0]?.display).toBe("inline");
        expect(before.pages[0]?.versions.map((v) => v.file.inline?.display)).toEqual([
          "inline",
          "inline",
        ]);
        const completions = events.filter(
          (event): event is DurableEvent<"tool.completed"> =>
            event.type === "tool.completed" && event.payload.name === "render_html",
        );
        expect(completions[0]?.payload.modelContent).toContain("page-1 v1，内嵌");
        expect(completions[1]?.payload.modelContent).toContain("page-1 v2，内嵌");
        expect(completions[1]?.payload.output).toMatchObject({ display: "inline", version: 2 });

        // 0.62.0 的日志会将内嵌页的更新版本记成 panel。
        const oldLog = events.map((event) => {
          if (event.type === "session.created") {
            return encodeDurableEvent({
              ...event,
              payload: { ...event.payload, nocturneVersion: "0.62.0" },
            });
          }
          const file = event.type === "tool.completed" ? event.payload.files?.[0] : undefined;
          if (event.type === "tool.completed" && file?.inline?.version === 2) {
            return encodeDurableEvent({
              ...event,
              payload: {
                ...event.payload,
                files: [{ ...file, inline: { ...file.inline, display: "panel" } }],
              },
            });
          }
          return encodeDurableEvent(event);
        });
        const restored = replaySessionView(oldLog.map(decodeDurableEvent));
        expect(restored.pages[0]?.display).toBe("inline");
        expect(restored.pages[0]?.versions.map((v) => v.file.inline?.display)).toEqual([
          "inline",
          "panel",
        ]);

        const userEvents = session
          .durableEvents()
          .filter((e): e is DurableEvent<"message.user"> => e.type === "message.user");
        const secondUserSeq = userEvents[1]?.seq;
        if (secondUserSeq === undefined) throw new Error("expected second user event");

        await Promise.all(
          Array.from({ length: 20 }, (_, i) => session.setPageData("page-1", `key-${i}`, i)),
        );
        await session.setPageData("page-1", "__proto__", null);
        expect(await session.listPageDataKeys("page-1")).toHaveLength(21);
        expect(await session.getPageData("page-1", "__proto__")).toBeNull();
        await expect(session.getPageData("page-1", "")).rejects.toMatchObject({
          code: "invalid_command",
        });
        await expect(session.setPageData("page-1", "x".repeat(201), 1)).rejects.toMatchObject({
          code: "invalid_command",
        });
        await expect(session.setPageData("../page-1", "key", 1)).rejects.toMatchObject({
          code: "page_not_found",
        });
        await expect(
          session.setPageData("page-1", "key-0", "x".repeat(1024 * 1024)),
        ).rejects.toMatchObject({ code: "page_storage_full" });
        expect(await session.getPageData("page-1", "key-0")).toBe(0);

        // 分叉在第二条用户消息之前：只继承 v1
        const forkedId = await runtime.forkSession(session.id, { targetSeq: secondUserSeq });
        const forkedSession = await runtime.resumeSession(forkedId);
        try {
          const forkedView = replaySessionView(forkedSession.durableEvents());
          expect(forkedView.pages).toHaveLength(1);
          expect(forkedView.pages[0]?.display).toBe("inline");
          expect(forkedView.pages[0]?.versions.map((v) => v.version)).toEqual([1]);
          expect(await forkedSession.getPageData("page-1", "key-2")).toBe(2);
          await forkedSession.setPageData("page-1", "key-2", "fork");
          expect(await session.getPageData("page-1", "key-2")).toBe(2);
        } finally {
          await forkedSession.close();
        }

        // 原会话回退到第二条用户消息之前：撤销 v2，只剩 v1
        await session.rewind(secondUserSeq, "conversation");
        const afterRewind = replaySessionView(session.durableEvents());
        expect(afterRewind.pages).toHaveLength(1);
        expect(afterRewind.pages[0]?.display).toBe("inline");
        expect(afterRewind.pages[0]?.versions.map((v) => v.version)).toEqual([1]);
        expect(await session.getPageData("page-1", "key-2")).toBe(2);
        await session.deletePageData("page-1", "key-2");
        expect(await session.getPageData("page-1", "key-2")).toBeUndefined();
        const dataFile = path.join(
          sessionsDir,
          "attachments",
          session.id,
          "page-data",
          "page-1.json",
        );
        expect(existsSync(dataFile)).toBe(true);
        const [firstUserEvent] = userEvents;
        if (!firstUserEvent) throw new Error("缺少首条用户事件");
        await session.rewind(firstUserEvent.seq, "conversation");
        expect(existsSync(dataFile)).toBe(false);
        await expect(session.listPageDataKeys("page-1")).rejects.toMatchObject({
          code: "page_not_found",
        });
      } finally {
        await session.close();
      }
    });

    it("旧日志中均记为 inline 的版本仍派生为内嵌页面", () => {
      const events = [1, 2].map((version) => {
        const event: DurableEvent<"tool.completed"> = {
          type: "tool.completed",
          seq: version,
          sessionId: "s-old-inline",
          turnId: "t1",
          time: "2026-11-20T00:00:00.000Z",
          payload: {
            callId: `c${version}`,
            name: "render_html",
            status: "ok",
            modelContent: "ok",
            durationMs: 5,
            files: [
              {
                type: "file",
                file: `file-${version}.html`,
                bytes: 32,
                sha256: "a".repeat(64),
                label: "图表.html",
                mimeType: "text/html",
                source: "upload",
                inline: { title: "图表", page: "page-1", version, display: "inline" },
              },
            ],
          },
        };
        return decodeDurableEvent(encodeDurableEvent(event));
      });
      const [page] = replaySessionView(events).pages;
      expect(page?.display).toBe("inline");
      expect(page?.versions.map((version) => version.version)).toEqual([1, 2]);
    });

    it("旧会话页面派生为单版本 inline 页面且 id 不与新页面冲突；旧版 schema 剥离新字段后仍能解析", () => {
      const legacyFile: FileAttachment = {
        type: "file",
        file: "file-1.html",
        bytes: 32,
        sha256: "a".repeat(64),
        label: "旧图表.html",
        mimeType: "text/html",
        source: "upload",
        inline: { title: "旧图表" },
      };
      const newFile: FileAttachment = {
        type: "file",
        file: "file-2.html",
        bytes: 48,
        sha256: "b".repeat(64),
        label: "新面板.html",
        mimeType: "text/html",
        source: "upload",
        inline: { title: "新面板", page: "page-1", version: 1, display: "panel" },
      };
      const event2: DurableEvent<"tool.completed"> = {
        seq: 3,
        sessionId: "s-legacy",
        turnId: "t2",
        time: "2026-11-20T00:00:02.000Z",
        type: "tool.completed",
        payload: {
          callId: "c2",
          name: "render_html",
          status: "ok",
          modelContent: "ok",
          durationMs: 5,
          files: [newFile],
        },
      };
      const events: DurableEvent[] = [
        {
          seq: 1,
          sessionId: "s-legacy",
          time: "2026-11-20T00:00:00.000Z",
          type: "session.created",
          payload: {
            cwd: "/ws",
            workspaceRoot: "/ws",
            model: { provider: "fake", model: "m" },
            permissionPreset: "default",
            formatVersion: 1,
            nocturneVersion: "0.57.0",
          },
        },
        {
          seq: 2,
          sessionId: "s-legacy",
          turnId: "t1",
          time: "2026-11-20T00:00:01.000Z",
          type: "tool.completed",
          payload: {
            callId: "c1",
            name: "render_html",
            status: "ok",
            modelContent: "ok",
            durationMs: 5,
            files: [legacyFile],
          },
        },
        event2,
      ];

      const view = replaySessionView(events);
      expect(view.pages).toHaveLength(2);
      expect(view.pages[0]).toEqual({
        page: legacyInlinePageId("file-1.html"),
        title: "旧图表",
        display: "inline",
        origin: { sessionId: "s-legacy", page: legacyInlinePageId("file-1.html") },
        versions: [{ version: 1, file: legacyFile, title: "旧图表", seq: 2 }],
      });
      expect(view.pages[1]).toEqual({
        page: "page-1",
        title: "新面板",
        display: "panel",
        origin: { sessionId: "s-legacy", page: "page-1" },
        versions: [{ version: 1, file: newFile, title: "新面板", seq: 3 }],
      });
      expect(view.pages[0]?.page).not.toBe(view.pages[1]?.page);

      // 模拟旧版 Runtime 的 toolResultFileAttachmentSchema（仅 inline: z.object({ title: z.string() })，非 strict）
      const oldInlineSchema = z.object({ title: z.string() }).optional();
      const stripped = oldInlineSchema.parse(newFile.inline);
      expect(stripped).toEqual({ title: "新面板" });

      // 反向验证：新版 decodeDurableEvent 解析带新字段的持久事件完整保留所有字段
      const encoded = encodeDurableEvent(event2);
      const decoded = decodeDurableEvent(encoded);
      expect(decoded.type).toBe("tool.completed");
      if (decoded.type === "tool.completed") {
        expect(decoded.payload.files?.[0]?.inline).toEqual({
          title: "新面板",
          page: "page-1",
          version: 1,
          display: "panel",
        });
      }
    });
  });
});
