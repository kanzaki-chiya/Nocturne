/**
 * 默认测试集完全离线（workflow.md 第 5 节）：全局 fetch 只放行本机地址，
 * 其余一律抛错。需要网络行为的用例应注入自己的 fetch（如 modelsDevFetch）
 * 或用 vi.stubGlobal 桩掉 fetch；忘记注入时在这里暴露，而不是悄悄联网。
 *
 * 另把 HOME/USERPROFILE 指向每个测试进程独立的临时目录：不传 platform 的
 * createRuntime 会读 os.homedir()，技能发现等会扫维护者真实的
 * ~/.agents/skills、~/.claude/skills，测试也会写进真实 ~/.nocturne。
 * os.homedir() 每次调用都读环境变量，重定向对所有被测代码路径生效。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

// 留给守护测试断言重定向生效（见 skills.test.ts 的隔离守护用例）
process.env.NOCTURNE_TEST_REAL_HOME ??= homedir();
const testHome = mkdtempSync(path.join(tmpdir(), "nct-test-home-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error(`默认测试集禁止联网：${url.href}`));
  }
  return realFetch(input, init);
};
