/**
 * apply_patch 工具测试（ADR-0035 验收）：
 * 解析器、四级匹配、整体成败与回滚、先读后写、权限主体、
 * 换行/BOM 保留、工具可见性筛选、shell 误用拒绝。
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform, type FileSystem, type Platform } from "../src/platform/index.js";
import type { PermissionSubject } from "../src/protocol/index.js";
import {
  applyPatchTool,
  createBuiltinRegistry,
  createReadStateStore,
  createToolExecutor,
  parsePatch,
  shellTool,
  type ExecutionScope,
  type PermissionGate,
  type ReadStateStore,
  type ToolResult,
} from "../src/tools/index.js";
import { createProcessCleanup, removeTempDirs } from "../../../scripts/test/process-cleanup.mjs";

const processes = createProcessCleanup();
const platform: Platform = processes.platform(createPlatform());
const tmpRoots: string[] = [];
afterEach(async () => {
  await processes.cleanup();
  await removeTempDirs(tmpRoots.splice(0));
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "nct-ap-"));
  tmpRoots.push(d);
  return d;
};

const write = (ws: string, rel: string, content: string): string => {
  const p = path.join(ws, rel);
  writeFileSync(p, content);
  return p;
};
const readBack = (ws: string, rel: string): string => readFileSync(path.join(ws, rel), "utf8");

/** 模拟「本会话已读」：按当前 stat 登记 readState（read 工具做的就是这件事） */
async function markRead(readState: ReadStateStore, p: string): Promise<void> {
  const resolved = await platform.resolveReal(p);
  const stat = statSync(resolved);
  readState.record(resolved, { mtimeMs: stat.mtimeMs, size: stat.size });
}

interface PatchFileOut {
  path: string;
  op: string;
  movedTo?: string;
  diff?: string;
}
type PatchResult = ToolResult<{ files?: PatchFileOut[] }>;
interface ExecOut {
  status: string;
  result: PatchResult;
}

interface ExecHarness {
  ws: string;
  scope: ExecutionScope;
  executor: ReturnType<typeof createToolExecutor>;
  readState: ReadStateStore;
  /** 历次调用批准的权限主体（permissionSubjects → 执行器解析后的列表） */
  subjects: PermissionSubject[][];
}

function harness(ws: string, platformOverride?: Platform): ExecHarness {
  const subjects: PermissionSubject[][] = [];
  const gate: PermissionGate = {
    check: (s) => {
      subjects.push(s);
      return Promise.resolve({
        subjects: s,
        decision: { action: "allow", source: "rule", reason: "test" },
      });
    },
    checkLexical: () => "allow",
  };
  const registry = createBuiltinRegistry();
  const readState = createReadStateStore(platform.paths);
  const scope: ExecutionScope = {
    cwd: ws,
    workspaceRoot: ws,
    paths: platform.paths,
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
    platform: platformOverride ?? platform,
    gate,
    readState,
    events: {
      emit: () => Promise.resolve(),
      emitEphemeral: () => undefined,
    },
    // 本套件测的是 apply_patch；能力值直接给补丁侧
    editTool: "apply_patch",
  };
  return { ws, scope, executor: createToolExecutor(registry), readState, subjects };
}

async function exec(h: ExecHarness, name: string, input: unknown): Promise<ExecOut> {
  return (await h.executor.execute({ callId: "c1", name, input }, h.scope)) as ExecOut;
}
const execPatch = (h: ExecHarness, patch: string): Promise<ExecOut> =>
  exec(h, "apply_patch", { input: patch });

// ── 解析器 ────────────────────────────────────────────────

describe("parsePatch", () => {
  it("Add/Delete/Update/Move、多文件、多 hunk、@@ 上下文、End of File", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+export const x = 1;",
        "*** Update File: src/app.ts",
        "*** Move to: src/main.ts",
        "@@ function start",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "@@ tail",
        "-last",
        "*** End of File",
        "*** Update File: src/second.ts",
        "-only",
        "+changed",
        "*** Delete File: src/old.ts",
        "*** End Patch",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ops.map((o) => o.kind)).toEqual(["add", "update", "update", "delete"]);
    const updOp = parsed.ops[1];
    expect(updOp?.kind === "update" && updOp.moveTo).toBe("src/main.ts");
    expect(updOp?.kind === "update" && updOp.hunks).toHaveLength(2);
    expect(updOp?.kind === "update" && updOp.hunks[1]?.eof).toBe(true);
    expect(updOp?.kind === "update" && updOp.hunks[0]?.context).toBe("function start");
    // 无 @@ 的段是隐式 hunk（Codex 格式允许）
    const second = parsed.ops[2];
    expect(second?.kind === "update" && second.hunks).toHaveLength(1);
    expect(second?.kind === "update" && second.hunks[0]?.context).toBeUndefined();
  });

  it("heredoc 外壳宽松剥离", () => {
    const inner = "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch";
    for (const wrapped of [
      `apply_patch <<'EOF'\n${inner}\nEOF`,
      `apply_patch <<PATCH\n${inner}\nPATCH\n`,
      `apply_patch\n${inner}`,
      `\n\n${inner}\n\n`,
    ]) {
      const parsed = parsePatch(wrapped);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.ops[0]?.kind).toBe("delete");
    }
  });

  it("格式错误逐一拒绝且不猜测", () => {
    const bad: [string, string][] = [
      ["", "补丁为空"],
      ["*** Update File: a\n-x\n+y\n*** End Patch", '"*** Begin Patch"'],
      ["*** Begin Patch\n*** Update File: a\n-x\n+y", '"*** End Patch"'],
      ["*** Begin Patch\n*** Move to: b\n*** End Patch", '"*** Move to" 只能紧跟'],
      ["*** Begin Patch\n*** Add File: a\n没有加号\n*** End Patch", '以 "+" 开头'],
      ["*** Begin Patch\n*** Update File: a\n*** End Patch", "没有任何 hunk"],
      ["*** Begin Patch\n*** Update File: a\n@bad\n*** End Patch", '空格、"-" 或 "+"'],
      ["*** Begin Patch\n*** Update File: a\n-x\n?bad\n*** End Patch", '空格、"-" 或 "+"'],
      ["*** Begin Patch\n*** Delete File:\n*** End Patch", "缺少文件路径"],
      [
        "*** Begin Patch\n*** Delete File: a\n*** End Patch\n还有内容",
        '"*** End Patch" 之后还有内容',
      ],
      ["*** Begin Patch\n*** End Patch", "不包含任何文件操作"],
      [
        "*** Begin Patch\n*** Update File: a\n*** Move to:\n-x\n+y\n*** End Patch",
        "缺少改名目标路径",
      ],
    ];
    for (const [input, msg] of bad) {
      const parsed = parsePatch(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain(msg);
    }
  });
});

// ── 四级匹配与 hunk 语义 ──────────────────────────────────

const upd = (rel: string, body: string): string =>
  `*** Begin Patch\n*** Update File: ${rel}\n${body}\n*** End Patch`;

describe("匹配四级（ADR-0035 §2）", () => {
  it("L1 逐字 → L2 行尾空白 → L3 首尾空白 → L4 Unicode 标点", async () => {
    const ws = tmp();
    const h = harness(ws);
    const f1 = write(ws, "l1.txt", "alpha\nbeta\ngamma\n");
    await markRead(h.readState, f1);
    const r1 = await execPatch(h, upd("l1.txt", " beta\n-gamma\n+delta"));
    expect(r1.status).toBe("ok");
    expect(readBack(ws, "l1.txt")).toBe("alpha\nbeta\ndelta\n");

    // L2：补丁行尾多空白，文件行没有
    const f2 = write(ws, "l2.txt", "foo\nbar\n");
    await markRead(h.readState, f2);
    const r2 = await execPatch(h, upd("l2.txt", " foo   \n-bar   \n+baz"));
    expect(r2.status).toBe("ok");
    expect(readBack(ws, "l2.txt")).toBe("foo\nbaz\n");

    // L3：文件行有前导缩进，补丁没写
    const f3 = write(ws, "l3.txt", "    indented = 1;\nend\n");
    await markRead(h.readState, f3);
    const r3 = await execPatch(h, upd("l3.txt", "-indented = 1;\n+indented = 2;"));
    expect(r3.status).toBe("ok");
    expect(readBack(ws, "l3.txt")).toBe("indented = 2;\nend\n");

    // L4：文件里是弯引号/破折号/不间断空格，补丁写 ASCII
    const f4 = write(ws, "l4.txt", "const s = “a”—b\u00a0c;\n");
    await markRead(h.readState, f4);
    const r4 = await execPatch(h, upd("l4.txt", '-const s = "a"-b c;\n+const s = "x";'));
    expect(r4.status).toBe("ok");
    expect(readBack(ws, "l4.txt")).toBe('const s = "x";\n');
  });

  it("多个 hunk 顺序应用：后一个从前一个结束位置之后找", async () => {
    const ws = tmp();
    const m = write(ws, "m.txt", "same\nA\nsame\nB\nsame\n");
    const h = harness(ws);
    await markRead(h.readState, m);
    // 第二个 hunk 的上下文 "same" 必须在 A1 之后命中，不会回到文件头
    const { status } = await execPatch(h, upd("m.txt", "-A\n+A1\n@@ same\n-B\n+B2"));
    expect(status).toBe("ok");
    expect(readBack(ws, "m.txt")).toBe("same\nA1\nsame\nB2\nsame\n");
  });

  it("@@ 定位上下文先命中再找 hunk；*** End of File 要求贴末尾", async () => {
    const ws = tmp();
    const f = write(ws, "f.txt", "target = 0\nfn a() {\n  keep\n}\nfn b() {\n  drop\n}\n");
    const h = harness(ws);
    await markRead(h.readState, f);
    // @@ 定位到 fn b，再删 drop
    const r = await execPatch(h, upd("f.txt", "@@ fn b()\n-  drop"));
    expect(r.status).toBe("ok");
    expect(readBack(ws, "f.txt")).toBe("target = 0\nfn a() {\n  keep\n}\nfn b() {\n}\n");

    // @@ 上下文未命中 → no_match
    const miss = await execPatch(h, upd("f.txt", "@@ no such fn\n-x\n+y"));
    expect(miss.status).toBe("error");
    expect(miss.result.status === "error" && miss.result.error.code).toBe("no_match");

    // End of File：hunk 不在末尾 → 失败且不落盘
    const tail = write(ws, "tail.txt", "one\ntwo\nthree\n");
    await markRead(h.readState, tail);
    const bad = await execPatch(
      h,
      "*** Begin Patch\n*** Update File: tail.txt\n-two\n+TWO\n*** End of File\n*** End Patch",
    );
    expect(bad.status).toBe("error");
    if (bad.result.status === "error") {
      expect(bad.result.error.code).toBe("no_match");
      expect(bad.result.error.message).toContain("末尾");
    }
    expect(readBack(ws, "tail.txt")).toBe("one\ntwo\nthree\n");

    // 贴末尾则成功
    const good = await execPatch(
      h,
      "*** Begin Patch\n*** Update File: tail.txt\n-three\n+THREE\n*** End of File\n*** End Patch",
    );
    expect(good.status).toBe("ok");
    expect(readBack(ws, "tail.txt")).toBe("one\ntwo\nTHREE\n");
  });

  it("未命中复用 edit 的诊断：错误指出文件与 hunk 序号", async () => {
    const ws = tmp();
    const d = write(ws, "d.txt", "const value = 42;\nother line\n");
    const h = harness(ws);
    await markRead(h.readState, d);
    const out = await execPatch(h, upd("d.txt", "-const value = 41;\n+x"));
    expect(out.status).toBe("error");
    if (out.result.status === "error") {
      expect(out.result.error.code).toBe("no_match");
      expect(out.result.error.message).toContain("d.txt");
      expect(out.result.error.message).toContain("hunk");
    }
  });
});

// ── 语义：增删改与改名 ────────────────────────────────────

describe("文件操作语义", () => {
  it("Add 新建（含嵌套目录）；Update+Move 改名；Delete 删除；逐文件 diff", async () => {
    const ws = tmp();
    const del = write(ws, "old.txt", "bye\n");
    const src = write(ws, "src.txt", "a\nb\n");
    const h = harness(ws);
    await markRead(h.readState, del);
    await markRead(h.readState, src);
    const out = await execPatch(
      h,
      [
        "*** Begin Patch",
        "*** Add File: sub/new.txt",
        "+fresh",
        "*** Update File: src.txt",
        "*** Move to: moved.txt",
        "-b",
        "+B",
        "*** Delete File: old.txt",
        "*** End Patch",
      ].join("\n"),
    );
    expect(out.status).toBe("ok");
    expect(readBack(ws, "sub/new.txt")).toBe("fresh\n");
    expect(readBack(ws, "moved.txt")).toBe("a\nB\n");
    expect(existsSync(path.join(ws, "src.txt"))).toBe(false);
    expect(existsSync(path.join(ws, "old.txt"))).toBe(false);
    if (out.result.status !== "ok") throw new Error("unreachable");
    const files = out.result.output?.files ?? [];
    expect(files.map((f) => f.op)).toEqual(["add", "move", "delete"]);
    expect(files.find((f) => f.op === "move")?.movedTo).toContain("moved.txt");
    expect(files.every((f) => typeof f.diff === "string")).toBe(true);
    expect(out.result.modelContent).toContain("Success. Updated the following files:");
    expect(out.result.modelContent).toMatch(/A .*new\.txt/);
    expect(out.result.modelContent).toMatch(/D .*old\.txt/);
  });

  it("Add 已存在 / Move 目标已存在 → file_exists，其余文件不动", async () => {
    const ws = tmp();
    write(ws, "exists.txt", "here\n");
    write(ws, "new-target.txt", "taken\n");
    const src = write(ws, "src.txt", "data\n");

    const h = harness(ws);
    const r1 = await execPatch(h, "*** Begin Patch\n*** Add File: exists.txt\n+x\n*** End Patch");
    expect(r1.status).toBe("error");
    if (r1.result.status === "error") {
      expect(r1.result.error.code).toBe("file_exists");
      expect(r1.result.error.message).toContain("Update File");
    }
    expect(readBack(ws, "exists.txt")).toBe("here\n");

    await markRead(h.readState, src);
    const r2 = await execPatch(h, upd("src.txt", "*** Move to: new-target.txt\n-data\n+d"));
    expect(r2.status).toBe("error");
    if (r2.result.status === "error") expect(r2.result.error.code).toBe("file_exists");
    expect(readBack(ws, "new-target.txt")).toBe("taken\n");
    expect(readBack(ws, "src.txt")).toBe("data\n");
  });
});

// ── 先读后写与整体成败 ────────────────────────────────────

describe("先读后写与整体成败（ADR-0035 §3）", () => {
  it("Update 未读 → not_read；已读后外部改动 → stale_file；全程不落盘", async () => {
    const ws = tmp();
    write(ws, "unread.txt", "content\n");
    const h = harness(ws);

    const r1 = await execPatch(h, upd("unread.txt", "-content\n+x"));
    expect(r1.status).toBe("error");
    if (r1.result.status === "error") {
      expect(r1.result.error.code).toBe("not_read");
      expect(r1.result.error.message).toContain("read");
    }
    expect(readBack(ws, "unread.txt")).toBe("content\n");

    // 同一补丁里第一个文件改得动、第二个 stale → 两个都不写
    const other = write(ws, "other.txt", "intact\n");
    const stale = write(ws, "stale.txt", "v1\n");
    await markRead(h.readState, other);
    await markRead(h.readState, stale);
    writeFileSync(stale, "v2 changed outside\n");
    const r2 = await execPatch(
      h,
      [
        "*** Begin Patch",
        "*** Update File: other.txt",
        "-intact",
        "+touched",
        "*** Update File: stale.txt",
        "-v1",
        "+v2",
        "*** End Patch",
      ].join("\n"),
    );
    expect(r2.status).toBe("error");
    if (r2.result.status === "error") expect(r2.result.error.code).toBe("stale_file");
    expect(readBack(ws, "other.txt")).toBe("intact\n");
    expect(readBack(ws, "stale.txt")).toBe("v2 changed outside\n");
  });

  it("解析失败 / 匹配失败时一个文件都不写（整体成败）", async () => {
    const ws = tmp();
    const a = write(ws, "a.txt", "aaa\n");
    const h = harness(ws);
    await markRead(h.readState, a);

    // 前半是合法 Add，后半语法坏 → 整个不落盘，且不走权限
    const r1 = await execPatch(
      h,
      "*** Begin Patch\n*** Add File: created.txt\n+x\n*** Bad Op: y\n*** End Patch",
    );
    expect(r1.status).toBe("error");
    if (r1.result.status === "error") expect(r1.result.error.code).toBe("invalid_input");
    expect(existsSync(path.join(ws, "created.txt"))).toBe(false);
    expect(h.subjects).toHaveLength(0);

    // 第一个文件改得动、第二个 hunk 未命中 → a.txt 也保持原样
    const b = write(ws, "b.txt", "bbb\n");
    await markRead(h.readState, b);
    const r2 = await execPatch(
      h,
      "*** Begin Patch\n*** Update File: a.txt\n-aaa\n+AAA\n*** Update File: b.txt\n-不存在\n+x\n*** End Patch",
    );
    expect(r2.status).toBe("error");
    expect(readBack(ws, "a.txt")).toBe("aaa\n");
    expect(readBack(ws, "b.txt")).toBe("bbb\n");
  });

  it("写盘中途失败：已写的文件恢复原状并报错", async () => {
    const ws = tmp();
    const a = write(ws, "a.txt", "aaa\n");
    const b = write(ws, "b.txt", "bbb\n");
    const realFs = platform.fs;
    const failingFs: FileSystem = {
      ...realFs,
      writeFile: (p, content) => {
        if (typeof p === "string" && p.endsWith("b.txt")) {
          return Promise.reject(new Error("injected write failure"));
        }
        return realFs.writeFile(p, content);
      },
    };
    const h = harness(ws, { ...platform, fs: failingFs });
    await markRead(h.readState, a);
    await markRead(h.readState, b);
    const out = await execPatch(
      h,
      "*** Begin Patch\n*** Update File: a.txt\n-aaa\n+AAA\n*** Update File: b.txt\n-bbb\n+BBB\n*** End Patch",
    );
    // plan 顺序：a 先写成功，b 失败 → a 恢复
    expect(out.status).toBe("error");
    if (out.result.status === "error") {
      expect(out.result.error.code).toBe("write_failed");
      expect(out.result.error.message).toContain("injected write failure");
      expect(out.result.error.message).toContain("已恢复原状");
    }
    expect(readBack(ws, "a.txt")).toBe("aaa\n");
    expect(readBack(ws, "b.txt")).toBe("bbb\n");
  });

  it("写盘中途失败且恢复也失败：逐个列出实际状态", async () => {
    const ws = tmp();
    const a = write(ws, "a.txt", "aaa\n");
    const b = write(ws, "b.txt", "bbb\n");
    const realFs = platform.fs;
    const written = new Set<string>();
    const failingFs: FileSystem = {
      ...realFs,
      writeFile: (p, content) => {
        if (typeof p === "string" && p.endsWith("b.txt")) {
          return Promise.reject(new Error("injected write failure"));
        }
        if (typeof p === "string" && written.has(p) && p.endsWith("a.txt")) {
          // 回滚恢复 a.txt 也失败
          return Promise.reject(new Error("restore failed too"));
        }
        if (typeof p === "string") written.add(p);
        return realFs.writeFile(p, content);
      },
    };
    const h = harness(ws, { ...platform, fs: failingFs });
    await markRead(h.readState, a);
    await markRead(h.readState, b);
    const out = await execPatch(
      h,
      "*** Begin Patch\n*** Update File: a.txt\n-aaa\n+AAA\n*** Update File: b.txt\n-bbb\n+BBB\n*** End Patch",
    );
    expect(out.status).toBe("error");
    if (out.result.status === "error") {
      expect(out.result.error.code).toBe("write_failed");
      expect(out.result.error.message).toContain("恢复失败");
      expect(out.result.error.message).toContain("可能已改动");
    }
    expect(readBack(ws, "a.txt")).toBe("AAA\n");
  });

  it("成功写盘后 readState 更新为新 stat，后续删除视为已读", async () => {
    const ws = tmp();
    const f = write(ws, "f.txt", "old\n");
    const h = harness(ws);
    await markRead(h.readState, f);
    const out = await execPatch(h, upd("f.txt", "-old\n+new"));
    expect(out.status).toBe("ok");
    const resolved = await platform.resolveReal(f);
    const rec = h.readState.get(resolved);
    const stat = statSync(resolved);
    expect(rec).toEqual({ mtimeMs: stat.mtimeMs, size: stat.size });
    // 同一 readState 下 Delete 视为已读（写回登记的 stat 记录）
    const del = await execPatch(h, "*** Begin Patch\n*** Delete File: f.txt\n*** End Patch");
    expect(del.status).toBe("ok");
    expect(existsSync(f)).toBe(false);
  });
});

// ── 换行 / BOM / 末尾换行保留 ─────────────────────────────

describe("换行与 BOM 保留", () => {
  it("CRLF 文件改后仍 CRLF；BOM 保留；无末尾换行不新增", async () => {
    const ws = tmp();
    const h = harness(ws);
    const crlf = write(ws, "crlf.txt", "line1\r\nline2\r\nline3\r\n");
    await markRead(h.readState, crlf);
    const r = await execPatch(h, upd("crlf.txt", "-line2\n+LINE2"));
    expect(r.status).toBe("ok");
    expect(readBack(ws, "crlf.txt")).toBe("line1\r\nLINE2\r\nline3\r\n");

    const bom = write(ws, "bom.txt", "﻿keep\n");
    await markRead(h.readState, bom);
    const r2 = await execPatch(h, upd("bom.txt", "-keep\n+保持"));
    expect(r2.status).toBe("ok");
    expect(readFileSync(path.join(ws, "bom.txt"), "utf8").charCodeAt(0)).toBe(0xfeff);

    const noeol = write(ws, "noeol.txt", "tail-no-newline");
    await markRead(h.readState, noeol);
    const r3 = await execPatch(h, upd("noeol.txt", "-tail-no-newline\n+still-no-newline"));
    expect(r3.status).toBe("ok");
    expect(readBack(ws, "noeol.txt")).toBe("still-no-newline");
  });
});

// ── 权限主体与输入校验 ────────────────────────────────────

describe("权限主体与校验", () => {
  it("每个涉及路径产出一个 edit 主体；改名源与目标都算", async () => {
    const ws = tmp();
    const subjects =
      applyPatchTool.permissionSubjects?.(
        {
          input: [
            "*** Begin Patch",
            "*** Add File: new.txt",
            "+x",
            "*** Update File: src.txt",
            "*** Move to: dst.txt",
            "-a",
            "+b",
            "*** Delete File: old.txt",
            "*** End Patch",
          ].join("\n"),
        },
        { cwd: ws, workspaceRoot: ws, paths: platform.paths },
      ) ?? [];
    expect(subjects.map((s) => s.kind)).toEqual(["edit", "edit", "edit", "edit"]);
    const targets = subjects.map((s) => s.target);
    for (const rel of ["new.txt", "src.txt", "dst.txt", "old.txt"]) {
      expect(targets).toContain(platform.paths.resolve(ws, rel));
    }
    // 经执行器跑一遍：主体被批准的路径是 realpath 后的
    const h = harness(ws);
    for (const rel of ["src.txt", "old.txt"]) {
      const p = write(ws, rel, "a\n");
      await markRead(h.readState, p);
    }
    const out = await execPatch(
      h,
      [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+x",
        "*** Update File: src.txt",
        "*** Move to: dst.txt",
        "-a",
        "+b",
        "*** Delete File: old.txt",
        "*** End Patch",
      ].join("\n"),
    );
    expect(out.status).toBe("ok");
    expect(h.subjects).toHaveLength(1);
    expect(h.subjects[0]?.map((s) => s.kind)).toEqual(["edit", "edit", "edit", "edit"]);
    expect(h.subjects[0]?.every((s) => s.resolved !== undefined)).toBe(true);
  });

  it("补丁解析失败 → validateInput 拒绝，不产主体", () => {
    expect(
      applyPatchTool.validateInput?.({ input: "*** Begin Patch\n*** Bad\n*** End Patch" }),
    ).toContain("补丁格式错误");
    expect(
      applyPatchTool.permissionSubjects?.(
        { input: "not a patch" },
        { cwd: "/w", workspaceRoot: "/w", paths: platform.paths },
      ),
    ).toEqual([]);
    expect(
      applyPatchTool.validateInput?.({
        input: "*** Begin Patch\n*** Delete File: a\n*** End Patch",
      }),
    ).toBeUndefined();
  });

  it("经执行器：解析失败以 invalid_input 结算且不请求权限", async () => {
    const ws = tmp();
    const h = harness(ws);
    const out = await execPatch(h, "垃圾");
    expect(out.status).toBe("error");
    if (out.result.status === "error") expect(out.result.error.code).toBe("invalid_input");
    expect(h.subjects).toHaveLength(0);
  });
});

// ── 工具可见性筛选（ADR-0035 §5） ─────────────────────────

describe("按模型 editTool 筛选", () => {
  it("specs/get 按能力值筛选；不带值不筛", () => {
    const registry = createBuiltinRegistry();
    const names = (caps?: "edit" | "apply_patch") => registry.specs(caps).map((t) => t.name);
    expect(names("apply_patch")).toContain("apply_patch");
    expect(names("apply_patch")).not.toContain("edit");
    expect(names("apply_patch")).not.toContain("write");
    expect(names("edit")).toContain("edit");
    expect(names("edit")).toContain("write");
    expect(names("edit")).not.toContain("apply_patch");
    // 缺省不筛选：三套编辑工具都在
    for (const n of ["edit", "write", "apply_patch"]) expect(names()).toContain(n);
    // 非编辑工具不受影响
    for (const n of ["read", "shell", "grep"]) expect(names("apply_patch")).toContain(n);
    expect(registry.get("edit", "apply_patch")).toBeUndefined();
    expect(registry.get("apply_patch", "apply_patch")).toBe(applyPatchTool);
    expect(registry.get("edit", "edit")).toBeDefined();
    expect(registry.get("apply_patch", "edit")).toBeUndefined();
  });

  it("调用未暴露的编辑工具 → unknown_tool 且可用列表同口径", async () => {
    const ws = tmp();
    const h = harness(ws); // scope.editTool = "apply_patch"
    const out = await exec(h, "edit", { path: "x", old: "a", new: "b" });
    expect(out.status).toBe("error");
    if (out.result.status === "error") {
      expect(out.result.error.code).toBe("unknown_tool");
      expect(out.result.error.message).toContain("未知工具");
      const listed = out.result.error.message.split("可用工具：")[1]?.split(", ") ?? [];
      expect(listed).toContain("apply_patch");
      expect(listed).not.toContain("edit");
      expect(listed).not.toContain("write");
    }
    // 反向：editTool=edit 时 apply_patch 不可见
    const h2 = harness(ws);
    h2.scope.editTool = "edit";
    const out2 = await exec(h2, "apply_patch", {
      input: "*** Begin Patch\n*** End Patch",
    });
    expect(out2.status).toBe("error");
    if (out2.result.status === "error") expect(out2.result.error.code).toBe("unknown_tool");
  });
});

// ── shell 误用拒绝（ADR-0035 §6） ─────────────────────────

describe("shell 里执行 apply_patch", () => {
  it("命令第一个词是 apply_patch → 拒绝，文案指向工具", () => {
    for (const cmd of [
      "apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF",
      "  apply_patch -x",
      "FOO=1 apply_patch <<PATCH",
    ]) {
      const msg = shellTool.validateInput?.({ command: cmd });
      expect(msg).toBe(
        "`apply_patch` 不是 shell 命令；工具列表里有 `apply_patch` 时请直接调用该工具，并把补丁原文放进 `input`",
      );
    }
    // 非首词 / 名字相近不拦
    expect(shellTool.validateInput?.({ command: "echo apply_patch" })).toBeUndefined();
    expect(shellTool.validateInput?.({ command: "echo hi | apply_patch_x" })).toBeUndefined();
  });

  it("经执行器：以 invalid_input 结算且不请求权限", async () => {
    const ws = tmp();
    const h = harness(ws);
    const out = await exec(h, "shell", {
      command: "apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF",
    });
    expect(out.status).toBe("error");
    if (out.result.status === "error") expect(out.result.error.code).toBe("invalid_input");
    expect(h.subjects).toHaveLength(0);
  });
});
