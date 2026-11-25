#!/usr/bin/env node
/**
 * 宿主注入 MCP stdio 夹具（ACP 端到端测试用）：
 * - 可通过参数 `--fail` 立即以非零码退出（测部分启动失败清理）
 * - 通过环境变量 NOCTURNE_TEST_PID_FILE 记录自身 PID
 * - 通过环境变量 NOCTURNE_TEST_CALL_LOG 逐行记录工具调用（测拒绝后零执行与会话隔离）
 * - 通过环境变量 SESSION_TAG 与 ORCH_API_TOKEN 验证会话级环境注入与脱敏
 */
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--fail")) {
  process.stderr.write("intentional host mcp startup failure\n");
  process.exit(1);
}

if (process.env.NOCTURNE_TEST_PID_FILE) {
  writeFileSync(process.env.NOCTURNE_TEST_PID_FILE, String(process.pid));
}

const tag = process.env.SESSION_TAG ?? "untagged";
const token = process.env.ORCH_API_TOKEN ?? "";
const callLog = process.env.NOCTURNE_TEST_CALL_LOG;

const tools = [
  {
    name: "dispatch",
    description: "派发任务到宿主编排器（非只读，用于验证权限审批与隔离）",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
  },
  {
    name: "slow_op",
    description: "只读长耗时操作（用于测试 session/cancel）",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number" } },
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function logCall(tool, args) {
  if (!callLog) return;
  appendFileSync(
    callLog,
    `${JSON.stringify({ tool, args, tag, hasToken: token.length > 0, tokenLen: token.length })}\n`,
  );
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-host-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (req.method === "notifications/initialized") {
    return;
  }
  if (req.method === "tools/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { tools } });
    return;
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    logCall(name, args);
    if (name === "dispatch") {
      // 故意把 token 放进工具返回体，验证 Nocturne MCP 脱敏层不让它进入上下文和日志
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [
            {
              type: "text",
              text: `dispatched tag=${tag} task=${String(args.task ?? "")} secret=${token}`,
            },
          ],
        },
      });
      return;
    }
    if (name === "slow_op") {
      const ms = typeof args.ms === "number" ? args.ms : 10_000;
      const timer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: req.id,
          result: { content: [{ type: "text", text: `slow_done tag=${tag}` }] },
        });
      }, ms);
      timer.unref();
      return;
    }
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { isError: true, content: [{ type: "text", text: `unknown tool: ${String(name)}` }] },
    });
  }
});
