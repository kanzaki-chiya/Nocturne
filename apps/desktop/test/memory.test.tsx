import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  MemoryDescription,
  MemoryEntry,
  MemoryEntryMeta,
  MemoryScopeOverview,
} from "@nocturne/core/protocol";
import { MemoryPage } from "../src/MemoryPage";
import { fakeServer, withInit } from "./fake-server";

afterEach(cleanup);

const meta = (overrides: Partial<MemoryEntryMeta> = {}): MemoryEntryMeta => ({
  name: "tone",
  description: "Prefer concise direct replies",
  type: "user",
  updatedAt: "2026-11-19T04:00:00.000Z",
  ...overrides,
});

const scope = (overrides: Partial<MemoryScopeOverview> = {}): MemoryScopeOverview => ({
  enabled: true,
  dir: "C:/nocturne/memory/global",
  entries: [],
  warnings: [],
  ...overrides,
});

const desc = (overrides: Partial<MemoryDescription> = {}): MemoryDescription => ({
  global: scope(),
  otherProjects: [],
  ...overrides,
});

it("渲染全局与项目分组、四种类型短词、停用组行变暗以及组警告", async () => {
  const openDirectory = vi.fn().mockResolvedValue(undefined);
  const f = fakeServer(
    withInit({
      "memory.describeMemory": desc({
        global: scope({
          enabled: false,
          dir: "C:/nocturne/memory/global",
          entries: [
            meta({ name: "tone", description: "Direct tone", type: "user" }),
            meta({ name: "no-mocks", description: "Use real DB in tests", type: "feedback" }),
          ],
          warnings: ["C:/nocturne/memory/global/broken.md: 缺少 YAML 前言"],
        }),
        project: scope({
          enabled: true,
          dir: "C:/nocturne/memory/projects/nocturne-1234abcd",
          entries: [
            meta({ name: "build-cmd", description: "Run pnpm typecheck", type: "project" }),
            meta({ name: "issue-tracker", description: "Linear project URL", type: "reference" }),
          ],
        }),
      }),
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot="Z:/nocturne"
      version={0}
      openDirectory={openDirectory}
      openUrl={vi.fn()}
    />,
  );

  const globalRegion = await screen.findByRole("region", { name: "全局 · 2" });
  const projectRegion = screen.getByRole("region", { name: "项目 · 2" });

  expect(within(globalRegion).getByText("tone")).toBeTruthy();
  expect(within(globalRegion).getByText("Direct tone")).toBeTruthy();
  expect(within(globalRegion).getByText("用户")).toBeTruthy();
  expect(within(globalRegion).getByText("no-mocks")).toBeTruthy();
  expect(within(globalRegion).getByText("反馈")).toBeTruthy();
  expect(within(globalRegion).getByText("1 条警告，查看")).toBeTruthy();
  expect(
    within(globalRegion).getByText("tone").closest(".slist-row")?.classList.contains("off"),
  ).toBe(true);

  const buildRow = within(projectRegion)
    .getByText("build-cmd")
    .closest(".slist-row") as HTMLElement;
  expect(within(buildRow).getByText("项目")).toBeTruthy();
  expect(within(projectRegion).getByText("issue-tracker")).toBeTruthy();
  expect(within(projectRegion).getByText("参考")).toBeTruthy();
  expect(buildRow.classList.contains("off")).toBe(false);

  fireEvent.click(within(globalRegion).getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith("C:/nocturne/memory/global");

  f.close();
});

it("无项目范围时不显示「项目记忆」开关与「项目」组", async () => {
  const f = fakeServer(
    withInit({
      "memory.describeMemory": desc({
        global: scope({
          entries: [meta({ name: "tone", description: "Concise", type: "user" })],
        }),
      }),
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot={undefined}
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );

  await screen.findByRole("switch", { name: "全局记忆" });
  expect(screen.queryByRole("switch", { name: "项目记忆" })).toBeNull();
  expect(screen.queryByRole("region", { name: /^项目/ })).toBeNull();

  f.close();
});

it("开关调用 updateSettings 更新 memory.global 与 memory.project", async () => {
  let globalEnabled = true;
  let projectEnabled = true;
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({
            enabled: globalEnabled,
            entries: [meta()],
          }),
          project: scope({
            enabled: projectEnabled,
            dir: "C:/nocturne/memory/projects/demo-11223344",
          }),
        }),
      "runtime.updateSettings": (params: Record<string, unknown>) => {
        const patch = params.patch as Record<string, unknown>;
        if (typeof patch["memory.global"] === "boolean") globalEnabled = patch["memory.global"];
        if (typeof patch["memory.project"] === "boolean") projectEnabled = patch["memory.project"];
        return [];
      },
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot="Z:/demo"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );

  const globalSwitch = await screen.findByRole("switch", { name: "全局记忆" });
  const projectSwitch = screen.getByRole("switch", { name: "项目记忆" });
  expect(globalSwitch.getAttribute("aria-checked")).toBe("true");
  expect(projectSwitch.getAttribute("aria-checked")).toBe("true");

  fireEvent.click(globalSwitch);
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "全局记忆" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  fireEvent.click(projectSwitch);
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "项目记忆" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  expect(
    f.calls.filter((c) => c.method === "runtime.updateSettings").map((c) => c.params.patch),
  ).toEqual([{ "memory.global": false }, { "memory.project": false }]);

  f.close();
});

it("点击记忆行进入详情页显示概况与 Markdown 正文，取消不删，确认后删除并回到列表", async () => {
  let globalEntries: MemoryEntryMeta[] = [
    meta({ name: "build-cmd", description: "Run typecheck", type: "project" }),
  ];
  const entryDetail: MemoryEntry = {
    scope: "global",
    name: "build-cmd",
    description: "Run typecheck",
    type: "project",
    updatedAt: "2026-11-19T04:00:00.000Z",
    content: "## Check\n\nRun `pnpm typecheck` before commit.",
    raw: "---\nname: build-cmd\n---\n\n## Check\n\nRun `pnpm typecheck` before commit.\n",
  };
  const openDirectory = vi.fn().mockResolvedValue(undefined);
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({
            dir: "C:/nocturne/memory/global",
            entries: globalEntries,
          }),
        }),
      "memory.readMemory": entryDetail,
      "memory.deleteMemory": (params: Record<string, unknown>) => {
        globalEntries = globalEntries.filter((item) => item.name !== params.name);
        return null;
      },
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot={undefined}
      version={0}
      openDirectory={openDirectory}
      openUrl={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByText("build-cmd"));

  expect(await screen.findByRole("button", { name: "记忆" })).toBeTruthy();
  const summary = screen.getByRole("region", { name: "概况" });
  expect(summary.textContent).toContain("项目");
  expect(summary.textContent).toContain("C:/nocturne/memory/global/build-cmd.md");
  expect(await screen.findByText("Check")).toBeTruthy();
  expect(screen.getByText("pnpm typecheck")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith("C:/nocturne/memory/global");

  const deleteBtn = screen.getByRole("button", { name: "删除" });
  expect(deleteBtn.classList.contains("btn-danger")).toBe(true);
  fireEvent.click(deleteBtn);
  const cancelDlg = screen.getByRole("dialog", { name: "删除 build-cmd？" });
  fireEvent.click(within(cancelDlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  const confirmDlg = screen.getByRole("dialog", { name: "删除 build-cmd？" });
  fireEvent.click(within(confirmDlg).getByRole("button", { name: "删除" }));

  expect(await screen.findByRole("status")).toHaveProperty("textContent", "✓ 已删除 build-cmd");
  expect(await screen.findByText("没有记忆")).toBeTruthy();
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory").map((c) => c.params)).toEqual([
    { scope: "global", name: "build-cmd" },
  ]);

  f.close();
});

it("其他项目默认折叠，展开后点清空弹出确认，取消不调 RPC，确认调用 clearMemory", async () => {
  let others = [{ key: "other-12345678", path: "Z:/other-repo", count: 3 }];
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: others,
        }),
      "memory.clearMemory": (params: Record<string, unknown>) => {
        others = others.filter((item) => item.key !== params.key);
        return null;
      },
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot="Z:/current"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );

  const toggle = await screen.findByRole("button", { name: /其他项目/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Z:/other-repo")).toBeNull();

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Z:/other-repo")).toBeTruthy();
  expect(screen.getByText("3 条")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  const cancelDlg = screen.getByRole("dialog", { name: "清空 Z:/other-repo 的记忆？" });
  fireEvent.click(within(cancelDlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.filter((c) => c.method === "memory.clearMemory")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "清空" }));
  const confirmDlg = screen.getByRole("dialog", { name: "清空 Z:/other-repo 的记忆？" });
  fireEvent.click(within(confirmDlg).getByRole("button", { name: "清空" }));

  await waitFor(() => {
    expect(screen.queryByText("Z:/other-repo")).toBeNull();
  });
  expect(f.calls.filter((c) => c.method === "memory.clearMemory").map((c) => c.params)).toEqual([
    { scope: "project", key: "other-12345678" },
  ]);

  f.close();
});

it("没有任何记忆也没有其他项目时开关组照常显示，下面显示「没有记忆」且不带按钮", async () => {
  const f = fakeServer(
    withInit({
      "memory.describeMemory": desc({
        global: scope({ enabled: true, entries: [] }),
        project: scope({ enabled: false, dir: "C:/nocturne/memory/projects/ws-1", entries: [] }),
        otherProjects: [],
      }),
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot="Z:/ws"
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );

  expect(await screen.findByText("没有记忆")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "全局记忆" })).toBeTruthy();
  expect(screen.getByRole("switch", { name: "项目记忆" })).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();

  f.close();
});

it("runtime.providersChanged 触发刷新且迟到响应不覆盖新快照", async () => {
  let callIndex = 0;
  let releaseFirst!: (value: MemoryDescription) => void;
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () => {
        callIndex++;
        if (callIndex === 1) {
          return new Promise<MemoryDescription>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return desc({
          global: scope({ entries: [meta({ name: "fresh-memory" })] }),
        });
      },
    }),
  );
  await f.initialize();
  render(
    <MemoryPage
      client={f.client}
      workspaceRoot={undefined}
      version={0}
      openDirectory={vi.fn()}
      openUrl={vi.fn()}
    />,
  );

  await waitFor(() => {
    expect(callIndex).toBe(1);
  });

  act(() => {
    f.notify("runtime.providersChanged", {});
  });
  await screen.findByText("fresh-memory");

  await act(async () => {
    releaseFirst(
      desc({
        global: scope({ entries: [meta({ name: "stale-memory" })] }),
      }),
    );
  });
  expect(screen.getByText("fresh-memory")).toBeTruthy();
  expect(screen.queryByText("stale-memory")).toBeNull();

  f.close();
});
