import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceReadPolicy } from "../permission/index.js";
import { createPlatform, type Platform } from "../platform/index.js";
import type { ToolCallRef } from "../protocol/index.js";
import {
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  type ExecutionScope,
  type ToolDefinition,
} from "./index.js";
import { SPILL_LIMIT_BYTES, writeSpill } from "./spill.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

const bigTool: ToolDefinition = {
  name: "bigout",
  description: "returns a huge modelContent",
  inputSchema: { type: "object", properties: { size: { type: "number" } } },
  traits: { mutates: false, concurrencySafe: true, timeoutMs: 5_000 },
  permissionSubjects: () => [],
  execute: (input) =>
    Promise.resolve({
      status: "ok",
      modelContent: "Z".repeat((input as { size: number }).size),
    }),
};

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

async function makeScope(
  ws: string,
  attachmentsDir?: string,
): Promise<{
  scope: ExecutionScope;
  events: Captured[];
}> {
  const workspaceRoot = await platform.resolveReal(ws);
  const policy = createWorkspaceReadPolicy({
    workspaceRoot,
    caseSensitive: platform.caseSensitivePaths,
  });
  const events: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "sess-1",
    turnId: "turn-1",
    signal: new AbortController().signal,
    platform,
    gate: createPolicyGate(policy),
    readState: createReadStateStore(platform.paths),
    events: {
      emit: (type, payload) => {
        events.push({ type, payload: payload as unknown as Captured["payload"] });
        return Promise.resolve();
      },
      emitEphemeral: () => undefined,
    },
    attachmentsDir,
  };
  return { scope, events };
}

const registry = () => {
  const r = createToolRegistry();
  r.register(bigTool);
  return r;
};

const call = (input: unknown, callId = "c1"): ToolCallRef => ({
  callId,
  name: "bigout",
  input,
});

describe("输出落盘（tools.md 第 4 节）", () => {
  it("超预算输出写入 <attachmentsDir>/<sessionId>/<callId>.txt，事件带 spillPath", async () => {
    const ws = tmpDir("nct-spill-ws-");
    const attachmentsDir = tmpDir("nct-spill-att-");
    const { scope, events } = await makeScope(ws, attachmentsDir);
    const executor = createToolExecutor(registry());

    const r = await executor.execute(call({ size: 50_000 }, "call-9"), scope);
    expect(r.status).toBe("ok");

    const done = events.find((e) => e.type === "tool.completed");
    expect(done?.payload.truncated).toBe(true);
    const spillPath = done?.payload.spillPath;
    expect(typeof spillPath).toBe("string");
    expect(spillPath).toBe(path.join(attachmentsDir, "sess-1", "call-9.txt"));
    // 落盘内容是未截断的完整输出
    const content = readFileSync(spillPath as string, "utf8");
    expect(content).toBe("Z".repeat(50_000));
    // modelContent 保留截断预览并标注落盘路径
    expect(done?.payload.modelContent).toContain("已省略");
    expect(done?.payload.modelContent).toContain(spillPath as string);
  });

  it("attachmentsDir 缺省：降级为普通截断，明确说明未落盘", async () => {
    const ws = tmpDir("nct-spill-ws-");
    const { scope, events } = await makeScope(ws);
    const executor = createToolExecutor(registry());

    await executor.execute(call({ size: 50_000 }), scope);
    const done = events.find((e) => e.type === "tool.completed");
    expect(done?.payload.truncated).toBe(true);
    expect(done?.payload.spillPath).toBeUndefined();
    expect(done?.payload.modelContent).toContain("未保留");
  });

  it("落盘写失败：降级为普通截断且不携带 spillPath", async () => {
    const ws = tmpDir("nct-spill-ws-");
    const { scope, events } = await makeScope(ws);
    // 让平台 fs 写失败：用一个只在 writeFile 上抛错的包装
    const failingFs = {
      ...platform.fs,
      writeFile: () => Promise.reject(new Error("disk full")),
    };
    const failingScope: ExecutionScope = {
      ...scope,
      attachmentsDir: tmpDir("nct-spill-att-"),
      platform: { ...platform, fs: failingFs },
    };
    const executor = createToolExecutor(registry());
    await executor.execute(call({ size: 50_000 }), failingScope);
    const done = events.find((e) => e.type === "tool.completed");
    expect(done?.payload.truncated).toBe(true);
    expect(done?.payload.spillPath).toBeUndefined();
    expect(done?.payload.modelContent).toContain("未保留");
  });

  it("writeSpill 超过 1 MB 时只写头部并注明截断", async () => {
    const attachmentsDir = tmpDir("nct-spill-cap-");
    const content = "A".repeat(SPILL_LIMIT_BYTES + 100_000);
    const p = await writeSpill({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir,
      sessionId: "s",
      callId: "c",
      content,
    });
    const size = statSync(p).size;
    expect(size).toBeLessThanOrEqual(SPILL_LIMIT_BYTES);
    const text = readFileSync(p, "utf8");
    expect(text.startsWith("A".repeat(100))).toBe(true);
    expect(text).toContain("超过 1 MB 落盘上限");
  });
});
