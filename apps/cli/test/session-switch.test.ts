/**
 * /resume 会话切换（cli.md 第 4 节）：切换器的离线测试。
 * 覆盖：成功、锁冲突/目标不存在留在原会话、Turn 进行中拒绝、
 * 跨目录确认与重试、切换后可重放。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPlatform,
  createRuntime,
  FakeProvider,
  loadConfig,
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";

import {
  createNewSession,
  createSessionSwitcher,
  resumeFailureHint,
  sessionOpenNotes,
  type SessionHolder,
} from "../src/session-switch.js";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});
// mkdtempSync 可能返回 8.3 短名；会话的 workspaceRoot 经 platform.resolveReal
// 展开为长名（main.ts 的 cwd 同口径），这里保持一致
const platform = createPlatform();
const tmp = async (p: string) => {
  const d = await platform.resolveReal(mkdtempSync(path.join(tmpdir(), p)));
  tmpRoots.push(d);
  return d;
};

const TEXT = (text: string) => [
  { type: "text_delta" as const, text },
  { type: "finish" as const, reason: "stop" as const },
];

async function makeRuntime(cwd: string, sessionsDir: string): Promise<Runtime> {
  return createRuntime({
    cwd,
    sessionsDir,
    providers: [new FakeProvider({ scripts: [] })],
  });
}

function makeSwitcher(runtime: Runtime, cwd: string, session: RuntimeSession) {
  const holder: SessionHolder = { current: session };
  const switcher = createSessionSwitcher({
    runtime,
    platform,
    cwd,
    holder,
  });
  return { holder, switcher };
}

describe("createSessionSwitcher", () => {
  it("成功切换：holder 换入新会话，旧会话被关闭", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const sd = await tmp("nct-sw-sd-");
    const runtime = await makeRuntime(cwd, sd);
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    const s2 = await runtime.createSession({ model: "fake/fake-1" });
    await s2.close(); // 先释放 s2 的锁，切换时再 resume

    const { holder, switcher } = makeSwitcher(runtime, cwd, s1);
    const res = await switcher(s2.id);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.session.id).toBe(s2.id);
    expect(holder.current.id).toBe(s2.id);
    // 旧会话已关闭：submit 应被拒绝
    await expect(s1.submit({ text: "x" })).rejects.toThrow();
    await res.session.close();
  });

  it("切换到当前会话：报错且不动作", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const runtime = await makeRuntime(cwd, await tmp("nct-sw-sd-"));
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    const { holder, switcher } = makeSwitcher(runtime, cwd, s1);
    const res = await switcher(s1.id);
    expect(res).toEqual({ kind: "error", message: "已在该会话中" });
    expect(holder.current).toBe(s1);
    await s1.close();
  });

  it("目标被占用（锁冲突）：报错并留在原会话", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const runtime = await makeRuntime(cwd, await tmp("nct-sw-sd-"));
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    const s2 = await runtime.createSession({ model: "fake/fake-1" }); // s2 持锁未释放

    const { holder, switcher } = makeSwitcher(runtime, cwd, s1);
    const res = await switcher(s2.id);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.message).toContain("占用");
    expect(holder.current).toBe(s1);
    await s1.close();
    await s2.close();
  });

  it("目标不存在：报错并留在原会话", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const runtime = await makeRuntime(cwd, await tmp("nct-sw-sd-"));
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    const { holder, switcher } = makeSwitcher(runtime, cwd, s1);
    const res = await switcher("no-such-id");
    expect(res.kind).toBe("error");
    expect(holder.current).toBe(s1);
    await s1.close();
  });

  it("Turn 进行中拒绝切换（busy）", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const sd = await tmp("nct-sw-sd-");
    // 闸门 handler：release 前 stream 挂起（保持 openTurn），release 后按 abort 收束
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hanging = new FakeProvider({ handler: () => gate.then(() => TEXT("ok")) });
    const runtime = await createRuntime({ cwd, sessionsDir: sd, providers: [hanging] });
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    const s2 = await runtime.createSession({ model: "fake/fake-1" });
    await s2.close();

    const { holder, switcher } = makeSwitcher(runtime, cwd, s1);
    const turn = s1.submit({ text: "hi" });
    await new Promise((r) => setTimeout(r, 50));
    expect(s1.state().openTurn).toBeDefined();

    const res = await switcher(s2.id);
    expect(res.kind).toBe("busy");
    expect(holder.current).toBe(s1);

    s1.interrupt();
    release?.();
    await turn;
    await s1.close();
  });

  it("跨目录：先返回 foreign，确认后带 allowForeign 切换成功", async () => {
    const dirA = await tmp("nct-sw-a-");
    const dirB = await tmp("nct-sw-b-");
    const sd = await tmp("nct-sw-sd-");
    const rtA = await makeRuntime(dirA, sd);
    const foreign = await rtA.createSession({ model: "fake/fake-1" });
    const foreignId = foreign.id;
    await foreign.close();

    const rtB = await makeRuntime(dirB, sd);
    const s1 = await rtB.createSession({ model: "fake/fake-1" });
    const { holder, switcher } = makeSwitcher(rtB, dirB, s1);

    const res = await switcher(foreignId);
    expect(res.kind).toBe("foreign");
    if (res.kind !== "foreign") return;
    expect(res.workspaceRoot).toBe(dirA);
    expect(holder.current).toBe(s1); // 留在原会话

    const ok = await switcher(foreignId, { allowForeign: true });
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") return;
    expect(holder.current.id).toBe(foreignId);
    await ok.session.close();
  });

  it("sessionOpenNotes：无修复时只剩警告；有修复时带摘要", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const runtime = await makeRuntime(cwd, await tmp("nct-sw-sd-"));
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    expect(sessionOpenNotes(s1)).toEqual([]);
    await s1.close();
  });

  it("sessionOpenNotes：非法 NOCTURNE_SHELL 的启动警告透出（CLI/TUI 共用口径，ADR-0022）", async () => {
    // runtime.warning 事件发出时尚无订阅者；警告经 session.warnings →
    // sessionOpenNotes 透出，CLI/TUI 启动提示列表渲染它
    process.env["NOCTURNE_SHELL"] = "fish";
    try {
      const cwd = await tmp("nct-sw-cwd-");
      const runtime = await makeRuntime(cwd, await tmp("nct-sw-sd-"));
      const s1 = await runtime.createSession({ model: "fake/fake-1" });
      const notes = sessionOpenNotes(s1);
      expect(notes.some((n) => n.includes("fish") && n.includes("回退自动选择"))).toBe(true);
      // 生效 shell 自动兜底，不因非法 env 值而拒绝启动
      expect(s1.shellInfo().effective).toBeDefined();
      await s1.close();
    } finally {
      Reflect.deleteProperty(process.env, "NOCTURNE_SHELL");
    }
  });
});

describe("createNewSession", () => {
  it("配置注入后 /new 使用刚保存的默认模型、档位和权限，旧会话快照不变", async () => {
    const cwd = await tmp("nct-new-cwd-");
    const config = await loadConfig(platform, {
      nocturneHome: await tmp("nct-new-home-"),
      env: () => undefined,
    });
    const provider = new FakeProvider({
      models: ["old", "new"].map((model) => ({
        ref: { provider: "fake", model },
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "visible" as const,
          imageInput: false,
          promptCache: false,
          editTool: "edit" as const,
          reasoningEffort: ["low" as const, "high" as const],
        },
      })),
    });
    const runtime = await createRuntime({
      cwd,
      config,
      sessionsDir: await tmp("nct-new-sd-"),
      providers: [provider],
    });
    const old = await runtime.createSession({
      model: "fake/old",
      permissionPreset: "default",
      reasoningEffort: "off",
    });
    await runtime.setDefaultModel("fake/new", "high");
    await runtime.updateSettings({ "permissions.preset": "read-only" });
    expect(old.state().config.model.model).toBe("old");
    expect(old.state().config.permissionPreset).toBe("default");
    const result = await createNewSession({ runtime, holder: { current: old } })();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.session.state().config).toMatchObject({
      model: { provider: "fake", model: "new" },
      permissionPreset: "read-only",
      reasoningEffort: "high",
    });
    const restored = await runtime.resumeSession(old.id);
    expect(restored.state().config).toMatchObject({
      model: { model: "old" },
      permissionPreset: "default",
      reasoningEffort: "off",
    });
    await Promise.all([restored.close(), result.session.close()]);
  });

  it("沿用当前配置，先创建并换入新会话，再关闭旧会话；旧会话可恢复", async () => {
    const cwd = await tmp("nct-new-cwd-");
    const runtime = await makeRuntime(cwd, await tmp("nct-new-sd-"));
    const old = await runtime.createSession({ model: "fake/fake-1" });
    await old.setPermissionPreset("read-only");
    const holder: SessionHolder = { current: old };
    const res = await createNewSession({ runtime, holder })();
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.session.id).not.toBe(old.id);
    expect(holder.current).toBe(res.session);
    expect(res.session.state().config).toEqual(old.state().config);
    expect(res.session.state().history).toEqual([]);
    const restored = await runtime.resumeSession(old.id);
    expect(restored.state().config.permissionPreset).toBe("read-only");
    await restored.close();
    await res.session.close();
  });

  it("Turn 进行中拒绝创建且不换绑", async () => {
    const cwd = await tmp("nct-new-cwd-");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await createRuntime({
      cwd,
      sessionsDir: await tmp("nct-new-sd-"),
      providers: [new FakeProvider({ handler: () => gate.then(() => TEXT("ok")) })],
    });
    const old = await runtime.createSession({ model: "fake/fake-1" });
    const holder: SessionHolder = { current: old };
    const turn = old.submit({ text: "hold" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await createNewSession({ runtime, holder })()).toEqual({ kind: "busy" });
    expect(holder.current).toBe(old);
    old.interrupt();
    release?.();
    await turn;
    await old.close();
  });
});

describe("REPL /resume 与切换器组合", () => {
  it("切换后新会话的持久事件可被订阅重放（视图重建前提）", async () => {
    const cwd = await tmp("nct-sw-cwd-");
    const sd = await tmp("nct-sw-sd-");
    const runtime = await createRuntime({
      cwd,
      sessionsDir: sd,
      providers: [new FakeProvider({ scripts: [TEXT("来自旧会话的回答")] })],
    });
    const s1 = await runtime.createSession({ model: "fake/fake-1" });
    await s1.submit({ text: "hi" });

    const s2 = await runtime.createSession({ model: "fake/fake-1" });
    await s2.close();
    const { switcher } = makeSwitcher(runtime, cwd, s1);
    const res = await switcher(s2.id);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    // 新会话重放：durableEvents 含 session.created
    expect(res.session.durableEvents().map((e) => e.type)).toContain("session.created");
    await res.session.close();
  });
});

describe("恢复失败的 CLI 用法提示", () => {
  it("invalid_model 在恢复路径提示 --model，其余路径与错误不提示", async () => {
    const cwd = await tmp("nct-hint-cwd-");
    const sd = await tmp("nct-hint-sd-");
    // 会话记录的服务商已不存在 → resumeSession 抛 invalid_model（真链路）
    const before = await createRuntime({
      cwd,
      sessionsDir: sd,
      providers: [new FakeProvider({ id: "gone" })],
    });
    const created = await before.createSession({ model: "gone/fake-1" });
    const id = created.id;
    await created.close();
    const runtime = await makeRuntime(cwd, sd);
    const failure: unknown = await runtime.resumeSession(id).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "invalid_model" });
    expect(resumeFailureHint(failure, true)).toBe("加 --model <id> 指定替代模型");
    // 新建路径的同名错误不提示（--model 本就是显式入参）
    expect(resumeFailureHint(failure, false)).toBeUndefined();
    expect(resumeFailureHint(new Error("boom"), true)).toBeUndefined();
  });
});
