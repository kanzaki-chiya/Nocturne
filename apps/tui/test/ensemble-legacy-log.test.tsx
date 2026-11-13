/**
 * r1114d：TUI /resume 遇到手写的旧 swarm 日志。
 * 列表照常显示，打开时提示行是 Runtime 原文；旧成员子会话不进 /resume，
 * 单独打开时按普通用户消息显示，正文保留 <swarm-post>，没有「→ 指挥」。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";

import { createRuntime, FakeProvider, replaySessionView } from "@nocturne/core";

import { App } from "../src/app.js";
import { TuiEnvContext } from "../src/env.js";
import { layoutEntry } from "../src/lines.js";
import type { SwitchSessionFn } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const LEGACY_OPEN_ERROR = "日志包含不认识的持久化事件类型: 不认识的持久化事件类型: swarm.created";
const CHILD_POST = '<swarm-post n="1" from="orders">成员汇报订单</swarm-post>';

function writeLegacy(
  sessionsDir: string,
  cwd: string,
  workspaceRoot: string,
): {
  parentId: string;
  childId: string;
} {
  const parentId = "20261114-tuiparent";
  const childId = "20261114-tuimember";
  const created = (id: string, parent?: { sessionId: string; callId: string }) => ({
    type: "session.created",
    sessionId: id,
    seq: 1,
    time: "2026-11-14T00:00:00.000Z",
    payload: {
      formatVersion: 1,
      nocturneVersion: "0.0.0",
      cwd,
      workspaceRoot,
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      ...(parent !== undefined ? { parent } : {}),
    },
  });
  writeFileSync(
    path.join(sessionsDir, `${parentId}.jsonl`),
    [
      JSON.stringify(created(parentId)),
      JSON.stringify({
        type: "message.user",
        sessionId: parentId,
        seq: 2,
        time: "2026-11-14T00:00:01.000Z",
        payload: {
          messageId: "m-parent",
          content: [{ type: "text", text: "旧合奏要改订单页" }],
        },
      }),
      JSON.stringify({
        type: "swarm.created",
        sessionId: parentId,
        seq: 3,
        time: "2026-11-14T00:00:02.000Z",
        payload: { title: "订单页" },
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    path.join(sessionsDir, `${childId}.jsonl`),
    [
      JSON.stringify(created(childId, { sessionId: parentId, callId: "swarm:orders" })),
      JSON.stringify({
        type: "message.user",
        sessionId: childId,
        seq: 2,
        time: "2026-11-14T00:00:03.000Z",
        payload: {
          messageId: "m-child",
          content: [{ type: "text", text: CHILD_POST }],
          swarm: { postNumber: 1, from: "orders", fromKind: "member" },
        },
      }),
    ].join("\n") + "\n",
  );
  return { parentId, childId };
}

async function waitFor(check: () => boolean, detail: () => string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`waitFor 超时\n${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("TUI /resume 列出旧日志，打开时只显示 Runtime 原文，归档后从列表消失", async () => {
  const cwd = tmp("nct-tui-legacy-ws-");
  const sessionsDir = tmp("nct-tui-legacy-sd-");
  const runtime = await createRuntime({
    cwd,
    sessionsDir,
    providers: [
      new FakeProvider({
        handler: () => [
          { type: "text_delta", text: "好" },
          { type: "finish", reason: "stop" },
        ],
      }),
    ],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  await session.submit({ text: "可搜索的好会话" });
  await waitFor(
    () => session.state().openTurn === undefined,
    () => `turn ${JSON.stringify(session.state().openTurn)}`,
  );
  const meta = session.state().meta;
  const { parentId, childId } = writeLegacy(sessionsDir, meta.cwd, meta.workspaceRoot);
  const switcher: SwitchSessionFn = async (id) => {
    try {
      return { kind: "ok", session: await runtime.resumeSession(id) };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
  const { lastFrame, stdin, unmount } = render(
    createElement(
      TuiEnvContext.Provider,
      { value: { ascii: false, animated: false } },
      createElement(App, {
        session,
        runtime,
        env: { ascii: false, animated: false },
        switchSession: switcher,
      }),
    ),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("/resume");
    stdin.write("\r");
    await waitFor(
      () => (lastFrame() ?? "").includes("旧合奏要改订单页"),
      () => lastFrame() ?? "",
    );
    const list = lastFrame() ?? "";
    expect(list).toContain("可搜索的好会话");
    expect(list).not.toContain("成员汇报订单");
    expect(list).not.toContain(childId);
    // 旧日志更新更晚，排在第一行；Enter 打开它
    expect(list.indexOf("旧合奏要改订单页")).toBeLessThan(list.indexOf("可搜索的好会话"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write("\r");
    await waitFor(
      () => (lastFrame() ?? "").includes("swarm.created"),
      () => lastFrame() ?? "",
    );
    const failed = lastFrame() ?? "";
    expect(failed).toContain(`! ${LEGACY_OPEN_ERROR}`);
    expect(failed).not.toContain("已切换到会话");
    expect(failed).not.toContain("旧格式");

    await runtime.archiveSession(parentId);
    stdin.write("/resume");
    stdin.write("\r");
    await waitFor(
      () => (lastFrame() ?? "").includes("可搜索的好会话"),
      () => lastFrame() ?? "",
    );
    expect(lastFrame()).not.toContain("旧合奏要改订单页");
    stdin.write("\u001b");
    await waitFor(
      () => !(lastFrame() ?? "").includes("切换到会话"),
      () => lastFrame() ?? "",
    );
    await runtime.unarchiveSession(parentId);
    stdin.write("/resume");
    stdin.write("\r");
    await waitFor(
      () => (lastFrame() ?? "").includes("旧合奏要改订单页"),
      () => lastFrame() ?? "",
    );
  } finally {
    unmount();
    await session.close();
  }

  const child = await runtime.resumeSession(childId);
  try {
    const user = replaySessionView(child.durableEvents()).entries.find(
      (entry) => entry.kind === "user",
    );
    expect(user?.kind).toBe("user");
    if (user?.kind !== "user") throw new Error("缺少用户消息");
    const laid = layoutEntry(user, 80, false)
      .map((line) => line.text)
      .join("\n");
    expect(laid).toContain(CHILD_POST);
    expect(laid).not.toContain("→");
  } finally {
    await child.close();
  }
});
