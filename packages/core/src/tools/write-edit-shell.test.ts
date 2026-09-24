/**
 * write / edit / shell 工具的离线测试（tools.md 第 6 节）。
 * 写文件与 shell 命令只在临时目录中执行。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform, type Platform } from "../platform/index.js";
import type { ToolCallRef } from "../protocol/index.js";
import { diffLines } from "./builtin/diff.js";
import {
  createBuiltinRegistry,
  createReadStateStore,
  createToolExecutor,
  type ExecutionScope,
  type PermissionGate,
} from "./index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-wes-"));
  tmpRoots.push(dir);
  return dir;
}

interface Captured {
  type: string;
  payload: Record<string, unknown>;
}

interface Harness {
  scope: ExecutionScope;
  events: Captured[];
  ephemeral: Captured[];
  executor: ReturnType<typeof createToolExecutor>;
  ws: string;
  workspaceRoot: string;
}

/** Phase 2 default 预设：工作区内读取 allow，其余 ask；测试用 allow-all gate 直通执行 */
const allowAllGate: PermissionGate = {
  check: (subjects) =>
    Promise.resolve({
      subjects,
      decision: { action: "allow", source: "rule", reason: "test allow-all" },
    }),
  checkLexical: () => "allow",
};

async function makeHarness(
  ws: string,
  options?: { gate?: PermissionGate; signal?: AbortSignal },
): Promise<Harness> {
  const workspaceRoot = await platform.resolveReal(ws);
  const events: Captured[] = [];
  const ephemeral: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "s1",
    turnId: "turn-1",
    signal: options?.signal ?? new AbortController().signal,
    platform,
    gate: options?.gate ?? allowAllGate,
    readState: createReadStateStore(platform.paths),
    events: {
      emit: (type, payload) => {
        events.push({ type, payload: payload as unknown as Captured["payload"] });
        return Promise.resolve();
      },
      emitEphemeral: (type, payload) => {
        ephemeral.push({ type, payload: payload as unknown as Captured["payload"] });
      },
    },
  };
  return {
    scope,
    events,
    ephemeral,
    executor: createToolExecutor(createBuiltinRegistry()),
    ws,
    workspaceRoot,
  };
}

const call = (name: string, input: unknown, callId = "c1"): ToolCallRef => ({
  callId,
  name,
  input,
});

const readViaTool = async (h: Harness, rel: string) =>
  h.executor.execute(call("read", { path: rel }), h.scope);

describe("write 工具", () => {
  it("创建新文件不要求先读", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("write", { path: "a.ts", content: "export const x = 1;\n" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    const output = r.result.output as { path: string; created: boolean; lines: number };
    expect(output.created).toBe(true);
    expect(output.lines).toBe(1);
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe(
      "export const x = 1;\n",
    );
  });

  it("覆盖已存在文件且本会话未读过 → not_read", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "old\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("write", { path: "a.ts", content: "new\n" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("not_read");
    // 文件未被修改
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe("old\n");
  });

  it("先读后写成功，output 携带 diff", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "line1\nline2\nline3\n");
    const h = await makeHarness(ws);
    expect((await readViaTool(h, "a.ts")).status).toBe("ok");
    const r = await h.executor.execute(
      call("write", { path: "a.ts", content: "line1\nchanged\nline3\n" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    const output = r.result.output as { created: boolean; diff?: string };
    expect(output.created).toBe(false);
    expect(output.diff).toContain("-line2");
    expect(output.diff).toContain("+changed");
    expect(output.diff).toContain(" line1");
  });

  it("读取后文件被外部修改 → stale_file", async () => {
    const ws = tmpWorkspace();
    const file = path.join(ws, "a.ts");
    writeFileSync(file, "v1\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    // 外部修改：改变大小与 mtime
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, "v1-external-longer\n");
    const r = await h.executor.execute(call("write", { path: "a.ts", content: "v2\n" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("stale_file");
  });

  it("write 创建后，本会话内 edit 可直接使用（写入即记录状态）", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    await h.executor.execute(call("write", { path: "a.ts", content: "alpha\nbeta\n" }), h.scope);
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old: "beta", new: "gamma" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe("alpha\ngamma\n");
  });
});

describe("edit 工具", () => {
  it("唯一替换成功", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "foo\nbar\nbaz\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old: "bar", new: "qux" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe("foo\nqux\nbaz\n");
    const output = r.result.output as { replaced: number; diff: string };
    expect(output.replaced).toBe(1);
    expect(output.diff).toContain("-bar");
    expect(output.diff).toContain("+qux");
  });

  it("替换文本含 $& 等 JS 替换语法时按字面值写入", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "before OLD after\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old: "OLD", new: "$& and $$" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    const output = r.result.output as { replaced: number; diff: string };
    expect(output.replaced).toBe(1);
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe(
      "before $& and $$ after\n",
    );
    expect(output.diff).toContain("+before $& and $$ after");
  });

  it("多处出现且未指定 replaceAll → not_unique", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "x\nx\nx\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(call("edit", { path: "a.ts", old: "x", new: "y" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("not_unique");
  });

  it("replaceAll 替换全部", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "x\nx\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old: "x", new: "y", replaceAll: true }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    const output = r.result.output as { replaced: number };
    expect(output.replaced).toBe(2);
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe("y\ny\n");
  });

  it("old 未出现 → no_match；old===new → no_change", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "content\n");
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const noMatch = await h.executor.execute(
      call("edit", { path: "a.ts", old: "missing", new: "y" }),
      h.scope,
    );
    expect(noMatch.result.status === "error" && noMatch.result.error.code).toBe("no_match");
    const noChange = await h.executor.execute(
      call("edit", { path: "a.ts", old: "content", new: "content" }),
      h.scope,
    );
    expect(noChange.result.status === "error" && noChange.result.error.code).toBe("no_change");
  });

  it("未先读 → not_read；文件不存在 → file_not_found", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "content\n");
    const h = await makeHarness(ws);
    const notRead = await h.executor.execute(
      call("edit", { path: "a.ts", old: "content", new: "y" }),
      h.scope,
    );
    expect(notRead.result.status === "error" && notRead.result.error.code).toBe("not_read");
    const missing = await h.executor.execute(
      call("edit", { path: "gone.ts", old: "x", new: "y" }),
      h.scope,
    );
    expect(missing.result.status === "error" && missing.result.error.code).toBe("file_not_found");
  });
});

describe("shell 工具", () => {
  const node = JSON.stringify(process.execPath);

  it("合并 stdout/stderr 输出并返回退出码", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("shell", {
        command: `${node} -e "process.stdout.write('OUT');process.stderr.write('ERR');process.stdout.write('OUT2')"`,
      }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("OUT");
    expect(r.result.modelContent).toContain("ERR");
    expect(r.result.modelContent).toContain("[exit code 0]");
    const output = r.result.output as ShellOut;
    expect(output.exitCode).toBe(0);
    // 输出流式上报
    const progress = h.ephemeral.filter((e) => e.type === "tool.progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.payload.stream === "stderr")).toBe(true);
  });

  it("非零退出码：status ok，output 携带 exitCode", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("shell", { command: `${node} -e "process.exit(3)"` }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect((r.result.output as ShellOut).exitCode).toBe(3);
    expect(r.result.modelContent).toContain("[exit code 3]");
  });

  it("超时：终止进程并标记 timedOut", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", {
        command: `${node} -e "setInterval(()=>{},1000)"`,
        timeoutMs: 800,
      }),
      h.scope,
    );
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("timeout");
    expect((r.result.output as ShellOut).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("中断：终止整个进程树（Windows 实测：taskkill /T）", async () => {
    const ws = tmpWorkspace();
    // 父进程派生一个孙进程并写出其 pid，然后双双挂起
    writeFileSync(
      path.join(ws, "child.js"),
      `const {spawn}=require("child_process");const fs=require("fs");
const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
fs.writeFileSync("grandchild.pid",String(c.pid));
setInterval(()=>{},1000);`,
    );
    const ac = new AbortController();
    const h = await makeHarness(ws, { signal: ac.signal });
    const exec = h.executor.execute(call("shell", { command: `${node} child.js` }), h.scope);
    // 等孙进程 pid 文件出现
    const pidFile = path.join(ws, "grandchild.pid");
    let grandchildPid = -1;
    for (let i = 0; i < 100; i++) {
      if (await platform.fs.exists(pidFile)) {
        grandchildPid = Number(await platform.fs.readTextFile(pidFile));
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(grandchildPid).toBeGreaterThan(0);

    ac.abort();
    const r = await exec;
    expect(r.status).toBe("cancelled");

    // 孙进程必须已被终止（进程树终止的直接证据）
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // 给 taskkill / 进程组信号一点落点时间
    for (let i = 0; i < 50 && alive(grandchildPid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(alive(grandchildPid)).toBe(false);
  });

  it("cwd 指定到工作区外 → invalid_input", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("shell", { command: `${node} -e "0"`, cwd: outside }),
      h.scope,
    );
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("invalid_input");
  });

  it("shell 主体 kind 为 shell（供权限层 ask）", async () => {
    const ws = tmpWorkspace();
    const seen: string[] = [];
    const spy: PermissionGate = {
      check: (subjects) => {
        for (const s of subjects) seen.push(s.kind);
        return Promise.resolve({
          subjects,
          decision: { action: "allow", source: "rule", reason: "spy" },
        });
      },
      checkLexical: () => "allow",
    };
    const h = await makeHarness(ws, { gate: spy });
    await h.executor.execute(call("shell", { command: `${node} -e "0"` }), h.scope);
    expect(seen).toEqual(["shell"]);
  });
});

interface ShellOut {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
}

describe("diffLines", () => {
  it("公共前后缀作上下文，中段 -/+", () => {
    const d = diffLines("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", "f.ts");
    expect(d).toContain("@@ f.ts @@");
    expect(d).toContain("-c");
    expect(d).toContain("+X");
    expect(d).toContain(" a");
    expect(d).toContain(" e");
  });

  it("无变化返回空串；尾部新增", () => {
    expect(diffLines("a\n", "a\n", "f")).toBe("");
    const d = diffLines("a\n", "a\nb\n", "f");
    expect(d).toContain("+b");
    expect(d).not.toContain("-a");
  });
});
