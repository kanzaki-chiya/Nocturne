import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { RuntimeEvent } from "@nocturne/core/protocol";
import { completeLine } from "../src/completer.js";
import { renderEvent, renderPermissionPrompt } from "../src/render.js";
import { runRepl } from "../src/repl.js";

describe("CLI 文件引用", () => {
  it("readline 的异步 Tab 补全使用共享索引，选中后 Enter 才提交", async () => {
    const oldTerm = process.env.TERM;
    process.env.TERM = "xterm-256color";
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    const submit = vi.fn().mockResolvedValue("done");
    const fileIndex = vi.fn().mockResolvedValue([{ path: "main.ts", kind: "file" }]);
    const session = {
      describeSkills: () => ({ skills: [] }),
      subscribe: () => () => undefined,
      readInputHistory: async () => [],
      recordInputHistory: async () => undefined,
      reasoningEffortInfo: () => ({ available: [] }),
      submit,
      fileIndex,
      interrupt: vi.fn(),
    } as unknown as RuntimeSession;
    const runtime = { listModels: () => [] } as unknown as Runtime;
    const done = runRepl(session, runtime, { stdin, stdout, stderr: new PassThrough() });
    try {
      await vi.waitFor(() => expect(output).toContain("nctrn>"));
      stdin.write("@ma");
      await vi.waitFor(() => expect(output).toContain("@ma"));
      stdin.write("\t");
      await vi.waitFor(() => expect(output).toContain("@main.ts"));
      expect(submit).not.toHaveBeenCalled();
      expect(fileIndex).toHaveBeenCalledTimes(1);
      stdin.write("\r");
      await vi.waitFor(() => expect(submit).toHaveBeenCalledWith({ text: "@main.ts" }));
    } finally {
      stdin.end();
      await done;
      if (oldTerm === undefined) delete process.env.TERM;
      else process.env.TERM = oldTerm;
    }
  });
  it("保留输入前缀，补全目录逐级向下，自动引用空格路径", () => {
    const entries = [
      { path: "src/", kind: "directory" as const },
      { path: "src/my file.ts", kind: "file" as const },
      { path: "src/deep/main.ts", kind: "file" as const },
    ];
    expect(completeLine("看看 @sr", { effortLevels: [], providerIds: [] }, entries)).toEqual([
      ["看看 @src/", '看看 @"src/my file.ts" ', "看看 @src/deep/main.ts "],
      "看看 @sr",
    ]);
    expect(completeLine("看看 @src/", { effortLevels: [], providerIds: [] }, entries)).toEqual([
      ['看看 @"src/my file.ts" '],
      "看看 @src/",
    ]);
    expect(completeLine("/hel", { effortLevels: [], providerIds: [] }, entries)[0]).toContain(
      "/help",
    );
    expect(completeLine("a@b", { effortLevels: [], providerIds: [] }, entries)[0]).toEqual([]);
  });
  it("只显示引用摘要，不输出原文与快照，打印模式走 stderr", () => {
    const ev = {
      type: "message.user",
      sessionId: "s",
      seq: 1,
      time: "",
      payload: {
        messageId: "m",

        content: [
          { type: "text", text: "检查 @a.ts" },
          { type: "text", text: "第二原文块" },
          { type: "text", text: "SECRET_SNAPSHOT" },
          { type: "text", text: "DIRECTORY_SNAPSHOT" },
        ],
        fileRefs: [
          { path: "a.ts", kind: "file", lines: 2, totalLines: 4, chars: 99, truncated: true },
          { path: "src/", kind: "directory", chars: 0, truncated: false },
        ],
      },
    } as RuntimeEvent;
    const interactive = renderEvent(ev, "interactive");
    expect(interactive.map((p) => p.text.trim()).join("\n")).toBe(
      "附带 @a.ts（2/4 行）\n附带 @src/（目录）",
    );
    expect(renderEvent(ev, "print").every((p) => p.channel === "stderr")).toBe(true);
  });
  it("权限保留 URL 两端，并标明本会话主机范围", () => {
    const text = renderPermissionPrompt(
      [
        {
          kind: "network",
          target: "docs.example.com",
          detail: `https://docs.example.com/${"x".repeat(120)}/end.html`,
        },
      ],
      "需要确认",
      ["allow_session", "deny"],
      50,
    );
    const detail = text.split("\n")[2] ?? "";
    expect(detail).toContain("https://docs.");
    expect(detail).toContain("…");
    expect(detail).toContain("/end.html");
    expect(detail.length).toBeLessThanOrEqual(50);
    expect(text).toContain("本会话允许访问 docs.example.com");
    expect(
      renderPermissionPrompt([{ kind: "network", target: "x", detail: "abcdef" }], "", [], 1).split(
        "\n",
      )[2],
    ).toBe("  …");
  });
  it("仅图片引用与多块原文只附加图片摘要，原文沿用 readline 回显", () => {
    const event: RuntimeEvent = {
      type: "message.user",
      sessionId: "s",
      seq: 1,
      time: "",
      payload: {
        messageId: "m",

        content: [
          { type: "text", text: "检查 @photo.png" },
          { type: "text", text: "第二块说明" },
        ],
        fileRefs: [{ path: "photo.png", kind: "image", chars: 0, truncated: false }],
      },
    };
    expect(renderEvent(event, "interactive").map((part) => part.text.trim())).toEqual([
      "附带 @photo.png（图片）",
    ]);
  });
  it("中文 URL 按显示列宽截断，保留主机与末尾文件名", () => {
    const prompt = renderPermissionPrompt(
      [
        {
          kind: "network",
          target: "docs.test",
          detail: `https://docs.test/${"中文".repeat(50)}/结尾.html`,
        },
      ],
      "",
      [],
      50,
    );
    const detail = prompt.split("\n")[2] ?? "";
    const columns = Array.from(detail).reduce(
      (sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1),
      0,
    );
    expect(columns).toBeLessThanOrEqual(50);
    expect(detail).toContain("https://docs.test/");
    expect(detail).toContain("/结尾.html");
    expect(detail).toContain("…");
  });
});
