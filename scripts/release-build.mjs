#!/usr/bin/env node
/**
 * 发布构建总入口（本地与 CI 共用）：
 *
 *   node scripts/release-build.mjs [--config <覆盖配置.json>] [--notes <文本>]
 *
 * 依次执行：pnpm build → bundle 单文件 → npm pack → 中继 pack → 取随附 Node →
 * cargo test → tauri build → 生成 latest.json，产物统一收集到
 * release/<version>/（已加入 .gitignore；每次构建先清空该版本目录）。
 *
 * --config 与 tauri build 的 --config 一致（JSON 文件路径），同时用于
 * 计算产物目录名与 latest.json 里的版本号；本地演练可经它临时覆盖
 * pubkey / endpoints / version / productName，改动不会写回仓库配置。
 *
 * 签名由 tauri build 通过环境变量完成：
 *   TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
 * 没有签名私钥时构建照常进行，但 bundle 目录里没有 .sig，本脚本在
 * 生成 latest.json 时失败并说明。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractChangelog, extractNotes } from "./release-notes.mjs";
import { packNpm } from "./pack-npm.mjs";
import { packRelay } from "./pack-relay.mjs";
import { run } from "./lib/proc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "apps", "desktop", "src-tauri");
const REPO_RELEASES = "https://github.com/kanzaki-chiya/Nocturne/releases/download";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 浅层深合并：普通对象递归，数组与标量直接替换（与 tauri --config 语义一致） */
function mergeConfig(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (
    typeof base === "object" &&
    base !== null &&
    typeof override === "object" &&
    override !== null
  ) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    return merged;
  }
  return override === undefined ? base : override;
}

export function effectiveConfig(overridePath) {
  const base = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  if (overridePath === undefined) return base;
  return mergeConfig(base, JSON.parse(readFileSync(overridePath, "utf8")));
}

/**
 * 生成 latest.json 内容：`notes` 支持 `--notes` 覆盖，`changelog` 始终取 CHANGELOG 全部版本（从新到旧）。
 */
export function buildLatestManifest({
  version,
  signature,
  setupName,
  changelogText,
  notesOverride,
  pubDate = new Date().toISOString(),
}) {
  const notes = notesOverride ?? extractNotes(changelogText, version);
  const changelog = extractChangelog(changelogText);
  return {
    version,
    notes,
    changelog,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `${REPO_RELEASES}/v${version}/${setupName}`,
      },
    },
  };
}

function main() {
  const overridePath = argValue("--config");
  const notesOverride = argValue("--notes");
  const config = effectiveConfig(overridePath);
  const version = config.version;
  if (typeof version !== "string" || version === "") {
    throw new Error("tauri.conf.json 缺少 version");
  }

  // 版本号会拼进要清空的目录路径：只接受 semver，防止 ".." 之类越出 release/
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`tauri.conf.json 的 version 不是合法 semver：${version}`);
  }
  const releaseDir = join(root, "release", version);
  // 先清空本版本目录（只这一层），避免本地重复构建残留旧的 setup.exe
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  const bundleFile = join(tauriDir, "resources", "nctrn.mjs");

  console.log("== 1/7 pnpm build");
  run("pnpm", ["build"], { cwd: root });

  console.log("== 2/7 bundle 单文件");
  run("node", [join(root, "scripts", "bundle-nctrn.mjs")], { cwd: root });

  const mac = process.platform === "darwin";
  if (!mac) {
    console.log("== 3/7 npm pack");
    const tgz = packNpm({ bundleFile, out: releaseDir });
    console.log(`npm 包: ${tgz}`);

    console.log("== 4/7 中继 pack（含手机网页）");
    console.log(`中继包: ${packRelay({ out: releaseDir })}`);
  }

  console.log("== 5/7 随附 Node");
  run("node", [join(root, "scripts", "fetch-node.mjs")], { cwd: root });
  if (!mac) run("node", [join(root, "scripts", "fetch-computer.mjs")], { cwd: root });

  console.log("== 6/7 cargo test");
  run("cargo", ["test", "--manifest-path", join(tauriDir, "Cargo.toml")], { cwd: root });

  console.log("== 7/7 tauri build");
  const args = ["--dir", join(root, "apps", "desktop"), "exec", "tauri", "build"];
  if (overridePath !== undefined) args.push("--config", overridePath);
  const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
  if (mac && !signed) args.push("--config", '{"bundle":{"createUpdaterArtifacts":false}}');
  run("pnpm", args, { cwd: root });

  if (mac) {
    const bundle = join(
      process.env.CARGO_TARGET_DIR ?? join(tauriDir, "target"),
      "release",
      "bundle",
    );
    const base = `${config.productName}_${version}_aarch64`;
    const dmg = `${base}.dmg`;
    copyFileSync(join(bundle, "dmg", dmg), join(releaseDir, dmg));
    const app = `${config.productName}.app`;
    const archive = `${base}.app.tar.gz`;
    const macDir = join(bundle, "macos");
    if (!signed) {
      // --no-sign would bypass ad-hoc app signing too. Archive the signed app instead.
      run("tar", ["-czf", join(releaseDir, archive), "-C", macDir, app]);
      console.log("未配置更新签名私钥：已收集安装包与更新包，不生成签名与平台条目");
      return;
    }
    const source = join(macDir, `${app}.tar.gz`);
    copyFileSync(source, join(releaseDir, archive));
    copyFileSync(`${source}.sig`, join(releaseDir, `${archive}.sig`));
    const signature = readFileSync(`${source}.sig`, "utf8").trim();
    if (!signature) throw new Error("更新签名为空");
    writeFileSync(
      join(releaseDir, "darwin-aarch64.json"),
      JSON.stringify({
        version,
        platform: "darwin-aarch64",
        signature,
        url: `${REPO_RELEASES}/v${version}/${archive}`,
      }),
    );
    return;
  }

  const nsisDir = join(tauriDir, "target", "release", "bundle", "nsis");
  const setupName = readdirSync(nsisDir).find((name) => name.endsWith(`_${version}_x64-setup.exe`));
  if (setupName === undefined) {
    throw new Error(`在 ${nsisDir} 找不到 *_${version}_x64-setup.exe`);
  }
  const setupPath = join(nsisDir, setupName);
  const sigPath = `${setupPath}.sig`;
  if (!existsSync(sigPath)) {
    throw new Error(
      `找不到 ${sigPath}。updater 产物未签名：请设置 TAURI_SIGNING_PRIVATE_KEY` +
        " 与 TAURI_SIGNING_PRIVATE_KEY_PASSWORD 后重跑",
    );
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  const changelogText = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const latest = buildLatestManifest({
    version,
    signature,
    setupName,
    changelogText,
    notesOverride,
  });

  copyFileSync(setupPath, join(releaseDir, setupName));
  copyFileSync(sigPath, join(releaseDir, `${setupName}.sig`));
  writeFileSync(join(releaseDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);

  console.log(`\n产物收集在 ${releaseDir}：`);
  for (const name of readdirSync(releaseDir)) console.log(`  ${name}`);
  console.log(`latest.json url: ${latest.platforms["windows-x86_64"].url}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
