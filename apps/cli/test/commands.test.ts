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
    {
      ref: { provider: "p", model: "m1" },
      contextWindow: 128_000,
      pricing: { input: 0.27, output: 1.1 },
      capabilities: {
        reasoning: "visible",
        imageInput: true,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
    {
      ref: { provider: "p", model: "m2" },
      capabilities: {
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
    {
      ref: { provider: "other", model: "big" },
      contextWindow: 1_000_000,
      capabilities: {
        reasoning: "none",
        imageInput: false,
        promptCache: false,
        toolCalls: true,
        parallelToolCalls: false,
      },
    },
  ],
  defaultModel: () => ({ provider: "p", model: "m2" }),
  listRecentModels: () => [],
  updateProviders: () => undefined,
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

  it("/model 无参数：编号表格含列信息与标注（cli.md 第 4 节）", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/model", fakeSession(), fakeRuntime, io);
    const text = lines.join("");
    expect(text).toContain("p/m1");
    expect(text).toContain("p/m2");
    expect(text).toContain("128k");
    expect(text).toContain("1m");
    expect(text).toContain("$0.27/1.1");
    expect(text).toContain("当前会话");
    expect(text).toContain("默认模型");
  });

  it("/model <关键词> 未匹配 id 时过滤列表，不切换", async () => {
    let called = 0;
    const session = fakeSession({
      setModel: async () => {
        called += 1;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/model big", session, fakeRuntime, io);
    expect(called).toBe(0);
    expect(lines.join("")).toContain("other/big");
    expect(lines.join("")).not.toContain("p/m1");

    const none = capture();
    await runSlashCommand("/model zzzz", session, fakeRuntime, none.io);
    expect(none.lines.join("")).toContain("没有匹配");
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

  it("/preset 无参数显示当前；/preset <name> 调 setPermissionPreset", async () => {
    let called: unknown;
    const session = fakeSession({
      setPermissionPreset: async (n) => {
        called = n;
      },
    });
    const { lines, io } = capture();
    await runSlashCommand("/preset", session, fakeRuntime, io);
    expect(lines.join("")).toContain("default");
    await runSlashCommand("/preset auto-edit", session, fakeRuntime, io);
    expect(called).toBe("auto-edit");

    const failing = fakeSession({
      setPermissionPreset: async () => {
        throw new RuntimeCommandError("invalid_command", "未知预设");
      },
    });
    await runSlashCommand("/preset bogus", failing, fakeRuntime, io);
    expect(lines.join("")).toContain("invalid_command");
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

  it("/provider 列出服务商：密钥来源、来源层、当前会话标注，不含密钥", async () => {
    const { lines, io } = capture();
    const deps = {
      provider: {
        config: {
          providerSetupWarning: undefined,
          describeProviders: async () => [
            {
              id: "p",
              type: "openai-compatible",
              host: "api.corp.test",
              keySource: "credential" as const,
              origin: "setup" as const,
              overridden: false,
              modelCount: 2,
              managed: true,
            },
            {
              id: "q",
              type: "anthropic",
              host: undefined,
              keySource: "env" as const,
              keyEnvName: "ANTHROPIC_API_KEY",
              origin: "user" as const,
              overridden: false,
              modelCount: 0,
              managed: false,
            },
          ],
        } as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    };
    await runSlashCommand("/provider", fakeSession(), fakeRuntime, io, deps);
    const text = lines.join("");
    expect(text).toContain("api.corp.test");
    expect(text).toContain("凭据文件");
    expect(text).toContain("环境变量 ANTHROPIC_API_KEY");
    expect(text).toContain("向导");
    expect(text).toContain("config.json");
    expect(text).toContain("当前会话");
    expect(text).not.toContain("sk-");
  });

  it("/provider remove 当前会话使用的服务商拒绝；其他删除并刷新", async () => {
    const removed: string[] = [];
    const updated: unknown[] = [];
    const deps = {
      provider: {
        config: {
          removeSetupProvider: async (id: string) => {
            removed.push(id);
          },
        } as never,
        reloadConfig: async () => ({ tag: "rc" }) as never,
        updateProviders: (rc: unknown) => {
          updated.push(rc);
        },
      },
    };
    const { lines, io } = capture();
    await runSlashCommand("/provider remove p", fakeSession(), fakeRuntime, io, deps);
    expect(removed).toHaveLength(0);
    expect(lines.join("")).toContain("不能删除");

    await runSlashCommand("/provider remove q", fakeSession(), fakeRuntime, io, deps);
    expect(removed).toEqual(["q"]);
    expect(updated).toEqual([{ tag: "rc" }]);
  });

  it("/provider refresh 调 refreshUpstreamLimits 并 updateProviders", async () => {
    const refreshed: string[] = [];
    const updated: unknown[] = [];
    const deps = {
      provider: {
        config: {
          refreshUpstreamLimits: async (id: string) => {
            refreshed.push(id);
          },
        } as never,
        reloadConfig: async () => ({ tag: "rc" }) as never,
        updateProviders: (rc: unknown) => {
          updated.push(rc);
        },
      },
    };
    const { io } = capture();
    await runSlashCommand("/provider refresh p", fakeSession(), fakeRuntime, io, deps);
    expect(refreshed).toEqual(["p"]);
    expect(updated).toEqual([{ tag: "rc" }]);
  });

  it("/provider add 无向导桥时提示需要交互终端", async () => {
    const { lines, io } = capture();
    await runSlashCommand("/provider add", fakeSession(), fakeRuntime, io, {
      provider: {
        config: {} as never,
        reloadConfig: async () => ({}) as never,
        updateProviders: () => undefined,
      },
    });
    expect(lines.join("")).toContain("交互式终端");
  });

  it("/exit → exit；未知命令 → unknown 且不报错退出", async () => {
    const { lines, io } = capture();
    expect(await runSlashCommand("/exit", fakeSession(), fakeRuntime, io)).toBe("exit");
    expect(await runSlashCommand("/nope", fakeSession(), fakeRuntime, io)).toBe("unknown");
    expect(lines.join("")).toContain("未知命令");
  });
});
