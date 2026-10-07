#!/usr/bin/env node
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "normal";
const calls = [];
let mode;
let cwd;
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "small",
    options: [
      {
        group: "fixture",
        name: "Fixture",
        options: [
          { value: "small", name: "Small" },
          { value: "large", name: "Large" },
        ],
      },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];
const writeProbe = () => {
  if (process.env.NOCTURNE_TEST_PROBE_FILE)
    writeFileSync(
      process.env.NOCTURNE_TEST_PROBE_FILE,
      JSON.stringify({ calls, cwd, configOptions }),
    );
};
let capabilities;
let pending;
let child;
if (scenario.includes("Tree")) {
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "inherit",
    windowsHide: true,
  });
}
if (process.env.NOCTURNE_TEST_PID_FILE) {
  writeFileSync(
    process.env.NOCTURNE_TEST_PID_FILE,
    JSON.stringify({ pid: process.pid, child: child?.pid }),
  );
}
const connection = new AgentSideConnection(
  (client) => ({
    initialize(params) {
      calls.push("initialize");
      capabilities = params.clientCapabilities;
      writeProbe();
      if (scenario === "hangInitialize")
        return new Promise(() => {
          /* 模拟永不响应的握手。 */
        });
      if (scenario === "authInitialize") throw RequestError.authRequired();
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "fixture", version: "1.2.3" },
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "login", name: "CLI login" }],
      };
    },
    newSession(params) {
      calls.push("new");
      cwd = params.cwd;
      writeProbe();
      if (scenario === "hangNewTree")
        return new Promise(() => {
          /* 模拟永不响应的会话创建。 */
        });
      if (scenario === "authNew") throw RequestError.authRequired();
      if (params.mcpServers.length) throw new Error("Unexpected MCP servers");
      return {
        sessionId: "fixture-session",
        configOptions,
        modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }] },
      };
    },
    setSessionMode(params) {
      calls.push("mode");
      mode = params.modeId;
      if (scenario === "badMode") throw RequestError.invalidParams("Unknown mode");
      return {};
    },
    setSessionConfigOption(params) {
      calls.push(`config:${params.configId}`);
      const option = configOptions.find((entry) => entry.id === params.configId);
      writeProbe();
      if (
        !option ||
        scenario === "badConfig" ||
        params.configId === process.env.NOCTURNE_TEST_REJECT_CONFIG_ID
      )
        throw RequestError.invalidParams("Rejected config option");
      option.currentValue = params.value;
      return { configOptions };
    },
    async prompt(params) {
      calls.push("prompt");
      writeProbe();
      if (scenario === "probeOnly") throw new Error("Probe must never prompt");
      if (scenario === "authPrompt") throw RequestError.authRequired();
      if (scenario.startsWith("crash")) process.exit(3);
      if (scenario.startsWith("hang") || scenario.startsWith("ignoreCancel")) {
        pending = Promise.withResolvers();
        if (process.env.NOCTURNE_TEST_READY_FILE)
          writeFileSync(process.env.NOCTURNE_TEST_READY_FILE, "prompt");
        return pending.promise;
      }
      if (scenario === "release") {
        if (process.env.NOCTURNE_TEST_READY_FILE)
          writeFileSync(process.env.NOCTURNE_TEST_READY_FILE, "prompt");
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (existsSync(process.env.NOCTURNE_TEST_RELEASE_FILE)) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
        });
      }
      const task = params.prompt[0].text;
      let spec;
      try {
        spec = JSON.parse(task);
      } catch {
        spec = {};
      }
      const permissions = [];
      const clientMethods = [];
      if (spec.probeClient) {
        for (const [method, fields] of [
          ["fs/read_text_file", { path: `${cwd}/input.txt` }],
          ["fs/write_text_file", { path: `${cwd}/written.txt`, content: "must not write" }],
          ["terminal/create", { command: process.execPath, args: ["-e", "process.exit()"] }],
        ]) {
          try {
            await client.request(method, { sessionId: params.sessionId, ...fields });
            clientMethods.push({ method, allowed: true });
          } catch (error) {
            clientMethods.push({ method, allowed: false, code: error.code });
          }
        }
      }
      const requestPermission = async (toolCall, index) => {
        const response = await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `p-${index}`, ...toolCall },
          options: spec.options ?? [
            { optionId: "allow", kind: "allow_once", name: "Allow once" },
            { optionId: "deny", kind: "reject_once", name: "Reject once" },
            { optionId: "always", kind: "allow_always", name: "Allow always" },
          ],
        });
        return response.outcome;
      };
      if (spec.concurrentPermissions) {
        permissions.push(...(await Promise.all(spec.permissions.map(requestPermission))));
      } else {
        for (const [index, toolCall] of (spec.permissions ?? []).entries())
          permissions.push(await requestPermission(toolCall, index));
      }
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "private thought" },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        fixtureExtension: "raw-preserved",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t",
          title: "Read\nfile",
          kind: "read",
          status: "in_progress",
          rawInput: { fixture: true },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" },
      });
      const result = JSON.stringify({
        task,
        cwd,
        mode,
        configOptions,
        calls,
        capabilities,
        permissions,
        clientMethods,
        env: process.env.NOCTURNE_TEST_VALUE,
      });
      const mid = Math.floor(result.length / 2);
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.slice(0, mid) },
        },
      });
      await client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.slice(mid) },
        },
      });
      return { stopReason: "end_turn" };
    },
    cancel() {
      calls.push("cancel");
      if (process.env.NOCTURNE_TEST_CANCEL_FILE)
        writeFileSync(process.env.NOCTURNE_TEST_CANCEL_FILE, "cancel");
      if (!scenario.startsWith("ignoreCancel")) pending?.resolve({ stopReason: "cancelled" });
    },
    authenticate() {
      throw new Error("Client must not authenticate");
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
