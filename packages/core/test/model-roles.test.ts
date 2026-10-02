import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPlatform, createRuntime, FakeProvider, loadConfig } from "../src/index.js";

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nct-roles-"));
  home = path.join(root, "home");
  workspace = path.join(root, "ws");
  await Promise.all([mkdir(home), mkdir(workspace)]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const json = (name: string, value: unknown) =>
  writeFile(path.join(home, name), JSON.stringify(value));
const load = () => loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });

it("模型角色逐项分层合并，项目仅信任后参与；来源与保存值可复核", async () => {
  await json("settings.json", {
    modelRoles: { task: "fake/fake-1", vision: "fake/image" },
    theme: "dark",
  });
  await json("config.json", { modelRoles: { smol: "fake/title" } });
  await mkdir(path.join(workspace, ".nocturne"));
  await writeFile(
    path.join(workspace, ".nocturne/config.json"),
    JSON.stringify({ modelRoles: { task: "fake/child" } }),
  );
  const config = await load();
  expect((await config.forWorkspace(workspace)).resolved.modelRoles).toEqual({
    task: "fake/fake-1",
    vision: "fake/image",
    smol: "fake/title",
  });
  await config.setWorkspaceTrusted(workspace, true);
  expect((await config.forWorkspace(workspace)).resolved.modelRoles?.task).toBe("fake/child");
  expect(config.describeSettings(workspace).find((s) => s.key === "modelRoles.task")).toMatchObject(
    { source: "project", saved: "fake/fake-1", overridden: true },
  );
  await config.setModelRole("vision", null);
  expect(JSON.parse(await readFile(path.join(home, "settings.json"), "utf8"))).toEqual({
    modelRoles: { task: "fake/fake-1" },
    theme: "dark",
  });
});

it("未知服务商、未知模型和非图片 vision 降级并警告，启动成功", async () => {
  await json("config.json", {
    modelRoles: { task: "missing/model", smol: "fake/missing", vision: "fake/fake-1" },
  });
  const runtime = await createRuntime({
    cwd: workspace,
    config: await load(),
    providers: [new FakeProvider({})],
  });
  expect(runtime.describeModelRoles().map((r) => r.available)).toEqual([false, false, false]);
  const session = await runtime.createSession({ model: "fake/fake-1" });
  expect(session.warnings.filter((w) => w.includes("模型角色"))).toHaveLength(3);
  await expect(runtime.setModelRole("vision", "fake/fake-1")).rejects.toThrow("不可用");
  await session.close();
});

it("设置接口保存、清除角色，Settings 包含三行；畸形引用拒绝写入", async () => {
  const config = await load();
  const runtime = await createRuntime({
    cwd: workspace,
    config,
    providers: [new FakeProvider({})],
  });
  await runtime.setModelRole("task", "fake/fake-1");
  expect(runtime.describeModelRoles()[0]).toMatchObject({
    role: "task",
    configured: "fake/fake-1",
    model: "fake/fake-1",
    source: "settings",
    available: true,
  });
  expect(runtime.describeSettings().filter((s) => s.key.startsWith("modelRoles."))).toHaveLength(3);
  await expect(config.setModelRole("task", "broken")).rejects.toThrow();
  await runtime.setModelRole("task", null);
  expect(runtime.describeModelRoles()[0]?.configured).toBeUndefined();
});
