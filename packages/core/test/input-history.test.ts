import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime, FakeProvider } from "../src/index.js";

const roots: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nct-history-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function open(workspaceRoot: string) {
  const runtime = await createRuntime({
    cwd: workspaceRoot,
    sessionsDir: temp(),
    providers: [new FakeProvider({})],
  });
  return runtime.createSession({ model: "fake/fake-model" });
}

describe("公开输入历史 API", () => {
  it("过滤工作区、连续去重、满 1000 条截断，并保留多行原文", async () => {
    const home = temp();
    vi.stubEnv("NOCTURNE_HOME", home);
    const ws1 = temp();
    const ws2 = temp();
    const first = await open(ws1);
    const second = await open(ws2);
    const old = Array.from({ length: 999 }, (_, i) => ({
      text: `旧${i}`,
      workspaceRoot: first.state().meta.workspaceRoot,
      time: "2026-01-01T00:00:00.000Z",
    }));
    writeFileSync(
      path.join(home, "history.jsonl"),
      old.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    await first.recordInputHistory("甲\n乙");
    await first.recordInputHistory("甲\n乙");
    await second.recordInputHistory("另一个工作区");
    await first.recordInputHistory("甲\n乙");

    const lines = readFileSync(path.join(home, "history.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1000);
    expect(JSON.parse(lines[0] ?? "").text).toBe("旧1");
    expect(await first.readInputHistory()).toEqual([
      ...old.slice(1).map((row) => row.text),
      "甲\n乙",
    ]);
    expect(await second.readInputHistory()).toEqual(["另一个工作区"]);
    await first.close();
    await second.close();
  });

  // 权限位只在 POSIX 生效；Windows 下跳过
  it.skipIf(process.platform === "win32")("新建 history.jsonl 的权限是 0600", async () => {
    const home = temp();
    vi.stubEnv("NOCTURNE_HOME", home);
    const session = await open(temp());
    await session.recordInputHistory("一条输入");
    expect(statSync(path.join(home, "history.jsonl")).mode & 0o777).toBe(0o600);
    await session.close();
  });

  it("写入失败只发警告，不阻断输入", async () => {
    const home = temp();
    vi.stubEnv("NOCTURNE_HOME", home);
    const session = await open(temp());
    const codes: string[] = [];
    session.subscribe((event) => {
      if (event.type === "runtime.warning") codes.push(event.payload.code);
    });
    mkdirSync(path.join(home, "history.jsonl"));
    await expect(session.recordInputHistory("继续输入")).resolves.toBeUndefined();
    expect(codes).toContain("input_history_write_failed");
    await session.close();
  });
});
