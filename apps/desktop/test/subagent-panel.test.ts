/**
 * 子代理面板的纯逻辑（ADR-0060 修订（五））：父 task 行与 child 的归属、外部调用识别、
 * 状态与耗时推导、最终结果提取、标签的存取与去重。
 */
import { createSessionView, reduceSessionView, type RuntimeEvent } from "@nocturne/core/protocol";
import { expect, it } from "vitest";

import {
  parseStoredSessionPanels,
  parseStoredTabs,
  restoreSessionPanel,
  storeSessionPanel,
  storedTabs,
  subagentTabFor,
  subagentTabName,
  type PanelTab,
  type SubagentTab,
} from "../src/side-panel";
import {
  childFinish,
  elapsedText,
  externalAgentOf,
  externalRuns,
  finalResult,
  linkFor,
  oneLineSummary,
  runningBuiltin,
  runningMs,
  subagentStatus,
  unsettledBuiltinTasks,
} from "../src/subagent-panel";
import {
  externalEntry,
  settled,
  summary,
  taskEntry,
  toolCompleted,
  toolStarted,
  userMessage,
} from "./subagent-fixtures";

function viewOf(...events: RuntimeEvent[]) {
  const view = createSessionView();
  for (const event of events) reduceSessionView(view, event);
  return view;
}

it("外部 agent 按父持久工具主体识别，不读当前配置；内置不算外部", () => {
  expect(externalAgentOf(externalEntry("claude"))).toBe("claude");
  expect(externalAgentOf(taskEntry())).toBeUndefined();
  const view = {
    entries: [taskEntry(), externalEntry("codex"), externalEntry("x", { status: "ok" })],
  };
  expect(externalRuns(view)).toEqual([
    { callId: "ext-1", agent: "codex", summary: "外部 agent 的任务" },
  ]);
  // 外部调用没有 child 可找：不计入需要补查的未结算任务
  expect(unsettledBuiltinTasks(view)).toBe(1);
  expect(unsettledBuiltinTasks({ entries: [externalEntry()] })).toBe(0);
  // 尚在启动权限确认的 task 还没有 child，也不计
  expect(unsettledBuiltinTasks({ entries: [taskEntry({ status: "awaiting_permission" })] })).toBe(
    0,
  );
});

it("task 原文压成单行、至多 120 个码点（含代理对），空文本回退「子任务」", () => {
  expect(oneLineSummary("  第一行\n\n第二行\t尾  ")).toBe("第一行 第二行 尾");
  expect(oneLineSummary("   ")).toBe("子任务");
  const long = "😀".repeat(200);
  expect(Array.from(oneLineSummary(long))).toHaveLength(120);
});

it("task 行与 child 的归属：运行中未查到是 locating，查到即 ready；外部与无 child 的失败为 none", () => {
  const list = [summary({ callId: "call-1", childSessionId: "a" })];
  expect(linkFor(taskEntry(), list)).toEqual({ kind: "ready", childSessionId: "a" });
  // 运行中还没查到：正在定位，不是永久「无子会话」
  expect(linkFor(taskEntry({ callId: "call-2" }), list)).toEqual({ kind: "locating" });
  // 已结算且没有 child（启动前失败）：none
  expect(
    linkFor(taskEntry({ callId: "call-2", status: "error", result: settled("error") }), list),
  ).toEqual({ kind: "none" });
  // 尚在启动确认：还没有 child
  expect(linkFor(taskEntry({ callId: "call-2", status: "awaiting_permission" }), list)).toEqual({
    kind: "none",
  });
  // 已结束（含失败/取消）且有 child：仍可点
  expect(
    linkFor(taskEntry({ status: "error", result: settled("error") }), [
      summary({ state: "ended" }),
    ]),
  ).toEqual({ kind: "ready", childSessionId: "child-1" });
  // 外部 ACP 行不提供
  expect(linkFor(externalEntry(), [summary({ callId: "ext-1" })])).toEqual({ kind: "none" });
  // 不是 task 的行
  expect(linkFor(taskEntry({ name: "read" }), list)).toEqual({ kind: "none" });
  // 同一父调用意外有多个 child：取最早的（列表已按 startedAt 升序）
  expect(
    linkFor(taskEntry(), [
      summary({ childSessionId: "first" }),
      summary({ childSessionId: "second" }),
    ]),
  ).toEqual({ kind: "ready", childSessionId: "first" });
});

it("概览只列运行中的内置子代理", () => {
  const list = [
    summary({ childSessionId: "a", state: "running" }),
    summary({ childSessionId: "b", state: "ended" }),
    summary({ childSessionId: "c", state: "unsealed" }),
  ];
  expect(runningBuiltin(list).map((s) => s.childSessionId)).toEqual(["a"]);
});

it("时间文案：本地计时与人读时长", () => {
  expect(elapsedText(0)).toBe("0 秒");
  expect(elapsedText(59_900)).toBe("59 秒");
  expect(elapsedText(60_000)).toBe("1 分");
  expect(elapsedText(105_000)).toBe("1 分 45 秒");
  expect(elapsedText(3_660_000)).toBe("1 小时 1 分");
  expect(elapsedText(-5)).toBe("");
  expect(runningMs("2026-10-21T00:00:00.000Z", Date.parse("2026-10-21T00:00:07.500Z"))).toBe(7500);
  expect(runningMs("not a date", 1)).toBeUndefined();
  // 系统时钟比 startedAt 早也不出现负数
  expect(runningMs("2026-10-21T00:00:10.000Z", Date.parse("2026-10-21T00:00:00.000Z"))).toBe(0);
});

it("状态优先父 task 的持久结算，耗时优先父 tool.completed.durationMs", () => {
  const ok = subagentStatus({
    summary: summary({ state: "running" }),
    parent: taskEntry({ status: "ok", result: settled("ok", { durationMs: 83_000 }) }),
    childView: undefined,
  });
  expect(ok).toMatchObject({ phase: "ok", label: "已完成", animated: false, durationMs: 83_000 });
  const failed = subagentStatus({
    summary: summary({ state: "ended" }),
    parent: taskEntry({ status: "error", result: settled("error") }),
    childView: undefined,
  });
  expect(failed).toMatchObject({ phase: "error", label: "失败", error: "子代理失败" });
  const cancelled = subagentStatus({
    summary: summary({ state: "ended" }),
    parent: taskEntry({ status: "cancelled", result: settled("cancelled") }),
    childView: undefined,
  });
  expect(cancelled).toMatchObject({ phase: "cancelled", label: "已取消" });
  // 没有父条目时用服务端 summary.outcome 与耗时（近似时带标记）
  const fromSummary = subagentStatus({
    summary: summary({
      state: "ended",
      outcome: { status: "ok" },
      durationMs: 5000,
      durationApproximate: true,
    }),
    parent: undefined,
    childView: undefined,
  });
  expect(fromSummary).toMatchObject({
    phase: "ok",
    durationMs: 5000,
    durationApproximate: true,
  });
});

it("运行中显示运行状态并带动画；父尚未结算但已有成功 finish 时先显示「结果已提交」", () => {
  const running = subagentStatus({
    summary: summary({ state: "running" }),
    parent: taskEntry(),
    childView: viewOf(userMessage(1, "任务")),
  });
  expect(running).toMatchObject({ phase: "running", label: "运行中", animated: true });
  const withFinish = viewOf(
    userMessage(1, "任务"),
    toolStarted(2, "f1", "finish", { result: "好了" }),
    toolCompleted(3, "f1", "finish", "ok", "结果已提交给父会话。"),
  );
  expect(
    subagentStatus({
      summary: summary({ state: "running" }),
      parent: taskEntry(),
      childView: withFinish,
    }),
  ).toMatchObject({ phase: "submitted", label: "结果已提交", animated: false });
});

it("未收束日志：不转圈、标明运行状态未知，不编造最终耗时；无终止事实时耗时缺省", () => {
  const unsealed = subagentStatus({
    summary: summary({ state: "unsealed" }),
    parent: undefined,
    childView: viewOf(userMessage(1, "任务")),
  });
  expect(unsealed).toMatchObject({
    phase: "unsealed",
    label: "日志未收束／运行状态未知",
    animated: false,
  });
  expect(unsealed.durationMs).toBeUndefined();
  expect(
    subagentStatus({
      summary: summary({ state: "unsealed" }),
      parent: taskEntry({ status: "ok", result: settled("ok", { durationMs: 1000 }) }),
      childView: undefined,
    }),
  ).toMatchObject({ phase: "unsealed", animated: false });
  // 还没拿到任何摘要
  expect(
    subagentStatus({ summary: undefined, parent: undefined, childView: undefined }),
  ).toMatchObject({
    phase: "unknown",
    label: "正在读取",
  });
});

it("finish 的 input.result 才是最终结果：字符串按文本，结构化值格式化；提交回执不当结果", () => {
  const text = viewOf(
    userMessage(1, "任务"),
    toolStarted(2, "f1", "finish", { result: "## 结论\n全部通过" }),
    toolCompleted(3, "f1", "finish", "ok", "结果已提交给父会话。"),
  );
  expect(childFinish(text)?.callId).toBe("f1");
  expect(finalResult(text)).toEqual({ kind: "text", text: "## 结论\n全部通过" });
  const json = viewOf(
    toolStarted(2, "f1", "finish", { result: { passed: true, n: 3 } }),
    toolCompleted(3, "f1", "finish", "ok"),
  );
  expect(finalResult(json)).toEqual({
    kind: "json",
    text: JSON.stringify({ passed: true, n: 3 }, null, 2),
  });
  // finish 失败或没有 finish：没有最终结果，不拿最后一条助手文本冒充
  const failed = viewOf(
    toolStarted(2, "f1", "finish", { result: "x" }),
    toolCompleted(3, "f1", "finish", "error", "schema 不符"),
  );
  expect(finalResult(failed)).toBeUndefined();
  expect(finalResult(viewOf(userMessage(1, "任务")))).toBeUndefined();
});

const tab = (over: Partial<SubagentTab> = {}): SubagentTab => ({
  id: "t1",
  kind: "subagent",
  childSessionId: "child-1",
  parentCallId: "call-1",
  profile: "explore",
  taskSummary: "检查依赖方向",
  ...over,
});

it("标签名是「档位 · 摘要」，摘要压成单行、至多 120 个码点；空摘要只剩档位", () => {
  expect(subagentTabName(tab())).toBe("explore · 检查依赖方向");
  expect(subagentTabName(tab({ taskSummary: "a\n b" }))).toBe("explore · a b");
  expect(Array.from(subagentTabName(tab({ taskSummary: "好".repeat(300) })))).toHaveLength(
    "explore · ".length + 120,
  );
  expect(subagentTabName(tab({ taskSummary: "  " }))).toBe("explore");
});

it("子代理标签存取：只存标识和展示字段；同一 child 只留一个；损坏条目丢弃", () => {
  const tabs: PanelTab[] = [
    { id: "n", kind: "new" },
    tab(),
    tab({ id: "t2", childSessionId: "child-2", parentCallId: "call-2" }),
  ];
  expect(storedTabs(tabs)).toEqual([
    {
      id: "t1",
      kind: "subagent",
      childSessionId: "child-1",
      parentCallId: "call-1",
      profile: "explore",
      taskSummary: "检查依赖方向",
    },
    {
      id: "t2",
      kind: "subagent",
      childSessionId: "child-2",
      parentCallId: "call-2",
      profile: "explore",
      taskSummary: "检查依赖方向",
    },
  ]);
  const parsed = parseStoredTabs([
    { ...tab(), extra: "不存", events: [1, 2] },
    // 同 child 重复
    { ...tab({ id: "dup" }) },
    // 缺档位 / 缺 callId / 摘要类型不对：整条丢弃
    { ...tab({ id: "x1", childSessionId: "c3" }), profile: "" },
    { ...tab({ id: "x2", childSessionId: "c4" }), parentCallId: undefined },
    { ...tab({ id: "x3", childSessionId: "c5" }), taskSummary: 7 },
    {
      id: "ok",
      kind: "subagent",
      childSessionId: "c6",
      parentCallId: "k",
      profile: "p",
      taskSummary: "",
    },
  ]);
  expect(parsed.map((t) => t.id)).toEqual(["t1", "ok"]);
  // 任务全文、事件之类不会被带进来
  expect(parsed[0]).toEqual(expect.not.objectContaining({ extra: "不存" }));
  expect(JSON.stringify(parsed)).not.toContain("events");
});

it("重启恢复：标签、顺序、当前项原样回来，所属父会话取外层键", () => {
  const panel = restoreSessionPanel(undefined, () => "new");
  panel.tabs = [tab(), tab({ id: "t2", childSessionId: "child-2", parentCallId: "c2" })];
  panel.activeId = "t2";
  panel.open = true;
  const stored = { "parent-1": storeSessionPanel(panel) };
  const restored = parseStoredSessionPanels(JSON.parse(JSON.stringify(stored)));
  const back = restoreSessionPanel(restored["parent-1"], () => "new");
  expect(back.open).toBe(true);
  expect(back.activeId).toBe("t2");
  expect(back.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(subagentTabFor(back.tabs, "child-2")?.id).toBe("t2");
  expect(subagentTabFor(back.tabs, "nope")).toBeUndefined();
});
