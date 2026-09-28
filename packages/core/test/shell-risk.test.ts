/**
 * ADR-0022 第 1/6 节：高风险表集中在 ShellDescriptor.risk，经主体透传到
 * 权限层执行匹配。本文件在 test 层组装真实描述符 + 真实 policy，
 * 验证每个种类的元数据与降级语义端到端一致。
 */
import { describe, expect, it } from "vitest";

import {
  createRulePolicy,
  isOpaquePowerShellCommand,
  isRiskyShellCommand,
} from "../src/permission/index.js";
import { SHELL_RISK_BY_DIALECT, shellDescriptor } from "../src/platform/index.js";
import type { ShellKind } from "../src/platform/index.js";
import type { PermissionRule } from "../src/protocol/index.js";

const WS = "C:\\ws\\proj";

const policyFor = (extra?: { rules?: { rule: PermissionRule; origin: "user" }[] }) =>
  createRulePolicy({
    workspaceRoot: WS,
    caseSensitive: false,
    preset: "full-access",
    ...extra,
  });
const policy = policyFor();

/** 真实描述符的元数据随主体透传（等价 tools 层 permissionSubjects 的产出） */
const act = (target: string, shell?: ShellKind) =>
  policy.evaluate([
    {
      kind: "shell",
      target,
      ...(shell !== undefined
        ? { shell, shellRisk: shellDescriptor(shell, `${shell}-exe`, "win32").risk }
        : {}),
      shellRiskByDialect: SHELL_RISK_BY_DIALECT,
    },
  ]).decision.action;

describe("full-access 高风险表按 shell 种类判定（ADR-0022 第 6 节）", () => {
  it("基础表各 shell 共用：rm -rf / sudo / git push --force / git reset --hard", () => {
    for (const shell of ["pwsh", "powershell", "bash", "cmd", "sh"] as const) {
      expect(act("rm -rf /tmp/x", shell), `rm -rf @${shell}`).toBe("ask");
      expect(act("sudo apt update", shell)).toBe("ask");
      expect(act("git push --force origin main", shell)).toBe("ask");
      expect(act("git push -f origin main", shell)).toBe("ask");
      expect(act("git push --force-with-lease origin main", shell)).toBe("ask");
      expect(act("git reset --hard HEAD~1", shell)).toBe("ask");
      // 负例逐种类：普通 push/reset 在任何 shell 下都放行
      expect(act("git push origin main", shell)).toBe("allow");
      expect(act("git reset --soft HEAD~1", shell)).toBe("allow");
    }
    // 未携带 shell 种类/元数据：POSIX 基础表仍生效
    expect(act("rm -rf /tmp/x")).toBe("ask");
    expect(act("git reset --hard")).toBe("ask");
    // 负例：同表不覆盖的普通命令
    expect(act("rm x.txt", "bash")).toBe("allow");
  });

  it("PowerShell/cmd 不区分大小写；POSIX 区分", () => {
    expect(act("RM -RF C:\\x", "pwsh")).toBe("ask");
    expect(act("RM -RF C:\\x", "cmd")).toBe("ask");
    // bash/sh 下大小写敏感的词法匹配不命中
    expect(act("RM -RF /tmp/x", "bash")).toBe("allow");
    expect(act("RM -RF /tmp/x", "sh")).toBe("allow");
    expect(act("SUDO ls", "pwsh")).toBe("ask");
  });

  it("cmd：rd/rmdir/del/erase 带 /s 与 format 为高风险；同名无标志放行", () => {
    for (const c of ["rd /s C:\\x", "rmdir /s /q C:\\x", "del /s C:\\x\\*.tmp", "erase /s a"]) {
      expect(act(c, "cmd"), c).toBe("ask");
      expect(act(c.toUpperCase(), "cmd"), `${c}（大写）`).toBe("ask");
    }
    expect(act("format c:", "cmd")).toBe("ask");
    // 负例逐词：不带 /s 的同名内建命令都放行
    expect(act("del x.txt", "cmd")).toBe("allow");
    expect(act("rd empty", "cmd")).toBe("allow");
    expect(act("rmdir empty", "cmd")).toBe("allow");
    expect(act("erase a.txt", "cmd")).toBe("allow");
    expect(act("format.exe --help", "pwsh")).toBe("allow"); // 非 cmd 不按 cmd 表
    // 同名字段在其他 shell 不按 cmd 表判（bash 的 del 不存在；以未命中为准）
    expect(act("del /s x", "bash")).toBe("allow");
  });

  it("PowerShell：Remove-Item 及别名带递归+强制才命中（允许参数前缀缩写、任意顺序）", () => {
    for (const c of [
      "Remove-Item C:\\x -Recurse -Force",
      "Remove-Item -r -f C:\\x",
      "Remove-Item C:\\x -Re -Fo",
      "Remove-Item -Force -Recurse C:\\x", // 参数顺序任意
      "rm C:\\x -Recurse -Force",
      "ri x -r -force",
      "del x -r -f",
      "erase x -Recurse -Force",
      "rd x -r -f",
      "rmdir -Force x -Recurse",
    ]) {
      expect(act(c, "pwsh"), c).toBe("ask");
      expect(act(c.toUpperCase(), "powershell"), `${c}（大写）`).toBe("ask");
    }
    // 负例：缺一个标志、或只是别名列举不构成高危组合
    expect(act("Remove-Item C:\\x -Recurse", "pwsh")).toBe("allow");
    expect(act("Remove-Item C:\\x -Force", "pwsh")).toBe("allow");
    expect(act("Remove-Item C:\\x", "pwsh")).toBe("allow");
    expect(act("del a.txt", "pwsh")).toBe("allow"); // 单文件删除不带递归/强制
    expect(act("rd empty", "pwsh")).toBe("allow");
    // bash 下不按 PowerShell 表判
    expect(act("Remove-Item x -r -f", "bash")).toBe("allow");
  });

  it("PowerShell：Format-Volume / Clear-Disk / Stop-Computer / Restart-Computer / Invoke-Expression(iex)", () => {
    for (const c of [
      "Format-Volume -DriveLetter D",
      "Clear-Disk 1 -RemoveData",
      "Stop-Computer",
      "Restart-Computer -Force",
      "Invoke-Expression 'rm -rf x'",
      "iex 'x'",
    ]) {
      expect(act(c, "pwsh"), c).toBe("ask");
      expect(act(c.toUpperCase(), "pwsh"), `${c}（大写）`).toBe("ask");
    }
    // 负例：相近 cmdlet 不命中
    expect(act("Format-List", "pwsh")).toBe("allow");
    expect(act("Get-Volume", "pwsh")).toBe("allow");
    expect(act("iex-safe.cmd arg", "cmd")).toBe("allow");
  });

  it("组合命令按执行 shell 的方言逐段求值：PowerShell 脚本块内的危险段仍 ask", () => {
    // {} 只在 powershell 方言拆开；bash 下整段不命中高危表
    const block = "1..3 | ForEach-Object { Remove-Item $_ -Recurse -Force }";
    expect(act(block, "pwsh")).toBe("ask");
    expect(act(block, "bash")).toBe("allow");
    // 普通组合中的 PowerShell 高危段
    expect(act("echo ok ; Remove-Item x -r -f", "pwsh")).toBe("ask");
  });

  it("嵌套 shell 调用的命令体按内层方言检查（pwsh -c / cmd /c / bash -c）", () => {
    for (const [c, outer] of [
      ['pwsh -c "Remove-Item -Recurse -Force x"', "pwsh"],
      ['pwsh -NoProfile -Command "Remove-Item x -r -f"', "cmd"],
      ["powershell.exe -ExecutionPolicy Bypass -Command \"iex 'x'\"", "bash"],
      ['cmd /c "rd /s /q x"', "pwsh"],
      ['cmd.exe /d /s /c "del /s C:\\x\\*.tmp"', "bash"],
      ['bash -c "rm -rf x"', "pwsh"],
      ["bash -lc 'git reset --hard'", "cmd"],
      ['sh -c "rm -rf x"', "sh"],
      ['C:\\Git\\bin\\bash.exe -c "sudo ls"', "pwsh"],
      // 多层嵌套
      ["cmd /c \"pwsh -c 'Remove-Item x -Recurse -Force'\"", "bash"],
      // 外层分隔符切断的命令体：内层方言的表仍能认出
      ['pwsh -c "echo a; Remove-Item x -r -f"', "cmd"],
    ] as const) {
      expect(act(c, outer), `${c} @${outer}`).toBe("ask");
    }
    // 负例：命令体本身无害时照常放行
    expect(act('pwsh -c "Get-ChildItem"', "cmd")).toBe("allow");
    expect(act('cmd /c "dir /b"', "pwsh")).toBe("allow");
    expect(act('bash -c "ls -la"', "pwsh")).toBe("allow");
    // 内层 cmd 的 rd /s 不因外层是 bash 就漏掉，但外层 bash 的 rd /s 仍不按 cmd 表判
    expect(act("rd /s x", "bash")).toBe("allow");
    // 没有命令参数的 shell 调用不当作嵌套
    expect(act("bash script.sh", "pwsh")).toBe("allow");
  });

  it("不透明 PowerShell -EncodedCommand（含嵌套）至少 ask；-Command 不受影响", () => {
    expect(act("pwsh -EncodedCommand aGk=", "cmd")).toBe("ask");
    expect(act("pwsh -ec aGk=", "bash")).toBe("ask");
    expect(act('cmd /c "pwsh -EncodedCommand aGk="', "cmd")).toBe("ask");
    expect(act("powershell -e aGk=", "sh")).toBe("ask");
    // 非编码参数照常放行
    expect(act("pwsh -Command Get-ChildItem", "pwsh")).toBe("allow");
    expect(act("pwsh -NoProfile -File x.ps1", "cmd")).toBe("allow");
    // 与 pwsh 无关的 -ec 不误报
    expect(act("echo -ec hi", "bash")).toBe("allow");
  });

  it("shell 种类只带 kind 不带元数据时按 POSIX 保守表判（cmd 专属词表不生效）", () => {
    expect(
      policy.evaluate([{ kind: "shell", target: "rd /s C:\\x", shell: "cmd" }]).decision.action,
    ).toBe("allow");
    expect(
      policy.evaluate([{ kind: "shell", target: "rm -rf x", shell: "cmd" }]).decision.action,
    ).toBe("ask");
  });

  it("isRiskyShellCommand / isOpaquePowerShellCommand 直测", () => {
    const pwshRisk = shellDescriptor("pwsh", "pwsh.exe", "win32").risk;
    const cmdRisk = shellDescriptor("cmd", "cmd.exe", "win32").risk;
    const bashRisk = shellDescriptor("bash", "bash", "win32").risk;
    expect(isRiskyShellCommand("rm -rf x", bashRisk)).toBe(true);
    expect(isRiskyShellCommand("git push --force-with-lease", bashRisk)).toBe(true);
    expect(isRiskyShellCommand("git push origin main", bashRisk)).toBe(false);
    // 种类词表来自元数据：同一段在 cmd 元数据下命中、POSIX 元数据下不命中
    expect(isRiskyShellCommand("rd /s C:\\x", cmdRisk)).toBe(true);
    expect(isRiskyShellCommand("rd /s C:\\x", bashRisk)).toBe(false);
    expect(isRiskyShellCommand("Remove-Item x -r -f", pwshRisk)).toBe(true);
    // 无元数据：POSIX 基础表保守兜底
    expect(isRiskyShellCommand("sudo rm -rf /")).toBe(true);
    expect(isRiskyShellCommand("rd /s C:\\x")).toBe(false);
    expect(isOpaquePowerShellCommand("pwsh -EncodedCommand XX==")).toBe(true);
    expect(isOpaquePowerShellCommand("pwsh -Command ls")).toBe(false);
    expect(isOpaquePowerShellCommand("echo powershell")).toBe(false);
  });

  it("用户显式规则照旧覆盖：user 层 allow 不被内建表降级", () => {
    const p = policyFor({
      rules: [
        {
          rule: { kind: "shell", pattern: "Remove-Item *", action: "allow" },
          origin: "user",
        },
      ],
    });
    expect(
      p.evaluate([
        {
          kind: "shell",
          target: "Remove-Item x -Recurse -Force",
          shell: "pwsh",
          shellRisk: shellDescriptor("pwsh", "pwsh.exe", "win32").risk,
        },
      ]).decision.action,
    ).toBe("allow");
  });
});
