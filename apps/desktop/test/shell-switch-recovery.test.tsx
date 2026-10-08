/**
 * Shell 切换恢复回归：DesktopHost 的 backend_send 走真实 RPC 服务端
 * （createRpcServer + createRuntime + FakeProvider + loadConfig），行交付
 * 经 queueMicrotask 模拟 Tauri channel 的异步时序。用例做故障注入：
 * 丢弃 setShell 响应与紧随的 config_changed 事件，断言后续切换不被
 * 永久吞掉（useSessionControls 的变更队列 + 超时放行）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createPlatform, createRuntime, FakeProvider, loadConfig } from "@nocturne/core";
import type { LineTransport } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { App } from "../src/App";
import { sessionMutationTimeout } from "../src/session-controls";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

/** 故障注入：某方法发出后精确丢弃其响应与指定类型的会话事件（模拟通道丢消息但没断连）。只触发一次。 */
interface FaultSpec {
  /** 触发丢包的方法名；未设置则不丢包 */
  afterMethod?: string;
  /** 丢弃该请求的响应 */
  dropResponse?: boolean;
  /** 丢弃该方法之后到达的第一条此类型会话事件（如 session.config_changed） */
  dropEvent?: string;
}

function realHost(ws: string, sessionsDir: string, fault?: FaultSpec) {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const clients = new Map<number, LineTransport>();
  const dropIds = new Set<number>();
  const dropEvents = new Set<string>();
  let faultFired = false;
  const provider = new FakeProvider({
    scripts: [
      [
        { type: "text_delta", text: "回答" },
        { type: "finish", reason: "stop" },
      ],
    ],
    models: [
      {
        ref: { provider: "fake", model: "fake-model" },
        capabilities: {
          toolCalls: true,
          parallelToolCalls: false,
          reasoning: "none",
          imageInput: true,
          promptCache: false,
          editTool: "edit",
        },
      },
    ],
  });
  const host: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "C:/Users/me",
    appVersion: async () => "0.0.0-test",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: () => undefined,
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return ws;
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = Math.max(0, ...channels.keys()) + 1;
        channels.set(id, channel as (m: BackendMessage) => void);
        const { createMemoryTransportPair } = await import("@nocturne/rpc/client");
        const [clientEnd, serverEnd] = createMemoryTransportPair();
        const home = mkdtempSync(path.join(tmpdir(), "f01-home-"));
        const server = createRpcServer({
          nocturneVersion: "test",
          createRuntime: async () => {
            const platform = createPlatform();
            const config = await loadConfig(platform, {
              nocturneHome: home,
              env: () => undefined,
            });
            return {
              runtime: await createRuntime({
                cwd: ws,
                sessionsDir,
                providers: [provider],
                interactive: true,
                config,
              }),
              sessionsDir,
            };
          },
        });
        void server.serve(serverEnd);
        clients.set(id, clientEnd);
        clientEnd.onLine((line) => {
          let drop = false;
          try {
            const parsed = JSON.parse(line) as {
              id?: unknown;
              method?: unknown;
              params?: { event?: { type?: string } };
            };
            if (typeof parsed.id === "number" && dropIds.has(parsed.id)) {
              drop = true;
              dropIds.delete(parsed.id);
            } else if (
              parsed.method === "event" &&
              parsed.params?.event?.type !== undefined &&
              dropEvents.has(parsed.params.event.type)
            ) {
              drop = true;
              dropEvents.delete(parsed.params.event.type);
            }
          } catch {
            // 非 JSON 行原样投递
          }
          if (!drop) channels.get(id)?.({ kind: "line", line });
        });
        clientEnd.onClose(() => {
          channels.get(id)?.({ kind: "closed", code: 0, stderr: [] });
        });
        return id;
      }
      if (command === "backend_close") {
        const id = Number(args?.backendId);
        clients.get(id)?.close();
        return;
      }
      if (command === "backend_stderr") return [];
      if (command === "backend_send") {
        const id = Number(args?.backendId);
        const line = String(args?.line ?? "");
        if (!faultFired && fault?.afterMethod !== undefined) {
          try {
            const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
            if (parsed.method === fault.afterMethod && typeof parsed.id === "number") {
              faultFired = true;
              if (fault.dropResponse === true) dropIds.add(parsed.id);
              if (fault.dropEvent !== undefined) dropEvents.add(fault.dropEvent);
            }
          } catch {
            // 非 JSON 行不触发
          }
        }
        clients.get(id)?.send(line);
        return;
      }
      if (command === "app_note") return;
      if (command === "shell_log") return [];
      throw new Error(`未处理外壳命令 ${command}`);
    },
  };
  return host;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  sessionMutationTimeout.ms = 15_000;
  cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 打开 App、建会话、返回 Shell 状态栏 pill（Turn 结束、菜单可开）。settleMs>0 时再等回复落盘并静默一段，确保随后没有滞留事件驱动刷新。 */
async function openSessionWithShell(fault?: FaultSpec, settleMs = 0) {
  const ws = mkdtempSync(path.join(tmpdir(), "f01-ws-"));
  const sessionsDir = mkdtempSync(path.join(tmpdir(), "f01-sessions-"));
  render(<App host={realHost(ws, sessionsDir, fault)} />);
  const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入", undefined, {
    timeout: 10_000,
  });
  fireEvent.change(field, { target: { value: "你好" } });
  // 常驻后台握手 + 草稿控件数据就绪前发送不可用，等模型芯片显示再提交
  await waitFor(
    () => expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", false),
    { timeout: 10_000 },
  );
  await waitFor(
    () =>
      expect(screen.getByRole("button", { name: "切换模型" }).textContent).toContain("fake-model"),
    { timeout: 10_000 },
  );
  act(() => {
    fireEvent.keyDown(field, { key: "Enter" });
  });
  await screen.findByRole("region", { name: "会话消息" }, { timeout: 15_000 });
  const pill = await screen.findByRole("button", { name: "切换 Shell" }, { timeout: 10_000 });
  await waitFor(() => expect(pill.textContent).toMatch(/Shell\s+\S+/), { timeout: 10_000 });
  await waitFor(() => expect(pill).toHaveProperty("disabled", false), { timeout: 10_000 });
  if (settleMs > 0) {
    // 回复文本出现后再静默：turn.completed/runtime.status 等滞留事件折叠
    // 会触发 refresh——静默后才不存在「别的刷新路径捡到新值」的干扰
    await screen.findByText("回答", undefined, { timeout: 10_000 });
    await sleep(settleMs);
  }
  return { ws, sessionsDir, pill };
}

/** Shell 菜单选项的主标签（自动行说明含当前种类名，不能用整行子串匹配种类行）。 */
function optionLabel(node: Element): string {
  return node.querySelector(".menu-label")?.textContent ?? "";
}

/** 开 Shell 菜单并点击包含 fragment 的可选项（重试一次点击，应对并发渲染延迟）。 */
async function pickShell(fragment: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pill = screen.getByRole("button", { name: "切换 Shell" });
    fireEvent.click(pill);
    try {
      // 菜单先显示 auto，探测结果返回后才有具体 shell；等目标项出现再选
      let target: HTMLElement | undefined;
      await waitFor(
        () => {
          target = screen
            .getAllByRole("menuitemradio")
            .find((item) => optionLabel(item).startsWith(fragment));
          expect(target).toBeDefined();
        },
        { timeout: 3000 },
      );
      fireEvent.click(target as HTMLElement);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      fireEvent.keyDown(document.body, { key: "Escape" });
    }
  }
}

function shellItem(fragment: string): Promise<HTMLElement> {
  return waitFor(() => {
    const item = screen
      .getAllByRole("menuitemradio")
      .find((node) => optionLabel(node).startsWith(fragment));
    expect(item).toBeDefined();
    return item as HTMLElement;
  });
}

it("setShell 响应丢失时后续切换仍能放行", async () => {
  sessionMutationTimeout.ms = 60;
  // setShell 发出后丢其响应与紧随的 config_changed 事件：
  // 事件丢了 → entries 不变 → 无触发刷新；响应丢了 → choose 挂起。
  const { ws, sessionsDir, pill } = await openSessionWithShell(
    {
      afterMethod: "session.setShell",
      dropResponse: true,
      dropEvent: "session.config_changed",
    },
    500,
  );
  try {
    const before = pill.textContent;
    // 第一次选择：响应丢失，变更挂起（不中断后续选择）
    await pickShell("bash");
    await sleep(300);
    expect(pill.textContent).toBe(before);
    // 第二次选择：排队并在超时后放行，新值写入并刷新状态栏
    await pickShell("cmd");
    await waitFor(() => expect(pill.textContent).toContain("cmd"), { timeout: 5000 });
    fireEvent.click(pill);
    const item = await shellItem("cmd");
    expect(item.getAttribute("aria-checked")).toBe("true");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});
