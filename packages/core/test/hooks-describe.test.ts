import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore, createPlatform, loadConfig } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function setupFixture(opts: {
  userHooks?: Record<string, unknown>;
  projectHooks?: Record<string, unknown>;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "nct-hooks-describe-"));
  roots.push(root);
  const home = path.join(root, "home");
  const ws = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(ws, ".nocturne"), { recursive: true });

  const userConfigPath = path.join(home, "config.json");
  await writeFile(
    userConfigPath,
    JSON.stringify({
      modelsDev: false,
      ...(opts.userHooks !== undefined ? { hooks: opts.userHooks } : {}),
    }),
  );

  const projectConfigPath = path.join(ws, ".nocturne", "config.json");
  if (opts.projectHooks !== undefined) {
    await writeFile(projectConfigPath, JSON.stringify({ hooks: opts.projectHooks }));
  }

  const platform = createPlatform();
  const credentials = (await createCredentialStore(platform, home, { backend: "memory" })).store;
  const config = await loadConfig(platform, {
    nocturneHome: home,
    credentials,
    env: () => undefined,
  });
  return { root, home, ws, userConfigPath, projectConfigPath, config, platform };
}

describe("describeHooks 只读配置概览", () => {
  it("合并用户层与已信任项目层，按事件点与配置顺序输出并应用超时与 matcher 规则", async () => {
    const { ws, userConfigPath, projectConfigPath, config, platform } = await setupFixture({
      userHooks: {
        TurnEnd: [{ command: "node", args: ["./audit.mjs"], matcher: "ignored-non-tool" }],
        PreToolUse: [
          {
            matcher: "shell|edit",
            command: "node",
            args: ["./guard.mjs", "--strict"],
            timeoutMs: 12000,
          },
          { command: "python3", args: ["check.py"], timeoutMs: 999999 },
        ],
      },
      projectHooks: {
        PreToolUse: [{ matcher: "write", command: "./hooks/project-guard.cmd" }],
        SessionStart: [{ command: "node", args: ["./hooks/session-init.mjs"] }],
      },
    });
    await config.setWorkspaceTrusted(ws, true);

    const realProjectConfig = path.join(await platform.resolveReal(ws), ".nocturne", "config.json");
    const desc = await config.describeHooks({ workspaceRoot: ws });

    expect(desc.hooks).toEqual([
      {
        point: "PreToolUse",
        matcher: "shell|edit",
        command: "node",
        args: ["./guard.mjs", "--strict"],
        timeoutMs: 12000,
        origin: "user",
        path: userConfigPath,
        trusted: true,
      },
      {
        point: "PreToolUse",
        command: "python3",
        args: ["check.py"],
        timeoutMs: 60000,
        origin: "user",
        path: userConfigPath,
        trusted: true,
      },
      {
        point: "PreToolUse",
        matcher: "write",
        command: "./hooks/project-guard.cmd",
        args: [],
        timeoutMs: 5000,
        origin: "project",
        path: realProjectConfig,
        trusted: true,
      },
      {
        point: "TurnEnd",
        command: "node",
        args: ["./audit.mjs"],
        timeoutMs: 5000,
        origin: "user",
        path: userConfigPath,
        trusted: true,
      },
      {
        point: "SessionStart",
        command: "node",
        args: ["./hooks/session-init.mjs"],
        timeoutMs: 5000,
        origin: "project",
        path: realProjectConfig,
        trusted: true,
      },
    ]);
    expect(projectConfigPath.toLowerCase()).toContain(".nocturne");
  });

  it("未信任项目的 Hook 带 trusted: false，不传 workspaceRoot 时只列用户层", async () => {
    const { ws, userConfigPath, config, platform } = await setupFixture({
      userHooks: {
        SessionStart: [{ command: "node", args: ["./user-start.mjs"] }],
      },
      projectHooks: {
        PreToolUse: [{ matcher: "shell", command: "node", args: ["./proj-guard.mjs"] }],
        SessionStart: [{ command: "node", args: ["./proj-start.mjs"] }],
      },
    });

    const userOnly = await config.describeHooks();
    expect(userOnly.hooks).toHaveLength(1);
    expect(userOnly.hooks[0]).toMatchObject({
      point: "SessionStart",
      origin: "user",
      path: userConfigPath,
      trusted: true,
    });

    const realProjectConfig = path.join(await platform.resolveReal(ws), ".nocturne", "config.json");
    const withProject = await config.describeHooks({ workspaceRoot: ws });
    expect(withProject.hooks).toEqual([
      {
        point: "PreToolUse",
        matcher: "shell",
        command: "node",
        args: ["./proj-guard.mjs"],
        timeoutMs: 5000,
        origin: "project",
        path: realProjectConfig,
        trusted: false,
      },
      {
        point: "SessionStart",
        command: "node",
        args: ["./user-start.mjs"],
        timeoutMs: 5000,
        origin: "user",
        path: userConfigPath,
        trusted: true,
      },
      {
        point: "SessionStart",
        command: "node",
        args: ["./proj-start.mjs"],
        timeoutMs: 5000,
        origin: "project",
        path: realProjectConfig,
        trusted: false,
      },
    ]);
  });
});
