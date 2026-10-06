/**
 * 默认测试集不读真实主目录：HOME/USERPROFILE 指向每个测试文件独立的
 * 临时目录。不传 platform 的 createRuntime 会读 os.homedir()——技能发现
 * 会扫维护者真实的 ~/.agents/skills、~/.claude/skills，输入历史等也会
 * 写进真实 ~/.nocturne。os.homedir() 每次调用都读环境变量，重定向对
 * 所有被测代码路径生效（含测试派生的子进程）。策略同
 * packages/core/test/setup-offline.ts。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const home = mkdtempSync(path.join(tmpdir(), "nct-cli-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
