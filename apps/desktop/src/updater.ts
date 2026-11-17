/**
 * 自动更新（ADR-0050 第 3 节）：
 * - 启动后检查一次，之后 24 小时内最多一次（lastUpdateCheck 节流）；
 * - 开关与上次检查结果存 prefs（默认开）；
 * - 自动检查失败只写外壳日志；手动检查把结果交回界面；
 * - 发现新版本写入 pendingUpdate，「稍后」只影响本次运行；
 * - 安装前重新调 check() 取 Update 句柄（存的 pendingUpdate 没有安装入口）；
 *   安装（Windows 下进程被安装器接管退出，其后的代码可能不执行）后重启。
 */

import type { DesktopHost } from "./host";
import type { PrefsStore } from "./prefs";
import { compareVersions, type ChangelogEntry } from "./versions";

export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 弹窗展示用的新版本数据 */
export interface UpdateNotice {
  version: string;
  notes: string | null;
  changelog: ChangelogEntry[];
}

export type CheckResult =
  | { kind: "update"; notice: UpdateNotice }
  | { kind: "latest" }
  | { kind: "error"; message: string };

export type InstallResult = "installed" | "gone";

export { compareVersions, type ChangelogEntry } from "./versions";

/**
 * 从更新源携带的 changelog 中筛出「比当前版本新、且不比最新版本新」的条目，按版本从新到旧排。
 * 拿不到当前版本时只保留最新版本那一项；过滤后为空时退回成 `[{ version, notes }]`。
 */
export function resolveChangelog(
  latestVersion: string,
  latestNotes: string | null,
  rawChangelog: readonly ChangelogEntry[] | undefined,
  currentVersion: string | undefined,
): ChangelogEntry[] {
  const source = rawChangelog ?? [];
  let filtered: ChangelogEntry[];
  if (currentVersion === undefined) {
    const latestEntry = source.find((entry) => compareVersions(entry.version, latestVersion) === 0);
    filtered = latestEntry !== undefined ? [latestEntry] : [];
  } else {
    filtered = source
      .filter(
        (entry) =>
          compareVersions(entry.version, currentVersion) > 0 &&
          compareVersions(entry.version, latestVersion) <= 0,
      )
      .sort((a, b) => compareVersions(b.version, a.version));
  }
  if (filtered.length === 0) {
    return [{ version: latestVersion, notes: latestNotes }];
  }
  return filtered.map((entry) => ({ version: entry.version, notes: entry.notes }));
}

function buildNotice(
  source: {
    version: string;
    notes: string | null;
    changelog?: readonly ChangelogEntry[] | undefined;
  },
  currentVersion: string | undefined,
): UpdateNotice {
  return {
    version: source.version,
    notes: source.notes,
    changelog: resolveChangelog(source.version, source.notes, source.changelog, currentVersion),
  };
}

/**
 * 把 updater 的原始错误（多为 tauri-plugin-updater 的英文信息）映射成界面用的中文说明。
 * 原始信息仍由调用方写进外壳日志；界面只显示这里的结果。
 */
export function describeUpdateError(message: string): string {
  const lower = message.toLowerCase();
  if (/minisign|signature|\bsign(ed|ing)?\b|pubkey|public key/.test(lower)) {
    return "签名校验失败，已取消安装";
  }
  if (
    /network|download|request|fetch|connect|timed? ?out|dns|unreachable|offline|status code|status: \d|https?:|tls|socket/.test(
      lower,
    )
  ) {
    return "下载失败，请检查网络后重试";
  }
  return `更新失败：${message}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateService(opts: {
  host: Pick<DesktopHost, "checkUpdate" | "relaunch" | "note">;
  prefs: PrefsStore;
  /** 当前应用版本；拿不到时返回 undefined（不做版本过滤） */
  currentVersion: () => string | undefined;
  now?: () => number;
}) {
  const { host, prefs } = opts;
  const now = opts.now ?? (() => Date.now());

  const note = (line: string) => {
    host.note(`[updater] ${line}`);
  };

  /** 已存的新版本提示；不比当前版本新时清掉并返回 undefined */
  function pendingNotice(): UpdateNotice | undefined {
    const pending = prefs.get().pendingUpdate;
    if (pending === undefined) return undefined;
    const current = opts.currentVersion();
    if (current !== undefined && compareVersions(pending.version, current) <= 0) {
      prefs.update({ pendingUpdate: undefined });
      return undefined;
    }
    return buildNotice(pending, current);
  }

  /** 自动检查：开关关或距上次不足 24h 时跳过。失败只写外壳日志。 */
  async function autoCheck(): Promise<UpdateNotice | undefined> {
    const current = prefs.get();
    if (current.autoUpdate === false) return undefined;
    const last = current.lastUpdateCheck ?? 0;
    if (now() - last < AUTO_CHECK_INTERVAL_MS) return pendingNotice();
    prefs.update({ lastUpdateCheck: now() });
    try {
      const update = await host.checkUpdate();
      if (update === null) {
        prefs.update({ pendingUpdate: undefined });
        return undefined;
      }
      const notice = buildNotice(update, opts.currentVersion());
      prefs.update({ pendingUpdate: notice });
      note(`发现新版本 v${update.version}`);
      return notice;
    } catch (error) {
      note(`自动检查更新失败：${messageOf(error)}`);
      return undefined;
    }
  }

  /** 手动检查：不节流；结果经返回值交给界面展示。 */
  async function manualCheck(): Promise<CheckResult> {
    prefs.update({ lastUpdateCheck: now() });
    try {
      const update = await host.checkUpdate();
      if (update === null) {
        prefs.update({ pendingUpdate: undefined });
        return { kind: "latest" };
      }
      const notice = buildNotice(update, opts.currentVersion());
      prefs.update({ pendingUpdate: notice });
      return { kind: "update", notice };
    } catch (error) {
      const message = messageOf(error);
      note(`手动检查更新失败：${message}`);
      return { kind: "error", message };
    }
  }

  /**
   * 下载、校验签名并安装，随后重启。
   * "gone" = 实际已无更新（例如手动装过新版），提示状态被清掉。
   * 下载/签名校验失败时恢复 pendingUpdate 并抛错，由界面显示原因。
   */
  async function install(
    onProgress?: (downloaded: number, total: number | undefined) => void,
  ): Promise<InstallResult> {
    const update = await host.checkUpdate();
    if (update === null) {
      prefs.update({ pendingUpdate: undefined });
      return "gone";
    }
    // Windows 安装成功时进程直接被安装器退出：先清掉 pendingUpdate，
    // 避免新版本启动后再提示一遍；失败分支里恢复。
    prefs.update({ pendingUpdate: undefined });
    try {
      await update.downloadAndInstall(onProgress);
    } catch (error) {
      prefs.update({ pendingUpdate: buildNotice(update, opts.currentVersion()) });
      note(`更新安装失败：${messageOf(error)}`);
      throw error;
    }
    await host.relaunch();
    return "installed";
  }

  return { autoCheck, manualCheck, install, pendingNotice };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
