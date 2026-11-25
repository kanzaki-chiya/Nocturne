import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  MemoryDescription,
  MemoryEntry,
  MemoryEntryMeta,
  MemoryScopeOverview,
  OtherProjectMemory,
} from "@nocturne/core/protocol";
import { MemoryPage } from "../src/MemoryPage";
import { fakeServer, RpcFail, withInit } from "./fake-server";

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

const projectEntries = (count: number): MemoryEntryMeta[] =>
  Array.from({ length: count }, (_, i) =>
    meta({
      name: `rule-${String(i + 1).padStart(2, "0")}`,
      description: `Rule ${i + 1} description`,
      type: (["user", "feedback", "project", "reference"] as const)[i % 4] ?? "user",
    }),
  );

const otherProject = (overrides: Partial<OtherProjectMemory> = {}): OtherProjectMemory => {
  const entries = overrides.entries ?? projectEntries(2);
  return {
    key: "alpha-12345678",
    path: "Z:/code/alpha",
    count: entries.length,
    entries,
    ...overrides,
  };
};

const desc = (overrides: Partial<MemoryDescription> = {}): MemoryDescription => ({
  global: scope(),
  otherProjects: [],
  ...overrides,
});

function renderMemoryPage(
  f: ReturnType<typeof fakeServer>,
  workspaceRoot: string | undefined = undefined,
) {
  return render(
    <MemoryPage
      client={f.client}
      workspaceRoot={workspaceRoot}
      version={0}
      openDirectory={vi.fn().mockResolvedValue(undefined)}
      openUrl={vi.fn()}
    />,
  );
}

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
  renderMemoryPage(f);

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
  renderMemoryPage(f, "Z:/demo");

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

it("其他项目静态展示全部行：项目名、完整路径、条数、清空与进入箭头；清空取消不调 RPC，确认调用 clearMemory", async () => {
  let others = [
    otherProject({
      key: "alpha-12345678",
      path: "Z:/code/alpha",
      entries: projectEntries(3),
    }),
    otherProject({
      key: "alpha-87654321",
      path: "D:/work/alpha",
      entries: projectEntries(2),
    }),
  ];
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
  renderMemoryPage(f, "Z:/current");

  // 「其他项目」是静态分组标题，进入总览直接展示全部项目，没有折叠开关
  const region = await screen.findByRole("region", { name: "其他项目 · 2" });
  expect(screen.queryByRole("button", { name: /其他项目/ })).toBeNull();

  // 同名项目按两行排版与完整路径区分（ADR-0122 §1）
  const rows = within(region).getAllByText("alpha", { exact: true });
  expect(rows).toHaveLength(2);
  expect(within(region).getByText("Z:/code/alpha")).toBeTruthy();
  expect(within(region).getByText("D:/work/alpha")).toBeTruthy();
  expect(within(region).getByText("3 条")).toBeTruthy();
  expect(within(region).getByText("2 条")).toBeTruthy();

  const firstRow = within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement;
  fireEvent.click(within(firstRow).getByRole("button", { name: "清空" }));
  const cancelDlg = screen.getByRole("dialog", { name: "清空 Z:/code/alpha 的记忆？" });
  fireEvent.click(within(cancelDlg).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.calls.filter((c) => c.method === "memory.clearMemory")).toHaveLength(0);

  fireEvent.click(within(firstRow).getByRole("button", { name: "清空" }));
  const confirmDlg = screen.getByRole("dialog", { name: "清空 Z:/code/alpha 的记忆？" });
  fireEvent.click(within(confirmDlg).getByRole("button", { name: "清空" }));

  await waitFor(() => {
    expect(screen.queryByText("Z:/code/alpha")).toBeNull();
  });
  expect(within(region).getByText("D:/work/alpha")).toBeTruthy();
  expect(f.calls.filter((c) => c.method === "memory.clearMemory").map((c) => c.params)).toEqual([
    { scope: "project", key: "alpha-12345678" },
  ]);
  // 清空按钮不触发进入项目子页
  expect(screen.queryByRole("button", { name: "记忆" })).toBeNull();

  f.close();
});

it("点项目行进入子页：面包屑、完整路径、条数与条目；点条目读正文按 key+name 寻址", async () => {
  const entries = [
    meta({ name: "feedback-testing", description: "Run affected tests", type: "feedback" }),
    meta({ name: "release-flow", description: "Push main first", type: "project" }),
  ];
  const proj = otherProject({ key: "alpha-12345678", path: "Z:/code/alpha", entries });
  const entryDetail: MemoryEntry = {
    scope: "project",
    name: "feedback-testing",
    description: "Run affected tests",
    type: "feedback",
    updatedAt: "2026-11-24T16:22:00.000Z",
    content: "Run `pnpm verify` locally.",
    raw: "---\nname: feedback-testing\n---\nRun `pnpm verify` locally.\n",
  };
  const openDirectory = vi.fn().mockResolvedValue(undefined);
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [proj],
        }),
      "memory.readMemory": entryDetail,
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

  const region = await screen.findByRole("region", { name: "其他项目 · 1" });
  const row = within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /alpha/ }));

  // 子页页头：记忆 › Z:/code/alpha，N 条
  expect(await screen.findByRole("button", { name: "记忆" })).toBeTruthy();
  const head = document.querySelector(".phead h1");
  expect(head?.textContent).toContain("Z:/code/alpha");
  expect(head?.textContent).toContain("2 条");

  const listRegion = screen.getByRole("region", { name: "Z:/code/alpha · 2" });
  expect(within(listRegion).getByText("feedback-testing")).toBeTruthy();
  expect(within(listRegion).getByText("release-flow")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
  expect(openDirectory).toHaveBeenCalledWith("C:/nocturne/memory/projects/alpha-12345678");

  fireEvent.click(within(listRegion).getByRole("button", { name: /feedback-testing/ }));
  await screen.findByText("Run", { exact: false });
  const reads = f.calls.filter((c) => c.method === "memory.readMemory").map((c) => c.params);
  expect(reads).toEqual([{ scope: "project", key: "alpha-12345678", name: "feedback-testing" }]);

  // 详情面包屑是项目路径而不是「记忆」
  const crumb = document.querySelector(".phead .crumb");
  expect(crumb?.textContent).toBe("Z:/code/alpha");

  f.close();
});

it("跨项目同名条目：读取与删除按所选项目的 key 定位，取消后两边数据完整", async () => {
  const alpha = otherProject({
    key: "alpha-12345678",
    path: "Z:/code/alpha",
    entries: [
      meta({ name: "feedback-testing", description: "Alpha tests", type: "feedback" }),
      meta({ name: "alpha-only", description: "Alpha only", type: "project" }),
    ],
  });
  const beta = otherProject({
    key: "beta-87654321",
    path: "D:/code/beta",
    entries: [
      meta({ name: "feedback-testing", description: "Beta tests", type: "feedback" }),
      meta({ name: "beta-only", description: "Beta only", type: "reference" }),
    ],
  });
  let alphaEntries = [...alpha.entries];
  let betaEntries = [...beta.entries];
  const rebuild = () => [
    otherProject({ ...alpha, entries: alphaEntries, count: alphaEntries.length }),
    otherProject({ ...beta, entries: betaEntries, count: betaEntries.length }),
  ];
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: rebuild(),
        }),
      "memory.readMemory": (params: Record<string, unknown>) => ({
        scope: "project",
        name: String(params.name),
        description: `${String(params.key)} content`,
        type: "feedback",
        updatedAt: "2026-11-24T16:22:00.000Z",
        content: `Content of ${String(params.key)} / ${String(params.name)}`,
        raw: "raw",
      }),
      "memory.deleteMemory": (params: Record<string, unknown>) => {
        if (params.key === "alpha-12345678") {
          alphaEntries = alphaEntries.filter((e) => e.name !== params.name);
        } else if (params.key === "beta-87654321") {
          betaEntries = betaEntries.filter((e) => e.name !== params.name);
        }
        return null;
      },
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  // 进入 alpha，打开 feedback-testing，取消删除：零调用，两边数据完整
  const region = await screen.findByRole("region", { name: "其他项目 · 2" });
  fireEvent.click(
    within(
      within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /alpha/ }),
  );
  const listRegion = await screen.findByRole("region", { name: "Z:/code/alpha · 2" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /feedback-testing/ }));
  await screen.findByRole("button", { name: "删除" });

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  const dlg = screen.getByRole("dialog", {
    name: "删除 feedback-testing（Z:/code/alpha）？",
  });
  expect(within(dlg).getByText("Z:/code/alpha")).toBeTruthy();
  fireEvent.click(within(dlg).getByRole("button", { name: "取消" }));
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();

  // Esc 取消同样零误删
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  const dlgEsc = screen.getByRole("dialog", {
    name: "删除 feedback-testing（Z:/code/alpha）？",
  });
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(dlgEsc).toBeTruthy();
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory")).toHaveLength(0);

  // 确认删除：只删 alpha 的 feedback-testing，beta 的同名条目仍在
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  const confirmDlg = screen.getByRole("dialog", {
    name: "删除 feedback-testing（Z:/code/alpha）？",
  });
  fireEvent.click(within(confirmDlg).getByRole("button", { name: "删除" }));

  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "✓ 已删除 feedback-testing",
  );
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory").map((c) => c.params)).toEqual([
    { scope: "project", key: "alpha-12345678", name: "feedback-testing" },
  ]);

  // 回到 alpha 列表且数量更新为 1；beta 子页的同名条目还在
  await screen.findByRole("region", { name: "Z:/code/alpha · 1" });
  expect(screen.queryByRole("button", { name: /feedback-testing/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "记忆" }));
  const regionBack = await screen.findByRole("region", { name: "其他项目 · 2" });
  fireEvent.click(
    within(
      within(regionBack).getByText("D:/code/beta").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /beta/ }),
  );
  const betaRegion = await screen.findByRole("region", { name: "D:/code/beta · 2" });
  expect(within(betaRegion).getByText("feedback-testing")).toBeTruthy();
  expect(betaEntries.map((e) => e.name)).toContain("feedback-testing");

  f.close();
});

it("删除失败留在详情可重试，重试成功回到列表", async () => {
  let entries = [
    meta({ name: "alpha-only", description: "Alpha only", type: "project" }),
    meta({ name: "feedback-testing", description: "Alpha tests", type: "feedback" }),
  ];
  let failOnce = true;
  const proj = () =>
    otherProject({ key: "alpha-12345678", path: "Z:/code/alpha", entries: [...entries] });
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [proj()],
        }),
      "memory.readMemory": (params: Record<string, unknown>) => ({
        scope: "project",
        name: String(params.name),
        description: "Alpha tests",
        type: "feedback",
        updatedAt: "2026-11-24T16:22:00.000Z",
        content: "Alpha content",
        raw: "raw",
      }),
      "memory.deleteMemory": (params: Record<string, unknown>) => {
        if (failOnce) {
          failOnce = false;
          return new RpcFail(-32000, "文件被占用");
        }
        entries = entries.filter((e) => e.name !== params.name);
        return null;
      },
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const region = await screen.findByRole("region", { name: "其他项目 · 1" });
  fireEvent.click(
    within(
      within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /alpha/ }),
  );
  const listRegion = await screen.findByRole("region", { name: "Z:/code/alpha · 2" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /feedback-testing/ }));
  await screen.findByRole("button", { name: "删除" });

  // 第一次确认失败：对话框关闭、留在详情、错误显示、条目未删
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "删除 feedback-testing（Z:/code/alpha）？" }),
    ).getByRole("button", { name: "删除" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("文件被占用");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
  expect(entries.map((e) => e.name)).toContain("feedback-testing");

  // 重试成功：回到项目列表，条目消失
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "删除 feedback-testing（Z:/code/alpha）？" }),
    ).getByRole("button", { name: "删除" }),
  );
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "✓ 已删除 feedback-testing",
  );
  await screen.findByRole("region", { name: "Z:/code/alpha · 1" });
  expect(f.calls.filter((c) => c.method === "memory.deleteMemory")).toHaveLength(2);

  f.close();
});

it("删掉最后一条显示项目空态；返回总览后该项目行移除，焦点落到相邻项目", async () => {
  let alphaEntries = [meta({ name: "alpha-only", description: "Alpha only", type: "project" })];
  const betaEntries = projectEntries(2);
  const rebuild = () => [
    ...(alphaEntries.length > 0
      ? [
          otherProject({
            key: "alpha-12345678",
            path: "Z:/code/alpha",
            entries: alphaEntries,
          }),
        ]
      : []),
    otherProject({ key: "beta-87654321", path: "D:/code/beta", entries: betaEntries }),
  ];
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: rebuild(),
        }),
      "memory.readMemory": {
        scope: "project",
        name: "alpha-only",
        description: "Alpha only",
        type: "project",
        updatedAt: "2026-11-24T16:22:00.000Z",
        content: "Alpha content",
        raw: "raw",
      },
      "memory.deleteMemory": (params: Record<string, unknown>) => {
        if (params.key === "alpha-12345678") {
          alphaEntries = alphaEntries.filter((e) => e.name !== params.name);
        }
        return null;
      },
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const region = await screen.findByRole("region", { name: "其他项目 · 2" });
  fireEvent.click(
    within(
      within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /alpha/ }),
  );
  const listRegion = await screen.findByRole("region", { name: "Z:/code/alpha · 1" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /alpha-only/ }));
  await screen.findByRole("button", { name: "删除" });

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "删除 alpha-only（Z:/code/alpha）？" })).getByRole(
      "button",
      { name: "删除" },
    ),
  );

  // 空态仍留在项目子页，页头数量更新为 0
  await screen.findByText("没有记忆");
  const head = document.querySelector(".phead h1");
  expect(head?.textContent).toContain("0 条");
  expect(screen.getByRole("button", { name: "记忆" })).toBeTruthy();

  // 返回总览：alpha 行按空项目规则消失，焦点落到相邻的 beta 行
  fireEvent.click(screen.getByRole("button", { name: "记忆" }));
  const regionBack = await screen.findByRole("region", { name: "其他项目 · 1" });
  expect(within(regionBack).queryByText("Z:/code/alpha")).toBeNull();
  expect(within(regionBack).getByText("D:/code/beta")).toBeTruthy();
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-mem-key="beta-87654321"]')).toBeTruthy();
  });

  f.close();
});

it("快速切换时旧请求迟到不覆盖：返回后迟到的详情与乱序的总览响应都被丢弃", async () => {
  const pendingReads: { name: string; resolve: (value: MemoryEntry) => void }[] = [];
  let releaseStale!: (value: MemoryDescription) => void;
  let describeCalls = 0;
  const entryOf = (name: string, content: string): MemoryEntry => ({
    scope: "project",
    name,
    description: "desc",
    type: "user",
    updatedAt: "2026-11-19T04:00:00.000Z",
    content,
    raw: "raw",
  });
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () => {
        describeCalls++;
        if (describeCalls === 2) {
          // 第二轮总览挂起，稍后以旧数据（2 条）迟到返回
          return new Promise<MemoryDescription>((resolve) => {
            releaseStale = resolve;
          });
        }
        const count = describeCalls === 1 ? 2 : 3;
        return desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [otherProject({ entries: projectEntries(count) })],
        });
      },
      "memory.readMemory": (params: Record<string, unknown>) =>
        new Promise<MemoryEntry>((resolve) => {
          pendingReads.push({ name: String(params.name), resolve });
        }),
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const region = await screen.findByRole("region", { name: "其他项目 · 1" });
  fireEvent.click(
    within(
      within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /alpha/ }),
  );
  const listRegion = await screen.findByRole("region", { name: "Z:/code/alpha · 2" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /rule-01/ }));

  // 详情还在加载时立即返回列表，再连续触发两次刷新：第二轮挂起、第三轮先行返回新数据
  fireEvent.click(await screen.findByRole("button", { name: "Z:/code/alpha" }));
  act(() => {
    f.notify("runtime.providersChanged", {});
  });
  await waitFor(() => {
    expect(describeCalls).toBe(2);
  });
  act(() => {
    f.notify("runtime.providersChanged", {});
  });
  await screen.findByRole("region", { name: "Z:/code/alpha · 3" });

  // 再打开 rule-02 的详情并让它的响应先到，然后迟到的 rule-01 旧响应不得覆盖
  const freshRegion = screen.getByRole("region", { name: "Z:/code/alpha · 3" });
  fireEvent.click(within(freshRegion).getByRole("button", { name: /rule-02/ }));
  await waitFor(() => {
    expect(pendingReads.map((r) => r.name)).toContain("rule-02");
  });
  const read01 = pendingReads.find((r) => r.name === "rule-01");
  const read02 = pendingReads.find((r) => r.name === "rule-02");
  expect(read01 !== undefined).toBe(true);
  expect(read02 !== undefined).toBe(true);
  await act(async () => {
    read02?.resolve(entryOf("rule-02", "fresh content rule-02"));
  });
  await screen.findByText("fresh content rule-02");
  await act(async () => {
    read01?.resolve(entryOf("rule-01", "stale content rule-01"));
  });
  expect(screen.queryByText("stale content rule-01")).toBeNull();
  expect(screen.getByText("fresh content rule-02")).toBeTruthy();

  // 返回列表后，第二轮以旧数据（2 条）迟到返回：代际过期被丢弃，界面保持 3 条不回落
  fireEvent.click(await screen.findByRole("button", { name: "Z:/code/alpha" }));
  await act(async () => {
    releaseStale(
      desc({
        global: scope({ entries: [meta()] }),
        otherProjects: [otherProject({ entries: projectEntries(2) })],
      }),
    );
  });
  expect(screen.getByRole("region", { name: "Z:/code/alpha · 3" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Z:/code/alpha · 2" })).toBeNull();

  f.close();
});

it("焦点恢复限定在当前记忆页：DOM 中更早的其他设置页 .crumb 不抢占", async () => {
  // 模拟 SettingsDeck：另一个设置页（已 hidden）先渲染并保留同名 .crumb 按钮
  const decoy = document.createElement("button");
  decoy.className = "crumb";
  decoy.textContent = "其他设置页";
  const hiddenPage = document.createElement("div");
  hiddenPage.hidden = true;
  hiddenPage.appendChild(decoy);
  document.body.prepend(hiddenPage);

  const entries = projectEntries(30);
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [otherProject({ key: "alpha-12345678", path: "Z:/code/alpha", entries })],
        }),
      "memory.readMemory": (params: Record<string, unknown>) => ({
        scope: "project",
        name: String(params.name),
        description: "desc",
        type: "user",
        updatedAt: "2026-11-19T04:00:00.000Z",
        content: "content",
        raw: "raw",
      }),
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const activeEl = () => document.activeElement as HTMLElement | null;
  const memoryRoot = () => document.querySelector(".memory-page") as HTMLElement;

  // 键盘进入项目子页：焦点必须落在记忆页自己的面包屑，而不是隐藏页的 .crumb
  const region = await screen.findByRole("region", { name: "其他项目 · 1" });
  const alphaRow = within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement;
  const openBtn = within(alphaRow).getByRole("button", { name: /alpha/ });
  openBtn.focus();
  fireEvent.keyDown(openBtn, { key: "Enter" });
  fireEvent.click(openBtn);

  await screen.findByRole("region", { name: "Z:/code/alpha · 30" });
  await waitFor(() => {
    expect(activeEl()?.classList.contains("crumb")).toBe(true);
    expect(memoryRoot().contains(activeEl())).toBe(true);
    expect(hiddenPage.contains(activeEl())).toBe(false);
  });

  // 键盘打开条目详情：同样聚焦记忆页自己的面包屑
  const spage = document.querySelector(".spage") as HTMLElement;
  spage.scrollTop = 90;
  const listRegion = screen.getByRole("region", { name: "Z:/code/alpha · 30" });
  const entryBtn = within(listRegion).getByRole("button", { name: /rule-15/ });
  entryBtn.focus();
  fireEvent.keyDown(entryBtn, { key: "Enter" });
  fireEvent.click(entryBtn);
  await screen.findByText("content");
  await waitFor(() => {
    expect(activeEl()?.classList.contains("crumb")).toBe(true);
    expect(memoryRoot().contains(activeEl())).toBe(true);
    expect(hiddenPage.contains(activeEl())).toBe(false);
  });

  // 返回项目子页：焦点落回 rule-15 行且滚动位置保持
  fireEvent.click(screen.getByRole("button", { name: "Z:/code/alpha" }));
  await screen.findByRole("region", { name: "Z:/code/alpha · 30" });
  expect(spage.scrollTop).toBe(90);
  await waitFor(() => {
    expect(activeEl()?.closest('[data-mem-entry="rule-15"]')).toBeTruthy();
    expect(hiddenPage.contains(activeEl())).toBe(false);
  });

  // 返回总览：焦点落回项目行
  fireEvent.click(screen.getByRole("button", { name: "记忆" }));
  await screen.findByRole("region", { name: "其他项目 · 1" });
  await waitFor(() => {
    expect(activeEl()?.closest('[data-mem-key="alpha-12345678"]')).toBeTruthy();
    expect(hiddenPage.contains(activeEl())).toBe(false);
  });

  hiddenPage.remove();
  f.close();
});

it("逐级返回恢复焦点与滚动位置", async () => {
  const entries = projectEntries(40);
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [
            otherProject({ key: "alpha-12345678", path: "Z:/code/alpha", entries }),
            otherProject({
              key: "beta-87654321",
              path: "D:/code/beta",
              entries: projectEntries(1),
            }),
          ],
        }),
      "memory.readMemory": (params: Record<string, unknown>) => ({
        scope: "project",
        name: String(params.name),
        description: "desc",
        type: "user",
        updatedAt: "2026-11-19T04:00:00.000Z",
        content: "content",
        raw: "raw",
      }),
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const region = await screen.findByRole("region", { name: "其他项目 · 2" });
  const alphaRow = within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement;
  fireEvent.click(within(alphaRow).getByRole("button", { name: /alpha/ }));

  // 进入项目子页时焦点落在面包屑
  await screen.findByRole("region", { name: "Z:/code/alpha · 40" });
  await waitFor(() => {
    expect((document.activeElement as HTMLElement | null)?.classList.contains("crumb")).toBe(true);
  });

  // 滚动项目子页后打开条目
  const spage = document.querySelector(".spage") as HTMLElement;
  spage.scrollTop = 120;
  const listRegion = screen.getByRole("region", { name: "Z:/code/alpha · 40" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /rule-20/ }));
  await screen.findByText("content");
  expect(spage.scrollTop).toBe(0);

  // 返回项目子页：滚动与焦点恢复到 rule-20 行
  fireEvent.click(screen.getByRole("button", { name: "Z:/code/alpha" }));
  await screen.findByRole("region", { name: "Z:/code/alpha · 40" });
  expect(spage.scrollTop).toBe(120);
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-mem-entry="rule-20"]')).toBeTruthy();
  });

  // 返回总览：焦点落回 alpha 项目行
  fireEvent.click(screen.getByRole("button", { name: "记忆" }));
  await screen.findByRole("region", { name: "其他项目 · 2" });
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-mem-key="alpha-12345678"]')).toBeTruthy();
  });

  f.close();
});

it("删除成功后焦点落到相邻条目", async () => {
  let entries = [
    meta({ name: "rule-01", description: "one", type: "user" }),
    meta({ name: "rule-02", description: "two", type: "user" }),
    meta({ name: "rule-03", description: "three", type: "user" }),
  ];
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [meta()] }),
          otherProjects: [
            otherProject({ key: "alpha-12345678", path: "Z:/code/alpha", entries: [...entries] }),
          ],
        }),
      "memory.readMemory": (params: Record<string, unknown>) => ({
        scope: "project",
        name: String(params.name),
        description: "desc",
        type: "user",
        updatedAt: "2026-11-19T04:00:00.000Z",
        content: "content",
        raw: "raw",
      }),
      "memory.deleteMemory": (params: Record<string, unknown>) => {
        entries = entries.filter((e) => e.name !== params.name);
        return null;
      },
    }),
  );
  await f.initialize();
  renderMemoryPage(f);

  const region = await screen.findByRole("region", { name: "其他项目 · 1" });
  fireEvent.click(
    within(
      within(region).getByText("Z:/code/alpha").closest(".slist-row") as HTMLElement,
    ).getByRole("button", { name: /alpha/ }),
  );
  const listRegion = await screen.findByRole("region", { name: "Z:/code/alpha · 3" });
  fireEvent.click(within(listRegion).getByRole("button", { name: /rule-02/ }));
  await screen.findByRole("button", { name: "删除" });

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "删除 rule-02（Z:/code/alpha）？" })).getByRole(
      "button",
      { name: "删除" },
    ),
  );

  // 焦点落到下一条（rule-03）
  await screen.findByRole("region", { name: "Z:/code/alpha · 2" });
  await waitFor(() => {
    const active = document.activeElement as HTMLElement | null;
    expect(active?.closest('[data-mem-entry="rule-03"]')).toBeTruthy();
  });

  f.close();
});

it("当前项目详情删除确认显示 folder 图标与工作区路径", async () => {
  const project = scope({
    dir: "C:/nocturne/memory/projects/demo-11223344",
    entries: [meta({ name: "build-cmd", description: "Run typecheck", type: "project" })],
  });
  const f = fakeServer(
    withInit({
      "memory.describeMemory": () =>
        desc({
          global: scope({ entries: [] }),
          project,
        }),
      "memory.readMemory": {
        scope: "project",
        name: "build-cmd",
        description: "Run typecheck",
        type: "project",
        updatedAt: "2026-11-19T04:00:00.000Z",
        content: "content",
        raw: "raw",
      },
    }),
  );
  await f.initialize();
  renderMemoryPage(f, "Z:/demo-ws");

  const projectRegion = await screen.findByRole("region", { name: "项目 · 1" });
  fireEvent.click(within(projectRegion).getByRole("button", { name: /build-cmd/ }));
  await screen.findByRole("button", { name: "删除" });

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  const dlg = screen.getByRole("dialog", { name: "删除 build-cmd（Z:/demo-ws）？" });
  expect(within(dlg).getByText("Z:/demo-ws")).toBeTruthy();

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
  renderMemoryPage(f, "Z:/ws");

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
  renderMemoryPage(f);

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
