/** 面板终端的进程生命周期（ADR-0060 第 4 节）：开、换、退出、关闭标签、迟到消息。 */
import { describe, expect, it, vi } from "vitest";

import type { TerminalHost, TerminalMessage } from "../src/host";
import { TerminalSession, type TerminalStatus } from "../src/terminal-session";

function setup(options: { failOpen?: boolean } = {}) {
  const pushes = new Map<number, (m: TerminalMessage) => void>();
  const pending: { resolve: () => void }[] = [];
  let next = 1;
  let hold = false;
  const host: TerminalHost = {
    open: vi.fn(async (_input, onMessage) => {
      if (options.failOpen === true) throw { code: "invalid_shell", message: "不支持的 shell" };
      const id = next++;
      pushes.set(id, onMessage);
      if (hold) await new Promise<void>((resolve) => pending.push({ resolve }));
      return id;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readClipboard: vi.fn(async () => ""),
    writeClipboard: vi.fn(async () => undefined),
  };
  const output: string[] = [];
  const statuses: TerminalStatus[] = [];
  const session = new TerminalSession(host, {
    output: (data) => output.push(data),
    status: (status) => statuses.push(status),
  });
  return {
    host,
    session,
    output,
    statuses,
    push: (id: number, m: TerminalMessage) => pushes.get(id)?.(m),
    holdOpen: () => {
      hold = true;
    },
    release: () => {
      for (const p of pending.splice(0)) p.resolve();
    },
  };
}

const launch = { shell: "C:\\pwsh.exe", cwd: "Z:\\p", cols: 80, rows: 24 };

describe("TerminalSession", () => {
  it("开进程、转发输出与输入、按尺寸变化 resize", async () => {
    const t = setup();
    await t.session.start(launch);
    expect(t.statuses.at(-1)).toEqual({ kind: "running" });
    t.push(1, { kind: "output", data: "hi" });
    expect(t.output).toEqual(["hi"]);
    t.session.write("ls\r");
    expect(t.host.write).toHaveBeenCalledWith(1, "ls\r");
    t.session.resize(80, 24);
    expect(t.host.resize).not.toHaveBeenCalled();
    t.session.resize(120, 30);
    expect(t.host.resize).toHaveBeenCalledWith(1, 120, 30);
  });

  it("进程退出给出退出码；之后写入不再发往外壳", async () => {
    const t = setup();
    await t.session.start(launch);
    t.push(1, { kind: "exit", code: 3 });
    expect(t.statuses.at(-1)).toEqual({ kind: "exited", code: 3 });
    t.session.write("x");
    expect(t.host.write).not.toHaveBeenCalled();
    t.push(1, { kind: "exit", code: null });
  });

  it("重新开（换 shell / 重新启动）先结束旧进程，旧进程迟到的消息丢弃", async () => {
    const t = setup();
    await t.session.start(launch);
    await t.session.start({ ...launch, shell: "C:\\bash.exe" });
    expect(t.host.close).toHaveBeenCalledWith(1);
    expect(t.session.processId).toBe(2);
    t.push(1, { kind: "output", data: "stale" });
    t.push(1, { kind: "exit", code: 0 });
    expect(t.output).toEqual([]);
    expect(t.statuses.at(-1)).toEqual({ kind: "running" });
  });

  it("dispose 结束进程；开的过程中 dispose（StrictMode 卸载）也会把新进程关掉", async () => {
    const t = setup();
    await t.session.start(launch);
    t.session.dispose();
    expect(t.host.close).toHaveBeenCalledWith(1);

    const u = setup();
    u.holdOpen();
    const starting = u.session.start(launch);
    await Promise.resolve();
    u.session.dispose();
    u.release();
    await starting;
    expect(u.host.close).toHaveBeenCalledWith(1);
    expect(u.statuses.some((s) => s.kind === "running")).toBe(false);
  });

  it("开进程期间的输入（xterm 对 ESC[6n 的回答）排队，拿到 id 后按顺序发出", async () => {
    const t = setup();
    t.holdOpen();
    const starting = t.session.start(launch);
    await Promise.resolve();
    t.push(1, { kind: "output", data: "\x1b[6n" });
    t.session.write("\x1b[1;1R");
    t.session.write("a");
    expect(t.host.write).not.toHaveBeenCalled();
    t.release();
    await starting;
    expect(vi.mocked(t.host.write).mock.calls).toEqual([
      [1, "\x1b[1;1R"],
      [1, "a"],
    ]);
  });

  it("外壳拒绝（不支持的 shell 等）显示错误文案", async () => {
    const t = setup({ failOpen: true });
    await t.session.start(launch);
    expect(t.statuses.at(-1)).toEqual({ kind: "error", message: "不支持的 shell" });
  });
});
