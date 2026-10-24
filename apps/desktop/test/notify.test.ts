/**
 * 通知判定（src/notify.ts）：三类事件 × 在看/没在看 × 开关组合，完成阈值边界
 * （等于阈值提醒、少 1 秒不提醒），中断与重放不提醒，子代理请求按父会话，
 * 正文格式（用时、单题/多题、subject 截断）与标题回退链。
 */
import { describe, expect, it } from "vitest";
import type { PermissionSubject, QuestionItem, RuntimeEvent } from "@nocturne/core/protocol";

import {
  decideNotification,
  ellipsize,
  formatDuration,
  NOTIFY_DEFAULTS,
  notifyPrefsFrom,
  permissionOperation,
  sessionMarkFor,
  sessionTitle,
  thresholdLabel,
  type NotifyInput,
  type NotifyPrefs,
} from "../src/notify";
import type { SettingItem } from "../src/rpc-types";

const TURN_START = Date.parse("2026-10-12T10:00:00.000Z");

/** 造一条事件：默认是实时、非在看、有标题的会话 */
function input(overrides: Partial<NotifyInput> & { event: RuntimeEvent }): NotifyInput {
  return {
    prefs: NOTIFY_DEFAULTS,
    live: true,
    watching: false,
    session: { title: "桌面端提问卡片改版" },
    turnStartedAt: TURN_START,
    ...overrides,
  };
}

function permission(
  subjects: PermissionSubject[] = [{ kind: "shell", target: "git push origin main" }],
): RuntimeEvent {
  return {
    type: "permission.requested",
    sessionId: "s1",
    seq: 7,
    time: "2026-10-12T10:00:05.000Z",
    payload: {
      requestId: "req-1",
      callId: "call-1",
      subjects,
      reason: "按权限规则需要确认",
      options: ["allow_once", "deny"],
    },
  };
}

function question(questions: QuestionItem[]): RuntimeEvent {
  return {
    type: "question.requested",
    sessionId: "s1",
    runId: "run-1",
    eseq: 1,
    afterSeq: 7,
    time: "2026-10-12T10:00:05.000Z",
    payload: { requestId: "q-1", callId: "call-2", questions },
  };
}

function completed(payload: {
  reason: "done" | "error" | "max_steps" | "aborted" | "truncated" | "refused";
  steps?: number;
  seconds: number;
  error?: { code: string; message: string };
  recovered?: boolean;
}): RuntimeEvent {
  return {
    type: "turn.completed",
    sessionId: "s1",
    seq: 9,
    time: new Date(TURN_START + payload.seconds * 1000).toISOString(),
    payload: {
      reason: payload.reason,
      steps: payload.steps ?? 54,
      usage: { inputTokens: 1, outputTokens: 1 },
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.recovered !== undefined ? { recovered: payload.recovered } : {}),
    },
  };
}

const OFF: NotifyPrefs = {
  ...NOTIFY_DEFAULTS,
  enabled: false,
};

describe("decideNotification · 需要确认", () => {
  it("权限请求：没在看就提醒，正文是「需要确认：操作 subject」", () => {
    const decision = decideNotification(input({ event: permission() }));
    expect(decision).toEqual({
      kind: "attention",
      title: "桌面端提问卡片改版",
      body: "需要确认：执行命令 git push origin main",
    });
  });

  it.each([
    ["read", "读取文件"],
    ["edit", "修改文件"],
    ["network", "访问网络"],
    ["mcp", "调用 MCP 工具"],
    ["subagent", "启动子任务"],
  ] as const)("subject kind %s 用权限卡片同款操作文字 %s", (kind, label) => {
    const decision = decideNotification(
      input({ event: permission([{ kind, target: "C:/tmp/a.txt" }]) }),
    );
    expect(decision?.body).toBe(`需要确认：${label} C:/tmp/a.txt`);
  });

  it("没有 subject 时只写操作文字；target 过长截断", () => {
    expect(decideNotification(input({ event: permission([]) }))?.body).toBe("需要确认：操作");
    const long = "x".repeat(200);
    const body = decideNotification(
      input({ event: permission([{ kind: "shell", target: long }]) }),
    )?.body;
    expect(body).toBe(`需要确认：执行命令 ${"x".repeat(99)}…`);
    expect(body?.length).toBe("需要确认：执行命令 ".length + 100);
  });

  it("提问：单题写「需要你回答：题目」，多题写「需要你回答 N 个问题：第一题」", () => {
    const one = question([{ question: "要不要覆盖现有配置？" }]);
    expect(decideNotification(input({ event: one }))?.body).toBe(
      "需要你回答：要不要覆盖现有配置？",
    );
    const three = question([
      { question: "这次改动要覆盖哪些包？" },
      { question: "第二题" },
      { question: "第三题" },
    ]);
    expect(decideNotification(input({ event: three }))?.body).toBe(
      "需要你回答 3 个问题：这次改动要覆盖哪些包？",
    );
  });

  it("在看、总开关关闭、attention 未勾选都不提醒", () => {
    expect(decideNotification(input({ event: permission(), watching: true }))).toBeNull();
    expect(decideNotification(input({ event: permission(), prefs: OFF }))).toBeNull();
    expect(
      decideNotification(
        input({ event: permission(), prefs: { ...NOTIFY_DEFAULTS, attention: false } }),
      ),
    ).toBeNull();
    expect(
      decideNotification(input({ event: question([{ question: "Q" }]), watching: true })),
    ).toBeNull();
  });
});

describe("decideNotification · 出错与完成", () => {
  it("出错：不看用时、不看阈值，正文带用时与错误摘要", () => {
    const event = completed({
      reason: "error",
      seconds: 26 * 60,
      error: { code: "stream_aborted", message: "服务商响应流中途断开，已重试 4 次仍失败" },
    });
    expect(decideNotification(input({ event }))).toEqual({
      kind: "error",
      title: "桌面端提问卡片改版",
      body: "出错停止，用时 26 分钟：服务商响应流中途断开，已重试 4 次仍失败",
    });
    // 用时未知（没记到 turn.started）时省略用时，不猜
    expect(decideNotification(input({ event, turnStartedAt: undefined }))?.body).toBe(
      "出错停止：服务商响应流中途断开，已重试 4 次仍失败",
    );
    // 没有 message 时退回错误码
    const bare = completed({ reason: "error", seconds: 10, error: { code: "boom", message: "" } });
    expect(decideNotification(input({ event: bare }))?.body).toBe("出错停止，用时 10 秒：boom");
  });

  it("完成：用时到阈值才提醒，正文是「已完成，用时 X，N 步」", () => {
    const event = completed({ reason: "done", seconds: 6 * 60, steps: 54 });
    expect(decideNotification(input({ event }))?.body).toBe("已完成，用时 6 分钟，54 步");
  });

  it("阈值边界：等于阈值提醒，少 1 秒不提醒", () => {
    const exactly = completed({ reason: "done", seconds: 60 });
    expect(decideNotification(input({ event: exactly }))?.body).toBe("已完成，用时 1 分钟，54 步");
    const justUnder = completed({ reason: "done", seconds: 59 });
    expect(decideNotification(input({ event: justUnder }))).toBeNull();
    const custom = { ...NOTIFY_DEFAULTS, doneAfterSeconds: 300 };
    expect(
      decideNotification(
        input({ event: completed({ reason: "done", seconds: 299 }), prefs: custom }),
      ),
    ).toBeNull();
    expect(
      decideNotification(
        input({ event: completed({ reason: "done", seconds: 300 }), prefs: custom }),
      ),
    ).not.toBeNull();
  });

  it.each(["max_steps", "truncated", "refused"] as const)(
    "%s 属于非中断结束，按完成处理",
    (reason) => {
      const event = completed({ reason, seconds: 90 });
      expect(decideNotification(input({ event }))?.kind).toBe("done");
    },
  );

  it("用户中断（aborted）永不提醒，即使开着也不看阈值", () => {
    const event = completed({ reason: "aborted", seconds: 3600 });
    expect(decideNotification(input({ event }))).toBeNull();
  });

  it("恢复补写的 turn.completed 不提醒", () => {
    const event = completed({ reason: "error", seconds: 600, recovered: true });
    expect(decideNotification(input({ event }))).toBeNull();
  });

  it("重放事件不提醒（live: false）", () => {
    expect(
      decideNotification(
        input({ event: completed({ reason: "done", seconds: 600 }), live: false }),
      ),
    ).toBeNull();
    expect(decideNotification(input({ event: permission(), live: false }))).toBeNull();
    expect(
      decideNotification(input({ event: question([{ question: "Q" }]), live: false })),
    ).toBeNull();
  });

  it("在看时不提醒；error / done 未勾选各自静默", () => {
    const event = completed({ reason: "done", seconds: 600 });
    expect(decideNotification(input({ event, watching: true }))).toBeNull();
    expect(
      decideNotification(input({ event, prefs: { ...NOTIFY_DEFAULTS, done: false } })),
    ).toBeNull();
    const error = completed({ reason: "error", seconds: 600, error: { code: "x", message: "y" } });
    expect(
      decideNotification(input({ event: error, prefs: { ...NOTIFY_DEFAULTS, error: false } })),
    ).toBeNull();
  });

  it("用时未知时不按阈值猜完成提醒", () => {
    const event = completed({ reason: "done", seconds: 600 });
    expect(decideNotification(input({ event, turnStartedAt: undefined }))).toBeNull();
  });

  it("与通知无关的事件不提醒", () => {
    const started: RuntimeEvent = {
      type: "turn.started",
      sessionId: "s1",
      seq: 6,
      time: "2026-10-12T10:00:00.000Z",
      payload: { turnIndex: 1 },
    };
    expect(decideNotification(input({ event: started }))).toBeNull();
  });
});

describe("sessionMarkFor · 侧栏留痕", () => {
  it("出错与完成留痕，中断、恢复补写与非 turn.completed 事件不留", () => {
    expect(sessionMarkFor(completed({ reason: "error", seconds: 10 }))).toBe("error");
    expect(sessionMarkFor(completed({ reason: "done", seconds: 10 }))).toBe("done");
    expect(sessionMarkFor(completed({ reason: "max_steps", seconds: 10 }))).toBe("done");
    expect(sessionMarkFor(completed({ reason: "aborted", seconds: 10 }))).toBeNull();
    expect(sessionMarkFor(completed({ reason: "error", seconds: 10, recovered: true }))).toBeNull();
    expect(sessionMarkFor(permission())).toBeNull();
  });
});

describe("会话标题与正文格式", () => {
  it("标题回退链：会话标题 → 首条用户消息第一行 → Nocturne", () => {
    expect(sessionTitle({ title: "生成的标题", firstText: "首条消息" })).toBe("生成的标题");
    expect(sessionTitle({ firstText: "首条消息\n第二行" })).toBe("首条消息");
    expect(sessionTitle({ title: "   ", firstText: "  " })).toBe("Nocturne");
    expect(sessionTitle({})).toBe("Nocturne");
  });

  it("用时格式：秒 / 取整分钟 / 小时加分钟", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(45_000)).toBe("45 秒");
    expect(formatDuration(59_999)).toBe("59 秒");
    expect(formatDuration(60_000)).toBe("1 分钟");
    expect(formatDuration(26 * 60_000 + 59_000)).toBe("26 分钟");
    expect(formatDuration(59 * 60_000)).toBe("59 分钟");
    expect(formatDuration(60 * 60_000)).toBe("1 小时");
    expect(formatDuration(65 * 60_000)).toBe("1 小时 5 分钟");
    expect(formatDuration(120 * 60_000)).toBe("2 小时");
  });

  it("截断与操作文字：一次只做一件事", () => {
    expect(ellipsize("短", 10)).toBe("短");
    expect(ellipsize("abcdefghij", 10)).toBe("abcdefghij");
    expect(ellipsize("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(permissionOperation("shell")).toBe("执行命令");
    expect(permissionOperation(undefined)).toBe("操作");
    expect(permissionOperation(undefined, "task")).toBe("task");
  });

  it("阈值档位名：命中档位用档位名，其余写「N 秒」", () => {
    expect(thresholdLabel(60)).toBe("1 分钟");
    expect(thresholdLabel(600)).toBe("10 分钟");
    expect(thresholdLabel(45)).toBe("45 秒");
  });
});

describe("notifyPrefsFrom", () => {
  const item = (key: SettingItem["key"], effective: string): SettingItem => ({
    key,
    effective,
    source: "settings",
    saved: effective,
    overridden: false,
  });

  it("读生效值；缺条目按 Core 缺省", () => {
    expect(notifyPrefsFrom([])).toEqual(NOTIFY_DEFAULTS);
    const prefs = notifyPrefsFrom([
      item("notifications.enabled", "false"),
      item("notifications.events.attention", "false"),
      item("notifications.events.error", "true"),
      item("notifications.events.done", "false"),
      item("notifications.doneAfterSeconds", "180"),
      item("notifications.sound", "false"),
    ]);
    expect(prefs).toEqual({
      enabled: false,
      attention: false,
      error: true,
      done: false,
      doneAfterSeconds: 180,
      sound: false,
    });
  });

  it("阈值不是合法数字时回到缺省 60", () => {
    const prefs = notifyPrefsFrom([item("notifications.doneAfterSeconds", "abc")]);
    expect(prefs.doneAfterSeconds).toBe(60);
  });
});
