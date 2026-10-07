/**
 * F-01 端到端回归（可选）：DesktopHost 的 backend_open 直接 spawn
 * `node apps/cli/dist/main.js rpc --stdio`（与生产 debug 路径同一份脚本），
 * 工作区内 openai-compatible provider 指向本地 SSE stub；行收发经真实
 * stdin/stdout 管道。需要先构建 apps/cli（`pnpm --filter @nocturne/cli build`），
 * 产物缺失时自动跳过——CI 先测后建的顺序下不影响套件。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import type { BackendMessage } from "../src/types";

const CLI_MAIN = path.resolve(__dirname, "../../cli/dist/main.js");

/** OpenAI Chat Completions 的 SSE 应答：一段正文 + finish_reason=stop + [DONE] */
function sseBody(text: string): string {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const usage = `data: ${JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-model",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  })}\n\n`;
  return (
    chunk({ role: "assistant", content: text }, null) +
    chunk({}, "stop") +
    usage +
    "data: [DONE]\n\n"
  );
}

function startStub(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.end(sseBody("stub 回答"));
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function spawnHost(ws: string, home: string, baseURL: string) {
  const children = new Map<number, ChildProcess>();
  const channels = new Map<number, (message: BackendMessage) => void>();
  const host: DesktopHost = {
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => home,
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
        const stderrLines: string[] = [];
        const child = spawn(process.execPath, [CLI_MAIN, "rpc", "--stdio"], {
          cwd: ws,
          env: {
            ...process.env,
            NOCTURNE_HOME: home,
            NOCTURNE_STUB_KEY: "stub-key",
            NOCTURNE_STUB_URL: baseURL,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.set(id, child);
        readline
          .createInterface({ input: child.stdout as NodeJS.ReadableStream })
          .on("line", (line) => {
            channels.get(id)?.({ kind: "line", line });
          });
        readline
          .createInterface({ input: child.stderr as NodeJS.ReadableStream })
          .on("line", (line) => {
            stderrLines.push(line);
          });
        child.on("exit", (code) => {
          channels.get(id)?.({ kind: "closed", code, stderr: stderrLines.slice(-20) });
        });
        return id;
      }
      if (command === "backend_close") {
        const id = Number(args?.backendId);
        children.get(id)?.stdin?.end();
        return;
      }
      if (command === "backend_stderr") return [];
      if (command === "backend_send") {
        const id = Number(args?.backendId);
        const line = String(args?.line ?? "");
        children.get(id)?.stdin?.write(`${line}\n`);
        return;
      }
      if (command === "app_note") return;
      if (command === "shell_log") return [];
      throw new Error(`未处理外壳命令 ${command}`);
    },
  };
  return { host, children };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it.skipIf(!existsSync(CLI_MAIN))(
  "真实子进程：切换 Shell 后状态栏立即更新",
  async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "f01s-ws-"));
    const home = mkdtempSync(path.join(tmpdir(), "f01s-home-"));
    const { server, baseURL } = await startStub();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        model: "stub/stub-model",
        providers: [
          {
            id: "stub",
            type: "openai-compatible",
            baseURL,
            apiKeyEnv: "NOCTURNE_STUB_KEY",
            models: {
              "stub-model": {
                contextWindow: 128000,
                maxOutputTokens: 4096,
                capabilities: {
                  toolCalls: true,
                  parallelToolCalls: false,
                  reasoning: "none",
                  imageInput: false,
                  promptCache: false,
                  editTool: "edit",
                },
              },
            },
          },
        ],
      }),
    );
    const { host, children } = spawnHost(ws, home, baseURL);
    try {
      render(<App host={host} />);
      const field = await screen.findByLabelText<HTMLTextAreaElement>("消息输入", undefined, {
        timeout: 15_000,
      });
      fireEvent.change(field, { target: { value: "你好" } });
      await waitFor(
        () =>
          expect(screen.getByRole("button", { name: "发送" })).toHaveProperty("disabled", false),
        { timeout: 15_000 },
      );
      await waitFor(
        () =>
          expect(screen.getByRole("button", { name: "切换模型" }).textContent).toContain(
            "stub-model",
          ),
        { timeout: 15_000 },
      );
      act(() => {
        fireEvent.keyDown(field, { key: "Enter" });
      });
      await screen.findByRole("region", { name: "会话消息" }, { timeout: 20_000 });
      const pill = await screen.findByRole("button", { name: "切换 Shell" }, { timeout: 10_000 });
      await waitFor(() => expect(pill.textContent).toMatch(/Shell\s+\S+/), { timeout: 10_000 });
      await waitFor(() => expect(pill).toHaveProperty("disabled", false), { timeout: 10_000 });
      const before = pill.textContent;
      fireEvent.click(pill);
      let target: HTMLElement | undefined;
      await waitFor(
        () => {
          target = screen
            .getAllByRole("menuitemradio")
            .find((item) => item.textContent?.includes("cmd"));
          expect(target).toBeDefined();
        },
        { timeout: 10_000 },
      );
      fireEvent.click(target as HTMLElement);
      // 状态栏文字与菜单勾选都应更新
      await waitFor(() => expect(pill.textContent).not.toBe(before), { timeout: 8000 });
      await waitFor(() => expect(pill.textContent).toContain("cmd"));
      fireEvent.click(pill);
      const item = await screen.findByRole("menuitemradio", { name: /cmd/ });
      expect(item.getAttribute("aria-checked")).toBe("true");
    } finally {
      for (const child of children.values()) child.kill();
      await Promise.all(
        [...children.values()].map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.killed) {
                resolve();
                return;
              }
              child.once("exit", () => resolve());
              setTimeout(resolve, 3000);
            }),
        ),
      );
      server.close();
      // Windows 上子进程退出后工作目录锁可能延迟释放
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(ws, { recursive: true, force: true });
          rmSync(home, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  },
  60_000,
);
