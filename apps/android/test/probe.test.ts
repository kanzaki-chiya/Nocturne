import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseNativeLog, ProbeLog, summarize, type ProbeEntry } from "../src/probe";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("summarize", () => {
  it("分前后台统计事件、间隔、成批涌入与回放", () => {
    const entries: ProbeEntry[] = [
      [1000, "event", "fg live s1 message.delta 1"],
      [2000, "event", "fg live s1 message.delta 2"],
      [3000, "event", "bg live s1 message.delta 3"],
      // 静默 8 秒后一口气涌入 3 条：成批延迟
      [11000, "event", "bg live s1 message.delta 4"],
      [11010, "event", "bg live s1 message.delta 5"],
      [11020, "event", "bg live s1 message.delta 6"],
      [11500, "event", "bg replay s1 turn.completed 7"],
      [12000, "disconnect", "电脑 1 网络断开"],
      [13000, "connect", "电脑 1"],
      [30000, "tick", "bg max_lag=1800ms ticks=29"],
      [60000, "tick", "fg max_lag=5000ms ticks=30"],
    ];
    const summary = summarize(entries, []);
    expect(summary.events).toEqual({ fg: 2, bg: 4, replay: 1 });
    expect(summary.maxGap).toEqual({ fg: 1000, bg: 8000 });
    expect(summary.gapsOver5s).toEqual({ fg: 0, bg: 1 });
    expect(summary.batches).toBe(2);
    expect(summary.disconnects).toBe(1);
    expect(summary.connects).toBe(1);
    // 只统计后台的计时器延迟
    expect(summary.maxTimerLag).toBe(1800);
  });

  it("原生记录：服务启停、渲染进程回收与重启", () => {
    const native = parseNativeLog(
      [
        "1000\tservice_start",
        "2000\tactivity_pause",
        "3000\trenderer_gone crashed=false foreground=false",
        "4000\tapp_restart",
        "5000\tservice_stop",
        "损坏的行",
        "",
      ].join("\n"),
    );
    expect(native).toHaveLength(5);
    expect(summarize([], native).native).toEqual({
      serviceStarts: 1,
      serviceStops: 1,
      rendererGone: 1,
      restarts: 1,
    });
  });
});

describe("ProbeLog", () => {
  it("事件只记类型、会话 id 与序号，不含内容；落盘后重新加载仍在", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let visible = true;
    const probe = new ProbeLog(() => visible);
    probe.event("session-1", "message.delta", 7, true);
    visible = false;
    probe.event("session-1", "turn.completed", undefined, false);
    probe.flush();
    const reloaded = new ProbeLog(() => true);
    expect(reloaded.all().map((entry) => entry[2])).toEqual([
      "fg live session-1 message.delta 7",
      "bg replay session-1 turn.completed -",
    ]);
  });

  it("记录有上限，清除后为空", () => {
    const probe = new ProbeLog(() => true);
    for (let i = 0; i < 20050; i++) probe.add("state", `n${i}`);
    expect(probe.all()).toHaveLength(20000);
    expect(probe.all()[0]?.[2]).toBe("n50");
    probe.clear();
    expect(probe.all()).toHaveLength(0);
    expect(new ProbeLog(() => true).all()).toHaveLength(0);
  });

  it("计时器每 30 秒汇总一次前后台与最大延迟", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let visible = true;
    const probe = new ProbeLog(() => visible);
    probe.start();
    visible = false;
    // 一次被系统冻结 12 秒的计时器
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() + 12_000);
    vi.advanceTimersByTime(25_000);
    probe.stop();
    const ticks = probe.all().filter((entry) => entry[1] === "tick");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]?.[2]).toMatch(/^bg max_lag=\d+ms ticks=\d+$/);
    expect(
      Math.max(...ticks.map((entry) => Number(/max_lag=(\d+)/.exec(entry[2])?.[1]))),
    ).toBeGreaterThanOrEqual(11_000);
  });

  it("导出文本含摘要，并把 JS 与原生记录按时间合并", () => {
    const probe = new ProbeLog(
      () => true,
      () => 3000,
    );
    probe.event("s", "message.delta", 1, true);
    const text = probe.text(
      [
        { at: 1000, event: "service_start" },
        { at: 9000, event: "service_stop" },
      ],
      { version: "0.10.0", agent: "测试设备" },
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Nocturne 后台探针 v0.10.0");
    expect(text).toContain("设备 测试设备");
    expect(text).toContain("前台服务启 1 次、停 1 次");
    const body = lines.slice(lines.indexOf("---") + 1);
    expect(body.map((line) => line.replace(/^\S+ \S+ epoch=\d+ /, ""))).toEqual([
      "native service_start",
      "event fg live s message.delta 1",
      "native service_stop",
    ]);
    expect(text).not.toContain("好的");
    expect(text).toContain("epoch=3000");
  });
  it("用事件时间统计后台延迟且不把回放算作实时", () => {
    const entries: ProbeEntry[] = [
      [2000, "event", "bg live s message.delta - sent=1900"],
      [3000, "event", "bg live s message.delta - sent=2700"],
      [4000, "event", "bg live s message.delta - sent=3500"],
      [5000, "event", "bg replay s turn.completed 4 sent=1000"],
    ];
    expect(summarize(entries, []).backgroundLatency).toEqual({ count: 3, median: 300, max: 500 });
  });
  it("保留负延迟以暴露设备时钟偏差，不伪装成零网络耗时", () => {
    expect(
      summarize([[1000, "event", "bg live s turn.completed 1 sent=1650"]], []).backgroundLatency,
    ).toEqual({ count: 1, median: -650, max: -650 });
  });
});
