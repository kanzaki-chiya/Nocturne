/** 诊断通道测试（observability.md）：脱敏、截断、文件输出、no-op、降级 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDiagnostics } from "../src/diagnostics/index.js";
import { createPlatform, type Platform } from "../src/platform/index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-diag-"));
  tmpRoots.push(dir);
  return dir;
}

/** 等待追加队列清空（record 同步返回，写盘异步排队） */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
}

describe("diagnostics", () => {
  it("未启用时 no-op：不产生文件", async () => {
    const ws = tmp();
    const d = createDiagnostics({ platform, enabled: false, logsDir: ws });
    d.record("tool.exec", { callId: "c1" });
    await flush();
    const files = await platform.fs.readdir(ws).catch(() => []);
    expect(files.filter((f) => f.name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("写 JSONL 文件：kind/time/data 齐全", async () => {
    const ws = tmp();
    const file = path.join(ws, "dbg.jsonl");
    const d = createDiagnostics({ platform, enabled: true, file, logsDir: ws });
    d.record("tool.exec", { callId: "c1", durationMs: 12 });
    d.record("provider.result", { finishReason: "stop" });
    await flush();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(a.kind).toBe("tool.exec");
    expect(a.time).toBeTruthy();
    expect(a.callId).toBe("c1");
  });

  it("脱敏：凭据形键名与 env 值一律 ***", async () => {
    const ws = tmp();
    const file = path.join(ws, "dbg.jsonl");
    const d = createDiagnostics({ platform, enabled: true, file, logsDir: ws });
    d.record("config.load", {
      apiKey: "sk-1234567890",
      nested: { authorization: "Bearer x", normal: "ok" },
      env: { OPENAI_API_KEY: "sk-live", PLAIN: "visible-name-only" },
      headers: { "x-token": "abc" },
    });
    await flush();
    const line = readFileSync(file, "utf8").trim();
    expect(line).not.toContain("sk-1234567890");
    expect(line).not.toContain("Bearer x");
    expect(line).not.toContain("sk-live");
    expect(line).toContain('"normal":"ok"');
    const obj = JSON.parse(line) as Record<string, Record<string, unknown>>;
    expect(obj.apiKey).toBe("***");
    expect(obj.env?.PLAIN).toBe("***");
  });

  it("超长字符串截断", async () => {
    const ws = tmp();
    const file = path.join(ws, "dbg.jsonl");
    const d = createDiagnostics({ platform, enabled: true, file, logsDir: ws });
    d.record("provider.result", { text: "x".repeat(20 * 1024) });
    await flush();
    const line = readFileSync(file, "utf8").trim();
    expect(line.length).toBeLessThan(20 * 1024);
    expect(line).toContain("truncated");
  });

  it("writeLine 注入（stderr 路径）：不落盘", async () => {
    const ws = tmp();
    const lines: string[] = [];
    const d = createDiagnostics({
      platform,
      enabled: true,
      logsDir: ws,
      writeLine: (l) => lines.push(l),
    });
    d.record("hook.run", { point: "PreToolUse" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "hook.run" });
    const files = await platform.fs.readdir(ws).catch(() => []);
    expect(files.filter((f) => f.name.endsWith(".jsonl"))).toHaveLength(0);
  });

  it("写入失败 → warn 降级，后续记录不再抛错", async () => {
    const ws = tmp();
    const warnings: { code: string; message: string }[] = [];
    // 指向不存在且无权限创建的怪异路径：父路径是文件 → mkdir 必失败
    const blocker = path.join(ws, "blocker");
    await platform.fs.writeFile(blocker, "x");
    const d = createDiagnostics({
      platform,
      enabled: true,
      file: path.join(blocker, "dbg.jsonl"),
      logsDir: path.join(blocker, "logs"),
      warn: (code, message) => warnings.push({ code, message }),
    });
    d.record("tool.exec", {});
    await flush();
    expect(warnings.some((w) => w.code === "debug_sink_failed")).toBe(true);
    // 降级后继续调用不抛错
    d.record("tool.exec", {});
    await flush();
  });
});
