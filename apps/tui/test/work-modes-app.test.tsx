/**
 * ADR-0076 执行方式在完整 App 里的往返：计划模式中设定目标、/goal 状态与停止。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type FakeScript } from "@nocturne/core";
import { App } from "../src/app.js";
import { settle } from "./provider-test-utils.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-wm-ui-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", temp()));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: string): FakeScript => [
  { type: "text_delta", text: value },
  { type: "finish", reason: "stop" },
];

it("计划模式中设定目标：回复照常显示、不续跑；/goal 看到进行中，/goal stop 停止", async () => {
  const provider = new FakeProvider({ scripts: [text("计划初稿"), text("交付清单已列出")] });
  const runtime = await createRuntime({ cwd: temp(), sessionsDir: temp(), providers: [provider] });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const ui = render(
    createElement(App, { session, runtime, env: { ascii: false, animated: false } }),
  );
  const frame = () => ui.lastFrame() ?? "";
  const settleOn = async (want: string) => {
    try {
      await settle(() => frame().includes(want));
    } catch {
      throw new Error(`等待「${want}」超时，当前帧：\n${frame()}`);
    }
  };
  const enter = async (value: string) => {
    ui.stdin.write(value);
    await pause();
    ui.stdin.write("\r");
  };
  try {
    await settleOn("fake-1");
    await enter("/plan 加功能");
    await settleOn("计划初稿");
    await enter("/goal 测试全过");
    await settleOn("交付清单已列出");
    expect(provider.requests).toHaveLength(2);
    await pause(200);
    await enter("/goal");
    await settleOn("状态：进行中");
    // 本地提示行推入后，之前的助手回复仍在原位
    expect(frame()).toContain("交付清单已列出");
    await enter("/goal stop");
    await settleOn("目标已停止");
    expect(session.state().goal).toMatchObject({ status: "stopped", reason: "user" });
  } finally {
    ui.unmount();
    await session.close();
  }
});
