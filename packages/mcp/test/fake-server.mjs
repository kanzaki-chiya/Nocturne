#!/usr/bin/env node
/**
 * 假 MCP stdio 服务器（离线测试用）：换行分隔 JSON-RPC。
 * 内置工具：echo / fail(isError) / sleep(ms) / crash(进程退出) /
 * env_report(汇报可见环境变量) / mutate(追加工具并发 list_changed)。
 */
import readline from "node:readline";

const tools = [
  {
    name: "echo",
    description: "回显 text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "fail",
    description: "总是返回 isError",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sleep",
    description: "睡眠 ms 毫秒",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "crash",
    description: "让服务器进程退出",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "env_report",
    description: "汇报给定环境变量是否可见",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string" } } },
      required: ["keys"],
    },
  },
  {
    name: "mutate",
    description: "追加一个工具并发送 tools/list_changed",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleCall(id, params) {
  const args = params?.arguments ?? {};
  switch (params?.name) {
    case "echo":
      respond(id, { content: [{ type: "text", text: String(args.text ?? "") }] });
      return;
    case "fail":
      respond(id, {
        isError: true,
        content: [{ type: "text", text: "工具内部错误（isError）" }],
      });
      return;
    case "sleep":
      setTimeout(
        () => {
          respond(id, { content: [{ type: "text", text: "slept" }] });
        },
        Number(args.ms ?? 0),
      );
      return;
    case "crash":
      // 先回一个 ack 再退出的场景不需要——直接退出模拟崩溃
      process.exit(3);
      return;
    case "env_report": {
      const report = {};
      for (const k of args.keys ?? []) report[k] = process.env[k] !== undefined;
      respond(id, { content: [{ type: "text", text: JSON.stringify(report) }] });
      return;
    }
    case "mutate":
      tools.push({
        name: "added",
        description: "动态追加的工具",
        inputSchema: { type: "object", properties: {} },
      });
      respond(id, { content: [{ type: "text", text: "mutated" }] });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return;
    default:
      respondError(id, -32601, `未知工具 ${params?.name}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  // 通知（无 id）只记录不回包
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
      return;
    case "ping":
      respond(msg.id, {});
      return;
    case "tools/list":
      respond(msg.id, { tools });
      return;
    case "tools/call":
      handleCall(msg.id, msg.params);
      return;
    default:
      respondError(msg.id, -32601, `未知方法 ${msg.method}`);
  }
});
