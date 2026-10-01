import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { createElement, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CompactionThresholdDialog } from "../src/components/compaction-threshold-dialog.js";
import { CursorClaimsContext, InputCursor } from "../src/components/input-cursor.js";
import { createCursorStream, type CursorClaims, type CursorPoint } from "../src/cursor.js";

const pause = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 记录登记表的最终目标：后登记的有效项优先。 */
function recorder(): CursorClaims & { current(): CursorPoint | undefined } {
  const entries = new Map<symbol, CursorPoint>();
  return {
    set(id, point) {
      entries.delete(id);
      if (point !== undefined) entries.set(id, point);
    },
    delete(id) {
      entries.delete(id);
    },
    current: () => [...entries.values()].at(-1),
  };
}

function fakeStdout(): { stream: NodeJS.WriteStream; out: string[] } {
  const out: string[] = [];
  const stream = {
    columns: 80,
    rows: 24,
    isTTY: true,
    write(chunk: string) {
      out.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, out };
}

describe("浮层输入法光标", () => {
  it.each([
    ["模型搜索", "搜索: ", 18, 0, 18 + 6 + 4],
    ["服务商过滤", "过滤: ", 0, 2, 6 + 4],
    ["向导名称/URL/密钥行", "> ", 1, 6, 1 + 2 + 4],
  ])("%s 打开时定位到中文末尾", (_name, prefix, x, y, expectedX) => {
    const claims = recorder();
    const { unmount } = render(
      createElement(
        CursorClaimsContext.Provider,
        { value: claims },
        createElement(InputCursor, { active: true, prefix, text: "中文", x, y, width: 60 }),
      ),
    );
    expect(claims.current()).toEqual({ x: expectedX, y });
    unmount();
    expect(claims.current()).toBeUndefined();
  });

  it("浮层打开时主输入让出光标，父组件后提交也不覆盖", () => {
    const claims = recorder();
    const tree = (pageOpen: boolean) =>
      createElement(
        CursorClaimsContext.Provider,
        { value: claims },
        createElement(
          Box,
          null,
          pageOpen
            ? createElement(InputCursor, {
                active: true,
                prefix: "搜索: ",
                text: "",
                width: 60,
                y: 0,
              })
            : null,
          createElement(InputCursor, {
            active: !pageOpen,
            prefix: "› ",
            text: "ab",
            width: 60,
            y: 20,
          }),
        ),
      );
    const { rerender, unmount } = render(tree(false));
    expect(claims.current()).toEqual({ x: 4, y: 20 });
    rerender(tree(true));
    expect(claims.current()).toEqual({ x: 6, y: 0 });
    rerender(tree(false));
    expect(claims.current()).toEqual({ x: 4, y: 20 });
    unmount();
  });

  it("其它组件单独刷新时登记不丢", async () => {
    const claims = recorder();
    function Spinner(): React.JSX.Element {
      const [i, setI] = useState(0);
      useEffect(() => {
        const t = setInterval(() => setI((n) => n + 1), 5);
        return () => clearInterval(t);
      }, []);
      return createElement(Text, null, String(i));
    }
    const { unmount } = render(
      createElement(
        CursorClaimsContext.Provider,
        { value: claims },
        createElement(
          Box,
          null,
          createElement(Spinner),
          createElement(InputCursor, { active: true, prefix: "› ", text: "中", width: 60, y: 3 }),
        ),
      ),
    );
    await pause();
    expect(claims.current()).toEqual({ x: 4, y: 3 });
    unmount();
  });
});

describe("createCursorStream", () => {
  it("每次写完补位，下次写之前先恢复 Ink 的位置", () => {
    const { stream: raw, out } = fakeStdout();
    const { stream, claims, stop } = createCursorStream(raw);
    const id = Symbol();
    stream.write("frame1");
    expect(out.at(-1)).toBe("frame1");
    claims.set(id, { x: 4, y: -2 });
    expect(out.at(-1)).toBe("\x1b7\x1b[2A\x1b[5G\x1b[?25h");
    stream.write("frame2");
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8frame2\x1b7\x1b[2A\x1b[5G\x1b[?25h");
    claims.set(id, { x: 6, y: -2 });
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8\x1b[2A\x1b[7G\x1b[?25h");
    claims.delete(id);
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8");
    stream.write("frame3");
    expect(out.at(-1)).toBe("frame3");
    stop();
  });

  it("坐标连续变化时先恢复 Ink 写入终点，再从终点相对移动", () => {
    const { stream: raw, out } = fakeStdout();
    const { stream, claims, stop } = createCursorStream(raw);
    const id = Symbol();
    stream.write("frame\n");
    claims.set(id, { x: 4, y: -2 });
    expect(out.at(-1)).toBe("\x1b7\x1b[2A\x1b[5G\x1b[?25h");
    // 第二次变化：先 DECRC 回写入终点再上移 2 行、到第 7 列——不是从旧目标再移
    claims.set(id, { x: 6, y: -2 });
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8\x1b[2A\x1b[7G\x1b[?25h");
    // 仅 y 变化：同样从终点出发
    claims.set(id, { x: 6, y: -5 });
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8\x1b[5A\x1b[7G\x1b[?25h");
    // 目标即终点：恢复后只写列定位，带上移则错
    claims.set(id, { x: 6, y: 0 });
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8\x1b[7G\x1b[?25h");
    // 坐标不变：不再写任何序列
    const before = out.length;
    claims.set(id, { x: 6, y: 0 });
    expect(out.length).toBe(before);
    stop();
  });

  it("同步输出标记原样放行；切屏后等待新帧再补位", () => {
    const { stream: raw, out } = fakeStdout();
    const { stream, claims } = createCursorStream(raw);
    claims.set(Symbol(), { x: 0, y: 0 });
    stream.write("\x1b[?2026h");
    expect(out.at(-1)).toBe("\x1b[?2026h");
    stream.write("\x1b[?1049l");
    expect(out.at(-1)).toBe("\x1b[?25l\x1b8\x1b[?1049l");
    expect(out.at(-1)).not.toContain("\x1b7");
    stream.write("主屏提示\n");
    expect(out.at(-1)).toBe("主屏提示\n\x1b7\x1b[1G\x1b[?25h");
  });

  it("其余属性原样转发", () => {
    const { stream: raw } = fakeStdout();
    const { stream } = createCursorStream(raw);
    expect(stream.columns).toBe(80);
    expect(stream.isTTY).toBe(true);
  });
});

describe("压缩阈值对话框的真实光标", () => {
  it.each([100, 101])("宽 %i 时光标落在输入值末尾之后一列", async (width) => {
    const claims = recorder();
    const screen = render(
      createElement(
        CursorClaimsContext.Provider,
        { value: claims },
        createElement(CompactionThresholdDialog, {
          initial: "90%",
          width,
          height: 24,
          onApply: () => undefined,
          onCancel: () => undefined,
        }),
      ),
    );
    await vi.waitFor(() => expect(screen.lastFrame()).toContain("压缩阈值"));
    await pause(100);
    screen.stdin.write("\t");
    await vi.waitFor(() => expect(claims.current()).toBeDefined());
    const line = (screen.lastFrame() ?? "").split("\n").find((l) => l.includes("[ 90"));
    expect(claims.current()?.x).toBe((line ?? "").indexOf("[ 90") + 4);
    screen.unmount();
  });
});
