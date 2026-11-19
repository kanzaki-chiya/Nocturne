/**
 * TUI 测试禁止通过默认真实子进程写入系统剪贴板：
 * 拦截 clipboard.copyText，未注入假 spawn（或显式传入真实 node:child_process.spawn）时
 * 不启动系统剪贴板命令，并在当前测试结束时报错失败。
 * 显式注入假 spawn 的测试（如 clipboard.test.ts）照常执行原实现。
 */
import { spawn as realSpawn } from "node:child_process";

import { afterAll, afterEach, beforeEach, vi } from "vitest";

import type * as ClipboardModule from "../src/clipboard.js";
import type { CopyDeps } from "../src/clipboard.js";

let clipboardViolation: Error | undefined;

vi.mock("../src/clipboard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClipboardModule>();
  return {
    ...actual,
    copyText(text: string, deps?: CopyDeps) {
      if (deps?.spawn === undefined || deps.spawn === realSpawn) {
        clipboardViolation ??= new Error(
          "测试未注入 copySpawn：禁止使用默认真实进程写入系统剪贴板",
        );
        return Promise.resolve([]);
      }
      return actual.copyText(text, deps);
    },
  };
});

beforeEach(() => {
  clipboardViolation = undefined;
});

afterEach(() => {
  const err = clipboardViolation;
  clipboardViolation = undefined;
  if (err !== undefined) throw err;
});

afterAll(() => {
  const err = clipboardViolation;
  clipboardViolation = undefined;
  if (err !== undefined) throw err;
});
