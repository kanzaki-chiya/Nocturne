import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingPermission } from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { PermissionCard, toolArgument } from "../src/Conversation";

afterEach(cleanup);
const family = "Microsoft.WindowsNotepad_8wekyb3d8bbwe";
const subject = {
  kind: "app" as const,
  target: family,
  app: { name: "Windows 记事本", packageFamilyName: family },
};
it("打包应用工具行显示名字，不出现包族名；没有名字时回退 target", () => {
  const entry = {
    name: "mcp__computer__get_window_state",
    subjects: [subject],
  } as Parameters<typeof toolArgument>[0];
  expect(toolArgument(entry, "Z:/project")).toBe("get_window_state · Windows 记事本");
  expect(
    toolArgument({ ...entry, subjects: [{ kind: "app", target: "excel.exe" }] }, "Z:/project"),
  ).toBe("get_window_state · excel.exe");
});
it("打包应用确认卡只显示名字，不出现包族名", () => {
  const pending: PendingPermission = {
    requestId: "package",
    callId: "package",
    toolName: "mcp__computer__get_window_state",
    subjects: [subject],
    reason: "按权限规则需要确认",
    options: ["allow_session", "allow_always", "deny"],
  };
  const view = render(
    <PermissionCard
      pending={pending}
      session={{ respondPermission: vi.fn() } as unknown as RpcSession}
      cwd="Z:/project"
    />,
  );
  expect(screen.getByText("Windows 记事本")).toBeTruthy();
  expect(view.container.textContent).not.toContain(family);
});
it.each([
  [{ pid: 99 }, "", "PID 99"],
  [{}, "PID 42", "PID 42"],
  [{}, "", "操作软件"],
  [{ windowId: 123 }, "123", "操作软件"],
] as const)("未解析确认卡名字行非空并隐藏句柄：%j", (app, target, expected) => {
  const pending: PendingPermission = {
    requestId: "unresolved",
    callId: "unresolved",
    toolName: "mcp__computer__get_window_state",
    subjects: [{ kind: "app", target, app, appUnresolved: true }],
    reason: "按权限规则需要确认",
    options: ["allow_session", "deny"],
  };
  const view = render(
    <PermissionCard
      pending={pending}
      session={{ respondPermission: vi.fn() } as unknown as RpcSession}
      cwd="Z:/project"
    />,
  );
  expect(view.container.querySelector(".ask-app .app-name")?.textContent).toBe(expected);
  expect(view.container.querySelector(".ask-app .exe")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(2);
});
