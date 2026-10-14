import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "tsdown";
import { RelayServer } from "../src/server.js";
import { startAdmin } from "../src/admin.js";

function command(entry: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      output += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });
}
it("真实命令行经管理通道输出邀请与电脑列表；服务未运行退出码 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-cli-"));
  const relay = new RelayServer(
    { dataDir: dir, listen: "127.0.0.1:0", publicOrigin: "https://relay.example" },
    () => {
      /* 不污染 CLI 输出。 */
    },
  );
  try {
    await build({
      config: false,
      entry: { main: fileURLToPath(new URL("../src/main.ts", import.meta.url)) },
      outDir: join(dir, "dist"),
      format: "esm",
      platform: "node",
      target: "node24",
      dts: false,
      alias: {
        "@nocturne/remote": fileURLToPath(
          new URL("../../../packages/remote/src/index.ts", import.meta.url),
        ),
      },
      noExternal: ["@nocturne/remote", "ws"],
      outExtensions: () => ({ js: ".mjs" }),
    });
    const entry = join(dir, "dist", "main.mjs");
    await relay.start();
    const admin = await startAdmin(relay);
    try {
      const invite = await command(entry, ["invite", "create", "--data-dir", dir]);
      expect(invite.code, invite.output).toBe(0);
      expect(invite.output).toMatch(/nocturne-invite:relay.example\/[A-Za-z0-9_-]{24}/);
      expect(await command(entry, ["host", "list", "--data-dir", dir])).toMatchObject({
        code: 0,
        output: "暂无电脑\n",
      });
    } finally {
      await new Promise<void>((done) => admin.close(() => done()));
    }
    const absent = await command(entry, ["host", "list", "--data-dir", dir]);
    expect(absent.code).toBe(1);
    expect(absent.output).toContain("中继未运行");
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
