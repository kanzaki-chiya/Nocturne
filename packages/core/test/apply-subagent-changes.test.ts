import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import type { SubagentChanges } from "../src/protocol/index.js";
import {
  checkExpectedHead,
  createApplySubagentChangesTool,
  ExpectedHeadMismatchError,
} from "../src/tools/builtin/apply-subagent-changes.js";
import {
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  type ExecutionScope,
  type PermissionGate,
} from "../src/tools/index.js";

const COMMIT_A = "1111111111111111111111111111111111111111";
const COMMIT_B = "2222222222222222222222222222222222222222";
const BASE_COMMIT = "0000000000000000000000000000000000000000";

const platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nocturne-apply-tool-"));
  tmpRoots.push(dir);
  writeFileSync(path.join(dir, "target.txt"), "original\n", "utf8");
  return dir;
}

function makeChanges(repo: string, head: string): SubagentChanges {
  return {
    branch: "nocturne/child-1",
    base: BASE_COMMIT,
    head,
    snapshot: false,
    worktree: path.join(repo, ".fake-wt"),
    files: [{ path: "target.txt", status: "modified", additions: 1, deletions: 1 }],
  };
}

function allowGate(onCheck?: () => void): PermissionGate {
  return {
    check: (subjects) => {
      onCheck?.();
      return Promise.resolve({
        subjects,
        decision: { action: "allow", source: "rule", reason: "test allow" },
      });
    },
    checkLexical: () => "allow",
  };
}

function makeScope(workspaceRoot: string, gate: PermissionGate = allowGate()): ExecutionScope {
  return {
    sessionId: "s-apply-test",
    turnId: "turn-1",
    cwd: workspaceRoot,
    workspaceRoot,
    paths: platform.paths,
    platform,
    gate,
    readState: createReadStateStore(platform.paths),
    signal: new AbortController().signal,
    events: {
      emit: () => Promise.resolve(),
      emitEphemeral: () => undefined,
    },
  };
}

describe("apply_subagent_changes expectedHead", () => {
  it("expectedHead 与当前 head 不符时拒绝并回且不改工作区，错误信息包含当前 head 与期望值", async () => {
    const repo = makeTempRepo();
    const applySpy = vi.fn(() => {
      writeFileSync(path.join(repo, "target.txt"), "mutated\n", "utf8");
      return Promise.resolve({ conflicts: [] });
    });
    const registry = createToolRegistry();
    registry.register(
      createApplySubagentChangesTool({
        lookup: (id) =>
          id === "author"
            ? { changes: makeChanges(repo, COMMIT_B), repository: repo, applied: false }
            : undefined,
        apply: applySpy,
      }),
    );

    const executor = createToolExecutor(registry);
    const { result } = await executor.execute(
      {
        callId: "c-mismatch",
        name: "apply_subagent_changes",
        input: { id: "author", mode: "clean", expectedHead: COMMIT_A },
      },
      makeScope(repo),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("invalid_input");
    }
    expect(result.modelContent).toContain(COMMIT_B);
    expect(result.modelContent).toContain(COMMIT_A);
    expect(applySpy).not.toHaveBeenCalled();
    expect(readFileSync(path.join(repo, "target.txt"), "utf8")).toBe("original\n");
  });

  it("expectedHead 与当前 head 相符（完整 SHA 与 12 位前缀）时正常并回", async () => {
    const repo = makeTempRepo();
    let appliedContent = "";
    const applySpy = vi.fn((_id: string, _mode: "clean" | "3way", _expectedHead?: string) => {
      appliedContent = "applied-v1\n";
      writeFileSync(path.join(repo, "target.txt"), appliedContent, "utf8");
      return Promise.resolve({ conflicts: [] });
    });
    const registry = createToolRegistry();
    registry.register(
      createApplySubagentChangesTool({
        lookup: () => ({
          changes: makeChanges(repo, COMMIT_A),
          repository: repo,
          applied: false,
        }),
        apply: applySpy,
      }),
    );

    const executor = createToolExecutor(registry);

    // 完整 SHA
    const fullRes = await executor.execute(
      {
        callId: "c-full",
        name: "apply_subagent_changes",
        input: { id: "author", mode: "clean", expectedHead: COMMIT_A },
      },
      makeScope(repo),
    );
    expect(fullRes.result.status).toBe("ok");
    expect(applySpy).toHaveBeenCalledWith("author", "clean", COMMIT_A);
    expect(readFileSync(path.join(repo, "target.txt"), "utf8")).toBe("applied-v1\n");

    // 12 位短 SHA（大小写不敏感）
    const shortSha = COMMIT_A.slice(0, 12).toUpperCase();
    const prefixRes = await executor.execute(
      {
        callId: "c-short",
        name: "apply_subagent_changes",
        input: { id: "author", expectedHead: shortSha },
      },
      makeScope(repo),
    );
    expect(prefixRes.result.status).toBe("ok");
    expect(applySpy).toHaveBeenCalledWith("author", "clean", shortSha);
  });

  it("省略 expectedHead 时保持原有行为正常并回", async () => {
    const repo = makeTempRepo();
    const applySpy = vi.fn(() => {
      writeFileSync(path.join(repo, "target.txt"), "legacy-applied\n", "utf8");
      return Promise.resolve({ conflicts: [] });
    });
    const registry = createToolRegistry();
    registry.register(
      createApplySubagentChangesTool({
        lookup: () => ({
          changes: makeChanges(repo, COMMIT_B),
          repository: repo,
          applied: false,
        }),
        apply: applySpy,
      }),
    );

    const executor = createToolExecutor(registry);
    const { result } = await executor.execute(
      {
        callId: "c-legacy",
        name: "apply_subagent_changes",
        input: { id: "child-1" },
      },
      makeScope(repo),
    );

    expect(result.status).toBe("ok");
    expect(applySpy).toHaveBeenCalledWith("child-1", "clean", undefined);
    expect(readFileSync(path.join(repo, "target.txt"), "utf8")).toBe("legacy-applied\n");
  });

  it("非法格式的 expectedHead（空串、短于 7 位、非十六进制）直接拒绝且不调用 apply", async () => {
    const repo = makeTempRepo();
    const applySpy = vi.fn(() => Promise.resolve({ conflicts: [] }));
    const registry = createToolRegistry();
    registry.register(
      createApplySubagentChangesTool({
        lookup: () => ({
          changes: makeChanges(repo, COMMIT_A),
          repository: repo,
          applied: false,
        }),
        apply: applySpy,
      }),
    );
    const executor = createToolExecutor(registry);

    for (const bad of ["", "   ", "111111", "HEAD", "zzzzzzzz"]) {
      const { result } = await executor.execute(
        {
          callId: `c-bad-${bad}`,
          name: "apply_subagent_changes",
          input: { id: "author", expectedHead: bad },
        },
        makeScope(repo),
      );
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe("invalid_input");
      }
      expect(result.modelContent).toContain("Invalid expectedHead");
    }
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("权限审批期间分支头推进时，execute 与 apply 锁内复检均拒绝且不改工作区", async () => {
    const repo = makeTempRepo();
    let currentHead = COMMIT_A;
    const applySpy = vi.fn(() => {
      writeFileSync(path.join(repo, "target.txt"), "should-not-write\n", "utf8");
      return Promise.resolve({ conflicts: [] });
    });
    const registry = createToolRegistry();
    registry.register(
      createApplySubagentChangesTool({
        lookup: () => ({
          changes: makeChanges(repo, currentHead),
          repository: repo,
          applied: false,
        }),
        apply: applySpy,
      }),
    );

    const executor = createToolExecutor(registry);
    // 模拟权限等待期间作者推进了分支头：validateInput 时为 A，gate 放行后变为 B
    const scope = makeScope(
      repo,
      allowGate(() => {
        currentHead = COMMIT_B;
      }),
    );

    const { result } = await executor.execute(
      {
        callId: "c-race-execute",
        name: "apply_subagent_changes",
        input: { id: "author", expectedHead: COMMIT_A },
      },
      scope,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("invalid_input");
    }
    expect(result.modelContent).toContain(COMMIT_B);
    expect(result.modelContent).toContain(COMMIT_A);
    expect(applySpy).not.toHaveBeenCalled();
    expect(readFileSync(path.join(repo, "target.txt"), "utf8")).toBe("original\n");

    // 模拟 apply 锁内抛出 ExpectedHeadMismatchError 时同样返回 invalid_input
    const mismatchMsg = checkExpectedHead("author", COMMIT_B, COMMIT_A);
    expect(mismatchMsg).toBeDefined();
    const lockRegistry = createToolRegistry();
    lockRegistry.register(
      createApplySubagentChangesTool({
        lookup: () => ({
          changes: makeChanges(repo, COMMIT_A),
          repository: repo,
          applied: false,
        }),
        apply: () => Promise.reject(new ExpectedHeadMismatchError(mismatchMsg)),
      }),
    );
    const lockRes = await createToolExecutor(lockRegistry).execute(
      {
        callId: "c-race-lock",
        name: "apply_subagent_changes",
        input: { id: "author", expectedHead: COMMIT_A },
      },
      makeScope(repo),
    );
    expect(lockRes.result.status).toBe("error");
    if (lockRes.result.status === "error") {
      expect(lockRes.result.error.code).toBe("invalid_input");
    }
    expect(lockRes.result.modelContent).toContain(COMMIT_B);
    expect(lockRes.result.modelContent).toContain(COMMIT_A);
  });
});
