import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createPlatform } from "@nocturne/core";
import { permissionOutcome, permissionSubjects } from "../src/permissions.js";

const { paths } = createPlatform();
const cwd = paths.resolve(process.cwd(), "workspace");
const kinds = [
  "read",
  "search",
  "edit",
  "delete",
  "move",
  "execute",
  "fetch",
  "switch_mode",
  "think",
  "other",
  "future",
  undefined,
] as const;
const options: RequestPermissionRequest["options"] = [
  { kind: "allow_once", optionId: "allow", name: "Allow" },
  { kind: "allow_always", optionId: "always", name: "Always" },
  { kind: "reject_once", optionId: "deny", name: "Deny" },
  { kind: "reject_always", optionId: "denyAlways", name: "Deny always" },
];
const combinations = Array.from({ length: 16 }, (_, mask) => ({
  mask,
  options: options.filter((_option, index) => (mask & (1 << index)) !== 0),
}));

describe("ACP 封闭主体映射", () => {
  it.each(kinds)("%s 的 locations 只按声明映射", (kind) => {
    // 未知字符串是协议向前兼容路径，故在此明确跨 SDK 的当前封闭 enum。
    const call = {
      toolCallId: "call",
      kind,
      locations: [{ path: "a" }, { path: "b" }],
    } as RequestPermissionRequest["toolCall"];
    const expected =
      kind === "read" || kind === "search"
        ? "read"
        : kind === "edit" || kind === "delete" || kind === "move"
          ? "edit"
          : undefined;
    if (expected) {
      expect(permissionSubjects(call, cwd, paths)).toEqual([
        { kind: expected, target: paths.resolve(cwd, "a") },
        { kind: expected, target: paths.resolve(cwd, "b") },
      ]);
      expect(permissionSubjects({ ...call, locations: [] }, cwd, paths)).toEqual([
        { kind: expected, target: "*" },
      ]);
      expect(permissionSubjects({ ...call, locations: [{ path: "" }] }, cwd, paths)).toEqual([
        { kind: expected, target: "*" },
      ]);
    } else if (kind === "execute" || kind === "fetch") {
      expect(permissionSubjects(call, cwd, paths)).toEqual([
        { kind: kind === "execute" ? "shell" : "network", target: "*" },
      ]);
    } else {
      expect(permissionSubjects(call, cwd, paths)).toBeUndefined();
    }
  });
});

describe("全部 kind × options 子集 × gate 决定", () => {
  for (const kind of kinds) {
    for (const allowed of [true, false]) {
      it.each(combinations)(
        `${kind ?? "missing"} / allow=${allowed} / mask=$mask`,
        ({ mask, options: offered }) => {
          const subjects = permissionSubjects(
            { toolCallId: "call", kind } as RequestPermissionRequest["toolCall"],
            cwd,
            paths,
          );
          const grant = allowed && subjects !== undefined && (mask & 1) !== 0;
          const result = permissionOutcome(offered, allowed && subjects !== undefined);
          expect(result.allowed).toBe(grant);
          expect(result.response.outcome).toEqual(
            grant
              ? { outcome: "selected", optionId: "allow" }
              : (mask & 4) !== 0
                ? { outcome: "selected", optionId: "deny" }
                : { outcome: "cancelled" },
          );
          expect(result.response.outcome).not.toEqual({ outcome: "selected", optionId: "always" });
          expect(result.response.outcome).not.toEqual({
            outcome: "selected",
            optionId: "denyAlways",
          });
        },
      );
    }
  }
});
