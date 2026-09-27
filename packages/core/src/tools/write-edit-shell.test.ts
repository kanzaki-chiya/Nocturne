/**
 * write / edit / shell 工具的离线测试（tools.md 第 6 节）。
 * 写文件与 shell 命令只在临时目录中执行。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const ORPHAN_MARKER = "ORPHAN-HOLDS-PIPE-7f3a";

/** 测试派生的后台进程 pid，afterEach 统一清理，不留孤儿 */
const orphanPids: number[] = [];

/** 终止指定 PID 的进程树；已退出的进程忽略（Windows taskkill /T，POSIX 直接 SIGKILL） */
async function killPidTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已退出
  }
}

afterEach(async () => {
  // 先杀孤儿再等其消失：Windows 上进程持有的 cwd 句柄会锁临时目录，
  // 必须在删目录前完成。除已登记 PID 外还扫描本次临时目录中的 orphan.pid
  // （去重）：工具执行/断言/vi.waitFor 在 trackOrphan 之前失败时，pid 文件
  // 已写出的孤儿同样被清理；只读自己创建的目录，不触碰其他进程
  const pids = new Set(orphanPids.splice(0));
  for (const root of tmpRoots) {
    const pidFile = path.join(root, "orphan.pid");
    if (!existsSync(pidFile)) continue;
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  for (const pid of pids) {
    await killPidTree(pid);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/** 读取孤儿 pid 文件并登记清理（pid 文件由测试脚本写出，不会误杀其他进程） */
async function trackOrphan(pidFile: string): Promise<void> {
  if (await platform.fs.exists(pidFile)) {
    const pid = Number(await platform.fs.readTextFile(pidFile));
    if (Number.isInteger(pid) && pid > 0) orphanPids.push(pid);
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
    orphanPids.push(grandchildPid);

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

  it("分页器占用管道的命令（| more）：有界返回", async () => {
    const ws = tmpWorkspace();
    // 真实孤儿场景接分页器：leaf detached 继承 parent→more 的管道，more 等不到
    // stdin EOF 不退出，整条管道命令随之挂起，直到超时终止
    const { pidFile } = writeOrphanScripts(ws);
    const h = await makeHarness(ws);
    const started = Date.now();
    const r = await h.executor.execute(
      call("shell", {
        command: `${node} orphan-parent.js | more`,
        timeoutMs: 1_000,
      }),
      h.scope,
    );
    const elapsed = Date.now() - started;
    await trackOrphan(pidFile);
    // 分页器未退出 → timeout 终止；若平台行为令其自然退出则 ok。
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
  outputDetached?: boolean;
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
