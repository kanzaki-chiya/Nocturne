// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageLibraryItem } from "@nocturne/core/protocol";

import { ArtifactEntryRow } from "../src/InlinePage";
import { PageLibraryPage, type PageLibraryApi } from "../src/PageLibraryPage";
import { parseStoredTabs, storedTabs, type PanelTab } from "../src/side-panel";

afterEach(() => {
  cleanup();
});

describe("Open Artifact UI & persistence (ADR-0125)", () => {
  it("桌面端作品卡可点击打开右侧编辑器；移动端只显示作品信息与桌面打开提示且不暴露回环地址", () => {
    const onOpen = vi.fn();
    const artifact = {
      url: "open-artifact://artifact/design-42",
      id: "design-42",
      title: "双方案设计稿",
      type: "design",
      summary: "2 个画板",
    };

    const { unmount } = render(
      <ArtifactEntryRow artifact={artifact} active={false} onOpenInPanel={onOpen} />,
    );
    const btn = screen.getByRole("button", { name: /双方案设计稿/ });
    expect(btn.textContent).toContain("Design");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    unmount();

    // 移动端（remote=true）：不可点击、提示桌面打开、无 127.0.0.1
    const { container } = render(
      <ArtifactEntryRow artifact={artifact} remote onOpenInPanel={onOpen} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain("双方案设计稿");
    expect(container.textContent).toContain("Design");
    expect(container.textContent).toContain("请在桌面端打开");
    expect(container.innerHTML).not.toContain("127.0.0.1");
    expect(container.innerHTML).not.toContain("localhost");
  });

  it("页面库同库展示旧 HTML 页面与新 Open Artifact 作品并支持按类型检索与打开", async () => {
    const items: PageLibraryItem[] = [
      {
        kind: "artifact",
        origin: { sessionId: "s-1", page: "artifact-design-42" },
        originKey: "artifact:design-42",
        page: "artifact-design-42",
        ref: "open-artifact://artifact/design-42",
        title: "交互设计稿",
        version: 1,
        sessionId: "s-1",
        sessionTitle: "产品改版",
        projectKey: "/repo",
        updatedAt: "2026-11-26T10:00:00.000Z",
        file: "",
        hasUnresolvedComments: false,
        artifact: {
          url: "open-artifact://artifact/design-42",
          id: "design-42",
          type: "design",
          summary: "2 个画板",
        },
      },
      {
        kind: "page",
        origin: { sessionId: "s-legacy", page: "page-1" },
        originKey: "s-legacy/page-1",
        page: "page-1",
        ref: "s-legacy/page-1",
        title: "旧版报表页",
        version: 3,
        sessionId: "s-legacy",
        sessionTitle: "历史报表",
        projectKey: "/repo",
        updatedAt: "2026-11-25T10:00:00.000Z",
        file: "att-1.html",
        hasUnresolvedComments: false,
      },
    ];

    const api: PageLibraryApi = {
      listPageProjects: async () => ({
        currentProjectKey: "/repo",
        currentProjectName: "repo",
        currentProjectIsDefault: false,
        projects: [
          {
            key: "/repo",
            name: "repo",
            isDefault: false,
            pageCount: 2,
            updatedAt: "2026-11-26T10:00:00.000Z",
          },
        ],
      }),
      listPages: async () => ({
        projectKey: "/repo",
        items,
      }),
    };
    const opened: PageLibraryItem[] = [];

    render(
      <PageLibraryPage
        api={api}
        currentWorkspaceRoot="/repo"
        pinnedOriginKeys={new Set()}
        onPin={() => undefined}
        onUnpin={() => undefined}
        onOpenPage={(item) => opened.push(item)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("交互设计稿")).toBeTruthy();
      expect(screen.getByText("旧版报表页")).toBeTruthy();
    });
    expect(screen.getByText("Design")).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();

    fireEvent.click(screen.getByText("交互设计稿"));
    expect(opened[0]?.kind).toBe("artifact");
    expect(opened[0]?.ref).toBe("open-artifact://artifact/design-42");

    // 按类型过滤只显示 design 作品
    const search = screen.getByRole("searchbox", { name: "搜索" });
    fireEvent.change(search, { target: { value: "design" } });
    expect(screen.getByText("交互设计稿")).toBeTruthy();
    expect(screen.queryByText("旧版报表页")).toBeNull();
  });

  it("右侧面板标签持久化只保存稳定 open-artifact:// 标识，过滤非法地址并按 URL 去重", () => {
    const tabs: PanelTab[] = [
      {
        id: "t1",
        kind: "artifact",
        url: "open-artifact://artifact/p1",
        title: "产品首页",
        artifactType: "page",
      },
    ];
    const saved = storedTabs(tabs);
    expect(saved).toEqual([
      {
        id: "t1",
        kind: "artifact",
        url: "open-artifact://artifact/p1",
        title: "产品首页",
        artifactType: "page",
      },
    ]);

    const parsed = parseStoredTabs([
      ...saved,
      {
        id: "t2",
        kind: "artifact",
        url: "open-artifact://artifact/p1",
        title: "重复",
        artifactType: "page",
      },
      {
        id: "t3",
        kind: "artifact",
        url: "http://127.0.0.1:41234/a/p1",
        title: "非法回环",
        artifactType: "page",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(saved[0]);
  });
});
