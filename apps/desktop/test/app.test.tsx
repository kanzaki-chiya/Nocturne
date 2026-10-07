import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RPC_PROTOCOL_VERSION } from "@nocturne/rpc/client";

import { App } from "../src/App";
import { WindowFrame } from "../src/WindowFrame";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

interface RpcCall {
  backendId: number;
  method: string;
  params: Record<string, unknown>;
}

function replayHost(
  failRpc: readonly string[] = [],
  seedStderr?: (backendId: number, workspace: string) => string[],
) {
  const channels = new Map<number, (message: BackendMessage) => void>();
  /** 每个后台的内存 stderr 缓冲（backend_stderr 读取；后台关闭后随之回收） */
  const stderr = new Map<number, string[]>();
  /** backend_stderr 命令的调用记录（backendId） */
  const stderrReads: number[] = [];
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
  /** 带状态的 Shell：session.setShell 改写、session.shellInfo 返回最新值（与真实后台一致） */
  const shellState = new Map<string, { kind: string; path: string }>();
  const shellFor = (id: string | undefined) => {
    const key = id ?? "";
    return shellState.get(key) ?? { kind: "pwsh", path: "C:/tools/pwsh.exe" };
  };
  /** 持久事件 seq：订阅回放 lastSeq=4，新事件从 5 起递增 */
  let nextSeq = 5;
  const emitEvent = (backendId: number, sessionId: string | undefined, event: object) => {
    const channel = channels.get(backendId);
    channel?.({
      kind: "line",
      line: JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: {
          sessionId,
          event: {
            sessionId,
            turnId: `turn-${sessionId}`,
            seq: nextSeq++,
            time: "2026-10-04T00:00:00Z",
            ...event,
          },
        },
      }),
    });
  };
  const notify = (backendId: number, method: string) => {
    channels.get(backendId)?.({
      kind: "line",
      line: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
    });
  };
  /** 后台进程退出：closed 消息携带 stderr 尾部，随后缓冲回收、通道移除 */
  const close = (backendId: number, code: number | null, tail?: string[]) => {
    const channel = channels.get(backendId);
    const stderrTail = tail ?? stderr.get(backendId) ?? [];
    channels.delete(backendId);
    stderr.delete(backendId);
    workspaces.delete(backendId);
    channel?.({ kind: "closed", code, stderr: stderrTail });
  };
  /** 外壳日志缓冲（app_note 写入、shell_log 读出） */
  const shellLog: string[] = [];
  const host: DesktopHost & {
    calls: RpcCall[];
    workspaces: Map<number, string>;
    notify: typeof notify;
    close: typeof close;
    stderrReads: number[];
    shellLog: string[];
  } = {
    calls,
    workspaces,
    notify,
    close,
    stderrReads,
    shellLog,
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "C:/Users/me",
    appVersion: async () => "0.0.0-test",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: (line) => {
      shellLog.push(line);
    },
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return "Z:/plain";
      if (command === "app_note") {
        shellLog.push(String(args?.line ?? ""));
        return;
      }
      if (command === "shell_log") return [...shellLog];
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = Math.max(0, ...channels.keys()) + 1;
        channels.set(id, channel as (message: BackendMessage) => void);
        const workspace = String(args?.workspace ?? "");
        workspaces.set(id, workspace);
        stderr.set(
          id,
          seedStderr?.(id, workspace) ?? [`backend-${id} stderr 样例`, `cwd=${workspace}`],
        );
        return id;
      }
      if (command === "backend_close") return;
      if (command === "backend_stderr") {
        const backendId = Number(args?.backendId);
        stderrReads.push(backendId);
        const lines = stderr.get(backendId);
        if (lines === undefined)
          throw Object.assign(new Error("后台不存在或已退出"), { code: "unknown_backend" });
        return lines;
      }
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
        case "runtime.listReviewerProviders":
          result = [];
          break;
        case "runtime.updateSettings":
          // 与真实服务端一致：写 settings.json 不推 providersChanged，由桌面端协调
          result = [
            { key: "reasoningEffort", effective: "low" },
            { key: "permissions.preset", effective: "smart", saved: "smart", source: "settings" },
          ];
          break;
        case "runtime.reloadConfig":
          notify(backendId, "runtime.providersChanged");
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
          // runtime.status 是易失事件不进回放；与真实服务端一致，在回放后以实时事件补发当前状态
          if (id === "alpha" || id === "beta") {
            channel({
              kind: "line",
              line: JSON.stringify({
                jsonrpc: "2.0",
                method: "event",
                params: {
                  sessionId: id,
                  event: {
                    type: "runtime.status",
                    sessionId: id,
                    time: "2026-10-04T00:00:00Z",
                    payload: { status: "waiting_permission" },
                  },
                },
              }),
            });
          }
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
        case "session.shellInfo": {
          const current = shellFor(id);
          result = {
            selected: current.kind,
            source: "settings",
            effective: { kind: current.kind, name: current.kind, path: current.path },
          };
          break;
        }
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
          // 与真实服务端一致：先写持久 message.user 事件（视图随即出现新消息），再返回响应
          emitEvent(backendId, id, {
            type: "message.user",
            payload: {
              messageId: `u-${id}-${nextSeq}`,
              content: [{ type: "text", text: String(request.params.text ?? "") }],
            },
          });
          result = "done";
          break;
        case "session.rewindTargets":
          result = [
            {
              seq: 1,
              firstLine: `${id} 正文`,
              time: "2026-10-04T00:00:00Z",
              text: `${id} 正文`,
              hasImages: false,
              files: [
                { path: `Z:/qa-${id}/${id}.txt`, action: "restore", external: false },
                { path: `Z:/qa-${id}/${id}.log`, action: "untracked", external: false },
              ],
              untrackedCalls: 1,
            },
          ];
          break;
        case "session.rewind":
          // 与真实服务端一致：先写持久 session.rewound 事件，视图随即截断该目标之后的条目
          emitEvent(backendId, id, {
            type: "session.rewound",
            payload: {
              targetSeq: Number(request.params.targetSeq),
              mode: String(request.params.mode),
              files: [],
            },
          });
          result = [];
          break;
        case "session.readAttachment":
          result = { data: "AQID", mimeType: "image/png", bytes: 3 };
          break;
        case "session.readInputHistory":
          result = [];
          break;
        case "session.setShell": {
          const kind = String(request.params.kind ?? "");
          shellState.set(id ?? "", { kind, path: `C:/tools/${kind}.exe` });
          // 真实服务端：切换生效先写持久 config_changed 事件，再返回响应
          emitEvent(backendId, id, {
            type: "session.config_changed",
            payload: { shell: { kind, path: `C:/tools/${kind}.exe` } },
          });
          break;
        }
        case "session.recordInputHistory":
        case "session.compact":
        case "session.respondPermission":
        case "session.interrupt":
        case "session.setModel":
        case "session.setReasoningEffort":
        case "session.setPermissionPreset":
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

it("用户消息操作：复制、编辑并重发（仅对话）、重发与忙时置灰（U-01）", async () => {
  const host = replayHost();
  render(<App host={host} />);
  const clipboard = { writeText: vi.fn(async (_text: string) => undefined) };
  Object.defineProperty(window.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  // 空闲会话 gamma：复制随时可用
  fireEvent.click(await screen.findByRole("button", { name: /^gamma (?:会话|正文)/ }));
  const stream = () => screen.getByRole("region", { name: "会话消息" });
  await screen.findByRole("region", { name: "会话消息" });
  await within(stream()).findByText("gamma 正文");
  fireEvent.click(within(stream()).getByRole("button", { name: "复制" }));
  await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("gamma 正文"));

  // 编辑并重发：编辑框带原文、撤回信息取自 rewindTargets，选「仅对话」→ mode=conversation
  fireEvent.click(screen.getByRole("button", { name: "编辑并重发" }));
  const box = await screen.findByLabelText<HTMLTextAreaElement>("编辑消息");
  expect(box.value).toBe("gamma 正文");
  await screen.findByText(/将撤回 0 轮回复，将还原 1 个文件：gamma\.txt/);
  expect(screen.getByText(/另有 1 次命令改动不还原/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "仅对话" }));
  fireEvent.change(box, { target: { value: "改写后的正文" } });
  const editBox = box.closest(".u-edit") as HTMLElement;
  fireEvent.click(within(editBox).getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(host.calls.some((call) => call.method === "session.submit")).toBe(true),
  );
  expect(host.calls.find((call) => call.method === "session.rewind")?.params).toMatchObject({
    targetSeq: 1,
    mode: "conversation",
  });
  expect(host.calls.find((call) => call.method === "session.submit")?.params).toMatchObject({
    text: "改写后的正文",
    attachments: [],
  });

  // 重发：在重发后出现的新消息上点「重发」→ 默认「对话和文件」回退该消息
  fireEvent.click(await screen.findByRole("button", { name: "重发" }));
  await waitFor(() =>
    expect(
      host.calls.some((call) => call.method === "session.rewind" && call.params.mode === "both"),
    ).toBe(true),
  );
  const rewoundSeq = host.calls.find(
    (call) => call.method === "session.rewind" && call.params.mode === "both",
  )?.params.targetSeq;
  expect(rewoundSeq).not.toBe(1); // 新消息在重写事件之后的 seq
  expect(
    host.calls.filter((call) => call.method === "session.submit").map((c) => c.params.text),
  ).toEqual(["改写后的正文", "改写后的正文"]);

  // 忙时（等待确认的 alpha）：编辑并重发/重发置灰并提示，复制仍可用
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (c) => c.method === "runtime.resumeSession" && c.params.sessionId === "alpha",
      ),
    ).toBe(true),
  );
  await within(stream()).findByText("alpha 正文");
  for (const name of ["编辑并重发", "重发"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("请先等待或按 Esc 中断");
  }
  expect((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled).toBe(false);
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
  // gamma 是空闲会话：忙时模型锁定的覆盖见 U-03 用例
  fireEvent.click(await screen.findByRole("button", { name: /^gamma (?:会话|正文)/ }));
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
  fireEvent.click(screen.getByRole("combobox", { name: "切换思考档位" }));
  fireEvent.click(await screen.findByRole("option", { name: /^high/ }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) => call.method === "session.setReasoningEffort" && call.params.level === "high",
      ),
    ).toBe(true),
  );
  // 预设 pill
  fireEvent.click(screen.getByRole("combobox", { name: "切换权限预设" }));
  fireEvent.click(await screen.findByRole("option", { name: /^smart/ }));
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

it("切换 Shell 后状态栏文字与菜单勾选立即更新（F-01）", async () => {
  const host = replayHost();
  render(
    <StrictMode>
      <App host={host} />
    </StrictMode>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^gamma (?:会话|正文)/ }));
  await screen.findByRole("region", { name: "会话消息" });
  const pill = await screen.findByRole("button", { name: "切换 Shell" });
  await waitFor(() => expect(pill.textContent).toContain("pwsh"));
  fireEvent.click(pill);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /bash · Bash/ }));
  await waitFor(() =>
    expect(
      host.calls.some((call) => call.method === "session.setShell" && call.params.kind === "bash"),
    ).toBe(true),
  );
  await waitFor(() => expect(pill.textContent).toContain("bash"));
  // 菜单勾选也指向新值
  fireEvent.click(pill);
  const item = await screen.findByRole("menuitemradio", { name: /bash · Bash/ });
  expect(item.getAttribute("aria-checked")).toBe("true");
});

it("忙时（等待确认）档位/Shell/预设可切换、模型锁定（U-03）", async () => {
  const host = replayHost();
  render(<App host={host} />);
  // alpha 回放 permission.requested → waiting_permission（忙态）
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await screen.findByRole("region", { name: "会话消息" });
  await screen.findAllByText(/等待确认/);
  // 模型仍锁定，其余三项可点
  expect(screen.getByRole("button", { name: "切换模型" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("combobox", { name: "切换思考档位" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("combobox", { name: "切换权限预设" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "切换 Shell" })).toHaveProperty("disabled", false);
  // 预设菜单说明：等待中的请求仍由用户决定
  fireEvent.click(screen.getByRole("combobox", { name: "切换权限预设" }));
  const note = await screen.findByText(/等待确认的权限请求仍由你决定/);
  expect(note).toBeTruthy();
  // 忙时切换预设走真实 RPC
  fireEvent.click(await screen.findByRole("option", { name: /bypass/ }));
  await waitFor(() =>
    expect(
      host.calls.some(
        (call) => call.method === "session.setPermissionPreset" && call.params.name === "bypass",
      ),
    ).toBe(true),
  );
  // Shell 菜单说明：下一次命令生效
  fireEvent.click(screen.getByRole("button", { name: "切换 Shell" }));
  expect(await screen.findByText(/下一次命令生效/)).toBeTruthy();
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

it("常规与服务商设置打开时，窗口按钮保持可访问并执行宿主操作", async () => {
  const host = replayHost();
  const invoke = host.invoke;
  const windowCalls: string[] = [];
  host.invoke = async (command, args) => {
    if (command.startsWith("plugin:window|")) {
      windowCalls.push(command);
      return false;
    }
    return invoke(command, args);
  };
  render(
    <WindowFrame host={host}>
      <App host={host} />
    </WindowFrame>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  const nav = await screen.findByRole("navigation", { name: "设置" });
  for (const page of ["常规", "服务商"]) {
    fireEvent.click(within(nav).getByRole("button", { name: new RegExp(page) }));
    for (const [name, command] of [
      ["最小化", "minimize"],
      ["最大化", "toggle_maximize"],
      ["关闭", "close"],
    ] as const) {
      const button = screen.getByRole("button", { name });
      expect(button.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(button.closest(".window-titlebar")).not.toBeNull();
      windowCalls.length = 0;
      fireEvent.click(button);
      await waitFor(() => expect(windowCalls).toContain(`plugin:window|${command}`));
    }
  }
});

it("设置区接管左栏：返回与 Esc 回到原会话且滚动位置不变", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  const stream = await screen.findByRole("region", { name: "会话消息" });
  await within(stream).findByText("alpha 正文");
  // 用户往上翻过：不再跟随最新，滚动位置由用户决定
  fireEvent.wheel(stream, { deltaY: -100 });
  stream.scrollTop = 120;
  expect(stream.scrollTop).toBe(120);

  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const nav = await screen.findByRole("navigation", { name: "设置" });
  expect(within(nav).getByRole("button", { name: /常规/ }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.queryByRole("button", { name: /^beta (?:会话|正文)/ })).toBeNull();
  expect(await screen.findByRole("heading", { name: "常规" })).toBeTruthy();
  // 会话区仍挂载，只是不可交互
  expect(stream.isConnected).toBe(true);
  expect(stream.closest(".mainpane")?.hasAttribute("inert")).toBe(true);

  fireEvent.click(within(nav).getByRole("button", { name: /外观/ }));
  expect(await screen.findByRole("heading", { name: "外观" })).toBeTruthy();
  fireEvent.click(within(nav).getByRole("button", { name: /服务商/ }));
  expect(await screen.findByTestId("providers-page")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /← 返回/ }));
  await waitFor(() => {
    expect(screen.queryByRole("navigation", { name: "设置" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "会话消息" })).toBe(stream);
  expect(stream.scrollTop).toBe(120);
  expect(stream.closest(".mainpane")?.hasAttribute("inert")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("navigation", { name: "设置" });
  // 被盖住的会话有待确认权限：设置区里的 Esc 和数字键不能替它作答
  fireEvent.keyDown(document.body, { key: "1" });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("navigation", { name: "设置" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "会话消息" })).toBe(stream);
  expect(host.calls.some((c) => c.method === "session.respondPermission")).toBe(false);
  expect(screen.getByRole("region", { name: "权限确认" })).toBeTruthy();
});

it("配置变更让其他后台 reloadConfig，重载引起的通知不再转发", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await within(await screen.findByRole("region", { name: "会话消息" })).findByText("alpha 正文");
  const idOf = (ws: string) => [...host.workspaces].find(([, w]) => w === ws)?.[0];
  await waitFor(() => {
    expect(idOf("Z:/plain")).toBeDefined();
    expect(idOf("Z:/qa-alpha")).toBeDefined();
  });
  const plain = idOf("Z:/plain") ?? -1;
  const alpha = idOf("Z:/qa-alpha") ?? -1;
  const reloads = () =>
    host.calls.filter((c) => c.method === "runtime.reloadConfig").map((c) => c.backendId);

  // 设置页（走普通对话后台）保存成功 → 只让 alpha 重载，alpha 的回声不再回传
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "默认权限预设" }));
  fireEvent.click(screen.getByRole("option", { name: /^smart/ }));
  await waitFor(() => {
    expect(reloads()).toEqual([alpha]);
  });

  // alpha 自己的变更（例如另一个窗口改了文件后它先重载）→ 让普通对话后台重载一次
  host.notify(alpha, "runtime.providersChanged");
  await waitFor(() => {
    expect(reloads()).toEqual([alpha, plain]);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reloads()).toEqual([alpha, plain]);
});

it("后台日志页按后台显示 stderr，支持刷新与复制全部", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  const nav = await screen.findByRole("navigation", { name: "设置" });
  fireEvent.click(within(nav).getByRole("button", { name: /后台日志/ }));
  const page = await screen.findByTestId("logs-page");
  // 常驻普通对话后台在选择器里
  expect(within(page).getByRole("combobox", { name: "后台" }).textContent).toContain("对话");
  // 打开页面即拉取一次
  await within(page).findByText(/backend-1 stderr 样例/);
  expect(host.stderrReads.length).toBe(1);
  // 刷新再拉一次
  fireEvent.click(within(page).getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(host.stderrReads.length).toBe(2));
  // 复制全部把日志写进剪贴板
  fireEvent.click(within(page).getByRole("button", { name: "复制全部" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("backend-1 stderr 样例\ncwd=Z:/plain"),
  );
});

it("后台日志页的空态与已退出后台的回收", async () => {
  const host = replayHost([], () => []);
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  const nav = await screen.findByRole("navigation", { name: "设置" });
  fireEvent.click(within(nav).getByRole("button", { name: /后台日志/ }));
  const page = await screen.findByTestId("logs-page");
  await within(page).findByText(/暂无 stderr 输出/);
  // 已退出的后台缓冲被回收：直接读报 unknown_backend 文案
  const idOf = (ws: string) => [...host.workspaces].find(([, w]) => w === ws)?.[0];
  const plain = idOf("Z:/plain") ?? -1;
  await act(async () => {
    host.close(plain, 0);
  });
  // 后台退出后页面选择器回落到剩下的「外壳」条目
  await within(page).findByText(/外壳暂无诊断输出/);
});

it("后台退出显示 stderr 尾部与「重启后台」；重启按 afterSeq 恢复会话", async () => {
  const host = replayHost();
  render(<App host={host} />);
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await within(await screen.findByRole("region", { name: "会话消息" })).findByText("alpha 正文");
  const idOf = (ws: string) => [...host.workspaces].find(([, w]) => w === ws)?.[0];
  const alphaBackend = await waitFor(() => {
    const id = idOf("Z:/qa-alpha");
    expect(id).toBeDefined();
    return id as number;
  });

  await act(async () => {
    host.close(alphaBackend, 1, ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  });
  const crash = (await screen.findByText(/后台已退出（退出码 1）/)).closest(".crash");
  if (crash === null) throw new Error("缺少崩溃横幅");
  // 默认只显示最后 5 行，可展开全部
  expect(within(crash as HTMLElement).queryByText(/e1/)).toBeNull();
  expect(within(crash as HTMLElement).getByText(/e7/)).toBeTruthy();
  fireEvent.click(within(crash as HTMLElement).getByRole("button", { name: /展开全部/ }));
  expect(within(crash as HTMLElement).getByText(/e1/)).toBeTruthy();

  // 「查看日志」跳到后台日志页；退出后台的缓冲已回收，选择器只剩常驻后台
  fireEvent.click(within(crash as HTMLElement).getByRole("button", { name: "查看日志" }));
  const logsPage = await screen.findByTestId("logs-page");
  expect(within(logsPage).getByRole("combobox", { name: "后台" }).textContent).toContain("对话");
  fireEvent.keyDown(window, { key: "Escape" });

  // 重启后台：新进程 resumeSession + subscribe { afterSeq: 崩溃前 lastSeq }
  const crashAgain = await screen.findByText(/后台已退出（退出码 1）/);
  fireEvent.click(
    within(crashAgain.closest(".crash") as HTMLElement).getByRole("button", {
      name: "重启后台",
    }),
  );
  await waitFor(() => expect(screen.queryByText(/后台已退出/)).toBeNull());
  const newBackend = await waitFor(() => {
    const id = idOf("Z:/qa-alpha");
    expect(id).toBeDefined();
    return id as number;
  });
  // 假宿主复用回收的 backendId，用第二次 initialize 证明进程确实重启过
  expect(
    host.calls.filter((c) => c.method === "initialize" && c.backendId === newBackend),
  ).toHaveLength(2);
  const sub = host.calls
    .filter(
      (c) =>
        c.method === "session.subscribe" &&
        c.backendId === newBackend &&
        c.params.sessionId === "alpha",
    )
    .at(-1);
  expect(sub?.params.afterSeq).toBe(4);
  // 会话视图续接：消息与权限卡片仍在，可以继续对话
  expect(screen.getByRole("region", { name: "会话消息" }).textContent).toContain("alpha 正文");
  expect(screen.getByRole("region", { name: "权限确认" })).toBeTruthy();
});

// ── 自动更新（ADR-0050 第 3 节）──────────────────────────────

/** 让假宿主的更新检查返回一个可用的新版本 */
function serveUpdate(host: ReturnType<typeof replayHost>, failInstall?: unknown) {
  const install = vi.fn(async () => {
    if (failInstall !== undefined) throw failInstall;
  });
  host.checkUpdate = async () => ({
    version: "9.9.9",
    notes: "## 修复\n- 修好了一些事",
    downloadAndInstall: install,
  });
  return install;
}

it("发现新版本时底部出提示条；「稍后」只隐藏本次运行", async () => {
  const host = replayHost();
  serveUpdate(host);
  render(<App host={host} />);
  const bar = await screen.findByRole("status", { name: "发现新版本" });
  expect(bar.textContent).toContain("发现新版本 v9.9.9");
  expect(bar.textContent).toContain("修复");
  // 「稍后」隐藏提示条；pendingUpdate 仍留在 prefs 里，下次启动再提示
  fireEvent.click(within(bar).getByRole("button", { name: "稍后" }));
  expect(screen.queryByRole("status", { name: "发现新版本" })).toBeNull();
  const stored = JSON.parse(localStorage.getItem("nocturne.desktop.prefs.v1") ?? "{}") as {
    pendingUpdate?: { version?: string };
  };
  expect(stored.pendingUpdate?.version).toBe("9.9.9");
});

it("自动检查失败不出 UI，原因写进外壳日志", async () => {
  const host = replayHost();
  host.checkUpdate = async () => {
    throw new Error("endpoint 404");
  };
  render(<App host={host} />);
  await screen.findByLabelText("消息输入");
  await waitFor(() =>
    expect(host.shellLog.some((line) => line.includes("endpoint 404"))).toBe(true),
  );
  expect(screen.queryByRole("status", { name: "发现新版本" })).toBeNull();
});

it("有运行中的会话时点「立即更新」先确认会中断会话", async () => {
  const host = replayHost();
  const install = serveUpdate(host);
  render(<App host={host} />);
  // alpha 有未决权限卡片 → 非 idle
  fireEvent.click(await screen.findByRole("button", { name: /^alpha (?:会话|正文)/ }));
  await screen.findByRole("region", { name: "权限确认" });
  const bar = await screen.findByRole("status", { name: "发现新版本" });
  fireEvent.click(within(bar).getByRole("button", { name: "立即更新" }));
  const dialog = await screen.findByRole("dialog", { name: "更新确认" });
  expect(dialog.textContent).toMatch(/将中断\s*1\s*个正在运行的会话/);
  // 取消：对话框关掉、提示条还在、没有开始安装
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "更新确认" })).toBeNull();
  expect(screen.getByRole("status", { name: "发现新版本" })).toBeTruthy();
  expect(install).not.toHaveBeenCalled();
  // 确认后真正下载安装
  fireEvent.click(
    within(screen.getByRole("status", { name: "发现新版本" })).getByRole("button", {
      name: "立即更新",
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "更新确认" })).getByRole("button", {
      name: "继续更新",
    }),
  );
  await waitFor(() => expect(install).toHaveBeenCalled());
});

it("没有运行中的会话时直接下载安装；失败把原因留在提示条", async () => {
  const host = replayHost();
  const install = serveUpdate(host, new Error("Invalid encoding in minisign data"));
  render(<App host={host} />);
  const bar = await screen.findByRole("status", { name: "发现新版本" });
  // gamma 会话是 idle；不打开任何会话也没有 running Turn
  fireEvent.click(within(bar).getByRole("button", { name: "立即更新" }));
  // 不弹确认框，直接安装
  expect(screen.queryByRole("dialog", { name: "更新确认" })).toBeNull();
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  // 界面只显示中文说明，原始英文信息进外壳日志
  await waitFor(() => expect(bar.textContent).toContain("签名校验失败，已取消安装"));
  expect(bar.textContent).not.toContain("minisign");
  expect(host.shellLog.some((line) => line.includes("Invalid encoding in minisign data"))).toBe(
    true,
  );
  expect(within(bar).getByRole("button", { name: "重试" })).toBeTruthy();
  // pendingUpdate 恢复，下次启动仍提示
  const stored = JSON.parse(localStorage.getItem("nocturne.desktop.prefs.v1") ?? "{}") as {
    pendingUpdate?: { version?: string };
  };
  expect(stored.pendingUpdate?.version).toBe("9.9.9");
});
