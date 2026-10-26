import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient, RpcSession } from "@nocturne/rpc/client";
import type { Grant, GrantWorkspace } from "@nocturne/core/protocol";
import { GrantsPage } from "../src/GrantsPage";
import { SessionGrants, useSessionGrants } from "../src/SessionGrants";
import { GrantedTag } from "../src/Conversation";
const grant: Grant = { kind: "shell", target: "git status", createdAt: "2026-10-20T14:03:00Z" };
function fixture(entries = [grant]) {
  let grants = [...entries];
  let trusted = false;
  let notify: () => void = () => undefined;
  const runtime = {
    listGrantWorkspaces: vi.fn(async (): Promise<GrantWorkspace[]> => [
      { workspace: "Z:/plain", grantCount: 0, trusted: false, hasProjectConfig: false },
      { workspace: "Z:/nocturne", grantCount: grants.length, trusted, hasProjectConfig: true },
    ]),
    listGrants: vi.fn(async ({ workspace }: { workspace: string }) =>
      workspace === "Z:/plain" ? [] : grants,
    ),
    revokeGrant: vi.fn(async () => {
      grants = [];
      notify();
    }),
    revokeAllGrants: vi.fn(async () => {
      grants = [];
      notify();
    }),
    describeProject: vi.fn(async () => ({
      mcpServers: [{ name: "example", command: "node server.js --arg" }],
      hooks: [{ event: "PreToolUse", count: 2 }],
      relaxedRuleCount: 3,
    })),
    setWorkspaceTrusted: vi.fn(async (input: { trusted: boolean }) => {
      trusted = input.trusted;
      notify();
    }),
  };
  const client = {
    runtime,
    onNotification: vi.fn((_method, handler) => {
      notify = handler;
      return () => undefined;
    }),
  } as unknown as RpcClient;
  return { client, runtime, notify: () => notify() };
}
afterEach(cleanup);
async function project() {
  fireEvent.click(await screen.findByRole("button", { name: /nocturne/ }));
  await screen.findByRole("heading", { name: /项目授权/ });
}
it("普通对话最先、项目列表和空状态、撤销后刷新；失败保留列表", async () => {
  const h = fixture();
  render(<GrantsPage client={h.client} plainWorkspace="Z:/plain" />);
  expect(await screen.findByText(/还没有项目授权/)).toBeTruthy();
  expect(
    within(screen.getByRole("navigation", { name: "工作区" })).getAllByRole("button")[0]
      ?.textContent,
  ).toContain("普通对话");
  await project();
  expect(await screen.findByText("git status")).toBeTruthy();
  h.runtime.revokeGrant.mockRejectedValueOnce(new Error("写盘失败"));
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "写盘失败");
  expect(screen.getByText("git status")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await screen.findByText(/还没有项目授权/);
  expect(h.runtime.revokeGrant).toHaveBeenLastCalledWith({
    workspace: "Z:/nocturne",
    kind: "shell",
    target: "git status",
  });
});
it("全部撤销需二次确认，刷新不重置确认", async () => {
  const h = fixture();
  render(<GrantsPage client={h.client} />);
  await project();
  await screen.findByText("git status");
  fireEvent.click(screen.getByRole("button", { name: "全部撤销" }));
  expect(h.runtime.revokeAllGrants).not.toHaveBeenCalled();
  await act(async () => h.notify());
  fireEvent.click(screen.getByRole("button", { name: "确认全部撤销" }));
  await waitFor(() =>
    expect(h.runtime.revokeAllGrants).toHaveBeenCalledWith({ workspace: "Z:/nocturne" }),
  );
  await screen.findByText(/还没有项目授权/);
});
it("信任先展示项目命令、Hook 和规则，取消信任直接执行", async () => {
  const h = fixture([]);
  render(<GrantsPage client={h.client} />);
  await project();
  fireEvent.click(screen.getByRole("button", { name: "信任此项目" }));
  const dialog = await screen.findByRole("dialog", { name: "信任此项目？" });
  expect(dialog.textContent).toContain("node server.js --arg");
  expect(dialog.textContent).toContain("PreToolUse · 2 条");
  expect(dialog.textContent).toContain("放宽的权限规则 · 3 条");
  fireEvent.click(within(dialog).getByRole("button", { name: "信任此项目" }));
  fireEvent.click(await screen.findByRole("button", { name: "取消信任" }));
  await waitFor(() =>
    expect(h.runtime.setWorkspaceTrusted).toHaveBeenLastCalledWith({
      workspace: "Z:/nocturne",
      trusted: false,
    }),
  );
});
it("手机信任按钮只读并提示在电脑上操作", async () => {
  const h = fixture();
  render(<GrantsPage client={h.client} remote />);
  await project();
  expect(screen.getByRole("button", { name: "信任此项目" })).toHaveProperty("disabled", true);
  expect(screen.getByText("请在电脑上操作")).toBeTruthy();
  expect(h.runtime.describeProject).not.toHaveBeenCalled();
});
it("会话菜单 0 项隐藏，单项和全部撤销，通知刷新列表", async () => {
  const h = fixture();
  let entries = [grant];
  const session = {
    listGrants: vi.fn(async () => entries),
    revokeGrant: vi.fn(async () => {
      entries = [];
      h.notify();
    }),
    revokeAllGrants: vi.fn(async () => {
      entries = [];
      h.notify();
    }),
  } as unknown as RpcSession;
  const manage = vi.fn();
  function Menu() {
    const { grants } = useSessionGrants(session, h.client);
    return <SessionGrants grants={grants} session={session} onManage={manage} />;
  }
  const { rerender } = render(<SessionGrants grants={[]} session={session} />);
  expect(screen.queryByText(/本会话已允许/)).toBeNull();
  rerender(<Menu />);
  await screen.findByText("本会话已允许 1 项");
  fireEvent.click(screen.getByText("管理项目授权 →"));
  expect(manage).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() => expect(screen.queryByText(/本会话已允许/)).toBeNull());
  await act(async () => {
    entries = [grant];
    h.notify();
  });
  fireEvent.click(await screen.findByRole("button", { name: "全部撤销" }));
  expect(session.revokeAllGrants).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认全部撤销" }));
  await waitFor(() => expect(session.revokeAllGrants).toHaveBeenCalledOnce());
});
it.each(["session", "project", undefined] as const)(
  "工具已授权标签 %s，旧日志不猜范围",
  (scope) => {
    render(
      <GrantedTag
        target="git status"
        permission={{
          action: "allow",
          source: "grant",
          rule: undefined,
          ...(scope ? { grant: { scope, createdAt: grant.createdAt } } : {}),
        }}
      />,
    );
    const tag = screen.getByText("已授权");
    if (scope === undefined) expect(tag.title).toBe("已授权");
    else {
      expect(tag.title).toContain(scope === "session" ? "本会话授权" : "项目授权");
      expect(tag.title).toContain("git status");
    }
  },
);
