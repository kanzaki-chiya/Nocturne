import { expect, it } from "vitest";
import { foldEvents } from "./fold.js";
import { mcpAvailabilityNote } from "./mcp-note.js";
import { decodeDurableEvent, type DurableEvent } from "../protocol/index.js";

function event(payload: unknown): DurableEvent {
  return decodeDurableEvent(
    JSON.stringify({
      type: "session.config_changed",
      sessionId: "s",
      seq: 1,
      time: "2026-10-29T00:00:00Z",
      payload,
    }),
  );
}

it("MCP 字段经 schema 保留；多台合一条 note，重放文字与可用性相同", () => {
  const changes = [
    { server: "browseros", available: false, reason: "connection refused", autoRetry: true },
    { server: "stdio", available: false, reason: "x".repeat(250), autoRetry: false },
    { server: "restored", available: true },
  ];
  const e = event({ mcp: changes });
  const state = foldEvents([e]);
  expect(state.mcpAvailability).toEqual({ browseros: false, stdio: false, restored: true });
  expect(state.history).toHaveLength(1);
  expect(state.history[0]).toMatchObject({
    kind: "note",
    seq: 1,
    text: mcpAvailabilityNote(changes),
  });
  expect(JSON.stringify(state.history)).toContain(
    "will not retry it automatically again in this session",
  );
  expect(JSON.stringify(state.history)).not.toContain("x".repeat(201));
  expect(foldEvents([event(JSON.parse(JSON.stringify(e.payload)))])).toEqual(state);
});

it("旧 config_changed 不生成 MCP 状态或说明", () => {
  const state = foldEvents([event({ permissionPreset: "default" })]);
  expect(state.history).toEqual([]);
  expect(state.mcpAvailability).toBeUndefined();
});
