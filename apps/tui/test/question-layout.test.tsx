/** 实际 Ink 帧验证弹窗预算与输入分隔线；不打开真实终端。 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
import { App } from "../src/app.js";

const roots: string[] = [];
function tmp(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nct-popup-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("弹窗未出现");
    await pause();
  }
}

describe("弹窗位置", () => {
  it.each(
    [false, true].flatMap((inline) =>
      ["ask_user", "shell"].flatMap((name) => [24, 8].map((rows) => ({ inline, name, rows }))),
    ),
  )(
    "$name inline=$inline rows=$rows：最新对话保留，弹窗末行紧接输入分隔线",
    async ({ inline, name, rows }) => {
      vi.stubEnv("NOCTURNE_HOME", tmp());
      const runtime = await createRuntime({
        cwd: tmp(),
        sessionsDir: tmp(),
        interactive: true,
        providers: [
          new FakeProvider({
            scripts: [
              [
                { type: "text_delta", text: "先前对话\n最新一行" },
                {
                  type: "tool_call",
                  toolCallId: "popup",
                  name,
                  input:
                    name === "ask_user"
                      ? {
                          questions: [
                            { question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
                          ],
                        }
                      : { command: "echo popup" },
                },
                { type: "finish", reason: "tool_calls" },
              ],
            ],
          }),
        ],
      });
      const session = await runtime.createSession({ model: "fake/fake-model" });
      const stdout = new EventEmitter() as NodeJS.WriteStream;
      stdout.columns = 80;
      stdout.rows = rows;
      stdout.isTTY = false;
      let frame = "";
      stdout.write = ((chunk: string | Uint8Array) => {
        if (String(chunk).includes("\n")) frame = String(chunk);
        return true;
      }) as NodeJS.WriteStream["write"];
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
      stdin.isTTY = true;
      stdin.setRawMode = () => stdin;
      stdin.ref = () => stdin;
      stdin.unref = () => stdin;
      const stderr = new EventEmitter() as NodeJS.WriteStream;
      stderr.write = (() => true) as NodeJS.WriteStream["write"];
      const app = render(
        createElement(App, { session, runtime, env: { ascii: false, animated: false }, inline }),
        { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false, debug: true },
      );
      await pause();
      const turn = session.submit({ text: "检查布局" });
      try {
        await waitFor(() =>
          frame.includes(name === "ask_user" ? "等待回答提问" : "等待权限确认"),
        ).catch((error) => {
          throw new Error(String(error) + "\n" + frame);
        });
        const lines = frame.trimEnd().split("\n");
        const top = lines.findIndex((line) => line.startsWith("╭"));
        const bottom = lines.findIndex((line, i) => i > top && line.startsWith("╰"));
        if (rows === 24) {
          expect(top).toBeGreaterThan(0);
          expect(lines.slice(0, top).join("\n")).toContain("最新一行");
        }
        expect(lines[bottom + 1]).toMatch(/^─+$/);
        expect(lines[bottom + 2]).toContain(name === "ask_user" ? "等待回答" : "等待权限确认");
        expect(lines[bottom - 1]?.trim()).not.toBe("│");
        if (!inline) expect(lines.length).toBeLessThanOrEqual(rows - 1);
        else expect(lines.length - top).toBeLessThanOrEqual(rows - 1);
        if (!inline) expect(lines.length).toBe(rows - 1);
        else expect(bottom - top).toBeLessThan(12);
        if (rows === 8) {
          await pause();
          (stdin as unknown as PassThrough).write(name === "ask_user" ? "\x1b[A" : "\t");
          await waitFor(() =>
            frame.includes(name === "ask_user" ? "> ( ) 拒绝回答" : ">[s] 本会话内允许"),
          );
        }
        (stdin as unknown as PassThrough).write("\x1b[5~");
        await pause();
        expect(frame).not.toContain("已向上翻阅");
      } finally {
        session.interrupt();
        await turn;
        app.unmount();
        await session.close();
      }
    },
  );
});
