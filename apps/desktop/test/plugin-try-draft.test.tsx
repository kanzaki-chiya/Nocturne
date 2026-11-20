/**
 * 插件详情页「立即试用」端到端：在真实 App + RPC + Core 下打开插件详情，
 * 点「立即试用」关闭设置页、在当前工作区新开草稿会话、预填 `/<技能名> `、
 * 光标在末尾并聚焦、无错误提示、不自动发送。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createPlatform, createRuntime, FakeProvider, loadConfig } from "@nocturne/core";
import { createMemoryTransportPair, type LineTransport } from "@nocturne/rpc/client";
import { createRpcServer } from "@nocturne/rpc/server";
import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTestHost(
  ws: string,
  plain: string,
  sessionsDir: string,
  home: string,
  builtinDir: string,
) {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const clients = new Map<number, LineTransport>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const desktop: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => home,
    appVersion: async () => "0.0.0-test",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: () => undefined,
    notify: async () => ({ shown: true }),
    dismissNotification: async () => undefined,
    requestAttention: async () => undefined,
    onNotificationActivated: () => () => undefined,
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return plain;
      if (command === "backend_open") {
        const channel = args?.channel;
        if (typeof channel !== "function") throw new Error("后台缺少消息通道");
        const id = Math.max(0, ...channels.keys()) + 1;
        channels.set(id, channel as (m: BackendMessage) => void);
        const [clientEnd, serverEnd] = createMemoryTransportPair();
        const server = createRpcServer({
          nocturneVersion: "test",
          createRuntime: async () => {
            const config = await loadConfig(createPlatform(), {
              nocturneHome: home,
              env: () => undefined,
            });
            const runtime = await createRuntime({
              cwd: ws,
              sessionsDir,
              providers: [
                new FakeProvider({
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
                }),
              ],
              interactive: true,
              config,
              builtinPluginsDir: builtinDir,
              plugins: {
                codexHome: path.join(home, "empty-codex"),
                claudeHome: path.join(home, "empty-claude"),
              },
            });
            return { runtime, sessionsDir };
          },
        });
        void server.serve(serverEnd);
        clients.set(id, clientEnd);
        clientEnd.onLine((line) => {
          channels.get(id)?.({ kind: "lines", lines: [line] });
        });
        clientEnd.onClose(() => {
          channels.get(id)?.({ kind: "closed", code: 0, stderr: [] });
        });
        return id;
      }
      if (command === "backend_close") {
        clients.get(Number(args?.backendId))?.close();
        return;
      }
      if (command === "backend_stderr") return [];
      if (command === "backend_send") {
        const line = String(args?.line ?? "");
        try {
          const parsed = JSON.parse(line) as { method?: unknown; params?: unknown };
          if (typeof parsed.method === "string") {
            calls.push({
              method: parsed.method,
              params: (parsed.params ?? {}) as Record<string, unknown>,
            });
          }
        } catch {
          // 忽略非 JSON 行
        }
        clients.get(Number(args?.backendId))?.send(line);
        return;
      }
      if (command === "app_note") return;
      if (command === "shell_log") return [];
      throw new Error(`未处理外壳命令 ${command}`);
    },
  };
  return { desktop, calls };
}

it("点「立即试用」关闭设置页、新开草稿会话并预填 /docx ，不自动发送且不显示错误", async () => {
  const ws = temp("try-ws-");
  const plain = temp("try-plain-");
  const sessionsDir = temp("try-sessions-");
  const home = temp("try-home-");
  const builtinDir = temp("try-builtin-");

  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ modelsDev: false, skills: { sources: { agents: false, claude: false } } }),
  );
  const docxDir = path.join(builtinDir, "docx");
  mkdirSync(path.join(docxDir, ".nocturne-plugin"), { recursive: true });
  mkdirSync(path.join(docxDir, "skills", "docx"), { recursive: true });
  writeFileSync(
    path.join(docxDir, ".nocturne-plugin", "plugin.json"),
    JSON.stringify({
      name: "docx",
      version: "0.1.0",
      description: "创建、读取与编辑 Word 文档",
      interface: { displayName: "Word 文档" },
    }),
  );
  writeFileSync(
    path.join(docxDir, "skills", "docx", "SKILL.md"),
    "---\ndescription: Word 文档处理\n---\n使用 word 工具",
  );

  const { desktop, calls } = createTestHost(ws, plain, sessionsDir, home, builtinDir);
  render(<App host={desktop} />);

  // 打开设置 → 插件 → Word 文档详情
  const settingsBtn = await screen.findByRole("button", { name: "设置" }, { timeout: 15_000 });
  fireEvent.click(settingsBtn);
  fireEvent.click(await screen.findByRole("button", { name: "插件" }));
  fireEvent.click(await screen.findByText("Word 文档", {}, { timeout: 15_000 }));

  const tryBtn = await screen.findByRole("button", { name: "立即试用" });
  fireEvent.click(tryBtn);

  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "立即试用" })).toBeNull();
  });
  const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  await waitFor(() => {
    const label = textarea.closest(".txt")?.querySelector(".draft-skill .input-label");
    expect(label?.textContent).toBe("Word 文档");
    expect(label?.querySelector("svg")).toBeTruthy();
    expect(textarea.value).toBe("");
    expect(textarea.placeholder).toBe("");
  });
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe(0);
  expect(textarea.selectionEnd).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(calls.filter((c) => c.method === "session.submit")).toHaveLength(0);
});
