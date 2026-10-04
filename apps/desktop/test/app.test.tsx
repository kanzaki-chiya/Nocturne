import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RPC_PROTOCOL_VERSION } from "@nocturne/rpc/client";

import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

function replayHost(): DesktopHost {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const model = { provider: "test", model: "cheap" };
  const sessions = ["alpha", "beta"].map((id) => ({
    id,
    createdAt: "2026-10-04T00:00:00Z",
    cwd: `Z:/qa-${id}`,
    workspaceRoot: `Z:/qa-${id}`,
    model,
    mtimeMs: 100,
    firstText: `${id} 会话`,
  }));
  return {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    pickFolder: async () => null,
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return "Z:/plain";
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = channels.size + 1;
        channels.set(id, channel as (message: BackendMessage) => void);
        return id;
      }
      if (command === "backend_close") return;
      if (command !== "backend_send") throw new Error(`未处理外壳命令 ${command}`);
      const channel = channels.get(Number(args?.backendId));
      if (channel === undefined) throw new Error("后台未打开");
      const request = JSON.parse(String(args?.line)) as {
        id: number;
        method: string;
        params: { sessionId?: string };
      };
      const id = request.params.sessionId;
      let result: unknown = null;
      switch (request.method) {
        case "initialize":
          result = { protocolVersion: RPC_PROTOCOL_VERSION, nocturneVersion: "test" };
          break;
        case "runtime.listSessions":
          result = sessions;
          break;
        case "runtime.listModels":
          result = [{ ref: model, capabilities: {} }];
          break;
        case "runtime.resumeSession":
          result = {
            sessionId: id,
            meta: { id, cwd: `Z:/qa-${id}` },
            config: { model, permissionPreset: "default" },
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
          result = { config: { model, permissionPreset: "default" } };
          break;
        case "session.describeContext":
          result = {
            report: { estimatedTokens: 0, budgetTokens: 1000, totalChars: 0, sections: [] },
          };
          break;
        case "session.reasoningEffortInfo":
          result = { current: "off", effective: "off", available: [] };
          break;
        case "session.shellInfo":
          result = { effective: { kind: "pwsh" } };
          break;
        case "session.readInputHistory":
          result = [];
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
      expect(within(card).getByText(`edit: ${id}.txt`)).toBeTruthy();
    });
  }
});
