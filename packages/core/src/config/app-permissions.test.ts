import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPlatform } from "../platform/index.js";
import { loadConfig } from "./load.js";
import { createRulePolicy } from "../permission/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
it("app 规则写用户层，新会话生效，保留未知字段，并可列举和移除", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nocturne-app-rules-"));
  roots.push(home);
  const file = path.join(home, "config.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      custom: { preserved: true },
      permissions: {
        preset: "default",
        rules: [{ kind: "shell", pattern: "git status", action: "allow" }],
      },
    }),
  );
  const config = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
  const store = config.appPermissions;
  if (store === undefined) throw new Error("缺少软件规则存储");
  await store.set("excel.exe", "allow");
  await store.set("*", "ask");
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
    custom: { preserved: true },
    permissions: { preset: "default" },
  });
  const fresh = await loadConfig(createPlatform(), { nocturneHome: home, env: () => undefined });
  const freshStore = fresh.appPermissions;
  if (freshStore === undefined) throw new Error("缺少软件规则存储");
  expect(freshStore.list()).toEqual([
    { kind: "app", pattern: "*", action: "ask" },
    { kind: "app", pattern: "excel.exe", action: "allow" },
  ]);
  const policy = createRulePolicy({
    workspaceRoot: home,
    caseSensitive: false,
    rules: fresh.base.rules,
  });
  expect(policy.evaluate([{ kind: "app", target: "excel.exe" }]).decision.action).toBe("allow");
  expect(policy.evaluate([{ kind: "app", target: "notepad.exe" }]).decision.action).toBe("ask");
  await freshStore.set("excel.exe", undefined);
  expect(freshStore.list()).toHaveLength(1);
});
