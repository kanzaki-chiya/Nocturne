import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { createPlatform } from "../src/platform/index.js";
import { createRuntime, REVIEWER_SAMPLES, RuntimeCommandError } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";

const tmpRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

const answers = (patch: Record<string, boolean>) =>
  JSON.stringify({
    requested: false,
    destroys: false,
    credentials: false,
    exfiltrates: false,
    weakens: false,
    crosses: false,
    opaque: false,
    ...patch,
    reason: "离线测试",
  });

async function setup(reviewer: Record<string, unknown> | undefined, provider: FakeProvider) {
  const config = await loadConfig(createPlatform(), {
    nocturneHome: tmp("nct-samples-home-"),
    env: () => undefined,
  });
  if (reviewer !== undefined)
    await config.updateSettings({ "permission.reviewer": reviewer as never });
  const runtime = await createRuntime({
    cwd: tmp("nct-samples-ws-"),
    sessionsDir: tmp("nct-samples-sessions-"),
    providers: [provider],
    config,
    interactive: false,
  });
  return { runtime, config };
}

describe("审查样例 Runtime API（ADR-0057）", () => {
  it("listReviewerSamples 只给 id、说明与期望，不暴露主体和用户消息", async () => {
    const { runtime } = await setup(undefined, new FakeProvider({ scripts: [] }));
    const list = runtime.listReviewerSamples();
    expect(list).toHaveLength(REVIEWER_SAMPLES.length);
    expect(list[0]).toEqual({
      id: REVIEWER_SAMPLES[0]?.id,
      title: REVIEWER_SAMPLES[0]?.title,
      expect: REVIEWER_SAMPLES[0]?.expect,
    });
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["expect", "id", "title"]);
  });

  it("审查器未配置或关闭时拒绝；未知样例拒绝", async () => {
    const none = await setup(undefined, new FakeProvider({ scripts: [] }));
    await expect(none.runtime.testReviewerSample("push-unrequested")).rejects.toMatchObject({
      code: "invalid_command",
    });
    const off = await setup({ backend: "off" }, new FakeProvider({ scripts: [] }));
    await expect(off.runtime.testReviewerSample("push-unrequested")).rejects.toBeInstanceOf(
      RuntimeCommandError,
    );
    await expect(off.runtime.testReviewerSample("nope")).rejects.toMatchObject({
      code: "invalid_command",
    });
  });

  it("用已保存的模型审查器跑样例：结果带期望/实际/用时/理由，追加规则进提示词", async () => {
    const provider = new FakeProvider({
      handler: (request) => {
        const text = JSON.stringify(request.messages);
        const wantsPush = text.includes("改完 README 以后推送到 origin");
        return [
          {
            type: "text_delta",
            text: answers(wantsPush ? { requested: true, crosses: true } : { crosses: true }),
          },
          { type: "finish", reason: "stop" },
        ];
      },
    });
    const { runtime, config } = await setup(
      { backend: "model", model: { provider: "fake", model: "fake-1" } },
      provider,
    );
    await config.updateSettings({ "permission.reviewerRules": { ask: "任何 docker 命令" } });

    const blocked = await runtime.testReviewerSample("push-unrequested");
    expect(blocked).toMatchObject({
      id: "push-unrequested",
      expected: "ask",
      actual: "ask",
      match: true,
      reason: expect.stringContaining("会推送"),
    });
    expect(blocked.durationMs).toBeGreaterThanOrEqual(0);

    const allowed = await runtime.testReviewerSample("push-requested");
    expect(allowed).toMatchObject({ expected: "allow", actual: "allow", match: true });

    expect(JSON.stringify(provider.requests[0]?.system)).toContain(
      "用户追加：以下情况交人：任何 docker 命令",
    );
    expect(provider.requests.every((request) => request.tools.length === 0)).toBe(true);
  });

  it("调用方中止时抛出；审查异常记为交人而不是抛错", async () => {
    const failing = new FakeProvider({
      handler: () => [
        { type: "text_delta", text: "不是 JSON" },
        { type: "finish", reason: "stop" },
      ],
    });
    const { runtime } = await setup(
      { backend: "model", model: { provider: "fake", model: "fake-1" } },
      failing,
    );
    expect(await runtime.testReviewerSample("pnpm-install")).toMatchObject({
      expected: "allow",
      actual: "ask",
      match: false,
      reason: "审查输出格式错误",
    });
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));
    await expect(runtime.testReviewerSample("pnpm-install", controller.signal)).rejects.toThrow(
      "用户取消",
    );
  });
});
