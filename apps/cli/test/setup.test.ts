/**
 * CLI 向导 IO 测试（provider-setup.md 第 1 节、ADR-0018）：
 * chooseMulti 的逗号分隔编号解析与非法输入重问。
 * 非 TTY 路径用 PassThrough 供行，stdout 用数组收集。
 */
import { PassThrough, Writable } from "node:stream";
import { runProviderSetupFlow } from "@nocturne/tui/provider-setup-flow";
import type { RuntimeConfig } from "@nocturne/core";
import { describe, expect, it } from "vitest";

import { createSetupPrompts } from "../src/setup.js";

function ioWith(stdin: PassThrough) {
  const out: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out.push(String(chunk));
      cb();
    },
  });
  return { io: createSetupPrompts(stdin, stdout), out };
}

const OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** 等 stdout 出现指定文本（readline 逐行消费，写下一行前必须等重问提示打出） */
async function waitFor(out: string[], needle: string, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (out.join("").split(needle).length - 1 >= count) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等待输出超时：${needle} ×${count}`);
}

describe("chooseMulti 编号勾选解析（ADR-0018）", () => {
  it("逗号分隔编号 → 去重升序的下标数组", async () => {
    const stdin = new PassThrough();
    const { io } = ioWith(stdin);
    const answer = io.chooseMulti("勾选档位", OPTIONS);
    stdin.write("4,2，3 4\n"); // 中文逗号与空白也接受；重复编号去重
    await expect(answer).resolves.toEqual([1, 2, 3]);
  });

  it("非法输入（越界/非数字）重问；空行 = 不选", async () => {
    const stdin = new PassThrough();
    const { io, out } = ioWith(stdin);
    const answer = io.chooseMulti("勾选档位", OPTIONS);
    await waitFor(out, "编号", 1);
    stdin.write("7\n");
    await waitFor(out, "无效输入", 1);
    stdin.write("abc\n");
    await waitFor(out, "无效输入", 2);
    stdin.write("\n");
    await expect(answer).resolves.toEqual([]);
  });
});

it.each(["deepseek", "grok-cli"])(
  "逐行 %s：提示/模型 ID 先于确认，确认前不保存",
  async (presetId) => {
    const stdin = new PassThrough();
    const { io, out } = ioWith(stdin);
    const saved: unknown[] = [];
    const config = {
      credentials: { backend: () => "none", has: () => false },
      findProviderConflict: async () => undefined,
      saveSetupProvider: async (entry: unknown) => {
        saved.push(entry);
      },
      refreshModelsDev: async () => undefined,
    } as unknown as RuntimeConfig;
    const flow = runProviderSetupFlow(
      io,
      config,
      {
        login: async () => {
          throw new Error("unused");
        },
        confirm: async () => {
          expect(saved).toHaveLength(0);
          expect(out.join("")).toContain(
            presetId === "deepseek" ? "保存后可用 /provider refresh 重试" : "模型 ID",
          );
          io.print("保存配置");
        },
        addOptions: {
          fetchModels: async () => {
            throw Object.assign(new Error("missing"), { status: 404 });
          },
          env: () => undefined,
        },
      },
      { presetId },
    );
    await waitFor(out, presetId === "deepseek" ? "凭据环境变量名" : "模型 ID", 1);
    stdin.write(presetId === "deepseek" ? "TEST_ENV\n" : "grok-code\n");
    await flow;
    const text = out.join("");
    expect(text.indexOf(presetId === "deepseek" ? "保存后可用" : "模型 ID")).toBeLessThan(
      text.indexOf("保存配置"),
    );
    expect(saved).toHaveLength(1);
  },
);
