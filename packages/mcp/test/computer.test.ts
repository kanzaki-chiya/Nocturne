import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import release from "../src/computer-release.json" with { type: "json" };
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
          : target.pid === 86512
            ? { packageFamilyName: "Microsoft.WindowsNotepad_8wekyb3d8bbwe", name: "Notepad" }
            : target.identity?.startsWith("shell:appsFolder\\Microsoft.WindowsNotepad_")
              ? {
                  packageFamilyName: "Microsoft.WindowsNotepad_8wekyb3d8bbwe",
                  name: "Windows 记事本",
                }
              : target.identity?.toLowerCase() === "notepad.exe"
                ? { exePath: "C:/Windows/System32/notepad.exe", name: "notepad" }
                : target.identity?.toLowerCase() === "calc.exe"
                  ? { exePath: "C:/Windows/System32/calc.exe", name: "calc" }
                  : target.identity?.toLowerCase() === "mspaint.exe"
                    ? { exePath: "C:/Windows/System32/mspaint.exe", name: "mspaint" }
                    : target.identity !== undefined &&
                        /^[a-z]:[\\/].*\.exe$/iu.test(target.identity)
                      ? { exePath: target.identity }
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
  it("随附驱动清单只保留所需文件，且 fetch-computer 清理目标目录多余旧文件", async () => {
    const expectedFiles = ["LICENSE", "THIRD_PARTY_NOTICES.md", "cua-driver.exe"];
    expect(Object.keys(release.files).sort()).toEqual(expectedFiles);
    const rootDir = join(fileURLToPath(new URL("../../..", import.meta.url)));
    const destDir = mkdtempSync(join(tmpdir(), "nocturne-computer-"));
    for (const name of [...expectedFiles, "stale-unused.dll", "cua_driver_sdk.dll"])
      writeFileSync(join(destDir, name), "x");
    const proc = platform.process.spawnPipe(process.execPath, [
      join(rootDir, "scripts/fetch-computer.mjs"),
      "--prune-only",
      destDir,
    ]);
    proc.stdin.end();
    const exit = await proc.wait();
    expect(exit.code).toBe(0);
    expect(readdirSync(destDir).sort()).toEqual(expectedFiles);
    rmSync(destDir, { recursive: true, force: true });
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
  it("驱动环境保留系统用户目录变量，CUA_* 目录在 Nocturne 用户数据目录下且关闭遥测", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const env = structured(await tool(session, "list_windows").execute({}, ctx())).env as Record<
      string,
      string | undefined
    >;
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("false");
    expect(env.CUA_TELEMETRY_ENABLED).toBe("false");
    expect(env.CUA_TELEMETRY_DISABLED).toBe("1");
    expect(env.CUA_TELEMETRY).toBe("false");
    expect(env.CUA_DRIVER_RS_UPDATE_CHECK).toBe("0");
    for (const key of [
      "CUA_HOME",
      "CUA_DRIVER_HOME",
      "CUA_DRIVER_LOCAL_HOME",
      "CUA_DRIVER_RS_HOME",
      "CUA_DRIVER_TELEMETRY_HOME",
      "CUA_DRIVER_CURSOR_THEME_DIR",
    ])
      expect(env[key]?.replaceAll("\\", "/")).toContain("dist/test-computer/computer/");
    for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"] as const)
      expect(env[key]).toBe(process.env[key]);
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
  it.each(["text", "structured"])(
    "%s 快照不带逐元素 token，后续句柄仍解析到快照所属软件",
    async (fixture) => {
      const { source, open } = make();
      await source.setEnabled(true);
      const session = await open("a");
      const result = await tool(session, "get_window_state").execute({ fixture }, ctx());
      expect(result.modelContent.length).toBeGreaterThan(100_000);
      const click = tool(session, "click");
      const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
      const token = fixture === "text" ? "s00000001:88" : "s00000002:88";
      const request = click.permissionSubjects({ element_token: token }, scope)[0];
      if (!request || !click.resolveSubject) throw new Error("缺少解析器");
      expect(await click.resolveSubject(request, scope)).toMatchObject({
        target: fixture === "text" ? "Microsoft.WindowsNotepad_8wekyb3d8bbwe" : "excel.exe",
        appUnresolved: false,
        app: {
          pid: fixture === "text" ? 86512 : 20,
          windowId: fixture === "text" ? 78711444 : 100,
        },
      });
    },
  );
  it("未知快照保留未解析主体，确认主体不包含句柄，也不借用最近软件", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    await tool(session, "get_window_state").execute({ fixture: "text" }, ctx());
    const click = tool(session, "click");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    const request = click.permissionSubjects({ element_token: "sffffffff:88" }, scope)[0];
    if (!request || !click.resolveSubject) throw new Error("缺少解析器");
    const subject = await click.resolveSubject(request, scope);
    expect(subject.appUnresolved).toBe(true);
    expect(subject.target).toBe("");
    expect(JSON.stringify(subject)).not.toContain("sffffffff:88");
    expect(subject.app?.pid).toBeUndefined();
  });
  it("启动记事本别名与后续 PID 使用同一包族身份；普通 exe 保持小写名", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    const launch = tool(session, "launch_app");
    const window = tool(session, "get_window_state");
    const launchRequest = launch.permissionSubjects({ name: "notepad.exe" }, scope)[0];
    const windowRequest = window.permissionSubjects({ pid: 86512, window_id: 78711444 }, scope)[0];
    if (!launchRequest || !windowRequest || !launch.resolveSubject || !window.resolveSubject)
      throw new Error("缺少解析器");
    const before = await launch.resolveSubject(launchRequest, scope);
    const after = await window.resolveSubject(windowRequest, scope);
    expect(before.target).toBe("Microsoft.WindowsNotepad_8wekyb3d8bbwe");
    expect(before.appUnresolved).toBe(false);
    expect(before.app?.identity).toBe(after.app?.identity);
    expect(before.app).toMatchObject({ packageFamilyName: after.target });
    const ordinary = launch.permissionSubjects({ name: "C:/Office/EXCEL.EXE" }, scope)[0];
    if (!ordinary) throw new Error("缺少主体");
    expect((await launch.resolveSubject(ordinary, scope)).target).toBe("excel.exe");
  });
  it("同一包族名在启动和窗口两条路径使用同一份本地化显示名", async () => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("localized");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    const launch = tool(session, "launch_app");
    const window = tool(session, "get_window_state");
    const launchRequest = launch.permissionSubjects({ name: "notepad.exe" }, scope)[0];
    const windowRequest = window.permissionSubjects({ pid: 86512, window_id: 78711444 }, scope)[0];
    if (!launchRequest || !windowRequest || !launch.resolveSubject || !window.resolveSubject)
      throw new Error("缺少解析器");
    const before = await launch.resolveSubject(launchRequest, scope);
    const after = await window.resolveSubject(windowRequest, scope);
    expect(before.app?.name).toBe("Windows 记事本");
    expect(after.app?.name).toBe(before.app?.name);
    expect((await launch.resolveSubject(launchRequest, scope)).app?.name).toBe(after.app?.name);
  });
  it.each([
    [{ name: "calc.exe" }, "Microsoft.WindowsCalculator_8wekyb3d8bbwe"],
    [{ name: "mspaint.exe" }, "Microsoft.Paint_8wekyb3d8bbwe"],
    [{ name: "Notep" }, "Microsoft.WindowsNotepad_8wekyb3d8bbwe"],
    [{ path: "C:/Custom/NOTEPAD.EXE", name: "Notepad" }, "notepad.exe"],
    [
      { aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
      "Microsoft.WindowsNotepad_8wekyb3d8bbwe",
    ],
    [
      { bundle_id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
      "Microsoft.WindowsNotepad_8wekyb3d8bbwe",
    ],
    [
      {
        launch_path: "shell:appsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App",
        path: "C:/Office/EXCEL.EXE",
      },
      "Microsoft.Paint_8wekyb3d8bbwe",
    ],
  ])("启动身份尊重别名与目标字段优先级：%j", async (input, identity) => {
    const { source, open } = make();
    await source.setEnabled(true);
    const session = await open("a");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    const launch = tool(session, "launch_app");
    const request = launch.permissionSubjects(input, scope)[0];
    if (!request || !launch.resolveSubject) throw new Error("缺少解析器");
    expect(await launch.resolveSubject(request, scope)).toMatchObject({
      target: identity,
      appUnresolved: false,
    });
  });
  it("同一 PID 第二次解析命中缓存不再调底层；创建时间变化时重新解析；同一 ApplicationFrameHost 不同窗口分别解析；解析时不取图标", async () => {
    const creationTimes = new Map<number, string>([
      [20, "1000"],
      [30, "2000"],
    ]);
    const calls: {
      pid?: number | undefined;
      windowId?: number | undefined;
      includeIcon?: boolean | undefined;
    }[] = [];
    const source = createComputerSource({
      platform,
      cwd,
      verifyPackage: async () => undefined,
      home: platform.paths.join(cwd, "dist/test-computer"),
      executable: process.execPath,
      args: [fileURLToPath(new URL("./fake-computer.mjs", import.meta.url))],
      getProcessCreationTime: async (pid) => creationTimes.get(pid),
      resolveApplication: async (target, opts) => {
        calls.push({ pid: target.pid, windowId: target.windowId, includeIcon: opts?.includeIcon });
        if (target.pid === 20) {
          return creationTimes.get(20) === "1000"
            ? { exePath: "C:/Office/EXCEL.EXE", name: "Excel" }
            : { exePath: "C:/Windows/notepad.exe", name: "Notepad" };
        }
        if (target.pid === 30) {
          return {
            exePath: "C:/Windows/System32/ApplicationFrameHost.exe",
            packageFamilyName:
              target.windowId === 101
                ? "Microsoft.Calculator_8wekyb3d8bbwe"
                : "Microsoft.WindowsStore_8wekyb3d8bbwe",
            name: target.windowId === 101 ? "计算器" : "Microsoft Store",
          };
        }
        return undefined;
      },
    });
    sources.push(source);
    await source.setEnabled(true);
    const connector = createMcpConnector({ runtimeServers: [source] });
    const session = await connector.open({
      servers: [],
      cwd,
      workspaceRoot: cwd,
      sessionId: "cache-test",
      platform,
      emitServer: () => undefined,
      warn: () => undefined,
    });
    sessions.push(session);
    await session.startup();
    session.applyPendingTools();
    const t = tool(session, "get_window_state");
    const scope = { cwd, workspaceRoot: cwd, paths: platform.paths };
    const resolve = async (pid: number, window_id: number) => {
      const req = t.permissionSubjects({ pid, window_id }, scope)[0];
      if (!req || !t.resolveSubject) throw new Error("缺少解析器");
      return t.resolveSubject(req, scope);
    };

    const first = await resolve(20, 100);
    expect(first.target).toBe("excel.exe");
    expect(first.app?.icon).toBeUndefined();
    expect(calls).toEqual([{ pid: 20, windowId: 100, includeIcon: false }]);

    const second = await resolve(20, 100);
    expect(second.target).toBe("excel.exe");
    expect(calls).toHaveLength(1);

    creationTimes.set(20, "1001");
    const reused = await resolve(20, 100);
    expect(reused.target).toBe("notepad.exe");
    expect(calls).toHaveLength(2);

    const uwp1 = await resolve(30, 101);
    expect(uwp1.target).toBe("Microsoft.Calculator_8wekyb3d8bbwe");
    expect(calls).toHaveLength(3);

    const uwp1Cached = await resolve(30, 101);
    expect(uwp1Cached.target).toBe("Microsoft.Calculator_8wekyb3d8bbwe");
    expect(calls).toHaveLength(3);

    const uwp2 = await resolve(30, 102);
    expect(uwp2.target).toBe("Microsoft.WindowsStore_8wekyb3d8bbwe");
    expect(calls).toHaveLength(4);
  });
  it("确认卡取图标：同一 identity 第二次取图标不再调用底层解析", async () => {
    const calls: { pid?: number | undefined; includeIcon?: boolean | undefined }[] = [];
    const source = createComputerSource({
      platform,
      cwd,
      verifyPackage: async () => undefined,
      home: platform.paths.join(cwd, "dist/test-computer"),
      executable: process.execPath,
      args: [fileURLToPath(new URL("./fake-computer.mjs", import.meta.url))],
      resolveApplication: async (target, opts) => {
        calls.push({ pid: target.pid, includeIcon: opts?.includeIcon });
        return { exePath: "C:/Office/EXCEL.EXE", name: "Excel", icon: "RVhDRUw=" };
      },
    });
    sources.push(source);
    const app = { pid: 20, windowId: 100, identity: "excel.exe" };
    expect(await source.resolveIcon(app, app.identity)).toBe("RVhDRUw=");
    expect(calls).toEqual([{ pid: 20, includeIcon: true }]);
    expect(await source.resolveIcon({ pid: 21, identity: "excel.exe" }, "excel.exe")).toBe(
      "RVhDRUw=",
    );
    expect(calls).toHaveLength(1);
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
