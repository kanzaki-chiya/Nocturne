/**
 * ADR-0064：schedule 权限主体的确认框——detail 是多行纯文本（名称、计划、工作区、
 * 模型 · 档位 · 权限、指令全文），完整显示；长指令默认折叠，按 e 展开看全。
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type { PendingPermission } from "@nocturne/core/protocol";
import { boxSafe } from "../src/format.js";
import {
  PermissionDialog,
  permissionDialogRows,
  scheduleDetailRows,
} from "../src/components/permission-dialog.js";

const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const header = [
  "新建定时任务",
  "名称：错误日志巡检",
  "计划：每天 09:00",
  "工作区：普通对话",
  "模型 · 档位 · 权限：默认 · 默认 · read-only",
  "时长上限：60 分钟",
  "指令：",
];

function pendingWith(prompt: string): PendingPermission {
  return {
    requestId: "p1",
    callId: "c1",
    toolName: "schedule",
    subjects: [
      {
        kind: "schedule",
        target: "create:错误日志巡检",
        detail: [...header, prompt].join("\n"),
      },
    ],
    reason: "按权限规则需要确认",
    options: ["allow_once", "allow_session", "deny", "deny_stop"],
  };
}

const longPrompt = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 步：检查服务 ${i + 1}`).join(
  "\n",
);

describe("schedule 确认框（TUI）", () => {
  it("短指令完整显示：全部字段与指令全文，保留换行", () => {
    const pending = pendingWith("检查 logs/ 下最近一天的错误日志。\n按服务汇总前 5 条。");
    const { lastFrame, unmount } = render(
      createElement(PermissionDialog, { pending, active: false, onReply: vi.fn(), width: 80 }),
    );
    const frame = lastFrame() ?? "";
    for (const line of [...header, "检查 logs/ 下最近一天的错误日志。", "按服务汇总前 5 条。"]) {
      expect(frame).toContain(boxSafe(line));
    }
    expect(frame).not.toContain("按 e 展开");
    unmount();
  });

  it("折叠：只给前 10 行与「还有 N 行」；展开给全文并提示按 e 折叠", () => {
    const pending = pendingWith(longPrompt);
    const collapsed = scheduleDetailRows(pending, 80, false);
    expect(collapsed.foldable).toBe(true);
    expect(collapsed.rows).toHaveLength(11);
    expect(collapsed.rows.at(-1)).toMatch(/^… 还有 \d+ 行（按 e 展开）$/);
    expect(collapsed.rows.join("\n")).not.toContain("第 30 步");

    const full = scheduleDetailRows(pending, 80, true);
    expect(full.rows.join("\n")).toContain("第 30 步：检查服务 30");
    expect(full.rows.at(-1)).toBe("（按 e 折叠）");
    // 对话框为它预留的行数随展开状态变化
    expect(permissionDialogRows(pending, 80, true)).toBeGreaterThan(
      permissionDialogRows(pending, 80, false),
    );
  });

  it("按 e 触发展开回调；没有可折叠内容时 e 不触发", async () => {
    const toggle = vi.fn();
    const long = render(
      createElement(PermissionDialog, {
        pending: pendingWith(longPrompt),
        active: true,
        onReply: vi.fn(),
        width: 80,
        onToggleExpanded: toggle,
      }),
    );
    await pause();
    long.stdin.write("e");
    await pause();
    expect(toggle).toHaveBeenCalledTimes(1);
    long.unmount();

    const shortToggle = vi.fn();
    const short = render(
      createElement(PermissionDialog, {
        pending: pendingWith("一句话"),
        active: true,
        onReply: vi.fn(),
        width: 80,
        onToggleExpanded: shortToggle,
      }),
    );
    await pause();
    short.stdin.write("e");
    await pause();
    expect(shortToggle).not.toHaveBeenCalled();
    short.unmount();
  });

  it("展开后高度放不下：选项固定在底部，↑/↓ 滚动查看全文", async () => {
    const pending = pendingWith(longPrompt);
    const { lastFrame, stdin, unmount } = render(
      createElement(PermissionDialog, {
        pending,
        active: true,
        onReply: vi.fn(),
        width: 80,
        height: 14,
        expanded: true,
      }),
    );
    await pause();
    const first = lastFrame() ?? "";
    expect(first).toContain("新建定时任务");
    expect(first).toContain("[a] 允许一次");
    expect(first).toContain(boxSafe("↑/↓ 滚动"));
    expect(first).not.toContain("第 30 步");
    for (let i = 0; i < 40; i++) stdin.write("\x1b[B");
    await pause(120);
    const last = lastFrame() ?? "";
    expect(last).toContain("第 30 步：检查服务 30");
    expect(last).toContain("[a] 允许一次");
    expect(last).not.toContain("新建定时任务");
    unmount();
  });

  it("detail 里的终端控制序列被去掉，窄屏按显示宽度换行而不是截断", () => {
    const pending = pendingWith("\u001b[31m红色\u001b[0m" + "长".repeat(40));
    const rows = scheduleDetailRows(pending, 30, true).rows;
    expect(rows.join("")).not.toContain("\u001b");
    expect(rows.join("")).toContain("长".repeat(40));
    expect(rows.every((r) => r.length <= 30)).toBe(true);
  });
});
