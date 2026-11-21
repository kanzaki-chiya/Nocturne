import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionView,
  reduceSessionView,
  type PendingPermission,
  type PermissionSubject,
  type RuntimeEvent,
  type SubagentObserver,
  type SubagentPendingPermission,
  type ToolEntry,
  type ViewEntry,
} from "@nocturne/core/protocol";
import type { RpcSession } from "@nocturne/rpc/client";
import { createAttachmentImageSource } from "../src/attachment-images";
import { Conversation, PermissionCard, shellHistoryFromView } from "../src/Conversation";
import { SubagentPane, type SubagentRuntime } from "../src/SubagentPane";
import { SubagentWatcher } from "../src/subagent-watch";
import { assistantMessage, summary, userMessage } from "./subagent-fixtures";

beforeEach(() => {
  vi.stubGlobal("matchMedia", undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function shellPending(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestId: "req-shell-1",
    callId: "call-shell-1",
    toolName: "shell",
    subjects: [{ kind: "shell", target: "git status --short", shell: "bash" }],
    reason: "ask",
    options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
    ruleSuggestion: { pattern: "git status *" },
    ...overrides,
  };
}

function shellToolEntry(
  id: string,
  target: string,
  options: {
    permission?: ToolEntry["permission"];
    resolution?: ToolEntry["resolution"];
    shell?: string;
  } = {},
): ToolEntry {
  return {
    kind: "tool",
    key: `tool:${id}`,
    turnId: "turn-1",
    callId: id,
    name: "shell",
    seq: 1,
    status: "ok",
    input: { command: target },
    subjects: [{ kind: "shell", target, shell: options.shell ?? "bash" }],
    permission: options.permission,
    resolution: options.resolution,
    liveOutput: "",
    result: undefined,
  };
}

function fakeSession(overrides: Partial<RpcSession> = {}): RpcSession {
  return new Proxy(
    {
      id: "parent-1",
      respondPermission: vi.fn(async () => undefined),
      respondSubagentPermission: vi.fn(async () => undefined),
      respondQuestion: vi.fn(async () => undefined),
      readAttachment: vi.fn(async () => ({ data: new Uint8Array(), mimeType: "image/png" })),
      ...overrides,
    },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        if (key === "then") return undefined;
        return () => Promise.resolve([]);
      },
    },
  ) as unknown as RpcSession;
}

describe("PermissionCard 改成规则… 表单", () => {
  it("带 ruleSuggestion 时显示「改成规则…」且排在「本项目允许」后，KeyHint 变为 1–6；不满足条件时不显示", () => {
    const { container, rerender } = render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
      />,
    );

    const buttons = screen.getAllByRole("button").map((btn) => btn.textContent);
    expect(buttons).toEqual([
      "允许一次",
      "本会话允许",
      "本项目允许",
      "改成规则…",
      "拒绝",
      "拒绝并停止",
    ]);
    const kbds = Array.from(container.querySelectorAll(".ask-kbd kbd")).map((el) => el.textContent);
    expect(kbds).toEqual(["1", "6", "Esc"]);

    // 不带 ruleSuggestion 时不显示
    rerender(
      <PermissionCard
        pending={shellPending({ requestId: "req-no-sug", ruleSuggestion: undefined })}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
      />,
    );
    expect(screen.queryByRole("button", { name: "改成规则…" })).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".ask-kbd kbd")).map((el) => el.textContent),
    ).toEqual(["1", "5", "Esc"]);

    // 不含 allow_project 时不显示
    rerender(
      <PermissionCard
        pending={shellPending({
          requestId: "req-no-proj",
          options: ["allow_once", "allow_session", "deny", "deny_stop"],
        })}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
      />,
    );
    expect(screen.queryByRole("button", { name: "改成规则…" })).toBeNull();

    // 非 shell 主体或多主体时不显示
    rerender(
      <PermissionCard
        pending={shellPending({
          requestId: "req-multi",
          subjects: [
            { kind: "shell", target: "git status --short" },
            { kind: "shell", target: "git diff" },
          ],
        })}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
      />,
    );
    expect(screen.queryByRole("button", { name: "改成规则…" })).toBeNull();
  });

  it("点击「改成规则…」或按数字键 4 展开表单，预填建议模式并聚焦，展开中忽略数字键", () => {
    const onRespond = vi.fn(async () => undefined);
    const { rerender } = render(
      <PermissionCard pending={shellPending()} onRespond={onRespond} cwd="Z:/ws" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const input = screen.getByLabelText("命令规则") as HTMLInputElement;
    expect(input.value).toBe("git status *");
    expect(document.activeElement).toBe(input);

    // 焦点移到「返回」按钮后按数字键 1 不应触发 allow_once
    const backBtn = screen.getByRole("button", { name: "返回" });
    backBtn.focus();
    fireEvent.keyDown(backBtn, { key: "1" });
    expect(onRespond).not.toHaveBeenCalled();

    // 点返回后，通过数字键 4 再次展开表单
    fireEvent.click(backBtn);
    expect(screen.queryByLabelText("命令规则")).toBeNull();
    fireEvent.keyDown(window, { key: "4" });
    expect((screen.getByLabelText("命令规则") as HTMLInputElement).value).toBe("git status *");

    // 切换 requestId 自动重置回选项按钮
    rerender(
      <PermissionCard
        pending={shellPending({ requestId: "req-shell-2" })}
        onRespond={onRespond}
        cwd="Z:/ws"
      />,
    );
    expect(screen.queryByLabelText("命令规则")).toBeNull();
  });

  it("匹配列表：当前命令排第一，去重且最多 5 条；置前的高风险、组合与不透明 PowerShell 候选在可匹配模式下均被排除", () => {
    // 1. 高风险与组合命令放在最前面（总量未满 5 条），用能匹配它们的 `git *` 验证确实被过滤
    const riskyFirstHistory: PermissionSubject[] = [
      { kind: "shell", target: "git push --force origin main", shell: "bash" },
      { kind: "shell", target: "git status && echo hacked", shell: "bash" },
      { kind: "shell", target: "git status --porcelain", shell: "bash" },
      { kind: "shell", target: "git status -sb", shell: "bash" },
    ];
    const { container, unmount } = render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
        shellHistory={riskyFirstHistory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    fireEvent.change(screen.getByLabelText("命令规则"), { target: { value: "git *" } });
    const broadItems = Array.from(container.querySelectorAll(".ask-rule-matches li > span")).map(
      (el) => el.textContent,
    );
    expect(broadItems).toEqual(["git status --short", "git status --porcelain", "git status -sb"]);
    unmount();

    // 2. 不透明 PowerShell 命令（-EncodedCommand）放在最前面，用 `pwsh *` 验证被过滤
    const psHistory: PermissionSubject[] = [
      { kind: "shell", target: "pwsh -EncodedCommand SQBFAFgA", shell: "pwsh" },
      { kind: "shell", target: "pwsh -NoProfile -Command { Get-Date }", shell: "pwsh" },
      { kind: "shell", target: "pwsh -NoProfile -Command Get-Location", shell: "pwsh" },
    ];
    const psRender = render(
      <PermissionCard
        pending={shellPending({
          requestId: "req-ps-1",
          subjects: [{ kind: "shell", target: "pwsh -NoProfile -Command Get-Date", shell: "pwsh" }],
          ruleSuggestion: { pattern: "pwsh *" },
        })}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
        shellKind="pwsh"
        shellHistory={psHistory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const psItems = Array.from(
      psRender.container.querySelectorAll(".ask-rule-matches li > span"),
    ).map((el) => el.textContent);
    expect(psItems).toEqual([
      "pwsh -NoProfile -Command Get-Date",
      "pwsh -NoProfile -Command Get-Location",
    ]);
    psRender.unmount();

    // 3. 去重与最多 5 条上限
    const manyHistory: PermissionSubject[] = [
      { kind: "shell", target: "git status --short", shell: "bash" },
      { kind: "shell", target: "git status --porcelain", shell: "bash" },
      { kind: "shell", target: "git status -sb", shell: "bash" },
      { kind: "shell", target: "git status --porcelain", shell: "bash" },
      { kind: "shell", target: "git status -s", shell: "bash" },
      { kind: "shell", target: "git status -v", shell: "bash" },
      { kind: "shell", target: "git status --branch", shell: "bash" },
    ];
    const capRender = render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
        shellHistory={manyHistory}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const capped = Array.from(
      capRender.container.querySelectorAll(".ask-rule-matches li > span"),
    ).map((el) => el.textContent);
    expect(capped).toEqual([
      "git status --short",
      "git status --porcelain",
      "git status -sb",
      "git status -s",
      "git status -v",
    ]);
    capRender.unmount();
  });

  it("shellHistoryFromView 严格依据 Core 证据：排除显式 ask / forceAsk / 仅在 resolution 的规则 deny 与无法确认的人工批准", () => {
    const view = createSessionView();
    const ruleEligibleCalls = new Map<string, boolean>();
    const dispatch = (event: RuntimeEvent) => {
      if (event.type === "permission.requested") {
        ruleEligibleCalls.set(event.payload.callId, event.payload.ruleSuggestion !== undefined);
      }
      reduceSessionView(view, event);
    };

    // 1. 普通 shell 命令：permission.requested 带 ruleSuggestion，用户允许一次 → 应保留
    dispatch({
      seq: 1,
      time: "2026-11-21T00:00:01Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "permission.requested",
      payload: {
        requestId: "r-ok",
        callId: "c-ok",
        subjects: [{ kind: "shell", target: "git status --porcelain", shell: "bash" }],
        reason: "ask",
        options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
        ruleSuggestion: { pattern: "git status *" },
      },
    });
    dispatch({
      seq: 2,
      time: "2026-11-21T00:00:02Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "permission.resolved",
      payload: { requestId: "r-ok", callId: "c-ok", action: "allow", source: "user" },
    });
    dispatch({
      seq: 3,
      time: "2026-11-21T00:00:03Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "tool.started",
      payload: {
        callId: "c-ok",
        name: "shell",
        input: { command: "git status --porcelain" },
        subjects: [{ kind: "shell", target: "git status --porcelain", shell: "bash" }],
        permission: { action: "allow", source: "user" },
      },
    });

    // 2. 命中显式 ask 规则（如 git push * → ask）或 Hook forceAsk：permission.requested 不带 ruleSuggestion → 必须排除
    dispatch({
      seq: 4,
      time: "2026-11-21T00:00:04Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "permission.requested",
      payload: {
        requestId: "r-explicit-ask",
        callId: "c-explicit-ask",
        subjects: [{ kind: "shell", target: "git push origin main", shell: "bash" }],
        reason: "用户配置第 1 条",
        options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
      },
    });
    dispatch({
      seq: 5,
      time: "2026-11-21T00:00:05Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "permission.resolved",
      payload: {
        requestId: "r-explicit-ask",
        callId: "c-explicit-ask",
        action: "allow",
        source: "user",
        rule: "用户配置第 1 条",
      },
    });
    dispatch({
      seq: 6,
      time: "2026-11-21T00:00:06Z",
      sessionId: "parent-1",
      turnId: "t1",
      type: "tool.started",
      payload: {
        callId: "c-explicit-ask",
        name: "shell",
        input: { command: "git push origin main" },
        subjects: [{ kind: "shell", target: "git push origin main", shell: "bash" }],
        permission: { action: "allow", source: "user", rule: "用户配置第 1 条" },
      },
    });

    // 3. 规则硬拒绝：仅结算在 entry.resolution（deny 不发 tool.started，entry.permission 为 undefined）→ 必须排除
    const extraEntries: ViewEntry[] = [
      ...view.entries,
      shellToolEntry("c-rule-deny", "git status -uall", {
        permission: undefined,
        resolution: {
          callId: "c-rule-deny",
          action: "deny",
          source: "rule",
          rule: "用户配置第 2 条",
        },
      }),
      // 4. 曾由模式 Grant 放行：Core 已验证非 userOnly → 应保留
      shellToolEntry("c-pattern-grant", "git status -sb", {
        permission: {
          action: "allow",
          source: "grant",
          rule: undefined,
          grant: {
            scope: "project",
            createdAt: "2026-11-20T00:00:00Z",
            match: "pattern",
            pattern: "git status *",
          },
        },
      }),
      // 5. 仅经精确 Grant 放行且无 ruleSuggestion 证据（无法排除显式 ask）→ 保守省略
      shellToolEntry("c-exact-grant", "git push origin dev", {
        permission: {
          action: "allow",
          source: "grant",
          rule: undefined,
          grant: { scope: "project", createdAt: "2026-11-20T00:00:00Z" },
        },
      }),
      // 6. 无法确认来源的历史人工批准（无 ruleEligibleCalls 记录）→ 保守省略
      shellToolEntry("c-unverified-user", "git status --ignored", {
        permission: { action: "allow", source: "user", rule: undefined },
        resolution: {
          requestId: "r-old",
          callId: "c-unverified-user",
          action: "allow",
          source: "user",
        },
      }),
    ];

    const history = shellHistoryFromView(extraEntries, ruleEligibleCalls);
    const { container } = render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
        shellHistory={history}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    fireEvent.change(screen.getByLabelText("命令规则"), { target: { value: "git *" } });
    const matched = Array.from(container.querySelectorAll(".ask-rule-matches li > span")).map(
      (el) => el.textContent,
    );
    expect(matched).toEqual(["git status --short", "git status --porcelain", "git status -sb"]);
  });

  it("跨会话隔离：父对话转发的子请求不混入父会话历史；SubagentPane 嵌套后代不混入当前子标签历史", async () => {
    // 1. Conversation：父会话有可匹配的 git status --porcelain，但转发的子代理请求不能使用父会话历史
    const parentView = createSessionView();
    parentView.entries.push(
      shellToolEntry("parent-call-1", "git status --porcelain", {
        permission: {
          action: "allow",
          source: "grant",
          rule: undefined,
          grant: {
            scope: "project",
            createdAt: "2026-11-20T00:00:00Z",
            match: "pattern",
            pattern: "git status *",
          },
        },
      }),
    );
    const subPerm: SubagentPendingPermission = {
      requestId: "sub-req-1",
      callId: "child-call-2",
      toolName: "shell",
      childSessionId: "child-1",
      parentCallId: "task-1",
      profile: "explore",
      taskSummary: "检查状态",
      afterSeq: 2,
      order: 1,
      reason: "ask",
      subjects: [{ kind: "shell", target: "git status --short", shell: "bash" }],
      options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
      ruleSuggestion: { pattern: "git status *" },
    };
    parentView.pendingSubagentPermissions = [subPerm];

    const conv = render(
      <Conversation
        session={fakeSession()}
        view={parentView}
        ruleEligibleCalls={new Map([["parent-call-1", true]])}
        openUrl={vi.fn()}
        cwd="Z:/ws"
        subscribeEvents={() => () => undefined}
        images={createAttachmentImageSource()}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const parentCardMatches = Array.from(
      conv.container.querySelectorAll(".ask-rule-matches li > span"),
    ).map((el) => el.textContent);
    expect(parentCardMatches).toEqual(["git status --short"]);
    conv.unmount();

    // 2. SubagentPane：child-1 已加载且有历史 git status --child-only；嵌套后代 grandchild-1 未加载，不得混入 child-1 历史
    const watcher = new SubagentWatcher();
    const runtime: SubagentRuntime = {
      observeSubagent: vi.fn(async (_input, observer: SubagentObserver) => {
        observer.onEvent(userMessage(1, "检查仓库"));
        observer.onEvent({
          seq: 2,
          time: "2026-11-21T00:00:02Z",
          sessionId: "child-1",
          turnId: "ct1",
          type: "permission.requested",
          payload: {
            requestId: "cr-1",
            callId: "cc-1",
            subjects: [{ kind: "shell", target: "git status --child-only", shell: "bash" }],
            reason: "ask",
            options: ["allow_once", "allow_session", "allow_project", "deny", "deny_stop"],
            ruleSuggestion: { pattern: "git status *" },
          },
        });
        observer.onEvent({
          seq: 3,
          time: "2026-11-21T00:00:03Z",
          sessionId: "child-1",
          turnId: "ct1",
          type: "permission.resolved",
          payload: { requestId: "cr-1", callId: "cc-1", action: "allow", source: "user" },
        });
        observer.onEvent({
          seq: 4,
          time: "2026-11-21T00:00:04Z",
          sessionId: "child-1",
          turnId: "ct1",
          type: "tool.started",
          payload: {
            callId: "cc-1",
            name: "shell",
            input: { command: "git status --child-only" },
            subjects: [{ kind: "shell", target: "git status --child-only", shell: "bash" }],
            permission: { action: "allow", source: "user" },
          },
        });
        observer.onEvent(assistantMessage(5, "等待确认"));
        return {
          mode: "live" as const,
          lastSeq: 5,
          summary: summary({ childSessionId: "child-1", state: "running" }),
          unsubscribe: vi.fn(),
        };
      }),
      readSubagentAttachment: vi.fn(async () => ({
        data: new Uint8Array(),
        bytes: 0,
        mimeType: "image/png",
      })),
    };

    const grandchildPerm: SubagentPendingPermission = {
      ...subPerm,
      requestId: "grand-req-1",
      callId: "grand-call-1",
      childSessionId: "grandchild-1",
      profile: "nested",
      taskSummary: "后代检查",
      order: 2,
      subjects: [{ kind: "shell", target: "git status --grandchild", shell: "bash" }],
    };

    const pane = render(
      <SubagentPane
        tab={{
          id: "tab-1",
          kind: "subagent",
          childSessionId: "child-1",
          parentCallId: "task-1",
          profile: "explore",
          taskSummary: "检查状态",
        }}
        parentSessionId="parent-1"
        visible
        watcher={watcher}
        runtime={runtime}
        summary={summary({ childSessionId: "child-1", state: "running" })}
        parentEntry={undefined}
        workspace="Z:/ws"
        images={createAttachmentImageSource()}
        openUrl={vi.fn()}
        pendingPermissions={[subPerm, grandchildPerm]}
        onRespondPermission={vi.fn(async () => undefined)}
      />,
    );

    const ruleBtns = await screen.findAllByRole("button", { name: "改成规则…" });
    expect(ruleBtns).toHaveLength(2);
    // 展开第一张卡（child-1 直属请求）：应包含 child-1 自己的历史 git status --child-only
    fireEvent.click(ruleBtns[0] as HTMLElement);
    // 展开第二张卡（grandchild-1 嵌套后代请求）：未加载后代视图，只应包含后代自己的当前命令
    fireEvent.click(ruleBtns[1] as HTMLElement);

    const lists = Array.from(pane.container.querySelectorAll(".ask-rule-matches")).map((ul) =>
      Array.from(ul.querySelectorAll("li > span")).map((el) => el.textContent),
    );
    expect(lists).toEqual([
      ["git status --short", "git status --child-only"],
      ["git status --grandchild"],
    ]);
    watcher.dispose();
  });

  it("输入不合法模式时标红 invalid、隐藏匹配列表、显示对应错误文案并禁用「允许并保存」", () => {
    const { container } = render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const input = screen.getByLabelText("命令规则");
    const submit = () => screen.getByRole("button", { name: "允许并保存" }) as HTMLButtonElement;

    const cases: [string, string][] = [
      ["git log *", "不匹配当前命令"],
      ["npm *", "开头要是 git"],
      ["g* status *", "开头要是 git"],
      ["git status * && echo ok", "不能包含 &&、|、; 等连接符"],
      ["git status * | cat", "不能包含 &&、|、; 等连接符"],
      ["git status * ; ls", "不能包含 &&、|、; 等连接符"],
      ["   ", "不匹配当前命令"],
      [`git ${"a".repeat(200)}`, "不匹配当前命令"],
    ];

    for (const [value, expectedMessage] of cases) {
      fireEvent.change(input, { target: { value } });
      expect(input.className).toContain("invalid");
      expect(container.querySelector(".ask-rule-matches")).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe(expectedMessage);
      expect(submit().disabled).toBe(true);
    }

    // 改回合法模式后恢复正常
    fireEvent.change(input, { target: { value: "git status *" } });
    expect(input.className).not.toContain("invalid");
    expect(container.querySelector(".ask-rule-matches")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it("允许并保存发送 remember=pattern；Esc（输入框与返回按钮）与点返回均回到选项而不发 deny", async () => {
    const onRespond = vi.fn(async () => undefined);
    render(<PermissionCard pending={shellPending()} onRespond={onRespond} cwd="Z:/ws" />);
    const card = screen.getByRole("region", { name: "权限确认" });

    // 展开后在输入框按 Esc 返回选项且聚焦卡片
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const input1 = screen.getByLabelText("命令规则");
    fireEvent.keyDown(input1, { key: "Escape" });
    expect(screen.queryByLabelText("命令规则")).toBeNull();
    expect(document.activeElement).toBe(card);
    expect(onRespond).not.toHaveBeenCalled();

    // 再次展开，焦点在「返回」按钮上按 Esc 也应退回选项而非发 deny
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    const backBtn = screen.getByRole("button", { name: "返回" });
    backBtn.focus();
    fireEvent.keyDown(backBtn, { key: "Escape" });
    expect(screen.queryByLabelText("命令规则")).toBeNull();
    expect(document.activeElement).toBe(card);
    expect(onRespond).not.toHaveBeenCalled();

    // 再次展开，编辑后点击「允许并保存」
    fireEvent.click(screen.getByRole("button", { name: "改成规则…" }));
    fireEvent.change(screen.getByLabelText("命令规则"), { target: { value: "  git status *  " } });
    fireEvent.click(screen.getByRole("button", { name: "允许并保存" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith({
        decision: "allow",
        remember: "pattern",
        pattern: "git status *",
      }),
    );
  });

  it(".phone 容器下与 hidePersistentPermissions=true 时均不显示「改成规则…」", () => {
    const { unmount } = render(
      <div className="phone">
        <PermissionCard
          pending={shellPending()}
          onRespond={vi.fn(async () => undefined)}
          cwd="Z:/ws"
        />
      </div>,
    );
    expect(screen.queryByRole("button", { name: "改成规则…" })).toBeNull();
    unmount();

    render(
      <PermissionCard
        pending={shellPending()}
        onRespond={vi.fn(async () => undefined)}
        cwd="Z:/ws"
        hidePersistentPermissions
      />,
    );
    expect(screen.queryByRole("button", { name: "改成规则…" })).toBeNull();
  });
});
