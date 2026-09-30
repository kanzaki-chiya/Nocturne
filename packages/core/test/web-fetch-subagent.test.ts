import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import { FakeProvider } from "../src/provider/index.js";
import type { DurableEvent, RuntimeEvent } from "../src/protocol/index.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("explore 实际包含 web_fetch，继承父会话主机 Grant 并拒绝未授权主机", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nct-web-subagent-"));
  roots.push(root);
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (input) => {
      fetched.push(String(input));
      return new Response("public documentation", { headers: { "Content-Type": "text/plain" } });
    }),
  );
  let parentStep = 0;
  let childStep = 0;
  const provider = new FakeProvider({
    handler: (request) => {
      const child = request.tools.some((tool) => tool.name === "finish");
      if (child) {
        expect(request.tools.some((tool) => tool.name === "web_fetch")).toBe(true);
        if (childStep++ === 0)
          return [
            {
              type: "tool_call",
              toolCallId: "allowed",
              name: "web_fetch",
              input: { url: "https://docs.example/child" },
            },
            {
              type: "tool_call",
              toolCallId: "denied",
              name: "web_fetch",
              input: { url: "https://other.example/child" },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        return [
          {
            type: "tool_call",
            toolCallId: "finish",
            name: "finish",
            input: { result: "已读取授权主机，另一主机受阻" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      }
      if (parentStep++ === 0)
        return [
          {
            type: "tool_call",
            toolCallId: "parent-fetch",
            name: "web_fetch",
            input: { url: "https://docs.example/parent" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      if (parentStep === 2)
        return [
          {
            type: "tool_call",
            toolCallId: "task",
            name: "task",
            input: { task: "抓取两站文档", preset: "explore" },
          },
          { type: "finish", reason: "tool_calls" },
        ];
      return [
        { type: "text_delta", text: "done" },
        { type: "finish", reason: "stop" },
      ];
    },
  });
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir: path.join(root, "sessions"),
    providers: [provider],
    interactive: true,
  });
  const session = await runtime.createSession({ model: "fake/fake-model" });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "permission.requested") {
      expect(event.payload.subjects).toEqual([
        { kind: "network", target: "docs.example", detail: "https://docs.example/parent" },
      ]);
      void session.respondPermission(event.payload.requestId, {
        decision: "allow",
        remember: "session",
      });
    }
  });
  try {
    expect(await session.submit({ text: "先授权文档主机再委派抓取" })).toBe("done");
    expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    expect(fetched).toEqual(["https://docs.example/parent", "https://docs.example/child"]);
    const task = events.find(
      (event) => event.type === "tool.completed" && event.payload.name === "task",
    );
    if (task?.type !== "tool.completed") throw new Error("Missing task result");
    expect(task.payload.status).toBe("ok");
    const output = task.payload.output as { childLogPath: string };
    const childEvents = readFileSync(output.childLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DurableEvent);
    expect(childEvents.filter((event) => event.type === "permission.requested")).toHaveLength(0);
    expect(
      childEvents
        .filter((event) => event.type === "tool.completed" && event.payload.name === "web_fetch")
        .map((event) => (event.type === "tool.completed" ? event.payload.status : undefined))
        .sort(),
    ).toEqual(["denied", "ok"]);
  } finally {
    await session.close();
  }
});
