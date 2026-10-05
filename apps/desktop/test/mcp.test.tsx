import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpPage } from "../src/McpPage";
import { parseMcpImport } from "../src/mcp-import";
import { fakeServer, withInit } from "./fake-server";

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
});
