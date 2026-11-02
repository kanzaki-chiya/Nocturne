import { useState } from "react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleTaskOverview } from "@nocturne/core/protocol";
import { RPC_PROTOCOL_VERSION, type RpcClient, type RpcParams } from "@nocturne/rpc/client";

import { App } from "../src/App";
import type { DesktopHost } from "../src/host";
import {
  designResults,
  SearchDialog,
  type SessionMatch,
  type SettledSearch,
} from "../src/SearchDialog";
import { projectKey, type ProjectNode, type SessionSummary } from "../src/session-tree";
import type { BackendMessage } from "../src/types";

const NOW = new Date("2026-11-02T12:00:00Z").getTime();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeSession(
  id: string,
  cwd: string,
  mtimeMs: number,
  firstText: string,
  extra?: Partial<SessionSummary>,
): SessionSummary {
  return {
    id,
    createdAt: "2026-11-01T00:00:00Z",
    cwd,
    workspaceRoot: cwd,
    model: { provider: "test", model: "cheap" },
    mtimeMs,
    firstText,
    ...extra,
  };
}

function makeProject(p: string, name: string, count = 1): ProjectNode {
  return {
    key: projectKey(p),
    name,
    path: p,
    count,
    sessions: [],
    moreCount: 0,
    manual: false,
  };
}

function makeSchedule(
  id: string,
  name: string,
  prompt: string,
  startedAt?: string,
): ScheduleTaskOverview {
  return {
    id,
    name,
    prompt,
    workspace: "Z:\\nocturne",
    model: "test/cheap",
    reasoningEffort: "low",
    permissionPreset: "default",
    schedule: { type: "daily", time: "09:00" },
    enabled: true,
    maxDurationMinutes: 60,
    createdAt: "2026-11-01T00:00:00Z",
    running: false,
    ...(startedAt !== undefined
      ? {
          lastRun: {
            id: `run-${id}`,
            taskId: id,
            scheduledAt: startedAt,
            startedAt,
            trigger: "schedule",
            result: "done",
          },
        }
      : {}),
    stats: { last7Days: { runs: 1, skipped: 0 } },
  };
}

describe("SearchDialog 组件", () => {
  function progressive(
    initial: SettledSearch = {
      query: "旧",
      matches: [{ sessionId: "s0", mtimeMs: 3, snippet: "旧片段" }],
    },
  ) {
    const calls: {
      input: RpcParams<"runtime.searchSessions">;
      resolve: (matches: SessionMatch[]) => void;
    }[] = [];
    const listeners = new Set<(value: { searchId: string; results: SessionMatch[] }) => void>();
    const captured: ((value: { searchId: string; results: SessionMatch[] }) => void)[] = [];
    const api = {
      searchSessions: vi.fn(
        (input: RpcParams<"runtime.searchSessions">) =>
          new Promise<SessionMatch[]>((resolve) => calls.push({ input, resolve })),
      ),
    };
    const client = {
      onNotification: ((_method, listener) => {
        const handler = listener as (value: { searchId: string; results: SessionMatch[] }) => void;
        listeners.add(handler);
        captured.push(handler);
        return () => listeners.delete(handler);
      }) as RpcClient["onNotification"],
    };
    const onOpen = vi.fn();
    const onSettled = vi.fn();
    function Harness() {
      const [query, setQuery] = useState("旧");
      const [settled, setSettled] = useState(initial);
      return (
        <SearchDialog
          api={api}
          client={client}
          sessions={[
            makeSession("s0", "Z:/repo", 3, "旧标题"),
            makeSession("s1", "Z:/repo", 2, "新会话一"),
            makeSession("s2", "Z:/repo", 1, "新会话二"),
          ]}
          projects={[makeProject("Z:/new", "新项目"), makeProject("Z:/old", "旧项目")]}
          schedules={[
            makeSchedule("new", "新任务", "新内容"),
            makeSchedule("old", "旧任务", "旧内容"),
          ]}
          hiddenProjects={new Set()}
          query={query}
          settled={settled}
          onQueryChange={setQuery}
          onSettledChange={(value) => {
            onSettled(value);
            setSettled(value);
          }}
          onClose={vi.fn()}
          onOpen={onOpen}
        />
      );
    }
    const view = render(<Harness />);
    const notify = (index: number, results: SessionMatch[]) => {
      const searchId = calls[index]?.input.searchId ?? "missing";
      for (const listener of listeners) listener({ searchId, results });
    };
    return { ...view, calls, notify, captured, onOpen, onSettled };
  }

  it("本地立即过滤，旧行用旧词高亮，首批替换后续追加，身份选中不随组变长移动，最终响应校准", async () => {
    vi.useFakeTimers();
    const h = progressive();
    const input = screen.getByRole("textbox", { name: "搜索" });
    fireEvent.change(input, { target: { value: "新" } });
    expect(screen.getByRole("option", { name: /新项目/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /新任务/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /旧项目/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /旧任务/ })).toBeNull();
    const old = screen.getAllByRole("option")[0];
    expect(old?.querySelector("mark")?.textContent).toBe("旧");
    expect(h.calls).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    act(() => h.notify(0, [{ sessionId: "s1", mtimeMs: 2 }]));
    expect(screen.queryByText("旧标题")).toBeNull();
    const project = screen
      .getAllByRole("option")
      .find((item) => item.textContent?.includes("新项目"));
    if (!project) throw new Error("缺少项目行");
    fireEvent.mouseMove(project);
    expect(project.getAttribute("aria-selected")).toBe("true");
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    act(() => h.notify(0, [{ sessionId: "s2", mtimeMs: 1 }]));
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(project.getAttribute("aria-selected")).toBe("true");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onOpen).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: `project:${projectKey("Z:/new")}` }),
    );
    await act(async () => h.calls[0]?.resolve([{ sessionId: "s1", mtimeMs: 2 }]));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(project.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(input, { target: { value: "新会话" } });
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("第一次查询不显示未过滤的会话；没动过选中时高亮跟随第一行", async () => {
    vi.useFakeTimers();
    const h = progressive({ query: "", matches: [] });
    expect(screen.queryByText("新会话一")).toBeNull();
    const first = screen.getAllByRole("option")[0];
    expect(first?.textContent).toContain("旧项目");
    expect(first?.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    act(() => h.notify(0, [{ sessionId: "s1", mtimeMs: 2 }]));
    const rows = screen.getAllByRole("option");
    expect(rows[0]?.textContent).toContain("新会话一");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索" }), { key: "Enter" });
    expect(h.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "s1" }));
  });

  it("扫描中空白，结束才显示没有结果；IME冻结本地列表，过期通知与返回和关闭后的通知无效", async () => {
    vi.useFakeTimers();
    const h = progressive({ query: "旧", matches: [] });
    const input = screen.getByRole("textbox", { name: "搜索" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "新" } });
    expect(screen.getByRole("option", { name: /旧项目/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /新项目/ })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(h.calls).toHaveLength(0);
    fireEvent.compositionEnd(input);
    expect(screen.getByRole("option", { name: /新项目/ })).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    fireEvent.change(input, { target: { value: "无命中" } });
    expect(screen.queryByText("没有结果")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    act(() => h.notify(0, [{ sessionId: "s0", mtimeMs: 3 }]));
    await act(async () => h.calls[0]?.resolve([{ sessionId: "s0", mtimeMs: 3 }]));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByText("没有结果")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    expect(screen.queryByText("没有结果")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "项目" }));
    expect(screen.getByText("没有结果")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    await act(async () => h.calls[1]?.resolve([]));
    expect(screen.getByText("没有结果")).toBeTruthy();
    fireEvent.change(input, { target: { value: "关闭" } });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    h.unmount();
    h.onSettled.mockClear();
    act(() => {
      for (const listener of h.captured)
        listener({
          searchId: h.calls[2]?.input.searchId ?? "",
          results: [{ sessionId: "s0", mtimeMs: 3 }],
        });
    });
    await act(async () => h.calls[2]?.resolve([]));
    expect(h.onSettled).not.toHaveBeenCalled();
  });

  it("空输入显示「最近使用」且全部栏最多 8 条，切栏显示全量，设计栏为空，不调 searchSessions", () => {
    const searchSessions = vi.fn(async () => []);
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession(`s${i}`, "Z:\\repo-a", NOW - (i + 1) * 60_000, `会话 ${i}`),
    );
    const projects = [makeProject("Z:\\repo-a", "repo-a"), makeProject("Z:\\repo-b", "repo-b")];
    const schedules = [
      makeSchedule("t1", "每日巡检", "检查构建", new Date(NOW - 30_000).toISOString()),
      makeSchedule("t2", "周报汇总", "汇总变更", new Date(NOW - 500_000).toISOString()),
    ];

    render(
      <SearchDialog
        api={{ searchSessions }}
        sessions={sessions}
        projects={projects}
        hiddenProjects={new Set()}
        schedules={schedules}
        query=""
        settled={{ query: "", matches: [] }}
        onQueryChange={vi.fn()}
        onSettledChange={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(searchSessions).not.toHaveBeenCalled();
    expect(screen.getByText("最近使用")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(designResults()).toEqual([]);

    fireEvent.click(screen.getByRole("tab", { name: "会话" }));
    expect(screen.getAllByRole("option")).toHaveLength(6);

    fireEvent.click(screen.getByRole("tab", { name: "项目" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.click(screen.getByRole("tab", { name: "定时任务" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.click(screen.getByRole("tab", { name: "设计" }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("没有结果")).toBeTruthy();
  });

  it("方向键循环选中，光标在输入框首尾时左右键循环切栏，中间时不切栏", () => {
    const sessions = [
      makeSession("s1", "Z:\\repo", NOW - 1000, "第一条"),
      makeSession("s2", "Z:\\repo", NOW - 2000, "第二条"),
    ];
    render(
      <SearchDialog
        api={{ searchSessions: vi.fn(async () => []) }}
        sessions={sessions}
        projects={[makeProject("Z:\\repo", "repo")]}
        hiddenProjects={new Set()}
        schedules={[]}
        query="abc"
        settled={{
          query: "abc",
          matches: [
            { sessionId: "s1", mtimeMs: NOW - 1000 },
            { sessionId: "s2", mtimeMs: NOW - 2000 },
          ],
        }}
        onQueryChange={vi.fn()}
        onSettledChange={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "搜索" }) as HTMLInputElement;
    input.focus();
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");

    // 光标在中间（位置 1）：左右键不切栏
    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "全部" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "全部" }).getAttribute("aria-selected")).toBe("true");

    // 光标在末尾：ArrowRight 切到「会话」
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "会话" }).getAttribute("aria-selected")).toBe("true");

    // 光标在开头：ArrowLeft 切回「全部」，再按一次循环到「定时任务」
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "全部" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "定时任务" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("输入法组字期间不发起搜索、不响应导航键；150ms 防抖且过期结果不覆盖新结果，等待期间保留上次列表", async () => {
    vi.useFakeTimers();
    const resolvers = new Map<string, (matches: SessionMatch[]) => void>();
    const searchSessions = vi.fn(
      ({ query }: { query: string }) =>
        new Promise<SessionMatch[]>((resolve) => {
          resolvers.set(query, resolve);
        }),
    );
    const sessions = [
      makeSession("s1", "Z:\\repo", NOW - 1000, "旧结果会话"),
      makeSession("s2", "Z:\\repo", NOW - 2000, "新结果会话"),
    ];
    let query = "";
    let settled: SettledSearch = { query: "", matches: [] };
    const onClose = vi.fn();

    const { rerender } = render(
      <SearchDialog
        api={{ searchSessions }}
        sessions={sessions}
        projects={[makeProject("Z:\\repo", "repo")]}
        hiddenProjects={new Set()}
        schedules={[]}
        query={query}
        settled={settled}
        onQueryChange={(next) => {
          query = next;
        }}
        onSettledChange={(next) => {
          settled = next;
        }}
        onClose={onClose}
        onOpen={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "搜索" });
    fireEvent.compositionStart(input);
    query = "旧";
    rerender(
      <SearchDialog
        api={{ searchSessions }}
        sessions={sessions}
        projects={[makeProject("Z:\\repo", "repo")]}
        hiddenProjects={new Set()}
        schedules={[]}
        query={query}
        settled={settled}
        onQueryChange={(next) => {
          query = next;
        }}
        onSettledChange={(next) => {
          settled = next;
        }}
        onClose={onClose}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(searchSessions).not.toHaveBeenCalled();

    // 结束组字后 150ms 才发起第一次搜索
    fireEvent.compositionEnd(input);
    await act(async () => {
      vi.advanceTimersByTime(140);
    });
    expect(searchSessions).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(searchSessions).toHaveBeenCalledWith({ query: "旧", searchId: expect.any(String) });
    // 从最近使用开始的第一次查询，结果未返回前不把未过滤的会话当结果显示
    expect(screen.queryByRole("option", { name: /旧结果会话/ })).toBeNull();

    // 紧接着输入新查询「新」
    query = "新";
    rerender(
      <SearchDialog
        api={{ searchSessions }}
        sessions={sessions}
        projects={[makeProject("Z:\\repo", "repo")]}
        hiddenProjects={new Set()}
        schedules={[]}
        query={query}
        settled={settled}
        onQueryChange={(next) => {
          query = next;
        }}
        onSettledChange={(next) => {
          settled = next;
        }}
        onClose={onClose}
        onOpen={vi.fn()}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(searchSessions).toHaveBeenCalledWith({ query: "新", searchId: expect.any(String) });

    // 新请求先返回
    await act(async () => {
      resolvers.get("新")?.([
        {
          sessionId: "s2",
          mtimeMs: NOW - 2000,
          snippet: "命中了新词内容",
          ranges: [{ start: 3, end: 4 }],
          seq: 2,
        },
      ]);
    });
    rerender(
      <SearchDialog
        api={{ searchSessions }}
        sessions={sessions}
        projects={[makeProject("Z:\\repo", "repo")]}
        hiddenProjects={new Set()}
        schedules={[]}
        query={query}
        settled={settled}
        onQueryChange={(next) => {
          query = next;
        }}
        onSettledChange={(next) => {
          settled = next;
        }}
        onClose={onClose}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("option")[0]?.textContent).toContain("新结果会话");
    expect(screen.getAllByRole("option")[0]?.textContent).toContain("命中了新词内容");

    // 旧请求晚到，不得覆盖新结果
    await act(async () => {
      resolvers.get("旧")?.([{ sessionId: "s1", mtimeMs: NOW - 1000 }]);
    });
    expect(settled.query).toBe("新");
    expect(settled.matches.map((m) => m.sessionId)).toEqual(["s2"]);
  });

  it("已移除项目（hiddenProjects）及其会话不出现在任何结果里", () => {
    const sessions = [
      makeSession("s-hidden", "Z:\\hidden-repo", NOW - 1000, "隐藏项目会话"),
      makeSession("s-visible", "Z:\\visible-repo", NOW - 2000, "可见项目会话"),
    ];
    const projects = [
      makeProject("Z:\\hidden-repo", "hidden-repo"),
      makeProject("Z:\\visible-repo", "visible-repo"),
    ];
    render(
      <SearchDialog
        api={{ searchSessions: vi.fn(async () => []) }}
        sessions={sessions}
        projects={projects}
        hiddenProjects={new Set([projectKey("Z:\\hidden-repo")])}
        schedules={[]}
        query="项目"
        settled={{
          query: "项目",
          matches: [
            { sessionId: "s-hidden", mtimeMs: NOW - 1000 },
            { sessionId: "s-visible", mtimeMs: NOW - 2000 },
          ],
        }}
        onQueryChange={vi.fn()}
        onSettledChange={vi.fn()}
        onClose={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByText("隐藏项目会话")).toBeNull();
    expect(screen.getAllByRole("option")[0]?.textContent).toContain("可见项目会话");
  });
});

function createTestHost() {
  const channels = new Map<number, (message: BackendMessage) => void>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cheap = { provider: "test", model: "cheap" };
  const sessions = [
    makeSession("alpha", "Z:/qa-alpha", NOW - 60_000, "alpha 会话"),
    makeSession("beta", "Z:/qa-beta", NOW - 120_000, "beta 会话"),
  ];
  const schedules = [
    makeSchedule("daily", "每日构建检查", "运行 pnpm test 并汇报", "2026-11-02T09:00:00Z"),
  ];
  const host: DesktopHost & { calls: typeof calls } = {
    calls,
    createChannel: (onMessage) => onMessage,
    openUrl: async () => undefined,
    openPath: async () => undefined,
    revealItem: async () => undefined,
    detectEditors: async () => ({ vscode: false, cursor: false }),
    openInEditor: async () => undefined,
    pickFolder: async () => null,
    pickImages: async () => [],
    homeDir: async () => "C:/Users/me",
    appVersion: async () => "0.0.0-test",
    checkUpdate: async () => null,
    relaunch: async () => undefined,
    note: () => undefined,
    notify: async () => ({ shown: true }),
    dismissNotification: async () => undefined,
    requestAttention: async () => undefined,
    onNotificationActivated: () => () => undefined,
    invoke: async (command, args) => {
      if (command === "node_probe") return { ok: true };
      if (command === "plain_workspace") return "Z:/plain";
      if (command === "app_note" || command === "backend_close") return;
      if (command === "shell_log" || command === "key_diag_log" || command === "backend_stderr")
        return [];
      if (command === "backend_open") {
        const channel = args?.channel as (message: BackendMessage) => void;
        const id = channels.size + 1;
        channels.set(id, channel);
        return id;
      }
      if (command !== "backend_send") throw new Error(`未处理命令 ${command}`);
      const backendId = Number(args?.backendId);
      const channel = channels.get(backendId);
      const req = JSON.parse(String(args?.line)) as {
        id: number;
        method: string;
        params: Record<string, unknown> & { sessionId?: string; query?: string };
      };
      calls.push({ method: req.method, params: req.params });
      const sid = req.params.sessionId;
      let result: unknown = null;
      switch (req.method) {
        case "initialize":
          result = { protocolVersion: RPC_PROTOCOL_VERSION, nocturneVersion: "test" };
          break;
        case "runtime.listSessions":
          result = sessions;
          break;
        case "runtime.searchSessions":
          result =
            req.params.query === "工具命中词"
              ? [
                  {
                    sessionId: "beta",
                    mtimeMs: NOW - 120_000,
                    snippet: "工具输出里包含工具命中词",
                    ranges: [{ start: 7, end: 12 }],
                    seq: 4,
                  },
                ]
              : [];
          break;
        case "schedule.list":
          result = { tasks: schedules, scheduler: { running: true }, warnings: [] };
          break;
        case "schedule.history":
          result = [];
          break;
        case "runtime.listModels":
          result = [{ ref: cheap, capabilities: {} }];
          break;
        case "runtime.listRecentModels":
          result = [cheap];
          break;
        case "runtime.defaultModel":
          result = cheap;
          break;
        case "runtime.listReviewerProviders":
        case "grants.workspaces":
        case "grants.list":
          result = [];
          break;
        case "runtime.describeSettings":
          result = [
            { key: "reasoningEffort", effective: "low" },
            { key: "permissions.preset", effective: "default" },
          ];
          break;
        case "runtime.resumeSession":
          result = {
            sessionId: sid,
            meta: { id: sid, cwd: `Z:/qa-${sid}` },
            config: { model: cheap, permissionPreset: "default" },
            warnings: [],
            lastSeq: 4,
          };
          break;
        case "session.subscribe":
          [
            {
              type: "message.user",
              seq: 1,
              payload: { messageId: "u1", content: [{ type: "text", text: `${sid} 提问` }] },
            },
            { type: "turn.started", seq: 2, payload: { turnIndex: 1 } },
            {
              type: "tool.started",
              seq: 3,
              payload: {
                callId: "c1",
                name: "read",
                input: { path: "readme.md" },
                subjects: [{ kind: "read", target: "readme.md" }],
                permission: { action: "allow", source: "preset" },
              },
            },
            {
              type: "tool.completed",
              seq: 4,
              payload: {
                callId: "c1",
                name: "read",
                status: "ok",
                modelContent: "工具输出里包含工具命中词",
              },
            },
          ].forEach((ev) => {
            channel?.({
              kind: "lines",
              lines: [
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "event",
                  params: {
                    sessionId: sid,
                    event: {
                      ...ev,
                      sessionId: sid,
                      turnId: "t1",
                      time: "2026-11-02T00:00:00Z",
                    },
                  },
                }),
              ],
            });
          });
          result = { lastSeq: 4 };
          break;
        case "session.state":
          result = { config: { model: cheap, permissionPreset: "default" } };
          break;
        case "session.describeContext":
          result = {
            report: { estimatedTokens: 0, budgetTokens: 1000, totalChars: 0, sections: [] },
          };
          break;
        case "session.shellInfo":
          result = {
            selected: "pwsh",
            source: "settings",
            effective: { kind: "pwsh", name: "pwsh", path: "pwsh.exe" },
          };
          break;
        case "session.listShells":
        case "session.rewindTargets":
        case "session.turnChanges":
        case "session.listGrants":
        case "session.mcpServers":
        case "session.fileIndex":
        case "subagent.list":
        case "subagent.worktrees":
          result = [];
          break;
        case "session.reasoningEffortInfo":
          result = { current: "off", effective: "off", available: ["low", "high"] };
          break;
        case "session.visionInfo":
          result = { imageInput: true, available: true };
          break;
        case "session.pendingInputs":
          result = { items: [] };
          break;
        case "session.describeSkills":
        case "skills.describeSkills":
          result = { skills: [], warnings: [], budgetChars: 4000, usedChars: 0 };
          break;
        case "session.describeExternalAgents":
        case "agents.describeExternalAgents":
          result = { agents: [], warnings: [] };
          break;
        case "remote.describe":
          result = {
            enabled: false,
            registered: false,
            connected: false,
            devices: [],
            agents: [],
            pendingAgentPairings: [],
          };
          break;
        default:
          result = {};
      }
      channel?.({
        kind: "lines",
        lines: [JSON.stringify({ jsonrpc: "2.0", id: req.id, result })],
      });
    },
  };
  return host;
}

describe("桌面端跨会话搜索集成", () => {
  it("Ctrl+K 开关、终端焦点不打开、设置页内 Esc 只关弹窗不退设置页、打开工具命中自动展开", async () => {
    const host = createTestHost();
    render(<App host={host} />);
    await screen.findByText("alpha 会话");

    // 焦点在 .xterm 内时 Ctrl+K 不打开弹窗
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const termInput = document.createElement("textarea");
    xterm.appendChild(termInput);
    document.body.appendChild(xterm);
    termInput.focus();
    fireEvent.keyDown(termInput, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "搜索" })).toBeNull();
    xterm.remove();

    // 进入设置页，按 Ctrl+K 打开搜索弹窗
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("button", { name: /返回/ });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "搜索" });
    expect(dialog).toBeTruthy();

    // 在设置页打开弹窗时按 Esc：只关闭弹窗，仍留在设置页
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "搜索" })).toBeNull();
    expect(screen.getByRole("button", { name: /返回/ })).toBeTruthy();

    // 再次按 Ctrl+K 打开，输入「工具命中词」搜索并回车打开会话结果
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "搜索" });
    fireEvent.change(input, { target: { value: "工具命中词" } });
    await waitFor(
      () => {
        expect(screen.getAllByRole("option")[0]?.textContent).toContain("工具输出里包含工具命中词");
      },
      { timeout: 2000 },
    );
    fireEvent.keyDown(input, { key: "Enter" });

    // 关闭弹窗并离开设置页，打开 beta 会话且工具输出已展开可见
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "搜索" })).toBeNull();
      expect(screen.queryByRole("button", { name: /返回/ })).toBeNull();
    });
    expect(await screen.findByText("工具输出里包含工具命中词")).toBeTruthy();

    // 离开再切回：跳转已作废，工具行回到默认折叠，不再高亮
    fireEvent.click(screen.getByText("alpha 会话"));
    await waitFor(() => {
      expect(screen.queryByText("工具输出里包含工具命中词")).toBeNull();
    });
    const betaRow = document.querySelector<HTMLElement>(
      '[data-project-key="z:\\\\qa-beta"] .nav.sub .item',
    );
    expect(betaRow).not.toBeNull();
    if (betaRow !== null) fireEvent.click(betaRow);
    await waitFor(() => {
      expect(document.querySelector("article.tool, .tool")).not.toBeNull();
    });
    expect(screen.queryByText("工具输出里包含工具命中词")).toBeNull();
    expect(document.querySelector(".search-hit")).toBeNull();

    // 折叠 qa-alpha 项目组，再通过搜索打开该项目：项目组自动展开且不新建会话
    const alphaGroup = document.querySelector<HTMLElement>('[data-project-key="z:\\\\qa-alpha"]');
    alphaGroup?.querySelector<HTMLButtonElement>(".gh-toggle")?.click();
    await waitFor(() => {
      expect(alphaGroup?.querySelector(".nav.sub")).toBeNull();
    });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input2 = await screen.findByRole("textbox", { name: "搜索" });
    fireEvent.change(input2, { target: { value: "qa-alpha" } });
    fireEvent.click(screen.getByRole("tab", { name: "项目" }));
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
    fireEvent.keyDown(input2, { key: "Enter" });
    await waitFor(() => {
      expect(alphaGroup?.querySelector(".nav.sub")).not.toBeNull();
    });

    // 通过搜索打开定时任务：进入定时任务管理页并选中该任务
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input3 = await screen.findByRole("textbox", { name: "搜索" });
    fireEvent.change(input3, { target: { value: "pnpm test" } });
    fireEvent.click(screen.getByRole("tab", { name: "定时任务" }));
    await waitFor(() => {
      expect(screen.getAllByRole("option")[0]?.textContent).toContain("每日构建检查");
    });
    fireEvent.keyDown(input3, { key: "Enter" });
    expect(await screen.findByDisplayValue("每日构建检查")).toBeTruthy();
  });

  it("手机端（src/web/）不包含跨会话搜索入口也不调用 searchSessions", () => {
    const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/web");
    const files = readdirSync(webDir).filter((name) => /\.(ts|tsx)$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(path.join(webDir, file), "utf8");
      expect(content).not.toContain("searchSessions");
      expect(content).not.toContain("SearchDialog");
    }
  });
});
