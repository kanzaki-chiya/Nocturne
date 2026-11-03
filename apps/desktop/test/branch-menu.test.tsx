import { createSessionView, type WorkspaceBranches } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMenu } from "../src/BranchMenu";

afterEach(cleanup);
const initial: WorkspaceBranches = {
  current: "main",
  busy: false,
  branches: [
    { name: "main" },
    { name: "fix/style" },
    { name: "feat/auth", worktree: "Z:/other/auth" },
  ],
};
function fixture(value = initial) {
  const client = {
    workspaceBranches: vi.fn(async () => value),
    switchBranch: vi.fn(
      async (_input: { workspace: string; branch: string; create?: boolean }) => undefined,
    ),
  };
  const session = { id: "branch-fixture" } as RpcSession;
  const view = createSessionView();
  const props = { client, session, workspace: "Z:/fixture", view };
  return { ...props, props };
}
async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "main" }));
  await screen.findByRole("menu");
  return screen.getByRole("textbox");
}

describe("桌面分支菜单 ADR-0079", () => {
  it("非仓库和读取失败隐藏，游离 HEAD 原样显示", async () => {
    const h = fixture({ current: null, branches: [], busy: false });
    const page = render(<BranchMenu {...h.props} />);
    await waitFor(() => expect(h.client.workspaceBranches).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
    h.client.workspaceBranches.mockRejectedValueOnce(new Error("unavailable"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(h.client.workspaceBranches).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
    h.client.workspaceBranches.mockResolvedValue({
      current: "a1b2c3d4",
      branches: [],
      busy: false,
    });
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "a1b2c3d4" });
    page.unmount();
  });

  it("搜索无占位文字，当前项打勾，占用项禁用且仅路径 title；过滤并新建", async () => {
    const h = fixture();
    render(<BranchMenu {...h.props} />);
    const input = await open();
    expect(input.hasAttribute("placeholder")).toBe(false);
    expect(document.activeElement).toBe(input);
    const occupied = screen.getByRole("menuitemradio", { name: "feat/auth" });
    expect(occupied.hasAttribute("disabled")).toBe(true);
    expect(occupied.getAttribute("title")).toBe("Z:/other/auth");
    if (!occupied.parentElement) throw new Error("missing branch row");
    fireEvent.mouseEnter(occupied.parentElement);
    expect(screen.getByRole("tooltip").textContent).toBe("Z:/other/auth");
    fireEvent.mouseLeave(occupied.parentElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "main" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.change(input, { target: { value: "fix" } });
    expect(screen.queryByRole("menuitemradio", { name: "main" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "fix/style" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "feat/new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(h.client.switchBranch).toHaveBeenCalledWith({
        workspace: "Z:/fixture",
        branch: "feat/new",
        create: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("失败保留菜单和原样 stderr，重试成功后刷新状态栏，不弹成功提示", async () => {
    const h = fixture();
    const stderr = "error: Your local changes would be overwritten:\n\tfile.txt\nAborting\n";
    h.client.switchBranch.mockRejectedValueOnce(new Error(stderr));
    render(<BranchMenu {...h.props} />);
    await open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fix/style" }));
    expect((await screen.findByRole("alert")).textContent).toBe(stderr);
    expect(screen.getByRole("menu")).toBeTruthy();
    h.client.workspaceBranches.mockResolvedValue({ ...initial, current: "fix/style" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fix/style" }));
    await screen.findByRole("button", { name: "fix/style" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("本会话和目录忙时禁用，打开会话/菜单/Turn结束/窗口焦点都刷新", async () => {
    const h = fixture();
    const page = render(<BranchMenu {...h.props} />);
    await screen.findByRole("button", { name: "main" });
    expect(h.client.workspaceBranches).toHaveBeenCalledTimes(1);
    await open();
    await waitFor(() => expect(h.client.workspaceBranches).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "main" }));
    page.rerender(<BranchMenu {...h.props} view={{ ...h.view, status: "thinking" }} />);
    expect(screen.getByRole("button", { name: "main" }).hasAttribute("disabled")).toBe(true);
    page.rerender(<BranchMenu {...h.props} view={{ ...h.view, turnCount: 1 }} />);
    await waitFor(() =>
      expect(h.client.workspaceBranches.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    h.client.workspaceBranches.mockResolvedValue({ ...initial, current: "external", busy: true });
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    expect((await screen.findByRole("button", { name: "external" })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(h.client.switchBranch).not.toHaveBeenCalled();
  });

  it("方向键跳过禁用项，Escape关闭归焦；输入选项样名字不被当作界面指令", async () => {
    const h = fixture();
    render(<BranchMenu {...h.props} />);
    const input = await open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(h.client.switchBranch).toHaveBeenCalledWith({
        workspace: "Z:/fixture",
        branch: "fix/style",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await open();
    for (const name of ["-x", "--force", "a b", "..", "main;calc"]) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: name } });
      expect(screen.getByRole("menuitemradio", { name: `新建分支 ${name}` })).toBeTruthy();
    }
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
