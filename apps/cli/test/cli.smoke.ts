/**
 * CLI 验收冒烟：在临时 fixture 中用真实模型跑 `nctrn --yes -p`，
 * 覆盖文件修复及假 MCP 服务器工具往返。
 * 需要环境变量（openai-compatible）：
 *   NOCTURNE_SMOKE_BASE_URL / NOCTURNE_SMOKE_API_KEY / NOCTURNE_SMOKE_MODEL
 * 未设置时跳过。运行前需 pnpm build（根 test:smoke 已保证）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BASE_URL = process.env.NOCTURNE_SMOKE_BASE_URL;
const API_KEY = process.env.NOCTURNE_SMOKE_API_KEY;
const MODEL = process.env.NOCTURNE_SMOKE_MODEL;
const configured = BASE_URL !== undefined && API_KEY !== undefined && MODEL !== undefined;

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../dist/main.js");

const tmpRoots: string[] = [];
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-cli-fixture-"));
  tmpRoots.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture", type: "module", scripts: { test: "node test.mjs" } },
      null,
      2,
    ),
  );
  // bug：加法被写成减法
  writeFileSync(path.join(dir, "math.mjs"), `export function add(a, b) {\n  return a - b;\n}\n`);
  writeFileSync(
    path.join(dir, "test.mjs"),
    `import assert from "node:assert/strict";\nimport { add } from "./math.mjs";\nassert.equal(add(2, 3), 5);\nconsole.log("PASS");\n`,
  );
  return dir;
}

describe.skipIf(!configured)("nctrn 非交互冒烟（真实服务）", () => {
  it("定位并修复 fixture 仓库里的 bug，测试由失败转为通过", () => {
    expect(existsSync(CLI)).toBe(true);
    const cwd = makeFixture();

    // 前置断言：测试当前确实失败
    const before = spawnSync("node", ["test.mjs"], { cwd, encoding: "utf8" });
    expect(before.status).not.toBe(0);

    const run = spawnSync(
      process.execPath,
      [
        CLI,
        "--yes",
        "-p",
        "这个仓库的测试当前失败。请阅读代码定位 bug，修改源文件修复它，然后运行 npm test 确认通过。最后简要报告原因。",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 480_000,
        env: {
          ...process.env,
          NOCTURNE_API_TYPE: "openai-compatible",
          NOCTURNE_BASE_URL: BASE_URL ?? "",
          NOCTURNE_API_KEY: API_KEY ?? "",
          NOCTURNE_MODEL: MODEL ?? "",
          NOCTURNE_HOME: mkdtempSync(path.join(tmpdir(), "nct-smoke-home-")),
        },
      },
    );

    // stderr 留诊断渠道；stdout 应是纯模型文本
    if (run.status !== 0) {
      console.error("nctrn stderr:\n", run.stderr);
    }
    expect(run.status).toBe(0);

    const after = spawnSync("node", ["test.mjs"], { cwd, encoding: "utf8" });
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("PASS");
  });

  it("MCP 工具往返：真实模型调用假服务器的 echo", () => {
    expect(existsSync(CLI)).toBe(true);
    const cwd = makeFixture();
    const home = mkdtempSync(path.join(tmpdir(), "nct-smoke-home-"));
    tmpRoots.push(home);
    const fakeServer = path.resolve(here, "../../../packages/mcp/test/fake-server.mjs");
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        mcp: { servers: { fake: { command: process.execPath, args: [fakeServer] } } },
      }),
    );
    const token = `NCT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const run = spawnSync(
      process.execPath,
      [CLI, "--yes", "-p", `调用 mcp__fake__echo 工具，参数 text 为 ${token}，然后原样回复结果。`],
      {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          NOCTURNE_API_TYPE: "openai-compatible",
          NOCTURNE_BASE_URL: BASE_URL ?? "",
          NOCTURNE_API_KEY: API_KEY ?? "",
          NOCTURNE_MODEL: MODEL ?? "",
          NOCTURNE_HOME: home,
        },
      },
    );
    if (run.status !== 0) console.error("nctrn stderr:\n", run.stderr);
    expect(run.status).toBe(0);
    const log = readdirSync(path.join(home, "sessions"))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(path.join(home, "sessions", name), "utf8"))
      .join("\n");
    expect(log).toContain('"name":"mcp__fake__echo"');
    expect(log).toContain('"status":"ok"');
    expect(run.stdout).toContain(token);
  });
});
