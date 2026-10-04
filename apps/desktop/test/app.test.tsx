import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RPC_PROTOCOL_VERSION } from "@nocturne/rpc/client";

import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

interface RpcCall {
  backendId: number;
  method: string;
  params: Record<string, unknown>;
}

function replayHost(failRpc: readonly string[] = []) {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const calls: RpcCall[] = [];
  const models = [
    { ref: { provider: "test", model: "cheap" }, capabilities: {} },
    {
      ref: { provider: "test", model: "fancy" },
      capabilities: { reasoningEffort: ["low", "high"] },
    },
  ];
  const cheap = models[0]?.ref;
  const sessions = ["alpha", "beta", "gamma"].map((id) => ({
    id,
    createdAt: "2026-10-04T00:00:00Z",
    cwd: `Z:/qa-${id}`,
    workspaceRoot: `Z:/qa-${id}`,
    model: cheap,
    mtimeMs: 100,
    firstText: `${id} 会话`,
  }));
  const workspaces = new Map<number, string>();
  const host: DesktopHost & { calls: RpcCall[] } = {
    calls,
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "C:/Users/me",
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return "Z:/plain";
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = channels.size + 1;
        channels.set(id, channel as (message: BackendMessage) => void);
        workspaces.set(id, String(args?.workspace ?? ""));
        return id;
      }
      if (command === "backend_close") return;
      if (command !== "backend_send") throw new Error(`未处理外壳命令 ${command}`);
      const backendId = Number(args?.backendId);
      const channel = channels.get(backendId);
      if (channel === undefined) throw new Error("后台未打开");
      const request = JSON.parse(String(args?.line)) as {
        id: number;
        method: string;
        params: Record<string, unknown> & { sessionId?: string };
      };
      calls.push({ backendId, method: request.method, params: request.params });
      const id = request.params.sessionId;
      const workspace = workspaces.get(backendId) ?? "";
      let result: unknown = null;
      if (failRpc.includes(request.method)) {
        channel({
          kind: "line",
          line: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: "internal", message: `${request.method} 测试失败` },
          }),
        });
        return;
      }
      switch (request.method) {
        case "initialize":
          result = { protocolVersion: RPC_PROTOCOL_VERSION, nocturneVersion: "test" };
          break;
        case "runtime.listSessions":
          result = sessions;
          break;
        case "runtime.listModels":
          result = models;
          break;
        case "runtime.listRecentModels":
          result = [cheap];
          break;
        case "runtime.defaultModel":
          result = cheap;
          break;
        case "runtime.describeSettings":
          result = [
            { key: "reasoningEffort", effective: "low" },
            { key: "permissions.preset", effective: "default" },
          ];
          break;
        case "runtime.createSession":
          result = {
            sessionId: "draft-1",
            meta: { id: "draft-1", cwd: workspace },
            config: {
              model: request.params.model ?? cheap,
              permissionPreset: request.params.permissionPreset ?? "default",
            },
            warnings: [],
            lastSeq: 0,
          };
          break;
        case "runtime.resumeSession":
          result = {
            sessionId: id,
            meta: { id, cwd: `Z:/qa-${id}` },
            config: { model: cheap, permissionPreset: "default" },
            warnings: [],
            lastSeq: 4,
          };
          break;
        case "session.subscribe": {
          const events = [
            {
              type: "message.user",
              payload: { messageId: `user-${id}`, content: [{ type: "text", text: `${id} 正文` }] },
            },
            ...(id === "gamma"
              ? []
              : [
                  { type: "turn.started", payload: { turnIndex: 1 } },
                  {
                    type: "tool.started",
                    payload: {
                      callId: `call-${id}`,
                      name: "write",
                      input: { path: `${id}.txt`, content: id },
                      subjects: [{ kind: "edit", target: `${id}.txt` }],
                      permission: { action: "ask", source: "preset" },
                    },
                  },
                  {
                    type: "permission.requested",
                    payload: {
                      requestId: `permission-${id}`,
                      callId: `call-${id}`,
                      subjects: [{ kind: "edit", target: `${id}.txt` }],
                      reason: "等待用户确认",
                      options: ["allow_once", "deny"],
                    },
                  },
                ]),
          ];
          events.forEach((event, index) =>
            channel({
              kind: "line",
              line: JSON.stringify({
                jsonrpc: "2.0",
                method: "event",
                params: {
                  sessionId: id,
                  event: {
                    ...event,
                    sessionId: id,
                    turnId: `turn-${id}`,
                    seq: index + 1,
                    time: "2026-10-04T00:00:00Z",
                  },
                },
              }),
            }),
          );
          result = { lastSeq: 4 };
          break;
        }
        case "session.state":
          result = { config: { model: cheap, permissionPreset: "default" } };
          break;
        case "session.describeContext":
          result = {
            report: { estimatedTokens: 0, budgetTokens: 1000, totalChars: 0, sections: [] },
          };
          break;
        case "session.reasoningEffortInfo":
          result = { current: "off", effective: "off", available: ["low", "high"] };
          break;
        case "session.shellInfo":
          result = { effective: { kind: "pwsh" } };
          break;
        case "session.listShells":
          result = [{ kind: "bash", name: "Bash", available: true, executable: "/bin/bash" }];
          break;
        case "session.visionInfo":
          result = { imageInput: true, available: true };
          break;
        case "session.fileIndex":
          result = [{ path: "src/main.ts", kind: "file" }];
          break;
        case "session.mcpServers":
          result = [];
          break;
        case "session.submit":
          // 立即返回 = 已接受；发送方随后才看到持久事件
          result = "done";
          break;
        case "session.readInputHistory":
          result = [];
          break;
        case "session.recordInputHistory":
        case "session.compact":
        case "session.respondPermission":
        case "session.interrupt":
        case "session.setModel":
        case "session.setReasoningEffort":
        case "session.setPermissionPreset":
        case "session.setShell":
          break;
        case "session.unsubscribe":
        case "session.close":
          break;
        default:
          throw new Error(`未处理 RPC 方法 ${request.method}`);
      }
      channel({ kind: "line", line: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) });
    },
  };
  return host;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("反复切换待确认会话时只显示当前消息流和当前权限卡片，不残留旧会话", async () => {
  render(<App host={replayHost()} />);
  for (const id of ["alpha", "beta", "alpha", "beta"]) {
    fireEvent.click(
      await screen.findByRole("button", { name: new RegExp(`^${id} (?:会话|正文)`) }),
    );
    await waitFor(() => {
      const stream = screen.getByRole("region", { name: "会话消息" });
      expect(within(stream).getByText(`${id} 正文`)).toBeTruthy();
      const other = id === "alpha" ? "beta" : "alpha";
      expect(within(stream).queryByText(`${other} 正文`)).toBeNull();
      const cards = screen.getAllByRole("region", { name: "权限确认" });
      expect(cards).toHaveLength(1);
      const card = cards[0];
      if (card === undefined) throw new Error("缺少当前会话权限卡片");
      expect(within(card).getByText(`${id}.txt`)).toBeTruthy();
    });
  }
});

it("空状态选择模型/档位/预设后，首条消息把选择传给 createSession", async () => {
  const host = replayHost();
  render(<App host={host} />);
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  // 模型 → fancy
  fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /fancy/ }));
  // 档位 → high（fancy 声明了 low/high）
  fireEvent.click(screen.getByRole("button", { name: "切换思考档位" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "high" }));
  // 预设 → smart
  fireEvent.click(screen.getByRole("button", { name: "切换权限预设" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "smart" }));
  fireEvent.change(field, { target: { value: "第一条" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(host.calls.some((call) => call.method === "runtime.createSession")).toBe(true),
  );
  const create = host.calls.find((call) => call.method === "runtime.createSession");
  expect(create?.params).toMatchObject({
    model: { provider: "test", model: "fancy" },
    reasoningEffort: "high",
    permissionPreset: "smart",
  });
});

it("空状态不触碰控件时 createSession 只带解析出的默认模型", async () => {
  const host = replayHost();
  render(<App host={host} />);
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  fireEvent.change(field, { target: { value: "第一条" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(host.calls.some((call) => call.method === "runtime.createSession")).toBe(true),
  );
  const create = host.calls.find((call) => call.method === "runtime.createSession");
  expect(create?.params).toEqual({ model: { provider: "test", model: "cheap" } });
});

it("会话内状态栏控件调用真实 setter", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await screen.findByRole("region", { name: "会话消息" });
  await waitFor(() => expect(screen.getByRole("button", { name: "切换模型" })).toBeTruthy());
  // 模型 pill（状态栏）
  fireEvent.click(screen.getByRole("button", { name: "切换模型" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /fancy/ }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) =>
          call.method === "session.setModel" &&
          (call.params.model as { model?: string }).model === "fancy",
      ),
    ).toBe(true),
  );
  // 档位 pill
  fireEvent.click(screen.getByRole("button", { name: "切换思考档位" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "high" }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) => call.method === "session.setReasoningEffort" && call.params.level === "high",
      ),
    ).toBe(true),
  );
  // 预设 pill
  fireEvent.click(screen.getByRole("button", { name: "切换权限预设" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "smart" }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) => call.method === "session.setPermissionPreset" && call.params.name === "smart",
      ),
    ).toBe(true),
  );
  // 状态栏 Shell（菜单打开时探测列表）
  fireEvent.click(screen.getByRole("button", { name: "切换 Shell" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /bash · Bash/ }));
  await waitFor(() =>
    expect(
      host.calls.some((call) => call.method === "session.setShell" && call.params.kind === "bash"),
    ).toBe(true),
  );
});

it("/compact 走真实 RPC，移除命令只给界面提示", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^gamma (?:会话|正文)/ }));
  // resumeSession/subscribe 完成前 DraftPane 仍挂载着同 label 的输入框；等会话流出现再取
  await screen.findByRole("region", { name: "会话消息" });
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  fireEvent.change(field, { target: { value: "/compact" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(host.calls.some((call) => call.method === "session.compact")).toBe(true),
  );
  expect(host.calls.some((call) => call.method === "session.submit")).toBe(false);
  fireEvent.change(field, { target: { value: "/model" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("在底部状态栏切换模型"),
  );
  expect(host.calls.some((call) => call.method === "session.submit")).toBe(false);
});

it("草稿控件数据加载失败时在输入框下方显示错误", async () => {
  const host = replayHost(["runtime.listModels"]);
  render(<App host={host} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("runtime.listModels 测试失败");
});

it("权限卡片聚焦后，焦点在输入框时 Esc 直接拒绝且不中断会话", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await screen.findByRole("region", { name: "会话消息" });
  const card = await screen.findByRole("region", { name: "权限确认" });
  await waitFor(() => expect(document.activeElement).toBe(card));
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入");
  field.focus();
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) =>
          call.method === "session.respondPermission" &&
          (call.params.reply as { decision?: string }).decision === "deny",
      ),
    ).toBe(true),
  );
  expect(host.calls.some((call) => call.method === "session.interrupt")).toBe(false);
});
