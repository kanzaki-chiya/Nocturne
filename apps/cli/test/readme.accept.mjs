#!/usr/bin/env node
/** Exercise the README's source-built CLI and JSON examples against a local SSE service. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "apps/cli/dist/main.js");
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const jsonBlocks = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
  JSON.parse(match[1]),
);
assert.equal(jsonBlocks.length, 3);
const temp = mkdtempSync(path.join(tmpdir(), "nct-readme-"));
const home = path.join(temp, "home");
const workspace = path.join(temp, "workspace");
mkdirSync(home);
mkdirSync(workspace);
mkdirSync(path.join(workspace, ".nocturne"));
const fakeMcp = path.join(root, "packages/mcp/test/fake-server.mjs");
const hookFile = path.join(temp, "hook.mjs");
const hookMarker = path.join(temp, "hook.marker");
writeFileSync(
  hookFile,
  'import { appendFileSync } from "node:fs"; appendFileSync(process.env.HOOK_MARKER, "x"); process.stdout.write("{}");',
);

function run(args, extraEnv = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: workspace,
      env: {
        ...process.env,
        NOCTURNE_HOME: home,
        NOCTURNE_API_KEY: "placeholder",
        HOOK_MARKER: hookMarker,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish) => ({
      id: "readme",
      object: "chat.completion.chunk",
      created: 1,
      model: "example-model",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
    response.write(
      `data: ${JSON.stringify(chunk({ role: "assistant", content: "README OK" }))}\n\n`,
    );
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const envConfig = {
    NOCTURNE_BASE_URL: baseURL,
    NOCTURNE_MODEL: "example-model",
  };
  let result = await run(["--version"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.1.0");
  result = await run(["--sessions"], envConfig);
  assert.equal(result.code, 0, result.stderr);

  const config = jsonBlocks[0];
  config.providers[0].baseURL = baseURL;
  config.mcp.servers.example.args[0] = fakeMcp;
  config.hooks.TurnEnd[0].args[0] = hookFile;
  writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  writeFileSync(path.join(workspace, ".nocturne/config.json"), JSON.stringify(jsonBlocks[2]));
  for (const args of [["trust"], ["--sessions"], ["-p", "概述这个仓库"], ["-c", "-p", "继续"]]) {
    result = await run(args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  const sessionId = readdirSync(path.join(home, "sessions"))
    .find((name) => name.endsWith(".jsonl"))
    ?.replace(/\.jsonl$/, "");
  assert(sessionId);
  const created = JSON.parse(
    readFileSync(path.join(home, "sessions", `${sessionId}.jsonl`), "utf8").split("\n")[0],
  );
  assert.equal(created.payload.nocturneVersion, "0.1.0");
  result = await run(["--resume", sessionId, "-p", "恢复"]);
  assert.equal(result.code, 0, result.stderr);
  result = await run(["-c"], {}, "/exit\n");
  assert.equal(result.code, 0, result.stderr);
  result = await run(["--resume", sessionId], {}, "/exit\n");
  assert.equal(result.code, 0, result.stderr);
  result = await run(["--debug", "-p", "调试"]);
  assert.equal(result.code, 0, result.stderr);
  assert(readdirSync(path.join(home, "logs")).some((name) => name.endsWith(".jsonl")));
  assert.equal(readFileSync(hookMarker, "utf8").length, 4);
  result = await run(
    [],
    {},
    "/help\n/model\n/preset\n/context\n/compact\n/mcp\n/resume\n\n/exit\n",
  );
  assert.equal(result.code, 0, result.stderr);
  for (const cmd of ["/help", "/model", "/preset", "/context", "/compact", "/mcp", "/resume"])
    assert(result.stdout.includes(cmd));
  result = await run(["untrust"]);
  assert.equal(result.code, 0, result.stderr);

  writeFileSync(path.join(home, "config.json"), JSON.stringify(jsonBlocks[1]));
  result = await run(["--sessions"], { ANTHROPIC_API_KEY: "placeholder" });
  assert.equal(result.code, 0, result.stderr);
  console.log(
    "PASS: README JSON examples, source CLI, sessions, trust, hooks, MCP, debug and REPL commands",
  );
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
