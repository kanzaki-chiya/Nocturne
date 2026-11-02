import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider } from "@nocturne/core";
import { runRepl } from "../src/repl.js";
import { internalSession } from "./internal-session.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-rewind-repl-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function repl(pending = false, tty = false) {
  const runtime = await createRuntime({
    cwd: temp(),
    sessionsDir: temp(),
    providers: [new FakeProvider({ scripts: pending ? [[{ type: "wait", ms: 60_000 }]] : [] })],
  });
  let session = await runtime.createSession({ model: "fake/fake-1" });
  await internalSession(session).emit("message.user", {
    messageId: "first",
    content: [{ type: "text", text: "保留" }],
  });
  await internalSession(session).emit("message.user", {
    messageId: "second",
    content: [{ type: "text", text: "修改这轮\n第二行" }],
  });
  const original = session;
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  if (tty) Object.assign(stdin, { isTTY: true, setRawMode: () => undefined });
  let output = "",
    errors = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const done = runRepl(
    session,
    runtime,
    { stdin, stdout, stderr },
    {
      switchSession: async (id) => {
        const next = await runtime.resumeSession(id);
        await session.close();
        session = next;
        return { kind: "ok", session: next };
      },
    },
  );
  const line = async (text: string, expected: string) => {
    const before = output.length;
    stdin.write(`${text}\n`);
    await vi.waitFor(() => expect(output.slice(before)).toContain(expected), { timeout: 5000 });
    await new Promise((resolve) => setImmediate(resolve));
  };
  if (tty) await vi.waitFor(() => expect(output).toContain("nctrn> "));
  return {
    runtime,
    original,
    stdin,
    line,
    done,
    current: () => session,
    output: () => output,
    errors: () => errors,
    close: async () => {
      stdin.end();
      await done;
      await session.close();
    },
  };
}

it("编号回退校验、灰显、默认取消；确认后仅一条通知并回填原文", async () => {
  const ui = await repl();
  try {
    await ui.line("/rewind bad", "用法：/rewind");
    await ui.line("/rewind", "选择轮次");
    await ui.line("1x", "无效轮次编号");
    await ui.line("1", "只回退对话");
    await ui.line("1", "没有可还原的文件");
    await ui.line("2", "确认回退？[y/N]");
    await ui.line("", "已取消");
    expect(ui.original.state().history.filter((e) => e.kind === "user")).toHaveLength(2);
    await ui.line("/rewind", "选择轮次");
    await ui.line("1", "只回退对话");
    await ui.line("2", "文件保持当前状态");
    await ui.line("y", "可修改后重发：修改这轮\n第二行");
    expect(ui.original.state().history.filter((e) => e.kind === "user")).toHaveLength(1);
    expect(ui.output().match(/已回退到「修改这轮」之前 • 还原 0 个文件/g)).toHaveLength(1);
    expect(ui.errors()).toBe("");
  } finally {
    await ui.close();
  }
});
it("/fork 和中途分叉复用会话切换，/resume 显示分叉标记", async () => {
  const ui = await repl();
  try {
    await ui.line("/fork", "已切换到会话");
    const full = ui.current();
    expect(full.id).not.toBe(ui.original.id);
    expect(full.state().history).toEqual(ui.original.state().history);
    await ui.line("/resume", "[分叉]");
    await ui.line("", "已取消");
    await ui.line("/rewind", "选择轮次");
    await ui.line("1", "从这里分叉新会话");
    await ui.line("4", "文件保持当前状态");
    await ui.line("y", "可修改后重发：修改这轮");
    expect(ui.current().state().meta.forkedFrom?.sessionId).toBe(full.id);
    expect(
      ui
        .current()
        .state()
        .history.filter((e) => e.kind === "user"),
    ).toHaveLength(1);
    expect(full.state().history.filter((e) => e.kind === "user")).toHaveLength(2);
  } finally {
    await ui.close();
  }
});
it("从执行方式消息分叉带命令名回填、不打回退提示；Runtime 写入的消息不回填", async () => {
  const ui = await repl();
  try {
    await internalSession(ui.original).emit("message.user", {
      messageId: "goal",
      content: [
        { type: "text", text: "修好登录" },
        { type: "text", text: "目标说明块" },
      ],
      workMode: { name: "goal", body: "目标说明块" },
    });
    await internalSession(ui.original).emit("message.user", {
      messageId: "check",
      content: [{ type: "text", text: "核对说明块" }],
      workMode: { name: "goal", body: "核对说明块", source: "runtime" },
    });
    // 轮次列表最新在上：1 = Runtime 核对消息
    await ui.line("/rewind", "选择轮次");
    await ui.line("1", "从这里分叉新会话");
    await ui.line("4", "文件保持当前状态");
    const beforeRuntimeFork = ui.output().length;
    await ui.line("y", "已切换到会话");
    expect(ui.output().slice(beforeRuntimeFork)).not.toContain("可修改后重发");
    expect(ui.current().state().meta.forkedFrom?.sessionId).toBe(ui.original.id);
    // 新会话里最新一条是 /goal 消息
    await ui.line("/rewind", "选择轮次");
    await ui.line("1", "从这里分叉新会话");
    await ui.line("4", "文件保持当前状态");
    await ui.line("y", "可修改后重发：/goal 修好登录");
    expect(ui.output()).not.toContain("已回退到");
    expect(
      ui
        .current()
        .state()
        .history.filter((e) => e.kind === "user"),
    ).toHaveLength(2);
  } finally {
    await ui.close();
  }
});
it("Turn 进行中拒绝 /rewind、/fork，EOF 中断并等待收束", async () => {
  const ui = await repl(true);
  try {
    ui.stdin.write("执行\n");
    await vi.waitFor(() => expect(ui.original.state().openTurn).toBeDefined());
    await ui.line("/rewind", "会话忙");
    await ui.line("/fork", "会话忙");
    expect(ui.output()).not.toContain("选择轮次");
    expect(await ui.runtime.listSessions()).toHaveLength(1);
  } finally {
    await ui.close();
  }
  expect(await ui.done).toBe(0);
});
it("分叉期间 Ctrl+C 不释放忙碌状态，EOF 等待操作完成", async () => {
  const ui = await repl(false, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fork = ui.runtime.forkSession.bind(ui.runtime);
  const spy = vi.spyOn(ui.runtime, "forkSession").mockImplementation(async (...args) => {
    await gate;
    return fork(...args);
  });
  const exited = vi.fn();
  void ui.done.then(exited);
  try {
    ui.stdin.write("/fork\n");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    await ui.line("\x03", "操作进行中，请稍候");
    await ui.line("/rewind", "会话忙");
    ui.stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exited).not.toHaveBeenCalled();
  } finally {
    release();
    ui.stdin.end();
    await ui.done;
    spy.mockRestore();
    await ui.current().close();
  }
  expect(exited).toHaveBeenCalledOnce();
  expect(ui.current().id).not.toBe(ui.original.id);
});
it("执行方式消息：列表与回填带命令名、不含说明块；Runtime 写入的消息不回填（ADR-0076 §1）", async () => {
  const ui = await repl();
  try {
    const session = internalSession(ui.original);
    await session.emit("message.user", {
      messageId: "goal",
      content: [
        { type: "text", text: "修好测试" },
        { type: "text", text: '<work-mode name="goal">Goal mode</work-mode>' },
      ],
      workMode: { name: "goal", body: "Goal mode" },
    });
    await session.emit("message.user", {
      messageId: "approve",
      content: [
        { type: "text", text: "批准" },
        { type: "text", text: '<work-mode name="plan">Approved</work-mode>' },
      ],
      workMode: { name: "plan", body: "Approved", source: "runtime" },
    });
    await ui.line("/rewind", "选择轮次");
    expect(ui.output()).toContain("1. /plan 批准");
    expect(ui.output()).toContain("2. /goal 修好测试");
    expect(ui.output()).not.toContain("Goal mode");
    await ui.line("1", "只回退对话");
    await ui.line("2", "文件保持当前状态");
    const before = ui.output().length;
    await ui.line("y", "已回退到");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ui.output().slice(before)).not.toContain("可修改后重发");
    await ui.line("/rewind", "选择轮次");
    await ui.line("1", "只回退对话");
    await ui.line("2", "文件保持当前状态");
    await ui.line("y", "可修改后重发：/goal 修好测试");
    expect(ui.output()).not.toContain("<work-mode");
  } finally {
    await ui.close();
  }
});
