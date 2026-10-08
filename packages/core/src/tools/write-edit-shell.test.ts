/**
 * write / edit / shell 工具的离线测试（tools.md 第 6 节）。
 * 写文件与 shell 命令只在临时目录中执行。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultPolicy, createRulePolicy } from "../permission/index.js";
import {
  createPlatform,
  SHELL_RISK_BY_DIALECT,
  shellDescriptor,
  type Platform,
  type ProcessRunner,
  type ShellResolution,
  type SpawnedProcess,
} from "../platform/index.js";
import type { ToolCallRef } from "../protocol/index.js";
import { diffLines } from "./builtin/diff.js";
import {
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  shellTool,
  type ExecutionScope,
  type PermissionGate,
} from "./index.js";
import { createProcessCleanup, removeTempDirs } from "../../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const platform: Platform = processes.platform(createPlatform());
const tmpRoots: string[] = [];

const ORPHAN_MARKER = "ORPHAN-HOLDS-PIPE-7f3a";

afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});

/** 读取孤儿 pid 文件并登记清理（pid 文件由测试脚本写出，不会误杀其他进程） */
async function trackOrphan(pidFile: string): Promise<void> {
  if (await platform.fs.exists(pidFile)) {
    const pid = Number(await platform.fs.readTextFile(pidFile));
    if (Number.isInteger(pid) && pid > 0) processes.trackPid(pid);
  }
}

const LEAF_SPAWN = `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const c=spawn(process.execPath,["orphan-leaf.js"],{cwd:__dirname,detached:true,stdio:["ignore","inherit","inherit"],windowsHide:true});
c.unref();`;

/**
 * 在 ws 中写脚本，制造"直接子进程已退出/将退出，但输出管道被后台进程持有"：
 * 末端 leaf 长期存活、detached 并继承管道；其 pid 写到 orphan.pid，打印 marker。
 * - "exit" 两层：parent 派生 leaf 后立即退出（leaf 成为脱离树的孤儿）。
 * - "hang" 三层：parent 挂起；mid 派生 leaf 后退出——kill/超时触发时
 *   leaf 的父链已断（mid 已死），taskkill /T 枚举不到它，detach 必然发生。
 */
function writeOrphanScripts(ws: string, mode: "exit" | "hang" = "exit"): { pidFile: string } {
  const pidFile = path.join(ws, "orphan.pid");
  processes.watchPidFile(pidFile);
  writeFileSync(path.join(ws, "orphan-leaf.js"), "setInterval(()=>{},1000);\n");
  if (mode === "exit") {
    writeFileSync(
      path.join(ws, "orphan-parent.js"),
      `${LEAF_SPAWN}
fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));
process.stdout.write(${JSON.stringify(`${ORPHAN_MARKER}\n`)});`,
    );
  } else {
    writeFileSync(
      path.join(ws, "orphan-mid.js"),
      `${LEAF_SPAWN}
fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));
process.stdout.write(${JSON.stringify(`${ORPHAN_MARKER}\n`)});`,
    );
    writeFileSync(
      path.join(ws, "orphan-parent.js"),
      `const {spawn}=require("node:child_process");
const c=spawn(process.execPath,["orphan-mid.js"],{cwd:__dirname,stdio:["ignore","inherit","inherit"],windowsHide:true});
c.unref();
setInterval(()=>{},1000);`,
    );
  }
  return { pidFile };
}

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
  options?: {
    gate?: PermissionGate;
    signal?: AbortSignal;
    shell?: ShellResolution;
    process?: ProcessRunner;
  },
): Promise<Harness> {
  const workspaceRoot = await platform.resolveReal(ws);
  const plat: Platform =
    options?.process !== undefined ? { ...platform, process: options.process } : platform;
  const events: Captured[] = [];
  const ephemeral: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "s1",
    turnId: "turn-1",
    signal: options?.signal ?? new AbortController().signal,
    platform: plat,
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
    ...(options?.shell !== undefined ? { shell: options.shell } : {}),
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

  it("新建 write 返回从空文件到内容的 diff", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("write", { path: "new.ts", content: "one\ntwo\n" }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.output).toMatchObject({
      created: true,
      diff: "@@ -0,0 +1,2 @@\n+one\n+two",
    });
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
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe("content\n");
  });

  it.each([
    ["alpha\r\nbeta\r\n", "alpha\nbeta", "换行符", "1 行"],
    ["alpha\n    beta\n", "alpha\nbeta", "缩进", "1 行"],
    ["alpha beta\n", "alpha  beta", "空白", "1 行"],
    ["alpha\nbeta value\ngamma\n", "beta valse", "相近片段", "2: beta value"],
    [
      "one\ntwo\nthree\nfour\nfive\nsix\n",
      "one\ntwo\nthrae\nfour\nfive\nsix",
      "相近片段",
      "2: two",
    ],
  ])("未命中诊断只提示并保留文件：%s", async (content, old, kind, location) => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), content);
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old, new: "REPLACED" }),
      h.scope,
    );
    expect(r.result.status === "error" && r.result.error.code).toBe("no_match");
    expect(r.result.modelContent).toContain(kind);
    expect(r.result.modelContent).toContain(location);
    expect(await h.scope.platform.fs.readTextFile(path.join(ws, "a.ts"))).toBe(content);
  });

  it("大文件未命中退化为短错误", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.ts"), "x\n".repeat(50_100));
    const h = await makeHarness(ws);
    await readViaTool(h, "a.ts");
    const r = await h.executor.execute(
      call("edit", { path: "a.ts", old: "missing", new: "y" }),
      h.scope,
    );
    expect(r.result.status === "error" && r.result.error.code).toBe("no_match");
    expect(r.result.modelContent).not.toContain("相近片段");
    expect(r.result.modelContent.length).toBeLessThan(300);
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

  it.each([
    [undefined, "1"],
    ["0", "0"],
    ["", ""],
  ])("父进程 PYTHONUNBUFFERED=%j 时子进程看到 %j", async (value, expected) => {
    vi.stubEnv("PYTHONUNBUFFERED", value);
    try {
      const ws = tmpWorkspace();
      writeFileSync(
        path.join(ws, "env.js"),
        "process.stdout.write(JSON.stringify(process.env.PYTHONUNBUFFERED));",
      );
      const h = await makeHarness(ws);
      const r = await h.executor.execute(call("shell", { command: `${node} env.js` }), h.scope);
      expect(r.status).toBe("ok");
      expect(r.result.modelContent).toBe(`${JSON.stringify(expected)}\n[exit code 0]`);
      expect(process.env.PYTHONUNBUFFERED).toBe(value);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("模型可见说明分两种情况：可能卡住设短超时，已知耗时长直接设足", () => {
    expect(shellTool.description).toContain("timeout 30 python3 test.py");
    expect(shellTool.description).toContain("PowerShell/cmd 用对应写法");
    expect(shellTool.description).toContain("可能卡住的命令");
    expect(shellTool.description).toContain("按预计耗时设较短的超时");
    expect(shellTool.description).toContain("超时后根据已有输出定位");
    expect(shellTool.description).toContain("已知耗时长的命令");
    expect(shellTool.description).toContain("按预计耗时直接设足");
    expect(shellTool.description).toContain("宁可宽一些，一次跑完");
    expect(shellTool.description).not.toContain("不要为了保险");
    expect(shellTool.inputSchema).toMatchObject({
      properties: {
        timeoutMs: {
          maximum: 1_800_000,
          description: expect.stringMatching(/默认 120000，上限 1800000/),
        },
      },
    });
    const schema = shellTool.inputSchema as {
      properties: { timeoutMs: { description: string } };
    };
    expect(schema.properties.timeoutMs.description).toContain("可能卡住的命令");
    expect(schema.properties.timeoutMs.description).toContain("已知耗时长的命令");
    expect(schema.properties.timeoutMs.description).not.toContain("不要为了保险");
    expect(shellTool.traits?.timeoutMs).toBe(1_800_000 + 30_000);
  });

  it("timeoutMs 超过新上限时被夹到 1800000（直接调用，不等待 30 分钟）", async () => {
    const ws = tmpWorkspace();
    const workspaceRoot = await platform.resolveReal(ws);
    let seenTimeoutMs: number | undefined;
    const fakeProcess = {
      spawnShell: (_command: string, options?: { timeoutMs?: number }) => {
        seenTimeoutMs = options?.timeoutMs;
        const empty: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            return { next: async () => ({ done: true as const, value: "" }) };
          },
        };
        return {
          pid: 12345,
          stdout: empty,
          stderr: empty,
          wait: async () => ({ code: null, signal: null, timedOut: true, killed: true }),
          kill: async () => undefined,
          detachOutput: () => undefined,
        };
      },
    };
    const scope = {
      cwd: ws,
      workspaceRoot,
      paths: platform.paths,
      sessionId: "s1",
      turnId: "turn-1",
      callId: "c-clamp",
      signal: new AbortController().signal,
      subjects: [{ kind: "shell", target: "echo hi", resolved: "echo hi" }],
      permissions: { check: () => "allow" as const },
      fs: platform.fs,
      process: fakeProcess,
      readState: createReadStateStore(platform.paths),
      progress: () => undefined,
    };
    const r = await shellTool.execute(
      { command: "echo hi", timeoutMs: 5_000_000 },
      scope as unknown as Parameters<typeof shellTool.execute>[1],
    );
    expect(seenTimeoutMs).toBe(1_800_000);
    expect(r.status).toBe("error");
    expect(r.status === "error" && r.error.code).toBe("timeout");
    expect(
      r.status === "error" && (r.output as { timeoutMs?: number } | undefined)?.timeoutMs,
    ).toBe(1_800_000);
  });

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
    processes.watchPidFile(path.join(ws, "grandchild.pid"));
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
    processes.trackPid(grandchildPid);

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

  it("后台孙进程占用输出管道：shell 退出后分离输出，有界返回", async () => {
    const ws = tmpWorkspace();
    const { pidFile } = writeOrphanScripts(ws);
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", { command: `${node} orphan-parent.js`, timeoutMs: 30_000 }),
      h.scope,
    );
    const elapsed = Date.now() - started;
    await trackOrphan(pidFile);
    expect(r.status).toBe("ok");
    const output = r.result.output as ShellOut;
    expect(output.exitCode).toBe(0);
    expect(output.outputDetached).toBe(true);
    expect(r.result.modelContent).toContain(ORPHAN_MARKER);
    expect(r.result.modelContent).toContain("命令已退出，但仍有后台进程占用输出管道");
    expect(r.result.modelContent).toContain("[exit code 0]");
    // exit 结算 + 500ms 收尾窗口，远小于旧的无限等待
    expect(elapsed).toBeLessThan(3_000);
  });

  it("孙进程占用管道时中断：cancelled 且有界返回", async () => {
    const ws = tmpWorkspace();
    const { pidFile } = writeOrphanScripts(ws);
    const ac = new AbortController();
    const h = await makeHarness(ws, { signal: ac.signal });
    const exec = h.executor.execute(
      call("shell", { command: `${node} orphan-parent.js`, timeoutMs: 60_000 }),
      h.scope,
    );
    // 等孤儿接管管道：pid 文件写出后父进程随即退出
    await vi.waitFor(
      async () => {
        expect(await platform.fs.exists(pidFile)).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    await trackOrphan(pidFile);
    const abortAt = Date.now();
    ac.abort();
    const r = await exec;
    const elapsed = Date.now() - abortAt;
    expect(r.status).toBe("cancelled");
    // 中断结果由执行器统一归一化（cancelled 不由工具返回）；有界返回本身
    // 证明 detach 收尾生效——否则输出泵会被孤儿占用的管道一直挂住
    expect(elapsed).toBeLessThan(3_000);
  });

  it("孙进程占用管道时超时：有界 timeout 并附提示", async () => {
    const ws = tmpWorkspace();
    // 三层结构：parent 挂起（保证超时先触发），leaf 经已退出的 mid 脱离进程树，
    // taskkill /T 杀不到 → 管道只能经 detach 收尾
    const { pidFile } = writeOrphanScripts(ws, "hang");
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", { command: `${node} orphan-parent.js`, timeoutMs: 400 }),
      h.scope,
    );
    const elapsed = Date.now() - started;
    await trackOrphan(pidFile);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("timeout");
    const output = r.result.output as ShellOut;
    expect(output.timedOut).toBe(true);
    expect(output.outputDetached).toBe(true);
    expect(r.result.modelContent).toContain("命令超过 400ms 超时");
    expect(r.result.modelContent).toContain("命令已退出，但仍有后台进程占用输出管道");
    expect(elapsed).toBeLessThan(3_000);
  });

  it("下游命令与孙进程占用输出管道：有界返回", async () => {
    const ws = tmpWorkspace();
    // 真实孤儿场景接一个永不读到 EOF 的下游命令：leaf detached 继承
    // parent→tail 管道的写端，tail 的 stdin 始终不关闭，整条管道随之挂起，
    // 直到超时终止（旧用例接 | more，现在末尾分页在输入预检就被拒绝，
    // 改用 node 下游保持同一占用形态）
    const { pidFile } = writeOrphanScripts(ws);
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", {
        command: `${node} orphan-parent.js | ${node} -e "process.stdin.resume()"`,
        timeoutMs: 1_000,
      }),
      h.scope,
    );
    const elapsed = Date.now() - started;
    await trackOrphan(pidFile);
    // 下游未退出 → timeout 终止；若平台行为令其自然退出则 ok。
    // 两者都要求有界返回；leaf 是否还持有 shell stdout 取决于 kill 落点，
    // outputDetached 两种取值都合法，不断言
    if (r.status === "error") {
      expect(r.result.status === "error" && r.result.error.code).toBe("timeout");
    } else {
      expect(r.status).toBe("ok");
    }
    expect(elapsed).toBeLessThan(4_000);
  });

  it("无后台占用的正常命令：modelContent 与退出码不变，无 outputDetached", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", { command: `${node} -e "process.stdout.write('OK');process.exit(7)"` }),
      h.scope,
    );
    const elapsed = Date.now() - started;
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toBe("OK\n[exit code 7]");
    const output = r.result.output as ShellOut;
    expect(output.exitCode).toBe(7);
    expect("outputDetached" in output).toBe(false);
    // 管道自然收尾立即返回，不付出 500ms 宽限
    expect(elapsed).toBeLessThan(2_000);
  });
});

interface ShellOut {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
  timeoutMs?: number;
  outputDetached?: boolean;
}

describe("shell 末尾分页预检（ADR-0021 第 9 条）", () => {
  const node = JSON.stringify(process.execPath);
  const PAGER_MESSAGE =
    "命令以分页工具结尾（more/less/Out-Host -Paging）。分页工具会改坏输出编码、可能等待按键卡住；输出会被自动收集，去掉末尾的分页命令后直接执行即可。需要筛选时先重定向到文件再用 grep 工具。";

  it("末尾接分页工具的命令在权限之前拒绝：invalid_input、不 spawn、不请求权限、恰好一个 tool.completed", async () => {
    const ws = tmpWorkspace();
    const spawnSpy = vi.spyOn(platform.process, "spawnShell");
    // default 预设的真实策略：shell 一律 ask——若拒绝发生在权限之后，
    // 这里会产生 permission.resolved（非交互 deny）；断言 gate 根本没被调用
    const policy = createDefaultPolicy({
      workspaceRoot: await platform.resolveReal(ws),
      caseSensitive: platform.caseSensitivePaths,
    });
    const gate = createPolicyGate(policy);
    const gateCheck = vi.spyOn(gate, "check");
    try {
      const h = await makeHarness(ws, { gate });
      const blocked = [
        "dir | more",
        "dir|more.com",
        "dir | MORE",
        "dir | more +0",
        "dir | less -S",
        "x | less -R",
        "a | more & b",
        "x | more || b",
        "b ; x | more",
        "echo ok && dir | more",
        "dir | more && echo ok",
        "x | C:\\Windows\\System32\\more.com",
        'dir | "C:\\Windows\\System32\\more.com" /p',
        `${node} -v 2>&1 | more`,
        "echo $(dir | more)",
      ];
      for (const [i, command] of blocked.entries()) {
        const r = await h.executor.execute(call("shell", { command }, `c${i}`), h.scope);
        expect(r.status, command).toBe("error");
        expect(r.result.status === "error" && r.result.error.code, command).toBe("invalid_input");
        expect(r.result.modelContent, command).toBe(PAGER_MESSAGE);
      }
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(gateCheck).not.toHaveBeenCalled();
      expect(h.events.some((e) => e.type === "tool.started")).toBe(false);
      expect(h.events.some((e) => e.type === "permission.requested")).toBe(false);
      expect(h.events.some((e) => e.type === "permission.resolved")).toBe(false);
      expect(h.events.filter((e) => e.type === "tool.completed")).toHaveLength(blocked.length);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("不误伤：引号内的分页字样、文件名、非末段分页工具与其他命令照常放行", () => {
    const allowed = [
      'echo "a | more"', // 双引号内的 | 不是管道
      "echo 'a | less'", // 单引号同理
      "dir | more.txt", // 文件名不是分页工具
      "x | findstr more", // more 只是参数
      "findstr more file.txt",
      "a | more | findstr x", // 分页工具不在管道末段
      "a | more | sort",
      'dir | "more.com.txt"', // 引号文件名
      "type file.txt && echo more",
      "x > more.txt", // 重定向目标
      "echo hi > more.txt",
      "dir", // 普通命令
    ];
    for (const command of allowed) {
      expect(shellTool.validateInput?.({ command }), command).toBeUndefined();
    }
  });

  it("引号内的分页字样放行后命令正常执行", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("shell", { command: `${node} -e "process.stdout.write('a|more')"` }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toBe("a|more\n[exit code 0]");
  });

  it("PreToolUse updatedInput 重写后的输入同样经过预检", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    h.scope.hooks = {
      run: (point) =>
        Promise.resolve(
          point === "PreToolUse" ? { updatedInput: { command: "dir | less" } } : undefined,
        ),
    };
    const r = await h.executor.execute(call("shell", { command: "dir" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("invalid_input");
    expect(r.result.modelContent).toBe(PAGER_MESSAGE);
  });

  it("其他工具无 validateInput：行为不变（read 照常执行）", async () => {
    const ws = tmpWorkspace();
    writeFileSync(path.join(ws, "a.txt"), "hi\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("hi");
  });
});

describe("shell 工具 × ADR-0022（描述符 / 分页器名单 / 主体 shell 字段）", () => {
  const pwshScope = { descriptor: shellDescriptor("pwsh", "C:\\ps\\pwsh.exe", "win32") };
  const resolution = (descriptor: ReturnType<typeof shellDescriptor>): ShellResolution => ({
    descriptor,
    source: "auto",
    selected: "auto",
  });

  it("permissionSubjects 主体携带当前 shell 种类与描述符风险元数据", () => {
    const subs = shellTool.permissionSubjects({ command: "ls" }, {
      shell: resolution(pwshScope.descriptor),
    } as never);
    expect(subs).toEqual([
      {
        kind: "shell",
        target: "ls",
        shell: "pwsh",
        shellRisk: pwshScope.descriptor.risk,
        shellRiskByDialect: SHELL_RISK_BY_DIALECT,
      },
    ]);
    // 未装配 shell 时主体不带 shell/shellRisk 字段（权限层按 POSIX 保守处理）
    const bare = shellTool.permissionSubjects({ command: "ls" }, {} as never);
    expect(bare).toEqual([
      { kind: "shell", target: "ls", shellRiskByDialect: SHELL_RISK_BY_DIALECT },
    ]);
    expect("shell" in (bare[0] ?? {})).toBe(false);
    expect("shellRisk" in (bare[0] ?? {})).toBe(false);
  });

  it("描述符风险元数据经主体进入权限判定：pwsh 高危组合在全放行下仍 ask", () => {
    const policy = createRulePolicy({
      workspaceRoot: "C:\\ws",
      caseSensitive: false,
      preset: "guarded",
    });
    const subs = shellTool.permissionSubjects({ command: "Remove-Item x -Recurse -Force" }, {
      shell: resolution(pwshScope.descriptor),
    } as never);
    expect(policy.evaluate(subs).decision.action).toBe("ask");
    // 嵌套调用：cmd 下 pwsh -c 交出的命令体按 PowerShell 表判定
    const nested = shellTool.permissionSubjects(
      { command: 'pwsh -c "Remove-Item x -Recurse -Force"' },
      { shell: resolution(shellDescriptor("cmd", "cmd.exe", "win32")) } as never,
    );
    expect(policy.evaluate(nested).decision.action).toBe("ask");
  });

  it("分页器名单按生效 shell：pwsh 拒绝 more/Out-Host -Paging/oh -p，放行 less", () => {
    const scope = { shell: resolution(pwshScope.descriptor) } as never;
    for (const command of [
      "dir | more",
      "Get-ChildItem | Out-Host -Paging",
      "Get-ChildItem | oh -Paging",
      "Get-ChildItem | oh -p", // PowerShell 参数前缀缩写
      "Get-ChildItem | Out-Host -p",
    ]) {
      expect(shellTool.validateInput?.({ command }, scope), command).toContain("分页工具");
    }
    // 无 -Paging 的 Out-Host、非本方言分页器照常放行
    for (const command of ["Get-ChildItem | Out-Host", "x | less", "x | Out-String -Paging"]) {
      expect(shellTool.validateInput?.({ command }, scope), command).toBeUndefined();
    }
  });

  it("bash/sh 名单含 more+less；cmd 只含 more（less 放行）", () => {
    const bash = { shell: resolution(shellDescriptor("bash", "bash", "win32")) } as never;
    const cmd = { shell: resolution(shellDescriptor("cmd", "cmd.exe", "win32")) } as never;
    for (const command of ["x | less", "x | more"]) {
      expect(shellTool.validateInput?.({ command }, bash), command).toContain("分页工具");
    }
    expect(shellTool.validateInput?.({ command: "x | more" }, cmd)).toContain("分页工具");
    expect(shellTool.validateInput?.({ command: "x | less" }, cmd)).toBeUndefined();
    expect(shellTool.validateInput?.({ command: "x | oh -Paging" }, cmd)).toBeUndefined();
  });

  it("描述符缺省（无 shell 装配）回退全量名单 more/less", () => {
    expect(shellTool.validateInput?.({ command: "x | more" })).toContain("分页工具");
    expect(shellTool.validateInput?.({ command: "x | less" })).toContain("分页工具");
    // flagPagers 无描述符时不启用：Out-Host -Paging 不拒绝
    expect(
      shellTool.validateInput?.({ command: "Get-ChildItem | Out-Host -Paging" }),
    ).toBeUndefined();
  });

  it("显式选择的 shell 不可用：执行前返回错误并列出检测信息，不 spawn", async () => {
    const ws = tmpWorkspace();
    const spawnShell = vi.fn();
    const runner: ProcessRunner = {
      spawn: () => {
        throw new Error("unused");
      },
      spawnPipe: () => {
        throw new Error("unused");
      },
      spawnShell,
    };
    const h = await makeHarness(ws, {
      process: runner,
      shell: {
        source: "env",
        selected: "sh",
        error: "指定的 shell sh 未安装；可用 shell：pwsh | cmd",
      },
    });
    const r = await h.executor.execute(call("shell", { command: "ls" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("tool_failed");
    expect(r.result.modelContent).toContain("sh 未安装");
    expect(spawnShell).not.toHaveBeenCalled();
  });

  it("生效描述符原样传给 spawnShell（argv 由描述符 invoke 决定）", async () => {
    const ws = tmpWorkspace();
    const seen: {
      command?: string | undefined;
      shell?: string | undefined;
      verbatim?: boolean | undefined;
    } = {};
    const runner: ProcessRunner = {
      spawn: () => {
        throw new Error("unused");
      },
      spawnPipe: () => {
        throw new Error("unused");
      },
      spawnShell(command, options) {
        seen.command = command;
        seen.shell = options?.shell?.kind;
        seen.verbatim = options?.shell?.invoke(command).verbatimArgs;
        const done = Promise.resolve({
          code: 0,
          signal: null,
          timedOut: false,
          killed: false,
        });
        return {
          pid: 1,
          stdout: (async function* () {
            yield "OK\n";
          })(),
          stderr: (async function* () {
            await Promise.resolve();
          })(),
          wait: () => done,
          kill: () => Promise.resolve(),
          detachOutput: () => undefined,
        } satisfies SpawnedProcess;
      },
    };
    const h = await makeHarness(ws, {
      process: runner,
      shell: resolution(shellDescriptor("pwsh", "C:\\ps\\pwsh.exe", "win32")),
    });
    const r = await h.executor.execute(call("shell", { command: "ls" }), h.scope);
    expect(r.status).toBe("ok");
    expect(seen.shell).toBe("pwsh");
    expect(seen.verbatim).not.toBe(true);
    expect(r.result.modelContent).toContain("OK");
  });
});

describe("diffLines", () => {
  it("公共前后缀作上下文，中段 -/+", () => {
    const d = diffLines("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n", "f.ts");
    expect(d).toContain("@@ -1,5 +1,5 @@");
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

  it("首尾插入、删除及末尾换行使用真实行数和零行位置", () => {
    expect(diffLines("", "first\n")).toBe("@@ -0,0 +1,1 @@\n+first");
    expect(diffLines("last\n", "")).toBe("@@ -1,1 +0,0 @@\n-last");
    expect(diffLines("a\n", "a\nb\n")).toBe("@@ -1,1 +1,2 @@\n a\n+b");
    expect(diffLines("a", "a\n")).toBe("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a");
  });

  it("仅 CRLF/LF 不同也产生变更行", () => {
    expect(diffLines("a\r\n", "a\n")).toBe("@@ -1,1 +1,1 @@\n-a\n\\ CRLF\n+a");
  });
});
