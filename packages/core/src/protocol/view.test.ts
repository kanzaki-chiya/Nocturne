import { describe, expect, it } from "vitest";
import { isNotReadToolFailure } from "./view.js";
import type { ToolEntry } from "./view.js";

type Subject = Parameters<typeof isNotReadToolFailure>[0];

function entry(overrides: Partial<Subject> = {}): Subject {
  return {
    status: "error",
    result: {
      status: "error",
      modelContent: "拒绝覆盖未读取的文件：Z:/repo/a.ts。请先用 read 读取该文件",
      output: undefined,
      error: { code: "not_read", message: "拒绝覆盖未读取的文件：Z:/repo/a.ts" },
      truncated: false,
      spillPath: undefined,
      durationMs: 0,
    },
    ...overrides,
  };
}

describe("isNotReadToolFailure", () => {
  it("已结束且错误码为 not_read 时返回 true", () => {
    expect(isNotReadToolFailure(entry())).toBe(true);
  });

  it("执行中与等待确认时返回 false，即使结果已带 not_read", () => {
    expect(isNotReadToolFailure(entry({ status: "running" }))).toBe(false);
    expect(isNotReadToolFailure(entry({ status: "awaiting_permission" }))).toBe(false);
  });

  it("结果缺失或其他错误码返回 false", () => {
    expect(isNotReadToolFailure({ status: "running", result: undefined })).toBe(false);
    expect(isNotReadToolFailure(entry({ result: undefined }))).toBe(false);
    expect(
      isNotReadToolFailure(
        entry({
          result: {
            status: "error",
            modelContent: "",
            output: undefined,
            error: { code: "stale_file", message: "文件已变化，需重新读取" },
            truncated: false,
            spillPath: undefined,
            durationMs: 0,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isNotReadToolFailure(
        entry({
          result: {
            status: "ok",
            modelContent: "已修改",
            output: {},
            error: undefined,
            truncated: false,
            spillPath: undefined,
            durationMs: 0,
          },
        }),
      ),
    ).toBe(false);
  });

  it("只看错误码，不看工具名与输入", () => {
    const edit = entry() as ToolEntry;
    edit.name = "edit";
    const write = entry() as ToolEntry;
    write.name = "write";
    expect(isNotReadToolFailure(edit)).toBe(true);
    expect(isNotReadToolFailure(write)).toBe(true);
  });
});
