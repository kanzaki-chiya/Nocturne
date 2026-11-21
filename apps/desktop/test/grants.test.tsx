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
  const list = await screen.findByRole("region", { name: /^工作区/ });
  fireEvent.click(await within(list).findByText("nocturne"));
  await screen.findByRole("heading", { name: /nocturne/ });
}
it("普通对话最先、进详情与面包屑返回、空状态 —、撤销后刷新；失败保留列表", async () => {
  const h = fixture();
  render(<GrantsPage client={h.client} plainWorkspace="Z:/plain" />);
  const group = await screen.findByRole("region", { name: "工作区 · 2" });
  expect(screen.queryByText(/确认时选/)).toBeNull();
  expect(screen.queryByText("还没有项目授权")).toBeNull();
  const names = Array.from(group.querySelectorAll("*"))
    .map((el) => el.textContent)
    .filter((t) => t === "普通对话" || t === "nocturne");
  expect(names[0]).toBe("普通对话");
  expect(within(group).getByText("1 项")).toBeTruthy();

  // 进入普通对话详情：无项目配置时不显示信任按钮，项目授权为空显示 —
  fireEvent.click(within(group).getByText("普通对话"));
  await screen.findByRole("heading", { name: /普通对话/ });
  expect(screen.getByText("Z:/plain")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /信任/ })).toBeNull();
  expect(within(screen.getByRole("region", { name: "项目授权 · 0" })).getByText("—")).toBeTruthy();

  // 面包屑返回工作区列表
  fireEvent.click(screen.getByRole("button", { name: "授权" }));
  await screen.findByRole("region", { name: "工作区 · 2" });

  // 进入 nocturne 详情并测试撤销失败与成功
  await project();
  expect(await screen.findByText("git status")).toBeTruthy();
  expect(screen.getByText("命令")).toBeTruthy();
  h.runtime.revokeGrant.mockRejectedValueOnce(new Error("写盘失败"));
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "写盘失败");
  expect(screen.getByText("git status")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(
    within(await screen.findByRole("region", { name: "项目授权 · 0" })).getByText("—"),
  ).toBeTruthy();
  expect(h.runtime.revokeGrant).toHaveBeenLastCalledWith({
    workspace: "Z:/nocturne",
    kind: "shell",
    target: "git status",
  });
});
it("工作区列表展示全路径、三种信任状态点和非零授权数，无记录显示 —", async () => {
  const h = fixture();
  h.runtime.listGrantWorkspaces.mockImplementation(async () => [
    { workspace: "Z:/plain", grantCount: 0, trusted: false, hasProjectConfig: false },
    { workspace: "Z:/nocturne", grantCount: 2, trusted: false, hasProjectConfig: true },
    { workspace: "Z:/echo", grantCount: 4, trusted: true, hasProjectConfig: true },
  ]);
  const { unmount } = render(<GrantsPage client={h.client} plainWorkspace="Z:/plain" />);
  const group = await screen.findByRole("region", { name: "工作区 · 3" });
  expect(within(group).getByText("Z:/plain")).toBeTruthy();
  expect(within(group).getByText("Z:/nocturne")).toBeTruthy();
  expect(within(group).getByText("Z:/echo")).toBeTruthy();
  expect(within(group).getByText("2 项")).toBeTruthy();
  expect(within(group).getByText("4 项")).toBeTruthy();
  expect(within(group).queryByText("0 项")).toBeNull();

  const noConfig = within(group).getByText("没有项目配置");
  const untrusted = within(group).getByText("未信任");
  const trusted = within(group).getByText("已信任");
  expect(noConfig.querySelector(".grant-status-dot.hollow")).not.toBeNull();
  expect(untrusted.className).toContain("warn");
  expect(untrusted.querySelector(".grant-status-dot")).not.toBeNull();
  expect(trusted.className).toContain("ok");
  expect(trusted.querySelector(".grant-status-dot")).not.toBeNull();
  unmount();

  // 无工作区记录显示 —
  h.runtime.listGrantWorkspaces.mockResolvedValueOnce([]);
  render(<GrantsPage client={h.client} />);
  const emptyGroup = await screen.findByRole("region", { name: "工作区 · 0" });
  expect(within(emptyGroup).getByText("—")).toBeTruthy();
  expect(screen.queryByText(/还没有工作区授权记录/)).toBeNull();
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
  expect(
    within(await screen.findByRole("region", { name: "项目授权 · 0" })).getByText("—"),
  ).toBeTruthy();
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
  const list = await screen.findByRole("navigation", { name: "工作区" });
  fireEvent.click(await within(list).findByRole("button", { name: /^nocturne/ }));
  await screen.findByText("git status");
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
        kind="shell"
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
      const lines = tag.title.split("\n");
      expect(lines[0]).toMatch(
        new RegExp(`^${scope === "session" ? "本会话允许" : "本项目允许"} · 10-20 \\d{2}:\\d{2}$`),
      );
      expect(lines[1]).toBe("命令 · git status");
      expect(lines).toHaveLength(2);
      expect(tag.title).not.toContain("可在 设置 › 授权 中撤销");
    }
  },
);
it("已授权悬停说明的类别用中文名，不显示原始 kind", () => {
  render(
    <GrantedTag
      target={"Z:\\ws\\grant-demo.txt"}
      kind="edit"
      permission={{
        action: "allow",
        source: "grant",
        rule: undefined,
        grant: { scope: "project", createdAt: grant.createdAt },
      }}
    />,
  );
  const lines = screen.getByText("已授权").title.split("\n");
  expect(lines[1]).toBe("修改 · Z:\\ws\\grant-demo.txt");
  expect(lines[1]).not.toMatch(/\bedit\b/);
});
it("GrantedTag 对模式 Grant 悬停标题显示「命令规则 · 时间」与模式原文，不重复拼类别", () => {
  const { rerender } = render(
    <GrantedTag
      target="git status --short"
      kind="shell"
      permission={{
        action: "allow",
        source: "grant",
        rule: undefined,
        grant: {
          scope: "project",
          createdAt: grant.createdAt,
          match: "pattern",
          pattern: "git status *",
        },
      }}
    />,
  );
  const tag = screen.getByText("已授权");
  const lines = tag.title.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^命令规则 · 10-20 \d{2}:\d{2}$/);
  expect(lines[1]).toBe("git status *");
  expect(lines[1]).not.toContain("命令 · ");
  expect(lines[1]).not.toContain("命令规则 · ");

  rerender(
    <GrantedTag
      target="git status *"
      kind="shell"
      permission={{
        action: "allow",
        source: "grant",
        rule: undefined,
        grant: {
          scope: "project",
          createdAt: grant.createdAt,
          match: "pattern",
        },
      }}
    />,
  );
  expect(screen.getByText("已授权").title.split("\n")[1]).toBe("git status *");
});
it("GrantsPage（桌面与手机 remote）对模式 Grant 显示「命令规则」且撤销透传 match", async () => {
  const patternGrant: Grant = {
    kind: "shell",
    target: "git status *",
    match: "pattern",
    createdAt: "2026-10-21T08:15:00Z",
  };
  const exactGrant: Grant = {
    kind: "shell",
    target: "git status *",
    createdAt: "2026-10-20T14:03:00Z",
  };
  const h = fixture([patternGrant, exactGrant]);
  const { unmount } = render(<GrantsPage client={h.client} plainWorkspace="Z:/plain" />);
  await project();
  expect(await screen.findByText("命令规则")).toBeTruthy();
  expect(screen.getByText("命令")).toBeTruthy();
  const revokeButtons = screen.getAllByRole("button", { name: "撤销" });
  const firstRevoke = revokeButtons[0];
  expect(firstRevoke).toBeDefined();
  if (firstRevoke !== undefined) fireEvent.click(firstRevoke);
  await waitFor(() =>
    expect(h.runtime.revokeGrant).toHaveBeenCalledWith({
      workspace: "Z:/nocturne",
      kind: "shell",
      target: "git status *",
      match: "pattern",
    }),
  );
  unmount();

  const hRemote = fixture([patternGrant]);
  render(<GrantsPage client={hRemote.client} remote />);
  const list = await screen.findByRole("navigation", { name: "工作区" });
  fireEvent.click(await within(list).findByRole("button", { name: /^nocturne/ }));
  expect(await screen.findByText("命令规则")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() =>
    expect(hRemote.runtime.revokeGrant).toHaveBeenCalledWith({
      workspace: "Z:/nocturne",
      kind: "shell",
      target: "git status *",
      match: "pattern",
    }),
  );
});
