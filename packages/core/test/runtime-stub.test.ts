import { describe, expect, it, vi } from "vitest";
import { createRuntimeStub } from "@nocturne/core/testing";

describe("createRuntimeStub", () => {
  it("未覆盖的 on* 订阅成员默认返回空取消函数", () => {
    const rt = createRuntimeStub();
    const unsubGrants = rt.onGrantsChanged(() => undefined);
    const unsubSchedule = rt.onScheduleChanged(() => undefined);
    const unsubMemory = rt.onMemoryChanged(() => undefined);
    const unsubSessions = rt.onSessionsChanged(() => undefined);
    expect(typeof unsubGrants).toBe("function");
    expect(typeof unsubSchedule).toBe("function");
    expect(typeof unsubMemory).toBe("function");
    expect(typeof unsubSessions).toBe("function");
    expect(unsubGrants()).toBeUndefined();
    expect(unsubSchedule()).toBeUndefined();
    expect(unsubMemory()).toBeUndefined();
    expect(unsubSessions()).toBeUndefined();
  });

  it("未覆盖的非订阅成员被调用时抛出含成员名的错误", () => {
    const rt = createRuntimeStub();
    expect(() => rt.listModels()).toThrow("runtime stub: listModels not stubbed");
    expect(() => rt.listSessions()).toThrow("runtime stub: listSessions not stubbed");
    expect(() => rt.close()).toThrow("runtime stub: close not stubbed");
  });

  it("覆盖项生效且可被替换；Promise.resolve 不误判为 thenable", async () => {
    const onMemory = vi.fn(() => () => undefined);
    const rt = createRuntimeStub({
      listModels: () => [],
      onMemoryChanged: onMemory,
    });
    expect(rt.listModels()).toEqual([]);
    rt.onMemoryChanged(() => undefined);
    expect(onMemory).toHaveBeenCalledTimes(1);
    const resolved = await Promise.resolve(rt);
    expect(resolved).toBe(rt);
  });

  it("类型检查拦截错误签名与未知成员", () => {
    // 仅编译期检查，不执行
    const typeChecks = () => {
      // @ts-expect-error listModels 必须返回 ModelInfo[]
      createRuntimeStub({ listModels: () => "bad" });
      // @ts-expect-error 不存在的 Runtime 成员
      createRuntimeStub({ notARuntimeMember: () => undefined });
      // @ts-expect-error renameSession 参数类型不匹配
      createRuntimeStub({ renameSession: async (_id: number) => undefined });
    };
    expect(typeof typeChecks).toBe("function");
  });
});
