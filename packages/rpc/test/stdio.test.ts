import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, expect, it } from "vitest";

import { createRuntime, FakeProvider } from "@nocturne/core";
import { createRpcServer, createStdioTransport } from "@nocturne/rpc/server";

import { cleanupTmp, MODEL, tmpDir, until } from "./harness.js";

afterEach(cleanupTmp);

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientName: "stdio-test",
    capabilities: { interactive: false },
  },
};
const encode = (message: object) => `${JSON.stringify(message)}\n`;

async function connection() {
  const sessionsDir = tmpDir("nct-stdio-sessions-");
  const runtime = await createRuntime({
    cwd: tmpDir("nct-stdio-ws-"),
    sessionsDir,
    providers: [new FakeProvider({ scripts: [[{ type: "wait", ms: 60_000 }]] })],
  });
  const input = new PassThrough();
  const replies: { id: number; result?: unknown; error?: unknown }[] = [];
  let disposed = false;
  let bufferAtDispose: number | undefined;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (chunk.length > 0) replies.push(JSON.parse(chunk.toString()));
      // 延迟写回调，serve 必须等待输出缓冲刷完。
      setImmediate(callback);
    },
  });
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: async () => ({
      runtime,
      dispose: () => {
        bufferAtDispose = output.writableLength;
        disposed = true;
      },
    }),
  });
  const served = server.serve(createStdioTransport(input, output));
  return {
    input,
    output,
    replies,
    served,
    sessionsDir,
    disposed: () => disposed,
    bufferAtDispose: () => bufferAtDispose,
  };
}

it("输入立即 EOF：握手、查询和打开会话全部返回，刷出输出后释放锁", async () => {
  const h = await connection();
  h.input.end(
    [
      init,
      { jsonrpc: "2.0", id: 2, method: "runtime.listSessions", params: {} },
      { jsonrpc: "2.0", id: 3, method: "runtime.createSession", params: { model: MODEL } },
    ]
      .map(encode)
      .join(""),
  );
  await h.served;
  expect(h.replies.map((reply) => reply.id).sort()).toEqual([1, 2, 3]);
  expect(h.replies.every((reply) => reply.error === undefined)).toBe(true);
  expect(h.replies.find((reply) => reply.id === 2)?.result).toEqual([]);
  const { sessionId } = h.replies.find((reply) => reply.id === 3)?.result as { sessionId: string };
  expect(existsSync(path.join(h.sessionsDir, `${sessionId}.lock`))).toBe(false);
  expect(h.output.writableLength).toBe(0);
  expect(h.bufferAtDispose()).toBe(0);
  expect(h.disposed()).toBe(true);
});

it.each([false, true])("submit 在 EOF 时返回 aborted（已开始：%s）", async (started) => {
  const h = await connection();
  h.input.write(encode(init));
  h.input.write(
    encode({ jsonrpc: "2.0", id: 2, method: "runtime.createSession", params: { model: MODEL } }),
  );
  await until(() => h.replies.some((reply) => reply.id === 2), "打开会话回复");
  const { sessionId } = h.replies.find((reply) => reply.id === 2)?.result as { sessionId: string };
  const submit = encode({
    jsonrpc: "2.0",
    id: 3,
    method: "session.submit",
    params: { sessionId, text: "慢请求" },
  });
  if (started) {
    h.input.write(submit);
    await until(
      () =>
        readFileSync(path.join(h.sessionsDir, `${sessionId}.jsonl`), "utf8").includes(
          '"type":"turn.started"',
        ),
      "Turn 开始",
    );
    h.input.end();
  } else {
    h.input.end(submit);
  }
  await h.served;
  expect(h.replies.find((reply) => reply.id === 3)).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: "aborted",
  });
  expect(existsSync(path.join(h.sessionsDir, `${sessionId}.lock`))).toBe(false);
  expect(h.disposed()).toBe(true);
});

it("输出 EPIPE：停止发送并正常收尾", async () => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    },
  });
  const server = createRpcServer({
    nocturneVersion: "test",
    createRuntime: async () => ({ runtime: undefined as never }),
  });
  const served = server.serve(createStdioTransport(input, output));
  input.write(encode(init));
  await served;
  expect(output.destroyed).toBe(true);
});
