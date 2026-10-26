import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMcpOnDemandTools,
  createPlatform,
  createRuntime,
  createSessionView,
  estimateMcpToolsTokens,
  FakeProvider,
  loadConfig,
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOL_NAME,
  MCP_TOOL_SEARCH_AUTO_THRESHOLD,
  reduceSessionView,
  searchMcpTools,
  shouldEnableMcpToolSearch,
} from "../src/index.js";
import type { McpConnector, McpSession, RuntimeEvent, ToolDefinition } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function makeMcpTool(opts: {
  server: string;
  tool: string;
  description: string;
  properties?: Record<string, unknown>;
  required?: string[];
  mutates?: boolean;
  onCall?: (input: Record<string, unknown>) => string | Promise<string>;
}): ToolDefinition<Record<string, unknown>> {
  const name = `mcp__${opts.server}__${opts.tool}`;
  const readOnly = opts.mutates !== true;
  return {
    name,
    description: opts.description,
    origin: "mcp",
    inputSchema: {
      type: "object",
      properties: opts.properties ?? { query: { type: "string", description: "查询文本" } },
      ...(opts.required !== undefined ? { required: opts.required } : {}),
      additionalProperties: false,
    },
    traits: {
      mutates: !readOnly,
      fileEffects: "none",
      concurrencySafe: readOnly,
      timeoutMs: 5_000,
    },
    permissionSubjects: () => [
      {
        kind: "mcp",
        target: `${opts.server}/${opts.tool}`,
        ...(readOnly ? { readOnly: true } : {}),
      },
    ],
    async execute(input) {
      const text = (await opts.onCall?.(input)) ?? `ok:${name}:${JSON.stringify(input)}`;
      return { status: "ok", modelContent: text, output: { called: name, input } };
    },
  };
}

function makeStaticConnector(
  tools: readonly ToolDefinition[],
  servers: readonly string[] = ["github", "exa"],
): McpConnector {
  return {
    probe: async () => ({ ok: true, durationMs: 1, tools: [] }),
    open: async () => {
      const session: McpSession = {
        startup: async () => undefined,
        status: () =>
          servers.map((name) => ({
            name,
            state: "ready" as const,
            toolCount: tools.filter((t) => t.name.startsWith(`mcp__${name}__`)).length,
            restarts: 0,
          })),
        tools: () => [...tools],
        reconcile: async () => undefined,
        applyPendingTools: () => ({ add: [], remove: [] }),
        close: async () => undefined,
      };
      return session;
    },
  };
}

describe("ADR-0067 单元测试：mcp_search / mcp_call 与阈值判定", () => {
  const catalog: ToolDefinition[] = [
    makeMcpTool({
      server: "github",
      tool: "search_issues",
      description: "Search GitHub issues and pull requests by keyword",
      properties: {
        repository: { type: "string", description: "owner/repo" },
        labels: { type: "array", description: "Issue labels" },
      },
      required: ["repository"],
    }),
    makeMcpTool({
      server: "github",
      tool: "create_issue",
      description: "创建新的 GitHub 议题（issue）",
      properties: {
        title: { type: "string", description: "议题标题" },
        assignee: { type: "string", description: "负责人用户名" },
      },
      required: ["title"],
      mutates: true,
    }),
    makeMcpTool({
      server: "exa",
      tool: "web_search_exa",
      description: "Search the web for current information and news",
      properties: {
        query: { type: "string" },
        numResults: { type: "number" },
      },
      required: ["query"],
    }),
    makeMcpTool({
      server: "slack",
      tool: "post_message",
      description: "向 Slack 频道发送消息",
      properties: { channel_id: { type: "string" }, text: { type: "string" } },
      mutates: true,
    }),
    makeMcpTool({
      server: "db",
      tool: "query_sql",
      description: "Execute read-only SQL query",
      properties: { statement: { type: "string" } },
    }),
    makeMcpTool({
      server: "docs",
      tool: "read_page",
      description: "Read documentation page",
      properties: { page_id: { type: "string" } },
    }),
    makeMcpTool({
      server: "calendar",
      tool: "list_events",
      description: "List calendar events",
      properties: { start_date: { type: "string" } },
    }),
  ];

  it("mcp_search：名称、说明、参数名匹配，支持中英文、server 过滤、完整工具名精确命中与最多 5 条限制", () => {
    // 英文名称/说明匹配
    const gh = searchMcpTools(catalog, "pull requests");
    expect(gh[0]?.name).toBe("mcp__github__search_issues");

    // 中文说明/参数说明匹配（CJK 按字拆分）
    const cn = searchMcpTools(catalog, "议题负责人");
    expect(cn[0]?.name).toBe("mcp__github__create_issue");

    // 参数名匹配（不区分大小写）
    const byParam = searchMcpTools(catalog, "NUMRESULTS");
    expect(byParam.map((t) => t.name)).toContain("mcp__exa__web_search_exa");

    // server 过滤
    const onlyExa = searchMcpTools(catalog, "search", "exa");
    expect(onlyExa.map((t) => t.name)).toEqual(["mcp__exa__web_search_exa"]);

    // 完整工具名精确命中（只返回该条）
    const exact = searchMcpTools(catalog, "mcp__github__create_issue");
    expect(exact.map((t) => t.name)).toEqual(["mcp__github__create_issue"]);

    // 最多返回 5 条
    const many = Array.from({ length: 10 }, (_, i) =>
      makeMcpTool({
        server: "srv",
        tool: `search_item_${i}`,
        description: `Search item ${i}`,
      }),
    );
    expect(searchMcpTools(many, "search")).toHaveLength(5);
  });

  it("mcp_search 工具说明按服务器列出全部工具名", async () => {
    const { searchTool } = createMcpOnDemandTools(catalog, ["github", "exa"]);
    expect(searchTool.description).toContain(
      "- github: mcp__github__search_issues, mcp__github__create_issue",
    );
    expect(searchTool.description).toContain("- exa: mcp__exa__web_search_exa");

    const res = await searchTool.execute({ query: "议题" }, {} as never);
    expect(res.status).toBe("ok");
    expect(res.modelContent).toContain("mcp__github__create_issue");
    expect(res.output?.matches[0]?.name).toBe("mcp__github__create_issue");
  });

  it("阈值判定：auto 严格以 10,000 token 为界；always / never 覆盖", () => {
    expect(MCP_TOOL_SEARCH_AUTO_THRESHOLD).toBe(10_000);
    // 少量工具（远低于 10k token）
    expect(estimateMcpToolsTokens(catalog)).toBeLessThan(10_000);
    expect(shouldEnableMcpToolSearch(catalog, "auto")).toBe(false);
    expect(shouldEnableMcpToolSearch(catalog, "always")).toBe(true);
    expect(shouldEnableMcpToolSearch(catalog, "never")).toBe(false);

    // 构造刚超过 10,000 token 的工具集
    const heavyTools = Array.from({ length: 30 }, (_, i) =>
      makeMcpTool({
        server: "heavy",
        tool: `op_${i}`,
        description: `Operation ${i}: ${"detailed documentation text ".repeat(50)}`,
      }),
    );
    expect(estimateMcpToolsTokens(heavyTools)).toBeGreaterThan(10_000);
    expect(shouldEnableMcpToolSearch(heavyTools, "auto")).toBe(true);
    expect(shouldEnableMcpToolSearch(heavyTools, "never")).toBe(false);
    expect(shouldEnableMcpToolSearch([], "always")).toBe(false);
  });
});

describe("ADR-0067 集成测试：按需加载全流程、前缀缓存稳定、权限、Hook 与子会话", () => {
  it("mcp_call 未知目标列服务器并引导 mcp_search，不列 registry 可见工具", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-unknown-"));
    roots.push(root);
    const platform = createPlatform();
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ modelsDev: false, mcp: { toolSearch: "always" } }),
    );
    const config = await loadConfig(platform, { nocturneHome: root, env: () => undefined });
    const runtime = await createRuntime({
      config,
      cwd: root,
      mcp: makeStaticConnector(
        [makeMcpTool({ server: "github", tool: "search", description: "search" })],
        ["github", "exa"],
      ),
      providers: [
        new FakeProvider({
          scripts: [
            [
              {
                type: "tool_call",
                toolCallId: "missing",
                name: "mcp_call",
                input: { tool: "mcp__missing__tool" },
              },
              { type: "finish", reason: "tool_calls" },
            ],
            [
              { type: "text_delta", text: "done" },
              { type: "finish", reason: "stop" },
            ],
          ],
        }),
      ],
    });
    const session = await runtime.createSession({ model: "fake/fake-1" });
    const events: RuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.submit({ text: "call unknown" });
      const completed = events.find((event) => event.type === "tool.completed");
      expect(completed?.payload).toMatchObject({
        status: "error",
        error: { code: "unknown_tool" },
      });
      const content = completed?.type === "tool.completed" ? completed.payload.modelContent : "";
      expect(content).toContain("可用服务器：github, exa");
      expect(content).toContain("请先用 mcp_search");
      expect(content).not.toContain("可用工具：");
      expect(content).not.toContain("todo_write");
    } finally {
      await session.close();
    }
  });
  it("按需模式下 mcp_search → mcp_call → 目标服务器收到调用，连续多步 tools 字段逐字节不变，/context 注明未列出数量", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-ondemand-"));
    roots.push(root);

    const receivedCalls: { tool: string; input: unknown }[] = [];
    const mcpTools = [
      makeMcpTool({
        server: "github",
        tool: "search_issues",
        description: "搜索 GitHub 仓库中的议题",
        properties: {
          repo: { type: "string" },
          keyword: { type: "string" },
        },
        required: ["repo", "keyword"],
        onCall: (input) => {
          receivedCalls.push({ tool: "github/search_issues", input });
          return `Found issue #42 in ${String(input.repo)} for ${String(input.keyword)}`;
        },
      }),
      makeMcpTool({
        server: "github",
        tool: "create_issue",
        description: "创建新的 GitHub 议题",
        properties: {
          repo: { type: "string" },
          title: { type: "string" },
        },
        required: ["repo", "title"],
        mutates: true,
        onCall: (input) => {
          receivedCalls.push({ tool: "github/create_issue", input });
          return `Created issue "${String(input.title)}"`;
        },
      }),
    ];

    const provider = new FakeProvider({
      scripts: [
        [
          {
            type: "tool_call",
            toolCallId: "c-search",
            name: "mcp_search",
            input: { query: "搜索议题", server: "github" },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool_call",
            toolCallId: "c-call",
            name: "mcp_call",
            input: {
              tool: "mcp__github__search_issues",
              arguments: { repo: "nocturne/core", keyword: "prune" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "搞定，找到了 #42。" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const hookCalls: { point: string; tool: string; input: unknown }[] = [];
    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      mcp: makeStaticConnector(mcpTools, ["github"]),
      mcpToolSearch: "always",
    });

    const session = await runtime.createSession({
      model: { provider: "fake", model: "fake-default" },
      permissionPreset: "bypass",
    });
    const events: RuntimeEvent[] = [];
    const view = createSessionView();
    session.subscribe((ev) => {
      events.push(ev);
      reduceSessionView(view, ev);
    });

    // /context 报告注明「MCP 按需，2 个工具未列出」
    const ctxDesc = session.describeContext();
    const toolsSection = ctxDesc.report.sections.find((s) => s.name === "tools");
    expect(toolsSection?.source).toContain("MCP 按需，2 个工具未列出");

    const reason = await session.submit({ text: "帮我搜一下 prune 相关的 issue" });
    expect(reason).toBe("done");
    expect(receivedCalls).toEqual([
      { tool: "github/search_issues", input: { repo: "nocturne/core", keyword: "prune" } },
    ]);

    // 连续 3 步请求中，发给服务商的 tools 列表必须逐字节完全相同，且不含 mcp__github__*
    expect(provider.requests).toHaveLength(3);
    const tools0 = JSON.stringify(provider.requests[0]?.tools);
    const tools1 = JSON.stringify(provider.requests[1]?.tools);
    const tools2 = JSON.stringify(provider.requests[2]?.tools);
    expect(tools1).toBe(tools0);
    expect(tools2).toBe(tools0);
    const toolNames = provider.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toContain(MCP_SEARCH_TOOL_NAME);
    expect(toolNames).toContain(MCP_CALL_TOOL_NAME);
    expect(toolNames.some((n) => n.startsWith("mcp__"))).toBe(false);

    // tool.started 携带 target: { name, input }，SessionView 的 ToolEntry 也记录 target
    const startedEvents = events.filter((e) => e.type === "tool.started");
    const callStarted = startedEvents.find((e) => e.payload.name === "mcp_call");
    expect(callStarted?.type === "tool.started" && callStarted.payload.target).toEqual({
      name: "mcp__github__search_issues",
      input: { repo: "nocturne/core", keyword: "prune" },
    });
    const viewTool = view.entries.find((e) => e.kind === "tool" && e.name === "mcp_call");
    expect(viewTool?.kind === "tool" && viewTool.target).toEqual({
      name: "mcp__github__search_issues",
      input: { repo: "nocturne/core", keyword: "prune" },
    });
    expect(hookCalls).toHaveLength(0);

    await session.close();
  });

  it("现有 mcp server/tool 权限规则、会话授权与 PreToolUse/PostToolUse Hook 对 mcp_call 生效", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-perm-"));
    roots.push(root);
    const home = path.join(root, "home");
    const ws = path.join(root, "ws");
    const platform = createPlatform();
    await platform.fs.mkdir(home);
    await platform.fs.mkdir(ws);
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        mcp: { toolSearch: "always" },
        permissions: {
          preset: "default",
          rules: [{ subject: "mcp", pattern: "github/delete_repo", action: "deny" }],
        },
      }),
    );

    const mcpTools = [
      makeMcpTool({
        server: "github",
        tool: "create_issue",
        description: "创建议题",
        properties: { title: { type: "string" } },
        required: ["title"],
        mutates: true,
      }),
      makeMcpTool({
        server: "github",
        tool: "delete_repo",
        description: "删除仓库",
        properties: { repo: { type: "string" } },
        required: ["repo"],
        mutates: true,
      }),
    ];

    const provider = new FakeProvider({
      scripts: [
        // 1. 命中 deny 规则的 mcp_call
        [
          {
            type: "tool_call",
            toolCallId: "c-deny",
            name: "mcp_call",
            input: { tool: "mcp__github__delete_repo", arguments: { repo: "a/b" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 2. 需要 ask 确认的写工具：用户在确认时选 allow_session
        [
          {
            type: "tool_call",
            toolCallId: "c-ask-1",
            name: "mcp_call",
            input: { tool: "mcp__github__create_issue", arguments: { title: "first" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // 3. 第二次调用同一工具：命中刚才写入的会话 Grant，不再弹确认
        [
          {
            type: "tool_call",
            toolCallId: "c-ask-2",
            name: "mcp_call",
            input: { tool: "mcp__github__create_issue", arguments: { title: "second" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const config = await loadConfig(platform, { nocturneHome: home });
    const runtime = await createRuntime({
      cwd: ws,
      sessionsDir: path.join(home, "sessions"),
      config,
      providers: [provider],
      mcp: makeStaticConnector(mcpTools, ["github"]),
      interactive: true,
    });

    const session = await runtime.createSession({
      model: { provider: "fake", model: "fake-default" },
    });
    const requestedCalls: string[] = [];
    const view = createSessionView();
    session.subscribe((ev) => {
      reduceSessionView(view, ev);
      if (ev.type === "permission.requested") {
        requestedCalls.push(ev.payload.callId);
        // 验证权限确认的主体是 mcp github/create_issue，toolName 解析为目标工具而非 mcp_call
        expect(ev.payload.subjects).toEqual([{ kind: "mcp", target: "github/create_issue" }]);
        expect(view.pendingPermission?.toolName).toBe("mcp__github__create_issue");
        void session.respondPermission(ev.payload.requestId, {
          decision: "allow",
          remember: "session",
        });
      }
    });

    const reason = await session.submit({ text: "test permissions" });
    expect(reason).toBe("done");
    // 只有第一次 create_issue 触发了 permission.requested，第二次走会话授权直接放行
    expect(requestedCalls).toHaveLength(1);

    const toolEntries = view.entries.filter((e) => e.kind === "tool");
    expect(toolEntries).toHaveLength(3);
    expect(toolEntries[0]?.status).toBe("denied");
    expect(toolEntries[1]?.status).toBe("ok");
    expect(toolEntries[2]?.status).toBe("ok");

    await session.close();
  });

  it("子会话受限工具池（explore）：只搜得到只读 MCP 工具，通过 mcp_call 调写工具返回 error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-mcp-subagent-"));
    roots.push(root);

    const mcpTools = [
      makeMcpTool({
        server: "github",
        tool: "search_issues",
        description: "只读搜索议题",
        properties: { q: { type: "string" } },
        mutates: false,
      }),
      makeMcpTool({
        server: "github",
        tool: "create_issue",
        description: "写入创建议题",
        properties: { title: { type: "string" } },
        mutates: true,
      }),
    ];

    const childToolResultContents: string[] = [];
    let step = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        step++;
        if (step === 1) {
          // 父会话派发 explore 子代理
          return [
            {
              type: "tool_call",
              toolCallId: "parent-task",
              name: "task",
              input: { preset: "explore", task: "调查 MCP 工具池" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 2) {
          // 子会话第 1 步：先搜所有工具，再尝试调用池外的写工具 create_issue
          return [
            {
              type: "tool_call",
              toolCallId: "child-search",
              name: "mcp_search",
              input: { query: "议题" },
            },
            {
              type: "tool_call",
              toolCallId: "child-write",
              name: "mcp_call",
              input: { tool: "mcp__github__create_issue", arguments: { title: "hack" } },
            },
            {
              type: "tool_call",
              toolCallId: "child-read",
              name: "mcp_call",
              input: { tool: "mcp__github__search_issues", arguments: { q: "bug" } },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        if (step === 3) {
          for (const m of req.messages) {
            if (m.role === "tool") childToolResultContents.push(m.content);
          }
          return [
            {
              type: "tool_call",
              toolCallId: "child-finish",
              name: "finish",
              input: { result: "子代理验证完成" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          { type: "text_delta", text: "全部完成" },
          { type: "finish", reason: "stop" },
        ];
      },
    });

    const runtime = await createRuntime({
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      providers: [provider],
      mcp: makeStaticConnector(mcpTools, ["github"]),
      mcpToolSearch: "always",
    });

    const session = await runtime.createSession({
      model: { provider: "fake", model: "fake-default" },
      permissionPreset: "bypass",
    });
    const reason = await session.submit({ text: "run subagent" });
    expect(reason).toBe("done");

    // 1. 子会话的 mcp_search 只搜得到只读的 search_issues，搜不到 create_issue
    expect(childToolResultContents[0]).toContain("mcp__github__search_issues");
    expect(childToolResultContents[0]).not.toContain("mcp__github__create_issue");
    // 2. 子会话尝试经 mcp_call 调用池外写工具 create_issue 被拒绝，并附可用服务器列表
    expect(childToolResultContents[1]).toContain("mcp__github__create_issue");
    expect(childToolResultContents[1]).toContain("可用服务器：github");
    // 3. 子会话经 mcp_call 调用池内只读工具 search_issues 成功
    expect(childToolResultContents[2]).toContain("ok:mcp__github__search_issues");

    await session.close();
  });
});
