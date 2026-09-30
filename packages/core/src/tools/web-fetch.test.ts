import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRulePolicy } from "../permission/index.js";
import type { Grant, PermissionSubject } from "../protocol/index.js";
import { createPlatform } from "../platform/index.js";
import { NOCTURNE_VERSION } from "../protocol/version.js";
import {
  builtinTools,
  createAttachmentStore,
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  webFetchTool,
  type ExecutionScope,
  type HookRunner,
} from "./index.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(timeoutMs = 30_000, signal = new AbortController().signal) {
  const root = mkdtempSync(path.join(tmpdir(), "nct-web-fetch-"));
  roots.push(root);
  const platform = createPlatform();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const scope: ExecutionScope = {
    cwd: root,
    workspaceRoot: root,
    paths: platform.paths,
    platform,
    sessionId: "s1",
    turnId: "t1",
    signal,
    gate: createPolicyGate(
      createRulePolicy({ workspaceRoot: root, caseSensitive: true, preset: "full-access" }),
    ),
    readState: createReadStateStore(platform.paths),
    attachmentsDir: root,
    attachments: createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir: root,
      sessionId: "s1",
    }),
    events: {
      emit: (type, payload) => {
        events.push({ type, payload: payload as unknown as Record<string, unknown> });
        return Promise.resolve();
      },
      emitEphemeral: () => undefined,
    },
  };
  const registry = createToolRegistry();
  registry.register({ ...webFetchTool, traits: { ...webFetchTool.traits, timeoutMs } });
  const executor = createToolExecutor(registry);
  return {
    scope,
    events,
    run: (input: unknown = { url: "https://docs.example/start" }) =>
      executor.execute({ callId: "c1", name: "web_fetch", input }, scope),
  };
}

function respond(
  body: ConstructorParameters<typeof Response>[0],
  contentType = "text/plain",
  status = 200,
) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(body, { status, headers: { "Content-Type": contentType } }),
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("web_fetch", () => {
  it.each(["timeout", "cancelled"])("响应体停滞时 %s 取消读取且恰好结算一次", async (status) => {
    const cancel = vi.fn();
    const pulled = vi.fn();
    respond(new ReadableStream({ pull: pulled, cancel }));
    const controller = new AbortController();
    const h = harness(status === "timeout" ? 20 : 30_000, controller.signal);
    const pending = h.run();
    await vi.waitFor(() => expect(pulled).toHaveBeenCalled());
    if (status === "cancelled") controller.abort();
    const result = await pending;
    expect(result.status).toBe(status === "timeout" ? "error" : "cancelled");
    expect(result.result).toMatchObject({ error: { code: status } });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(h.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });

  it.each([
    ["https://DOCS.EXAMPLE:443/start", "docs.example"],
    ["http://DOCS.EXAMPLE:80/start", "docs.example"],
    ["https://DOCS.EXAMPLE:8443/start", "docs.example:8443"],
    ["http://[::1]:8080/start", "[::1]:8080"],
  ])("权限目标规范化 %s", (url, target) => {
    expect(webFetchTool.permissionSubjects({ url }, harness().scope)).toEqual([
      { kind: "network", target, detail: url },
    ]);
  });

  it("本会话允许后同主机不再确认；子会话只读继承，未授权主机拒绝", async () => {
    const h = harness();
    const grants: Grant[] = [];
    const policy = createRulePolicy({
      workspaceRoot: h.scope.workspaceRoot,
      caseSensitive: true,
      grants: { session: grants },
    });
    const gate = createPolicyGate(policy, {
      interactive: true,
      grants: { session: grants },
      newRequestId: () => "p1",
    });
    const first: PermissionSubject = {
      kind: "network",
      target: "docs.example",
      detail: "https://docs.example/first",
    };
    const pending = gate.check([first], "c1", h.scope.signal, {
      turnId: "t1",
      events: h.scope.events,
    });
    expect(
      h.events.find((event) => event.type === "permission.requested")?.payload.subjects,
    ).toEqual([first]);
    await gate.respond?.("p1", { decision: "allow", remember: "session" });
    expect((await pending).decision.action).toBe("allow");
    expect(grants).toHaveLength(1);
    expect(grants[0]).not.toHaveProperty("detail");
    const otherPage = { ...first, detail: "https://docs.example/second" };
    expect((await gate.check([otherPage], "c2", h.scope.signal)).decision.action).toBe("allow");
    expect(h.events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    const inherited = createPolicyGate(
      createRulePolicy({
        workspaceRoot: h.scope.workspaceRoot,
        caseSensitive: true,
        grants: { project: grants },
      }),
    );
    expect((await inherited.check([otherPage], "child1", h.scope.signal)).decision.action).toBe(
      "allow",
    );
    expect(
      (await inherited.check([{ ...first, target: "other.example" }], "child2", h.scope.signal))
        .decision,
    ).toMatchObject({ action: "deny", source: "non_interactive" });
    expect(grants).toHaveLength(1);
  });

  it("PermissionRequest Hook 看不到 detail，显示字段保留且不改变 Hook 判定", async () => {
    const h = harness();
    const run = vi.fn<HookRunner["run"]>().mockResolvedValue({ action: "allow" });
    const gate = createPolicyGate(
      createRulePolicy({ workspaceRoot: h.scope.workspaceRoot, caseSensitive: true }),
      { hooks: { run } },
    );
    for (const detail of ["https://docs.example/first", "https://docs.example/deny"]) {
      const result = await gate.check(
        [{ kind: "network", target: "docs.example", detail }],
        "c1",
        h.scope.signal,
      );
      expect(result.decision).toMatchObject({ action: "allow", source: "hook" });
      expect(result.subjects[0]?.detail).toBe(detail);
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).toEqual(run.mock.calls[1]?.[1]);
    expect(run.mock.calls[0]?.[1].subjects).toEqual([{ kind: "network", target: "docs.example" }]);
  });

  it("注册并以只读特性进入 explore 可选池", () => {
    expect(createBuiltinRegistry().get("web_fetch")).toBe(webFetchTool);
    expect(
      builtinTools().filter((tool) => !tool.traits.mutates && !tool.traits.needsUser),
    ).toContain(webFetchTool);
    expect(webFetchTool.traits).toEqual({
      mutates: false,
      concurrencySafe: true,
      timeoutMs: 30_000,
      maxModelChars: 30_000,
    });
  });

  it("HTML 提取 main、标题与 Markdown，清除全部杂质标签", async () => {
    const removed = [
      "script",
      "style",
      "noscript",
      "svg",
      "iframe",
      "nav",
      "header",
      "footer",
      "aside",
      "form",
    ];
    respond(
      `<html><head><title>A &amp; B</title></head><body><p>outside</p><main><h1>Heading</h1><p>Hello <strong>world</strong></p>${removed.map((tag) => `<${tag}>discard-${tag}</${tag}>`).join("")}</main></body></html>`,
      "text/html",
    );
    const result = (await harness().run()).result;
    expect(result.status).toBe("ok");
    expect(result.modelContent).toContain(
      "URL: https://docs.example/start\n标题: A & B\n\n# Heading",
    );
    expect(result.modelContent).toContain("**world**");
    expect(result.modelContent).not.toMatch(/discard|outside/);
    expect(result.output).toMatchObject({
      title: "A & B",
      status: 200,
      contentType: "text/html",
      chars: result.modelContent.length,
    });
    expect(JSON.stringify(result.output)).not.toContain("Heading");
  });

  it.each([
    "<article><h2>article</h2></article><p>outside</p>",
    "<h2>article</h2><nav>outside</nav>",
  ])("HTML article 与无主体页面：%s", async (html) => {
    respond(html, "application/xhtml+xml");
    const result = (await harness().run()).result;
    expect(result.modelContent).toContain("## article");
    expect(result.modelContent).not.toContain("outside");
  });

  it.each([
    "text/plain",
    "text/markdown",
    "text/css",
    "application/json",
    "application/xml",
    "application/problem+json",
    "application/atom+xml",
    "image/svg+xml",
  ])("%s 原文保留", async (mime) => {
    const text = ' { "hello": "世界" }\r\n';
    respond(text, mime);
    expect((await harness().run()).result.modelContent).toBe(
      `URL: https://docs.example/start\n\n${text}`,
    );
  });

  it.each([
    ["text/plain; charset=gbk", new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), "中文"],
    [
      "text/html",
      new Uint8Array([
        ...new TextEncoder().encode('<meta charset="gbk"><main>'),
        0xd6,
        0xd0,
        0xce,
        0xc4,
        ...new TextEncoder().encode("</main>"),
      ]),
      "中文",
    ],
    [
      "text/html; charset=utf-8",
      new TextEncoder().encode('<meta charset="gbk"><main>中文</main>'),
      "中文",
    ],
    ["text/plain; charset=unknown-encoding", new TextEncoder().encode("中文"), "中文"],
  ])("字符集解码 %s", async (mime, bytes, text) => {
    respond(bytes, mime);
    expect((await harness().run()).result.modelContent).toContain(text);
  });

  it("本地 HTTP 请求使用 GET、共享版本 UA、Accept 和手动重定向", async () => {
    const received: {
      url: string | undefined;
      method: string | undefined;
      ua: string | undefined;
      accept: string | undefined;
      cookie: string | undefined;
    }[] = [];
    const server = createServer((req, res) => {
      received.push({
        url: req.url,
        method: req.method,
        ua: req.headers["user-agent"],
        accept: req.headers.accept,
        cookie: req.headers.cookie,
      });
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/end", "Set-Cookie": "secret=value" });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("done");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    try {
      const h = harness();
      const url = `http://127.0.0.1:${address.port}/start`;
      const result = (await h.run({ url })).result;
      expect(result.status).toBe("ok");
      expect(result.output).toMatchObject({
        url,
        finalUrl: `http://127.0.0.1:${address.port}/end`,
      });
      expect(received.map((req) => req.url)).toEqual(["/start", "/end"]);
      expect(
        received.every(
          (req) =>
            req.method === "GET" &&
            req.ua === `nocturne/${NOCTURNE_VERSION}` &&
            req.cookie === undefined,
        ),
      ).toBe(true);
      expect(received[0]?.accept).toBe(
        "text/html, text/markdown, text/plain, application/json, */*;q=0.5",
      );
      expect(h.events.find((event) => event.type === "tool.started")?.payload.subjects).toEqual([
        expect.objectContaining({
          kind: "network",
          target: `127.0.0.1:${address.port}`,
          detail: url,
        }),
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    "https://other.example/page",
    "https://docs.example:8443/page",
    "http://docs.example:8080/page",
  ])("跨授权主机不跟随 %s", async (location) => {
    const mocked = respond(null, "text/plain", 302);
    mocked.mockImplementation(
      async () => new Response(null, { status: 302, headers: { Location: location } }),
    );
    const result = (await harness().run()).result;
    expect(result.status).toBe("ok");
    expect(result.modelContent).toContain(location);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("默认端口 http → https 升级跟随", async () => {
    const mocked = respond("done");
    mocked.mockImplementationOnce(
      async () =>
        new Response(null, { status: 301, headers: { Location: "https://docs.example/end" } }),
    );
    expect((await harness().run({ url: "http://docs.example/start" })).result.output).toMatchObject(
      { finalUrl: "https://docs.example/end" },
    );
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("至多跟随五次重定向并取消所有响应体", async () => {
    const cancel = vi.fn();
    const mocked = respond(null);
    mocked.mockImplementation(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { Location: "/loop" },
        }),
    );
    const result = (await harness().run()).result;
    expect(result).toMatchObject({ status: "error", error: { code: "network_error" } });
    expect(result.modelContent).toContain("5 次");
    expect(mocked).toHaveBeenCalledTimes(6);
    expect(cancel).toHaveBeenCalledTimes(6);
  });

  it.each([
    "file:///secret",
    "data:text/plain,secret",
    "https://user:pass@other.example/",
    "http://[",
  ])("重定向目标重新校验 %s", async (location) => {
    const mocked = respond(null);
    mocked.mockImplementation(
      async () => new Response(null, { status: 302, headers: { Location: location } }),
    );
    expect((await harness().run()).result).toMatchObject({
      status: "error",
      error: { code: "network_error" },
    });
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it.each([
    "file:///a",
    "data:text/plain,a",
    "ftp://example/a",
    "not-a-url",
    "https://user:pass@example/",
    `https://example/${"x".repeat(2000)}`,
  ])("输入拒绝 %s", async (url) => {
    const mocked = respond("should not fetch");
    const h = harness();
    expect((await h.run({ url })).result).toMatchObject({
      status: "error",
      error: { code: "invalid_input" },
    });
    expect(mocked).not.toHaveBeenCalled();
    expect(h.events.map((event) => event.type)).toEqual(["tool.completed"]);
  });

  it("未知输入字段拒绝", async () => {
    expect(
      (await harness().run({ url: "https://example/", prompt: "summarize" })).result,
    ).toMatchObject({ error: { code: "invalid_input" } });
  });

  it.each([400, 404, 500])("HTTP %s 附正文前 2000 字符", async (status) => {
    respond("x".repeat(3000), "application/json", status);
    const result = (await harness().run()).result;
    expect(result).toMatchObject({
      status: "error",
      error: { code: "http_error" },
      output: { status },
    });
    expect(result.modelContent.split("\n\n")[1]).toHaveLength(2000);
  });

  it.each(["application/pdf", "application/zip", "video/mp4"])(
    "拒绝不支持的类型 %s",
    async (mime) => {
      respond("data", mime);
      const result = (await harness().run()).result;
      expect(result).toMatchObject({ status: "error", error: { code: "unsupported_content" } });
      expect(result.modelContent).toContain(mime);
      expect(result.modelContent).toContain("4 字节");
    },
  );

  it("5 MB 读取硬上限，停止流并注明截断", async () => {
    const cancel = vi.fn();
    respond(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1).fill(120));
        },
        cancel,
      }),
    );
    const h = harness();
    const result = (await h.run()).result;
    expect(result.output).toMatchObject({
      truncatedBytes: true,
      chars:
        "URL: https://docs.example/start\n\n".length +
        5 * 1024 * 1024 +
        "\n\n页面过大，只处理了前 5 MB".length,
    });
    expect(cancel).toHaveBeenCalledOnce();
    const spill = h.events.find((event) => event.type === "tool.completed")?.payload.spillPath;
    expect(typeof spill).toBe("string");
    expect(result.modelContent).toContain(spill as string);
  });

  it("超过 30,000 字符按执行器预算落盘", async () => {
    const text = "x".repeat(40_000);
    respond(text);
    const h = harness();
    const result = (await h.run()).result;
    const spill = h.events.find((event) => event.type === "tool.completed")?.payload.spillPath;
    expect(readFileSync(spill as string, "utf8")).toBe(
      `URL: https://docs.example/start\n\n${text}`,
    );
    expect(result.modelContent).toContain(spill as string);
  });

  it("PNG 图片进入附件通道，不记录 readState", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3e8AAAAASUVORK5CYII=",
      "base64",
    );
    respond(bytes, "image/png");
    const h = harness();
    const record = vi.spyOn(h.scope.readState, "record");
    expect((await h.run()).status).toBe("ok");
    const attachments = h.events.find((event) => event.type === "tool.completed")?.payload
      .attachments;
    expect(attachments).toEqual([
      expect.objectContaining({ mimeType: "image/png", source: "read", width: 1, height: 1 }),
    ]);
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    [new Uint8Array(5 * 1024 * 1024 + 1), "image_too_large"],
    [new Uint8Array([1, 2, 3]), "image_corrupt"],
  ])("图片大小/损坏错误", async (bytes, code) => {
    respond(bytes, "image/png");
    expect((await harness().run()).result).toMatchObject({ status: "error", error: { code } });
  });

  it("网络失败给出原因，恰好一次结算", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(new Error("fetch failed", { cause: new Error("DNS lookup failed") })),
    );
    const h = harness();
    expect((await h.run()).result).toMatchObject({
      status: "error",
      error: { code: "network_error" },
    });
    expect(h.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
    expect(h.events.at(-1)?.payload.modelContent).toContain("DNS lookup failed");
  });

  it.each(["timeout", "cancelled"] as const)("%s 中止 fetch 并恰好一次结算", async (code) => {
    const controller = new AbortController();
    const mocked = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", mocked);
    const h = harness(code === "timeout" ? 20 : 30_000, controller.signal);
    const pending = h.run();
    if (code === "cancelled") {
      await vi.waitFor(() => expect(mocked).toHaveBeenCalledOnce());
      controller.abort();
    }
    const result = await pending;
    expect(result.result).toMatchObject({ error: { code } });
    expect(result.status).toBe(code === "cancelled" ? "cancelled" : "error");
    expect(h.events.filter((event) => event.type === "tool.completed")).toHaveLength(1);
  });
});
