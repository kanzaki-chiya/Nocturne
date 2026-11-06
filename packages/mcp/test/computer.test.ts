import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createPlatform,
  type McpOpenScope,
  type McpSession,
  type ToolContext,
} from "@nocturne/core";
import { createProcessCleanup } from "../../../scripts/test/process-cleanup.mjs";
import { createMcpConnector } from "../src/connector.js";
import {
  createComputerSource,
  applicationIdentity,
  takeComputerBootstrap,
  validateComputerPackage,
} from "../src/computer.js";

const cleanup = createProcessCleanup();
const platform = cleanup.platform(createPlatform());
const sources: ReturnType<typeof createComputerSource>[] = [];
const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(sources.splice(0).map((s) => s.close()));
  await cleanup.cleanup();
});
const cwd = process.cwd();
function make() {
  const source = createComputerSource({
    platform,
    cwd,
    verifyPackage: async () => undefined,
    home: platform.paths.join(cwd, "dist/test-computer"),
    executable: process.execPath,
    args: [fileURLToPath(new URL("./fake-computer.mjs", import.meta.url))],
    resolveApplication: async (target) =>
      target.pid === 30
        ? { packageFamilyName: "Microsoft.Calculator_8wekyb3d8bbwe", name: "计算器" }
        : target.pid === 20
          ? { exePath: "C:/Office/EXCEL.EXE", name: "Excel" }
          : undefined,
  });
  sources.push(source);
  const connector = createMcpConnector({ runtimeServers: [source] });
  async function open(sessionId: string) {
    const scope: McpOpenScope = {
      servers: [],
      cwd,
      workspaceRoot: cwd,
      sessionId,
      platform,
      emitServer: () => undefined,
      warn: () => undefined,
    };
    const session = await connector.open(scope);
    sessions.push(session);
    await session.startup();
    session.applyPendingTools();
    return session;
  }
  return { source, open };
}
function tool(s: McpSession, name: string) {
  const found = s.tools().find((t) => t.name === `mcp__computer__${name}`);
  if (!found) throw new Error(name);
  return found;
}
const ctx = (sessionId = "a", turnId = "turn"): ToolContext =>
  ({
    sessionId,
    turnId,
    callId: "call",
    signal: new AbortController().signal,
    subjects: [],
  }) as unknown as ToolContext;
function structured(result: { output?: unknown }) {
  return (result.output as { structured: Record<string, unknown> }).structured;
}

describe("ADR-0082 内置电脑来源（假 MCP）", () => {
  it("启动变量读取后删除；非法值也不留在后台环境；损坏文件不能启动", async () => {
    const env = {
      NOCTURNE_COMPUTER_USE_BOOTSTRAP: JSON.stringify({ executable: "C:/driver/cua-driver.exe" }),
    };
    expect(takeComputerBootstrap(env)).toEqual({ executable: "C:/driver/cua-driver.exe" });
    expect(env).not.toHaveProperty("NOCTURNE_COMPUTER_USE_BOOTSTRAP");
    const invalid = { NOCTURNE_COMPUTER_USE_BOOTSTRAP: "invalid" };
    expect(() => takeComputerBootstrap(invalid)).toThrow();
    expect(invalid).not.toHaveProperty("NOCTURNE_COMPUTER_USE_BOOTSTRAP");
    await expect(
      validateComputerPackage(
        { ...platform, fs: { ...platform.fs, readFile: async () => Buffer.from("changed") } },
        platform.paths.join(cwd, "cua-driver.exe"),
      ),
    ).rejects.toThrow("SHA-256");
  });
  it("两会话共享一个 stdio 进程；单会话关闭不停止；关闭开关后边界移除，重新开启恢复", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const [a, b] = await Promise.all([open("a"), open("b")]);
    const pa = structured(await tool(a, "list_windows").execute({}, ctx()));
    expect(structured(await tool(b, "list_windows").execute({}, ctx("b"))).pid).toBe(pa.pid);
    await a.close();
    expect((await tool(b, "list_windows").execute({}, ctx("b"))).status).toBe("ok");
    await source.setEnabled(false);
    expect(b.applyPendingTools().remove).toContain("mcp__computer__list_windows");
    expect(b.tools()).toEqual([]);
    await source.setEnabled(true);
    b.applyPendingTools();
    expect(tool(b, "list_windows")).toBeDefined();
  });
  it("白名单排除未知、browser、更新、录制和回放工具", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const names = session.tools().map((t) => t.name);
    for (const name of [
      "unknown_future_tool",
      "browser_click",
      "check_for_update",
      "start_recording",
      "replay_trajectory",
    ])
      expect(names).not.toContain(`mcp__computer__${name}`);
    expect(names).toContain("mcp__computer__get_window_state");
  });
  it("驱动环境关闭遥测并隔离全部 home 路径", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const env = structured(await tool(session, "list_windows").execute({}, ctx())).env as Record<
      string,
      string
    >;
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("false");
    expect(env.CUA_TELEMETRY).toBe("false");
    for (const key of [
      "CUA_DRIVER_RS_HOME",
      "CUA_DRIVER_TELEMETRY_HOME",
      "HOME",
      "USERPROFILE",
      "LOCALAPPDATA",
    ])
      expect(env[key]?.replaceAll("\\", "/")).toContain("dist/test-computer/computer/");
  });
  it("exe 小写、打包应用包族名；未知 PID 保留且不能当作无主体", async () => {
    expect(applicationIdentity({ exePath: "C:/Office/EXCEL.EXE" })).toBe("excel.exe");
    expect(applicationIdentity({ exePath: "C:/Windows/ApplicationFrameHost.exe" })).toBeUndefined();
    expect(
      applicationIdentity({
        exePath: "C:/Windows/ApplicationFrameHost.exe",
        packageFamilyName: "Microsoft.Calculator_8wekyb3d8bbwe",
      }),
    ).toBe("Microsoft.Calculator_8wekyb3d8bbwe");
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const t = tool(session, "get_window_state");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    for (const [pid, identity] of [
      [20, "excel.exe"],
      [30, "Microsoft.Calculator_8wekyb3d8bbwe"],
    ] as const) {
      const request = t.permissionSubjects({ pid, window_id: 100 }, scope)[0];
      if (!request || !t.resolveSubject) throw new Error("缺少解析器");
      expect((await t.resolveSubject(request, scope)).target).toBe(identity);
    }
    const request = t.permissionSubjects({ pid: 99 }, scope)[0];
    if (!request || !t.resolveSubject) throw new Error("缺少解析器");
    expect(await t.resolveSubject(request, scope)).toMatchObject({
      kind: "app",
      target: "PID 99",
      appUnresolved: true,
    });
    for (const name of ["list_windows", "list_apps", "clipboard_read"])
      expect(tool(session, name).permissionSubjects({}, scope)).toEqual([]);
  });
  it("剪贴板首次写入前备份，Turn 结束恢复；外部修改后不恢复", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const s = await open("a");
    await tool(s, "clipboard_write").execute({ text: "first" }, ctx());
    await tool(s, "clipboard_write").execute({ text: "second" }, ctx());
    await s.finishTurn?.("a");
    expect(structured(await tool(s, "clipboard_read").execute({}, ctx())).text).toBe("original");
    await tool(s, "clipboard_write").execute({ text: "ours" }, ctx("a", "next"));
    await tool(s, "clipboard_read").execute({ external: "user" }, ctx());
    await s.finishTurn?.("a");
    expect(structured(await tool(s, "clipboard_read").execute({}, ctx())).text).toBe("user");
  });
  it("无法核对的结果只执行一次，工具说明要求重新观察", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const s = await open("a");
    const t = tool(s, "get_window_state");
    expect(t.description).toContain("先观察");
    expect(structured(await t.execute({ pid: 20, window_id: 100 }, ctx()))).toMatchObject({
      effect: "unverifiable",
      calls: 1,
    });
  });
});
