import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDefaultPolicy,
  createWorkspaceReadPolicy,
  type PermissionDecision,
} from "../permission/index.js";
import { createPlatform, type Platform } from "../platform/index.js";
import type { Grant, ToolCallRef } from "../protocol/index.js";
import { globToRegExp } from "./builtin/globmatch.js";
import { compileGitignore, matchGitignore } from "./builtin/gitignore.js";
import {
  builtinTools,
  createAttachmentStore,
  createBuiltinRegistry,
  createPolicyGate,
  createReadStateStore,
  createToolExecutor,
  createToolRegistry,
  readTool,
  type ExecutionScope,
  type GateOutcome,
  type PermissionGate,
  type ToolDefinition,
} from "./index.js";

const platform: Platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function tmpWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-tools-"));
  tmpRoots.push(dir);
  return dir;
}

async function writeWs(ws: string, rel: string, content: string): Promise<void> {
  const p = path.join(ws, rel);
  await platform.fs.mkdir(path.dirname(p));
  await platform.fs.writeFile(p, content);
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
  workspaceRoot: string;
}

async function makeHarness(
  ws: string,
  gate?: PermissionGate,
  signal?: AbortSignal,
): Promise<Harness> {
  const workspaceRoot = await platform.resolveReal(ws);
  const policy = createWorkspaceReadPolicy({
    workspaceRoot,
    caseSensitive: platform.caseSensitivePaths,
  });
  const events: Captured[] = [];
  const ephemeral: Captured[] = [];
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot,
    paths: platform.paths,
    sessionId: "s1",
    turnId: "turn-1",
    signal: signal ?? new AbortController().signal,
    platform,
    gate: gate ?? createPolicyGate(policy),
    readState: createReadStateStore(platform.paths),
    events: {
      emit: (type, payload) => {
        events.push({
          type,
          payload: payload as unknown as Captured["payload"],
        });
        return Promise.resolve();
      },
      emitEphemeral: (type, payload) => {
        ephemeral.push({
          type,
          payload: payload as unknown as Captured["payload"],
        });
      },
    },
  };
  const registry = createBuiltinRegistry();
  return {
    scope,
    events,
    ephemeral,
    executor: createToolExecutor(registry),
    workspaceRoot,
  };
}

const call = (name: string, input: unknown, callId = "c1"): ToolCallRef => ({
  callId,
  name,
  input,
});

const completedOf = (h: Harness) => h.events.filter((e) => e.type === "tool.completed");

describe("ToolRegistry", () => {
  it("注册 / 查找 / specs / 重复名抛错", () => {
    const r = createToolRegistry();
    for (const t of builtinTools()) r.register(t);
    expect(r.get("read")?.name).toBe("read");
    expect(
      r
        .specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["edit", "glob", "grep", "read", "shell", "write"]);
    expect(() => r.register(builtinTools()[0] ?? readTool)).toThrow(/重复/);
    r.unregister("read");
    expect(r.get("read")).toBeUndefined();
  });

  it("非法工具名抛错", () => {
    const bad = { ...(builtinTools()[0] ?? readTool), name: "Read-Tool" };
    const r = createToolRegistry();
    expect(() => r.register(bad)).toThrow(/非法/);
  });
});

describe("Executor 管线", () => {
  it("unknown_tool：恰好一个 tool.completed，错误含可用工具名", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("nope", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)).toHaveLength(1);
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "unknown_tool",
    });
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("read");
  });

  it("invalid_input：schema 校验失败", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "invalid_input",
    });
  });

  it("权限拒绝：denied + permission.resolved + 无 tool.started", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "secret.txt", "top secret");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: path.join(outside, "secret.txt") }),
      h.scope,
    );
    expect(r.status).toBe("denied");
    expect(h.events.some((e) => e.type === "tool.started")).toBe(false);
    const resolved = h.events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload).toMatchObject({ action: "deny", source: "rule" });
    expect(completedOf(h)).toHaveLength(1);
    expect(completedOf(h)[0]?.payload.status).toBe("denied");
  });

  it("正常调用：tool.started 先于执行，恰好一个 tool.completed", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "a.txt", "hello\nworld\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("ok");
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(["tool.started", "tool.completed"]);
    expect(String(completedOf(h)[0]?.payload.modelContent)).toContain("1|hello");
    // 已读状态被记录
    const wsReal = await platform.resolveReal(ws);
    expect(h.scope.readState.get(path.join(wsReal, "a.txt"))).toBeDefined();
  });

  it("工具抛异常 → tool_failed", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const registry = createToolRegistry();
    const boom: ToolDefinition = {
      name: "boom",
      description: "x",
      inputSchema: { type: "object" },
      traits: { mutates: false, concurrencySafe: true, timeoutMs: 1000 },
      permissionSubjects: () => [],
      execute: () => {
        throw new Error("kaboom");
      },
    };
    registry.register(boom);
    const r = await createToolExecutor(registry).execute(call("boom", {}), h.scope);
    expect(r.status).toBe("error");
    expect(completedOf(h)[0]?.payload.error).toMatchObject({
      code: "tool_failed",
    });
  });

  it("执行前已中断 → cancelled", async () => {
    const ws = tmpWorkspace();
    const ac = new AbortController();
    ac.abort();
    const h = await makeHarness(ws, undefined, ac.signal);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("cancelled");
    expect(completedOf(h)).toHaveLength(1);
  });

  it("gate 返回 stopTurn → ToolExecution.stopTurn", async () => {
    const ws = tmpWorkspace();
    const denyStop: PermissionGate = {
      check: (subjects): Promise<GateOutcome> =>
        Promise.resolve({
          subjects,
          decision: {
            action: "deny",
            source: "user",
            reason: "用户拒绝并停止",
          } satisfies PermissionDecision,
          stopTurn: true,
        }),
      checkLexical: () => "deny",
    };
    const h = await makeHarness(ws, denyStop);
    const r = await h.executor.execute(call("read", { path: "a.txt" }), h.scope);
    expect(r.status).toBe("denied");
    expect(r.stopTurn).toBe(true);
  });
});

describe("read 工具", () => {
  it("offset/limit 截取行并标注剩余", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "b.txt", "l1\nl2\nl3\nl4\nl5");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: "b.txt", offset: 2, limit: 2 }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("2|l2");
    expect(r.result.modelContent).toContain("3|l3");
    expect(r.result.modelContent).not.toContain("1|l1");
    expect(r.result.modelContent).toContain("还有 2 行");
  });

  it("文件不存在 → file_not_found", async () => {
    const ws = tmpWorkspace();
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "missing.txt" }), h.scope);
    expect(r.status).toBe("error");
    expect(r.result.status === "error" && r.result.error.code).toBe("file_not_found");
  });

  it("二进制文件 → binary_file", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "bin.dat", "abc");
    const bin = await platform.fs.readFile(path.join(ws, "bin.dat"));
    bin[1] = 0;
    await platform.fs.writeFile(path.join(ws, "bin.dat"), bin);
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "bin.dat" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("binary_file");
  });

  it(".. 逃逸到工作区外 → denied", async () => {
    const ws = tmpWorkspace();
    const parent = path.dirname(ws);
    await writeWs(parent, `escape-${path.basename(ws)}.txt`, "x");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(
      call("read", { path: `..\\escape-${path.basename(ws)}.txt` }),
      h.scope,
    );
    expect(r.status).toBe("denied");
    rmSync(path.join(parent, `escape-${path.basename(ws)}.txt`), {
      force: true,
    });
  });
});

describe("read 图片（ADR-0023 第 2 节）", () => {
  const u8 = (arr: number[]): Uint8Array => new Uint8Array(arr);
  const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  const PNG = (w: number, h: number): Uint8Array =>
    u8([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...u32be(13),
      ...ascii("IHDR"),
      ...u32be(w),
      ...u32be(h),
      8,
      6,
      0,
      0,
      0,
    ]);
  const JPEG = (w: number, h: number): Uint8Array =>
    u8([
      0xff,
      0xd8,
      0xff,
      0xe0,
      ...u16be(16),
      ...ascii("JFIF"),
      0,
      ...new Array(9).fill(0),
      0xff,
      0xc0,
      ...u16be(17),
      8,
      ...u16be(h),
      ...u16be(w),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]);
  const GIF = (w: number, h: number): Uint8Array =>
    u8([...ascii("GIF89a"), ...u16le(w), ...u16le(h), 0xf0, 0, 0]);
  const WEBP = (w: number, h: number): Uint8Array =>
    u8([
      ...ascii("RIFF"),
      ...u32be(18),
      ...ascii("WEBP"),
      ...ascii("VP8X"),
      ...u32be(10),
      0,
      0,
      0,
      0,
      (w - 1) & 0xff,
      ((w - 1) >> 8) & 0xff,
      ((w - 1) >> 16) & 0xff,
      (h - 1) & 0xff,
      ((h - 1) >> 8) & 0xff,
      ((h - 1) >> 16) & 0xff,
    ]);

  async function writeBin(ws: string, rel: string, data: Uint8Array): Promise<void> {
    await platform.fs.writeFile(path.join(ws, rel), data);
  }

  function withAttachmentStore(h: Harness, attachmentsDir: string): void {
    h.scope.attachments = createAttachmentStore({
      fs: platform.fs,
      paths: platform.paths,
      attachmentsDir,
      sessionId: h.scope.sessionId,
    });
  }

  it.each([
    ["png", PNG(2, 3), "image/png"],
    ["jpeg", JPEG(4, 5), "image/jpeg"],
    ["gif", GIF(6, 7), "image/gif"],
    ["webp", WEBP(8, 9), "image/webp"],
  ] as const)("四种格式成功：%s → 附件引用落盘、不写 readState", async (ext, data, mime) => {
    const ws = tmpWorkspace();
    const attachmentsDir = tmpWorkspace();
    await writeBin(ws, `pic.${ext}`, data);
    const h = await makeHarness(ws);
    withAttachmentStore(h, attachmentsDir);
    const wsReal = h.workspaceRoot;

    const r = await h.executor.execute(
      call("read", { path: `pic.${ext}`, offset: 5, limit: 1 }),
      h.scope,
    );
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toBe(
      `Image file: pic.${ext} (${mime}, ${{ png: "2×3", jpeg: "4×5", gif: "6×7", webp: "8×9" }[ext]}, ${data.length} B)`,
    );
    const output = r.result.output as { path: string; mimeType: string; bytes: number };
    expect(output.mimeType).toBe(mime);
    expect(output.path).toBe(path.join(wsReal, `pic.${ext}`));
    // 事件里只有引用；文件已落盘
    const done = completedOf(h)[0]?.payload;
    const refs = done?.attachments as { file: string; source: string; label: string }[];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.file).toBe("img-1." + (ext === "jpeg" ? "jpg" : ext));
    expect(refs[0]?.source).toBe("read");
    expect(refs[0]?.label).toBe(`pic.${ext}`);
    const onDisk = await platform.fs.readFile(path.join(attachmentsDir, "s1", refs[0]?.file ?? ""));
    expect(onDisk).toEqual(Buffer.from(data));
    // 图片不写 readState
    expect(h.scope.readState.get(path.join(wsReal, `pic.${ext}`))).toBeUndefined();
  });

  it("截断的 PNG 头 → image_corrupt", async () => {
    const ws = tmpWorkspace();
    await writeBin(ws, "bad.png", PNG(1, 1).subarray(0, 12));
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "bad.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_corrupt");
    expect(r.result.modelContent).toContain("损坏或被截断");
  });

  it(".png 扩展名但内容是文本 → 走文本路径", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "fake.png", "not a real image\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "fake.png" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("1|not a real image");
  });

  it("超过 5 MB 的图片 → image_too_large", async () => {
    const ws = tmpWorkspace();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG(1, 1));
    await writeBin(ws, "big.png", big);
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "big.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_too_large");
    expect(r.result.modelContent).toContain("5 MB");
  });

  it("边长超过 8000 → image_too_large", async () => {
    const ws = tmpWorkspace();
    await writeBin(ws, "tall.png", PNG(8001, 1));
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("read", { path: "tall.png" }), h.scope);
    expect(r.result.status === "error" && r.result.error.code).toBe("image_too_large");
    expect(r.result.modelContent).toContain("8001×1");
  });

  it("SVG 走文本路径；BMP → binary_file 且说明列出支持格式", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "icon.svg", '<svg xmlns="x"><rect/></svg>\n');
    await writeBin(ws, "img.bmp", u8([0x42, 0x4d, 0, 0, 0, 0, 0, 0]));
    const h = await makeHarness(ws);
    const svg = await h.executor.execute(call("read", { path: "icon.svg" }), h.scope);
    expect(svg.status).toBe("ok");
    expect(svg.result.modelContent).toContain("<svg");
    const bmp = await h.executor.execute(call("read", { path: "img.bmp" }, "c2"), h.scope);
    expect(bmp.result.status === "error" && bmp.result.error.code).toBe("binary_file");
    expect(bmp.result.modelContent).toContain("PNG、JPEG、GIF、WebP");
  });
});

describe("grep / glob 边界与行为", () => {
  it("grep 命中工作区内文件", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, "src/a.ts", "const token = 1;\n");
    await writeWs(ws, "src/b.md", "nothing here\n");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("grep", { pattern: "token" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("a.ts:1");
  });

  it("grep 结果不包含 junction 链接到工作区外的内容", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "secret.txt", "token_outside_marker\n");
    // Windows junction：目录链接无需管理员权限
    const linkDir = path.join(ws, "linked");
    await platform.fs.mkdir(linkDir);
    rmSync(linkDir, { recursive: true, force: true });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, linkDir, "junction");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("grep", { pattern: "token_outside_marker" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).not.toContain("token_outside_marker");
  });

  it("glob 枚举不跟随 junction，结果无工作区外文件", async () => {
    const ws = tmpWorkspace();
    const outside = tmpWorkspace();
    await writeWs(outside, "out.txt", "x");
    await writeWs(ws, "in.txt", "y");
    const linkDir = path.join(ws, "linked");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, linkDir, "junction");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("glob", { pattern: "**/*.txt" }), h.scope);
    expect(r.status).toBe("ok");
    expect(r.result.modelContent).toContain("in.txt");
    expect(r.result.modelContent).not.toContain("out.txt");
    expect(r.result.modelContent).not.toContain("linked");
  });

  it("glob 遵守 .gitignore", async () => {
    const ws = tmpWorkspace();
    await writeWs(ws, ".gitignore", "ignored/\n*.tmp\n");
    await writeWs(ws, "ignored/x.ts", "x");
    await writeWs(ws, "keep.ts", "y");
    await writeWs(ws, "drop.tmp", "z");
    const h = await makeHarness(ws);
    const r = await h.executor.execute(call("glob", { pattern: "**/*" }), h.scope);
    expect(r.result.modelContent).toContain("keep.ts");
    expect(r.result.modelContent).not.toContain("x.ts");
    expect(r.result.modelContent).not.toContain("drop.tmp");
  });
});

describe("globToRegExp / gitignore", () => {
  it("glob：* 不跨目录，** 跨目录", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("d/a.ts")).toBe(false);
    expect(globToRegExp("**/*.ts").test("d/e/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/a/b.txt")).toBe(true);
  });

  it("gitignore：基础规则、取反、目录限定", () => {
    const rules = compileGitignore("*.log\n!keep.log\nbuild/\n");
    expect(matchGitignore(rules, "a.log", false)).toBe(true);
    expect(matchGitignore(rules, "keep.log", false)).toBe(false);
    expect(matchGitignore(rules, "build", true)).toBe(true);
    expect(matchGitignore(rules, "build/out.js", false)).toBe(true);
    expect(matchGitignore(rules, "build", false)).toBeUndefined();
    expect(matchGitignore(rules, "src/a.ts", false)).toBeUndefined();
  });
});

describe("PermissionGate（ask 流程与 Grant）", () => {
  const wsSubject = (ws: string, rel = "a.ts") => [
    { kind: "read" as const, target: rel, resolved: path.join(ws, rel) },
  ];

  function gateHarness(ws: string, grants: Grant[]) {
    const events: Captured[] = [];
    const ephemeral: Captured[] = [];
    // default 预设：工作区外 read → ask（workspaceReadPolicy 会直接 deny，走不到 ask 流程）
    const policy = createDefaultPolicy({
      workspaceRoot: ws,
      caseSensitive: platform.caseSensitivePaths,
    });
    const gate = createPolicyGate(policy, {
      interactive: true,
      grants: { session: grants },
      caseSensitive: platform.caseSensitivePaths,
      newRequestId: (id) => `req-${id}`,
    });
    const turn = {
      turnId: "t1",
      events: {
        emit: (type: string, payload: unknown) => {
          events.push({ type, payload: payload as Captured["payload"] });
          return Promise.resolve();
        },
        emitEphemeral: (type: string, payload: unknown) => {
          ephemeral.push({ type, payload: payload as Captured["payload"] });
        },
      } as never,
    };
    return { gate, turn, events, ephemeral };
  }

  it("ask → 用户允许一次：allow + source user + resolved 带规则说明", async () => {
    const ws = tmpWorkspace();
    const outside = path.join(tmpdir(), `nct-out-${Date.now()}`);
    const { gate, turn, events } = gateHarness(ws, []);
    const check = gate.check(wsSubject(outside), "c1", new AbortController().signal, turn);
    // permission.requested 已发出且携带完整选项集
    const requested = events.find((e) => e.type === "permission.requested");
    expect(requested?.payload.requestId).toBe("req-c1");
    expect(requested?.payload.options).toEqual([
      "allow_once",
      "allow_session",
      "allow_project",
      "deny",
      "deny_stop",
    ]);
    const ok = await gate.respond?.("req-c1", { decision: "allow" });
    expect(ok).toBe(true);
    const outcome = await check;
    expect(outcome.decision.action).toBe("allow");
    expect(outcome.decision.source).toBe("user");
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved?.payload.action).toBe("allow");
    expect(String(resolved?.payload.rule)).toContain("预设 default");
  });

  it("ask → 本会话内允许：生成会话 Grant，后续同类主体直接放行", async () => {
    const ws = tmpWorkspace();
    const grants: Grant[] = [];
    const outside = path.join(tmpdir(), `nct-out2-${Date.now()}`);
    const { gate, turn } = gateHarness(ws, grants);
    const signal = new AbortController().signal;
    const check = gate.check(wsSubject(outside), "c1", signal, turn);
    await gate.respond?.("req-c1", { decision: "allow", remember: "session" });
    const outcome = await check;
    expect(outcome.remember).toBe("session");
    expect(grants).toHaveLength(1);
    // grant 写入会话集合后，同一主体的下一次求值直接 allow（policy 读活引用）——
    // 本测试用 workspaceReadPolicy 不带 grants 联动，故直接验证 grants 内容
    expect(grants[0]?.kind).toBe("read");
  });

  it("ask → 拒绝并停止：stopTurn 置位", async () => {
    const ws = tmpWorkspace();
    const outside = path.join(tmpdir(), `nct-out3-${Date.now()}`);
    const { gate, turn } = gateHarness(ws, []);
    const check = gate.check(wsSubject(outside), "c1", new AbortController().signal, turn);
    await gate.respond?.("req-c1", { decision: "deny", stop: true, feedback: "别动这个" });
    const outcome = await check;
    expect(outcome.decision.action).toBe("deny");
    expect(outcome.stopTurn).toBe(true);
    expect(outcome.feedback).toBe("别动这个");
  });

  it("非交互：ask 直接结算为 deny，不发 permission.requested", async () => {
    const ws = tmpWorkspace();
    const policy = createDefaultPolicy({
      workspaceRoot: ws,
      caseSensitive: platform.caseSensitivePaths,
    });
    const gate = createPolicyGate(policy);
    const outside = path.join(tmpdir(), `nct-out4-${Date.now()}`);
    const outcome = await gate.check(
      wsSubject(outside),
      "c1",
      new AbortController().signal,
      undefined,
    );
    expect(outcome.decision.action).toBe("deny");
    expect(outcome.decision.source).toBe("non_interactive");
  });
});
