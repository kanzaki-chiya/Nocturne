/**
 * MCP 会话装配测试（mcp.md 第 8 节）：注入式 McpConnector，
 * 验证 MCP 工具走普通注册表与执行管线、权限主体为 mcp 类别、
 * Turn 边界应用工具集变化、close 清理进程集合。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import type {
  McpConnector,
  McpOpenScope,
  McpServerStatus,
  McpToolDiff,
  ToolContext,
  ToolDefinition,
} from "../src/tools/index.js";
import type { RuntimeEvent } from "../src/protocol/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

function echoTool(remote: string, text = "ok"): ToolDefinition {
  return {
    name: `mcp__fake__${remote}`,
    description: `fake ${remote}`,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    traits: { mutates: true, concurrencySafe: false, timeoutMs: 5_000 },
    permissionSubjects: () => [{ kind: "mcp", target: `fake/${remote}` }],
    execute: (input: unknown, _ctx: ToolContext) =>
      Promise.resolve({
        status: "ok",
        modelContent: `${text}:${JSON.stringify(input)}`,
      }),
  };
}

interface Stub {
  connector: McpConnector;
  diff: { add: ToolDefinition[]; remove: string[] };
  closed: () => boolean;
  scope: () => McpOpenScope | undefined;
}

function stubConnector(tools: ToolDefinition[]): Stub {
  const state = { closed: false, scope: undefined as McpOpenScope | undefined };
  const diff: McpToolDiff = { add: [], remove: [] };
  return {
    diff,
    closed: () => state.closed,
    scope: () => state.scope,
    connector: {
      open: (scope) => {
        state.scope = scope;
        return Promise.resolve({
          tools: () => tools,
          status: (): McpServerStatus[] => [
            { name: "fake", state: "ready", toolCount: tools.length, restarts: 0 },
          ],
          applyPendingTools: () => {
            const d = { add: [...diff.add], remove: [...diff.remove] };
            diff.add = [];
            diff.remove = [];
            return d;
          },
          close: () => {
            state.closed = true;
            return Promise.resolve();
          },
        });
      },
    },
  };
}

async function makeRuntime(
  scripts: ConstructorParameters<typeof FakeProvider>[0]["scripts"],
  connector: Stub,
  extra?: { autoApproveAsk?: boolean },
) {
  const runtime = await createRuntime({
    cwd: tmp("nct-mcp-ws-"),
    sessionsDir: tmp("nct-mcp-sessions-"),
    providers: [new FakeProvider({ scripts })],
    permissions: extra?.autoApproveAsk === true ? { autoApproveAsk: true } : undefined,
    mcp: connector.connector,
    mcpServers: [{ name: "fake", origin: "user", command: "unused" }],
  });
  return runtime;
}

describe("Runtime MCP 装配", () => {
  it("MCP 工具经普通注册表 + 执行管线调用，主体为 mcp 类别", async () => {
    const stub = stubConnector([echoTool("echo")]);
    const runtime = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "t1", name: "mcp__fake__echo", input: { text: "hi" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "done" }, { type: "finish", reason: "stop" }],
      ],
      stub,
      { autoApproveAsk: true },
    );
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    const reason = await session.submit({ text: "call it" });
    expect(reason).toBe("done");

    const started = events.find(
      (e) => e.type === "tool.started" && e.payload.name === "mcp__fake__echo",
    );
    expect(started?.type).toBe("tool.started");
    if (started?.type === "tool.started") {
      expect(started.payload.subjects).toEqual([
        { kind: "mcp", target: "fake/echo" },
      ]);
    }
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type).toBe("tool.completed");
    if (completed?.type === "tool.completed") {
      expect(completed.payload.status).toBe("ok");
      expect(completed.payload.modelContent).toContain("ok:");
    }
    expect(session.mcpServers()[0]?.name).toBe("fake");
    await session.close();
    expect(stub.closed()).toBe(true);
  });

  it("非交互 + 默认预设：mcp 主体为 ask → 结算为 deny(non_interactive)", async () => {
    const stub = stubConnector([echoTool("echo")]);
    const runtime = await makeRuntime(
      [
        [
          { type: "tool_call", toolCallId: "t1", name: "mcp__fake__echo", input: { text: "hi" } },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "done" }, { type: "finish", reason: "stop" }],
      ],
      stub,
    );
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.submit({ text: "call it" });
    const completed = events.find((e) => e.type === "tool.completed");
    expect(completed?.type === "tool.completed" && completed.payload.status).toBe("denied");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(
      resolved?.type === "permission.resolved" && resolved.payload.source,
    ).toBe("non_interactive");
    await session.close();
  });

  it("applyPendingTools 在 Turn 边界应用：新工具下一 Turn 可调用", async () => {
    const stub = stubConnector([echoTool("echo")]);
    stub.diff.add.push(echoTool("added", "added"));
    const runtime = await makeRuntime(
      [
        [{ type: "text_delta", text: "first" }, { type: "finish", reason: "stop" }],
        [
          { type: "tool_call", toolCallId: "t2", name: "mcp__fake__added", input: {} },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "text_delta", text: "done" }, { type: "finish", reason: "stop" }],
      ],
      stub,
      { autoApproveAsk: true },
    );
    const session = await runtime.createSession({ model: "fake/fake-model" });
    await session.submit({ text: "one" });
    const events: RuntimeEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.submit({ text: "two" });
    const completed = events.find((e) => e.type === "tool.completed");
    expect(
      completed?.type === "tool.completed" && completed.payload.modelContent,
    ).toContain("added:");
    await session.close();
  });
});
