// @vitest-environment jsdom
/**
 * 覆盖 SidePanel 内已打开的成员会话标签（EnsembleMemberPane）只读冻结状态转换：
 * 1) Ensemble 活动且成员在列时，显示输入框（.composer）与待确认权限卡片；
 * 2) 指挥的 ensemble.status 变为 "ended" 后，输入框与权限卡片立即收起，
 *    对话以 readOnly + frozen 只读展示（保留私信气泡但无编辑/重发按钮，不误标子代理「任务/催促」）；
 * 3) Ensemble 仍为 "active" 但成员 status 变为 "removed"（或同会话新建第二个 Ensemble 不再包含该成员）时，同样只读并收起输入框。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatEnsemblePostForModel,
  type RuntimeEvent,
  type EnsembleMemberStatus,
  type EnsembleView,
} from "@nocturne/core/protocol";
import { createMemoryTransportPair, createRpcClient } from "@nocturne/rpc/client";

import { createAttachmentImageSource } from "../src/attachment-images";
import { SidePanel } from "../src/SidePanel";
import type { PanelTab } from "../src/side-panel";
import type { EnsembleSession } from "../src/EnsemblePane";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

afterEach(cleanup);

const CHILD = "child-runner";

function createMemberHarness() {
  const [clientEnd, serverEnd] = createMemoryTransportPair();
  const replies: Record<string, unknown> = {
    initialize: { protocolVersion: 1, nocturneVersion: "test" },
    "session.open": {
      sessionId: CHILD,
      meta: {
        id: CHILD,
        cwd: "Z:/fixture",
        workspaceRoot: "Z:/fixture",
        formatVersion: 1,
        nocturneVersion: "test",
      },
      config: { model: { provider: "smoke", model: "deepseek-v4.1-flash" } },
      warnings: [],
      lastSeq: 0,
    },
    "session.subscribe": { lastSeq: 0 },
    "session.pendingInputs": { items: [], paused: false },
    "session.describeSkills": {
      skills: [],
      warnings: [],
      budget: {},
      scannedDirs: [],
      homeDir: "C:/home",
    },
    "session.describeExternalAgents": { agents: [], warnings: [] },
    "session.shellInfo": {
      selected: "auto",
      source: "auto",
      effective: { kind: "pwsh", name: "PowerShell 7", path: "pwsh" },
    },
    "session.readInputHistory": { entries: [] },
    "session.fileIndex": { files: [], truncated: false },
    "session.close": null,
  };

  serverEnd.onLine((line) => {
    const req = JSON.parse(line) as { id?: unknown; method?: string };
    if (req.id === undefined) return;
    serverEnd.send(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: replies[req.method ?? ""] ?? null }),
    );
  });

  const client = createRpcClient(clientEnd, { clientName: "test", interactive: false });
  let initialized: Promise<unknown> | undefined;
  return {
    emit(event: RuntimeEvent) {
      serverEnd.send(
        JSON.stringify({ jsonrpc: "2.0", method: "event", params: { sessionId: CHILD, event } }),
      );
    },
    ensureClient: () => {
      initialized ??= client.initialize();
      return initialized.then(() => client);
    },
    close() {
      client.close();
    },
  };
}

function makeEnsembleView(options: {
  ensembleStatus: EnsembleView["status"];
  memberStatus?: EnsembleMemberStatus | "absent";
}): EnsembleView {
  return {
    createdSeq: 2,
    ...(options.ensembleStatus === "ended" ? { endedSeq: 20, endedReason: "user" as const } : {}),
    title: "函数核对",
    status: options.ensembleStatus,
    maestro: {
      model: { provider: "smoke", model: "deepseek-v4.1-flash" },
      status: "waiting",
      awaitingPermission: false,
    },
    members:
      options.memberStatus === "absent"
        ? [
            {
              name: "other",
              childSessionId: "child-other",
              charter: { owns: "x", handsOff: "y", doneWhen: "z" },
              model: { provider: "smoke", model: "deepseek-v4.1-flash" },
              preset: "general",
              isolated: false,
              status: "working",
              pendingPermissions: [],
            },
          ]
        : [
            {
              name: "runner",
              childSessionId: CHILD,
              charter: { owns: "运行命令", handsOff: "不改文件", doneWhen: "回帖" },
              model: { provider: "smoke", model: "deepseek-v4.1-flash" },
              preset: "general",
              isolated: false,
              status: options.memberStatus ?? "working",
              pendingPermissions: [],
            },
          ],
    awaitingPermissionMembers: [],
    posts: [],
  };
}

const TABS: PanelTab[] = [
  { id: "tab-ensemble", kind: "ensemble" },
  { id: "tab-runner", kind: "ensemble_member", childSessionId: CHILD, memberName: "runner" },
];

const NOOP_ENSEMBLE_SESSION: EnsembleSession = {
  postToEnsemble: async () => ({ number: 1, recipients: [] }),
  removeEnsembleMember: async () => undefined,
  endEnsemble: async () => ({ unmerged: [] }),
};

function makeBaseSidePanelProps() {
  return {
    tabs: TABS,
    activeId: "tab-runner",
    overlay: false,
    width: 440,
    onActivate: vi.fn(),
    onCloseTab: vi.fn(),
    onMoveTab: vi.fn(),
    onNewTab: vi.fn(),
    onResize: vi.fn(),
    onOpenChanges: vi.fn(),
    onQuickOpen: vi.fn(),
    onOpenTerminal: vi.fn(),
    onAddress: async () => undefined,
    changes: undefined,
    canOpenFiles: false,
    readFile: async () => {
      throw new Error("unused");
    },
    readerKey: "r0",
    fileActions: {
      externalLabel: "VS Code",
      openExternal: async () => undefined,
      reveal: async () => undefined,
      openInBrowser: async () => undefined,
      browserLabel: "打开",
    },
    terminals: undefined,
    loadShells: async () => ({ shells: [], setting: undefined }),
    onShellChange: vi.fn(),
    workspace: "Z:/fixture",
  };
}

describe("SidePanel 成员会话标签只读冻结", () => {
  it("active 时显示输入框与权限卡；ensemble.status 变为 ended 后隐藏输入框并转为只读", async () => {
    const h = createMemberHarness();
    const images = createAttachmentImageSource();

    const baseProps = makeBaseSidePanelProps();
    const renderPanel = (ensemble: EnsembleView) => (
      <SidePanel
        {...baseProps}
        ensemble={{
          ensemble,
          session: NOOP_ENSEMBLE_SESSION,
          ensureClient: h.ensureClient,
          images,
          pickImages: async () => [],
          openUrl: vi.fn(),
          onOpenMember: vi.fn(),
        }}
      />
    );

    const { container, rerender } = render(
      renderPanel(makeEnsembleView({ ensembleStatus: "active", memberStatus: "working" })),
    );

    // 等 session.open 与 subscribe 完成，推入一条留言板投递、一条用户私信和一个待确认权限
    await vi.waitFor(() => {
      expect(container.querySelector(".sp-ensemble-member .composer")).not.toBeNull();
    });

    act(() => {
      h.emit({
        type: "message.user",
        sessionId: CHILD,
        seq: 1,
        turnId: "t1",
        time: "2026-11-12T12:00:00.000Z",
        payload: {
          messageId: "m1",
          content: [
            {
              type: "text",
              text: formatEnsemblePostForModel({
                number: 3,
                from: "maestro",
                text: "@runner 开始工作",
              }),
            },
          ],
          ensemble: { postNumber: 3, from: "maestro", fromKind: "maestro" },
        },
      });
      h.emit({
        type: "message.user",
        sessionId: CHILD,
        seq: 2,
        turnId: "t2",
        time: "2026-11-12T12:01:00.000Z",
        payload: {
          messageId: "m2",
          content: [{ type: "text", text: "这是一条私信" }],
        },
      });
      h.emit({
        type: "permission.requested",
        sessionId: CHILD,
        seq: 3,
        turnId: "t2",
        time: "2026-11-12T12:01:05.000Z",
        payload: {
          requestId: "perm-1",
          callId: "c1",
          reason: "运行验证命令",
          subjects: [{ kind: "shell", target: "node -v" }],
          options: ["allow_once", "deny"],
        },
      });
    });

    await vi.waitFor(() => {
      expect(container.querySelector(".sp-ensemble-member .composer")).not.toBeNull();
      expect(
        container.querySelector(
          ".sp-ensemble-member .pcard, .sp-ensemble-member .conversation-requests",
        ),
      ).not.toBeNull();
    });

    // 把指挥的 ensemble.status 改为 "ended"：输入框与权限卡立即收起，对话只读
    rerender(renderPanel(makeEnsembleView({ ensembleStatus: "ended", memberStatus: "waiting" })));

    expect(container.querySelector(".sp-ensemble-member .composer")).toBeNull();
    expect(container.querySelector(".sp-ensemble-member .conversation-requests")).toBeNull();
    // 留言板投递仍显示为 → @runner，私信保留为用户气泡且无重发/编辑按钮，也不误标子代理「催促/任务」
    expect(container.querySelector(".sp-ensemble-member .post-in")?.textContent).toContain(
      "→ @runner",
    );
    expect(container.querySelector(".sp-ensemble-member .u")?.textContent).toContain(
      "这是一条私信",
    );
    expect(container.querySelector(".sp-ensemble-member .ro-user")).toBeNull();
    expect(container.textContent).not.toContain("编辑并重发");

    images.dispose();
    h.close();
  });

  it("成员被移除（memberStatus === removed）或被新 Ensemble 取代（memberStatus === undefined）时同样只读无输入框", async () => {
    const h = createMemberHarness();
    const images = createAttachmentImageSource();

    const baseProps = makeBaseSidePanelProps();
    const renderPanel = (ensemble: EnsembleView) => (
      <SidePanel
        {...baseProps}
        ensemble={{
          ensemble,
          session: NOOP_ENSEMBLE_SESSION,
          ensureClient: h.ensureClient,
          images,
          pickImages: async () => [],
          openUrl: vi.fn(),
          onOpenMember: vi.fn(),
        }}
      />
    );

    const { container, rerender } = render(
      renderPanel(makeEnsembleView({ ensembleStatus: "active", memberStatus: "waiting" })),
    );

    await vi.waitFor(() => {
      expect(container.querySelector(".sp-ensemble-member .composer")).not.toBeNull();
    });

    // 1) Ensemble 仍在活动中，但该成员被移除（status === "removed"）
    rerender(renderPanel(makeEnsembleView({ ensembleStatus: "active", memberStatus: "removed" })));
    expect(container.querySelector(".sp-ensemble-member .composer")).toBeNull();

    // 2) 恢复为活跃成员时输入框出现；随后同会话开启新 Ensemble（旧成员不在新 members 中，memberStatus === undefined）仍保持只读无输入框
    rerender(renderPanel(makeEnsembleView({ ensembleStatus: "active", memberStatus: "working" })));
    expect(container.querySelector(".sp-ensemble-member .composer")).not.toBeNull();

    rerender(renderPanel(makeEnsembleView({ ensembleStatus: "active", memberStatus: "absent" })));
    expect(container.querySelector(".sp-ensemble-member .composer")).toBeNull();

    images.dispose();
    h.close();
  });
});
