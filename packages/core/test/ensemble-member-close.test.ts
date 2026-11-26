/**
 * 打开成员会话的界面句柄（runtime.resumeSession(childSessionId)，RPC `session.open`）再关闭，
 * 只释放句柄：不中断、不关闭 Runtime 托管的常驻成员（ADR-0089 §10，rpc.md 第 3 节）。
 * 后半对比受校验（validate）与普通恢复对共享成员快路径的分流（ADR-0127 第二阶段收尾）。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, type Runtime, type RuntimeSession } from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";

const roots: string[] = [];
const sessions: RuntimeSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stopText = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

function role(req: ModelRequest): string {
  const sys = req.system.map((b) => b.text).join("\n");
  const match = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys);
  return match?.[1] !== undefined ? `member:${match[1]}` : "maestro";
}

/**
 * 搭好一个活动 Ensemble：指挥 coord + 成员 worker（childSessionId）。
 * 返回 runtime、指挥会话、成员 childSessionId 与成员请求记录。
 */
async function setupEnsemble(): Promise<{
  rt: Runtime;
  coord: RuntimeSession;
  child: string;
  ws: string;
  memberTurns: string[];
}> {
  const ws = mkdtempSync(path.join(tmpdir(), "nocturne-ensemble-close-"));
  roots.push(ws);
  let setup = false;
  const memberTurns: string[] = [];
  const provider = new FakeProvider({
    id: "fake",
    models: [
      {
        ref: { provider: "fake", model: "m1" },
        protocol: "openai-compatible" as const,
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        capabilities: {
          toolCalls: true,
          parallelToolCalls: true,
          reasoning: "none" as const,
          imageInput: false,
          promptCache: false,
          editTool: "edit" as const,
        },
      },
    ],
    roleHandler: () => stopText("Title"),
    handler: (req) => {
      const who = role(req);
      if (who === "maestro") {
        if (!setup) {
          setup = true;
          return [
            { type: "tool_call", toolCallId: "i", name: "ensemble_init", input: { title: "T" } },
            {
              type: "tool_call",
              toolCallId: "a",
              name: "ensemble_add_member",
              input: {
                name: "worker",
                charter: { owns: "a.ts", handsOff: "b.ts", doneWhen: "tests pass" },
              },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        }
        return stopText("coord idle");
      }
      memberTurns.push(JSON.stringify(req.messages));
      return stopText("worker done");
    },
  });
  const rt = await createRuntime({
    cwd: ws,
    workspaceRoot: ws,
    sessionsDir: path.join(ws, ".sessions"),
    providers: [provider],
    interactive: true,
    subagent: { background: true },
  });
  const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
  sessions.push(coord);
  await coord.submit({ text: "go", workMode: "ensemble" });
  await vi.waitFor(() => {
    expect(replaySessionView(coord.durableEvents()).ensemble?.members).toHaveLength(1);
    expect(coord.isIdle()).toBe(true);
  });
  const child = replaySessionView(coord.durableEvents()).ensemble?.members[0]?.childSessionId ?? "";
  return { rt, coord, child, ws, memberTurns };
}

describe("Ensemble 成员会话句柄", { timeout: 30_000 }, () => {
  it("关闭成员会话句柄不中断、不移除成员，之后仍能被 @ 唤醒", async () => {
    const { rt, coord, child, memberTurns } = await setupEnsemble();

    // 打开成员句柄并私信一轮
    const handle = await rt.resumeSession(child);
    await handle.submit({ text: "PRIVATE-1" });
    await vi.waitFor(() => {
      expect(memberTurns.some((m) => m.includes("PRIVATE-1"))).toBe(true);
      expect(coord.isIdle()).toBe(true);
    });

    // 关闭句柄：成员仍在 Ensemble 里、未被移除，Ensemble 仍是活动状态
    await handle.close();
    const view = replaySessionView(coord.durableEvents()).ensemble;
    expect(view?.status).toBe("active");
    expect(view?.members[0]?.status).not.toBe("removed");

    // 之后仍能被留言板 @ 唤醒，且能重新打开句柄
    await coord.postToEnsemble({ text: "@worker AFTER-CLOSE" });
    await vi.waitFor(() => {
      expect(memberTurns.some((m) => m.includes("AFTER-CLOSE"))).toBe(true);
    });
    const again = await rt.resumeSession(child);
    expect(again.id).toBe(child);
    await again.close();
  });
});

describe("受校验恢复与普通恢复的共享成员分流", { timeout: 30_000 }, () => {
  // 活动 Ensemble 的成员会话由 Runtime 经 store.load 托管并持有排他锁（见
  // index.ts 常驻子会话装配）。因此普通恢复命中共享快路径时拿到的是**借用的
  // 托管 proxy**（绕过任何 validate）；而受校验恢复跳过该快路径、改走 store.load
  // 独占锁路径，会因锁被托管方占用而拒绝——「拒绝」正是修复要的安全结果：
  // 宁可不恢复，也不返回一个绕过资格校验的借用会话。本组用合成 fixture 对比两者。
  const lockFile = (ws: string, id: string) => path.join(ws, ".sessions", `${id}.lock`);

  it("普通恢复成员会话命中共享快路径：拿到借用 proxy（对照，证明 fixture 有效）", async () => {
    const { rt, child, ws } = await setupEnsemble();
    // 成员会话此刻正被 Runtime 托管持锁（锁文件存在）。若普通恢复走独占锁路径
    // 必然 session_locked；它能成功，证明走的是共享 proxy 快路径——普通调用方
    // （桌面等）的共享行为保持不变。
    expect(existsSync(lockFile(ws, child))).toBe(true);
    const handle = await rt.resumeSession(child);
    expect(handle.id).toBe(child);
    await handle.close();
  });

  it("受校验恢复成员会话不借用 proxy：跳过共享快路径、取独占锁而被占用拒绝", async () => {
    const { rt, child, ws } = await setupEnsemble();
    // 关键证据：同一成员会话，普通恢复能打开（上一测试），受校验恢复却拒绝。
    // 差异只能来自受校验恢复绕开了共享 proxy 快路径、改走 store.load 独占锁，
    // 撞上托管方持有的锁。若它仍借用 proxy，就会和普通恢复一样成功。
    expect(existsSync(lockFile(ws, child))).toBe(true);
    let validated = false;
    await expect(
      rt.resumeSession(child, {
        validate: () => {
          validated = true;
        },
      }),
    ).rejects.toThrow(/session_locked|占用/);
    // 锁路径在 validate 之前就被占用拒绝，validate 不应被调用到（取锁失败即终止）。
    expect(validated).toBe(false);
    // 不借用 proxy 的旁证：恢复失败后，成员会话的锁仍由原托管方持有、未被破坏，
    // 普通恢复依旧能借用——受校验恢复没有碰它。
    const handle = await rt.resumeSession(child);
    expect(handle.id).toBe(child);
    await handle.close();
  });

  it("受校验恢复对合法顶层会话仍可恢复（validate 通过、取锁、正常包装）", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "nocturne-top-validate-"));
    roots.push(ws);
    const provider = new FakeProvider({ scripts: [stopText("hi")] });
    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
    });
    const top = await rt.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    sessions.push(top);
    await top.submit({ text: "hello" });
    await vi.waitFor(() => expect(top.isIdle()).toBe(true));
    const topId = top.id;
    await top.close();

    // 顶层会话不属于任何合奏/组曲——普通恢复和受校验恢复都应成功取锁恢复
    const validated: string[] = [];
    const resumed = await rt.resumeSession(topId, {
      validate: (state) => {
        validated.push(state.meta.parent === undefined ? "top" : "child");
      },
    });
    expect(validated).toEqual(["top"]);
    expect(resumed.id).toBe(topId);
    expect(resumed.isIdle()).toBe(true);
    await resumed.close();
  });

  it("受校验恢复不调用共享成员解析器：validate 抛错即失败、不留锁、可重试", async () => {
    // validate 存在时整个共享快路径被跳过，ensembleMember/suiteThread 根本不被调用
    // ——它们内部的 openOrGetMemberBySessionId 可能打开尚未在用的成员会话。这里用
    // 顶层会话验证：validate 抛错 → 恢复失败、锁释放、随后合法 validate 仍可恢复，
    // 证明资格校验在锁内生效且无残留（对成员会话同理，差异只是成员还被占用拒绝）。
    const ws = mkdtempSync(path.join(tmpdir(), "nocturne-vvalidate-retry-"));
    roots.push(ws);
    const provider = new FakeProvider({ scripts: [stopText("hi")] });
    const rt2 = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
    });
    const top = await rt2.createSession({ model: "fake/fake-1", permissionPreset: "bypass" });
    sessions.push(top);
    await top.submit({ text: "hello" });
    await vi.waitFor(() => expect(top.isIdle()).toBe(true));
    const topId = top.id;
    await top.close();

    await expect(
      rt2.resumeSession(topId, {
        validate: () => {
          throw new Error("not-eligible");
        },
      }),
    ).rejects.toThrow("not-eligible");
    // validate 抛错后锁已释放：立刻再用合法 validate 恢复成功（无残留占用）
    const ok = await rt2.resumeSession(topId, { validate: () => undefined });
    expect(ok.id).toBe(topId);
    await ok.close();
  });
});
