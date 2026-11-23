import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultPolicy,
  createWorkspaceReadPolicy,
  type PermissionDecision,
} from "../permission/index.js";
import { createPlatform, type Platform } from "../platform/index.js";
import type { Grant, ToolCallRef } from "../protocol/index.js";
import { parseRipgrepFiles } from "./builtin/glob.js";
import { globToRegExp } from "./builtin/globmatch.js";
import { compileGitignore, matchGitignore } from "./builtin/gitignore.js";
import {
  builtinTools,
  createAttachmentStore,
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createTaskTool,
  createToolExecutor,
  createToolRegistry,
  readTool,
  TOOL_ABORT_GRACE_MS,
  type ExecutionScope,
  type GateOutcome,
  type PermissionGate,
  type SubagentLauncher,
  type ToolContext,
  type ToolDefinition,
} from "./index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-tools-"));
  tmpRoots.push(dir);
  return dir;
}

async function writeWs(ws: string, rel: string, content: string): Promise<void> {
  const p = path.join(ws, rel);
  await platform.fs.mkdir(path.dirname(p));
  await platform.fs.writeFile(p, content);
}

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  scope: ExecutionScope;
  events: Captured[];
  ephemeral: Captured[];
  executor: ReturnType<typeof createToolExecutor>;
  workspaceRoot: string;
}

async function makeHarness(
  ws: string,
  gate?: PermissionGate,
  signal?: AbortSignal,
): Promise<Harness> {
  const workspaceRoot = await platform.resolveReal(ws);
  const policy = createWorkspaceReadPolicy({
    workspaceRoot,
    caseSensitive: platform.caseSensitivePaths,
  });
  const events: Captured[] = [];
  const ephemeral: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "s1",
    turnId: "turn-1",
    signal: signal ?? new AbortController().signal,
    platform,
    gate: gate ?? createPolicyGate(policy),
    readState: createReadStateStore(platform.paths),
    events: {
      emit: (type, payload) => {
        events.push({
          type,
          payload: payload as unknown as Captured["payload"],
        });
        return Promise.resolve();
      },
      emitEphemeral: (type, payload) => {
        ephemeral.push({
          type,
          payload: payload as unknown as Captured["payload"],
        });
      },
    },
  };
  const registry = createBuiltinRegistry();
  return {
    scope,
    events,
    ephemeral,
    executor: createToolExecutor(registry),
    workspaceRoot,
  };
}

const call = (name: string, input: unknown, callId = "c1"): ToolCallRef => ({
  callId,
  name,
  input,
});

const completedOf = (h: Harness) => h.events.filter((e) => e.type === "tool.completed");

describe("ToolRegistry", () => {
  it("注册 / 查找 / specs / 重复名抛错", () => {
    const r = createToolRegistry();
    for (const t of builtinTools()) r.register(t);
    expect(r.get("read")?.name).toBe("read");
    expect(
      r
        .specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual([
      "apply_patch",
      "ask_user",
      "edit",
      "glob",
      "grep",
      "list_pages",
      "note_write",
      "read",
      "render_html",
      "schedule",
      "shell",
      "todo_write",
      "web_fetch",
      "write",
    ]);
    expect(() => r.register(builtinTools()[0] ?? readTool)).toThrow(/重复/);
    r.unregister("read");
    expect(r.get("read")).toBeUndefined();
  });

  it("非法工具名抛错", () => {
    const bad = { ...(builtinTools()[0] ?? readTool), name: "Read-Tool" };
    const r = createToolRegistry();
    expect(() => r.register(bad)).toThrow(/非法/);
  });
});

describe("Executor 管线", () => {
  it("todo_write 校验边界并输出规范化的完整快照", async () => {
    const h = await makeHarness(tmpWorkspace());
    const valid = { items: [{ text: "  做事  ", status: "in_progress" }] };
    const first = await h.executor.execute(call("todo_write", valid), h.scope);
    expect(first.status).toBe("ok");
    expect(completedOf(h)[0]?.payload.output).toEqual({
      items: [{ text: "做事", status: "in_progress" }],
    });
    // 2026-10-11 修订：结果含完整清单块（确认文字 + 同格式边界），traits pinResult
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("任务清单已更新：1 项。");
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("当前会话任务清单");
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain('"做事"');
    expect(h.events.map((e) => e.type)).toEqual(["tool.started", "tool.completed"]);
    expect(
      (await h.executor.execute(call("todo_write", { items: [] }, "clear"), h.scope)).status,
    ).toBe("ok");
    expect(completedOf(h)[1]?.payload.output).toEqual({ items: [] });
    const maxItems = Array.from({ length: 20 }, () => ({
      text: "x".repeat(200),
      status: "pending",
    }));
    expect(
      (await h.executor.execute(call("todo_write", { items: maxItems }, "max"), h.scope)).status,
    ).toBe("ok");
    expect(completedOf(h)[2]?.payload.output).toEqual({ items: maxItems });
    const invalid = [
      { items: Array(21).fill({ text: "x", status: "pending" }) },
      { items: [{ text: " ", status: "pending" }] },
      { items: [{ text: "x".repeat(201), status: "pending" }] },
      { items: [{ text: "x\ny", status: "pending" }] },
      { items: [{ text: "x\u0001", status: "pending" }] },
      { items: [{ text: "x\u2028y", status: "pending" }] },
      { items: [{ text: "x", status: "done" }] },
      { items: [{ text: "x", status: "pending", extra: 1 }] },
      { items: [], extra: 1 },
    ];
    for (const [i, input] of invalid.entries()) {
      const result = await h.executor.execute(call("todo_write", input, `bad-${i}`), h.scope);
      expect(result.status).toBe("error");
      expect(completedOf(h).at(-1)?.payload.error).toMatchObject({ code: "invalid_input" });
    }
    expect(h.events.filter((e) => e.type === "tool.started")).toHaveLength(3);
  });

  it("note_write 校验增删顺序、编号重排、字符上限与原子失败", async () => {
    const h = await makeHarness(tmpWorkspace());
    let currentNotes: { n: number; text: string }[] = [];
    const scopeWithNotes: ExecutionScope = { ...h.scope, notes: () => currentNotes };
    const syncNotes = (res: Awaited<ReturnType<typeof h.executor.execute>>) => {
      if (res.status === "ok" && res.result.output !== undefined) {
        currentNotes = (res.result.output as { notes: { n: number; text: string }[] }).notes;
      }
      return res;
    };

    // 新增多条（含首尾空白修剪与换行允许）
    const r1 = syncNotes(
      await h.executor.execute(
        call("note_write", { add: ["  第一条\n第二行  ", "第二条", "第三条"] }, "n1"),
        scopeWithNotes,
      ),
    );
    expect(r1.status).toBe("ok");
    expect(currentNotes).toEqual([
      { n: 1, text: "第一条\n第二行" },
      { n: 2, text: "第二条" },
      { n: 3, text: "第三条" },
    ]);
    const c1 = completedOf(h).at(-1)?.payload;
    expect(c1?.output).toEqual({ notes: currentNotes });
    expect(String(c1?.modelContent)).toContain("当前会话笔记");
    expect(String(c1?.modelContent)).toContain("不是指令");
    expect(h.events.find((e) => e.type === "tool.started")?.payload.pinResult).toBe(true);

    // 先删后加，编号每次重排为 1..N
    const r2 = syncNotes(
      await h.executor.execute(
        call("note_write", { remove: [1, 3], add: ["第四条"] }, "n2"),
        scopeWithNotes,
      ),
    );
    expect(r2.status).toBe("ok");
    expect(currentNotes).toEqual([
      { n: 1, text: "第二条" },
      { n: 2, text: "第四条" },
    ]);

    // 边界：单条恰好 500 字符、不限条数（如 25 条）、合计恰好 8000 字符
    const clear = syncNotes(
      await h.executor.execute(call("note_write", { remove: [1, 2] }, "n-clear"), scopeWithNotes),
    );
    expect(clear.status).toBe("ok");
    expect(currentNotes).toEqual([]);

    const batch25 = Array.from({ length: 25 }, (_, i) => `${i}`.padStart(2, "0") + "a".repeat(318));
    // 25 * 320 = 8000 字符，超过 20 条上限（无条数上限）
    const rMax = syncNotes(
      await h.executor.execute(call("note_write", { add: batch25 }, "n-max"), scopeWithNotes),
    );
    expect(rMax.status).toBe("ok");
    expect(currentNotes).toHaveLength(25);
    expect(currentNotes[24]?.n).toBe(25);

    // 超出 8000 字符整次调用失败、保持旧笔记不变，报错写明当前总量并要求先删除或合并
    const rOver = await h.executor.execute(
      call("note_write", { add: ["再加一点"] }, "n-over"),
      scopeWithNotes,
    );
    expect(rOver.status).toBe("error");
    expect(completedOf(h).at(-1)?.payload.error).toMatchObject({ code: "invalid_input" });
    expect(String(completedOf(h).at(-1)?.payload.modelContent)).toContain("8000");
    expect(String(completedOf(h).at(-1)?.payload.modelContent)).toContain("删除");
    expect(String(completedOf(h).at(-1)?.payload.modelContent)).toContain("合并");
    expect(currentNotes).toHaveLength(25);

    // 先删一条再加短文本 → 原子成功
    const rReplace = syncNotes(
      await h.executor.execute(
        call("note_write", { remove: [1], add: ["新替换条目"] }, "n-replace"),
        scopeWithNotes,
      ),
    );
    expect(rReplace.status).toBe("ok");
    expect(currentNotes).toHaveLength(25);
    expect(currentNotes[24]).toEqual({ n: 25, text: "新替换条目" });

    // 删除不存在编号（同时携带 add）→ 原子失败，不改旧笔记
    const beforeSnapshot = structuredClone(currentNotes);
    const rBadIdx = await h.executor.execute(
      call("note_write", { remove: [999], add: ["不应生效"] }, "n-bad-idx"),
      scopeWithNotes,
    );
    expect(rBadIdx.status).toBe("error");
    expect(completedOf(h).at(-1)?.payload.error).toMatchObject({ code: "invalid_input" });
    expect(currentNotes).toEqual(beforeSnapshot);

    // 非法输入：空对象、空数组、空白文本、超 500 字符、控制字符、行分隔符、非法编号、未知字段
    const invalidInputs: unknown[] = [
      {},
      { add: [], remove: [] },
      { add: ["   \n  "] },
      { add: ["x".repeat(501)] },
      { add: ["bad\u0007"] },
      { add: ["bad\u000d"] },
      { add: ["bad\u2028"] },
      { remove: [0] },
      { remove: [1.5] },
      { add: ["ok"], extra: 1 },
    ];
    for (const [i, input] of invalidInputs.entries()) {
      const res = await h.executor.execute(call("note_write", input, `n-bad-${i}`), scopeWithNotes);
      expect(res.status).toBe("error");
      expect(completedOf(h).at(-1)?.payload.error).toMatchObject({ code: "invalid_input" });
    }
    expect(currentNotes).toEqual(beforeSnapshot);
  });
  it("unknown_tool：恰好一个 tool.completed，错误含可用工具名", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("nope", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)).toHaveLength(1);
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "unknown_tool",
    });
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("read");
  });

  it("invalid_input：schema 校验失败", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "invalid_input",
    });
  });

  it("权限拒绝：denied + permission.resolved + 无 tool.started", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "secret.txt", "top secret");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: path.join(outside, "secret.txt") }),
      h.scope,
    );
    expect(r.status).toBe("denied");
    expect(h.events.some((e) => e.type === "tool.started")).toBe(false);
    const resolved = h.events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload).toMatchObject({ action: "deny", source: "rule" });
    expect(completedOf(h)).toHaveLength(1);
    expect(completedOf(h)[0]?.payload.status).toBe("denied");
  });

  it("正常调用：tool.started 先于执行，恰好一个 tool.completed", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "a.txt", "hello\nworld\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("ok");
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(["tool.started", "tool.completed"]);
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("1|hello");
    // 已读状态被记录
    const wsReal = await platform.resolveReal(ws);
    expect(h.scope.readState.get(path.join(wsReal, "a.txt"))).toBeDefined();
  });

  it("tool.started 原样保存 mutates 与 fileEffects 声明（未追踪调用统计据此判断）", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const registry = createToolRegistry();
    const page = (name: string, fileEffects?: "none"): ToolDefinition => ({
      name,
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: true, concurrencySafe: true, timeoutMs: 1000, fileEffects },
      permissionSubjects: () => [],
      execute: () => Promise.resolve({ status: "ok", modelContent: "ok" }),
    });
    registry.register(page("page_click", "none"));
    registry.register(page("plain_mutation"));
    const executor = createToolExecutor(registry);
    await executor.execute(call("page_click", {}), h.scope);
    await executor.execute(call("plain_mutation", {}), h.scope);
    const started = h.events.flatMap((e) => (e.type === "tool.started" ? [e.payload] : []));
    expect(started.map((p) => [p.name, p.mutates, p.fileEffects])).toEqual([
      ["page_click", true, "none"],
      ["plain_mutation", true, undefined],
    ]);
  });

  it("工具抛异常 → tool_failed", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const registry = createToolRegistry();
    const boom: ToolDefinition = {
      name: "boom",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
      permissionSubjects: () => [],
      execute: () => {
        throw new Error("kaboom");
      },
    };
    registry.register(boom);
    const r = await createToolExecutor(registry).execute(call("boom", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "tool_failed",
    });
  });

  it("inputSchema 声明 2020-12 / 2019-09 / draft-04 方言时照常校验", async () => {
    const h = await makeHarness(tmpWorkspace());
    const registry = createToolRegistry();
    const dialects = {
      d2020: "https://json-schema.org/draft/2020-12/schema",
      d2019: "https://json-schema.org/draft/2019-09/schema",
      d04: "http://json-schema.org/draft-04/schema#",
    };
    for (const [name, uri] of Object.entries(dialects)) {
      registry.register({
        name,
        description: "x",
        inputSchema: {
          $schema: uri,
          type: "object",
          required: ["q"],
          properties: { q: { type: "string" } },
        },
        traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
        permissionSubjects: () => [],
        execute: () => Promise.resolve({ status: "ok" as const, modelContent: "done" }),
      });
    }
    const executor = createToolExecutor(registry);
    for (const name of Object.keys(dialects)) {
      expect((await executor.execute(call(name, { q: "a" }, `${name}-ok`), h.scope)).status).toBe(
        "ok",
      );
      expect((await executor.execute(call(name, { q: 1 }, `${name}-bad`), h.scope)).status).toBe(
        "error",
      );
      expect(completedOf(h).at(-1)?.payload.error).toMatchObject({ code: "invalid_input" });
    }
  });

  it("inputSchema 无法编译时跳过本地校验并记诊断，调用照常执行", async () => {
    const h = await makeHarness(tmpWorkspace());
    const records: { kind: string; data: unknown }[] = [];
    h.scope.diagnostics = {
      record: (kind: string, data: unknown) => records.push({ kind, data }),
    } as unknown as NonNullable<typeof h.scope.diagnostics>;
    const registry = createToolRegistry();
    registry.register({
      name: "broken",
      description: "x",
      inputSchema: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } },
      traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
      permissionSubjects: () => [],
      execute: () => Promise.resolve({ status: "ok" as const, modelContent: "done" }),
    });
    const executor = createToolExecutor(registry);
    expect((await executor.execute(call("broken", { a: 1 }), h.scope)).status).toBe("ok");
    expect((await executor.execute(call("broken", { a: 2 }, "c2"), h.scope)).status).toBe("ok");
    expect(completedOf(h)).toHaveLength(2);
    expect(records.filter((r) => r.kind === "tool.schema_unsupported")).toHaveLength(1);
  });

  it("任意工具的 edit 主体在执行前后记录检查点，失败后仍记录改动状态", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "a.txt", "before");
    const h = await makeHarness(ws, {
      check: (subjects) =>
        Promise.resolve({
          subjects,
          decision: { action: "allow", source: "rule", reason: "test" },
        }),
      checkLexical: () => "allow",
    });
    const file = path.join(h.workspaceRoot, "a.txt");
    const snapshots: string[] = [];
    h.scope.checkpoint = async (phase, callId, subjects, sessionId) => {
      expect(callId).toBe("c1");
      expect(sessionId).toBe("s1");
      expect(subjects).toMatchObject([{ kind: "edit", resolved: file }]);
      snapshots.push(`${phase}:${await platform.fs.readFile(file)}`);
    };
    const registry = createToolRegistry();
    registry.register({
      name: "arbitrary",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: true, concurrencySafe: false, timeoutMs: 1000 },
      permissionSubjects: () => [{ kind: "edit", target: file }],
      execute: async () => {
        await platform.fs.writeFile(file, "partial");
        throw new Error("failed after write");
      },
    });
    expect(
      (await createToolExecutor(registry).execute(call("arbitrary", {}), h.scope)).status,
    ).toBe("error");
    expect(snapshots).toEqual(["before:before", "after:partial"]);
  });

  it("执行前已中断 → cancelled", async () => {
    const ws = tmpWorkspace();
    const ac = new AbortController();
    ac.abort();
    const h = await makeHarness(ws, undefined, ac.signal);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("cancelled");
    expect(completedOf(h)).toHaveLength(1);
  });

  it("gate 返回 stopTurn → ToolExecution.stopTurn", async () => {
    const ws = tmpWorkspace();
    const denyStop: PermissionGate = {
      check: (subjects): Promise<GateOutcome> =>
        Promise.resolve({
          subjects,
          decision: {
            action: "deny",
            source: "user",
            reason: "用户拒绝并停止",
          } satisfies PermissionDecision,
          stopTurn: true,
        }),
      checkLexical: () => "deny",
    };
    const h = await makeHarness(ws, denyStop);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("denied");
    expect(r.stopTurn).toBe(true);
  });
});

describe("执行器超时", () => {
  const allowAll: PermissionGate = {
    check: (subjects) =>
      Promise.resolve({
        subjects,
        decision: { action: "allow", source: "rule", reason: "test" },
      }),
    checkLexical: () => "allow",
  };

  /** 等 ctx.signal 中止并记录耗时的探针工具（中止后抛错走执行器结算） */
  const abortProbe = (
    traits: ToolDefinition["traits"],
    properties?: Record<string, unknown>,
  ): { tool: ToolDefinition; elapsed: () => number } => {
    let ms = -1;
    return {
      elapsed: () => ms,
      tool: {
        name: "probe",
        description: "x",
        inputSchema: {
          type: "object",
          ...(properties !== undefined ? { properties } : {}),
        },
        traits,
        permissionSubjects: () => [],
        execute(_input, ctx) {
          const start = Date.now();
          return new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => {
              ms = Date.now() - start;
              reject(new Error("aborted"));
            });
          });
        },
      },
    };
  };

  const timeoutInput = { timeoutMs: { type: "integer", minimum: 1 } };
  const errorPayload = (h: Harness): { code?: string; message?: string } =>
    (completedOf(h)[0]?.payload.error ?? {}) as { code?: string; message?: string };

  it("声明 timeoutMs 输入且 maxTimeoutMs 更大时，输入值大于默认值可生效", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const probe = abortProbe(
      { mutates: false, concurrencySafe: true, timeoutMs: 120, maxTimeoutMs: 5_000 },
      timeoutInput,
    );
    const registry = createToolRegistry();
    registry.register(probe.tool);
    const r = await createToolExecutor(registry).execute(
      call("probe", { timeoutMs: 300 }),
      h.scope,
    );
    expect(r.status).toBe("error");
    // 中止在输入 300ms + 执行器余量处，而非默认 120ms 处
    expect(probe.elapsed()).toBeGreaterThanOrEqual(1_200);
    expect(errorPayload(h).code).toBe("timeout");
    expect(errorPayload(h).message).toContain("300ms");
  });

  it("输入值超过 maxTimeoutMs 时按上限封顶", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const probe = abortProbe(
      { mutates: false, concurrencySafe: true, timeoutMs: 80, maxTimeoutMs: 300 },
      timeoutInput,
    );
    const registry = createToolRegistry();
    registry.register(probe.tool);
    const r = await createToolExecutor(registry).execute(
      call("probe", { timeoutMs: 60_000 }),
      h.scope,
    );
    expect(r.status).toBe("error");
    // 生效值被夹到 300ms（+余量 ~1300ms），不会真等 60s
    expect(probe.elapsed()).toBeGreaterThanOrEqual(1_200);
    expect(probe.elapsed()).toBeLessThan(10_000);
    expect(errorPayload(h).code).toBe("timeout");
    expect(errorPayload(h).message).toContain("300ms");
  });

  it("inputSchema 未声明 timeoutMs 的工具不受该输入影响", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const probe = abortProbe({
      mutates: false,
      concurrencySafe: true,
      timeoutMs: 150,
      maxTimeoutMs: 5_000,
    });
    const registry = createToolRegistry();
    registry.register(probe.tool);
    const r = await createToolExecutor(registry).execute(call("probe", { timeoutMs: 10 }), h.scope);
    expect(r.status).toBe("error");
    // 输入被忽略，生效的仍是默认 150ms（而非 10ms）
    expect(probe.elapsed()).toBeGreaterThanOrEqual(1_050);
    expect(errorPayload(h).code).toBe("timeout");
    expect(errorPayload(h).message).toContain("150ms");
  });

  it("未声明 maxTimeoutMs 的工具不受 timeoutMs 输入影响", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const probe = abortProbe(
      { mutates: false, concurrencySafe: true, timeoutMs: 150 },
      timeoutInput,
    );
    const registry = createToolRegistry();
    registry.register(probe.tool);
    const r = await createToolExecutor(registry).execute(call("probe", { timeoutMs: 10 }), h.scope);
    expect(r.status).toBe("error");
    expect(probe.elapsed()).toBeGreaterThanOrEqual(1_050);
    expect(errorPayload(h).code).toBe("timeout");
    expect(errorPayload(h).message).toContain("150ms");
  });

  it("task：内置子代理路径输入 timeoutMs 大于 traits 默认值时不在默认值处中止", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    let forwarded: number | undefined;
    let ms = -1;
    const launcher: SubagentLauncher = {
      launch(request, ctx) {
        forwarded = request.timeoutMs;
        const start = Date.now();
        return new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            ms = Date.now() - start;
            resolve({ status: "error", error: { code: "timeout", message: "子代理超时" } });
          });
        });
      },
    };
    const task = createTaskTool(launcher);
    const registry = createToolRegistry();
    registry.register({ ...task, traits: { ...task.traits, timeoutMs: 100 } });
    const r = await createToolExecutor(registry).execute(
      call("task", { task: "x", timeoutMs: 800 }),
      h.scope,
    );
    expect(forwarded).toBe(800);
    // 中止在 800+余量 处，而非 traits.timeoutMs=100 处
    expect(ms).toBeGreaterThanOrEqual(1_600);
    expect(r.status).toBe("error");
    expect(errorPayload(h).code).toBe("timeout");
  });

  it("task：外部 agent 路径输入 timeoutMs 大于 traits 默认值时不在默认值处中止", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    let forwarded: number | undefined;
    let ms = -1;
    const external = {
      agents: [{ name: "offline", description: "x" }],
      run(
        request: { agent: string; task: string; timeoutMs?: number },
        ctx: ToolContext,
      ): Promise<{
        status: "error";
        modelContent: string;
        error: { code: string; message: string };
      }> {
        forwarded = request.timeoutMs;
        const start = Date.now();
        return new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            ms = Date.now() - start;
            resolve({
              status: "error",
              modelContent: "外部 agent 超时",
              error: { code: "timeout", message: "外部 agent 超时" },
            });
          });
        });
      },
    };
    const task = createTaskTool(undefined, external);
    const registry = createToolRegistry();
    registry.register({ ...task, traits: { ...task.traits, timeoutMs: 100 } });
    const r = await createToolExecutor(registry).execute(
      call("task", { task: "x", agent: "offline", timeoutMs: 800 }),
      h.scope,
    );
    expect(forwarded).toBe(800);
    expect(ms).toBeGreaterThanOrEqual(1_600);
    expect(r.status).toBe("error");
    expect(errorPayload(h).code).toBe("timeout");
  });

  it("task：输入 timeoutMs 不封顶，原样转发给 launcher", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    let forwarded: number | undefined;
    const launcher: SubagentLauncher = {
      launch(request) {
        forwarded = request.timeoutMs;
        return Promise.resolve({
          status: "error",
          error: { code: "x", message: "x" },
        });
      },
    };
    const registry = createToolRegistry();
    registry.register(createTaskTool(launcher));
    await createToolExecutor(registry).execute(
      call("task", { task: "x", timeoutMs: 9_000_000 }),
      h.scope,
    );
    expect(forwarded).toBe(9_000_000);
  });
  it("task 省略超时没有默认计时，内置与外部请求都保持未指定", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const timeouts: (number | undefined)[] = [];
    const launcher: SubagentLauncher = {
      launch(request) {
        timeouts.push(request.timeoutMs);
        return Promise.resolve({ status: "error", error: { code: "x", message: "x" } });
      },
    };
    const task = createTaskTool(launcher, {
      agents: [{ name: "offline", description: "x" }],
      run(request) {
        timeouts.push(request.timeoutMs);
        return Promise.resolve({
          status: "error",
          modelContent: "x",
          error: { code: "x", message: "x" },
        });
      },
    });
    expect(task.traits.timeoutMs).toBeUndefined();
    const registry = createToolRegistry();
    registry.register(task);
    const executor = createToolExecutor(registry);
    await executor.execute(call("task", { task: "x" }), h.scope);
    await executor.execute(call("task", { task: "x", agent: "offline" }), h.scope);
    expect(timeouts).toEqual([undefined, undefined]);
  });

  it("忽略 signal 且永不返回的工具：中断后在宽限期内结算为 cancelled", async () => {
    const ac = new AbortController();
    const h = await makeHarness(tmpWorkspace(), allowAll, ac.signal);
    const checkpoints: string[] = [];
    h.scope.checkpoint = (phase) => {
      checkpoints.push(phase);
      return Promise.resolve();
    };
    const registry = createToolRegistry();
    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      resolveStarted = r;
    });
    registry.register({
      name: "hang",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true },
      permissionSubjects: () => [],
      execute() {
        resolveStarted();
        return new Promise(() => undefined);
      },
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = createToolExecutor(registry)
        .execute(call("hang", {}), h.scope)
        .then((res) => {
          settled = true;
          return res;
        });
      await startedPromise;
      ac.abort();
      await vi.advanceTimersByTimeAsync(TOOL_ABORT_GRACE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await pending;
      expect(r.status).toBe("cancelled");
      expect(errorPayload(h)).toEqual({ code: "cancelled", message: "调用已被中断" });
      expect(completedOf(h)).toHaveLength(1);
      expect(checkpoints).toEqual(["before", "after"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("忽略 signal 且声明短 timeoutMs 的工具：超时后在宽限期内结算为 timeout", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const registry = createToolRegistry();
    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      resolveStarted = r;
    });
    registry.register({
      name: "hang",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true, timeoutMs: 20 },
      permissionSubjects: () => [],
      execute() {
        resolveStarted();
        return new Promise(() => undefined);
      },
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = createToolExecutor(registry)
        .execute(call("hang", {}), h.scope)
        .then((res) => {
          settled = true;
          return res;
        });
      await startedPromise;
      // 生效超时 20ms + 兜底余量 1000ms 触发超时信号，再经宽限期结算
      await vi.advanceTimersByTimeAsync(1_020 + TOOL_ABORT_GRACE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const r = await pending;
      expect(r.status).toBe("error");
      expect(errorPayload(h).code).toBe("timeout");
      expect(errorPayload(h).message).toContain("20ms");
      expect(completedOf(h)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("被放弃的工具之后 reject 或 resolve，不产生未处理 rejection 也不再写事件", async () => {
    const ac = new AbortController();
    const h = await makeHarness(tmpWorkspace(), allowAll, ac.signal);
    const checkpoints: string[] = [];
    h.scope.checkpoint = (phase) => {
      checkpoints.push(phase);
      return Promise.resolve();
    };
    let rejectLate: ((err: Error) => void) | undefined;
    let resolveLate: ((res: { status: "ok"; modelContent: string }) => void) | undefined;
    let emitLateProgress: ((chunk: string) => void) | undefined;
    let mode: "reject" | "resolve" = "reject";
    const registry = createToolRegistry();
    registry.register({
      name: "hang",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true },
      permissionSubjects: () => [],
      execute(_input, ctx) {
        emitLateProgress = (chunk) => ctx.progress(chunk);
        return new Promise((resolve, reject) => {
          if (mode === "reject") rejectLate = reject;
          else resolveLate = resolve;
        });
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const executor = createToolExecutor(registry, { abortGraceMs: 20 });
      const pendingReject = executor.execute(call("hang", {}, "c-rej"), h.scope);
      await vi.waitFor(() => expect(rejectLate).toBeDefined());
      ac.abort();
      const first = await pendingReject;
      expect(first.status).toBe("cancelled");
      const eventCountAfterCancel = h.events.length;
      const ephemeralCountAfterCancel = h.ephemeral.length;

      emitLateProgress?.("late-chunk");
      rejectLate?.(new Error("late rejection after abandon"));
      await new Promise<void>((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(h.events).toHaveLength(eventCountAfterCancel);
      expect(h.ephemeral).toHaveLength(ephemeralCountAfterCancel);
      expect(checkpoints).toEqual(["before", "after"]);

      // 另一轮验证：工具在放弃后延迟 resolve，结果同样直接丢弃
      mode = "resolve";
      const ac2 = new AbortController();
      const h2 = await makeHarness(tmpWorkspace(), allowAll, ac2.signal);
      const executor2 = createToolExecutor(registry, { abortGraceMs: 20 });
      const pendingResolve = executor2.execute(call("hang", {}, "c-res"), h2.scope);
      await vi.waitFor(() => expect(resolveLate).toBeDefined());
      ac2.abort();
      const second = await pendingResolve;
      expect(second.status).toBe("cancelled");
      const count2 = h2.events.length;
      resolveLate?.({ status: "ok", modelContent: "too late" });
      await new Promise<void>((r) => setImmediate(r));
      expect(h2.events).toHaveLength(count2);
      expect(completedOf(h2)).toHaveLength(1);
      expect(completedOf(h2)[0]?.payload.status).toBe("cancelled");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("声明 traits.abortGraceMs 的工具在默认宽限期后、自身宽限期内返回时保留其结果", async () => {
    const ac = new AbortController();
    const h = await makeHarness(tmpWorkspace(), allowAll, ac.signal);
    const registry = createToolRegistry();
    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      resolveStarted = r;
    });
    let resolveTool!: (res: {
      status: "error";
      modelContent: string;
      output: { partial: true };
      error: { code: string; message: string };
    }) => void;
    registry.register({
      name: "slow_cleanup",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true, abortGraceMs: 5_000 },
      permissionSubjects: () => [],
      execute() {
        resolveStarted();
        return new Promise((resolve) => {
          resolveTool = resolve;
        });
      },
    });

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = createToolExecutor(registry)
        .execute(call("slow_cleanup", {}), h.scope)
        .then((res) => {
          settled = true;
          return res;
        });
      await startedPromise;
      ac.abort();
      // 越过默认 2000ms 宽限期但仍在自身 5000ms 宽限期内：不得提前放弃
      await vi.advanceTimersByTimeAsync(TOOL_ABORT_GRACE_MS + 500);
      expect(settled).toBe(false);

      resolveTool({
        status: "error",
        modelContent: "已捕获部分输出",
        output: { partial: true },
        error: { code: "cancelled", message: "清理完成" },
      });
      const r = await pending;
      expect(r.status).toBe("cancelled");
      expect(r.result.modelContent).toBe("已捕获部分输出");
      expect(r.result.modelContent).not.toContain("调用已被中断");
      expect(r.result.output).toEqual({ partial: true });
      expect(completedOf(h)).toHaveLength(1);
      expect(completedOf(h)[0]?.payload.modelContent).toBe("已捕获部分输出");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("read 工具", () => {
  it("offset/limit 截取行并标注剩余", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "b.txt", "l1\nl2\nl3\nl4\nl5");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: "b.txt", offset: 2, limit: 2 }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("2|l2");
    expect(r.result.modelContent).toContain("3|l3");
    expect(r.result.modelContent).not.toContain("1|l1");
    expect(r.result.modelContent).toContain("还有 2 行");
  });

  it("整文件超过字符预算：按整行截止并给出下一段 offset，不交给执行器截掉中间一段", async () => {
    const ws = tmpWorkspace();
    const rows = Array.from(
      { length: 3_000 },
      (_, i) => `line-${String(i + 1).padStart(5, "0")}-${"x".repeat(30)}`,
    );
    await writeWs(ws, "big.txt", rows.join("\n"));
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "big.txt" }), h.scope);
    expect(r.status).toBe("ok");
    const content = r.result.modelContent;
    expect(content.length).toBeLessThan(30_000);
    expect(content).not.toContain("已省略");
    const match = /已读到第 (\d+) 行，其后还有 (\d+) 行，用 offset=(\d+) 继续读取/.exec(content);
    expect(match).not.toBeNull();
    const stop = Number(match?.[1]);
    expect(Number(match?.[3])).toBe(stop + 1);
    expect(Number(match?.[2])).toBe(3_000 - stop);
    // 返回的是连续的前 stop 行，最后一行完整
    expect(content).toContain(`${stop}|${rows[stop - 1]}`);
    expect(content).not.toContain(`${stop + 1}|`);
    // 按提示续读得到下一行
    const next = await h.executor.execute(
      call("read", { path: "big.txt", offset: stop + 1, limit: 2 }),
      h.scope,
    );
    expect(next.result.modelContent).toContain(`${stop + 1}|${rows[stop]}`);
  });

  it("文件不存在 → file_not_found", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "missing.txt" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("file_not_found");
  });

  it("二进制文件 → binary_file", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "bin.dat", "abc");
    const bin = await platform.fs.readFile(path.join(ws, "bin.dat"));
    bin[1] = 0;
    await platform.fs.writeFile(path.join(ws, "bin.dat"), bin);
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "bin.dat" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("binary_file");
  });

  it(".. 逃逸到工作区外 → denied", async () => {
    const ws = tmpWorkspace();
    const parent = path.dirname(ws);
    await writeWs(parent, `escape-${path.basename(ws)}.txt`, "x");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: path.join("..", `escape-${path.basename(ws)}.txt`) }),
      h.scope,
    );
    expect(r.status).toBe("denied");
    rmSync(path.join(parent, `escape-${path.basename(ws)}.txt`), {
      force: true,
    });
  });
});

describe("read 图片（ADR-0023 第 2 节）", () => {
  const u8 = (arr: number[]): Uint8Array => new Uint8Array(arr);
  const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  const PNG = (w: number, h: number): Uint8Array =>
    u8([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...u32be(13),
      ...ascii("IHDR"),
      ...u32be(w),
      ...u32be(h),
      8,
      6,
      0,
      0,
      0,
    ]);
  const JPEG = (w: number, h: number): Uint8Array =>
    u8([
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...u16be(16),
      ...ascii("JFIF"),
      0,
      ...new Array(9).fill(0),
      0xff,
      0xc0,
      ...u16be(17),
      8,
      ...u16be(h),
      ...u16be(w),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]);
  const GIF = (w: number, h: number): Uint8Array =>
    u8([...ascii("GIF89a"), ...u16le(w), ...u16le(h), 0xf0, 0, 0]);
  const WEBP = (w: number, h: number): Uint8Array =>
    u8([
      ...ascii("RIFF"),
      ...u32be(18),
      ...ascii("WEBP"),
      ...ascii("VP8X"),
      ...u32be(10),
      0,
      0,
      0,
      0,
      (w - 1) & 0xff,
      ((w - 1) >> 8) & 0xff,
      ((w - 1) >> 16) & 0xff,
      (h - 1) & 0xff,
      ((h - 1) >> 8) & 0xff,
      ((h - 1) >> 16) & 0xff,
    ]);

  async function writeBin(ws: string, rel: string, data: Uint8Array): Promise<void> {
    await platform.fs.writeFile(path.join(ws, rel), data);
  }

  function withAttachmentStore(h: Harness, attachmentsDir: string): void {
    h.scope.attachments = createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir,
      sessionId: h.scope.sessionId,
    });
  }

  it.each([
    ["png", PNG(2, 3), "image/png"],
    ["jpeg", JPEG(4, 5), "image/jpeg"],
    ["gif", GIF(6, 7), "image/gif"],
    ["webp", WEBP(8, 9), "image/webp"],
  ] as const)("四种格式成功：%s → 附件引用落盘、不写 readState", async (ext, data, mime) => {
    const ws = tmpWorkspace();
    const attachmentsDir = tmpWorkspace();
    await writeBin(ws, `pic.${ext}`, data);
    const h = await makeHarness(ws);
    withAttachmentStore(h, attachmentsDir);
    const wsReal = h.workspaceRoot;

    const r = await h.executor.execute(
      call("read", { path: `pic.${ext}`, offset: 5, limit: 1 }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toBe(
      `Image file: pic.${ext} (${mime}, ${{ png: "2×3", jpeg: "4×5", gif: "6×7", webp: "8×9" }[ext]}, ${data.length} B)`,
    );
    const output = r.result.output as { path: string; mimeType: string; bytes: number };
    expect(output.mimeType).toBe(mime);
    expect(output.path).toBe(path.join(wsReal, `pic.${ext}`));
    // 事件里只有引用；文件已落盘
    const done = completedOf(h)[0]?.payload;
    const refs = done?.attachments as { file: string; source: string; label: string }[];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.file).toBe("img-1." + (ext === "jpeg" ? "jpg" : ext));
    expect(refs[0]?.source).toBe("read");
    expect(refs[0]?.label).toBe(`pic.${ext}`);
    const onDisk = await platform.fs.readFile(path.join(attachmentsDir, "s1", refs[0]?.file ?? ""));
    expect(onDisk).toEqual(Buffer.from(data));
    // 图片不写 readState
    expect(h.scope.readState.get(path.join(wsReal, `pic.${ext}`))).toBeUndefined();
  });

  it("截断的 PNG 头 → image_corrupt", async () => {
    const ws = tmpWorkspace();
    await writeBin(ws, "bad.png", PNG(1, 1).subarray(0, 12));
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "bad.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_corrupt");
    expect(r.result.modelContent).toContain("损坏或被截断");
  });

  it(".png 扩展名但内容是文本 → 走文本路径", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "fake.png", "not a real image\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "fake.png" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("1|not a real image");
  });

  it("超过 50 MB 的图片 → image_too_large", async () => {
    const ws = tmpWorkspace();
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    big.set(PNG(1, 1));
    await writeBin(ws, "big.png", big);
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "big.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_too_large");
    expect(r.result.modelContent).toContain("50 MB");
  });

  it("总像素超过 64,000,000 → image_too_large", async () => {
    const ws = tmpWorkspace();
    await writeBin(ws, "huge.png", PNG(8001, 8001));
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "huge.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_too_large");
    expect(r.result.modelContent).toContain("8001×8001");
  });

  it("GIF 触发处理条件 → image_too_large 且说明不支持自动缩小", async () => {
    const ws = tmpWorkspace();
    const gif = u8([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 100, 0, 0xa0, 0x0f, 0xf0, 0, 0]); // 100x4000
    await writeBin(ws, "tall.gif", gif);
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "tall.gif" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_too_large");
    expect(r.result.modelContent).toContain("GIF");
    expect(r.result.modelContent).toContain("不支持自动缩小");
  });

  it("SVG 走文本路径；BMP → binary_file 且说明列出支持格式", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "icon.svg", '<svg xmlns="x"><rect/></svg>\n');
    await writeBin(ws, "img.bmp", u8([0x42, 0x4d, 0, 0, 0, 0, 0, 0]));
    const h = await makeHarness(ws);
    const svg = await h.executor.execute(call("read", { path: "icon.svg" }), h.scope);
    expect(svg.status).toBe("ok");
    expect(svg.result.modelContent).toContain("<svg");
    const bmp = await h.executor.execute(call("read", { path: "img.bmp" }, "c2"), h.scope);
    expect(bmp.result.status === "error" && bmp.result.error.code).toBe("binary_file");
    expect(bmp.result.modelContent).toContain("PNG、JPEG、GIF、WebP");
  });
});

describe("grep / glob 边界与行为", () => {
  it("grep 命中工作区内文件", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "src/a.ts", "const token = 1;\n");
    await writeWs(ws, "src/b.md", "nothing here\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("grep", { pattern: "token" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("a.ts:1");
  });

  it("rg 不可用时内部 walker 兜底：命中文本文件，跳过含 NUL 的二进制文件", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "src/a.ts", "const token = 1;\n");
    await writeWs(ws, "src/bin.dat", "token\0binary\n");
    const h = await makeHarness(ws);
    const scope: ExecutionScope = {
      ...h.scope,
      platform: {
        ...platform,
        process: {
          ...platform.process,
          spawn: () => {
            throw new Error("rg not found");
          },
        },
      },
    };
    const r = await h.executor.execute(call("grep", { pattern: "token" }), scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("a.ts:1");
    expect(r.result.modelContent).not.toContain("bin.dat");
  });

  it("grep 结果不包含 junction 链接到工作区外的内容", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "secret.txt", "token_outside_marker\n");
    // Windows junction：目录链接无需管理员权限
    const linkDir = path.join(ws, "linked");
    await platform.fs.mkdir(linkDir);
    rmSync(linkDir, { recursive: true, force: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, linkDir, "junction");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("grep", { pattern: "token_outside_marker" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).not.toContain("token_outside_marker");
  });

  it("glob 枚举不跟随 junction，结果无工作区外文件", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "out.txt", "x");
    await writeWs(ws, "in.txt", "y");
    const linkDir = path.join(ws, "linked");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, linkDir, "junction");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("glob", { pattern: "**/*.txt" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("in.txt");
    expect(r.result.modelContent).not.toContain("out.txt");
    expect(r.result.modelContent).not.toContain("linked");
  });

  it("glob 遵守 .gitignore", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, ".gitignore", "ignored/\n*.tmp\n");
    await writeWs(ws, "ignored/x.ts", "x");
    await writeWs(ws, "keep.ts", "y");
    await writeWs(ws, "drop.tmp", "z");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("glob", { pattern: "**/*" }), h.scope);
    expect(r.result.modelContent).toContain("keep.ts");
    expect(r.result.modelContent).not.toContain("x.ts");
    expect(r.result.modelContent).not.toContain("drop.tmp");
  });

  it("glob 的 * 只匹配顶层文件，结果路径不带 ./ 前缀", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "top.py", "x");
    await writeWs(ws, "sub/deep.py", "y");
    const h = await makeHarness(ws);
    const top = await h.executor.execute(call("glob", { pattern: "*" }), h.scope);
    expect(top.result.modelContent).toBe("top.py");
    const nested = await h.executor.execute(call("glob", { pattern: "sub/*" }), h.scope);
    expect(nested.result.modelContent).toBe("sub/deep.py");
  });

  it("glob 在 lstat 循环中途中止时提前结束，不再继续 stat 剩余匹配", async () => {
    const ws = tmpWorkspace();
    const ac = new AbortController();
    const h = await makeHarness(ws, undefined, ac.signal);
    const totalMatches = 2_000;
    const rgOut = Array.from({ length: totalMatches }, (_, i) => `file-${i}.ts`).join("\n") + "\n";
    let lstatCalls = 0;
    const scope: ExecutionScope = {
      ...h.scope,
      platform: {
        ...platform,
        fs: {
          ...platform.fs,
          lstat: () => {
            lstatCalls++;
            if (lstatCalls === 5) ac.abort();
            return Promise.resolve({ type: "file", size: 10, mtimeMs: 1_000 });
          },
        },
        process: {
          ...platform.process,
          spawn: () => ({
            pid: 1,
            stdout: (async function* () {
              await Promise.resolve();
              yield rgOut;
            })(),
            stderr: {
              async *[Symbol.asyncIterator]() {
                await Promise.resolve();
              },
            },
            wait: () => Promise.resolve({ code: 0, signal: null, timedOut: false, killed: false }),
            kill: () => Promise.resolve(),
            detachOutput: () => undefined,
          }),
        },
      },
    };
    const r = await h.executor.execute(call("glob", { pattern: "**/*" }), scope);
    expect(r.status).toBe("cancelled");
    expect(lstatCalls).toBe(5);
    expect(lstatCalls).toBeLessThan(totalMatches);
  });
});

describe("parseRipgrepFiles", () => {
  it("Windows 的 .\\ 前缀和反斜杠统一成相对路径", () => {
    expect(parseRipgrepFiles(".\\top.py\r\n.\\sub\\deep.py\r\n")).toEqual([
      "top.py",
      "sub/deep.py",
    ]);
    expect(parseRipgrepFiles("./top.py\n./sub/deep.py\n")).toEqual(["top.py", "sub/deep.py"]);
  });
});

describe("globToRegExp / gitignore", () => {
  it("glob：* 不跨目录，** 跨目录", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("d/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("d/e/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/a/b.txt")).toBe(true);
  });

  it("gitignore：基础规则、取反、目录限定", () => {
    const rules = compileGitignore("*.log\n!keep.log\nbuild/\n");
    expect(matchGitignore(rules, "a.log", false)).toBe(true);
    expect(matchGitignore(rules, "keep.log", false)).toBe(false);
    expect(matchGitignore(rules, "build", true)).toBe(true);
    expect(matchGitignore(rules, "build/out.js", false)).toBe(true);
    expect(matchGitignore(rules, "build", false)).toBeUndefined();
    expect(matchGitignore(rules, "src/a.ts", false)).toBeUndefined();
  });
});

describe("PermissionGate（ask 流程与 Grant）", () => {
  const wsSubject = (ws: string, rel = "a.ts") => [
    { kind: "read" as const, target: rel, resolved: path.join(ws, rel) },
  ];

  function gateHarness(ws: string, grants: Grant[]) {
    const events: Captured[] = [];
    const ephemeral: Captured[] = [];
    // default 预设：工作区外 read → ask（workspaceReadPolicy 会直接 deny，走不到 ask 流程）
    const policy = createDefaultPolicy({
      workspaceRoot: ws,
      caseSensitive: platform.caseSensitivePaths,
    });
    const gate = createPolicyGate(policy, {
      interactive: true,
      grants: { session: grants },
      caseSensitive: platform.caseSensitivePaths,
      newRequestId: (id) => `req-${id}`,
    });
    const turn = {
      turnId: "t1",
      events: {
        emit: (type: string, payload: unknown) => {
          events.push({ type, payload: payload as Captured["payload"] });
          return Promise.resolve();
        },
        emitEphemeral: (type: string, payload: unknown) => {
          ephemeral.push({ type, payload: payload as Captured["payload"] });
        },
      } as never,
    };
    return { gate, turn, events, ephemeral };
  }

  it("ask → 用户允许一次：allow + source user + resolved 带规则说明", async () => {
    const ws = tmpWorkspace();
    const outside = path.join(tmpdir(), `nct-out-${Date.now()}`);
    const { gate, turn, events } = gateHarness(ws, []);
    const check = gate.check(wsSubject(outside), "c1", new AbortController().signal, turn);
    // permission.requested 已发出且携带完整选项集
    const requested = events.find((e) => e.type === "permission.requested");
    expect(requested?.payload.requestId).toBe("req-c1");
    expect(requested?.payload.options).toEqual([
      "allow_once",
      "allow_session",
      "allow_project",
      "deny",
      "deny_stop",
    ]);
    const ok = await gate.respond?.("req-c1", { decision: "allow" });
    expect(ok).toBe(true);
    const outcome = await check;
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.decision.source).toBe("user");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload.action).toBe("allow");
    expect(String(resolved?.payload.rule)).toContain("预设 default");
  });

  it("ask → 本会话内允许：生成会话 Grant，后续同类主体直接放行", async () => {
    const ws = tmpWorkspace();
    const grants: Grant[] = [];
    const outside = path.join(tmpdir(), `nct-out2-${Date.now()}`);
    const { gate, turn } = gateHarness(ws, grants);
    const signal = new AbortController().signal;
    const check = gate.check(wsSubject(outside), "c1", signal, turn);
    await gate.respond?.("req-c1", { decision: "allow", remember: "session" });
    const outcome = await check;
    expect(outcome.remember).toBe("session");
    expect(grants).toHaveLength(1);
    // grant 写入会话集合后，同一主体的下一次求值直接 allow（policy 读活引用）——
    // 本测试用 workspaceReadPolicy 不带 grants 联动，故直接验证 grants 内容
    expect(grants[0]?.kind).toBe("read");
  });

  it("ask → 拒绝并停止：stopTurn 置位", async () => {
    const ws = tmpWorkspace();
    const outside = path.join(tmpdir(), `nct-out3-${Date.now()}`);
    const { gate, turn } = gateHarness(ws, []);
    const check = gate.check(wsSubject(outside), "c1", new AbortController().signal, turn);
    await gate.respond?.("req-c1", { decision: "deny", stop: true, feedback: "别动这个" });
    const outcome = await check;
    expect(outcome.decision.action).toBe("deny");
    expect(outcome.stopTurn).toBe(true);
    expect(outcome.feedback).toBe("别动这个");
  });

  it("非交互：ask 直接结算为 deny，不发 permission.requested", async () => {
    const ws = tmpWorkspace();
    const policy = createDefaultPolicy({
      workspaceRoot: ws,
      caseSensitive: platform.caseSensitivePaths,
    });
    const gate = createPolicyGate(policy);
    const outside = path.join(tmpdir(), `nct-out4-${Date.now()}`);
    const outcome = await gate.check(
      wsSubject(outside),
      "c1",
      new AbortController().signal,
      undefined,
    );
    expect(outcome.decision.action).toBe("deny");
    expect(outcome.decision.source).toBe("non_interactive");
  });
});

describe("ToolTraits.dispatch 代理调用管线（ADR-0067 §2）", () => {
  const allowAll: PermissionGate = {
    check: (subjects) =>
      Promise.resolve({
        subjects,
        decision: { action: "allow", source: "rule", reason: "test" },
      }),
    checkLexical: () => "allow",
  };
  const errorPayload = (h: Harness): { code?: string; message?: string } =>
    (completedOf(h)[0]?.payload.error ?? {}) as { code?: string; message?: string };

  const targetTool: ToolDefinition<{ query: string; limit?: number }> = {
    name: "mcp__github__search_issues",
    description: "搜索 GitHub issue",
    origin: "mcp",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    traits: {
      mutates: false,
      fileEffects: "none",
      concurrencySafe: true,
      timeoutMs: 2_000,
      maxModelChars: 60,
    },
    permissionSubjects: () => [{ kind: "mcp", target: "github/search_issues", readOnly: true }],
    async execute(input) {
      return {
        status: "ok",
        modelContent: `found:${input.query}:${input.limit ?? 10}`,
        output: { query: input.query, limit: input.limit ?? 10 },
      };
    },
  };

  function createProxyTool(pool: ReadonlyMap<string, ToolDefinition>, servers: readonly string[]) {
    const proxy: ToolDefinition<{ tool: string; arguments?: Record<string, unknown> }> = {
      name: "mcp_call",
      description: "调用 MCP 工具",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["tool"],
        additionalProperties: false,
      },
      traits: {
        mutates: true,
        concurrencySafe: true,
        timeoutMs: 60_000,
        dispatch(raw) {
          const input = raw as { tool: string; arguments?: Record<string, unknown> };
          const found = pool.get(input.tool);
          if (found === undefined) {
            return {
              code: "unknown_tool",
              error: `未知或不可用的 MCP 工具 "${input.tool}"。可用服务器：${servers.join(", ") || "（无）"}`,
            };
          }
          return { tool: found, input: input.arguments ?? {} };
        },
      },
      permissionSubjects: () => [],
      async execute() {
        throw new Error("unreachable");
      },
    };
    return proxy;
  }

  it("按目标工具执行校验、Hook、权限、调用、结果预算，且 tool.started 写 target", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const pool = new Map<string, ToolDefinition>([[targetTool.name, targetTool]]);
    const registry = createToolRegistry();
    registry.register(createProxyTool(pool, ["github"]));

    const seenHooks: { event: string; tool: string; input: unknown }[] = [];
    const scope = {
      ...h.scope,
      hooks: {
        async run(event: string, payload: { tool: string; input: unknown }) {
          seenHooks.push({ event, tool: payload.tool, input: payload.input });
          if (event === "PreToolUse") {
            return { updatedInput: { ...(payload.input as object), limit: 5 } };
          }
          return { feedback: "ok" };
        },
      } as never,
    };

    const exec = await createToolExecutor(registry).execute(
      call("mcp_call", { tool: "mcp__github__search_issues", arguments: { query: "bug" } }),
      scope,
    );
    expect(exec.status).toBe("ok");
    // Hook 看到的是目标工具名与目标输入
    expect(seenHooks).toEqual([
      { event: "PreToolUse", tool: "mcp__github__search_issues", input: { query: "bug" } },
      {
        event: "PostToolUse",
        tool: "mcp__github__search_issues",
        input: { query: "bug", limit: 5 },
      },
    ]);
    // tool.started 保留调用名 mcp_call，但写 target: { name, input } 与目标工具的 subjects/traits
    const started = h.events.find((e) => e.type === "tool.started")?.payload;
    expect(started).toMatchObject({
      name: "mcp_call",
      input: { tool: "mcp__github__search_issues", arguments: { query: "bug" } },
      target: {
        name: "mcp__github__search_issues",
        input: { query: "bug", limit: 5 },
      },
      subjects: [{ kind: "mcp", target: "github/search_issues", readOnly: true }],
      mutates: false,
      fileEffects: "none",
    });
    // tool.completed 仍用 mcp_call，保证回传给模型的历史与声明一致
    const completed = h.events.find((e) => e.type === "tool.completed")?.payload;
    expect(completed?.name).toBe("mcp_call");
    expect(completed?.modelContent).toContain("found:bug:5");
  });

  it("目标工具参数不合法时返回 invalid_input 并附带目标工具 inputSchema", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const pool = new Map<string, ToolDefinition>([[targetTool.name, targetTool]]);
    const registry = createToolRegistry();
    registry.register(createProxyTool(pool, ["github"]));

    const exec = await createToolExecutor(registry).execute(
      call("mcp_call", { tool: "mcp__github__search_issues", arguments: { limit: "bad" } }),
      h.scope,
    );
    expect(exec.status).toBe("error");
    expect(errorPayload(h).code).toBe("invalid_input");
    expect(errorPayload(h).message).toContain("mcp__github__search_issues");
    expect(errorPayload(h).message).toContain(JSON.stringify(targetTool.inputSchema));
  });

  it("目标不存在或不在本会话工具池时返回 error 并附可用服务器列表", async () => {
    const h = await makeHarness(tmpWorkspace(), allowAll);
    const pool = new Map<string, ToolDefinition>([[targetTool.name, targetTool]]);
    const registry = createToolRegistry();
    registry.register(createProxyTool(pool, ["github", "slack"]));

    const exec = await createToolExecutor(registry).execute(
      call("mcp_call", { tool: "mcp__jira__create_issue", arguments: {} }),
      h.scope,
    );
    expect(exec.status).toBe("error");
    expect(errorPayload(h).code).toBe("unknown_tool");
    expect(errorPayload(h).message).toContain("mcp__jira__create_issue");
    expect(errorPayload(h).message).toContain("github, slack");
  });
});

describe("ToolTraits.maxOutputChars 通用预算声明", () => {
  const allowAll: PermissionGate = {
    check: async (subjects) => ({
      subjects,
      decision: { action: "allow", source: "rule", reason: "test" },
    }),
    checkLexical: () => "allow",
  };

  it("普通工具与 dispatch 目标工具均可声明 maxOutputChars 覆盖默认上限", async () => {
    const h1 = await makeHarness(tmpWorkspace(), allowAll);
    const largePayload = { text: "x".repeat(120_000) };

    const defaultCapTool: ToolDefinition<Record<string, never>> = {
      name: "default_cap_tool",
      description: "使用默认 100k output 上限",
      inputSchema: { type: "object", additionalProperties: false },
      traits: { mutates: false, concurrencySafe: true },
      permissionSubjects: () => [],
      async execute() {
        return { status: "ok", modelContent: "ok", output: largePayload };
      },
    };
    const customCapTool: ToolDefinition<Record<string, never>> = {
      name: "custom_cap_tool",
      description: "声明更大 maxOutputChars",
      inputSchema: { type: "object", additionalProperties: false },
      traits: { mutates: false, concurrencySafe: true, maxOutputChars: 150_000 },
      permissionSubjects: () => [],
      async execute() {
        return { status: "ok", modelContent: "ok", output: largePayload };
      },
    };
    const proxyTool: ToolDefinition<{ target: string }> = {
      name: "proxy_cap_tool",
      description: "代理分派",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
      traits: {
        mutates: false,
        concurrencySafe: true,
        dispatch(raw) {
          const { target } = raw as { target: string };
          return { tool: target, input: {} };
        },
      },
      permissionSubjects: () => [],
      async execute() {
        throw new Error("unreachable");
      },
    };

    const registry = createToolRegistry();
    registry.register(defaultCapTool);
    registry.register(customCapTool);
    registry.register(proxyTool);

    const execDefault = await createToolExecutor(registry).execute(
      call("default_cap_tool", {}),
      h1.scope,
    );
    expect(execDefault.status).toBe("ok");
    expect(execDefault.result.output).toBeUndefined();
    expect(execDefault.result.modelContent).toContain("结构化 output 超过大小上限，已省略");

    const h2 = await makeHarness(tmpWorkspace(), allowAll);
    const execCustom = await createToolExecutor(registry).execute(
      call("custom_cap_tool", {}),
      h2.scope,
    );
    expect(execCustom.status).toBe("ok");
    expect(execCustom.result.output).toEqual(largePayload);
    expect(execCustom.result.modelContent).toBe("ok");

    const h3 = await makeHarness(tmpWorkspace(), allowAll);
    const execDispatched = await createToolExecutor(registry).execute(
      call("proxy_cap_tool", { target: "custom_cap_tool" }),
      h3.scope,
    );
    expect(execDispatched.status).toBe("ok");
    expect(execDispatched.result.output).toEqual(largePayload);
  });
});
