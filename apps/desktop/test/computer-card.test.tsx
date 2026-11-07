import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingPermission } from "@nocturne/core/protocol";
import type { RpcComputer, RpcSession } from "@nocturne/rpc/client";
import { appIconResolver } from "../src/app-icon";
import { PermissionCard } from "../src/Conversation";

afterEach(cleanup);
function mount() {
  const respondPermission = vi.fn<RpcSession["respondPermission"]>().mockResolvedValue(undefined);
  const pending: PendingPermission = {
    requestId: "app-request",
    callId: "app-call",
    toolName: "mcp__computer__get_window_state",
    subjects: [
      {
        kind: "app",
        target: "excel.exe",
        app: { name: "Excel", pid: 20, title: "预算 2026.xlsx" },
      },
    ],
    reason: "按权限规则需要确认",
    options: ["allow_session", "allow_always", "deny"],
  };
  render(
    <PermissionCard
      pending={pending}
      session={{ respondPermission } as unknown as RpcSession}
      cwd="Z:/project"
    />,
  );
  return respondPermission;
}
it("软件确认显示软件、进程与窗口，只有三按钮，首项主按钮", () => {
  mount();
  expect(screen.getByText("操作软件")).toBeTruthy();
  expect(screen.getByText("Excel")).toBeTruthy();
  expect(screen.getByText("excel.exe")).toBeTruthy();
  expect(screen.getByText("预算 2026.xlsx")).toBeTruthy();
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(3);
  expect(buttons[0]?.textContent).toContain("本会话允许");
  expect(buttons[1]?.textContent).toContain("始终允许 Excel");
  expect(buttons[2]?.textContent).toContain("拒绝");
  expect(buttons[0]?.className).toContain("primary");
});
it.each([
  ["1", { decision: "allow", remember: "session" }],
  ["2", { decision: "allow", remember: "always" }],
  ["3", { decision: "deny" }],
  ["Escape", { decision: "deny" }],
] as const)("软件确认快捷键 %s 直接回复", async (key, reply) => {
  const send = mount();
  fireEvent.keyDown(window, { key });
  await waitFor(() => expect(send).toHaveBeenCalledWith("app-request", reply));
  expect(screen.queryByRole("textbox")).toBeNull();
});
function mountWithComputer(identity: string, icon: string | null) {
  const computer = {
    appIcon: vi.fn<RpcComputer["appIcon"]>().mockResolvedValue(icon),
    runningApps: vi.fn<RpcComputer["runningApps"]>().mockResolvedValue([]),
  };
  const pending: PendingPermission = {
    requestId: `icon-${identity}`,
    callId: `icon-${identity}`,
    toolName: "mcp__computer__get_window_state",
    subjects: [
      {
        kind: "app",
        target: identity,
        app: { name: "Visio", pid: 42, windowId: 4200, identity },
      },
    ],
    reason: "按权限规则需要确认",
    options: ["allow_session", "allow_always", "deny"],
  };
  const view = render(
    <PermissionCard
      pending={pending}
      session={{ respondPermission: vi.fn() } as unknown as RpcSession}
      cwd="Z:/project"
      resolveAppIcon={appIconResolver(computer)}
    />,
  );
  return { computer, view };
}
it("确认卡用主体自己的 app 调 computer.appIcon，参数带 pid 和 windowId，不列运行中软件", async () => {
  const { computer, view } = mountWithComputer("visio.exe", "VklTSU8=");
  await waitFor(() =>
    expect(computer.appIcon).toHaveBeenCalledWith({
      pid: 42,
      windowId: 4200,
      identity: "visio.exe",
    }),
  );
  expect(computer.runningApps).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(view.container.querySelector(".app-ic img")?.getAttribute("src")).toBe(
      "data:image/png;base64,VklTSU8=",
    ),
  );
});
it("取不到图标时确认卡仍显示首字母", async () => {
  const { computer, view } = mountWithComputer("visio-noicon.exe", null);
  await waitFor(() => expect(computer.appIcon).toHaveBeenCalled());
  expect(computer.runningApps).not.toHaveBeenCalled();
  expect(view.container.querySelector(".app-ic img")).toBeNull();
  expect(view.container.querySelector(".app-ic")?.textContent).toBe("V");
});
