import { afterEach, describe, expect, it, vi } from "vitest";

import { routeSdkWarnings } from "./adapters/ai-sdk-common.js";

const g = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };

afterEach(() => {
  delete g.AI_SDK_LOG_WARNINGS;
});

describe("AI SDK 警告改记诊断", () => {
  it("装配后 SDK 警告记为 provider.sdk_warning，不走 process.emitWarning", () => {
    delete g.AI_SDK_LOG_WARNINGS;
    const record = vi.fn();
    routeSdkWarnings({ record });
    expect(typeof g.AI_SDK_LOG_WARNINGS).toBe("function");
    const warnings = [{ type: "other", message: "skip reasoning" }];
    (g.AI_SDK_LOG_WARNINGS as (o: unknown) => void)({ warnings, provider: "p", model: "m" });
    expect(record).toHaveBeenCalledWith("provider.sdk_warning", {
      provider: "p",
      model: "m",
      warnings,
    });
    // 后装配的诊断通道接替接收
    const next = vi.fn();
    routeSdkWarnings({ record: next });
    (g.AI_SDK_LOG_WARNINGS as (o: unknown) => void)({ warnings });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("用户已设置 AI_SDK_LOG_WARNINGS 时不覆盖", () => {
    g.AI_SDK_LOG_WARNINGS = false;
    routeSdkWarnings({ record: vi.fn() });
    expect(g.AI_SDK_LOG_WARNINGS).toBe(false);
  });
});
