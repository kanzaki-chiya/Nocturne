import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPlatform, loadConfig } from "@nocturne/core";
import { REMOTE_METHODS } from "@nocturne/rpc/server";
import { cleanupTmp, connectManyWithConfig, connectWithConfig, tmpDir } from "./harness.js";

afterEach(cleanupTmp);

it("agents.describeProjectSubagents 经 RPC 返回项目子代理与警告，并支持指定 workspaceRoot", async () => {
  const home = tmpDir("nct-rpc-proj-agents-home-");
  const ws = tmpDir("nct-rpc-proj-agents-ws-");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));
  mkdirSync(path.join(ws, ".nocturne/agents"), { recursive: true });
  mkdirSync(path.join(ws, ".claude/agents"), { recursive: true });
  const nocPath = path.join(ws, ".nocturne/agents/arch.md");
  const claudePath = path.join(ws, ".claude/agents/rev.md");
  writeFileSync(
    nocPath,
    `---
name: arch
description: 架构审查
tools:
  - read
  - grep
effort: high
---
检查架构边界。
`,
  );
  writeFileSync(
    claudePath,
    `---
name: rev
description: Code reviewer
model: sonnet
tools: Read, Bash
disallowedTools: KillShell
---
Review changes carefully.
`,
  );

  const h = await connectWithConfig({
    config: await loadConfig(createPlatform(), { nocturneHome: home }),
  });
  try {
    const desc = await h.client.runtime.describeProjectSubagents({ workspaceRoot: ws });
    const realWs = await createPlatform().fs.realpath(ws);
    expect(desc.agents).toEqual([
      {
        id: "project:arch",
        name: "arch",
        description: "架构审查",
        source: ".nocturne",
        path: path.join(realWs, ".nocturne", "agents", "arch.md"),
        effort: "high",
        tools: ["read", "grep"],
      },
      {
        id: "project:rev",
        name: "rev",
        description: "Code reviewer",
        source: ".claude",
        path: path.join(realWs, ".claude", "agents", "rev.md"),
        tools: ["read", "shell", "shell_output"],
      },
    ]);
    expect(desc.warnings).toHaveLength(1);
    expect(desc.warnings[0]).toContain("model");
  } finally {
    await h.client.shutdown();
    await h.served;
  }
});

it("agents.describeProjectSubagents 保持仅本机开放，远程客户端调用报 remote_not_allowed", async () => {
  expect(REMOTE_METHODS as readonly string[]).not.toContain("agents.describeProjectSubagents");
  const home = tmpDir("nct-rpc-proj-remote-home-");
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ modelsDev: false }));
  const h = await connectManyWithConfig({
    config: await loadConfig(createPlatform(), { nocturneHome: home }),
  });
  const remote = await h.add();
  try {
    await expect(remote.client.runtime.describeProjectSubagents()).rejects.toMatchObject({
      code: "remote_not_allowed",
      rpcCode: -32004,
    });
  } finally {
    await h.client.shutdown();
    await Promise.all([h.served, remote.served]);
  }
});
