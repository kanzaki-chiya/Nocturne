import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcError } from "@nocturne/rpc/client";
import { PanelHarness, panelFixture } from "./phone-panel-fixtures";
import { assistantMessage, summary, toolStarted, userMessage } from "./subagent-fixtures";

const viewer = vi.hoisted(() => ({
  mount: vi.fn(async (_parent: HTMLElement, _options: { text: string; path: string }) => ({
    destroy: vi.fn(),
    reveal: vi.fn(),
  })),
}));
vi.mock("../src/code-viewer", () => ({ mountCodeViewer: viewer.mount }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("总览显示上下文、同步与后台子代理，没有后台徽标或行内取消；终端不响应", async () => {
  const fixture = panelFixture({
    agents: [
      summary({
        background: true,
        taskSummary: "很长的后台子代理任务".repeat(20),
        profile: "quick",
        model: "p/model",
        effort: "high",
      }),
      summary({
        childSessionId: "child-2",
        profile: "deep",
        background: false,
        taskSummary: "同步任务",
      }),
    ],
  });
  const { container } = render(<PanelHarness fixture={fixture} />);
  await screen.findByText("同步任务");
  expect(screen.getByText("34%")).toBeTruthy();
  expect(screen.getByText("43,210 / 128,000 tokens")).toBeTruthy();
  expect(screen.getByText("quick · p/model · high")).toBeTruthy();
  expect(screen.queryByText("后台")).toBeNull();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "后台任务" })).toBeNull();
  expect(container.querySelector(".pi-list, .pi-item")).toBeNull();
  const terminal = screen.getByRole("button", { name: "终端" });
  expect(terminal.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(terminal);
  expect(screen.getByRole("heading", { name: "上下文" })).toBeTruthy();
  expect(fixture.runtime.cancelSubagent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "上下文" }));
  expect(screen.getByText("系统提示")).toBeTruthy();
  expect(screen.getByText("对话历史")).toBeTruthy();
});

it.each([true, false])(
  "子代理只读观察；background=%s 时详情取消资格正确，返回时退订",
  async (background) => {
    const agent = summary({ background, taskSummary: "审查调用方", profile: "quick" });
    const fixture = panelFixture({ agents: [agent] });
    const unsubscribe = vi.fn();
    fixture.runtime.observeSubagent.mockImplementation(async (_input, observer) => {
      observer.onEvent(userMessage(1, "审查调用方"));
      observer.onEvent(toolStarted(2, "r", "read", { path: "src/long.ts" }));
      observer.onEvent(assistantMessage(3, "已找到调用方。"));
      return { lastSeq: 3, summary: agent, mode: "live", unsubscribe };
    });
    const { container } = render(<PanelHarness fixture={fixture} />);
    fireEvent.click(await screen.findByRole("button", { name: /审查调用方/ }));
    await screen.findByText("已找到调用方。");
    expect(fixture.runtime.observeSubagent).toHaveBeenCalledWith(
      { parentSessionId: "p", childSessionId: "child-1" },
      expect.any(Object),
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.queryByText("只读")).toBeNull();
    expect(screen.queryByText("后台")).toBeNull();
    if (background) {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(fixture.runtime.cancelSubagent).toHaveBeenCalledWith({
        parentSessionId: "p",
        childSessionId: "child-1",
      });
    } else expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回总览" }));
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "子代理" })).toBeTruthy();
  },
);

it("无任务时隐藏两个任务组，暗处与 Escape 均关闭侧边栏", () => {
  const fixture = panelFixture();
  render(<PanelHarness fixture={fixture} />);
  expect(screen.queryByRole("heading", { name: "子代理" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "后台任务" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(fixture.onClose).toHaveBeenCalledTimes(2);
});

it("变更按轮列出并展开文件 diff，不提供撤销", async () => {
  const fixture = panelFixture();
  fixture.entry.turnChanges.set(1, {
    seq: 1,
    files: [
      {
        path: "Z:/work/src/long.ts",
        status: "modified",
        external: false,
        added: 1,
        removed: 1,
        restorable: true,
      },
    ],
    untrackedCalls: 0,
  });
  render(<PanelHarness fixture={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: "变更" }));
  expect(screen.getByText("第 1 轮")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /src\/long.ts/ }));
  await screen.findByText("new");
  expect(fixture.loadDiff).toHaveBeenCalledWith(1, "Z:/work/src/long.ts");
  expect(screen.queryByRole("button", { name: /撤销/ })).toBeNull();
});

it("文件索引点开复用只读 code-viewer，文件大小可见", async () => {
  const fixture = panelFixture();
  render(<PanelHarness fixture={fixture} initial={{ kind: "files" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "src/long.ts" }));
  await waitFor(() => expect(viewer.mount).toHaveBeenCalled());
  expect(fixture.session.readFile).toHaveBeenCalledWith("src/long.ts");
  expect(viewer.mount.mock.calls[0]?.[1].text).toContain("longlong");
  expect(screen.getByText("335 B")).toBeTruthy();
});

it.each(["file_too_large", "file_binary"])(
  "远程 %s 仅显示错误携带的字节数，不挂查看器",
  async (code) => {
    const fixture = panelFixture();
    fixture.session.readFile.mockRejectedValueOnce(
      RpcError.fromObject({ code: -32002, message: code, data: { code, bytes: 6000000 } }),
    );
    render(<PanelHarness fixture={fixture} initial={{ kind: "files" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "src/long.ts" }));
    await screen.findByText("6,000,000 B");
    expect(viewer.mount).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
  },
);
