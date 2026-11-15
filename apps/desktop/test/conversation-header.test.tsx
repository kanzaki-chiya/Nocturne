import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationHeader } from "../src/ConversationHeader";
afterEach(cleanup);
it("标题、分支、操控软件与停止按顺序显示，完整路径在标题上", () => {
  const stop = vi.fn();
  const { container, rerender } = render(
    <ConversationHeader
      title="修复输入框"
      workspace="Z:/project"
      branch={<button>main</button>}
      computerActive={{ identity: "editor.exe", name: "编辑器" }}
      onStopComputer={stop}
    />,
  );
  const title = screen.getByText("修复输入框");
  expect(title.title).toBe("Z:/project");
  expect(container.querySelector(".head")?.textContent).toBe("修复输入框main编辑器停止");
  expect(container.querySelector(".path, .crumb")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  expect(stop).toHaveBeenCalledOnce();
  rerender(
    <ConversationHeader title="修复输入框" workspace="Z:/project" branch={<button>main</button>} />,
  );
  expect(screen.queryByText("编辑器")).toBeNull();
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
});
