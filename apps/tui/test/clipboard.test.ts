/**
 * 复制双通道：OSC 52 序列格式；系统剪贴板命令按平台选择、
 * 文本经 stdin 传入；mock spawn 断言命令行与失败回退。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { copyText, osc52Sequence } from "../src/clipboard.js";

function fakeSpawn(handlers: Record<string, number | "error">) {
  const calls: { cmd: string; args: readonly string[]; input: string }[] = [];
  const spawn = ((cmd: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
    };
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (d) => {
      input += String(d);
    });
    const outcome = handlers[cmd] ?? 0;
    child.stdin.on("finish", () => {
      calls.push({ cmd, args, input });
      if (outcome === "error") child.emit("error", new Error("ENOENT"));
      else child.emit("exit", outcome);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

describe("OSC 52", () => {
  it("格式：ESC ] 52 ; c ; base64 BEL", () => {
    expect(osc52Sequence("hi")).toBe(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`);
    expect(osc52Sequence("中文")).toBe(
      `\x1b]52;c;${Buffer.from("中文", "utf8").toString("base64")}\x07`,
    );
  });
});

describe("系统剪贴板命令", () => {
  it("Windows：powershell 读 stdin 设 Set-Clipboard，文本走 stdin", async () => {
    const { spawn, calls } = fakeSpawn({ powershell: 0 });
    const ok = await copyText("复制我", { platform: "win32", spawn });
    expect(ok).toContain("system");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("powershell");
    expect(calls[0]?.args.join(" ")).toContain("Set-Clipboard");
    expect(calls[0]?.input).toBe("复制我");
  });

  it("macOS：pbcopy；Linux：wl-copy 失败回退 xclip", async () => {
    const mac = fakeSpawn({ pbcopy: 0 });
    expect(await copyText("x", { platform: "darwin", spawn: mac.spawn })).toContain("system");
    expect(mac.calls[0]?.cmd).toBe("pbcopy");

    const linux = fakeSpawn({ "wl-copy": "error", xclip: 0 });
    expect(await copyText("x", { platform: "linux", spawn: linux.spawn })).toContain("system");
    expect(linux.calls.map((c) => c.cmd)).toEqual(["wl-copy", "xclip"]);
    expect(linux.calls[1]?.args).toEqual(["-selection", "clipboard"]);
  });

  it("两路并行：系统失败时 OSC 52 成功仍算成功；都失败返回空", async () => {
    const fail = fakeSpawn({ powershell: 1 });
    const osc = vi.fn(() => true);
    const ok = await copyText("t", { platform: "win32", spawn: fail.spawn, osc52: osc });
    expect(ok).toEqual(["osc52"]);
    expect(osc).toHaveBeenCalledWith(osc52Sequence("t"));

    const none = await copyText("t", {
      platform: "linux",
      spawn: fakeSpawn({ "wl-copy": 1, xclip: 1 }).spawn,
      osc52: () => false,
    });
    expect(none).toEqual([]);
  });
});
