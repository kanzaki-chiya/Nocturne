/**
 * 子代理标签的内容（ADR-0060 修订（五）第 5–8 条）：状态与耗时、最终结果、非交互拒绝提示、
 * 图片走只读 RPC、错误与重试、只在显示时观察。
 */
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RuntimeEvent, SubagentObservation, SubagentObserver } from "@nocturne/core/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createAttachmentImageSource } from "../src/attachment-images";
import type { SubagentTab } from "../src/side-panel";
import { SubagentPane, type SubagentRuntime } from "../src/SubagentPane";
import { SubagentWatcher } from "../src/subagent-watch";
import {
  assistantMessage,
  durable,
  endOf,
  settled,
  summary,
  taskEntry,
  toolCompleted,
  toolStarted,
  userMessage,
} from "./subagent-fixtures";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tab: SubagentTab = {
  id: "t1",
  kind: "subagent",
  childSessionId: "child-1",
  parentCallId: "call-1",
  profile: "explore",
  taskSummary: "检查依赖方向",
};

function runtimeOf() {
  const subs: { observer: SubagentObserver; unsubscribed: boolean; afterSeq?: number }[] = [];
  const runtime = {
    observeSubagent: vi.fn(
      async (
        input: { afterSeq?: number | undefined },
        observer: SubagentObserver,
      ): Promise<SubagentObservation> => {
        const sub = {
          observer,
          unsubscribed: false,
          ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
        };
        subs.push(sub);
        return {
          lastSeq: 0,
          summary: summary(),
          mode: "live",
          unsubscribe: () => {
            sub.unsubscribed = true;
          },
        };
      },
    ),
    readSubagentAttachment: vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png" as const,
      bytes: 3,
    })),
  } as unknown as SubagentRuntime;
  return { runtime, subs };
}

function mount(
  over: {
    watcher?: SubagentWatcher;
    runtime?: SubagentRuntime | undefined;
    backend?: ReturnType<typeof runtimeOf>;
    visible?: boolean;
    summary?: ReturnType<typeof summary> | undefined;
    parentEntry?: ReturnType<typeof taskEntry> | undefined;
  } = {},
) {
  const backend = over.backend ?? runtimeOf();
  const watcher = over.watcher ?? new SubagentWatcher();
  const images = createAttachmentImageSource();
  const props = {
    tab,
    parentSessionId: "p",
    visible: over.visible ?? true,
    watcher,
    runtime: "runtime" in over ? over.runtime : backend.runtime,
    summary: over.summary,
    parentEntry: over.parentEntry,
    workspace: "Z:/p",
    images,
    openUrl: vi.fn(),
  };
  const view = render(<SubagentPane {...props} />);
  /** 把事件喂给最近一次建立的观察 */
  const feed = (...events: RuntimeEvent[]) => {
    act(() => {
      const observer = backend.subs.at(-1)?.observer;
      if (observer === undefined) throw new Error("还没有观察");
      for (const event of events) observer.onEvent(event);
    });
  };
  return { watcher, view, props, backend, feed };
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("运行中：标题行显示档位、摘要、状态和只读标记；父尚未结算", async () => {
  const { feed } = mount({ summary: summary() });
  await flush();
  const head = document.querySelector(".sp-sub-head") as HTMLElement;
  expect(head.textContent).toContain("explore");
  expect(head.textContent).toContain("检查依赖方向");
  expect(within(head).getByRole("status").textContent).toContain("运行中");
  expect(head.textContent).toContain("只读");
  expect(head.querySelector(".tool-spin")).not.toBeNull();
  feed(userMessage(1, "检查依赖方向并汇报"), assistantMessage(2, "正在检查"));
  expect(screen.getByText("正在检查")).toBeTruthy();
  // 没有任何写入口
  expect(document.querySelector("textarea")).toBeNull();
  expect(screen.queryByRole("button", { name: /重发|分叉|撤销|发送|中断/ })).toBeNull();
});

it("运行中的已运行时间由本地 timer 走秒", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-21T00:00:05.000Z"));
  mount({ summary: summary({ startedAt: "2026-10-21T00:00:00.000Z" }) });
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.querySelector(".sp-sub-time")?.textContent).toBe("已运行 5 秒");
  act(() => {
    vi.advanceTimersByTime(4000);
  });
  expect(document.querySelector(".sp-sub-time")?.textContent).toBe("已运行 9 秒");
});

it("finish 的 input.result 是最终结果（Markdown），提交回执不当结果；父尚未结算先显示「结果已提交」", async () => {
  const { feed } = mount({ summary: summary(), parentEntry: taskEntry() });
  await flush();
  feed(
    userMessage(1, "任务"),
    toolStarted(2, "f1", "finish", { result: "## 结论\n全部**正常**" }),
    toolCompleted(3, "f1", "finish", "ok", "结果已提交给父会话。"),
  );
  const result = screen.getByText("最终结果").closest("details") as HTMLElement;
  expect(result.querySelector("h2")?.textContent).toBe("结论");
  expect(result.querySelector("strong")?.textContent).toBe("正常");
  expect(result.textContent).not.toContain("结果已提交给父会话");
  expect(
    within(document.querySelector(".sp-sub-head") as HTMLElement).getByRole("status").textContent,
  ).toBe("结果已提交");
  // 不抢先宣告父调用成功
  expect(screen.queryByText("已完成")).toBeNull();
});

it("结构化的最终结果按 JSON 展示", async () => {
  const { feed } = mount({ summary: summary({ state: "ended" }) });
  await flush();
  feed(
    toolStarted(2, "f1", "finish", { result: { passed: true } }),
    toolCompleted(3, "f1", "finish", "ok"),
  );
  const block = screen.getByText("最终结果").closest("details") as HTMLElement;
  expect(block.querySelector("pre")?.textContent).toBe(JSON.stringify({ passed: true }, null, 2));
});

it("父 task 已结算：状态与耗时以父持久结算为准；失败/取消保留原因", async () => {
  mount({
    summary: summary({ state: "running" }),
    parentEntry: taskEntry({ status: "ok", result: settled("ok", { durationMs: 83_000 }) }),
  });
  await flush();
  const head = document.querySelector(".sp-sub-head") as HTMLElement;
  expect(within(head).getByRole("status").textContent).toBe("已完成");
  expect(head.querySelector(".tool-spin")).toBeNull();
  expect(head.querySelector(".sp-sub-time")?.textContent).toBe("用时 1 分 23 秒");
  cleanup();
  mount({
    summary: summary({ state: "ended" }),
    parentEntry: taskEntry({ status: "error", result: settled("error") }),
  });
  await flush();
  expect(screen.getByText("子代理失败")).toBeTruthy();
  expect(document.querySelector(".sp-sub-status")?.textContent).toBe("失败");
  cleanup();
  // 只有事件时间差时标注近似，没有终止事实不编造耗时
  mount({
    summary: summary({
      state: "ended",
      outcome: { status: "ok" },
      durationMs: 7000,
      durationApproximate: true,
    }),
  });
  await flush();
  expect(document.querySelector(".sp-sub-time")?.textContent).toBe("用时 约 7 秒");
  cleanup();
  mount({ summary: summary({ state: "unsealed" }) });
  await flush();
  expect(document.querySelector(".sp-sub-time")).toBeNull();
});

it("未收束的日志：停止动画并标「日志未收束／运行状态未知」，保留实际事件，不伪造收尾", async () => {
  const { feed, watcher } = mount({ summary: summary({ state: "unsealed" }) });
  await flush();
  feed(
    userMessage(1, "任务"),
    durable("turn.started", 2, { turnIndex: 1 }),
    toolStarted(3, "s1", "shell", { command: "sleep 100" }),
  );
  const head = document.querySelector(".sp-sub-head") as HTMLElement;
  expect(within(head).getByRole("status").textContent).toBe("日志未收束／运行状态未知");
  expect(document.querySelector(".tool-spin")).toBeNull();
  expect(screen.getByLabelText("工具 shell")).toBeTruthy();
  expect(screen.getByText("未收束")).toBeTruthy();
  const state = watcher.state("p", "child-1");
  expect(state?.view.currentTurn).toBeDefined();
  expect(state?.view.entries.map((e) => e.kind)).toEqual(["user", "tool"]);
});

it("子会话非交互：被拒的操作提示由主代理在主对话处理；没有批准入口", async () => {
  const { feed } = mount({ summary: summary() });
  await flush();
  feed(
    userMessage(1, "任务"),
    toolStarted(2, "w1", "write", { path: "a.txt", content: "x" }),
    toolCompleted(3, "w1", "write", "denied", "子会话是非交互的", "child-1", {
      code: "non_interactive",
      message: "子会话无法请求确认",
    }),
  );
  expect(screen.getByText("子代理无法请求确认；需由主代理在主对话处理。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许|批准/ })).toBeNull();
});

it("历史待决确认只读提示，不提供批准按钮", async () => {
  const { feed } = mount({ summary: summary({ state: "unsealed" }) });
  await flush();
  feed(
    userMessage(1, "任务"),
    toolStarted(2, "w1", "write", { path: "a.txt", content: "x" }),
    durable("permission.requested", 3, {
      requestId: "req-1",
      callId: "w1",
      subjects: [{ kind: "edit", target: "a.txt" }],
      reason: "需要确认",
      options: ["allow_once", "deny"],
    }),
  );
  expect(screen.getByText(/历史日志里没有结算的确认请求/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /允许|拒绝/ })).toBeNull();
});

it("读取失败：没有内容时显示错误和重试；重试重新观察；日志末尾不完整时提示", async () => {
  const backend = runtimeOf();
  vi.mocked(backend.runtime.observeSubagent).mockRejectedValueOnce(
    Object.assign(new Error("拒绝"), { code: "subagent_parent_mismatch" }),
  );
  mount({ backend });
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("这个子会话不属于当前会话");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await flush();
  expect(backend.subs).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => {
    backend.subs[0]?.observer.onEnd(endOf({ tailIgnored: true }));
  });
  expect(screen.getByText("日志末尾不完整，已忽略最后一行。")).toBeTruthy();
});

it("后台没连上：显示说明且不观察；连上后自动读取", async () => {
  const watcher = new SubagentWatcher();
  const { view, props } = mount({ watcher, runtime: undefined });
  expect(screen.getByText("后台未连接，连上后自动读取")).toBeTruthy();
  const backend = runtimeOf();
  view.rerender(<SubagentPane {...props} runtime={backend.runtime} />);
  await flush();
  expect(backend.subs).toHaveLength(1);
});

it("只在显示时观察：隐藏即退订，重新显示按 seq 续接；卸载也退订", async () => {
  const backend = runtimeOf();
  const watcher = new SubagentWatcher();
  const { view, props } = mount({ watcher, backend });
  await flush();
  backend.subs[0]?.observer.onEvent(userMessage(1, "任务"));
  backend.subs[0]?.observer.onEvent(assistantMessage(2, "第一段"));
  view.rerender(<SubagentPane {...props} runtime={backend.runtime} visible={false} />);
  expect(backend.subs[0]?.unsubscribed).toBe(true);
  view.rerender(<SubagentPane {...props} runtime={backend.runtime} visible />);
  await flush();
  expect(backend.subs[1]?.afterSeq).toBe(2);
  expect(screen.getByText("第一段")).toBeTruthy();
  view.unmount();
  expect(backend.subs[1]?.unsubscribed).toBe(true);
});

it("图片经只读 RPC 读取（父/子/文件三元组），不 resume 子会话", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:child-image");
      static override revokeObjectURL = vi.fn();
    },
  );
  const backend = runtimeOf();
  mount({ backend, summary: summary() });
  await flush();
  const withImage = durable("message.user", 1, {
    messageId: "u1",
    content: [{ type: "text", text: "看图" }],
    attachments: [
      {
        type: "image",
        file: "shot.png",
        mimeType: "image/png",
        bytes: 3,
        sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        source: "paste",
      },
    ],
  });
  act(() => {
    backend.subs[0]?.observer.onEvent(withImage);
  });
  // 任务块是折叠的：展开后图片进入可视区才读取
  const details = document.querySelector("details.ro-user") as HTMLDetailsElement;
  act(() => {
    details.open = true;
  });
  act(() => {
    for (const callback of observers) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
  await flush();
  expect(backend.runtime.readSubagentAttachment).toHaveBeenCalledWith({
    parentSessionId: "p",
    childSessionId: "child-1",
    file: "shot.png",
  });
  expect(document.querySelector("img.u-img")?.getAttribute("src")).toBe("blob:child-image");
});
