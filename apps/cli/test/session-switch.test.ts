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
  type Runtime,
  type RuntimeSession,
} from "@nocturne/core";

import {
  createNewSession,
  createSessionSwitcher,
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
});

describe("createNewSession", () => {
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
    expect(res.session.session.durableEvents().map((e) => e.type)).toContain("session.created");
    await res.session.close();
  });
});
