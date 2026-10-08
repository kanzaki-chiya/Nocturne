/**
 * MCP 连接器离线测试（mcp.md 验收）：假 stdio 服务器覆盖
 * 正常调用 / isError / 超时 / 崩溃与惰性重连 / list_changed 暂存 /
 * 环境白名单。
 */
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";

import {
  createPlatform,
  type McpOpenScope,
  type McpServerPayload,
  type McpSession,
  type Platform,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@nocturne/core";

import { createMcpConnector } from "../src/index.js";

const FAKE_SERVER = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));

const processes = createProcessCleanup();
const platform: Platform = processes.platform(createPlatform());
afterEach(async () => {
  await processes.cleanup();
});
const cwd = process.cwd();

interface Opened {
  session: McpSession;
  servers: McpServerPayload[];
  warnings: { code: string; message: string }[];
}

async function openFake(extra?: Record<string, unknown>): Promise<Opened> {
  const servers: McpServerPayload[] = [];
  const warnings: { code: string; message: string }[] = [];
  const scope: McpOpenScope = {
    servers: [
      {
        name: "fake",
        origin: "user",
        command: process.execPath,
        args: [FAKE_SERVER],
        ...(extra as object),
      },
    ],
    cwd,
    workspaceRoot: cwd,
    sessionId: "test-session",
    platform,
    emitServer: (p) => servers.push(p),
    warn: (code, message) => warnings.push({ code, message }),
  };
  const session = await createMcpConnector().open(scope);
  await session.startup();
  session.applyPendingTools();
  return { session, servers, warnings };
}

function getTool(session: McpSession, name: string): ToolDefinition {
  const tool = session.tools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`工具 ${name} 未注册`);
  return tool;
}

const ctx = { signal: new AbortController().signal, callId: "call-1" } as ToolContext;

async function call(tool: ToolDefinition, input: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute(input, ctx);
}

describe("MCP 连接器（假 stdio 服务器）", () => {
  it("open 在受控慢启动前返回 starting；等待可中断，工具就绪仍暂存直到边界", async () => {
    let release!: () => void;
    const held = new Promise<string>((resolve) => {
      release = () => {
        resolve("value");
      };
    });
    const session = await createMcpConnector().open({
      servers: [
        {
          name: "slow",
          origin: "user",
          command: process.execPath,
          args: [FAKE_SERVER],
          env: { GATE: { stored: true } },
        },
      ],
      cwd,
      workspaceRoot: cwd,
      sessionId: "slow",
      platform,
      credentials: { get: () => held },
      emitServer: () => undefined,
      warn: () => undefined,
    });
    try {
      expect(session.status()[0]?.state).toBe("starting");
      expect(session.tools()).toEqual([]);
      const ac = new AbortController();
      const waiting = session.startup(ac.signal);
      ac.abort();
      await waiting;
      expect(session.status()[0]?.state).toBe("starting");
      release();
      await session.startup();
      expect(session.status()[0]?.state).toBe("ready");
      expect(session.tools()).toEqual([]);
      expect(session.applyPendingTools().add.length).toBeGreaterThan(0);
    } finally {
      release();
      await session.close();
    }
  });

  it("启动中关闭后不再 spawn，取消已启动的连接并清理进程", async () => {
    let release!: () => void;
    const gate = new Promise<string>((resolve) => {
      release = () => {
        resolve("value");
      };
    });
    const spawn = vi.spyOn(platform.process, "spawnPipe");
    try {
      const session = await createMcpConnector().open({
        servers: [
          {
            name: "slow",
            origin: "user",
            command: process.execPath,
            args: [FAKE_SERVER],
            env: { GATE: { stored: true } },
          },
        ],
        cwd,
        workspaceRoot: cwd,
        sessionId: "close",
        platform,
        credentials: { get: () => gate },
        emitServer: () => undefined,
        warn: () => undefined,
      });
      await session.close();
      release();
      await session.startup();
      expect(spawn).not.toHaveBeenCalled();
      const connecting = await createMcpConnector().open({
        servers: [
          {
            name: "slow",
            origin: "user",
            command: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            startupTimeoutMs: 3000,
          },
        ],
        cwd,
        workspaceRoot: cwd,
        sessionId: "kill",
        platform,
        emitServer: () => undefined,
        warn: () => undefined,
      });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await connecting.close();
      await connecting.startup();
      expect(connecting.status().map((server) => server.state)).toEqual(["stopped"]);
    } finally {
      release();
      spawn.mockRestore();
    }
  });

  it("启动服务器并列出工具，echo 正常调用往返", async () => {
    const { session, servers } = await openFake();
    try {
      expect(session.status().map((s) => s.state)).toEqual(["ready"]);
      const echo = getTool(session, "mcp__fake__echo");
      expect(
        echo.permissionSubjects({}, { cwd, workspaceRoot: cwd, paths: platform.paths }),
      ).toEqual([{ kind: "mcp", target: "fake/echo" }]);
      const res = await call(echo, { text: "你好" });
      expect(res.status).toBe("ok");
      expect(res.modelContent).toBe("你好");
      expect(servers.map((s) => s.state)).toEqual(["starting", "ready"]);
    } finally {
      await session.close();
    }
  });

  it("isError 结果映射为 error/tool_error", async () => {
    const { session } = await openFake();
    try {
      const res = await call(getTool(session, "mcp__fake__fail"), {});
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error?.code).toBe("tool_error");
      expect(res.modelContent).toContain("isError");
    } finally {
      await session.close();
    }
  });

  it("callTimeoutMs 超时返回 error/timeout", async () => {
    const { session } = await openFake({ callTimeoutMs: 200 });
    try {
      const res = await call(getTool(session, "mcp__fake__sleep"), { ms: 5_000 });
      expect(res.status).toBe("error");
      expect(res.status === "error" && res.error?.code).toBe("timeout");
    } finally {
      await session.close();
    }
  });

  it("服务器崩溃：调用报错 mcp_server_crashed，下一次调用惰性重连后成功", async () => {
    const { session, warnings } = await openFake();
    try {
      const crash = await call(getTool(session, "mcp__fake__crash"), {});
      expect(crash.status).toBe("error");
      expect(["mcp_server_crashed", "mcp_unavailable"]).toContain(
        crash.status === "error" ? crash.error?.code : undefined,
      );
      // 崩溃状态反映到 status 与 warning
      expect(session.status()[0]?.state).toBe("crashed");
      expect(warnings.some((w) => w.code === "mcp_server_crashed")).toBe(true);

      const echo = await call(getTool(session, "mcp__fake__echo"), { text: "回来了" });
      expect(echo.status).toBe("ok");
      expect(echo.modelContent).toBe("回来了");
      expect(session.status()[0]?.restarts).toBe(1);
      expect(session.status()[0]?.state).toBe("ready");
    } finally {
      await session.close();
    }
  });

  it("list_changed 暂存，applyPendingTools 后才生效", async () => {
    const { session } = await openFake();
    try {
      await call(getTool(session, "mcp__fake__mutate"), {});
      // 等通知处理与 tools/list 完成
      await new Promise((r) => setTimeout(r, 300));
      expect(session.tools().some((t) => t.name === "mcp__fake__added")).toBe(false);
      const diff = session.applyPendingTools();
      expect(diff.add.map((t) => t.name)).toContain("mcp__fake__added");
      expect(session.tools().some((t) => t.name === "mcp__fake__added")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("子进程只拿到白名单环境（NOCTURNE_* / API Key 不可见），显式 env 叠加生效", async () => {
    process.env.NOCTURNE_TEST_SECRET = "should-not-leak";
    process.env.NOCTURNE_TEST_VISIBLE = "visible-value";
    const { session } = await openFake({ env: { DECLARED: "${NOCTURNE_TEST_VISIBLE}" } });
    try {
      const res = await call(getTool(session, "mcp__fake__env_report"), {
        keys: ["NOCTURNE_TEST_SECRET", "PATH", "DECLARED"],
      });
      const report = JSON.parse(res.modelContent) as Record<string, boolean>;
      expect(report.NOCTURNE_TEST_SECRET).toBe(false);
      expect(report.DECLARED).toBe(true);
      expect(report.PATH ?? report.Path).toBe(true);
    } finally {
      delete process.env.NOCTURNE_TEST_SECRET;
      delete process.env.NOCTURNE_TEST_VISIBLE;
      await session.close();
    }
  });

  it("启动失败降级为 failed（不抛出），状态与警告可见", async () => {
    const servers: McpServerPayload[] = [];
    const warnings: { code: string; message: string }[] = [];
    const session = await createMcpConnector().open({
      servers: [
        {
          name: "bad",
          origin: "user",
          command: "definitely-not-a-real-command-xyz",
          startupTimeoutMs: 3_000,
        },
      ],
      cwd,
      workspaceRoot: cwd,
      sessionId: "test-session",
      platform,
      emitServer: (p) => servers.push(p),
      warn: (code, message) => warnings.push({ code, message }),
    });
    try {
      await session.startup();
      const st = session.status()[0];
      expect(st?.state).toBe("failed");
      expect(st?.error).toBeDefined();
      expect(warnings.some((w) => w.code === "mcp_server_failed")).toBe(true);
    } finally {
      await session.close();
    }
  });
});
