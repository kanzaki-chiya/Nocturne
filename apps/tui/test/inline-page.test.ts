import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ToolEntry } from "@nocturne/core/protocol";
import { ToolRow } from "../src/components/tool-row.js";
import { summarizeToolInput } from "../src/format.js";
import { layoutEntry } from "../src/lines.js";

function makeInlineToolEntry(status: "running" | "ok" | "error" = "ok"): ToolEntry {
  return {
    kind: "tool",
    key: "t:rh-1",
    callId: "rh-1",
    turnId: "turn-1",
    seq: 1,
    completedSeq: status === "running" ? undefined : 2,
    name: "render_html",
    input: {
      title: "各包测试耗时",
      html: "<!doctype html><html><body><h1>各包测试耗时</h1></body></html>",
    },
    subjects: [],
    permission: { action: "allow", source: "rule", rule: undefined },
    resolution: undefined,
    status,
    liveOutput: "",
    result:
      status === "running"
        ? undefined
        : status === "ok"
          ? {
              status: "ok",
              modelContent: "已渲染内嵌页面「各包测试耗时」（file-1.html，56 B）。",
              output: { title: "各包测试耗时", file: "file-1.html", bytes: 56 },
              error: undefined,
              truncated: false,
              spillPath: undefined,
              files: [
                {
                  type: "file",
                  file: "file-1.html",
                  label: "各包测试耗时.html",
                  mimeType: "text/html",
                  bytes: 56,
                  sha256: "a".repeat(64),
                  source: "upload",
                  inline: { title: "各包测试耗时" },
                },
              ],
              durationMs: 4,
            }
          : {
              status: "error",
              modelContent: "title 不能为空",
              output: undefined,
              error: { code: "invalid_input", message: "title 不能为空" },
              truncated: false,
              spillPath: undefined,
              durationMs: 1,
            },
  };
}

describe("TUI 回复内嵌页面显示", () => {
  it("带 inline 标记的已完成工具结果仅显示一行标题（不带 .html，无额外提示文字）", () => {
    const completed = makeInlineToolEntry("ok");

    const lines = layoutEntry(completed, 100, false);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("▣ 各包测试耗时");
    expect(lines[0]?.text).not.toContain(".html");
    expect(lines[0]?.text).not.toContain("浏览器");

    const asciiLines = layoutEntry(completed, 100, true);
    expect(asciiLines).toHaveLength(1);
    expect(asciiLines[0]?.text).toBe("[] 各包测试耗时");

    const ink = render(createElement(ToolRow, { entry: completed, width: 100 }));
    expect(ink.lastFrame()).toBe("▣ 各包测试耗时");
    ink.unmount();
  });

  it("全屏时页面行带打开入口，--inline 不加入口", () => {
    const completed = makeInlineToolEntry("ok");
    const full = layoutEntry(completed, 100, false, new Map(), 0, false, false, undefined, {
      fullscreen: true,
    });
    expect(full[0]?.toggle).toEqual({ id: "page:file-1.html", anchor: "t:rh-1:inline:0" });
    expect(layoutEntry(completed, 100, false)[0]?.toggle).toBeUndefined();
  });

  it("运行中与失败时 summarizeToolInput 仅取 title，不铺出 html 正文", () => {
    expect(
      summarizeToolInput("render_html", {
        title: "各包测试耗时",
        html: "<div>very long html</div>",
      }),
    ).toBe("各包测试耗时");

    const running = makeInlineToolEntry("running");
    const runningText = layoutEntry(running, 100, false)
      .map((l) => l.text)
      .join("\n");
    expect(runningText).toContain("render_html 各包测试耗时");
    expect(runningText).not.toContain("very long html");
    expect(runningText).not.toContain("<!doctype html>");
  });
});
