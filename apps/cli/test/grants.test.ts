import { expect, it, vi } from "vitest";
import type { Runtime, RuntimeConfig, RuntimeSession } from "@nocturne/core";
import type { Grant } from "@nocturne/core/protocol";
import { parseArgs } from "../src/args.js";
import { projectGrants, sessionGrants } from "../src/grants.js";
it("grants 参数：默认 list、工作区、编号和全撤销", () => {
  expect(parseArgs(["grants"])).toMatchObject({ command: "grants", grantsAction: "list" });
  expect(parseArgs(["grants", "list", "--workspace", "Z:/work"])).toMatchObject({
    grantsAction: "list",
    workspace: "Z:/work",
  });
  expect(parseArgs(["grants", "revoke", "2"])).toMatchObject({
    grantsAction: "revoke",
    grantsIndex: 2,
    grantsAll: false,
  });
  expect(parseArgs(["grants", "revoke", "--all"])).toMatchObject({
    grantsAction: "revoke",
    grantsAll: true,
  });
  for (const args of [
    ["grants", "revoke"],
    ["grants", "revoke", "0"],
    ["grants", "revoke", "-1"],
    ["grants", "revoke", "1", "--all"],
    ["grants", "list", "--all"],
    ["--workspace", "x"],
    ["grants", "--resume", "id"],
  ])
    expect(() => parseArgs(args)).toThrow();
});
const first: Grant = { kind: "shell", target: "git status", createdAt: "2026-10-20" };
const second: Grant = { kind: "mcp", target: "test/write", createdAt: "2026-10-21" };
it("项目授权按列表编号撤销，空状态 / 全撤销 / 写失败报错", async () => {
  const store = {
    list: () => [first, second],
    remove: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  const config = {
    forWorkspace: vi.fn(async () => ({ grants: store })),
  } as unknown as RuntimeConfig;
  expect(await projectGrants(config, "Z:/work", "list")).toBe(
    "项目授权：Z:/work\n1. [本项目] mcp  test/write  2026-10-21\n2. [本项目] shell  git status  2026-10-20",
  );
  await projectGrants(config, "Z:/work", "revoke", 1);
  expect(store.remove).toHaveBeenCalledWith("mcp", "test/write");
  await projectGrants(config, "Z:/work", "revoke", undefined, true);
  expect(store.clear).toHaveBeenCalledOnce();
  await expect(projectGrants(config, "Z:/work", "revoke", 3)).rejects.toThrow("编号不存在");
  store.remove.mockRejectedValueOnce(new Error("disk full"));
  await expect(projectGrants(config, "Z:/work", "revoke", 1)).rejects.toThrow("disk full");
  store.list = () => [];
  expect(await projectGrants(config, "Z:/work", "list")).toContain("还没有授权");
});
it("会话内合并本会话 / 本项目、编号路由到对应 Core 入口", async () => {
  const session = {
    state: () => ({ meta: { workspaceRoot: "Z:/work" } }),
    listGrants: () => [first],
    revokeGrant: vi.fn(async () => undefined),
  } as unknown as RuntimeSession;
  const runtime = {
    listGrants: async () => [second],
    revokeGrant: vi.fn(async () => undefined),
  } as unknown as Runtime;
  expect(await sessionGrants(runtime, session, [])).toContain("1. [本会话]");
  expect(await sessionGrants(runtime, session, [])).toContain("2. [本项目]");
  await sessionGrants(runtime, session, ["revoke", "1"]);
  expect(session.revokeGrant).toHaveBeenCalledWith({ kind: first.kind, target: first.target });
  await sessionGrants(runtime, session, ["revoke", "2"]);
  expect(runtime.revokeGrant).toHaveBeenCalledWith({
    workspace: "Z:/work",
    kind: second.kind,
    target: second.target,
  });
  expect(await sessionGrants(runtime, session, ["revoke", "3"])).toContain("编号不存在");
});
