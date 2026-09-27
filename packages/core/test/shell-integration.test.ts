/**
 * ADR-0022 真实 shell 集成测试（runIf 守卫：对应 shell 未安装则跳过）。
 * 覆盖：调用形式、引号、`$` 变量、`&`/`;`/`|` 运算符、UTF-8 中文输出、
 * PowerShell 退出码语义（原生 $LASTEXITCODE / 非原生 0/1）。
 */
import { describe, expect, it } from "vitest";

import {
  createPlatform,
  createProcessRunner,
  detectShells,
  shellDescriptor,
  type ShellDescriptor,
} from "../src/platform/index.js";

const platform = createPlatform();
const detected = await detectShells(platform);
const byKind = (kind: string): ShellDescriptor | undefined => {
  const d = detected.find((x) => x.kind === kind && x.available);
  return d?.executable === undefined
    ? undefined
    : shellDescriptor(d.kind, d.executable, process.platform);
};
const pwsh = byKind("pwsh");
const powershell = byKind("powershell");
const bash = byKind("bash");

const runner = createProcessRunner();
const node = JSON.stringify(process.execPath);

async function run(d: ShellDescriptor, command: string, timeoutMs = 30_000) {
  const proc = runner.spawnShell(command, { shell: d, timeoutMs });
  const [out, err, exit] = await Promise.all([
    (async () => {
      let t = "";
      for await (const c of proc.stdout) t += c;
      return t;
    })(),
    (async () => {
      let t = "";
      for await (const c of proc.stderr) t += c;
      return t;
    })(),
    proc.wait(),
  ]);
  return { out, err, exit };
}

describe("真实 pwsh 集成（ADR-0022）", () => {
  it.runIf(pwsh !== undefined)(
    "调用形式：-EncodedCommand 包装执行，引号与中文 UTF-8 正常",
    async () => {
      // 引号内的 ; 不是命令边界
      const r = await run(pwsh as ShellDescriptor, "Write-Output 'a;b'");
      expect(r.exit.code).toBe(0);
      expect(r.out).toContain("a;b");
      const cn = await run(pwsh as ShellDescriptor, "Write-Output '你好，世界'");
      expect(cn.out).toContain("你好，世界");
      expect(cn.exit.code).toBe(0);
    },
  );

  it.runIf(pwsh !== undefined)("PowerShell 语法：$变量、& 调用运算符、| 管道", async () => {
    const r = await run(pwsh as ShellDescriptor, "$x='abc'; Write-Output $x.ToUpper()");
    expect(r.out).toContain("ABC");
    // & 调用运算符执行外部命令（cmd 里 & 是顺序执行——证明确实走了 pwsh）
    const call = await run(pwsh as ShellDescriptor, `& ${node} -e "process.stdout.write('via-&')"`);
    expect(call.exit.code).toBe(0);
    expect(call.out).toContain("via-&");
    const pipe = await run(pwsh as ShellDescriptor, "'x','y' | ForEach-Object { $_ }");
    expect(pipe.out).toContain("x");
    expect(pipe.out).toContain("y");
  });

  it.runIf(pwsh !== undefined)(
    "退出码：原生命令取 $LASTEXITCODE；非原生失败为 1、成功为 0",
    async () => {
      // 末句是原生命令 → $LASTEXITCODE（带引号路径须经 & 调用运算符）
      const native = await run(pwsh as ShellDescriptor, `& ${node} -e "process.exit(5)"`);
      expect(native.exit.code).toBe(5);
      // 非原生命令成功 → 0
      const ok = await run(pwsh as ShellDescriptor, "Write-Output 'done'");
      expect(ok.exit.code).toBe(0);
      // 非原生终止性错误 → 1
      const fail = await run(pwsh as ShellDescriptor, "throw 'boom'");
      expect(fail.exit.code).toBe(1);
      // 显式 exit 码原样透出
      const explicit = await run(pwsh as ShellDescriptor, "exit 7");
      expect(explicit.exit.code).toBe(7);
    },
  );

  it.runIf(pwsh !== undefined)(
    "非终止错误与混合语句：Write-Error → 1；原生命令后跟 cmdlet 不泄漏陈旧 LASTEXITCODE",
    async () => {
      // 末句是非终止错误（Write-Error）：非原生命令出错 → 1
      const we = await run(pwsh as ShellDescriptor, "Write-Error 'oops'");
      expect(we.exit.code).toBe(1);
      expect(we.err).toContain("oops");
      // 原生命令退出 5、末句是成功 cmdlet → 0（陈旧 LASTEXITCODE 不泄漏）
      const mixed = await run(
        pwsh as ShellDescriptor,
        `& ${node} -e "process.exit(5)"; Write-Output 'after'`,
      );
      expect(mixed.exit.code).toBe(0);
      expect(mixed.out).toContain("after");
      // 反向：cmdlet 成功后跟失败的原生命令 → 末句原生 → LASTEXITCODE
      const mixed2 = await run(
        pwsh as ShellDescriptor,
        `Write-Output 'before'; & ${node} -e "process.exit(4)"`,
      );
      expect(mixed2.exit.code).toBe(4);
      expect(mixed2.out).toContain("before");
    },
  );

  it.runIf(pwsh !== undefined)("Node 中文输出经 UTF-8 前奏不损坏", async () => {
    const r = await run(pwsh as ShellDescriptor, `& ${node} -e "process.stdout.write('中文测试')"`);
    expect(r.out).toContain("中文测试");
    expect(r.exit.code).toBe(0);
  });
});

describe("真实 powershell（Windows PowerShell 5.1）集成", () => {
  it.runIf(powershell !== undefined)("执行 -EncodedCommand 并区分退出码", async () => {
    const r = await run(powershell as ShellDescriptor, "Write-Output 'ps51-ok'");
    expect(r.exit.code).toBe(0);
    expect(r.out).toContain("ps51-ok");
    const native = await run(powershell as ShellDescriptor, `& ${node} -e "process.exit(6)"`);
    expect(native.exit.code).toBe(6);
  });
});

describe("真实 Git Bash 集成（ADR-0022）", () => {
  it.runIf(bash !== undefined)("bash 语法：$变量、| 管道、&& 顺序执行、引号", async () => {
    const r = await run(bash as ShellDescriptor, 'x=abc; echo "$x"');
    expect(r.out).toContain("abc");
    expect(r.exit.code).toBe(0);
    const pipe = await run(bash as ShellDescriptor, "echo hello | tr a-z A-Z");
    expect(pipe.out).toContain("HELLO");
    const seq = await run(bash as ShellDescriptor, "echo one && echo two");
    expect(seq.out).toContain("one");
    expect(seq.out).toContain("two");
    const quoted = await run(bash as ShellDescriptor, "echo 'a;b'");
    expect(quoted.out).toContain("a;b");
  });

  it.runIf(bash !== undefined)("& 后台运算符与 Node 中文输出", async () => {
    // bash 的 & 是真后台：两条输出都收齐；wait 保证合流
    const r = await run(bash as ShellDescriptor, "echo bg & echo fg; wait");
    expect(r.out).toContain("bg");
    expect(r.out).toContain("fg");
    expect(r.exit.code).toBe(0);
    const cn = await run(bash as ShellDescriptor, `${node} -e "console.log('中文输出')"`);
    expect(cn.out).toContain("中文输出");
  });
});
