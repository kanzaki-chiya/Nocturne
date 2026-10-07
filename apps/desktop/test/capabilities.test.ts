/**
 * 前端用到的 Tauri 命令与插件 API 都必须在 capability 里授权：漏授权时
 * 只在真实窗口里报 "not allowed by ACL"，假宿主测试看不出来（U-09 的
 * openPath / revealItemInDir 就是这样漏掉的）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const capability = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "capabilities", "main.json"), "utf8"),
) as { permissions: (string | { identifier: string })[] };
const granted = new Set(
  capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier)),
);
const buildRs = readFileSync(path.join(root, "src-tauri", "build.rs"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [readFileSync(full, "utf8")] : [];
  });
}
const code = sources(path.join(root, "src")).join("\n");

/** 插件/核心 API 的导出名 → 调用它需要的权限（名字与命令不总是一一对应） */
const API_PERMISSIONS: Record<string, string[]> = {
  "@tauri-apps/api/app:getVersion": ["core:app:allow-version"],
  "@tauri-apps/api/core:Channel": [],
  "@tauri-apps/api/core:invoke": [],
  "@tauri-apps/api/path:homeDir": ["core:path:allow-resolve-directory"],
  "@tauri-apps/plugin-dialog:open": ["dialog:allow-open"],
  "@tauri-apps/plugin-opener:openUrl": ["opener:allow-open-url"],
  "@tauri-apps/plugin-opener:openPath": ["opener:allow-open-path"],
  "@tauri-apps/plugin-opener:revealItemInDir": ["opener:allow-reveal-item-in-dir"],
  "@tauri-apps/plugin-process:relaunch": ["process:allow-restart"],
  "@tauri-apps/plugin-updater:check": ["updater:allow-check", "updater:allow-download-and-install"],
};

describe("capability 授权覆盖前端调用", () => {
  it("每个 invoke 的应用命令都在 build.rs 声明并授权", () => {
    const commands = new Set(
      [...code.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string),
    );
    expect(commands.size).toBeGreaterThan(0);
    for (const command of commands) {
      expect(buildRs, command).toContain(`"${command}"`);
      expect(granted.has(`allow-${command.replaceAll("_", "-")}`), command).toBe(true);
    }
  });

  it("每个导入的 Tauri API 都有已知权限映射且已授权", () => {
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(@tauri-apps\/[^"]+)"/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const [, names, module] of imports) {
      for (const raw of (names as string).split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]
          ?.replace(/^type\s+/, "");
        if (name === undefined || name === "" || raw.trim().startsWith("type ")) continue;
        const key = `${module}:${name}`;
        const needed = API_PERMISSIONS[key];
        expect(needed, `未登记的 Tauri API：${key}`).toBeDefined();
        for (const permission of needed ?? []) {
          expect(granted.has(permission), `${key} 需要 ${permission}`).toBe(true);
        }
      }
    }
  });
});
