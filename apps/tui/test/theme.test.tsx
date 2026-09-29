import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { createSessionView } from "@nocturne/core/protocol";

import { TodoPanel, TodoRows } from "../src/components/todo-panel.js";
import { TuiEnvContext } from "../src/env.js";
import { layoutDiffRow } from "../src/diff-format.js";
import { transcriptBlocks } from "../src/lines.js";
import { renderMarkdown } from "../src/markdown.js";
import { selSegments } from "../src/selection.js";
import { palettes, resolveTheme, ThemeContext } from "../src/theme.js";

describe("深浅主题", () => {
  it("保存值缺失或非法时选 dark；语义色进入 Markdown、diff 与选区", () => {
    expect(resolveTheme(undefined)).toBe("dark");
    expect(resolveTheme("unknown")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    for (const theme of [palettes.dark, palettes.light]) {
      const markdown = renderMarkdown("# 标题\n\n```ts\nconst n = 1\n```", 60, "reply", theme);
      expect(
        markdown.flatMap((line) => line.segments ?? []).some((s) => s.color === theme.secondary),
      ).toBe(true);
      expect(
        markdown
          .flatMap((line) => line.segments ?? [])
          .some((s) => s.backgroundColor === theme.codeBg),
      ).toBe(true);
      const diff = layoutDiffRow("d", { mark: "+", body: "新行", newNo: 1 }, 25, true, theme);
      expect(diff[0]?.segments?.some((s) => s.backgroundColor === theme.diffAddBg)).toBe(true);
      expect(
        selSegments({ key: "line", text: "正文" }, { start: 0, end: 1 }, theme)[0],
      ).toMatchObject({
        backgroundColor: theme.selectionBg,
        color: theme.selected,
      });
    }
  });

  it("全屏块 revision 随主题变化，已排版历史可重排", () => {
    const base = {
      welcome: [],
      notices: [],
      frozen: [],
      entries: [],
      hide: () => false,
      live: createSessionView(),
      clientLines: [],
      ascii: false,
    };
    const dark = transcriptBlocks({ ...base, theme: palettes.dark });
    const light = transcriptBlocks({ ...base, theme: palettes.light });
    expect(dark.map((b) => b.key)).toEqual(light.map((b) => b.key));
    expect(dark.map((b) => b.revision)).not.toEqual(light.map((b) => b.revision));
  });

  it("全屏固定区与普通屏幕快照在窄宽 ASCII 下实际可读", () => {
    const items = [
      { text: "第一步", status: "completed" as const },
      { text: "第二步", status: "in_progress" as const },
      { text: "第三步", status: "pending" as const },
    ];
    for (const theme of [palettes.dark, palettes.light]) {
      const wrap = (component: React.JSX.Element) =>
        createElement(
          ThemeContext.Provider,
          { value: theme },
          createElement(
            TuiEnvContext.Provider,
            { value: { ascii: true, animated: false } },
            component,
          ),
        );
      const panel = render(wrap(createElement(TodoPanel, { items, width: 28, height: 6 })));
      expect(panel.lastFrame()).toContain("[x] 第一步");
      expect(panel.lastFrame()).toContain("[>] 第二步");
      expect(panel.lastFrame()).toContain("[ ] 第三步");
      panel.unmount();
      const snapshot = render(wrap(createElement(TodoRows, { items, width: 28 })));
      expect(snapshot.lastFrame()).toContain("[>] 第二步");
      snapshot.unmount();
    }
  }, 15000);
});
