import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, type RuntimeSession } from "@nocturne/core";
import { App } from "../src/app.js";
import { emptyWelcomeLines, welcomeLines, type WelcomeInfo } from "../src/welcome.js";

const info: WelcomeInfo = {
  version: "0.5.0",
  model: "fake-model",
  effort: "high",
  cwd: "Z:\\nocturne",
  ascii: false,
  width: 100,
};
const roots: string[] = [];
const sessions: RuntimeSession[] = [];
const screens: ReturnType<typeof render>[] = [];
afterEach(async () => {
  for (const screen of screens.splice(0)) screen.unmount();
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function waitFor(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 20 });
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function command(screen: ReturnType<typeof render>, text: string) {
  const before = screen.lastFrame();
  screen.stdin.write(text);
  await waitFor(() => screen.lastFrame() !== before && (screen.lastFrame() ?? "").includes(text));
  screen.stdin.write("\r");
}
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nct-welcome-"));
  roots.push(root);
  vi.stubEnv("NOCTURNE_HOME", path.join(root, "home"));
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [
      new FakeProvider({
        scripts: Array.from({ length: 3 }, () => [
          { type: "text_delta" as const, text: "离线回答" },
          { type: "finish" as const, reason: "stop" as const },
        ]),
      }),
    ],
  });
  const open = async () => {
    const session = await runtime.createSession({ model: "fake/fake-model" });
    sessions.push(session);
    return session;
  };
  return { runtime, open };
}
function mount(props: Parameters<typeof App>[0]) {
  const screen = render(createElement(App, props));
  screens.push(screen);
  return screen;
}

describe("ADR-0039 空会话欢迎区", () => {
  it.each([
    [51, 12, true],
    [50, 12, false],
    [51, 11, false],
    [100, 4, false],
  ])("视口 %s×%s 的字标边界", (width, height, logo) => {
    const lines = emptyWelcomeLines({ ...info, width }, height);
    expect(lines.some((line) => line.text.includes("█"))).toBe(logo);
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every((line) => stringWidth(line.text) <= width)).toBe(true);
    expect(lines.map((line) => line.text).join("\n")).toContain("v0.5.0");
    if (!logo) expect(lines.some((line) => line.text.trim() === "Nocturne v0.5.0")).toBe(true);
  });
  it("不足四行回退小欢迎区文字，不居中，也不误截宽屏目录", () => {
    const narrowHeight = { ...info, cwd: `Z:\\${"directory\\".repeat(5)}project` };
    expect(emptyWelcomeLines(narrowHeight, 3)).toEqual(
      welcomeLines(narrowHeight, true).slice(0, 3),
    );
    expect(emptyWelcomeLines(narrowHeight, 3)[2]?.text).toBe(narrowHeight.cwd);
  });
  it("居中、2/5 上留白、目录保留末段；ASCII 保留字标形状", () => {
    const lines = emptyWelcomeLines(info, 20);
    expect(lines.slice(0, 4).every((line) => line.text === "")).toBe(true);
    expect(lines[4]?.text.startsWith(" ".repeat(26) + "█")).toBe(true);
    expect(lines.map((line) => line.text.trim())).toContain("v0.5.0 • fake-model • 思考:high");
    const ascii = emptyWelcomeLines({ ...info, ascii: true, effort: undefined }, 20);
    expect(ascii.map((line) => line.text).join("\n")).toContain("#");
    expect(ascii.map((line) => line.text).join("\n")).not.toMatch(/[█▀▄•]|思考:/);
    const cwd = emptyWelcomeLines(
      { ...info, width: 51, cwd: `Z:\\${"long\\".repeat(20)}project` },
      12,
    );
    expect(cwd.some((line) => line.text.startsWith("...") && line.text.endsWith("project"))).toBe(
      true,
    );
  });
  it("空会话显示大字标，首条消息后换小欢迎区；退出仅导出小欢迎区文字", async () => {
    const { runtime, open } = await fixture();
    const session = await open();
    const transcriptOut: { current?: (() => string[]) | undefined } = {};
    const screen = mount({
      session,
      runtime,
      env: { ascii: true, animated: false },
      transcriptOut,
    });
    await waitFor(() => (screen.lastFrame() ?? "").includes("idle"));
    expect(screen.lastFrame()).not.toContain("Nocturne 0.5.0");
    expect(screen.lastFrame()).toContain("#");
    expect(transcriptOut.current?.().join("\n")).toContain("Nocturne 0.5.0");
    expect(transcriptOut.current?.().join("\n")).not.toContain("#");
    await session.submit({ text: "第一条消息" });
    await waitFor(() => (screen.lastFrame() ?? "").includes("离线回答"));
    expect(screen.lastFrame()).toContain("Nocturne 0.5.0");
    expect(screen.lastFrame()).not.toContain("v0.5.0");
    expect(transcriptOut.current?.().join("\n")).toContain("第一条消息");
    expect(transcriptOut.current?.().join("\n")).not.toContain("#");
  });
  it("启动通知保留大字标；resize 按实际视口高度退化", async () => {
    const { runtime, open } = await fixture();
    const session = await open();
    Object.defineProperty(session, "warnings", { value: ["离线启动提示"] });
    const screen = mount({ session, runtime, env: { ascii: false, animated: false } });
    await waitFor(() => (screen.lastFrame() ?? "").includes("离线启动提示"));
    expect(screen.lastFrame()).toContain("v0.5.0");
    Object.defineProperty(screen.stdout, "columns", { configurable: true, value: 51 });
    Object.defineProperty(screen.stdout, "rows", { configurable: true, value: 16 });
    let before = screen.lastFrame();
    screen.stdout.emit("resize");
    await waitFor(() => screen.lastFrame() !== before);
    expect(screen.lastFrame()).not.toContain("Nocturne v0.5.0");
    Object.defineProperty(screen.stdout, "rows", { configurable: true, value: 15 });
    before = screen.lastFrame();
    screen.stdout.emit("resize");
    await waitFor(() => screen.lastFrame() !== before);
    expect(screen.lastFrame()).toContain("Nocturne v0.5.0");
    Object.defineProperty(screen.stdout, "rows", { configurable: true, value: 7 });
    before = screen.lastFrame();
    screen.stdout.emit("resize");
    await waitFor(() => screen.lastFrame() !== before);
    expect(screen.lastFrame()).not.toContain("v0.5.0");
    expect(screen.lastFrame()).toContain("fake-model");
  });
  it("/new 重新显示大字标；/resume 有历史的会话显示小欢迎区", async () => {
    const { runtime, open } = await fixture();
    const original = await open();
    const historic = await open();
    await historic.submit({ text: "历史消息" });
    const screen = mount({
      session: original,
      runtime,
      env: { ascii: false, animated: false },
      newSession: async () => ({ kind: "ok", session: await open() }),
      switchSession: async () => ({ kind: "ok", session: historic }),
    });
    await waitFor(() => (screen.lastFrame() ?? "").includes("v0.5.0"));
    await original.submit({ text: "首条" });
    await waitFor(() => (screen.lastFrame() ?? "").includes("离线回答"));
    await command(screen, "/new");
    await waitFor(() => (screen.lastFrame() ?? "").includes("v0.5.0"));
    expect(screen.lastFrame()).not.toContain("首条");
    await command(screen, `/resume ${historic.id}`);
    await waitFor(() => (screen.lastFrame() ?? "").includes("历史消息"));
    expect(screen.lastFrame()).toContain("Nocturne 0.5.0");
    expect(screen.lastFrame()).not.toContain("v0.5.0");
  });
  it("非启动条目阻止大欢迎区；--inline 保持小欢迎区", async () => {
    const { runtime, open } = await fixture();
    const session = await open();
    const screen = mount({ session, runtime, env: { ascii: false, animated: false } });
    await waitFor(() => (screen.lastFrame() ?? "").includes("v0.5.0"));
    await command(screen, "/invalid");
    await waitFor(() => (screen.lastFrame() ?? "").includes("Nocturne 0.5.0"));
    expect(screen.lastFrame()).not.toContain("v0.5.0");
    const inline = mount({
      session: await open(),
      runtime,
      inline: true,
      env: { ascii: false, animated: false },
    });
    await waitFor(() => (inline.lastFrame() ?? "").includes("Nocturne 0.5.0"));
    expect(inline.lastFrame()).not.toContain("v0.5.0");
  });
});
