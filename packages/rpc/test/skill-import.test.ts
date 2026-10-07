/**
 * skills.importSkills 经 RPC 往返（U-08）：预检返回候选与冲突、
 * 执行按逐项决定写入、commit 触发 providersChanged 通知、参数校验。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupTmp, connectWithConfig, tmpDir } from "./harness.js";

afterEach(cleanupTmp);

function seedSource(root: string): { bundle: string; single: string } {
  const bundle = path.join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(bundle, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: ${name}\n---\nbody ${name}`);
  }
  const single = path.join(root, "solo");
  mkdirSync(single, { recursive: true });
  writeFileSync(path.join(single, "SKILL.md"), "---\ndescription: solo\n---\nsolo body");
  return { bundle, single };
}

it("importSkills 预检与执行经 RPC 往返，commit 发通知", async () => {
  const root = tmpDir("nct-rpc-import-");
  const { bundle, single } = seedSource(root);
  const h = await connectWithConfig();
  try {
    // 多技能目录预检
    const preview = await h.client.runtime.importSkills({
      mode: "preview",
      sourceDir: bundle,
      target: "user",
    });
    expect(preview.mode).toBe("preview");
    if (preview.mode !== "preview") throw new Error("unreachable");
    expect(preview.candidates.map((c) => c.name).sort()).toEqual(["alpha", "beta"]);
    expect(preview.targetDir).toBe(path.join(h.config.nocturneHome, "skills"));

    // 单技能目录预检
    const solo = await h.client.runtime.importSkills({
      mode: "preview",
      sourceDir: single,
      target: "user",
    });
    if (solo.mode !== "preview") throw new Error("unreachable");
    expect(solo.candidates).toHaveLength(1);

    // 执行：overwrite + skip
    let changed = 0;
    const off = h.client.onProvidersChanged(() => {
      changed += 1;
    });
    const done = await h.client.runtime.importSkills({
      mode: "commit",
      target: "user",
      decisions: [
        { sourcePath: path.join(bundle, "alpha"), action: "overwrite" },
        { sourcePath: path.join(bundle, "beta"), action: "skip" },
      ],
    });
    expect(done.mode).toBe("commit");
    if (done.mode !== "commit") throw new Error("unreachable");
    expect(done.results.map((r) => r.status)).toEqual(["imported", "skipped"]);
    expect(changed).toBe(1);
    expect(done.affectedSessions).toBe(0);
    off();

    // 落盘可用：describeSkills 能看到
    const description = await h.client.runtime.describeSkills();
    expect(description.skills.some((s) => s.name === "alpha")).toBe(true);
    expect(
      readFileSync(path.join(h.config.nocturneHome, "skills", "alpha", "SKILL.md"), "utf8"),
    ).toContain("body alpha");

    // 重名默认改名：preview 给出 suggestedName，commit 按 rename 落盘
    const conflict = await h.client.runtime.importSkills({
      mode: "preview",
      sourceDir: single,
      target: "user",
    });
    if (conflict.mode !== "preview") throw new Error("unreachable");
    expect(conflict.candidates[0]?.targetConflict).toBe(false);
    const dup = await h.client.runtime.importSkills({
      mode: "preview",
      sourceDir: bundle,
      target: "user",
    });
    if (dup.mode !== "preview") throw new Error("unreachable");
    expect(dup.candidates.find((c) => c.name === "alpha")?.targetConflict).toBe(true);
    const renamed = await h.client.runtime.importSkills({
      mode: "commit",
      target: "user",
      decisions: [{ sourcePath: path.join(bundle, "alpha"), name: "alpha-2", action: "rename" }],
    });
    if (renamed.mode !== "commit") throw new Error("unreachable");
    expect(renamed.results[0]).toMatchObject({ status: "imported", finalName: "alpha-2" });
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});

it("importSkills 参数校验：mode/target/action 非法 → -32602", async () => {
  const h = await connectWithConfig();
  try {
    await expect(
      h.client.call("skills.importSkills", {
        mode: "bogus",
        sourceDir: "x",
        target: "user",
      } as never),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("skills.importSkills", {
        mode: "preview",
        sourceDir: "x",
        target: "vault",
      } as never),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("skills.importSkills", {
        mode: "commit",
        target: "user",
        decisions: [{ sourcePath: "x", action: "merge" }],
      } as never),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      h.client.call("skills.importSkills", { mode: "commit", target: "user", decisions: [] }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});
