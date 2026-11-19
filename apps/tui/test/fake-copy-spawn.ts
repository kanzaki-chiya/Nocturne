import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn as nodeSpawn } from "node:child_process";

/** 测试用假 copySpawn：吞掉剪贴板子进程 stdin 并立即以退出码 0 结束。 */
export function fakeCopySpawn(): {
  spawn: typeof nodeSpawn;
  copied: string[];
} {
  const copied: string[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += String(chunk);
    });
    child.stdin.on("finish", () => {
      copied.push(input);
      child.emit("exit", 0);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, copied };
}
