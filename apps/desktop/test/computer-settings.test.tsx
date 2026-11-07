import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerSettingsPage } from "../src/ComputerSettingsPage";
import { createPrefsStore } from "../src/prefs";
import type { RpcComputer } from "@nocturne/rpc/client";

afterEach(cleanup);
function mount() {
  let description = {
    available: true,
    state: {
      enabled: false,
      cursor: true,
      state: "stopped" as "stopped" | "running",
      version: "0.40.2",
    },
    rules: [
      {
        kind: "app" as const,
        pattern: "excel.exe",
        action: "allow" as const,
        app: { name: "Excel" },
      },
    ],
  };
  const api = {
    describe: vi.fn(() => Promise.resolve(description)),
    setEnabled: vi.fn((enabled: boolean) => {
      description = {
        ...description,
        state: { ...description.state, enabled, state: enabled ? "running" : "stopped" },
      };
      return Promise.resolve(description);
    }),
    setCursor: vi.fn((cursor: boolean) => {
      description = { ...description, state: { ...description.state, cursor } };
      return Promise.resolve(description);
    }),
    restart: vi.fn(() => Promise.resolve(description)),
    runningApps: vi.fn(() =>
      Promise.resolve([
        { identity: "excel.exe", name: "Excel", pid: 20 },
        { identity: "notepad.exe", name: "记事本", pid: 30 },
      ]),
    ),
    appIcon: vi.fn(() => Promise.resolve(null)),
    setPermission: vi.fn(() => Promise.resolve(description)),
    onChanged: vi.fn(() => () => undefined),
  } satisfies RpcComputer;
  const prefs = createPrefsStore(undefined);
  render(<ComputerSettingsPage computer={api} prefs={prefs} version={1} />);
  return { api, prefs };
}
it("总开关先同行确认，取消不启动；确认后当场生效并写本机 prefs", async () => {
  const { api, prefs } = mount();
  await screen.findByText("cua-driver 0.40.2");
  fireEvent.click(screen.getByRole("switch", { name: "电脑操控" }));
  const confirmation = screen.getByRole("alertdialog", { name: "启用电脑操控" });
  expect(
    within(confirmation).getByText("模型能看到你的屏幕，并在允许的软件里替你点击和输入。"),
  ).toBeTruthy();
  expect(api.setEnabled).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "电脑操控" }));
  fireEvent.click(screen.getByRole("button", { name: "仍然启用" }));
  await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true));
  expect(prefs.get().computerEnabled).toBe(true);
  await screen.findByText("运行中");
  fireEvent.click(screen.getByRole("switch", { name: "电脑操控" }));
  await waitFor(() => expect(api.setEnabled).toHaveBeenLastCalledWith(false));
});
it("权限组保留用户规则；添加软件列出运行中的软件，已有软件不可选", async () => {
  const { api } = mount();
  await screen.findByText("Excel");
  fireEvent.click(screen.getByRole("switch", { name: "电脑操控" }));
  fireEvent.click(screen.getByRole("button", { name: "仍然启用" }));
  await screen.findByText("运行中");
  fireEvent.click(screen.getByRole("button", { name: "添加软件" }));
  const menu = await screen.findByRole("listbox", { name: "添加软件" });
  expect(within(menu).getByRole("option", { name: /Excel/ }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  fireEvent.click(within(menu).getByRole("option", { name: /记事本/ }));
  await waitFor(() =>
    expect(api.setPermission).toHaveBeenCalledWith({
      identity: "notepad.exe",
      action: "ask",
      app: { name: "记事本", icon: undefined },
    }),
  );
  expect(screen.queryByText(/MCP|stdio|校验|协议/)).toBeNull();
});
it("驱动重启与显示光标当场调用后台，不要求重启应用", async () => {
  const { api, prefs } = mount();
  await screen.findByText("cua-driver 0.40.2");
  fireEvent.click(screen.getByRole("switch", { name: "电脑操控" }));
  fireEvent.click(screen.getByRole("button", { name: "仍然启用" }));
  await screen.findByText("运行中");
  cleanup();
  render(<ComputerSettingsPage computer={api} prefs={prefs} version={1} hotkeyBound={false} />);
  await screen.findByText("运行中（停止快捷键未绑定）");
  cleanup();
  render(<ComputerSettingsPage computer={api} prefs={prefs} version={1} />);
  await screen.findByText("运行中");
  fireEvent.click(screen.getByRole("button", { name: "重启" }));
  await waitFor(() => expect(api.restart).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("switch", { name: "显示光标" }));
  await waitFor(() => expect(api.setCursor).toHaveBeenCalledWith(false));
  expect(prefs.get().computerCursor).toBe(false);
  expect(screen.queryByText("重启应用")).toBeNull();
});
