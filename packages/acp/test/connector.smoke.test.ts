import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlatform, type ToolContext } from "@nocturne/core";
import { createAcpConnector } from "../src/index.js";

// 只在专用命令 + 显式开关下调用真实 agent；默认测试绝不加载本文件。
it.runIf(process.env.NOCTURNE_ACP_SMOKE === "1")("真实 ACP agent 的只读 task", async () => {
  const command = process.env.NOCTURNE_ACP_SMOKE_COMMAND;
  if (!command) throw new Error("NOCTURNE_ACP_SMOKE_COMMAND is required");
  const args: unknown = JSON.parse(process.env.NOCTURNE_ACP_SMOKE_ARGS ?? "[]");
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    throw new Error("NOCTURNE_ACP_SMOKE_ARGS must be a JSON string array");
  }
  const platform = createPlatform();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nctrn-acp-smoke-"));
  try {
    await fs.writeFile(path.join(cwd, "input.txt"), "nocturne-acp-readonly-smoke\n");
    const connector = createAcpConnector(platform);
    const config = {
      name: "smoke",
      command,
      args,
      enabled: true,
      ...(process.env.NOCTURNE_ACP_SMOKE_MODE ? { mode: process.env.NOCTURNE_ACP_SMOKE_MODE } : {}),
    };
    const ctx: ToolContext = {
      cwd,
      workspaceRoot: cwd,
      paths: platform.paths,
      sessionId: "smoke",
      turnId: "smoke",
      callId: "smoke",
      signal: new AbortController().signal,
      subjects: [],
      permissions: { check: () => "deny" },
      fs: platform.fs,
      process: platform.process,
      readState: {
        record() {
          /* 外部操作没有内置已读状态。 */
        },
        get: () => undefined,
      },
      progress() {
        /* 冒烟只断言最终结果，不渲染终端。 */
      },
    };
    const result = await connector.run(
      config,
      {
        agent: "smoke",
        cwd,
        timeoutMs: 90_000,
        transcriptPath: path.join(cwd, "external", "smoke.jsonl"),
        task: "Read input.txt and report its exact single line. This is strictly read-only: do not edit, create or delete any file, run any command, fetch any URL, or delegate. Return only the line.",
        async requestPermission(subjects) {
          return {
            decision: subjects.every((subject) => subject.kind === "read") ? "allow" : "deny",
            source: "smoke_readonly",
          };
        },
      },
      ctx,
    );
    // 冒烟需要人工判断对方是否主动请求权限：打印结果摘要（不含凭据）
    console.info("smoke output:", JSON.stringify(result.output));
    console.info(
      "transcript lines:",
      (await fs.readFile(path.join(cwd, "external", "smoke.jsonl"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean).length,
    );
    expect(result.status).toBe("ok");
    expect(result.modelContent).toContain("nocturne-acp-readonly-smoke");
    expect(await fs.readFile(path.join(cwd, "input.txt"), "utf8")).toBe(
      "nocturne-acp-readonly-smoke\n",
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
