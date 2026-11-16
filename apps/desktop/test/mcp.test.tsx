import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../src/McpPage";
import { parseMcpImport } from "../src/mcp-import";
import { RpcFail, fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

describe("MCP JSON 导入", () => {
  it("三种格式、HTTP 推断、SSE 跳过、重名提示和密钥转 stored", () => {
    const rows = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          one: { command: "node", env: { API_TOKEN: "test-token-123" } },
          two: { type: "streamable-http", url: "https://example.com/mcp" },
          three: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer test-token-123" },
          },
          old: { type: "sse", url: "https://example.com/sse" },
        },
      }),
      ["ONE"],
    );
    expect(rows[0]?.notice).toContain("重名");
    expect(rows[0]?.draft?.config.env?.API_TOKEN).toEqual({ stored: true });
    expect(rows[1]?.draft?.config.type).toBe("http");
    expect(rows[1]?.notice).toContain("OAuth");
    expect(rows[2]?.draft?.secrets.Authorization).toBe("Bearer test-token-123");
    expect(rows[3]?.draft).toBeUndefined();
    expect(rows[3]?.notice).toContain("暂不支持");
    expect(parseMcpImport('{"named":{"command":"node"}}', [])[0]?.id).toBe("named");
    expect(parseMcpImport('{"url":"https://example.com/mcp"}', [])[0]?.draft?.config.type).toBe(
      "http",
    );
    expect(parseMcpImport('{"command":"node"}', [])[0]?.id).toBe("");
    expect(() => parseMcpImport("broken", [])).toThrow();
  });
});

describe("MCP 设置页", () => {
  it("状态点和状态格取当前会话的连接状态，手动测试结果优先", async () => {
    const server = (id: string, enabled = true) => ({
      id,
      origin: "app",
      editable: true,
      trusted: true,
      path: "home/mcp.json",
      transport: "http",
      enabled,
      url: "https://example.com/mcp",
      headers: [],
      startupTimeoutMs: 15000,
      callTimeoutMs: 60000,
    });
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [server("up"), server("down"), server("off", false), server("none")],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.probeMcpServer": {
          ok: false,
          durationMs: 100,
          tools: [],
          error: { code: "connect_failed", message: "x" },
        },
      }),
    );
    await f.initialize();
    const statuses = [
      { name: "up", state: "ready" as const, toolCount: 3 },
      { name: "down", state: "failed" as const, toolCount: 0, error: "连接被拒绝" },
      { name: "off", state: "ready" as const, toolCount: 1 },
    ];
    const loadLive = () => Promise.resolve(statuses);
    const page = (version: number) => (
      <McpPage
        client={f.client}
        workspaceRoot={undefined}
        version={version}
        onChanged={() => undefined}
        loadLive={loadLive}
      />
    );
    const { container, rerender } = render(page(0));
    await screen.findByText("up");
    const dots = () =>
      Array.from(container.querySelectorAll(".dot")).map((dot) =>
        dot.className.replace(/^dot ?/, ""),
      );
    await waitFor(() => expect(dots()).toEqual(["ok", "warn", ""]));

    const statusText = () => screen.getByRole("region", { name: "状态" }).textContent;
    fireEvent.click(screen.getByText("up"));
    expect(statusText()).toContain("已连接3 个工具");
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    fireEvent.click(screen.getByText("down"));
    expect(statusText()).toContain("未连接");
    expect(statusText()).toContain("连接被拒绝");
    expect(screen.getByTitle("连接被拒绝")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    fireEvent.click(screen.getByText("off"));
    expect(statusText()).toContain("未测试");
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    fireEvent.click(screen.getByText("none"));
    expect(statusText()).toContain("未测试");
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    fireEvent.click(screen.getByText("up"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(statusText()).toContain("测试失败"));
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    await waitFor(() => expect(dots()).toEqual(["warn", "warn", ""]));

    rerender(page(1));
    await waitFor(() => expect(dots()).toEqual(["ok", "warn", ""]));
    f.close();
  });

  it.each(["stdio", "http"])("%s 编辑名称锁定、值类型说明与凭据不可用提示", async (transport) => {
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [
            {
              id: "managed",
              origin: "app",
              editable: true,
              trusted: true,
              path: "home/mcp.json",
              transport,
              enabled: true,
              command: "node",
              url: "https://example.com/mcp",
              env: [],
              headers: [],
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
          ],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: false } } },
      }),
    );
    await f.initialize();
    render(
      <McpPage
        client={f.client}
        workspaceRoot={undefined}
        version={0}
        onChanged={() => undefined}
      />,
    );
    await screen.findByText("managed");
    fireEvent.click(screen.getByText("managed"));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    const name = screen.getByLabelText(/^名称/) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.classList.contains("mcp-name-locked")).toBe(true);
    if (transport === "stdio") {
      expect(screen.getByLabelText("参数")).toBeDefined();
      expect(screen.queryByLabelText("参数，一行一个")).toBeNull();
    }
    expect(screen.getByRole("region", { name: "超时" })).toBeDefined();
    expect(screen.getByLabelText("启动")).toBeDefined();
    expect(screen.getByLabelText("调用")).toBeDefined();
    expect(screen.queryByText(/系统凭据后端不可用，保存到凭据库不可选/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: transport === "http" ? "添加请求头" : "添加变量" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "值类型 1" }));
    const list = within(screen.getByRole("listbox"));
    expect(list.queryByText(/值原样写进 mcp\.json/)).toBeNull();
    expect(list.queryByText(/启动时从 Nocturne 的进程环境读取/)).toBeNull();
    const stored = list.getByRole("option", { name: /保存到凭据库/ });
    expect(stored.getAttribute("aria-disabled")).toBe("true");
    expect(within(stored).getByText("系统凭据后端不可用，请引用环境变量")).toBeDefined();
    fireEvent.click(stored);
    expect(screen.getByRole("combobox").textContent).toContain("明文");
    f.close();
  });

  it.each([
    ["auth_required", "认证失败，请检查请求头"],
    ["spawn_failed", "启动失败，请检查命令是否已安装、路径是否正确"],
    ["startup_timeout", "启动超时，请检查服务器是否正常启动或增加启动超时"],
    ["http_redirect", "服务器重定向到其他地址，请检查 HTTP 地址"],
    ["mcp_secret_missing", "缺少已保存的凭据，请替换密钥或引用环境变量"],
  ])("%s 详情显示错误原文及 title，列表保留原状态文字", async (code, text) => {
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [
            {
              id: "managed",
              origin: "app",
              editable: true,
              trusted: true,
              path: "home/mcp.json",
              transport: "http",
              enabled: true,
              url: "https://example.com/mcp",
              headers: [],
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
          ],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.probeMcpServer": {
          ok: false,
          durationMs: 100,
          tools: [],
          error: { code, message: "连接失败，请检查服务器配置" },
          httpStatus: 401,
        },
      }),
    );
    await f.initialize();
    render(
      <McpPage
        client={f.client}
        workspaceRoot={undefined}
        version={0}
        onChanged={() => undefined}
      />,
    );
    await screen.findByText("managed");
    fireEvent.click(screen.getByText("managed"));
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    const originalError = "连接失败，请检查服务器配置";
    await screen.findByTitle(originalError);
    const statusRegion = screen.getByRole("region", { name: "状态" });
    expect(statusRegion.textContent).toContain("测试失败");
    expect(statusRegion.textContent).toContain(originalError);
    expect(within(statusRegion).getByTitle(originalError)).toBeDefined();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    expect(screen.getByText(text)).toBeDefined();
    f.close();
  });

  it("来源分组与只读开关、编辑类型切换保留名称、默认 stored 和保存传播", async () => {
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [
            {
              id: "managed",
              origin: "app",
              editable: true,
              trusted: true,
              path: "home/mcp.json",
              transport: "stdio",
              enabled: true,
              command: "node",
              args: [],
              env: [],
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
            {
              id: "manual",
              origin: "user",
              editable: false,
              trusted: true,
              path: "home/config.json",
              transport: "http",
              url: "https://example.com/mcp",
              headers: [],
              enabled: true,
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
          ],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.saveMcpServer": { id: "test" },
      }),
    );
    await f.initialize();
    const changed = vi.fn();
    render(
      <McpPage client={f.client} workspaceRoot="test-workspace" version={0} onChanged={changed} />,
    );
    await screen.findByText("managed");
    const readonlyRegion = screen.getByRole("region", { name: "只读 · 1" });
    expect(readonlyRegion).toBeDefined();
    expect(readonlyRegion.querySelector(".badge")).toBeNull();
    const listSwitch = within(readonlyRegion).getByRole("switch");
    expect(listSwitch.hasAttribute("disabled")).toBe(true);
    expect(listSwitch.getAttribute("title")).toBe("来自 home/config.json，请修改该文件");

    fireEvent.click(within(readonlyRegion).getByText("manual"));
    const badge = screen.getByText("只读");
    expect(badge.getAttribute("title")).toBe("来自 home/config.json，请修改该文件");
    const detailSwitch = screen.getByRole("switch");
    expect(detailSwitch.hasAttribute("disabled")).toBe(true);
    expect(detailSwitch.getAttribute("title")).toBe("来自 home/config.json，请修改该文件");
    expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
    expect(screen.queryByText(/只读：在 home\/config\.json 中定义/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "远程地址（HTTP）" }));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe("test");
    fireEvent.change(screen.getByLabelText(/^地址/), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加请求头" }));
    fireEvent.change(screen.getByLabelText("请求头名 1"), { target: { value: "Authorization" } });
    expect(screen.getByRole("combobox", { name: "值类型 1" }).textContent).toContain(
      "保存到凭据库",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "值类型 1" }));
    const stored = within(screen.getByRole("listbox")).getByRole("option", {
      name: /保存到凭据库/,
    });
    expect(stored.getAttribute("aria-disabled")).toBeNull();
    expect(within(stored).queryByText(/值存进系统凭据库/)).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.change(screen.getByLabelText("值 1"), { target: { value: "test-token-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(f.calls.find((call) => call.method === "mcp.saveMcpServer")?.params).toMatchObject({
      id: "test",
      config: { type: "http", headers: { Authorization: { stored: true } } },
      secrets: { Authorization: "test-token-123" },
    });
    expect(screen.getByRole("status").textContent).toContain("已保存 test");
    expect(screen.getByRole("status").textContent).not.toContain("本轮结束后");
    f.close();
  });

  it("点行进详情、面包屑返回、表单取消流向与保存进详情", async () => {
    let saved = false;
    const baseServer = {
      id: "context7",
      origin: "app" as const,
      editable: true,
      trusted: true,
      path: "home/mcp.json",
      transport: "stdio" as const,
      enabled: true,
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [{ name: "CONTEXT7_API_KEY", kind: "stored" as const, stored: "set" as const }],
      startupTimeoutMs: 15000,
      callTimeoutMs: 60000,
    };
    const f = fakeServer({
      ...withInit({
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.saveMcpServer": () => {
          saved = true;
          return {
            ...baseServer,
            id: "created",
            transport: "http",
            url: "https://example.com/mcp",
            headers: [],
            env: undefined,
            command: undefined,
            args: undefined,
          };
        },
      }),
      "mcp.describeMcpServers": () => ({
        servers: saved
          ? [
              baseServer,
              {
                ...baseServer,
                id: "created",
                transport: "http",
                url: "https://example.com/mcp",
                headers: [],
                env: undefined,
                command: undefined,
                args: undefined,
              },
            ]
          : [baseServer],
        warnings: [],
      }),
    });
    await f.initialize();
    render(
      <McpPage
        client={f.client}
        workspaceRoot={undefined}
        version={0}
        onChanged={() => undefined}
      />,
    );

    await screen.findByText("context7");
    expect(screen.getByText(/本地命令/)).toBeDefined();
    expect(screen.getByText("npx -y @upstash/context7-mcp")).toBeDefined();

    // 点行进详情
    fireEvent.click(screen.getByText("context7"));
    expect(screen.getByRole("button", { name: "MCP" })).toBeDefined();
    expect(screen.getByRole("region", { name: "状态" }).textContent).toContain("—");
    const conn = screen.getByRole("region", { name: "连接" });
    expect(conn.textContent).toContain("本地命令");
    expect(conn.textContent).toContain("npx -y @upstash/context7-mcp");
    expect(conn.textContent).toContain("会话工作区（默认）");
    const envRegion = screen.getByRole("region", { name: "环境变量 · 1" });
    expect(envRegion.textContent).toContain("CONTEXT7_API_KEY");
    expect(envRegion.textContent).toContain("凭据库");
    const timeoutRegion = screen.getByRole("region", { name: "超时" });
    expect(timeoutRegion.textContent).toContain("15 秒");
    expect(timeoutRegion.textContent).toContain("60 秒");

    // 编辑取消回详情
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
    expect(screen.getByRole("button", { name: "MCP" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("region", { name: "连接" })).toBeDefined();

    // 面包屑返回列表
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeDefined();

    // 新增取消回列表
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    expect(screen.getByRole("heading", { name: /添加 MCP 服务器/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeDefined();

    // 新增保存进详情
    fireEvent.click(screen.getByRole("button", { name: "添加服务器" }));
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: "created" } });
    fireEvent.click(screen.getByRole("button", { name: "远程地址（HTTP）" }));
    fireEvent.change(screen.getByLabelText(/^地址/), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "连接" })).toBeDefined());
    expect(screen.getByRole("region", { name: "连接" }).textContent).toContain("流式 HTTP");
    expect(screen.getByRole("region", { name: "请求头" }).textContent).toContain("—");
    f.close();
  });

  it("列表行点击启用开关仅调用启用，不导航到详情", async () => {
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [
            {
              id: "managed",
              origin: "app",
              editable: true,
              trusted: true,
              path: "home/mcp.json",
              transport: "stdio",
              enabled: true,
              command: "node",
              args: [],
              env: [],
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
          ],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.setMcpServerEnabled": {},
      }),
    );
    await f.initialize();
    const changed = vi.fn();
    render(<McpPage client={f.client} workspaceRoot={undefined} version={0} onChanged={changed} />);
    await screen.findByText("managed");
    fireEvent.click(screen.getByRole("switch", { name: "启用" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(f.calls.find((call) => call.method === "mcp.setMcpServerEnabled")?.params).toEqual({
      id: "managed",
      enabled: false,
    });
    expect(screen.getByRole("status").textContent).toContain("已停用");
    // 仍在列表页，未进入详情
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "连接" })).toBeNull();
    f.close();
  });

  it("详情更多菜单删除确认后回列表", async () => {
    let deleted = false;
    const server = {
      id: "managed",
      origin: "app" as const,
      editable: true,
      trusted: true,
      path: "home/mcp.json",
      transport: "stdio" as const,
      enabled: true,
      command: "node",
      args: [],
      env: [],
      startupTimeoutMs: 15000,
      callTimeoutMs: 60000,
    };
    const f = fakeServer({
      ...withInit({
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.deleteMcpServer": () => {
          deleted = true;
          return {};
        },
      }),
      "mcp.describeMcpServers": () => ({
        servers: deleted ? [] : [server],
        warnings: [],
      }),
    });
    await f.initialize();
    const changed = vi.fn();
    render(<McpPage client={f.client} workspaceRoot={undefined} version={0} onChanged={changed} />);
    await screen.findByText("managed");
    fireEvent.click(screen.getByText("managed"));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const deleteItem = screen.getByRole("menuitem", { name: "删除" });
    expect(deleteItem.classList.contains("danger")).toBe(true);
    fireEvent.click(deleteItem);

    const dialog = screen.getByRole("dialog", { name: "删除 MCP 服务器" });
    const checkbox = within(dialog).getByRole("checkbox", {
      name: "同时删除保存的凭据",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(dialog.textContent).not.toContain("保存的凭据。");

    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(f.calls.find((call) => call.method === "mcp.deleteMcpServer")?.params).toEqual({
      id: "managed",
    });
    expect(screen.queryByRole("dialog", { name: "删除 MCP 服务器" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("已删除 managed");
    expect(screen.getByText("给 Nocturne 接上外部工具")).toBeDefined();
    f.close();
  });

  it.each(["启用", "删除", "保存"])("%s失败后显示错误并重新拉取列表", async (action) => {
    const fail = () => new RpcFail(-32000, "配置未能应用到会话");
    const f = fakeServer(
      withInit({
        "mcp.describeMcpServers": {
          servers: [
            {
              id: "managed",
              origin: "app",
              editable: true,
              trusted: true,
              path: "home/mcp.json",
              transport: "stdio",
              enabled: true,
              command: "node",
              args: [],
              env: [],
              startupTimeoutMs: 15000,
              callTimeoutMs: 60000,
            },
          ],
          warnings: [],
        },
        "provider.describeProviderSetup": { credential: { backend: { available: true } } },
        "mcp.setMcpServerEnabled": fail,
        "mcp.deleteMcpServer": fail,
        "mcp.saveMcpServer": fail,
      }),
    );
    await f.initialize();
    render(
      <McpPage
        client={f.client}
        workspaceRoot={undefined}
        version={0}
        onChanged={() => undefined}
      />,
    );
    await screen.findByText("managed");
    const lists = () => f.calls.filter((call) => call.method === "mcp.describeMcpServers").length;
    expect(lists()).toBe(1);
    if (action === "启用") {
      fireEvent.click(screen.getByRole("switch"));
    } else if (action === "删除") {
      fireEvent.click(screen.getByText("managed"));
      fireEvent.click(screen.getByRole("button", { name: "更多" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
      const dialog = screen.getByRole("dialog", { name: "删除 MCP 服务器" });
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    } else {
      fireEvent.click(screen.getByText("managed"));
      fireEvent.click(screen.getByRole("button", { name: "更多" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "编辑" }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    }
    await waitFor(() => expect(lists()).toBe(2));
    expect(screen.getByText(/配置未能应用到会话/)).toBeDefined();
    expect(screen.queryByRole("switch", { name: /面板浏览器/ })).toBeNull();
    f.close();
  });
});
