import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedWorktreesDescription,
  WorktreeCleanupResult,
  WorktreeRestoreResult,
} from "@nocturne/core/protocol";
import type { RpcClient } from "@nocturne/rpc/client";
import { SettingsPage, type SettingsPageSection } from "../src/SettingsPage";
import type { SettingItem, SettingsPatch } from "../src/rpc-types";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

function makeGitWorktreeItems(
  overrides: Partial<Record<SettingItem["key"], string>> = {},
): SettingItem[] {
  const defaults: Record<string, string> = {
    "git.branchPrefix": "nocturne/",
    "git.forcePush": "false",
    "git.mergeMethod": "merge",
    "git.draftPr": "true",
    "git.reviewView": "inline",
    "git.instructions.commit": "",
    "git.instructions.prTitle": "",
    "git.instructions.prBody": "",
    "worktree.sessionRoot": "",
    "worktree.subagentRoot": "",
    "worktree.fetchBeforeCreate": "false",
    "worktree.autoDelete": "true",
    "worktree.keepCount": "15",
    "worktree.askBeforeDelete": "true",
    ...overrides,
  };
  return Object.entries(defaults).map(([key, effective]) => ({
    key: key as SettingItem["key"],
    effective,
    source: "default",
    saved: undefined,
    overridden: false,
  }));
}

function makeWorktreeDescription(
  overrides: Partial<ManagedWorktreesDescription> = {},
): ManagedWorktreesDescription {
  const now = Date.now();
  return {
    defaultSubagentRoot: "C:\\Users\\test\\.nocturne\\sessions\\worktrees",
    effectiveSubagentRoot: "C:\\Users\\test\\.nocturne\\sessions\\worktrees",
    worktrees: [
      {
        id: "session:1",
        kind: "session",
        projectPath: "D:\\code\\nocturne",
        projectName: "nocturne",
        branch: "nocturne/active-branch",
        path: "D:\\code\\nocturne-wt\\active-branch",
        sourceSessionId: "sess-1",
        sourceTitle: "设置页增加 Git 与工作树",
        sourceExists: true,
        state: "active",
        aheadCount: 0,
        dirty: false,
        ownsBranch: true,
        pinned: false,
        autoDeleteCandidate: false,
        createdAt: now - 1000,
        lastUsedAt: now - 1000,
      },
      {
        id: "subagent:2",
        kind: "subagent",
        projectPath: "D:\\code\\nocturne",
        projectName: "nocturne",
        branch: "nocturne/20261125-a1b2c3",
        path: "C:\\Users\\test\\.nocturne\\sessions\\worktrees\\20261125-a1b2c3",
        sourceSessionId: "sess-1",
        sourceTitle: "设置页增加 Git 与工作树",
        sourceExists: true,
        childSessionId: "child-2",
        state: "ahead",
        aheadCount: 2,
        dirty: false,
        ownsBranch: true,
        pinned: false,
        autoDeleteCandidate: false,
        createdAt: now - 86_400_000,
        lastUsedAt: now - 86_400_000,
      },
      {
        id: "session:3",
        kind: "session",
        projectPath: "D:\\code\\nocturne",
        projectName: "nocturne",
        branch: "nocturne/old-merged",
        path: "D:\\code\\nocturne-wt\\old-merged",
        sourceSessionId: "sess-3",
        sourceTitle: "热力图配色",
        sourceExists: true,
        state: "merged",
        aheadCount: 0,
        dirty: false,
        ownsBranch: true,
        pinned: false,
        autoDeleteCandidate: true,
        createdAt: now - 3 * 86_400_000,
        lastUsedAt: now - 3 * 86_400_000,
      },
    ],
    snapshots: [],
    ...overrides,
  };
}

function renderSection(
  section: SettingsPageSection,
  client: RpcClient,
  extra?: {
    onOpenDirectory?: (path: string) => Promise<void>;
    onOpenSession?: (sessionId: string, projectPath: string) => void;
  },
) {
  return render(
    <SettingsPage
      section={section}
      client={client}
      theme="light"
      fileOpener="panel"
      editors={{ vscode: false, cursor: false }}
      workspace={null}
      defaultWorkspace={null}
      workspaceOverridden={false}
      onThemeChange={() => true}
      onFileOpenerChange={() => true}
      onWorkspaceChange={async () => undefined}
      pickFolder={async () => null}
      providersVersion={0}
      notifications={{ sendTest: async () => ({ shown: true }) }}
      onOpenDirectory={extra?.onOpenDirectory}
      onOpenSession={extra?.onOpenSession}
    />,
  );
}

describe("Git 设置页", () => {
  it("渲染约定默认值、校验非法分支前缀并回滚、保存各偏好开关/分段/指引文本框", async () => {
    let items = makeGitWorktreeItems();
    const patches: SettingsPatch[] = [];
    const srv = fakeServer(
      withInit({
        "runtime.describeSettings": () => items,
        "runtime.updateSettings": (params: { patch: SettingsPatch }) => {
          patches.push(params.patch);
          items = items.map((it) => {
            if (!(it.key in params.patch)) return it;
            const val = (params.patch as Record<string, unknown>)[it.key];
            const fallback = makeGitWorktreeItems().find((d) => d.key === it.key)?.effective ?? "";
            return {
              ...it,
              effective: val === null ? fallback : String(val),
              saved: val === null ? undefined : String(val),
            };
          });
          return items;
        },
      }),
    );

    renderSection("git", srv.client);

    const prefixInput = (await screen.findByRole("textbox", {
      name: "自动分支前缀",
    })) as HTMLInputElement;
    expect(prefixInput.value).toBe("nocturne/");

    // 非法分支前缀：报错并恢复原值，不发 RPC
    fireEvent.change(prefixInput, { target: { value: "bad prefix" } });
    fireEvent.blur(prefixInput);
    expect((await screen.findByRole("alert")).textContent).toContain("不能包含空格");
    expect(prefixInput.value).toBe("nocturne/");
    expect(patches).toHaveLength(0);

    // 合法分支前缀：保存并出现恢复默认按钮
    fireEvent.change(prefixInput, { target: { value: "feat/" } });
    fireEvent.blur(prefixInput);
    await waitFor(() => expect(patches).toContainEqual({ "git.branchPrefix": "feat/" }));

    // 开关：始终强制推送
    const forceSwitch = screen.getByRole("switch", { name: "始终强制推送" });
    expect(forceSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(forceSwitch);
    await waitFor(() => expect(patches).toContainEqual({ "git.forcePush": true }));

    // 分段控件：合并方法 -> 压缩合并
    const mergeGroup = screen.getByRole("radiogroup", { name: "合并方法" });
    fireEvent.click(within(mergeGroup).getByRole("radio", { name: "压缩合并" }));
    await waitFor(() => expect(patches).toContainEqual({ "git.mergeMethod": "squash" }));

    // 开关：创建草稿 Pull Request（默认开 -> 关）
    const draftSwitch = screen.getByRole("switch", { name: "创建草稿 Pull Request" });
    expect(draftSwitch.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(draftSwitch);
    await waitFor(() => expect(patches).toContainEqual({ "git.draftPr": false }));

    // 分段控件：审查结果呈现方式 -> 单独
    const reviewGroup = screen.getByRole("radiogroup", { name: "审查结果呈现方式" });
    fireEvent.click(within(reviewGroup).getByRole("radio", { name: "单独" }));
    await waitFor(() => expect(patches).toContainEqual({ "git.reviewView": "separate" }));

    // 指引文本框失焦保存
    const commitArea = screen.getByRole("textbox", { name: "提交说明" }) as HTMLTextAreaElement;
    fireEvent.change(commitArea, { target: { value: "中文摘要" } });
    fireEvent.blur(commitArea);
    await waitFor(() => expect(patches).toContainEqual({ "git.instructions.commit": "中文摘要" }));
  });
});

describe("工作树设置页", () => {
  it("渲染根目录/开关/保留数、按项目聚合列表、置顶、手动删除询问与清理预览、恢复快照", async () => {
    let items = makeGitWorktreeItems();
    let desc = makeWorktreeDescription({
      snapshots: [
        {
          version: 1,
          id: "snap-1",
          createdAt: new Date().toISOString(),
          reason: "auto",
          kind: "session",
          repository: "D:\\code\\nocturne",
          projectName: "nocturne",
          originalPath: "D:\\code\\nocturne-wt\\old-snapshot",
          branch: "nocturne/old-snapshot",
          ownsBranch: true,
          headSha: "abc123",
          sessionId: "sess-old",
          aheadCount: 1,
          dirty: true,
          hasBundle: true,
          hasWorkingPatch: true,
          untrackedFiles: [],
          untrackedSymlinks: [],
          snapshotDir: "C:\\Users\\test\\.nocturne\\sessions\\worktree-snapshots\\snap-1",
          restoreSteps: [],
        },
      ],
    });
    const pinnedCalls: { id: string; pinned: boolean }[] = [];
    const deletedCalls: string[][] = [];
    const restoredCalls: string[] = [];
    const patches: SettingsPatch[] = [];

    const srv = fakeServer(
      withInit({
        "runtime.describeSettings": () => items,
        "runtime.updateSettings": (params: { patch: SettingsPatch }) => {
          patches.push(params.patch);
          items = items.map((it) => {
            if (!(it.key in params.patch)) return it;
            const val = (params.patch as Record<string, unknown>)[it.key];
            const fallback = makeGitWorktreeItems().find((d) => d.key === it.key)?.effective ?? "";
            return {
              ...it,
              effective: val === null ? fallback : String(val),
              saved: val === null ? undefined : String(val),
            };
          });
          return items;
        },
        "worktrees.describe": () => desc,
        "worktrees.setPinned": (params: { id: string; pinned: boolean }) => {
          pinnedCalls.push(params);
          desc = {
            ...desc,
            worktrees: desc.worktrees.map((w) =>
              w.id === params.id ? { ...w, pinned: params.pinned } : w,
            ),
          };
          return params;
        },
        "worktrees.delete": (params: { ids: string[] }): WorktreeCleanupResult => {
          deletedCalls.push(params.ids);
          const removed = desc.worktrees.filter((w) => params.ids.includes(w.id));
          desc = {
            ...desc,
            worktrees: desc.worktrees.filter((w) => !params.ids.includes(w.id)),
          };
          return {
            deleted: removed.map((w) => ({
              id: w.id,
              branch: w.branch,
              path: w.path,
              status: "deleted",
              removedBranch: true,
            })),
            skipped: [],
            failed: [],
          };
        },
        "worktrees.restoreSnapshot": (params: { snapshotId: string }): WorktreeRestoreResult => {
          restoredCalls.push(params.snapshotId);
          return {
            snapshotId: params.snapshotId,
            worktreeId: "session:restored",
            worktreePath: "D:\\code\\nocturne-wt\\old-snapshot",
            branch: "nocturne/old-snapshot",
            headSha: "abc123",
            appliedPatch: true,
            restoredUntrackedCount: 0,
          };
        },
      }),
    );

    const onOpenDirectory = vi.fn(async () => undefined);
    const onOpenSession = vi.fn();
    renderSection("worktrees", srv.client, { onOpenDirectory, onOpenSession });

    // 等待聚合列表出现并校验超出警告
    expect(await screen.findByText("nocturne/active-branch")).toBeTruthy();
    expect(screen.getByText("使用中")).toBeTruthy();
    expect(screen.getByText("2 个独有提交")).toBeTruthy();
    expect(screen.getByText("已并回")).toBeTruthy();
    expect(screen.getByText("将自动删除")).toBeTruthy();
    expect(screen.getByText(/超出 1 个，将先保存恢复快照/)).toBeTruthy();

    // 非法根目录报错并回滚
    const sessionRootInput = screen.getByRole("textbox", { name: "新会话" }) as HTMLInputElement;
    fireEvent.change(sessionRootInput, { target: { value: "relative/dir" } });
    fireEvent.blur(sessionRootInput);
    expect((await screen.findByRole("alert")).textContent).toContain("需要绝对路径");
    expect(sessionRootInput.value).toBe("");

    // 子代理「打开」按钮调用 onOpenDirectory
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(onOpenDirectory).toHaveBeenCalledWith(desc.effectiveSubagentRoot);

    // 置顶
    const mergedRow = screen.getByText("nocturne/old-merged").closest(".wt-row") as HTMLElement;
    fireEvent.click(within(mergedRow).getByRole("button", { name: "置顶" }));
    await waitFor(() => expect(pinnedCalls).toContainEqual({ id: "session:3", pinned: true }));

    // 使用中工作树的删除按钮禁用
    const activeRow = screen.getByText("nocturne/active-branch").closest(".wt-row") as HTMLElement;
    expect(
      (within(activeRow).getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // 回到会话
    fireEvent.click(within(activeRow).getByRole("button", { name: "回到会话" }));
    expect(onOpenSession).toHaveBeenCalledWith("sess-1", "D:\\code\\nocturne");

    // 清理预览弹窗：打开 -> 仅显示非使用中项 -> 勾选并确认清理
    fireEvent.click(screen.getByRole("button", { name: "清理…" }));
    const cleanDialog = await screen.findByRole("dialog", { name: "清理工作树" });
    expect(within(cleanDialog).queryByText("nocturne/active-branch")).toBeNull();
    // 已置顶的 old-merged 默认不勾，手动勾上它再点清理
    const checkboxes = within(cleanDialog).getAllByRole("checkbox");
    expect(checkboxes.every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    const secondBox = checkboxes[1];
    if (secondBox === undefined) throw new Error("expected second checkbox");
    fireEvent.click(secondBox);
    fireEvent.click(within(cleanDialog).getByRole("button", { name: "清理 1 个" }));
    await waitFor(() => expect(deletedCalls).toContainEqual(["session:3"]));

    // 手动删除确认弹窗 + 「不再询问」
    const aheadRow = screen.getByText("nocturne/20261125-a1b2c3").closest(".wt-row") as HTMLElement;
    fireEvent.click(within(aheadRow).getByRole("button", { name: "删除" }));
    const delDialog = await screen.findByRole("alertdialog", { name: "删除工作树？" });
    fireEvent.click(within(delDialog).getByRole("checkbox", { name: "不再询问" }));
    fireEvent.click(within(delDialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(patches).toContainEqual({ "worktree.askBeforeDelete": false }));
    await waitFor(() => expect(deletedCalls).toContainEqual(["subagent:2"]));

    // 恢复快照按钮
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(restoredCalls).toEqual(["snap-1"]));

    // 自动删除开关关闭时禁用保留数量输入框
    const autoCleanSwitch = screen.getByRole("switch", { name: "自动删除旧工作树" });
    fireEvent.click(autoCleanSwitch);
    await waitFor(() => expect(patches).toContainEqual({ "worktree.autoDelete": false }));
    expect(
      (screen.getByRole("textbox", { name: "保留的工作树数量" }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("工作树删除确认与清理预览对话框遵循共享 Scrim 契约：默认聚焦取消、Esc 单层关闭还焦、双击只删一次", async () => {
    const items = makeGitWorktreeItems();
    const desc = makeWorktreeDescription();
    let resolveDelete: ((res: WorktreeCleanupResult) => void) | undefined;
    const deletedCalls: string[][] = [];
    const srv = fakeServer(
      withInit({
        "runtime.describeSettings": () => items,
        "worktrees.describe": () => desc,
        "worktrees.delete": (params: { ids: string[] }) => {
          deletedCalls.push(params.ids);
          return new Promise<WorktreeCleanupResult>((resolve) => {
            resolveDelete = resolve;
          });
        },
      }),
    );

    // 模拟 App.tsx 设置区在弹窗打开前注册的窗口 Esc 监听（仅在无 .scrim / dialog / alertdialog 时关闭设置）
    let settingsClosedByEsc = false;
    const onSettingsEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('.scrim, [role="dialog"], [role="alertdialog"]') != null) return;
      settingsClosedByEsc = true;
    };
    window.addEventListener("keydown", onSettingsEsc);
    try {
      renderSection("worktrees", srv.client);
      expect(await screen.findByText("nocturne/20261125-a1b2c3")).toBeTruthy();

      // 1) 清理预览弹窗：打开后默认聚焦「取消」，Esc 仅关弹窗不关设置、不删并还焦给「清理…」
      const cleanTrigger = screen.getByRole("button", { name: "清理…" });
      cleanTrigger.focus();
      fireEvent.click(cleanTrigger);
      const cleanDialog = await screen.findByRole("dialog", { name: "清理工作树" });
      const cleanCancel = within(cleanDialog).getByRole("button", { name: "取消" });
      expect(document.activeElement).toBe(cleanCancel);
      fireEvent.keyDown(cleanCancel, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "清理工作树" })).toBeNull());
      expect(settingsClosedByEsc).toBe(false);
      expect(deletedCalls).toHaveLength(0);
      expect(document.activeElement).toBe(cleanTrigger);

      // 2) 删除确认弹窗：打开后默认聚焦「取消」，Esc 仅关弹窗不触发删除也不关设置，且还焦给行内删除按钮
      const row = screen.getByText("nocturne/20261125-a1b2c3").closest(".wt-row") as HTMLElement;
      const delTrigger = within(row).getByRole("button", { name: "删除" });
      delTrigger.focus();
      fireEvent.click(delTrigger);
      const delDialog = await screen.findByRole("alertdialog", { name: "删除工作树？" });
      const delCancel = within(delDialog).getByRole("button", { name: "取消" });
      expect(document.activeElement).toBe(delCancel);
      fireEvent.keyDown(delCancel, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByRole("alertdialog", { name: "删除工作树？" })).toBeNull(),
      );
      expect(settingsClosedByEsc).toBe(false);
      expect(deletedCalls).toHaveLength(0);
      expect(document.activeElement).toBe(delTrigger);

      // 3) 再次打开并快速双击「删除」：同步 ref 拦截，仅发出一次 worktrees.delete
      fireEvent.click(delTrigger);
      const delDialog2 = await screen.findByRole("alertdialog", { name: "删除工作树？" });
      const confirmBtn = within(delDialog2).getByRole("button", { name: "删除" });
      fireEvent.click(confirmBtn);
      fireEvent.click(confirmBtn);
      await waitFor(() => expect(deletedCalls).toHaveLength(1));
      expect(deletedCalls[0]).toEqual(["subagent:2"]);
      resolveDelete?.({
        deleted: [
          {
            id: "subagent:2",
            branch: "nocturne/20261125-a1b2c3",
            path: "C:\\Users\\test\\.nocturne\\sessions\\worktrees\\child-2",
            status: "deleted",
            removedBranch: true,
          },
        ],
        skipped: [],
        failed: [],
      });
    } finally {
      window.removeEventListener("keydown", onSettingsEsc);
    }
  });
});
