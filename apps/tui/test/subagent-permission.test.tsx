/**
 * TUI 子代理权限转发（PermissionDialog 来源标注 + App 混排顺序与回应路由）。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRuntime,
  FakeProvider,
  type Runtime,
  type RuntimeEvent,
  type RuntimeSession,
} from "@nocturne/core";
import type { PendingPermission, SubagentPendingPermission } from "@nocturne/core/protocol";

import { runTui } from "../src/index.js";
import { App } from "../src/app.js";
import { PermissionDialog, permissionDialogRows } from "../src/components/permission-dialog.js";
import { TuiEnvContext } from "../src/env.js";
import { flush } from "./provider-test-utils.js";

const ENV = { ascii: false, animated: false };

const tmpRoots: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpRoots.push(d);
  return d;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp("nct-tui-sub-home-")));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function inEnv(node: React.ReactElement) {
  return createElement(TuiEnvContext.Provider, { value: ENV }, node);
}

describe("TUI 子代理权限转发", () => {
  it("PermissionDialog 标明子代理档位与任务摘要，且 permissionDialogRows 预留 1 行", () => {
    const pending: PendingPermission = {
      requestId: "r-sub-1",
      callId: "c-sub-1",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "git status" }],
      reason: "命中规则",
      options: ["allow_once", "allow_session", "deny", "deny_stop"],
    };

    expect(permissionDialogRows(pending, 80, false, true)).toBe(
      permissionDialogRows(pending, 80, false, false) + 1,
    );

    const { lastFrame, unmount } = render(
      inEnv(
        createElement(PermissionDialog, {
          pending,
          source: { profile: "explore", taskSummary: "排查测试失败" },
          active: true,
          onReply: vi.fn(),
          width: 80,
        }),
      ),
    );
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("需要确认");
      expect(frame).toContain("子代理 [explore] • 排查测试失败");
    } finally {
      unmount();
    }
  });

  it("App 按全局到达顺序混排父/子权限，并在确认后路由到对应回应入口", async () => {
    const runtime: Runtime = await createRuntime({
      cwd: tmp("nct-tui-sub-ws-"),
      sessionsDir: tmp("nct-tui-sub-sd-"),
      providers: [new FakeProvider({ scripts: [] })],
    });
    const realSession = await runtime.createSession({ model: "fake/fake-model" });
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const origSubscribe = realSession.subscribe.bind(realSession);
    const parentReplies: { requestId: string; reply: unknown }[] = [];
    const subReplies: { childSessionId: string; requestId: string; reply: unknown }[] = [];

    const session = new Proxy(realSession, {
      get(target, prop, receiver) {
        if (prop === "subscribe") {
          return (fn: (event: RuntimeEvent) => void) => {
            listeners.add(fn);
            const unsub = origSubscribe(fn);
            return () => {
              listeners.delete(fn);
              unsub();
            };
          };
        }
        if (prop === "respondPermission") {
          return (requestId: string, reply: unknown) => {
            parentReplies.push({ requestId, reply });
            return Promise.resolve();
          };
        }
        if (prop === "respondSubagentPermission") {
          return (childSessionId: string, requestId: string, reply: unknown) => {
            subReplies.push({ childSessionId, requestId, reply });
            return Promise.resolve();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as RuntimeSession;

    const emit = (ev: RuntimeEvent) => {
      for (const fn of listeners) fn(ev);
    };

    const { lastFrame, stdin, unmount } = render(
      createElement(App, {
        session,
        runtime,
        env: ENV,
        inline: true,
      }),
    );
    try {
      await flush();

      const childReq: SubagentPendingPermission = {
        childSessionId: "child-1",
        parentCallId: "parent-call-1",
        profile: "general",
        taskSummary: "修改配置脚本",
        afterSeq: 5,
        order: 1,
        requestId: "r-child",
        callId: "c1",
        toolName: "shell",
        subjects: [{ kind: "shell", target: "npm test" }],
        reason: "子代理确认",
        options: ["allow_once", "allow_session", "deny", "deny_stop"],
      };

      // 同时存在父与子请求：child (afterSeq=5) 先于 parent (seq=6)
      emit({
        type: "subagent.permissions",
        sessionId: realSession.id,
        runId: "run-1",
        eseq: 1,
        afterSeq: 5,
        time: "2026-11-14T00:00:00.000Z",
        payload: { pending: [childReq] },
      });
      emit({
        type: "permission.requested",
        sessionId: realSession.id,
        seq: 6,
        time: "2026-11-14T00:00:01.000Z",
        payload: {
          requestId: "r-parent",
          callId: "c-parent",
          subjects: [{ kind: "edit", target: "/ws/parent.ts" }],
          reason: "父请求确认",
          options: ["allow_once", "deny"],
        },
      });
      await flush();

      expect(lastFrame() ?? "").toContain("子代理 [general] • 修改配置脚本");

      // 按 a 允许子请求
      stdin.write("a");
      await flush();
      expect(subReplies).toEqual([
        { childSessionId: "child-1", requestId: "r-child", reply: { decision: "allow" } },
      ]);

      // 紧接着显示父自身请求
      expect(lastFrame() ?? "").toContain("/ws/parent.ts");
      stdin.write("a");
      await flush();
      expect(parentReplies).toEqual([{ requestId: "r-parent", reply: { decision: "allow" } }]);
    } finally {
      unmount();
      await realSession.close();
    }
  });

  it("父会话 idle 且存在后台等待子权限时按 Ctrl+C：真实 Runtime 调用 interrupt 结算而不直接退出", async () => {
    const outsideDir = tmp("nct-tui-outside-");
    const outsideFile = path.join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const ws = tmp("nct-tui-sub-ws-");
    let childCalls = 0;
    const provider = new FakeProvider({
      handler: (req) => {
        const isChild = req.tools.some((t) => t.name === "finish");
        const hasToolResult = req.messages.some((m) => m.role === "tool");
        if (!isChild) {
          if (!hasToolResult) {
            return [
              {
                type: "tool_call",
                toolCallId: "parent-bg-task",
                name: "task",
                input: { task: "后台读取外部文件", preset: "explore", background: true },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return [
            { type: "text_delta", text: "后台已启动" },
            { type: "finish", reason: "stop" },
          ];
        }
        childCalls += 1;
        if (childCalls === 1) {
          return [
            {
              type: "tool_call",
              toolCallId: "child-read-outside",
              name: "read",
              input: { path: outsideFile },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return [
          {
            type: "tool_call",
            toolCallId: "child-finish",
            name: "finish",
            input: { result: "done" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      },
    });
    const runtime: Runtime = await createRuntime({
      cwd: ws,
      sessionsDir: tmp("nct-tui-sub-sd-"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const session = await runtime.createSession({ model: "fake/fake-model" });
    const interruptSpy = vi.spyOn(session, "interrupt");

    const stdoutChunks: string[] = [];
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    stdout.columns = 80;
    stdout.rows = 24;
    stdout.isTTY = true;
    stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];
    const stderr = new EventEmitter() as NodeJS.WriteStream;
    stderr.write = (() => true) as NodeJS.WriteStream["write"];
    const stdin = new EventEmitter() as NodeJS.ReadStream & { write: (d: string) => void };
    stdin.isTTY = true;
    let buffered: string | null = null;
    stdin.setRawMode = () => stdin;
    stdin.setEncoding = () => stdin;
    stdin.resume = () => stdin;
    stdin.pause = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    stdin.read = (() => {
      const d = buffered;
      buffered = null;
      return d;
    }) as NodeJS.ReadStream["read"];
    stdin.write = ((data: string) => {
      buffered = data;
      stdin.emit("readable");
      stdin.emit("data", data);
      return true;
    }) as NodeJS.ReadStream["write"] & ((d: string) => void);

    let exited = false;
    const done = runTui({ session }, runtime, {
      stdin,
      stdout,
      stderr,
      patchConsole: false,
      inline: true,
    }).then((res) => {
      exited = true;
      return res;
    });

    const waitUntil = async (check: () => boolean, label: string, timeoutMs = 6000) => {
      await vi.waitFor(
        () => {
          if (!check()) throw new Error(`等待超时：${label}`);
        },
        { timeout: timeoutMs, interval: 20 },
      );
    };

    try {
      await waitUntil(() => stdoutChunks.join("").includes("Nocturne"), "TUI 启动");
      const turn = session.submit({ text: "启动后台探索" });
      expect(await turn).toBe("done");
      await waitUntil(() => stdoutChunks.join("").includes("需要确认"), "后台子代理权限确认框弹出");

      // 此时父会话已 idle，仅后台子代理在等待确认；首次 Ctrl+C 应先 interrupt 结算而不退出
      stdin.write("\x03");
      await waitUntil(() => interruptSpy.mock.calls.length === 1, "触发 session.interrupt");
      await flush();
      expect(exited).toBe(false);

      // 结算后再按 Ctrl+C：正常退出
      stdin.write("\x03");
      await done;
      expect(exited).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("带 ruleSuggestion 的 PendingPermission 在 PermissionDialog 中照常只显示原有选项", () => {
    const pending: PendingPermission = {
      requestId: "r-rule-1",
      callId: "c-rule-1",
      toolName: "shell",
      subjects: [{ kind: "shell", target: "git status --short" }],
      reason: "命中规则",
      options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
      ruleSuggestion: { pattern: "git status *" },
    };
    const { lastFrame, unmount } = render(
      inEnv(
        createElement(PermissionDialog, {
          pending,
          active: true,
          onReply: vi.fn(),
          width: 100,
        }),
      ),
    );
    try {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("允许一次");
      expect(frame).toContain("本会话内允许");
      expect(frame).toContain("在此项目中始终允许");
      expect(frame).toContain("拒绝（可附反馈）");
      expect(frame).toContain("拒绝并停止本轮");
      expect(frame).not.toContain("改成规则");
    } finally {
      unmount();
    }
  });
});
