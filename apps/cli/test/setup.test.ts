/**
 * CLI 向导 IO 测试（provider-setup.md 第 1 节、ADR-0018）：
 * chooseMulti 的逗号分隔编号解析与非法输入重问。
 * 非 TTY 路径用 PassThrough 供行，stdout 用数组收集。
 */
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createWizardIo } from "../src/setup.js";

function ioWith(stdin: PassThrough) {
  const out: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out.push(String(chunk));
      cb();
    },
  });
  return { io: createWizardIo(stdin, stdout), out };
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
