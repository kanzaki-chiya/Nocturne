import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider, type Clipboard } from "@nocturne/core";
import type { ImageAttachment } from "@nocturne/core/protocol";
import { App } from "../src/app.js";
import { attachmentLine } from "../src/attachment-line.js";
import { layoutEntry } from "../src/lines.js";
import { createImageStore, droppedImage, splitImageTokens } from "../src/images.js";
import { palettes } from "../src/theme.js";
import { createPlatform } from "@nocturne/core";

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-image-"));
  roots.push(dir);
  return dir;
};
beforeEach(() => vi.stubEnv("NOCTURNE_HOME", tmp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const env = { ascii: false, animated: false };
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("render timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function session(imageInput = true) {
  const runtime = await createRuntime({
    cwd: tmp(),
    sessionsDir: tmp(),
    providers: [
      new FakeProvider({
        scripts: [
          [
            { type: "text_delta", text: "完成" },
            { type: "finish", reason: "stop" },
          ],
        ],
        models: [
          {
            ref: { provider: "fake", model: "vision" },
            capabilities: {
              toolCalls: true,
              parallelToolCalls: true,
              reasoning: "none",
              imageInput,
              promptCache: false,
            },
          },
          {
            ref: { provider: "fake", model: "text" },
            capabilities: {
              toolCalls: true,
              parallelToolCalls: true,
              reasoning: "none",
              imageInput: false,
              promptCache: false,
            },
          },
        ],
      }),
    ],
  });
  return { runtime, active: await runtime.createSession({ model: "fake/vision" }) };
}
const clip = (data?: Uint8Array): Clipboard => ({
  readImage: vi.fn(async () =>
    data === undefined ? undefined : { data, mimeType: "image/png" as const },
  ),
});

describe("TUI 图片输入", () => {
  it("Alt+V 插入占位并提交，历史不含占位", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const { runtime, active } = await session();
    const submit = vi.spyOn(active, "submit");
    const history = vi.spyOn(active, "recordInputHistory");
    const transcriptOut: { current?: () => string[] } = {};
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session: active,
        runtime,
        env,
        clipboard: clip(png),
        clipboardPlatform: "win32",
        transcriptOut,
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    stdin.write("看");
    stdin.write("\x1bv");
    await waitFor(() => (lastFrame() ?? "").includes("[Image #1]"));
    stdin.write("\r");
    await waitFor(() => submit.mock.calls.length === 1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      text: "看[Image #1]",
      attachments: [{ data: png, mimeType: "image/png", label: "剪贴板" }],
    });
    await waitFor(() => history.mock.calls.length === 1);
    expect(history.mock.calls[0]?.[0]).toBe("看");
    await waitFor(() =>
      (transcriptOut.current?.() ?? []).some((line) => line.includes("[图片 #1")),
    );
    expect(transcriptOut.current?.().join("\n")).not.toMatch(/\x1b\[/);
    unmount();
    await active.close();
  }, 15_000);

  it("Alt+V 无图、非 Windows、超限、模型不支持时只提示", async () => {
    for (const [imageInput, platform, data, hint] of [
      [true, "win32", undefined, "剪贴板中没有图片"],
      [true, "linux", png, "当前平台暂不支持"],
      [true, "win32", new Uint8Array(5 * 1024 * 1024 + 1).fill(1), "图片超过"],
      [false, "win32", png, "未声明支持图片输入"],
    ] as const) {
      const { runtime, active } = await session(imageInput);
      const { stdin, lastFrame, unmount } = render(
        createElement(App, {
          session: active,
          runtime,
          env,
          clipboard: clip(data),
          clipboardPlatform: platform,
        }),
      );
      await waitFor(() => (lastFrame() ?? "").includes("idle"));
      stdin.write("\x1bv");
      await waitFor(() => (lastFrame() ?? "").includes(hint));
      expect(lastFrame()).not.toContain("[Image #1]");
      // 提示进对话（! 开头），不挂在状态栏：切回模型后状态栏不会残留旧提示
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines.some((l) => l.includes("! ") && l.includes(hint))).toBe(true);
      expect(lines.find((l) => l.includes("idle"))).not.toContain(hint);
      unmount();
      await active.close();
    }
  }, 30_000);

  it("提示行留在推入位置，之后的对话排在它下面", async () => {
    const { runtime, active } = await session(false);
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session: active,
        runtime,
        env,
        clipboard: clip(png),
        clipboardPlatform: "win32",
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    stdin.write("\x1bv");
    await waitFor(() => (lastFrame() ?? "").includes("未声明支持图片输入"));
    stdin.write("你好");
    await waitFor(() => (lastFrame() ?? "").includes("你好"));
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("完成"));
    const frame = lastFrame() ?? "";
    expect(frame.indexOf("未声明支持图片输入")).toBeLessThan(frame.indexOf("› 你好"));
    expect(frame.indexOf("› 你好")).toBeLessThan(frame.indexOf("完成"));
    unmount();
    await active.close();
  });

  it("拖入路径：引号、普通路径、非图片、不存在、超限", async () => {
    const dir = tmp();
    const good = path.join(dir, "a.png");
    const bad = path.join(dir, "a.txt");
    const huge = path.join(dir, "huge.png");
    writeFileSync(good, png);
    writeFileSync(bad, "hello");
    const large = new Uint8Array(5 * 1024 * 1024 + 1);
    large.set(png);
    writeFileSync(huge, large);
    const p = createPlatform();
    expect(await droppedImage(` "${good}" `, p)).toMatchObject({
      kind: "ok",
      image: { label: "a.png" },
    });
    expect((await droppedImage(good, p)).kind).toBe("ok");
    expect((await droppedImage(bad, p)).kind).toBe("none");
    expect((await droppedImage(path.join(dir, "missing.png"), p)).kind).toBe("none");
    expect((await droppedImage(huge, p)).kind).toBe("too_large");
    const { runtime, active } = await session();
    const { stdin, lastFrame, unmount } = render(
      createElement(App, { session: active, runtime, env }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    stdin.write(`\x1b[200~"${good}"\x1b[201~`);
    await waitFor(() => (lastFrame() ?? "").includes("[Image #1]"));
    unmount();
    await active.close();
  });

  it("拖入无效路径和超限文件保留原文；模型不支持时保留路径并提示", async () => {
    const dir = tmp();
    const bad = path.join(dir, "note.txt");
    const huge = path.join(dir, "large.png");
    writeFileSync(bad, "plain text");
    const large = new Uint8Array(5 * 1024 * 1024 + 1);
    large.set(png);
    writeFileSync(huge, large);
    for (const [imageInput, file, hint] of [
      [true, bad, undefined],
      [true, path.join(dir, "missing.png"), undefined],
      [true, huge, "图片超过"],
      [false, path.join(dir, "image.png"), "未声明支持图片输入"],
    ] as const) {
      if (!imageInput) writeFileSync(file, png);
      const { runtime, active } = await session(imageInput);
      const { stdin, lastFrame, unmount } = render(
        createElement(App, { session: active, runtime, env }),
      );
      await waitFor(() => (lastFrame() ?? "").includes("idle"));
      stdin.write(`\x1b[200~${file}\x1b[201~`);
      await waitFor(() => (lastFrame() ?? "").includes(path.basename(file)));
      expect(lastFrame()).not.toContain("[Image #");
      if (hint !== undefined) expect(lastFrame()).toContain(hint);
      unmount();
      await active.close();
    }
    // 四轮各挂载一次 App，全量并发下接近默认 15s 上限
  }, 30_000);

  it("插入后切换到不支持图片的模型：拒绝提交且保留占位", async () => {
    const { runtime, active } = await session();
    const submit = vi.spyOn(active, "submit");
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session: active,
        runtime,
        env,
        clipboard: clip(png),
        clipboardPlatform: "win32",
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    stdin.write("\x1bv");
    await waitFor(() => (lastFrame() ?? "").includes("[Image #1]"));
    await active.setModel("fake/text");
    await waitFor(() => (lastFrame() ?? "").includes("text"));
    stdin.write("\r");
    await waitFor(() => (lastFrame() ?? "").includes("未声明支持图片输入"));
    expect(lastFrame()).toContain("[Image #1]");
    expect(submit).not.toHaveBeenCalled();
    unmount();
    await active.close();
  });

  it("占位整体左移、退格删除后下次粘贴编号递增", async () => {
    const { runtime, active } = await session();
    const { stdin, lastFrame, unmount } = render(
      createElement(App, {
        session: active,
        runtime,
        env,
        clipboard: clip(png),
        clipboardPlatform: "win32",
      }),
    );
    await waitFor(() => (lastFrame() ?? "").includes("idle"));
    stdin.write("x");
    stdin.write("\x1bv");
    await waitFor(() => (lastFrame() ?? "").includes("[Image #1]"));
    stdin.write("\x1b[D"); // 整体越过占位
    stdin.write("y");
    await waitFor(() => (lastFrame() ?? "").includes("y"));
    expect(lastFrame()).toContain("xy[Image #1]");
    stdin.write("\x1b[C");
    stdin.write("\x7f");
    await waitFor(() => !(lastFrame() ?? "").includes("[Image #1]"));
    stdin.write("\x1bv");
    await waitFor(() => (lastFrame() ?? "").includes("[Image #2]"));
    unmount();
    await active.close();
  }, 10_000);

  it("删除占位释放字节，编号不复用，历史剥离占位", () => {
    const store = createImageStore();
    const first = store.add({ data: png, mimeType: "image/png", label: "a" });
    expect(store.in(first)).toHaveLength(1);
    store.prune("");
    expect(store.in(first)).toHaveLength(0);
    expect(store.add({ data: png, mimeType: "image/png", label: "b" })).toBe("[Image #2]");
    expect(store.strip(`看${first}这里`)).toBe("看这里");
  });
});

describe("附件行", () => {
  const att: ImageAttachment = {
    type: "image",
    file: "img-3.png",
    mimeType: "image/png",
    bytes: 2048,
    sha256: "a",
    width: 2,
    height: 3,
    source: "read",
    label: "a.png",
  };
  it("用户与 read 工具行及退出用布局均展示；ASCII 为纯文本", () => {
    expect(attachmentLine(att, 0, false)).toBe("[图片 #3 • a.png • 2x3 • 2 KB]");
    expect(attachmentLine(att, 0, true)).toBe("[Image #3 | a.png | 2x3 | 2 KB]");
    const user = {
      kind: "user" as const,
      key: "u",
      seq: 1,
      turnId: "t",
      content: [{ type: "text" as const, text: "看" }],
      attachments: [att],
    };
    const tool = {
      kind: "tool" as const,
      key: "t",
      turnId: "t",
      callId: "c",
      name: "read",
      seq: 2,
      status: "ok" as const,
      input: {},
      subjects: [],
      permission: undefined,
      resolution: undefined,
      liveOutput: "",
      result: {
        status: "ok" as const,
        modelContent: "读取成功",
        output: undefined,
        error: undefined,
        truncated: false,
        spillPath: undefined,
        durationMs: 1,
        attachments: [att],
      },
    };
    expect(
      layoutEntry(user, 80, false)
        .map((l) => l.text)
        .join("\n"),
    ).toContain("[图片 #3 • a.png • 2x3 • 2 KB]");
    expect(
      layoutEntry(tool, 80, false)
        .map((l) => l.text)
        .join("\n"),
    ).toContain("[图片 #3 • a.png • 2x3 • 2 KB]");
    expect(
      layoutEntry(user, 80, true)
        .map((l) => l.text)
        .join("\n"),
    ).toContain("[Image #3");
  });

  it("用户消息里的 [Image #n] 占位单独着色，其余文字继承本行颜色", () => {
    expect(splitImageTokens("看[Image #1]和[Image #12]")).toEqual([
      { text: "看", image: false },
      { text: "[Image #1]", image: true },
      { text: "和", image: false },
      { text: "[Image #12]", image: true },
    ]);
    expect(splitImageTokens("无占位")).toEqual([{ text: "无占位", image: false }]);
    const user = {
      kind: "user" as const,
      key: "u",
      seq: 1,
      turnId: "t",
      content: [{ type: "text" as const, text: "[Image #1]识别图片内容" }],
    };
    const [first] = layoutEntry(user, 80, false);
    expect(first?.color).toBe(palettes.dark.accent);
    expect(first?.segments).toEqual([
      { text: "› " },
      { text: "[Image #1]", color: palettes.dark.accentAlt },
      { text: "识别图片内容" },
    ]);
    // 不含占位的行保持原样，不额外拆分
    const plain = layoutEntry(
      { ...user, content: [{ type: "text" as const, text: "你好" }] },
      80,
      false,
    );
    expect(plain[0]?.segments).toBeUndefined();
  });
});
