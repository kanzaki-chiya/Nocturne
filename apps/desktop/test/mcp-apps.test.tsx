// @vitest-environment jsdom
/**
 * 桌面端 MCP Apps 宿主测试（ADR-0101 第 5、6 节）：
 * - 纯逻辑：主题变量映射、文件扩展名 surface 匹配、ui/message 与 ui/open-link 校验、tool.completed 交付转换；
 * - AppPane（jsdom + 假 iframe）：恢复未显示不发 RPC、首次显示才读页面与调 open.tool、握手门控、
 *   tool-input/tool-result/tool-cancelled、tools/call（只读成功/非只读 app_tool_not_allowed/绑定标签服务器）、
 *   resources/read、ui/message、ui/open-link、ui/request-display-mode、ping、notifications/message、
 *   未知方法 -32601、伪造 event.source 忽略、主题变化 host-context-changed、ui/resource-teardown、插件停用错误页；
 * - SidePanel 新标签页 surface 卡片排序（变更/文件/终端之后）、点击打开、以及面板标签持久化/恢复、
 *   模型调用实时打开与历史重放不打开、点击 .nctdemo 文件引用复用同一标签并调用 open.tool。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionAppSurface, ToolCompletedPayload } from "@nocturne/core/protocol";
import { RpcError, type RpcSession } from "@nocturne/rpc/client";

import { AppPane } from "../src/AppPane";
import {
  deliveryFromToolCompleted,
  extractUiMessageText,
  isAllowedHttpsLink,
  matchSurfaceForFile,
  MCP_APP_STYLE_SOURCES,
  MCP_APPS_PROTOCOL_VERSION,
  readMcpAppTheme,
  type McpAppToolDelivery,
} from "../src/mcp-app-host";
import { SidePanel, type SidePanelProps } from "../src/SidePanel";
import {
  appTabKey,
  restoreSessionPanel,
  storeSessionPanel,
  type AppTab,
  type PanelTab,
} from "../src/side-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
});

const DEMO_SURFACE: SessionAppSurface = {
  pluginId: "nocturne:mcp-apps-demo@builtin",
  pluginName: "MCP Apps 示例",
  serverId: "demo",
  id: "demo-viewer",
  title: "示例面板",
  resourceUri: "ui://demo/viewer.html",
  icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  open: {
    tool: "open_demo_file",
    fileTypes: [".nctdemo"],
  },
};

function makeFakeSession(overrides?: {
  readAppResource?: RpcSession["readAppResource"];
  callAppTool?: RpcSession["callAppTool"];
  listAppSurfaces?: RpcSession["listAppSurfaces"];
}): RpcSession {
  return {
    id: "sess-1",
    readAppResource:
      overrides?.readAppResource ??
      vi.fn().mockResolvedValue({
        uri: "ui://demo/viewer.html",
        mimeType: "text/html;profile=mcp-app",
        html: "<!doctype html><html><body>demo</body></html>",
      }),
    callAppTool:
      overrides?.callAppTool ??
      vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { count: 1 },
      }),
    listAppSurfaces: overrides?.listAppSurfaces ?? vi.fn().mockResolvedValue([DEMO_SURFACE]),
  } as unknown as RpcSession;
}

/** 拦截 iframe.contentWindow.postMessage 并提供从假 iframe 向宿主发消息的辅助函数 */
function attachFakeFrame(iframe: HTMLIFrameElement) {
  const sentToFrame: unknown[] = [];
  const fakeWin = {
    postMessage: (msg: unknown) => {
      sentToFrame.push(msg);
    },
  } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    get: () => fakeWin,
  });
  const sendFromFrame = (data: unknown) => {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: fakeWin }));
    });
  };
  return { sentToFrame, fakeWin, sendFromFrame };
}

describe("mcp-app-host 纯逻辑", () => {
  it("matchSurfaceForFile 按扩展名大小写无关匹配，多插件命中时取 pluginId 字典序第一个", () => {
    const zPlugin: SessionAppSurface = {
      ...DEMO_SURFACE,
      pluginId: "nocturne:z-demo@local",
    };
    const aPlugin: SessionAppSurface = {
      ...DEMO_SURFACE,
      pluginId: "nocturne:a-demo@local",
    };
    expect(matchSurfaceForFile([zPlugin, aPlugin], "Z:\\ws\\sample.NCTDEMO")?.pluginId).toBe(
      "nocturne:a-demo@local",
    );
    expect(matchSurfaceForFile([zPlugin, aPlugin], "Z:\\ws\\readme.md")).toBeUndefined();
    expect(matchSurfaceForFile([zPlugin], "Z:\\ws\\Makefile")).toBeUndefined();
  });

  it("extractUiMessageText 支持对象与数组两种 text content，拒绝非法格式；isAllowedHttpsLink 只放行 https:", () => {
    expect(extractUiMessageText({ role: "user", content: { type: "text", text: "hello" } })).toBe(
      "hello",
    );
    expect(
      extractUiMessageText({
        role: "user",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      }),
    ).toBe("line 1\nline 2");
    expect(
      extractUiMessageText({ role: "user", content: { type: "image", data: "x" } }),
    ).toBeUndefined();

    expect(isAllowedHttpsLink("https://example.com/doc")).toBe(true);
    expect(isAllowedHttpsLink("http://example.com/doc")).toBe(false);
    expect(isAllowedHttpsLink("javascript:alert(1)")).toBe(false);
    expect(isAllowedHttpsLink("file:///C:/Windows/win.ini")).toBe(false);
  });

  it("deliveryFromToolCompleted 正确映射 ok / error / cancelled / interrupted / denied", () => {
    const okPayload = {
      callId: "c1",
      name: "mcp__demo__show_demo",
      status: "ok",
      modelContent: "展示成功",
      output: { structured: { title: "文档A" } },
      durationMs: 5,
    } as unknown as ToolCompletedPayload;
    expect(deliveryFromToolCompleted(okPayload, { title: "文档A" }, 1)).toEqual({
      kind: "result",
      seq: 1,
      arguments: { title: "文档A" },
      result: {
        content: [{ type: "text", text: "展示成功" }],
        structuredContent: { title: "文档A" },
      },
    });

    const errPayload = {
      ...okPayload,
      status: "error",
      modelContent: "boom",
    } as unknown as ToolCompletedPayload;
    expect(deliveryFromToolCompleted(errPayload, { title: "文档A" }, 2)).toMatchObject({
      kind: "result",
      result: { isError: true, content: [{ type: "text", text: "boom" }] },
    });

    for (const status of ["cancelled", "interrupted", "denied"] as const) {
      const cancelled = {
        ...okPayload,
        status,
        error: { code: status, message: `reason:${status}` },
      } as unknown as ToolCompletedPayload;
      expect(deliveryFromToolCompleted(cancelled, { x: 1 }, 3)).toEqual({
        kind: "cancelled",
        seq: 3,
        arguments: { x: 1 },
        reason: `reason:${status}`,
      });
    }
  });

  it("readMcpAppTheme 从 documentElement 读取主题模式与标准化变量映射", () => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--a-bg", "#fafafa");
    document.documentElement.style.setProperty("--a-text", "#18181b");
    const snap = readMcpAppTheme();
    expect(snap.theme).toBe("light");
    expect(snap.variables["--color-background-primary"]).toBe("#fafafa");
    expect(snap.variables["--color-text-primary"]).toBe("#18181b");
    expect(MCP_APP_STYLE_SOURCES.length).toBeGreaterThan(30);
  });
});

describe("AppPane 生命周期、握手与 JSON-RPC 协议（jsdom + 假 iframe）", () => {
  it("重启恢复后的 app 标签在首次显示前不发起 readAppResource 与 callAppTool RPC；显示后才加载并调用 open.tool", async () => {
    const restoredTab: AppTab = {
      id: "app-restored",
      kind: "app",
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      surface: DEMO_SURFACE.id,
      resourceUri: DEMO_SURFACE.resourceUri,
      title: DEMO_SURFACE.title,
      openCall: { tool: "open_demo_file", arguments: { path: "Z:\\ws\\a.nctdemo" } },
    };

    // 验证 panelSessions 序列化/恢复保留标签描述与 openCall
    const stored = storeSessionPanel({
      open: true,
      activeId: "other",
      tabs: [{ id: "other", kind: "new" }, restoredTab],
      treeWidth: 240,
      wrap: true,
      recent: [],
    });
    const rehydrated = restoreSessionPanel(stored, () => "gen-id");
    const rehydratedApp = rehydrated.tabs.find((t): t is AppTab => t.kind === "app");
    expect(rehydratedApp?.openCall).toEqual({
      tool: "open_demo_file",
      arguments: { path: "Z:\\ws\\a.nctdemo" },
    });

    const readAppResource = vi.fn().mockResolvedValue({
      uri: DEMO_SURFACE.resourceUri,
      mimeType: "text/html;profile=mcp-app",
      html: "<h1>restored</h1>",
    });
    const callAppTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "opened file" }],
      structuredContent: { path: "Z:\\ws\\a.nctdemo" },
    });
    const session = makeFakeSession({ readAppResource, callAppTool });

    const { rerender } = render(
      <AppPane
        tab={restoredTab}
        sessionId="sess-1"
        session={session}
        visible={false}
        onAppMessage={vi.fn()}
        openExternalUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // 未显示前不读页面、不调 open.tool、不挂载 iframe
    expect(readAppResource).not.toHaveBeenCalled();
    expect(callAppTool).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();

    // 首次显示后：发起 readAppResource 并调用 open.tool
    rerender(
      <AppPane
        tab={restoredTab}
        sessionId="sess-1"
        session={session}
        visible={true}
        onAppMessage={vi.fn()}
        openExternalUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => {
      expect(readAppResource).toHaveBeenCalledTimes(1);
      expect(callAppTool).toHaveBeenCalledWith({
        pluginId: DEMO_SURFACE.pluginId,
        serverId: DEMO_SURFACE.serverId,
        tool: "open_demo_file",
        arguments: { path: "Z:\\ws\\a.nctdemo" },
      });
    });
  });

  it("完整协议往返：握手门控、tool-input/result、tools/call（只读与拒绝）、ui/message、ui/open-link、主题推送与 teardown", async () => {
    const callAppTool = vi.fn(
      async (opts: { tool: string; serverId: string; pluginId: string }) => {
        if (opts.tool === "mutate_demo_state") {
          throw new RpcError("app_tool_not_allowed", "第一版页面只能调用只读工具", -32000);
        }
        return {
          content: [{ type: "text", text: `ok:${opts.tool}` }],
          structuredContent: { count: 1, server: opts.serverId, plugin: opts.pluginId },
        };
      },
    );
    const readAppResource = vi.fn().mockResolvedValue({
      uri: DEMO_SURFACE.resourceUri,
      mimeType: "text/html;profile=mcp-app",
      html: "<!doctype html><html><body>viewer</body></html>",
    });
    const session = makeFakeSession({ readAppResource, callAppTool });
    const onAppMessage = vi.fn();
    const openExternalUrl = vi.fn().mockResolvedValue(undefined);
    const onDiagnosticLog = vi.fn();
    let teardownFn: ((reason: string) => Promise<void>) | undefined;
    const registerTeardown = (_tabId: string, fn: (reason: string) => Promise<void>) => {
      teardownFn = fn;
      return () => {
        teardownFn = undefined;
      };
    };

    const tab: AppTab = {
      id: "app-1",
      kind: "app",
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      surface: DEMO_SURFACE.id,
      resourceUri: DEMO_SURFACE.resourceUri,
      title: DEMO_SURFACE.title,
    };
    const initialDelivery: McpAppToolDelivery = {
      kind: "result",
      seq: 1,
      arguments: { title: "示例标题" },
      result: {
        content: [{ type: "text", text: "已加载示例：示例标题" }],
        structuredContent: { title: "示例标题" },
      },
    };

    render(
      <AppPane
        tab={tab}
        sessionId="sess-42"
        session={session}
        visible={true}
        delivery={initialDelivery}
        onAppMessage={onAppMessage}
        openExternalUrl={openExternalUrl}
        onDiagnosticLog={onDiagnosticLog}
        registerTeardown={registerTeardown}
      />,
    );

    const iframe = (await waitFor(() => {
      const el = document.querySelector("iframe.sp-app-frame") as HTMLIFrameElement | null;
      expect(el).not.toBeNull();
      return el;
    })) as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");

    const { sentToFrame, sendFromFrame } = attachFakeFrame(iframe);

    // 1) 空壳页就绪 → 宿主只发 load，在 ui/notifications/initialized 前不发任何 JSON-RPC 通知
    sendFromFrame({ type: "nocturne:mcp-app:ready" });
    expect(sentToFrame).toEqual([
      { type: "nocturne:mcp-app:load", html: "<!doctype html><html><body>viewer</body></html>" },
    ]);

    // 伪造其他来源的 postMessage 必须被忽略
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            jsonrpc: "2.0",
            id: 999,
            method: "ui/message",
            params: { content: { type: "text", text: "evil" } },
          },
          source: window,
        }),
      );
    });
    expect(onAppMessage).not.toHaveBeenCalled();

    // 2) ui/initialize 应答
    document.documentElement.dataset.theme = "dark";
    sendFromFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: {
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
        appInfo: { name: "demo", version: "1.0.0" },
        appCapabilities: {},
      },
    });
    expect(sentToFrame[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "nocturne" },
        hostContext: {
          theme: "dark",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          platform: "desktop",
        },
      },
    });
    // 仍未收到 ui/notifications/initialized，不能下发 tool-input/tool-result
    expect(sentToFrame).toHaveLength(2);

    // 3) 收到 ui/notifications/initialized → 顺序下发 tool-input 与 tool-result
    sendFromFrame({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(sentToFrame[2]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { title: "示例标题" } },
    });
    expect(sentToFrame[3]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: initialDelivery.result,
    });

    // 4) tools/call 只读成功（忽略页面传入的恶意 serverId/pluginId）
    sendFromFrame({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fetch_app_stats",
        arguments: { section: "s1" },
        serverId: "evil-server",
        pluginId: "evil-plugin",
      },
    });
    await waitFor(() => {
      expect(sentToFrame.some((m) => (m as { id?: number }).id === 2)).toBe(true);
    });
    expect(callAppTool).toHaveBeenCalledWith({
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      tool: "fetch_app_stats",
      arguments: { section: "s1" },
    });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 2)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { structuredContent: { count: 1, server: "demo" } },
    });

    // 5) tools/call 非只读工具返回 app_tool_not_allowed
    sendFromFrame({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "mutate_demo_state", arguments: {} },
    });
    await waitFor(() => {
      expect(sentToFrame.some((m) => (m as { id?: number }).id === 3)).toBe(true);
    });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 3)).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, data: { code: "app_tool_not_allowed" } },
    });

    // 6) ui/message 写入目标会话草稿（不发送）
    sendFromFrame({
      jsonrpc: "2.0",
      id: 4,
      method: "ui/message",
      params: { role: "user", content: { type: "text", text: "选中段落" } },
    });
    expect(onAppMessage).toHaveBeenCalledWith("sess-42", "选中段落");
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 4)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: {},
    });

    // 7) ui/open-link 仅放行 https:
    sendFromFrame({
      jsonrpc: "2.0",
      id: 5,
      method: "ui/open-link",
      params: { url: "https://example.com/guide" },
    });
    await waitFor(() => {
      expect(sentToFrame.some((m) => (m as { id?: number }).id === 5)).toBe(true);
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/guide");

    sendFromFrame({
      jsonrpc: "2.0",
      id: 6,
      method: "ui/open-link",
      params: { url: "http://insecure.example.com" },
    });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 6)).toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32000 },
    });

    // 8) ping / ui/request-display-mode / notifications/message / 未知方法(-32601)
    sendFromFrame({ jsonrpc: "2.0", id: 7, method: "ping", params: {} });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 7)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {},
    });

    sendFromFrame({
      jsonrpc: "2.0",
      id: 8,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 8)).toEqual({
      jsonrpc: "2.0",
      id: 8,
      result: { mode: "inline" },
    });

    sendFromFrame({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", logger: "viewer", data: "ready" },
    });
    expect(onDiagnosticLog).toHaveBeenCalledWith(expect.stringContaining("viewer"));

    sendFromFrame({
      jsonrpc: "2.0",
      id: 9,
      method: "ui/update-model-context",
      params: { content: [] },
    });
    expect(sentToFrame.find((m) => (m as { id?: number }).id === 9)).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601 },
    });

    // 9) 深浅色切换推送 ui/notifications/host-context-changed
    act(() => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => {
      expect(
        sentToFrame.some(
          (m) =>
            (m as { method?: string; params?: { theme?: string } }).method ===
              "ui/notifications/host-context-changed" &&
            (m as { params?: { theme?: string } }).params?.theme === "light",
        ),
      ).toBe(true);
    });

    // 10) 优雅卸载：发 ui/resource-teardown，收到应答后 resolve
    if (teardownFn === undefined) throw new Error("teardown callback not registered");
    const tdPromise = teardownFn("close");
    const tdReq = sentToFrame.find(
      (m) => (m as { method?: string }).method === "ui/resource-teardown",
    ) as { id: number; method: string; params: { reason: string } } | undefined;
    expect(tdReq).toMatchObject({ method: "ui/resource-teardown", params: { reason: "close" } });
    if (tdReq === undefined) throw new Error("teardown request not sent");
    sendFromFrame({ jsonrpc: "2.0", id: tdReq.id, result: {} });
    await tdPromise;
  });

  it("插件停用或卸载时显示错误页、不自动关闭，且不发起读取请求", () => {
    const readAppResource = vi.fn();
    const session = makeFakeSession({ readAppResource });
    const tab: AppTab = {
      id: "app-disabled",
      kind: "app",
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      surface: DEMO_SURFACE.id,
      resourceUri: DEMO_SURFACE.resourceUri,
      title: DEMO_SURFACE.title,
    };

    render(
      <AppPane
        tab={tab}
        sessionId="sess-1"
        session={session}
        visible={true}
        pluginDisabled={true}
        onAppMessage={vi.fn()}
        openExternalUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("插件已停用或已卸载");
    expect(readAppResource).not.toHaveBeenCalled();
  });

  it("pluginDisabled 从 undefined 变为 false 时不重读资源、不重置 iframe", async () => {
    const readAppResource = vi.fn().mockResolvedValue({
      uri: DEMO_SURFACE.resourceUri,
      mimeType: "text/html;profile=mcp-app",
      html: "<!doctype html><html><body>stable</body></html>",
    });
    const session = makeFakeSession({ readAppResource });
    const tab: AppTab = {
      id: "app-stable",
      kind: "app",
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      surface: DEMO_SURFACE.id,
      resourceUri: DEMO_SURFACE.resourceUri,
      title: DEMO_SURFACE.title,
    };

    const { rerender } = render(
      <AppPane
        tab={tab}
        sessionId="sess-1"
        session={session}
        visible={true}
        pluginDisabled={undefined}
        onAppMessage={vi.fn()}
        openExternalUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const iframeBefore = await waitFor(() => {
      const el = document.querySelector("iframe.sp-app-frame") as HTMLIFrameElement | null;
      if (el === null) throw new Error("iframe not mounted");
      return el;
    });
    expect(readAppResource).toHaveBeenCalledTimes(1);

    rerender(
      <AppPane
        tab={tab}
        sessionId="sess-1"
        session={session}
        visible={true}
        pluginDisabled={false}
        onAppMessage={vi.fn()}
        openExternalUrl={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(readAppResource).toHaveBeenCalledTimes(1);
    expect(document.querySelector("iframe.sp-app-frame")).toBe(iframeBefore);
  });
});

describe("SidePanel 新标签页 surface 卡片与点击打开", () => {
  function sidePanelProps(overrides: Partial<SidePanelProps>): SidePanelProps {
    return {
      tabs: [{ id: "new-1", kind: "new" }],
      activeId: "new-1",
      overlay: false,
      width: 480,
      workspace: "Z:\\ws",
      canOpenFiles: true,
      onActivate: vi.fn(),
      onCloseTab: vi.fn(),
      onMoveTab: vi.fn(),
      onNewTab: vi.fn(),
      onResize: vi.fn(),
      onOpenChanges: vi.fn(),
      onQuickOpen: vi.fn(),
      onOpenTerminal: vi.fn(),
      onAddress: vi.fn().mockResolvedValue(undefined),
      changes: {
        workspace: "Z:\\ws",
        turns: new Map(),
        userSeqs: [],
        loadDiff: vi.fn(),
      },
      readFile: vi.fn(),
      readerKey: "rk-1",
      fileActions: {
        externalLabel: "VS Code",
        openExternal: vi.fn().mockResolvedValue(undefined),
        reveal: vi.fn().mockResolvedValue(undefined),
        openInBrowser: vi.fn().mockResolvedValue(undefined),
        browserLabel: "浏览器",
      },
      terminals: undefined,
      loadShells: vi.fn().mockResolvedValue({ shells: [], selected: "" }),
      onShellChange: vi.fn(),
      ...overrides,
    };
  }

  it("新标签页在「变更」「文件」「终端」之后展示已启用插件的 surface 卡片，点击打开对应 surface", () => {
    const onOpenSurface = vi.fn();
    render(
      <SidePanel
        {...sidePanelProps({
          apps: {
            sessionId: "sess-1",
            session: makeFakeSession(),
            surfaces: [DEMO_SURFACE],
            onOpenSurface,
            deliveryFor: () => undefined,
            resolveMeta: (t) => ({ title: t.title, icon: t.icon }),
            onAppMessage: vi.fn(),
            openExternalUrl: vi.fn().mockResolvedValue(undefined),
            registerTeardown: () => () => undefined,
          },
        })}
      />,
    );

    const toolButtons = Array.from(document.querySelectorAll(".sp-tools button.sp-tool"));
    const names = toolButtons.map((b) => b.querySelector(".sp-tool-name")?.textContent?.trim());
    expect(names).toEqual(["变更", "文件", "终端", "示例面板"]);

    const demoBtn = toolButtons[3] as HTMLButtonElement;
    // 无悬停 title，且只含 surface 标题，不含副标题说明
    expect(demoBtn.getAttribute("title")).toBeNull();
    expect(demoBtn.querySelector(".sp-tool-sub")).toBeNull();
    expect(demoBtn.querySelector("img.sp-plugin-icon")?.getAttribute("src")).toBe(
      DEMO_SURFACE.icon,
    );

    fireEvent.click(demoBtn);
    expect(onOpenSurface).toHaveBeenCalledWith(DEMO_SURFACE);
  });

  it("同一插件同一 surface 复用同一个标签键，点击 .nctdemo 文件引用复用标签并触发 open.tool", async () => {
    const callAppTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "opened" }],
      structuredContent: { path: "Z:\\ws\\notes.nctdemo" },
    });
    const session = makeFakeSession({ callAppTool });
    const tab: AppTab = {
      id: "app-shared",
      kind: "app",
      pluginId: DEMO_SURFACE.pluginId,
      serverId: DEMO_SURFACE.serverId,
      surface: DEMO_SURFACE.id,
      resourceUri: DEMO_SURFACE.resourceUri,
      title: DEMO_SURFACE.title,
      openCall: { tool: "open_demo_file", arguments: { path: "Z:\\ws\\first.nctdemo" } },
    };
    expect(appTabKey(tab)).toBe(`${DEMO_SURFACE.pluginId}\0s:${DEMO_SURFACE.id}`);

    const tabs: PanelTab[] = [tab];
    const { rerender } = render(
      <SidePanel
        {...sidePanelProps({
          tabs,
          activeId: tab.id,
          apps: {
            sessionId: "sess-1",
            session,
            surfaces: [DEMO_SURFACE],
            onOpenSurface: vi.fn(),
            deliveryFor: () => undefined,
            openCallSeqFor: () => 1,
            resolveMeta: (t) => ({ title: t.title, icon: t.icon }),
            onAppMessage: vi.fn(),
            openExternalUrl: vi.fn().mockResolvedValue(undefined),
            registerTeardown: () => () => undefined,
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(callAppTool).toHaveBeenCalledWith({
        pluginId: DEMO_SURFACE.pluginId,
        serverId: DEMO_SURFACE.serverId,
        tool: "open_demo_file",
        arguments: { path: "Z:\\ws\\first.nctdemo" },
      });
    });

    // 再次点击另一个 .nctdemo 文件引用：复用同一标签（同一个 tab.id）并再次调用 open.tool
    const updatedTab: AppTab = {
      ...tab,
      openCall: { tool: "open_demo_file", arguments: { path: "Z:\\ws\\second.nctdemo" } },
    };
    rerender(
      <SidePanel
        {...sidePanelProps({
          tabs: [updatedTab],
          activeId: tab.id,
          apps: {
            sessionId: "sess-1",
            session,
            surfaces: [DEMO_SURFACE],
            onOpenSurface: vi.fn(),
            deliveryFor: () => undefined,
            openCallSeqFor: () => 2,
            resolveMeta: (t) => ({ title: t.title, icon: t.icon }),
            onAppMessage: vi.fn(),
            openExternalUrl: vi.fn().mockResolvedValue(undefined),
            registerTeardown: () => () => undefined,
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(callAppTool).toHaveBeenCalledWith({
        pluginId: DEMO_SURFACE.pluginId,
        serverId: DEMO_SURFACE.serverId,
        tool: "open_demo_file",
        arguments: { path: "Z:\\ws\\second.nctdemo" },
      });
    });
  });
});
