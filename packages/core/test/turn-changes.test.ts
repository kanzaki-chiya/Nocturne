import { mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntime, FakeProvider, createPlatform } from "../src/index.js";
import { createCheckpointRecorder } from "../src/session/checkpoints.js";
import { createTurnChanges } from "../src/session/turn-changes.js";
import { internalSession } from "./internal-session.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nct-changes-")));
  roots.push(root);
  const sessionsDir = path.join(root, "sessions");
  const platform = createPlatform();
  const runtime = await createRuntime({
    cwd: root,
    sessionsDir,
    providers: [new FakeProvider({})],
  });
  const session = await runtime.createSession({ model: "fake/fake-1" });
  const s = internalSession(session);
  const record = createCheckpointRecorder(s, platform, sessionsDir);
  const user = () =>
    s.emit("message.user", { messageId: "u", content: [{ type: "text", text: "change" }] });
  const edit = async (name: string, text: string | Uint8Array | null) => {
    const target = path.join(root, name);
    const subjects = [{ kind: "edit" as const, target }];
    await record("before", name, subjects, session.id);
    if (text === null) unlinkSync(target);
    else writeFileSync(target, text);
    await record("after", name, subjects, session.id);
  };
  return { root, sessionsDir, platform, runtime, session, s, user, edit };
}

it("同轮两次编辑取净值；两轮归属与后续工具改动不误报 external，计数缓存仍重查磁盘", async () => {
  const h = await setup();
  try {
    writeFileSync(path.join(h.root, "a"), "old\n");
    const first = await h.user();
    await h.edit("a", "middle\nextra\n");
    await h.edit("a", "final\n");
    const second = await h.user();
    await h.edit("a", "later\n");
    await h.edit("b", "new\n");
    const changes = await h.session.turnChanges();
    expect(changes).toEqual([
      {
        seq: first.seq,
        files: [
          {
            path: path.join(h.root, "a"),
            status: "modified",
            added: 1,
            removed: 1,
            external: false,
          },
        ],
        untrackedCalls: 0,
      },
      {
        seq: second.seq,
        files: [
          {
            path: path.join(h.root, "a"),
            status: "modified",
            added: 1,
            removed: 1,
            external: false,
          },
          { path: path.join(h.root, "b"), status: "added", added: 1, removed: 0, external: false },
        ],
        untrackedCalls: 0,
      },
    ]);
    console.log("turnChanges two-round JSON:", JSON.stringify(changes));
    const query = createTurnChanges(h.s, h.platform, h.sessionsDir);
    expect(await query.changes()).toEqual(changes);
    const read = vi.spyOn(h.platform.fs, "readFile");
    await query.changes();
    expect(read.mock.calls.every(([file]) => !file.includes("checkpoints"))).toBe(true);
    writeFileSync(path.join(h.root, "a"), "external");
    expect(
      (await h.session.turnChanges()).every(
        (t) => t.files.find((f) => f.path.endsWith("a"))?.external,
      ),
    ).toBe(true);
    expect(await h.session.turnChangeDiff(first.seq, path.join(h.root, "a"))).toEqual({
      diff: "@@ -1,1 +1,1 @@\n-old\n+final",
    });
  } finally {
    await h.session.close();
  }
});

it("新增、删除与改回原文；去 BOM，空轮省略", async () => {
  const h = await setup();
  try {
    writeFileSync(path.join(h.root, "deleted"), "old\n");
    writeFileSync(path.join(h.root, "back"), "old\n");
    const u = await h.user();
    await h.edit("new", "new\n");
    await h.edit("deleted", null);
    await h.edit("back", "changed\n");
    await h.edit("back", "old\n");
    const [turn] = await h.session.turnChanges();
    expect(turn?.files.map((f) => f.status)).toEqual(["added", "deleted"]);
    await expect(h.session.turnChangeDiff(u.seq, path.join(h.root, "back"))).rejects.toMatchObject({
      code: "invalid_command",
    });
    await h.user();
    writeFileSync(path.join(h.root, "bom"), "\uFEFFtext\n");
    await h.edit("bom", "text\n");
    expect(await h.session.turnChanges()).toHaveLength(1);
  } finally {
    await h.session.close();
  }
});

it("仅对话回退不重归属被移除的轮；shell 类统计限原始轮；文件回退带 reverted", async () => {
  const h = await setup();
  try {
    const first = await h.user();
    await h.edit("a", "one\n");
    const second = await h.user();
    await h.edit("b", "two\n");
    await h.s.emit("tool.started", {
      callId: "untracked",
      name: "not-shell",
      mutates: true,
      input: {},
      subjects: [],
      permission: { action: "allow", source: "rule" },
    });
    expect((await h.session.turnChanges())[1]?.untrackedCalls).toBe(1);
    await h.session.rewind(second.seq, "conversation");
    const third = await h.user();
    await h.edit("c", "three\n");
    expect(
      (await h.session.turnChanges()).map((t) => [
        t.seq,
        t.files.map((f) => path.basename(f.path)),
        t.untrackedCalls,
      ]),
    ).toEqual([
      [first.seq, ["a"], 0],
      [third.seq, ["c"], 0],
    ]);
    const files = await h.session.rewind(third.seq, "files");
    expect((await h.session.turnChanges())[1]?.reverted).toEqual({
      seq: h.session.durableEvents().at(-1)?.seq,
      files,
    });
    await expect(
      h.session.turnChangeDiff(second.seq, path.join(h.root, "b")),
    ).rejects.toMatchObject({ code: "invalid_command" });
  } finally {
    await h.session.close();
  }
});

it("二进制、大于 1MB、未追踪、缺 after 和缺内容降级，非法 diff 拒绝", async () => {
  const h = await setup();
  try {
    const u = await h.user();
    await h.edit("binary", new Uint8Array([65, 0, 66]));
    await h.edit("large", "x".repeat(1024 * 1024 + 1));
    await h.s.emit("checkpoint.file", {
      callId: "u",
      path: path.join(h.root, "untracked"),
      phase: "before",
      before: { untracked: "不是普通文件" },
    });
    await h.s.emit("checkpoint.file", {
      callId: "c",
      path: path.join(h.root, "crash"),
      phase: "before",
      before: null,
    });
    await h.edit("missing", "saved");
    const after = h.session.durableEvents().findLast((e) => e.type === "checkpoint.file");
    if (
      after?.type !== "checkpoint.file" ||
      after.payload.phase !== "after" ||
      !after.payload.sha256
    )
      throw new Error("no after");
    unlinkSync(path.join(h.sessionsDir, "checkpoints", h.session.id, after.payload.sha256));
    expect((await h.session.turnChanges())[0]?.files.map((f) => f.unavailable)).toEqual([
      "二进制文件",
      "文件较大，不计算差异",
      "不是普通文件",
      "没有改动后的记录",
      "检查点内容缺失",
    ]);
    for (const [seq, name] of [
      [999, "binary"],
      [u.seq, "unknown"],
      [u.seq, "binary"],
    ] as const)
      await expect(h.session.turnChangeDiff(seq, path.join(h.root, name))).rejects.toMatchObject({
        code: "invalid_command",
      });
    const id = h.session.id;
    await h.session.close();
    const resumed = await h.runtime.resumeSession(id);
    try {
      expect((await resumed.turnChanges())[0]?.files.at(-1)?.unavailable).toBe(
        "旧会话没有保存改动后的内容",
      );
    } finally {
      await resumed.close();
    }
  } finally {
    await h.session.close();
  }
});
