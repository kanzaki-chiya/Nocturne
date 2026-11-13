/**
 * 打开成员会话的界面句柄（runtime.resumeSession(childSessionId)，RPC `session.open`）再关闭，
 * 只释放句柄：不中断、不关闭 Runtime 托管的常驻成员（ADR-0089 §10，rpc.md 第 3 节）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, type RuntimeSession } from "../src/index.js";
import { replaySessionView } from "../src/protocol/index.js";
import { FakeProvider, type FakeScript, type ModelRequest } from "../src/provider/index.js";

const roots: string[] = [];
const sessions: RuntimeSession[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const stopText = (text: string): FakeScript => [
  { type: "text_delta", text },
  { type: "finish", reason: "stop" },
];

function role(req: ModelRequest): string {
  const sys = req.system.map((b) => b.text).join("\n");
  const match = /persistent ensemble member `@([a-z0-9-]+)`/.exec(sys);
  return match?.[1] !== undefined ? `member:${match[1]}` : "maestro";
}

describe("Ensemble 成员会话句柄", { timeout: 30_000 }, () => {
  it("关闭成员会话句柄不中断、不移除成员，之后仍能被 @ 唤醒", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "nocturne-ensemble-close-"));
    roots.push(ws);
    let setup = false;
    const memberTurns: string[] = [];
    const provider = new FakeProvider({
      id: "fake",
      models: [
        {
          ref: { provider: "fake", model: "m1" },
          protocol: "openai-compatible" as const,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: {
            toolCalls: true,
            parallelToolCalls: true,
            reasoning: "none" as const,
            imageInput: false,
            promptCache: false,
            editTool: "edit" as const,
          },
        },
      ],
      roleHandler: () => stopText("Title"),
      handler: (req) => {
        const who = role(req);
        if (who === "maestro") {
          if (!setup) {
            setup = true;
            return [
              { type: "tool_call", toolCallId: "i", name: "ensemble_init", input: { title: "T" } },
              {
                type: "tool_call",
                toolCallId: "a",
                name: "ensemble_add_member",
                input: {
                  name: "worker",
                  charter: { owns: "a.ts", handsOff: "b.ts", doneWhen: "tests pass" },
                },
              },
              { type: "finish", reason: "tool_calls" },
            ];
          }
          return stopText("coord idle");
        }
        memberTurns.push(JSON.stringify(req.messages));
        return stopText("worker done");
      },
    });
    const rt = await createRuntime({
      cwd: ws,
      workspaceRoot: ws,
      sessionsDir: path.join(ws, ".sessions"),
      providers: [provider],
      interactive: true,
      subagent: { background: true },
    });
    const coord = await rt.createSession({ model: "fake/m1", permissionPreset: "bypass" });
    sessions.push(coord);
    await coord.submit({ text: "go", workMode: "ensemble" });
    await vi.waitFor(() => {
      expect(replaySessionView(coord.durableEvents()).ensemble?.members).toHaveLength(1);
      expect(coord.isIdle()).toBe(true);
    });
    const child =
      replaySessionView(coord.durableEvents()).ensemble?.members[0]?.childSessionId ?? "";

    // 打开成员句柄并私信一轮
    const handle = await rt.resumeSession(child);
    await handle.submit({ text: "PRIVATE-1" });
    await vi.waitFor(() => {
      expect(memberTurns.some((m) => m.includes("PRIVATE-1"))).toBe(true);
      expect(coord.isIdle()).toBe(true);
    });

    // 关闭句柄：成员仍在 Ensemble 里、未被移除，Ensemble 仍是活动状态
    await handle.close();
    const view = replaySessionView(coord.durableEvents()).ensemble;
    expect(view?.status).toBe("active");
    expect(view?.members[0]?.status).not.toBe("removed");

    // 之后仍能被留言板 @ 唤醒，且能重新打开句柄
    await coord.postToEnsemble({ text: "@worker AFTER-CLOSE" });
    await vi.waitFor(() => {
      expect(memberTurns.some((m) => m.includes("AFTER-CLOSE"))).toBe(true);
    });
    const again = await rt.resumeSession(child);
    expect(again.id).toBe(child);
    await again.close();
  });
});
