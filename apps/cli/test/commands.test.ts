import { describe, expect, it } from "vitest";

import type { Runtime, RuntimeSession } from "@nocturne/core";
import { RuntimeCommandError } from "@nocturne/core";

import { runSlashCommand } from "../src/commands.js";

function fakeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: "s1",
    state: () =>
      ({
        config: { model: { provider: "p", model: "m1" }, permissionPreset: "default" },
      }) as ReturnType<RuntimeSession["state"]>,
    setModel: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    describeContext: () =>
      ({
        report: {
          sections: [
            { name: "system", source: "v1", chars: 100, estimatedTokens: 25 },
            { name: "history", source: "3 条", chars: 400, estimatedTokens: 100 },
          ],
          totalChars: 500,
          estimatedTokens: 125,
          budgetTokens: 100_000,
        },
        overBudget: false,
      }) as ReturnType<RuntimeSession["describeContext"]>,
    ...overrides,
  } as unknown as RuntimeSession;
}

const fakeRuntime = {
  listModels: () => [
    { ref: { provider: "p", model: "m1" } },
    { ref: { provider: "p", model: "m2" } },
  ],
} as unknown as Runtime;

function capture() {
  const lines: string[] = [];
  return { lines, io: { print: (t: string) => lines.push(t) } };
}

describe("斜杠命令（cli.md 第 4 节）", () => {
  it("/help 列出命令", async () => {
    const { lines, io } = capture();
    expect(await runSlashCommand("/help", fakeSession(), fakeRuntime, io)).toBe("handled");
    expect(lines.join("")).toContain("/compact");
  });

  it("/model 无参数：显示当前与可用模型", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/model", fakeSession(), fakeRuntime, io);
    expect(lines.join("")).toContain("p/m1");
    expect(lines.join("")).toContain("p/m2");
  });

  it("/model <id> 调 setModel；RuntimeCommandError 显示为提示", async () => {
    let called: unknown;
    const session = fakeSession({
      setModel: async (m) => {
        called = m;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model p/m2", session, fakeRuntime, io);
    expect(called).toBe("p/m2");

    const failing = fakeSession({
      setModel: async () => {
        throw new RuntimeCommandError("session_busy", "Turn 进行中");
      },
    });
    await runSlashCommand("/model p/m2", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("session_busy");
  });

  it("/model <裸 id> 按当前 Provider 补齐；异 api-type 前缀报错不调 setModel", async () => {
    const calls: unknown[] = [];
    const session = fakeSession({
      setModel: async (m) => {
        calls.push(m);
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model m2", session, fakeRuntime, io);
    expect(calls).toEqual(["p/m2"]);

    // 含斜杠但前缀不是 api-type：整体按模型 id 处理
    await runSlashCommand("/model deepseek/deepseek-v4.1-flash", session, fakeRuntime, io);
    expect(calls.at(-1)).toBe("p/deepseek/deepseek-v4.1-flash");

    await runSlashCommand("/model anthropic/claude-b", session, fakeRuntime, io);
    expect(calls).toHaveLength(2);
    expect(lines.join("")).toContain("anthropic");
    expect(lines.join("")).toContain("不一致");
  });

  it("/context 渲染分区与合计", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/context", fakeSession(), fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("system");
    expect(text).toContain("history");
    expect(text).toContain("125");
    expect(text).toContain("100000");
  });

  it("/compact 调 compact；失败只显示不抛", async () => {
    let compacted = false;
    const session = fakeSession({
      compact: async () => {
        compacted = true;
      },
    });
    const { io } = capture();
    await runSlashCommand("/compact", session, fakeRuntime, io);
    expect(compacted).toBe(true);

    const failing = fakeSession({
      compact: async () => {
        throw new RuntimeCommandError("compaction_in_progress", "x");
      },
    });
    const c2 = capture();
    const outcome = await runSlashCommand("/compact", failing, fakeRuntime, c2.io);
    expect(outcome).toBe("handled");
    expect(c2.lines.join("")).toContain("compaction_in_progress");
  });

  it("/exit → exit；未知命令 → unknown 且不报错退出", async () => {
    const { lines, io } = capture();
    expect(await runSlashCommand("/exit", fakeSession(), fakeRuntime, io)).toBe("exit");
    expect(await runSlashCommand("/nope", fakeSession(), fakeRuntime, io)).toBe("unknown");
    expect(lines.join("")).toContain("未知命令");
  });
});
