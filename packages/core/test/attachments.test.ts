/**
 * 附件存储 × 真实会话存储（ADR-0023 第 2 节）：
 * 恢复会话后历史保留附件引用，新 save 编号不与已落盘文件冲突。
 * 跨模块协作测试放在 test/（depcheck 只允许 tools 依赖 protocol/permission/platform）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPlatform } from "../src/platform/index.js";
import { createSessionStore } from "../src/session/index.js";
import { createAttachmentStore } from "../src/tools/index.js";

const platform = createPlatform();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

const PNG_2x3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);

const makeStore = (attachmentsDir: string, sessionId: string) =>
  createAttachmentStore({ fs: platform.fs, paths: platform.paths, attachmentsDir, sessionId });

describe("附件编号跨恢复续接（ADR-0023）", () => {
  it("带附件的会话恢复后历史含引用，新 save 续编号不撞旧文件", async () => {
    const sessionsDir = tmpDir("nct-att-sess-");
    const attachmentsDir = path.join(sessionsDir, "attachments");
    const store = createSessionStore({ platform, sessionsDir });
    const s1 = await store.create({
      cwd: "Z:\\repo",
      workspaceRoot: "Z:\\repo",
      model: { provider: "fake", model: "fake-1" },
      permissionPreset: "default",
      nocturneVersion: "0.0.0",
    });
    const a1 = await makeStore(attachmentsDir, s1.id).save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "read",
    });
    await s1.emit("turn.started", { turnIndex: 1 }, { turnId: "t1" });
    await s1.emit(
      "tool.completed",
      {
        callId: "c1",
        name: "read",
        status: "ok",
        modelContent: "Image file: x.png",
        attachments: [a1],
      },
      { turnId: "t1" },
    );
    await s1.emit(
      "turn.completed",
      { reason: "done", steps: 1, usage: { inputTokens: 0, outputTokens: 0 } },
      { turnId: "t1" },
    );
    await s1.close();

    const s2 = await store.load(s1.id);
    const toolEntry = s2.state().history.find((h) => h.kind === "tool");
    expect(toolEntry?.kind === "tool" && toolEntry.attachments?.[0]?.file).toBe("img-1.png");
    const a2 = await makeStore(attachmentsDir, s2.id).save({
      data: PNG_2x3,
      mimeType: "image/png",
      source: "paste",
    });
    expect(a2.file).toBe("img-2.png");
    expect(await platform.fs.exists(path.join(attachmentsDir, s2.id, "img-1.png"))).toBe(true);
    await s2.close();
  });
});
