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
    await screen.findByRole("heading", { name: "managed" });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const name = screen.getByLabelText(/^名称/) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.classList.contains("mcp-name-locked")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: transport === "http" ? "＋ 添加请求头" : "＋ 添加变量" }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "值类型 1" }));
    const list = within(screen.getByRole("listbox"));
    expect(list.getByText("值原样写进 mcp.json，适合地址、开关这类非敏感内容")).toBeDefined();
    expect(list.getByText("启动时从 Nocturne 的进程环境读取同名或指定变量")).toBeDefined();
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
  ])("%s 在最近测试与失败横幅显示具体说明", async (code, text) => {
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
    await screen.findByRole("heading", { name: "managed" });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(text));
    expect(screen.getByText("最近测试").nextElementSibling?.textContent).toBe(text);
    expect(screen.queryByText("连接失败，请检查服务器配置")).toBeNull();
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
    await screen.findByRole("heading", { name: "managed" });
    expect(screen.getByText("config.json · 只读")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /manual/ }));
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/home\/config.json/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加服务器" }));
    fireEvent.change(screen.getByLabelText(/^名称/), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: "流式 HTTP · 远程地址" }));
    expect((screen.getByLabelText(/^名称/) as HTMLInputElement).value).toBe("test");
    fireEvent.change(screen.getByLabelText(/^地址/), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加请求头" }));
    fireEvent.change(screen.getByLabelText("请求头名 1"), { target: { value: "Authorization" } });
    expect(screen.getByRole("combobox", { name: "值类型 1" }).textContent).toContain(
      "保存到凭据库",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "值类型 1" }));
    const stored = within(screen.getByRole("listbox")).getByRole("option", {
      name: /保存到凭据库/,
    });
    expect(stored.getAttribute("aria-disabled")).toBeNull();
    expect(
      within(stored).getByText("值存进系统凭据库，mcp.json 只记引用，界面不再显示"),
    ).toBeDefined();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.change(screen.getByLabelText("值 1"), { target: { value: "test-token-123" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(f.calls.find((call) => call.method === "mcp.saveMcpServer")?.params).toMatchObject({
      id: "test",
      config: { type: "http", headers: { Authorization: { stored: true } } },
      secrets: { Authorization: "test-token-123" },
    });
    expect(screen.getByRole("status").textContent).toContain("本轮结束后");
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
    await screen.findByRole("heading", { name: "managed" });
    const lists = () => f.calls.filter((call) => call.method === "mcp.describeMcpServers").length;
    expect(lists()).toBe(1);
    if (action === "启用") fireEvent.click(screen.getByRole("switch"));
    else if (action === "删除") {
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      const buttons = screen.getAllByRole("button", { name: "删除" });
      fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    }
    await waitFor(() => expect(lists()).toBe(2));
    expect(screen.getByText(/配置未能应用到会话/)).toBeDefined();
    f.close();
  });
});
