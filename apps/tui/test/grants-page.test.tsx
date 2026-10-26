import { render } from "ink-testing-library";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import type { Runtime, RuntimeSession } from "@nocturne/core";
import type { Grant } from "@nocturne/core/protocol";
import { GrantsPage } from "../src/components/grants-page.js";
import { runSlash } from "../src/commands.js";
import { ToolRow } from "../src/components/tool-row.js";
import { layoutEntry } from "../src/lines.js";
import type { ToolEntry } from "@nocturne/core/protocol";

it("工具已授权标签在普通屏幕和全屏一致", () => {
  const entry = {
    kind: "tool",
    key: "t",
    callId: "c",
    turnId: "turn",
    seq: 1,
    time: "2026-10-20",
    name: "shell",
    input: { command: "git status" },
    subjects: [],
    target: undefined,
    permission: { action: "allow", source: "grant", rule: undefined },
    status: "ok",
    liveOutput: "",
    result: undefined,
    review: undefined,
    resolution: undefined,
  } as ToolEntry;
  const screen = render(createElement(ToolRow, { entry, width: 120 }));
  expect(screen.lastFrame()).toContain("（已授权）");
  expect(
    layoutEntry(entry, 120, false)
      .map((line) => line.text)
      .join("\n"),
  ).toContain("（已授权）");
  screen.unmount();
});
function fixture() {
  let entries: Grant[] = [{ kind: "shell", target: "git status", createdAt: "2026-10-20" }];
  let trusted = false;
  const runtime = {
    listGrantWorkspaces: vi.fn(async () => [
      { workspace: "Z:/project", grantCount: entries.length, trusted, hasProjectConfig: true },
    ]),
    listGrants: vi.fn(async () => entries),
    onGrantsChanged: () => () => undefined,
    revokeGrant: vi.fn(async () => {
      entries = [];
    }),
    revokeAllGrants: vi.fn(async () => {
      entries = [];
    }),
    describeProject: vi.fn(async () => ({
      mcpServers: [{ name: "test", command: "node test.mjs --stdio" }],
      hooks: [{ event: "PreToolUse", count: 2 }],
      relaxedRuleCount: 3,
    })),
    setWorkspaceTrusted: vi.fn(async (input: { trusted: boolean }) => {
      trusted = input.trusted;
    }),
  };
  const session = { state: () => ({ meta: { workspaceRoot: "Z:/project" } }) } as RuntimeSession;
  const close = vi.fn();
  const screen = render(
    createElement(GrantsPage, {
      runtime: runtime as unknown as Runtime,
      session,
      width: 110,
      height: 28,
      onClose: close,
    }),
  );
  return { runtime, screen, close, session };
}
async function frame(h: ReturnType<typeof fixture>, text: string) {
  await vi.waitFor(() => expect(h.screen.lastFrame()).toContain(text));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
it("/grants 打开 PageShell；d 撤销且空状态，Esc 返回", async () => {
  const h = fixture();
  expect(await runSlash("/grants", h.session)).toEqual({ kind: "overlay", name: "grants" });
  await frame(h, "git status");
  expect(h.screen.lastFrame()).toMatchSnapshot();
  h.screen.stdin.write("d");
  await frame(h, "还没有项目授权");
  expect(h.runtime.revokeGrant).toHaveBeenCalledWith({
    workspace: "Z:/project",
    kind: "shell",
    target: "git status",
  });
  h.screen.stdin.write("\u001b");
  await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  h.screen.unmount();
});
it("D 二次确认；t 展示项目配置后确认信任，取消信任不确认", async () => {
  const h = fixture();
  await frame(h, "git status");
  h.screen.stdin.write("D");
  await frame(h, "撤销这个工作区的全部授权");
  expect(h.runtime.revokeAllGrants).not.toHaveBeenCalled();
  h.screen.stdin.write("\r");
  await frame(h, "还没有项目授权");
  expect(h.runtime.revokeAllGrants).toHaveBeenCalledOnce();
  h.screen.stdin.write("t");
  await frame(h, "node test.mjs --stdio");
  expect(h.screen.lastFrame()).toContain("PreToolUse");
  expect(h.screen.lastFrame()).toContain("放宽规则 3");
  expect(h.runtime.setWorkspaceTrusted).not.toHaveBeenCalled();
  h.screen.stdin.write("\r");
  await frame(h, "已信任");
  h.screen.stdin.write("t");
  await frame(h, "未信任");
  expect(h.runtime.setWorkspaceTrusted).toHaveBeenLastCalledWith({
    workspace: "Z:/project",
    trusted: false,
  });
  h.screen.unmount();
});
